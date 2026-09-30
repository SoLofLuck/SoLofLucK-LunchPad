import { useMemo, useState } from 'react'
import { TokenCard } from '../components/TokenCard'
import { LockBadges, Progress, TokenImage } from '../components/ui'
import { useOffchain, useSolPrice, useTokens } from '../hooks'
import { compact, fmtUsd } from '../lib/format'
import { marketCapSol, progressPct, type TokenView } from '../lib/program'
import { href } from '../router'

type Sort = 'mcap' | 'new' | 'graduating' | 'graduated'

function KingOfTheHill({ t, solUsd }: { t: TokenView; solUsd: number | null }) {
  const meta = useOffchain(t.uri)
  const mcap = marketCapSol(t.curve)
  const pct = progressPct(t.curve)
  return (
    <a className="panel koth" href={href.token(t.curve.mint.toBase58())} style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
      <div className="koth-title">👑 King of the Hill</div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <TokenImage className="thumb" src={meta.image} alt={t.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t.name} <span className="muted">${t.symbol}</span>
          </h2>
          <div className="green" style={{ fontWeight: 800, margin: '4px 0' }}>
            MC {solUsd ? fmtUsd(mcap * solUsd) : `${compact(mcap)} SOL`}
          </div>
          <div className="small muted">{meta.description?.slice(0, 140)}</div>
        </div>
      </div>
      <div style={{ margin: '14px 0 6px' }} className="row small">
        <span>Bonding curve</span>
        <span className="spacer" />
        <b>{pct.toFixed(1)}%</b>
      </div>
      <Progress pct={pct} />
      <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
        <LockBadges curve={t.curve} />
      </div>
    </a>
  )
}

export function Home() {
  const { tokens, error } = useTokens()
  const solUsd = useSolPrice()
  const [sort, setSort] = useState<Sort>('mcap')
  const [q, setQ] = useState('')

  const list = useMemo(() => {
    if (!tokens) return null
    const needle = q.trim().toLowerCase()
    let l = tokens.filter(
      (t) =>
        !needle ||
        t.name.toLowerCase().includes(needle) ||
        t.symbol.toLowerCase().includes(needle) ||
        t.curve.mint.toBase58() === q.trim(),
    )
    if (sort === 'graduated') l = l.filter((t) => t.curve.status !== 'trading')
    else if (sort === 'graduating') l = l.filter((t) => t.curve.status === 'trading')
    const key: Record<Sort, (t: TokenView) => number> = {
      mcap: (t) => marketCapSol(t.curve),
      new: (t) => t.curve.createdAt,
      graduating: (t) => progressPct(t.curve),
      graduated: (t) => marketCapSol(t.curve),
    }
    return [...l].sort((a, b) => key[sort](b) - key[sort](a))
  }, [tokens, sort, q])

  const king = useMemo(() => {
    const live = (tokens ?? []).filter((t) => t.curve.status === 'trading')
    return live.sort((a, b) => progressPct(b.curve) - progressPct(a.curve))[0]
  }, [tokens])

  return (
    <div className="container">
      <section className="hero">
        <div className="panel hero-copy">
          <h1>
            Launch a coin in seconds.
            <br />
            <span className="gold">Fair from the first block.</span>
          </h1>
          <p>
            Every token starts on the same bonding curve with no presale and no team allocation. When the curve fills it
            graduates to Raydium automatically, and its liquidity is burned forever.
          </p>
          <div className="features">
            <div className="feature">
              <span className="ic">🔒</span>
              <div>
                <b>Sell Lock</b>
                <span className="muted small">Snipers can't dump at launch: selling opens when the creator's lock expires.</span>
              </div>
            </div>
            <div className="feature">
              <span className="ic">🛡️</span>
              <div>
                <b>Creator Lock</b>
                <span className="muted small">The creator's own first buy can be locked for up to 90 days.</span>
              </div>
            </div>
            <div className="feature">
              <span className="ic">🔥</span>
              <div>
                <b>LP burned on Raydium</b>
                <span className="muted small">Graduation burns 100% of the LP tokens. No rug pulls.</span>
              </div>
            </div>
            <div className="feature">
              <span className="ic">🚫</span>
              <div>
                <b>No mint, no freeze</b>
                <span className="muted small">Mint authority is revoked and metadata is frozen at creation.</span>
              </div>
            </div>
          </div>
          <div className="row wrap">
            <a className="btn primary" href={href.create}>
              🍀 Launch a token
            </a>
            <a className="btn" href={href.how}>
              How it works
            </a>
          </div>
        </div>
        {king ? (
          <KingOfTheHill t={king} solUsd={solUsd} />
        ) : (
          <div className="panel koth">
            <div className="koth-title">👑 King of the Hill</div>
            <p className="muted">The token closest to graduation is crowned here. Could be yours.</p>
          </div>
        )}
      </section>

      <div className="toolbar">
        <div className="tabs">
          {(
            [
              ['mcap', '🔥 Top'],
              ['new', '✨ New'],
              ['graduating', '🚀 About to graduate'],
              ['graduated', '🎓 Graduated'],
            ] as [Sort, string][]
          ).map(([k, label]) => (
            <button key={k} className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <input placeholder="Search name, symbol or mint" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <div className="error-box">Could not load tokens: {error}</div>}
      {!list ? (
        error ? null : <div className="grid">
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="empty">
          <div style={{ fontSize: 40 }}>🍀</div>
          <p>No tokens here yet.</p>
          <a className="btn primary" href={href.create}>
            Launch the first one
          </a>
        </div>
      ) : (
        <div className="grid">
          {list.map((t) => (
            <TokenCard key={t.curve.mint.toBase58()} t={t} solUsd={solUsd} />
          ))}
        </div>
      )}
    </div>
  )
}
