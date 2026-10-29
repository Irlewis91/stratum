// Tells the page whether the producer is signed in and in the server.
import { session, json, INVITE } from '../lib/gate.js';

export function GET(request) {
    const s = session(request);
    return json({ invite: INVITE(), ...(s ? { signedIn: true, name: s.name, member: !!s.member } : { signedIn: false }) });
}
