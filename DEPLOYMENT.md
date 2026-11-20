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
   `npm start`. Render marks the service live once `/api/health` answers.

## 3. Check it

- `https://<your-service>.onrender.com/api/health` shows `"status":"ok"`,
  `"persistence":"postgres"` and `"invariantViolations":0`.
- The landing page shows a live order book; **Buy 5 shares at market** returns
  a trace with a "Logged to Postgres" time.
- `https://<your-service>.onrender.com/replay` ends with "Your browser replayed
  N engine commands and matched the server exactly".

## Configuration

| Variable               | Default  | Notes                                                                                                                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | none     | Required in production. Direct Neon connection string.                                                                                                           |
| `TOKEN_SECRET`         | none     | Required in production, 32+ characters. Rotating it signs every guest out.                                                                                       |
| `TICK_MS`              | `600`    | Milliseconds between simulated market ticks.                                                                                                                     |
| `WARMUP_MINUTES`       | `30`     | Minutes of history simulated when a new session starts.                                                                                                          |
| `SESSION_HOURS`        | `24`     | A fresh market session starts after this long.                                                                                                                   |
| `SNAPSHOT_MINUTES`     | `10`     | Minutes between engine snapshots while the exchange is in use, which keep restarts fast. `0` turns them off.                                                     |
| `LOG_LEVEL`            | `info`   | Fastify/pino log level.                                                                                                                                          |
| `PUBLIC_URL`           | none     | The site's address, used for absolute URLs in link previews. On Render it defaults to the service's `onrender.com` address; set it when you add a custom domain. |
| `SHUTDOWN_DEADLINE_MS` | `20000`  | Longest a graceful shutdown may take before the process exits with code 1. At most 29000, below Render's 30-second kill.                                         |
| `IDLE_AFTER_MS`        | `300000` | Milliseconds without stream clients or activity before the engine suspends its log. Only the test suite lowers it.                                               |
| `RATE_LIMIT_SCALE`     | `1`      | Multiplies every rate limit. Only the test suite raises it.                                                                                                      |
| `PORT`                 | `8080`   | Render sets this automatically.                                                                                                                                  |

## Operating notes

- **One instance only.** The engine is a single writer. A second instance fails
  at startup with "Another engine process holds the command-log lock"; that is
  the lock doing its job. Don't scale the service horizontally.
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
- **Data retention.** Sessions older than seven days are deleted at startup.
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
  process exits so Render restarts it.
- **If startup fails with a TLS or `sslmode` message**, the connection string
  is wrong; the message says which parameter to change.
