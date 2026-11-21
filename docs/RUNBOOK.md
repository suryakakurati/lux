# Runbook

## First run

```bash
cd LuxV.0
npm install
npm run hotkey       # compiles resources/bin/lux-hotkey
npm run assets       # draws the tray glyph
npm start
```

`npm start` builds and launches. The welcome window opens because onboarding has not been completed.

### Permission dance

1. **Microphone** — click *Allow*. If you dismissed the prompt, enable the binary you launched in
   System Settings → Privacy & Security → Microphone. In development that is `Electron`.
2. **Input Monitoring** — open the pane from the welcome window, add the same binary, then toggle it
   on. The helper polls every 1.5 s and starts working without a restart.
3. **Automation** — macOS asks the first time Lux controls an app (Spotify, System Events). Approve
   per app, or pre-approve in Privacy & Security → Automation.

The welcome window's *Re-check* button refreshes the statuses.

## Verifying the install

| Check | Command | Expected |
| --- | --- | --- |
| Types | `npm run typecheck` | no output, exit 0 |
| Unit tests | `npm test` | 103 passing (no network or macOS permissions required) |
| Build | `npm run build` | `out/main`, `out/preload`, `out/renderer` |
| Brain + tools | `npm run smoke -- "how's my battery?"` | tool rows, then a spoken-style answer |
| Capability audit | `npm run audit` | 57-tool registry plus 42 live integration checks; see `logs/audit.json` |
| Cancellation | `LUX_SMOKE_ABORT_MS=2000 npm run smoke -- "research this topic"` | aborts during the model call, exits 0 |
| Packaged form gate | `"release/Lux-darwin-arm64/Lux.app/Contents/MacOS/Lux" --form-test` | denied submit click does not submit; an approved submit changes the URL |
| Packaged research | `"release/Lux-darwin-arm64/Lux.app/Contents/MacOS/Lux" --ask "Research ..."` | one real packaged turn; inspect `logs/turns.jsonl` |
| Model rounds | `tail -n 1 ~/Library/Application\ Support/Lux/logs/turns.jsonl \| jq '.steps[] \| select(.kind=="model")'` | wall time, prompt/eval/load ms and exact cache reuse per model call |
| Hotkey binary | `resources/bin/lux-hotkey` runs and prints `{"event":"..."}` | `ready` after permission |
| STT | hold right ⌥ and say "open Spotify" | transcript appears in the HUD |

## Common problems

### The hotkey does nothing

- Is the helper built? `ls resources/bin/lux-hotkey`. If missing: `npm run hotkey`.
- Is Input Monitoring granted to the *Electron* binary? The helper is a child process; TCC
  attributes the grant to the responsible app.
- Are you inside a password field or the login window? Secure Event Input blocks all key events.
- Fallback: **⌃⌥Space** toggles dictation, **⌃⌥L** toggles the chat window. Neither needs Input
  Monitoring.

### "No audio detected"

- Microphone permission is denied or the input device is muted.
- The HUD reports this instead of sending silence to Whisper, which would otherwise invent text.
- Check the input device in System Settings → Sound → Input, then re-hold ⌥.

### "No local speech engine found"

Install one:

```bash
npm run stt:setup          # whisper.cpp + ggml-base.en (fastest)
# or make sure a whisper CLI is on PATH
which whisper
```

The engine state is shown in the top-bar pill, the rail's engine row and Settings → Local engine.

### "Can't reach Ollama" / engine offline

Lux supervises Ollama itself. On launch, every 20 seconds, and after the Mac wakes or the screen is
unlocked, `agent/engine.ts` pings `127.0.0.1:11434`. If it is down it runs `open -a Ollama`, falls
back to the bundled `ollama serve` binary, waits up to 30 seconds and then loads the selected model
with the keep-alive from Settings. A turn waits for that recovery, so a long powered-off gap shows
**STARTING ENGINE / WAKING MODEL** instead of a raw fetch error.

If the banner still says **ENGINE OFFLINE**:

```bash
ollama list                        # is Ollama installed and answering?
open -a Ollama                     # or run: ollama serve
ollama pull qwen3.5:latest
ollama pull nomic-embed-text
```

Use the **Wake** button in the banner or Settings → Local engine to retry immediately. Lux only
auto-starts a loopback URL; a custom remote `ollamaUrl` is never launched or pulled for you.

Lux uses the model selected in Settings. Tool calling requires a tool-capable model; `qwen3.5` and
`qwen3.5-instruct` both work. Recovery decisions are in
`~/Library/Application Support/Lux/logs/lux.log` under `[engine]`.

### The model answers but never acts

- Confirm the selected model supports tools: `ollama show qwen3.5:latest` lists `tools`.
- Small or heavily quantised models sometimes emit malformed arguments; the validator returns the
  error to the model, which usually corrects on the next round.

### Research is slow, empty, or repeats searches

`research` uses two keyless providers: Bing RSS for direct pages and Bing News RSS for current
articles, then falls back to Google News snippets only when the first pass has fewer than three
relevant results. Results are ranked against the question, so generic "local news" homepages are
dropped. A single turn allows two research calls and three `web_search` calls; after that the model
is told to use the evidence it has. If a result is marked `search snippet; page not opened`, treat
it as a lead rather than a full-page claim.

Check the raw ranking locally without a model:

```bash
node --input-type=module -e "import('./electron/main/web/search.ts').then(async m => console.log((await m.searchWeb('local AI models', 5)).hits))"
```

If Ollama is slow, check what is resident and whether the embedding model is still loaded:

```bash
ollama ps
```

Lexical memory is the default; switch to semantic only when paraphrase recall matters more than the
extra model and embedding call.

### App-control tools fail silently

macOS Automation permission was denied for that app. Open Privacy & Security → Automation and enable
Lux → the target app. `lock_screen`, `toggle_appearance` and `quit_app` are the usual suspects.

### Chat window will not open

The app is a menu-bar app; closing the window hides it. Use the tray icon, **⌃⌥L**, or
**⇧ + right ⌥**.

## Development notes

- `npm run dev` runs Electron with Vite HMR. The main process restarts on change.
- Renderer dev URL is `http://localhost:5173`; the packaged build is served from `app://lux/`.
- State lives in `~/Library/Application Support/Lux/data/`. Delete `settings.json` to replay
  onboarding; delete `conversations.json` for a clean history.
- Screenshots for design review: `docs/screenshots/`.

## Packaging

`npm run package` builds `release/Lux-darwin-arm64/Lux.app` (icon, `Lux` name, usage strings,
helper inside the bundle). Copy it to `/Applications` to install; Input Monitoring is path-based
so it must be re-granted once after a move. Signing is best effort and fails on an iCloud-managed
folder — the app still runs. Details and the permission panes: see README.

`npm start` runs the app from source. To ship a `.app`:

1. Add `electron-builder` with `mac.target: dmg`, `extraResources: resources/bin`.
2. Add `NSMicrophoneUsageDescription` to `extendInfo`.
3. Ad-hoc sign (`codesign --deep --force -s -`), then grant Input Monitoring once to the signed app.
4. Keep the helper outside `app.asar` so TCC can identify it.

Until that exists, treat Lux as a developer build — there is no installer.
