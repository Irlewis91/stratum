#!/usr/bin/env python3
"""Builds the STRATUM Owner's Manual (docs/manual/manual.html) from the screenshots and control positions that
`STRATUM --manual-shots docs/manual/img` captures, and the keyboard shortcuts in web/js/ui.js. The Mac app then prints it
to PDF with `STRATUM --manual-pdf docs/manual/manual.html "docs/STRATUM Owner's Manual.pdf"`."""
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
VERSION = sys.argv[1] if len(sys.argv) > 1 else "Alpha"
rects = json.load(open(os.path.join(HERE, "img", "rects.json")))
W, H = 1440, 900
esc = html.escape

# ---- keyboard shortcuts, read from the app so the manual always matches it ----
ui = open(os.path.join(ROOT, "web", "js", "ui.js")).read()
km = ui[ui.index("const KEYMAP = {"):ui.index("};", ui.index("const KEYMAP = {"))]
keymap = {}
for skin, body in re.findall(r"(\w+): \[(.*?)\]\],?\n", km + "\n", re.S):
    keymap[skin] = re.findall(r"\['([^']+)', '[^']*', '([^']+)'\]", body + "]")


def keyname(k):
    return k.replace("Meta", "⌘").replace("Alt", "⌥").replace("Shift", "⇧").replace("+", " ")


def figure(shot, items, caption, crop=None, start=1):
    """A screenshot with numbered callouts at the real positions of controls, and the matching key underneath."""
    r = rects.get(shot, {})
    x0, y0, w, h = crop or (0, 0, W, H)
    marks, legend = [], []
    for n, (sel, label, text) in enumerate(items, start):
        box = r.get(sel)
        if box:
            cx, cy = box[0] + box[2], box[1]             # small controls: the number sits on the top-right corner
            if box[2] > 260 or box[3] > 120:   # big panels: put the number in the top-left corner
                cx, cy = box[0] + 22, box[1] + 22
            px, py = (cx - x0) / w * 100, (cy - y0) / h * 100
            if 0 <= px <= 100 and 0 <= py <= 100:
                marks.append(f'<span class="mark" style="left:{px:.2f}%;top:{py:.2f}%">{n}</span>')
                if box[2] <= 260 and box[3] <= 120:
                    bx, by = (box[0] - x0) / w * 100, (box[1] - y0) / h * 100
                    marks.append(f'<span class="ring" style="left:{bx:.2f}%;top:{by:.2f}%;width:{box[2] / w * 100:.2f}%;height:{box[3] / h * 100:.2f}%"></span>')
        legend.append(f"<li><b>{n} · {esc(label)}</b> — {text}</li>")
    style = f"--x:{x0 / W * 100}%;--y:{y0 / H * 100}%;--zw:{W / w * 100}%;--ar:{w}/{h}"
    small = ' tight' if h < 120 else ''
    return (f'<figure><div class="shot{small}" style="{style}"><img src="img/{shot}.png" alt="">{"".join(marks)}</div>'
            f'<figcaption>{esc(caption)}</figcaption><ol class="key">{"".join(legend)}</ol></figure>')


def table(head, rows):
    return "<table><thead><tr>" + "".join(f"<th>{esc(h)}</th>" for h in head) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows) + "</tbody></table>"


def flow(nodes, note=""):
    """A left-to-right signal-flow diagram drawn in SVG."""
    n = len(nodes)
    bw, gap, hgt = 128, 26, 54
    width = n * bw + (n - 1) * gap
    parts = []
    for i, (title, sub) in enumerate(nodes):
        x = i * (bw + gap)
        parts.append(f'<rect x="{x}" y="6" width="{bw}" height="{hgt}" rx="8" class="node"/>'
                     f'<text x="{x + bw / 2}" y="29" class="nt">{esc(title)}</text><text x="{x + bw / 2}" y="46" class="ns">{esc(sub)}</text>')
        if i < n - 1:
            ax = x + bw
            parts.append(f'<path d="M{ax + 3},{6 + hgt / 2} L{ax + gap - 4},{6 + hgt / 2}" class="arrow" marker-end="url(#ah)"/>')
    svg = (f'<svg viewBox="0 0 {width} {hgt + 12}" class="flow"><defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
           f'<path d="M0,0 L10,5 L0,10 z" class="ahead"/></marker></defs>{"".join(parts)}</svg>')
    return f'<div class="diagram">{svg}{f"<p class=small>{note}</p>" if note else ""}</div>'


HEADER = [
    ("#hdr .logo", "STRATUM", "the app name; the window title shows your project's name."),
    ("[data-act=new]", "New", "starts an empty project."),
    ("[data-act=open]", "Open / Import", "opens STRATUM projects and imports other software's projects, MIDI and audio (Chapter 4)."),
    ("[data-act=save]", "Save", "saves a .stratum project file, with all its audio inside it."),
    ("[data-act=sounds]", "Sounds", "the built-in sound library (Chapter 11)."),
    ("[data-act=share]", "Share", "makes a branded video and audio file and sends or posts it (Chapter 14)."),
    ("#exportSel", "Export", "WAV mixdown, MIDI file or DAWproject."),
    ("#playBtn", "Play / stop", "Space bar does the same."),
    ("[data-act=stop]", "Stop", "stops and returns to the start."),
    ("#recBtn", "Record", "records onto the armed audio track (Chapter 9)."),
    ("#monBtn", "Monitor", "hear your input while recording."),
    ("#modeSel", "Scene loop / Song", "loop one scene, or play the whole arrangement."),
    ("#bpm", "Tempo and key", "beats per minute, then the song's key and scale."),
    ("#metroBtn", "Click", "the metronome."),
    ("#pos", "Position", "bar . beat . sixteenth of the playhead."),
    ("#keysBtn", "Keys", "play the selected track from the computer keyboard."),
    ("[data-act=dump]", "Dump Score Log", "puts what you played in the last five minutes into the selected clip — even if you weren't recording."),
    ("[data-act=undo]", "Undo", "⌘Z."),
    ("#addTrackSel", "+ Track", "add a synth, drum or audio track."),
    ("[data-act=help]", "?", "shortcuts for the current skin, the tour and this manual."),
    ("#skinSel", "Comfort Skin", "choose the layout that matches the software you know (Chapter 3)."),
]

css = open(os.path.join(HERE, "manual.css")).read()
logo = "../../assets/stratum-icon.png"
mark = "img/wordmark.png"

body = []
add = body.append

# ---- cover ----
add(f"""<section class="cover"><img class="wm" src="{mark}" alt="STRATUM"><h1>Owner’s Manual</h1>
<p class="ver">{esc(VERSION)} · for macOS 12 or later</p>
<p class="lead">Everything in STRATUM, where to find it, what it does, and how it compares with the music software you may already use.</p></section>""")

# ---- contents ----
chapters = ["Welcome and installing", "The window at a glance", "Comfort Skins", "Projects, opening and importing", "Tracks and instruments",
            "STRATUM Wave", "Writing notes and patterns", "Arranging your song", "Recording and comping", "Effects", "The sound library",
            "Mixing", "Stems: splitting a track apart", "Exporting and sharing", "Coming from another DAW", "Keyboard shortcuts",
            "Plugins", "Limits in this alpha and troubleshooting"]
add('<section class="toc"><h2>Contents</h2><ol>' + "".join(f"<li>{esc(c)}</li>" for c in chapters) + "</ol></section>")

# 1
add("""<section><h1><span>1</span>Welcome and installing</h1>
<p>STRATUM is a music production app for the Mac. It plays and records audio, runs software instruments and effects — its own, and the Audio Unit, VST3 and VST2 plugins installed on your Mac — and opens projects from FL Studio, Ableton Live, Logic Pro and Reason.</p>
<h3>Installing</h3><ol>
<li>Open <b>STRATUM.dmg</b> and drag <b>STRATUM</b> into <b>Applications</b>.</li>
<li>Open STRATUM. Because this alpha is not yet notarised by Apple, macOS stops it the first time.</li>
<li>Open <b>System Settings › Privacy &amp; Security</b>, scroll down and click <b>Open Anyway</b> next to STRATUM. You only do this once.</li></ol>
<h3>The first time you open it</h3>
<p>STRATUM opens with a short demo song and asks whether you want a tour. The tour highlights each part of the window and lets you try Play and the sound library as you go. You can take it again any time from <b>Help › Take the Tour</b>.</p>"""
    + figure("tour", [(".tour-box", "Highlighted control", "the part of the window the tour is explaining."), (".tour-card", "Tour card", "what it does; Next and Back move through the tour, Skip leaves it.")],
             "The guided tour pointing out the Comfort Skin menu.")
    + """<h3>Permissions STRATUM may ask for</h3>
<ul><li><b>Microphone</b> — only when you first record.</li><li><b>Photos</b> — only when you share to an Instagram Story, so the video can reach your phone.</li></ul></section>""")

# 2
add("""<section><h1><span>2</span>The window at a glance</h1>
<p>The window is a bar of controls along the top and a set of panels below. Which panels you see, and where, depends on the Comfort Skin (Chapter 3); this is the <b>Pattern</b> skin.</p>"""
    + figure("pattern", [h for h in HEADER if (rects["pattern"].get(h[0]) or [0])[0] < 700], "The top bar, left half.", crop=(0, 0, 720, 64))
    + figure("pattern", [h for h in HEADER if (rects["pattern"].get(h[0]) or [0])[0] >= 700], "The top bar, right half.", crop=(700, 0, 740, 64), start=1 + sum(1 for h in HEADER if (rects["pattern"].get(h[0]) or [0])[0] < 700))
    + figure("pattern", [("#rack", "Channel Rack", "every track, with a step grid for drum patterns."), ("#mixer", "Mixer", "a channel strip per track plus the master."),
                         ("#editor", "Piano Roll", "the notes of the selected clip."), ("#devices", "Devices", "the selected track's instrument and effects.")],
             "The panels in the Pattern skin.")
    + "</section>")

# 3
add("""<section><h1><span>3</span>Comfort Skins</h1>
<p>A Comfort Skin rearranges the window and changes the keyboard shortcuts so STRATUM feels like the software you are used to. The project itself does not change — switch skins as often as you like from the <b>Comfort Skin</b> menu at the top right.</p>"""
    + table(["Skin", "Feels like", "What you see"], [
        ["<b>Pattern</b>", "FL Studio", "Channel Rack with step grid, Mixer, Piano Roll and Devices; F5 and F7 switch the lower panel to the Playlist or Piano Roll."],
        ["<b>Session</b>", "Ableton Live", "Scenes and clips in a grid, the Mixer, and clip or device view at the bottom (⇧Tab)."],
        ["<b>Arrange</b>", "Logic Pro, Cubase, Studio One", "Inspector on the left, tracks and regions on a timeline, editor or mixer below."],
        ["<b>Mix / Edit</b>", "Pro Tools", "Separate Edit and Mix windows (⌘=)."]])
    + figure("session", [("#session", "Clip grid", "scenes in rows, tracks in columns; ▶ launches a whole scene."), ("#mixer", "Mixer", "levels, pan, mute and solo."), ("#devices", "Device view", "instrument and effects of the selected track.")], "The Session skin.")
    + figure("arrange", [("#inspector", "Inspector", "the selected track's level, pan and inserts."), ("#timeline", "Tracks area", "regions on the song timeline, with section markers above."), ("#editor", "Editor", "the piano roll for the selected region.")], "The Arrange skin.")
    + figure("mixedit", [("#timeline", "Edit window", "the timeline; ⌘= swaps to the Mix window."), ("#editor", "Editor", "notes of the selected region.")], "The Mix / Edit skin.")
    + "</section>")

# 4
add("""<section><h1><span>4</span>Projects, opening and importing</h1>
<p><b>Save</b> writes a <code>.stratum</code> file that contains everything, including recorded and imported audio, so it can be sent to someone else as a single file. <b>Open / Import</b> (⌘O) opens STRATUM projects and brings in work from other software:</p>"""
    + table(["File", "What comes in", "What doesn't"], [
        ["FL Studio <code>.flp</code> or zipped loop package", "Tempo, channels, patterns, notes, the playlist, volume and pan, sampler and audio-clip samples (found on your Mac, in the zip, or via <b>Missing samples</b>), volume and pan automation.", "FL Studio's own instruments (FLEX, Sytrus, 3x Osc…) play on stand-in sounds; mixer effects; tempo in some FL 25 projects."],
        ["Logic Pro <code>.logicx</code> (or a zip of one)", "Tempo, key, tracks by name, MIDI regions with notes in place, Quick Sampler samples with their root key, bounced audio.", "Mixer levels, effects, automation; Logic's own synths."],
        ["Ableton Live <code>.als</code>", "Tempo, tracks, MIDI clips and arrangement, volume and pan.", "Devices, samples and automation."],
        ["Reason <code>.reason</code>", "Tempo, tracks, note clips, audio-track recordings.", "Rack devices and their samples (bounce them to audio in Reason first)."],
        ["MIDI <code>.mid</code>", "Every track's notes and the tempo.", "—"],
        ["Audio (WAV, AIFF, MP3, M4A, FLAC)", "A new audio track, stretched to the song tempo when its own tempo is detected.", "—"]])
    + """<p>If a third-party plugin a project used is installed on your Mac, STRATUM puts it back on its track (with its default sound).</p>
<p class="tip">Send STRATUM projects as <code>.stratum</code> files, and other people's FL Studio projects as zipped loop packages — those carry their samples.</p></section>""")

# 5
add("""<section><h1><span>5</span>Tracks and instruments</h1>
<p>Add tracks with <b>+ Track</b>. Every note track has an <b>Instrument</b> menu at the top of its Devices panel, so the same notes can be played by any sound:</p>"""
    + table(["Instrument", "What it is"], [
        ["Built-in synth", "Two oscillators, a filter and an envelope. Quick and light."],
        ["Wavetable synth (STRATUM Wave)", "STRATUM's full synthesizer — see Chapter 6."],
        ["My own sample…", "Plays any sound file across the keys from its root note, with an optional loop."],
        ["Drum kit / pads", "Eight pads with built-in sounds; load your own one-shots onto any pad, or add more pads."],
        ["Plugin…", "Any Audio Unit, VST3 or VST2 instrument installed on your Mac (Chapter 17)."]])
    + figure("gate", [(".ikind", "Instrument menu", "switch what this track plays; the notes stay the same."), ("#devices", "Drum Sampler", "Load… puts your own sound on a pad; Load sounds… fills several pads at once, matching kicks, snares and hats by file name.")], "A drum track's Devices panel.")
    + "</section>")

# 6
add("""<section><h1><span>6</span>STRATUM Wave</h1>
<p>STRATUM Wave is a wavetable synthesizer, in the same family as Serum, Vital and Pigments. A wavetable is a series of single waveforms; the <b>Position</b> control sweeps through them, which is what makes wavetable sounds move. Choose <b>Wavetable synth (STRATUM Wave)</b> in a track's Instrument menu.</p>"""
    + figure("wave", [("#wavePreset", "Preset", "ten starting points: Supersaw Lead, Reese Bass, Wobble Bass, Pluck, Warm Pad, Growl Bass and more."),
                      (".wavebox", "Waveform displays", "the waveform each oscillator is playing right now; Load wavetable… turns any audio file into a wavetable."),
                      (".pctl.grouped", "Controls", "in sections: Osc A, Osc B, Sub & Noise, Filter, Amp Envelope, Mod Envelope, LFO and Voice.")], "STRATUM Wave in the Devices panel.")
    + flow([("Osc A + Osc B", "wavetables, unison"), ("Sub & Noise", "added in"), ("Filter", "drive, cutoff, res"), ("Amp envelope", "per note"), ("Track", "volume, pan")],
           "Mod envelope and LFO can move the filter cutoff and the wavetable position; the LFO can follow the song tempo.")
    + table(["Section", "Controls"], [
        ["Osc A / Osc B", "Wavetable (nine built in, or your own), Position, Octave, Semitone, Fine, Level, Unison (1–8 voices), Detune, Spread (stereo width)."],
        ["Sub & Noise", "A sine an octave below, and white noise."],
        ["Filter", "Off, low-pass 12 or 24, high-pass, band-pass; Cutoff, Resonance, Drive, Key track, Envelope amount."],
        ["Amp / Mod Envelope", "Attack, Decay, Sustain, Release. The mod envelope can also move each oscillator's position."],
        ["LFO", "Sine, triangle, saw, square or random; free rate or synced from 4 bars to 1/16 triplets; to cutoff, position, pitch (vibrato) and volume."],
        ["Voice", "Poly, Mono or Legato, Glide, Velocity sensitivity, Volume."]])
    + "<p class=tip>For a wobble bass, load the Wobble Bass preset and change <b>LFO › Sync</b> between 1/4, 1/8 and 1/16 to change the wobble speed in time with the song.</p></section>")

# 7
add("""<section><h1><span>7</span>Writing notes and patterns</h1>
<ul><li><b>Step grid</b> (Pattern skin): click squares in the Channel Rack to place drum hits on sixteenth notes.</li>
<li><b>Piano Roll</b>: click to add a note, drag to move it, drag its right edge to change its length, Option-click to delete. <b>Scale lock</b> keeps new notes in the song's key.</li>
<li><b>Session players</b>: in the Piano Roll's Session player menu choose Drummer, Bass, Chords or Arpeggio and press Regenerate — STRATUM writes a part that follows the scene's chords (the Chords box, in scale degrees, e.g. 1 6 3 7).</li>
<li><b>Keys</b>: turn on Keys in the top bar to play the selected track from the computer keyboard (A–L row; Z and X change octave).</li>
<li><b>Dump Score Log</b>: STRATUM keeps the last five minutes of everything you played, recording or not. Press Dump Score Log to put it into the selected clip.</li></ul></section>""")

# 8
add("""<section><h1><span>8</span>Arranging your song</h1>
<p>STRATUM has two ways of playing, chosen with the <b>Scene loop / Song</b> menu:</p>
<ul><li><b>Scene loop</b> repeats one scene — a pattern or a set of clips — while you work on it, like FL Studio's pattern mode or an Ableton scene.</li>
<li><b>Song</b> plays the arrangement: regions placed freely on each track's timeline, with named sections across the top.</li></ul>
<p>In the timeline, drag regions to move them, drag their right edge to lengthen or loop them, ⌘E splits at the playhead and ⌘D duplicates. Section buttons move, duplicate or delete whole sections.</p>
<p><b>Automation</b>: volume and pan automation imported from other software plays in Song mode; the Inspector shows a track's automation and can clear it. Drawing your own automation is planned for a later version.</p></section>""")

# 9
add("""<section><h1><span>9</span>Recording and comping</h1><ol>
<li>Add an audio track and press its arm button (or just press Record — STRATUM arms or adds an audio track for you).</li>
<li>Turn on <b>Monitor</b> if you want to hear yourself; this is direct monitoring, without effects.</li>
<li>Press <b>Record</b>. Each pass over the same place becomes a new <b>take</b>.</li>
<li>Comp the best parts: in the take lanes below a recorded region, drag across a take to use that part of it.</li></ol>
<p>STRATUM removes the audio interface's delay from recordings automatically, so takes line up with the beat.</p></section>""")

# 10
add("""<section><h1><span>10</span>Effects</h1>
<p>Effects are added in the Devices panel. STRATUM's own effects run in its audio engine; plugin effects run in the Mac's plugin engine.</p>"""
    + flow([("Instrument", "or audio"), ("Track filter", "synths"), ("Effects", "in order"), ("Saturation", "track"), ("Volume / Pan", "mute, solo"), ("Master", "drive, glue")],
           "The signal path of a track. A track with any plugin on it — including STRATUM Wave, STRATUM Tune and Airwindows — plays through the plugin engine instead and skips STRATUM's own effects and the master section.")
    + """<h3>Prompt-to-Plugin</h3><p>Click <b>+ Prompt-to-Plugin</b> and describe the effect you want in plain words — “dusty lo-fi tape with a little room”, “sidechain pump”, “stutter”. STRATUM builds a chain of effects to match and shows a knob for each setting.</p>"""
    + table(["Stock effect", "Controls"], [["High-pass / Low-pass", "Cutoff (and Resonance)"], ["Compressor", "Amount"], ["Saturation", "Drive, Tone"], ["Bit Crusher", "Crush"], ["Tape Wobble", "Rate, Depth"],
                                           ["Tone", "Bright"], ["Chorus / Phaser", "Rate, Depth, Mix"], ["Tremolo", "Rate, Depth"], ["Delay", "Time, Feedback, Mix"], ["Reverb", "Size, Mix"], ["Dust & Hiss", "Level"],
                                           ["Sidechain Pump", "Depth, Rate (1 bar to 1/16), Release, Follow (grid or kick-drum hits)"], ["Gate / Stutter", "16-step pattern, Smooth, Mix"]])
    + figure("gate", [(".gatepat", "Gate / Stutter steps", "click a step to cycle: play, M mute, R repeat 1/32, r repeat 1/64, T tape stop."), ("#devices", "Sidechain Pump", "ducks the track on the beat, or whenever a kick drum plays — a muted “ghost” kick track works too.")],
             "Gate / Stutter and Sidechain Pump on a drum track.")
    + """<h3>Airwindows</h3><p>508 Airwindows effects are built in — reverbs, tape, saturation, console emulation, EQs, compressors, clippers and more. Choose <b>+ Plugin effect…</b>; Airwindows effects are listed with their category, and the recommended ones come first. Their controls appear in the Devices panel.</p>
<h3>STRATUM Tune</h3><p>Pitch correction for vocals and other single-note parts. It starts in the song's key and scale; <b>Retune speed</b> runs from instant (the robotic effect) to natural, with <b>Amount</b> and <b>Mix</b>.</p>
<h3>Back panel and LFOs</h3><p>Press Tab to flip the Devices panel round. Patch an LFO's CV output into an effect's input to move that setting in time — like the back of a Reason rack.</p></section>""")

# 11
add("""<section><h1><span>11</span>The sound library</h1><p>Click <b>Sounds</b> to browse 791 free sounds — kicks, snares, claps, hats, cymbals, toms, percussion, found sounds, vocal shouts and vocal percussion — and 99 MIDI chord, bass and piano kits. They are public domain (CC0): use them in anything, with no credit needed.</p>"""
    + figure("sounds", [("#pop .popbox", "Sounds browser", "search, pick a category, press ▶ to preview, and add the sound to the selected track: a drum pad, the sampler, an audio clip, or for MIDI, the notes.")], "The Sounds browser.")
    + """<h3>Record from another app</h3><p>Choose <b>File › Record from Another App…</b> or the button at the top of the Sounds browser. Pick the app (a web browser, a music player), choose where the sound goes — a new audio track, the sampler or a drum pad — press Record and play the sound in that app. Only that app is recorded, and silence at both ends is trimmed. The first time, macOS asks you to allow STRATUM under Privacy &amp; Security › Screen &amp; System Audio Recording. Only record sounds you have the right to use.</p>"""
    + "</section>")

# 12
add("""<section><h1><span>12</span>Mixing</h1><p>Each track has a volume fader, pan knob, mute (M) and solo (S). The <b>Master</b> strip has <b>Drive</b> (gentle console-style saturation) and <b>Glue</b> (bus compression). Each effect chain and the master end in a limiter, so STRATUM's own output doesn't clip.</p></section>""")

# 13
add("""<section><h1><span>13</span>Stems: splitting a track apart</h1><p>Select an audio clip and press <b>Separate stems (AI)</b> in its clip settings. STRATUM separates the audio into drums, bass, vocals and other instruments on four new tracks, using the HT-Demucs model on your Mac — nothing is uploaded. This needs an Apple silicon Mac and can take about as long as the audio itself.</p></section>""")

# 14
add("""<section><h1><span>14</span>Exporting and sharing</h1><p><b>Export</b> saves a WAV mixdown, a MIDI file, or a DAWproject file for other DAWs. <b>Share</b> makes a STRATUM-branded video and an audio file of the whole track or its first 15, 30 or 60 seconds, saves them in <b>Movies › STRATUM</b>, and sends them:</p>"""
    + figure("share", [("#pop .popbox", "Share", "title and artist, length, then where to send it.")], "The Share window.")
    + table(["Destination", "Video shape", "How"], [["Messages, AirDrop", "9:16", "opens with the video attached"], ["Mail", "audio file", "opens with the audio attached"],
                                                    ["Instagram Story", "9:16, up to 60 s", "saved to Photos to post from your phone"], ["Instagram Reel, TikTok, YouTube Shorts", "9:16", "opens the upload page; the video is selected in Finder"],
                                                    ["Instagram Post, Facebook, Threads", "4:5", "opens the upload page"], ["X (Twitter)", "square, up to 2:20", "opens the post composer"]])
    + "</section>")

# 15
add("""<section><h1><span>15</span>Coming from another DAW</h1><p>Most ideas you know have a home in STRATUM. Choose the matching Comfort Skin first, then use this table to find things.</p>"""
    + table(["You know…", "In STRATUM"], [
        ["<b>FL Studio</b> Channel Rack, step sequencer", "Pattern skin › Channel Rack step grid"], ["FL Studio Playlist", "Song mode timeline (F5)"], ["FL Studio patterns", "Scenes"],
        ["FL Studio mixer inserts", "Devices panel effects"], ["FL Studio Fruity Edison / slicing", "Stems and the sampler"],
        ["<b>Ableton Live</b> Session View", "Session skin clip grid"], ["Ableton Arrangement View", "Song mode timeline"], ["Ableton devices and racks", "Devices panel; Prompt-to-Plugin chains"], ["Ableton Simpler", "My own sample / drum pads"], ["Ableton Wavetable", "STRATUM Wave"],
        ["<b>Logic Pro</b> Tracks area, regions", "Arrange skin"], ["Logic Quick Sampler, Drum Machine Designer", "My own sample, Drum kit / pads"], ["Logic Alchemy, Vital, Serum", "STRATUM Wave"], ["Logic Flex Pitch / Auto-Tune", "STRATUM Tune"], ["Logic Step Sequencer", "Pattern skin step grid; Gate / Stutter"],
        ["<b>Pro Tools</b> Edit and Mix windows", "Mix / Edit skin (⌘=)"], ["Pro Tools playlists and comping", "Takes and comp lanes"],
        ["<b>Reason</b> rack and back panel cables", "Devices panel; Tab flips it to patch LFOs"], ["Reason Kong", "Drum kit / pads"], ["Reason Europa", "STRATUM Wave"],
        ["<b>GarageBand</b> Smart Controls", "Device knobs and plugin controls"], ["Kickstart, LFO Tool", "Sidechain Pump"], ["Gross Beat, Effectrix", "Gate / Stutter"]])
    + "</section>")

# 16
names = {"common": "Every skin", "pattern": "Pattern", "session": "Session", "arrange": "Arrange", "mixedit": "Mix / Edit"}
sc = "".join(f"<h3>{names.get(k, k)}</h3>" + table(["Key", "Does"], [[f"<kbd>{esc(keyname(a))}</kbd>", esc(b)] for a, b in v]) for k, v in keymap.items())
add(f"<section><h1><span>16</span>Keyboard shortcuts</h1><p>Shortcuts change with the Comfort Skin so they match the software it imitates. Press <b>?</b> in STRATUM to see the current set.</p>{sc}</section>")

# 17
add("""<section><h1><span>17</span>Plugins</h1>
<p>STRATUM finds the Audio Unit, VST3 and VST2 plugins installed on your Mac. Choose <b>Plugin…</b> in a track's Instrument menu for an instrument, or <b>+ Plugin effect…</b> for an effect on any track.</p>
<ul><li><b>Open plugin window</b> shows the plugin's own controls; <b>Controls</b> shows its settings inside STRATUM's Devices panel.</li>
<li>Plugin settings are saved in the project and included in exports.</li>
<li>Plugins receive the song's tempo and position, so tempo-synced plugins follow the song.</li>
<li>VST3 plugins are looked for in <code>/Library/Audio/Plug-Ins/VST3</code> and <code>~/Library/Audio/Plug-Ins/VST3</code>; VST2 in the matching <code>VST</code> folders.</li></ul>
<p class=tip>Plugins run inside STRATUM, so a faulty plugin can close the app. Save often when trying a new plugin.</p></section>""")

# 18
add("""<section><h1><span>18</span>Limits in this alpha and troubleshooting</h1>
<ul><li><b>“STRATUM can't be opened”</b> — use System Settings › Privacy &amp; Security › Open Anyway (Chapter 1).</li>
<li>Stem separation needs an Apple silicon Mac.</li>
<li>Many older VST2 plugins are Intel-only and won't load on Apple silicon.</li>
<li>Imported projects bring notes, arrangement and samples, but not other software's own instruments, mixer effects or most automation.</li>
<li>STRATUM can't post to social platforms by itself; it opens each upload page with your video ready to drag in.</li>
<li>Automation can be played and cleared but not yet drawn.</li></ul>
<h3>Licences</h3><p>Airwindows Consolidated (MIT) · Steinberg VST3 SDK (MIT) · ONNX Runtime (MIT) · HT-Demucs (MIT) · Stargate sample pack and Producer Space sounds (CC0). Licence files are inside the app.</p></section>""")

page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>STRATUM Owner’s Manual</title><style>{css}</style></head><body>{''.join(body)}</body></html>"""
open(os.path.join(HERE, "manual.html"), "w").write(page)
print("manual.html written,", len(page), "bytes")
