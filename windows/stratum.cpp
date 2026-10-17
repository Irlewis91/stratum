// STRATUM for Windows: a window that runs the STRATUM web app (in the "app" folder next to this program) inside
// Microsoft Edge WebView2, which is built into Windows 10 and 11.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wrl.h>
#include <string>
#include "WebView2.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;

static ComPtr<ICoreWebView2Controller> g_controller;
static ComPtr<ICoreWebView2> g_web;
static HWND g_hwnd;
static const wchar_t* HOST = L"app.stratum";

static std::wstring exeDir() {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring p(path);
    return p.substr(0, p.find_last_of(L"\\/"));
}

static std::wstring dataDir() {
    PWSTR local = nullptr;
    std::wstring dir;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) dir = std::wstring(local) + L"\\STRATUM";
    CoTaskMemFree(local);
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir;
}

static void fail(const wchar_t* what, HRESULT hr) {
    wchar_t msg[600];
    if (hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND))
        swprintf_s(msg, L"STRATUM needs Microsoft Edge WebView2, which comes with Windows 10 and 11 but is missing on this PC.\n\n"
                        L"Install the \"Evergreen\" WebView2 Runtime from Microsoft (search for \"WebView2 Runtime download\"), then open STRATUM again.");
    else swprintf_s(msg, L"STRATUM could not start: %s (error 0x%08X).", what, (unsigned)hr);
    MessageBoxW(g_hwnd, msg, L"STRATUM", MB_ICONERROR);
    PostQuitMessage(1);
}

static void resize() {
    if (!g_controller) return;
    RECT r;
    GetClientRect(g_hwnd, &r);
    g_controller->put_Bounds(r);
}

// Links that leave STRATUM (upload pages, the manual PDF, the GitHub page) open in the default browser or PDF viewer.
static void openOutside(const std::wstring& uri) {
    std::wstring prefix = std::wstring(L"https://") + HOST + L"/";
    if (uri.rfind(prefix, 0) == 0) {
        std::wstring rel = uri.substr(prefix.size());
        for (auto& c : rel) if (c == L'/') c = L'\\';
        std::wstring file = exeDir() + L"\\app\\" + rel;
        ShellExecuteW(nullptr, L"open", file.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    } else if (uri.rfind(L"https://", 0) == 0 || uri.rfind(L"http://", 0) == 0) {
        ShellExecuteW(nullptr, L"open", uri.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }
}

static void startWebView() {
    std::wstring app = exeDir() + L"\\app";
    if (GetFileAttributesW((app + L"\\index.html").c_str()) == INVALID_FILE_ATTRIBUTES) {
        MessageBoxW(g_hwnd, L"STRATUM's \"app\" folder is missing. Keep STRATUM.exe and the app folder together, as they come in the download.", L"STRATUM", MB_ICONERROR);
        PostQuitMessage(1);
        return;
    }
    std::wstring data = dataDir() + L"\\WebView2";
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(nullptr, data.c_str(), nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([app](HRESULT res, ICoreWebView2Environment* env) -> HRESULT {
            if (FAILED(res) || !env) { fail(L"WebView2 did not start", res); return S_OK; }
            env->CreateCoreWebView2Controller(g_hwnd, Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                [app](HRESULT res, ICoreWebView2Controller* controller) -> HRESULT {
                    if (FAILED(res) || !controller) { fail(L"the STRATUM window could not be created", res); return S_OK; }
                    g_controller = controller;
                    g_controller->get_CoreWebView2(&g_web);

                    ComPtr<ICoreWebView2Settings> settings;
                    g_web->get_Settings(&settings);
                    settings->put_AreDevToolsEnabled(FALSE);
                    settings->put_IsStatusBarEnabled(FALSE);
                    settings->put_AreDefaultContextMenusEnabled(FALSE);
                    settings->put_IsZoomControlEnabled(FALSE);

                    // Tell the web app it is the Windows version.
                    g_web->AddScriptToExecuteOnDocumentCreated(L"window.STRATUM_PLATFORM = 'windows';", nullptr);

                    // Serve the app folder at https://app.stratum/ (a secure origin, so the microphone works).
                    ComPtr<ICoreWebView2_3> web3;
                    if (SUCCEEDED(g_web.As(&web3)))
                        web3->SetVirtualHostNameToFolderMapping(HOST, app.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);

                    // Recording: allow the microphone for STRATUM itself (Windows still asks the first time).
                    g_web->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>(
                        [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                            COREWEBVIEW2_PERMISSION_KIND kind;
                            args->get_PermissionKind(&kind);
                            LPWSTR uri = nullptr;
                            args->get_Uri(&uri);
                            bool ours = uri && std::wstring(uri).rfind(std::wstring(L"https://") + HOST + L"/", 0) == 0;
                            CoTaskMemFree(uri);
                            if (ours && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE) args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                            return S_OK;
                        }).Get(), nullptr);

                    // New windows (upload pages, the manual) open outside STRATUM.
                    g_web->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                        [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                            LPWSTR uri = nullptr;
                            args->get_Uri(&uri);
                            if (uri) openOutside(uri);
                            CoTaskMemFree(uri);
                            args->put_Handled(TRUE);
                            return S_OK;
                        }).Get(), nullptr);

                    // Keep the STRATUM window on STRATUM: other sites open in the default browser.
                    g_web->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>(
                        [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                            LPWSTR uri = nullptr;
                            args->get_Uri(&uri);
                            std::wstring u = uri ? uri : L"";
                            CoTaskMemFree(uri);
                            if (u.rfind(std::wstring(L"https://") + HOST + L"/", 0) != 0 && u.rfind(L"about:", 0) != 0 && u.rfind(L"blob:", 0) != 0 && u.rfind(L"data:", 0) != 0) {
                                args->put_Cancel(TRUE);
                                openOutside(u);
                            }
                            return S_OK;
                        }).Get(), nullptr);

                    // The page title becomes the window title ("STRATUM — song name").
                    g_web->add_DocumentTitleChanged(Callback<ICoreWebView2DocumentTitleChangedEventHandler>(
                        [](ICoreWebView2* sender, IUnknown*) -> HRESULT {
                            LPWSTR title = nullptr;
                            sender->get_DocumentTitle(&title);
                            if (title) SetWindowTextW(g_hwnd, title);
                            CoTaskMemFree(title);
                            return S_OK;
                        }).Get(), nullptr);

                    resize();
                    g_web->Navigate((std::wstring(L"https://") + HOST + L"/index.html").c_str());
                    return S_OK;
                }).Get());
            return S_OK;
        }).Get());
    if (FAILED(hr)) fail(L"WebView2 is not available", hr);
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_SIZE: resize(); return 0;
    case WM_GETMINMAXINFO: { auto* mm = (MINMAXINFO*)lp; mm->ptMinTrackSize = { 720, 480 }; return 0; }
    case WM_DESTROY: PostQuitMessage(0); return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = CreateSolidBrush(RGB(0x0f, 0x10, 0x16));
    wc.lpszClassName = L"STRATUM";
    wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
    wc.hIconSm = wc.hIcon;
    RegisterClassExW(&wc);
    g_hwnd = CreateWindowExW(0, L"STRATUM", L"STRATUM", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, 1440, 900, nullptr, nullptr, inst, nullptr);
    ShowWindow(g_hwnd, show == SW_SHOWDEFAULT || show == SW_SHOWNORMAL ? SW_MAXIMIZE : show);
    UpdateWindow(g_hwnd);
    startWebView();
    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0)) { TranslateMessage(&m); DispatchMessageW(&m); }
    g_controller = nullptr;
    g_web = nullptr;
    CoUninitialize();
    return (int)m.wParam;
}
