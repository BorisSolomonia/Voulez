# Wolt Sync System

End-to-end service that pulls inventory from Fina and pushes availability + stock updates to Wolt while honoring rate limits and persisting state so only deltas are sent after the first sync.

## How the Sync Works
1. Scheduler (every 15 minutes by default) loads inventory + product details from Fina for each enabled store.
2. State files (`state/.state-store-<FINA_STORE_ID>.json`) store the last-known quantity/availability/price per Wolt SKU.
3. If no state exists yet, the engine forces a **full sync** with slow pacing (default: batch of 1 item, 10 s delay) to protect Wolt from bursts. Once state exists, only changed or missing SKUs are sent using the faster batch config.
4. Updates run in two phases: `PATCH /items` (availability/price) followed by `PATCH /items/inventory` (stock counts), with retries and automatic `Retry-After` handling.
5. After a successful sync, the new state replaces the old one and future runs operate delta-only.
6. Health endpoints (`/health`, `/metrics`, `/metrics/store/<id>`) and PM2 logs provide realtime visibility.

## Features
- **Modular Architecture** with separate adapters for Fina/Wolt and a reusable sync engine.
- **Stateful Delta Logic** so Wolt only receives meaningful changes after the initial full push.
- **Rate-Limit Controls** via env-configurable batch size/delay for both first sync and steady-state runs.
- **CLI & Scheduler**: Manual commands for bootstrap/testing; PM2-managed background service.
- **Observability**: Health endpoints, metrics history, and structured logs suitable for centralized monitoring.

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configuration**
   Copy `.env.example` to `.env` and define which stores you want to run:
   - Set `WOLT_STORES` to a comma-separated list of Fina store IDs (e.g. `WOLT_STORES=4` to run only one store). This ID is the one used by Fina endpoints like `GET /operation/getProductsRestByStore/<ID>`.
   - For each store ID listed, provide `STORE_<ID>_NAME`, `STORE_<ID>_ENABLED`, and the matching `WOLT_VENUE_ID_<ID>`, `WOLT_USER_<ID>`, `WOLT_PASS_<ID>`.
     - Note: the `<ID>` suffix is the Fina store ID; it is not a Wolt venue ID. Wolt venue IDs are the long hex strings you put into `WOLT_VENUE_ID_<ID>`.
   - Optional pacing knobs:
     - Global defaults: `WOLT_BATCH_SIZE`/`WOLT_BATCH_DELAY_MS` (steady state) and `WOLT_FIRST_SYNC_BATCH_SIZE`/`WOLT_FIRST_SYNC_BATCH_DELAY_MS` (first sync).
     - Per-store overrides: `STORE_<ID>_WOLT_BATCH_SIZE`/`STORE_<ID>_WOLT_BATCH_DELAY_MS` and `STORE_<ID>_WOLT_FIRST_SYNC_BATCH_SIZE`/`STORE_<ID>_WOLT_FIRST_SYNC_BATCH_DELAY_MS`.
   - Optional adaptive rate-limit guardrails (recommended for staging): `WOLT_RATE_LIMIT_MIN_INTERVAL_MS`, `WOLT_LEARN_MIN_INTERVAL_FROM_RETRY_AFTER`, `WOLT_ENFORCE_LEARNED_MIN_INTERVAL_AFTER_SUCCESS`.
   - Optional: `STORE_ID=<ID>` runs only that single store (PM2 per-store mode). The `<ID>` must still be included in `WOLT_STORES` so configuration can be resolved.
   ```bash
   cp .env.example .env
   ```

3. **Build**
   ```bash
   npm run build
   ```

## Usage

### Development Mode
```bash
npm run dev
```

### Production Mode
```bash
npm start
```
- First sync automatically sends the entire catalog with throttled batches (default 1 item every 10 s). Expect multi-hour runtime and respect any `Retry-After` headers from Wolt. Subsequent syncs run delta-only using the faster batch settings.

### Monitoring & Verification
- Check process health: `curl http://localhost:3000/health`
- Inspect per-store metrics/history: `curl http://localhost:3000/metrics` and `curl http://localhost:3000/metrics/store/<id>`
- Tail logs locally/over SSH: `pm2 logs --lines 200` or `tail -f logs/all-stores-out.log`
- Manual on-demand sync: `node dist/cli/index.js sync -s <id> [--dry-run|--force-full|--limit <n>]`

### State & First Sync Behavior
- State files live under `state/.state-store-<FINA_STORE_ID>.json` and are automatically created/updated after each successful sync.
- If the state file is missing or empty, the engine forces `forceFullSync` and uses `WOLT_FIRST_SYNC_BATCH_SIZE` / `WOLT_FIRST_SYNC_BATCH_DELAY_MS` (defaults: `1` / `10000`) until all SKUs are acknowledged by Wolt. Leave the process running—multi-hour runtimes with repeated `Retry-After` sleeps are expected.
- After the first sync saves state, regular runs switch to the faster `WOLT_BATCH_SIZE` / `WOLT_BATCH_DELAY_MS` settings (defaults: `50` / `2000`) and only send deltas, keeping sync cycles short.
- For a one-shot initial push with fewer API calls, set a large first-sync batch size per store (example for Store 4): `STORE_4_WOLT_FIRST_SYNC_BATCH_SIZE=10000`.

### CLI Manual Sync
To run a manual sync for Store 10:
```bash
npm run cli -- sync -s 10
```
Options:
- `--dry-run` to avoid sending to Wolt.
- `--limit <n>` to cap availability/inventory updates (useful for staging/tests).
- `WOLT_BATCH_SIZE` and `WOLT_BATCH_DELAY_MS` env vars control batch size and per-batch delay (defaults: 50 items, 2000ms). Example:
  ```bash
  WOLT_BATCH_SIZE=2 WOLT_BATCH_DELAY_MS=8000 npm run cli -- sync -s 10 --limit 5
  ```
To run a "Dry Run" (see what would happen without sending):
```bash
npm run cli -- sync -s 10 --dry-run
```

## Deployment

1. Build the project: `npm run build`
2. Configure PM2:
   ```javascript
   module.exports = {
     apps: [{
       name: "wolt-sync",
       script: "./dist/index.js",
       env: {
         NODE_ENV: "production"
       }
     }]
   }
   ```
3. Start with PM2: `pm2 start ecosystem.config.js`

## Staging Test Observations (Wolt Dev)

- Wolt staging enforces aggressive rate limits. Expect `429 Too many requests` with `Retry-After` up to ~900s.
- Use the `--limit` flag plus small batches and long delays to validate without overwhelming staging. Example that succeeded partially before waiting on `Retry-After`:  
  `WOLT_BATCH_SIZE=2 WOLT_BATCH_DELAY_MS=8000 npm run cli -- sync -s 10 --limit 5`
- Allow long runtimes (15–20 minutes or more) so the built-in retry can honor `Retry-After` and finish.
- Fina staging auth works with the provided env vars; inventory load of ~73k products and ~25k candidate updates is normal for Store 10. Use limits to keep staging runs small.
