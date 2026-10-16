# Deploying (about 30 minutes)

Three pieces: **Supabase** (Postgres), **ML service** (Render), **web app + API** (Vercel). Order matters.

## 1. Database (Supabase, free tier)
1. Create a project. Settings -> Database -> *Connection string*: copy the **Session/Transaction pooler** URI (it works from serverless).
   Replace `[YOUR-PASSWORD]`.
2. On your laptop (Node 20+, repo cloned, `npm install`):
   ```bash
   export DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@aws-0-xx.pooler.supabase.com:6543/postgres'
   npm run db:migrate                       # creates the tables
   SEED_PASSWORD='choose-a-demo-password' npm run db:seed   # SYNTHETIC demo data + logins (CHIEF, ADMIN, NN25CSE290...)
   ```
   Seeding marks the database `data_source = synthetic_demo`, so the UI shows a SYNTHETIC DATA banner. For real data, import
   real students/meals instead of seeding and set `data_source` to `real` (`PUT /api/settings`).
3. (Recommended) create a read-only role for the ML service:
   `create role ml_reader login password '...'; grant select on mess_usage, users, leave_requests to ml_reader;`

For local commands, copy `.env.example` to `.env` and set `DATABASE_URL` to the pooled URI shown above. The
`db:migrate` and `db:seed` scripts load the repository-root `.env` automatically; an existing environment variable
takes precedence. The URI has the form `postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=require`.

## 2. ML service (Render)
1. Render -> **New -> Blueprint** -> select the repo (reads `render.yaml`).
2. Set `DATABASE_URL` to the read-only (or the same) connection string. Leave `HISTORY_SOURCE=postgres`, `DATA_LABEL=synthetic`.
3. After the first boot (about 1-2 minutes: it trains from `mess_usage`) open `https://<name>.onrender.com/health` -> `model_loaded: true`.
4. Copy the generated `ML_API_KEY` (Render -> Environment).
5. Free instances sleep after ~15 min idle (first request 30-50 s). Open `/health` before a demo or use an uptime pinger.
   If the ML service is asleep or down the dashboard still works: forecasts fall back to the 7-day average with a visible warning.

## 3. Web app + API (Vercel)
Import the repo (Framework = Other, root directory = repo root). Environment variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase pooler URI (**required**; without it the site runs the synthetic demo backend) |
| `SESSION_SECRET` | 32+ random characters: `openssl rand -hex 32` (**required**) |
| `ML_SERVICE_URL`, `ML_API_KEY` | Render URL (no trailing slash) and its key |
| `QR_SECRET` | optional, defaults to `SESSION_SECRET`; change it to invalidate printed QR codes |
| `WARDEN_WEBHOOK_SECRET` | optional; enables `POST /api/warden/webhook` |

Deploy, then check `https://<app>.vercel.app/api/health`: expect `"database":"connected"` and `"forecasts":"ml-service (baseline fallback)"`.

## 4. Smoke test (2 minutes)
1. Sign in as **Mess Chief** (`CHIEF`, your seed password) -> *Counter QR* shows the code; *Dashboard* shows expected/served; *Prepared & Actuals* saves.
2. On a phone, sign in as **Hostel Student** `NN25CSE290` -> *Scan QR* -> scan the code on the chief's screen (or paste its text).
   You see a green result; the chief's served count rises; a second scan is red "Already scanned".
3. Demo database only: meal windows are not enforced, so the scan page asks which meal you are scanning. Before real use set
   `demo_ignore_windows` to `false` (`PUT /api/settings`, admin).

## 5. Going to real data
Replace seeded users/logs with real ones (same tables), set `data_source=real`, set `DATA_LABEL=real` on the ML service and call its
`POST /retrain`. The model report shows whether XGBoost beats the 7-day average on your real history. Change the seeded demo password and delete the demo accounts.
