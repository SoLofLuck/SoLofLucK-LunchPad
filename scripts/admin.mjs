#!/usr/bin/env node
// Launchpad operator CLI.
//
//   NETWORK=devnet KEYPAIR=~/.config/solana/id.json node scripts/admin.mjs <command>
//
// Commands:
//   status                         print the config and a curve summary
//   init <feeRecipient>            one-time setup (signer must be the upgrade authority)
//   update '<json>'                change params, e.g. '{"protocolFeeBps":80}'
//   pause | unpause                stop/allow create + buy (sell, claims, migrate stay open)
//   set-fee-recipient <pubkey>
//   transfer-admin <pubkey>        step 1 of the admin handover
//   accept-admin                   step 2, signed by the new admin
//   collect-fees                   push accrued protocol fees of every curve to the fee recipient
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { ammConfigPda, BN, connect, loadKeypair, network, pda, program, RAYDIUM, send, statusOf } from './lib.mjs'

const SOL = 1_000_000_000n
const TOK = 1_000_000n

/** Defaults: pump.fun-style economics, ~85 SOL to graduate. */
function defaultParams(net) {
  const r = RAYDIUM[net]
  return {
    protocolFeeBps: 70,
    creatorFeeBps: 30,
    tokenTotalSupply: new BN((1_000_000_000n * TOK).toString()),
    curveTokenSupply: new BN((793_100_000n * TOK).toString()),
    initialVirtualTokenReserves: new BN((1_073_000_000n * TOK).toString()),
    initialVirtualSolReserves: new BN((30n * SOL).toString()),
    migrationFeeLamports: new BN(SOL.toString()),
    // Raydium's 0.15 SOL creation fee + ~0.05 SOL of pool rent, with margin.
    poolCreationBudgetLamports: new BN(((SOL * 25n) / 100n).toString()),
    raydiumCpmmProgram: r.cpmm,
    raydiumAmmConfig: ammConfigPda(r.cpmm, 0),
    raydiumCreatePoolFee: r.createPoolFee,
  }
}

const USAGE =
  'commands: status | init <feeRecipient> | update <json> | pause | unpause | set-fee-recipient <pk> | transfer-admin <pk> | accept-admin | collect-fees'
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
      console.log(`No config yet on ${net} for program ${prog.programId.toBase58()}. Run: init <feeRecipient>`)
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
    if (!arg) throw new Error('usage: init <feeRecipient>')
    const params = defaultParams(net)
    const ammInfo = await connection.getAccountInfo(params.raydiumAmmConfig)
    if (!ammInfo) throw new Error(`Raydium AMM config ${params.raydiumAmmConfig.toBase58()} not found on ${net}`)
    await run(
      prog.methods
        .initializeConfig(new PublicKey(arg), params)
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
