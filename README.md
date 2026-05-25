# SLA Dashboard — Mintsoft + DPD Local

A live dashboard tracking warehouse dispatch SLA (1pm cut-off) and DPD delivery SLA per client. Runs on Vercel, syncs hourly via cron.

## Architecture

- **Next.js 14** (App Router) — frontend + API in one project
- **Vercel KV** (Redis) — order persistence (free tier covers ~5,000 orders)
- **Vercel Cron** — hourly sync of new orders + DPD tracking

## Deploy in 6 steps

### 1. Push this code to GitHub

Create a new private repo on GitHub called `sla-dashboard` (or anything you like). Upload everything in this folder via the GitHub web UI:

- On the empty repo page, click the **"uploading an existing file"** link
- Drag the contents of this folder in (everything except `node_modules/` if present)
- Commit

### 2. Create a Vercel project

- Go to https://vercel.com/new
- Click **Import** next to your `sla-dashboard` repo
- Leave all settings default
- **Don't click Deploy yet** — add env vars first (next step)

### 3. Add environment variables in Vercel

Before deploying, expand **"Environment Variables"** in the import screen and add:

| Name | Value |
|---|---|
| `MINTSOFT_API_KEY` | Your Mintsoft key |
| `DPD_USERNAME` | Your DPD Local username |
| `DPD_PASSWORD` | Your DPD Local password (change from temp if not yet) |
| `DPD_ACCOUNT_NUMBER` | Your DPD account number |
| `CRON_SECRET` | A long random string (e.g. generate with https://www.random.org/strings) |

### 4. Click **Deploy**

First deploy takes ~90 seconds. You'll get a URL like `sla-dashboard-xyz.vercel.app`.

It will load with empty data — that's expected. Next step adds the database.

### 5. Add the database (Neon Postgres — free)

- In the Vercel dashboard, open your project
- Click the **Storage** tab → **Create Database**
- Choose **Neon — Serverless Postgres** (it's free on Vercel Hobby)
- Click **Continue**, pick a region (London EU-West-2 is closest), accept defaults
- Click **Connect** → tick your project's box → **Connect**

Vercel auto-injects `DATABASE_URL` (and a few other Postgres env vars). Your project redeploys automatically. The app creates its tables on first sync — no SQL setup needed.

### 6. Trigger the first sync

- Open your dashboard URL
- Click **Sync now** in the top right
- Wait ~30 seconds — orders appear

From now on, the cron runs **once daily at 08:00 UTC** automatically (Vercel hobby plan limit). You can hit **Sync now** anytime for an immediate refresh.

If you upgrade to Vercel Pro later, change `vercel.json` to `"schedule": "0 * * * *"` for hourly sync.

## Local dev (optional)

```bash
npm install
cp .env.example .env.local
# Fill in env.local with your values
npm run dev
# Open http://localhost:3000
```

Without KV env vars, it falls back to in-memory storage (resets on restart) — fine for testing.

## How it works

- **Cron** (`/api/cron`) runs hourly. Fetches up to 200 dispatched orders from Mintsoft (`OrderStatusId=4`), upserts into KV, then refreshes DPD tracking for the 30 oldest non-delivered DPD orders.
- **Dashboard** reads from KV — no live API calls on page load.
- **SLA** computed at query time from stored `OrderDate`, `DespatchDate`, `DeliveredDate`.

## Tuning

Override defaults via env vars:

- `WAREHOUSE_CUTOFF_HOUR=13`
- `DPD_DELIVERY_SLA_DAYS=1`

## Files

```
app/
  page.tsx          ← Dashboard UI (React)
  layout.tsx
  globals.css
  api/
    cron/route.ts   ← Hourly sync
    summary/route.ts
    by-client/route.ts
    orders/route.ts
lib/
  mintsoft.ts       ← Mintsoft API client
  dpd.ts            ← DPD Local API client
  sla.ts            ← SLA calculation logic
  storage.ts        ← Vercel KV wrapper
vercel.json         ← Cron schedule (hourly)
```

## Troubleshooting

- **"MINTSOFT_API_KEY not set"** → env var missing, add in Vercel Settings → Environment Variables, then redeploy
- **DPD auth failures** → check username/password/account number, ensure password was changed from the temporary one DPD issued
- **Empty dashboard after sync** → check `/api/cron` response directly: visit `https://your-app.vercel.app/api/cron?key=<your-CRON_SECRET>` and see what it returns
- **Cron not running** → Vercel cron is enabled on all plans. Check **Settings → Cron Jobs** in the dashboard.
- **Database connection errors** → ensure `DATABASE_URL` is set (Vercel sets this automatically when you connect Neon)
