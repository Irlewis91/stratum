// STRATUM for Windows: Go live (live_win.cpp).
#pragma once
#define NOMINMAX
#include <windows.h>
#include <string>
#include "json.h"

namespace live {
// Connects and starts streaming `window`; returns an error message, or "" once live. Blocks while connecting.
std::string start(HWND window, const std::string &url, const std::string &key, bool camera, bool mic);
void stop();
Json status();
// Stream keys the producer asked STRATUM to remember, kept in Windows Credential Manager.
void saveKey(const std::string &platform, const std::string &url, const std::string &key);
Json loadKey(const std::string &platform);
}
