# Security

## Guarantee

Audio, transcripts, prompts and responses stay on this machine. Lux never contacts a hosted model.
The only outbound requests are the ones an explicit tool performs (`news_digest`, `open_url` /
`search_web` which just open a browser, and Ollama on loopback).

## Threat model

| Asset | Risk | Control |
| --- | --- | --- |
| Microphone audio | recorded beyond a hold, or exfiltrated | capture only while the HUD reports `listening`; 30 s hard stop; WAV posted to the local main process and deleted after transcription |
| Keystrokes | Lux reading everything you type | listen-only `CGEventTap`; only modifier flag changes are inspected; no keycode logging; no event filtering or posting |
| Shell | model runs a destructive command | `run_shell` requires per-call approval + blocklist + 20 s timeout + output truncation |
| Renderer | XSS through model output | DOMPurify with an allow-list, CSP, no `nodeIntegration`, `contextIsolation`, `sandbox` |
| Local state | other users reading memory | files under `~/Library/Application Support/Lux` inherit user-only filesystem permissions |
| Network | a tool silently uploading data | no HTTP tool except RSS fetch; no telemetry; no analytics |

## Renderer isolation

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window.
- Preload exposes a fixed `window.lux` object. No `ipcRenderer` reaches page code.
- `setWindowOpenHandler` denies all popups and opens http(s) externally.
- `will-navigate` blocks anything that is not the app origin.
- Custom protocol resolves inside `out/renderer` only; `..` traversal is rejected before reading.
- Markdown is parsed by `marked` then sanitised by DOMPurify with an explicit tag/attribute list.

## Tool safety

Two independent layers:

1. **Validation** — unknown arguments, wrong types, out-of-range numbers and enum violations are
   rejected before a tool runs. The model sees the error and can correct.
2. **Policy** — `risk: 'confirm'` pauses the turn for human approval; denial is fed back to the
   model as a final answer, not a retry.

`run_shell` additionally refuses:

`sudo`, `mkfs`, `dd if=`, writes to `/dev/disk*`, fork bombs, `diskutil erase|partition|secureErase`,
`shutdown|reboot|halt`, `curl … | sh`, `rm -rf /|~|$HOME`, `killall`, `launchctl unload|remove|disable`,
`csrutil`.

This is a safety net, not a sandbox. A shell command that passes both checks still runs with your
user privileges — that is why approval is mandatory and the command is shown verbatim.

## Prompt injection

Content fetched by `news_digest` and text read from the clipboard/notes enters the model context. The
system prompt treats tool output as data, and no tool can escalate privileges on its own; the worst
outcome is a wrong tool call, which is either safe or requires approval. `remember` only stores a
fact string.

## Secrets

V.0 has no API keys. Ollama is unauthenticated on loopback; if you expose it on a network interface,
put authentication in front of it — Lux assumes `127.0.0.1`.

## Reporting a concern

Anything that would send data off-device, or make a destructive action possible without approval, is
a design violation regardless of intent.
