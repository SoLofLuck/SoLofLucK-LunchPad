import { useState, type ReactNode } from 'react'
import { EXPLORER } from '../lib/config'
import { fmtDuration, shortAddr } from '../lib/format'
import { useNow } from '../hooks'
import type { CurveState } from '../lib/program'

export function TokenImage({ src, alt, className }: { src?: string; alt: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <div className={`${className ?? ''} thumb-fallback`}>🍀</div>
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} />
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="chip"
      style={{ cursor: 'pointer' }}
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      <span className="mono">{label ?? shortAddr(text)}</span> {done ? '✓' : '⧉'}
    </button>
  )
}

export function AddrLink({ addr, label }: { addr: string; label?: string }) {
  return (
    <a className="mono" href={EXPLORER('address', addr)} target="_blank" rel="noreferrer">
      {label ?? shortAddr(addr)}
    </a>
  )
}

export function Progress({ pct }: { pct: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  )
}

export function Countdown({ until }: { until: number }) {
  const now = useNow()
  return <span className="countdown">{fmtDuration(until - now)}</span>
}

/** The trust signals for a token, compact. */
export function LockBadges({ curve }: { curve: CurveState }) {
  const now = useNow(5000)
  const out: ReactNode[] = []
  if (curve.status === 'migrated') out.push(<span key="m" className="chip ok">🎓 Raydium · LP burned</span>)
  else if (curve.status === 'complete') out.push(<span key="c" className="chip warn">🎓 Graduating</span>)
  if (now < curve.sellUnlockAt)
    out.push(
      <span key="s" className="chip info" title="Selling to the curve is disabled until the lock expires">
        🔒 Sell Lock <Countdown until={curve.sellUnlockAt} />
      </span>,
    )
  if (curve.creatorLockedTokens > 0n && now < curve.creatorUnlockAt)
    out.push(
      <span key="d" className="chip ok" title="The creator's initial buy is locked">
        🛡️ Dev locked
      </span>,
    )
  return <>{out}</>
}

export function TxLink({ signature }: { signature: string }) {
  return (
    <a href={EXPLORER('tx', signature)} target="_blank" rel="noreferrer">
      View transaction ↗
    </a>
  )
}

export function Status({ status, error, signature }: { status: string | null; error: string | null; signature?: string | null }) {
  return (
    <>
      {status && <div className="warn-box" style={{ marginTop: 10 }}>⏳ {status}</div>}
      {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
      {signature && !status && !error && (
        <div className="ok-box" style={{ marginTop: 10 }}>
          ✅ Confirmed. <TxLink signature={signature} />
        </div>
      )}
    </>
  )
}
