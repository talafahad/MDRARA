# مدرار · Midrar

Food-waste tracking and recommendations for restaurants, schools, universities and hospitals.
Arabic (RTL) and English. Only Node.js 22.13+ is needed (nothing to install) unless you use SQL Server.

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

## Microsoft SQL Server (and SSMS)

Midrar can keep its data in SQL Server instead of the SQLite file, so you can open the tables in SQL Server Management Studio.

1. Create an empty database in SSMS (right-click Databases > New Database > name it `midrar`).
2. Make sure SQL Server accepts TCP/IP connections and has a SQL login (user + password) with rights on that database.
   For SQL Express: SQL Server Configuration Manager > Network Configuration > TCP/IP = Enabled, then restart the service.
   Windows login is not supported by this connector: use a SQL login.
3. In the project folder run once: `npm install` (installs the `mssql` package).
4. Set the variables and start (PowerShell):
```
$env:DB_TYPE="mssql"
$env:MSSQL_SERVER="localhost"          # or PC-NAME\SQLEXPRESS for a named instance
$env:MSSQL_DATABASE="midrar"
$env:MSSQL_USER="midrar_user"
$env:MSSQL_PASSWORD="your password"
$env:MSSQL_TRUST_CERT="1"              # needed for a local server with a self-signed certificate
node server.js
```
   The tables are created automatically on first start. Optional: `MSSQL_PORT`, `MSSQL_INSTANCE`, `MSSQL_ENCRYPT=1`,
   or one `MSSQL_CONNECTION` string instead of the separate variables.
5. To move data you already entered in SQLite: with the same variables set, run
   `node scripts/migrate-sqlite-to-mssql.js --dry-run` (counts rows) and then `node scripts/migrate-sqlite-to-mssql.js`.
   It needs an empty SQL Server database and checks that the row counts match.

Not set `DB_TYPE`? Midrar keeps using `data/midrar.db` exactly as before.

Status: the SQL Server path was checked with a stand-in driver and a T-SQL syntax check, but not yet against a live SQL Server.
If something fails on first start, send the error text.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| PORT | 3000 | Port |
| HOST | 127.0.0.1 | Use `0.0.0.0` to share on your network |
| DATA_DIR | ./data | Where the database lives |
| SECURE_COOKIES | off | Set to `1` behind HTTPS |
| CSP_UNSAFE_EVAL | off | Set to `1` only if TensorFlow.js is blocked by the security policy |
| TZ_OFFSET_HOURS | 3 | Riyadh time |
| DB_TYPE | sqlite | `mssql` to use SQL Server (see above) |

## Going public
Put it behind HTTPS (e.g. a reverse proxy), set `SECURE_COOKIES=1`, and use strong admin passwords.

## What it does and does not do (v1)
- Forecast: weekday averages, needs >= 10 logged days in the last 28. No weather/holiday inputs yet.
- Recommendations: rule-based from your own logs (needs >= 5 days).
- Redistribution: records the request; contacting the charity is manual. No email/SMS.
- Demo data can be loaded only on an empty account and removed in one click.
