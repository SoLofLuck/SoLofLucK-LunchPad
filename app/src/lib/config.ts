import { clusterApiUrl, PublicKey } from '@solana/web3.js'
import idl from '../idl/launchpad.json'

export type Network = 'devnet' | 'mainnet-beta'

const env = import.meta.env
export const NETWORK: Network = env.VITE_NETWORK === 'mainnet-beta' ? 'mainnet-beta' : 'devnet'
export const RPC_URL: string = env.VITE_RPC_URL || clusterApiUrl(NETWORK)
export const PROGRAM_ID = new PublicKey(env.VITE_PROGRAM_ID || idl.address)
export const PINATA_JWT: string | undefined = env.VITE_PINATA_JWT || undefined

export const EXPLORER = (kind: 'address' | 'tx', id: string) =>
  `https://solscan.io/${kind === 'tx' ? 'tx' : 'account'}/${id}${NETWORK === 'devnet' ? '?cluster=devnet' : ''}`

export const RAYDIUM_SWAP = (mint: string) =>
  `https://raydium.io/swap/?inputMint=sol&outputMint=${mint}`

// Must match SELL_LOCK_OPTIONS / CREATOR_LOCK_OPTIONS in constants.rs.
export const SELL_LOCK_OPTIONS = [
  { seconds: 0, label: 'None' },
  { seconds: 300, label: '5 min' },
  { seconds: 900, label: '15 min' },
  { seconds: 3_600, label: '1 hour' },
  { seconds: 18_000, label: '5 hours' },
  { seconds: 86_400, label: '24 hours' },
] as const

export const CREATOR_LOCK_OPTIONS = [
  { seconds: 0, label: 'None' },
  { seconds: 86_400, label: '1 day' },
  { seconds: 604_800, label: '7 days' },
  { seconds: 2_592_000, label: '30 days' },
  { seconds: 7_776_000, label: '90 days' },
] as const

export const MAX_NAME_LEN = 32
export const MAX_SYMBOL_LEN = 10
export const MAX_URI_LEN = 200
