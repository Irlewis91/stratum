// STRATUM for Windows: the app's other native features (stem separation, Record from another app, sharing, Go live).
// Each answers the same messages from the page as the Mac app.
#pragma once
#define NOMINMAX
#include <windows.h>
#include <functional>
#include <string>
#include "json.h"

namespace features {
// `runJs` runs a script in the page; it may be called from any thread. `reply(req, value)` answers a request.
void init(HWND main, std::function<void(const std::wstring &)> runJs, std::function<void(int, const Json &)> reply);
// Returns true when the message was one of these features'.
bool op(const std::string &name, const Json &body);
void shutdown();
}
