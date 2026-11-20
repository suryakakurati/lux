import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app } from 'electron'
import { join } from 'node:path'
import { CommitmentLedger } from './commitments'
import { getSettings } from './config'
import { executeTool } from './tools'
import type { ToolContext } from './tools/types'

/**
 * Packaged-browser smoke test.
 *
 * This is deliberately a debug entry point (`Lux --form-test`), not part of the
 * assistant's normal surface. It exercises the real Chromium window and the
 * real tool permission path against a local form:
 *
 *   1. a submit-looking click with approval denied must not submit;
 *   2. an approved browser_submit must actually submit and change the URL.
 */
export async function runFormTest(): Promise<boolean> {
  let submitted = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams.get('q')
    if (q) {
      submitted = q
      response.setHeader('content-type', 'text/html')
      response.end(`<html><body><h1>Form submitted</h1><p>q=${escapeHtml(q)}</p></body></html>`)
      return
    }
    response.setHeader('content-type', 'text/html')
    response.end(
      '<html><body><form method="get"><label for="q">Search</label><input id="q" name="q"><button type="submit">Go</button></form></body></html>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

  const baseContext: ToolContext = {
    settings: getSettings(),
    commitments: new CommitmentLedger(join(app.getPath('temp'), `lux-form-test-${process.pid}.json`)),
    confirm: async () => false,
    notify: () => undefined,
    speak: () => undefined,
    remember: () => undefined
  }

  try {
    const opened = await executeTool('browser_open', { url }, baseContext)
    console.log(`[form-test] open ${opened.ok ? 'ok' : 'FAILED'} — ${opened.summary}`)

    const filled = await executeTool('browser_fill', { field: 'Search', value: 'local ai agents' }, {
      ...baseContext,
      confirm: async () => true
    })
    console.log(`[form-test] fill ${filled.ok ? 'ok' : 'FAILED'} — ${filled.summary}`)

    let confirmations = 0
    const denied = await executeTool('browser_click', { text: 'Go' }, {
      ...baseContext,
      confirm: async () => {
        confirmations += 1
        return false
      }
    })
    const bypassBlocked = denied.ok && /declined/i.test(denied.content) && submitted === ''
    console.log(
      `[form-test] denied submit click ${bypassBlocked ? 'blocked' : 'BYPASSED'} — confirmations=${confirmations}`
    )

    const approved = await executeTool('browser_submit', { text: 'Go' }, {
      ...baseContext,
      confirm: async () => true
    })
    const submittedOk = approved.ok && submitted === 'local ai agents'
    console.log(`[form-test] approved submit ${submittedOk ? 'ok' : 'FAILED'} — q=${JSON.stringify(submitted)}`)

    return bypassBlocked && filled.ok && submittedOk
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
