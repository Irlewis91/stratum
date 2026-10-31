// STRATUM download gate: shared settings, a signed session cookie, and the Discord calls.
// Settings come from the Vercel project's environment variables (see README.md in this folder).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const env = name => process.env[name] || '';
export const GUILD = () => env('DISCORD_GUILD_ID') || '1561488145688694806';   // the "Stratum" server
export const INVITE = () => env('DISCORD_INVITE') || 'https://discord.gg/PtpChEj8Gc';
export const DISCORD = () => env('DISCORD_API') || 'https://discord.com';      // overridden only by the tests
const DAY = 86400;

const key = () => env('SESSION_SECRET');   // never the Discord secret: one leak must not give away both
const b64 = s => Buffer.from(s).toString('base64url');
const mac = s => createHmac('sha256', key()).update(s).digest('base64url');

export function sign(data, maxAge) {
    if (!key()) throw new Error('SESSION_SECRET is not set');
    const body = b64(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + maxAge }));
    return body + '.' + mac(body);
}

export function verify(token) {
    if (!token || !key()) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        return data.exp > Date.now() / 1000 ? data : null;
    } catch { return null; }
}

export function cookies(request) {
    const out = {};
    for (const part of (request.headers.get('cookie') || '').split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* a malformed cookie is ignored */ }
    }
    return out;
}

export const cookie = (name, value, maxAge) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const session = request => verify(cookies(request).stratum_session);
export const SESSION_AGE = DAY;   // short, so leaving the server ends access within a day
export const nonce = () => randomBytes(18).toString('base64url');

export const origin = request => env('SITE_URL') || new URL(request.url).origin;
export const redirectUri = request => origin(request) + '/api/callback';

export function redirect(location, setCookies = []) {
    const headers = new Headers({ Location: location });
    for (const c of setCookies) headers.append('Set-Cookie', c);
    return new Response(null, { status: 302, headers });
}

export const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Exchanges the sign-in code for a token, then reads who the producer is and whether they are in the server.
export async function discordCheck(code, request) {
    const tok = await fetch(DISCORD() + '/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code', code, redirect_uri: redirectUri(request),
            client_id: env('DISCORD_CLIENT_ID'), client_secret: env('DISCORD_CLIENT_SECRET'),
        }),
    });
    if (!tok.ok) throw new Error('Discord did not accept the sign-in (' + tok.status + ')');
    const { access_token } = await tok.json();
    const auth = { headers: { Authorization: 'Bearer ' + access_token } };
    const [me, guilds] = await Promise.all([
        fetch(DISCORD() + '/api/v10/users/@me', auth).then(r => r.ok ? r.json() : Promise.reject(new Error('profile ' + r.status))),
        fetch(DISCORD() + '/api/v10/users/@me/guilds', auth).then(r => r.ok ? r.json() : Promise.reject(new Error('servers ' + r.status))),
    ]);
    return { id: me.id, name: me.global_name || me.username, member: guilds.some(g => g.id === GUILD()) };
}
