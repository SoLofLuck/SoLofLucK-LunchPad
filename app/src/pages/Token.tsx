import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PriceChart } from '../components/Chart'
import { TradePanel } from '../components/TradePanel'
import { TradesTable } from '../components/TradesTable'
import { AddrLink, Copy, Countdown, Progress, Status, TokenImage } from '../components/ui'
import { useCurve, useNow, useOffchain, useProgram, useSend, useSolPrice } from '../hooks'
import { claimCreatorFeesIx, claimCreatorLockIx, migrateIx } from '../lib/actions'
import { priceSol } from '../lib/curve'
import { compact, fmtPrice, fmtSol, fmtTokens, fmtUsd, timeAgo } from '../lib/format'
import {
  curvePda,
  curvePriceSol,
  curveVault,
  fetchMintMetas,
  marketCapSol,
  progressPct,
  type CurveState,
  type MintMeta,
} from '../lib/program'
import { fetchTrades, tradesFromLogs, type TradeEvent } from '../lib/trades'
import { href } from '../router'

function parseKey(s: string): PublicKey | null {
  try {
    return new PublicKey(s)
  } catch {
    return null
  }
}

function Holders({ mint, curve }: { mint: PublicKey; curve: CurveState }) {
  const { connection } = useConnection()
  const [rows, setRows] = useState<{ owner: string; amount: bigint; label?: string }[] | null>(null)
  useEffect(() => {
    let alive = true
    const vault = curveVault(mint).toBase58()
    connection
      .getTokenLargestAccounts(mint, 'confirmed')
      .then(async (res) => {
        const accs = res.value.filter((a) => a.amount !== '0').slice(0, 12)
        const infos = await connection.getMultipleParsedAccounts(accs.map((a) => a.address))
        const out = accs.map((a, i) => {
          const parsed = infos.value[i]?.data as { parsed?: { info?: { owner?: string } } } | undefined
          const owner = parsed?.parsed?.info?.owner ?? a.address.toBase58()
          const label =
            a.address.toBase58() === vault ? '🏦 Bonding curve' : owner === curve.creator.toBase58() ? '👤 Creator' : undefined
          return { owner, amount: BigInt(a.amount), label }
        })
        if (alive) setRows(out)
      })
      .catch(() => alive && setRows([]))
    return () => {
      alive = false
    }
    // Refresh when reserves move.
  }, [connection, mint, curve.realTokenReserves, curve.creator])

  const supply = Number(curve.tokenTotalSupply)
  return (
    <div className="panel">
      <h3 style={{ marginBottom: 10 }}>Top holders</h3>
      {!rows ? (
        <div className="muted small">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="muted small">No holders yet.</div>
      ) : (
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.owner + i}>
                <td>
                  {i + 1}. {r.label ?? <AddrLink addr={r.owner} />}
                </td>
                <td style={{ textAlign: 'right' }}>{((Number(r.amount) / supply) * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function CreatorPanel({ curve, onDone }: { curve: CurveState; onDone: () => void }) {
  const program = useProgram()
  const { publicKey } = useWallet()
  const now = useNow()
  const { send, status, error, signature } = useSend()
  if (!publicKey || !publicKey.equals(curve.creator)) return null
  const lockOpen = now >= curve.creatorUnlockAt
  return (
    <div className="panel">
      <h3 style={{ marginBottom: 10 }}>👤 Creator panel</h3>
      <div className="row small" style={{ marginBottom: 8 }}>
        <span className="muted">Unclaimed trading fees</span>
        <span className="spacer" />
        <b>{fmtSol(curve.creatorFeesAccrued, 6)} SOL</b>
      </div>
      <button
        className="btn primary block"
        disabled={curve.creatorFeesAccrued === 0n || status !== null}
        onClick={async () => {
          if (await send(async () => ({ ixs: [await claimCreatorFeesIx(program, publicKey, curve.mint)] }))) onDone()
        }}
      >
        Claim fees
      </button>
      {curve.creatorLockedTokens > 0n && (
        <>
          <div className="row small" style={{ margin: '14px 0 8px' }}>
            <span className="muted">Creator Lock</span>
            <span className="spacer" />
            <b>{fmtTokens(curve.creatorLockedTokens)}</b>
          </div>
          <button
            className="btn block"
            disabled={!lockOpen || status !== null}
            onClick={async () => {
              if (await send(async () => ({ ixs: [await claimCreatorLockIx(program, publicKey, curve.mint)] }))) onDone()
            }}
          >
            {lockOpen ? 'Claim locked tokens' : <>Unlocks in&nbsp;<Countdown until={curve.creatorUnlockAt} /></>}
          </button>
        </>
      )}
      <Status status={status} error={error} signature={signature} />
    </div>
  )
}

function GraduatePanel({ curve }: { curve: CurveState }) {
  const program = useProgram()
  const { publicKey } = useWallet()
  const now = useNow()
  const { send, status, error, signature } = useSend()
  if (curve.status !== 'complete') return null
  const waiting = now < curve.sellUnlockAt
  return (
    <div className="panel koth">
      <div className="koth-title">🎓 Ready to graduate</div>
      <p className="small muted">
        The curve sold out. Anyone can move the liquidity to Raydium: the pool opens at the curve's final price and every
        LP token is burned. You only pay the network fee.
      </p>
      <button
        className="btn primary block"
        disabled={!publicKey || waiting || status !== null}
        onClick={() =>
          send(async () => {
            const { ix, pool } = await migrateIx(program, publicKey!, curve.mint)
            return { ixs: [ix], signers: [pool] }
          })
        }
      >
        {waiting ? <>Available after the Sell Lock: <Countdown until={curve.sellUnlockAt} /></> : 'Graduate to Raydium'}
      </button>
      <Status status={status} error={error} signature={signature} />
    </div>
  )
}

export function TokenPage({ mintStr }: { mintStr: string }) {
  const { connection } = useConnection()
  const program = useProgram()
  const solUsd = useSolPrice()
  const mint = useMemo(() => parseKey(mintStr), [mintStr])
  const curveKey = useMemo(() => (mint ? curvePda(mint) : null), [mint])
  const curve = useCurve(mint, curveKey)
  const [meta, setMeta] = useState<MintMeta | null>(null)
  const off = useOffchain(meta?.uri)
  const [trades, setTrades] = useState<TradeEvent[]>([])
  const [loadingTrades, setLoadingTrades] = useState(true)
  const now = useNow(5000)

  useEffect(() => {
    if (!mint) return
    fetchMintMetas(connection, [mint]).then((m) => setMeta(m.get(mint.toBase58()) ?? null))
  }, [connection, mint])

  const loadTrades = useCallback(() => {
    if (!curveKey) return
    fetchTrades(connection, program, curveKey)
      .then(setTrades)
      .catch(() => {})
      .finally(() => setLoadingTrades(false))
  }, [connection, program, curveKey])

  useEffect(() => {
    loadTrades()
    if (!curveKey) return
    const id = connection.onLogs(
      curveKey,
      (l) => {
        if (l.err) return
        const fresh = tradesFromLogs(program, l.signature, l.logs).map((t) => ({
          ...t,
          timestamp: t.timestamp || Math.floor(Date.now() / 1000),
        }))
        if (fresh.length)
          setTrades((prev) => (prev.some((p) => p.signature === l.signature) ? prev : [...fresh, ...prev]))
      },
      'confirmed',
    )
    return () => {
      connection.removeOnLogsListener(id)
    }
  }, [connection, program, curveKey, loadTrades])

  if (!mint) return <div className="container empty">That is not a valid token address.</div>
  if (curve === undefined) return <div className="container"><div className="skeleton" style={{ height: 400 }} /></div>
  if (curve === null)
    return (
      <div className="container empty">
        This token was not launched on SoLofLuck LaunchPad. <a href={href.home}>Back to the board</a>
      </div>
    )

  const name = meta?.name ?? '…'
  const symbol = meta?.symbol ?? ''
  const mcap = marketCapSol(curve)
  const pct = progressPct(curve)
  const price = curvePriceSol(curve)
  const startPrice = priceSol(
    curve.virtualSolReserves - curve.realSolReserves,
    curve.virtualTokenReserves + (curve.tokenTotalSupply - curve.lpTokenReserve - curve.realTokenReserves),
  )
  const sellLocked = now < curve.sellUnlockAt

  return (
    <div className="container">
      <div className="token-head">
        <TokenImage src={off.image} alt={name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={{ fontSize: 26 }}>
            {name} <span className="muted">${symbol}</span>
          </h1>
          <div className="row wrap small" style={{ gap: 8, marginTop: 4 }}>
            <Copy text={mint.toBase58()} />
            <span className="muted">
              by <AddrLink addr={curve.creator.toBase58()} /> · {timeAgo(curve.createdAt, now)}
            </span>
            {off.website && <a href={off.website} target="_blank" rel="noreferrer">🌐 Website</a>}
            {off.twitter && <a href={off.twitter} target="_blank" rel="noreferrer">𝕏 Twitter</a>}
            {off.telegram && <a href={off.telegram} target="_blank" rel="noreferrer">✈️ Telegram</a>}
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="k">Market cap</div>
          <div className="v green">{solUsd ? fmtUsd(mcap * solUsd) : `${compact(mcap)} SOL`}</div>
        </div>
        <div className="stat">
          <div className="k">Price</div>
          <div className="v">{solUsd ? `$${fmtPrice(price * solUsd)}` : `${fmtPrice(price)} SOL`}</div>
        </div>
        <div className="stat">
          <div className="k">Raised on curve</div>
          <div className="v">{fmtSol(curve.realSolReserves, 2)} SOL</div>
        </div>
        <div className="stat">
          <div className="k">Trading fee</div>
          <div className="v">{(curve.protocolFeeBps + curve.creatorFeeBps) / 100}%</div>
        </div>
      </div>

      <div className="token-layout">
        <div style={{ display: 'grid', gap: 16, minWidth: 0 }}>
          <PriceChart trades={trades} startPrice={startPrice} solUsd={solUsd} />
          {off.description && (
            <div className="panel">
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{off.description}</p>
            </div>
          )}
          <TradesTable trades={trades} loading={loadingTrades} />
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <GraduatePanel curve={curve} />
          <TradePanel curve={curve} symbol={symbol} onTraded={() => setTimeout(loadTrades, 1500)} />

          <div className="panel">
            <div className="row small" style={{ marginBottom: 6 }}>
              <b>Bonding curve progress</b>
              <span className="spacer" />
              <b>{pct.toFixed(1)}%</b>
            </div>
            <Progress pct={pct} />
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              {curve.status === 'trading' ? (
                <>
                  {fmtTokens(curve.realTokenReserves)} tokens left on the curve. When they sell out, the liquidity
                  graduates to Raydium and the LP is burned.
                </>
              ) : curve.status === 'complete' ? (
                'Sold out — waiting for graduation.'
              ) : (
                'Graduated. Liquidity is on Raydium with LP burned.'
              )}
            </p>
          </div>

          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Safety</h3>
            <div className="lock-card">
              <span className="ic">🔒</span>
              <div className="small">
                <b>Sell Lock</b>
                <div className="muted">
                  {curve.sellUnlockAt <= curve.createdAt
                    ? 'None chosen: selling was open from launch.'
                    : sellLocked
                      ? <>Selling opens in <Countdown until={curve.sellUnlockAt} /> for everyone, the creator included.</>
                      : `Expired ${timeAgo(curve.sellUnlockAt, now)}. Selling is open.`}
                </div>
              </div>
            </div>
            <div className="lock-card">
              <span className="ic">🛡️</span>
              <div className="small">
                <b>Creator Lock</b>
                <div className="muted">
                  {curve.creatorLockedTokens === 0n
                    ? curve.creatorUnlockAt > curve.createdAt
                      ? 'Released or claimed.'
                      : 'No creator buy was locked.'
                    : now < curve.creatorUnlockAt
                      ? <>{fmtTokens(curve.creatorLockedTokens)} tokens locked for <Countdown until={curve.creatorUnlockAt} />.</>
                      : `${fmtTokens(curve.creatorLockedTokens)} tokens unlocked, not yet claimed.`}
                </div>
              </div>
            </div>
            <div className="lock-card">
              <span className="ic">🚫</span>
              <div className="small">
                <b>Mint & freeze authority revoked</b>
                <div className="muted">Supply is fixed at {fmtTokens(curve.tokenTotalSupply)}; no account can be frozen; metadata is immutable.</div>
              </div>
            </div>
          </div>

          <CreatorPanel curve={curve} onDone={() => {}} />
          <Holders mint={mint} curve={curve} />
        </div>
      </div>
    </div>
  )
}
