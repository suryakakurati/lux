# Design

Lux is a desktop utility, not a dashboard. The interface should feel like a well-made macOS app:
quiet surfaces, system typography, one accent, and a reading column that belongs to the answer. The
previous "Sentinel" console — near-black panels, ion-cyan glow, reactor rings, scan lines, mono
telemetry — was replaced in 0.1.0 because it read as decoration around the work.

## Principles

1. **The text is the interface.** Reply text has the highest contrast; chrome is secondary.
2. **One accent.** The crimson step marks primary actions, links and focus. Status colours
   (`success`, `warning`, `danger`) are only used to report a state.
3. **System type.** SF Pro through `-apple-system`. Mono is reserved for code, tool arguments,
   timings and model identifiers.
4. **Flat, not glowing.** Depth comes from a 1 px hairline and a small shadow. No gradients, glows,
   neon, scan lines or animated backgrounds.
5. **Motion explains, never entertains.** Transitions are 120–160 ms and only for state changes.
6. **Every state is designed.** Empty, checking, offline, missing model, missing permission, error,
   streaming and approval all have explicit UI.

## Tokens

Defined once in `src/styles/tokens.css`. Both themes follow the system appearance. The palette is
the project's six-step wine and rose ramp — `#501423`, `#751C2F`, `#B72F4A`, `#EA5C6F`, `#EF96A3`,
`#F4B4C1` — from `colorscheme.png`. The two darkest steps tint the surfaces, the crimson step is the
accent, and the blush steps carry soft fills. The app icon already used the same wine, crimson and
blush values.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#fbf4f6` | `#3a0e19` | window base |
| `--surface` | `#ffffff` | `#501423` | reading surface, controls |
| `--field` | `#ffffff` | `#5f1829` | inputs and composer |
| `--surface-2` | `#f7e9ed` | `#5f1829` | user bubble, tool trace, hovers |
| `--surface-3` | `#efdae0` | `#751c2f` | pressed / disabled fills |
| `--sidebar` | `#f6e9ec` | `#430f1d` | conversation sidebar |
| `--sidebar-active` | `#ebd3da` | `#6a1a2c` | selected conversation |
| `--line` | `rgba(80,20,35,.10)` | `rgba(244,180,193,.13)` | hairlines |
| `--line-strong` | `rgba(80,20,35,.19)` | `rgba(244,180,193,.24)` | input borders |
| `--ink` | `#2a0810` | `#fdf1f4` | primary text |
| `--ink-2` | `#57222f` | `#f0cdd5` | secondary text |
| `--ink-3` | `#7b4351` | `#d9a9b5` | supporting text |
| `--ink-4` | `#96606d` | `#c08d9a` | timestamps, hints |
| `--accent` | `#b72f4a` | `#f06d80` | primary action, links, focus |
| `--success` | `#1a7f37` | `#6fcf97` | engine ready, tool succeeded |
| `--warning` | `#8a5a00` | `#f2c078` | engine starting, model missing |
| `--danger` | `#b3261e` | `#ff8a8a` | offline, failed or denied tool |

Spacing is a 4 px grid: `4, 8, 12, 16, 20, 24, 32, 40`. Radii: `4` (chips), `6` (buttons), `8`
(cards, composer controls), `12` (composer, settings), `16` (sheets, onboarding).

### Type scale

| Role | Size | Weight |
| --- | --- | --- |
| Page heading (empty state) | 22 px | 600 |
| Settings title | 15 px | 600 |
| Conversation / assistant body | 13.5 px | 400 |
| UI labels, buttons, sidebar rows | 12–13 px | 400–500 |
| Timestamps, hints, notes | 11 px | 400 |
| Code, tool args, timings | 11–12 px mono | 400 |

Line height is 1.65 for replies and 1.5 for controls. Numbers use tabular figures in the sidebar
stats and tool timings.

## Layout

- **Sidebar** 244 px (210 px below 980 px): wordmark, new chat, conversation list, then engine state,
  system stats, microphone/privacy line and Settings. Hidden with the sidebar button; the toolbar
  gains a show-sidebar button.
- **Toolbar** 52 px: conversation title, engine chip, model chip, sidebar toggle, settings. It is the
  window drag region, with the native traffic lights above the sidebar at `(18, 20)`.
- **Thread** up to 700 px wide. Assistant replies are plain text with a 24 px monogram and a small
  meta line. User messages are right-aligned bubbles at most 78% wide.
- **Tool trace** is indented to the reply text. A quiet header (`Tools · 2 steps · 1.6s`) sits above
  one 11 px line per call: status dot, tool name, the recognisable argument, duration. Clicking a line
  reveals full arguments and the result summary.
- **Composer** 700 px: auto-growing textarea, a hint line and a single primary send button. Enter
  sends, Shift+Enter adds a line, Escape cancels a running turn.
- **Settings** is a 440 px panel over a dim scrim, organised into sections: engine, model, voice,
  morning brief, permissions, knowledge and memory, Spotify, about. Escape or the close button
  dismisses it.

## States

| State | Treatment |
| --- | --- |
| Empty | “How can I help?”, one sentence, four real suggestions, engine line. A missing microphone adds an inline notice with **Open settings**. |
| Checking engine | Engine line reads “Connecting to the local engine…” and a settings shortcut is offered. |
| Engine starting / waking | A quiet banner above the composer with the reason and a **Start engine** action. |
| Offline | The same banner in `danger`; the sidebar engine row and toolbar chip turn red. |
| Model missing | Warning banner; the action re-checks instead of pulling a model. |
| Missing permission | An inline notice in the empty state and a row in Settings → Permissions. |
| Streaming | A 2 px accent caret; the meta line says “Writing…”. Replies are announced with `aria-live="polite"`. |
| Working | Three small dots, “Working” and elapsed seconds. |
| Error | A bordered notice in the thread with the actual message. |
| Approval | A `role="alertdialog"` card showing the exact command or arguments, Deny and Approve. |

## HUD

A 400×132 transparent window containing a compact pill: status dot, label, elapsed time, two lines
of transcript or detail, and (only while listening) a 16-bar level indicator. The HUD keeps a fixed
dark surface so it stays legible over any wallpaper. It never takes focus.

## Motion

| Element | Duration | Easing |
| --- | --- | --- |
| Hover, focus, state | 120–160 ms | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| Message entrance | 160 ms, 2 px rise | same |
| Settings panel | 160 ms, 12 px slide | same |
| Working dots | 1.2 s loop | same |
| Caret | 1.1 s step blink | — |

`prefers-reduced-motion` collapses every animation and transition to 0.001 ms. Nothing animates on a
timer for decoration.

## Accessibility

- Every interactive control has an accessible name; icon-only buttons use `aria-label`.
- `:focus-visible` draws a 2 px accent ring with a 2 px offset. Mouse clicks do not show it.
- The settings panel is a labelled `role="dialog" aria-modal="true"`; Escape closes it.
- Approval is an `alertdialog`. Streaming replies and the working indicator use polite live regions.
- Contrast targets WCAG AA: primary text is at least 12:1 on its surface in both themes; secondary
  text is at least 4.5:1. Status colours are paired with a label or dot shape, never colour alone.
- Tool rows are buttons with `aria-expanded`; the detail is plain text and selectable.
- The whole window is keyboard reachable: sidebar, thread, composer, settings.

## Screenshots

Captured from the real app with the debug hooks described in the README:

| File | State |
| --- | --- |
| `docs/screenshots/chat.png` | populated thread with tool trace (dark) |
| `docs/screenshots/chat-light.png` | the same thread in the light theme |
| `docs/screenshots/chat-empty.png` | empty state, microphone not granted |
| `docs/screenshots/settings.png` | settings panel |
| `docs/screenshots/hud.png` | morning brief in the HUD |

## Deliberate trade-offs

- **No native vibrancy.** Solid wine-tinted surfaces keep text contrast predictable over any desktop
  and make the light and dark themes behave the same. Translucency is limited to the floating HUD,
  where it serves hierarchy.
- **System theme only.** There is no in-app appearance switch; the app follows macOS. A manual switch
  would be a second setting with no product need.
- **No instrument telemetry.** CPU, memory and battery are one quiet line in the sidebar, not gauges.
  They answer a question; they are not the product.
- **No decorative animation.** The only looping motion is a working indicator and a text caret.
