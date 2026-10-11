import base64
import hashlib
import http.server
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
import urllib.request


HERE = os.path.dirname(__file__)
SPEC = importlib.util.spec_from_file_location('vo_wopi_server', os.path.join(HERE, 'server.py'))
WOPI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WOPI)


class FakeHost(http.server.BaseHTTPRequestHandler):
    content = b'original document'
    name = 'Test.docx'
    version = 1
    lock = None
    saved = None
    deleted = False
    drop_put_response = False
    drop_put_before_write = False
    seen_token = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        self.__class__.seen_token = urllib.parse.parse_qs(parsed.query).get('access_token', [None])[0]
        if path == '/wopi/files/1':
            if self.deleted:
                return self.send_error(404)
            data = json.dumps({
                'BaseFileName': self.name, 'Size': len(self.content), 'Version': str(self.version),
                'SHA256': base64.b64encode(hashlib.sha256(self.content).digest()).decode(),
                'OwnerId': 'owner-1',
                'UserCanWrite': True, 'SupportsLocks': True, 'SupportsGetLock': True,
                'SupportsUpdate': True, 'SupportsRename': True,
                'PostMessageOrigin': 'https://cloud.example.test',
            }).encode()
            return self.reply(200, data, 'application/json')
        if path == '/wopi/files/2':
            data = json.dumps({
                'BaseFileName': 'Copy.docx', 'Size': len(self.saved or b''),
                'Version': str(self.version),
                'SHA256': base64.b64encode(hashlib.sha256(self.saved or b'').digest()).decode(),
                'OwnerId': 'owner-1', 'UserCanWrite': True, 'SupportsLocks': True,
                'SupportsGetLock': True, 'SupportsUpdate': True, 'SupportsRename': True,
            }).encode()
            return self.reply(200, data, 'application/json')
        if path == '/wopi/files/1/contents':
            return self.reply(200, self.content)
        if path == '/wopi/files/2/contents':
            return self.reply(200, self.saved or b'')
        self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        override = self.headers.get('X-WOPI-Override')
        lock = self.headers.get('X-WOPI-Lock')
        if path == '/wopi/wopibootstrapper':
            if self.headers.get('Authorization') != 'Bearer oauth':
                return self.reply(401, b'')
            data = json.dumps({
                'AccessTokenInfo': {'AccessToken': 'fresh', 'AccessTokenExpiry': 0}
            }).encode()
            return self.reply(200, data, 'application/json')
        if path == '/wopi/files/1' and override == 'PUT_RELATIVE':
            n = int(self.headers['Content-Length'])
            self.__class__.saved = self.rfile.read(n)
            self.__class__.version += 1
            port = self.server.server_port
            data = json.dumps({'Name': 'Copy.docx', 'Url': f'http://127.0.0.1:{port}/wopi/files/2?access_token=next'}).encode()
            return self.reply(200, data, 'application/json',
                              {'X-WOPI-ItemVersion': str(self.version)})
        if path == '/wopi/files/1' and override == 'GET_LOCK':
            return self.reply(200, b'', headers={'X-WOPI-Lock': self.lock or ''})
        if path == '/wopi/files/1' and override in ('LOCK', 'REFRESH_LOCK', 'UNLOCK', 'UNLOCK_AND_RELOCK'):
            if override == 'LOCK':
                if self.lock not in (None, lock):
                    return self.lock_mismatch()
                self.__class__.lock = lock
            elif override == 'REFRESH_LOCK':
                if self.lock != lock:
                    return self.lock_mismatch()
            elif override == 'UNLOCK':
                if self.lock != lock:
                    return self.lock_mismatch()
                self.__class__.lock = None
            else:
                old_lock = self.headers.get('X-WOPI-OldLock')
                if self.lock != old_lock:
                    return self.lock_mismatch()
                self.__class__.lock = lock
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if path == '/wopi/files/1' and override == 'RENAME_FILE':
            if self.lock and self.lock != lock:
                return self.lock_mismatch()
            self.__class__.name = self.headers['X-WOPI-RequestedName']
            self.__class__.version += 1
            port = self.server.server_port
            data = json.dumps({
                'Name': self.name,
                'Url': f'http://127.0.0.1:{port}/wopi/files/1?access_token=secret',
            }).encode()
            return self.reply(200, data, 'application/json',
                              {'X-WOPI-ItemVersion': str(self.version)})
        if path == '/wopi/files/1' and override == 'DELETE':
            if self.lock:
                return self.lock_mismatch()
            self.__class__.deleted = True
            return self.reply(200, b'')
        if path == '/wopi/files/1/contents' and override == 'PUT':
            if self.lock != lock:
                return self.lock_mismatch()
            if self.drop_put_before_write:
                self.__class__.drop_put_before_write = False
                self.close_connection = True
                return
            n = int(self.headers['Content-Length'])
            body = self.rfile.read(n)
            self.__class__.saved = body
            self.__class__.content = body
            self.__class__.version += 1
            if self.drop_put_response:
                self.__class__.drop_put_response = False
                self.close_connection = True
                return
            self.send_response(200)
            self.send_header('X-WOPI-ItemVersion', str(self.version))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_error(404)

    def lock_mismatch(self):
        self.send_response(409)
        self.send_header('X-WOPI-Lock', self.lock or '')
        self.send_header('X-WOPI-LockFailureReason', 'Lock mismatch.')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def reply(self, status, data, content_type='application/octet-stream', headers=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)


def start(handler):
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class WopiGatewayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.host = start(FakeHost)
        cls.host_origin = f'http://127.0.0.1:{cls.host.server_port}'
        cls.gateway = start(WOPI.WopiHandler)
        cls.gateway.sessions = WOPI.SessionStore()
        cls.gateway.public_url = f'http://127.0.0.1:{cls.gateway.server_port}'
        cls.gateway.allowed_origins = {cls.host_origin}
        cls.gateway.proof_signer = None
        cls.gateway.oauth_token = None
        cls.base = cls.gateway.public_url

    @classmethod
    def tearDownClass(cls):
        cls.gateway.shutdown()
        cls.host.shutdown()
        cls.gateway.server_close()
        cls.host.server_close()

    def setUp(self):
        self.gateway.coauthors = WOPI.CoauthorManager()
        FakeHost.content = b'original document'
        FakeHost.name = 'Test.docx'
        FakeHost.version = 1
        FakeHost.lock = None
        FakeHost.saved = None
        FakeHost.deleted = False
        FakeHost.drop_put_response = False
        FakeHost.drop_put_before_write = False
        FakeHost.seen_token = None

    def request(self, path, data=None, headers=None):
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {})
        return urllib.request.urlopen(req, timeout=5)

    def launch(self):
        source = self.host_origin + '/wopi/files/1'
        body = urllib.parse.urlencode({'access_token': 'secret', 'access_token_ttl': '4102444800000'}).encode()
        with self.request('/quire/?WOPISrc=' + urllib.parse.quote(source, safe=''), body,
                          {'Content-Type': 'application/x-www-form-urlencoded'}) as response:
            page = response.read().decode()
            self.assertEqual("frame-ancestors https://cloud.example.test",
                             response.headers['Content-Security-Policy'])
        match = re.search(r'window\.__VO_WOPI__=(.*?);</script>', page)
        self.assertIsNotNone(match)
        return json.loads(match.group(1))['session']

    def command(self, sid, action, **values):
        body = json.dumps({'action': action, **values}).encode()
        return self.request(
            f'/wopi/session/{sid}/command', body,
            {'Content-Type': 'application/json', 'Origin': self.base})

    def put(self, sid, payload, lock='lock-1', relative=None):
        path = f'/wopi/session/{sid}/contents'
        if relative:
            path += '?relative=' + urllib.parse.quote(relative)
        headers = {'Content-Type': 'application/octet-stream', 'Origin': self.base}
        if lock:
            headers['X-VO-WOPI-Lock'] = lock
        return self.request(path, payload, headers)

    def test_discovery_lists_apps(self):
        with self.request('/hosting/discovery') as response:
            xml = response.read().decode()
        self.assertIn('application/vnd.openxmlformats-officedocument.wordprocessingml.document', xml)
        self.assertIn('/ledger/?', xml)
        self.assertIn('ext="pptx"', xml)
        self.assertIn('?action=view&amp;', xml)
        self.assertIn('?action=edit&amp;', xml)

    def test_accepts_prefixed_wopi_file_url(self):
        source = 'https://cloud.example.test/WopiHost/files/test.docx'
        self.assertEqual(source, WOPI.validate_wopi_source(source, {'https://cloud.example.test'}))
        with self.assertRaises(WOPI.WopiError):
            WOPI.validate_wopi_source(source + '/contents', {'https://cloud.example.test'})

    def test_launch_get_lock_and_put(self):
        sid = self.launch()
        with self.request(f'/wopi/session/{sid}/info') as response:
            self.assertEqual('Test.docx', json.load(response)['BaseFileName'])
        with self.request(f'/wopi/session/{sid}/contents') as response:
            self.assertEqual(FakeHost.content, response.read())

        headers = {'Content-Type': 'application/json', 'Origin': self.base}
        with self.command(sid, 'lock', lock='lock-1'):
            pass
        self.assertEqual(self.gateway.sessions.get(sid)['coauthor_lock'], FakeHost.lock)

        payload = b'new document bytes'
        with self.put(sid, payload) as response:
            result = json.load(response)
        self.assertEqual('2', result['Version'])
        self.assertEqual(payload, FakeHost.saved)

        with self.command(sid, 'unlock', lock='lock-1'):
            pass
        with self.put(sid, payload, lock=None, relative='Copy.docx') as response:
            relative = json.load(response)
        self.assertEqual('Copy.docx', relative['Name'])
        self.assertTrue(relative['Relative'])
        self.assertIsNone(FakeHost.lock)
        self.assertEqual('/wopi/files/2', urllib.parse.urlsplit(self.gateway.sessions.get(sid)['source']).path)

    def test_get_lock_unlock_and_relock_and_rename(self):
        sid = self.launch()
        with self.command(sid, 'lock', lock='lock-1'):
            pass
        with self.command(sid, 'getLock') as response:
            self.assertEqual(self.gateway.sessions.get(sid)['coauthor_lock'], json.load(response)['Lock'])
        with self.command(sid, 'unlockAndRelock', oldLock='lock-1', lock='lock-2'):
            pass
        self.assertEqual(self.gateway.sessions.get(sid)['coauthor_lock'], FakeHost.lock)
        with self.command(sid, 'rename', lock='lock-2', name='Renamed.docx') as response:
            renamed = json.load(response)
        self.assertEqual('Renamed.docx', renamed['Name'])
        session = self.gateway.sessions.get(sid)
        self.assertEqual('Renamed.docx', session['info']['BaseFileName'])
        self.assertNotIn('access_token', session['source'])

    def test_delete_marks_gateway_session_gone(self):
        sid = self.launch()
        with self.command(sid, 'delete'):
            pass
        self.assertTrue(FakeHost.deleted)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request(f'/wopi/session/{sid}/info')
        self.assertEqual(410, caught.exception.code)
        caught.exception.close()

    def test_coauthors_share_lock_and_receive_save_event(self):
        first = self.launch()
        second = self.launch()
        with self.command(first, 'lock', lock='client-1'):
            pass
        shared = FakeHost.lock
        with self.command(second, 'lock', lock='client-2'):
            pass
        self.assertEqual(shared, FakeHost.lock)
        with self.put(first, b'coauth save', lock='client-1') as response:
            self.assertEqual('2', json.load(response)['Version'])
        with self.request(f'/wopi/session/{second}/events?since=0') as response:
            event = json.load(response)
        self.assertEqual('save', event['kind'])
        self.assertEqual(first, event['origin'])
        self.gateway.sessions.get(second)['token'] = 'peer-secret'
        with self.command(first, 'rename', lock='client-1', name='Together.docx'):
            pass
        self.assertEqual('peer-secret', self.gateway.sessions.get(second)['token'])
        with self.command(first, 'unlock', lock='client-1'):
            pass
        self.assertEqual(shared, FakeHost.lock)
        with self.command(second, 'unlock', lock='client-2'):
            pass
        self.assertIsNone(FakeHost.lock)

    def test_coauthor_recovers_an_expired_shared_host_lock(self):
        first = self.launch()
        second = self.launch()
        with self.command(first, 'lock', lock='client-1'):
            pass
        shared = FakeHost.lock
        FakeHost.lock = None
        with self.command(second, 'lock', lock='client-2'):
            pass
        self.assertEqual(shared, FakeHost.lock)
        holders = self.gateway.coauthors.states[
            self.gateway.sessions.get(second)['coauthor_key']]['holders']
        self.assertEqual({second}, holders)
        with self.command(second, 'unlock', lock='client-2'):
            pass
        self.assertIsNone(FakeHost.lock)

    def test_rejects_stale_version_before_put(self):
        sid = self.launch()
        with self.command(sid, 'lock', lock='lock-1'):
            pass
        FakeHost.content = b'external change'
        FakeHost.version = 2
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.put(sid, b'local change')
        self.assertEqual(409, caught.exception.code)
        error = json.load(caught.exception)
        self.assertEqual('version_conflict', error['code'])
        self.assertEqual('1', error['expectedVersion'])
        self.assertEqual('2', error['currentVersion'])
        caught.exception.close()

    def test_reconciles_put_when_response_is_lost(self):
        sid = self.launch()
        with self.command(sid, 'lock', lock='lock-1'):
            pass
        FakeHost.drop_put_response = True
        with self.put(sid, b'saved despite disconnect') as response:
            result = json.load(response)
        self.assertTrue(result['Reconciled'])
        self.assertEqual('2', result['Version'])

    def test_returns_network_conflict_instead_of_replaying_put(self):
        sid = self.launch()
        with self.command(sid, 'lock', lock='lock-1'):
            pass
        FakeHost.drop_put_before_write = True
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.put(sid, b'not written')
        self.assertEqual(409, caught.exception.code)
        error = json.load(caught.exception)
        self.assertEqual('network_conflict', error['code'])
        self.assertIsNone(FakeHost.saved)
        caught.exception.close()

    def test_zero_token_ttl_is_non_expiring_but_session_is_bounded(self):
        store = WOPI.SessionStore()
        sid = store.create('http://example.test/wopi/files/1', 'token', 0, {})
        item = store.get(sid)
        self.assertIsNone(item['token_expires'])
        self.assertGreater(item['expires'], int(__import__('time').time() * 1000))

    def test_refreshes_expiring_token_before_request(self):
        session = {
            'source': self.host_origin + '/wopi/files/1',
            'token': 'old',
            'token_expires': 1,
            'oauth_token': 'oauth',
            'proof_signer': None,
        }
        info = WOPI.session_file_info(session)
        self.assertEqual('Test.docx', info['BaseFileName'])
        self.assertEqual('fresh', session['token'])
        self.assertIsNone(session['token_expires'])
        self.assertEqual('fresh', FakeHost.seen_token)

    @unittest.skipUnless(shutil.which('openssl'), 'OpenSSL is required for proof-key tests')
    def test_proof_key_signatures_and_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            private = os.path.join(directory, 'private.pem')
            public = os.path.join(directory, 'public.pem')
            subprocess.run(
                ['openssl', 'genpkey', '-quiet', '-algorithm', 'RSA',
                 '-pkeyopt', 'rsa_keygen_bits:2048', '-out', private], check=True)
            subprocess.run(
                ['openssl', 'pkey', '-in', private, '-pubout', '-out', public], check=True)
            signer = WOPI.ProofSigner(private)
            url = 'https://host.test/wopi/files/1?access_token=token'
            headers = signer.headers('token', url)
            timestamp = int(headers['X-WOPI-TimeStamp'])
            expected = signer.expected('token', url, timestamp)
            signature = base64.b64decode(headers['X-WOPI-Proof'])
            expected_path = os.path.join(directory, 'expected.bin')
            signature_path = os.path.join(directory, 'signature.bin')
            with open(expected_path, 'wb') as stream:
                stream.write(expected)
            with open(signature_path, 'wb') as stream:
                stream.write(signature)
            verified = subprocess.run(
                ['openssl', 'dgst', '-sha256', '-verify', public,
                 '-signature', signature_path, expected_path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(0, verified.returncode, verified.stderr.decode())
            xml = WOPI.discovery('https://office.test', signer).decode()
            self.assertIn('<proof-key ', xml)
            self.assertIn('modulus="', xml)
            self.assertIn('oldmodulus="', xml)

    def test_rejects_unlisted_wopi_host(self):
        body = urllib.parse.urlencode({'access_token': 'secret'}).encode()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/quire/?WOPISrc=' + urllib.parse.quote('https://example.test/wopi/files/1', safe=''),
                         body, {'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(403, caught.exception.code)
        caught.exception.close()


if __name__ == '__main__':
    unittest.main()
