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

- **Model**: `gemini-2.5-flash` (only one available; `gemini-2.0-flash` is deprecated/404)
- **NEVER use `responseSchema`** — causes 60s+ timeouts even with `thinkingBudget: 0`
- Use only `responseMimeType: 'application/json'` with JSON format described in text prompt
- Keep system prompts compact (no verbose examples)
- **Audio processing**: 2 steps — (1) transcribe audio, (2) parse text into JSON separately
- **Post-processing**: truncate titles > 50 chars, extract ISO timestamps from bloated fields
- Handle `memberId` as array (Gemini sometimes returns `[2, 5]` instead of separate actions)

---

## Telegram Bot

Long polling (2s interval), `deleteWebhook` on startup.

**Commands:** /start, /help, /events, /next, /prev, /today, /places

**Processing pipeline:**
1. Audio → Gemini transcription (30s timeout)
2. Text → Gemini parsing with system prompt (60s timeout, 3 retries)
3. Post-process: expand memberId arrays, merge split actions, fix bloated titles
4. Unknown places → inline buttons (save as-is or add details)

---

## Environment Variables

```env
GEMINI_API_KEY="..."              # Google AI (Gemini 2.5 Flash)
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
