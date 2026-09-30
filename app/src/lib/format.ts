export function shortAddr(a: string, n = 4): string {
  return a.length <= n * 2 + 1 ? a : `${a.slice(0, n)}…${a.slice(-n)}`
}

/** Lamports (bigint) to a SOL string with up to `dp` decimals. */
export function fmtSol(lamports: bigint | number, dp = 4): string {
  const v = Number(lamports) / 1e9
  return v.toLocaleString('en-US', { maximumFractionDigits: dp })
}

/** Token base units (6 decimals) to a compact human string. */
export function fmtTokens(units: bigint | number): string {
  return compact(Number(units) / 1e6)
}

export function compact(v: number): string {
  if (!isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(2)}K`
  if (a >= 1) return v.toFixed(2)
  return v.toPrecision(3)
}

/** Very small prices (1e-8 SOL) readable: 0.0₇1234 style. */
export function fmtPrice(v: number): string {
  if (!isFinite(v) || v === 0) return '0'
  if (v >= 0.001) return v.toPrecision(4)
  const s = v.toExponential(3) // e.g. 2.795e-8
  const [mant, exp] = s.split('e')
  const zeros = -Number(exp) - 1
  const digits = mant.replace('.', '').replace(/0+$/, '')
  const sub = String(zeros)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('')
  return `0.0${sub}${digits}`
}

export function fmtUsd(v: number): string {
  if (!isFinite(v)) return '—'
  return `$${compact(v)}`
}

export function timeAgo(tsSeconds: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.floor(now - tsSeconds))
  if (d < 60) return `${d}s ago`
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Parses a decimal string into base units without float rounding. */
export function parseUnits(input: string, decimals: number): bigint | null {
  const s = input.trim()
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null
  const [whole, frac = ''] = s.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}
