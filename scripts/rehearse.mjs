#!/usr/bin/env node
// End-to-end devnet rehearsal against the REAL Raydium CPMM program:
// create (with Sell Lock + initial buy) -> buy -> Sell Lock refuses a sell ->
// buy the curve out -> graduation waits for the lock -> graduate -> verify the
// Raydium pool and that every LP token is burned -> claims.
//
//   NETWORK=devnet KEYPAIR=deploy.json node scripts/rehearse.mjs
//
// Needs ~5 devnet SOL on the keypair with the devnet (scaled-down) config.
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js'
import { appendFileSync } from 'node:fs'
import {
  ata22,
  buyIx,
  claimCreatorFeesIx,
  claimCreatorLockIx,
  collectProtocolFeesIx,
  connect,
  createIx,
  curveVaultOf,
  loadKeypair,
  migrateIx,
  network,
  pda,
  program,
  raydiumAccounts,
  send,
  sellIx,
  simulateError,
  statusOf,
} from './lib.mjs'

if (network() !== 'devnet') {
  console.error('The rehearsal only runs on devnet.')
  process.exit(1)
}

const SELL_LOCK = 300
const connection = connect()
const payer = loadKeypair()
const prog = program(connection, payer)
const report = []
const step = (ok, text) => {
  report.push(`${ok ? '✅' : '❌'} ${text}`)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) finish(1)
}
function finish(code) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Devnet rehearsal\n\n${report.join('\n\n')}\n`)
  }
  process.exit(code)
}
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chainTime = async () => (await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000)
const tokenBalance = async (acc) => BigInt((await connection.getTokenAccountBalance(acc).catch(() => ({ value: { amount: '0' } }))).value.amount)

const cfg = await prog.account.globalConfig.fetchNullable(pda.config())
if (!cfg) step(false, 'launchpad config exists (run the deploy workflow with config init first)')
const need = BigInt(cfg.params.initialVirtualSolReserves.toString()) * 3n + LAMPORTS_PER_SOL
const balance = BigInt(await connection.getBalance(payer.publicKey))
step(balance >= need, `payer ${payer.publicKey.toBase58()} has ${sol(balance)} SOL (needs ~${sol(need)})`)

// 1. Create with a Sell Lock and an initial buy (Creator Lock 0 = claimable at once).
const { ix: cIx, mint: mintKp } = await createIx(prog, payer.publicKey, {
  name: 'Rehearsal Luck',
  symbol: 'RLUCK',
  uri: 'https://solofluck.github.io/rehearsal.json',
  sellLockSeconds: SELL_LOCK,
  creatorLockSeconds: 0,
  initialBuyLamports: LAMPORTS_PER_SOL / 20,
})
await send(connection, payer, [cIx], [mintKp])
const mint = mintKp.publicKey
let curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
const mintInfo = await connection.getParsedAccountInfo(mint)
const parsed = mintInfo.value.data.parsed.info
step(parsed.mintAuthority === null && parsed.freezeAuthority === null, `token ${mint.toBase58()} created; mint & freeze authority revoked`)
step(BigInt(curve.creatorLockedTokens.toString()) > 0n, `initial buy held under Creator Lock (${curve.creatorLockedTokens} units)`)

// 2. A second wallet buys.
const buyer = Keypair.generate()
await send(connection, payer, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: LAMPORTS_PER_SOL / 5 })])
await send(connection, buyer, [await buyIx(prog, buyer.publicKey, mint, LAMPORTS_PER_SOL / 10)])
const bought = await tokenBalance(ata22(buyer.publicKey, mint))
step(bought > 0n, `second wallet bought ${bought} units for 0.1 SOL`)

// 3. Sell Lock refuses the sell.
const lockErr = await simulateError(connection, buyer, [await sellIx(prog, buyer.publicKey, mint, bought / 2n)])
step(lockErr === 'SellLocked', `sell during the lock is refused (${lockErr})`)

// 4. Buy the curve out.
curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
const payerBal = BigInt(await connection.getBalance(payer.publicKey))
await send(connection, payer, [await buyIx(prog, payer.publicKey, mint, payerBal - LAMPORTS_PER_SOL / 5)])
curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
step(statusOf(curve.status) === 'complete', `curve completed with ${sol(curve.realSolReserves)} SOL raised`)
const buyErr = await simulateError(connection, buyer, [await buyIx(prog, buyer.publicKey, mint, LAMPORTS_PER_SOL / 100)])
step(buyErr === 'CurveComplete', `buying a completed curve is refused (${buyErr})`)

// 5. Graduation waits for the Sell Lock.
const early = await migrateIx(prog, payer.publicKey, mint, cfg)
const earlyErr = await simulateError(connection, payer, [early.ix], [early.pool])
const unlockAt = Number(curve.sellUnlockAt)
if ((await chainTime()) < unlockAt) {
  step(earlyErr === 'SellLocked', `graduation before the lock expires is refused (${earlyErr})`)
  while ((await chainTime()) < unlockAt + 2) await sleep(10_000)
}

// 6. Graduate against the real Raydium CPMM.
const feeBefore = BigInt(await connection.getBalance(cfg.feeRecipient))
const { ix: mIx, pool } = await migrateIx(prog, payer.publicKey, mint, cfg)
const sig = await send(connection, payer, [mIx], [pool], 400_000)
curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
step(statusOf(curve.status) === 'migrated' && curve.raydiumPool.equals(pool.publicKey), `graduated to Raydium pool ${pool.publicKey.toBase58()} (${sig})`)
const poolInfo = await connection.getAccountInfo(pool.publicKey)
step(poolInfo?.owner.equals(cfg.params.raydiumCpmmProgram), 'pool account is owned by Raydium CPMM')
const lpMint = raydiumAccounts(cfg.params.raydiumCpmmProgram, pool.publicKey, mint).lpMint
const lpSupply = BigInt((await connection.getTokenSupply(lpMint)).value.amount)
const lpHeld = await tokenBalance(getAssociatedTokenAddressSync(lpMint, pda.solVault(mint), true, TOKEN_PROGRAM_ID))
// Raydium keeps 100 LP units permanently locked in the pool; everything we
// received must be gone.
step(lpHeld === 0n && lpSupply <= 100n, `every LP token burned (held ${lpHeld}, mint supply ${lpSupply})`)
step((await tokenBalance(curveVaultOf(mint))) === BigInt(curve.creatorLockedTokens.toString()), 'curve vault holds only the Creator Lock tokens')
const feeAfter = BigInt(await connection.getBalance(cfg.feeRecipient))
step(feeAfter > feeBefore || cfg.feeRecipient.equals(payer.publicKey), `fee recipient received ${sol(feeAfter - feeBefore)} SOL of migration revenue`)

// 7. The second wallet can no longer sell to the curve.
const postErr = await simulateError(connection, buyer, [await sellIx(prog, buyer.publicKey, mint, bought / 2n)])
step(postErr === 'CurveComplete', `curve sells are closed after graduation (${postErr})`)

// 8. Claims.
await send(connection, payer, [await claimCreatorLockIx(prog, payer.publicKey, mint), await claimCreatorFeesIx(prog, payer.publicKey, mint)])
curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
step(Number(curve.creatorLockedTokens) === 0 && Number(curve.creatorFeesAccrued) === 0, 'creator claimed locked tokens and trading fees')
await send(connection, payer, [await collectProtocolFeesIx(prog, mint, cfg.feeRecipient)])
curve = await prog.account.bondingCurve.fetch(pda.curve(mint))
step(Number(curve.protocolFeesAccrued) === 0, 'protocol fees collected')

report.push(`\nToken: https://solscan.io/token/${mint.toBase58()}?cluster=devnet`)
finish(0)
