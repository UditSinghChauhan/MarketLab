/** System diagram: how a request and the market stream move through MarketLab. */

const BOX = "fill-[var(--surface)] stroke-[var(--line)]";

function Box({
  x,
  y,
  w,
  h,
  title,
  lines,
  emphasis = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  lines: string[];
  emphasis?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        className={emphasis ? "fill-[var(--surface)] stroke-[var(--accent)]" : BOX}
      />
      <text x={x + 16} y={y + 26} className="fill-[var(--text)] text-[13px] font-semibold">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={line} x={x + 16} y={y + 48 + i * 18} className="fill-[var(--muted)] text-[12px]">
          {line}
        </text>
      ))}
    </g>
  );
}

function Arrow({
  d,
  label,
  lx,
  ly,
  dashed = false,
}: {
  d: string;
  label?: string;
  lx?: number;
  ly?: number;
  dashed?: boolean;
}) {
  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="var(--muted)"
        strokeWidth={1.25}
        markerEnd="url(#arrow)"
        strokeDasharray={dashed ? "4 4" : undefined}
      />
      {label && lx !== undefined && ly !== undefined && (
        <text x={lx} y={ly} className="fill-[var(--muted)] text-[11px]">
          {label}
        </text>
      )}
    </g>
  );
}

export function Architecture() {
  return (
    <figure className="mt-16">
      <figcaption className="mb-4 text-sm text-muted">
        How an order moves through the system. Numbers show the order of steps for one command.
      </figcaption>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface p-4">
        <svg
          viewBox="0 0 960 300"
          className="min-w-[680px]"
          role="img"
          aria-label="Architecture: the browser sends orders over HTTP and receives market data over server-sent events. The API validates and authenticates, then the engine host's single writer first appends the command to the Postgres command log and then applies it to the in-memory matching engine. On startup the log is replayed into the engine."
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
            </marker>
          </defs>

          <Box
            x={10}
            y={90}
            w={170}
            h={110}
            title="Browser"
            lines={["Landing page", "Trading terminal", "Engine inspector"]}
          />
          <Box
            x={260}
            y={90}
            w={190}
            h={110}
            title="API (Fastify)"
            lines={["Validation (zod)", "Guest tokens (HMAC)", "Rate limits, CSP"]}
          />
          <Box
            x={530}
            y={90}
            w={190}
            h={110}
            title="Engine host"
            lines={["Single-writer queue", "Market clock", "Read models"]}
            emphasis
          />
          <Box
            x={790}
            y={20}
            w={160}
            h={100}
            title="Command log"
            lines={["PostgreSQL", "Append-only"]}
          />
          <Box
            x={790}
            y={170}
            w={160}
            h={110}
            title="Matching engine"
            lines={["In memory", "Price-time priority", "Seeded bot market"]}
          />

          <Arrow d="M180 125 H256" label="1  order (HTTP)" lx={186} ly={117} />
          <Arrow d="M450 125 H526" label="2  command" lx={462} ly={117} />
          <Arrow d="M720 112 C 750 112, 760 70, 786 70" label="3  write" lx={732} ly={84} />
          <Arrow d="M720 165 C 750 165, 760 222, 786 222" label="4  match" lx={712} ly={238} />
          <Arrow
            d="M625 200 V250 H95 V204"
            label="Live updates: book, trades, your fills (server-sent events)"
            lx={210}
            ly={268}
          />
          <Arrow d="M870 120 V166" dashed label="replay on start" lx={878} ly={148} />
        </svg>
      </div>
    </figure>
  );
}
