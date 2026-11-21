# Security

## Guarantee

Audio, transcripts, prompts and responses stay on this machine. Lux never contacts a hosted model and
sends no telemetry. The only outbound requests are the ones an explicit tool performs: ranked web
search, page reads, a research dossier, the optional news feed, and Ollama on loopback.

## Threat model

| Asset | Risk | Control |
| --- | --- | --- |
| Microphone audio | recorded beyond a hold, or exfiltrated | capture only while the HUD reports `listening`; recorder auto-stop; near-silence is rejected; WAV is posted to the local main process |
| Keystrokes | Lux reading everything you type | listen-only `CGEventTap`; only modifier flag changes are inspected; no keycodes are logged; no filtering or posting |
| Shell | model runs a destructive command | per-call approval, destructive-command blocklist, timeout, output truncation |
| Browser actions | a click or fill submits a form without approval | clicks, fills and Enter presses are confirmation-gated; native submits, controls inside a form, inline `onclick` and `javascript:` links are reported as requiring confirmation |
| Renderer | XSS through model output or a tool result | DOMPurify allow-list, CSP, sandbox, context isolation, no Node integration |
| Local state | another local user reads memory or credentials | files live under `~/Library/Application Support/Lux` with user-only permissions; no world-readable copies |
| Network | a tool silently uploads local data | no telemetry, analytics or cloud fallback; a remote Ollama URL is reported but never managed |
| Prompt injection | a page or note instructs the agent | content is labelled data; the prompt forbids following instructions from it; actions still pass the approval layer |

## Untrusted input

The following are **data, never instructions**:

- web pages and search results,
- Obsidian notes and markdown files,
- rows from the optional local knowledge database,
- clipboard text,
- Spotify track and playlist names,
- browser history titles,
- model output itself.

The system prompt states this explicitly and requires Lux to report an injection attempt instead of
acting on it. No tool can escalate its own privileges, so the worst case of a successful injection is
a wrong tool call — which is either safe or requires approval.

## Approvals

Each tool declares `risk: 'safe' | 'confirm'`. `executeTool` pauses a confirm-gated call, sends the
request to the chat window and waits up to 60 seconds. Timeout resolves to **no**. The dialog shows:

- the tool name,
- the exact command for `run_shell`,
- the argument summary for everything else.

A denial is final for that call and is returned to the model as a result, not retried in a loop.

`browser_submit` is always confirm-gated. A click on a native submit control, a control inside a form,
an inline JavaScript action or a `javascript:` link is also treated as requiring confirmation, so a
tool cannot bypass the gate by choosing a different selector.

## Shell safety

`run_shell` is approval-gated and also refuses, before execution:

`sudo`, `mkfs`, `dd if=`, writes to `/dev/disk*`, fork bombs, `diskutil erase|partition|secureErase`,
`shutdown|reboot|halt`, `curl … | sh`, `rm -rf /|~|$HOME`, `killall`,
`launchctl unload|remove|disable`, `csrutil`.

This is a safety net, not a sandbox. A command that passes both checks still runs with your user
privileges. Approval is the control; the blocklist exists so a tired confirmation cannot erase a
disk.

## Tool results and errors

Tools return a uniform envelope (`ok`, `data`, `truncated`, `next_hint`, `error_kind`). Large results
are truncated before they re-enter context. A tool error is a value, never an unhandled exception:
the turn can replan or report the failure without crashing the app.

## Background jobs

The `job` tool runs one existing tool outside the current round. The nested call keeps its own
validation, confirmation and timeout, so a job cannot be used to skip an approval or to start an
unbounded process. Jobs are in-memory and disappear when the app quits.

## Renderer isolation

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every window.
- The preload exposes a fixed `window.lux` object; no `ipcRenderer` reaches page code.
- `setWindowOpenHandler` denies popups and opens http(s) externally.
- `will-navigate` blocks anything that is not the app origin or the local dev server.
- The custom protocol resolves inside the built renderer only; `..` traversal is rejected.
- Markdown is parsed with `marked` and sanitised with DOMPurify using an explicit tag/attribute
  allow-list.
- The HUD is `focusable: false` and shown inactive, so holding ⌥ never steals keystrokes.

## Secrets

- Spotify client credentials, if provided, live in `data/settings.json` and never enter the prompt,
  the turn trace, the logs or the renderer.
- Ollama is unauthenticated on loopback. Do not expose `11434` on a network interface; Lux assumes
  `127.0.0.1`.
- The repository contains no credentials. `.env*` files are ignored, and `.env.example` documents
  names only.

## Data at rest

Settings, conversations, memory, commitments, proactive state and task state are atomic JSON files
(`tmp` + rename) under `~/Library/Application Support/Lux/data/`. Deleting a conversation removes it
from `conversations.json`; deleting the app's data directory removes everything. Logs are plain text
under `logs/` and rotate at 2 MB.

## Reporting a concern

Anything that would send data off-device, or make a destructive action possible without approval, is
a design violation regardless of intent. Report it as a security issue rather than a bug.
