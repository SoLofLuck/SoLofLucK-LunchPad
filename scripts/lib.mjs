// Shared helpers for the operator scripts (admin, crank, checks).
import anchor from '@coral-xyz/anchor'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  clusterApiUrl,
} from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const { AnchorProvider, Program, Wallet, BN } = anchor
export { BN }

const here = dirname(fileURLToPath(import.meta.url))
export const IDL = JSON.parse(readFileSync(resolve(here, '../app/src/idl/launchpad.json'), 'utf8'))
const IDS = JSON.parse(readFileSync(resolve(here, '../app/src/program-ids.json'), 'utf8'))
export const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || IDS[process.env.NETWORK || 'devnet'] || IDL.address)

/** Raydium CPMM per cluster (from @raydium-io/raydium-sdk-v2). */
export const RAYDIUM = {
  devnet: {
    cpmm: new PublicKey('DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb'),
    createPoolFee: new PublicKey('3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy'),
  },
  'mainnet-beta': {
    cpmm: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
    createPoolFee: new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'),
  },
}

export function ammConfigPda(cpmm, index = 0) {
  const idx = Buffer.alloc(2)
  idx.writeUInt16BE(index)
  return PublicKey.findProgramAddressSync([Buffer.from('amm_config'), idx], cpmm)[0]
}

export function network() {
  const n = process.env.NETWORK || 'devnet'
  if (n !== 'devnet' && n !== 'mainnet-beta') throw new Error(`NETWORK must be devnet or mainnet-beta, got ${n}`)
  return n
}

export function loadKeypair(path = process.env.KEYPAIR || `${homedir()}/.config/solana/id.json`) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))))
}

export function connect() {
  return new Connection(process.env.RPC_URL || clusterApiUrl(network()), 'confirmed')
}

export function program(connection, keypair) {
  const provider = new AnchorProvider(connection, new Wallet(keypair ?? Keypair.generate()), { commitment: 'confirmed' })
  return new Program({ ...IDL, address: PROGRAM_ID.toBase58() }, provider)
}

export const pda = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0],
  curve: (mint) => PublicKey.findProgramAddressSync([Buffer.from('curve'), mint.toBuffer()], PROGRAM_ID)[0],
  solVault: (mint) => PublicKey.findProgramAddressSync([Buffer.from('sol_vault'), mint.toBuffer()], PROGRAM_ID)[0],
  programData: () =>
    PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0],
}

export function raydiumAccounts(cpmm, pool, mint) {
  const p = (seeds) => PublicKey.findProgramAddressSync(seeds, cpmm)[0]
  const mintFirst = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0
  const [m0, m1] = mintFirst ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint]
  return {
    authority: p([Buffer.from('vault_and_lp_mint_auth_seed')]),
    lpMint: p([Buffer.from('pool_lp_mint'), pool.toBuffer()]),
    vault0: p([Buffer.from('pool_vault'), pool.toBuffer(), m0.toBuffer()]),
    vault1: p([Buffer.from('pool_vault'), pool.toBuffer(), m1.toBuffer()]),
    observation: p([Buffer.from('observation'), pool.toBuffer()]),
  }
}

/** Builds the migrate instruction. `cfg` is the on-chain GlobalConfig. */
export async function migrateIx(prog, payer, mint, cfg, pool = Keypair.generate()) {
  const cpmm = cfg.params.raydiumCpmmProgram
  const r = raydiumAccounts(cpmm, pool.publicKey, mint)
  const vault = pda.solVault(mint)
  const curve = pda.curve(mint)
  const ix = await prog.methods
    .migrate()
    .accountsPartial({
      payer,
      config: pda.config(),
      curve,
      mint,
      curveVault: getAssociatedTokenAddressSync(mint, curve, true, TOKEN_2022_PROGRAM_ID),
      solVault: vault,
      vaultToken: getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID),
      wsolMint: NATIVE_MINT,
      vaultWsol: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID),
      feeRecipient: cfg.feeRecipient,
      cpmmProgram: cpmm,
      ammConfig: cfg.params.raydiumAmmConfig,
      raydiumAuthority: r.authority,
      poolState: pool.publicKey,
      lpMint: r.lpMint,
      vaultLp: getAssociatedTokenAddressSync(r.lpMint, vault, true, TOKEN_PROGRAM_ID),
      token0Vault: r.vault0,
      token1Vault: r.vault1,
      createPoolFee: cfg.params.raydiumCreatePoolFee,
      observationState: r.observation,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      splTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction()
  return { ix, pool }
}

export async function send(connection, payer, ixs, extraSigners = [], units = 400_000) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }),
    ...ixs,
  )
  tx.feePayer = payer.publicKey
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(payer, ...extraSigners)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw new Error(`${sig} failed: ${JSON.stringify(res.value.err)}`)
  return sig
}

export const statusOf = (s) => Object.keys(s)[0]

const SOL = 1_000_000_000n
const TOK = 1_000_000n

/**
 * Defaults. Mainnet: pump.fun-style economics, ~85 SOL to graduate. Devnet:
 * the same curve shape scaled down 20x (~4.25 SOL to graduate) so the full
 * lifecycle, Raydium graduation included, can be rehearsed with faucet SOL.
 */
export function defaultParams(net) {
  const r = RAYDIUM[net]
  const devnet = net === 'devnet'
  return {
    protocolFeeBps: 70,
    creatorFeeBps: 30,
    tokenTotalSupply: new BN((1_000_000_000n * TOK).toString()),
    curveTokenSupply: new BN((793_100_000n * TOK).toString()),
    initialVirtualTokenReserves: new BN((1_073_000_000n * TOK).toString()),
    initialVirtualSolReserves: new BN((devnet ? (SOL * 3n) / 2n : 30n * SOL).toString()),
    migrationFeeLamports: new BN((devnet ? SOL / 20n : SOL).toString()),
    // Raydium's 0.15 SOL creation fee + ~0.05 SOL of pool rent, with margin.
    poolCreationBudgetLamports: new BN(((SOL * 25n) / 100n).toString()),
    raydiumCpmmProgram: r.cpmm,
    raydiumAmmConfig: ammConfigPda(r.cpmm, 0),
    raydiumCreatePoolFee: r.createPoolFee,
  }
}


// --- Instruction builders used by the rehearsal -------------------------------------

const ata22 = (owner, mint) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)
const curveVaultOf = (mint) => ata22(pda.curve(mint), mint)

export async function createIx(prog, creator, args) {
  const mint = Keypair.generate()
  const ix = await prog.methods
    .create({
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      sellLockSeconds: new BN(args.sellLockSeconds),
      creatorLockSeconds: new BN(args.creatorLockSeconds),
      initialBuyLamports: new BN(String(args.initialBuyLamports)),
      minTokensOut: new BN(0),
    })
    .accountsPartial({
      creator,
      config: pda.config(),
      mint: mint.publicKey,
      curve: pda.curve(mint.publicKey),
      solVault: pda.solVault(mint.publicKey),
      curveVault: curveVaultOf(mint.publicKey),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return { ix, mint }
}

export function buyIx(prog, buyer, mint, maxCost, minOut = 1n) {
  return prog.methods
    .buy(new BN(String(maxCost)), new BN(String(minOut)))
    .accountsPartial({
      buyer,
      config: pda.config(),
      curve: pda.curve(mint),
      solVault: pda.solVault(mint),
      mint,
      curveVault: curveVaultOf(mint),
      buyerTokenAccount: ata22(buyer, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function sellIx(prog, seller, mint, amount, minOut = 0n) {
  return prog.methods
    .sell(new BN(String(amount)), new BN(String(minOut)))
    .accountsPartial({
      seller,
      curve: pda.curve(mint),
      solVault: pda.solVault(mint),
      mint,
      curveVault: curveVaultOf(mint),
      sellerTokenAccount: ata22(seller, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function claimCreatorFeesIx(prog, creator, mint) {
  return prog.methods
    .claimCreatorFees()
    .accountsPartial({ creator, curve: pda.curve(mint), solVault: pda.solVault(mint), systemProgram: SystemProgram.programId })
    .instruction()
}

export function claimCreatorLockIx(prog, creator, mint) {
  return prog.methods
    .claimCreatorLock()
    .accountsPartial({
      creator,
      curve: pda.curve(mint),
      mint,
      curveVault: curveVaultOf(mint),
      creatorTokenAccount: ata22(creator, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function collectProtocolFeesIx(prog, mint, feeRecipient) {
  return prog.methods
    .collectProtocolFees()
    .accountsPartial({
      config: pda.config(),
      curve: pda.curve(mint),
      solVault: pda.solVault(mint),
      feeRecipient,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

/** Simulates; returns the IDL error name the program failed with, or null on success. */
export async function simulateError(connection, payer, ixs, signers = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs)
  tx.feePayer = payer.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(payer, ...signers)
  const sim = await connection.simulateTransaction(tx)
  if (!sim.value.err) return null
  const logs = (sim.value.logs ?? []).join('\n')
  const m = logs.match(/Error Code: (\w+)/)
  return m ? m[1] : JSON.stringify(sim.value.err)
}

export { ata22, curveVaultOf }
