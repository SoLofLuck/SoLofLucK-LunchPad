#!/usr/bin/env node
// The graduation transaction carries ~27 accounts. A legacy Solana transaction
// is capped at 1232 bytes; this check builds the real instruction offline and
// fails CI if a change pushes it over (it would then need a lookup table).
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import { migrateIx, program, RAYDIUM, ammConfigPda } from './lib.mjs'
import { Connection } from '@solana/web3.js'

const LIMIT = 1232
const prog = program(new Connection('http://127.0.0.1:1'))
const payer = Keypair.generate()
let worst = 0
for (const net of ['devnet', 'mainnet-beta']) {
  const cfg = {
    feeRecipient: Keypair.generate().publicKey,
    params: {
      raydiumCpmmProgram: RAYDIUM[net].cpmm,
      raydiumAmmConfig: ammConfigPda(RAYDIUM[net].cpmm),
      raydiumCreatePoolFee: RAYDIUM[net].createPoolFee,
    },
  }
  const mint = Keypair.generate().publicKey
  const { ix, pool } = await migrateIx(prog, payer.publicKey, mint, cfg)
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    ix,
  )
  tx.feePayer = payer.publicKey
  tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 7)).toBase58()
  tx.sign(payer, pool)
  const size = tx.serialize().length
  worst = Math.max(worst, size)
  console.log(`${net}: migrate transaction is ${size} bytes (limit ${LIMIT}), ${ix.keys.length} accounts`)
}
if (worst > LIMIT) {
  console.error('The migrate transaction no longer fits; add an address lookup table.')
  process.exit(1)
}
