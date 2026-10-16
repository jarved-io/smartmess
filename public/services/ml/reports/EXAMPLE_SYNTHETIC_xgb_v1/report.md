# Model report xgb_v1
Data label: **synthetic**
> **SYNTHETIC DATA - these numbers say nothing about real-world accuracy.**


## Test set (newest, never used for fitting/early stopping)
| Model                  |   MAE |   RMSE |   R2 |   MAPE % |   n |
|:-----------------------|------:|-------:|-----:|---------:|----:|
| 7-Day Average          | 24.09 |  36.95 | 0.87 |     4.59 | 330 |
| Seasonal naive (lag 7) | 19.21 |  39.82 | 0.85 |     3.51 | 330 |
| XGBoost                | 10.81 |  14.19 | 0.98 |     1.94 | 330 |

## Validation set
| Model                  |   MAE |   RMSE |   R2 |   MAPE % |   n |
|:-----------------------|------:|-------:|-----:|---------:|----:|
| 7-Day Average          | 29.11 |  43.98 | 0.83 |     5.52 | 324 |
| Seasonal naive (lag 7) | 27.73 |  58.06 | 0.7  |     5.1  | 324 |
| XGBoost                | 11.04 |  15.29 | 0.98 |     2    | 324 |

## In plain words
On the held-out test period the model is off by about 11 meals on average per meal period (about 1.8% of a typical 594-meal service). The simple 7-day average is off by 24. XGBoost reduces the average error by 55%.

## Time-series CV (expanding window)
 fold  test_from  n_test  xgb_mae  baseline_mae
    1 2025-09-15     438    10.97         25.55
    2 2025-11-27     432     9.32         22.53
    3 2026-02-07     432    10.97         26.47
    4 2026-04-20     432     9.80         29.90

## Top features (gain; influence on predictions, not causes)
roll_mean_7         329037.2
rate_est            122321.5
roll_mean_14         44060.4
same_wd_mean_4       40543.6
is_holiday           32069.0
approved_leave       28982.0
present_students     17319.3
mess_code            17282.9
lag_7                13444.9
meal_code             9487.6
