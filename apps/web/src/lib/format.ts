/** Display formatting. Prices arrive as decimal rupee strings and are never parsed into floats for arithmetic that matters. */

const grouping = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const qtyFormat = new Intl.NumberFormat("en-IN");

/** "1234567.5" → "12,34,567.50" (Indian grouping, always two decimals). */
export function price(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  return `${negative ? "−" : ""}${grouping.format(Number(whole))}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

/** Rupee amount with symbol: "₹12,34,567.50". */
export function rupees(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const formatted = price(value);
  return formatted.startsWith("−") ? `−₹${formatted.slice(1)}` : `₹${formatted}`;
}

/** Signed rupee change: "+₹12.50" / "−₹3.00". */
export function signedRupees(value: string): string {
  if (Number(value) === 0) return "₹0.00";
  return value.startsWith("-") ? rupees(value) : `+${rupees(value)}`;
}

export function pct(value: number): string {
  if (value === 0) return "0.00%";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

export function qty(value: number): string {
  return qtyFormat.format(value);
}

/** Text colour class for a signed change: green up, red down, muted when flat. */
export function changeTone(value: string | number): string {
  const d = direction(value);
  return d === "up" ? "text-bid" : d === "down" ? "text-ask" : "text-muted";
}

export function direction(value: string | number): "up" | "down" | "flat" {
  const n = typeof value === "number" ? value : Number(value);
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

const clock = new Intl.DateTimeFormat("en-IN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function time(epochMs: number): string {
  return clock.format(epochMs);
}

/** Microseconds for humans: 0.6 µs, 58 µs, 1.2 ms. */
export function duration(us: number): string {
  if (us < 10) return `${us.toFixed(1)} µs`;
  if (us < 1000) return `${Math.round(us)} µs`;
  return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
}

/** Adds `steps` ticks to a decimal rupee price, without float drift. */
export function stepPrice(value: string, tick: string, steps: number): string {
  const toPaise = (v: string) => {
    const [w = "0", f = ""] = v.split(".");
    return Number(w) * 100 + Number(f.padEnd(2, "0").slice(0, 2));
  };
  const next = Math.max(toPaise(tick), toPaise(value) + steps * toPaise(tick));
  return `${String(Math.trunc(next / 100))}.${String(next % 100).padStart(2, "0")}`;
}
