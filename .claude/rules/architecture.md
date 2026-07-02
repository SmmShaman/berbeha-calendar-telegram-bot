# Architecture

## Monolith Structure
Everything is in two files: `server.ts` (backend) and `src/App.tsx` (frontend). No separate routes, controllers, or component files.

## Backend (server.ts ~2084 lines)

### SQLite Schema (6 tables)
- `settings` -- KV store, UPSERT via ON CONFLICT
- `members` -- 7 pre-seeded family members (id, name, role=parent|child, avatar_url, color)
- `events` -- local events (member_id FK, title, start_time/end_time ISO8601, location, gcal_event_id)
- `member_photos` -- gallery (member_id FK, photo_url as /photos/filename or external URL)
- `translations` -- Gemini translation cache (original TEXT PK, translated TEXT)
- `places` -- learned places library (short_name, full_name, address, description)
- `event_types` -- learned event types (short_name, full_name, default_location, default_duration_min)

### Event Sources (3 types, merged in frontend)
1. **Local DB events** (id >= 0) -- created via Telegram bot or web UI
2. **Google Calendar events** (id < 0, no _spond) -- proxied through server, matched to members by keyword rules then name
3. **Spond events** (id < 0, _spond=true) -- fetched from Spond API, matched via child-mapping or group-mapping

### Telegram Bot Processing Pipeline
1. Receive update via long polling (2s interval)
2. If callback_query: `processCallbackQuery()` handles inline button presses
3. If message with text/voice/video_note/audio: `processMessage()`
4. Audio transcription: Gemini 2.5 Flash (thinkingBudget=0, 30s timeout)
5. Text parsing: Gemini 2.5 Flash with system prompt containing members, existing events (+-30 days), places/event_types libraries
6. Response: JSON with `{transcription, actions[{action, memberId, title, startTime, endTime, location}]}`
7. Post-processing: expand memberId arrays, merge split actions, fix bloated titles, auto-learn places/event types
8. Unknown places trigger follow-up with inline buttons (save as-is or add details)

### Spond Multi-Account System
- `getSpondAccounts()` reads from `spond_accounts` setting (JSON array) with legacy single-account fallback
- Per-account caching: `spondTokens` (50min), `spondGroupsCaches` (10min), `spondProfileCaches` (10min)
- Child detection uses 3 strategies sequentially: guardian profileId, guardian email, family name with Cyrillic-to-Latin transliteration
- Deduplication by name key (Spond assigns different profileIds per group for same person)

### Gemini AI Usage
- Model: `gemini-2.5-flash` everywhere
- `thinkingBudget: 0` for all requests (speed over reasoning)
- `responseMimeType: 'application/json'` for structured parsing
- 3 retry attempts with 60s timeout for event parsing
- Translation: batch titles in single request, cache in SQLite

## Frontend (src/App.tsx ~2539 lines)

### Component Hierarchy
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
- localStorage used for offline fallback and session persistence
- `useApi` flag: true when server available, false = demo mode with localStorage only
- API polling intervals: events 5s, Spond 2min, Google Calendar 1min

### Calendar Grid
- 21-day rolling window (3 days before today + 18 ahead)
- "Lens" effect: today gets MAX_WEIGHT=3.5 * TODAY_BOOST=1.5, days within LENS_RADIUS=3 scaled proportionally
- Grouped by ISO weeks with merged week number column
- Member columns with photo slideshow headers and next-event countdown

### Google Integration
- Photos Picker API: creates session, opens popup, polls for mediaItemsSet, downloads selected photos to server
- Calendar API: proxied through server, events matched to members by keyword rules first, then name substring match
- OAuth2 scopes: photospicker.mediaitems.readonly + calendar.readonly
