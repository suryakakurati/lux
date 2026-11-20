import type { CSSProperties } from 'react'

/**
 * The Lux mark: concentric instrument rings around a live core. It is pure CSS
 * so it inherits the theme tokens and keeps moving without a canvas or rAF.
 */
export function Reactor({
  size = 32,
  active = true,
  className
}: {
  size?: number
  active?: boolean
  className?: string
}) {
  return (
    <span
      className={className ? `reactor ${className}` : 'reactor'}
      data-active={active}
      style={{ '--reactor': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <span className="reactor-halo" />
      <span className="reactor-ring reactor-ring--outer" />
      <span className="reactor-ring reactor-ring--mid" />
      <span className="reactor-tick reactor-tick--a" />
      <span className="reactor-tick reactor-tick--b" />
      <span className="reactor-core" />
    </span>
  )
}
