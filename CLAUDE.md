# Berbeha Family Calendar — Telegram Bot

## Project Overview

Full-stack family calendar with Telegram bot + AI-powered event parsing. Monolith architecture: `server.ts` (backend, ~2126 lines) + `src/App.tsx` (frontend, ~2605 lines).

**Production URL:** https://berbeha.vitalii.no

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js via tsx |
| Frontend | React 19, Vite 6, Tailwind CSS 4 |
| Backend | Express 4, better-sqlite3 |
| AI | Google Gemini 2.5 Flash (@google/genai) |
| Bot | Telegram Bot API (long polling) |
| Sports | Spond API (multi-account) |
| Calendar | Google Calendar API (read-only) |
| Photos | Google Photos Picker API |
| Language | TypeScript 5.8 |

---

## Project Structure

```
berbeha-calendar-telegram-bot/
  server.ts            # Express server + SQLite DB + Telegram bot + all API routes
  src/
    App.tsx            # Entire React frontend (single file)
    main.tsx           # React entry point
    index.css          # Tailwind import
  index.html           # SPA shell (loads Google GSI)
  vite.config.ts       # Vite + React + Tailwind, path alias @/
  tsconfig.json        # ES2022, bundler resolution
  Dockerfile           # Multi-stage build for containerized deploy
  fly.toml             # Fly.io config (DEPRECATED — see Infrastructure)
  render.yaml          # Render config (alternative deploy)
```

---

## Infrastructure

### Server: Oracle Cloud VM (Free Tier) — PRIMARY
- **IP**: `129.151.219.55` (Reserved — permanent)
- **SSH**: `ssh -i ~/.oci/berbeha-ssh-key ubuntu@129.151.219.55`
- **Instance**: VM.Standard.E2.1.Micro (1 CPU, 1GB RAM), eu-stockholm-1
- **OS**: Ubuntu 22.04
- **Services**: `berbeha-calendar` (systemd), nginx (port 80 -> 3000)
- **Fly.io**: DESTROYED — do not use

### Domain & DNS
- **Domain**: `berbeha.vitalii.no` -> `129.151.219.55` (Cloudflare Proxied)
- **SSL**: Cloudflare Flexible (Cloudflare -> HTTP -> Nginx:80)
- **Bot Fight Mode**: disabled

### Deploy Flow
```bash
# 1. Local: commit and push
git add -A && git commit -m "..." && git push

# 2. Server: pull and restart
ssh -i ~/.oci/berbeha-ssh-key ubuntu@129.151.219.55
cd berbeha-calendar-telegram-bot
git pull
sudo systemctl restart berbeha-calendar

# 3. If frontend (App.tsx) changed — build first:
npx vite build
sudo systemctl restart berbeha-calendar
```

### Logs
```bash
sudo journalctl -u berbeha-calendar -f
sudo journalctl -u berbeha-calendar --since "5 min ago"
```

### Dev vs Production
- **Dev:** `npm run dev` — Vite middleware mode (HMR, no build step)
- **Production:** `npm run build` creates `dist/`, `npm start` serves static files via express.static with SPA fallback

---

## Architecture

### SQLite Schema (7 tables)
- `settings` — KV store, UPSERT via ON CONFLICT
- `members` — 7 pre-seeded family members (id, name, role=parent|child, avatar_url, color)
- `events` — local events (member_id FK, title, start_time/end_time ISO8601, location, gcal_event_id)
- `member_photos` — gallery (member_id FK, photo_url as /photos/filename or external URL)
- `translations` — Gemini translation cache (original TEXT PK, translated TEXT)
- `places` — learned places library (short_name, full_name, address, description)
- `event_types` — learned event types (short_name, full_name, default_location, default_duration_min)

### Event Sources (3 types, merged in frontend)
1. **Local DB events** (id >= 0) — created via Telegram bot or web UI
2. **Google Calendar events** (id < 0, no _spond) — proxied through server, matched to members by keyword rules then name
3. **Spond events** (id < 0, _spond=true) — fetched from Spond API, matched via child-mapping or group-mapping

### Frontend Component Hierarchy
```
App (auth state, PIN modal)
  LoginPage (Google GSI button, client ID setup)
  CalendarApp (main app after auth)
    Header (nav tabs, Google connect, user menu)
    Calendar tab (21-day rolling grid with lens effect)
    Members tab (MembersTab: profiles, photo upload/import)
    Events tab (EventMappingTab: Spond mapping, keyword rules)
    Settings tab (SettingsTab: bot config, Spond accounts)
    EventModal (add event form)
    Event Detail Modal (view/delete event)
```

### State Management
- All state via React useState/useEffect at CalendarApp level
- localStorage for offline fallback and session persistence
- `useApi` flag: true when server available, false = demo mode with localStorage only
- API polling intervals: events 5s, Spond 2min, Google Calendar 1min

### Calendar Grid
- 21-day rolling window (3 days before today + 18 ahead)
- "Lens" effect: today gets MAX_WEIGHT=3.5 * TODAY_BOOST=1.5, days within LENS_RADIUS=3 scaled proportionally
- Grouped by ISO weeks with merged week number column

---

## Gemini API (Critical Rules)

- **Model**: `gemini-2.5-flash` (only one available; `gemini-2.0-flash` is deprecated/404)
- **NEVER use `responseSchema`** — causes 60s+ timeouts even with `thinkingBudget: 0`
- Use only `responseMimeType: 'application/json'` with JSON format described in text prompt
- `thinkingBudget: 0` for all requests (speed over reasoning)
- Keep system prompts compact (no verbose examples)
- **Audio processing**: 2 steps — (1) transcribe audio, (2) parse text into JSON separately
- **Post-processing**: truncate titles > 50 chars, extract ISO timestamps from bloated fields
- Handle `memberId` as array (Gemini sometimes returns `[2, 5]` instead of separate actions)
- Translation: batch titles in single request, cache in SQLite

---

## Telegram Bot

Long polling (2s interval), `deleteWebhook` on startup. Runs in the same Node.js process as the web server.

**Commands:** /start, /help, /events, /next, /prev, /today, /places

**Processing pipeline:**
1. Audio -> Gemini transcription (30s timeout)
2. Text -> Gemini parsing with system prompt (60s timeout, 3 retries)
3. Post-process: expand memberId arrays, merge split actions, fix bloated titles
4. Auto-learn places/event types from new events
5. Unknown places -> inline buttons (save as-is or add details)

**Key functions in server.ts:**
- `processMessage()` — text/voice processing
- `processCallbackQuery()` — inline button handling
- `systemPrompt` in `processMessage()` — AI parsing prompt (member list, action schema, timezone)

---

## Spond Multi-Account System

- `getSpondAccounts()` reads from `spond_accounts` setting (JSON array) with legacy single-account fallback
- Per-account caching: `spondTokens` (50min), `spondGroupsCaches` (10min), `spondProfileCaches` (10min)
- Child detection: 3 strategies sequentially — (1) guardian profileId match, (2) guardian email match, (3) family name match with Cyrillic-to-Latin transliteration
- Name-based deduplication (Spond assigns different profileIds per group for same person)

---

## Google Integration

- **Photos Picker API**: creates session, opens popup, polls for mediaItemsSet, downloads selected photos to server
- **Calendar API**: proxied through server, events matched to members by keyword rules first, then name substring match
- **OAuth2 scopes**: photospicker.mediaitems.readonly + calendar.readonly

---

## Environment Variables

```env
GEMINI_API_KEY="..."              # Google AI (Gemini 2.5 Flash) — REQUIRED
TELEGRAM_BOT_TOKEN="..."          # Telegram Bot API token — REQUIRED
ADMIN_CHAT_IDS="123,456"         # Telegram chat IDs for admin access — REQUIRED
APP_URL="https://..."             # Public app URL (reference only)
VITE_GOOGLE_CLIENT_ID="..."      # Google OAuth Client ID (baked into frontend build)
DATABASE_DIR="/data"              # SQLite DB location (default: ./data)
PORT=3000                         # Server port
NODE_ENV=production               # Enables static file serving
```

`autoSetup()` copies `TELEGRAM_BOT_TOKEN` and `ADMIN_CHAT_IDS` from env vars into the SQLite `settings` table on startup.

---

## Known Bug Patterns

### Gemini AI
- **Truncated JSON**: Salvage transcription via regex `/"transcription"\s*:\s*"([^"]*?)"/`, always wrap `JSON.parse()` in try/catch
- **Thinking leak into title**: Post-process — extract startTime/endTime/location from bloated title via regex, truncate to 50 chars
- **Split actions**: Detect pattern (withMemberNoTime + withTimeNoMember), merge into complete actions
- **memberId as array**: Pre-process expands `[3, 4]` into individual actions
- **Timeout**: 60s timeout via `Promise.race`, 3 retries. Transcription: 30s timeout

### Spond
- **Child detection fails**: Check all 3 strategies (guardian profileId, email, family name with transliteration)
- **Token expiry**: Cached 50min, auto-invalidates on 401
- **Events not matched**: Two mapping levels — child-based, then group-based fallback

### Frontend
- **Google token expired**: Check for 401, clear token, user reconnects
- **Admin PIN session**: 30-minute session in localStorage as `calendar_admin_until`
- **Calendar not updating**: Events poll every 5s; check `useApi` flag
- **Photo slideshow**: Unique interval (4-10s) and delay per member based on name hash

### General
- **better-sqlite3 build fails**: Needs python3, make, g++ (both Docker stages)
- **Database disappears**: Check `DATABASE_DIR` env var
- **Time zone**: All times use `+01:00` (Europe/Oslo). Display: `toLocaleString('uk-UA', { timeZone: 'Europe/Oslo' })`
- **Bot not responding**: Check TELEGRAM_BOT_TOKEN, admin_chat_ids, deleteWebhook, no duplicate pollers
