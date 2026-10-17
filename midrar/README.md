# مدرار · Midrar

Food-waste tracking and recommendations for restaurants, schools, universities and hospitals.
Arabic (RTL) and English. No dependencies to install: only Node.js 22.13+.

## Run (Windows / Mac / Linux)

```
node server.js
```

Open http://localhost:3000. On first run you create the organisation and the admin account.
Data is stored in `data/midrar.db` (SQLite). Back it up by copying that file while the server is stopped.

Tests: `npm test`

## Adding your AI model (Teachable Machine)

1. Train a **Standard image model**, one class per food item, plus an "Empty / other" class.
2. Export > **Tensorflow.js** > Download.
3. Copy `model.json`, `metadata.json` and `weights.bin` into `public/model/`.
4. Refresh the page. In **Settings > AI model** the status becomes "added".
5. In **Settings > Items**, set "Model class" for each item to the exact class name (or name the class like the item's English or Arabic name and it will match automatically).

Photos are analysed in the browser and never uploaded. Only the chosen item and weight are saved.
The best guess (>= 50%) is pre-selected; the user can correct it, and corrections are stored.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| PORT | 3000 | Port |
| HOST | 127.0.0.1 | Use `0.0.0.0` to share on your network |
| DATA_DIR | ./data | Where the database lives |
| SECURE_COOKIES | off | Set to `1` behind HTTPS |
| CSP_UNSAFE_EVAL | off | Set to `1` only if TensorFlow.js is blocked by the security policy |
| TZ_OFFSET_HOURS | 3 | Riyadh time |

## Going public
Put it behind HTTPS (e.g. a reverse proxy), set `SECURE_COOKIES=1`, and use strong admin passwords.

## What it does and does not do (v1)
- Forecast: weekday averages, needs >= 10 logged days in the last 28. No weather/holiday inputs yet.
- Recommendations: rule-based from your own logs (needs >= 5 days).
- Redistribution: records the request; contacting the charity is manual. No email/SMS.
- Demo data can be loaded only on an empty account and removed in one click.
