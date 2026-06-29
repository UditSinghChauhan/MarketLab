# MarketLab — Deployment Guide

This guide deploys MarketLab as three separate services:

| Service | Platform | URL pattern |
|---|---|---|
| Backend API | Railway | `https://marketlab-api.up.railway.app` |
| Dashboard | Vercel | `https://marketlab-dashboard.vercel.app` |
| Landing site | Vercel | `https://marketlab.vercel.app` |

---

## Step 1 — Deploy the Backend on Railway

Railway gives you a free managed Node.js host with environment variable support.

### 1.1 Create a Railway project

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select **UditSinghChauhan/MarketLab**
4. Railway will detect Node.js automatically

### 1.2 Set the root directory

Railway needs to know the backend is in a subdirectory:

1. In your Railway service settings → **Settings tab**
2. Set **Root Directory** to `backend`
3. Railway will now run `npm start` inside `backend/` — which runs `node index.js`

### 1.3 Set environment variables

In the Railway service → **Variables tab**, add:

```
AUTH_SECRET=<generate a random 64-char string>
MONGO_URL=<your MongoDB Atlas connection string>  ← optional
PORT=3002
```

> **MongoDB Atlas (free tier):** Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas), create a database user, whitelist `0.0.0.0/0`, and copy the connection string.
>
> If you skip `MONGO_URL`, the backend uses in-memory storage — data resets on every deploy. Fine for demos, not for persistent use.

### 1.4 Deploy

Click **Deploy**. Railway builds and starts the server. Copy the generated URL — you'll need it next.

**Verify:**
```
GET https://your-railway-url.up.railway.app/health
→ { "status": "ok", "service": "MarketLab API" }
```

---

## Step 2 — Deploy the Dashboard on Vercel

### 2.1 Create a Vercel project

1. Go to [vercel.com](https://vercel.com) and sign in with GitHub
2. Click **Add New → Project**
3. Import **UditSinghChauhan/MarketLab**
4. Set **Root Directory** to `dashboard`
5. Framework Preset: **Create React App**

### 2.2 Set environment variables

In the Vercel project → **Settings → Environment Variables**:

```
REACT_APP_API_URL=https://your-railway-url.up.railway.app
```

> This is the Railway backend URL from Step 1.

### 2.3 Deploy

Click **Deploy**. Vercel builds the React app and serves it globally via CDN.

---

## Step 3 — Deploy the Landing Site on Vercel

Repeat Step 2 but with these differences:

- **Root Directory:** `frontend`
- **Environment variable:**
  ```
  REACT_APP_DASHBOARD_URL=https://your-vercel-dashboard-url.vercel.app
  ```

---

## Step 4 — Update the README

Once all three are live, add the URLs to your README:

```markdown
## Live Demo

| App | URL |
|---|---|
| Landing site | https://your-frontend.vercel.app |
| Dashboard | https://your-dashboard.vercel.app |
| Backend API | https://your-backend.up.railway.app |
```

---

## CORS Note

If the deployed backend rejects requests from Vercel, update `backend/index.js`:

```js
// Replace
app.use(cors());

// With
app.use(cors({
  origin: [
    "https://your-dashboard.vercel.app",
    "https://your-frontend.vercel.app",
  ],
}));
```

Redeploy the backend after this change.

---

## Costs

| Service | Free tier limits |
|---|---|
| Railway | 500 hours/month free (enough for a demo) |
| Vercel | Unlimited static deploys free |
| MongoDB Atlas | 512 MB free cluster, no expiry |

All three services are free for a portfolio project at this scale.
