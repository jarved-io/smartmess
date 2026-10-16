# Smart Mess

Hostel mess meal tracking + **aggregate meal-demand forecasting** (XGBoost). Students scan a QR with their own phone;
mess staff only check green/red; the manager dashboard shows live counts, tomorrow's forecast, predicted vs actual and reports.

```
public/            web app (student portal + manager dashboard), static; web/live.js connects it to the backend
api/[...path].js   Vercel serverless entry: real backend when DATABASE_URL is set, synthetic demo backend otherwise
lib/               backend: auth, scan validation, routes, forecasts, Warden adapter, seed (see docs/BACKEND.md)
db/schema.sql      PostgreSQL schema (PRD tables)        scripts/db.js   migrate / seed
mock/, adapters/   synthetic demo backend (no-database fallback) and ML adapter
services/ml/       Python FastAPI + XGBoost forecasting service (own README); trains from the database
docs/              BACKEND, API contract, DEPLOY, demo script/status
test/              unit, backend (PGlite or real Postgres), browser-flow (jsdom) tests; Playwright E2E run locally
```

## What is real and what is demo (read before presenting)
| Part | Status |
|---|---|
| Student/staff login, role checks, QR scan with server-side validation, meal ledger, leave rules, prepared/actual recording, dashboards, reports, forecast storage and evaluation | **Real code on PostgreSQL**, tested (including against a real Postgres server) |
| XGBoost pipeline (baseline comparison, chronological validation, versioned models) | Real code; trains from the `mess_usage` table |
| **Data in the deployed demo** | **SYNTHETIC** (seeded; flagged on screen). Forecast accuracy numbers say nothing about real accuracy until real meal history exists |
| Warden integration | Adapter + webhook; the Warden app itself is not built here |
| Menu, inventory, feedback pages | Browser-only demo (not in the PRD data model) |
| Pricing/ledger charges, offline local server, rotating QR | Not built (open decisions in the PRD) |

Without `DATABASE_URL` the site falls back to a fully synthetic demo backend, so it never shows a broken page.

## Run locally
```bash
LOCAL_DB=pglite npm start                # real backend on an in-process Postgres, SYNTHETIC data; logins CHIEF / NN25CSE290, password demo1234
npm start                                # no database: synthetic demo backend
cd services/ml && pip install -r requirements-dev.txt
ML_API_KEY=dev sh scripts/start.sh       # ML service on :8000 (demo mode, synthetic data)
ML_SERVICE_URL=http://localhost:8000 ML_API_KEY=dev npm start     # real XGBoost forecasts in the dashboard
node scripts/check.js && npm test        # web + backend + browser-flow tests
cd services/ml && python -m pytest -q    # ML tests
```
For PostgreSQL commands, copy `.env.example` to `.env` and set `DATABASE_URL` to your PostgreSQL connection URI.
The database scripts load `.env` automatically; an environment-provided `DATABASE_URL` takes precedence. For Supabase,
use its pooled URI (`postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=require`).
Deploy: `docs/DEPLOY.md` (Supabase, Render, Vercel). Backend reference: `docs/BACKEND.md`. Environment variables: `.env.example`.
