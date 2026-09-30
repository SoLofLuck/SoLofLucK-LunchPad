// A 1:1 mirror of programs/launchpad/src/math.rs, in bigint. Quotes shown in
// the UI must match what the program will do, rounding included, so this file
// must change whenever math.rs does (curve.test.ts pins the shared cases).

export const LAMPORTS_PER_SOL = 1_000_000_000n
export const TOKEN_DECIMALS = 6
export const TOKEN_UNIT = 1_000_000n
const BPS = 10_000n

export interface Reserves {
  virtualSol: bigint
  virtualToken: bigint
  realSol: bigint
  realToken: bigint
}

export interface Fees {
  protocol: bigint
  creator: bigint
}

export interface BuyQuote {
  solIn: bigint
  fees: Fees
  totalCost: bigint
  tokensOut: bigint
  completesCurve: boolean
}

export interface SellQuote {
  solOut: bigint
  fees: Fees
  netToSeller: bigint
}

export function feeCeil(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps) + BPS - 1n) / BPS
}

function feesFor(amount: bigint, protocolBps: number, creatorBps: number): Fees {
  return { protocol: feeCeil(amount, protocolBps), creator: feeCeil(amount, creatorBps) }
}

export function tokensOutForSol(r: Reserves, solIn: bigint): bigint {
  return (r.virtualToken * solIn) / (r.virtualSol + solIn)
}

export function solInForTokens(r: Reserves, tokensOut: bigint): bigint | null {
  if (tokensOut >= r.virtualToken) return null
  const num = r.virtualSol * tokensOut
  const den = r.virtualToken - tokensOut
  return (num + den - 1n) / den
}

export function quoteBuy(
  r: Reserves,
  maxTotal: bigint,
  protocolBps: number,
  creatorBps: number,
): BuyQuote | null {
  if (maxTotal <= 0n) return null
  let fees = feesFor(maxTotal, protocolBps, creatorBps)
  let solIn = maxTotal - fees.protocol - fees.creator
  if (solIn < 0n) return null
  const tokensOut = tokensOutForSol(r, solIn)
  if (tokensOut < r.realToken) {
    return { solIn, fees, totalCost: maxTotal, tokensOut, completesCurve: false }
  }
  const capped = r.realToken
  const needed = solInForTokens(r, capped)
  if (needed === null) return null
  solIn = needed
  fees = feesFor(solIn, protocolBps, creatorBps)
  return {
    solIn,
    fees,
    totalCost: solIn + fees.protocol + fees.creator,
    tokensOut: capped,
    completesCurve: true,
  }
}

export function quoteSell(
  r: Reserves,
  tokensIn: bigint,
  protocolBps: number,
  creatorBps: number,
): SellQuote | null {
  if (tokensIn <= 0n) return null
  let solOut = (r.virtualSol * tokensIn) / (r.virtualToken + tokensIn)
  if (solOut > r.realSol) solOut = r.realSol
  const fees = feesFor(solOut, protocolBps, creatorBps)
  const netToSeller = solOut - fees.protocol - fees.creator
  if (netToSeller < 0n) return null
  return { solOut, fees, netToSeller }
}

export function applyBuy(r: Reserves, q: BuyQuote): Reserves {
  return {
    virtualSol: r.virtualSol + q.solIn,
    virtualToken: r.virtualToken - q.tokensOut,
    realSol: r.realSol + q.solIn,
    realToken: r.realToken - q.tokensOut,
  }
}

export function applySell(r: Reserves, tokensIn: bigint, q: SellQuote): Reserves {
  return {
    virtualSol: r.virtualSol - q.solOut,
    virtualToken: r.virtualToken + tokensIn,
    realSol: r.realSol - q.solOut,
    realToken: r.realToken + tokensIn,
  }
}

/** Price of one whole token, in SOL. */
export function priceSol(virtualSol: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0
  return Number(virtualSol) / 1e9 / (Number(virtualToken) / 1e6)
}

/** Slippage-adjusted minimum: `amount * (1 - bps/10000)`, rounded down. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * (BPS - BigInt(slippageBps))) / BPS
}

/** Price impact of a trade, in percent, from the price before and after. */
export function priceImpactPct(before: Reserves, after: Reserves): number {
  const p0 = priceSol(before.virtualSol, before.virtualToken)
  const p1 = priceSol(after.virtualSol, after.virtualToken)
  return p0 === 0 ? 0 : (Math.abs(p1 - p0) / p0) * 100
}
