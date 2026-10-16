# Backend reference (Member 2 scope)

Stack: Node serverless functions on Vercel (`api/[...path].js` -> `lib/backend.js` -> `lib/routes.js`), PostgreSQL
(Supabase/Neon) via `pg`, schema in `db/schema.sql`. No framework, no ORM: plain parameterised SQL.
The static app is served from the same origin, so there is no CORS surface and the session cookie is first-party.

## Run it
```bash
LOCAL_DB=pglite npm start                 # real backend on an in-process Postgres (no install). Seeds SYNTHETIC data. password: demo1234
DATABASE_URL=... SESSION_SECRET=... npm start   # against any Postgres (POSTGRES_URL / PRISMA_DATABASE_URL are also accepted)
DATABASE_URL=... npm run db:migrate && SEED_PASSWORD=... npm run db:seed   # create tables, load SYNTHETIC demo data
npm test                                   # unit + backend (PGlite) + browser-flow (jsdom) tests
TEST_DATABASE_URL=postgresql://... node --test test/backend.test.js   # same backend tests on a real server
```

## Authentication and roles
* `POST /api/auth/login {student_id, password}`: scrypt-hashed passwords, HMAC-signed `HttpOnly; SameSite=Lax; Secure` cookie
  (12 h), 8 failed attempts / 10 min per ID -> 429. The user is re-read from the database on every request, so deactivating
  an account takes effect immediately. `SESSION_SECRET` is **required** in production.
* POST bodies must be `application/json` (blocks cross-site form posts); there are no CORS headers (same origin only).
* Roles: `student`, `mess_manager` (`mess_id` NULL = all messes), `admin`, `warden`. Enforced server-side in `lib/auth.js`.

| Endpoint | student | manager | admin | warden |
|---|:-:|:-:|:-:|:-:|
| `POST /api/meals/scan`, `GET /api/meals/history`, `GET /api/account` | yes | - | - | - |
| `GET /api/meal-windows` | own mess | yes | yes | - |
| dashboard, forecasts, evaluations, exceptions, reports, mess-usage, `mess/qr`, `meals/attendance`, `students` | - | own mess | yes | - |
| `GET /api/warden/leave-status` | own record | - | yes | yes |
| `PUT /api/settings` | - | - | yes | - |
| `POST /api/warden/webhook` | shared secret header, disabled unless `WARDEN_WEBHOOK_SECRET` is set | | | |

## Meal scan validation (`lib/scan.js`)
Deterministic order: signed QR -> account active -> meal window (server clock, mess timezone; **the client cannot choose the
meal**) -> correct mess -> duplicate -> leave policy. Every attempt is logged in `meal_logs` with a machine-readable
`result` (`success, duplicate, outside_window, on_leave, invalid_qr, wrong_mess, inactive`).
* One successful meal per student per meal per day is enforced **by the database** (partial unique index), so two phones
  scanning at once cannot both succeed. Retries with the same `event_id` return the original outcome (idempotent offline sync).
* The QR is `SMARTMESS:v1:<mess>:<HMAC>`; staff never scan. Show it from the Mess Chief's "Counter QR" page. Rotate by changing `QR_SECRET`.
* Balance never blocks a scan and no ledger charges are written: pricing and billing rules are still an open decision.
* Business rules live in the `settings` table (admin-editable, audited): `leave_policy` (reject|flag|ignore),
  `cross_mess_policy`, `safety_buffer`, `timezone`, `demo_ignore_windows`, `data_source`.

## Definitions (answers to the contract's open questions)
* `expected` = the stored forecast for that mess/date/meal (XGBoost via the ML service, or the 7-day average). `null` if none exists.
* `served` = verified scans today; past days use `mess_usage.served_count`. `prepared` = `mess_usage.prepared_count`. Unknown = `null`, never 0.
* Forecasts (`GET /api/forecasts`) are stored in `forecasts` (model version, method, range, warnings) and reused for 3 h.
  The backend sends `active_students` and `approved_leave` to the ML service. If the ML service is down or has no history,
  the 7-day average is stored and shown with an explicit warning; with no history at all the meal is reported `unavailable`.
* Predicted vs actual (`/api/forecasts/evaluations`) joins the latest stored forecast with `mess_usage.served_count` and persists
  `forecast_evaluations` (absolute and squared error). Close each meal on the "Prepared & Actuals" page to store the actual.
* The ML service reads `mess_usage` directly (`HISTORY_SOURCE=postgres`), so every closed meal becomes training data; `POST /retrain` on the ML service refreshes the model.

## Warden integration
The Warden app stays the approval system. This backend only mirrors approved leave: `POST /api/warden/webhook`
(`x-warden-secret` header, body `{external_id, student_id, start_date, end_date, status, approved_by}` or `{items:[...]}`) upserts
`leave_requests` idempotently; `GET /api/warden/leave-status` reads it. If the Warden app cannot push, replace `webhook` with a polling job against its API.

## Not done / decisions needed
Meal pricing, ledger charges and low-balance alerts; add-on orders (table exists, no endpoints); offline local server;
rotating QR; student photos (column exists); real data import; production admin UI for users. Exact meal windows
(`meal_windows` table: seeded 07:30-08:45, 12:00-13:45, 19:30-20:45 as placeholders) and the leave policy must be confirmed with the college.
Menu, inventory and feedback pages in the static app are not in the PRD's data model and remain browser-only demo features.
