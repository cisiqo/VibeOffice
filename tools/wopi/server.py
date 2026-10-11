#!/usr/bin/env python3
"""Serve VibeOffice as a WOPI client.

The normal site remains static. This optional gateway accepts the standard WOPI launch POST, keeps
access tokens in memory, proxies WOPI calls server-to-server, and serves public/ without caching.

    python3 tools/wopi/server.py --public-url https://office.example.com \
        --wopi-host https://cloud.example.com --port 8761
"""
import argparse
import base64
import hashlib
import html
import http.server
import json
import mimetypes
import os
import secrets
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', '..', 'public'))
MAX_LAUNCH = 64 * 1024
MAX_FILE = 512 * 1024 * 1024
APPS = {
    'quire': {
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'docm': 'application/vnd.ms-word.document.macroEnabled.12',
        'dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
        'dotm': 'application/vnd.ms-word.template.macroEnabled.12',
    },
    'ledger': {
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
        'xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
        'xltm': 'application/vnd.ms-excel.template.macroEnabled.12',
    },
    'lectern': {
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
        'ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
        'ppsm': 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
        'potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
        'potm': 'application/vnd.ms-powerpoint.template.macroEnabled.12',
    },
}


class WopiError(Exception):
    def __init__(self, status, message, headers=None, body=b'', code=None, details=None):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}
        self.body = body
        self.code = code
        self.details = details or {}


class SessionStore:
    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def create(self, source, token, ttl, info, proof_signer=None, oauth_token=None):
        sid = secrets.token_urlsafe(32)
        now = int(time.time() * 1000)
        # A zero token TTL explicitly means a non-expiring local token. The opaque browser session is
        # still bounded independently, so a leaked session id does not live forever.
        expires = now + 12 * 60 * 60 * 1000
        token_expires = ttl if ttl > 0 else None
        with self.lock:
            self.items[sid] = {
                'source': source, 'token': token, 'expires': expires,
                'token_expires': token_expires, 'info': info, 'proof_signer': proof_signer,
                'oauth_token': oauth_token, 'sid': sid,
            }
            self._prune(now)
        return sid

    def get(self, sid):
        now = int(time.time() * 1000)
        with self.lock:
            item = self.items.get(sid)
            if not item or item.get('deleted') or item['expires'] <= now:
                self.items.pop(sid, None)
                raise WopiError(410, 'The WOPI session has expired. Open the file again.')
            if (item['token_expires'] is not None and item['token_expires'] <= now and
                    not item.get('oauth_token')):
                raise WopiError(401, 'The WOPI access token has expired. Open the file again.',
                                code='token_expired')
            return item

    def _prune(self, now):
        for sid in [key for key, value in self.items.items() if value['expires'] <= now]:
            self.items.pop(sid, None)


class CoauthorManager:
    def __init__(self):
        self.states = {}
        self.lock = threading.Condition()

    def join(self, session):
        with self.lock:
            state = self.states.setdefault(session['source'], {
                'lock': 'VibeOffice-' + secrets.token_urlsafe(24),
                'holders': set(), 'sessions': {}, 'revision': 0, 'event': None,
            })
            state['sessions'][session['sid']] = session
            session['coauthor_key'] = session['source']
            session['coauthor_lock'] = state['lock']
            return state['lock']

    def acquire(self, session):
        with self.lock:
            state = self.states[session['coauthor_key']]
            override = 'LOCK' if not state['holders'] else 'REFRESH_LOCK'
            try:
                remote(session, method='POST', headers={
                    'X-WOPI-Override': override, 'X-WOPI-Lock': state['lock']}, body=b'')
            except WopiError as error:
                current = header_value(error.headers, 'X-WOPI-Lock')
                if error.status != 409:
                    raise
                if override == 'REFRESH_LOCK' and not current:
                    # Every previous browser disappeared and the host expired their shared lock.
                    state['holders'].clear()
                    remote(session, method='POST', headers={
                        'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': state['lock']}, body=b'')
                elif override == 'LOCK' and current and current.startswith('VibeOffice-'):
                    # The in-memory gateway restarted while its host lock was still alive. Old browser
                    # sessions cannot use the new gateway, so reclaim only locks carrying our namespace.
                    remote(session, method='POST', headers={
                        'X-WOPI-Override': 'UNLOCK_AND_RELOCK',
                        'X-WOPI-OldLock': current,
                        'X-WOPI-Lock': state['lock'],
                    }, body=b'')
                else:
                    raise
            state['holders'].add(session['sid'])

    def refresh(self, session):
        with self.lock:
            state = self.states[session['coauthor_key']]
            if session['sid'] not in state['holders']:
                raise WopiError(409, 'This coauthoring session does not own the shared lock.',
                                code='lock_conflict')
            remote(session, method='POST', headers={
                'X-WOPI-Override': 'REFRESH_LOCK', 'X-WOPI-Lock': state['lock']}, body=b'')

    def release(self, session):
        with self.lock:
            state = self.states.get(session.get('coauthor_key'))
            if not state or session['sid'] not in state['holders']:
                return
            state['holders'].remove(session['sid'])
            if not state['holders']:
                remote(session, method='POST', headers={
                    'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': state['lock']}, body=b'')

    def current_lock(self, session):
        with self.lock:
            state = self.states[session['coauthor_key']]
            _, headers, _ = remote(session, method='POST', headers={
                'X-WOPI-Override': 'GET_LOCK'}, body=b'')
            return header_value(headers, 'X-WOPI-Lock') or ''

    def publish(self, session, kind, values=None):
        with self.lock:
            state = self.states.get(session.get('coauthor_key'))
            if not state:
                return
            state['revision'] += 1
            state['event'] = {
                'revision': state['revision'], 'kind': kind, 'origin': session['sid'],
                **(values or {}),
            }
            self.lock.notify_all()

    def rename(self, session, old_source):
        with self.lock:
            old_key = session.get('coauthor_key', old_source)
            state = self.states.pop(old_key, None)
            if not state:
                return
            new_source = session['source']
            self.states[new_source] = state
            for peer in state['sessions'].values():
                peer['source'] = new_source
                peer['coauthor_key'] = new_source
                peer['info']['BaseFileName'] = session['info']['BaseFileName']
            self.publish(session, 'rename', {
                'name': session['info']['BaseFileName'], 'version': session['info']['Version']})

    def move(self, session, old_key):
        with self.lock:
            state = self.states.get(old_key)
            if state:
                state['sessions'].pop(session['sid'], None)
                state['holders'].discard(session['sid'])
            session.pop('coauthor_key', None)
        self.join(session)

    def wait(self, session, since):
        with self.lock:
            state = self.states.get(session.get('coauthor_key'))
            if not state:
                return {'revision': since}
            if state['revision'] <= since:
                self.lock.wait(timeout=25)
            event = state.get('event')
            return event if event and event['revision'] > since else {'revision': state['revision']}

    def revision(self, session):
        with self.lock:
            state = self.states.get(session.get('coauthor_key'))
            return state['revision'] if state else 0


def origin(url):
    p = urllib.parse.urlsplit(url)
    port = p.port
    default = (p.scheme == 'https' and port == 443) or (p.scheme == 'http' and port == 80)
    return f'{p.scheme}://{p.hostname}' + (f':{port}' if port and not default else '')


def validate_wopi_source(source, allowed_origins):
    try:
        p = urllib.parse.urlsplit(source)
        src_origin = origin(source)
    except (ValueError, TypeError):
        raise WopiError(400, 'Invalid WOPISrc.')
    # Standard hosts commonly use /wopi/files/{id}; compatible hosts also use prefixes such as
    # /WopiHost/files/{id}. The exact-origin allowlist is the SSRF boundary, not a product-specific path.
    if p.scheme not in ('http', 'https') or not p.hostname or '/files/' not in p.path or p.path.rstrip('/').endswith('/contents'):
        raise WopiError(400, 'WOPISrc must be an http(s) WOPI file URL containing /files/.')
    if src_origin not in allowed_origins:
        raise WopiError(403, f'WOPI host {src_origin} is not allowed.')
    return source


def token_url(source, token):
    p = urllib.parse.urlsplit(source)
    q = [(key, value) for key, value in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
         if key != 'access_token']
    q.append(('access_token', token))
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, urllib.parse.urlencode(q), p.fragment))


def append_path(source, suffix):
    p = urllib.parse.urlsplit(source)
    return urllib.parse.urlunsplit((p.scheme, p.netloc, p.path.rstrip('/') + suffix, p.query, p.fragment))


def refresh_access_token(session):
    expires = session.get('token_expires')
    oauth_token = session.get('oauth_token')
    now = int(time.time() * 1000)
    if expires is None or expires - now > 5 * 60 * 1000 or not oauth_token:
        return
    p = urllib.parse.urlsplit(session['source'])
    prefix = p.path.rsplit('/files/', 1)[0]
    url = urllib.parse.urlunsplit((p.scheme, p.netloc, prefix + '/wopibootstrapper', '', ''))
    request = urllib.request.Request(url, data=b'', method='POST', headers={
        'Authorization': 'Bearer ' + oauth_token,
        'X-WOPI-EcosystemOperation': 'GET_NEW_ACCESS_TOKEN',
        'X-WOPI-WopiSrc': session['source'],
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            value = json.loads(response.read().decode('utf-8'))
    except (urllib.error.HTTPError, urllib.error.URLError, OSError,
            UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WopiError(401, f'The WOPI access token could not be refreshed: {error}',
                        code='token_refresh_failed')
    token_info = value.get('AccessTokenInfo') if isinstance(value, dict) else None
    token = token_info.get('AccessToken') if isinstance(token_info, dict) else None
    expiry = token_info.get('AccessTokenExpiry') if isinstance(token_info, dict) else None
    if not isinstance(token, str) or not token or not isinstance(expiry, int):
        raise WopiError(502, 'GetNewAccessToken returned an invalid response.')
    session['token'] = token
    session['token_expires'] = expiry if expiry > 0 else None


def header_value(headers, name):
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None


def content_sha256(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode('ascii')


def der_value(data, offset):
    tag = data[offset]
    n = data[offset + 1]
    used = 2
    if n & 0x80:
        count = n & 0x7f
        n = int.from_bytes(data[offset + 2:offset + 2 + count], 'big')
        used += count
    start = offset + used
    return tag, data[start:start + n], start + n


def rsa_public_parts(private_key):
    result = subprocess.run(
        ['openssl', 'pkey', '-in', private_key, '-pubout', '-outform', 'DER'],
        check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    _, spki, _ = der_value(result.stdout, 0)
    _, _, pos = der_value(spki, 0)
    _, bit_string, _ = der_value(spki, pos)
    _, rsa, _ = der_value(bit_string[1:], 0)
    _, modulus_bytes, pos = der_value(rsa, 0)
    _, exponent_bytes, _ = der_value(rsa, pos)
    modulus = int.from_bytes(modulus_bytes, 'big')
    exponent = int.from_bytes(exponent_bytes, 'big')
    return modulus, exponent


class ProofSigner:
    def __init__(self, private_key, old_private_key=None):
        self.private_key = os.path.realpath(private_key)
        self.old_private_key = os.path.realpath(old_private_key or private_key)
        self.modulus, self.exponent = rsa_public_parts(self.private_key)
        self.old_modulus, self.old_exponent = rsa_public_parts(self.old_private_key)

    @staticmethod
    def expected(token, url, timestamp):
        token_bytes = token.encode('utf-8')
        url_bytes = url.upper().encode('utf-8')
        timestamp_bytes = struct.pack('>Q', timestamp)
        return (struct.pack('>I', len(token_bytes)) + token_bytes +
                struct.pack('>I', len(url_bytes)) + url_bytes +
                struct.pack('>I', len(timestamp_bytes)) + timestamp_bytes)

    @staticmethod
    def _sign(private_key, data):
        result = subprocess.run(
            ['openssl', 'dgst', '-sha256', '-sign', private_key],
            input=data, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return base64.b64encode(result.stdout).decode('ascii')

    def headers(self, token, url):
        # X-WOPI-TimeStamp uses .NET ticks: 100 ns intervals since 0001-01-01 UTC.
        timestamp = int(time.time() * 10_000_000) + 621355968000000000
        expected = self.expected(token, url, timestamp)
        return {
            'X-WOPI-TimeStamp': str(timestamp),
            'X-WOPI-Proof': self._sign(self.private_key, expected),
            'X-WOPI-ProofOld': self._sign(self.old_private_key, expected),
        }

    @staticmethod
    def _attributes(modulus, exponent):
        width = (modulus.bit_length() + 7) // 8
        mod = modulus.to_bytes(width, 'big')
        exp = exponent.to_bytes((exponent.bit_length() + 7) // 8, 'big')
        blob = (struct.pack('<BBHI', 0x06, 0x02, 0, 0x00002400) +
                struct.pack('<III', 0x31415352, width * 8, exponent) + mod[::-1])
        return {
            'value': base64.b64encode(blob).decode('ascii'),
            'modulus': base64.b64encode(mod).decode('ascii'),
            'exponent': base64.b64encode(exp).decode('ascii'),
        }

    def discovery_element(self):
        current = self._attributes(self.modulus, self.exponent)
        old = self._attributes(self.old_modulus, self.old_exponent)
        attrs = {**current, **{'old' + key: value for key, value in old.items()}}
        return ' <proof-key ' + ' '.join(
            f'{key}="{html.escape(value, quote=True)}"' for key, value in attrs.items()) + ' />\n'


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_origin):
        self.allowed_origin = allowed_origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if origin(newurl) != self.allowed_origin:
            raise WopiError(502, 'The WOPI host redirected to an origin that is not allowed.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def remote(session, path='', method='GET', headers=None, body=None):
    refresh_access_token(session)
    url = token_url(append_path(session['source'], path) if path else session['source'], session['token'])
    request_headers = dict(headers or {})
    if session.get('proof_signer'):
        request_headers.update(session['proof_signer'].headers(session['token'], url))
    req = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    try:
        opener = urllib.request.build_opener(SameOriginRedirect(origin(session['source'])))
        with opener.open(req, timeout=60) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as e:
        try:
            data = e.read()
            raise WopiError(e.code, f'WOPI host returned {e.code}.', dict(e.headers.items()), data)
        finally:
            e.close()
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, 'reason', e)
        raise WopiError(502, f'Could not reach the WOPI host: {reason}')


def parse_file_info(body):
    try:
        info = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise WopiError(502, 'CheckFileInfo did not return valid JSON.')
    required = {'BaseFileName': str, 'OwnerId': str, 'Size': int, 'Version': str}
    if not isinstance(info, dict) or any(not isinstance(info.get(key), kind) for key, kind in required.items()):
        raise WopiError(502, 'CheckFileInfo is missing a required BaseFileName, OwnerId, Size or Version value.')
    if info['Size'] < 0:
        raise WopiError(502, 'CheckFileInfo returned an invalid Size.')
    return info


def check_file_info(source, token, proof_signer=None):
    temporary = {'source': source, 'token': token, 'proof_signer': proof_signer}
    _, _, body = remote(temporary)
    return parse_file_info(body)


def session_file_info(session):
    _, _, body = remote(session)
    return parse_file_info(body)


def utf7(value):
    return value.encode('utf-7').decode('ascii')


def discovery(public_url, proof_signer=None):
    groups = []
    for app, formats in APPS.items():
        for ext, mime in formats.items():
            edit_url = html.escape(f'{public_url}/{app}/?action=edit&', quote=True)
            view_url = html.escape(f'{public_url}/{app}/?action=view&', quote=True)
            groups.append(
                f'  <app name="{html.escape(mime, quote=True)}">\n'
                f'   <action name="edit" ext="{ext}" default="true" requires="locks,update" urlsrc="{edit_url}" />\n'
                f'   <action name="view" ext="{ext}" urlsrc="{view_url}" />\n'
                f'  </app>'
            )
    cap_url = html.escape(f'{public_url}/?')
    groups.append(f'  <app name="Capabilities"><action name="view" ext="" urlsrc="{cap_url}" /></app>')
    zone = 'external-https' if public_url.startswith('https://') else 'external-http'
    proof = proof_signer.discovery_element() if proof_signer else ''
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<wopi-discovery>\n{proof} <net-zone name="{zone}">\n' + '\n'.join(groups) +
            '\n </net-zone>\n</wopi-discovery>\n').encode('utf-8')


class WopiHandler(http.server.SimpleHTTPRequestHandler):
    server_version = 'VibeOffice-WOPI/1.0'
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.webmanifest': 'application/manifest+json'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/hosting/discovery':
            return self.reply_bytes(
                200, discovery(self.server.public_url, self.server.proof_signer),
                'text/xml; charset=utf-8')
        if path == '/hosting/capabilities':
            return self.reply_json(200, {
                'productName': 'VibeOffice', 'productVersion': 'dev',
                'hasMobileSupport': True, 'hasProxyPrefix': False,
                'hasTemplateSaveAs': True, 'hasTemplateSource': False,
            })
        route = self.session_route(path)
        if route:
            sid, part = route
            try:
                session = self.server.sessions.get(sid)
                if part == 'info':
                    return self.reply_json(200, session['info'])
                if part == 'contents':
                    status, headers, body = remote(session, '/contents')
                    return self.reply_bytes(status, body, headers.get('Content-Type', 'application/octet-stream'))
                if part == 'events':
                    try:
                        since = int(urllib.parse.parse_qs(
                            urllib.parse.urlsplit(self.path).query).get('since', ['0'])[0])
                    except ValueError:
                        raise WopiError(400, 'Invalid coauthoring revision.')
                    return self.reply_json(200, self.server.coauthors.wait(session, max(0, since)))
                if part == 'reload':
                    try:
                        since = int(urllib.parse.parse_qs(
                            urllib.parse.urlsplit(self.path).query).get(
                                'since', [str(self.server.coauthors.revision(session))])[0])
                    except ValueError:
                        raise WopiError(400, 'Invalid coauthoring revision.')
                    session['info'] = session_file_info(session)
                    return self.render_session(session, max(0, since))
            except WopiError as e:
                return self.reply_error(e)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlsplit(self.path)
        app = parsed.path.strip('/').split('/')[0]
        if app in APPS and parsed.path.rstrip('/') == '/' + app:
            return self.launch(app, parsed.query)
        route = self.session_route(parsed.path)
        if not route:
            return self.reply_json(404, {'error': 'Not found.'})
        sid, part = route
        try:
            self.require_same_origin()
            session = self.server.sessions.get(sid)
            if part == 'command':
                return self.wopi_command(session)
            if part == 'contents':
                return self.put_contents(session, urllib.parse.parse_qs(parsed.query).get('relative', [None])[0])
            raise WopiError(404, 'Not found.')
        except WopiError as e:
            return self.reply_error(e)

    def launch(self, app, query):
        try:
            n = self.content_length(MAX_LAUNCH)
            ctype = self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
            if ctype != 'application/x-www-form-urlencoded':
                raise WopiError(415, 'WOPI launch must use an application/x-www-form-urlencoded POST.')
            form = urllib.parse.parse_qs(self.rfile.read(n).decode('utf-8'), keep_blank_values=True)
            q = urllib.parse.parse_qs(query, keep_blank_values=True)
            source = validate_wopi_source(q.get('WOPISrc', q.get('wopisrc', ['']))[0], self.server.allowed_origins)
            action = q.get('action', ['view'])[0]
            if action not in ('view', 'edit'):
                raise WopiError(400, 'WOPI action must be view or edit.')
            save_as = q.get('saveAs', ['0'])[0] == '1'
            token = form.get('access_token', [''])[0]
            if not token:
                raise WopiError(400, 'The WOPI launch is missing access_token.')
            try:
                ttl = int(form.get('access_token_ttl', ['0'])[0] or 0)
            except ValueError:
                ttl = 0
            if ttl < 0 or (ttl > 0 and ttl <= int(time.time() * 1000)):
                raise WopiError(401, 'The WOPI access token has expired. Launch the file again.',
                                code='token_expired')
            info = check_file_info(source, token, self.server.proof_signer)
            extension = info['BaseFileName'].rsplit('.', 1)[-1].lower() if '.' in info['BaseFileName'] else ''
            if extension not in APPS[app]:
                raise WopiError(400, f"{info['BaseFileName']} does not belong to the {app} editor.")
            ancestor = origin(source)
            frame_origin = info.get('PostMessageOrigin')
            try:
                if isinstance(frame_origin, str) and origin(frame_origin) == frame_origin.rstrip('/'):
                    ancestor = frame_origin.rstrip('/')
            except (TypeError, ValueError):
                pass
            info['PostMessageOrigin'] = ancestor
            sid = self.server.sessions.create(
                source, token, ttl, info, self.server.proof_signer, self.server.oauth_token)
            session = self.server.sessions.get(sid)
            session['app'] = app
            session['action'] = action
            session['saveAs'] = save_as
            coauthor_lock = self.server.coauthors.join(session)
            session['ancestor'] = ancestor
            session['frameTrust'] = q.get('sftc', ['0'])[0] == '1'
            return self.render_session(session)
        except (UnicodeDecodeError, OSError) as e:
            return self.reply_json(400, {'error': str(e)})
        except WopiError as e:
            return self.reply_error(e)

    def render_session(self, session, event_revision=None):
        page = os.path.join(ROOT, session['app'], 'index.html')
        try:
            with open(page, 'rb') as stream:
                data = stream.read()
        except OSError as error:
            raise WopiError(500, str(error))
        boot = json.dumps({
            'session': session['sid'], 'info': session['info'], 'action': session['action'],
            'saveAs': session.get('saveAs', False), 'frameTrust': session.get('frameTrust', False),
            'coauthorLock': session.get('coauthor_lock'),
            'eventRevision': (self.server.coauthors.revision(session)
                              if event_revision is None else event_revision),
        }, ensure_ascii=False).replace('<', '\\u003c')
        data = data.replace(
            b'<head>', f'<head>\n<base href="/{session["app"]}/">'.encode('utf-8'), 1)
        marker = b'<script src="../common/suite.js"></script>'
        data = data.replace(
            marker, f'<script>window.__VO_WOPI__={boot};</script>\n'.encode('utf-8') + marker, 1)
        headers = {'Content-Security-Policy': 'frame-ancestors ' + session['ancestor']}
        return self.reply_bytes(200, data, 'text/html; charset=utf-8', headers)

    def wopi_command(self, session):
        data = self.read_json(MAX_LAUNCH)
        action = data.get('action')
        overrides = {
            'lock': 'LOCK', 'refresh': 'REFRESH_LOCK', 'getLock': 'GET_LOCK',
            'unlock': 'UNLOCK', 'unlockAndRelock': 'UNLOCK_AND_RELOCK',
            'rename': 'RENAME_FILE', 'delete': 'DELETE',
        }
        if action not in overrides:
            raise WopiError(400, 'Invalid WOPI command.')
        if action in ('lock', 'refresh', 'getLock', 'unlock', 'unlockAndRelock'):
            if action != 'getLock' and (not isinstance(data.get('lock'), str) or not data['lock']):
                raise WopiError(400, 'This WOPI command requires a lock.')
            if action == 'lock':
                self.server.coauthors.acquire(session)
            elif action in ('refresh', 'unlockAndRelock'):
                self.server.coauthors.refresh(session)
            elif action == 'unlock':
                self.server.coauthors.release(session)
            else:
                return self.reply_json(
                    200, {'ok': True, 'Lock': self.server.coauthors.current_lock(session)})
            return self.reply_json(200, {'ok': True})
        headers = {'X-WOPI-Override': overrides[action]}
        if action not in ('getLock', 'rename', 'delete'):
            if not isinstance(data.get('lock'), str) or not data['lock']:
                raise WopiError(400, 'This WOPI command requires a lock.')
            headers['X-WOPI-Lock'] = data['lock']
        elif isinstance(data.get('lock'), str) and data['lock']:
            headers['X-WOPI-Lock'] = session.get('coauthor_lock', data['lock'])
        if action == 'unlockAndRelock':
            if not isinstance(data.get('oldLock'), str) or not data['oldLock']:
                raise WopiError(400, 'UnlockAndRelock requires the old lock.')
            headers['X-WOPI-OldLock'] = data['oldLock']
        if action == 'rename':
            old_source = session['source']
            requested = data.get('name')
            if not isinstance(requested, str) or not requested or os.path.basename(requested) != requested:
                raise WopiError(400, 'RenameFile requires a valid file name.')
            headers['X-WOPI-RequestedName'] = utf7(requested)
        _, response_headers, body = remote(session, method='POST', headers=headers, body=b'')
        out = {'ok': True}
        current_lock = header_value(response_headers, 'X-WOPI-Lock')
        if action == 'getLock':
            out['Lock'] = current_lock or ''
        version = header_value(response_headers, 'X-WOPI-ItemVersion')
        if version:
            out['Version'] = version
        if action == 'rename':
            try:
                renamed = json.loads(body.decode('utf-8')) if body else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                renamed = {}
            if not isinstance(renamed.get('Name'), str) or not isinstance(renamed.get('Url'), str):
                raise WopiError(502, 'RenameFile response is missing Name or Url.')
            self.adopt_source(session, renamed['Url'])
            new_info = session_file_info(session)
            session['info'] = new_info
            out.update({
                'Name': new_info['BaseFileName'], 'Version': new_info['Version'],
                'Size': new_info['Size'], 'SHA256': new_info.get('SHA256'),
            })
            self.server.coauthors.rename(session, old_source)
        if action == 'delete':
            self.server.coauthors.publish(session, 'delete', {
                'name': session['info']['BaseFileName']})
            session['deleted'] = True
        return self.reply_json(200, out)

    def put_contents(self, session, relative):
        n = self.content_length(MAX_FILE)
        body = self.rfile.read(n)
        lock = self.headers.get('X-VO-WOPI-Lock')
        headers = {'X-WOPI-Override': 'PUT_RELATIVE' if relative else 'PUT', 'X-WOPI-Size': str(n),
                   'Content-Type': 'application/octet-stream'}
        if lock:
            headers['X-WOPI-Lock'] = session.get('coauthor_lock', lock)
        path = ''
        if relative:
            headers['X-WOPI-SuggestedTarget'] = utf7(os.path.basename(relative))
        else:
            if session['info'].get('SupportsLocks') is True and not lock:
                raise WopiError(409, 'The file lock is missing.', code='lock_conflict')
            current_info = session_file_info(session)
            if current_info['Version'] != session['info']['Version']:
                raise WopiError(
                    409, 'The file changed on the WOPI host before it could be saved.',
                    code='version_conflict',
                    details={'expectedVersion': session['info']['Version'],
                             'currentVersion': current_info['Version']},
                )
            path = '/contents'
        try:
            _, response_headers, response_body = remote(
                session, path, method='POST', headers=headers, body=body)
        except WopiError as error:
            if relative or error.status not in (502, 503, 504):
                raise
            # A timed-out PutFile may have reached the host. Query state once instead of replaying a
            # non-idempotent write. Matching content is success; differing content is a safe-copy case.
            try:
                reconciled = session_file_info(session)
            except WopiError:
                raise error
            if reconciled.get('SHA256') != content_sha256(body):
                raise WopiError(
                    409, 'The save result is uncertain and the host contains different content.',
                    code='network_conflict',
                    details={'expectedVersion': session['info']['Version'],
                             'currentVersion': reconciled['Version']},
                )
            session['info'] = reconciled
            return self.reply_json(200, {
                'ok': True, 'Reconciled': True, 'Version': reconciled['Version'],
                'Size': reconciled['Size'], 'SHA256': reconciled.get('SHA256'),
            })
        out = {}
        if response_body:
            try:
                out = json.loads(response_body.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                out = {}
        if relative and (not isinstance(out.get('Url'), str) or not isinstance(out.get('Name'), str)):
            raise WopiError(502, 'PutRelativeFile response is missing Name or Url.')
        if relative:
            old_source, old_token = session['source'], session['token']
            self.adopt_source(session, out['Url'])
            if lock:
                try:
                    remote({'source': old_source, 'token': old_token}, method='POST',
                           headers={'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': lock}, body=b'')
                except WopiError:
                    pass
            session['info'] = session_file_info(session)
            self.server.coauthors.move(session, old_source)
            out.pop('Url', None)
            out['Relative'] = True
        else:
            session['info'].update({
                'Version': header_value(response_headers, 'X-WOPI-ItemVersion') or session['info']['Version'],
                'Size': n, 'SHA256': content_sha256(body),
            })
        out.update({
            'Name': session['info']['BaseFileName'],
            'Version': session['info']['Version'],
            'Size': session['info']['Size'],
            'SHA256': session['info'].get('SHA256'),
        })
        self.server.coauthors.publish(session, 'save', {
            'name': session['info']['BaseFileName'], 'version': session['info']['Version'],
            'size': session['info']['Size'], 'sha256': session['info'].get('SHA256'),
        })
        return self.reply_json(200, out)

    def adopt_source(self, session, url):
        p = urllib.parse.urlsplit(url)
        values = urllib.parse.parse_qs(p.query)
        token = values.get('access_token', [session['token']])[0]
        clean_query = [(key, value) for key, vals in values.items()
                       for value in vals if key != 'access_token']
        source = urllib.parse.urlunsplit(
            (p.scheme, p.netloc, p.path, urllib.parse.urlencode(clean_query), p.fragment))
        validate_wopi_source(source, self.server.allowed_origins)
        session['source'] = source
        session['token'] = token

    def session_route(self, path):
        parts = path.strip('/').split('/')
        if len(parts) == 4 and parts[:2] == ['wopi', 'session'] and parts[3] in (
                'info', 'contents', 'command', 'events', 'reload'):
            return parts[2], parts[3]
        return None

    def require_same_origin(self):
        supplied = self.headers.get('Origin')
        if supplied and supplied != self.server.public_url:
            raise WopiError(403, 'Cross-origin WOPI session request refused.')

    def content_length(self, limit):
        try:
            n = int(self.headers.get('Content-Length', ''))
        except ValueError:
            raise WopiError(411, 'Content-Length is required.')
        if n < 0 or n > limit:
            raise WopiError(413, 'Request body is too large.')
        return n

    def read_json(self, limit):
        try:
            value = json.loads(self.rfile.read(self.content_length(limit)).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise WopiError(400, 'Invalid JSON.')
        if not isinstance(value, dict):
            raise WopiError(400, 'Expected a JSON object.')
        return value

    def reply_error(self, error):
        detail = error.body.decode('utf-8', 'replace')[:1000] if error.body else str(error)
        headers = {}
        current_lock = header_value(error.headers, 'X-WOPI-Lock')
        reason = header_value(error.headers, 'X-WOPI-LockFailureReason')
        if current_lock is not None:
            headers['X-WOPI-Lock'] = current_lock
        payload = {'error': detail}
        if error.code:
            payload['code'] = error.code
        if current_lock is not None:
            payload['currentLock'] = current_lock
        if reason:
            payload['reason'] = reason
        payload.update(error.details)
        return self.reply_json(error.status, payload, headers)

    def reply_json(self, status, value, headers=None):
        return self.reply_bytes(status, json.dumps(value, ensure_ascii=False).encode('utf-8'),
                                'application/json; charset=utf-8', headers)

    def reply_bytes(self, status, data, content_type, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        for key, value in (headers or {}).items():
            if value is not None:
                self.send_header(key, str(value))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()


def parse_args(argv=None):
    p = argparse.ArgumentParser(description='VibeOffice WOPI client gateway')
    p.add_argument('--bind', default='127.0.0.1')
    p.add_argument('--port', type=int, default=8761)
    p.add_argument('--public-url', required=True, help='public origin of this gateway, for example https://office.example.com')
    p.add_argument('--wopi-host', action='append', required=True, help='allowed WOPI host origin; repeat for more hosts')
    p.add_argument('--proof-key', help='RSA private PEM used to sign WOPI requests and published in discovery')
    p.add_argument('--proof-key-old', help='previous RSA private PEM during proof-key rotation')
    p.add_argument('--oauth-token', help='OAuth bearer token used by GetNewAccessToken before token expiry')
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    public_url = args.public_url.rstrip('/')
    if urllib.parse.urlsplit(public_url).path not in ('', '/'):
        raise SystemExit('--public-url must be an origin without a path')
    allowed = {origin(value) for value in args.wopi_host}
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer((args.bind, args.port), WopiHandler)
    server.sessions = SessionStore()
    server.coauthors = CoauthorManager()
    server.public_url = public_url
    server.allowed_origins = allowed
    server.proof_signer = ProofSigner(args.proof_key, args.proof_key_old) if args.proof_key else None
    server.oauth_token = args.oauth_token
    print(f'VibeOffice WOPI gateway at http://{args.bind}:{args.port}/; public URL {public_url}', flush=True)
    print('Allowed WOPI hosts: ' + ', '.join(sorted(allowed)), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
