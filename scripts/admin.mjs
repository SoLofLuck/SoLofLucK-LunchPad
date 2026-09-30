#!/usr/bin/env node
// Launchpad operator CLI.
//
//   NETWORK=devnet KEYPAIR=~/.config/solana/id.json node scripts/admin.mjs <command>
//
// Commands:
//   status                         print the config and a curve summary
//   init [feeRecipient]            one-time setup (signer must be the upgrade authority;
//                                  fee recipient defaults to the signer)
//   update '<json>'                change params, e.g. '{"protocolFeeBps":80}'
//   pause | unpause                stop/allow create + buy (sell, claims, migrate stay open)
//   set-fee-recipient <pubkey>
//   transfer-admin <pubkey>        step 1 of the admin handover
//   accept-admin                   step 2, signed by the new admin
//   collect-fees                   push accrued protocol fees of every curve to the fee recipient
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { ammConfigPda, BN, connect, defaultParams, loadKeypair, network, pda, program, send, statusOf } from './lib.mjs'

const USAGE =
  'commands: status | init [feeRecipient] | update <json> | pause | unpause | set-fee-recipient <pk> | transfer-admin <pk> | accept-admin | collect-fees'
const [cmd, arg] = process.argv.slice(2)
if (!cmd) {
  console.log(USAGE)
  process.exit(0)
}
const net = network()
const connection = connect()
const kp = loadKeypair()
const prog = program(connection, kp)
const admin = { admin: kp.publicKey, config: pda.config() }

async function run(ix, label) {
  const sig = await send(connection, kp, [await ix])
  console.log(`${label}: ${sig}`)
}

const show = (v) => (v instanceof PublicKey ? v.toBase58() : BN.isBN(v) ? v.toString() : v)

switch (cmd) {
  case 'status': {
    const cfg = await prog.account.globalConfig.fetchNullable(pda.config())
    if (!cfg) {
      console.log(`No config yet on ${net} for program ${prog.programId.toBase58()}. Run: init [feeRecipient]`)
      break
    }
    console.log({
      network: net,
      program: prog.programId.toBase58(),
      admin: show(cfg.admin),
      pendingAdmin: show(cfg.pendingAdmin),
      feeRecipient: show(cfg.feeRecipient),
      paused: cfg.paused,
      params: Object.fromEntries(Object.entries(cfg.params).map(([k, v]) => [k, show(v)])),
    })
    const curves = await prog.account.bondingCurve.all()
    const by = {}
    let fees = 0n
    for (const c of curves) {
      by[statusOf(c.account.status)] = (by[statusOf(c.account.status)] ?? 0) + 1
      fees += BigInt(c.account.protocolFeesAccrued.toString())
    }
    console.log(`curves: ${curves.length}`, by, `uncollected protocol fees: ${Number(fees) / 1e9} SOL`)
    break
  }
  case 'init': {
    const recipient = arg ? new PublicKey(arg) : kp.publicKey
    const params = defaultParams(net)
    // Raydium's fee tiers are AMM configs at PDA indexes 0, 1, 2...; use the
    // first one that exists on this cluster.
    let found = false
    for (let i = 0; i < 16 && !found; i++) {
      const candidate = ammConfigPda(params.raydiumCpmmProgram, i)
      const info = await connection.getAccountInfo(candidate)
      if (info && info.owner.equals(params.raydiumCpmmProgram)) {
        params.raydiumAmmConfig = candidate
        found = true
        console.log(`Using Raydium AMM config #${i}: ${candidate.toBase58()}`)
      }
    }
    if (!found) throw new Error(`No Raydium CPMM AMM config found on ${net}`)
    await run(
      prog.methods
        .initializeConfig(recipient, params)
        .accountsPartial({ ...admin, programData: pda.programData(), systemProgram: SystemProgram.programId })
        .instruction(),
      'initialized',
    )
    break
  }
  case 'update': {
    const cfg = await prog.account.globalConfig.fetch(pda.config())
    const patch = JSON.parse(arg ?? '{}')
    const params = { ...cfg.params }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in params)) throw new Error(`unknown param ${k}`)
      params[k] = params[k] instanceof PublicKey ? new PublicKey(v) : BN.isBN(params[k]) ? new BN(String(v)) : v
    }
    await run(prog.methods.updateConfig(params).accountsPartial(admin).instruction(), 'updated')
    break
  }
  case 'pause':
  case 'unpause':
    await run(prog.methods.setPaused(cmd === 'pause').accountsPartial(admin).instruction(), cmd)
    break
  case 'set-fee-recipient':
    await run(prog.methods.setFeeRecipient(new PublicKey(arg)).accountsPartial(admin).instruction(), 'fee recipient set')
    break
  case 'transfer-admin':
    await run(prog.methods.transferAdmin(new PublicKey(arg)).accountsPartial(admin).instruction(), 'handover started')
    break
  case 'accept-admin':
    await run(
      prog.methods.acceptAdmin().accountsPartial({ newAdmin: kp.publicKey, config: pda.config() }).instruction(),
      'admin accepted',
    )
    break
  case 'collect-fees': {
    const cfg = await prog.account.globalConfig.fetch(pda.config())
    const curves = await prog.account.bondingCurve.all()
    for (const c of curves) {
      if (BigInt(c.account.protocolFeesAccrued.toString()) === 0n) continue
      await run(
        prog.methods
          .collectProtocolFees()
          .accountsPartial({
            config: pda.config(),
            curve: c.publicKey,
            solVault: pda.solVault(c.account.mint),
            feeRecipient: cfg.feeRecipient,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        `collected ${Number(c.account.protocolFeesAccrued) / 1e9} SOL from ${c.account.mint.toBase58()}`,
      )
    }
    break
  }
  default:
    console.log(USAGE)
    process.exit(1)
}
