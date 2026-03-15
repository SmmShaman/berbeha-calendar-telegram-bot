# CLAUDE.md - Berbeha Calendar Telegram Bot

## Project Overview

**Berbeha Family Calendar** -- a full-stack family calendar app with Telegram bot integration and AI-powered event parsing. Built as a single-page React app with an Express/SQLite backend. Users manage family schedules via a web calendar or by sending text/voice messages to a Telegram bot, which uses Gemini AI to parse natural language into calendar events.

**Production URL:** https://berbeha-calendar.netlify.app
**AI Studio App:** https://ai.studio/apps/9d2405c3-907a-48a6-b8df-2309d9ffa408

---

## Quick Start

```bash
npm install
npm run dev              # http://localhost:3000

# Production
npm run build
npm start

# Quality checks
npx tsc --noEmit        # TypeScript validation
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, Vite 6, Tailwind CSS 4 |
| Backend | Express 4, better-sqlite3, tsx |
| AI | Google Gemini 2.5 Flash (@google/genai) |
| Bot | Telegram Bot API (long polling) |
| Sports | Spond API (multi-account) |
| Calendar | Google Calendar API (read-only) |
| Photos | Google Photos Picker API |
| Language | TypeScript 5.8 |
| Deployment | Fly.io (primary), Render (alt) |

---

## Project Structure

```
berbeha-calendar-telegram-bot/
  server.ts          # Express server + SQLite DB + Telegram bot + all API routes (~2084 lines)
  src/
    App.tsx           # Entire React frontend (~2539 lines)
    main.tsx          # React entry point
    index.css         # Tailwind import
  index.html          # SPA shell (loads Google GSI)
  fly.toml            # Fly.io config (arn region, /data volume)
  render.yaml         # Render.com config (alternative)
  Dockerfile          # Multi-stage: node:20-slim, /data persistent volume
  vite.config.ts      # Vite + React + Tailwind, path alias @/
  tsconfig.json       # ES2022, bundler resolution
```

This is a monolith: one server.ts file contains all backend logic, one App.tsx contains all frontend components.

---

## Architecture

### Backend (server.ts)

**SQLite Database** (calendar.db in DATABASE_DIR or ./data/):
- `settings` -- key-value config (telegram_token, admin_chat_ids, spond accounts, etc.)
- `members` -- family members (name, role, avatar_url, color). Pre-seeded with 7 members.
- `events` -- calendar events (member_id, title, start_time, end_time, location, gcal_event_id)
- `member_photos` -- member photo gallery (member_id, photo_url)
- `translations` -- cached Norwegian-to-Ukrainian translations (original -> translated)
- `places` -- known places library (short_name, full_name, address, description)
- `event_types` -- known event types (short_name, full_name, default_location, default_duration_min)

**API Routes:**
- `GET/POST /api/settings` -- app configuration
- `GET/PUT /api/members/:id` -- family members CRUD
- `GET/POST/DELETE /api/events` -- calendar events
- `GET/POST/DELETE /api/members/:id/photos` -- member photo management
- `POST /api/members/:id/photos/from-url` -- download and save photos from URL
- `POST /api/members/:id/photos/upload` -- file upload (multer, 10MB limit)
- `POST/GET/DELETE /api/google-photos/session` -- Google Photos Picker API proxy
- `GET /api/google-calendar/events` -- Google Calendar proxy
- `GET /api/google-calendar/list` -- list all Google calendars
- `GET /api/google-calendar/events/:calendarId` -- specific calendar events
- `POST /api/spond/test` -- test Spond credentials
- `GET /api/spond/children` -- auto-detect children via guardian matching
- `GET /api/spond/groups` -- list Spond groups
- `GET /api/spond/events` -- fetch and translate Spond events (multi-account merge)
- `POST /api/spond/accounts/add|remove` -- manage multiple Spond accounts
- `GET/POST/DELETE /api/library/places` -- places library
- `GET/POST/DELETE /api/library/event-types` -- event types library

**Telegram Bot** (long polling, 2s interval):
- Parses text, voice, and video note messages via Gemini AI
- AI actions: add, delete, reschedule, query (schedule lookup)
- Commands: /start, /help, /events, /next, /prev, /today, /places
- Inline button callbacks for event management (delete, reschedule, place learning)
- Admin-only access controlled by `admin_chat_ids` setting
- Auto-learns new places and event types from user input

**Spond Integration** (multi-account):
- Per-account token caching (50-min TTL)
- Groups and profiles cached (10-min TTL)
- Child detection: 3 strategies (guardian profileId, email match, family name match with Cyrillic transliteration)
- Events merged and deduplicated across all accounts
- Titles translated Norwegian->Ukrainian via Gemini (cached in `translations` table)

### Frontend (src/App.tsx)

**Tabs:**
- Calendar -- 21-day rolling window with "lens" effect (today enlarged)
- Members -- member profiles, photo gallery with slideshow, Google Photos import
- Events -- Spond child/group mapping, Google Calendar keyword rules
- Settings -- Telegram token, admin IDs, Spond accounts

**Key Features:**
- Google Sign-In (GSI) with OAuth2 for Photos + Calendar scopes
- PIN protection (hardcoded '1234') for admin tabs (30-min session)
- Works without Google login (guest mode with default "Berbeha" user)
- Member photo slideshow with crossfade (unique per-member intervals)
- Next event countdown overlay (urgent mode at <15min with red pulsing)
- Holiday display (Norway + Ukraine via date.nager.at API)
- Events auto-refresh every 5s (local), 2min (Spond), 1min (Google Calendar)
- Event sources color-coded: red (Telegram bot), green (Google Calendar), teal (Spond)
- Week number column (ISO weeks)
- localStorage fallback when API unavailable (demo mode)

---

## Environment Variables

```env
GEMINI_API_KEY="..."              # Google AI (Gemini 2.5 Flash)
TELEGRAM_BOT_TOKEN="..."          # Telegram Bot API token
APP_URL="https://..."             # Public app URL
VITE_GOOGLE_CLIENT_ID="..."       # Google OAuth Client ID
DATABASE_DIR="/data"              # SQLite DB location (default: ./data)
PORT=3000                         # Server port
NODE_ENV=production               # Enables static file serving
ADMIN_CHAT_IDS="123,456"          # Telegram chat IDs for admin access
```

---

## Development

- Dev server uses Vite middleware mode (HMR enabled)
- Production builds static frontend to `dist/`, serves via express.static
- SQLite DB persists to `DATABASE_DIR` (Fly.io mounts volume at `/data`)
- Telegram bot uses long polling (not webhooks) -- deletes webhook on startup
- `autoSetup()` copies env vars (TELEGRAM_BOT_TOKEN, ADMIN_CHAT_IDS) to DB on first run

---

## Deployment

**Fly.io (primary):**
- App: `berbeha-calendar`, region: `arn` (Stockholm)
- Persistent volume: `calendar_data` at `/data`
- VM: 512MB shared CPU

**Render (alternative):**
- Free plan, env vars via dashboard

**Docker:**
- Multi-stage build, node:20-slim
- Requires python3/make/g++ for better-sqlite3 native compilation

---

## Common Tasks

### Add a family member
1. Insert into `members` table (server auto-seeds 7 on first run)
2. Update `DEFAULT_MEMBERS` array in App.tsx for offline fallback

### Change Telegram bot behavior
All bot logic is in `server.ts`: `processMessage()` for text/voice, `processCallbackQuery()` for inline buttons.

### Modify AI parsing
Edit the `systemPrompt` string in `processMessage()` (~line 1496). The prompt defines member list, action schema, and timezone.

### Add new Spond account
POST `/api/spond/accounts/add` with `{ email, password, label }`. Tests login before saving.

### Translations cache
Norwegian Spond event titles are auto-translated via Gemini and cached in the `translations` table. Delete rows to force re-translation.
