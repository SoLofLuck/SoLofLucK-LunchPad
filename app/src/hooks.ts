import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PROGRAM_ID } from './lib/config'
import {
  decodeCurve,
  fetchAllCurves,
  fetchMintMetas,
  fetchOffchain,
  getProgram,
  type CurveState,
  type OffchainMeta,
  type TokenView,
} from './lib/program'
import { sendTx, type TxWallet } from './lib/tx'
import type { Keypair, TransactionInstruction } from '@solana/web3.js'

export function useProgram() {
  const { connection } = useConnection()
  return useMemo(() => getProgram(connection), [connection])
}

/** Re-renders every `ms` with the current unix time in seconds. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** All launchpad tokens, refreshed on an interval and on program activity. */
export function useTokens() {
  const { connection } = useConnection()
  const program = useProgram()
  const [tokens, setTokens] = useState<TokenView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const metaCache = useRef(new Map<string, { name: string; symbol: string; uri: string }>())

  const load = useCallback(async () => {
    try {
      const curves = await fetchAllCurves(program)
      const missing = curves.map((c) => c.mint).filter((m) => !metaCache.current.has(m.toBase58()))
      if (missing.length) {
        const metas = await fetchMintMetas(connection, missing)
        metas.forEach((v, k) => metaCache.current.set(k, v))
      }
      setTokens(
        curves.map((curve) => {
          const m = metaCache.current.get(curve.mint.toBase58())
          return { curve, name: m?.name ?? '…', symbol: m?.symbol ?? '', uri: m?.uri ?? '' }
        }),
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [connection, program])

  useEffect(() => {
    load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [load])

  return { tokens, error, reload: load }
}

/** One curve, live: refetched whenever the account changes on chain. */
export function useCurve(mint: PublicKey | null, curveKey: PublicKey | null) {
  const { connection } = useConnection()
  const program = useProgram()
  const [curve, setCurve] = useState<CurveState | null | undefined>(undefined)

  useEffect(() => {
    if (!mint || !curveKey) return
    let alive = true
    connection
      .getAccountInfo(curveKey, 'confirmed')
      .then((info) => alive && setCurve(info ? decodeCurve(program, info.data) : null))
      .catch(() => alive && setCurve(null))
    const sub = connection.onAccountChange(
      curveKey,
      (info) => {
        try {
          setCurve(decodeCurve(program, info.data))
        } catch {
          /* ignore */
        }
      },
      'confirmed',
    )
    return () => {
      alive = false
      connection.removeAccountChangeListener(sub)
    }
  }, [connection, program, mint, curveKey])

  return curve
}

export function useOffchain(uri: string | undefined): OffchainMeta {
  const [meta, setMeta] = useState<OffchainMeta>({})
  useEffect(() => {
    let alive = true
    if (uri) fetchOffchain(uri).then((m) => alive && setMeta(m))
    return () => {
      alive = false
    }
  }, [uri])
  return meta
}

/** USD per SOL, or null if no price source answers. Refreshed each minute. */
export function useSolPrice(): number | null {
  const [price, setPrice] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const sources: [string, (j: unknown) => number | undefined][] = [
        [
          'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
          (j) => (j as Record<string, { usdPrice?: number }>)['So11111111111111111111111111111111111111112']?.usdPrice,
        ],
        [
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          (j) => (j as { solana?: { usd?: number } }).solana?.usd,
        ],
      ]
      for (const [url, pick] of sources) {
        try {
          const r = await fetch(url)
          if (!r.ok) continue
          const v = pick(await r.json())
          if (v && alive) {
            setPrice(v)
            return
          }
        } catch {
          /* next source */
        }
      }
    }
    load()
    const id = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])
  return price
}

/** Sends instructions with the connected wallet; tracks status for the UI. */
export function useSend() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [signature, setSignature] = useState<string | null>(null)
  const busy = status !== null

  const send = useCallback(
    async (build: () => Promise<{ ixs: TransactionInstruction[]; signers?: Keypair[] }>) => {
      setError(null)
      setSignature(null)
      if (!wallet.publicKey || !wallet.signTransaction) {
        setError('Connect a wallet first.')
        return null
      }
      try {
        setStatus('Preparing…')
        const { ixs, signers } = await build()
        const sig = await sendTx(connection, wallet as unknown as TxWallet, ixs, signers ?? [], setStatus)
        setSignature(sig)
        return sig
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return null
      } finally {
        setStatus(null)
      }
    },
    [connection, wallet],
  )

  return { send, status, busy, error, signature, setError }
}

/** Program-wide log subscription, for the live ticker. */
export function useProgramLogs(onLogs: (signature: string, logs: string[]) => void) {
  const { connection } = useConnection()
  const cb = useRef(onLogs)
  cb.current = onLogs
  useEffect(() => {
    const id = connection.onLogs(PROGRAM_ID, (l) => {
      if (!l.err) cb.current(l.signature, l.logs)
    }, 'confirmed')
    return () => {
      connection.removeOnLogsListener(id)
    }
  }, [connection])
}
