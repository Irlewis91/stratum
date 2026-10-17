@echo off
rem Builds STRATUM.exe for Windows (x64). Run from a "x64 Native Tools Command Prompt for VS" with nuget.exe on the PATH.
setlocal
cd /d "%~dp0"
set WV2=1.0.4129.50
if not exist pkgs\Microsoft.Web.WebView2.%WV2% nuget install Microsoft.Web.WebView2 -Version %WV2% -OutputDirectory pkgs || exit /b 1
set SDK=pkgs\Microsoft.Web.WebView2.%WV2%\build\native
if not exist out mkdir out
rc /nologo /fo out\stratum.res stratum.rc || exit /b 1
cl /nologo /O2 /EHsc /std:c++17 /W3 /MT /DUNICODE /D_UNICODE /I "%SDK%\include" stratum.cpp out\stratum.res /Fo"out\\" /Fe"out\STRATUM.exe" ^
  /link /SUBSYSTEM:WINDOWS "%SDK%\x64\WebView2LoaderStatic.lib" user32.lib gdi32.lib ole32.lib shell32.lib shlwapi.lib advapi32.lib version.lib || exit /b 1
echo Built windows\out\STRATUM.exe
