import { Chat } from './windows/Chat'
import { Hud } from './windows/Hud'
import { Welcome } from './windows/Welcome'

function route(): string {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return hash || 'chat'
}

export function App() {
  const page = route()
  if (page === 'hud') return <Hud />
  if (page === 'welcome') return <Welcome />
  return <Chat />
}
