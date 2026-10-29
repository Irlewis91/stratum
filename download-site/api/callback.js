// Discord sends the producer back here. Checks the sign-in, then whether they are in the Stratum server.
import { cookies, cookie, discordCheck, redirect, sign, SESSION_AGE } from '../lib/gate.js';

export async function GET(request) {
    const q = new URL(request.url).searchParams;
    const clear = cookie('stratum_state', '', 0);
    if (q.get('error')) return redirect('/?signin=cancelled', [clear]);
    if (!q.get('code') || !q.get('state') || q.get('state') !== cookies(request).stratum_state)
        return redirect('/?signin=expired', [clear]);
    try {
        const who = await discordCheck(q.get('code'), request);
        const token = sign({ id: who.id, name: who.name, member: who.member }, SESSION_AGE);
        return redirect(who.member ? '/?welcome=1' : '/?join=1', [clear, cookie('stratum_session', token, SESSION_AGE)]);
    } catch (e) {
        console.error('sign-in failed:', e.message);
        return redirect('/?signin=failed', [clear]);
    }
}
