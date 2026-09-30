import { BN, type Program } from '@coral-xyz/anchor'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, type TransactionInstruction } from '@solana/web3.js'
import type { Launchpad } from '../idl/launchpad'
import { configPda, curvePda, curveVault, fetchConfig, solVaultPda } from './program'

const bn = (v: bigint) => new BN(v.toString())
const ata2022 = (owner: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)

export interface CreateParams {
  name: string
  symbol: string
  uri: string
  sellLockSeconds: number
  creatorLockSeconds: number
  initialBuyLamports: bigint
  minTokensOut: bigint
}

export async function createIx(
  program: Program<Launchpad>,
  creator: PublicKey,
  p: CreateParams,
): Promise<{ ix: TransactionInstruction; mint: Keypair }> {
  const mint = Keypair.generate()
  const ix = await program.methods
    .create({
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      sellLockSeconds: new BN(p.sellLockSeconds),
      creatorLockSeconds: new BN(p.creatorLockSeconds),
      initialBuyLamports: bn(p.initialBuyLamports),
      minTokensOut: bn(p.minTokensOut),
    })
    .accountsPartial({
      creator,
      config: configPda(),
      mint: mint.publicKey,
      curve: curvePda(mint.publicKey),
      solVault: solVaultPda(mint.publicKey),
      curveVault: curveVault(mint.publicKey),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return { ix, mint }
}

export function buyIx(program: Program<Launchpad>, buyer: PublicKey, mint: PublicKey, maxCost: bigint, minOut: bigint) {
  return program.methods
    .buy(bn(maxCost), bn(minOut))
    .accountsPartial({
      buyer,
      config: configPda(),
      curve: curvePda(mint),
      solVault: solVaultPda(mint),
      mint,
      curveVault: curveVault(mint),
      buyerTokenAccount: ata2022(buyer, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function sellIx(program: Program<Launchpad>, seller: PublicKey, mint: PublicKey, amount: bigint, minOut: bigint) {
  return program.methods
    .sell(bn(amount), bn(minOut))
    .accountsPartial({
      seller,
      curve: curvePda(mint),
      solVault: solVaultPda(mint),
      mint,
      curveVault: curveVault(mint),
      sellerTokenAccount: ata2022(seller, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function claimCreatorFeesIx(program: Program<Launchpad>, creator: PublicKey, mint: PublicKey) {
  return program.methods
    .claimCreatorFees()
    .accountsPartial({
      creator,
      curve: curvePda(mint),
      solVault: solVaultPda(mint),
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export function claimCreatorLockIx(program: Program<Launchpad>, creator: PublicKey, mint: PublicKey) {
  return program.methods
    .claimCreatorLock()
    .accountsPartial({
      creator,
      curve: curvePda(mint),
      mint,
      curveVault: curveVault(mint),
      creatorTokenAccount: ata2022(creator, mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

export async function collectProtocolFeesIx(program: Program<Launchpad>, mint: PublicKey) {
  const config = await fetchConfig(program)
  if (!config) throw new Error('Launchpad config not found on this network.')
  return program.methods
    .collectProtocolFees()
    .accountsPartial({
      config: configPda(),
      curve: curvePda(mint),
      solVault: solVaultPda(mint),
      feeRecipient: config.feeRecipient,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
}

// --- Raydium CPMM accounts for graduation ----------------------------------------

const seed = (s: string) => Buffer.from(s, 'utf8')

export function raydiumCpmmAccounts(cpmm: PublicKey, pool: PublicKey, mint: PublicKey) {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, cpmm)[0]
  const mintFirst = Buffer.compare(mint.toBuffer(), NATIVE_MINT.toBuffer()) < 0
  const [m0, m1] = mintFirst ? [mint, NATIVE_MINT] : [NATIVE_MINT, mint]
  return {
    authority: pda([seed('vault_and_lp_mint_auth_seed')]),
    lpMint: pda([seed('pool_lp_mint'), pool.toBuffer()]),
    vault0: pda([seed('pool_vault'), pool.toBuffer(), m0.toBuffer()]),
    vault1: pda([seed('pool_vault'), pool.toBuffer(), m1.toBuffer()]),
    observation: pda([seed('observation'), pool.toBuffer()]),
  }
}

/** Anyone can graduate a completed curve. Returns the pool keypair to sign with. */
export async function migrateIx(program: Program<Launchpad>, payer: PublicKey, mint: PublicKey) {
  const config = await fetchConfig(program)
  if (!config) throw new Error('Launchpad config not found on this network.')
  const pool = Keypair.generate()
  const cpmm = config.params.raydiumCpmmProgram
  const r = raydiumCpmmAccounts(cpmm, pool.publicKey, mint)
  const vault = solVaultPda(mint)
  const ix = await program.methods
    .migrate()
    .accountsPartial({
      payer,
      config: configPda(),
      curve: curvePda(mint),
      mint,
      curveVault: curveVault(mint),
      solVault: vault,
      vaultToken: ata2022(vault, mint),
      wsolMint: NATIVE_MINT,
      vaultWsol: getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID),
      feeRecipient: config.feeRecipient,
      cpmmProgram: cpmm,
      ammConfig: config.params.raydiumAmmConfig,
      raydiumAuthority: r.authority,
      poolState: pool.publicKey,
      lpMint: r.lpMint,
      vaultLp: getAssociatedTokenAddressSync(r.lpMint, vault, true, TOKEN_PROGRAM_ID),
      token0Vault: r.vault0,
      token1Vault: r.vault1,
      createPoolFee: config.params.raydiumCreatePoolFee,
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
