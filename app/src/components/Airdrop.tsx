import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { useState } from 'react'
import { NETWORK } from '../lib/config'

/** Devnet only: one click to get test SOL, with the web faucet as fallback. */
export function Airdrop() {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle')
  if (NETWORK !== 'devnet' || !publicKey) return null
  if (state === 'failed')
    return (
      <a className="btn sm" href="https://faucet.solana.com" target="_blank" rel="noreferrer" title="The RPC faucet is rate limited; use the web faucet">
        Faucet ↗
      </a>
    )
  return (
    <button
      className="btn sm"
      disabled={state === 'busy'}
      title="Get 1 devnet SOL for testing"
      onClick={async () => {
        setState('busy')
        try {
          const sig = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL)
          const bh = await connection.getLatestBlockhash()
          await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed')
          setState('done')
          setTimeout(() => setState('idle'), 4000)
        } catch {
          setState('failed')
        }
      }}
    >
      {state === 'busy' ? 'Airdropping…' : state === 'done' ? '+1 SOL ✓' : '🚰 Get devnet SOL'}
    </button>
  )
}
