import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { fmtPrice } from '../lib/format'
import { toCandles, type TradeEvent } from '../lib/trades'

const BUCKETS = [
  { s: 60, label: '1m' },
  { s: 300, label: '5m' },
  { s: 900, label: '15m' },
  { s: 3600, label: '1h' },
]

/** Candles in SOL per token, or in USD when a SOL price is known. */
export function PriceChart({ trades, startPrice, solUsd }: { trades: TradeEvent[]; startPrice: number; solUsd: number | null }) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [bucket, setBucket] = useState(300)
  const mult = solUsd ?? 1

  useEffect(() => {
    if (!el.current) return
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8aa596', attributionLogo: false },
      grid: { vertLines: { color: 'rgba(31,51,40,0.5)' }, horzLines: { color: 'rgba(31,51,40,0.5)' } },
      rightPriceScale: { borderColor: '#1f3328' },
      timeScale: { borderColor: '#1f3328', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    const s = c.addSeries(CandlestickSeries, {
      upColor: '#2ee88a',
      downColor: '#ff5d6c',
      borderVisible: false,
      wickUpColor: '#2ee88a',
      wickDownColor: '#ff5d6c',
      priceFormat: { type: 'custom', minMove: 1e-12, formatter: (p: number) => fmtPrice(p) },
    })
    chart.current = c
    series.current = s
    return () => {
      c.remove()
      chart.current = null
      series.current = null
    }
  }, [])

  const candles = useMemo(
    () =>
      toCandles(trades, bucket, startPrice).map(
        (k) =>
          ({
            time: k.time as UTCTimestamp,
            open: k.open * mult,
            high: k.high * mult,
            low: k.low * mult,
            close: k.close * mult,
          }) satisfies CandlestickData<UTCTimestamp>,
      ),
    [trades, bucket, startPrice, mult],
  )

  useEffect(() => {
    series.current?.setData(candles)
    chart.current?.timeScale().fitContent()
  }, [candles])

  return (
    <div className="panel" style={{ padding: 8 }}>
      <div className="chart-toolbar">
        <div className="seg" style={{ flex: 'none' }}>
          {BUCKETS.map((b) => (
            <button key={b.s} className={bucket === b.s ? 'active' : ''} onClick={() => setBucket(b.s)}>
              {b.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="tiny muted" style={{ alignSelf: 'center' }}>
          Price in {solUsd ? 'USD' : 'SOL'}
        </span>
      </div>
      <div className="chart-box" ref={el} style={{ position: "relative" }}>
        {trades.length === 0 && (
          <div className="empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            No trades yet — be the first.
          </div>
        )}
      </div>
    </div>
  )
}
