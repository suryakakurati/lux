# Tool catalog

55 tools. Everything runs locally except the pages that are inherently remote (news, `web_read`,
`web_search`, `research`, the agent browser and Spotify lookups). `risk: confirm` means the turn
pauses for explicit approval.

| Tool | Risk | Arguments | What it does |
| --- | --- | --- | --- |
| `open_app` | safe | `name` | `open -a`, with fuzzy fallback against `/Applications` |
| `quit_app` | safe | `name` | AppleScript `quit` |
| `list_apps` | safe | — | installed `.app` names |
| `focus_preset` | safe | `preset` | opens preset apps + URLs, sets volume (study/coding/focus/reset) |
| `system_status` | safe | — | CPU load, memory, disk, battery, volume; opens chat |
| `set_volume` | safe | `level` 0–100 | system output volume |
| `get_volume` | safe | — | volume + mute settings |
| `toggle_appearance` | safe | `mode` | light / dark / toggle via System Events |
| `lock_screen` | safe | — | `CGSession -suspend`, keystroke fallback |
| `sleep_display` | safe | — | `pmset displaysleepnow` |
| `battery_status` | safe | — | percentage + power source |
| `music_taste` | safe | `tracks?`, `playlists?` | Reads Spotify's local play history, resolves names from public pages, reports what is in rotation |
| `now_playing` | safe | — | track, artist, album, player state |
| `spotify_search` | safe | `query`, `limit?` | Looks up tracks by name and returns their `spotify:track:` URIs, artists, albums and lengths |
| `play_music` | safe | `tracks?`, `uri?`, `query?`, `resume?` | Plays one or more tracks by name or URI; the first starts now and the rest queue in order |
| `spotify_control` | safe | `action` | play / pause / next / previous |
| `apple_music_control` | safe | `action` | Music.app play / pause / next |
| `open_url` | safe | `url` | default browser, adds `https://` |
| `search_web` | safe | `query`, `engine` | google, duckduckgo, youtube, github, wikipedia, maps |
| `news_digest` | safe | `topic?`, `limit` | Google News RSS headlines; opens chat |
| `find_files` | safe | `query`, `limit` | Spotlight `mdfind`, filters system paths |
| `open_path` | safe | `path` | `open` a file or folder |
| `quick_look` | safe | `path` | `qlmanage -p` |
| `write_note` | safe | `title?`, `body`, `append` | markdown into the notes folder / daily note |
| `search_notes` | safe | `query`, `limit` | notes folder + optional Obsidian vault; opens chat |
| `remember` | safe | `fact` | durable fact for future turns |
| `commitments` | safe | `action`, `text?`, `due?`, `target?`, `minutes?` | list, add, complete, snooze or read the deterministic morning brief |
| `clipboard_read` | safe | — | current clipboard text |
| `clipboard_write` | safe | `text` | copy text |
| `set_timer` | safe | `minutes`, `label` | countdown that notifies and speaks |
| `list_timers` | safe | — | active timers |
| `take_screenshot` | safe | `mode` | `~/Pictures/Lux`, full or selection |
| `run_shell` | **confirm** | `command`, `reason` | zsh with blocklist, 20 s timeout |

## Browsing and local knowledge

| Tool | What it does | Risk |
| --- | --- | --- |
| `site_open` | Finds the URL the person actually uses for a named site in history, opens it and returns the page — one step instead of search-then-open | safe |
| `browser_open` | Loads a URL in Lux's own Chromium window (persistent login) and returns the page text and links | safe |
| `browser_read` | Re-reads the current page: text, links, whether it wants a sign-in | safe |
| `browser_inspect` | Structured DOM view: headings, buttons, forms and fields, tables, pagination, scroll position | safe |
| `browser_click` | Clicks a link or button by visible label (or CSS selector); every click asks for approval because a page listener can submit or navigate | safe* |
| `browser_back` / `browser_forward` | Move through the window's history | safe |
| `browser_scroll` | Scrolls up/down/top/bottom and returns the viewport | safe |
| `browser_fill` | Fills a text field, textarea or select by label; input/change handlers can submit, so it asks for approval | safe* |
| `browser_press` | Presses Enter, Tab, Escape, arrows, PageUp/Down, Home or End; Enter asks for approval because it can submit a form | safe* |
| `browser_submit` | Clicks a submit control; creates an external action, so it requires approval | **confirm** |
| `web_search` | Ranked direct web + news results with snippets; no browser window | safe |
| `research` | 2-angle search, concurrent page extraction, numbered dossier with source URLs | safe |
| `discover_tools` | Searches the full registry and returns schemas that were not shortlisted | safe |
| `consult_specialist` | One bounded call to the optional specialist model; releases it afterward | safe |
| `web_read` | Fetches a public page and returns readable text, no session | safe |
| `history_search` | Searches Firefox (also Chrome, Safari) history for visited pages, with visit counts | safe |
| `agni_links` | Reads the optional local knowledge database: events plus evidence-scored connections | safe |
| `agni_report` | Reads written investigations from the optional local knowledge database | safe |
| `vault_search` | Finds notes in the Obsidian vault by title or content | safe |
| `vault_read` | Reads one vault note in full | safe |
| `vault_write` | Creates or appends a note in the vault | safe |

Why Lux reads pages in its own window: Firefox exposes no scripting interface, so a tab there
cannot be read. Lux's window is ordinary Chromium on a persistent partition
(`Partitions/lux-web`), so the person signs in once and later requests can read and click through
the same site. Firefox remains where Lux opens links for the person, and Firefox history supplies
the exact URLs they use.

`history_search` and the local knowledge tools copy each database to a temp file before querying it;
Firefox, Chrome and the configured database hold locks and run in WAL mode, so Lux never opens a live
database it does not own.

## Music and taste

`music_taste` answers "what do I listen to" without an account, a token or a round trip to
Spotify's API. It reads three local sources:

- `~/Library/Application Support/Spotify/PersistentCache/Users/*/list_player_play_history` — the
  desktop app's play history, which is a binary list of `spotify:track:` and `spotify:playlist:` URIs.
  Frequency stands in for "in rotation".
- the public `open.spotify.com/embed/<kind>/<id>` page for each URI, which ships the track, artist and
  album inline. (The non-embed page used to carry Open Graph tags; it now serves an app shell with no
  tags at all.) Resolved names are cached for 30 days in `userData/cache/spotify-meta.json`.
- AppleScript for the current track and player state, and `play track <uri>` to start something
  specific for real.

Reading and playing are separate tools on purpose. A request to see the listening history must never
start playback as a side effect; `play_music` will not resume unless it is asked to.

### A name is not a track

`play track` accepts a URI and nothing else, and Spotify's AppleScript dictionary has no search
command. So a name has to become a URI, in this order:

1. **The resolve cache** — anything already played or looked up, offline and instant.
2. **The rest of the play history** — the history is a list of URIs, so the tracks they already
   listen to can be named from their embed pages a dozen at a time, capped at twelve per miss. This
   is what makes "play Sweater Weather" work for a song played a hundred times with no network call
   beyond the name lookup.
3. **Spotify's public search page** — the primary route. `open.spotify.com/search/<q>/tracks` is
   rendered in a hidden Chromium window (`music/web-search.ts`) and its track anchors are parsed
   into `spotify:track:` ids. No login, no token, no developer app, no Premium. This works on a free
   account, which is why it leads: Spotify's API now answers development-mode apps with `403 Active
   premium subscription required for the owner of the app` when the owner is not a subscriber.
4. **The optional Web API** — used only when the rendered page returns nothing and credentials are
   configured. It returns richer metadata; it is not required for playback. The token is cached in
   `userData/cache/spotify-token.json`, and a 401 clears it so the next call retries.
5. **An honest failure** — which names failed, why, and Spotify's search opened for the first one.
   Never a guess, never a claim that a URI must be supplied.

### Playing a list

AppleScript can start one track and has no queue. "Play all of them" is therefore kept in
`shared/music-queue.ts`, which decides and `music-queue.ts`, which polls:

| The player shows | The queue does |
| --- | --- |
| the expected track, playing | nothing |
| the expected track, stopped near its end | starts the next |
| the expected track, paused mid-track | nothing — they paused it |
| a later queued track | adopts that index (a skip forward) |
| an earlier queued track | follows the person, does not push forward |
| something else entirely, playing | takes the queue back (Spotify autoplayed a radio pick) |
| a different track, within 6 s of a play | nothing — the play has not landed yet |
| an advertisement (`spotify:ad:`) | waits it out; never skips a queued track for an ad |

Polling is 2.5 s and `unref`'d, so watching playback never keeps Electron alive. The watcher stops
itself when the list is exhausted.

`LUX_SPOTIFY_API_BASE` and `LUX_SPOTIFY_TOKEN_URL` point the client at a local mock
(`scripts/mock-spotify.js`) so the search path can be exercised without credentials.

## Execution contract

```ts
interface ToolDef {
  name: string
  description: string          // shown to the model
  risk: 'safe' | 'confirm'
  parallelSafe?: boolean       // independent, read-only; may run with at most two others
  params: ToolParams           // JSON Schema subset
  run(args, context): Promise<{ content, summary, openChat? }>
}
```

- `content` is the text the model reads next (facts, errors, output).
- `summary` is the one-line human label used by the HUD and the activity row.
- `openChat` forces the result into the chat window (used for inherently readable output).
- Errors are returned, not thrown: `executeTool` catches and converts them.

## Confirmation flow

```
model calls run_shell
  → validateArgs
  → context.confirm({tool, args, reason})
      → Session broadcasts {kind:'confirm'}
      → chat window shows the approval bar
      → resolves true/false (60 s timeout → false)
  → denied: returns "The person declined..." so the model changes course
```

## Shell safety

Blocked before execution (case-insensitive): `sudo`, `mkfs`, `dd if=`, writes to `/dev/disk*`,
fork bombs, `diskutil erase|partition`, shutdown/reboot/halt, `curl | sh`, `rm -rf /|~|$HOME`,
`killall`, disabling `launchctl` services, `csrutil`.

Approval is still required for everything else. Output is truncated to 4 000 characters before it
re-enters the context.

## Adding a tool

1. Add a `ToolDef` to the relevant module in `electron/main/tools/`.
2. Export it from that module's array — `tools/index.ts` picks it up automatically.
3. Keep `description` short and action-oriented; local models follow imperative descriptions best.
4. If it needs permission to run, set `risk: 'confirm'`.
5. Add a case to `tests/` if it has parsing or policy logic.
