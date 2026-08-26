# Berbeha Family Calendar — Telegram Bot

## Project Overview

Full-stack family calendar with Telegram bot + AI-powered event parsing. Monolith: `server.ts` (backend) + `src/App.tsx` (frontend).

**Production URL:** https://berbeha.vitalii.no

---

## Infrastructure

### Server: Oracle Cloud VM (Free Tier)
- **IP**: `129.151.219.55` (Reserved — permanent)
- **SSH**: `ssh -i ~/.oci/berbeha-ssh-key ubuntu@129.151.219.55`
- **Instance**: VM.Standard.E2.1.Micro (1 CPU, 1GB RAM), eu-stockholm-1
- **OS**: Ubuntu 22.04
- **Services**: `berbeha-calendar` (systemd), nginx (port 80 → 3000)
- **Fly.io**: DESTROYED — do not use

### Domain & DNS
- **Domain**: `berbeha.vitalii.no` → `129.151.219.55` (Cloudflare Proxied)
- **SSL**: Cloudflare Flexible (Cloudflare → HTTP → Nginx:80)
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
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Frontend | React 19, Vite 6, Tailwind CSS 4 |
| Backend | Express 4, better-sqlite3 |
| AI | Gemini via @google/genai (model is a SETTING) + Groq whisper-large-v3 for speech |
| Bot | Telegram Bot API (long polling) |
| Sports | Spond API (multi-account) — see **Spond auth** below |
| Calendar | Google Calendar API (read-only) |
| Photos | Google Photos Picker API |
| Language | TypeScript 5.8 |

---

## Project Structure

```
berbeha-calendar-telegram-bot/
  server.ts          # Express server + SQLite DB + Telegram bot + all API routes
  src/
    App.tsx           # Entire React frontend
    main.tsx          # React entry point
    index.css         # Tailwind import
  index.html          # SPA shell (loads Google GSI)
  vite.config.ts      # Vite + React + Tailwind, path alias @/
  tsconfig.json       # ES2022, bundler resolution
```

---

## Gemini API (Critical Rules)

- **The model is a SETTING, never a constant** — `getGeminiModel()` reads `settings.gemini_model`
  / `GEMINI_MODEL`, default `gemini-3.1-flash-lite`. Google retires a generation and the old id
  starts answering `404 "no longer available to new users"`; that plus a revoked key is what left
  the bot writing NO events from April to 26.08.2026 while looking alive. `gemini-2.5-flash` and
  `-flash-lite` are already 404 for any key on a newer project, even though `/v1beta/models` still
  lists them. Lite is the deliberate default: 500 free requests a day (full Flash gets 20) and it
  accepts `thinkingBudget: 0`, which 3.x full Flash rejects outright.
- **Free-tier ceilings, measured 2026-08-26 (not guessed):** Gemini Lite **500 requests/day**,
  Groq whisper **2000 requests / 7200 audio-seconds a day** (read off the `x-ratelimit-*`
  response headers). One bot message costs ONE Gemini call (~400 tokens) plus one Groq call
  when it is voice. `translateTitles` batches every new heading into a SINGLE call and caches
  the result in the `translations` table, so it costs ~0/day in steady state. `settings.
  llm_usage:<date>` keeps a per-day tally of both.
- **A failure must say WHY.** Until 2026-08-26 every error came back as the same «❌ Помилка
  обробки», which is precisely how a revoked API key survived from April to August unnoticed —
  the bot looked like it was having a bad day. `llmFailureReason()` separates an exhausted
  quota, a dead key and a retired model. Never collapse those back into one message.
- **Speech does NOT go to Gemini first** — `transcribeAudio()` calls Groq `whisper-large-v3` and
  falls back to Gemini. On one clip Whisper heard «Привіт, працюю зараз.» and Gemini Lite heard
  «Тревіть працюю зараз.»; a garbled transcript writes a WRONG event, which is worse than none.
- **NEVER use `responseSchema`** — causes 60s+ timeouts even with `thinkingBudget: 0`
- Use only `responseMimeType: 'application/json'` with JSON format described in text prompt
- Keep system prompts compact (no verbose examples)
- **Audio processing**: 2 steps — (1) transcribe audio, (2) parse text into JSON separately
- **Post-processing**: truncate titles > 50 chars, extract ISO timestamps from bloated fields
- Handle `memberId` as array (Gemini sometimes returns `[2, 5]` instead of separate actions)

---

## Spond auth (Critical Rules)

- The live route is **`POST /core/v1/auth2/login`** — `/core/v1/login` was retired and answers 404
  with Spond's own JSON.
- **`accessToken` in that reply is an OBJECT `{token, expiration}`, not a string.** Taking it as-is
  sent the literal header `Bearer [object Object]`; every API call then answered 401, every 401
  dropped the token, and the next poll logged in again. That storm is what got stuardbmw's profile
  locked with `401 outOfLoginAttempts` — a lock Spond holds, which no amount of retrying clears.
- Therefore **every refusal arms a cooldown**: 429 and non-JSON → 30 min, a refused password → 60
  min, and a *rejected token on an API call* → 30 min. Never add a Spond path that can retry a
  login without a brake; the kiosk polls the calendar every 10 minutes.
- Tokens are persisted in `settings.spond_token:<email>` so a restart does not re-log-in, and the
  expiry comes from the server's own `expiration`, refreshed a minute early.

---

## Telegram Bot

Long polling (2s interval), `deleteWebhook` on startup.

**Commands:** /start, /help, /events, /next, /prev, /today, /places

**Processing pipeline:**
1. Audio → `transcribeAudio()`: Groq whisper-large-v3, Gemini fallback (30s timeout each)
2. Text → Gemini parsing with system prompt (60s timeout, 3 retries)
3. Post-process: expand memberId arrays, merge split actions, fix bloated titles
4. Unknown places → inline buttons (save as-is or add details)

---

## Environment Variables

```env
GEMINI_API_KEY="..."              # Google AI Studio key (free tier is enough)
GEMINI_MODEL="gemini-3.1-flash-lite"  # optional override; also settings.gemini_model
GROQ_API_KEY="gsk_..."            # speech-to-text (whisper-large-v3)
TELEGRAM_BOT_TOKEN="..."          # Telegram Bot API token
APP_URL="https://..."             # Public app URL
VITE_GOOGLE_CLIENT_ID="..."      # Google OAuth Client ID
DATABASE_DIR="/data"              # SQLite DB location (default: ./data)
PORT=3000                         # Server port
NODE_ENV=production               # Enables static file serving
ADMIN_CHAT_IDS="123,456"         # Telegram chat IDs for admin access
```

---

## Common Tasks

### Change Telegram bot behavior
All bot logic is in `server.ts`: `processMessage()` for text/voice, `processCallbackQuery()` for inline buttons.

### Modify AI parsing
Edit the `systemPrompt` string in `processMessage()`. The prompt defines member list, action schema, and timezone.

### Check bot on server
```bash
ssh -i ~/.oci/berbeha-ssh-key ubuntu@129.151.219.55
sudo journalctl -u berbeha-calendar --since "5 min ago"
```
