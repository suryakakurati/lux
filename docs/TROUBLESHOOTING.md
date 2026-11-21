# Troubleshooting

Start with the two logs:

```
~/Library/Application Support/Lux/logs/lux.log      human-readable
~/Library/Application Support/Lux/logs/turns.jsonl  one structured record per turn
```

`LUX_DEBUG=1` echoes the human log to stdout. `LUX_DATA_DIR=/tmp/lux-test` runs against isolated
settings so an experiment cannot damage real state.

## The engine is offline

The sidebar and toolbar show **Offline**, and a banner offers **Start engine**.

1. Press **Start engine**. Lux asks the supervisor to launch Ollama, wait for the API and preload the
   model.
2. If it stays offline, check that Ollama is installed and that `curl http://127.0.0.1:11434/api/tags`
   answers.
3. Lux only launches a loopback URL. If Settings contains a remote `ollamaUrl`, the app reports it and
   does not manage that process.
4. After a long sleep or a cold boot the supervisor polls every 20 seconds and re-checks on resume and
   unlock. A manual restart is only needed if it still fails.

## “Model missing”

The configured model is not installed. Lux never downloads a multi-gigabyte model on its own.

```bash
ollama pull qwen3.5:latest
```

Then choose it in Settings → Model and press **Restart** on the engine row.

## Holding right ⌥ does nothing

1. Settings → Permissions: **Input monitoring** must be granted to Lux (or Electron when running from
   source). Granting it usually requires quitting and reopening the app.
2. Check that the native helper exists. `npm run hotkey` compiles it. When running from source the
   helper is looked up next to the build output.
3. Input Monitoring is recorded per binary path. Moving `Lux.app` into `/Applications`, or rebuilding
   it, can require the grant again.
4. A keyboard-only fallback exists: ⌃⌥Space starts dictation without the event tap.

## The HUD appears but nothing is transcribed

1. Microphone permission must be granted to Lux. Settings → Permissions → **Open** takes you to the
   pane. macOS only lists an app after it has asked once, so use **Allow microphone** in onboarding
   first.
2. Lux needs a local STT engine. Install whisper.cpp with `npm run stt:setup`, or put a `whisper`
   binary on `PATH`. Without one, voice input fails with an actionable message.
3. If the HUD reports no audio, check the input device and mute state. A near-silent recording is
   rejected on purpose; it is not sent to Whisper.
4. Run `LUX_AUDIT_AUDIO=1 npm run audit` to exercise recording and playback end to end.

## A turn is very slow

Local inference on a 16 GB machine has a real floor.

- The first turn after launch loads a 6.6 GB model. Expect several seconds before the first token.
- A large context costs prefill time. Try 8K, which is the default.
- A turn that keeps calling tools is usually stuck on a failing page or an unsatisfied plan step.
  Read `turns.jsonl`: the `tools` and `plan` fields show what happened, and `kind: "model"` shows
  prefill, generation, load time and cache reuse.
- Research turns are allowed to take minutes. Trivial turns are not; if one does, the prompt probably
  changed shape and lost cache reuse.

## Spotify will not play a track by name

- Playback needs the desktop Spotify app and Automation permission for Lux.
- Name lookup primarily uses Spotify's rendered public search page, which needs no account or Premium.
- Optional Web API credentials only help when the account owning the developer app has Premium.
  Spotify returns `403 Active premium subscription required for the owner of the app` otherwise. That
  is Spotify's rule, not a Lux bug.
- Reading play history must never start playback. If playback starts on a taste question, that is a
  bug; the tools are separate by design.

## The browser cannot see a page

- Lux uses its own Chromium window, not your Firefox tabs. Firefox cannot be scripted; only its
  history is readable.
- The browser is hidden by default. A page that asks for a sign-in reveals the window; complete the
  sign-in there and the session persists for later requests.
- `browser_inspect` reports headings, buttons, forms and tables. If a page renders content after a
  long delay, call it again rather than assuming the page is empty.
- Clicking a link, filling a field or pressing Enter asks for approval because a page handler can
  submit. `browser_submit` always asks.

## The morning brief did not appear

- Lux must be running. The brief is delivered once a day at the configured time (default 08:30).
- Quiet hours suppress delivery (default 22:00–08:00).
- If the Mac was asleep at the delivery time, the brief waits until it wakes, but only within three
  hours. Opening the lid at 21:00 will not produce a “morning” brief.
- Delivery is recorded in `data/proactive.json`, so a restart does not repeat it.
- To see it immediately: `LUX_BRIEF_NOW=1 npx electron out/main/index.js`.

## Settings says a permission is missing but macOS shows it as on

macOS grants some permissions per binary path. Rebuilding or moving the app creates a new identity.
Remove the old Lux entry in the relevant Privacy & Security pane, relaunch, and grant it again. The
microphone grant is by bundle id and normally survives a move; Input Monitoring does not.

## Packaging fails to sign

Ad-hoc signing fails in iCloud-managed folders (Desktop, Documents) because the file provider keeps
re-attaching `com.apple.FinderInfo`, which `codesign` rejects. The app still runs locally. Move the
project to a non-iCloud folder if a clean signature matters.

## “No audio” after a rebuild

Rebuilding changes the bundle, so macOS may re-prompt for Microphone and Input Monitoring. Grant them
again; the prompts are expected, not a regression.

## Reset everything

Quit Lux, then remove the data directory:

```bash
rm -rf "$HOME/Library/Application Support/Lux/data"
```

Settings, conversations, memory, commitments and task state are recreated with defaults on the next
launch. Removing `logs/` is safe too. This is destructive and cannot be undone.

## Collect a report

```bash
npm run typecheck && npm run lint && npm test
npm run audit
```

`npm run audit` writes `logs/audit.json` with PASS/FAIL/SKIP per live integration. Include the
relevant `turns.jsonl` records when reporting an agent problem; they contain no secrets, but review
them before sharing.
