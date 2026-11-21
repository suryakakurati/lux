/**
 * Headless end-to-end check of the agent loop against the real local model.
 *
 *   npm run smoke -- "what's my battery at?"
 *
 * It runs the same prompt, tool registry and Ollama client the app uses, so a
 * pass here means tool calling and macOS actions actually work.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { Memory } from './agent/memory'
import { runAgent } from './agent/agent'
import { CommitmentLedger } from './commitments'
import { getSettings } from './config'
import { initLog } from './log'
import { batteryInfo, frontmostApp, outputVolume, runningApps } from './mac/stats'
import type { ToolContext } from './tools/types'

app.setName('Lux')
app.dock?.hide()

async function main(): Promise<void> {
  await app.whenReady()
  initLog()
  if (process.env.LUX_DUMP_TOOLS) {
    const { toolDefinitions } = await import('./tools')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.LUX_DUMP_TOOLS, JSON.stringify(toolDefinitions(), null, 2))
    console.log('[smoke] wrote tool definitions to', process.env.LUX_DUMP_TOOLS)
    app.exit(0)
    return
  }
  const settings = getSettings()
  const commitments = new CommitmentLedger(
    join(app.getPath('temp'), `lux-smoke-commitments-${process.pid}.json`)
  )

  // LUX_SMOKE_TOOL=music_taste runs one tool directly and prints its result.
  // Verifying a tool should not require a model round trip.
  if (process.env.LUX_SMOKE_TOOL) {
    const { executeTool } = await import('./tools')
    const args = process.env.LUX_SMOKE_ARGS ? JSON.parse(process.env.LUX_SMOKE_ARGS) : {}
    const outcome = await executeTool(process.env.LUX_SMOKE_TOOL, args, {
      settings,
      commitments,
      confirm: async () => true,
      notify: () => undefined,
      speak: () => undefined,
      remember: () => undefined
    })
    console.log(`[smoke] tool ${process.env.LUX_SMOKE_TOOL} ${outcome.ok ? 'ok' : 'FAILED'} ${outcome.durationMs}ms — ${outcome.summary}`)
    console.log(outcome.data)
    // Background work — the play queue polling Spotify — needs the process alive
    // long enough to be observed. Without this a queue looks started but never runs.
    const hold = Number(process.env.LUX_SMOKE_HOLD_MS ?? 0)
    if (Number.isFinite(hold) && hold > 0) {
      console.log(`[smoke] holding ${hold}ms`)
      await new Promise((resolve) => setTimeout(resolve, hold))
    }
    app.exit(outcome.ok ? 0 : 1)
    return
  }

  const prompt = process.argv.slice(2).join(' ').trim() || 'How is this machine doing?'
  const memory = new Memory(join(app.getPath('userData'), 'smoke-memory.json'), () => ({
    url: settings.ollamaUrl,
    model: settings.embeddingModel,
    mode: settings.memoryMode
  }))

  const toolContext: ToolContext = {
    settings,
    commitments,
    confirm: async () => true,
    notify: () => undefined,
    speak: () => undefined,
    remember: () => undefined
  }

  const [apps, battery, volume, front] = await Promise.all([
    runningApps(),
    batteryInfo(),
    outputVolume(),
    frontmostApp()
  ])

  const started = Date.now()
  console.log(`[smoke] prompt: ${prompt}`)
  console.log(`[smoke] model: ${settings.model}`)
  const controller = new AbortController()
  const abortAfter = Number(process.env.LUX_SMOKE_ABORT_MS ?? 0)
  if (Number.isFinite(abortAfter) && abortAfter > 0) {
    setTimeout(() => controller.abort(), abortAfter)
  }

  // LUX_SMOKE_SEED_REFUSAL=1 recreates the poisoned-context case: an earlier
  // turn where Lux claimed it could not see a site.
  const history =
    process.env.LUX_SMOKE_SEED_REFUSAL === '1'
      ? [
          { role: 'user' as const, content: 'Do I have any assignments due today?' },
          {
            role: 'assistant' as const,
            content:
              "I still can't see inside the course portal to check your specific assignments. You need to log in and look at the Assignments tab yourself."
          }
        ]
      : []

  let outcome
  try {
    outcome = await runAgent({
    userText: prompt,
    history,
    settings,
    memory,
    machine: { runningApps: apps, battery, volume: volume ?? 50, frontmostApp: front },
    toolContext,
    signal: controller.signal,
    emit: (event) => {
      if (event.type === 'token') process.stdout.write(event.delta)
      if (event.type === 'tool-start') console.log(`\n[smoke] tool → ${event.run.name} ${JSON.stringify(event.run.args)}`)
      if (event.type === 'tool-end') {
        console.log(`[smoke] tool ← ${event.run.status} (${event.run.ms}ms) ${event.run.summary ?? ''}`)
      }
      }
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      console.log(`\n[smoke] aborted after ${Date.now() - started}ms`)
      app.exit(0)
      return
    }
    throw error
  }

  console.log('\n')
  console.log(`[smoke] tools used: ${outcome.toolRuns.map((run) => `${run.name}:${run.status}`).join(', ') || 'none'}`)
  console.log(`[smoke] ${Date.now() - started}ms total`)
  app.exit(outcome.toolRuns.every((run) => run.status !== 'error') ? 0 : 1)
}

void main().catch((error) => {
  console.error('[smoke] failed', error)
  app.exit(1)
})
