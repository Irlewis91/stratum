// A small JSON value with a parser and writer, for the messages between the STRATUM page and the Windows app.
#pragma once
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::map<std::string, Json> o;

    Json() {}
    Json(std::nullptr_t) {}
    Json(bool v) : type(Bool), b(v) {}
    Json(int v) : type(Number), n(v) {}
    Json(long long v) : type(Number), n((double)v) {}
    Json(double v) : type(Number), n(v) {}
    Json(const char *v) : type(String), s(v) {}
    Json(const std::string &v) : type(String), s(v) {}
    static Json array() { Json j; j.type = Array; return j; }
    static Json object() { Json j; j.type = Object; return j; }

    const Json &operator[](const std::string &k) const { static Json none; auto it = o.find(k); return it == o.end() ? none : it->second; }
    Json &operator[](const std::string &k) { type = Object; return o[k]; }
    const Json &operator[](size_t i) const { static Json none; return i < a.size() ? a[i] : none; }
    void push(const Json &v) { type = Array; a.push_back(v); }
    size_t size() const { return type == Array ? a.size() : o.size(); }
    bool has(const std::string &k) const { return type == Object && o.count(k); }

    double num(double d = 0) const { return type == Number ? n : type == Bool ? (b ? 1 : 0) : d; }
    int integer(int d = 0) const { return type == Number ? (int)std::lround(n) : d; }
    bool truthy(bool d = false) const { return type == Bool ? b : type == Number ? n != 0 : d; }
    std::string str(const std::string &d = "") const { return type == String ? s : d; }

    // ---- writing ----
    static void quote(const std::string &v, std::string &out) {
        out += '"';
        for (unsigned char c : v) {
            switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) { char t[8]; snprintf(t, sizeof t, "\\u%04x", c); out += t; }
                else out += (char)c;
            }
        }
        out += '"';
    }
    void write(std::string &out) const {
        switch (type) {
        case Null: out += "null"; break;
        case Bool: out += b ? "true" : "false"; break;
        case Number: {
            if (!std::isfinite(n)) { out += "0"; break; }
            char t[32];
            if (n == std::floor(n) && std::fabs(n) < 1e15) snprintf(t, sizeof t, "%lld", (long long)n); else snprintf(t, sizeof t, "%.9g", n);
            out += t; break;
        }
        case String: quote(s, out); break;
        case Array: { out += '['; for (size_t i = 0; i < a.size(); i++) { if (i) out += ','; a[i].write(out); } out += ']'; break; }
        case Object: { out += '{'; bool first = true; for (auto &kv : o) { if (!first) out += ','; first = false; quote(kv.first, out); out += ':'; kv.second.write(out); } out += '}'; break; }
        }
    }
    std::string dump() const { std::string out; write(out); return out; }

    // ---- reading ----
    static Json parse(const std::string &text) { size_t i = 0; Json j = value(text, i); return j; }

private:
    static void ws(const std::string &t, size_t &i) { while (i < t.size() && (t[i] == ' ' || t[i] == '\n' || t[i] == '\r' || t[i] == '\t')) i++; }
    static void utf8(unsigned cp, std::string &out) {
        if (cp < 0x80) out += (char)cp;
        else if (cp < 0x800) { out += (char)(0xC0 | cp >> 6); out += (char)(0x80 | (cp & 63)); }
        else if (cp < 0x10000) { out += (char)(0xE0 | cp >> 12); out += (char)(0x80 | (cp >> 6 & 63)); out += (char)(0x80 | (cp & 63)); }
        else { out += (char)(0xF0 | cp >> 18); out += (char)(0x80 | (cp >> 12 & 63)); out += (char)(0x80 | (cp >> 6 & 63)); out += (char)(0x80 | (cp & 63)); }
    }
    static std::string string(const std::string &t, size_t &i) {
        std::string out;
        i++;  // opening quote
        while (i < t.size() && t[i] != '"') {
            char c = t[i++];
            if (c != '\\') { out += c; continue; }
            if (i >= t.size()) break;
            char e = t[i++];
            switch (e) {
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                unsigned cp = (unsigned)strtoul(t.substr(i, 4).c_str(), nullptr, 16); i += 4;
                if (cp >= 0xD800 && cp < 0xDC00 && i + 6 <= t.size() && t[i] == '\\' && t[i + 1] == 'u') {
                    unsigned lo = (unsigned)strtoul(t.substr(i + 2, 4).c_str(), nullptr, 16);
                    if (lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i += 6; }
                }
                utf8(cp, out); break;
            }
            default: out += e;
            }
        }
        i++;  // closing quote
        return out;
    }
    static Json value(const std::string &t, size_t &i) {
        ws(t, i);
        if (i >= t.size()) return Json();
        char c = t[i];
        if (c == '{') {
            Json j = object(); i++;
            ws(t, i);
            if (i < t.size() && t[i] == '}') { i++; return j; }
            while (i < t.size()) {
                ws(t, i);
                if (t[i] != '"') break;
                std::string k = string(t, i);
                ws(t, i); if (i < t.size() && t[i] == ':') i++;
                j.o[k] = value(t, i);
                ws(t, i);
                if (i < t.size() && t[i] == ',') { i++; continue; }
                if (i < t.size() && t[i] == '}') { i++; break; }
                break;
            }
            return j;
        }
        if (c == '[') {
            Json j = array(); i++;
            ws(t, i);
            if (i < t.size() && t[i] == ']') { i++; return j; }
            while (i < t.size()) {
                j.a.push_back(value(t, i));
                ws(t, i);
                if (i < t.size() && t[i] == ',') { i++; continue; }
                if (i < t.size() && t[i] == ']') { i++; break; }
                break;
            }
            return j;
        }
        if (c == '"') return Json(string(t, i));
        if (t.compare(i, 4, "true") == 0) { i += 4; return Json(true); }
        if (t.compare(i, 5, "false") == 0) { i += 5; return Json(false); }
        if (t.compare(i, 4, "null") == 0) { i += 4; return Json(); }
        char *end = nullptr;
        double v = strtod(t.c_str() + i, &end);
        i = end ? (size_t)(end - t.c_str()) : i + 1;
        return Json(v);
    }
};

// Base64, for audio and plugin settings carried inside messages.
inline std::string b64encode(const unsigned char *d, size_t n) {
    static const char *T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out; out.reserve((n + 2) / 3 * 4);
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = d[i] << 16 | (i + 1 < n ? d[i + 1] << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
        out += T[v >> 18 & 63]; out += T[v >> 12 & 63]; out += i + 1 < n ? T[v >> 6 & 63] : '='; out += i + 2 < n ? T[v & 63] : '=';
    }
    return out;
}
inline std::vector<unsigned char> b64decode(const std::string &s) {
    static int R[256]; static bool init = false;
    if (!init) { for (int i = 0; i < 256; i++) R[i] = -1; const char *T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (int i = 0; i < 64; i++) R[(unsigned char)T[i]] = i; init = true; }
    std::vector<unsigned char> out; out.reserve(s.size() * 3 / 4);
    unsigned v = 0; int bits = 0;
    for (unsigned char c : s) { int x = R[c]; if (x < 0) continue; v = v << 6 | x; bits += 6; if (bits >= 8) { bits -= 8; out.push_back((unsigned char)(v >> bits & 255)); } }
    return out;
}
