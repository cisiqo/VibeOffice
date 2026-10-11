#!/usr/bin/env python3
"""Serve VibeOffice as a WOPI client.

The normal site remains static. This optional gateway accepts the standard WOPI launch POST, keeps
access tokens in memory, proxies WOPI calls server-to-server, and serves public/ without caching.

    python3 tools/wopi/server.py --public-url https://office.example.com \
        --wopi-host https://cloud.example.com --port 8761
"""
import argparse
import html
import http.server
import json
import mimetypes
import os
import secrets
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
    def __init__(self, status, message, headers=None, body=b''):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}
        self.body = body


class SessionStore:
    def __init__(self):
        self.items = {}
        self.lock = threading.Lock()

    def create(self, source, token, ttl, info):
        sid = secrets.token_urlsafe(32)
        now = int(time.time() * 1000)
        # access_token_ttl is an epoch time in milliseconds. Keep sessions bounded if it is absent.
        expires = min(ttl if ttl and ttl > now else now + 12 * 60 * 60 * 1000, now + 24 * 60 * 60 * 1000)
        with self.lock:
            self.items[sid] = {'source': source, 'token': token, 'expires': expires, 'info': info}
            self._prune(now)
        return sid

    def get(self, sid):
        now = int(time.time() * 1000)
        with self.lock:
            item = self.items.get(sid)
            if not item or item['expires'] <= now:
                self.items.pop(sid, None)
                raise WopiError(410, 'The WOPI session has expired. Open the file again.')
            return item

    def _prune(self, now):
        for sid in [key for key, value in self.items.items() if value['expires'] <= now]:
            self.items.pop(sid, None)


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


class SameOriginRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_origin):
        self.allowed_origin = allowed_origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if origin(newurl) != self.allowed_origin:
            raise WopiError(502, 'The WOPI host redirected to an origin that is not allowed.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def remote(session, path='', method='GET', headers=None, body=None):
    url = token_url(append_path(session['source'], path) if path else session['source'], session['token'])
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        opener = urllib.request.build_opener(SameOriginRedirect(origin(session['source'])))
        with opener.open(req, timeout=60) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as e:
        data = e.read()
        raise WopiError(e.code, f'WOPI host returned {e.code}.', dict(e.headers.items()), data)
    except urllib.error.URLError as e:
        raise WopiError(502, f'Could not reach the WOPI host: {e.reason}')


def check_file_info(source, token):
    temporary = {'source': source, 'token': token}
    _, _, body = remote(temporary)
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


def utf7(value):
    return value.encode('utf-7').decode('ascii')


def discovery(public_url):
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
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<wopi-discovery>\n <net-zone name="{zone}">\n' + '\n'.join(groups) +
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
            return self.reply_bytes(200, discovery(self.server.public_url), 'text/xml; charset=utf-8')
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
            info = check_file_info(source, token)
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
            sid = self.server.sessions.create(source, token, ttl, info)
            page = os.path.join(ROOT, app, 'index.html')
            with open(page, 'rb') as f:
                data = f.read()
            boot = json.dumps({'session': sid, 'info': info, 'action': action, 'saveAs': save_as},
                              ensure_ascii=False).replace('<', '\\u003c')
            marker = b'<script src="../common/suite.js"></script>'
            data = data.replace(marker, f'<script>window.__VO_WOPI__={boot};</script>\n'.encode('utf-8') + marker, 1)
            headers = {'Content-Security-Policy': 'frame-ancestors ' + ancestor}
            return self.reply_bytes(200, data, 'text/html; charset=utf-8', headers)
        except (UnicodeDecodeError, OSError) as e:
            return self.reply_json(400, {'error': str(e)})
        except WopiError as e:
            return self.reply_error(e)

    def wopi_command(self, session):
        data = self.read_json(MAX_LAUNCH)
        action = data.get('action')
        overrides = {'lock': 'LOCK', 'refresh': 'REFRESH_LOCK', 'unlock': 'UNLOCK'}
        if action not in overrides or not isinstance(data.get('lock'), str) or not data['lock']:
            raise WopiError(400, 'Invalid WOPI lock command.')
        headers = {'X-WOPI-Override': overrides[action], 'X-WOPI-Lock': data['lock']}
        _, response_headers, body = remote(session, method='POST', headers=headers, body=b'')
        return self.reply_json(200, {'ok': True, 'Version': response_headers.get('X-WOPI-ItemVersion')})

    def put_contents(self, session, relative):
        n = self.content_length(MAX_FILE)
        body = self.rfile.read(n)
        lock = self.headers.get('X-VO-WOPI-Lock')
        headers = {'X-WOPI-Override': 'PUT_RELATIVE' if relative else 'PUT', 'X-WOPI-Size': str(n),
                   'Content-Type': 'application/octet-stream'}
        if lock:
            headers['X-WOPI-Lock'] = lock
        path = ''
        if relative:
            headers['X-WOPI-SuggestedTarget'] = utf7(os.path.basename(relative))
        else:
            path = '/contents'
        _, response_headers, response_body = remote(session, path, method='POST', headers=headers, body=body)
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
            p = urllib.parse.urlsplit(out['Url'])
            values = urllib.parse.parse_qs(p.query)
            new_token = values.get('access_token', [session['token']])[0]
            clean_query = [(k, v) for k, vals in urllib.parse.parse_qs(p.query).items() for v in vals if k != 'access_token']
            new_source = urllib.parse.urlunsplit((p.scheme, p.netloc, p.path, urllib.parse.urlencode(clean_query), p.fragment))
            validate_wopi_source(new_source, self.server.allowed_origins)
            if lock:
                try:
                    remote({'source': old_source, 'token': old_token}, method='POST',
                           headers={'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': lock}, body=b'')
                except WopiError:
                    pass
            session['source'] = new_source
            session['token'] = new_token
            session['info']['BaseFileName'] = out.get('Name', relative)
            out.pop('Url', None)
            out['Relative'] = True
        out['Version'] = response_headers.get('X-WOPI-ItemVersion')
        return self.reply_json(200, out)

    def session_route(self, path):
        parts = path.strip('/').split('/')
        if len(parts) == 4 and parts[:2] == ['wopi', 'session'] and parts[3] in ('info', 'contents', 'command'):
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
        if error.headers.get('X-WOPI-Lock'):
            headers['X-WOPI-Lock'] = error.headers['X-WOPI-Lock']
        return self.reply_json(error.status, {'error': detail}, headers)

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
    server.public_url = public_url
    server.allowed_origins = allowed
    print(f'VibeOffice WOPI gateway at http://{args.bind}:{args.port}/; public URL {public_url}', flush=True)
    print('Allowed WOPI hosts: ' + ', '.join(sorted(allowed)), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
