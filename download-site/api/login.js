// Sends the producer to Discord to sign in. Asks only for their name and the list of servers they are in.
import { env, nonce, cookie, redirect, redirectUri } from '../lib/gate.js';

export function GET(request) {
    if (!env('DISCORD_CLIENT_ID') || !env('DISCORD_CLIENT_SECRET') || !env('SESSION_SECRET'))
        return new Response('Sign-in is not set up yet.', { status: 503 });
    const state = nonce();
    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
        client_id: env('DISCORD_CLIENT_ID'), response_type: 'code', scope: 'identify guilds',
        redirect_uri: redirectUri(request), state, prompt: 'none',
    });
    return redirect(url.toString(), [cookie('stratum_state', state, 600)]);
}
