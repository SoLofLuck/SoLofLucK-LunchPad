#!/usr/bin/env node
// Points the source at a program ID.
//
//   node scripts/sync-program-id.mjs <keypair.json | pubkey> [--network devnet|mainnet-beta] [--source]
//
// Always records the ID in app/src/program-ids.json for the network.
// With --source it also rewrites declare_id!, Anchor.toml and the app IDL
// address (the program is compiled with declare_id!, so CI does this before
// every build; the committed source tracks the devnet deployment).
import { Keypair, PublicKey } from '@solana/web3.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--network')
const netIdx = args.indexOf('--network')
const network = netIdx >= 0 ? args[netIdx + 1] : 'devnet'
const source = args.includes('--source')
if (!target || !['devnet', 'mainnet-beta'].includes(network)) {
  console.error('usage: sync-program-id.mjs <keypair.json | pubkey> [--network devnet|mainnet-beta] [--source]')
  process.exit(1)
}
const id = existsSync(target)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(target, 'utf8')))).publicKey.toBase58()
  : new PublicKey(target).toBase58()

const edit = (file, fn) => {
  const p = resolve(root, file)
  const before = readFileSync(p, 'utf8')
  const after = fn(before)
  if (after !== before) writeFileSync(p, after)
  console.log(`${after === before ? 'unchanged' : 'updated  '} ${file}`)
}
edit('app/src/program-ids.json', (s) => {
  const ids = JSON.parse(s)
  ids[network] = id
  return `${JSON.stringify(ids, null, 2)}\n`
})
if (source) {
  edit('programs/launchpad/src/lib.rs', (s) => s.replace(/declare_id!\("[^"]+"\)/, `declare_id!("${id}")`))
  edit('Anchor.toml', (s) => s.replace(/^launchpad = "[^"]+"/gm, `launchpad = "${id}"`))
  edit('app/src/idl/launchpad.json', (s) => s.replace(/"address": "[^"]+"/, `"address": "${id}"`))
  edit('app/src/idl/launchpad.ts', (s) => s.replace(/"address": "[^"]+"/, `"address": "${id}"`))
}
console.log(`${network} program id: ${id}`)
