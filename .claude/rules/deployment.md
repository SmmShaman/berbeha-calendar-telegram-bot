# Deployment

## Fly.io (Primary)

**Config:** `fly.toml`
- App: `berbeha-calendar`, Region: `arn` (Stockholm)
- VM: shared CPU, 512MB RAM
- Persistent volume: `calendar_data` mounted at `/data`
- Auto-stop/start machines enabled, min 1 running
- Force HTTPS

```bash
fly deploy                        # Deploy from Dockerfile
fly logs                          # View logs
fly ssh console                   # SSH into machine
fly volumes list                  # Check persistent volumes
```

**Important:** SQLite database (`calendar.db`) and uploaded photos live on the `/data` volume. If volume is lost, all data is lost. The Dockerfile creates `/data` directory and sets `DATABASE_DIR=/data`.

## Render (Alternative)

**Config:** `render.yaml`
- Free plan, Node runtime
- Build: `npm install && npm run build`
- Start: `npm start`
- Env vars set manually in dashboard (GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, ADMIN_CHAT_IDS, APP_URL)

## Docker Build

Multi-stage Dockerfile:
1. **Builder stage:** node:20-slim + python3/make/g++ (for better-sqlite3 native compilation), `npm ci`, `npm run build`
2. **Production stage:** node:20-slim + python3/make/g++, `npm ci`, copy `dist/` from builder, copy server files

**Note:** Both stages need build tools because `better-sqlite3` compiles native bindings during `npm ci`.

## Environment Variables

Required for production:
- `GEMINI_API_KEY` -- Google AI API key for Gemini 2.5 Flash
- `TELEGRAM_BOT_TOKEN` -- Telegram Bot API token
- `ADMIN_CHAT_IDS` -- comma-separated Telegram chat IDs

Optional:
- `APP_URL` -- public URL (for reference only, not used in code)
- `VITE_GOOGLE_CLIENT_ID` -- baked into frontend build for Google Sign-In
- `DATABASE_DIR` -- SQLite location (default: `./data`)
- `PORT` -- server port (default: 3000)

## Dev vs Production

- **Dev:** `npm run dev` uses Vite middleware mode (HMR, no build step)
- **Production:** `npm run build` creates `dist/`, `npm start` serves static files via express.static with SPA fallback

## Telegram Bot

Uses **long polling** (not webhooks). On startup, calls `deleteWebhook` to ensure no conflict. Polls every 2 seconds. No external scheduler or cron needed -- the bot runs inside the same Node.js process as the web server.

## First Run

`autoSetup()` copies `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_IDS` from env vars into the SQLite `settings` table on startup, so the bot works immediately without manual configuration.
