// Hands members the download. The files live at unlisted addresses set in DOWNLOAD_MAC_URL and DOWNLOAD_WINDOWS_URL.
import { env, session, redirect } from '../lib/gate.js';

const FILES = { mac: 'DOWNLOAD_MAC_URL', windows: 'DOWNLOAD_WINDOWS_URL', manual: 'DOWNLOAD_MANUAL_URL' };

export function GET(request) {
    const which = new URL(request.url).searchParams.get('file');
    const s = session(request);
    if (!s) return redirect('/?signin=needed');
    if (!s.member) return redirect('/?join=1');
    const url = FILES[which] && env(FILES[which]);
    if (!url) return new Response('That download is not available yet.', { status: 404 });
    console.log('download', which, s.id);
    return redirect(url);
}
