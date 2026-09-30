import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import idl from '../idl/launchpad.json'

// Lessons carried over from the SoLofLuck main site:
// - Sign with the wallet but broadcast over OUR connection. The adapter's
//   sendTransaction broadcasts to whatever network the wallet is set to, which
//   silently sends devnet transactions to the wrong cluster.
// - Always attach a small priority fee; unprioritised transactions get dropped
//   under load and the blockhash expires.
// - Size the compute limit by simulating; if simulation gives no number, ask
//   for the ceiling rather than a guess that might be too small.
// - Re-broadcast until confirmed or the blockhash expires.

export interface TxWallet {
  publicKey: PublicKey
  signTransaction: <T extends Transaction>(tx: T) => Promise<T>
}

const PRIORITY_MICRO_LAMPORTS = 20_000
const CU_MAX = 1_400_000
const CU_HEADROOM = 1.25

const errorsByCode = new Map<number, string>(
  (idl.errors as { code: number; msg: string }[]).map((e) => [e.code, e.msg]),
)

/** Turns a raw RPC / program error into something a person can act on. */
export function explainError(err: unknown, logs?: string[] | null): string {
  const text = err instanceof Error ? err.message : String(err)
  const hay = [text, ...(logs ?? [])].join('\n')
  const hex = hay.match(/custom program error: 0x([0-9a-f]+)/i)
  if (hex) {
    const code = parseInt(hex[1], 16)
    const msg = errorsByCode.get(code)
    if (msg) return msg
  }
  const anchor = hay.match(/Error Number: (\d+)\. Error Message: ([^\n]+)/)
  if (anchor) return errorsByCode.get(Number(anchor[1])) ?? anchor[2]
  if (/User rejected|rejected the request/i.test(hay)) return 'You rejected the transaction in your wallet.'
  if (/insufficient (funds|lamports)|Attempt to debit an account but found no record/i.test(hay))
    return 'Not enough SOL in your wallet for this transaction and its fees.'
  if (/block height exceeded|expired/i.test(hay)) return 'The network did not confirm the transaction in time. Please try again.'
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

async function computeLimit(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
): Promise<number> {
  try {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_MAX }),
      ...ixs,
    )
    tx.feePayer = payer
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    const sim = await connection.simulateTransaction(tx)
    if (sim.value.err) {
      throw new SimulationError(explainError(JSON.stringify(sim.value.err), sim.value.logs), sim.value.logs)
    }
    const used = sim.value.unitsConsumed ?? 0
    return used > 0 ? Math.min(CU_MAX, Math.ceil(used * CU_HEADROOM) + 5_000) : CU_MAX
  } catch (e) {
    if (e instanceof SimulationError) throw e
    return CU_MAX
  }
}

export class SimulationError extends Error {
  logs: string[] | null
  constructor(msg: string, logs: string[] | null) {
    super(msg)
    this.logs = logs
  }
}

/**
 * Simulates, signs (extra keypairs first, then the wallet), broadcasts and
 * confirms. Returns the signature. Throws an Error with a readable message.
 */
export async function sendTx(
  connection: Connection,
  wallet: TxWallet,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
  onStatus?: (s: string) => void,
): Promise<string> {
  onStatus?.('Preparing…')
  const units = await computeLimit(connection, wallet.publicKey, ixs)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  let tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICRO_LAMPORTS }),
    ...ixs,
  )
  if (signers.length) tx.partialSign(...signers)

  onStatus?.('Approve in your wallet…')
  try {
    tx = await wallet.signTransaction(tx)
  } catch (e) {
    throw new Error(explainError(e))
  }

  const raw = tx.serialize()
  onStatus?.('Sending…')
  let signature: string
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
  } catch (e) {
    throw new Error(explainError(e))
  }

  onStatus?.('Confirming…')
  let done = false
  const resend = (async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 2_000))
      if (done) break
      connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
    }
  })()
  try {
    const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (res.value.err) {
      const detail = await connection
        .getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
        .catch(() => null)
      throw new Error(explainError(JSON.stringify(res.value.err), detail?.meta?.logMessages))
    }
  } catch (e) {
    throw new Error(explainError(e))
  } finally {
    done = true
    await resend
  }
  return signature
}
