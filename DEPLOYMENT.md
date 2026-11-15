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

## Configuration

| Variable         | Default | Notes                                                                      |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`   | none    | Required in production. Direct Neon connection string.                     |
| `TOKEN_SECRET`   | none    | Required in production, 32+ characters. Rotating it signs every guest out. |
| `TICK_MS`        | `600`   | Milliseconds between simulated market ticks.                               |
| `WARMUP_MINUTES` | `30`    | Minutes of history simulated when a new session starts.                    |
| `SESSION_HOURS`  | `24`    | A fresh market session starts after this long.                             |
| `LOG_LEVEL`      | `info`  | Fastify/pino log level.                                                    |
| `PORT`           | `8080`  | Render sets this automatically.                                            |

## Operating notes

- **One instance only.** The engine is a single writer. A second instance fails
  at startup with "Another engine process holds the command-log lock"; that is
  the lock doing its job. Don't scale the service horizontally.
- **Free-plan sleep.** Render's free plan stops the service after about 15
  minutes without traffic. The next visit wakes it (expect a cold start of
  roughly a minute), and startup replays the session's log, so no order or
  balance is lost. A paid instance avoids the sleep.
- **Restarts and deploys** replay the log the same way. Guests keep their
  accounts until the session rolls over.
- **Data retention.** Sessions older than seven days are deleted at startup.
- **Snapshots.** Every ten minutes and on shutdown the engine stores a
  hash-checked snapshot, so a restart replays only the last few log entries:
  about half a second instead of up to a minute for a day-old session
  ([ADR 0006](docs/adr/0006-startup-budget-and-snapshots.md)). `SNAPSHOT_MINUTES`
  changes the interval; `0` turns snapshots off.
- **If the database becomes unreachable**, the engine stops accepting orders,
  requests in flight and `/api/health` get `503`, and half a second later the
  process exits so Render restarts it.
- **If startup fails with a TLS or `sslmode` message**, the connection string
  is wrong; the message says which parameter to change.
