import { useEffect, useState } from 'react'
import { Chat } from './windows/Chat'
import { Hud } from './windows/Hud'
import { Welcome } from './windows/Welcome'

function route(): string {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return hash || 'chat'
}

export function App() {
  const [page, setPage] = useState(route)
  // Each window loads its own route, but a hash change should not leave a stale
  // window behind while developing.
  useEffect(() => {
    const onHash = (): void => setPage(route())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (page === 'hud') return <Hud />
  if (page === 'welcome') return <Welcome />
  return <Chat />
}
