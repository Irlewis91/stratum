# STRATUM Alpha v1 (0.1.0-alpha.1)

First public alpha.

## Download

`STRATUM.dmg` — macOS 12 or later, Apple silicon and Intel.

The app is not yet signed with an Apple Developer ID, so macOS blocks it on first launch. Drag it into Applications, then either open **System Settings › Privacy & Security** and click **Open Anyway**, or run:

```bash
xattr -dr com.apple.quarantine /Applications/STRATUM.app
```

## In this release

- Four switchable layouts: Pattern, Session, Arrange, Mix / Edit
- Synth, drum and audio tracks with a mixer, insert effects and a master bus
- Step sequencer and piano roll with scale lock, glide and microtonal notes
- Chord-following session players
- Free-placement song timeline with arranger sections
- Audio recording with direct monitoring, take lanes and comping
- Prompt-to-Plugin effect builder and a patchable rack back panel
- Tempo warping of imported audio
- On-device AI stem separation (Apple silicon only)
- Import: MIDI, Ableton `.als`, FL Studio `.flp`, audio. Export: WAV, MIDI, DAWproject

## Known limits

- Prompt-to-Plugin is keyword-driven and builds from fixed effect blocks
- `.als` / `.flp` import reads notes, tempo, volume and pan only
- DAWproject import is not built yet (export only)
- Recording is tested with simulated input; real audio interfaces are untested
- No AU/VST plugin hosting and no MIDI hardware input

## Planned

- DAWproject import
- Developer ID signing and notarisation
