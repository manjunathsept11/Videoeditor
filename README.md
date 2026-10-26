# ShortStudio

Deterministic, code-driven 3D engine for 9:16 explainer shorts. Full design: [docs/ShortStudio_Architecture.md](docs/ShortStudio_Architecture.md).

## Layout

| Path | Purpose |
|:--|:--|
| `packages/schema` | zod schemas for `project.json`, `sets/*.json`, `shots/*.json` + cross-reference validation (`parseBundle`) |
| `packages/engine` | The six animation rules as pure functions (`rules.ts`), pose/timeline resolution (no WebGL, unit-tested), and the Three.js layer (`Studio`, WhiteLift + inverted-hull shaders, mannequin, procedural set kit) |
| `packages/audio` | Silence clamping with a source-to-output time map, WhisperX importer, BS.1770 loudness meter, synthesized SFX, timeline-driven cues, the mixer (-14 LUFS master) |
| `packages/export` | WebCodecs + mp4-muxer video export (frame N is rendered at t = N / fps; H.264, falling back to VP9/AV1) |
| `packages/qa` | Quality gate: framing/eye-line/caption-zone, blocked views, prop clipping, floor coverage; each with an auto-fix |
| `packages/agents` | Director -> Set Designer -> Scene Builder, validated and self-repairing; Claude API and local-CLI backends behind one interface |
| `apps/render` | Headless renderer (Vite + Playwright -> PNG frames -> ffmpeg -> MP4, muxes the voiceover) and the `audio` CLI |
| `examples/demo` | 4-shot sample project with hand-typed times |
| `examples/kit` | The set kit: pachinko hall, prize shop, exchange-window alley |
| `examples/rig` | A walk across the set (foot-locked, with the bob and arm swing), a gesture, and a jolt |
| `examples/props` | The five number props (counter, dial, calendar, clock, magnifier), each landing on a spoken word |
| `examples/anchored` | Same shots authored against words (`"at": {"word": "gambling"}`) + a sample `audio/alignment.json` |

## Use

```bash
npm install
npm test                       # rules + schema + timeline resolution
npm run typecheck
npm run render -- examples/demo out/demo.mp4 --scale 0.5      # preview
npm run render -- examples/demo out/f.png --frame 54 --scale 0.5   # single frame
```

## Making a short from a script

```bash
# script + word timings -> project (Director, Set Designer, Scene Builder agents)
npm run produce -- script.txt projects/x/audio/alignment.json projects/x --provider cli            # local `claude -p`
npm run produce -- script.txt projects/x/audio/alignment.json projects/x --provider api            # Claude API (ANTHROPIC_API_KEY)
npm run qa -- projects/x --fix        # auto-repair framing, blocked views, props, floor gaps; patches the JSON
npm run render -- projects/x out/short.mp4
```

Every agent answer is validated against the schema and the quality gate; problems are shown back to the model so it repairs its own
answer. Floor gaps are repaired deterministically at set level. `--provider cli` accepts any CLI that reads a prompt on stdin
(`--cli gemini --cli-args "-p"`). `render` runs the gate first and refuses to render a broken project unless you pass `--force`.
Captions come from the alignment (lower 30%, white with black stroke, 3 words per line) and can be switched off or given a
highlight colour for the spoken word in `project.json` (`"captions": {"enabled": true, "highlight": "#ffe14a"}`).

## Export and sound

```bash
npm run export -- projects/x out/short.mp4                  # 1080x1920, project fps (30)
npm run export -- projects/x out/short.mp4 --fps 60 --music beat.wav
npm run audio -- mix projects/x out/master.wav              # just the audio master + a report of every level
```

**Video** is encoded in the engine with WebCodecs (`packages/export`), not screen-captured: frame N is rendered at exactly t = N / fps and
handed to a `VideoEncoder` with an exact microsecond timestamp. H.264 High (level 4.2) is used when the browser has it, otherwise
VP9/AV1 (ffmpeg then transcodes to H.264). ffmpeg only attaches the audio.

**Audio** is mixed in code, with the voiceover as the 0 LU anchor:

| stem | level | notes |
|:--|:--|:--|
| voiceover | 0 LU (its measured loudness) | the anchor |
| hits: impact, tick, ding, footsteps | -10 LU | measured over each effect's own duration |
| whooshes, page flips | -15 LU | |
| music (`audio/music_bed.wav` or `--music`) | -18 LU | looped, trimmed, faded, **never ducked** |
| master | **-14 LUFS**, true peak <= -1 dBTP | iterates gain + a lookahead limiter until both hold |

Effects are **synthesized** (deterministic, royalty-free) and **derived from the timeline**, landing on the exact frames the engine uses:
a whoosh into each shot change, a tick/ding/page-flip where each prop reaches its value, an impact on every jolt, and one footstep
cue per walk with a footfall at every step the foot-lock rig plants. Density is capped at 20/min by priority (`--max-sfx n` changes it) and
a long video with fewer than 12/min is flagged. Hand-written cues go in `audio/sfx_manifest.json`
(`{"cues": [{"at": {"word": "boom"}, "kind": "impact", "gain": 2}, {"at": 5, "kind": "whoosh", "file": "my.wav"}]}`); they outrank auto cues.

The loudness meter is written from BS.1770-4 (exact ITU coefficients at 48 kHz) and is checked against ffmpeg's `ebur128` in the tests:
within 0.04 LU and 0.03 dB of true peak. `npm run test:e2e` runs a real export and judges it with ffprobe/ebur128.

## Sets and look

Set objects beyond boxes, signs and lights (all procedural, detail seeded from the object id so renders repeat exactly):
`pachinko` (lit pin panel, header, ball tray, side light bars), `shopcounter`, `exchangewindow`, `shelf` (stocked with prizes), `lantern`,
`vending`, `streetlight`. Each has collision bounds in the quality gate (blocked views, prop clipping).

`project.json` -> `look` controls post-processing. Both are on by default, mildly:

- **Depth of field:** focus follows the actors (distance to their centroid), so backgrounds and foreground soften while the characters
  stay sharp. `"dof": {"aperture": 0.0008, "maxBlur": 0.012}` or `false`.
- **Bloom:** only pixels brighter than `threshold` (1.0 is plain white) glow, so it picks out neon, lanterns and lamps, never white heads.
  `"bloom": {"strength": 0.4, "radius": 0.5, "threshold": 1.1}` or `false`.

## Body motion: walk and jolt

A real joint hierarchy (pelvis, torso, head, shoulders -> elbows, hips -> knees -> feet). Everything is a pure function of time
(`engine/src/rig.ts`), so any frame renders alone.

```json
{"type": "walk", "actor": "ken", "at": {"word": "door"}, "until": {"word": "makes"}, "to": [1.5, 1.0], "turn": true}
{"type": "jolt", "actor": "mio", "at": {"word": "legal"}, "height": 0.5}
```

- **Foot lock by construction:** every planted foot is one fixed world point for its whole stance and the legs are solved to reach it
  with two-bone IK, so feet cannot slide. The only way to break it is a stride the legs cannot span, which the quality gate reports
  (`foot-slide`) with a duration that is known to fit.
- **Cadence and bob:** a step every 5-6 frames (the step time adapts so the walk lands exactly on `until`), hips bob 7% of head
  height peak to peak, arms swing opposite the legs. Speed ramps over the first and last step so nothing pops.
- **Turning:** the actor turns into the direction of travel over the first two steps and back over the last two, so a planted
  foot never twists under the hip. `"turn": false` strafes without turning.
- **Jolt:** up 50% of a head height in 2 frames, hold, settle. The legs hang with the body.
- Idle is dead still: with no events active, every joint is a constant.

## Number props

Numbers are physical objects, never text overlays. A shot lists `props` and `propEvents`; each event rolls a prop to its value so that it
**first touches the value on the exact frame of the anchored word**, overshoots ~10% and settles (closed-form spring, started
`springRiseTime` early, so any frame can be rendered on its own).

| kind | event payload | behaviour |
|:--|:--|:--|
| `counter` | `value` | odometer drums; the ones drum rolls, higher drums only turn on the carry |
| `dial` | `value` | gauge needle sweeping through min..max |
| `calendar` | `value` (day 1-31) | hinged flap folds over to reveal the next day |
| `clock` | `time` ("4:30") | hands whirl forward at least one full turn, then settle |
| `magnifier` | `to` ([x, y] in -1..1) | lens glides over a document and magnifies the text under it |

The quality gate checks props are fully in frame (including the camera creep) and clear of the caption zone.

## Voiceover workflow

```bash
# 1. Tighten: clamp every pause to <= 0.2s (writes out.wav + out.wav.map.json)
npm run audio -- tighten voiceover.wav projects/x/audio/voiceover_tight.wav

# 2. Word timestamps: run WhisperX (or whisper-timestamped) yourself, then import.
#    Needs a machine that can download the model.
whisperx projects/x/audio/voiceover_tight.wav --output_format json --output_dir tmp
npm run audio -- import-whisper tmp/voiceover_tight.json projects/x/audio/alignment.json \
    --audio projects/x/audio/voiceover_tight.wav
#    If you aligned the ORIGINAL (untightened) audio instead, add: --map projects/x/audio/voiceover_tight.wav.map.json

# 3. Author shots against words, check the resolved timeline, render with audio
npm run audio -- check projects/x
npm run render -- projects/x out/short.mp4
```

Anchors: `{"word": "gambling", "nth": 2, "edge": "start|end", "offset": 0}`; `word` may be a phrase (`"the window"`) and matches ignore case and punctuation. A shot may omit `duration` (it runs to the next shot's start; the last shot runs to `alignment.duration`). Gesture lead (-4 frames) is applied by the engine, so anchor to the word itself.

## Decisions

- **Timebase:** rules are authored on a 30fps canonical grid; JSON stores seconds. A 60fps export keeps identical timing (blinks and gestures snap to the 30fps grid).
- **Determinism:** `Studio.renderAt(t)` is a pure function of `t`; the renderer steps frame indices, never wall-clock. The same frame renders byte-identically across browser sessions.
- **Gesture timing:** per Rule 2 the arm has *landed* `lead` (4) frames before the spoken word, with the 5-frame rise finishing there. (The doc's sequence diagram shows the move *starting* at -4, which contradicts the rule table; the rule table wins.)
- **Shot density:** configurable per project; shots carry absolute `start`/`duration` in seconds.

## Not done yet

Running the aligner model itself (WhisperX/CTC; the importer and everything downstream are tested, the model step is not), TTS, walk cycles / full joint rig (phase 2), physical number props (3), loudness mixing and SFX/music (6), Electron click-to-edit shell (5), WebCodecs export + FFmpeg mixer (6), agents, captions, and a richer set kit.
