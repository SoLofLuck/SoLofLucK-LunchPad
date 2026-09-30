import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNow, useProgram, useSend } from '../hooks'
import { buyIx, sellIx } from '../lib/actions'
import { RAYDIUM_SWAP } from '../lib/config'
import { applyBuy, applySell, priceImpactPct, quoteBuy, quoteSell, withSlippage } from '../lib/curve'
import { fmtSol, fmtTokens, parseUnits } from '../lib/format'
import { reservesOf, type CurveState } from '../lib/program'
import { Countdown, Status } from './ui'

const SOL_PRESETS = ['0.1', '0.5', '1', '5']
const SLIPPAGES = [100, 300, 500, 1000]
// Leave room for the transaction fee and a token account's rent on first buy.
const SOL_RESERVE = 5_000_000n

export function TradePanel({ curve, symbol, onTraded }: { curve: CurveState; symbol: string; onTraded: () => void }) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const { setVisible } = useWalletModal()
  const program = useProgram()
  const { send, status, busy, error, signature } = useSend()
  const now = useNow()
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(500)
  const [solBal, setSolBal] = useState<bigint | null>(null)
  const [tokBal, setTokBal] = useState<bigint | null>(null)
  const mint = curve.mint
  const ata = useMemo(
    () => (publicKey ? getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID) : null),
    [publicKey, mint],
  )

  const refreshBalances = useCallback(async () => {
    if (!publicKey || !ata) {
      setSolBal(null)
      setTokBal(null)
      return
    }
    connection.getBalance(publicKey, 'confirmed').then((b) => setSolBal(BigInt(b))).catch(() => {})
    connection
      .getTokenAccountBalance(ata, 'confirmed')
      .then((b) => setTokBal(BigInt(b.value.amount)))
      .catch(() => setTokBal(0n))
  }, [connection, publicKey, ata])

  useEffect(() => {
    refreshBalances()
  }, [refreshBalances, signature])

  const locked = now < curve.sellUnlockAt
  const r = reservesOf(curve)
  const units = parseUnits(amount, side === 'buy' ? 9 : 6)

  const quote = useMemo(() => {
    if (!units || units <= 0n) return null
    if (side === 'buy') {
      const q = quoteBuy(r, units, curve.protocolFeeBps, curve.creatorFeeBps)
      if (!q) return null
      return {
        kind: 'buy' as const,
        q,
        impact: priceImpactPct(r, applyBuy(r, q)),
        minOut: withSlippage(q.tokensOut, slippageBps),
      }
    }
    const q = quoteSell(r, units, curve.protocolFeeBps, curve.creatorFeeBps)
    if (!q) return null
    return {
      kind: 'sell' as const,
      q,
      impact: priceImpactPct(r, applySell(r, units, q)),
      minOut: withSlippage(q.netToSeller, slippageBps),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, side, curve, slippageBps])

  if (curve.status === 'migrated') {
    return (
      <div className="panel">
        <h3>🎓 Graduated to Raydium</h3>
        <p className="muted small">
          This token's liquidity lives in a Raydium pool now, and every LP token was burned — the liquidity can never be
          pulled.
        </p>
        <a className="btn primary block" href={RAYDIUM_SWAP(mint.toBase58())} target="_blank" rel="noreferrer">
          Trade on Raydium ↗
        </a>
        <div className="tiny muted" style={{ marginTop: 8 }}>
          Pool: <span className="mono">{curve.raydiumPool.toBase58()}</span>
        </div>
      </div>
    )
  }

  const insufficient =
    units !== null &&
    ((side === 'buy' && solBal !== null && units + SOL_RESERVE > solBal) ||
      (side === 'sell' && tokBal !== null && units > tokBal))

  const submit = async () => {
    if (!publicKey || !quote || !units) return
    const sig = await send(async () => ({
      ixs: [
        side === 'buy'
          ? await buyIx(program, publicKey, mint, units, quote.minOut > 0n ? quote.minOut : 1n)
          : await sellIx(program, publicKey, mint, units, quote.minOut),
      ],
    }))
    if (sig) {
      setAmount('')
      onTraded()
    }
  }

  const setPct = (pct: number) => {
    if (tokBal === null) return
    const v = (tokBal * BigInt(pct)) / 100n
    setAmount((Number(v) / 1e6).toString())
  }

  return (
    <div className="panel">
      <div className="trade-tabs">
        <button className={`buy ${side === 'buy' ? 'active' : ''}`} onClick={() => { setSide('buy'); setAmount('') }}>
          Buy
        </button>
        <button className={`sell ${side === 'sell' ? 'active' : ''}`} onClick={() => { setSide('sell'); setAmount('') }}>
          Sell
        </button>
      </div>

      {curve.status === 'complete' && (
        <div className="warn-box" style={{ marginBottom: 12 }}>
          🎓 The curve is complete. Trading resumes on Raydium after graduation — anyone can trigger it below.
        </div>
      )}
      {side === 'sell' && locked && curve.status === 'trading' && (
        <div className="lock-card">
          <span className="ic">🔒</span>
          <div>
            <b>Sell Lock active</b>
            <div className="small muted">
              Selling opens in <Countdown until={curve.sellUnlockAt} />. Buying is open. The creator chose this lock at
              launch; it applies to everyone, the creator included.
            </div>
          </div>
        </div>
      )}

      <div className="field">
        <div className="row" style={{ marginBottom: 6 }}>
          <label style={{ margin: 0 }}>{side === 'buy' ? 'You pay' : 'You sell'}</label>
          <span className="spacer" />
          <span className="tiny muted">
            Balance:{' '}
            {side === 'buy'
              ? solBal === null ? '—' : `${fmtSol(solBal, 3)} SOL`
              : tokBal === null ? '—' : `${fmtTokens(tokBal)} ${symbol}`}
          </span>
        </div>
        <div className="amount-input">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
          />
          <span className="unit">{side === 'buy' ? 'SOL' : symbol}</span>
        </div>
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        {side === 'buy'
          ? SOL_PRESETS.map((p) => (
              <button key={p} onClick={() => setAmount(p)}>
                {p} SOL
              </button>
            ))
          : [25, 50, 75, 100].map((p) => (
              <button key={p} onClick={() => setPct(p)}>
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
      </div>

      {quote && (
        <div className="quote">
          {quote.kind === 'buy' ? (
            <>
              <div>
                <span className="muted">You receive</span>
                <b>
                  {fmtTokens(quote.q.tokensOut)} {symbol}
                </b>
              </div>
              {quote.q.completesCurve && (
                <div>
                  <span className="gold">Completes the curve — you pay only</span>
                  <b className="gold">{fmtSol(quote.q.totalCost)} SOL</b>
                </div>
              )}
              <div>
                <span className="muted">Fees</span>
                <span>{fmtSol(quote.q.fees.protocol + quote.q.fees.creator, 6)} SOL</span>
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="muted">You receive</span>
                <b>{fmtSol(quote.q.netToSeller, 6)} SOL</b>
              </div>
              <div>
                <span className="muted">Fees</span>
                <span>{fmtSol(quote.q.fees.protocol + quote.q.fees.creator, 6)} SOL</span>
              </div>
            </>
          )}
          <div>
            <span className="muted">Price impact</span>
            <span className={quote.impact > 10 ? 'red' : ''}>{quote.impact.toFixed(2)}%</span>
          </div>
          <div>
            <span className="muted">Minimum received</span>
            <span>
              {quote.kind === 'buy' ? `${fmtTokens(quote.minOut)} ${symbol}` : `${fmtSol(quote.minOut, 6)} SOL`}
            </span>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="tiny muted">Slippage</span>
        <div className="seg compact" style={{ flex: 1, flexWrap: 'nowrap' }}>
          {SLIPPAGES.map((s) => (
            <button key={s} className={slippageBps === s ? 'active' : ''} onClick={() => setSlippageBps(s)}>
              {s / 100}%
            </button>
          ))}
        </div>
      </div>

      {!publicKey ? (
        <button className="btn primary block" onClick={() => setVisible(true)}>
          Connect wallet
        </button>
      ) : (
        <button
          className={`btn block ${side === 'buy' ? 'primary' : 'danger'}`}
          disabled={
            busy || !quote || insufficient || curve.status !== 'trading' || (side === 'sell' && locked)
          }
          onClick={submit}
        >
          {busy
            ? status
            : insufficient
              ? 'Insufficient balance'
              : side === 'buy'
                ? `Buy ${symbol}`
                : locked
                  ? 'Sell Lock active'
                  : `Sell ${symbol}`}
        </button>
      )}
      <Status status={null} error={error} signature={signature} />
    </div>
  )
}
