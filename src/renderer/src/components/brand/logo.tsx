import { cn } from '@/lib/utils'

/** Navo mark: a pointer (the agent driving the browser) with a spark (AI). Mirrors resources/logo.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" fill="none" className={cn('size-5 shrink-0', className)} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--primary)" />
      <g transform="translate(32 32) scale(0.94) translate(-35.5 -30.5)">
        <path d="M19 15 L19 45 L27 38 L32 49 L36.5 47 L31.5 36.5 L41 36.5 Z" fill="#fff" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M45 11.5 Q46 18 52.5 19 Q46 20 45 26.5 Q44 20 37.5 19 Q44 18 45 11.5 Z" fill="#fff" opacity=".92" />
      </g>
    </svg>
  )
}

export const PRODUCT_NAME = 'Navo'
