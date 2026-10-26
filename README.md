# ShortStudio

Deterministic, code-driven 3D engine for 9:16 explainer shorts. Full design: [docs/ShortStudio_Architecture.md](docs/ShortStudio_Architecture.md).

## Layout

| Path | Purpose |
|:--|:--|
| `packages/schema` | zod schemas for `project.json`, `sets/*.json`, `shots/*.json` + cross-reference validation (`parseBundle`) |
| `packages/engine` | The six animation rules as pure functions (`rules.ts`), pose/timeline resolution (no WebGL, unit-tested), and the Three.js layer (`Studio`, WhiteLift + inverted-hull shaders, mannequin, procedural set kit) |
| `packages/audio` | Silence clamping (no pause > 0.2s) with a source-to-output time map, WAV I/O, WhisperX / whisper-timestamped importer |
| `packages/qa` | Quality gate: framing/eye-line/caption-zone, blocked views, prop clipping, floor coverage; each with an auto-fix |
| `packages/agents` | Director -> Set Designer -> Scene Builder, validated and self-repairing; Claude API and local-CLI backends behind one interface |
| `apps/render` | Headless renderer (Vite + Playwright -> PNG frames -> ffmpeg -> MP4, muxes the voiceover) and the `audio` CLI |
| `examples/demo` | 4-shot sample project with hand-typed times |
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
