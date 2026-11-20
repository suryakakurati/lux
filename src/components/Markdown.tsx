import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

marked.setOptions({ gfm: true, breaks: true })

/** Assistant replies rendered as sanitised markdown — never raw HTML. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const parsed = marked.parse(text, { async: false })
    return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : '', {
      ALLOWED_TAGS: [
        'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'a', 'hr', 'h1', 'h2', 'h3', 'h4', 'table',
        'thead', 'tbody', 'tr', 'th', 'td'
      ],
      ALLOWED_ATTR: ['href', 'title']
    })
  }, [text])

  return <div className="markdown selectable" dangerouslySetInnerHTML={{ __html: html }} />
}
