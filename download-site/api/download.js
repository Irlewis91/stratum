// Hands members the download. With DOWNLOAD_TOKEN set, the files come from a private release through short-lived links;
// otherwise from the addresses in DOWNLOAD_MAC_URL, DOWNLOAD_WINDOWS_URL and DOWNLOAD_MANUAL_URL.
import { env, session, redirect, privateLink } from '../lib/gate.js';

const FILES = {
    mac: ['DOWNLOAD_MAC_URL', 'STRATUM.dmg'],
    windows: ['DOWNLOAD_WINDOWS_URL', 'STRATUM-Windows.zip'],
    manual: ['DOWNLOAD_MANUAL_URL', 'STRATUM-Owners-Manual.pdf'],
};
const missing = () => new Response('That download is not available right now. Please try again in a minute.', { status: 503 });

export async function GET(request) {
    const which = new URL(request.url).searchParams.get('file');
    const s = session(request);
    if (!s) return redirect('/?signin=needed');
    if (!s.member) return redirect('/?join=1');
    const item = Object.hasOwn(FILES, which) ? FILES[which] : null;
    if (!item) return new Response('That download is not available.', { status: 404 });
    console.log('download', which, s.id);
    if (!env('DOWNLOAD_TOKEN')) return env(item[0]) ? redirect(env(item[0])) : new Response('That download is not available yet.', { status: 404 });
    try {   // never falls back to a public address: a failure here must not open the gate
        const url = await privateLink(item[1]);
        return url ? redirect(url) : missing();
    } catch (e) {
        console.error('download failed:', e.message);
        return missing();
    }
}
