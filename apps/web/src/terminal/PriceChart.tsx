/**
 * Candlestick chart drawn as SVG: price candles, a volume strip, a right-hand
 * price axis, a last-price marker and a hover crosshair. No chart library: the
 * data is small (≤ 480 candles) and the drawing rules are the interesting part.
 */

import type { Candle } from "@marketlab/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { price, time } from "../lib/format";

const AXIS_W = 68;
const AXIS_H = 22;
/**
 * Pixels kept free above the highest price. The range pad is a share of the
 * range, so on a short chart it can be only a few pixels; a gridline label or
 * the last-price badge (both centred on their line) would then be cut off.
 */
const TOP_PAD = 10;
const STEP = 9; // horizontal pixels per candle
const BODY = 6;

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, size] as const;
}

export function PriceChart({
  candles,
  last,
  onHover,
  loading = false,
}: {
  candles: readonly Candle[];
  last: string | null;
  onHover: (candle: Candle | null) => void;
  /** True until the first candles have loaded: draws the empty frame instead of a message. */
  loading?: boolean;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; y: number } | null>(null);

  const plotW = Math.max(0, width - AXIS_W);
  const plotH = Math.max(0, height - AXIS_H);
  const priceH = plotH * 0.8;
  const volumeTop = priceH + 6;
  const volumeH = plotH - volumeTop;

  const view = useMemo(() => {
    const visible = Math.max(1, Math.floor(plotW / STEP));
    const data = candles.slice(-visible);
    const lastPrice = last === null ? undefined : Number(last);
    let lo = Math.min(...data.map((c) => Number(c.low)), lastPrice ?? Infinity);
    let hi = Math.max(...data.map((c) => Number(c.high)), lastPrice ?? -Infinity);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (hi - lo < hi * 0.002) {
      const mid = (hi + lo) / 2;
      lo = mid * 0.999;
      hi = mid * 1.001;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const maxVolume = Math.max(1, ...data.map((c) => c.volume));
    const offset = plotW - data.length * STEP; // right-align: newest candle at the axis
    return { data, lo, hi, maxVolume, offset, lastPrice };
  }, [candles, last, plotW]);

  if (width === 0 || !view || view.data.length === 0) {
    return (
      <div ref={ref} className="relative grid h-full place-items-center text-sm text-muted">
        {width > 0 && (
          <>
            <svg
              width={width}
              height={height}
              aria-hidden="true"
              className="absolute inset-0 block"
            >
              {[0.2, 0.4, 0.6, 0.8].map((f) => (
                <line
                  key={f}
                  x1={0}
                  x2={plotW}
                  y1={priceH * f}
                  y2={priceH * f}
                  stroke="var(--line)"
                />
              ))}
              <line x1={plotW} x2={plotW} y1={0} y2={plotH} stroke="var(--line)" />
              <line x1={0} x2={plotW} y1={volumeTop - 3} y2={volumeTop - 3} stroke="var(--line)" />
              {loading &&
                [0.2, 0.4, 0.6, 0.8].map((f) => (
                  <rect
                    key={f}
                    x={plotW + 8}
                    y={priceH * f - 4}
                    width={44}
                    height={8}
                    rx={2}
                    fill="var(--raised)"
                  />
                ))}
            </svg>
            {loading ? (
              <span className="sr-only" role="status">
                Loading the chart
              </span>
            ) : (
              <span className="relative bg-surface px-3 py-1">
                Waiting for the first trades in this session.
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  const { data, lo, hi, maxVolume, offset, lastPrice } = view;
  const y = (p: number) => TOP_PAD + ((hi - p) / (hi - lo)) * (priceH - TOP_PAD);
  const x = (i: number) => offset + i * STEP + STEP / 2;
  const step = niceStep(hi - lo, Math.max(2, Math.floor(priceH / 56)));
  const gridLines: number[] = [];
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) gridLines.push(p);
  const labelEvery = Math.max(1, Math.round(96 / STEP));
  const lastCandle = data.at(-1);
  const lastUp = lastCandle ? Number(lastCandle.close) >= Number(lastCandle.open) : true;
  const hovered = hover ? data[hover.index] : undefined;

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const index = Math.floor((px - offset) / STEP);
    if (px > plotW || index < 0 || index >= data.length) {
      setHover(null);
      onHover(null);
      return;
    }
    setHover({ index, y: py });
    onHover(data[index] ?? null);
  };

  return (
    <div ref={ref} className="h-full w-full select-none">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Price chart: ${String(data.length)} fifteen-second candles, last ₹${last ?? ""}`}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
          onHover(null);
        }}
        className="block"
      >
        {gridLines.map((p) => (
          <g key={p}>
            <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="var(--line)" />
            {(lastPrice === undefined || Math.abs(y(p) - y(lastPrice)) > 14) && (
              <text x={plotW + 8} y={y(p) + 4} className="num fill-muted text-2xs">
                {price(p.toFixed(2))}
              </text>
            )}
          </g>
        ))}
        <line x1={plotW} x2={plotW} y1={0} y2={plotH} stroke="var(--line)" />
        <line x1={0} x2={plotW} y1={volumeTop - 3} y2={volumeTop - 3} stroke="var(--line)" />

        {data.map((c, i) => {
          const open = Number(c.open);
          const close = Number(c.close);
          const up = close >= open;
          const color = up ? "var(--bid)" : "var(--ask)";
          const top = y(Math.max(open, close));
          const bodyH = Math.max(1, Math.abs(y(open) - y(close)));
          const vh = (c.volume / maxVolume) * volumeH;
          return (
            <g key={c.time} opacity={hovered && hovered !== c ? 0.55 : 1}>
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(Number(c.high))}
                y2={y(Number(c.low))}
                stroke={color}
              />
              <rect x={x(i) - BODY / 2} y={top} width={BODY} height={bodyH} fill={color} rx={1} />
              <rect
                x={x(i) - BODY / 2}
                y={volumeTop + volumeH - vh}
                width={BODY}
                height={vh}
                fill={color}
                opacity={0.35}
              />
              {i % labelEvery === 0 && x(i) > 32 && x(i) < plotW - 32 && (
                <text
                  x={x(i)}
                  y={plotH + 15}
                  textAnchor="middle"
                  className="num fill-muted text-2xs"
                >
                  {time(c.time)}
                </text>
              )}
            </g>
          );
        })}

        {lastPrice !== undefined && (
          <g>
            <line
              x1={0}
              x2={plotW}
              y1={y(lastPrice)}
              y2={y(lastPrice)}
              stroke={lastUp ? "var(--bid)" : "var(--ask)"}
              strokeDasharray="2 3"
            />
            <rect
              x={plotW + 1}
              y={y(lastPrice) - 9}
              width={AXIS_W - 2}
              height={18}
              rx={3}
              fill={lastUp ? "var(--bid)" : "var(--ask)"}
            />
            <text
              x={plotW + 8}
              y={y(lastPrice) + 4}
              className="num text-2xs font-medium"
              fill="var(--bg)"
            >
              {price(last)}
            </text>
          </g>
        )}

        {hover && hovered && (
          <g pointerEvents="none">
            <line
              x1={x(hover.index)}
              x2={x(hover.index)}
              y1={0}
              y2={plotH}
              stroke="var(--muted)"
              strokeDasharray="3 3"
            />
            {hover.y < priceH && (
              <>
                <line
                  x1={0}
                  x2={plotW}
                  y1={hover.y}
                  y2={hover.y}
                  stroke="var(--muted)"
                  strokeDasharray="3 3"
                />
                <rect
                  x={plotW + 1}
                  y={hover.y - 9}
                  width={AXIS_W - 2}
                  height={18}
                  rx={3}
                  fill="var(--raised)"
                />
                <text x={plotW + 8} y={hover.y + 4} className="num fill-text text-2xs">
                  {price((hi - ((hover.y - TOP_PAD) / (priceH - TOP_PAD)) * (hi - lo)).toFixed(2))}
                </text>
              </>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}
