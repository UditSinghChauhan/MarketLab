/** System diagram: how a request, the market stream and a verified replay move through MarketLab. */

import { useScrollFade } from "../ui/useScrollFade";

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
  const { attach: attachScroller, style: scrollerFade } = useScrollFade();
  return (
    <figure className="mt-20">
      <figcaption className="mb-6">
        <h3 className="text-lg font-semibold tracking-[-0.02em]">
          How an order moves through the system
        </h3>
        <p className="mt-2 text-sm text-muted">
          Numbers show the order of steps for one command.
          <span className="md:hidden"> Scroll sideways to see all of it.</span>
        </p>
      </figcaption>
      <div className="rounded-lg border border-line bg-surface p-4">
        <div
          ref={attachScroller}
          style={scrollerFade}
          // Scrollable on small screens, so it must be reachable by keyboard.
          tabIndex={0}
          role="region"
          aria-label="Architecture diagram"
          className="overflow-x-auto"
        >
          <svg
            viewBox="0 0 1060 400"
            className="w-full min-w-[960px]"
            role="img"
            aria-label="Architecture: the browser sends orders over HTTP and receives market data over server-sent events. The API validates and authenticates, then the engine host's single writer first appends the command to the PostgreSQL command log and then applies it to the in-memory matching engine. The host also stores hashed engine snapshots in PostgreSQL; on startup it restores the latest snapshot and replays the rest of the log. For verified replay, the browser downloads the command log, replays it in a Web Worker and compares its state hash with the server's."
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
              y={110}
              w={190}
              h={130}
              title="Browser"
              lines={[
                "Landing page",
                "Trading terminal",
                "Engine inspector",
                "Replay in a Web Worker",
              ]}
            />
            <Box
              x={280}
              y={115}
              w={200}
              h={120}
              title="API (Fastify)"
              lines={["Validation (zod)", "Guest tokens (HMAC)", "Rate limits, CSP"]}
            />
            <Box
              x={560}
              y={115}
              w={200}
              h={120}
              title="Engine host"
              lines={["Single-writer queue", "Market clock", "Read models"]}
              emphasis
            />
            <Box
              x={870}
              y={30}
              w={180}
              h={86}
              title="Command log"
              lines={["PostgreSQL", "Append-only, hashed"]}
            />
            <Box
              x={870}
              y={136}
              w={180}
              h={90}
              title="Snapshot store"
              lines={["PostgreSQL", "Engine state + hash"]}
            />
            <Box
              x={870}
              y={280}
              w={180}
              h={110}
              title="Matching engine"
              lines={["In memory", "Price-time priority", "Seeded bot market"]}
            />

            <Arrow d="M200 165 H276" label="1  order" lx={210} ly={157} />
            <Arrow d="M480 165 H556" label="2  command" lx={488} ly={157} />
            <Arrow d="M760 140 H810 V73 H866" label="3  write" lx={816} ly={65} />
            <Arrow d="M760 180 H866" label="snapshot" lx={816} ly={172} />
            <Arrow d="M760 215 H810 V335 H866" label="4  match" lx={816} ly={327} />
            <Arrow d="M900 226 V276" dashed label="restore + replay on start" lx={908} ly={256} />
            <Arrow
              d="M660 235 V262 H105 V244"
              label="Live updates: book, trades, your fills (server-sent events)"
              lx={230}
              ly={280}
            />
            <Arrow
              d="M960 30 V14 H105 V106"
              dashed
              label="Verified replay: the browser downloads the log, replays it in a Web Worker and compares the state hash"
              lx={120}
              ly={36}
            />
          </svg>
        </div>
      </div>
    </figure>
  );
}
