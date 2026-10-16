# STRATUM

A digital audio workstation for macOS. Alpha software: expect rough edges.

STRATUM is a native Mac app with one project model and four switchable layouts ("Comfort Skins"): Pattern, Session, Arrange and Mix / Edit. Switching skin changes the screen layout and the keyboard map without stopping playback.

## Install

1. Download `STRATUM.dmg` from the [Releases](../../releases) page and drag STRATUM into Applications.
2. The app is not yet signed with an Apple Developer ID, so macOS blocks it on first launch. Either:
   - double-click it once, then open **System Settings › Privacy & Security** and click **Open Anyway**, or
   - run `xattr -dr com.apple.quarantine /Applications/STRATUM.app` in Terminal.

Requires macOS 12 or later. Runs on Apple silicon and Intel; AI stem separation is Apple silicon only.

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
- **Share:** the Share button makes a STRATUM-branded vertical video (1080×1920, for TikTok, Reels, Shorts and X) and an AAC audio file of the whole track or its first 15, 30 or 60 seconds, saves both in Movies › STRATUM, and sends them by Messages, Mail or AirDrop or through the macOS share menu. For TikTok, Instagram, YouTube and X it opens the upload page with the video selected in Finder.
- **Plugins:** Audio Unit, VST3 and VST2 instruments and effects installed on the Mac. Any note track can use a plugin instrument; plugin effects can go on every kind of track. Plugin windows open from the Devices panel, settings are saved in the project, plugins receive the song tempo and position, and plugin tracks are included in the WAV mixdown. A track that uses a plugin plays through the Mac's audio output directly, so STRATUM's own effects on that track and the master section do not process it; on a built-in synth track with plugin effects, CV cables to its filter have no effect. VST3 hosting is built on Steinberg's VST3 SDK (MIT licence). VST2 hosting uses STRATUM's own description of the plugin interface and no Steinberg VST2 SDK code; Steinberg no longer licenses VST2, so check the legal position before distributing a VST2 host commercially.
- `.reason` import (Reason 6 and later) brings in tempo, tracks, note clips and audio-track recordings at their timeline positions. Reason devices, their samples, mixer levels, effects and automation are not read (the embedded sample bank is in a protected format); bounce a device's track to audio in Reason to bring its real sound across; clips flagged as muted are left out.
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
