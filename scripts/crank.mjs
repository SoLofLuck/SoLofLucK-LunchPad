#!/usr/bin/env node
// Graduates every completed curve whose Sell Lock has expired. Anyone can run
// this; it only pays network fees (the temporary token accounts' rent is
// refunded in the same transaction). Scheduled from .github/workflows/crank.yml.
//
//   NETWORK=devnet KEYPAIR=path/to/key.json node scripts/crank.mjs
import { connect, loadKeypair, migrateIx, pda, program, send, statusOf } from './lib.mjs'

const connection = connect()
const kp = loadKeypair()
const prog = program(connection, kp)
const cfg = await prog.account.globalConfig.fetchNullable(pda.config())
if (!cfg) {
  console.log('No launchpad config on this network; nothing to do.')
  process.exit(0)
}
const now = Math.floor(Date.now() / 1000)
const ready = (await prog.account.bondingCurve.all()).filter(
  (c) => statusOf(c.account.status) === 'complete' && Number(c.account.sellUnlockAt) <= now,
)
console.log(`${ready.length} curve(s) ready to graduate`)
let failed = 0
for (const c of ready) {
  const mint = c.account.mint
  try {
    const { ix, pool } = await migrateIx(prog, kp.publicKey, mint, cfg)
    const sig = await send(connection, kp, [ix], [pool], 400_000)
    console.log(`graduated ${mint.toBase58()} -> pool ${pool.publicKey.toBase58()} (${sig})`)
  } catch (e) {
    failed++
    console.error(`failed to graduate ${mint.toBase58()}: ${e.message}`)
  }
}
process.exit(failed ? 1 : 0)
