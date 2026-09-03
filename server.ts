import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Photo uploads
const photosDir = path.join(process.env.DATABASE_DIR || path.join(process.cwd(), 'data'), 'photos');
if (!fs.existsSync(photosDir)) fs.mkdirSync(photosDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, photosDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images allowed'));
  },
});

// Serve uploaded photos
app.use('/photos', express.static(photosDir));

// Initialize SQLite Database
const dbDir = process.env.DATABASE_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new Database(path.join(dbDir, 'calendar.db'));

// Setup tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    avatar_url TEXT,
    color TEXT
  );

  CREATE TABLE IF NOT EXISTS member_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    photo_url TEXT NOT NULL,
    FOREIGN KEY(member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS translations (
    original TEXT PRIMARY KEY,
    translated TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    gcal_event_id TEXT,
    FOREIGN KEY(member_id) REFERENCES members(id)
  );

  CREATE TABLE IF NOT EXISTS places (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_name TEXT NOT NULL,
    full_name TEXT,
    address TEXT,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS event_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_name TEXT NOT NULL,
    full_name TEXT,
    default_location TEXT,
    default_duration_min INTEGER DEFAULT 60
  );

  CREATE TABLE IF NOT EXISTS restrictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    FOREIGN KEY(member_id) REFERENCES members(id)
  );

  -- Google Calendar mirrored server-side from its secret iCal address, so devices that
  -- never signed in to Google (the Boytasks TV kiosk) can see the family's events too.
  -- DELIBERATELY NOT the events table: the web app already fetches these same events
  -- straight from Google with the browser's token, so merging them in would show every
  -- training twice in the grid. Nothing but the kiosk reads this table.
  CREATE TABLE IF NOT EXISTS ical_events (
    uid TEXT PRIMARY KEY,
    member_id INTEGER,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    location TEXT,
    synced_at TEXT
  );
`);

// Pre-populate family members if empty
const countMembers = db.prepare('SELECT COUNT(*) as count FROM members').get() as { count: number };
if (countMembers.count === 0) {
  const insertMember = db.prepare('INSERT INTO members (name, role, avatar_url, color) VALUES (?, ?, ?, ?)');
  insertMember.run('Папа', 'parent', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Dad', '#3b82f6');
  insertMember.run('Мама', 'parent', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Mom', '#ec4899');
  insertMember.run('Мирон', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Miron', '#10b981');
  insertMember.run('Дитина 2', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child2', '#f59e0b');
  insertMember.run('Дитина 3', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child3', '#8b5cf6');
  insertMember.run('Дитина 4', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child4', '#ef4444');
  insertMember.run('Дитина 5', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child5', '#06b6d4');
}

// ─── Places & Event Types library helpers ────────────────────

function getPlacesLibrary(): { id: number; short_name: string; full_name: string; address: string; description: string }[] {
  return db.prepare('SELECT id, short_name, full_name, address, description FROM places').all() as any[];
}

function getEventTypesLibrary(): { short_name: string; full_name: string; default_location: string; default_duration_min: number }[] {
  return db.prepare('SELECT short_name, full_name, default_location, default_duration_min FROM event_types').all() as any[];
}

function findPlace(name: string): any {
  return db.prepare('SELECT * FROM places WHERE LOWER(short_name) = LOWER(?)').get(name);
}

function addPlace(shortName: string, fullName?: string, address?: string, description?: string) {
  const existing = findPlace(shortName);
  if (existing) {
    db.prepare('UPDATE places SET full_name = COALESCE(?, full_name), address = COALESCE(?, address), description = COALESCE(?, description) WHERE id = ?')
      .run(fullName || null, address || null, description || null, existing.id);
  } else {
    db.prepare('INSERT INTO places (short_name, full_name, address, description) VALUES (?, ?, ?, ?)')
      .run(shortName, fullName || '', address || '', description || '');
  }
}

function findEventType(name: string): any {
  return db.prepare('SELECT * FROM event_types WHERE LOWER(short_name) = LOWER(?)').get(name);
}

function addEventType(shortName: string, fullName?: string, defaultLocation?: string, durationMin?: number) {
  const existing = findEventType(shortName);
  if (existing) {
    db.prepare('UPDATE event_types SET full_name = COALESCE(?, full_name), default_location = COALESCE(?, default_location), default_duration_min = COALESCE(?, default_duration_min) WHERE id = ?')
      .run(fullName || null, defaultLocation || null, durationMin || null, existing.id);
  } else {
    db.prepare('INSERT INTO event_types (short_name, full_name, default_location, default_duration_min) VALUES (?, ?, ?, ?)')
      .run(shortName, fullName || '', defaultLocation || '', durationMin || 60);
  }
}

// Pending follow-up questions per chat (chatId → { type, context })
const pendingFollowUp = new Map<string,
  | { type: 'place'; name: string; eventId?: number }
  | { type: 'event_type'; name: string; eventId?: number }
>();

// Helper functions for settings
const getSetting = (key: string) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
};

const setSetting = (key: string, value: string) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

const getGeminiKey = () => getSetting('gemini_api_key') || process.env.GEMINI_API_KEY || '';
const getGroqKey = () => getSetting('groq_api_key') || process.env.GROQ_API_KEY || '';
/**
 * The model name is a SETTING, not a constant: Google retires a generation and the old id
 * starts answering 404 "no longer available to new users" — which is exactly how this bot went
 * silent (a hardcoded 2.5-era model plus a revoked key, dead 18.08-26.08.2026). Lite is the
 * deliberate default: it accepts thinkingBudget:0 and gets 500 free requests a day, while the
 * full Flash models are capped at 20.
 */
const getGeminiModel = () => getSetting('gemini_model') || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

/**
 * A day-keyed tally of LLM calls, so «are we near the free-tier ceiling?» is answered by a
 * number instead of a guess. Both tiers are per DAY: Gemini Lite gives 500 requests, Groq
 * whisper 2000 requests / 7200 audio-seconds. Cheap to keep, and it is the only record we
 * have — the providers show usage in a dashboard nobody watches.
 */
function bumpLlmUsage(kind: 'gemini' | 'groq') {
  const key = `llm_usage:${new Date().toISOString().slice(0, 10)}`;
  let row: Record<string, number> = {};
  try { row = JSON.parse(getSetting(key) || '{}'); } catch { /* start a fresh tally */ }
  row[kind] = (row[kind] || 0) + 1;
  setSetting(key, JSON.stringify(row));
}

/**
 * Why the failure happened, in words the parent can act on. Until 2026-08-26 every failure
 * came back as the same «❌ Помилка обробки» — which is exactly how a revoked API key stayed
 * unnoticed from April to August: the bot looked like it was merely having a bad day.
 */
function llmFailureReason(err: any): string | null {
  const m = String(err?.message || err || '');
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(m)) {
    return '⚠️ Денний ліміт LLM вичерпано. Спробуй завтра або зміни модель у налаштуваннях.';
  }
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|CONSUMER_SUSPENDED|\b40[13]\b/i.test(m)) {
    return '⚠️ Ключ LLM недійсний або відкликаний — бот не зможе писати події, доки його не оновлять.';
  }
  if (/no longer available|NOT_FOUND|\b404\b/i.test(m)) {
    return `⚠️ Модель «${getGeminiModel()}» більше не доступна — треба вказати нову в налаштуваннях.`;
  }
  return null;
}

// Auto-setup: save env vars to DB on first run
function autoSetup() {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    setSetting('telegram_token', process.env.TELEGRAM_BOT_TOKEN);
  }
  if (process.env.ADMIN_CHAT_IDS) {
    setSetting('admin_chat_ids', process.env.ADMIN_CHAT_IDS);
  }
  if (process.env.GEMINI_API_KEY) {
    setSetting('gemini_api_key', process.env.GEMINI_API_KEY);
  }
  if (process.env.GROQ_API_KEY) {
    setSetting('groq_api_key', process.env.GROQ_API_KEY);
  }
  if (process.env.GEMINI_MODEL) {
    setSetting('gemini_model', process.env.GEMINI_MODEL);
  }
}

// ─── API Routes ──────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  const telegramToken = getSetting('telegram_token') || '';
  const adminChatIds = getSetting('admin_chat_ids') || '';
  const monthOffset = parseInt(getSetting('month_offset') || '0', 10);
  const gcalKeywords = getSetting('gcal_keywords') || '[]';
  const spondChildMapping = getSetting('spond_child_mapping') || '[]';
  // Multi-account: return accounts (without passwords) + legacy single-account for backward compat
  const spondAccountsJson = getSetting('spond_accounts') || '[]';
  let spondAccounts: { email: string; label?: string }[] = [];
  try {
    spondAccounts = JSON.parse(spondAccountsJson).map((a: any) => ({ email: a.email, label: a.label || a.email }));
  } catch { /* empty */ }
  // Legacy single-account fallback
  const spondEmail = getSetting('spond_email') || '';
  const spondHasPassword = !!getSetting('spond_password');
  if (spondAccounts.length === 0 && spondEmail && spondHasPassword) {
    spondAccounts = [{ email: spondEmail, label: spondEmail }];
  }
  const spondGroupMapping = getSetting('spond_group_mapping') || '[]';
  res.json({ telegramToken, adminChatIds, monthOffset, gcalKeywords, spondEmail, spondHasPassword, spondChildMapping, spondGroupMapping, spondAccounts });
});

app.post('/api/settings', (req, res) => {
  const { telegramToken, adminChatIds, monthOffset, gcalKeywords, spondEmail, spondPassword } = req.body;
  if (telegramToken !== undefined) setSetting('telegram_token', telegramToken);
  if (adminChatIds !== undefined) setSetting('admin_chat_ids', adminChatIds);
  if (monthOffset !== undefined) setSetting('month_offset', monthOffset.toString());
  if (gcalKeywords !== undefined) setSetting('gcal_keywords', gcalKeywords);
  // Legacy single-account support
  if (spondEmail !== undefined) setSetting('spond_email', spondEmail);
  if (spondPassword !== undefined) setSetting('spond_password', spondPassword);
  if (req.body.spondChildMapping !== undefined) setSetting('spond_child_mapping', req.body.spondChildMapping);
  if (req.body.spondGroupMapping !== undefined) setSetting('spond_group_mapping', req.body.spondGroupMapping);
  if (req.body.spondAccounts !== undefined) setSetting('spond_accounts', JSON.stringify(req.body.spondAccounts));
  if (req.body.geminiApiKey !== undefined) setSetting('gemini_api_key', req.body.geminiApiKey);
  res.json({ success: true });
});

// Add/remove Spond accounts
app.post('/api/spond/accounts/add', async (req, res) => {
  const { email, password, label } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Test login first
  try {
    const token = await spondLoginAccount({ email, password });
    if (!token) return res.json({ success: false, error: 'Невірний логін або пароль' });
  } catch {
    return res.json({ success: false, error: 'Помилка підключення до Spond' });
  }

  const accountsJson = getSetting('spond_accounts') || '[]';
  let accounts: SpondAccount[] = [];
  try { accounts = JSON.parse(accountsJson); } catch { /* empty */ }

  // Migrate legacy single account if spond_accounts is empty but legacy exists
  if (accounts.length === 0) {
    const legacyEmail = getSetting('spond_email');
    const legacyPassword = getSetting('spond_password');
    if (legacyEmail && legacyPassword) {
      accounts.push({ email: legacyEmail, password: legacyPassword, label: legacyEmail });
    }
  }

  // Check if account already exists
  if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
    return res.json({ success: false, error: 'Цей акаунт вже додано' });
  }

  accounts.push({ email, password, label: label || email });
  setSetting('spond_accounts', JSON.stringify(accounts));

  res.json({ success: true, accounts: accounts.map(a => ({ email: a.email, label: a.label })) });
});

app.post('/api/spond/accounts/remove', (req, res) => {
  const { email } = req.body;
  const accountsJson = getSetting('spond_accounts') || '[]';
  let accounts: SpondAccount[] = [];
  try { accounts = JSON.parse(accountsJson); } catch { /* empty */ }

  accounts = accounts.filter(a => a.email.toLowerCase() !== email.toLowerCase());
  setSetting('spond_accounts', JSON.stringify(accounts));

  // Clear per-account caches (the token is persisted too — drop that copy as well)
  clearStoredSpondToken(email);
  setSetting(`spond_login_cooldown:${email}`, '0');
  spondGroupsCaches.delete(email);
  spondProfileCaches.delete(email);

  res.json({ success: true, accounts: accounts.map(a => ({ email: a.email, label: a.label })) });
});

app.get('/api/members', (req, res) => {
  const members = db.prepare('SELECT * FROM members').all();
  res.json(members);
});

app.put('/api/members/:id', (req, res) => {
  const { name, avatar_url, color } = req.body;
  db.prepare('UPDATE members SET name = ?, avatar_url = ?, color = ? WHERE id = ?').run(name, avatar_url, color, req.params.id);
  res.json({ success: true });
});

// ─── Events API ──────────────────────────────────────────────

app.get('/api/library/places', (_req, res) => {
  try { res.json(getPlacesLibrary()); } catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/library/places', (req, res) => {
  const { short_name, full_name, address, description } = req.body;
  if (!short_name) return res.status(400).json({ error: 'short_name required' });
  addPlace(short_name, full_name, address, description);
  res.json({ success: true });
});
app.delete('/api/library/places/:id', (req, res) => {
  db.prepare('DELETE FROM places WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});
app.get('/api/library/event-types', (_req, res) => {
  try { res.json(getEventTypesLibrary()); } catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/library/event-types', (req, res) => {
  const { short_name, full_name, default_location, default_duration_min } = req.body;
  if (!short_name) return res.status(400).json({ error: 'short_name required' });
  addEventType(short_name, full_name, default_location, default_duration_min);
  res.json({ success: true });
});
app.delete('/api/library/event-types/:id', (req, res) => {
  db.prepare('DELETE FROM event_types WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Restrictions API ───
app.get('/api/restrictions', (_req, res) => {
  const restrictions = db.prepare('SELECT * FROM restrictions').all();
  res.json(restrictions);
});

app.delete('/api/restrictions/:id', (req, res) => {
  db.prepare('DELETE FROM restrictions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Google Calendar via secret iCal ──────────────────────────
//
// Why this exists: Google Calendar events reach the web app only through the BROWSER's
// OAuth token, so they live nowhere on this server — a device that never signed in to
// Google (the Boytasks TV kiosk) can never see them. Subscribing to the calendar's own
// secret iCal address lets the server mirror them itself, with no login anywhere.
//
// The URL is a credential — anyone holding it reads the whole calendar — so it lives in
// `settings.gcal_ics_urls`, never in code and never in git.
//
// Each entry is either a bare URL string (a whole family calendar, where events are handed
// to a child by keyword rules) or `{url, member_id, label}` — a feed belonging to ONE child,
// typically a single Spond group. The tagged form is what makes four brothers' football
// separable at all: the calendar itself carries no child, only a group name, so an event
// titled just "Fotballtrening" is unattributable by title. Coming from that child's own feed
// answers it outright, and survives the club renaming the group next season.

const ICAL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const ICAL_PAST_DAYS = 14;
const ICAL_FUTURE_DAYS = 120;

type IcalFeed = { url: string; member_id: number; label: string };

function getIcalUrls(): IcalFeed[] {
  const raw = getSetting('gcal_ics_urls');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const feeds: IcalFeed[] = [];
    for (const entry of arr) {
      if (typeof entry === 'string' && entry.startsWith('http')) {
        feeds.push({ url: entry, member_id: 0, label: '' });
      } else if (entry && typeof entry.url === 'string' && entry.url.startsWith('http')) {
        feeds.push({ url: entry.url, member_id: Number(entry.member_id) || 0, label: entry.label || '' });
      }
    }
    return feeds;
  } catch {
    return [];
  }
}

/** Minutes that `tz` is ahead of UTC at that instant. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Wall-clock time in a named zone → absolute ISO instant. Two passes because the offset
 * itself depends on the instant we are solving for (CET vs CEST); the second pass settles
 * every case except the hour that DST skips, which no calendar schedules into anyway.
 */
function zonedToIso(y: number, mo: number, d: number, h: number, mi: number, tz: string): string {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - tzOffsetMinutes(new Date(guess), tz) * 60000;
  return new Date(guess).toISOString();
}

/** One DTSTART/DTEND property → ISO instant. Handles UTC, TZID and all-day (VALUE=DATE). */
function icsDateToIso(propParams: string, value: string): string | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mi, , z] = m;
  if (!hh) return zonedToIso(+y, +mo, +d, 0, 0, 'Europe/Oslo'); // all-day → local midnight
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi)).toISOString();
  const tzid = /TZID=([^;:]+)/.exec(propParams)?.[1] || 'Europe/Oslo';
  try {
    return zonedToIso(+y, +mo, +d, +hh, +mi, tzid);
  } catch {
    return zonedToIso(+y, +mo, +d, +hh, +mi, 'Europe/Oslo');
  }
}

type IcsEvent = { uid: string; title: string; start: string; end: string; location: string };

function parseIcs(text: string): IcsEvent[] {
  // Unfold: iCal wraps long lines by starting the continuation with a space or tab.
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const unescape = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

  const out: IcsEvent[] = [];
  const windowStart = Date.now() - ICAL_PAST_DAYS * 86400000;
  const windowEnd = Date.now() + ICAL_FUTURE_DAYS * 86400000;

  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const prop = (name: string) => {
      const re = new RegExp(`^${name}([^:\\r\\n]*):(.*)$`, 'm');
      const m = re.exec(body);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };

    if (/^STATUS:CANCELLED/m.test(body)) continue;
    const summary = prop('SUMMARY');
    const title = summary ? unescape(summary.value) : '';
    if (!title) continue; // Google exports a handful of title-less rows; nothing to show

    const dtStart = prop('DTSTART');
    if (!dtStart) continue;
    const startIso = icsDateToIso(dtStart.params, dtStart.value);
    if (!startIso) continue;

    const dtEnd = prop('DTEND');
    const endIso = (dtEnd && icsDateToIso(dtEnd.params, dtEnd.value))
      || new Date(new Date(startIso).getTime() + 3600000).toISOString();

    const uid = prop('UID')?.value || `${title}|${startIso}`;
    const location = unescape(prop('LOCATION')?.value || '');
    const rrule = prop('RRULE')?.value || '';

    const push = (s: string, e: string, suffix = '') => {
      const t = new Date(s).getTime();
      if (t >= windowStart && t <= windowEnd) out.push({ uid: uid + suffix, title, start: s, end: e, location });
    };

    if (!rrule) { push(startIso, endIso); continue; }

    // Recurrence: expand DAILY/WEEKLY inside the sync window only. Anything else is kept as
    // its single first occurrence rather than silently dropped.
    const rule: Record<string, string> = {};
    for (const part of rrule.split(';')) {
      const [k, v] = part.split('=');
      if (k && v) rule[k.toUpperCase()] = v;
    }
    const freq = rule.FREQ;
    if (freq !== 'DAILY' && freq !== 'WEEKLY') { push(startIso, endIso); continue; }

    const stepDays = (freq === 'DAILY' ? 1 : 7) * (parseInt(rule.INTERVAL || '1', 10) || 1);
    const until = rule.UNTIL ? new Date(icsDateToIso('', rule.UNTIL) || '').getTime() : Infinity;
    const maxCount = rule.COUNT ? parseInt(rule.COUNT, 10) : Infinity;
    const duration = new Date(endIso).getTime() - new Date(startIso).getTime();

    let cursor = new Date(startIso).getTime();
    for (let n = 0; n < 500 && n < maxCount && cursor <= until && cursor <= windowEnd; n++) {
      if (cursor >= windowStart) {
        const s = new Date(cursor).toISOString();
        push(s, new Date(cursor + duration).toISOString(), `#${s.slice(0, 10)}`);
      }
      cursor += stepDays * 86400000;
    }
  }
  return out;
}

/**
 * Assign each event to a family member the same way the web app does (`App.tsx`,
 * `matchedGcalEvents`): keyword rules first — they also rename the event to the parent's own
 * label — then a plain member-name match, otherwise nobody.
 */
function matchMemberForTitle(title: string): { member_id: number; title: string } {
  const lower = title.toLowerCase();
  try {
    const rules: { keyword: string; member_id: number; label?: string }[] = JSON.parse(getSetting('gcal_keywords') || '[]');
    const hit = rules.find(r => r.keyword && lower.includes(r.keyword.toLowerCase()));
    if (hit) return { member_id: hit.member_id, title: hit.label || title };
  } catch { /* no rules configured yet */ }

  const members = db.prepare('SELECT id, name FROM members').all() as { id: number; name: string }[];
  const byName = members.find(m => lower.includes(m.name.toLowerCase()));
  return { member_id: byName ? byName.id : 0, title };
}

let icalSyncing = false;

async function syncIcalFeeds(): Promise<{ ok: boolean; feeds: number; events: number; error?: string }> {
  if (icalSyncing) return { ok: false, feeds: 0, events: 0, error: 'already running' };
  const urls = getIcalUrls();
  if (!urls.length) return { ok: false, feeds: 0, events: 0, error: 'no gcal_ics_urls configured' };

  icalSyncing = true;
  try {
    const collected = new Map<string, IcsEvent & { owner: number }>();
    let okFeeds = 0;
    // Untagged family calendars first, then per-child feeds: when the same training sits in
    // both (a parent accepted the Spond invite into their own calendar), UID dedup keeps one
    // copy, and it must be the one that knows whose child it is.
    const ordered = [...urls].sort((a, b) => (a.member_id ? 1 : 0) - (b.member_id ? 1 : 0));
    for (const feed of ordered) {
      try {
        const res = await fetch(feed.url, { headers: { 'User-Agent': 'berbeha-calendar/1.0' } });
        if (!res.ok) { console.error(`📅 iCal feed HTTP ${res.status} (${feed.label || 'family'})`); continue; }
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) { console.error(`📅 iCal feed returned no calendar (${feed.label || 'family'})`); continue; }
        for (const e of parseIcs(text)) collected.set(e.uid, { ...e, owner: feed.member_id });
        okFeeds++;
      } catch (err: any) {
        console.error('📅 iCal feed failed:', err?.message || err);
      }
    }

    // A feed that answered but parsed to nothing must not wipe what we already show.
    if (!okFeeds || !collected.size) {
      const kept = (db.prepare('SELECT COUNT(*) c FROM ical_events').get() as { c: number }).c;
      console.warn(`📅 iCal sync produced no events — keeping the ${kept} already stored`);
      return { ok: false, feeds: okFeeds, events: 0, error: 'empty result' };
    }

    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT INTO ical_events (uid, member_id, title, start_time, end_time, location, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET
        member_id = excluded.member_id, title = excluded.title,
        start_time = excluded.start_time, end_time = excluded.end_time,
        location = excluded.location, synced_at = excluded.synced_at
    `);
    const sweep = db.prepare('DELETE FROM ical_events WHERE synced_at < ?');

    db.transaction(() => {
      for (const e of collected.values()) {
        // A feed dedicated to one child already answers "whose is this?" — only fall back to
        // guessing from the title for the shared family calendars.
        const m = e.owner ? { member_id: e.owner, title: e.title } : matchMemberForTitle(e.title);
        upsert.run(e.uid, m.member_id, m.title, e.start, e.end, e.location, now);
      }
      sweep.run(now); // rows absent from this run were deleted or moved in Google
    })();

    console.log(`📅 iCal sync: ${collected.size} events from ${okFeeds}/${urls.length} feed(s)`);
    return { ok: true, feeds: okFeeds, events: collected.size };
  } finally {
    icalSyncing = false;
  }
}

// Read-only feed for the Boytasks TV kiosk (its worker proxies this; the web app does not
// use it — the browser already has the same events straight from Google).
app.get('/api/ical/events', (_req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM ical_events ORDER BY start_time').all();
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ical/sync', async (_req, res) => {
  res.json(await syncIcalFeeds());
});

// Scheduled unconditionally: syncIcalFeeds() no-ops while no feed is configured, so a URL
// added later starts syncing on its own instead of waiting for a restart.
if (getIcalUrls().length) syncIcalFeeds().catch(() => {});
setInterval(() => { syncIcalFeeds().catch(() => {}); }, ICAL_SYNC_INTERVAL_MS);

app.get('/api/events', (req, res) => {
  const events = db.prepare('SELECT * FROM events').all();
  res.json(events);
});

app.post('/api/events', (req, res) => {
  const { member_id, title, start_time, end_time, location } = req.body;
  try {
    const result = db.prepare('INSERT INTO events (member_id, title, start_time, end_time, location) VALUES (?, ?, ?, ?, ?)')
      .run(member_id || null, title, start_time, end_time || start_time, location || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Member photos API
app.get('/api/members/:id/photos', (req, res) => {
  const photos = db.prepare('SELECT * FROM member_photos WHERE member_id = ?').all(req.params.id);
  res.json(photos);
});

app.post('/api/members/:id/photos', (req, res) => {
  const { photo_url } = req.body;
  if (!photo_url) return res.status(400).json({ error: 'photo_url required' });
  const result = db.prepare('INSERT INTO member_photos (member_id, photo_url) VALUES (?, ?)').run(req.params.id, photo_url);
  res.json({ success: true, id: result.lastInsertRowid });
});

// Download photo from URL and save locally
app.post('/api/members/:id/photos/from-url', async (req, res) => {
  console.log(`📸 from-url endpoint called for member ${req.params.id}, body:`, JSON.stringify(req.body).slice(0, 200));
  const { urls } = req.body;
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  console.log(`📸 urls count: ${urls?.length || 0}, hasToken: ${!!accessToken}`);
  if (!urls || !Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls array required' });

  const saved: number[] = [];
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {};
      if (accessToken && url.includes('googleusercontent.com')) {
        headers['Authorization'] = `Bearer ${accessToken}`;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) { console.log(`📸 Download failed: ${response.status} for ${url.slice(0, 80)}`); continue; }
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
      const filePath = path.join(photosDir, filename);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      const localUrl = `/photos/${filename}`;
      const result = db.prepare('INSERT INTO member_photos (member_id, photo_url) VALUES (?, ?)').run(req.params.id, localUrl);
      saved.push(result.lastInsertRowid as number);
      console.log(`📸 Saved photo: ${filename} (${(buffer.length / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.error('Failed to download photo:', err);
    }
  }
  res.json({ success: true, count: saved.length, ids: saved });
});

// Upload photo file
app.post('/api/members/:id/photos/upload', upload.array('photos', 20), (req, res) => {
  const files = req.files as any[];
  if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const inserted: number[] = [];
  for (const file of files) {
    const photoUrl = `/photos/${file.filename}`;
    const result = db.prepare('INSERT INTO member_photos (member_id, photo_url) VALUES (?, ?)').run(req.params.id, photoUrl);
    inserted.push(result.lastInsertRowid as number);
  }
  res.json({ success: true, count: inserted.length, ids: inserted });
});

app.delete('/api/members/:id/photos/:photoId', (req, res) => {
  db.prepare('DELETE FROM member_photos WHERE id = ? AND member_id = ?').run(req.params.photoId, req.params.id);
  res.json({ success: true });
});

app.delete('/api/members/:id/photos', (req, res) => {
  db.prepare('DELETE FROM member_photos WHERE member_id = ?').run(req.params.id);
  res.json({ success: true });
});

// Google Photos Picker API — create session
app.post('/api/google-photos/session', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization required' });

  try {
    console.log('📸 Creating Photos Picker session...');
    const response = await fetch('https://photospicker.googleapis.com/v1/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ }),
    });
    const data = await response.json();
    console.log('📸 Picker session response:', JSON.stringify(data, null, 2));
    res.json(data);
  } catch (error) {
    console.error('Photos Picker session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Google Photos Picker API — poll session status
app.get('/api/google-photos/session/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization required' });

  try {
    const response = await fetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await response.json();
    console.log(`📸 Poll session: mediaItemsSet=${data.mediaItemsSet}`, data.error ? `ERROR: ${JSON.stringify(data.error)}` : '');
    res.json(data);
  } catch (error) {
    console.error('📸 Poll error:', error);
    res.status(500).json({ error: 'Failed to poll session' });
  }
});

// Google Photos Picker API — get selected media items
app.get('/api/google-photos/media-items', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization required' });

  const sessionId = req.query.sessionId as string;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  try {
    const response = await fetch(`https://photospicker.googleapis.com/v1/mediaItems?sessionId=${sessionId}&pageSize=100`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await response.json();
    console.log('📸 Media items response status:', response.status);
    console.log('📸 Media items full response:', JSON.stringify(data, null, 2));
    if (data.mediaItems) {
      data.mediaItems.forEach((item: any, i: number) => {
        console.log(`📸 Item ${i}: keys=${Object.keys(item).join(',')}`);
        if (item.mediaFile) console.log(`📸 Item ${i} mediaFile keys=${Object.keys(item.mediaFile).join(',')}, baseUrl=${item.mediaFile.baseUrl?.slice(0, 80)}`);
      });
    }
    res.json(data);
  } catch (error) {
    console.error('📸 Media items error:', error);
    res.status(500).json({ error: 'Failed to fetch media items' });
  }
});

// Google Photos Picker API — delete session
app.delete('/api/google-photos/session/:id', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization required' });

  try {
    await fetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false });
  }
});

// Google Calendar proxy — fetch events from user's Google Calendar
app.get('/api/google-calendar/events', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization header required' });

  try {
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Google Calendar error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// Google Calendar — list all calendars
app.get('/api/google-calendar/list', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization header required' });

  try {
    const response = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Google Calendar list error:', error);
    res.status(500).json({ error: 'Failed to fetch calendars' });
  }
});

// Google Calendar — fetch events from specific calendar
app.get('/api/google-calendar/events/:calendarId', async (req, res) => {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(400).json({ error: 'Authorization header required' });

  try {
    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();
    const calId = encodeURIComponent(req.params.calendarId);

    const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=250`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Google Calendar events error:', error);
    res.status(500).json({ error: 'Failed to fetch calendar events' });
  }
});

// ─── Spond API Integration (multi-account) ──────────────────

const SPOND_API = 'https://api.spond.com/core/v1';

type SpondAccount = { email: string; password: string; label?: string };

// Per-account caches
const spondTokens = new Map<string, { token: string; expiry: number }>();
const spondGroupsCaches = new Map<string, { groups: any[]; expiry: number }>();
const spondProfileCaches = new Map<string, { profile: any; expiry: number }>();

function getSpondAccounts(): SpondAccount[] {
  // Support both old single-account and new multi-account settings
  const accountsJson = getSetting('spond_accounts');
  if (accountsJson) {
    try { return JSON.parse(accountsJson); } catch { /* fall through */ }
  }
  // Legacy single-account fallback
  const email = getSetting('spond_email');
  const password = getSetting('spond_password');
  if (email && password) return [{ email, password, label: email }];
  return [];
}

const SPOND_TOKEN_TTL = 50 * 60 * 1000;
const SPOND_LOGIN_COOLDOWN = 30 * 60 * 1000;
// A refused password is not a transient hiccup — wait far longer than for a rate limit.
const SPOND_LOCKOUT_COOLDOWN = 60 * 60 * 1000;
const SPOND_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function readStoredSpondToken(email: string): { token: string; expiry: number } | null {
  const raw = getSetting(`spond_token:${email}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.token && parsed?.expiry ? parsed : null;
  } catch {
    return null;
  }
}

function clearStoredSpondToken(email: string) {
  spondTokens.delete(email);
  setSetting(`spond_token:${email}`, '');
}

/**
 * Spond's API sits behind Cloudflare, which rate-limits /login PER IP — a block shows up as
 * HTTP 429 with the body "error code: 1015", and since that body is HTML, the old
 * `res.json()` turned it into the misleading `Unexpected token '<'` in the log.
 *
 * The token used to live in memory only, so every service restart dropped it and each account
 * logged in again on the very next request. That storm is what got this VM blocked (verified
 * 2026-08-15: /login answered 429/1015 while /profile still answered a normal 401, i.e. the IP
 * was not banned — only the login endpoint was). So the token is now persisted in `settings`
 * and survives restarts, and a rate-limit arms a cooldown instead of retrying: hammering a
 * rate limiter only extends the block.
 */
async function spondLoginAccount(account: SpondAccount): Promise<string | null> {
  const cached = spondTokens.get(account.email);
  if (cached && Date.now() < cached.expiry) return cached.token;

  const stored = readStoredSpondToken(account.email);
  if (stored && Date.now() < stored.expiry) {
    spondTokens.set(account.email, stored);
    return stored.token;
  }

  const cooldownUntil = parseInt(getSetting(`spond_login_cooldown:${account.email}`) || '0', 10);
  if (Date.now() < cooldownUntil) {
    const mins = Math.ceil((cooldownUntil - Date.now()) / 60000);
    console.warn(`🏟️ Spond login skipped (${account.email}): rate-limited, retrying in ~${mins} min`);
    return null;
  }

  try {
    // Spond retired POST /core/v1/login: it answers 404 with Spond's own JSON (verified
    // 2026-08-19 from two different IPs, so it is a removed route, not a Cloudflare block).
    // Its web client authenticates at /core/v1/auth2/login instead — GET on that path answers
    // 405 Method Not Allowed while GET on the old one answers 404, which is how the live path
    // was found without ever sending a password.
    const res = await fetch(`${SPOND_API}/auth2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': SPOND_UA },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });

    // Read as text: a Cloudflare block page is HTML, and parsing it as JSON hides the real cause.
    const body = await res.text();

    // Back off on the rate limit itself, not on how the rejection happens to be encoded —
    // Cloudflare answers 429 sometimes as an HTML block page, sometimes as valid JSON.
    if (res.status === 429) {
      setSetting(`spond_login_cooldown:${account.email}`, String(Date.now() + SPOND_LOGIN_COOLDOWN));
      console.error(`🏟️ Spond rate-limited (${account.email}): "${body.slice(0, 80).replace(/\s+/g, ' ')}" — backing off ${SPOND_LOGIN_COOLDOWN / 60000} min`);
      return null;
    }

    let data: any = null;
    try {
      data = JSON.parse(body);
    } catch {
      setSetting(`spond_login_cooldown:${account.email}`, String(Date.now() + SPOND_LOGIN_COOLDOWN));
      console.error(`🏟️ Spond login blocked (${account.email}): HTTP ${res.status}, non-JSON reply "${body.slice(0, 80).replace(/\s+/g, ' ')}" — backing off ${SPOND_LOGIN_COOLDOWN / 60000} min`);
      return null;
    }

    // The old route called it `loginToken`; auth2 may name it differently. Accept any of the
    // shapes rather than tie the fix to one field name — the token is what matters.
    // Spond locks a profile out after a burst of failed logins ("outOfLoginAttempts").
    // Retrying then keeps the lock alive forever: the kiosk asks for the calendar every
    // 10 minutes, which is two more failed attempts per account per poll. So a refusal
    // arms the same cooldown a rate limit does, giving the lock a chance to lapse.
    if (res.status === 401 || res.status === 403) {
      setSetting(`spond_login_cooldown:${account.email}`, String(Date.now() + SPOND_LOCKOUT_COOLDOWN));
      console.error(`🏟️ Spond login refused (${account.email}): HTTP ${res.status} ${data?.errorKey || ''} — backing off ${SPOND_LOCKOUT_COOLDOWN / 60000} min`);
      return null;
    }

    // /auth2/login does NOT return a bare string: `accessToken` is an OBJECT
    // `{token, expiration}` (verified 2026-08-26). Taken as-is it went out as the literal
    // header `Bearer [object Object]`, so every API call answered 401, every 401 dropped the
    // token, and the next poll logged in again — the storm that ended with Spond answering
    // `outOfLoginAttempts` for stuardbmw. Accept both shapes and trust the server's expiry.
    const rawToken = data.loginToken ?? data.accessToken ?? data.token;
    const loginToken = typeof rawToken === 'string' ? rawToken : rawToken?.token;
    const serverExpiry = rawToken && typeof rawToken === 'object' && rawToken.expiration
      ? Date.parse(rawToken.expiration) : NaN;
    if (typeof loginToken === 'string' && loginToken) {
      // Refresh a minute before Spond's own expiry, and never later than our local TTL.
      const expiry = Number.isFinite(serverExpiry)
        ? Math.min(serverExpiry - 60_000, Date.now() + SPOND_TOKEN_TTL)
        : Date.now() + SPOND_TOKEN_TTL;
      const entry = { token: loginToken, expiry };
      spondTokens.set(account.email, entry);
      setSetting(`spond_token:${account.email}`, JSON.stringify(entry));
      setSetting(`spond_login_cooldown:${account.email}`, '0');
      return entry.token;
    }

    // Log the reply's FIELD NAMES only — never its values, one of them may be a token.
    console.error(`🏟️ Spond login rejected (${account.email}): HTTP ${res.status}, no token in reply (fields: ${Object.keys(data || {}).join(',') || 'none'})`);
    return null;
  } catch (err) {
    console.error(`Spond login error (${account.email}):`, err);
    return null;
  }
}

// Backwards-compatible single-account login (for /api/spond/test)
async function spondLogin(email?: string, password?: string): Promise<string | null> {
  const accounts = getSpondAccounts();
  const e = email || accounts[0]?.email;
  const p = password || accounts[0]?.password;
  if (!e || !p) return null;
  return spondLoginAccount({ email: e, password: p });
}

async function spondFetchAs(account: SpondAccount, endpoint: string, params?: Record<string, string>): Promise<any> {
  const token = await spondLoginAccount(account);
  if (!token) throw new Error(`Spond not authenticated (${account.email})`);

  const url = new URL(`${SPOND_API}/${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });
  // A persisted token outlives a restart, so it can also outlive its validity on Spond's side.
  // Drop it on 401 instead of serving the stale one until the local TTL runs out.
  if (res.status === 401) {
    clearStoredSpondToken(account.email);
    // Dropping the token is not enough on its own: when it is rejected for a reason a fresh
    // login cannot fix, every following poll logs in again and Spond counts those attempts
    // until it locks the profile. So a rejected token arms the same brake the rate limit and
    // the refused password already use.
    setSetting(`spond_login_cooldown:${account.email}`, String(Date.now() + SPOND_LOGIN_COOLDOWN));
    throw new Error(`Spond API 401 — token rejected (${account.email}), backing off ${SPOND_LOGIN_COOLDOWN / 60000} min`);
  }
  if (!res.ok) throw new Error(`Spond API ${res.status} (${account.email})`);
  return res.json();
}

// Backwards-compatible fetch using first account
async function spondFetch(endpoint: string, params?: Record<string, string>): Promise<any> {
  const accounts = getSpondAccounts();
  if (!accounts.length) throw new Error('No Spond accounts configured');
  return spondFetchAs(accounts[0], endpoint, params);
}

async function getSpondProfileFor(account: SpondAccount): Promise<any> {
  const cached = spondProfileCaches.get(account.email);
  if (cached && Date.now() < cached.expiry) return cached.profile;
  const profile = await spondFetchAs(account, 'profile');
  spondProfileCaches.set(account.email, { profile, expiry: Date.now() + 10 * 60 * 1000 });
  return profile;
}

async function getSpondProfile(): Promise<any> {
  const accounts = getSpondAccounts();
  if (!accounts.length) throw new Error('No Spond accounts configured');
  return getSpondProfileFor(accounts[0]);
}

async function getSpondGroupsFor(account: SpondAccount): Promise<any[]> {
  const cached = spondGroupsCaches.get(account.email);
  if (cached && Date.now() < cached.expiry) return cached.groups;
  const groups = await spondFetchAs(account, 'groups/');
  spondGroupsCaches.set(account.email, { groups, expiry: Date.now() + 10 * 60 * 1000 });
  return groups;
}

async function getSpondGroups(): Promise<any[]> {
  const accounts = getSpondAccounts();
  if (!accounts.length) throw new Error('No Spond accounts configured');
  return getSpondGroupsFor(accounts[0]);
}

// Merge groups from all accounts (deduplicate by group ID)
async function getAllSpondGroups(): Promise<any[]> {
  const accounts = getSpondAccounts();
  const allGroups = new Map<string, any>();
  for (const account of accounts) {
    try {
      const groups = await getSpondGroupsFor(account);
      for (const g of groups) {
        if (!allGroups.has(g.id)) allGroups.set(g.id, g);
      }
    } catch (err) {
      console.error(`Failed to fetch groups for ${account.email}:`, err);
    }
  }
  return Array.from(allGroups.values());
}

// Find all children of all logged-in parents across all groups (multi-account)
async function findMyChildren(): Promise<Map<string, { profileId: string; firstName: string; lastName: string; groups: { id: string; name: string }[] }>> {
  const accounts = getSpondAccounts();
  if (!accounts.length) return new Map();

  // Collect all parent profile IDs, emails, and groups across all accounts
  const parentProfileIds = new Set<string>();
  const parentEmails = new Set<string>();
  const parentLastNames = new Set<string>();
  const allGroups: any[] = [];

  // Ukrainian Cyrillic → Latin transliteration
  const cyrToLat: Record<string, string> = {
    'а':'a','б':'b','в':'v','г':'h','ґ':'g','д':'d','е':'e','є':'ye','ж':'zh',
    'з':'z','и':'y','і':'i','ї':'yi','й':'y','к':'k','л':'l','м':'m','н':'n',
    'о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts',
    'ч':'ch','ш':'sh','щ':'shch','ь':'','ю':'yu','я':'ya',
  };
  const toLatin = (s: string) => s.toLowerCase().split('').map(c => cyrToLat[c] || c).join('');

  for (const account of accounts) {
    try {
      const [profile, groups] = await Promise.all([
        getSpondProfileFor(account),
        getSpondGroupsFor(account),
      ]);
      parentProfileIds.add(profile.id);
      const email = (profile.email || account.email || '').toLowerCase();
      if (email) parentEmails.add(email);
      const lastName = (profile.lastName || '').toLowerCase();
      if (lastName) parentLastNames.add(lastName);
      // Merge groups (deduplicate by group ID)
      for (const g of groups) {
        if (!allGroups.some(eg => eg.id === g.id)) allGroups.push(g);
      }
      console.log(`🏟️ Account ${account.email}: profileId=${profile.id}, lastName=${profile.lastName}, groups=${groups.length}`);
    } catch (err) {
      console.error(`🏟️ Failed to fetch data for ${account.email}:`, err);
    }
  }

  const childrenMap = new Map<string, any>();

  // Strategy 1: Find members where any parent is listed as guardian (by profileId)
  for (const group of allGroups) {
    for (const member of (group.members || [])) {
      const isMyChild = (member.guardians || []).some(
        (g: any) => parentProfileIds.has(g.profile?.id) || parentProfileIds.has(g.id)
      );
      if (isMyChild && member.profile?.id) {
        const pid = member.profile.id;
        if (!childrenMap.has(pid)) {
          childrenMap.set(pid, { profileId: pid, firstName: member.firstName, lastName: member.lastName, groups: [] });
        }
        const existing = childrenMap.get(pid)!;
        if (!existing.groups.some((eg: any) => eg.id === group.id)) {
          existing.groups.push({ id: group.id, name: group.name });
        }
      }
    }
  }

  // Strategy 2: Guardian email match (using all account emails)
  if (childrenMap.size === 0 && parentEmails.size > 0) {
    console.log('🏟️ Guardian profileId match failed. Trying email match:', [...parentEmails]);
    for (const group of allGroups) {
      for (const member of (group.members || [])) {
        const isMyChild = (member.guardians || []).some(
          (g: any) => parentEmails.has(g.email?.toLowerCase()) || parentEmails.has(g.profile?.email?.toLowerCase())
        );
        if (isMyChild) {
          const pid = member.profile?.id || member.id;
          if (!childrenMap.has(pid)) {
            childrenMap.set(pid, { profileId: pid, firstName: member.firstName, lastName: member.lastName, groups: [] });
          }
          const existing = childrenMap.get(pid)!;
          if (!existing.groups.some((eg: any) => eg.id === group.id)) {
            existing.groups.push({ id: group.id, name: group.name });
          }
        }
      }
    }
  }

  // Strategy 3: Always supplement with family name match (handles cross-script names)
  for (const parentLastName of parentLastNames) {
    const parentLastNameLat = toLatin(parentLastName);
    console.log('🏟️ Also running family name match:', parentLastName, '→', parentLastNameLat);

    for (const group of allGroups) {
      for (const member of (group.members || [])) {
        if (parentProfileIds.has(member.profile?.id)) continue;
        if (!(member.guardians || []).length) continue; // only children (have guardians)
        const memberLastName = (member.lastName || '').toLowerCase();
        const memberLastNameLat = toLatin(memberLastName);
        const match = parentLastNameLat && memberLastNameLat &&
          (memberLastNameLat.includes(parentLastNameLat) || parentLastNameLat.includes(memberLastNameLat) ||
           memberLastNameLat.split(/[\s-]/).some((part: string) => part.length >= 3 && parentLastNameLat.includes(part)));
        if (match) {
          const pid = member.profile?.id || member.id;
          if (!childrenMap.has(pid)) {
            childrenMap.set(pid, { profileId: pid, firstName: member.firstName, lastName: member.lastName, groups: [] });
          }
          const existing = childrenMap.get(pid)!;
          if (!existing.groups.some((eg: any) => eg.id === group.id)) {
            existing.groups.push({ id: group.id, name: group.name });
          }
        }
      }
    }
  }

  // Deduplicate by name (Spond can assign different profileIds per group for the same person)
  const nameMap = new Map<string, any>();
  for (const child of childrenMap.values()) {
    const nameKey = `${child.firstName} ${child.lastName}`.toLowerCase();
    if (nameMap.has(nameKey)) {
      const existing = nameMap.get(nameKey)!;
      for (const g of child.groups) {
        if (!existing.groups.some((eg: any) => eg.id === g.id)) {
          existing.groups.push(g);
        }
      }
    } else {
      nameMap.set(nameKey, { ...child });
    }
  }

  console.log('🏟️ Found children:', Array.from(nameMap.values()).map(c => `${c.firstName} ${c.lastName} (${c.groups.length} groups)`));
  return new Map(Array.from(nameMap.values()).map(c => [c.profileId, c]));
}

// Build groupId → set of child profileIds mapping
async function buildGroupChildrenMap(): Promise<Map<string, Set<string>>> {
  const children = await findMyChildren();
  const groupChildren = new Map<string, Set<string>>();

  for (const [profileId, child] of children) {
    for (const group of child.groups) {
      if (!groupChildren.has(group.id)) groupChildren.set(group.id, new Set());
      groupChildren.get(group.id)!.add(profileId);
    }
  }
  return groupChildren;
}

// Translate event titles via Gemini (with SQLite cache)
async function translateTitles(titles: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const untranslated: string[] = [];

  for (const t of titles) {
    const row = db.prepare('SELECT translated FROM translations WHERE original = ?').get(t) as { translated: string } | undefined;
    if (row) {
      result[t] = row.translated;
    } else {
      untranslated.push(t);
    }
  }

  if (untranslated.length === 0) return result;

  const apiKey = getGeminiKey();
  if (!apiKey) {
    for (const t of untranslated) result[t] = t;
    return result;
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Translate these Norwegian sports/event titles to Ukrainian. Keep proper names (places, people) as-is. Return a JSON object where keys are originals and values are translations.\n\n${untranslated.map((t, i) => `${i + 1}. "${t}"`).join('\n')}`;

    const response = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: { parts: [{ text: prompt }] },
      config: { responseMimeType: 'application/json' },
    });

    const translations = JSON.parse(response.text || '{}');
    for (const [orig, trans] of Object.entries(translations)) {
      const translated = trans as string;
      db.prepare('INSERT OR REPLACE INTO translations (original, translated) VALUES (?, ?)').run(orig, translated);
      result[orig] = translated;
    }
    console.log(`🌐 Translated ${Object.keys(translations).length} titles`);
  } catch (err) {
    console.error('Translation error:', err);
    for (const t of untranslated) result[t] = t;
  }

  return result;
}

// Test Spond connection
app.post('/api/spond/test', async (req, res) => {
  const { email, password } = req.body;
  try {
    const token = await spondLogin(email, password);
    res.json({ success: !!token });
  } catch {
    res.json({ success: false });
  }
});

// Get user's children from Spond (auto-detected via guardians)
app.get('/api/spond/children', async (req, res) => {
  try {
    const children = await findMyChildren();
    res.json(Array.from(children.values()));
  } catch (err: any) {
    console.error('Spond children error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch children' });
  }
});

// Get Spond groups (fallback if children detection doesn't work)
app.get('/api/spond/groups', async (req, res) => {
  try {
    const groups = await getSpondGroups();
    const simplified = groups.map((g: any) => ({
      id: g.id,
      name: g.name,
      memberCount: (g.members || []).length,
    }));
    res.json(simplified);
  } catch (err: any) {
    console.error('Spond groups error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch groups' });
  }
});

// ─── Oslo wall-clock helpers ─────────────────────────────────
// The bot used to tell the parser «Timezone: +01:00» all year round and to stamp its own
// end times with the same literal — so every event dictated in summer time (late March to
// late October) landed one hour late: «збори 17:30» was stored as 17:30+01:00 = 18:30 Oslo.
// The offset must be COMPUTED for the date in question; Norway is +01:00 in winter and
// +02:00 in summer.
function osloOffset(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Oslo', timeZoneName: 'longOffset' })
    .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'GMT+01:00';
  const m = parts.match(/([+-])(\d{2}):?(\d{2})/);
  return m ? `${m[1]}${m[2]}:${m[3]}` : '+01:00';
}
function osloIso(d: Date): string {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const wall = f.format(d).replace(' ', 'T'); // sv-SE gives YYYY-MM-DD HH:mm:ss
  return `${wall}${osloOffset(d)}`;
}

// Get Spond events (with child-based mapping + translation, merged from all accounts)
app.get('/api/spond/events', async (req, res) => {
  try {
    const now = new Date();
    const minStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const maxStart = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();

    const accounts = getSpondAccounts();
    // Fetch events from all accounts and deduplicate by Spond event ID
    const eventMap = new Map<string, any>();
    const fetchPromises = accounts.map(async (account) => {
      try {
        const accountEvents = await spondFetchAs(account, 'sponds/', {
          max: '200',
          minStartTimestamp: minStart,
          maxStartTimestamp: maxStart,
        });
        for (const e of accountEvents) {
          // A fixture the club called off stays in Spond's list with `cancelled:true`
          // (+ `cancelledReason`, e.g. «Denne er flyttet til 22.oktober»). Until 2026-09-03
          // the flag was never read, so «Kolbu KK/Skreia – Kapp Lena Toten 2» stood on the
          // kiosk a day after Spond had struck it out.
          if (e.cancelled === true) {
            console.log(`🏟️ Skipping cancelled: ${e.startTimestamp} «${e.heading}» — ${e.cancelledReason || ''}`);
            continue;
          }
          if (!eventMap.has(e.id)) eventMap.set(e.id, e);
        }
      } catch (err) {
        console.error(`🏟️ Failed to fetch events for ${account.email}:`, err);
      }
    });
    await Promise.all(fetchPromises);

    const events = Array.from(eventMap.values());
    const groupChildren = await buildGroupChildrenMap();

    // Log stats
    console.log(`🏟️ Fetched ${events.length} unique events from ${accounts.length} account(s)`);
    // Get child mapping and group mapping from settings
    const mappingJson = getSetting('spond_child_mapping') || '[]';
    const childMapping: { profileId: string; member_id: number }[] = JSON.parse(mappingJson);
    const groupMappingJson = getSetting('spond_group_mapping') || '[]';
    const groupMapping: { groupId: string; member_id: number }[] = JSON.parse(groupMappingJson);

    // Translate all unique titles
    const uniqueTitles = [...new Set(events.map((e: any) => e.heading || '').filter(Boolean))] as string[];
    const translations = await translateTitles(uniqueTitles);

    const result = events.map((e: any, i: number) => {
      // recipients can be a plain string (group ID) or an object
      const groupId = e.groupId || e.group?.id || (typeof e.recipients === 'string' ? e.recipients : (e.recipients?.group?.id || e.recipients?.groupId || ''));

      // 1) Try child-based mapping (auto-detected children in this group)
      const childProfileIds = groupChildren.get(groupId) || new Set<string>();
      let memberId = 0;
      for (const profileId of childProfileIds) {
        const mapped = childMapping.find(m => m.profileId === profileId);
        if (mapped) { memberId = mapped.member_id; break; }
      }

      // 2) Fallback: group-based mapping (for parent groups, school groups, etc.)
      if (memberId === 0 && groupId) {
        const gm = groupMapping.find(m => m.groupId === groupId);
        if (gm) memberId = gm.member_id;
      }

      const loc = e.location
        ? [e.location.feature, e.location.address].filter(Boolean).join(', ')
        : '';

      const originalTitle = e.heading || '(Без назви)';
      const translatedTitle = translations[originalTitle] || originalTitle;

      return {
        id: -(10000 + i),
        member_id: memberId,
        title: translatedTitle,
        original_title: originalTitle,
        // The Spond app shows the MEET-UP time («Oppmøte 17:15») and that is what a family
        // calendar has to answer — when do we have to be there. `startTimestamp` is the
        // kick-off/whistle, which can sit 5-60 minutes later; it travels as `activity_start`
        // so the UI can print «17:15 (старт 18:00)». Spond's own Google sync writes the
        // meet-up time too, so the two copies of one fixture now agree to the minute.
        start_time: e.meetupTimestamp || e.startTimestamp,
        activity_start: e.startTimestamp,
        meetup_prior: e.meetupPrior || 0,
        end_time: e.endTimestamp,
        location: loc,
        spond_group_id: groupId,
        spond_group_name: e.recipients?.group?.name || '',
        _spond: true,
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error('Spond events error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch events' });
  }
});

app.delete('/api/events/:id', (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── Telegram Bot Polling ────────────────────────────────────

async function downloadTelegramFile(token: string, fileId: string): Promise<string | null> {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (fileData.ok) {
      const filePath = fileData.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
      const res = await fetch(fileUrl);
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    }
  } catch (err) {
    console.error('Failed to download file:', err);
  }
  return null;
}

/**
 * Speech to text. Groq's whisper-large-v3 first, Gemini only as the fallback: on the same clip
 * (26.08.2026) Whisper heard "Привіт, працюю зараз." while gemini-3.1-flash-lite heard
 * "Тревіть працюю зараз." — a garbled transcript makes the bot write a WRONG event, which is
 * worse than writing none.
 */
async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const groqKey = getGroqKey();
  if (groqKey) {
    try {
      const ext = mimeType.startsWith('video') ? 'mp4' : 'ogg';
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(audioBase64, 'base64')], { type: mimeType }), `voice.${ext}`);
      form.append('model', 'whisper-large-v3');
      form.append('language', 'uk');
      const res = await Promise.race([
        fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${groqKey}` },
          body: form,
        }),
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Groq timeout after 30s')), 30000)),
      ]);
      const data: any = await res.json();
      if (data?.text) {
        console.log('🎙️ Transcribed via Groq whisper-large-v3');
        bumpLlmUsage('groq');
        return String(data.text).trim();
      }
      console.error('🎙️ Groq transcription returned no text:', JSON.stringify(data).slice(0, 300));
    } catch (err: any) {
      console.error('🎙️ Groq transcription failed, falling back to Gemini:', err.message);
    }
  }

  const ai = new GoogleGenAI({ apiKey: getGeminiKey() });
  const resp = await Promise.race([
    ai.models.generateContent({
      model: getGeminiModel(),
      contents: { parts: [
        { inlineData: { data: audioBase64, mimeType } },
        { text: 'Транскрибуй це аудіо українською. Напиши ТІЛЬКИ текст що сказано, нічого більше.' },
      ]},
      config: { thinkingConfig: { thinkingBudget: 0 } },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Transcription timeout after 30s')), 30000)),
  ]) as any;
  console.log('🎙️ Transcribed via Gemini', getGeminiModel());
  bumpLlmUsage('gemini');
  return resp.text?.trim() || '';
}

// Telegram API helpers
async function tgSend(token: string, chatId: string, text: string, replyMarkup?: any) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // A refused send used to vanish: Telegram answers 400 when a button's callback_data
  // exceeds 64 BYTES (a Cyrillic place name of ~25 letters already does), and the whole
  // message — question and buttons alike — is silently never delivered.
  if (!res.ok) console.error(`🤖 Telegram sendMessage refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function tgAnswer(token: string, callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

async function tgEditMessage(token: string, chatId: string, messageId: number, text: string, replyMarkup?: any) {
  const body: any = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`🤖 Telegram editMessageText refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ─── Callback Query Handler (inline buttons) ────────────────

async function processCallbackQuery(update: any) {
  const telegramToken = getSetting('telegram_token');
  if (!telegramToken || !update.callback_query) return;

  const cb = update.callback_query;
  const chatId = cb.message.chat.id.toString();
  const messageId = cb.message.message_id;
  const data = cb.data;

  // del_place:NAME — delete a place from library
  const placeRowFromPayload = (payload: string): any =>
    /^\d+$/.test(payload)
      ? db.prepare('SELECT * FROM places WHERE id = ?').get(parseInt(payload, 10))
      : db.prepare('SELECT * FROM places WHERE short_name = ?').get(payload);
  if (data.startsWith('del_place:')) {
    const row = placeRowFromPayload(data.substring('del_place:'.length));
    const placeName = row ? row.short_name : data.substring('del_place:'.length);
    try { if (row) db.prepare('DELETE FROM places WHERE id = ?').run(row.id); } catch {}
    await tgEditMessage(telegramToken, chatId, messageId,
      `🗑 Місце <b>${placeName}</b> видалено з бібліотеки.`
    );
    await tgAnswer(telegramToken, cb.id, 'Видалено!');
    return;
  }

  // edit_place:NAME — edit place description
  if (data.startsWith('edit_place:')) {
    const row = placeRowFromPayload(data.substring('edit_place:'.length));
    const placeName = row ? row.short_name : data.substring('edit_place:'.length);
    pendingFollowUp.set(chatId, { type: 'place', name: placeName, eventId: 0 });
    await tgEditMessage(telegramToken, chatId, messageId,
      `📝 <b>Опиши "${placeName}":</b>\n\nНапиши або надиктуй опис місця.`
    );
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  // place_ok:NAME — user confirmed place is fine as-is
  // Button payloads carry the EVENT ID and the place name is read back from the row:
  // callback_data is capped at 64 bytes and «place_detail:Лені, Тотен-Ідрець парк:53» is
  // already over it. A legacy name-payload (messages sent before 2026-09-03) still works.
  const placeFromPayload = (payload: string): { name: string; eventId: number } => {
    if (/^\d+$/.test(payload)) {
      const ev = db.prepare('SELECT id, location FROM events WHERE id = ?').get(parseInt(payload, 10)) as any;
      return { name: ev ? String(ev.location || '').replace(/\s*\(.*\)$/, '') : '', eventId: ev ? ev.id : 0 };
    }
    const colonIdx = payload.lastIndexOf(':');
    const tail = colonIdx >= 0 ? payload.substring(colonIdx + 1) : '';
    if (colonIdx >= 0 && /^\d+$/.test(tail)) return { name: payload.substring(0, colonIdx), eventId: parseInt(tail, 10) };
    return { name: payload, eventId: 0 };
  };
  if (data.startsWith('place_ok:')) {
    const placeName = placeFromPayload(data.substring('place_ok:'.length)).name;
    if (!placeName) {
      await tgEditMessage(telegramToken, chatId, messageId, '⚠️ Подію вже не знайти — місце не збережено.');
      await tgAnswer(telegramToken, cb.id);
      return;
    }
    addPlace(placeName, '', '', '');
    await tgEditMessage(telegramToken, chatId, messageId,
      `📚 <b>Збережено місце:</b> ${placeName}`
    );
    await tgAnswer(telegramToken, cb.id, 'Збережено!');
    return;
  }

  // place_detail:NAME:EVENT_ID — user wants to add details for place
  if (data.startsWith('place_detail:')) {
    const { name: placeName, eventId } = placeFromPayload(data.substring('place_detail:'.length));
    if (!placeName) {
      await tgEditMessage(telegramToken, chatId, messageId, '⚠️ Подію вже не знайти. Скажи «виправ місце для <подія> на <місце>» — і я оновлю.');
      await tgAnswer(telegramToken, cb.id);
      return;
    }
    pendingFollowUp.set(chatId, { type: 'place', name: placeName, eventId });
    await tgEditMessage(telegramToken, chatId, messageId,
      `📝 <b>Опиши "${placeName}":</b>\n\n` +
      `Напиши або надиктуй коротко — наприклад:\n` +
      `<i>"басейн, Rådhusgata 28, Lena"</i>`
    );
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  // batch_delete:ID1,ID2,ID3 — delete multiple events
  if (data.startsWith('batch_delete:')) {
    const ids = data.split(':')[1].split(',').map(Number);
    const deleted: string[] = [];
    for (const id of ids) {
      const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(id) as any;
      if (event) {
        db.prepare('DELETE FROM events WHERE id = ?').run(id);
        deleted.push(`<s>${event.title} — ${event.member_name || 'Сім\'я'}</s>`);
      }
    }
    await tgEditMessage(telegramToken, chatId, messageId,
      `🗑 <b>Видалено ${deleted.length} ${deleted.length === 1 ? 'подію' : 'подій'}!</b>\n\n` + deleted.join('\n')
    );
    await tgAnswer(telegramToken, cb.id, 'Видалено!');
    return;
  }

  // confirm_delete:EVENT_ID — user confirmed deletion
  if (data.startsWith('confirm_delete:')) {
    const eventId = parseInt(data.split(':')[1], 10);
    const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(eventId) as any;

    if (event) {
      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
      await tgEditMessage(telegramToken, chatId, messageId,
        `🗑 <b>Подію видалено!</b>\n\n` +
        `<s>${event.title} — ${event.member_name || 'Сім\'я'}</s>`
      );
    } else {
      await tgEditMessage(telegramToken, chatId, messageId, '⚠️ Подію не знайдено (можливо вже видалена).');
    }
    await tgAnswer(telegramToken, cb.id, 'Видалено!');
    return;
  }

  // reschedule:EVENT_ID — user wants to reschedule
  if (data.startsWith('reschedule:')) {
    const eventId = parseInt(data.split(':')[1], 10);
    const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(eventId) as any;

    if (event) {
      // Show reschedule options
      const buttons = [
        [{ text: '➕ 1 день', callback_data: `move:${eventId}:1` }, { text: '➕ 2 дні', callback_data: `move:${eventId}:2` }, { text: '➕ 3 дні', callback_data: `move:${eventId}:3` }],
        [{ text: '➕ 1 тиждень', callback_data: `move:${eventId}:7` }, { text: '➖ 1 день', callback_data: `move:${eventId}:-1` }],
        [{ text: '❌ Скасувати', callback_data: `cancel:${eventId}` }],
      ];
      await tgEditMessage(telegramToken, chatId, messageId,
        `📅 <b>Перенести подію:</b>\n\n` +
        `📌 ${event.title} — ${event.member_name || 'Сім\'я'}\n` +
        `🕐 ${new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' })}\n\n` +
        `На скільки перенести?`,
        { inline_keyboard: buttons }
      );
    }
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  // move:EVENT_ID:DAYS — move event by N days
  if (data.startsWith('move:')) {
    const parts = data.split(':');
    const eventId = parseInt(parts[1], 10);
    const days = parseInt(parts[2], 10);
    const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(eventId) as any;

    if (event) {
      const newStart = new Date(event.start_time);
      newStart.setDate(newStart.getDate() + days);
      const newEnd = new Date(event.end_time);
      newEnd.setDate(newEnd.getDate() + days);

      db.prepare('UPDATE events SET start_time = ?, end_time = ? WHERE id = ?')
        .run(newStart.toISOString(), newEnd.toISOString(), eventId);

      const newDateStr = newStart.toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
      await tgEditMessage(telegramToken, chatId, messageId,
        `✅ <b>Подію перенесено!</b>\n\n` +
        `📌 ${event.title} — ${event.member_name || 'Сім\'я'}\n` +
        `🕐 Нова дата: ${newDateStr}`
      );
    }
    await tgAnswer(telegramToken, cb.id, 'Перенесено!');
    return;
  }

  // cancel:EVENT_ID — cancel action
  if (data.startsWith('cancel:')) {
    await tgEditMessage(telegramToken, chatId, messageId, '👌 Скасовано.');
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  // show_event:EVENT_ID — show event details with actions
  if (data.startsWith('show_event:')) {
    const eventId = parseInt(data.split(':')[1], 10);
    const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(eventId) as any;

    if (event) {
      const dateStr = new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'full', timeStyle: 'short' });
      const buttons = [
        [
          { text: '🗑 Видалити', callback_data: `ask_delete:${eventId}` },
          { text: '📅 Перенести', callback_data: `reschedule:${eventId}` },
        ],
        [{ text: '❌ Закрити', callback_data: `cancel:${eventId}` }],
      ];
      await tgEditMessage(telegramToken, chatId, messageId,
        `📋 <b>Подія:</b>\n\n` +
        `📌 ${event.title}\n` +
        `👤 ${event.member_name || 'Сім\'я'}\n` +
        `🕐 ${dateStr}\n` +
        `📍 ${event.location || 'Не вказано'}`,
        { inline_keyboard: buttons }
      );
    }
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  // ask_delete:EVENT_ID — confirmation before delete
  if (data.startsWith('ask_delete:')) {
    const eventId = parseInt(data.split(':')[1], 10);
    const event = db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(eventId) as any;

    if (event) {
      const dateStr = new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
      const buttons = [
        [
          { text: '✅ Так, видалити', callback_data: `confirm_delete:${eventId}` },
          { text: '📅 Краще перенести', callback_data: `reschedule:${eventId}` },
        ],
        [{ text: '❌ Скасувати', callback_data: `cancel:${eventId}` }],
      ];
      await tgEditMessage(telegramToken, chatId, messageId,
        `⚠️ <b>Дійсно видалити подію?</b>\n\n` +
        `📌 ${event.title} — ${event.member_name || 'Сім\'я'}\n` +
        `🕐 ${dateStr}`,
        { inline_keyboard: buttons }
      );
    }
    await tgAnswer(telegramToken, cb.id);
    return;
  }

  await tgAnswer(telegramToken, cb.id);
}

// ─── Message Handler ─────────────────────────────────────────

async function processMessage(update: any) {
  const telegramToken = getSetting('telegram_token');
  if (!telegramToken || !update.message) return;

  const chatId = update.message.chat.id.toString();
  const adminChatIds = (getSetting('admin_chat_ids') || '').split(',').map((id: string) => id.trim());

  const sendMessage = async (text: string, replyMarkup?: any) => {
    await tgSend(telegramToken, chatId, text, replyMarkup);
  };

  // Commands
  if (update.message.text === '/start') {
    await sendMessage(`👋 Привіт! Твій Chat ID: <b>${chatId}</b>\nДодай його в налаштуваннях адміністраторів.`);
    return;
  }

  if (update.message.text === '/help') {
    await sendMessage(
      `📅 <b>Berbeha Calendar Bot</b>\n\n` +
      `<b>Команди:</b>\n` +
      `/events - переглянути найближчі події\n` +
      `/next - наступний місяць\n` +
      `/prev - попередній місяць\n` +
      `/today - поточний місяць\n` +
      `/help - ця довідка\n\n` +
      `<b>Як додати подію:</b>\n` +
      `✏️ Текстом: <i>"Мирон плавання завтра о 16:00"</i>\n` +
      `🎤 Голосовим повідомленням\n` +
      `⭕ Відео-кружечком\n\n` +
      `<b>Видалити/перенести:</b>\n` +
      `Натисни /events → обери подію → видалити або перенести\n\n` +
      `AI розпізнає хто, що, коли і додасть в календар!`
    );
    return;
  }

  // List upcoming events
  if (update.message.text === '/events') {
    if (!adminChatIds.includes(chatId)) {
      await sendMessage('⛔ У вас немає прав.');
      return;
    }

    const now = new Date().toISOString();
    const upcomingEvents = db.prepare(
      `SELECT e.*, m.name as member_name FROM events e
       LEFT JOIN members m ON e.member_id = m.id
       WHERE e.start_time >= ?
       ORDER BY e.start_time ASC LIMIT 15`
    ).all(now) as any[];

    if (upcomingEvents.length === 0) {
      await sendMessage('📅 Немає запланованих подій.');
      return;
    }

    // Send each event as a separate message with action buttons
    await sendMessage(`📅 <b>Найближчі події (${upcomingEvents.length}):</b>`);

    for (const event of upcomingEvents) {
      const dateStr = new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
      const buttons = {
        inline_keyboard: [
          [
            { text: '🗑 Видалити', callback_data: `ask_delete:${event.id}` },
            { text: '📅 Перенести', callback_data: `reschedule:${event.id}` },
          ],
        ],
      };
      await sendMessage(
        `📌 <b>${event.title}</b>\n` +
        `👤 ${event.member_name || 'Сім\'я'} | 🕐 ${dateStr}` +
        (event.location ? ` | 📍 ${event.location}` : ''),
        buttons
      );
    }
    return;
  }

  if (update.message.text === '/next') {
    const currentOffset = parseInt(getSetting('month_offset') || '0', 10);
    setSetting('month_offset', (currentOffset + 1).toString());
    await sendMessage('📅 Календар перемкнуто на наступний місяць.');
    return;
  }

  if (update.message.text === '/prev') {
    const currentOffset = parseInt(getSetting('month_offset') || '0', 10);
    setSetting('month_offset', (currentOffset - 1).toString());
    await sendMessage('📅 Календар перемкнуто на попередній місяць.');
    return;
  }

  if (update.message.text === '/today') {
    setSetting('month_offset', '0');
    await sendMessage('📅 Календар перемкнуто на поточний місяць.');
    return;
  }

  // /places — show and manage places library
  if (update.message.text === '/places') {
    const places = getPlacesLibrary();
    if (places.length === 0) {
      await sendMessage('📚 Бібліотека місць порожня.');
    } else {
      const list = places.map((p, i) => {
        const desc = [p.description, p.address].filter(Boolean).join(', ');
        return `${i + 1}. <b>${p.short_name}</b>${desc ? ` — ${desc}` : ''}`;
      }).join('\n');
      const buttons = {
        inline_keyboard: places.map(p => ([
          { text: `🗑 ${p.short_name}`, callback_data: `del_place:${p.id}` },
          { text: `📝 ${p.short_name}`, callback_data: `edit_place:${p.id}` },
        ])),
      };
      await sendMessage(`📚 <b>Бібліотека місць (${places.length}):</b>\n\n${list}`, buttons);
    }
    return;
  }

  // Only admins can add events
  if (!adminChatIds.includes(chatId)) {
    await sendMessage('⛔ У вас немає прав для додавання подій.');
    return;
  }

  // Check for pending follow-up answers (e.g. "What is NAV?")
  const followUp = pendingFollowUp.get(chatId);
  if (followUp && (update.message.text || update.message.voice || update.message.video_note || update.message.audio) && !(update.message.text || '').startsWith('/')) {
    let answer = (update.message.text || '').trim();
    // If voice/audio answer — transcribe first
    if (!answer && (update.message.voice || update.message.video_note || update.message.audio)) {
      const fileId = (update.message.voice || update.message.video_note || update.message.audio).file_id;
      const mimeType = update.message.video_note ? 'video/mp4' : 'audio/ogg';
      try {
        const audioData = await downloadTelegramFile(telegramToken, fileId);
        if (!audioData) throw new Error('download failed');
        answer = await transcribeAudio(audioData, mimeType);
        console.log('🤖 Follow-up voice transcribed:', answer);
      } catch (err: any) {
        console.error('🤖 Follow-up transcription failed:', err.message);
        await sendMessage('⚠️ Не вдалося розпізнати аудіо. Напиши текстом.');
        return;
      }
    }
    if (!answer) { return; }
    pendingFollowUp.delete(chatId);

    if (followUp.type === 'place') {
      // Parse answer: try to extract description and address
      addPlace(followUp.name, '', '', answer);
      // Also update the event location if we have the event ID
      if (followUp.eventId) {
        const fullLocation = `${followUp.name} (${answer})`;
        db.prepare('UPDATE events SET location = ? WHERE id = ?').run(fullLocation, followUp.eventId);
      }
      await sendMessage(`📚 <b>Збережено місце:</b>\n📍 <b>${followUp.name}</b> — ${answer}\n\nНаступного разу використаю автоматично!`);
    } else if (followUp.type === 'event_type') {
      addEventType(followUp.name, answer);
      await sendMessage(`📚 <b>Збережено тип події:</b>\n📌 <b>${followUp.name}</b> — ${answer}`);
    }
    return;
  }

  // Process text, voice, or video note with Gemini AI
  let textToProcess = update.message.text;
  let audioBase64 = null;
  let mediaType = '';

  // Voice message (audio)
  if (update.message.voice) {
    mediaType = 'voice';
    const fileId = update.message.voice.file_id;
    audioBase64 = await downloadTelegramFile(telegramToken, fileId);
  }

  // Video note (circle video)
  if (update.message.video_note) {
    mediaType = 'video_note';
    const fileId = update.message.video_note.file_id;
    audioBase64 = await downloadTelegramFile(telegramToken, fileId);
  }

  // Audio file
  if (update.message.audio) {
    mediaType = 'audio';
    const fileId = update.message.audio.file_id;
    audioBase64 = await downloadTelegramFile(telegramToken, fileId);
  }

  if (!textToProcess && !audioBase64) return;

  try {
    const processingMsg = audioBase64
      ? '🎤 Розпізнаю голосове повідомлення...'
      : '🔄 Обробляю...';
    await sendMessage(processingMsg);

    const ai = new GoogleGenAI({ apiKey: getGeminiKey() });
    const members = db.prepare('SELECT id, name FROM members').all();
    const membersList = members.map((m: any) => `${m.id}: ${m.name}`).join(', ');

    // Get existing events for context (so AI can match "delete X for date Y")
    // Only include events within ±30 days for context (avoid huge prompt)
    const now30 = new Date();
    const past30 = new Date(now30.getTime() - 30 * 86400000).toISOString();
    const future30 = new Date(now30.getTime() + 30 * 86400000).toISOString();
    const existingEvents = db.prepare(
      `SELECT e.id, e.title, e.start_time, e.member_id, m.name as member_name
       FROM events e LEFT JOIN members m ON e.member_id = m.id
       WHERE e.start_time BETWEEN ? AND ?
       ORDER BY e.start_time ASC`
    ).all(past30, future30) as any[];
    const eventsContext = existingEvents.slice(0, 50).map((e: any) =>
      `[${e.id}] ${e.title} — ${e.member_name || 'Сім\'я'} — ${e.start_time}`
    ).join('\n');

    // Get places & event types library for context
    const placesLib = getPlacesLibrary();
    const eventTypesLib = getEventTypesLibrary();
    const placesContext = placesLib.length > 0
      ? placesLib.map(p => `"${p.short_name}" → ${[p.full_name, p.address, p.description].filter(Boolean).join(', ')}`).join('\n')
      : '';
    const eventTypesContext = eventTypesLib.length > 0
      ? eventTypesLib.map(e => `"${e.short_name}" → ${[e.full_name, e.default_location ? `місце: ${e.default_location}` : ''].filter(Boolean).join(', ')}, ${e.default_duration_min} хв`).join('\n')
      : '';

    const tzOff = osloOffset(new Date());
    const systemPrompt = `Парсер сімейного календаря. Зараз: ${osloIso(new Date())} (Осло). Timezone: ${tzOff} — усі часи в цьому зміщенні.
Сім'я: ${membersList}.
${eventsContext ? `Події:\n${eventsContext}\n` : ''}Відповідай JSON: {"transcription":"текст","actions":[{"action":"add","memberId":N,"title":"1-2 слова","startTime":"ISO8601${tzOff}","endTime":"ISO8601${tzOff}","location":"місце"}]}
Дії: add, delete(eventId), reschedule(eventId,newStartTime,newEndTime,location), query(memberId,period), restrict(memberId,title,days).
delete і reschedule ЗАВЖДИ вказують eventId зі списку «Події» (число в квадратних дужках). Якщо просять виправити час або місце існуючої події — це reschedule з eventId, а не add.
restrict: заборона/обмеження. Приклад: "Артему не можна плейстейшн 19 днів" → {"action":"restrict","memberId":N,"title":"плейстейшн","days":19}. Заборони НЕ є подіями!
Для кожної людини — окрема action з УСІМА полями. endTime = startTime + 1 година якщо не вказано.`;

    // ─── Step 1: If audio, transcribe first with a simple fast request ───
    let transcribedText = textToProcess;
    if (audioBase64) {
      console.log('🤖 Step 1: Transcribing audio...');
      const mimeType = mediaType === 'video_note' ? 'video/mp4' : 'audio/ogg';
      try {
        transcribedText = await transcribeAudio(audioBase64, mimeType);
        console.log('🤖 Transcribed:', transcribedText);
      } catch (trErr: any) {
        console.error('🤖 Transcription failed:', trErr.message);
        throw trErr;
      }
      if (!transcribedText) {
        await sendMessage('⚠️ Не вдалося розпізнати аудіо. Спробуй текстом.');
        return;
      }
    }

    // ─── Step 2: Parse text into calendar actions (no schema — faster) ───
    const parts: any[] = [{ text: 'Повідомлення від користувача: ' + transcribedText }];

    const geminiConfig = {
      model: getGeminiModel(),
      contents: { parts },
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json' as const,
      },
    };

    // Retry up to 2 times on timeout
    let response: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await Promise.race([
          ai.models.generateContent(geminiConfig),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout after 60s')), 60000)),
        ]);
        bumpLlmUsage('gemini');
        break;
      } catch (retryErr: any) {
        console.error(`🤖 Gemini attempt ${attempt + 1} failed:`, retryErr.message);
        if (attempt === 2) throw retryErr;
      }
    }

    const resultText = response.text;
    console.log('🤖 Gemini raw response length:', resultText?.length, 'chars');
    console.log('🤖 Gemini raw (first 500):', resultText?.substring(0, 500));
    if (resultText) {
      let parsed: any;
      try {
        parsed = JSON.parse(resultText);
      } catch (jsonErr) {
        // Try to salvage truncated JSON — extract transcription at minimum
        console.error('🤖 JSON parse failed, trying to salvage...');
        const transMatch = resultText.match(/"transcription"\s*:\s*"([^"]*?)"/);
        const transcription = transMatch ? transMatch[1] : '';
        if (transcription) {
          await sendMessage(`🎧 <b>Почув:</b> <i>${transcription}</i>\n\n⚠️ Помилка обробки. Спробуй ще раз коротше.`);
        } else {
          await sendMessage('⚠️ Помилка обробки відповіді AI. Спробуй ще раз.');
        }
        return;
      }
      let { actions, transcription } = parsed;
      // For audio: use the clean transcription from step 1
      if (audioBase64 && transcribedText) transcription = transcribedText;
      console.log('🤖 Gemini result:', JSON.stringify(parsed, null, 2));

      // ─── Pre-process: expand memberId arrays into separate actions ───
      if (actions && actions.length > 0) {
        const expanded: any[] = [];
        for (const act of actions) {
          if (Array.isArray(act.memberId)) {
            for (const mid of act.memberId) {
              expanded.push({ ...act, memberId: mid });
            }
          } else {
            expanded.push(act);
          }
        }
        actions = expanded;
      }

      // ─── Post-process: fix broken/split actions from Gemini ───
      if (actions && actions.length > 0) {
        const addActions = actions.filter((a: any) => a.action === 'add');
        if (addActions.length > 1) {
          // Find the most complete action (has the most fields)
          const bestAction = addActions.reduce((best: any, act: any) => {
            const score = (act.startTime ? 1 : 0) + (act.location ? 1 : 0) + (act.endTime ? 1 : 0) + (act.memberId ? 1 : 0) + (act.title ? 1 : 0);
            const bestScore = (best.startTime ? 1 : 0) + (best.location ? 1 : 0) + (best.endTime ? 1 : 0) + (best.memberId ? 1 : 0) + (best.title ? 1 : 0);
            return score > bestScore ? act : best;
          }, addActions[0]);

          // Check if actions are split: some have memberId but no startTime, others have startTime but no memberId
          const withMemberNoTime = addActions.filter((a: any) => a.memberId && !a.startTime);
          const withTimeNoMember = addActions.filter((a: any) => !a.memberId && a.startTime);

          if (withMemberNoTime.length > 0 && withTimeNoMember.length > 0) {
            // Merge: create complete actions for each member
            const mergedActions: any[] = [];
            for (const memberAct of withMemberNoTime) {
              mergedActions.push({
                action: 'add',
                memberId: memberAct.memberId,
                title: bestAction.title || memberAct.title,
                startTime: bestAction.startTime,
                endTime: bestAction.endTime,
                location: bestAction.location,
              });
            }
            // Replace add actions with merged ones, keep non-add actions
            const nonAddActions = actions.filter((a: any) => a.action !== 'add');
            actions = [...nonAddActions, ...mergedActions];
            console.log('🤖 Fixed split actions:', JSON.stringify(actions, null, 2));
          } else {
            // Fill missing fields from best action into incomplete actions
            for (const act of addActions) {
              if (!act.startTime && bestAction.startTime) act.startTime = bestAction.startTime;
              if (!act.endTime && bestAction.endTime) act.endTime = bestAction.endTime;
              if (!act.location && bestAction.location) act.location = bestAction.location;
              if (!act.memberId && bestAction.memberId) act.memberId = bestAction.memberId;
            }
          }
        }

        // Sanitize: fix Gemini thinking leak — extract fields from bloated title
        for (const act of actions) {
          if (act.title && act.title.length > 80) {
            // Gemini dumped thinking into title — try to extract startTime, endTime, location
            if (!act.startTime) {
              const timeMatch = act.title.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/);
              if (timeMatch) act.startTime = timeMatch[1];
            }
            if (!act.endTime && act.startTime) {
              const allTimes = act.title.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})/g);
              if (allTimes && allTimes.length >= 2) act.endTime = allTimes[1];
            }
            if (!act.location) {
              const locMatch = act.title.match(/(?:Місце|location)[:\s]+([A-Za-zÀ-žА-Яа-яіїєґ\s]+?)(?:\.|,|\n|$)/i);
              if (locMatch) act.location = locMatch[1].trim();
            }
          }
          // Always truncate long titles
          if (act.title && act.title.length > 50) {
            // Take first sentence fragment (before parenthesis, period, or comma with space)
            const clean = act.title.split(/[.(,]\s/)[0].trim();
            act.title = clean.length > 50 ? clean.substring(0, 47) + '...' : clean;
          }
          // Generate endTime if missing but startTime exists
          if (act.startTime && !act.endTime) {
            try {
              act.endTime = osloIso(new Date(new Date(act.startTime).getTime() + 3600_000));
            } catch {}
          }
        }
      }

      // If no actions but text looks like a schedule query, handle it directly
      const queryText = (transcription || textToProcess || '').toLowerCase();
      const isScheduleQuery = /розклад|які події|що заплановано|що буде|які плани|schedule|events|графік|покажи події|склади|всі події/.test(queryText);

      if ((!actions || actions.length === 0) && isScheduleQuery) {
        // Determine member from text
        const allMembers = db.prepare('SELECT id, name FROM members').all() as any[];
        let queryMemberId: number | null = null;
        for (const m of allMembers) {
          // Match by name or its forms (Єгор/Єгора, Гордій/Гордія, Тимур/Тимура)
          const nameLower = m.name.toLowerCase();
          const nameRoot = nameLower.replace(/[аіяюуо]$/, '');
          if (queryText.includes(nameLower) || (nameRoot.length >= 3 && queryText.includes(nameRoot))) {
            queryMemberId = m.id;
            break;
          }
        }

        // Determine period
        let start: Date, end: Date, periodLabel: string;
        const now = new Date();
        if (/завтра|tomorrow/.test(queryText)) {
          start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0,0,0,0);
          end = new Date(start); end.setHours(23,59,59,999);
          periodLabel = 'завтра';
        } else if (/наступн.*тижд|next.*week/.test(queryText)) {
          const dow = now.getDay() || 7;
          start = new Date(now); start.setDate(start.getDate() - dow + 8); start.setHours(0,0,0,0);
          end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23,59,59,999);
          periodLabel = 'наступний тиждень';
        } else if (/цей тижд|this.*week/.test(queryText)) {
          const dow = now.getDay() || 7;
          start = new Date(now); start.setDate(start.getDate() - dow + 1); start.setHours(0,0,0,0);
          end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23,59,59,999);
          periodLabel = 'цей тиждень';
        } else if (/місяць|month/.test(queryText)) {
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
          periodLabel = 'цей місяць';
        } else {
          // Try to extract "N днів/days" from text
          const daysMatch = queryText.match(/(\d+)\s*(?:днів|дні|день|days?)/);
          const numDays = daysMatch ? parseInt(daysMatch[1], 10) : 7;
          start = new Date(now); start.setHours(0,0,0,0);
          end = new Date(now); end.setDate(end.getDate() + numDays); end.setHours(23,59,59,999);
          periodLabel = `найближчі ${numDays} днів`;
        }

        // Fetch from DB
        const dbEvents = db.prepare(
          `SELECT e.*, m.name as member_name FROM events e
           LEFT JOIN members m ON e.member_id = m.id
           WHERE e.start_time >= ? AND e.start_time <= ?
           ${queryMemberId ? 'AND e.member_id = ?' : ''}
           ORDER BY e.start_time ASC`
        ).all(...(queryMemberId ? [start.toISOString(), end.toISOString(), queryMemberId] : [start.toISOString(), end.toISOString()])) as any[];

        // Also fetch Spond events
        let spondQueryEvents: any[] = [];
        try {
          const spondRes = await fetch(`http://localhost:3000/api/spond/events`);
          if (spondRes.ok) {
            const allSpond = await spondRes.json();
            spondQueryEvents = allSpond.filter((e: any) => {
              const t = new Date(e.start_time).getTime();
              return t >= start.getTime() && t <= end.getTime() &&
                (!queryMemberId || e.member_id === queryMemberId);
            });
          }
        } catch {}

        const allQueryEvents = [...dbEvents, ...spondQueryEvents].sort(
          (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
        );

        const memberName = queryMemberId
          ? (allMembers.find((m: any) => m.id === queryMemberId) as any)?.name || 'Учасник'
          : 'всіх';

        if (transcription) {
          await sendMessage(`🎧 <b>Почув:</b> <i>${transcription}</i>`);
        }

        if (allQueryEvents.length === 0) {
          await sendMessage(`📅 <b>Розклад — ${memberName} (${periodLabel}):</b>\n\nПодій немає 🎉`);
        } else {
          const eventLines = allQueryEvents.map((e: any) => {
            const d = new Date(e.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            const src = e._spond ? '⚽' : '✏️';
            const loc = e.location ? `\n     📍 ${e.location}` : '';
            return `${src} <b>${d}</b>\n     ${e.title}${loc}`;
          });
          await sendMessage(`📅 <b>Розклад — ${memberName} (${periodLabel}):</b>\n\n${eventLines.join('\n\n')}`);
        }
        return;
      }

      if (!actions || actions.length === 0) {
        const noResult = transcription
          ? `🤔 Не вдалося розпізнати дію.\n\n🎧 <b>Почув:</b> <i>${transcription}</i>\n\nСпробуй описати інакше.`
          : '🤔 Не вдалося розпізнати. Спробуй описати інакше.';
        await sendMessage(noResult);
        return;
      }

      // The parser is asked for an eventId, but a small model often answers a delete or a
      // reschedule with the TITLE it heard instead («Виправ Лена … на 17.30» came back as
      // {action:'reschedule', title:'Збори школа', memberId:5, startTime:…} and was silently
      // ignored). Resolve it here: same member (when named), the closest title, nearest date.
      const normT = (t: string) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const resolveEventId = (act: any): number | null => {
        if (act.eventId && existingEvents.some(e => e.id === act.eventId)) return act.eventId;
        const want = normT(act.title || act.eventTitle || act.name || '');
        if (!want) return null;
        const wantWords = want.split(' ').filter(w => w.length > 2);
        const scored = existingEvents
          .filter(e => !act.memberId || e.member_id === act.memberId)
          .map(e => {
            const have = normT(e.title);
            const hit = wantWords.filter(w => have.includes(w)).length;
            const haveWords = have.split(' ').filter(w => w.length > 2);
            const back = haveWords.filter(w => want.includes(w)).length;
            const score = Math.max(hit / Math.max(1, wantWords.length), back / Math.max(1, haveWords.length));
            const ref = act.date || act.startTime || act.newStartTime;
            const dist = ref ? Math.abs(new Date(e.start_time).getTime() - new Date(ref).getTime()) : Math.abs(new Date(e.start_time).getTime() - Date.now());
            return { id: e.id, score, dist };
          })
          .filter(x => x.score >= 0.5)
          .sort((a, b) => b.score - a.score || a.dist - b.dist);
        return scored[0]?.id ?? null;
      };
      for (const act of actions) {
        if ((act.action === 'delete' || act.action === 'reschedule') && !existingEvents.some(e => e.id === act.eventId)) {
          const found = resolveEventId(act);
          if (found) { console.log(`🤖 Resolved ${act.action} → event ${found} from title «${act.title || ''}»`); act.eventId = found; }
        }
        if (act.action === 'reschedule') {
          if (!act.newStartTime && act.startTime) act.newStartTime = act.startTime;
          if (!act.newEndTime && act.endTime) act.newEndTime = act.endTime;
        }
      }

      const lines: string[] = [];
      const deleteIds: number[] = [];
      const deleteEventLines: string[] = [];
      const unknownPlaces: { name: string; eventId: number }[] = [];

      // Show what was heard (transcription)
      if (transcription) {
        lines.push(`🎧 <b>Почув:</b> <i>${transcription}</i>`);
      }

      for (const act of actions) {
        if (act.action === 'add' && act.title && act.startTime) {
          // Check if location is in the library → use full info
          let location = act.location || '';
          if (location) {
            const knownPlace = findPlace(location);
            if (knownPlace && knownPlace.description) {
              location = `${knownPlace.short_name} (${[knownPlace.description, knownPlace.address].filter(Boolean).join(', ')})`;
            }
          }

          // Check if event type has a default location and none was specified
          if (!location) {
            const knownType = findEventType(act.title);
            if (knownType && knownType.default_location) {
              location = knownType.default_location;
            }
          }

          const result = db.prepare('INSERT INTO events (member_id, title, start_time, end_time, location) VALUES (?, ?, ?, ?, ?)')
            .run(act.memberId || null, act.title, act.startTime, act.endTime || act.startTime, location);
          const newEventId = result.lastInsertRowid as number;

          // Track unknown places for follow-up
          if (act.location && !findPlace(act.location)) {
            unknownPlaces.push({ name: act.location, eventId: newEventId });
          }

          // Auto-learn event type if not in library
          if (!findEventType(act.title)) {
            addEventType(act.title, '', location, 60);
          }

          const member = members.find((m: any) => m.id === act.memberId);
          const memberName = member ? (member as any).name : 'Сім\'я';
          const dateStr = new Date(act.startTime).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
          lines.push(`✅ <b>Додано:</b> ${act.title}\n👤 ${memberName}\n🕐 ${dateStr}${location ? `\n📍 ${location}` : '\n📍 <i>місце не вказано</i>'}`);
        }

        if (act.action === 'delete') {
          const event = act.eventId
            ? db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(act.eventId) as any
            : null;
          if (event) {
            deleteIds.push(event.id);
            const dateStr = new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
            deleteEventLines.push(`📌 ${event.title} — ${event.member_name || 'Сім\'я'} | 🕐 ${dateStr}`);
          } else {
            // Only hand-dictated events live in `events`. A training or a fixture comes from
            // Spond (or its Google mirror) and can only be removed THERE — say so instead of
            // a bare «не знайдено», which reads as a broken bot.
            const want = normT(act.title || '');
            const foreign = want ? (db.prepare(
              `SELECT title, start_time FROM ical_events WHERE start_time >= ? ORDER BY start_time ASC LIMIT 400`
            ).all(new Date(Date.now() - 86400000).toISOString()) as any[]).find(e => {
              const have = normT(e.title);
              return have.includes(want) || want.split(' ').filter(w => w.length > 2).every(w => have.includes(w));
            }) : null;
            if (foreign) {
              const dateStr = new Date(foreign.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
              lines.push(`⚠️ <b>${foreign.title}</b> (${dateStr}) прийшла зі Spond / Google-календаря — бот може видаляти лише події, надиктовані йому. Видали її у Spond або в Google Calendar, і вона зникне звідси за ~15 хв.`);
            } else {
              lines.push(`⚠️ Не знайшов серед надиктованих подій${act.title ? ` «${act.title}»` : act.eventId ? ` (ID ${act.eventId})` : ''}. Натисни /events, щоб побачити список.`);
            }
          }
        }

        if (act.action === 'reschedule') {
          const event = act.eventId
            ? db.prepare('SELECT e.*, m.name as member_name FROM events e LEFT JOIN members m ON e.member_id = m.id WHERE e.id = ?').get(act.eventId) as any
            : null;
          if (!event) {
            lines.push(`⚠️ Не знайшов серед надиктованих подій${act.title ? ` «${act.title}»` : ''}, щоб перенести. Натисни /events, щоб побачити список.`);
          } else if (act.newStartTime || act.location) {
            const newStart = act.newStartTime || event.start_time;
            let newEnd = act.newEndTime || (act.newStartTime ? osloIso(new Date(new Date(newStart).getTime() + Math.max(3600_000, new Date(event.end_time).getTime() - new Date(event.start_time).getTime()))) : event.end_time);
            if (new Date(newEnd).getTime() <= new Date(newStart).getTime()) newEnd = osloIso(new Date(new Date(newStart).getTime() + 3600_000));
            const newLoc = act.location || event.location;
            db.prepare('UPDATE events SET start_time = ?, end_time = ?, location = ? WHERE id = ?')
              .run(newStart, newEnd, newLoc, event.id);

            const oldDate = new Date(event.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
            const newDate = new Date(newStart).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium', timeStyle: 'short' });
            const timeLine = newStart !== event.start_time ? `\n<s>${oldDate}</s> → ${newDate}` : `\n🕐 ${oldDate}`;
            const locLine = act.location && act.location !== event.location ? `\n📍 <s>${event.location || '—'}</s> → ${newLoc}` : '';
            lines.push(`📅 <b>${newStart !== event.start_time ? 'Перенесено' : 'Виправлено'}:</b> ${event.title} — ${event.member_name || 'Сім\'я'}${timeLine}${locLine}`);
          } else {
            lines.push(`⚠️ Для «${event.title}» не почув нового часу чи місця.`);
          }
        }

        // Restriction/ban
        if (act.action === 'restrict' && act.title && act.days) {
          const days = parseInt(act.days, 10) || 7;
          const now = new Date();
          const startDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' }); // YYYY-MM-DD
          const endDateObj = new Date(now);
          endDateObj.setDate(endDateObj.getDate() + days - 1);
          const endDate = endDateObj.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
          const endDateUk = endDateObj.toLocaleDateString('uk-UA', { timeZone: 'Europe/Oslo', dateStyle: 'medium' });

          db.prepare('INSERT INTO restrictions (member_id, title, start_date, end_date) VALUES (?, ?, ?, ?)')
            .run(act.memberId, act.title, startDate, endDate);

          const member = members.find((m: any) => m.id === act.memberId);
          const memberName = member ? (member as any).name : 'Сім\'я';
          lines.push(`🚫 <b>Заборона:</b> ${act.title}\n👤 ${memberName}\n📅 ${days} днів (до ${endDateUk})`);
        }

        // Schedule query — flexible period parsing
        if (act.action === 'query') {
          const now = new Date();
          let start: Date, end: Date, periodLabel: string;
          const rawPeriod = act.period;
          const p = (typeof rawPeriod === 'object' && rawPeriod !== null
            ? (rawPeriod.type || rawPeriod.value || JSON.stringify(rawPeriod))
            : String(rawPeriod || '')).toLowerCase();

          if (/today|сьогодні|сегодня/.test(p)) {
            start = new Date(now); start.setHours(0,0,0,0);
            end = new Date(now); end.setHours(23,59,59,999);
            periodLabel = 'сьогодні';
          } else if (/tomorrow|завтра/.test(p)) {
            start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0,0,0,0);
            end = new Date(start); end.setHours(23,59,59,999);
            periodLabel = 'завтра';
          } else if (/this.?week|цей.?тижд|поточн.?тижд/.test(p)) {
            const dow = now.getDay() || 7;
            start = new Date(now); start.setDate(start.getDate() - dow + 1); start.setHours(0,0,0,0);
            end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23,59,59,999);
            periodLabel = 'цей тиждень';
          } else if (/next.?week|наступн.?тижд|следующ.?недел/.test(p)) {
            const dow = now.getDay() || 7;
            start = new Date(now); start.setDate(start.getDate() - dow + 8); start.setHours(0,0,0,0);
            end = new Date(start); end.setDate(end.getDate() + 6); end.setHours(23,59,59,999);
            periodLabel = 'наступний тиждень';
          } else if (/this.?month|цей.?місяць|поточн.?місяць/.test(p)) {
            start = new Date(now.getFullYear(), now.getMonth(), 1);
            end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            periodLabel = 'цей місяць';
          } else if (/next.?month|наступн.?місяць|следующ.?месяц/.test(p)) {
            start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            end = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
            periodLabel = 'наступний місяць';
          } else {
            // Try to extract number: "10 days", "2 weeks", "3 тижні", "20 днів"
            const numMatch = p.match(/(\d+)/);
            if (numMatch) {
              const num = parseInt(numMatch[1], 10);
              if (/week|тижд|недел/.test(p)) {
                start = new Date(now); start.setHours(0,0,0,0);
                end = new Date(now); end.setDate(end.getDate() + num * 7); end.setHours(23,59,59,999);
                periodLabel = `найближчі ${num} тижн.`;
              } else if (/month|місяц/.test(p)) {
                start = new Date(now); start.setHours(0,0,0,0);
                end = new Date(now.getFullYear(), now.getMonth() + num, now.getDate(), 23, 59, 59, 999);
                periodLabel = `найближчі ${num} міс.`;
              } else {
                // Default: treat number as days
                start = new Date(now); start.setHours(0,0,0,0);
                end = new Date(now); end.setDate(end.getDate() + num); end.setHours(23,59,59,999);
                periodLabel = `найближчі ${num} днів`;
              }
            } else {
              // Fallback: next 7 days
              start = new Date(now); start.setHours(0,0,0,0);
              end = new Date(now); end.setDate(end.getDate() + 7); end.setHours(23,59,59,999);
              periodLabel = 'найближчі 7 днів';
            }
          }

          // Fetch from DB
          const dbEvents = db.prepare(
            `SELECT e.*, m.name as member_name FROM events e
             LEFT JOIN members m ON e.member_id = m.id
             WHERE e.start_time >= ? AND e.start_time <= ?
             ${act.memberId ? 'AND e.member_id = ?' : ''}
             ORDER BY e.start_time ASC`
          ).all(...(act.memberId ? [start.toISOString(), end.toISOString(), act.memberId] : [start.toISOString(), end.toISOString()])) as any[];

          // Also fetch Spond events for this period
          let spondEventsForQuery: any[] = [];
          try {
            const spondRes = await fetch(`http://localhost:3000/api/spond/events`);
            if (spondRes.ok) {
              const allSpond = await spondRes.json();
              spondEventsForQuery = allSpond.filter((e: any) => {
                const t = new Date(e.start_time).getTime();
                return t >= start.getTime() && t <= end.getTime() &&
                  (!act.memberId || e.member_id === act.memberId);
              });
            }
          } catch {}

          const allQueryEvents = [...dbEvents, ...spondEventsForQuery].sort(
            (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
          );

          const memberName = act.memberId
            ? (members.find((m: any) => m.id === act.memberId) as any)?.name || 'Учасник'
            : 'Всіх';

          if (allQueryEvents.length === 0) {
            lines.push(`📅 <b>Розклад ${memberName} (${periodLabel}):</b>\n\nПодій немає 🎉`);
          } else {
            const eventLines = allQueryEvents.map((e: any) => {
              const d = new Date(e.start_time).toLocaleString('uk-UA', { timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
              const src = e._spond ? '⚽' : '✏️';
              const loc = e.location ? ` 📍 ${e.location}` : '';
              const who = e.member_name || memberName;
              return `${src} <b>${d}</b> — ${e.title} (${who})${loc}`;
            });
            lines.push(`📅 <b>Розклад ${memberName} (${periodLabel}):</b>\n\n${eventLines.join('\n')}`);
          }
        }
      }

      // Batch delete confirmation
      if (deleteIds.length > 0) {
        const idsStr = deleteIds.join(',');
        const buttons = {
          inline_keyboard: [
            [
              { text: `✅ Так, видалити (${deleteIds.length})`, callback_data: `batch_delete:${idsStr}` },
            ],
            [
              { text: '❌ Скасувати', callback_data: `cancel:0` },
            ],
          ],
        };
        await sendMessage(
          `⚠️ <b>Видалити ${deleteIds.length === 1 ? 'подію' : deleteIds.length + ' подій'}?</b>\n\n` +
          deleteEventLines.join('\n'),
          buttons
        );
      }

      if (lines.length > 0) {
        await sendMessage(lines.join('\n\n'));
      }

      // Ask about unknown places with confirmation buttons
      if (unknownPlaces.length > 0) {
        // Deduplicate by name
        const uniquePlaces = [...new Map(unknownPlaces.map(p => [p.name, p])).values()];
        for (const unknown of uniquePlaces) {
          const buttons = {
            inline_keyboard: [
              [
                { text: `✅ Так, "${unknown.name}" — ок`, callback_data: `place_ok:${unknown.eventId}` },
              ],
              [
                { text: '📝 Уточнити деталі', callback_data: `place_detail:${unknown.eventId}` },
              ],
            ],
          };
          await sendMessage(
            `📍 Нове місце: <b>${unknown.name}</b>\nЗберегти як є?`,
            buttons
          );
        }
      }
    }
  } catch (error) {
    console.error('Gemini error:', error);
    await sendMessage(llmFailureReason(error) || '❌ Помилка обробки. Спробуй ще раз.');
  }
}

// Polling loop
let lastUpdateId = 0;
let lastPollErrorLog = 0;

async function pollTelegram() {
  const token = getSetting('telegram_token');
  if (!token) return;

  try {
    // `allowed_updates` is REMEMBERED by Telegram per bot (whatever the last consumer asked
    // for stays in force). On 2026-09-03 the bot's stored list was message/channel_post/
    // my_chat_member/chat_member/chat_join_request — no `callback_query` — so every tap on
    // «✅ Так, видалити» was dropped by Telegram before it ever reached this loop, and the
    // three «Зустріч з татом» rows the owner deleted on 26.08 were still in the table.
    // Ask for exactly what this bot handles on every call, so no other tool can starve it.
    const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=3&allowed_updates=${allowed}`);
    const data = await res.json();

    if (!data.ok) {
      // 409 = another process is polling with the same token; before, this was swallowed.
      const now = Date.now();
      if (now - lastPollErrorLog > 5 * 60_000) {
        lastPollErrorLog = now;
        console.error(`🤖 Telegram getUpdates refused: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
      }
      return;
    }

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        try {
          if (update.callback_query) {
            await processCallbackQuery(update);
          } else {
            await processMessage(update);
          }
        } catch (err) {
          console.error('Error processing update:', err);
        }
      }
    }
  } catch (err) {
    // Silent fail - will retry on next poll
  }
}

function startPolling() {
  const token = getSetting('telegram_token');
  if (!token) {
    console.log('⚠️  No Telegram token — bot polling disabled');
    return;
  }
  console.log('🤖 Telegram bot polling started');

  // Remove webhook once at startup
  fetch(`https://api.telegram.org/bot${token}/deleteWebhook`).catch(() => {});

  const poll = async () => {
    await pollTelegram();
    setTimeout(poll, 2000); // Poll every 2 seconds
  };
  poll();
}

// ─── Server Start ────────────────────────────────────────────

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api/')) {
        res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
      }
    });
  }

  autoSetup();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📅 Open in browser to see the calendar\n`);
    startPolling();
  });
}

startServer();
