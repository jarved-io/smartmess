-- Smart Mess schema (PostgreSQL / Supabase). Idempotent: safe to run repeatedly.
-- Tables follow the PRD (section 6) plus: meal_logs.event_id (idempotent offline sync),
-- auth_attempts (login throttling), users.password_hash.

CREATE TABLE IF NOT EXISTS messes (
  id       text PRIMARY KEY,                -- slug, e.g. 'south' (also what the ML service uses as mess_id)
  name     text NOT NULL UNIQUE,            -- display name, e.g. 'South Mess'
  location text,
  active   boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role          text NOT NULL CHECK (role IN ('student','mess_manager','warden','admin')),
  student_id    text NOT NULL UNIQUE,       -- login ID: USN for students, staff ID otherwise
  name          text NOT NULL,
  email         text,
  photo_url     text,
  mess_id       text REFERENCES messes(id), -- student's mess / manager's mess (NULL manager = all messes)
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_mess_role_idx ON users (mess_id, role, status);

CREATE TABLE IF NOT EXISTS meal_windows (
  id         serial PRIMARY KEY,
  mess_id    text NOT NULL REFERENCES messes(id),
  meal_type  text NOT NULL,                 -- lowercase: breakfast | lunch | dinner
  start_time time NOT NULL,
  end_time   time NOT NULL,
  UNIQUE (mess_id, meal_type)
);

CREATE TABLE IF NOT EXISTS meal_logs (
  id         bigserial PRIMARY KEY,
  event_id   text NOT NULL UNIQUE,          -- client-generated; retries / offline sync cannot duplicate
  user_id    uuid NOT NULL REFERENCES users(id),
  mess_id    text REFERENCES messes(id),
  meal_type  text,
  meal_date  date NOT NULL,                 -- mess-local date
  scanned_at timestamptz NOT NULL DEFAULT now(),
  result     text NOT NULL CHECK (result IN ('success','duplicate','outside_window','on_leave','invalid_qr','wrong_mess','inactive')),
  reason     text,
  source     text NOT NULL DEFAULT 'online'
);
-- one successful meal per student per meal period per day, enforced by the database (race-proof)
CREATE UNIQUE INDEX IF NOT EXISTS meal_logs_one_success ON meal_logs (user_id, meal_date, meal_type) WHERE result = 'success';
CREATE INDEX IF NOT EXISTS meal_logs_mess_idx ON meal_logs (mess_id, meal_date, meal_type, result);
CREATE INDEX IF NOT EXISTS meal_logs_user_idx ON meal_logs (user_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  type       text NOT NULL,
  amount     numeric(12,2) NOT NULL,
  reference  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id          bigserial PRIMARY KEY,
  external_id text UNIQUE,                  -- id in the Warden app (idempotent sync)
  user_id     uuid NOT NULL REFERENCES users(id),
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending','approved','rejected')),
  approved_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS leave_user_idx ON leave_requests (user_id, status, start_date, end_date);

CREATE TABLE IF NOT EXISTS add_on_orders (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  add_on_type text NOT NULL,
  quantity    int  NOT NULL CHECK (quantity > 0),
  date        date NOT NULL,
  amount      numeric(12,2)
);

CREATE TABLE IF NOT EXISTS mess_usage (
  id             bigserial PRIMARY KEY,
  mess_id        text NOT NULL REFERENCES messes(id),
  date           date NOT NULL,
  meal_type      text NOT NULL,
  prepared_count int CHECK (prepared_count >= 0),
  served_count   int CHECK (served_count >= 0),   -- the ML target (served_meals)
  waste_count    int CHECK (waste_count >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mess_id, date, meal_type)
);

CREATE TABLE IF NOT EXISTS forecasts (
  id                bigserial PRIMARY KEY,
  mess_id           text NOT NULL REFERENCES messes(id),
  target_date       date NOT NULL,
  meal_type         text NOT NULL,
  predicted_count   int  NOT NULL CHECK (predicted_count >= 0),
  recommended_count int,
  range_low         int,
  range_high        int,
  model_version     text NOT NULL,
  method            text,
  warnings          jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS forecasts_lookup_idx ON forecasts (mess_id, target_date, meal_type, created_at DESC);

CREATE TABLE IF NOT EXISTS forecast_evaluations (
  id             bigserial PRIMARY KEY,
  forecast_id    bigint NOT NULL UNIQUE REFERENCES forecasts(id) ON DELETE CASCADE,
  actual_count   int NOT NULL,
  absolute_error double precision NOT NULL,
  squared_error  double precision NOT NULL,
  evaluated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  id         serial PRIMARY KEY,
  mess_id    text REFERENCES messes(id),    -- NULL = global
  key        text NOT NULL,
  value      text NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS settings_unique ON settings (COALESCE(mess_id, ''), key);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  before_json jsonb,
  after_json  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id         bigserial PRIMARY KEY,
  student_id text NOT NULL,
  ok         boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_attempts_idx ON auth_attempts (student_id, at DESC);
