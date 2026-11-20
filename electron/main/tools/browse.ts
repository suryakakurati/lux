import { searchHistory, topSites, type HistoryBrowser } from '../web/history'
import {
  clickInPage,
  describeClickTarget,
  fillInPage,
  goBack,
  goForward,
  inspectPage,
  openWeb,
  pressPageKey,
  scrollPage,
  snapshotPage,
  submitPage,
  type PageSnapshot
} from '../web/browser'
import { readPublicPage } from '../web/read'
import type { ToolDef } from './types'

function normalizeUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [`${snapshot.title || '(untitled page)'} — ${snapshot.url}`]
  if (snapshot.signIn && snapshot.text.length < 800) {
    lines.push('(This page is asking for a sign-in.)')
  }
  lines.push('', snapshot.text || '(the page has no readable text)')
  if (snapshot.headings.length > 0) {
    lines.push('', `Outline: ${snapshot.headings.slice(0, 8).join(' · ')}`)
  }
  if (snapshot.pagination.length > 0) {
    lines.push(`Pagination: ${snapshot.pagination.map((item) => item.text || item.href).slice(0, 6).join(' · ')}`)
  }
  if (snapshot.links.length > 0) {
    lines.push('', 'Links on this page:')
    for (const link of snapshot.links) lines.push(`- ${link.text} — ${link.href}`)
  }
  return lines.join('\n')
}

function formatInspection(snapshot: PageSnapshot): string {
  return JSON.stringify(
    {
      title: snapshot.title,
      url: snapshot.url,
      signIn: snapshot.signIn,
      scroll: { position: snapshot.scrollY, height: snapshot.scrollHeight, viewport: snapshot.viewportHeight },
      headings: snapshot.headings,
      buttons: snapshot.buttons,
      forms: snapshot.forms,
      tables: snapshot.tables,
      pagination: snapshot.pagination,
      links: snapshot.links
    },
    null,
    2
  )
}

/**
 * Pick the page a person actually uses for a site.
 *
 * History is full of download URLs and SSO hops, so the busiest short URL on the
 * site's own domain wins; tracking parameters are stripped first.
 */
interface RankedSite {
  title: string
  url: string
  visits: number
  last: string
  score: number
}

function bestSiteHit(
  hits: { title: string; url: string; visits: number; last: string }[],
  site: string
): RankedSite | null {
  const needle = site.toLowerCase()
  const ranked: RankedSite[] = []

  for (const hit of hits) {
    let url = hit.url
    try {
      const parsed = new URL(hit.url)
      parsed.hash = ''
      for (const key of [...parsed.searchParams.keys()]) {
        if (/^(utm_|fbclid|gclid|verifier|sf_verifier|download_frd)/i.test(key)) parsed.searchParams.delete(key)
      }
      url = parsed.toString()
    } catch {
      continue
    }
    if (/\.(pdf|zip|png|jpg|docx?|pptx?)$/i.test(url)) continue

    const onTopic = url.toLowerCase().includes(needle) || hit.title.toLowerCase().includes(needle) ? 2 : 0
    ranked.push({ ...hit, url, score: hit.visits + onTopic * 10 - url.length / 200 })
  }

  ranked.sort((a, b) => b.score - a.score)
  return ranked[0] ?? null
}

export const browseTools: ToolDef[] = [
  {
    name: 'site_open',
    description:
      'Find the URL the person actually uses for a site from their browser history, open it in Lux\u2019s browser and return the page. One step: use this instead of history_search + browser_open when they name a site (courses, email, portal, bank, code host).',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site or service name, e.g. "courses", "outlook", "github".' },
        show: { type: 'boolean', description: 'Reveal the browser window (default false: it reads headless).' }
      },
      required: ['site']
    },
    async run(args) {
      const site = String(args.site ?? '').trim()
      if (site.length < 2) return { content: 'Name the site to open.', summary: 'no site given' }

      const history = await searchHistory(site, 12, 'auto')
      const hit = bestSiteHit(history.hits, site) ?? bestSiteHit(await topSites(12), site)
      if (!hit) {
        return {
          content: `No site matching "${site}" appears in browser history. Ask the person for the URL, or use web_read for a public page.`,
          summary: 'no site found'
        }
      }

      const snapshot = await openWeb(hit.url, args.show === true)
      const provenance = `${hit.title || hit.url} (from history: ${hit.visits} visit${hit.visits === 1 ? '' : 's'}${hit.last ? `, last ${hit.last}` : ''})`
      return {
        content: `Opened ${provenance}\n\n${formatSnapshot(snapshot)}`,
        summary: `open ${host(snapshot.url)}`,
        openChat: true
      }
    }
  },
  {
    name: 'browser_open',
    description:
      "Open a URL in Lux's own browser window (a real Chromium window with a persistent login) and return the page's readable text and links. Use this whenever a page must be read, clicked, or is behind a sign-in.",
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL, or a host/path; https:// is assumed.' },
        show: {
          type: 'boolean',
          description: 'Reveal the window to the person (default false: reading is headless).'
        }
      },
      required: ['url']
    },
    async run(args) {
      const url = normalizeUrl(String(args.url ?? ''))
      if (!url) return { content: 'That is not a URL I can open.', summary: 'bad url' }
      const snapshot = await openWeb(url, args.show === true)
      return {
        content: formatSnapshot(snapshot),
        summary: `open ${host(snapshot.url)}`,
        openChat: snapshot.text.length > 400
      }
    }
  },
  {
    name: 'browser_read',
    description:
      'Read the page currently shown in Lux’s browser window: its text, its links, and whether it is asking for a sign-in. Call it again after clicking or navigating.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const snapshot = await snapshotPage()
      return {
        content: formatSnapshot(snapshot),
        summary: `read ${host(snapshot.url)}`,
        openChat: snapshot.text.length > 400
      }
    }
  },
  {
    name: 'browser_click',
    description:
      'Click a link or button in Lux’s browser window by its visible text (preferred) or a CSS selector, then return the resulting page. Every click requires approval because page JavaScript listeners can submit or navigate.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible label of the link or button to click.' },
        selector: { type: 'string', description: 'CSS selector, when text is not enough.' }
      }
    },
    async run(args, context) {
      const text = String(args.text ?? '').trim()
      const selector = String(args.selector ?? '').trim()
      if (!text && !selector) return { content: 'Give a label or a selector to click.', summary: 'nothing to click' }
      const target = await describeClickTarget({ text: text || undefined, selector: selector || undefined })
      if (target.found) {
        const approved = await context.confirm({
          tool: 'browser_click',
          args: { text, selector },
          reason: `Clicking "${target.label || text || selector}" is ${target.reason || 'a page navigation'} and may run JavaScript, submit or navigate.`
        })
        if (!approved) {
          return {
            content: 'The person declined the click. Do not activate that control; ask what they would prefer.',
            summary: 'declined'
          }
        }
      }
      const result = await clickInPage({ text: text || undefined, selector: selector || undefined })
      if (!result.clicked) {
        return {
          content: `Nothing on the page matches "${text || selector}". Read the page and use one of its link labels.`,
          summary: 'click missed'
        }
      }
      const snapshot = await snapshotPage()
      const warning = result.urlChanged
        ? ''
        : '\nThe URL did not change after that click, so it did not navigate. Do not click it again: read the page and choose a different link, or answer from what is already visible.\n'
      return {
        content: `Clicked "${result.label ?? (text || selector)}".${warning}\n${formatSnapshot(snapshot)}`,
        summary: `clicked ${(result.label ?? text).slice(0, 28)}${result.urlChanged ? '' : ' (no change)'}`,
        openChat: snapshot.text.length > 400
      }
    }
  },
  {
    name: 'browser_back',
    description: 'Go back one page in Lux’s browser window and return the page you land on.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const snapshot = await goBack()
      return { content: formatSnapshot(snapshot), summary: `back to ${host(snapshot.url)}` }
    }
  },
  {
    name: 'browser_forward',
    description: 'Go forward one page in Lux’s browser window and return the page you land on.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const snapshot = await goForward()
      return { content: formatSnapshot(snapshot), summary: `forward to ${host(snapshot.url)}` }
    }
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the current page in Lux’s browser and return the new viewport. Use it when the needed content or links are below the fold, instead of guessing a URL.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'Scroll direction.', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 650).', minimum: 100, maximum: 5_000 }
      },
      required: ['direction']
    },
    async run(args) {
      const direction = String(args.direction ?? 'down') as 'up' | 'down' | 'top' | 'bottom'
      const snapshot = await scrollPage(direction, Number(args.amount ?? 650))
      return {
        content: `Scrolled ${direction}.\n${formatSnapshot(snapshot)}`,
        summary: `scroll ${direction} · ${snapshot.scrollY}px`
      }
    }
  },
  {
    name: 'browser_inspect',
    description:
      'Inspect the current page structurally: headings, buttons, links, forms and fields, tables, pagination and scroll position. Use this to operate an unfamiliar layout before clicking or filling anything.',
    risk: 'safe',
    params: { type: 'object', properties: {} },
    async run() {
      const snapshot = await inspectPage()
      return {
        content: formatInspection(snapshot),
        summary: `inspect ${host(snapshot.url)}`,
        openChat: true
      }
    }
  },
  {
    name: 'browser_fill',
    description:
      'Fill a text field, textarea or select in Lux’s browser by its label, placeholder or name. This edits the field, but page input/change listeners can submit or navigate, so every fill requires approval.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Visible label, placeholder, name or aria-label of the field.' },
        value: { type: 'string', description: 'Text or option to put in the field.' },
        selector: { type: 'string', description: 'Optional CSS selector when the label is ambiguous.' }
      },
      required: ['field', 'value']
    },
    async run(args, context) {
      const field = String(args.field ?? '').trim()
      const value = String(args.value ?? '')
      if (!field) return { content: 'Which field should I fill?', summary: 'no field' }
      const approved = await context.confirm({
        tool: 'browser_fill',
        args: { field, value, selector: args.selector },
        reason: 'Filling a field dispatches input/change events, which can run page JavaScript, submit a form or navigate.'
      })
      if (!approved) {
        return {
          content: 'The person declined filling the field because page change handlers can submit or navigate. Do not fill it.',
          summary: 'declined'
        }
      }
      const result = await fillInPage({
        field,
        value,
        selector: String(args.selector ?? '') || undefined
      })
      if (!result.filled) {
        throw new Error(
          `Could not fill that field${result.reason ? `: ${result.reason}` : ''}. Use browser_inspect to see the actual fields.`
        )
      }
      return {
        content: `Filled "${result.label ?? field}". Nothing was submitted.`,
        summary: `filled ${(result.label ?? '').slice(0, 28)}`
      }
    }
  },
  {
    name: 'browser_press',
    description:
      'Press a navigation key in the current page (Enter, Tab, Escape, arrows, PageDown/PageUp, Home, End) and return the page afterward. Use Enter to submit a search, not to commit an external action.',
    risk: 'safe',
    params: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key to press.',
          enum: ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']
        }
      },
      required: ['key']
    },
    async run(args, context) {
      const key = String(args.key ?? 'Enter')
      if (key === 'Enter') {
        const approved = await context.confirm({
          tool: 'browser_press',
          args: { key },
          reason: 'Pressing Enter can submit a form and create an external action.'
        })
        if (!approved) {
          return {
            content: 'The person declined the Enter key because it can submit a form. Read the page and ask what they want to submit.',
            summary: 'declined'
          }
        }
      }
      const snapshot = await pressPageKey(key)
      return {
        content: `Pressed ${key}.\n${formatSnapshot(snapshot)}`,
        summary: `press ${key}`
      }
    }
  },
  {
    name: 'browser_submit',
    description:
      'Submit a form in Lux’s browser. This creates an external action, so the person must approve it first. Fill fields with browser_fill before calling it.',
    risk: 'confirm',
    params: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible label of the submit control, when there is one.' },
        selector: { type: 'string', description: 'Optional CSS selector for the submit control.' }
      }
    },
    async run(args) {
      const result = await submitPage({
        text: String(args.text ?? '') || undefined,
        selector: String(args.selector ?? '') || undefined
      })
      if (!result.submitted) {
        throw new Error('No submit control matched. Inspect the page and identify the actual form control.')
      }
      return {
        content: `Submitted "${result.label ?? 'form'}"${result.urlChanged ? '' : ' (the URL did not change)'}.\n${formatSnapshot(result.snapshot)}`,
        summary: `submitted ${(result.label ?? 'form').slice(0, 24)}`,
        openChat: true
      }
    }
  },
  {
    name: 'web_read',
    description:
      'Fetch a public web page and return its readable text, without a browser session. Fast for news, docs and articles; pages behind a login need browser_open instead.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to read.' },
        fresh: { type: 'boolean', description: 'Bypass the short page cache when recency matters.' }
      },
      required: ['url']
    },
    async run(args) {
      const url = normalizeUrl(String(args.url ?? ''))
      if (!url) return { content: 'That is not a URL I can read.', summary: 'bad url' }
      try {
        const page = await readPublicPage(url, args.fresh === true)
        const header = `${page.title || '(untitled)'} — ${page.url}`
        const freshness = page.cached
          ? `Cached at ${new Date(page.fetchedAt ?? Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}; pass fresh=true if you need a new read.`
          : ''
        return {
          content: `${header}${freshness ? `\n${freshness}` : ''}\n\n${page.text || '(no readable text)'}`,
          summary: `read ${host(page.url)}`,
          openChat: page.text.length > 400
        }
      } catch (error) {
        return {
          content: `Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`,
          summary: 'read failed'
        }
      }
    }
  },
  {
    name: 'history_search',
    description:
      'Search the browser history on this Mac (Firefox by default, also Chrome and Safari) for pages the person has visited. Use it to find the exact URL and page they actually use for a site before opening anything.',
    risk: 'safe',
    parallelSafe: true,
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words from the page title or URL, e.g. "course portal" or "github".' },
        limit: { type: 'integer', description: 'How many results (default 8, max 20).', minimum: 1, maximum: 20 },
        browser: {
          type: 'string',
          description: 'Which history to search (default auto = all available).',
          enum: ['auto', 'firefox', 'chrome', 'safari']
        }
      },
      required: ['query']
    },
    async run(args) {
      const query = String(args.query ?? '').trim()
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)))
      const browser = String(args.browser ?? 'auto').toLowerCase() as HistoryBrowser
      const result = await searchHistory(query, limit, browser)

      const describe = (hit: { title: string; url: string; visits: number; last: string; browser: string }, index: number): string => {
        const title = hit.title ? `${hit.title} — ` : ''
        return `${index + 1}. ${title}${hit.url}\n   ${hit.visits} visit${hit.visits === 1 ? '' : 's'}${
          hit.last ? `, last ${hit.last}` : ''
        } · ${hit.browser}`
      }

      if (result.hits.length === 0) {
        // A vague question has no searchable words. Return the sites this Mac
        // actually uses so the model has somewhere concrete to go.
        const sites = await topSites(12)
        if (sites.length === 0) {
          return {
            content: [`Nothing in history matches "${query}".`, ...result.notes].join('\n'),
            summary: 'no history match'
          }
        }
        return {
          content: [
            `Nothing in history matches "${query}". These are the sites this Mac visits most — pick the one that holds the answer and open it:`,
            ...sites.map(describe),
            ...result.notes
          ].join('\n'),
          summary: `${sites.length} top sites`,
          openChat: true
        }
      }

      const top = result.hits[0]
      return {
        content: [
          `History matches for "${query}":`,
          ...result.hits.map(describe),
          ...result.notes,
          top ? `\nNext: open ${top.url} with browser_open (or call site_open with a site name) — do not search history again.` : ''
        ].join('\n'),
        summary: `${result.hits.length} history hits`,
        openChat: true
      }
    }
  }
]
