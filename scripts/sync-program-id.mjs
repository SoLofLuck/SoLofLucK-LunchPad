#!/usr/bin/env node
// Points the source at a program keypair: rewrites declare_id!, Anchor.toml and
// the app's IDL address from the keypair's public key.
//
//   node scripts/sync-program-id.mjs path/to/program-keypair.json
import { Keypair } from '@solana/web3.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = process.argv[2]
if (!path) {
  console.error('usage: sync-program-id.mjs <program-keypair.json>')
  process.exit(1)
}
const id = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))).publicKey.toBase58()
const edit = (file, fn) => {
  const p = resolve(root, file)
  const before = readFileSync(p, 'utf8')
  const after = fn(before)
  if (after !== before) writeFileSync(p, after)
  console.log(`${after === before ? 'unchanged' : 'updated  '} ${file}`)
}
edit('programs/launchpad/src/lib.rs', (s) => s.replace(/declare_id!\("[^"]+"\)/, `declare_id!("${id}")`))
edit('Anchor.toml', (s) => s.replace(/^launchpad = "[^"]+"/gm, `launchpad = "${id}"`))
edit('app/src/idl/launchpad.json', (s) => s.replace(/"address": "[^"]+"/, `"address": "${id}"`))
edit('app/src/idl/launchpad.ts', (s) => s.replace(/"address": "[^"]+"/, `"address": "${id}"`))
console.log(`program id: ${id}`)
