import pandas as pd
import pytest

from src import config as C
from src.features import assert_no_leakage, build_features
from src.predict import ModelBundle, load_latest, predict_meals, InsufficientHistoryError
from src.preprocessing import DataValidationError, clean
from src.synthetic import generate
from src.train import run_training


@pytest.fixture(scope="module")
def raw():
    return generate(days=200, seed=1, messes=("south",))


def test_no_leakage(raw):
    assert_no_leakage(clean(raw)[0])


def test_leak_detector_catches_leak(raw):
    from src import features
    df = clean(raw)[0]
    orig = features._group_features

    def leaky(g, optional):
        out = orig(g, optional)
        out["roll_mean_7"] = out[C.TARGET]  # deliberately peeks at the present
        return out
    features._group_features = leaky
    try:
        with pytest.raises(AssertionError):
            assert_no_leakage(df)
    finally:
        features._group_features = orig


def test_cleaning_reports_not_silent(raw):
    dirty = pd.concat([raw, raw.iloc[:5]]).copy()
    dirty.loc[dirty.index[0], C.DATE] = "not-a-date"
    df, rep = clean(dirty)
    assert rep["invalid_dates_dropped"] >= 1 and rep["rows_raw"] == len(dirty)


def test_missing_required_column():
    with pytest.raises(DataValidationError):
        clean(pd.DataFrame({"date": ["2026-01-01"], "mess_id": ["s"]}))


def test_cold_start_baseline_only(tmp_path):
    meta = run_training(generate(days=30, messes=("south",)), out_root=tmp_path / "m", reports_root=tmp_path / "r")
    assert meta["mode"] == "baseline"
    b = load_latest(tmp_path / "m")
    out = predict_meals({"mess_id": "south", "date": "2025-07-31", "meal_type": "lunch"}, history=generate(days=30, messes=("south",)), bundle=b)
    assert out["method"] == "moving_average_7"


def test_train_and_predict(raw, tmp_path):
    meta = run_training(raw, out_root=tmp_path / "m", reports_root=tmp_path / "r", data_label="synthetic", run_cv=False)
    assert meta["version"] == "xgb_v1" and meta["mode"] in ("xgboost", "baseline")
    assert run_training(raw, out_root=tmp_path / "m", reports_root=tmp_path / "r", run_cv=False)["version"] == "xgb_v2"
    b = load_latest(tmp_path / "m")
    nxt = (pd.to_datetime(raw[C.DATE]).max() + pd.Timedelta(days=1)).date().isoformat()
    out = predict_meals({"mess_id": "South", "date": nxt, "meal_type": "Lunch", "active_students": 900, "approved_leave": 60},
                        history=raw, bundle=b)
    assert out["model_version"] == "xgb_v2" and out["predicted_meals"] > 0
    assert out["recommended_preparation"] >= out["predicted_meals"]
    with pytest.raises(InsufficientHistoryError):
        predict_meals({"mess_id": "nowhere", "date": nxt, "meal_type": "lunch"}, history=raw, bundle=b)


def test_buffer_rounding():
    from src.predict import _apply_buffer
    assert _apply_buffer(750, 0.02) == 765 and _apply_buffer(752, 0.02) == 767
