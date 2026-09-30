// Mirrors the Rust unit tests in programs/launchpad/src/math.rs.
// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBuy, applySell, feeCeil, quoteBuy, quoteSell, type Reserves } from './curve.ts'

const SOL = 1_000_000_000n
const TOK = 1_000_000n
const fresh = (): Reserves => ({
  virtualSol: 30n * SOL,
  virtualToken: 1_073_000_000n * TOK,
  realSol: 0n,
  realToken: 793_100_000n * TOK,
})

test('fee rounds up', () => {
  assert.equal(feeCeil(10_000n, 100), 100n)
  assert.equal(feeCeil(10_001n, 100), 101n)
  assert.equal(feeCeil(1n, 1), 1n)
})

test('buy then sell never profits', () => {
  const r = fresh()
  for (const amount of [1_000n, SOL / 100n, SOL, 10n * SOL, 50n * SOL]) {
    const b = quoteBuy(r, amount, 70, 30)!
    const r2 = applyBuy(r, b)
    const s = quoteSell(r2, b.tokensOut, 70, 30)!
    assert.ok(s.netToSeller <= amount)
    assert.ok(s.solOut <= b.solIn)
    assert.equal(applySell(r2, b.tokensOut, s).realToken, r.realToken)
  }
})

test('oversized buy caps and completes at ~85 SOL', () => {
  const r = fresh()
  const b = quoteBuy(r, 1_000n * SOL, 70, 30)!
  assert.ok(b.completesCurve)
  assert.equal(b.tokensOut, r.realToken)
  const r2 = applyBuy(r, b)
  assert.equal(r2.realToken, 0n)
  assert.ok(r2.realSol > 84n * SOL && r2.realSol < 86n * SOL)
})

// Pinned against the Rust implementation: 1 SOL at 0.7% + 0.3% fees.
test('1 SOL buy matches the program exactly', () => {
  const b = quoteBuy(fresh(), SOL, 70, 30)!
  assert.equal(b.fees.protocol, 7_000_000n)
  assert.equal(b.fees.creator, 3_000_000n)
  assert.equal(b.solIn, 990_000_000n)
  // 1_073_000_000e6 * 0.99e9 / (30e9 + 0.99e9), floored.
  assert.equal(b.tokensOut, (1_073_000_000n * TOK * 990_000_000n) / (30n * SOL + 990_000_000n))
})
