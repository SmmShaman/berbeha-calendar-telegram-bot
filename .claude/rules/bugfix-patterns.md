# Bug Patterns & Solutions

## Gemini AI Response Issues

### Truncated/Invalid JSON from Gemini
**Symptom:** JSON parse fails on Gemini response
**Pattern:** Response text is cut off or contains non-JSON content
**Fix (server.ts ~1564-1577):** Salvage transcription via regex `/"transcription"\s*:\s*"([^"]*?)"/ ` and show partial result to user. Always wrap `JSON.parse()` in try/catch.

### Gemini Thinking Leak into Title
**Symptom:** Event title contains 80+ chars of reasoning text, ISO timestamps, locations
**Fix (server.ts ~1642-1663):** Post-process actions: extract startTime/endTime/location from bloated title via regex, then truncate to 50 chars using first sentence fragment.

### Gemini Splits Actions Incorrectly
**Symptom:** "Мирон і Тимур плавання" produces one action with memberId but no startTime, another with startTime but no memberId
**Fix (server.ts ~1598-1638):** Detect split pattern (withMemberNoTime + withTimeNoMember), merge into complete actions. Also fill missing fields from "best" (most complete) action.

### Gemini Returns memberId as Array
**Symptom:** `memberId: [3, 4]` instead of separate actions per member
**Fix (server.ts ~1584-1596):** Pre-process step expands array memberId into individual actions.

### Gemini Timeout
**Symptom:** Request hangs, no response
**Fix:** 60s timeout via `Promise.race`, 3 retry attempts. Transcription step has separate 30s timeout.

## Spond Integration

### Child Detection Fails (Guardian Match)
**Symptom:** `findMyChildren()` returns empty despite children existing
**Root cause:** Spond assigns different profileIds per group for the same child, or names are in different scripts (Cyrillic vs Latin)
**Fix:** 3 detection strategies: (1) guardian profileId match, (2) guardian email match, (3) family name match with Cyrillic-to-Latin transliteration. Plus name-based deduplication at the end.

### Spond Token Expiry
**Symptom:** API returns 401
**Fix:** Token cached for 50 minutes (Spond tokens last ~60min). On auth failure, cache is invalidated and re-login happens automatically.

### Spond Events Not Matched to Members
**Symptom:** Events appear in calendar with no member (member_id=0)
**Fix:** Two mapping levels: (1) child-based mapping (Spond child profileId -> member_id), (2) group-based mapping fallback (groupId -> member_id). Both configured via Settings > Events tab.

## Telegram Bot

### /places Used Wrong Table Name
**Commit:** 5adfadb
**Fix:** Changed `places_library` to `places` in DELETE query.

### Follow-up Answer Not Processed
**Symptom:** User describes a place but bot ignores it
**Pattern:** `pendingFollowUp` Map stores pending questions per chatId. Voice/audio follow-ups need transcription before processing.
**Fix:** Check for voice/video_note/audio in follow-up handler, transcribe first.

### Bot Not Responding After Deploy
**Symptom:** Bot ignores all messages
**Checklist:**
1. Is `TELEGRAM_BOT_TOKEN` set? (check `settings` table or env var)
2. Is `admin_chat_ids` configured? (non-admin users get "no access" reply)
3. Was a webhook previously set? (`deleteWebhook` runs on startup but check manually)
4. Is another instance polling? (only one poller can run per bot token)

## Frontend

### Google Token Expired
**Symptom:** Google Calendar/Photos stop working silently
**Fix (App.tsx ~948):** Check for 401 error code, clear token from state and localStorage, user must reconnect.

### Admin PIN Session Expired
**Symptom:** Settings/Members tabs require PIN again
**Pattern:** 30-minute session stored in localStorage as `calendar_admin_until` timestamp.

### Calendar Events Not Updating
**Symptom:** New events from Telegram bot don't appear
**Fix:** Events poll every 5 seconds (`setInterval` in CalendarApp). If API unavailable, falls back to localStorage (won't reflect server changes). Check `useApi` flag.

### Photo Slideshow Memory
**Symptom:** Photos don't cycle or all cycle at same time
**Pattern:** Each member gets unique interval (4-10s) and initial delay (0/1.5/3s) based on hash of member name. Only simple crossfade transition to prevent overlapping artifacts.

## General

### better-sqlite3 Build Fails
**Symptom:** `npm ci` fails with native compilation error
**Fix:** Ensure python3, make, g++ are installed. Both Docker stages need build tools.

### Database Location Wrong
**Symptom:** Data disappears after restart
**Fix:** Check `DATABASE_DIR` env var. On Fly.io it must be `/data` (persistent volume). Default `./data` is ephemeral in containers.

### Event Time Zone
All times use `+01:00` (Europe/Oslo, CET). The Gemini system prompt explicitly sets this. Display uses `toLocaleString('uk-UA', { timeZone: 'Europe/Oslo' })`.
