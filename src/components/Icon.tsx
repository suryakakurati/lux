interface IconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

const base = (size: number): { width: number; height: number; viewBox: string } => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24'
})

export function IconSend({ size = 16, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconStop({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

export function IconPlus({ size = 14, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

export function IconGear({ size = 15, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="3.2" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.7 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.7a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconClose({ size = 14, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

export function IconCheck({ size = 14, strokeWidth = 2, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function IconMic({ size = 14, strokeWidth = 1.7, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  )
}

export function IconChevron({ size = 12, strokeWidth = 1.8, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Four-point star: the Lux mark and the tool-trace spark. */
export function IconSparkle({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 2.4c.33 4.9 2.35 6.92 7.25 7.25-4.9.33-6.92 2.35-7.25 7.25-.33-4.9-2.35-6.92-7.25-7.25C9.65 9.32 11.67 7.3 12 2.4Z" />
    </svg>
  )
}

export function IconGlobe({ size = 14, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5Z" />
    </svg>
  )
}

export function IconTrash({ size = 15, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path
        d="M4.5 7h15M9.5 7V4.8h5V7M6.6 7l.67 11.9a2 2 0 0 0 2 1.86h5.46a2 2 0 0 0 2-1.86L17.4 7M10 11v5.6M14 11v5.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconCopy({ size = 14, strokeWidth = 1.6, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <rect x="9" y="9" width="11" height="11" rx="2.6" />
      <path d="M15.6 6.4V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.6a2 2 0 0 0 2 2h.4" strokeLinecap="round" />
    </svg>
  )
}
