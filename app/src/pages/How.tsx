import { useEffect, useState } from 'react'
import { useProgram } from '../hooks'
import { fmtSol } from '../lib/format'
import { fetchConfig } from '../lib/program'
import { href } from '../router'

export function How() {
  const program = useProgram()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [cfg, setCfg] = useState<any>(null)
  useEffect(() => {
    fetchConfig(program).then(setCfg).catch(() => {})
  }, [program])
  const p = cfg?.params
  const pct = (bps?: number) => (bps === undefined ? '…' : `${bps / 100}%`)
  const big = (v?: { toString(): string }) => (v ? BigInt(v.toString()) : 0n)
  const supply = p ? Number(big(p.tokenTotalSupply)) / 1e6 : 0
  const curveShare = p ? (Number(big(p.curveTokenSupply)) / Number(big(p.tokenTotalSupply))) * 100 : 0

  return (
    <div className="container" style={{ maxWidth: 860 }}>
      <div className="panel" style={{ display: 'grid', gap: 18 }}>
        <h1>How it works</h1>

        <section>
          <h2>1. Launch</h2>
          <p className="muted">
            Anyone can launch a token in one transaction. The program mints the entire supply
            {p && ` (${supply.toLocaleString('en-US')} tokens)`} into the bonding curve, then permanently revokes the
            mint authority and freezes the metadata. There is no freeze authority, no presale and no team allocation.
          </p>
        </section>

        <section>
          <h2>2. Bonding curve</h2>
          <p className="muted">
            The price follows a constant-product curve: every buy raises it, every sell lowers it. {p && `${curveShare.toFixed(1)}%`} of
            the supply is sold on the curve; the rest is reserved for the Raydium pool. Each trade pays a{' '}
            {p ? pct(p.protocolFeeBps + p.creatorFeeBps) : '…'} fee: {pct(p?.creatorFeeBps)} goes to the token's creator and{' '}
            {pct(p?.protocolFeeBps)} to the platform.
          </p>
        </section>

        <section>
          <h2>3. 🔒 Sell Lock</h2>
          <p className="muted">
            The creator can choose a Sell Lock of 5 minutes to 24 hours. Until it expires, nobody — the creator included —
            can sell to the curve. Buying is always open. Snipers who buy in the first block cannot dump on everyone who
            follows, so early buyers are people who believe in the token. The lock is enforced by the curve program itself,
            so it cannot be bypassed and needs no special token extension. Graduation also waits for the lock.
          </p>
        </section>

        <section>
          <h2>4. 🛡️ Creator Lock</h2>
          <p className="muted">
            A creator may buy at launch, at the lowest price. They can lock that buy for 1 to 90 days: the program holds the
            tokens and only releases them when the lock ends. Buyers see the lock as a badge on the token.
          </p>
        </section>

        <section>
          <h2>5. 🎓 Graduation to Raydium</h2>
          <p className="muted">
            When every curve token has been sold, anyone can trigger graduation. The raised SOL
            {p && ` (minus a ${fmtSol(big(p.migrationFeeLamports), 2)} SOL migration fee and Raydium's pool costs)`} and the
            reserved tokens form a Raydium CPMM pool that opens at exactly the curve's final price; unneeded reserve tokens
            are burned. Every LP token is burned in the same transaction, so the liquidity is locked forever.
          </p>
        </section>

        <section>
          <h2>Risks</h2>
          <p className="muted">
            Tokens launched here are speculative and most go to zero. The program has not been audited. Only trade what
            you can afford to lose.
          </p>
        </section>

        <a className="btn primary" href={href.create}>
          🍀 Launch a token
        </a>
      </div>
    </div>
  )
}
