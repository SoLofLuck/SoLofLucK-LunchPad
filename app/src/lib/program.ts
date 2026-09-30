import { AnchorProvider, Program, type Wallet } from '@coral-xyz/anchor'
import {
  ExtensionType,
  getAssociatedTokenAddressSync,
  getExtensionData,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'
import { unpack as unpackTokenMetadata } from '@solana/spl-token-metadata'
import { Connection, Keypair, PublicKey, type AccountInfo } from '@solana/web3.js'
import idl from '../idl/launchpad.json'
import type { Launchpad } from '../idl/launchpad'
import { PROGRAM_ID } from './config'
import { priceSol, type Reserves } from './curve'

export type CurveStatus = 'trading' | 'complete' | 'migrated'

export interface CurveState {
  mint: PublicKey
  creator: PublicKey
  status: CurveStatus
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  realTokenReserves: bigint
  realSolReserves: bigint
  lpTokenReserve: bigint
  tokenTotalSupply: bigint
  protocolFeeBps: number
  creatorFeeBps: number
  migrationFeeLamports: bigint
  poolCreationBudgetLamports: bigint
  creatorFeesAccrued: bigint
  protocolFeesAccrued: bigint
  createdAt: number
  sellUnlockAt: number
  creatorLockedTokens: bigint
  creatorUnlockAt: number
  raydiumPool: PublicKey
}

export interface OffchainMeta {
  image?: string
  description?: string
  website?: string
  twitter?: string
  telegram?: string
}

export interface TokenView {
  curve: CurveState
  name: string
  symbol: string
  uri: string
}

// --- Program handles ---------------------------------------------------------

const readonlyWallet: Wallet = {
  publicKey: Keypair.generate().publicKey,
  payer: undefined as never,
  signTransaction: async () => {
    throw new Error('read-only')
  },
  signAllTransactions: async () => {
    throw new Error('read-only')
  },
}

export function getProgram(connection: Connection): Program<Launchpad> {
  const provider = new AnchorProvider(connection, readonlyWallet, { commitment: 'confirmed' })
  return new Program<Launchpad>({ ...(idl as Launchpad), address: PROGRAM_ID.toBase58() }, provider)
}

// --- PDAs ------------------------------------------------------------------------

export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM_ID)[0]
export const curvePda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('curve'), mint.toBuffer()], PROGRAM_ID)[0]
export const solVaultPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from('sol_vault'), mint.toBuffer()], PROGRAM_ID)[0]
export const curveVault = (mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, curvePda(mint), true, TOKEN_2022_PROGRAM_ID)

// --- Decoding --------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCurve(raw: any): CurveState {
  const big = (v: { toString(): string }) => BigInt(v.toString())
  const status: CurveStatus = 'migrated' in raw.status ? 'migrated' : 'complete' in raw.status ? 'complete' : 'trading'
  return {
    mint: raw.mint,
    creator: raw.creator,
    status,
    virtualTokenReserves: big(raw.virtualTokenReserves),
    virtualSolReserves: big(raw.virtualSolReserves),
    realTokenReserves: big(raw.realTokenReserves),
    realSolReserves: big(raw.realSolReserves),
    lpTokenReserve: big(raw.lpTokenReserve),
    tokenTotalSupply: big(raw.tokenTotalSupply),
    protocolFeeBps: raw.protocolFeeBps,
    creatorFeeBps: raw.creatorFeeBps,
    migrationFeeLamports: big(raw.migrationFeeLamports),
    poolCreationBudgetLamports: big(raw.poolCreationBudgetLamports),
    creatorFeesAccrued: big(raw.creatorFeesAccrued),
    protocolFeesAccrued: big(raw.protocolFeesAccrued),
    createdAt: Number(raw.createdAt.toString()),
    sellUnlockAt: Number(raw.sellUnlockAt.toString()),
    creatorLockedTokens: big(raw.creatorLockedTokens),
    creatorUnlockAt: Number(raw.creatorUnlockAt.toString()),
    raydiumPool: raw.raydiumPool,
  }
}

export function decodeCurve(program: Program<Launchpad>, data: Buffer): CurveState {
  return toCurve(program.coder.accounts.decode('bondingCurve', data))
}

export async function fetchCurve(program: Program<Launchpad>, mint: PublicKey): Promise<CurveState | null> {
  const raw = await program.account.bondingCurve.fetchNullable(curvePda(mint))
  return raw ? toCurve(raw) : null
}

export async function fetchAllCurves(program: Program<Launchpad>): Promise<CurveState[]> {
  const all = await program.account.bondingCurve.all()
  return all.map((a) => toCurve(a.account))
}

export async function fetchConfig(program: Program<Launchpad>) {
  return program.account.globalConfig.fetchNullable(configPda())
}

export interface MintMeta {
  name: string
  symbol: string
  uri: string
}

export function parseMintMetadata(address: PublicKey, info: AccountInfo<Buffer>): MintMeta | null {
  try {
    const mint = unpackMint(address, info, TOKEN_2022_PROGRAM_ID)
    const data = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData)
    if (!data) return null
    const m = unpackTokenMetadata(data)
    return { name: m.name, symbol: m.symbol, uri: m.uri }
  } catch {
    return null
  }
}

export async function fetchMintMetas(connection: Connection, mints: PublicKey[]): Promise<Map<string, MintMeta>> {
  const out = new Map<string, MintMeta>()
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const infos = await connection.getMultipleAccountsInfo(chunk)
    infos.forEach((info, j) => {
      if (!info) return
      const meta = parseMintMetadata(chunk[j], info)
      if (meta) out.set(chunk[j].toBase58(), meta)
    })
  }
  return out
}

const offchainCache = new Map<string, Promise<OffchainMeta>>()

/** Fetches the JSON the metadata URI points to. Never throws. */
export function fetchOffchain(uri: string): Promise<OffchainMeta> {
  if (!uri) return Promise.resolve({})
  let p = offchainCache.get(uri)
  if (!p) {
    p = fetch(uri)
      .then((r) => (r.ok ? r.json() : {}))
      .then((j: Record<string, unknown>) => {
        const ext = (j.extensions ?? {}) as Record<string, string | undefined>
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
        return {
          image: str(j.image),
          description: str(j.description),
          website: str(ext.website) ?? str(j.external_url),
          twitter: str(ext.twitter),
          telegram: str(ext.telegram),
        }
      })
      .catch(() => ({}))
    offchainCache.set(uri, p)
  }
  return p
}

// --- Derived values ----------------------------------------------------------------

export function reservesOf(c: CurveState): Reserves {
  return {
    virtualSol: c.virtualSolReserves,
    virtualToken: c.virtualTokenReserves,
    realSol: c.realSolReserves,
    realToken: c.realTokenReserves,
  }
}

export function curvePriceSol(c: CurveState): number {
  return priceSol(c.virtualSolReserves, c.virtualTokenReserves)
}

export function marketCapSol(c: CurveState): number {
  return curvePriceSol(c) * (Number(c.tokenTotalSupply) / 1e6)
}

/** 0..100: share of the curve's tokens sold. */
export function progressPct(c: CurveState): number {
  if (c.status !== 'trading') return 100
  const curveSupply = c.tokenTotalSupply - c.lpTokenReserve
  if (curveSupply <= 0n) return 0
  const sold = curveSupply - c.realTokenReserves
  return Math.min(100, (Number(sold) / Number(curveSupply)) * 100)
}

export function sellLocked(c: CurveState, nowSec = Date.now() / 1000): boolean {
  return nowSec < c.sellUnlockAt
}
