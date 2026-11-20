/**
 * Capability audit: run every non-destructive tool against the real machine.
 *
 *   npm run audit
 *   LUX_AUDIT_AUDIO=1 npm run audit     # also plays a track and verifies Spotify
 *   LUX_AUDIT_GROUP=music npm run audit # one group only
 *
 * This is deliberately separate from the unit tests: it proves the macOS
 * integrations (Spotify, browser, history, vault, local knowledge, notifications) still
 * work, which a pure test cannot. It writes a JSON report next to the log.
 */
import { app } from 'electron'
import { unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { CommitmentLedger } from './commitments'
import { getSettings } from './config'
import { initLog, logLine } from './log'
import { executeTool } from './tools'
import type { ToolContext } from './tools/types'

app.setName('Lux')
app.dock?.hide()

interface AuditCase {
  group: string
  tool: string
  args?: Record<string, unknown>
  /** Failure is reported but does not fail the audit (e.g. optional local knowledge not configured). */
  optional?: boolean
  /** Expected outcome; the confirmation gate is tested by expecting a denial. */
  expect?: 'ok' | 'denied'
  note?: string
}

const CASES: AuditCase[] = [
  { group: 'apps', tool: 'list_apps' },
  { group: 'system', tool: 'system_status' },
  { group: 'system', tool: 'battery_status' },
  { group: 'system', tool: 'get_volume' },
  { group: 'clipboard', tool: 'clipboard_read' },
  { group: 'timers', tool: 'list_timers' },
  {
    group: 'commitments',
    tool: 'commitments',
    args: { action: 'add', text: 'Audit open loop', due: 'tomorrow' }
  },
  { group: 'commitments', tool: 'commitments', args: { action: 'list' } },
  {
    group: 'commitments',
    tool: 'commitments',
    args: { action: 'complete', target: 'Audit open loop' }
  },
  { group: 'files', tool: 'find_files', args: { query: 'Screenshot', limit: 3 } },
  { group: 'notes', tool: 'search_notes', args: { query: 'lux', limit: 3 } },
  {
    group: 'notes',
    tool: 'write_note',
    args: { title: 'Lux audit', body: 'Automated capability check.', append: false },
    note: 'temporary note, removed after the audit'
  },
  { group: 'vault', tool: 'vault_search', args: { query: 'the', limit: 3 }, optional: true },
  { group: 'web', tool: 'news_digest', args: { topic: 'technology', limit: 3 } },
  { group: 'research', tool: 'web_search', args: { query: 'local AI agents', limit: 3 }, optional: true },
  { group: 'research', tool: 'research', args: { query: 'local AI agent runtimes', maxSources: 2 }, optional: true },
  { group: 'web', tool: 'web_read', args: { url: 'https://example.com' } },
  { group: 'browser', tool: 'browser_open', args: { url: 'https://example.com' } },
  { group: 'browser', tool: 'browser_read' },
  { group: 'browser', tool: 'browser_back' },
  { group: 'browser', tool: 'browser_forward' },
  { group: 'browser', tool: 'browser_inspect' },
  { group: 'browser', tool: 'browser_scroll', args: { direction: 'down', amount: 200 } },
  {
    group: 'browser',
    tool: 'browser_open',
    args: {
      url: 'LOCAL_FORM'
    }
  },
  { group: 'browser', tool: 'browser_fill', args: { field: 'Search', value: 'local ai agents' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_inspect' },
  { group: 'browser', tool: 'browser_click', args: { text: 'Go' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_click', args: { text: 'Send JS' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_click', args: { text: 'JS link' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_click', args: { text: 'Outside JS' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_click', args: { text: 'Listener link' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_press', args: { key: 'Enter' }, expect: 'denied' },
  { group: 'browser', tool: 'browser_submit', args: { text: 'Go' }, expect: 'denied' },
  { group: 'history', tool: 'history_search', args: { query: 'github', limit: 5 } },
  { group: 'site', tool: 'site_open', args: { site: 'github' }, optional: true },
  { group: 'agni', tool: 'agni_links', args: { limit: 3 }, optional: true },
  { group: 'agni', tool: 'agni_report', args: { limit: 1 }, optional: true },
  { group: 'music', tool: 'now_playing' },
  { group: 'music', tool: 'music_taste', args: { tracks: 5, playlists: 2 } },
  { group: 'music', tool: 'spotify_search', args: { query: 'Heat Waves Glass Animals', limit: 3 } },
  {
    group: 'guard',
    tool: 'run_shell',
    args: { command: 'echo lux-audit', reason: 'verify the approval gate' },
    expect: 'denied'
  },
  { group: 'registry', tool: 'discover_tools', args: { query: 'read a table on a page', limit: 4 } }
]

interface AuditResult {
  group: string
  tool: string
  status: 'pass' | 'fail' | 'skip'
  ms: number
  summary: string
  detail?: string
}

async function main(): Promise<void> {
  await app.whenReady()
  initLog()
  const settings = getSettings()
  const only = (process.env.LUX_AUDIT_GROUP ?? '').trim().toLowerCase()
  // A temporary ledger: the audit must never add fake loops to the real one.
  const auditLedgerPath = join(app.getPath('temp'), `lux-audit-commitments-${process.pid}.json`)

  // A local form gives the fill/inspect path a real DOM without making the
  // audit depend on a public site's markup.
  const formServer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(
      '<form><label for="q">Search</label><input id="q" name="q" onchange="this.form.submit()">' +
        '<button type="submit">Go</button>' +
        '<button type="button" onclick="this.form.submit()">Send JS</button>' +
        '</form>' +
        '<a href="javascript:document.querySelector(\'form\').submit()">JS link</a>' +
        '<button type="button" onclick="document.querySelector(\'form\').submit()">Outside JS</button>' +
        '<a id="listener" href="/ok">Listener link</a>' +
        '<script>document.getElementById("listener").addEventListener("click", (event) => {' +
        ' event.preventDefault(); document.querySelector("form").submit(); });</script>'
    )
  })
  await new Promise<void>((resolve) => formServer.listen(0, '127.0.0.1', resolve))
  const formUrl = `http://127.0.0.1:${(formServer.address() as AddressInfo).port}/`

  const context: ToolContext = {
    settings,
    commitments: new CommitmentLedger(auditLedgerPath),
    // The gate is exercised by expecting a denial rather than actually running
    // shell commands during an audit.
    confirm: async () => false,
    notify: () => undefined,
    speak: () => undefined,
    remember: () => undefined
  }

  const results: AuditResult[] = []
  const cases = CASES.filter((item) => !only || item.group === only)
  for (const item of cases) {
    if (item.args?.url === 'LOCAL_FORM') item.args.url = formUrl
  }
  console.log(`[audit] ${cases.length} checks, model ${settings.model}`)

  // Every tool, not just the exercised ones: a duplicate name, an empty
  // description or a malformed schema breaks the function-calling contract for
  // the whole registry, so it is checked once here.
  const { TOOLS } = await import('./tools')
  const names = new Set<string>()
  const problems: string[] = []
  for (const tool of TOOLS) {
    if (names.has(tool.name)) problems.push(`duplicate ${tool.name}`)
    names.add(tool.name)
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(tool.name)) problems.push(`bad name ${tool.name}`)
    if (tool.description.trim().length < 20) problems.push(`short description ${tool.name}`)
    if ((tool.params as { type?: string }).type !== 'object') problems.push(`bad schema ${tool.name}`)
    if (typeof tool.run !== 'function') problems.push(`no run ${tool.name}`)
  }
  results.push({
    group: 'registry',
    tool: 'all tools',
    status: problems.length === 0 ? 'pass' : 'fail',
    ms: 0,
    summary: `${TOOLS.length} tools wired`,
    detail: problems.join('; ') || undefined
  })
  console.log(
    `${problems.length === 0 ? 'PASS' : 'FAIL'} registry  all tools            ${String(TOOLS.length).padStart(3)} tools  ${problems.join('; ') || 'schemas valid'}`
  )

  for (const item of cases) {
    const started = Date.now()
    const outcome = await executeTool(item.tool, item.args ?? {}, context)
    const ms = Date.now() - started
    const expected = item.expect ?? 'ok'
    const denied = outcome.denied === true || /declined/i.test(outcome.content)
    const good = expected === 'denied' ? denied : outcome.ok
    const skipped =
      !good &&
      item.optional === true &&
      /not installed|no obsidian|no vault|not found|unreadable|no notes|no site|sign-in|no search results|no readable|network|timed out|no specialist|memory is/i.test(
        outcome.content
      )

    const status: AuditResult['status'] = good ? 'pass' : skipped ? 'skip' : 'fail'
    results.push({
      group: item.group,
      tool: item.tool,
      status,
      ms,
      summary: outcome.summary,
      detail: status === 'pass' ? undefined : outcome.content.slice(0, 400)
    })
    const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL'
    console.log(`${mark.padEnd(4)} ${item.group.padEnd(9)} ${item.tool.padEnd(20)} ${String(ms).padStart(5)}ms  ${outcome.summary}`)
    if (status === 'fail') console.log(`     ${outcome.content.replace(/\s+/g, ' ').slice(0, 220)}`)
  }

  // Clean up the note the write test created, so auditing is repeatable.
  try {
    unlinkSync(join(settings.notesDir, 'Lux audit.md'))
  } catch {
    /* it may not exist if the write failed; that is already reported */
  }
  try {
    unlinkSync(auditLedgerPath)
  } catch {
    /* the temporary ledger may never have been written */
  }

  if (process.env.LUX_AUDIT_AUDIO === '1') {
    console.log('\n[audit] audio check: play a track and verify Spotify reports it')
    const started = Date.now()
    const play = await executeTool(
      'play_music',
      { tracks: 'Heat Waves — Glass Animals' },
      context
    )
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const now = await executeTool('now_playing', {}, context)
    const audible = now.ok && !/no track loaded|not running|idle/i.test(now.content)
    results.push({
      group: 'music',
      tool: 'play_music (audio)',
      status: play.ok && audible ? 'pass' : 'fail',
      ms: Date.now() - started,
      summary: now.summary,
      detail: play.ok ? now.content.slice(0, 300) : play.content.slice(0, 300)
    })
    console.log(`${audible ? 'PASS' : 'FAIL'} music     play_music (audio)   ${Date.now() - started}ms  ${now.summary}`)
    await executeTool('spotify_control', { action: 'pause' }, context)
  }

  const passed = results.filter((result) => result.status === 'pass').length
  const failed = results.filter((result) => result.status === 'fail').length
  const skipped = results.filter((result) => result.status === 'skip').length
  console.log(`\n[audit] ${passed} passed, ${failed} failed, ${skipped} skipped`)

  const report = { at: new Date().toISOString(), model: settings.model, results }
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(app.getPath('userData'), 'logs', 'audit.json'), JSON.stringify(report, null, 2))
    console.log(`[audit] report: ${join(app.getPath('userData'), 'logs', 'audit.json')}`)
  } catch {
    /* the console output is the primary report */
  }
  logLine('audit', `${passed} passed, ${failed} failed, ${skipped} skipped`)
  formServer.close()
  app.exit(failed > 0 ? 1 : 0)
}

void main().catch((error) => {
  console.error('[audit] crashed', error)
  app.exit(1)
})
