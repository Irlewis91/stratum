// STRATUM for Windows: an RTMP / RTMPS publisher (the same protocol subset as shell/rtmp.swift), enough to send live
// H.264 video and AAC audio to Twitch, YouTube, Instagram, TikTok and other servers that take a URL and a stream key.
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class Rtmp {
public:
    ~Rtmp();
    // Connects, publishes and waits until the server accepts the stream. Returns an error message, or "" when live.
    std::string connect(const std::string &url, const std::string &key);
    void metadata(int width, int height, double fps, double videoKbps, double audioKbps);
    void video(const std::vector<uint8_t> &body, uint32_t ts);
    void audio(const std::vector<uint8_t> &body, uint32_t ts);
    void close();
    bool live() const { return state == 2; }
    std::string problem() const { std::lock_guard<std::mutex> g(lock); return error; }
    long long bytesSent() const { return sent; }
private:
    struct Tls;
    uintptr_t sock = ~(uintptr_t)0;
    Tls *tls = nullptr;
    std::atomic<int> state{0};          // 0 idle, 1 connecting, 2 live, 3 failed, 4 closed
    mutable std::mutex lock;            // error text
    std::mutex sendLock;
    std::string error, app, tcUrl, key;
    uint32_t streamId = 0;
    int outChunk = 128, inChunk = 128;
    std::atomic<long long> sent{0};
    std::thread reader;
    std::vector<uint8_t> inbox;
    struct InHeader { uint32_t ts = 0; int len = 0; uint8_t type = 0; uint32_t sid = 0; std::vector<uint8_t> partial; };
    InHeader inHeaders[64];

    bool sendRaw(const uint8_t *d, size_t n);
    bool recvSome(std::vector<uint8_t> &into);
    bool recvExact(uint8_t *d, size_t n);
    void message(uint8_t type, uint8_t csid, uint32_t msid, uint32_t ts, const std::vector<uint8_t> &payload);
    void command(const std::string &name, double tx, const std::vector<uint8_t> &args, uint8_t csid, uint32_t msid);
    void fail(const std::string &m);
    void readLoop();
    void handle(uint8_t type, const std::vector<uint8_t> &m);
};
