import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Status } from '../components/ui'
import { useProgram, useSend } from '../hooks'
import { createIx } from '../lib/actions'
import {
  CREATOR_LOCK_OPTIONS,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  MAX_URI_LEN,
  SELL_LOCK_OPTIONS,
} from '../lib/config'
import { quoteBuy, withSlippage } from '../lib/curve'
import { fmtSol, fmtTokens, parseUnits } from '../lib/format'
import { uploadMetadata, uploadsEnabled } from '../lib/pinata'
import { fetchConfig } from '../lib/program'
import { href, navigate } from '../router'

const MAX_IMAGE_BYTES = 4 * 1024 * 1024

export function Create() {
  const program = useProgram()
  const { publicKey } = useWallet()
  const { setVisible } = useWalletModal()
  const { send, status, error, setError } = useSend()
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [uri, setUri] = useState('')
  const [website, setWebsite] = useState('')
  const [twitter, setTwitter] = useState('')
  const [telegram, setTelegram] = useState('')
  const [sellLock, setSellLock] = useState(900)
  const [creatorLock, setCreatorLock] = useState(604_800)
  const [initialBuy, setInitialBuy] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [config, setConfig] = useState<any>(null)
  const uploads = uploadsEnabled()

  useEffect(() => {
    fetchConfig(program).then(setConfig).catch(() => setConfig(null))
  }, [program])

  useEffect(() => {
    if (!image) return setPreview(null)
    const url = URL.createObjectURL(image)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [image])

  const buyLamports = parseUnits(initialBuy || '0', 9) ?? 0n
  const buyQuote = useMemo(() => {
    if (!config || buyLamports <= 0n) return null
    const p = config.params
    const big = (v: { toString(): string }) => BigInt(v.toString())
    return quoteBuy(
      {
        virtualSol: big(p.initialVirtualSolReserves),
        virtualToken: big(p.initialVirtualTokenReserves),
        realSol: 0n,
        realToken: big(p.curveTokenSupply),
      },
      buyLamports,
      p.protocolFeeBps,
      p.creatorFeeBps,
    )
  }, [config, buyLamports])

  const problems: string[] = []
  if (!name.trim()) problems.push('Name is required.')
  if (new TextEncoder().encode(name).length > MAX_NAME_LEN) problems.push(`Name is at most ${MAX_NAME_LEN} bytes.`)
  if (!symbol.trim()) problems.push('Ticker is required.')
  if (new TextEncoder().encode(symbol).length > MAX_SYMBOL_LEN) problems.push(`Ticker is at most ${MAX_SYMBOL_LEN} bytes.`)
  if (uploads && !image) problems.push('Add an image.')
  if (!uploads && !uri.trim()) problems.push('Paste a metadata URI.')
  if (uri.length > MAX_URI_LEN) problems.push('Metadata URI is too long.')
  if (initialBuy && parseUnits(initialBuy, 9) === null) problems.push('Initial buy must be a SOL amount.')
  if (config?.paused) problems.push('Launches are paused right now.')

  const onFile = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return setError('That file is not an image.')
    if (f.size > MAX_IMAGE_BYTES) return setError('Images must be 4 MB or smaller.')
    setError(null)
    setImage(f)
  }

  const submit = async () => {
    if (!publicKey) return setVisible(true)
    let mintAddr = ''
    const sig = await send(async () => {
      const metadataUri = uploads
        ? await uploadMetadata(image!, {
            name: name.trim(),
            symbol: symbol.trim(),
            description: description.trim(),
            website: website.trim(),
            twitter: twitter.trim(),
            telegram: telegram.trim(),
          })
        : uri.trim()
      if (metadataUri.length > MAX_URI_LEN) throw new Error('The metadata URI is too long.')
      const { ix, mint } = await createIx(program, publicKey, {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        uri: metadataUri,
        sellLockSeconds: sellLock,
        creatorLockSeconds: creatorLock,
        initialBuyLamports: buyLamports,
        minTokensOut: buyQuote ? withSlippage(buyQuote.tokensOut, 100) : 0n,
      })
      mintAddr = mint.publicKey.toBase58()
      return { ixs: [ix], signers: [mint] }
    })
    if (sig && mintAddr) navigate(href.token(mintAddr))
  }

  return (
    <div className="container">
      <div className="create-layout">
        <div className="panel">
          <h1 style={{ marginBottom: 4 }}>Launch a token</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            One transaction. Full supply on the bonding curve, mint authority revoked, metadata frozen.
          </p>

          <div className="two">
            <div className="field">
              <label>Name</label>
              <input value={name} maxLength={MAX_NAME_LEN} placeholder="Lucky Cat" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>Ticker</label>
              <input
                value={symbol}
                maxLength={MAX_SYMBOL_LEN}
                placeholder="LCAT"
                onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ''))}
              />
            </div>
          </div>

          <div className="field">
            <label>Description</label>
            <textarea rows={3} value={description} placeholder="What's the story?" onChange={(e) => setDescription(e.target.value)} />
          </div>

          {uploads ? (
            <div className="field">
              <label>Image</label>
              <div
                className="drop"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  onFile(e.dataTransfer.files[0])
                }}
              >
                {preview ? <img src={preview} alt="preview" /> : <div style={{ fontSize: 34 }}>🖼️</div>}
                <div className="small muted">{image ? image.name : 'Drop an image or click to choose (max 4 MB)'}</div>
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            </div>
          ) : (
            <div className="field">
              <label>Metadata URI</label>
              <input value={uri} placeholder="https://…/metadata.json" onChange={(e) => setUri(e.target.value)} />
              <div className="hint">Image uploads are not configured on this deployment; paste a hosted metadata JSON.</div>
            </div>
          )}

          <div className="three">
            <div className="field">
              <label>Website (optional)</label>
              <input value={website} placeholder="https://" onChange={(e) => setWebsite(e.target.value)} />
            </div>
            <div className="field">
              <label>Twitter / X (optional)</label>
              <input value={twitter} placeholder="https://x.com/…" onChange={(e) => setTwitter(e.target.value)} />
            </div>
            <div className="field">
              <label>Telegram (optional)</label>
              <input value={telegram} placeholder="https://t.me/…" onChange={(e) => setTelegram(e.target.value)} />
            </div>
          </div>

          <div className="field">
            <label>🔒 Sell Lock</label>
            <div className="seg">
              {SELL_LOCK_OPTIONS.map((o) => (
                <button key={o.seconds} className={sellLock === o.seconds ? 'active' : ''} onClick={() => setSellLock(o.seconds)}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className="hint">
              Nobody (you included) can sell to the curve until this expires; buying stays open. Stops snipers from
              dumping at launch. Graduation also waits for it.
            </div>
          </div>

          <div className="field">
            <label>💰 Initial buy (optional)</label>
            <div className="amount-input">
              <input inputMode="decimal" placeholder="0.0" value={initialBuy} onChange={(e) => setInitialBuy(e.target.value.replace(',', '.'))} />
              <span className="unit">SOL</span>
            </div>
            <div className="hint">
              Be the first buyer at the lowest price.{' '}
              {buyQuote && (
                <b className="green">
                  ≈ {fmtTokens(buyQuote.tokensOut)} tokens for {fmtSol(buyQuote.totalCost)} SOL
                </b>
              )}
            </div>
          </div>

          {buyLamports > 0n && (
            <div className="field">
              <label>🛡️ Creator Lock for your initial buy</label>
              <div className="seg">
                {CREATOR_LOCK_OPTIONS.map((o) => (
                  <button
                    key={o.seconds}
                    className={creatorLock === o.seconds ? 'active' : ''}
                    onClick={() => setCreatorLock(o.seconds)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="hint">
                Your initial buy is held by the program and released to you when this expires. Buyers see it as a
                trust badge.
              </div>
            </div>
          )}

          {problems.length > 0 && (name || symbol || image || uri) && (
            <div className="warn-box" style={{ marginBottom: 12 }}>
              {problems.map((p) => (
                <div key={p}>• {p}</div>
              ))}
            </div>
          )}

          <button className="btn primary block" disabled={!!publicKey && (problems.length > 0 || status !== null)} onClick={submit}>
            {!publicKey ? 'Connect wallet' : status ?? '🍀 Launch token'}
          </button>
          <Status status={null} error={error} />
          <p className="tiny muted">
            Costs: network rent (~0.01 SOL) plus your optional initial buy and its trading fee. There is no launch fee.
          </p>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Preview</h3>
            <div className="card" style={{ pointerEvents: 'none' }}>
              {preview ? <img className="thumb" src={preview} alt="" /> : <div className="thumb thumb-fallback">🍀</div>}
              <div className="body">
                <div className="title">
                  {name || 'Your token'} <span className="muted">${symbol || 'TICKER'}</span>
                </div>
                <div className="desc">{description || 'Your description appears here.'}</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {sellLock > 0 && <span className="chip info">🔒 Sell Lock {SELL_LOCK_OPTIONS.find((o) => o.seconds === sellLock)?.label}</span>}
                  {buyLamports > 0n && creatorLock > 0 && <span className="chip ok">🛡️ Dev locked</span>}
                </div>
              </div>
            </div>
          </div>
          <div className="panel small">
            <h3 style={{ marginBottom: 8 }}>What happens</h3>
            <ol className="muted" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 6 }}>
              <li>Your token is minted with a fixed supply; mint and freeze authority are revoked.</li>
              <li>Everyone buys and sells on the same bonding curve — no presale, no team tokens.</li>
              <li>When the curve sells out, the liquidity graduates to Raydium and the LP is burned.</li>
              <li>You earn {config ? `${config.params.creatorFeeBps / 100}%` : 'a share'} of every trade on the curve.</li>
            </ol>
            <a href={href.how} className="small">Read how it works →</a>
          </div>
        </div>
      </div>
    </div>
  )
}
