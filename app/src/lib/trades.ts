import { BorshCoder, EventParser, type Program } from '@coral-xyz/anchor'
import type { Connection, PublicKey } from '@solana/web3.js'
import type { Launchpad } from '../idl/launchpad'
import { PROGRAM_ID } from './config'
import { priceSol } from './curve'

export interface TradeEvent {
  signature: string
  mint: string
  trader: string
  isBuy: boolean
  solAmount: bigint
  tokenAmount: bigint
  virtualSol: bigint
  virtualToken: bigint
  price: number
  timestamp: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrade(signature: string, d: any): TradeEvent {
  const big = (v: { toString(): string }) => BigInt(v.toString())
  const virtualSol = big(d.virtualSolReserves)
  const virtualToken = big(d.virtualTokenReserves)
  return {
    signature,
    mint: d.mint.toBase58(),
    trader: d.trader.toBase58(),
    isBuy: d.isBuy,
    solAmount: big(d.solAmount),
    tokenAmount: big(d.tokenAmount),
    virtualSol,
    virtualToken,
    price: priceSol(virtualSol, virtualToken),
    timestamp: Number(d.timestamp.toString()),
  }
}

export function tradesFromLogs(program: Program<Launchpad>, signature: string, logs: string[]): TradeEvent[] {
  const parser = new EventParser(PROGRAM_ID, program.coder as BorshCoder)
  const out: TradeEvent[] = []
  try {
    for (const ev of parser.parseLogs(logs)) {
      if (ev.name === 'trade') out.push(toTrade(signature, ev.data))
    }
  } catch {
    /* truncated or foreign logs */
  }
  return out
}

/**
 * Rebuilds a token's trade history from its transactions. Every trade writes
 * the curve account, so its signature list is the trade list. Newest first.
 */
export async function fetchTrades(
  connection: Connection,
  program: Program<Launchpad>,
  curve: PublicKey,
  limit = 400,
): Promise<TradeEvent[]> {
  const sigs = await connection.getSignaturesForAddress(curve, { limit }, 'confirmed')
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature)
  const out: TradeEvent[] = []
  for (let i = 0; i < ok.length; i += 25) {
    const batch = ok.slice(i, i + 25)
    let txs
    try {
      txs = await connection.getTransactions(batch, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    } catch {
      txs = await Promise.all(
        batch.map((s) =>
          connection.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null),
        ),
      )
    }
    txs.forEach((tx, j) => {
      const logs = tx?.meta?.logMessages
      if (logs) out.push(...tradesFromLogs(program, batch[j], logs))
    })
  }
  return out.sort((a, b) => b.timestamp - a.timestamp)
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

/** OHLC candles from trades (any order), `bucket` seconds wide. */
export function toCandles(trades: TradeEvent[], bucket: number, openPrice?: number): Candle[] {
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp)
  const candles: Candle[] = []
  let prev = openPrice ?? sorted[0]?.price ?? 0
  for (const t of sorted) {
    const time = Math.floor(t.timestamp / bucket) * bucket
    const last = candles[candles.length - 1]
    if (last && last.time === time) {
      last.high = Math.max(last.high, t.price)
      last.low = Math.min(last.low, t.price)
      last.close = t.price
    } else {
      candles.push({ time, open: prev, high: Math.max(prev, t.price), low: Math.min(prev, t.price), close: t.price })
    }
    prev = t.price
  }
  return candles
}
