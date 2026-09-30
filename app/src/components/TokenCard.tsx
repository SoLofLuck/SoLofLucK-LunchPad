import { useOffchain } from '../hooks'
import { compact, fmtUsd, shortAddr, timeAgo } from '../lib/format'
import { marketCapSol, progressPct, type TokenView } from '../lib/program'
import { href } from '../router'
import { LockBadges, Progress, TokenImage } from './ui'

export function TokenCard({ t, solUsd }: { t: TokenView; solUsd: number | null }) {
  const meta = useOffchain(t.uri)
  const mcap = marketCapSol(t.curve)
  const pct = progressPct(t.curve)
  return (
    <a className="card" href={href.token(t.curve.mint.toBase58())}>
      <TokenImage className="thumb" src={meta.image} alt={t.name} />
      <div className="body">
        <div className="title">
          {t.name} <span className="muted">${t.symbol}</span>
        </div>
        <div className="tiny muted">
          by <span className="mono">{shortAddr(t.curve.creator.toBase58())}</span> · {timeAgo(t.curve.createdAt)}
        </div>
        <div className="small">
          <span className="green">MC {solUsd ? fmtUsd(mcap * solUsd) : `${compact(mcap)} SOL`}</span>
          <span className="muted"> · {pct.toFixed(pct >= 99 ? 0 : 1)}%</span>
        </div>
        <Progress pct={pct} />
        {meta.description && <div className="desc">{meta.description}</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          <LockBadges curve={t.curve} />
        </div>
      </div>
    </a>
  )
}
