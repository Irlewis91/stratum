# A stand-in for the parts of Supabase that STRATUM Sync uses (sign-in, the projects table, the projects bucket), for
# self-checks: python3 tests/mock-sync-server.py 8799. The email code is always 123456.
import json, sys, uuid, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
users, tokens, refresh, rows, objects = {}, {}, {}, {}, {}
CODE = '123456'
def new_session(uid):
    a, r = 'at-' + uuid.uuid4().hex, 'rt-' + uuid.uuid4().hex
    tokens[a] = uid; refresh[r] = uid
    return {'access_token': a, 'refresh_token': r, 'expires_in': 3600, 'token_type': 'bearer', 'user': users_by_id[uid]}
users_by_id = {}
def user_for(email):
    if email not in users:
        uid = str(uuid.uuid4()); users[email] = uid; users_by_id[uid] = {'id': uid, 'email': email}
    return users[email]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*'); self.send_header('Access-Control-Allow-Headers', '*'); self.send_header('Access-Control-Allow-Methods', '*'); self.send_header('Access-Control-Allow-Private-Network', 'true')
    def reply(self, code, body=b'', ctype='application/json'):
        if not isinstance(body, (bytes, bytearray)): body = json.dumps(body).encode()
        self.send_response(code); self.cors(); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self.reply(204)
    def body(self):
        n = int(self.headers.get('Content-Length') or 0); return self.rfile.read(n) if n else b''
    def who(self):
        a = (self.headers.get('Authorization') or '').replace('Bearer ', ''); return tokens.get(a)
    def route(self, method):
        u = urllib.parse.urlparse(self.path); p, q = u.path, urllib.parse.parse_qs(u.query)
        if p == '/__state': return self.reply(200, {'rows': list(rows.values()), 'objects': {k: len(v) for k, v in objects.items()}})
        if self.headers.get('apikey') != 'test-anon-key' and not p.startswith('/auth/v1/authorize'): return self.reply(401, {'message': 'bad apikey'})
        if p == '/auth/v1/otp': return self.reply(200, {})
        if p == '/auth/v1/verify':
            b = json.loads(self.body()); 
            if b.get('token') != CODE: return self.reply(403, {'msg': 'Token has expired or is invalid'})
            return self.reply(200, new_session(user_for(b['email'])))
        if p == '/auth/v1/authorize':
            uid = user_for('discord-user@example.com'); s = new_session(uid)
            loc = q['redirect_to'][0] + '#' + urllib.parse.urlencode({k: s[k] for k in ('access_token', 'refresh_token', 'expires_in', 'token_type')})
            # Like Discord: a page is shown first, then it returns to STRATUM.
            page = ('<html><body style="background:#5865f2;color:#fff;font:24px sans-serif">Pretend Discord: authorising STRATUM...'
                    '<script>setTimeout(function(){location.href=' + json.dumps(loc) + '},1200)</script></body></html>').encode()
            return self.reply(200, page, 'text/html')
        if p == '/auth/v1/token':
            r = json.loads(self.body()).get('refresh_token'); uid = refresh.pop(r, None)
            return self.reply(200, new_session(uid)) if uid else self.reply(400, {'error_description': 'Invalid Refresh Token'})
        uid = self.who()
        if not uid: return self.reply(401, {'message': 'not signed in'})
        if p == '/auth/v1/user': return self.reply(200, users_by_id[uid])
        if p == '/auth/v1/logout': return self.reply(204)
        if p == '/rest/v1/projects':
            mine = [r for (u_, i), r in rows.items() if u_ == uid]
            if 'id' in q: mine = [r for r in mine if 'eq.' + r['id'] == q['id'][0]]
            if method == 'GET':
                cols = q.get('select', ['*'])[0].split(','); return self.reply(200, sorted([{c: r.get(c) for c in cols} for r in mine], key=lambda r: r.get('updated_at') or '', reverse=True))
            if method == 'POST':
                b = json.loads(self.body())
                if b.get('user_id') != uid: return self.reply(403, {'message': 'row-level security'})
                rows[(uid, b['id'])] = {**rows.get((uid, b['id']), {}), **b}; return self.reply(201)
            if method == 'DELETE':
                for r in mine: rows.pop((uid, r['id']), None)
                return self.reply(204)
        if p.startswith('/storage/v1/object/'):
            rest = p[len('/storage/v1/object/'):]
            if rest.startswith('authenticated/'): rest = rest[len('authenticated/'):]
            bucket, _, path = rest.partition('/'); path = urllib.parse.unquote(path)
            if path.split('/')[0] != uid: return self.reply(403, {'message': 'row-level security'})
            if method == 'POST': objects[path] = self.body(); return self.reply(200, {'Key': path})
            if method == 'GET': return self.reply(200, objects[path], 'application/octet-stream') if path in objects else self.reply(404, {'message': 'not found'})
            if method == 'DELETE': objects.pop(path, None); return self.reply(200, [])
        if p == '/__state': return self.reply(200, {'rows': list(rows.values()), 'objects': {k: len(v) for k, v in objects.items()}})
        self.reply(404, {'message': 'no route ' + p})
    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def do_DELETE(self): self.route('DELETE')
ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
