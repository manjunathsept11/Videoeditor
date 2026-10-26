# ShortStudio

Deterministic, code-driven 3D engine for 9:16 explainer shorts. Full design: [docs/ShortStudio_Architecture.md](docs/ShortStudio_Architecture.md).

## Layout

| Path | Purpose |
|:--|:--|
| `packages/schema` | zod schemas for `project.json`, `sets/*.json`, `shots/*.json` + cross-reference validation (`parseBundle`) |
| `packages/engine` | The six animation rules as pure functions (`rules.ts`), pose/timeline resolution (no WebGL, unit-tested), and the Three.js layer (`Studio`, WhiteLift + inverted-hull shaders, mannequin, procedural set kit) |
| `apps/render` | Headless renderer: Vite + Playwright (Chromium) -> PNG frames -> ffmpeg -> MP4 |
| `examples/demo` | 4-shot sample project (2 sets, 2 actors, dissolves, gestures, expressions) |

## Use

```bash
npm install
npm test                       # rules + schema + timeline resolution
npm run typecheck
npm run render -- examples/demo out/demo.mp4 --scale 0.5      # preview
npm run render -- examples/demo out/f.png --frame 54 --scale 0.5   # single frame
```

## Decisions

- **Timebase:** rules are authored on a 30fps canonical grid; JSON stores seconds. A 60fps export keeps identical timing (blinks and gestures snap to the 30fps grid).
- **Determinism:** `Studio.renderAt(t)` is a pure function of `t`; the renderer steps frame indices, never wall-clock. The same frame renders byte-identically across browser sessions.
- **Gesture timing:** per Rule 2 the arm has *landed* `lead` (4) frames before the spoken word, with the 5-frame rise finishing there. (The doc's sequence diagram shows the move *starting* at -4, which contradicts the rule table; the rule table wins.)
- **Shot density:** configurable per project; shots carry absolute `start`/`duration` in seconds.

## Not done yet

Walk cycles / full joint rig (phase 2), physical number props (3), forced alignment + voiceover (4), Electron click-to-edit shell (5), WebCodecs export + FFmpeg mixer (6), agents, captions, and a richer set kit.
