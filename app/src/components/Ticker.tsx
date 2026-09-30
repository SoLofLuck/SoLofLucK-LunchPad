import { useState } from 'react'
import { useProgram, useProgramLogs } from '../hooks'
import { fmtSol, shortAddr } from '../lib/format'
import { tradesFromLogs } from '../lib/trades'
import { href } from '../router'

interface Tick {
  id: string
  kind: 'buy' | 'sell' | 'new'
  text: string
  mint: string
}

/** Live feed of launchpad activity from a program log subscription. */
export function Ticker() {
  const program = useProgram()
  const [ticks, setTicks] = useState<Tick[]>([])

  useProgramLogs((signature, logs) => {
    const next: Tick[] = []
    if (logs.some((l) => l.includes('Instruction: Create'))) {
      const t = tradesFromLogs(program, signature, logs)[0]
      if (t) next.push({ id: `${signature}-new`, kind: 'new', text: `🍀 ${shortAddr(t.trader)} launched a token`, mint: t.mint })
    }
    for (const t of tradesFromLogs(program, signature, logs)) {
      next.push({
        id: `${signature}-${t.trader}-${t.isBuy}`,
        kind: t.isBuy ? 'buy' : 'sell',
        text: `${shortAddr(t.trader)} ${t.isBuy ? 'bought' : 'sold'} ${fmtSol(t.solAmount, 3)} SOL`,
        mint: t.mint,
      })
    }
    if (next.length) setTicks((prev) => [...next, ...prev].slice(0, 12))
  })

  return (
    <div className="ticker">
      <div className="container ticker-inner">
        {ticks.length === 0 ? (
          <span className="tick muted small">Live activity appears here as it happens…</span>
        ) : (
          ticks.map((t) => (
            <a key={t.id} href={href.token(t.mint)} className={`tick ${t.kind}`}>
              {t.text}
            </a>
          ))
        )}
      </div>
    </div>
  )
}
