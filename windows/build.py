"""Builds STRATUM for Windows (x64) with the Microsoft C++ compiler.

Run from a "x64 Native Tools Command Prompt for VS" (or after vcvars64.bat), with the vendor code fetched
(fetch-code.sh). Objects are kept between builds, so only changed files are compiled again.
    python windows/build.py            -> windows/out/STRATUM.exe
    python windows/build.py plugins    -> windows/out/test-plugins (VST3 and VST2 test plugins for the self-checks)
"""
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'out')
SDK = os.path.join(ROOT, 'vendor', 'vst3sdk')
AW = os.path.join(ROOT, 'vendor', 'airwin2rack', 'src')
WV2 = '1.0.4129.50'
FLAGS = ['/nologo', '/c', '/MP', '/O2', '/EHsc', '/std:c++17', '/MT', '/utf-8', '/bigobj', '/DNDEBUG', '/DRELEASE=1',
         '/D_USE_MATH_DEFINES', '/D_CRT_SECURE_NO_WARNINGS', '/DUNICODE', '/D_UNICODE', '/DNOMINMAX']


def run(cmd):
    print(' '.join(cmd[:6]) + (' …' if len(cmd) > 6 else ''), flush=True)
    r = subprocess.run(cmd)
    if r.returncode:
        sys.exit(r.returncode)


def compile_group(name, files, includes, extra=()):
    """Compiles `files` into OUT/obj/<name>, skipping any whose object is newer than its source."""
    d = os.path.join(OUT, 'obj', name)
    os.makedirs(d, exist_ok=True)
    objs, todo = [], []
    for f in files:
        o = os.path.join(d, os.path.splitext(os.path.basename(f))[0] + '.obj')
        objs.append(o)
        if not os.path.exists(o) or os.path.getmtime(o) < os.path.getmtime(f):
            todo.append(f)
    for i in range(0, len(todo), 200):   # keep command lines short
        rsp = os.path.join(d, 'files.rsp')
        with open(rsp, 'w') as fh:
            fh.write('\n'.join('"%s"' % f for f in todo[i:i + 200]))
        run(['cl'] + FLAGS + list(extra) + ['/W0'] + ['/I' + i for i in includes] + ['/Fo' + d + '\\', '@' + rsp])
    return objs


def sdk_hosting():
    s = SDK
    return [s + '/public.sdk/source/vst/hosting/' + f for f in ['module.cpp', 'module_win32.cpp', 'plugprovider.cpp', 'hostclasses.cpp', 'eventlist.cpp',
            'parameterchanges.cpp', 'pluginterfacesupport.cpp', 'connectionproxy.cpp']] + [
        s + '/public.sdk/source/vst/utility/stringconvert.cpp', s + '/public.sdk/source/vst/vstinitiids.cpp',
        s + '/public.sdk/source/common/memorystream.cpp', s + '/public.sdk/source/common/commoniids.cpp',
        s + '/public.sdk/source/common/commonstringconvert.cpp', s + '/public.sdk/source/common/threadchecker_win32.cpp'] + sdk_base()


def sdk_base():
    s = SDK
    return [s + '/pluginterfaces/base/' + f for f in ['funknown.cpp', 'coreiids.cpp', 'ustring.cpp', 'conststringtable.cpp']] + [
        s + '/base/source/' + f for f in ['fobject.cpp', 'fstring.cpp', 'fdebug.cpp', 'fbuffer.cpp', 'fstreamer.cpp', 'baseiids.cpp', 'updatehandler.cpp']] + [
        s + '/base/thread/source/flock.cpp']


def webview2():
    pkg = os.path.join(HERE, 'pkgs', 'Microsoft.Web.WebView2.' + WV2)
    if not os.path.isdir(pkg):
        run(['nuget', 'install', 'Microsoft.Web.WebView2', '-Version', WV2, '-OutputDirectory', os.path.join(HERE, 'pkgs')])
    return os.path.join(pkg, 'build', 'native')


def app():
    wv = webview2()
    os.makedirs(OUT, exist_ok=True)
    run(['rc', '/nologo', '/fo', os.path.join(OUT, 'stratum.res'), os.path.join(HERE, 'stratum.rc')])
    objs = []
    objs += compile_group('airwin', sorted(glob.glob(AW + '/autogen_airwin/*.cpp')) + [AW + '/airwin_consolidated_base.cpp'], [AW])
    objs += compile_group('stratum-dsp', [ROOT + '/shell/airwin.cpp', ROOT + '/shell/wavesynth.cpp', ROOT + '/shell/tune.cpp'], [AW, ROOT + '/shell'])
    objs += compile_group('vst3sdk', sdk_hosting(), [SDK])
    objs += compile_group('app', [HERE + '/stratum.cpp', HERE + '/engine.cpp', HERE + '/vst3host_win.cpp'], [SDK, wv + '/include', HERE, ROOT + '/shell'], ['/W3'])
    exe = os.path.join(OUT, 'STRATUM.exe')
    rsp = os.path.join(OUT, 'link.rsp')
    with open(rsp, 'w') as fh:
        fh.write('\n'.join('"%s"' % o for o in objs))
    run(['link', '/nologo', '/OUT:' + exe, '/SUBSYSTEM:WINDOWS', '@' + rsp, os.path.join(OUT, 'stratum.res'), wv + '/x64/WebView2LoaderStatic.lib',
         'user32.lib', 'gdi32.lib', 'ole32.lib', 'oleaut32.lib', 'shell32.lib', 'shlwapi.lib', 'advapi32.lib', 'version.lib', 'avrt.lib', 'uuid.lib'])
    print('Built', exe)


def plugins():
    """Steinberg's mda example plugins as one .vst3 file, and the two VST2 test plugins in tests/plugins."""
    dest = os.path.join(OUT, 'test-plugins')
    os.makedirs(dest, exist_ok=True)
    mda = SDK + '/public.sdk/samples/vst/mda-vst3/source'
    sdk = SDK + '/public.sdk/source'
    files = sorted(glob.glob(mda + '/*.cpp')) + [sdk + '/vst/' + f for f in ['vstaudioeffect.cpp', 'vstbus.cpp', 'vstcomponent.cpp', 'vstcomponentbase.cpp',
            'vsteditcontroller.cpp', 'vstinitiids.cpp', 'vstparameters.cpp']] + [
        sdk + '/vst/utility/stringconvert.cpp', sdk + '/vst/utility/vst2persistence.cpp', sdk + '/common/commoniids.cpp', sdk + '/common/commonstringconvert.cpp',
        sdk + '/common/pluginview.cpp', sdk + '/main/dllmain.cpp', sdk + '/main/moduleinit.cpp', sdk + '/main/pluginfactory.cpp'] + sdk_base()
    objs = compile_group('mda', [f for f in files if os.path.exists(f)], [SDK, ROOT + '/tests/plugins'])
    rsp = os.path.join(OUT, 'mda.rsp')
    with open(rsp, 'w') as fh:
        fh.write('\n'.join('"%s"' % o for o in objs))
    run(['link', '/nologo', '/DLL', '/OUT:' + os.path.join(dest, 'mda.vst3'), '@' + rsp, 'user32.lib', 'ole32.lib', 'shell32.lib'])
    for name, defs in [('TestGain', []), ('TestTone', ['/DTONE'])]:
        d = os.path.join(OUT, 'obj', name)
        os.makedirs(d, exist_ok=True)
        run(['cl', '/nologo', '/O2', '/LD', '/MT', '/TC'] + defs + [ROOT + '/tests/plugins/testvst2.c', '/Fo' + d + '\\', '/Fe' + os.path.join(dest, name + '.dll')])
    print('Built test plugins in', dest)


if __name__ == '__main__':
    plugins() if sys.argv[1:] == ['plugins'] else app()
