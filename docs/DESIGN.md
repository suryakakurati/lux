# Design

Lux is a private instrument, not a chat toy. The interface is **Sentinel**: a near-black
instrument panel with one ion-cyan signal, layered glass, mono telemetry and slow mechanical
motion. The reactor mark in the rail is the only decorative object; everything else is there to
tell you what the local agent is doing and what it needs.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `void` | `#05080B` | window base |
| `abyss` | `#080D12` | sheet, rail foot |
| `panel` / `panel-soft` | `#0C141A` / `#111C24` | raised glass, controls |
| `ink` | `#E9F4F5` | primary type |
| `ink-2` | `rgba(222,240,242,.76)` | reply body |
| `ink-3` / `ink-4` | `rgba(202,228,233,.52)` / `.32` | secondary type, micro-labels |
| `ion` | `#5CEBD4` | the single accent: live state, focus, send, success |
| `ion-bright` / `ion-deep` | `#A6FFF0` / `#17A893` | core highlight, quiet accent |
| `amber` | `#F2B45E` | engine starting or waking, warnings |
| `danger` | `#FF6F86` | offline engine, failed tools, approval gating |
| `glass` | `rgba(14,23,30,.72)` | cards over the moving workspace |
| `glass-line` | `rgba(155,214,218,.13)` | every hairline |

Rules:

- One accent hue. Amber and coral are status signals, never decoration; a healthy surface is
  monochrome plus ion.
- No pure black and no pure white. The brightest object is the reactor core or the caret.
- Depth is a 1 px cyan-tinted hairline, a translucent fill and a shadow that disappears into the
  background — not a heavy drop shadow.
- The shell is an atmosphere: two ion/blue radials, a masked 44 px grid, and a vignette. The grid
  drifts 44 px over 48 s; nothing else in the background moves.

## Type

| Role | Family | Size / weight |
| --- | --- | --- |
| Empty-state headline | SF Pro Display via `-apple-system` | 48 px, 500, −0.035 em |
| Section headings | SF Pro Display via `-apple-system` | 20 px, 500 |
| Body and replies | SF Pro Text via `-apple-system` | 12–14.5 px, 400–600 |
| Wordmark | SF Pro Display | 16 px, 600, 0.26 em tracking |
| Data, labels, tool names | SF Mono / ui-monospace | 7–11 px, 0.1–0.22 em tracking |

- Micro-labels are uppercase mono at 7.5–9 px. They are the instrument-panel voice, not body copy.
- Numbers are tabular.
- No downloaded fonts: the interface must render identically offline.

## Space and surfaces

- 12 px inset around the window; 12 px gap between rail and workspace.
- Radii: 6–8 px controls, 12 px cards, 15–16 px rail/composer/sheet, 99 px status pills.
- The rail is 248 px (218 px below 980 px) because conversation titles have to stay readable; the
  instrument aesthetics do not justify a 137 px strip.
- Glass is reserved for things that float: the rail, reply cards, the tool trace, the HUD and the
  settings drawer. The composer is slightly denser so it reads as the input surface.
- The settings drawer is fully opaque (`#080D12`); a translucent sheet let bright transcript text
  ghost through the controls, which looked like a rendering bug.

## Motion

| Element | Duration | Easing |
| --- | --- | --- |
| Hover / focus / pill state | 150–200 ms | `cubic-bezier(.2,.8,.2,1)` |
| Message entrance | 380 ms, 9 px rise + 4 px blur | `cubic-bezier(.16,1,.3,1)` |
| Empty state stagger | 700 ms, 80–260 ms delays | `cubic-bezier(.16,1,.3,1)` |
| Rail collapse | 320 ms | `cubic-bezier(.2,.8,.2,1)` |
| Settings drawer | 380 ms slide + blur | `cubic-bezier(.16,1,.3,1)` |
| Reactor mid ring | 7 s linear, opposite direction | — |
| Reactor outer ring | 22 s linear | — |
| Live dot / status bars | 1.1–2.8 s | `ease-in-out` |
| Tool trace sweep | 2.2 s | `ease-in-out` |

- Only `opacity`, `transform` and `filter` animate. Layout properties change only for the rail
  width and textarea height.
- Streaming shows a glowing caret; the composer glows and grows a 1 px scan line on focus.
- `prefers-reduced-motion` collapses every animation and transition to 0.001 ms.

## The reactor

The mark is built from CSS, not an image: a blurred halo, a dashed outer ring, a counter-rotating
mid ring with one bright arc, two fixed tick marks and a radial core. It appears at 30 px in the
rail, 112 px in the empty state, 26 px on onboarding, and 20 px on an engine banner.

It is inert when the engine is offline (`data-active="false"`: rings stop, core turns grey). This is
the one place where the design encodes state without a label.

## The chat window

- **Framed workspace**: 12 px inset. The rail is a floating console; the native traffic lights sit
  above it at `(18, 20)`, clear of the brand block.
- **Top bar** 64 px, drag region: a blinking beacon plus `ON-DEVICE CHANNEL`, the active
  conversation title, then the engine pill, the model chip and the gear.
- **Engine pill**: `ONLINE` (ion, animated equalizer), `STARTING` / `WAKING` (amber, fast bars),
  `OFFLINE` or `NO MODEL` (coral/amber). Click to re-check. The same state appears in the rail and,
  when not ready, as a banner above the composer with a **Wake** action.
- **Rail**: reactor + `LUX` + `ON-DEVICE AGENT` and a live state word. `CONVERSATIONS` with a count
  and a circular new button; the active row gets a glowing 2 px ion bar and a faint gradient.
  Hover reveals delete. Below: `DELETE ALL`, `SETTINGS`, an engine row, three vitals (CPU / MEM /
  PWR) with 2 px meters, mic and privacy state, then `HIDE PANEL`.
- **Thread** max 720 px: assistant replies are glass slabs with a 28 px reactor avatar, a mono
  `LUX` + time header and a copy action. User messages are compact right-aligned slate slabs with a
  sharp top-right corner and `YOU` in the meta line.
- **Tool trace**: one card per agent step, indented to the reply text. It carries the step label, a
  zero-padded count, the primary argument and the total time. A running trace sweeps a 1 px ion line
  across its top; each row has a status dot, tool name, argument and per-call milliseconds. Clicking
  a row reveals the full arguments and result summary.
- **Thinking**: an equalizer pill with `PROCESSING` and a live seconds counter, so a long local turn
  never looks hung.
- **Composer** 760 px: `›` glyph, auto-growing textarea, `hold right ⌥`, `⏎ send`, `⇧⏎ line`, and a
  glowing circular ion send button. Enter sends, Shift+Enter adds a line, Esc cancels.
- **Approval bar** for destructive tools: coral-tinted glass, the command in a near-black mono
  block, Deny / Approve. It is the only saturated red surface.
- **Settings** is a 420 px opaque drawer with a sticky header; engine state and a Wake button sit
  first, then model, voice, proactive, permissions, notes/memory and Spotify.

## Empty state

A 112 px reactor with orbit rings → `SYSTEM READY · ALL LOCAL` → **At your service.** → one sentence
about local inference → four command rows (`01`–`04`) that are real tools, each with a chevron that
only appears on hover. The reactor is inert when the engine is not ready and the kicker names the
actual state.

## The HUD

A 452×168 transparent window holding a 424×140 dark-glass pill (14 px inset for the shadow).

- **Orb**: ion rings + a gradient core scaled by measured microphone RMS. Listening pulses rings;
  thinking spins one bright arc; done/brief show a check; error turns coral.
- **Status**: uppercase mono label plus a live `0.0s` counter while listening.
- **Transcript / detail**: 14.5 px, clamped to two lines.
- **Waveform**: 22 two-pixel ion bars fed by a rolling buffer of measured levels.
- **Motion**: a 34% light band scans the pill every 5.5 s; a 2 px ion progress line appears while
  recording.
- It never takes focus (`focusable: false`, `showInactive`), so holding ⌥ never steals keystrokes.

## Anti-patterns deliberately avoided

- No pure black; the background has blue-green depth so the glass has something to sit on.
- No second accent hue, no gradient text, no emoji, no exclamation marks.
- No neon glow on body text; glow belongs to the reactor, the caret, the send button and live dots.
- No glass on every control: inputs and the settings sheet are solid enough to read.
- No animation that delays work. Entrances are under 400 ms; status is always visible in text.
