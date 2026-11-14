# MarketLab — Design

## Brief

- **Subject:** a simulated stock exchange with a real matching engine.
- **Audience:** engineers and hiring teams, plus anyone curious how an exchange works.
- **Primary job:** let a visitor place an order and watch exactly what the
  engine does with it.

## The one memorable thing

**The order's journey.** The landing page's hero is the live order book and a
single button that places a real order and shows its trace: accepted, written
to the log, matched, filled, with the microseconds each step took. In the
terminal, the same trace lives in the engine inspector. Everything else is kept
quiet so this stands out.

## References

Chosen from [vibrant.design](https://vibrant.design/websites):

| Reference      | What we took                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Lightspark     | A light, restrained marketing page for financial infrastructure; one saturated blue for actions |
| Skydive        | Layered greys in product UI; a small semantic palette for states                                |
| Rauno Freiberg | Interaction detail: focus states, hover states, motion only in response to an action            |

## Colour

Two themes from one token set. The landing page is light; the terminal is dark
(`.dark-ui`). The terminal uses a cool graphite rather than near-black, so long
sessions are easier on the eyes and green and red carry the meaning.

| Token     | Light     | Dark      | Use                                       |
| --------- | --------- | --------- | ----------------------------------------- |
| `bg`      | `#F5F7FA` | `#121820` | Page                                      |
| `surface` | `#FFFFFF` | `#171E27` | Panels                                    |
| `raised`  | `#EEF1F5` | `#1E2631` | Hover, inset, spread row                  |
| `line`    | `#DDE2E9` | `#262F3B` | Hairlines between panels                  |
| `text`    | `#121A26` | `#E7EBF0` | Primary text                              |
| `muted`   | `#566273` | `#93A0B2` | Labels, secondary text                    |
| `faint`   | `#C5CCD6` | `#3A4553` | Gridlines and depth bars only, never text |
| `accent`  | `#1F4FE0` | `#6F93FF` | Actions, focus, the inspector             |
| `bid`     | `#0F7A50` | `#3CCB94` | Buys, bids, gains                         |
| `ask`     | `#C8323A` | `#FF7A80` | Sells, asks, losses                       |
| `pending` | `#94640A` | `#F0B44C` | Orders waiting in the book                |

Every text colour passes WCAG AA (4.5:1) on its backgrounds. A change of zero
is shown in `muted`, never in green.

## Type

- **IBM Plex Sans** throughout, self-hosted. Its engineering and terminal
  heritage suits an exchange, and its tabular figures keep price columns from
  jittering (`.num`).
- **IBM Plex Mono** only for raw engine events in the inspector, which really
  are machine data.
- Scale from 11 to 54 px; the terminal's body text is 13 px, the landing page's 15–17 px.
- Headings are sentence case with tight tracking. No all-caps labels.

## Layout

**Terminal (≥1280 px):**

```
┌ symbols ──────────────────────────────────── equity, inspector ┐
│ chart (candles + volume)          │ order book │ order ticket  │
│                                   │  ladder    │               │
├───────────────────────────────────┤            ├───────────────┤
│ positions / orders                │            │ trades        │
└───────────────────────────────────┴────────────┴───────────────┘
```

Panels are separated by 1 px hairlines rather than cards and shadows. On
smaller screens the panels stack, with the order ticket directly under the
chart, so a phone user never scrolls past the whole book to trade.

**Landing page:** hero (headline, live stats, live order book with the
one-click order), how price-time priority works with a worked example, the
engineering, an architecture diagram, and an honest list of what is simulated.

## Motion

- A trade briefly tints its row in the tape; nothing else moves on its own.
- Motion otherwise answers an action: opening the inspector, switching tabs.
- `prefers-reduced-motion` turns animation off.

## Loading and first run

- **Skeletons, not spinners.** While data loads, each panel shows still
  placeholders in the exact rows the data will fill (chart frame, ladder rows,
  tape rows, account figures), so nothing moves when it arrives. Skeletons do
  not pulse.
- **Cold start.** When the server has not answered within two seconds, the hero
  and the terminal say "Starting the exchange", explain in one line that the
  free server is waking up, count the seconds, and go live on their own.
- **First run.** A single row under the terminal header lists three things to
  try. Each ticks itself off when done; dismissed or completed once, it never
  returns.

## Interaction

- Keyboard first: `B`/`S` side, `M`/`L`/`T` type, `Enter` places, `Esc`
  clears, `↑`/`↓` move a price one tick, `I` opens the inspector, `?` lists
  shortcuts. Letters never fire while typing in a field; Enter never fires on a
  focused button.
- Clicking any price in the book, or the best bid or ask, fills in a limit order.
- Dialogs, the header menu and the inspector take focus when they open, keep
  Tab inside, close on `Esc` and return focus to what opened them.
- Errors say what happened and how to fix it ("Prices move in steps of ₹0.05.
  Round the price to the nearest step.").
