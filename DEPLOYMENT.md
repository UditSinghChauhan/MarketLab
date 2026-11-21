# Deploying MarketLab

One Render web service runs the API and the matching engine and serves the
built web app from the same origin. Neon provides PostgreSQL for the command
log. Both have free plans.

```
Browser ──HTTPS──▶ Render web service (Node 22)
                     ├─ /api/*   REST + server-sent events
                     └─ /*       built web app
                          │
                          └──TLS──▶ Neon PostgreSQL (command log)
```

## 1. Database (Neon)

1. Create a project. Pick the region closest to your Render region
   (`AWS Asia Pacific (Singapore)` matches the blueprint's `singapore`).
2. Open **Connect**, turn **Connection pooling off**, and copy the connection
   string. It has exactly this shape:

   ```
   postgresql://<user>:<password>@ep-<name>-<id>.<region>.aws.neon.tech/<database>?sslmode=require&channel_binding=require
   ```

   Check two things before pasting it into Render:

   - The host must **not** contain `-pooler`. `ep-cool-name-a1b2c3d4.ap-southeast-1.aws.neon.tech`
     is the direct endpoint; `ep-cool-name-a1b2c3d4-pooler...` is the pooled one.
     The engine holds a session-level advisory lock to guarantee a single
     writer, which a transaction-mode pooler cannot keep.
   - Keep both query parameters. `sslmode=require` makes the server connect over
     TLS and verify Neon's certificate and host name. `channel_binding=require`
     ties the password exchange to that TLS connection.

The schema is created automatically on first start.

How the parameters are read ([`connection.ts`](apps/api/src/log/connection.ts)):

| Parameter                                     | Effect                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| `sslmode=require`, `verify-ca`, `verify-full` | TLS; certificate and host name are verified              |
| `sslmode=no-verify`                           | TLS without verification (self-signed test servers only) |
| `sslmode=disable`, or no `sslmode`            | No TLS. For localhost only                               |
| `sslmode=prefer`, `allow`                     | Refused at startup, with a message saying what to use    |
| `channel_binding=require`                     | SCRAM channel binding; needs TLS, refused without it     |
| `channel_binding=prefer` (default), `disable` | Used when TLS is on and the server offers it; or never   |

## 2. Web service (Render)

1. In Render, choose **New → Blueprint** and connect this repository. Render
   reads [`render.yaml`](render.yaml).
2. When asked for `DATABASE_URL`, paste the Neon connection string.
   `TOKEN_SECRET` is generated for you.
3. Apply. The first build runs `npm ci --include=dev && npm run build`, then
   `npm start`. Render marks the service live once `/api/health` answers 200.
   Until the engine has the command log and has replayed it, health answers
   `503` with `"status":"starting"` and a reason.

## 3. Check it

- `https://<your-service>.onrender.com/api/health` shows `"status":"ok"`,
  `"persistence":"postgres"` and `"invariantViolations":0`.
- The landing page shows a live order book; **Buy 5 shares at market** returns
  a trace with a "Logged to Postgres" time.
- `https://<your-service>.onrender.com/replay` ends with "Your browser replayed
  N engine commands and matched the server exactly".

### Check the client-address header

Rate limits need each visitor's address. Behind Render's proxy every request
arrives from the proxy, so the server reads the address from the one header
named in `CLIENT_IP_HEADER`, and trusts no header until it is set. Cloudflare
sets `CF-Connecting-IP` (`True-Client-IP` only on its Enterprise plan). Which
header reaches the service has to be checked on the live service, not
assumed:

1. Set `CLIENT_IP_HEADER` to `CF-Connecting-IP` in the service's environment
   and let it redeploy.
2. **A forged value must be replaced.** From one machine, open 12 sessions,
   each claiming a different address:

   ```sh
   for i in $(seq 12); do
     curl -s -o /dev/null -w '%{http_code}\n' -X POST \
       -H "CF-Connecting-IP: 203.0.113.$i" https://<your-service>.onrender.com/api/session
   done
   ```

   Expect ten `201` and then `429`: the proxy overwrote the forged header with
   your real address, so all 12 counted against one limit. If all 12 answer
   `201`, the header passes through from the client and anyone can dodge the
   limits with it: remove `CLIENT_IP_HEADER` and find the header Render's
   proxy does set.

3. **Different visitors must count apart.** Within the same minute, open one
   session from another network (a phone on mobile data). Expect `201`. A
   `429` means the header is missing and every visitor shares the proxy's
   limit.

The check opens about 13 guest accounts, which count towards
`MAX_GUESTS_PER_SESSION` until the session rolls over. Nothing logs or
returns the addresses involved.

## Configuration

| Variable                 | Default  | Notes                                                                                                                                                                                          |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | none     | Required in production. Direct Neon connection string.                                                                                                                                         |
| `TOKEN_SECRET`           | none     | Required in production, 32+ characters. Rotating it signs every guest out.                                                                                                                     |
| `TICK_MS`                | `600`    | Milliseconds between simulated market ticks.                                                                                                                                                   |
| `WARMUP_MINUTES`         | `30`     | Minutes of history simulated when a new session starts.                                                                                                                                        |
| `SESSION_HOURS`          | `24`     | A session this old ends at the next idle moment (or restart) and a fresh one starts; see [Market sessions](#operating-notes).                                                                  |
| `SNAPSHOT_MINUTES`       | `10`     | Minutes between engine snapshots while the exchange is in use, which keep restarts fast. `0` turns them off.                                                                                   |
| `LOG_LEVEL`              | `info`   | Fastify/pino log level.                                                                                                                                                                        |
| `PUBLIC_URL`             | none     | The site's address, used for absolute URLs in link previews. On Render it defaults to the service's `onrender.com` address; set it when you add a custom domain.                               |
| `CLIENT_IP_HEADER`       | none     | The header the proxy sets to the visitor's address, used to key rate limits. Set it only after [checking it](#check-the-client-address-header). `X-Forwarded-For` and `Forwarded` are refused. |
| `MAX_GUESTS_PER_SESSION` | `500`    | Guest accounts one market session accepts; past it, new visitors get `503` "The demo is full until the market resets". Limits accounts only, not orders, snapshot size or command-log size.    |
| `LOCK_WAIT_MS`           | `840000` | How long a starting instance waits for the previous one to release the command log before exiting with code 1. At most 900000: Render's 15-minute limit, assumed, not verified live.           |
| `SHUTDOWN_DEADLINE_MS`   | `20000`  | Longest a graceful shutdown may take before the process exits with code 1. At most 29000, below Render's 30-second kill.                                                                       |
| `IDLE_AFTER_MS`          | `300000` | Milliseconds without stream clients or activity before the engine suspends its log. Only the test suite lowers it.                                                                             |
| `RATE_LIMIT_SCALE`       | `1`      | Multiplies every rate limit. Only the test suite raises it.                                                                                                                                    |
| `PORT`                   | `8080`   | Render sets this automatically.                                                                                                                                                                |

## Operating notes

- **One instance only.** The engine is a single writer: only the process
  holding the command log's lock writes. Don't scale the service horizontally;
  extra instances would only ever wait.
- **Deploys wait for the site to go quiet.** Render starts the new instance
  while the old one still serves. The new one listens at once, but answers
  `/api/health` with `503 {"status":"starting","reason":"waiting for the
previous instance"}` until the old one has gone idle (five minutes after the
  last visitor leaves) and released the log. It then replays the log (health
  says "replaying the command log"), turns healthy, and Render switches
  traffic to it. While it waits it logs `lock_waiting` every 30 seconds.
  - If someone stays on the site for longer than `LOCK_WAIT_MS` (14 minutes),
    the new instance gives up and exits with code 1, Render reports the deploy
    as failed, and **the old version keeps serving**. Deploy again later.
  - Between the takeover and the switch, a request that still reaches the old
    instance gets `503` at once (the web app shows "Starting the exchange" and
    retries); the old instance then waits for its `SIGTERM` and exits without
    writing.
  - This is deferral, not a zero-downtime handover
    ([ADR 0009](docs/adr/0009-deploys-with-a-single-writer.md)). To deploy at
    once, deploy when nobody is on the site.
  - Render's sequence here (traffic switches once health is 200, a 15-minute
    limit for that, and `SIGTERM` to the old instance 60 seconds after the
    switch) is a platform assumption the design relies on, not something
    verified on a live deploy.
- **Rate limits without `CLIENT_IP_HEADER`.** Until it is set, no proxy
  header is trusted, so every visitor arrives with the proxy's address and
  shares one set of limits (for the whole site: 10 new sessions a minute,
  30 orders every 10 seconds).
  The server logs a warning saying so at startup.
- **When the demo is full.** A session that reaches
  `MAX_GUESTS_PER_SESSION` guests keeps serving everyone who already has an
  account; new visitors see "The demo is full until the market resets" until
  the next session starts.
- **What the guest cap does not bound.** It limits accounts, not activity.
  The snapshot and the command log grow with orders, and orders are limited
  only by the per-address rate limit (30 every 10 seconds), so one scripted
  guest can keep both growing for the whole session. Measured
  (`npm run bench:guests -w @marketlab/api`): a guest without orders adds
  85 B to the snapshot, each order about 0.7 KB. 500 guests averaging 10
  orders came to 3.5 MB, and averaging 60 orders to 19 MB. Nothing caps the
  log's size; sessions older than seven days are deleted at startup and at
  each rollover.
- **Free-plan sleep.** Render's free plan stops the service after about 15
  minutes without traffic. The next visit wakes it (expect a cold start of
  roughly a minute), and startup replays the session's log, so no order or
  balance is lost. While it wakes, the landing page and the terminal show
  "Starting the exchange", keep retrying, and go live on their own. A paid
  instance avoids the sleep.
- **Link previews.** `apps/web/public/og.png` is a rendered screenshot. After a
  visible change to the terminal, regenerate it with the app running:
  `BASE_URL=http://localhost:8080 npm run assets -w @marketlab/web`.
- **Restarts and deploys** replay the log the same way. Guests keep their
  accounts until the session rolls over.
- **Market sessions.** A session ends once it is `SESSION_HOURS` old and the
  exchange is idle (no stream client and no activity for five minutes), or
  at a restart after that age. It is not a fixed daily time: a session in
  use carries on until the site goes quiet. The engine then:
  - logs the old session's remaining ticks and a final snapshot;
  - starts a new session with a new seed, runs the warm-up and snapshots it;
  - deletes sessions older than seven days;
  - logs `session_rolled_over` with both session ids, the old session's
    last entry and the time taken.

  Guest accounts, balances and open orders end with the old session. A
  returning visitor's token is refused with `session_expired`, and the web
  app opens a new guest account on its own. Requests that arrive during a
  rollover wait for it. Measured against local PostgreSQL 16, with
  production's 3,000 warm-up ticks: 0.6 s in all, 0.58 s of it the warm-up.
  On Neon the rollover may first wake the database, which was not measured.

- **Shutdown.** On `SIGTERM` the server stops taking work at once: every new
  request gets `503` with `Connection: close`, and `/api/health` answers
  `503` with `"status":"stopping"`. It then closes every event stream, lets
  orders already queued finish (each is logged before its `201`), logs the
  pending ticks, stores a final snapshot, closes all connections and the
  command log, and exits with code 0, normally within a second. If the log was
  suspended and another instance has taken it over meanwhile, the final write
  is skipped with the warning "another instance owns the log; idle ticks not
  persisted (ADR 0007)", which is not an error. If shutdown takes longer than
  `SHUTDOWN_DEADLINE_MS`, the process logs `shutdown_deadline_exceeded` with
  the step it was stuck in and exits with code 1, before Render's 30-second
  kill.
- **Lifecycle events.** Startup, the log's suspend and resume, snapshots,
  persistence failures and shutdown are each logged as one JSON line with an
  `event` field (`engine_ready`, `log_suspended`, `shutdown_completed`, …), so
  they can be searched in Render's logs. They never contain tokens or client
  addresses.
- **Data retention.** Sessions that started more than seven days ago are
  deleted at startup and at each rollover, except the current session.
- **Snapshots.** Every ten minutes while the exchange is in use, when it goes
  idle, when it wakes and on shutdown, the engine stores a hash-checked
  snapshot, so a restart replays only the last few log entries: about half a
  second instead of up to a minute for a day-old session
  ([ADR 0006](docs/adr/0006-startup-budget-and-snapshots.md)).
- **The database idles with the exchange.** Five minutes after the last
  stream client disconnects and the last order, the engine stops writing,
  releases its lock and closes its database connection, so Neon's compute
  can scale to zero and the free plan's compute hours last the month. The
  market keeps running in memory. The next visitor's first write reconnects
  (that order's "Written to the command log" time includes Neon waking up).
  `/api/health` never touches the database, so health checks do not keep it
  awake. Bot ticks from an idle stretch are logged when activity returns or on
  shutdown; a crash before then loses only those
  ([ADR 0007](docs/adr/0007-idle-aware-persistence.md)).
- **If the database becomes unreachable**, the engine stops accepting orders,
  requests in flight and `/api/health` get `503`, and half a second later the
  process exits so Render restarts it. One case is ambiguous: if the
  connection drops after PostgreSQL committed an order but before it replied,
  the visitor gets `503`, yet the order is in the log and exists after the
  restart. Retrying places it again. This is a known limitation
  ([ADR 0004](docs/adr/0004-command-log.md)).
- **If startup fails with a TLS or `sslmode` message**, the connection string
  is wrong; the message says which parameter to change.
