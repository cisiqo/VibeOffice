import http.server
import importlib.util
import json
import os
import re
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
    lock = None
    saved = None

    def log_message(self, *_):
        pass

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == '/wopi/files/1':
            data = json.dumps({
                'BaseFileName': 'Test.docx', 'Size': len(self.content), 'Version': '1',
                'OwnerId': 'owner-1',
                'UserCanWrite': True, 'SupportsLocks': True, 'SupportsUpdate': True,
                'PostMessageOrigin': 'https://cloud.example.test',
            }).encode()
            return self.reply(200, data, 'application/json')
        if path == '/wopi/files/1/contents':
            return self.reply(200, self.content)
        self.send_error(404)

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        override = self.headers.get('X-WOPI-Override')
        lock = self.headers.get('X-WOPI-Lock')
        if path == '/wopi/files/1' and override == 'PUT_RELATIVE':
            n = int(self.headers['Content-Length'])
            self.__class__.saved = self.rfile.read(n)
            port = self.server.server_port
            data = json.dumps({'Name': 'Copy.docx', 'Url': f'http://127.0.0.1:{port}/wopi/files/2?access_token=next'}).encode()
            return self.reply(200, data, 'application/json')
        if path == '/wopi/files/1' and override in ('LOCK', 'REFRESH_LOCK', 'UNLOCK'):
            if override == 'LOCK':
                self.__class__.lock = lock
            elif override == 'UNLOCK':
                self.__class__.lock = None
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if path == '/wopi/files/1/contents' and override == 'PUT':
            n = int(self.headers['Content-Length'])
            self.__class__.saved = self.rfile.read(n)
            self.send_response(200)
            self.send_header('X-WOPI-ItemVersion', '2')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_error(404)

    def reply(self, status, data, content_type='application/octet-stream'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
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
        cls.base = cls.gateway.public_url

    @classmethod
    def tearDownClass(cls):
        cls.gateway.shutdown()
        cls.host.shutdown()
        cls.gateway.server_close()
        cls.host.server_close()

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
        body = json.dumps({'action': 'lock', 'lock': 'lock-1'}).encode()
        with self.request(f'/wopi/session/{sid}/command', body, headers):
            pass
        self.assertEqual('lock-1', FakeHost.lock)

        payload = b'new document bytes'
        with self.request(f'/wopi/session/{sid}/contents', payload,
                          {'Content-Type': 'application/octet-stream', 'Origin': self.base,
                           'X-VO-WOPI-Lock': 'lock-1'}) as response:
            result = json.load(response)
        self.assertEqual('2', result['Version'])
        self.assertEqual(payload, FakeHost.saved)

        body = json.dumps({'action': 'unlock', 'lock': 'lock-1'}).encode()
        with self.request(f'/wopi/session/{sid}/command', body, headers):
            pass
        with self.request(f'/wopi/session/{sid}/contents?relative=Copy.docx', payload,
                          {'Content-Type': 'application/octet-stream', 'Origin': self.base}) as response:
            relative = json.load(response)
        self.assertEqual('Copy.docx', relative['Name'])
        self.assertTrue(relative['Relative'])
        self.assertIsNone(FakeHost.lock)
        self.assertEqual('/wopi/files/2', urllib.parse.urlsplit(self.gateway.sessions.get(sid)['source']).path)

    def test_rejects_unlisted_wopi_host(self):
        body = urllib.parse.urlencode({'access_token': 'secret'}).encode()
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/quire/?WOPISrc=' + urllib.parse.quote('https://example.test/wopi/files/1', safe=''),
                         body, {'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(403, caught.exception.code)
        caught.exception.close()


if __name__ == '__main__':
    unittest.main()
