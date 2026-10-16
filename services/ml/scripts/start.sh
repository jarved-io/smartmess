#!/bin/sh
# Container / Render entrypoint (run from anywhere).
#  - No HISTORY_CSV set  -> DEMO MODE: generate SYNTHETIC history ending today, train, serve. Labelled synthetic everywhere.
#  - HISTORY_SOURCE=postgres -> trains from the database (set DATA_LABEL=synthetic while the DB holds demo data)
#  - HISTORY_CSV set     -> REAL MODE: train once if no model exists yet, then serve. Retrain via POST /retrain.
set -e
cd "$(dirname "$0")/.."
if [ "$HISTORY_SOURCE" = "postgres" ]; then
  # Train from the Smart Mess database (mess_usage). Models live on ephemeral disk: retrain at boot, or POST /retrain later.
  if [ ! -f models/LATEST ]; then python -m src.train --from-source --data-label "${DATA_LABEL:-real}" --no-cv; fi
elif [ -z "$HISTORY_CSV" ]; then
  export HISTORY_CSV="data/demo/SYNTHETIC_meal_history.csv"
  python -m src.synthetic --out "$HISTORY_CSV"
  rm -f models/LATEST
  python -m src.train --data "$HISTORY_CSV" --data-label synthetic --no-cv
elif [ ! -f models/LATEST ]; then
  python -m src.train --data "$HISTORY_CSV" --data-label "${DATA_LABEL:-real}" --no-cv
fi
exec uvicorn api.app:app --host 0.0.0.0 --port "${PORT:-8000}"
