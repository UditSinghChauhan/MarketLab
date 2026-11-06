# MarketLab — Design Direction

Chosen from the references at <https://vibrant.design/websites>.

> Method note: these choices come from each reference's published palette, fonts,
> stack and style tags on Vibrant. The live sites still need a visual
> walkthrough before Phase 4 locks the components.

## References and what we take from each

| Reference | Why it fits MarketLab | What we take |
|---|---|---|
| **Lightspark** — "The API for money" (primary) | Financial infrastructure sold to engineers, the same position MarketLab wants | Near-white surfaces, near-black text, **one saturated blue accent**, Swiss grotesk type, restrained scroll and hover motion |
| **Skydive** — agents in the cloud (product UI) | Clean, minimal product UI built on Radix primitives | Light-gray and white layering, a small semantic palette (green, coral, amber) that maps to gain, loss and pending |
| **Rauno Freiberg** (interaction craft) | Known for interaction detail | Precise micro-interactions: hover states, number transitions, focus rings |

Not chosen: agency and portfolio sites with heavy art direction (basement.studio,
Lué Studio) — expressive, but they compete with dense financial data.

## Principles
1. **Data is the decoration.** No stock illustrations or gradients; the live book, tape and charts carry the visuals.
2. **One accent.** Blue marks actions and focus only. Green and red are reserved for gain and loss.
3. **Numbers are typeset.** Monospaced tabular figures for every price and quantity, so columns never jitter.
4. **Quiet motion.** Motion confirms changes (a fill, a price tick); it never decorates. `prefers-reduced-motion` disables it.
5. **Keyboard first** in the terminal.

## Themes
- **Landing site:** light (Lightspark direction).
- **Trading terminal:** dark by default, light available, following the system setting.

## Tokens

All text colours pass WCAG AA (≥ 4.5:1) on both `bg` and `surface`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F7F7F8` | `#0E0E0D` | Page |
| `--surface` | `#FFFFFF` | `#161514` | Panels, cards |
| `--surface-2` | `#F0F0EE` | `#1E1D1B` | Hover, inset |
| `--border` | `#E6E6E3` | `#2A2926` | Hairlines |
| `--text` | `#1A1A1A` | `#EDEDEB` | Primary text |
| `--muted` | `#6B6B66` | `#9B9A95` | Labels, secondary |
| `--accent` | `#0052FF` | `#5C8BFF` | Actions, focus |
| `--gain` | `#13804F` | `#3DD68C` | Profit, bids, buys |
| `--loss` | `#D12F36` | `#FF6B70` | Loss, asks, sells |
| `--pending` | `#9A6700` | `#F2B544` | Resting orders |

## Typography
- **Geist Sans** for UI and headings (free, OFL; closest open alternative to the Suisse Intl look).
- **Geist Mono** with tabular numerals for prices, quantities and the inspector.
- Scale: 12 / 13 / 14 / 16 / 20 / 28 / 40 / 56. Terminal body text is 13px; landing body text is 16px.
- Headings: tight tracking (−0.02em), weight 500–600. No all-caps except small labels.

## Space and shape
- 4px base grid: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Radius: 6px for controls, 10px for panels. Hairline 1px borders instead of shadows in the terminal.

## Landing page outline
1. Hero: one-line pitch, one sentence, and a live, read-only order book from the real engine.
2. "Watch an order": the inspector lifecycle, animated on scroll.
3. Engine: price-time priority explained with a small interactive book.
4. Architecture diagram and key decisions (links to ADRs).
5. Benchmarks: real numbers.
6. "What is simulated": an honest limits section.
7. CTA: "Open the terminal" (guest, no signup).
