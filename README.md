# STRATUM

A digital audio workstation for Mac, Windows, phones and tablets. Alpha software: expect rough edges.

STRATUM has one project model and four switchable layouts ("Comfort Skins"): Pattern, Session, Arrange and Mix / Edit. Switching skin changes the screen layout and the keyboard map without stopping playback.

## Install

1. Download `STRATUM.dmg` from the [Releases](../../releases) page and drag STRATUM into Applications.
2. The app is not yet signed with an Apple Developer ID, so macOS blocks it on first launch. Either:
   - double-click it once, then open **System Settings › Privacy & Security** and click **Open Anyway**, or
   - run `xattr -dr com.apple.quarantine /Applications/STRATUM.app` in Terminal.

Requires macOS 12 or later. Runs on Apple silicon and Intel; AI stem separation is Apple silicon only.

### Visuals

**Visuals** in the toolbar opens full-window, audio-reactive visuals that follow the whole mix or one track: 44 modes in 11 categories (Scope, Lava, Arcade, Cosmos, Code, Color Field, TV, Pixel, Text, Plasma, Spectrum), Glass / Dither / Texture / Track effects, 24 palettes or your own colours, your own image, lyrics and font, 50 factory presets plus your own, grids of up to 36 tiles, and a performance mode (presets on keys 1–9, flash, shake, blackout, presets that change with each scene). The same looks can be used for share videos and, on the Mac, for Go live.

### Windows

Download `STRATUM-Windows.zip` from the Releases page, unzip it, and double-click `STRATUM.exe` (keep it next to the `app` folder). Windows 10 or 11, 64-bit. STRATUM is not code-signed yet, so Windows SmartScreen may warn: choose **More info › Run anyway**. It is built and checked automatically on Windows 11 machines on GitHub (plugins, Wave, Tune, Airwindows, Go live, stems, recording and sharing), but not yet on a producer's own PC.

### iPhone, iPad, Android phones and tablets

Open **https://irlewis91.github.io/stratum/** in Safari (iPhone/iPad) or Chrome (Android), then:
- iPhone / iPad: tap **Share › Add to Home Screen**.
- Android: tap **Install app** (or the browser menu › **Install app**).

It then opens full screen from its icon and works offline. On phones, a tab bar along the bottom switches between the Rack, Piano roll, Mixer and Devices. On iPhone, turn the ringer on: iOS mutes web audio while the phone is on silent.

### Syncing beats between devices

Once STRATUM Sync is switched on (see [docs/SYNC-SETUP.md](docs/SYNC-SETUP.md)), press **Sync** and sign in with Discord or an emailed code on each device. Every beat you work on is then saved to your account a few seconds after each change, and your other devices pick up the changes within about 15 seconds. **Sync** lists all your beats so you can open any of them. If the same beat was changed on two devices at once, both versions are kept.

### Moving a beat as a file

A beat is one `.stratum` file (notes, mix and any recorded or imported audio), so it opens the same on Mac, Windows, phones and tablets:
- **Mac:** Save into iCloud Drive (or AirDrop the file to your phone).
- **Windows:** Save › **Save to a folder…** and choose your OneDrive, Google Drive or Dropbox folder, or use **Share…**.
- **Phone or tablet:** Save opens the share sheet: AirDrop, Save to Files / iCloud Drive, Google Drive, email.

Then press **Open / Import** on the other device and pick the file.

### What's in each version

| | Mac | Windows | Phones, tablets, browsers |
|---|---|---|---|
| Beat making, piano roll, mixer, skins, built-in sounds and effects | ✓ | ✓ | ✓ |
| Sound library (791 CC0 sounds, 99 MIDI kits) | ✓ | ✓ | ✓ (sounds download as you use them) |
| Import FL Studio, Ableton, Reason, Logic, MIDI, DAWproject | ✓ | ✓ | ✓ |
| Recording from a microphone or interface | ✓ | ✓ | ✓ |
| Branded share videos and Visuals | ✓ | ✓ | ✓ (via the share sheet) |
| VST3 and VST2 plugins, with their own windows | ✓ | ✓ | — |
| Audio Unit plugins | ✓ | — (a Mac-only format) | — |
| STRATUM Wave, STRATUM Tune, 508 Airwindows effects | ✓ | ✓ | — |
| Stem separation | ✓ (Apple silicon) | ✓ | — |
| Record from another app | ✓ | ✓ (one app on Windows 11; the whole PC's sound on Windows 10) | — |
| Go live (Twitch, YouTube, Instagram, TikTok) | ✓ | ✓ | — |
| Finding a project's missing samples automatically | ✓ | ✓ | — |
| Syncing beats between devices | ✓ | ✓ | ✓ |

Plugin settings travel with a project between the Mac and Windows versions.

## What it does

- **Tracks:** synth, drum and audio tracks; a mixer with insert effects; a master bus with drive, glue compression and a limiter.
- **Composition:** step sequencer, piano roll with scale lock, glide and per-note cents, harmony suggestions, and a Dump Score Log that keeps the last five minutes of notes you play.
- **Session players:** drum, bass, chord and arpeggio parts that follow each scene's chord progression.
- **Song timeline:** freely placed regions you can move, resize, copy, split and duplicate, plus arranger sections.
- **Recording:** record audio onto an armed track, with direct monitoring that bypasses effects.
- **Comping:** record again over a region to add takes, then drag across take lanes to choose between them.
- **Prompt-to-Plugin:** describe an effect in words and get an effect chain with matching controls.
- **Rack back panel:** press Tab to flip the devices and patch LFO cables into parameters.
- **Warping:** imported audio is tempo-detected and time-stretched to the project tempo.
- **Stem separation:** split a mix into drums, bass, other and vocals on-device (HT-Demucs).
- **Files:** saves `.stratum` projects; imports MIDI, Ableton `.als`, FL Studio `.flp`, Reason `.reason` songs and audio; exports WAV, MIDI and DAWproject.

## Known limits

- Prompt-to-Plugin is keyword-driven. It assembles built-in effect blocks; it does not generate or compile code.
- `.als` import brings in tempo, tracks, notes, volume and pan; plugins, samples and automation are not read.
- `.flp` import brings in tempo, channels, notes, the playlist, volume and pan, and loads the sample files the project points at: sampler channels play their sample and playlist audio clips are placed on audio tracks. An `.flp` does not contain its samples, so STRATUM looks where the project says they are and beside the project file, reads FL Studio zipped loop packages (`.zip`) directly, and offers a Missing samples picker for the rest. Automation clips for channel volume and pan, mixer-track volume and pan, and master volume are read and play back in Song mode; automation of tempo, pitch and plugin settings is not. VST instruments the project used are put back on their tracks when the same plugin is installed on this Mac (with default settings). FL Studio's own instruments (FLEX, Sytrus, 3x Osc and so on) cannot be recreated and play on a stand-in built-in sound; mixer effects are not carried over.
- **Sampler:** drum tracks have pads that load your own one-shots (several files at once; kicks, snares, claps and hats go to matching pads, the rest become extra pads), each with tune and level. A synth track can play one of your samples across the keys with a root note and loop switch.
- **STRATUM Wave:** a built-in wavetable synthesizer (choose “Wavetable synth” as a track's instrument): two morphing wavetable oscillators with up to 8-voice unison, detune and stereo spread, nine built-in wavetables, a sub and noise, a multimode filter with drive, amp and mod envelopes, a tempo-syncable LFO, poly/mono/legato with glide, ten factory presets, and any audio file importable as a wavetable. Its controls are shown in sections in the Devices panel with a live waveform display.
- **Tempo-locked effects:** Sidechain Pump ducks a track on every beat division (1 bar to 1/16) or on every kick-drum hit, including muted “ghost” kicks, with depth and release controls. Gate / Stutter plays a 16-step pattern per bar where each step can play, mute, repeat a 1/32 or 1/64 slice, or slow to a tape stop. Both are in the stock effects list and respond to words like “sidechain”, “pump”, “stutter” and “tape stop” in Prompt-to-Plugin.
- **STRATUM Tune:** pitch correction for vocals and other single-note parts, added like any plugin effect. It detects the pitch, pulls it to the nearest note of the chosen key and scale (it starts in the song's key), with retune speed from instant “robot” to natural, amount and mix.
- **Built-in effects:** 508 Airwindows effects (reverbs, tape, saturation, consoles, EQs, compressors, clippers and more, from Airwindows Consolidated, MIT licence) appear in the plugin-effect picker and work on any track, with their controls shown in the Devices panel.
- **Record from another app:** File › Record from Another App… (or the button in Sounds) records the sound one running app makes — a browser, a music player — onto a new audio track, the sampler or a drum pad, with silence trimmed from both ends. Needs macOS 13 and the Screen & System Audio Recording permission.
- **Sound library:** the Sounds button browses 791 built-in public-domain (CC0) sounds — kicks, snares, claps, hats, cymbals, toms, percussion, found sounds, vocal shouts and vocal percussion from the Stargate sample pack and Producer Space — plus 99 MIDI chord, bass and piano kits. Preview a sound, then add it to a drum pad, the sampler, an audio track, or (for MIDI) as notes on the selected track. `fetch-library.sh` rebuilds the library.
- **My Sounds:** in Sounds › My Sounds, **Add your sounds…** or **Add a folder…** (a whole sample pack, subfolders included) keeps your own WAV, AIFF, MP3, FLAC and other sound files on this device for every project, sorted as kicks, snares, hats and so on from their names. They're searchable with the built-in sounds, and an imported project that needs one of them finds it there.
- **Help:** on first open STRATUM offers a guided tour that highlights each part of the window and waits for you to try things (Help › Take the Tour runs it again). Help › STRATUM Owner’s Manual opens the bundled PDF manual (`docs/STRATUM Owner's Manual.pdf`), built from real screenshots by `docs/manual/build-manual.py`.
- **Share:** the Share button makes a STRATUM-branded video and an AAC audio file of the whole track or its first 15, 30 or 60 seconds and saves both in Movies › STRATUM. It sends them by Messages, Mail or AirDrop or through the macOS share menu, and posts to Instagram (Story, Reel, Post), Facebook, TikTok, X, Threads and YouTube Shorts in each platform's shape (9:16, 4:5 or square) by opening the upload page with the video selected in Finder. Instagram Stories can only be posted from the phone app, so that video is saved to Photos. Platform length limits are applied (Stories 60 s, X 2:20, Reels 3 min).
- **Go live:** Share › Go live streams the session to Twitch, YouTube, Instagram, TikTok or any RTMP service (720p, 30 fps, H.264 and AAC over RTMP/RTMPS). Viewers see the STRATUM window with an optional camera box and hear the Mac's sound plus an optional microphone. Stream keys are typed by the producer and can be kept in the Keychain.
- **Plugins:** Audio Unit, VST3 and VST2 instruments and effects installed on the Mac. Any note track can use a plugin instrument; plugin effects can go on every kind of track. Plugin windows open from the Devices panel, settings are saved in the project, plugins receive the song tempo and position, and plugin tracks are included in the WAV mixdown. A track that uses a plugin plays through the Mac's audio output directly, so STRATUM's own effects on that track and the master section do not process it; on a built-in synth track with plugin effects, CV cables to its filter have no effect. VST3 hosting is built on Steinberg's VST3 SDK (MIT licence). VST2 hosting uses STRATUM's own description of the plugin interface and no Steinberg VST2 SDK code; Steinberg no longer licenses VST2, so check the legal position before distributing a VST2 host commercially.
- Logic Pro import (a `.logicx` project, or a zip of one): tempo, key, every track by name, MIDI regions with their notes at their places in the arrangement, Quick Sampler tracks playing the samples saved in the project, and bounced audio. Tracks Logic bounced in place keep their MIDI, muted, and play the bounce. Third-party instruments are put back when the same plugin is installed; mixer levels, effects and automation are not read.
- `.reason` import (Reason 6 and later) brings in tempo, tracks, note clips and audio-track recordings at their timeline positions. Kong, Redrum and sampler tracks get the producer's own sample files: STRATUM looks for them where the song says they were (also inside your own home folder when the song was made on another computer), next to the song and in My Sounds, and **Missing samples** lets you choose any it can't find. Sounds from Reason's own sound banks (and the copy embedded in a self-contained song) are in a protected format only Reason can open, so a similar built-in STRATUM sound plays on that pad instead. Reason synths, mixer levels, effects and automation are not read; bounce a track to audio in Reason to bring its exact sound across; clips flagged as muted are left out.
- DAWproject is export-only; DAWproject import is not built yet.
- Comping is for recorded audio only.
- Recording has been tested with simulated input, not yet with a wide range of audio interfaces.
- No undo history across sessions, no plugin hosting (AU/VST), no MIDI hardware input.

## Build from source

Needs Xcode (for `swiftc`, `clang`, `codesign`, `iconutil`).

```bash
./fetch-vendor.sh   # optional: 350 MB of stem-separation model and runtime
./build.sh          # writes dist/STRATUM.app and dist/STRATUM.dmg
```

Layout:

- `web/` — the application: audio engine, DSP, file formats and interface (plain JavaScript, Web Audio).
- `shell/` — the macOS shell (Swift): window, menus, file dialogs, audio recording, and the stem-separation bridge (C).
- `assets/` — logo artwork.

The built app has three check modes, run from Terminal against `dist/STRATUM.app/Contents/MacOS/STRATUM`:
`--selftest` (launch and play), `--fake-input --rec-test` (record two takes and comp them), `--stem-test` (separate the demo song), and `--import-test <files…>` (run files through the importers).

## Third-party components

- [ONNX Runtime](https://github.com/microsoft/onnxruntime) — MIT licence.
- HT-Demucs stem separation model, ONNX export from [StemSplitio/htdemucs-onnx](https://huggingface.co/StemSplitio/htdemucs-onnx) — MIT licence. Original model: [Demucs](https://github.com/facebookresearch/demucs), Meta Platforms, Inc.

Their licence texts ship inside the app under `Contents/Resources/licenses`.
