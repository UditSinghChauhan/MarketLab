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
2. Open **Connection details**, turn **Connection pooling off**, and copy the
   connection string. It looks like
   `postgresql://user:password@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

Use the **direct** (non-pooled) string. The engine holds a session-level
advisory lock to guarantee a single writer, which a transaction-mode pooler
cannot keep. The schema is created automatically on first start.

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

| Variable           | Default | Notes                                                                                                                                                            |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`     | none    | Required in production. Direct Neon connection string.                                                                                                           |
| `TOKEN_SECRET`     | none    | Required in production, 32+ characters. Rotating it signs every guest out.                                                                                       |
| `TICK_MS`          | `600`   | Milliseconds between simulated market ticks.                                                                                                                     |
| `WARMUP_MINUTES`   | `30`    | Minutes of history simulated when a new session starts.                                                                                                          |
| `SESSION_HOURS`    | `24`    | A fresh market session starts after this long.                                                                                                                   |
| `LOG_LEVEL`        | `info`  | Fastify/pino log level.                                                                                                                                          |
| `PUBLIC_URL`       | none    | The site's address, used for absolute URLs in link previews. On Render it defaults to the service's `onrender.com` address; set it when you add a custom domain. |
| `RATE_LIMIT_SCALE` | `1`     | Multiplies every rate limit. Only the test suite raises it.                                                                                                      |
| `PORT`             | `8080`  | Render sets this automatically.                                                                                                                                  |

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
- **Data retention.** Sessions older than seven days are deleted at startup.
- **If the database becomes unreachable**, the engine stops accepting orders,
  `/api/health` returns `503`, and the process exits so Render restarts it.
