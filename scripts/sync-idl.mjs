#!/usr/bin/env node
// Copies the IDL and TypeScript types produced by `anchor idl build` into the
// web app, which ships them so the site builds without a Rust toolchain.
//
//   anchor idl build -p launchpad -o target/idl/launchpad.json -t target/types/launchpad.ts
//   node scripts/sync-idl.mjs          # copy
//   node scripts/sync-idl.mjs --check  # CI: fail if the app's copy is stale
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pairs = [
  ['target/idl/launchpad.json', 'app/src/idl/launchpad.json'],
  ['target/types/launchpad.ts', 'app/src/idl/launchpad.ts'],
]
const check = process.argv.includes('--check')
let stale = false
for (const [from, to] of pairs) {
  const src = resolve(root, from)
  if (!existsSync(src)) {
    console.error(`missing ${from}: run anchor idl build first`)
    process.exit(1)
  }
  const want = readFileSync(src, 'utf8')
  const dst = resolve(root, to)
  const have = existsSync(dst) ? readFileSync(dst, 'utf8') : ''
  if (want === have) continue
  if (check) {
    console.error(`${to} is out of date with the program; run: node scripts/sync-idl.mjs`)
    stale = true
  } else {
    writeFileSync(dst, want)
    console.log(`updated ${to}`)
  }
}
process.exit(stale ? 1 : 0)
