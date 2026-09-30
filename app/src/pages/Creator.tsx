import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useMemo } from 'react'
import { Countdown, LockBadges, Status } from '../components/ui'
import { useNow, useProgram, useSend, useTokens } from '../hooks'
import { claimCreatorFeesIx, claimCreatorLockIx } from '../lib/actions'
import { fmtSol, fmtTokens } from '../lib/format'
import { href } from '../router'

export function Creator() {
  const { publicKey } = useWallet()
  const { setVisible } = useWalletModal()
  const { tokens, reload } = useTokens()
  const program = useProgram()
  const now = useNow()
  const { send, status, error, signature } = useSend()

  const mine = useMemo(
    () => (tokens ?? []).filter((t) => publicKey && t.curve.creator.equals(publicKey)).sort((a, b) => b.curve.createdAt - a.curve.createdAt),
    [tokens, publicKey],
  )
  const claimable = mine.filter((t) => t.curve.creatorFeesAccrued > 0n)
  const total = claimable.reduce((s, t) => s + t.curve.creatorFeesAccrued, 0n)

  if (!publicKey)
    return (
      <div className="container empty">
        <p>Connect the wallet you launched with to see your tokens and fees.</p>
        <button className="btn primary" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      </div>
    )

  return (
    <div className="container">
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row wrap">
          <div>
            <h1 style={{ fontSize: 24 }}>Creator dashboard</h1>
            <div className="muted small">Trading fees you earn accrue on chain until you claim them.</div>
          </div>
          <span className="spacer" />
          <div style={{ textAlign: 'right' }}>
            <div className="muted small">Unclaimed fees</div>
            <div style={{ fontSize: 24, fontWeight: 800 }} className="green">
              {fmtSol(total, 6)} SOL
            </div>
          </div>
          <button
            className="btn primary"
            disabled={claimable.length === 0 || status !== null}
            onClick={async () => {
              // Up to 8 claims per transaction keeps well inside size limits.
              const batch = claimable.slice(0, 8)
              const ok = await send(async () => ({
                ixs: await Promise.all(batch.map((t) => claimCreatorFeesIx(program, publicKey, t.curve.mint))),
              }))
              if (ok) reload()
            }}
          >
            Claim all{claimable.length > 8 ? ' (first 8)' : ''}
          </button>
        </div>
        <Status status={status} error={error} signature={signature} />
      </div>

      {tokens === null ? (
        <div className="skeleton" />
      ) : mine.length === 0 ? (
        <div className="empty">
          <p>You haven't launched a token from this wallet yet.</p>
          <a className="btn primary" href={href.create}>
            Launch one
          </a>
        </div>
      ) : (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Status</th>
                <th>Fees</th>
                <th>Creator Lock</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine.map((t) => {
                const c = t.curve
                const lockOpen = now >= c.creatorUnlockAt
                return (
                  <tr key={c.mint.toBase58()}>
                    <td>
                      <a href={href.token(c.mint.toBase58())}>
                        <b>{t.name}</b> <span className="muted">${t.symbol}</span>
                      </a>
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 4 }}>
                        <span className="chip">{c.status}</span>
                        <LockBadges curve={c} />
                      </div>
                    </td>
                    <td>{fmtSol(c.creatorFeesAccrued, 6)} SOL</td>
                    <td>
                      {c.creatorLockedTokens === 0n ? (
                        <span className="muted">—</span>
                      ) : lockOpen ? (
                        <button
                          className="btn sm"
                          disabled={status !== null}
                          onClick={async () => {
                            if (await send(async () => ({ ixs: [await claimCreatorLockIx(program, publicKey, c.mint)] }))) reload()
                          }}
                        >
                          Claim {fmtTokens(c.creatorLockedTokens)}
                        </button>
                      ) : (
                        <span className="small">
                          {fmtTokens(c.creatorLockedTokens)} · <Countdown until={c.creatorUnlockAt} />
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        className="btn sm"
                        disabled={c.creatorFeesAccrued === 0n || status !== null}
                        onClick={async () => {
                          if (await send(async () => ({ ixs: [await claimCreatorFeesIx(program, publicKey, c.mint)] }))) reload()
                        }}
                      >
                        Claim fees
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
