// STRATUM for Windows: RTMP / RTMPS publishing over Winsock, with TLS from Windows' own Schannel for rtmps:// servers.
// Follows shell/rtmp.swift: handshake, connect / releaseStream / FCPublish / createStream / publish, then media messages.
#define NOMINMAX
#define SECURITY_WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <schannel.h>
#include <security.h>
#include <sspi.h>
#include "rtmp_win.h"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <random>

namespace {
void putU16(std::vector<uint8_t> &d, size_t n) { d.push_back((uint8_t)(n >> 8)); d.push_back((uint8_t)n); }
void amfString(std::vector<uint8_t> &d, const std::string &s) { d.push_back(2); putU16(d, s.size()); d.insert(d.end(), s.begin(), s.end()); }
void amfNumber(std::vector<uint8_t> &d, double v) { d.push_back(0); uint64_t b; memcpy(&b, &v, 8); for (int i = 7; i >= 0; i--) d.push_back((uint8_t)(b >> (i * 8))); }
void amfBool(std::vector<uint8_t> &d, bool v) { d.push_back(1); d.push_back(v ? 1 : 0); }
void amfNull(std::vector<uint8_t> &d) { d.push_back(5); }
void amfKey(std::vector<uint8_t> &d, const std::string &k) { putU16(d, k.size()); d.insert(d.end(), k.begin(), k.end()); }
void amfEnd(std::vector<uint8_t> &d) { d.push_back(0); d.push_back(0); d.push_back(9); }

// A small AMF0 reader: enough for command replies.
struct AmfValue { int type = -1; double n = 0; std::string s; std::vector<std::pair<std::string, AmfValue>> kv; };
struct AmfReader {
    const std::vector<uint8_t> &d; size_t o = 0;
    explicit AmfReader(const std::vector<uint8_t> &data) : d(data) {}
    bool str(std::string &out) { if (o + 2 > d.size()) return false; size_t n = d[o] << 8 | d[o + 1]; o += 2; if (o + n > d.size()) return false; out.assign((const char *)&d[o], n); o += n; return true; }
    bool pairs(AmfValue &v) {
        std::string k;
        while (str(k)) { if (k.empty() && o < d.size() && d[o] == 9) { o++; return true; } AmfValue x; if (!next(x)) return false; v.kv.emplace_back(k, x); }
        return false;
    }
    bool next(AmfValue &v) {
        if (o >= d.size()) return false;
        v.type = d[o++];
        switch (v.type) {
        case 0: { if (o + 8 > d.size()) return false; uint64_t b = 0; for (int i = 0; i < 8; i++) b = b << 8 | d[o + i]; o += 8; memcpy(&v.n, &b, 8); return true; }
        case 1: if (o >= d.size()) return false; v.n = d[o++]; return true;
        case 2: return str(v.s);
        case 3: pairs(v); return true;
        case 8: o += 4; pairs(v); return true;
        case 5: case 6: return true;
        default: return false;
        }
    }
};
std::string field(const AmfValue &obj, const std::string &k) { for (auto &p : obj.kv) if (p.first == k) return p.second.s; return ""; }
}

// ---------------------------------------------------------------- TLS (rtmps://)
struct Rtmp::Tls {
    CredHandle cred{}; CtxtHandle ctx{}; bool haveCred = false, haveCtx = false;
    SecPkgContext_StreamSizes sizes{};
    std::vector<uint8_t> incoming, plain;
    ~Tls() { if (haveCtx) DeleteSecurityContext(&ctx); if (haveCred) FreeCredentialsHandle(&cred); }

    static bool sendAll(SOCKET s, const uint8_t *d, size_t n) { while (n) { int k = ::send(s, (const char *)d, (int)std::min<size_t>(n, 1 << 20), 0); if (k <= 0) return false; d += k; n -= k; } return true; }
    bool pull(SOCKET s) { uint8_t buf[16384]; int k = ::recv(s, (char *)buf, sizeof buf, 0); if (k <= 0) return false; incoming.insert(incoming.end(), buf, buf + k); return true; }

    std::string handshake(SOCKET s, const std::wstring &host) {
        SCHANNEL_CRED sc{}; sc.dwVersion = SCHANNEL_CRED_VERSION; sc.dwFlags = SCH_CRED_AUTO_CRED_VALIDATION | SCH_CRED_NO_DEFAULT_CREDS | SCH_USE_STRONG_CRYPTO;
        if (AcquireCredentialsHandleW(nullptr, (LPWSTR)UNISP_NAME_W, SECPKG_CRED_OUTBOUND, nullptr, &sc, nullptr, nullptr, &cred, nullptr) != SEC_E_OK) return "Windows could not set up a secure connection.";
        haveCred = true;
        DWORD want = ISC_REQ_SEQUENCE_DETECT | ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY | ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM, got = 0;
        bool first = true;
        for (;;) {
            SecBuffer inb[2] = {{(unsigned long)incoming.size(), SECBUFFER_TOKEN, incoming.data()}, {0, SECBUFFER_EMPTY, nullptr}};
            SecBufferDesc inDesc{SECBUFFER_VERSION, 2, inb};
            SecBuffer outb[1] = {{0, SECBUFFER_TOKEN, nullptr}};
            SecBufferDesc outDesc{SECBUFFER_VERSION, 1, outb};
            SECURITY_STATUS st = InitializeSecurityContextW(&cred, first ? nullptr : &ctx, (SEC_WCHAR *)host.c_str(), want, 0, 0, first ? nullptr : &inDesc, 0, first ? &ctx : nullptr, &outDesc, &got, nullptr);
            if (first) haveCtx = true;
            first = false;
            if (outb[0].cbBuffer && outb[0].pvBuffer) { bool ok = sendAll(s, (uint8_t *)outb[0].pvBuffer, outb[0].cbBuffer); FreeContextBuffer(outb[0].pvBuffer); if (!ok) return "The secure connection was dropped."; }
            if (st == SEC_E_INCOMPLETE_MESSAGE) { if (!pull(s)) return "The streaming server closed the secure connection."; continue; }
            if (inb[1].BufferType == SECBUFFER_EXTRA && inb[1].cbBuffer) incoming.erase(incoming.begin(), incoming.end() - inb[1].cbBuffer);
            else if (st != SEC_E_INCOMPLETE_MESSAGE) incoming.clear();
            if (st == SEC_E_OK) break;
            if (st != SEC_I_CONTINUE_NEEDED) { char t[96]; snprintf(t, sizeof t, "The secure connection failed (0x%08X). Check the server address.", (unsigned)st); return t; }
            if (incoming.empty() && !pull(s)) return "The streaming server closed the secure connection.";
        }
        QueryContextAttributesW(&ctx, SECPKG_ATTR_STREAM_SIZES, &sizes);
        return "";
    }
    bool send(SOCKET s, const uint8_t *d, size_t n) {
        std::vector<uint8_t> buf;
        while (n) {
            size_t k = std::min<size_t>(n, sizes.cbMaximumMessage);
            buf.assign(sizes.cbHeader + k + sizes.cbTrailer, 0);
            memcpy(&buf[sizes.cbHeader], d, k);
            SecBuffer b[4] = {{sizes.cbHeader, SECBUFFER_STREAM_HEADER, &buf[0]}, {(unsigned long)k, SECBUFFER_DATA, &buf[sizes.cbHeader]},
                              {sizes.cbTrailer, SECBUFFER_STREAM_TRAILER, &buf[sizes.cbHeader + k]}, {0, SECBUFFER_EMPTY, nullptr}};
            SecBufferDesc desc{SECBUFFER_VERSION, 4, b};
            if (EncryptMessage(&ctx, 0, &desc, 0) != SEC_E_OK) return false;
            if (!sendAll(s, &buf[0], b[0].cbBuffer + b[1].cbBuffer + b[2].cbBuffer)) return false;
            d += k; n -= k;
        }
        return true;
    }
    bool recv(SOCKET s, std::vector<uint8_t> &into) {
        for (;;) {
            if (!plain.empty()) { into.insert(into.end(), plain.begin(), plain.end()); plain.clear(); return true; }
            if (incoming.empty() && !pull(s)) return false;
            SecBuffer b[4] = {{(unsigned long)incoming.size(), SECBUFFER_DATA, incoming.data()}, {0, SECBUFFER_EMPTY, nullptr}, {0, SECBUFFER_EMPTY, nullptr}, {0, SECBUFFER_EMPTY, nullptr}};
            SecBufferDesc desc{SECBUFFER_VERSION, 4, b};
            SECURITY_STATUS st = DecryptMessage(&ctx, &desc, 0, nullptr);
            if (st == SEC_E_INCOMPLETE_MESSAGE) { if (!pull(s)) return false; continue; }
            if (st == SEC_I_CONTEXT_EXPIRED) return false;
            if (st != SEC_E_OK && st != SEC_I_RENEGOTIATE) return false;
            std::vector<uint8_t> extra;
            for (auto &x : b) {
                if (x.BufferType == SECBUFFER_DATA && x.cbBuffer) plain.insert(plain.end(), (uint8_t *)x.pvBuffer, (uint8_t *)x.pvBuffer + x.cbBuffer);
                if (x.BufferType == SECBUFFER_EXTRA && x.cbBuffer) extra.assign((uint8_t *)x.pvBuffer, (uint8_t *)x.pvBuffer + x.cbBuffer);
            }
            incoming = extra;
        }
    }
};

// ---------------------------------------------------------------- connection
Rtmp::~Rtmp() { close(); }

bool Rtmp::sendRaw(const uint8_t *d, size_t n) {
    if (sock == ~(uintptr_t)0) return false;
    bool ok = tls ? tls->send((SOCKET)sock, d, n) : Tls::sendAll((SOCKET)sock, d, n);
    if (ok) sent += (long long)n;
    return ok;
}
bool Rtmp::recvSome(std::vector<uint8_t> &into) {
    if (tls) return tls->recv((SOCKET)sock, into);
    uint8_t buf[16384]; int k = ::recv((SOCKET)sock, (char *)buf, sizeof buf, 0);
    if (k <= 0) return false;
    into.insert(into.end(), buf, buf + k); return true;
}
bool Rtmp::recvExact(uint8_t *d, size_t n) {
    while (inbox.size() < n) if (!recvSome(inbox)) return false;
    memcpy(d, inbox.data(), n); inbox.erase(inbox.begin(), inbox.begin() + n); return true;
}
void Rtmp::fail(const std::string &m) {
    { std::lock_guard<std::mutex> g(lock); if (error.empty()) error = m; }
    state = 3;
}

std::string Rtmp::connect(const std::string &url, const std::string &k) {
    WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
    key = k; state = 1;
    size_t sep = url.find("://");
    std::string scheme = sep == std::string::npos ? "" : url.substr(0, sep);
    for (auto &c : scheme) c = (char)tolower((unsigned char)c);
    if (scheme != "rtmp" && scheme != "rtmps") { fail("That server address doesn't look like an rtmp:// or rtmps:// URL."); return problem(); }
    std::string rest = url.substr(sep + 3), hostport = rest.substr(0, rest.find('/')), path = rest.find('/') == std::string::npos ? "" : rest.substr(rest.find('/') + 1);
    while (!path.empty() && path.back() == '/') path.pop_back();
    std::string host = hostport, port = scheme == "rtmps" ? "443" : "1935";
    if (hostport.find(':') != std::string::npos) { host = hostport.substr(0, hostport.find(':')); port = hostport.substr(hostport.find(':') + 1); }
    app = path.empty() ? "live" : path;
    tcUrl = scheme + "://" + hostport + "/" + app;

    addrinfo hints{}, *res = nullptr; hints.ai_socktype = SOCK_STREAM; hints.ai_family = AF_UNSPEC;
    if (getaddrinfo(host.c_str(), port.c_str(), &hints, &res) || !res) { fail("Could not reach the streaming server: its address was not found."); return problem(); }
    SOCKET s = INVALID_SOCKET;
    for (addrinfo *a = res; a && s == INVALID_SOCKET; a = a->ai_next) {
        s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s != INVALID_SOCKET && ::connect(s, a->ai_addr, (int)a->ai_addrlen) != 0) { closesocket(s); s = INVALID_SOCKET; }
    }
    freeaddrinfo(res);
    if (s == INVALID_SOCKET) { fail("Could not reach the streaming server."); return problem(); }
    BOOL nd = TRUE; setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&nd, sizeof nd);
    sock = (uintptr_t)s;
    if (scheme == "rtmps") {
        tls = new Tls();
        std::wstring wh(host.begin(), host.end());
        std::string e = tls->handshake(s, wh);
        if (!e.empty()) { fail(e); return problem(); }
    }
    // Handshake: C0 C1 -> S0 S1 S2 -> C2 (echoes S1).
    std::vector<uint8_t> c01(1537, 0); c01[0] = 3;
    std::mt19937 rng((unsigned)std::chrono::steady_clock::now().time_since_epoch().count());
    for (int i = 9; i < 1537; i++) c01[i] = (uint8_t)rng();
    if (!sendRaw(c01.data(), c01.size())) { fail("The streaming server closed the connection."); return problem(); }
    std::vector<uint8_t> s012(3073);
    if (!recvExact(s012.data(), s012.size())) { fail("The streaming server closed the connection during setup."); return problem(); }
    if (!sendRaw(&s012[1], 1536)) { fail("The streaming server closed the connection."); return problem(); }

    outChunk = 4096;
    std::vector<uint8_t> cs = {0, 0, 0x10, 0};   // chunk size 4096
    message(1, 2, 0, 0, cs);
    std::vector<uint8_t> a;
    a.push_back(3); amfKey(a, "app"); amfString(a, app); amfKey(a, "type"); amfString(a, "nonprivate"); amfKey(a, "flashVer"); amfString(a, "FMLE/3.0 (compatible; STRATUM)"); amfKey(a, "tcUrl"); amfString(a, tcUrl); amfEnd(a);
    command("connect", 1, a, 3, 0);
    a.clear(); amfNull(a); amfString(a, key); command("releaseStream", 2, a, 3, 0);
    a.clear(); amfNull(a); amfString(a, key); command("FCPublish", 3, a, 3, 0);
    a.clear(); amfNull(a); command("createStream", 4, a, 3, 0);
    reader = std::thread([this] { readLoop(); });
    for (int i = 0; i < 300 && state == 1; i++) Sleep(50);
    if (state == 1) fail("The streaming server did not answer. Check the server address and stream key.");
    return state == 2 ? "" : problem();
}

void Rtmp::message(uint8_t type, uint8_t csid, uint32_t msid, uint32_t ts, const std::vector<uint8_t> &payload) {
    std::vector<uint8_t> out;
    bool ext = ts >= 0xFFFFFF; uint32_t t = ext ? 0xFFFFFF : ts;
    size_t n = payload.size();
    out.reserve(n + n / 4096 * 5 + 16);
    out.push_back(csid & 0x3F);
    out.push_back((uint8_t)(t >> 16)); out.push_back((uint8_t)(t >> 8)); out.push_back((uint8_t)t);
    out.push_back((uint8_t)(n >> 16)); out.push_back((uint8_t)(n >> 8)); out.push_back((uint8_t)n); out.push_back(type);
    out.push_back((uint8_t)msid); out.push_back((uint8_t)(msid >> 8)); out.push_back((uint8_t)(msid >> 16)); out.push_back((uint8_t)(msid >> 24));
    auto ext4 = [&] { out.push_back((uint8_t)(ts >> 24)); out.push_back((uint8_t)(ts >> 16)); out.push_back((uint8_t)(ts >> 8)); out.push_back((uint8_t)ts); };
    if (ext) ext4();
    for (size_t i = 0; i < n;) {
        if (i) { out.push_back(0xC0 | (csid & 0x3F)); if (ext) ext4(); }
        size_t m = std::min<size_t>(outChunk, n - i);
        out.insert(out.end(), payload.begin() + i, payload.begin() + i + m);
        i += m;
    }
    std::lock_guard<std::mutex> g(sendLock);
    if (!sendRaw(out.data(), out.size()) && state == 2) fail("The stream connection dropped.");
}

void Rtmp::command(const std::string &name, double tx, const std::vector<uint8_t> &args, uint8_t csid, uint32_t msid) {
    std::vector<uint8_t> p; amfString(p, name); amfNumber(p, tx); p.insert(p.end(), args.begin(), args.end());
    message(20, csid, msid, 0, p);
}

void Rtmp::metadata(int width, int height, double fps, double vk, double ak) {
    std::vector<uint8_t> p;
    amfString(p, "@setDataFrame"); amfString(p, "onMetaData");
    p.push_back(8); p.push_back(0); p.push_back(0); p.push_back(0); p.push_back(11);
    auto num = [&](const char *k, double v) { amfKey(p, k); amfNumber(p, v); };
    num("width", width); num("height", height); num("framerate", fps); num("videocodecid", 7); num("videodatarate", vk);
    num("audiocodecid", 10); num("audiodatarate", ak); num("audiosamplerate", 48000); num("audiosamplesize", 16);
    amfKey(p, "stereo"); amfBool(p, true); amfKey(p, "encoder"); amfString(p, "STRATUM"); amfEnd(p);
    message(18, 4, streamId, 0, p);
}
void Rtmp::video(const std::vector<uint8_t> &body, uint32_t ts) { if (state == 2) message(9, 6, streamId, ts, body); }
void Rtmp::audio(const std::vector<uint8_t> &body, uint32_t ts) { if (state == 2) message(8, 7, streamId, ts, body); }

void Rtmp::close() {
    if (sock != ~(uintptr_t)0) {
        if (streamId && state == 2) { std::vector<uint8_t> a; amfNull(a); amfNumber(a, streamId); command("deleteStream", 6, a, 3, 0); }
        state = 4;
        shutdown((SOCKET)sock, SD_BOTH); closesocket((SOCKET)sock); sock = ~(uintptr_t)0;
    }
    if (reader.joinable()) reader.join();
    delete tls; tls = nullptr;
}

void Rtmp::readLoop() {
    for (;;) {
        if (!recvSome(inbox)) { if (state == 2 || state == 1) fail(state == 1 ? "The streaming server closed the connection during setup." : "The streaming server ended the stream."); return; }
        for (;;) {   // whole chunks in the inbox
            if (inbox.empty()) break;
            size_t o = 0;
            uint8_t fmt = inbox[0] >> 6; uint32_t csid = inbox[0] & 0x3F; o = 1;
            if (csid == 0) { if (inbox.size() < 2) break; csid = inbox[1] + 64; o = 2; }
            else if (csid == 1) { if (inbox.size() < 3) break; csid = inbox[1] + inbox[2] * 256 + 64; o = 3; }
            static const int hl[4] = {11, 7, 3, 0};
            if (inbox.size() < o + hl[fmt]) break;
            InHeader &h = inHeaders[csid % 64];
            InHeader nh = h;
            if (fmt <= 2) nh.ts = inbox[o] << 16 | inbox[o + 1] << 8 | inbox[o + 2];
            if (fmt <= 1) { nh.len = inbox[o + 3] << 16 | inbox[o + 4] << 8 | inbox[o + 5]; nh.type = inbox[o + 6]; }
            if (fmt == 0) nh.sid = inbox[o + 7] | inbox[o + 8] << 8 | inbox[o + 9] << 16 | inbox[o + 10] << 24;
            o += hl[fmt];
            if (fmt <= 2 && nh.ts == 0xFFFFFF) { if (inbox.size() < o + 4) break; o += 4; }
            size_t have = h.partial.size(), take = std::min<size_t>(inChunk, nh.len > (int)have ? nh.len - have : 0);
            if (inbox.size() < o + take) break;
            h.ts = nh.ts; h.len = nh.len; h.type = nh.type; h.sid = nh.sid;
            h.partial.insert(h.partial.end(), inbox.begin() + o, inbox.begin() + o + take);
            inbox.erase(inbox.begin(), inbox.begin() + o + take);
            if ((int)h.partial.size() >= h.len) { std::vector<uint8_t> m; m.swap(h.partial); handle(h.type, m); }
        }
    }
}

void Rtmp::handle(uint8_t type, const std::vector<uint8_t> &m) {
    if (type == 1 && m.size() >= 4) { inChunk = (int)((m[0] << 24 | m[1] << 16 | m[2] << 8 | m[3]) & 0x7FFFFFFF); return; }
    if (type == 4 && m.size() >= 6 && m[1] == 6) { std::vector<uint8_t> p = {0, 7, m[2], m[3], m[4], m[5]}; message(4, 2, 0, 0, p); return; }
    if (type != 20) return;
    AmfReader r(m);
    AmfValue name, tx;
    if (!r.next(name) || name.type != 2 || !r.next(tx)) return;
    std::vector<AmfValue> rest; AmfValue v;
    while (r.next(v)) { rest.push_back(v); v = AmfValue(); }
    if (name.s == "_result" && tx.n == 4) {
        for (auto &x : rest) if (x.type == 0) { streamId = (uint32_t)x.n; break; }
        std::vector<uint8_t> a; amfNull(a); amfString(a, key); amfString(a, "live");
        command("publish", 5, a, 8, streamId);
    } else if (name.s == "onStatus" && !rest.empty()) {
        const AmfValue &info = rest.back();
        std::string code = field(info, "code"), desc = field(info, "description"), level = field(info, "level");
        if (code == "NetStream.Publish.Start") state = 2;
        else if (code.find("Failed") != std::string::npos || code.find("BadName") != std::string::npos || code.find("Rejected") != std::string::npos || level == "error")
            fail("The streaming server refused the stream: " + (desc.empty() ? code : desc) + ". Check the stream key.");
    } else if (name.s == "_error") {
        std::string desc = rest.empty() ? "" : field(rest.back(), "description");
        fail("The streaming server refused the connection: " + (desc.empty() ? std::string("unknown error") : desc));
    }
}
