# Research notes

Findings that shaped V.0, with sources. Everything here was verified before implementation.

## Holding right ⌥

Modifier keys never emit `keyDown`/`keyUp`; they emit `flagsChanged`. So a hold must be derived from
the flag edges of a listen-only `CGEventTap`:

- Right Option is **keycode 61** (`0x3D`); left Option is 58. The numeric keycodes come from
  Carbon's `Events.h` (`kVK_RightOption`), confirmed by Apple DTS:
  <https://developer.apple.com/forums/thread/748423>
- The side-specific bit is **`NX_DEVICERALTKEYMASK` (0x40)**, not `kCGEventFlagMaskAlternate`
  (0x80000), which both Option keys set:
  <https://developer.apple.com/documentation/coregraphics/cgeventflags>
- A **listen-only** tap needs **Input Monitoring** (`kTCCServiceListenEvent`), not Accessibility.
  Accessibility is only required for filtering taps or posting events:
  <https://developer.apple.com/forums/thread/744440>
- A tap can be created but silently disabled when the grant is missing, so the helper checks
  `CGEventTapIsEnabled` and re-arms on `tapDisabledByTimeout`.
- While Secure Event Input is active (password fields, login window) the tap receives nothing. No
  workaround exists; Lux treats it as "no keypress".

Design consequence: the helper lives in its own signed binary process, prints NDJSON, and polls for
permission so granting Input Monitoring takes effect without restarting the app.

## Microphone capture in a hidden Electron window

- Electron documents that with `backgroundThrottling: false` the page visibility state stays
  `visible` even when the window is hidden or occluded; without it, macOS occlusion can make the
  page hidden: <https://www.electronjs.org/docs/latest/api/browser-window>
- Chromium treats an already-active capture continuing after a page is hidden as expected
  behaviour: <https://issues.chromium.org/issues/526039695>
- Capture can fail to *silence* without an error (no `muted`, `readyState: live`) when the TCC grant
  is missing: <https://github.com/electron/electron/issues/42714>

Design consequence: prime the stream while the HUD window is visible, keep it alive, set
`backgroundThrottling: false`, and treat near-zero peak amplitude as an error rather than sending
silence to Whisper.

## Audio format for Whisper

- Whisper models are trained on **16 kHz mono**.
- `MediaRecorder` in Chromium cannot produce WAV, only lossy webm/opus, so it is the wrong tool.
- An `AudioContext({ sampleRate: 16000 })` plus an `AudioWorklet` gives sample-exact Float32 PCM and
  lets Chromium resample; encode a 44-byte RIFF header yourself.
- whisper.cpp's CLI accepts 16-bit WAV only:
  <https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/README.md>

Design consequence: `src/lib/recorder.ts` + `shared/wav.ts`, no ffmpeg dependency.

## Speech engine choice

Community benchmarks on Apple silicon: whisper.cpp `base` transcribes a short utterance in roughly
0.15–0.4 s once warm; openai-whisper's CLI pays Python import + model load per invocation. mlx-whisper
is fast but adds a Python runtime. Hence the priority order whisper.cpp → whisper CLI → mlx worker,
with the engine detected at runtime.

## Ollama tool calling

- `POST /api/chat` with `tools: [{type:'function', function:{name, description, parameters}}]`;
  `parameters` is JSON Schema. <https://docs.ollama.com/api/chat>
- The response carries `message.tool_calls[]`, and **`function.arguments` is an object**, not a JSON
  string. Verified locally against `qwen3.5:latest` on Ollama 0.40.3.
- Tool results go back as `{role:'tool', tool_name, content}` — `tool_call_id` is not required.
- `think: false` disables the reasoning stream. Without it, qwen models can spend the whole budget
  thinking and return no content.
- Embeddings use `POST /api/embed` with `input: string[]` → `embeddings: number[][]`, normalised.
  The older `/api/embeddings` endpoint is deprecated.

Design consequence: `ToolCallAccumulator` accepts both object and string arguments, merges by index,
and repairs truncated JSON.

## Design references

- Type scale and radii: Vercel's Geist system (named roles, 6/12/16 px materials):
  <https://vercel.com/geist/typography>, <https://vercel.com/geist/materials>
- Density and restraint: Linear's 2024 redesign notes — fewer decorative elements, more alignment:
  <https://linear.app/now/how-we-redesigned-the-linear-ui>
- Loading feedback: show progress after ~150–300 ms, keep it visible ≥300 ms (Vercel guidelines):
  <https://vercel.com/design/guidelines>
- macOS typography floor: 13 pt body, 10 pt minimum:
  <https://developer.apple.com/design/human-interface-guidelines/typography>
- Command surfaces with a contextual action row, not a sidebar-first layout: Raycast UI refresh:
  <https://www.raycast.com/blog/a-fresh-look-and-feel>
- Agent activity should be inspectable, compact and inline rather than a chat bubble per step:
  <https://platform.openai.com/docs/guides/function-calling>

Design consequence: see `docs/DESIGN.md` — a 12/13/14.5/20/44 px scale, 4 px spacing grid, hairline
rules, one accent colour, and an inline tool-activity row.

## What remains empirical

- No Apple documentation publishes keycode numbers; 61/0x3D rests on SDK headers and mirrors.
- No first-party Electron doc guarantees hidden-window capture forever; the mitigation is the
  visible-before-capture ordering plus the silence watchdog.
- Motion durations in `DESIGN.md` are our own tokens, not measured from other products.
