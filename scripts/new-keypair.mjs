#!/usr/bin/env node
// Creates a Solana keypair file without installing the Solana CLI.
//
//   node scripts/new-keypair.mjs deploy-key.json
//
// The file content (a JSON array of 64 numbers) is what goes into the
// LAUNCHPAD_DEPLOY_KEY GitHub secret. Keep an offline backup: this key is the
// program's upgrade authority and the launchpad admin. Never commit it.
import { Keypair } from '@solana/web3.js'
import { existsSync, writeFileSync } from 'node:fs'

const out = process.argv[2] || 'deploy-key.json'
if (existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite it.`)
  process.exit(1)
}
const kp = Keypair.generate()
writeFileSync(out, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
console.log(`Wrote ${out}`)
console.log(`Public address: ${kp.publicKey.toBase58()}`)
console.log('Next: fund it with devnet SOL at https://faucet.solana.com, then paste the file content')
console.log('into GitHub -> Settings -> Secrets and variables -> Actions -> LAUNCHPAD_DEPLOY_KEY.')
