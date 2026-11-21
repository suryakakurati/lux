/**
 * Keeping a tool-heavy turn inside the model's context window.
 *
 * Fetched pages and research dossiers are much larger than the answer needs.
 * Appending every one of them whole means a five-round turn ends with 26k
 * characters of prompt on an 8,192-token model and no room left to speak.
 * These helpers cap each result and drop the oldest tool batch when the request
 * is still too large. The task state and the URL evidence block survive, so the
 * model keeps the facts and the citations without replaying every page.
 *
 * Structural types only: this module is shared with the renderer side tests and
 * must not import Electron or the Ollama client.
 */

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: unknown[]
  tool_name?: string
}

/** Enough of a result to answer from, without the whole page. */
const RESULT_CAPS: Record<string, number> = {
  research: 4_500,
  web_read: 3_000,
  browser_read: 3_000,
  browser_open: 3_000,
  browser_inspect: 2_500,
  news_digest: 2_500,
  vault_read: 2_500,
  agni_report: 2_500
}

const DEFAULT_CAP = 2_000

export function truncateToolResult(name: string, content: string): string {
  const cap = RESULT_CAPS[name] ?? DEFAULT_CAP
  if (content.length <= cap) return content
  const omitted = content.length - cap
  return `${content.slice(0, cap)}\n…[truncated ${omitted} characters. The task state and the URL list above still hold the key facts; say so if a specific detail is missing rather than inventing it.]`
}

export function messageChars(message: ContextMessage): number {
  let total = message.content.length
  if (message.tool_calls && message.tool_calls.length > 0) {
    total += JSON.stringify(message.tool_calls).length
  }
  return total
}

export function contextChars(messages: ContextMessage[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0)
}

interface ToolGroup {
  from: number
  to: number
}

/** Assistant tool-call messages plus the tool results that answer them. */
function toolGroups(messages: ContextMessage[]): ToolGroup[] {
  const groups: ToolGroup[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant' || !message.tool_calls || message.tool_calls.length === 0) {
      continue
    }
    let end = index
    while (end + 1 < messages.length && messages[end + 1].role === 'tool') end += 1
    groups.push({ from: index, to: end })
    index = end
  }
  return groups
}

/**
 * A view of the conversation that fits the budget. The first system prompt and
 * the person's request are always kept; the oldest complete tool batch is
 * dropped first. A dangling tool result is never left behind, because Ollama
 * expects every tool message to answer the assistant call before it.
 */
export function fitContext<T extends ContextMessage>(messages: T[], budgetChars: number): T[] {
  if (contextChars(messages) <= budgetChars) return messages
  let view = [...messages]
  while (contextChars(view) > budgetChars) {
    const groups = toolGroups(view)
    // Keep the newest batch even if it alone is large; it is the evidence the
    // next answer needs. The per-result caps keep that case rare.
    if (groups.length <= 1) break
    const drop = groups[0]
    view = view.filter((_, index) => index < drop.from || index > drop.to)
  }
  return view
}

/** Characters available for the prompt, leaving room for the answer. */
export function contextBudgetChars(contextWindow: number, maxOutputTokens: number): number {
  const promptTokens = Math.max(1_024, contextWindow - maxOutputTokens)
  // Around 2.6 characters per token for this tokenizer once tool schemas are
  // included, with a floor for a deliberately small context window.
  return Math.max(6_000, Math.floor(promptTokens * 2.6))
}
