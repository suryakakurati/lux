import { BrowserWindow } from 'electron'
import { logLine } from '../log'

let webWindow: BrowserWindow | null = null

const PARTITION = 'persist:lux-web'
const MAX_TEXT = 7_000
const MAX_LINKS = 24

export interface PageSnapshot {
  title: string
  url: string
  text: string
  links: { text: string; href: string }[]
  headings: string[]
  buttons: string[]
  forms: PageForm[]
  tables: string[][][]
  pagination: { text: string; href: string }[]
  scrollY: number
  scrollHeight: number
  viewportHeight: number
  signIn: boolean
  loading: boolean
}

export interface PageForm {
  action: string
  method: string
  fields: { label: string; name: string; type: string; required: boolean }[]
}

/**
 * Runs inside the page. Kept as a string because the main process has no DOM
 * types; it returns the readable body plus the links a person would consider
 * clicking, which is what the model needs to decide where to go next.
 */
function snapshotScript(includeStructure: boolean): string {
  return `(() => {
  const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  const root = document.querySelector('main, [role="main"], #content, #main, article') || document.body
  const clone = root.cloneNode(true)
  clone.querySelectorAll('script,style,noscript,svg,iframe,form[aria-hidden="true"]').forEach((node) => node.remove())
  const text = clean(clone.innerText || clone.textContent || '')
  const visible = (element) => {
    if (!element || element.disabled) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const label = (element) => clean(element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.title)
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .filter(visible)
    .map((element) => clean(element.innerText))
    .filter(Boolean)
    .slice(0, 18)
  const buttons = [...document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],summary')]
    .filter(visible)
    .map((element) => label(element))
    .filter(Boolean)
    .slice(0, 24)
  const links = []
  const seen = new Set()
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.href
    if (!href || seen.has(href) || !/^https?:/i.test(href)) continue
    const label = clean(anchor.innerText || anchor.getAttribute('aria-label') || anchor.title)
    if (!label) continue
    seen.add(href)
    links.push({ text: label.slice(0, 90), href })
    if (links.length >= 40) break
  }
  const forms = ${includeStructure ? `[...document.querySelectorAll('form')].slice(0, 6).map((form) => ({
    action: form.action || '',
    method: (form.method || 'get').toUpperCase(),
    fields: [...form.querySelectorAll('input,select,textarea')].slice(0, 12).map((field) => ({
      label: clean(field.labels && field.labels[0] ? field.labels[0].innerText : (field.getAttribute('aria-label') || field.getAttribute('placeholder') || field.name || '')),
      name: field.name || '',
      type: field.tagName.toLowerCase() === 'select' ? 'select' : (field.type || field.tagName.toLowerCase()),
      required: Boolean(field.required)
    })).filter((field) => field.label || field.name)
  }))` : `[]`}
  const tables = ${includeStructure ? `[...document.querySelectorAll('table')]
    .filter((table) => table.rows.length > 1)
    .slice(0, 5)
    .map((table) => [...table.rows].slice(0, 30).map((row) => [...row.cells].slice(0, 8).map((cell) => clean(cell.innerText))))
    .filter((rows) => rows.some((row) => row.length > 1))` : `[]`}
  const pagination = [...document.querySelectorAll('a[href]')]
    .filter(visible)
    .filter((anchor) => /next|previous|prev|older|newer|more|page/i.test(clean(anchor.innerText)) || /[?&](page|p|offset)=\\d/i.test(anchor.href))
    .slice(0, 10)
    .map((anchor) => ({ text: clean(anchor.innerText).slice(0, 60), href: anchor.href }))
  return {
    title: document.title || '',
    url: location.href,
    text,
    links,
    headings,
    buttons,
    forms,
    tables,
    pagination,
    scrollY: Math.round(window.scrollY || 0),
    scrollHeight: Math.round(document.documentElement.scrollHeight || document.body.scrollHeight || 0),
    viewportHeight: Math.round(window.innerHeight || 0),
    signIn: Boolean(document.querySelector('input[type="password"]')),
    loading: document.readyState !== 'complete'
  }
})()`
}

function whenLoaded(win: BrowserWindow, timeoutMs = 25_000): Promise<void> {
  const contents = win.webContents
  if (!contents.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      contents.off('did-finish-load', finish)
      contents.off('did-fail-load', finish)
      resolve()
    }
    // A load can finish between the isLoading check and the listener being
    // attached; polling keeps that race from costing the full timeout.
    const poll = setInterval(() => {
      if (!contents.isLoading()) finish()
    }, 150)
    const timer = setTimeout(finish, timeoutMs)
    contents.once('did-finish-load', finish)
    contents.once('did-fail-load', finish)
  })
}

/**
 * Lux's own browser.
 *
 * Firefox exposes no scripting interface, so a page opened there cannot be read.
 * This window is ordinary Chromium on a persistent partition: the person signs
 * in once and every later request can read the page, click through it and come
 * back without asking them to log in again.
 */
function ensureWebWindow(show: boolean): BrowserWindow {
  if (webWindow && !webWindow.isDestroyed()) {
    if (show) {
      webWindow.show()
      webWindow.focus()
    }
    return webWindow
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 560,
    minHeight: 420,
    show,
    title: 'Lux — Web',
    backgroundColor: '#f0f0f2',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // New tabs load in place: the agent works one page at a time.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void win.loadURL(url)
    return { action: 'deny' }
  })

  // Failures inside the page are the most common reason a tool "did nothing";
  // they belong in the log with the error code, not just in the tool result.
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    logLine('web', `load failed ${errorCode} ${errorDescription} ${validatedUrl}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logLine('web', `renderer gone: ${details.reason} exit=${details.exitCode}`)
  })

  win.on('closed', () => {
    logLine('web', 'window closed')
    webWindow = null
  })

  webWindow = win
  return win
}

export async function snapshotPage(includeStructure = false, waitForLoad = true): Promise<PageSnapshot> {
  if (!webWindow || webWindow.isDestroyed()) {
    throw new Error('no browser window is open; call browser_open first')
  }
  if (waitForLoad) await whenLoaded(webWindow)
  const raw = (await webWindow.webContents.executeJavaScript(snapshotScript(includeStructure), true)) as PageSnapshot
  return {
    ...raw,
    text: raw.text.length > MAX_TEXT ? `${raw.text.slice(0, MAX_TEXT)}…` : raw.text,
    links: raw.links.slice(0, MAX_LINKS),
    headings: (raw.headings ?? []).slice(0, 18),
    buttons: (raw.buttons ?? []).slice(0, 24),
    forms: raw.forms ?? [],
    tables: raw.tables ?? [],
    pagination: (raw.pagination ?? []).slice(0, 10)
  }
}

export async function openWeb(url: string, show = false): Promise<PageSnapshot> {
  logLine('web', `open ${url} show=${show}`)
  const win = ensureWebWindow(show)
  // Re-reading the page the agent is already on should not reload it (and
  // lose form state or scroll position).
  if (!win.webContents.isLoading() && win.webContents.getURL() === url) {
    return snapshotPage()
  }
  await navigateForAgent(win, url)
  const snapshot = await snapshotPage(false, false)
  logLine('web', `loaded ${snapshot.url} chars=${snapshot.text.length} signIn=${snapshot.signIn}`)
  // Reading stays headless until the page actually needs the person.
  if (snapshot.signIn) {
    showWebWindow()
    logLine('web', 'sign-in required, window shown')
  }
  return snapshot
}

/**
 * Navigate until the DOM exists, not until every image, font and tracker has
 * finished. A heavy news page can keep Chromium's load event pending for 40s;
 * the agent only needs readable DOM, so it should not inherit that wait.
 */
async function navigateForAgent(win: BrowserWindow, url: string): Promise<void> {
  const contents = win.webContents
  const loading = win.loadURL(url).catch((error: unknown) => {
    // Redirects and SSO hops surface as aborted loads; the page may still be
    // there, so this is logged rather than thrown into the tool result.
    const message = error instanceof Error ? error.message : String(error)
    logLine('web', `load error: ${message}`)
    return null
  })

  const domReady = new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      contents.off('dom-ready', finish)
      contents.off('did-finish-load', finish)
      contents.off('did-fail-load', finish)
      resolve()
    }
    const timer = setTimeout(finish, 12_000)
    contents.once('dom-ready', finish)
    contents.once('did-finish-load', finish)
    contents.once('did-fail-load', finish)
  })

  await Promise.race([domReady, loading])
  // Let a client-rendered app paint its first meaningful frame.
  await new Promise((resolve) => setTimeout(resolve, 80))
}

export async function clickInPage(options: { text?: string; selector?: string }): Promise<{
  clicked: boolean
  label?: string
  href?: string | null
  urlChanged?: boolean
}> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')

  const script = options.selector
    ? `(() => {
        const element = document.querySelector(${JSON.stringify(options.selector)})
        if (!element) return { clicked: false }
        element.scrollIntoView({ block: 'center' })
        element.click()
        return { clicked: true, label: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 90), href: element.href || null }
      })()`
    : `(() => {
        const want = ${JSON.stringify((options.text ?? '').toLowerCase())}
        const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
        const candidates = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],[onclick],summary,li,tr,label')]
        let exact = null
        let partial = null
        for (const element of candidates) {
          const text = clean(element.innerText || element.value || element.getAttribute('aria-label')).toLowerCase()
          if (!text) continue
          if (text === want) { exact = element; break }
          if (!partial && text.includes(want)) partial = element
        }
        const target = exact || partial
        if (!target) return { clicked: false }
        target.scrollIntoView({ block: 'center' })
        target.click()
        return { clicked: true, label: clean(target.innerText || target.value || '').slice(0, 90), href: target.href || null }
      })()`

  const before = webWindow.webContents.getURL()
  const result = (await webWindow.webContents.executeJavaScript(script, true)) as {
    clicked: boolean
    label?: string
    href?: string | null
  }
  if (!result.clicked) return result

  // Give a navigation a moment to start, then let whenLoaded do the waiting.
  await new Promise((resolve) => setTimeout(resolve, 250))
  await whenLoaded(webWindow)

  // Saying whether anything actually happened is what stops a small model from
  // clicking the same dead link over and over.
  return { ...result, urlChanged: webWindow.webContents.getURL() !== before }
}

/**
 * Find a click target without activating it. Any control inside a form, a
 * native submit control, or an inline JavaScript action is reported before
 * anything happens, so browser_click cannot bypass the confirmation gate by
 * using a button type that delegates to form.submit().
 */
export async function describeClickTarget(options: {
  text?: string
  selector?: string
}): Promise<{
  found: boolean
  label?: string
  href?: string | null
  submitsForm?: boolean
  requiresConfirmation?: boolean
  reason?: string
}> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  const helper = `
    const inspect = (element) => {
      const form = element.form || element.closest('form')
      const type = (element.type || '').toLowerCase()
      const submitsForm = Boolean(form) && (
        (element.tagName === 'INPUT' && ['submit', 'image'].includes(type)) ||
        (element.tagName === 'BUTTON' && (!element.getAttribute('type') || type === 'submit'))
      )
      const rawHref = (element.getAttribute('href') || '').trim()
      const absoluteHref = element.href || ''
      const inlineJavaScript = element.hasAttribute('onclick') ||
        rawHref.toLowerCase().startsWith('javascript:')
      const plainLink = element.tagName === 'A' &&
        /^https?:\\/\\//i.test(absoluteHref) &&
        !rawHref.startsWith('#') &&
        !rawHref.toLowerCase().startsWith('javascript:')
      if (submitsForm) return { submitsForm: true, requiresConfirmation: true, reason: 'a native form submit control' }
      if (form) return { submitsForm: false, requiresConfirmation: true, reason: 'a control inside a form' }
      if (inlineJavaScript) return { submitsForm: false, requiresConfirmation: true, reason: 'an inline JavaScript action' }
      if (!plainLink) return { submitsForm: false, requiresConfirmation: true, reason: 'a button or JavaScript action' }
      return { submitsForm: false, requiresConfirmation: false, reason: '' }
    }
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  `
  const script = options.selector
    ? `(() => { ${helper}
        const element = document.querySelector(${JSON.stringify(options.selector)})
        if (!element) return { found: false }
        return {
          found: true,
          label: clean(element.innerText || element.value || element.getAttribute('aria-label')).slice(0, 90),
          href: element.href || null,
          ...inspect(element)
        }
      })()`
    : `(() => { ${helper}
        const want = ${JSON.stringify((options.text ?? '').toLowerCase())}
        const candidates = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],[onclick],summary,li,tr,label')]
        let exact = null
        let partial = null
        for (const element of candidates) {
          const text = clean(element.innerText || element.value || element.getAttribute('aria-label')).toLowerCase()
          if (!text) continue
          if (text === want) { exact = element; break }
          if (!partial && text.includes(want)) partial = element
        }
        const target = exact || partial
        if (!target) return { found: false }
        return {
          found: true,
          label: clean(target.innerText || target.value || target.getAttribute('aria-label')).slice(0, 90),
          href: target.href || null,
          ...inspect(target)
        }
      })()`
  return (await webWindow.webContents.executeJavaScript(script, true)) as {
    found: boolean
    label?: string
    href?: string | null
    submitsForm?: boolean
    requiresConfirmation?: boolean
    reason?: string
  }
}

export async function goBack(): Promise<PageSnapshot> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  webWindow.webContents.navigationHistory.goBack()
  await whenLoaded(webWindow)
  return snapshotPage()
}

export async function goForward(): Promise<PageSnapshot> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  webWindow.webContents.navigationHistory.goForward()
  await whenLoaded(webWindow)
  return snapshotPage()
}

export async function scrollPage(direction: 'up' | 'down' | 'top' | 'bottom', amount = 650): Promise<PageSnapshot> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  const script =
    direction === 'top'
      ? 'window.scrollTo({ top: 0, behavior: "instant" })'
      : direction === 'bottom'
        ? 'window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })'
        : `window.scrollBy({ top: ${direction === 'up' ? -amount : amount}, behavior: "instant" })`
  await webWindow.webContents.executeJavaScript(script, true)
  await new Promise((resolve) => setTimeout(resolve, 120))
  return snapshotPage()
}

export async function fillInPage(options: {
  field: string
  value: string
  selector?: string
}): Promise<{ filled: boolean; label?: string; reason?: string }> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  const script = `(() => {
    const clean = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const wanted = ${JSON.stringify(options.field.toLowerCase())}
    const selector = ${JSON.stringify(options.selector ?? '')}
    const value = ${JSON.stringify(options.value)}
    const candidates = selector
      ? [...document.querySelectorAll(selector)]
      : [...document.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')]
    const describe = (element) => clean(
      element.labels && element.labels[0] ? element.labels[0].innerText :
      (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.name || element.id || '')
    )
    const target = selector
      ? candidates[0]
      : candidates.find((element) => describe(element).toLowerCase() === wanted) ||
        candidates.find((element) => describe(element).toLowerCase().includes(wanted))
    if (!target) return { filled: false, reason: 'no matching field' }
    if (target.tagName === 'SELECT') {
      const option = [...target.options].find((item) => item.text.toLowerCase().includes(value.toLowerCase()) || item.value.toLowerCase() === value.toLowerCase())
      if (!option) return { filled: false, label: describe(target), reason: 'no matching option' }
      target.value = option.value
    } else if (target.isContentEditable) {
      target.innerText = value
    } else {
      const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter) setter.call(target, value)
      else target.value = value
    }
    target.focus()
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))
    return { filled: true, label: describe(target) || target.name || target.tagName }
  })()`
  return (await webWindow.webContents.executeJavaScript(script, true)) as {
    filled: boolean
    label?: string
    reason?: string
  }
}

export async function pressPageKey(key: string): Promise<PageSnapshot> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  const allowed = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'])
  if (!allowed.has(key)) throw new Error(`unsupported key ${key}`)
  webWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
  webWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await whenLoaded(webWindow)
  return snapshotPage()
}

export async function submitPage(options: { text?: string; selector?: string }): Promise<{
  submitted: boolean
  label?: string
  urlChanged?: boolean
  snapshot: PageSnapshot
}> {
  if (!webWindow || webWindow.isDestroyed()) throw new Error('no browser window is open; call browser_open first')
  const selector = options.selector || (options.text ? '' : 'button[type="submit"],input[type="submit"],form button')
  const result = await clickInPage({ text: options.text, selector: selector || undefined })
  const snapshot = await snapshotPage()
  return { submitted: result.clicked, label: result.label, urlChanged: result.urlChanged, snapshot }
}

export async function inspectPage(): Promise<PageSnapshot> {
  return snapshotPage(true)
}

/** Bring the browser forward so the person can sign in. */
export function showWebWindow(): void {
  if (webWindow && !webWindow.isDestroyed()) {
    webWindow.show()
    webWindow.focus()
  }
}

