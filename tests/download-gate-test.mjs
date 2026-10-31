// Checks the Discord download gate (download-site/) against a stand-in Discord: node tests/download-gate-test.mjs
import http from 'node:http';

let guilds = [];
const fake = http.createServer((req, res) => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let body = '';
    req.on('data', d => body += d).on('end', () => {
        if (req.url === '/api/v10/oauth2/token') {
            const p = new URLSearchParams(body);
            return p.get('code') === 'good' && p.get('client_secret') === 'shh' ? send(200, { access_token: 'tok' }) : send(400, { error: 'invalid_grant' });
        }
        if (req.headers.authorization !== 'Bearer tok') return send(401, {});
        if (req.url === '/api/v10/users/@me') return send(200, { id: '42', username: 'beatmaker', global_name: 'Beat Maker' });
        if (req.url === '/api/v10/users/@me/guilds') return send(200, guilds);
        send(404, {});
    });
});
await new Promise(r => fake.listen(0, r));
Object.assign(process.env, {
    DISCORD_API: 'http://127.0.0.1:' + fake.address().port, DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'shh',
    SESSION_SECRET: 'test-session', SITE_URL: 'https://download.test', DOWNLOAD_MAC_URL: 'https://files.test/STRATUM.dmg', DOWNLOAD_WINDOWS_URL: 'https://files.test/STRATUM-Windows.zip',
});
const site = '../download-site/api/';
const api = name => import(site + name + '.js');
const call = async (name, path, cookie = '') => (await api(name)).GET(new Request('https://download.test' + path, { headers: { cookie } }));
const setCookie = (res, name) => res.headers.getSetCookie().find(c => c.startsWith(name + '='))?.split(';')[0] || '';

let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };

let r = await call('me', '/api/me');
check(!(await r.json()).signedIn, 'not signed in at first');

r = await call('login', '/api/login');
const loc = new URL(r.headers.get('location'));
const state = setCookie(r, 'stratum_state');
check(r.status === 302 && loc.host === 'discord.com' && loc.searchParams.get('scope') === 'identify guilds', 'sign-in goes to Discord asking only for name and servers');
check(loc.searchParams.get('redirect_uri') === 'https://download.test/api/callback', 'Discord sends producers back to the site');
check(state.endsWith(loc.searchParams.get('state')), 'sign-in carries a one-time check value');

r = await call('callback', '/api/callback?code=good&state=wrong', state);
check(r.headers.get('location') === '/?signin=expired' && !setCookie(r, 'stratum_session'), 'a forged return is refused');

r = await call('download', '/api/download?file=mac');
check(r.headers.get('location') === '/?signin=needed', 'no download without signing in');

guilds = [{ id: '999', name: 'Another server' }];
r = await call('callback', '/api/callback?code=good&state=' + loc.searchParams.get('state'), state);
let sess = setCookie(r, 'stratum_session');
check(r.headers.get('location') === '/?join=1', 'someone outside the server is asked to join');
let me = await (await call('me', '/api/me', sess)).json();
check(me.signedIn && !me.member && me.name === 'Beat Maker', 'page knows they are signed in but not a member');
r = await call('download', '/api/download?file=mac', sess);
check(r.headers.get('location') === '/?join=1', 'non-members get no download');

guilds.push({ id: '1561488145688694806', name: 'Stratum' });
r = await call('callback', '/api/callback?code=good&state=' + loc.searchParams.get('state'), state);
sess = setCookie(r, 'stratum_session');
check(r.headers.get('location') === '/?welcome=1', 'a member is welcomed');
r = await call('download', '/api/download?file=mac', sess);
check(r.headers.get('location') === 'https://files.test/STRATUM.dmg', 'a member gets the Mac download');
r = await call('download', '/api/download?file=windows', sess);
check(r.headers.get('location') === 'https://files.test/STRATUM-Windows.zip', 'a member gets the Windows download');
r = await call('download', '/api/download?file=manual', sess);
check(r.status === 404, 'a file that is not set up says so');

const [body, sig] = decodeURIComponent(sess.split('=')[1]).split('.');
const forged = 'stratum_session=' + Buffer.from(JSON.stringify({ id: '1', name: 'x', member: true, exp: 9e9 })).toString('base64url') + '.' + sig;
r = await call('download', '/api/download?file=mac', forged);
check(r.headers.get('location') === '/?signin=needed', 'an edited cookie is refused');

r = await call('callback', '/api/callback?code=bad&state=' + loc.searchParams.get('state'), state);
check(r.headers.get('location') === '/?signin=failed', 'a failed Discord sign-in is handled');

r = await call('logout', '/api/logout', sess);
check(setCookie(r, 'stratum_session') === 'stratum_session=', 'sign out clears the session');

fake.close();
console.log(fails ? fails + ' failed' : 'all passed');
process.exit(fails ? 1 : 0);
