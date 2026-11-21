/**
 * Idle RSS measurement for the real Electron app.
 *
 *   npm run bench:rss
 *
 * Starts the built app with an isolated data directory, waits for it to settle,
 * sums RSS across its own process tree, then stops that tree. It never touches
 * an already-running Lux and never kills by process name.
 *
 * The result is written to docs/benchmarks/idle-rss.json, with the commit it
 * was measured against. `npm run bench` reads it into its own report, so the
 * sample time is never confused with the turn timings.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = join(root, 'node_modules', '.bin', 'electron')
if (!existsSync(electron)) {
  console.error('[rss] electron is not installed. Run npm install first.')
  process.exit(1)
}
if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('[rss] out/main/index.js is missing. Run npm run build first.')
  process.exit(1)
}

const running = execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' })
if (/Lux\.app\/Contents\/MacOS\/Lux/.test(running) || /out\/main\/index\.js/.test(running)) {
  console.error('[rss] Lux is already running. Quit it before measuring idle RSS.')
  process.exit(1)
}

const temp = mkdtempSync(join(tmpdir(), 'lux-idle-'))
const data = join(temp, 'data')
mkdirSync(data, { recursive: true })
writeFileSync(
  join(data, 'settings.json'),
  JSON.stringify(
    {
      onboarded: true,
      speechEnabled: false,
      proactiveEnabled: false,
      keepModelLoaded: true,
      memoryMode: 'lexical',
      vaultPath: ''
    },
    null,
    2
  )
)

const child = spawn(electron, [join(root, 'out', 'main', 'index.js')], {
  cwd: root,
  env: { ...process.env, LUX_DATA_DIR: data, LUX_DEBUG: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += String(chunk)
})

const waitMs = Number(process.env.LUX_RSS_WAIT_MS ?? 60_000)
console.log(`[rss] launched pid=${child.pid}; settling for ${waitMs}ms`)
await new Promise((resolveWait) => setTimeout(resolveWait, waitMs))

if (child.exitCode !== null) {
  console.error(`[rss] app exited early (${child.exitCode})`)
  if (stderr.trim()) console.error(stderr.trim().slice(0, 2000))
  process.exit(1)
}

const rows = execFileSync('ps', ['-axo', 'pid,ppid,rss'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => line.trim().split(/\s+/))
  .map(([pid, ppid, rss]) => ({ pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss) }))
  .filter((row) => Number.isFinite(row.pid) && Number.isFinite(row.ppid) && Number.isFinite(row.rssKb))

const byParent = new Map()
for (const row of rows) {
  const list = byParent.get(row.ppid) ?? []
  list.push(row)
  byParent.set(row.ppid, list)
}

const tree = []
const collect = (pid) => {
  for (const childRow of byParent.get(pid) ?? []) {
    collect(childRow.pid)
    tree.push(childRow)
  }
}
collect(child.pid)
const rootRow = rows.find((row) => row.pid === child.pid)
if (!rootRow) {
  console.error('[rss] could not find the app process in ps output')
  stopTree(child.pid, tree)
  process.exit(1)
}
tree.push(rootRow)
const totalKb = tree.reduce((sum, row) => sum + row.rssKb, 0)
const idleRssMb = Math.round(totalKb / 1024)

const docs = join(root, 'docs', 'benchmarks')
mkdirSync(docs, { recursive: true })
const commit = git(['rev-parse', '--short', 'HEAD'])
const dirty = (git(['status', '--porcelain']) ?? '').length > 0
const record = {
  at: new Date().toISOString(),
  idleRssMb,
  processes: tree.length,
  waitMs,
  commit,
  dirty,
  note: 'Sum of RSS across the app and all of its child processes after the settle window. Ollama is a separate process and is not counted.'
}
writeFileSync(join(docs, 'idle-rss.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
console.log(`[rss] idle RSS ${idleRssMb} MB across ${tree.length} processes`)

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

stopTree(child.pid, tree)
await new Promise((resolveWait) => setTimeout(resolveWait, 1_000))
process.exit(0)

function stopTree(rootPid, descendants) {
  // `descendants` is already deepest-first; stop children before the root.
  for (const row of descendants) {
    if (row.pid === process.pid) continue
    try {
      process.kill(row.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  try {
    process.kill(rootPid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}
