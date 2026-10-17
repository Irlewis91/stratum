// STRATUM for Windows: the native audio engine (plugins, STRATUM Wave, Tune, Airwindows and sample playback for tracks
// that use them). It answers the same "au…" messages from the page as the Mac app's PluginHost.
#pragma once
#define NOMINMAX
#include <windows.h>
#include <functional>
#include <string>
#include "json.h"

namespace engine {
// `reply(req, value)` answers a message that carried a request number.
void init(HWND main, std::function<void(int, const Json &)> reply);
void op(const std::string &name, const Json &body);
void shutdown();
// For the self-checks: the loudest sample played since the engine started.
float livePeak();
}
