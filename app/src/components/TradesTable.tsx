import { fmtSol, fmtTokens, shortAddr, timeAgo } from '../lib/format'
import type { TradeEvent } from '../lib/trades'
import { AddrLink, TxLink } from './ui'
import { useNow } from '../hooks'
import { useState } from 'react'

export function TradesTable({ trades, loading }: { trades: TradeEvent[]; loading: boolean }) {
  const now = useNow(10_000)
  const [shown, setShown] = useState(25)
  return (
    <div className="panel">
      <h3 style={{ marginBottom: 10 }}>Trades</h3>
      {loading && trades.length === 0 ? (
        <div className="muted small">Loading history…</div>
      ) : trades.length === 0 ? (
        <div className="muted small">No trades yet.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>SOL</th>
                <th>Tokens</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, shown).map((t) => (
                <tr key={t.signature + t.trader + t.isBuy}>
                  <td>
                    <AddrLink addr={t.trader} label={shortAddr(t.trader)} />
                  </td>
                  <td className={t.isBuy ? 'green' : 'red'}>{t.isBuy ? 'Buy' : 'Sell'}</td>
                  <td>{fmtSol(t.solAmount, 4)}</td>
                  <td>{fmtTokens(t.tokenAmount)}</td>
                  <td className="muted">{timeAgo(t.timestamp, now)}</td>
                  <td>
                    <TxLink signature={t.signature} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length > shown && (
            <button className="btn sm block" style={{ marginTop: 10 }} onClick={() => setShown((n) => n + 50)}>
              Show more ({trades.length - shown})
            </button>
          )}
        </div>
      )}
    </div>
  )
}
