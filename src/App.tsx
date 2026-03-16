import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { format, eachDayOfInterval, isSameDay, addDays, setHours, setMinutes, isWeekend, getYear, differenceInCalendarDays, getISOWeek, getDay } from 'date-fns';
import { uk } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Settings, Users, X, Trash2, LogOut, Calendar, CalendarDays } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// ─── Types ───────────────────────────────────────────────────

type GoogleUser = {
  email: string;
  name: string;
  picture: string;
  sub: string;
  accessToken?: string;
};

type Member = {
  id: number;
  name: string;
  role: string;
  avatar_url: string;
  color: string;
};

type CalendarEvent = {
  id: number;
  member_id: number;
  title: string;
  start_time: string;
  end_time: string;
  location: string;
  spond_group_id?: string;
  spond_group_name?: string;
  _spond?: boolean;
};

type Holiday = {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
};

type MemberPhoto = {
  id: number;
  member_id: number;
  photo_url: string;
};

// Keyword rule for matching Spond/Google Calendar events to family members
type GcalKeywordRule = {
  keyword: string;      // e.g. "тур ідр гр 2", "плавання гр 3"
  member_id: number;    // which family member this maps to
  label?: string;       // optional friendly label, e.g. "Гімнастика Тимура"
};

// Spond child (auto-detected from guardians) → family member mapping
type SpondChild = {
  profileId: string;
  firstName: string;
  lastName: string;
  groups: { id: string; name: string }[];
};

type SpondChildMapping = {
  profileId: string;     // Spond profile ID (unique per person)
  childName: string;     // "Timur Berbeha" for display
  member_id: number;     // family member ID
};

type SpondGroupMapping = {
  groupId: string;
  groupName: string;
  member_id: number;
};

// ─── Photo Slideshow Component ───────────────────────────────

// Simple crossfade transition — no overlapping artifacts
const TRANSITIONS = [
  { name: 'fade', enter: 'opacity-100', exit: 'opacity-0', style: {} },
] as const;

// Each slideshow instance gets its own random interval and transition
function useStableRandom(seed: string) {
  return useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) { h = ((h << 5) - h + seed.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }, [seed]);
}

function PhotoSlideshow({ photos, fallbackUrl, color, name, mode = 'circle' }: {
  photos: string[];
  fallbackUrl: string;
  color: string;
  name?: string;
  mode?: 'circle' | 'cell' | 'avatar';
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const [prevIndex, setPrevIndex] = useState(0);

  // Stable random based on name — each member gets unique interval + transition
  const hash = useStableRandom(name || fallbackUrl);
  const transition = TRANSITIONS[hash % TRANSITIONS.length];
  const intervalMs = 4000 + (hash % 7) * 1000; // 4s to 10s — all different
  const initialDelay = (hash % 3) * 1500; // 0, 1.5s, or 3s offset

  useEffect(() => {
    if (photos.length <= 1) return;
    const timeout = setTimeout(() => {
      const interval = setInterval(() => {
        setTransitioning(true);
        setTimeout(() => {
          setPrevIndex(prev => prev); // keep reference
          setCurrentIndex(prev => {
            setPrevIndex(prev);
            return (prev + 1) % photos.length;
          });
          setTimeout(() => setTransitioning(false), 50);
        }, 600);
      }, intervalMs);
      return () => clearInterval(interval);
    }, initialDelay);
    return () => clearTimeout(timeout);
  }, [photos.length, intervalMs, initialDelay]);

  const currentSrc = photos.length > 0 ? photos[currentIndex] : fallbackUrl;
  const prevSrc = photos.length > 0 ? photos[prevIndex] : fallbackUrl;

  // Cell mode — fills the entire header cell with photo, square aspect ratio
  if (mode === 'cell') {
    return (
      <div className="relative w-full overflow-hidden" style={{ backgroundColor: `${color}20`, aspectRatio: '1/1' }}>
        <img
          src={currentSrc}
          alt={name || ''}
          className="absolute inset-0 w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
        {/* Name overlay at bottom */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-1 py-0.5 md:py-1 z-10">
          <span className="text-[8px] md:text-[11px] font-bold text-white drop-shadow-sm truncate block text-center">
            {name}
          </span>
        </div>
        {/* Photo counter */}
        {photos.length > 1 && (
          <span className="absolute top-0.5 right-0.5 text-[7px] bg-black/40 text-white px-1 rounded-full z-10">
            {currentIndex + 1}/{photos.length}
          </span>
        )}
      </div>
    );
  }

  // Avatar mode — for MembersTab (large circle)
  if (mode === 'avatar') {
    return (
      <div className="relative w-24 h-24 rounded-full overflow-hidden bg-white" style={{ borderColor: color, borderWidth: 2 }}>
        <img
          src={currentSrc}
          alt=""
          className="absolute inset-0 w-full h-full rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      </div>
    );
  }

  // Circle mode — small fallback
  return (
    <img
      src={currentSrc}
      alt=""
      className="w-5 h-5 md:w-6 md:h-6 rounded-full object-cover bg-white"
      style={{ borderColor: color, borderWidth: 2 }}
      referrerPolicy="no-referrer"
    />
  );
}

// ─── Next Event Countdown Overlay ────────────────────────────

function NextEventCountdown({ events }: { events: CalendarEvent[] }) {
  const [now, setNow] = useState(() => Date.now());

  // Check if any event is within 15 min for faster updates
  const hasUrgent = events.some(e => {
    const t = new Date(e.start_time).getTime();
    return t > now && t - now < 15 * 60 * 1000;
  });

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), hasUrgent ? 1000 : 10000);
    return () => clearInterval(interval);
  }, [hasUrgent]);

  const nextEvent = useMemo(() => {
    return events
      .filter(e => new Date(e.start_time).getTime() > now)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())[0] || null;
  }, [events, now]);

  if (!nextEvent) return null;

  const remaining = new Date(nextEvent.start_time).getTime() - now;
  const isUrgent = remaining < 15 * 60 * 1000;
  const totalMin = Math.floor(remaining / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const timeStr = days > 0 ? `${days} дн ${hours} год` : hours > 0 ? `${hours} год ${mins} хв` : `${mins} хв`;

  const shortLoc = nextEvent.location ? nextEvent.location.split(',')[0].trim() : '';
  const locPart = shortLoc ? ` в ${shortLoc}` : '';

  if (isUrgent) {
    return (
      <>
        <div className="absolute inset-0 ring-[6px] ring-red-500 z-30 pointer-events-none animate-pulse" />
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-red-600/90 p-1">
          <div className="text-[14px] md:text-[22px] font-black text-white leading-tight text-center break-words">
            До {nextEvent.title}{locPart}
          </div>
          <div className="text-[11px] md:text-[18px] font-bold text-yellow-300 leading-tight text-center animate-pulse mt-0.5">
            залишилося: {timeStr}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="absolute bottom-4 md:bottom-6 inset-x-0 z-20 bg-black/60 backdrop-blur-[2px] px-0.5 py-px">
      <div className="text-[6px] md:text-[9px] font-semibold text-white/90 leading-tight truncate text-center">
        До {nextEvent.title}{locPart}
      </div>
      <div className="text-[5px] md:text-[8px] text-amber-300/90 leading-tight text-center font-medium">
        залишилося: {timeStr}
      </div>
    </div>
  );
}

// ─── Google Photos Picker (new Picker API) ──────────────────

function useGooglePhotosPicker(accessToken: string, onPhotosSelected: (urls: string[]) => void) {
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const cbRef = useRef(onPhotosSelected);
  cbRef.current = onPhotosSelected;
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const sessionRef = useRef<string | null>(null);

  const fetchItems = useCallback(async (sid: string): Promise<string[]> => {
    const token = tokenRef.current;
    const itemsRes = await fetch(`/api/google-photos/media-items?sessionId=${sid}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const itemsData = await itemsRes.json();
    console.log('📸 Picker items:', itemsData);
    const items = itemsData.mediaItems || [];
    return items
      .filter((item: any) => item.mediaFile?.baseUrl)
      .map((item: any) => `${item.mediaFile.baseUrl}=w800-h800`);
  }, []);

  // Manual "I selected photos" button handler
  const confirmSelection = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    setStatus('Завантаження фото на сервер...');
    try {
      const urls = await fetchItems(sid);
      console.log('📸 Manual confirm: got', urls.length, 'urls');
      // Cleanup session
      fetch(`/api/google-photos/session/${sid}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${tokenRef.current}` },
      });
      if (urls.length > 0) {
        cbRef.current(urls);
        setStatus(`Збережено ${urls.length} фото!`);
      } else {
        setStatus('Фото не знайдено — спробуйте ще раз');
      }
    } catch (err) {
      console.error('📸 Confirm error:', err);
      setStatus('Помилка завантаження');
    }
    setPicking(false);
    setSessionId(null);
    sessionRef.current = null;
  }, [fetchItems]);

  const cancelPicking = useCallback(() => {
    const sid = sessionRef.current;
    if (sid) {
      fetch(`/api/google-photos/session/${sid}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${tokenRef.current}` },
      });
    }
    setPicking(false);
    setSessionId(null);
    sessionRef.current = null;
    setStatus('');
  }, []);

  const startPicking = useCallback(() => {
    if (!tokenRef.current || picking) return;

    // Open popup SYNCHRONOUSLY in the click handler to avoid popup blockers
    const pickerWindow = window.open('about:blank', 'google-photos-picker', 'width=900,height=700');
    if (!pickerWindow) {
      alert('Popup заблоковано! Дозвольте popup-вікна для цього сайту.');
      return;
    }
    pickerWindow.document.title = 'Google Photos';
    pickerWindow.document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:18px;color:#666">Завантаження Google Photos...</div>';

    setPicking(true);
    setStatus('Створення сесії...');

    (async () => {
      try {
        const token = tokenRef.current;
        const sessionRes = await fetch('/api/google-photos/session', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const session = await sessionRes.json();
        if (session.error) {
          setStatus(`Помилка: ${session.error.message || JSON.stringify(session.error)}`);
          setPicking(false);
          pickerWindow.close();
          return;
        }

        setSessionId(session.id);
        sessionRef.current = session.id;
        pickerWindow.location.href = session.pickerUri;
        setStatus('Виберіть фото і натисніть "Готово" нижче');

        const pollMs = 3000;
        let polls = 0;

        const poll = async (): Promise<void> => {
          polls++;
          if (polls > 120 || !sessionRef.current) { return; }

          try {
            const res = await fetch(`/api/google-photos/session/${session.id}`, {
              headers: { 'Authorization': `Bearer ${token}` },
            });
            const s = await res.json();

            if (s.mediaItemsSet) {
              // Auto-detected selection!
              setStatus('Завантаження фото на сервер...');
              const urls = await fetchItems(session.id);
              fetch(`/api/google-photos/session/${session.id}`, {
                method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
              });
              try { pickerWindow.close(); } catch {}
              if (urls.length > 0) {
                cbRef.current(urls);
                setStatus(`Збережено ${urls.length} фото!`);
              } else {
                setStatus('Фото не обрано');
              }
              setPicking(false);
              setSessionId(null);
              sessionRef.current = null;
              return;
            }
          } catch { /* continue */ }

          setTimeout(poll, pollMs);
        };

        setTimeout(poll, pollMs);
      } catch (err) {
        console.error('Picker error:', err);
        setStatus('Помилка');
        setPicking(false);
        try { pickerWindow.close(); } catch {}
      }
    })();
  }, [picking, fetchItems]);

  return { startPicking, picking, status, confirmSelection, cancelPicking, hasSession: !!sessionId };
}

// ─── Constants ───────────────────────────────────────────────

const DEFAULT_MEMBERS: Member[] = [
  { id: 1, name: 'Папа', role: 'parent', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Dad', color: '#3b82f6' },
  { id: 2, name: 'Мама', role: 'parent', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Mom', color: '#ec4899' },
  { id: 3, name: 'Мирон', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Miron', color: '#10b981' },
  { id: 4, name: 'Дитина 2', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child2', color: '#f59e0b' },
  { id: 5, name: 'Дитина 3', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child3', color: '#8b5cf6' },
  { id: 6, name: 'Дитина 4', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child4', color: '#ef4444' },
  { id: 7, name: 'Дитина 5', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child5', color: '#06b6d4' },
];

// ─── Storage helpers ─────────────────────────────────────────

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, data: unknown) {
  localStorage.setItem(key, JSON.stringify(data));
}

async function tryApi<T>(url: string, options?: RequestInit): Promise<{ ok: boolean; data?: T }> {
  try {
    const res = await fetch(url, options);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch { /* API not available */ }
  return { ok: false };
}

// ─── Google Auth helpers ─────────────────────────────────────

function decodeJwtPayload(token: string): GoogleUser | null {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const GOOGLE_CLIENT_ID = '206519724770-in8hq6217oat2ajng11s665f9fcjej88.apps.googleusercontent.com';

function getGoogleClientId(): string {
  return GOOGLE_CLIENT_ID || loadFromStorage<string>('calendar_google_client_id', '');
}

// ─── Google global types ─────────────────────────────────────

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: any) => void;
          renderButton: (el: HTMLElement, config: any) => void;
          prompt: () => void;
          revoke: (email: string, cb: () => void) => void;
          disableAutoSelect: () => void;
        };
        oauth2: {
          initTokenClient: (config: any) => { requestAccessToken: (overrides?: any) => void };
        };
      };
    };
  }
}

// ─── Login Page ──────────────────────────────────────────────

function LoginPage({ onLogin }: { onLogin: (user: GoogleUser) => void }) {
  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [clientId, setClientId] = useState(() => getGoogleClientId());
  const [showSetup, setShowSetup] = useState(!clientId);
  const [gsiReady, setGsiReady] = useState(false);

  useEffect(() => {
    const check = () => {
      if (window.google?.accounts?.id) {
        setGsiReady(true);
        return true;
      }
      return false;
    };
    if (check()) return;
    const interval = setInterval(() => { if (check()) clearInterval(interval); }, 200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!gsiReady || !clientId || !googleBtnRef.current) return;

    window.google!.accounts.id.initialize({
      client_id: clientId,
      callback: (response: { credential: string }) => {
        const user = decodeJwtPayload(response.credential);
        if (user) {
          saveToStorage('calendar_user', user);
          onLogin(user);
        }
      },
    });

    window.google!.accounts.id.renderButton(googleBtnRef.current, {
      theme: 'outline',
      size: 'large',
      shape: 'rectangular',
      text: 'signin_with',
      locale: 'uk',
      width: 300,
    });
  }, [gsiReady, clientId, onLogin]);

  const saveClientId = () => {
    if (clientId.trim()) {
      saveToStorage('calendar_google_client_id', clientId.trim());
      setShowSetup(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-pink-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-indigo-100 rounded-2xl mb-4">
            <Calendar className="w-10 h-10 text-indigo-600" />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Berbeha Calendar</h1>
          <p className="text-slate-500">Сімейний календар з Telegram ботом</p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          {showSetup || !clientId ? (
            <div className="space-y-4">
              <h2 className="text-lg font-semibold text-slate-800 text-center">Налаштування Google Sign-In</h2>
              <p className="text-sm text-slate-500 text-center">
                Введіть Google OAuth Client ID для авторизації
              </p>
              <input
                type="text"
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                className="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none text-sm"
                placeholder="xxxxxxx.apps.googleusercontent.com"
              />
              <button
                onClick={saveClientId}
                disabled={!clientId.trim()}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-xl transition-colors disabled:opacity-50"
              >
                Зберегти та продовжити
              </button>
              <div className="pt-4 border-t border-slate-100">
                <details className="text-sm text-slate-500">
                  <summary className="cursor-pointer font-medium text-slate-600 hover:text-slate-800">Як отримати Client ID?</summary>
                  <ol className="mt-3 space-y-2 list-decimal list-inside text-xs leading-relaxed">
                    <li>Перейдіть до <strong>Google Cloud Console</strong> &rarr; APIs & Services &rarr; Credentials</li>
                    <li>Створіть <strong>OAuth 2.0 Client ID</strong> (тип: Web application)</li>
                    <li>В <strong>Authorized JavaScript origins</strong> додайте:<br/>
                      <code className="bg-slate-100 px-1.5 py-0.5 rounded text-indigo-600">https://berbeha-calendar.netlify.app</code><br/>
                      <code className="bg-slate-100 px-1.5 py-0.5 rounded text-indigo-600">http://localhost:3000</code>
                    </li>
                    <li>Скопіюйте <strong>Client ID</strong> та вставте вище</li>
                  </ol>
                </details>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <h2 className="text-lg font-semibold text-slate-800 text-center">Увійти в календар</h2>

              <div className="flex justify-center">
                <div ref={googleBtnRef} />
              </div>

              {!gsiReady && (
                <p className="text-sm text-slate-400 text-center">Завантаження Google Sign-In...</p>
              )}

              <div className="text-center">
                <button
                  onClick={() => setShowSetup(true)}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                >
                  Змінити Client ID
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-slate-400 mt-6">
          Berbeha Family Calendar &copy; 2026
        </p>
      </div>
    </div>
  );
}

// ─── Main App (after auth) ───────────────────────────────────

// Helper: request Google access token for Photos + Calendar
function requestGoogleToken(onToken: (token: string) => void) {
  const clientId = getGoogleClientId();
  if (!clientId || !window.google?.accounts?.oauth2) return;

  const tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly https://www.googleapis.com/auth/calendar.readonly',
    callback: (response: { access_token?: string; error?: string }) => {
      if (response.access_token) {
        saveToStorage('calendar_google_token', response.access_token);
        onToken(response.access_token);
      }
    },
  });
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

// ─── Admin PIN protection ────────────────────────────────────
const ADMIN_PIN = '1234';

function PinModal({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = () => {
    if (pin === ADMIN_PIN) {
      saveToStorage('calendar_admin_until', Date.now() + 30 * 60 * 1000); // 30 min session
      onSuccess();
    } else {
      setError(true);
      setPin('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl p-6 w-80">
        <h3 className="text-lg font-bold text-slate-800 mb-2 text-center">Введіть PIN</h3>
        <p className="text-sm text-slate-500 mb-4 text-center">Для редагування потрібен пароль</p>
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          maxLength={8}
          value={pin}
          onChange={e => { setPin(e.target.value); setError(false); }}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          className={`w-full text-center text-2xl tracking-[0.5em] border-2 rounded-xl px-4 py-3 mb-3 outline-none ${error ? 'border-red-400 bg-red-50' : 'border-slate-200 focus:border-indigo-400'}`}
          placeholder="****"
        />
        {error && <p className="text-red-500 text-sm text-center mb-3">Невірний PIN</p>}
        <div className="flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-sm font-medium">Скасувати</button>
          <button onClick={handleSubmit} className="flex-1 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 text-sm font-medium">Увійти</button>
        </div>
      </div>
    </div>
  );
}

function isAdminSession(): boolean {
  const until = loadFromStorage<number>('calendar_admin_until', 0);
  return Date.now() < until;
}

export default function App() {
  const [user, setUser] = useState<GoogleUser | null>(() => loadFromStorage<GoogleUser | null>('calendar_user', null));
  const [googleToken, setGoogleToken] = useState(() => loadFromStorage<string>('calendar_google_token', ''));
  const [members, setMembers] = useState<Member[]>(() => loadFromStorage('calendar_members', DEFAULT_MEMBERS));
  const [events, setEvents] = useState<CalendarEvent[]>(() => loadFromStorage('calendar_events', []));
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [activeTab, setActiveTab] = useState<'calendar' | 'settings' | 'members' | 'events'>('calendar');
  const [monthOffset, setMonthOffset] = useState(() => loadFromStorage('calendar_month_offset', 0));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [useApi, setUseApi] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isAdmin, setIsAdmin] = useState(() => isAdminSession());
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingTab, setPendingTab] = useState<'settings' | 'members' | 'events' | null>(null);

  // ── Default guest user if not logged in (calendar works without Google) ──
  const effectiveUser: GoogleUser = user || { name: 'Бербеха', email: '', picture: '' };

  // ── Tab switch with PIN protection for admin tabs ──
  const handleTabChange = (tab: 'calendar' | 'settings' | 'members' | 'events') => {
    if (tab === 'calendar') {
      setActiveTab(tab);
      return;
    }
    // Admin tabs require PIN
    if (isAdmin || isAdminSession()) {
      setIsAdmin(true);
      setActiveTab(tab);
    } else {
      setPendingTab(tab);
      setShowPinModal(true);
    }
  };

  // ── Render calendar directly (no login required) ──
  return (
    <>
      {showPinModal && (
        <PinModal
          onSuccess={() => {
            setIsAdmin(true);
            setShowPinModal(false);
            if (pendingTab) {
              setActiveTab(pendingTab);
              setPendingTab(null);
            }
          }}
          onCancel={() => { setShowPinModal(false); setPendingTab(null); }}
        />
      )}
      <CalendarApp
        user={effectiveUser}
        googleToken={googleToken}
        setGoogleToken={setGoogleToken}
        members={members}
        setMembers={setMembers}
        events={events}
        setEvents={setEvents}
        holidays={holidays}
        setHolidays={setHolidays}
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        monthOffset={monthOffset}
        setMonthOffset={setMonthOffset}
        isModalOpen={isAdmin ? isModalOpen : false}
        setIsModalOpen={(v) => {
          if (typeof v === 'function') { if (isAdmin) setIsModalOpen(v); return; }
          if (v && !isAdmin) { setShowPinModal(true); return; }
          setIsModalOpen(v);
        }}
        selectedDate={selectedDate}
        setSelectedDate={setSelectedDate}
        selectedMemberId={selectedMemberId}
        setSelectedMemberId={setSelectedMemberId}
        useApi={useApi}
        setUseApi={setUseApi}
        showUserMenu={showUserMenu}
        setShowUserMenu={setShowUserMenu}
        onLogout={() => {
          localStorage.removeItem('calendar_user');
          localStorage.removeItem('calendar_google_token');
          localStorage.removeItem('calendar_admin_until');
          if (window.google?.accounts?.id) {
            window.google.accounts.id.disableAutoSelect();
          }
          setUser(null);
          setGoogleToken('');
          setIsAdmin(false);
          setShowUserMenu(false);
        }}
        onGoogleLogin={() => {
          const clientId = getGoogleClientId();
          if (clientId && window.google?.accounts?.id) {
            window.google.accounts.id.initialize({
              client_id: clientId,
              callback: (response: { credential?: string }) => {
                if (response.credential) {
                  const decoded = decodeJwtPayload(response.credential);
                  if (decoded) {
                    saveToStorage('calendar_user', decoded);
                    setUser(decoded);
                  }
                }
              },
            });
            window.google.accounts.id.prompt();
          }
        }}
      />
    </>
  );
}

// ─── Calendar App (authenticated) ────────────────────────────

function CalendarApp({
  user, googleToken, setGoogleToken, members, setMembers, events, setEvents, holidays, setHolidays,
  activeTab, setActiveTab, monthOffset, setMonthOffset,
  isModalOpen, setIsModalOpen, selectedDate, setSelectedDate,
  selectedMemberId, setSelectedMemberId,
  useApi, setUseApi, showUserMenu, setShowUserMenu, onLogout, onGoogleLogin
}: {
  user: GoogleUser;
  onGoogleLogin?: () => void;
  googleToken: string;
  setGoogleToken: React.Dispatch<React.SetStateAction<string>>;
  members: Member[];
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  events: CalendarEvent[];
  setEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  holidays: Holiday[];
  setHolidays: React.Dispatch<React.SetStateAction<Holiday[]>>;
  activeTab: 'calendar' | 'settings' | 'members' | 'events';
  setActiveTab: React.Dispatch<React.SetStateAction<'calendar' | 'settings' | 'members' | 'events'>>;
  monthOffset: number;
  setMonthOffset: React.Dispatch<React.SetStateAction<number>>;
  isModalOpen: boolean;
  setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedDate: Date;
  setSelectedDate: React.Dispatch<React.SetStateAction<Date>>;
  selectedMemberId: number | null;
  setSelectedMemberId: React.Dispatch<React.SetStateAction<number | null>>;
  useApi: boolean;
  setUseApi: React.Dispatch<React.SetStateAction<boolean>>;
  showUserMenu: boolean;
  setShowUserMenu: React.Dispatch<React.SetStateAction<boolean>>;
  onLogout: () => void;
}) {
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    tryApi('/api/members').then(result => {
      if (result.ok) {
        setUseApi(true);
        setMembers(result.data as Member[]);
      }
    });
  }, []);

  const fetchMembers = useCallback(async () => {
    if (useApi) {
      const result = await tryApi<Member[]>('/api/members');
      if (result.ok && result.data) setMembers(result.data);
    }
  }, [useApi]);

  const fetchEvents = useCallback(async () => {
    if (useApi) {
      const result = await tryApi<CalendarEvent[]>('/api/events');
      if (result.ok && result.data) setEvents(result.data);
    }
  }, [useApi]);

  // Member photos for slideshow
  const [memberPhotos, setMemberPhotos] = useState<Record<number, string[]>>({});

  const fetchMemberPhotos = useCallback(async () => {
    if (!useApi) return;
    const photosMap: Record<number, string[]> = {};
    for (const m of members) {
      const result = await tryApi<MemberPhoto[]>(`/api/members/${m.id}/photos`);
      if (result.ok && result.data && result.data.length > 0) {
        photosMap[m.id] = result.data.map(p => p.photo_url);
      }
    }
    setMemberPhotos(photosMap);
  }, [useApi, members]);

  useEffect(() => { fetchMemberPhotos(); }, [fetchMemberPhotos]);

  // Keyword rules for matching Spond/Google Calendar events to members
  const [gcalKeywordRules, setGcalKeywordRules] = useState<GcalKeywordRule[]>([]);

  const fetchGcalKeywords = useCallback(async () => {
    if (!useApi) return;
    const result = await tryApi<{ gcalKeywords: string }>('/api/settings');
    if (result.ok && result.data?.gcalKeywords) {
      try { setGcalKeywordRules(JSON.parse(result.data.gcalKeywords)); } catch {}
    }
  }, [useApi]);

  useEffect(() => { fetchGcalKeywords(); }, [fetchGcalKeywords]);

  // Spond integration
  const [spondEvents, setSpondEvents] = useState<CalendarEvent[]>([]);
  const [spondChildren, setSpondChildren] = useState<SpondChild[]>([]);
  const [spondChildMapping, setSpondChildMapping] = useState<SpondChildMapping[]>([]);
  const [spondGroupMapping, setSpondGroupMapping] = useState<SpondGroupMapping[]>([]);
  const [spondConnected, setSpondConnected] = useState(false);
  const [spondAccounts, setSpondAccounts] = useState<{ email: string; label?: string }[]>([]);

  const fetchSpondSettings = useCallback(async () => {
    if (!useApi) return;
    const result = await tryApi<{ spondEmail: string; spondHasPassword: boolean; spondChildMapping: string; spondGroupMapping?: string; spondAccounts?: { email: string; label?: string }[] }>('/api/settings');
    if (result.ok && result.data) {
      const accounts = result.data.spondAccounts || [];
      setSpondAccounts(accounts);
      setSpondConnected(accounts.length > 0 || !!(result.data.spondEmail && result.data.spondHasPassword));
      if (result.data.spondChildMapping) {
        try { setSpondChildMapping(JSON.parse(result.data.spondChildMapping)); } catch {}
      }
      if (result.data.spondGroupMapping) {
        try { setSpondGroupMapping(JSON.parse(result.data.spondGroupMapping)); } catch {}
      }
    }
  }, [useApi]);

  useEffect(() => { fetchSpondSettings(); }, [fetchSpondSettings]);

  const fetchSpondChildren = useCallback(async () => {
    if (!useApi || !spondConnected) return;
    const result = await tryApi<SpondChild[]>('/api/spond/children');
    if (result.ok && result.data) setSpondChildren(result.data);
  }, [useApi, spondConnected]);

  useEffect(() => { fetchSpondChildren(); }, [fetchSpondChildren]);

  const fetchSpondEvents = useCallback(async () => {
    if (!useApi || !spondConnected) return;
    const result = await tryApi<CalendarEvent[]>('/api/spond/events');
    if (result.ok && result.data) setSpondEvents(result.data);
  }, [useApi, spondConnected]);

  useEffect(() => {
    fetchSpondEvents();
    if (spondConnected) {
      const interval = setInterval(fetchSpondEvents, 120000); // every 2 min
      return () => clearInterval(interval);
    }
  }, [fetchSpondEvents, spondConnected]);

  // Google Calendar events
  const [gcalEvents, setGcalEvents] = useState<CalendarEvent[]>([]);

  const fetchGoogleCalendarEvents = useCallback(async () => {
    if (!googleToken || !useApi) return;
    try {
      const res = await fetch('/api/google-calendar/events', {
        headers: { 'Authorization': `Bearer ${googleToken}` },
      });
      const data = await res.json();
      if (data.error) {
        // Token expired — clear it
        if (data.error?.code === 401) {
          setGoogleToken('');
          localStorage.removeItem('calendar_google_token');
        }
        return;
      }
      const items = data.items || [];
      const mapped: CalendarEvent[] = items
        .filter((e: any) => e.start?.dateTime || e.start?.date)
        .map((e: any, i: number) => ({
          id: -(i + 1), // negative IDs to distinguish from local events
          member_id: 0,
          title: e.summary || '(Без назви)',
          start_time: e.start?.dateTime || `${e.start?.date}T00:00:00`,
          end_time: e.end?.dateTime || e.start?.dateTime || `${e.start?.date}T23:59:59`,
          location: e.location || '',
          _gcal: true,
        }));
      setGcalEvents(mapped);
    } catch (err) {
      console.error('Google Calendar sync error:', err);
    }
  }, [googleToken, useApi]);

  useEffect(() => {
    fetchGoogleCalendarEvents();
    if (googleToken) {
      const interval = setInterval(fetchGoogleCalendarEvents, 60000); // sync every minute
      return () => clearInterval(interval);
    }
  }, [fetchGoogleCalendarEvents, googleToken]);

  // Match Google Calendar events to family members by keyword rules, then by name
  const matchedGcalEvents = useMemo(() => {
    return gcalEvents.map(e => {
      const titleLower = e.title.toLowerCase();
      // 1. Check keyword rules first (Spond groups etc.)
      const ruleMatch = gcalKeywordRules.find(r => titleLower.includes(r.keyword.toLowerCase()));
      if (ruleMatch) {
        return { ...e, member_id: ruleMatch.member_id, title: ruleMatch.label || e.title };
      }
      // 2. Fall back to member name match
      const matched = members.find(m => titleLower.includes(m.name.toLowerCase()));
      return { ...e, member_id: matched ? matched.id : 0 };
    });
  }, [gcalEvents, members, gcalKeywordRules]);

  // Collect unmatched Google Calendar events grouped by title
  const unmatchedGcalGroups = useMemo(() => {
    const unmatched = matchedGcalEvents.filter(e => e.member_id === 0);
    const groups = new Map<string, { title: string; events: CalendarEvent[] }>();
    for (const e of unmatched) {
      const orig = gcalEvents.find(g => g.id === e.id);
      const title = orig?.title || e.title;
      const key = title.toLowerCase();
      if (!groups.has(key)) {
        groups.set(key, { title, events: [] });
      }
      groups.get(key)!.events.push(e);
    }
    return Array.from(groups.values());
  }, [matchedGcalEvents, gcalEvents]);

  // Combine local + Google Calendar events
  const allEvents = [...events, ...matchedGcalEvents, ...spondEvents];

  useEffect(() => { saveToStorage('calendar_members', members); }, [members]);
  useEffect(() => { saveToStorage('calendar_events', events); }, [events]);
  useEffect(() => { saveToStorage('calendar_month_offset', monthOffset); }, [monthOffset]);

  const fetchHolidays = async (year: number) => {
    try {
      const [noRes, uaRes] = await Promise.all([
        fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/NO`),
        fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/UA`)
      ]);
      const noHolidays = noRes.ok ? await noRes.json() : [];
      const uaHolidays = uaRes.ok ? await uaRes.json() : [];
      setHolidays([...noHolidays, ...uaHolidays]);
    } catch (error) {
      console.error('Failed to fetch holidays:', error);
    }
  };

  useEffect(() => {
    if (useApi) {
      fetchMembers();
      fetchEvents();
      const interval = setInterval(() => { fetchEvents(); }, 5000);
      return () => clearInterval(interval);
    }
  }, [useApi, fetchMembers, fetchEvents]);

  // Rolling 21-day window: starts 3 days before today, offset shifts by 21 days
  const WINDOW_DAYS = 21;
  const DAYS_BEFORE_TODAY = 3;
  const windowStart = addDays(addDays(new Date(), -DAYS_BEFORE_TODAY), monthOffset * WINDOW_DAYS);
  const windowEnd = addDays(windowStart, WINDOW_DAYS - 1);

  // Track visible days for accurate header date range
  const [visibleDays, setVisibleDays] = useState<Set<string>>(new Set());
  const dayObserverRef = useRef<IntersectionObserver | null>(null);
  const calendarBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (dayObserverRef.current) dayObserverRef.current.disconnect();
    const root = calendarBodyRef.current;
    if (!root) return;
    const obs = new IntersectionObserver((entries) => {
      setVisibleDays(prev => {
        const next = new Set(prev);
        for (const e of entries) {
          const dateStr = (e.target as HTMLElement).dataset.date;
          if (!dateStr) continue;
          if (e.isIntersecting) next.add(dateStr); else next.delete(dateStr);
        }
        return next;
      });
    }, { root, threshold: 0.1 });
    dayObserverRef.current = obs;
    root.querySelectorAll('[data-date]').forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, [monthOffset, allEvents.length]);

  const visibleRange = useMemo(() => {
    if (visibleDays.size === 0) return { start: windowStart, end: windowEnd };
    const sorted = [...visibleDays].sort();
    return { start: new Date(sorted[0]), end: new Date(sorted[sorted.length - 1]) };
  }, [visibleDays, windowStart, windowEnd]);

  useEffect(() => {
    fetchHolidays(getYear(windowStart));
    // Also fetch next year if window crosses year boundary
    if (getYear(windowEnd) !== getYear(windowStart)) fetchHolidays(getYear(windowEnd));
  }, [getYear(windowStart), getYear(windowEnd)]);

  const updateMonthOffset = async (newOffset: number) => {
    setMonthOffset(newOffset);
    if (useApi) {
      await tryApi('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthOffset: newOffset }),
      });
    }
  };

  const nextMonth = () => updateMonthOffset(monthOffset + 1);
  const prevMonth = () => updateMonthOffset(monthOffset - 1);

  const handleCellClick = (day: Date, memberId: number | null) => {
    setSelectedDate(day);
    setSelectedMemberId(memberId);
    setIsModalOpen(true);
  };

  const addEvent = async (event: Omit<CalendarEvent, 'id'>) => {
    if (useApi) {
      await tryApi('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      fetchEvents();
    } else {
      const newEvent: CalendarEvent = { ...event, id: Date.now() };
      setEvents(prev => [...prev, newEvent]);
    }
  };

  const deleteEvent = (eventId: number) => {
    setEvents(prev => prev.filter(e => e.id !== eventId));
  };

  return (
    <div className="h-screen bg-slate-50 text-slate-900 font-sans flex flex-col overflow-hidden max-w-screen-2xl mx-auto">
      {/* ── Header ── */}
      <header className="bg-white shadow-sm border-b border-slate-200 p-2 md:p-3 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2 md:gap-4">
          <h1 className="text-lg md:text-xl font-bold text-slate-800 tracking-tight hidden sm:block">Berbeha Calendar</h1>
          {activeTab === 'calendar' && (
            <div className="flex items-center gap-1 md:gap-2 bg-slate-50 px-1 md:px-2 py-1 rounded-lg border border-slate-100">
              <button onClick={prevMonth} className="p-1 md:p-1.5 rounded-full hover:bg-slate-200 transition-colors">
                <ChevronLeft className="w-4 h-4 md:w-5 md:h-5 text-slate-600" />
              </button>
              <h2 className="text-xs md:text-base font-semibold text-slate-800 min-w-[110px] md:min-w-[170px] text-center">
                {format(visibleRange.start, 'd MMM', { locale: uk })} — {format(visibleRange.end, 'd MMM yyyy', { locale: uk })}
              </h2>
              <button onClick={nextMonth} className="p-1 md:p-1.5 rounded-full hover:bg-slate-200 transition-colors">
                <ChevronRight className="w-4 h-4 md:w-5 md:h-5 text-slate-600" />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          {!useApi && (
            <span className="text-[10px] md:text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium hidden sm:inline">Demo</span>
          )}
          <button onClick={() => setActiveTab('calendar')} className={cn("px-2 py-1.5 md:px-3 md:py-2 rounded-lg font-medium transition-colors text-xs md:text-sm", activeTab === 'calendar' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            Календар
          </button>
          <button onClick={() => setActiveTab('members')} className={cn("p-1.5 md:p-2 rounded-lg transition-colors", activeTab === 'members' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            <Users className="w-4 h-4 md:w-5 md:h-5" />
          </button>
          <button onClick={() => setActiveTab('events')} className={cn("p-1.5 md:p-2 rounded-lg transition-colors relative", activeTab === 'events' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            <CalendarDays className="w-4 h-4 md:w-5 md:h-5" />
            {unmatchedGcalGroups.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-amber-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                {unmatchedGcalGroups.length}
              </span>
            )}
          </button>
          <button onClick={() => setActiveTab('settings')} className={cn("p-1.5 md:p-2 rounded-lg transition-colors", activeTab === 'settings' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            <Settings className="w-4 h-4 md:w-5 md:h-5" />
          </button>

          {/* Connect Google button */}
          <button
            onClick={() => {
              // Always clear old token and re-request with all scopes
              localStorage.removeItem('calendar_google_token');
              setGoogleToken('');
              requestGoogleToken(setGoogleToken);
            }}
            className={cn(
              "px-2 py-1.5 md:px-3 md:py-2 rounded-lg text-xs md:text-sm font-medium transition-colors flex items-center gap-1 border",
              googleToken
                ? "bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
                : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
            )}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            {googleToken ? 'Google OK' : 'Google'}
          </button>

          {/* User avatar & menu */}
          <div className="relative ml-1 md:ml-2">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 p-1 rounded-full hover:bg-slate-100 transition-colors"
            >
              {user.picture ? (
                <img
                  src={user.picture}
                  alt={user.name}
                  className="w-7 h-7 md:w-8 md:h-8 rounded-full border-2 border-indigo-200"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 md:w-8 md:h-8 rounded-full border-2 border-indigo-200 bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs">
                  {user.name.charAt(0)}
                </div>
              )}
            </button>

            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <div className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-lg border border-slate-200 z-50 overflow-hidden">
                  <div className="p-4 border-b border-slate-100 bg-slate-50">
                    <div className="flex items-center gap-3">
                      {user.picture ? (
                        <img src={user.picture} alt={user.name} className="w-10 h-10 rounded-full" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-lg">
                          {user.name.charAt(0)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="font-semibold text-sm text-slate-800 truncate">{user.name}</p>
                        <p className="text-xs text-slate-500 truncate">{user.email || 'Google не підключено'}</p>
                      </div>
                    </div>
                  </div>
                  {!user.email && onGoogleLogin && (
                    <button
                      onClick={() => { onGoogleLogin(); setShowUserMenu(false); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                      Підключити Google
                    </button>
                  )}
                  {user.email && (
                    <button
                      onClick={onLogout}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Вийти з Google
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 p-2 md:p-4 w-full flex flex-col min-h-0">
        {activeTab === 'calendar' && (() => {
          const today = new Date();
          const days = eachDayOfInterval({ start: windowStart, end: windowEnd });
          const totalDays = days.length;

          // Lens effect: today gets max weight, nearby days progressively less
          const lensCenter = days.findIndex(d => isSameDay(d, today));
          const centerIdx = lensCenter >= 0 ? lensCenter : Math.min(Math.max(0, differenceInCalendarDays(today, windowStart)), totalDays - 1);

          const LENS_RADIUS = 3;
          const MAX_WEIGHT = 3.5;
          const MIN_WEIGHT = 1.0;
          const TODAY_BOOST = 1.5; // 50% taller for today

          const weights = days.map((_, i) => {
            const dist = Math.abs(i - centerIdx);
            let w = MIN_WEIGHT;
            if (dist === 0) w = MAX_WEIGHT;
            else if (dist <= LENS_RADIUS) w = MIN_WEIGHT + (MAX_WEIGHT - MIN_WEIGHT) * (1 - dist / LENS_RADIUS) * 0.7;
            // Boost today's row by 50%
            if (dist === 0) w *= TODAY_BOOST;
            return w;
          });
          const totalWeight = weights.reduce((a, b) => a + b, 0);

          return (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="flex flex-col flex-1 min-h-0 border-t border-slate-200">
              {/* Table Header — photo slideshow cells */}
              <div className="flex border-b border-slate-200 shadow-[0_1px_2px_rgba(0,0,0,0.05)] shrink-0">
                <div className="w-4 md:w-5 shrink-0 border-r border-slate-300 bg-slate-50" />
                <div className="w-8 md:w-10 shrink-0 p-1 text-center font-semibold text-slate-500 border-r border-slate-300 flex items-center justify-center text-[8px] md:text-[10px] bg-slate-50">Дата</div>
                {members.map(m => (
                  <div key={m.id} className="flex-1 border-r border-slate-300 min-w-0 overflow-hidden relative" style={{ borderTop: `3px solid ${m.color}` }}>
                    <PhotoSlideshow
                      photos={memberPhotos[m.id] || []}
                      fallbackUrl={m.avatar_url}
                      color={m.color}
                      name={m.name}
                      mode="cell"
                    />
                    <NextEventCountdown events={allEvents.filter(e => e.member_id === m.id)} />
                  </div>
                ))}
              </div>

              {/* Table Body — grouped by weeks, with merged week number cell */}
              <div className="flex flex-col flex-1 min-h-0" ref={calendarBodyRef}>
                {(() => {
                  // Group days into weeks (Mon-Sun)
                  const weeks: { weekNum: number; days: { day: Date; dayIdx: number }[] }[] = [];
                  let currentWeek: { weekNum: number; days: { day: Date; dayIdx: number }[] } | null = null;
                  days.forEach((day, dayIdx) => {
                    const wn = getISOWeek(day);
                    if (!currentWeek || currentWeek.weekNum !== wn) {
                      currentWeek = { weekNum: wn, days: [] };
                      weeks.push(currentWeek);
                    }
                    currentWeek.days.push({ day, dayIdx });
                  });

                  return weeks.map(week => {
                    const weekWeight = week.days.reduce((s, d) => s + weights[d.dayIdx], 0);
                    const weekPct = (weekWeight / totalWeight) * 100;

                    return (
                      <div key={week.weekNum} className="flex border-b border-slate-400" style={{ flex: `${weekPct} 0 0%` }}>
                        {/* Week number — merged cell spanning all days of the week */}
                        <div className="w-4 md:w-5 shrink-0 border-r border-slate-300 bg-slate-50 flex items-center justify-center">
                          <span className="text-[8px] md:text-[10px] font-bold text-teal-600">{week.weekNum}</span>
                        </div>
                        {/* Days column */}
                        <div className="flex flex-col flex-1 min-h-0">
                {week.days.map(({ day, dayIdx }) => {
                  const isToday = isSameDay(day, today);
                  const isWknd = isWeekend(day);
                  const dayHolidays = holidays.filter(h => h.date === format(day, 'yyyy-MM-dd'));
                  const dayEvents = allEvents.filter(e => isSameDay(new Date(e.start_time), day));

                  // Google Calendar events not matched to any member → full-width
                  const gcalGeneralEvents = dayEvents.filter(e => e.id < 0 && e.member_id === 0);
                  // All events per member (both local and matched gcal)
                  const memberEvents = (mId: number) => dayEvents.filter(e => e.member_id === mId);

                  const dayPct = (weights[dayIdx] / weekWeight) * 100;
                  const dist = Math.abs(dayIdx - centerIdx);
                  const isNearToday = dist <= LENS_RADIUS;

                  // Shorten location: take first meaningful part (building/venue name)
                  const shortLocation = (loc: string) => {
                    if (!loc) return '';
                    const parts = loc.split(',').map(s => s.trim());
                    // Return venue name + city (first and last parts)
                    if (parts.length >= 3) return `${parts[0]}, ${parts[parts.length - 1]}`;
                    return parts[0];
                  };

                  const renderEvents = (cellEvents: CalendarEvent[], member?: Member) => (
                    <div className="flex flex-wrap gap-px overflow-y-auto items-start content-start w-full h-full">
                      {cellEvents.map(event => {
                        const isGcal = event.id < 0 && !event._spond;
                        const isSpond = !!event._spond;
                        const isTgBot = event.id >= 0; // local DB = added via Telegram bot
                        const time = format(new Date(event.start_time), 'HH:mm');
                        // Spond: teal for all members, Telegram: red, Google: green
                        const titleColor = isSpond ? '#0d9488' : isTgBot ? '#dc2626' : '#2e7d32';
                        const srcIcon = isSpond ? '⚽' : isGcal ? '📅' : '✏️';
                        const borderColor = isSpond ? '#0d9488' : isTgBot ? '#dc2626' : '#4caf50';
                        const bgColor = isSpond ? '#f0fdfa' : isTgBot ? '#fef2f2' : '#e8f5e9';
                        const bgColorFar = isSpond ? '#f0fdfa' : isTgBot ? '#fef2f2' : '#e8f5e9';
                        const tooltipParts = [
                          srcIcon,
                          time,
                          event.title,
                          event.location ? `📍 ${event.location}` : '',
                          isSpond ? '(Spond)' : isTgBot ? '(Telegram)' : '(Google)',
                        ].filter(Boolean).join(' ');

                        // Today: enlarged fonts
                        const todayFont = isToday ? 'text-[10px] md:text-[13px]' : 'text-[8px] md:text-[10px]';
                        const todayFontSmall = isToday ? 'text-[8px] md:text-[10px]' : 'text-[7px] md:text-[8px]';

                        // Near today: expanded multi-line view
                        if (isNearToday) return (
                          <div
                            key={event.id}
                            className={cn("group px-0.5 py-px rounded-[2px] font-medium leading-tight max-w-full flex flex-col cursor-pointer", todayFont)}
                            style={{
                              backgroundColor: bgColor,
                              borderLeft: `2px solid ${borderColor}`
                            }}
                            title={tooltipParts}
                            onClick={(e) => { e.stopPropagation(); setDetailEvent(event); }}
                          >
                            <div className="flex items-center truncate">
                              <span className="mr-0.5 shrink-0 font-bold text-blue-600">{time}</span>
                              <span className="truncate font-semibold" style={{ color: titleColor }}>{event.title}</span>
                              {!useApi && isTgBot && (
                                <button onClick={(e) => { e.stopPropagation(); deleteEvent(event.id); }}
                                  className="hidden group-hover:inline-flex ml-auto p-px rounded hover:bg-red-100 text-red-400 hover:text-red-600">
                                  <Trash2 className="w-2 h-2" />
                                </button>
                              )}
                            </div>
                            {event.location && (
                              <span className={cn("truncate text-orange-500", todayFontSmall)}>📍 {event.location}</span>
                            )}
                          </div>
                        );

                        // Far days: compact single-line "Футбол 16:15 Лена"
                        return (
                          <div
                            key={event.id}
                            className="group px-0.5 py-px rounded-[2px] text-[7px] md:text-[9px] font-medium leading-tight max-w-full truncate cursor-pointer"
                            style={{
                              backgroundColor: bgColorFar,
                              borderLeft: `2px solid ${borderColor}`
                            }}
                            title={tooltipParts}
                            onClick={(e) => { e.stopPropagation(); setDetailEvent(event); }}
                          >
                            <span className="font-semibold" style={{ color: titleColor }}>{event.title}</span>
                            {' '}<span className="font-bold text-blue-600">{time}</span>
                            {event.location && <>{' '}<span className="text-orange-500">{shortLocation(event.location)}</span></>}
                          </div>
                        );
                      })}
                    </div>
                  );

                  return (
                    <div
                      key={day.toString()}
                      data-date={format(day, 'yyyy-MM-dd')}
                      className={cn(
                        "flex flex-col border-b border-slate-200 overflow-hidden",
                        isToday ? "bg-indigo-100 ring-2 ring-inset ring-indigo-400" :
                        isWknd ? "bg-pink-50" : "bg-white"
                      )}
                      style={{ flex: `${dayPct} 0 0%` }}
                    >
                      {/* General Google Calendar events (not matched to member) — full-width banner */}
                      {gcalGeneralEvents.length > 0 && (
                        <div className="flex gap-0.5 px-0.5 py-px bg-green-50/60 border-b border-green-100 overflow-hidden shrink-0">
                          {gcalGeneralEvents.map(e => (
                            <span key={e.id} className="shrink-0 text-[7px] md:text-[8px] leading-tight bg-green-100 text-green-800 rounded px-1 py-px font-medium truncate" title={`Google: ${e.title}`}>
                              📅 {e.title}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Main row: date + member columns */}
                      <div className="flex flex-1 min-h-0">
                        {/* Date column */}
                        <div className={cn("w-8 md:w-10 shrink-0 border-r border-slate-300 flex flex-col items-center justify-center", isWknd ? "bg-pink-100/50" : (isToday ? "bg-indigo-200" : "bg-white"))}>
                          <span className={cn("font-bold leading-none", isToday ? "text-lg md:text-2xl text-indigo-700" : (isNearToday ? "text-xs md:text-sm" : "text-[10px] md:text-xs"), isWknd && !isToday && "text-pink-600", !isWknd && !isToday && "text-slate-700")}>
                            {format(day, 'd')}
                          </span>
                          <span className={cn("uppercase font-medium leading-none", isToday ? "text-[10px] md:text-xs text-indigo-500" : "text-[6px] md:text-[8px]", isWknd && !isToday ? "text-pink-500" : "text-slate-400")}>
                            {format(day, 'EEEEEE', { locale: uk })}
                          </span>
                          {isNearToday && dayHolidays.length > 0 && (
                            <span className="text-[5px] md:text-[7px] text-slate-500 leading-none" title={dayHolidays.map(h => h.localName).join(', ')}>
                              {dayHolidays[0].countryCode === 'NO' ? '🇳🇴' : '🇺🇦'}
                            </span>
                          )}
                        </div>

                        {members.map(m => (
                          <div
                            key={m.id}
                            className="flex-1 px-px border-r border-slate-200 min-w-0 overflow-hidden cursor-pointer hover:brightness-95 transition-all flex items-start"
                            style={{ backgroundColor: `${m.color}12` }}
                            onClick={() => handleCellClick(day, m.id)}
                          >
                            {renderEvents(memberEvents(m.id), m)}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
          </div>
          );
        })()}

        {activeTab === 'events' && (
          <div className="overflow-y-auto flex-1">
            <EventMappingTab
              members={members}
              gcalKeywordRules={gcalKeywordRules} onKeywordsChanged={fetchGcalKeywords} unmatchedGroups={unmatchedGcalGroups}
              spondChildren={spondChildren} spondChildMapping={spondChildMapping} spondConnected={spondConnected}
              spondAccounts={spondAccounts}
              spondGroupMapping={spondGroupMapping} spondEvents={spondEvents}
              onSpondMappingChanged={() => { fetchSpondSettings(); fetchSpondEvents(); }}
              onSpondConnected={() => { fetchSpondSettings(); fetchSpondChildren(); fetchSpondEvents(); }}
              useApi={useApi}
            />
          </div>
        )}
        {activeTab === 'settings' && (
          <div className="overflow-y-auto flex-1">
            <SettingsTab useApi={useApi} />
          </div>
        )}
        {activeTab === 'members' && (
          <div className="overflow-y-auto flex-1">
            <MembersTab members={members} setMembers={setMembers} useApi={useApi} photosToken={googleToken} onPhotosChanged={fetchMemberPhotos} />
          </div>
        )}
      </main>

      {isModalOpen && (
        <EventModal
          onClose={() => setIsModalOpen(false)}
          selectedDate={selectedDate}
          selectedMemberId={selectedMemberId}
          members={members}
          onSave={addEvent}
        />
      )}

      {/* ── Event Detail Modal ── */}
      {detailEvent && (() => {
        const ev = detailEvent;
        const member = members.find(m => m.id === ev.member_id);
        const isSpond = !!ev._spond;
        const isGcal = ev.id < 0 && !ev._spond;
        const isTgBot = ev.id >= 0;
        const source = isSpond ? 'Spond' : isGcal ? 'Google Calendar' : 'Telegram';
        const sourceColor = isSpond ? 'text-teal-600' : isGcal ? 'text-green-600' : 'text-red-600';
        const startDate = new Date(ev.start_time);
        const endDate = ev.end_time ? new Date(ev.end_time) : null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDetailEvent(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-[90%] max-w-md mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header with member color */}
              <div className="p-4 text-white" style={{ backgroundColor: member?.color || '#6366f1' }}>
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-bold">{ev.title}</h3>
                    <p className="text-sm opacity-90">{member?.name || 'Сім\'я'}</p>
                  </div>
                  <button onClick={() => setDetailEvent(null)} className="p-1 rounded-full hover:bg-white/20">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
              {/* Details */}
              <div className="p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-slate-400 w-5 text-center">🕐</span>
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {format(startDate, 'EEEE, d MMMM yyyy', { locale: uk })}
                    </p>
                    <p className="text-sm text-slate-600">
                      {format(startDate, 'HH:mm')}
                      {endDate && ` — ${format(endDate, 'HH:mm')}`}
                    </p>
                  </div>
                </div>
                {ev.location && (
                  <div className="flex items-center gap-3">
                    <span className="text-slate-400 w-5 text-center">📍</span>
                    <p className="text-sm text-slate-800">{ev.location}</p>
                  </div>
                )}
                {ev.spond_group_name && (
                  <div className="flex items-center gap-3">
                    <span className="text-slate-400 w-5 text-center">👥</span>
                    <p className="text-sm text-slate-800">{ev.spond_group_name}</p>
                  </div>
                )}
                <div className="flex items-center gap-3">
                  <span className="text-slate-400 w-5 text-center">📌</span>
                  <p className={cn("text-sm font-medium", sourceColor)}>{source}</p>
                </div>
                {isTgBot && (
                  <div className="pt-2 border-t border-slate-100">
                    <button
                      onClick={() => { deleteEvent(ev.id); setDetailEvent(null); }}
                      className="flex items-center gap-2 text-sm text-red-500 hover:text-red-700 font-medium"
                    >
                      <Trash2 className="w-4 h-4" /> Видалити подію
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Event Modal ─────────────────────────────────────────────

function EventModal({ onClose, selectedDate, selectedMemberId, members, onSave }: {
  onClose: () => void;
  selectedDate: Date;
  selectedMemberId: number | null;
  members: Member[];
  onSave: (event: Omit<CalendarEvent, 'id'>) => void;
}) {
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('12:00');
  const [location, setLocation] = useState('');
  const [memberId, setMemberId] = useState<number | ''>(selectedMemberId || (members.length > 0 ? members[0].id : ''));
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || memberId === '') return;
    setSaving(true);
    const [hours, minutes] = time.split(':').map(Number);
    const eventDate = setMinutes(setHours(selectedDate, hours), minutes);
    try {
      await onSave({
        member_id: Number(memberId),
        title,
        start_time: eventDate.toISOString(),
        end_time: eventDate.toISOString(),
        location
      });
      onClose();
    } catch (error) {
      console.error('Failed to save event', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-800">
            Додати подію ({format(selectedDate, 'd MMMM', { locale: uk })})
          </h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Назва</label>
            <input type="text" required value={title} onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Наприклад: Плавання" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Час</label>
              <input type="time" required value={time} onChange={e => setTime(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Хто</label>
              <select required value={memberId} onChange={e => setMemberId(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white">
                {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Місце (необов'язково)</label>
            <input type="text" value={location} onChange={e => setLocation(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Наприклад: Басейн" />
          </div>
          <div className="pt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
              Скасувати
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50">
              {saving ? 'Зберігаю...' : 'Зберегти'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Event Mapping Tab ──────────────────────────────────────

function EventMappingTab({ members, gcalKeywordRules, onKeywordsChanged, unmatchedGroups, spondChildren, spondChildMapping, spondConnected, spondAccounts, spondGroupMapping, spondEvents, onSpondMappingChanged, onSpondConnected, useApi }: {
  members: Member[];
  gcalKeywordRules: GcalKeywordRule[];
  onKeywordsChanged: () => void;
  unmatchedGroups: { title: string; events: CalendarEvent[] }[];
  spondChildren: SpondChild[];
  spondChildMapping: SpondChildMapping[];
  spondConnected: boolean;
  spondAccounts: { email: string; label?: string }[];
  spondGroupMapping: SpondGroupMapping[];
  spondEvents: CalendarEvent[];
  onSpondMappingChanged: () => void;
  onSpondConnected: () => void;
  useApi: boolean;
}) {
  // ── Google Calendar keyword rules ──
  const [rules, setRules] = useState<GcalKeywordRule[]>(gcalKeywordRules);
  const [newKeyword, setNewKeyword] = useState('');
  const [newMemberId, setNewMemberId] = useState<number>(members[0]?.id || 0);
  const [newLabel, setNewLabel] = useState('');
  const [assigningTitle, setAssigningTitle] = useState<string | null>(null);
  const [assignMemberId, setAssignMemberId] = useState<number>(members[0]?.id || 0);
  const [assignLabel, setAssignLabel] = useState('');

  useEffect(() => { setRules(gcalKeywordRules); }, [gcalKeywordRules]);

  const saveKeywordRules = async (newRules: GcalKeywordRule[]) => {
    setRules(newRules);
    if (useApi) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gcalKeywords: JSON.stringify(newRules) }),
      });
      onKeywordsChanged();
    }
  };

  const addRule = () => {
    if (!newKeyword.trim() || !newMemberId) return;
    saveKeywordRules([...rules, { keyword: newKeyword.trim(), member_id: newMemberId, label: newLabel.trim() || undefined }]);
    setNewKeyword('');
    setNewLabel('');
  };

  const assignUnmatched = (title: string) => {
    if (!assignMemberId) return;
    saveKeywordRules([...rules, { keyword: title, member_id: assignMemberId, label: assignLabel.trim() || undefined }]);
    setAssigningTitle(null);
    setAssignLabel('');
  };

  const removeRule = (idx: number) => {
    saveKeywordRules(rules.filter((_, i) => i !== idx));
  };

  // ── Spond connection (multi-account) ──
  const [spondEmail, setSpondEmail] = useState('');
  const [spondPassword, setSpondPassword] = useState('');
  const [spondLabel, setSpondLabel] = useState('');
  const [spondTesting, setSpondTesting] = useState(false);
  const [spondTestResult, setSpondTestResult] = useState<string | null>(null);
  const [spondMappings, setSpondMappings] = useState<SpondChildMapping[]>(spondChildMapping);
  const [assigningSpondChild, setAssigningSpondChild] = useState<string | null>(null);
  const [spondAssignMemberId, setSpondAssignMemberId] = useState<number>(members[0]?.id || 0);
  const [showAddAccount, setShowAddAccount] = useState(false);

  useEffect(() => { setSpondMappings(spondChildMapping); }, [spondChildMapping]);

  const addSpondAccount = async () => {
    setSpondTesting(true);
    setSpondTestResult(null);
    try {
      const res = await fetch('/api/spond/accounts/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: spondEmail, password: spondPassword, label: spondLabel || spondEmail }),
      });
      const data = await res.json();
      if (data.success) {
        setSpondTestResult('ok');
        setSpondEmail('');
        setSpondPassword('');
        setSpondLabel('');
        setShowAddAccount(false);
        onSpondConnected();
      } else {
        setSpondTestResult(data.error || 'Помилка підключення');
      }
    } catch {
      setSpondTestResult('Помилка підключення');
    }
    setSpondTesting(false);
  };

  const removeSpondAccount = async (email: string) => {
    await fetch('/api/spond/accounts/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    onSpondConnected();
  };

  const saveSpondMapping = async (newMappings: SpondChildMapping[]) => {
    setSpondMappings(newMappings);
    if (useApi) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spondChildMapping: JSON.stringify(newMappings) }),
      });
      onSpondMappingChanged();
    }
  };

  const assignSpondChild = (child: SpondChild) => {
    if (!spondAssignMemberId) return;
    saveSpondMapping([...spondMappings, {
      profileId: child.profileId,
      childName: `${child.firstName} ${child.lastName}`,
      member_id: spondAssignMemberId,
    }]);
    setAssigningSpondChild(null);
  };

  const removeSpondMapping = (idx: number) => {
    saveSpondMapping(spondMappings.filter((_, i) => i !== idx));
  };

  // ── Spond group mapping (for parent groups, school groups, etc.) ──
  const [groupMappings, setGroupMappings] = useState<SpondGroupMapping[]>(spondGroupMapping);
  const [assigningGroupId, setAssigningGroupId] = useState<string | null>(null);
  const [groupAssignMemberId, setGroupAssignMemberId] = useState<number>(members[0]?.id || 0);

  useEffect(() => { setGroupMappings(spondGroupMapping); }, [spondGroupMapping]);

  const saveGroupMapping = async (newMappings: SpondGroupMapping[]) => {
    setGroupMappings(newMappings);
    if (useApi) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spondGroupMapping: JSON.stringify(newMappings) }),
      });
      onSpondMappingChanged();
    }
  };

  const removeGroupMapping = (idx: number) => {
    saveGroupMapping(groupMappings.filter((_, i) => i !== idx));
  };

  // Find unmapped groups: groups from Spond events that have member_id=0 and aren't already mapped
  const unmappedSpondGroups: { groupId: string; groupName: string; eventCount: number }[] = [];
  {
    const seen = new Set<string>();
    for (const e of spondEvents) {
      const gid = e.spond_group_id;
      const gname = e.spond_group_name;
      if (!gid || !gname || seen.has(gid)) continue;
      seen.add(gid);
      if (e.member_id === 0 && !groupMappings.some(m => m.groupId === gid)) {
        const cnt = spondEvents.filter(ev => ev.spond_group_id === gid && ev.member_id === 0).length;
        unmappedSpondGroups.push({ groupId: gid, groupName: gname, eventCount: cnt });
      }
    }
  }

  const unmappedChildren = spondChildren.filter(c => !spondMappings.some(m => m.profileId === c.profileId));

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* ═══ SPOND SECTION ═══ */}
      <div className="bg-white p-5 md:p-6 rounded-2xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xl">🏟️</span>
          <h2 className="text-lg font-bold text-slate-800">Spond</h2>
          {spondAccounts.length > 0 && (
            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
              {spondAccounts.length} {spondAccounts.length === 1 ? 'акаунт' : 'акаунти'}
            </span>
          )}
        </div>

        {/* Connected accounts list */}
        {spondAccounts.length > 0 && (
          <div className="mb-3 space-y-1.5">
            {spondAccounts.map(acc => (
              <div key={acc.email} className="flex items-center gap-2 px-3 py-2 bg-green-50 rounded-lg border border-green-200">
                <span className="text-green-600 text-sm">&#10003;</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-700 truncate">{acc.label || acc.email}</p>
                  {acc.label && acc.label !== acc.email && (
                    <p className="text-[10px] text-slate-400 truncate">{acc.email}</p>
                  )}
                </div>
                <button onClick={() => removeSpondAccount(acc.email)}
                  className="p-1 text-red-300 hover:text-red-600 hover:bg-red-50 rounded transition-colors shrink-0">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add account form */}
        {(spondAccounts.length === 0 || showAddAccount) ? (
          <div className="space-y-3">
            {spondAccounts.length === 0 && (
              <p className="text-sm text-slate-500">
                Підключіть Spond щоб автоматично отримувати події з прив'язкою до дитини.
              </p>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input type="email" value={spondEmail} onChange={e => setSpondEmail(e.target.value)}
                  placeholder="Email від Spond"
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                <input type="password" value={spondPassword} onChange={e => setSpondPassword(e.target.value)}
                  placeholder="Пароль"
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  onKeyDown={e => e.key === 'Enter' && addSpondAccount()} />
              </div>
              {spondAccounts.length > 0 && (
                <input type="text" value={spondLabel} onChange={e => setSpondLabel(e.target.value)}
                  placeholder="Мітка (напр. Тато, Мама)"
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={addSpondAccount} disabled={spondTesting || !spondEmail || !spondPassword}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {spondTesting ? 'Підключення...' : spondAccounts.length === 0 ? 'Підключити Spond' : 'Додати акаунт'}
              </button>
              {showAddAccount && (
                <button onClick={() => { setShowAddAccount(false); setSpondEmail(''); setSpondPassword(''); setSpondLabel(''); setSpondTestResult(null); }}
                  className="px-4 py-2 bg-white hover:bg-slate-100 text-slate-600 text-sm rounded-lg border border-slate-200">
                  Скасувати
                </button>
              )}
            </div>
            {spondTestResult && spondTestResult !== 'ok' && (
              <p className="text-sm text-red-600 text-center">{spondTestResult}</p>
            )}
          </div>
        ) : (
          <>
            {/* Add another account button */}
            <button onClick={() => setShowAddAccount(true)}
              className="w-full mb-4 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-medium rounded-lg transition-colors border border-dashed border-slate-300">
              + Додати ще один акаунт Spond
            </button>

            {/* Unmapped Spond children */}
            {unmappedChildren.length > 0 && (
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-amber-500">&#128118;</span>
                  <p className="text-sm font-semibold text-amber-800">
                    Непривʼязані діти ({unmappedChildren.length})
                  </p>
                </div>
                <p className="text-xs text-amber-700 mb-2">
                  Spond знайшов ваших дітей. Привʼяжіть кожну до відповідного учасника календаря:
                </p>
                <div className="space-y-2">
                  {unmappedChildren.map(child => (
                    <div key={child.profileId} className="bg-amber-50 rounded-lg border border-amber-200 overflow-hidden">
                      <div className="px-3 py-2 flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800">{child.firstName} {child.lastName}</p>
                          <p className="text-[11px] text-slate-500 truncate">
                            {child.groups.map(g => g.name).join(', ')}
                          </p>
                        </div>
                        {assigningSpondChild !== child.profileId && (
                          <button onClick={() => { setAssigningSpondChild(child.profileId); setSpondAssignMemberId(members[0]?.id || 0); }}
                            className="shrink-0 px-3 py-1 bg-amber-200 hover:bg-amber-300 text-amber-800 text-xs font-medium rounded-lg transition-colors">
                            Привʼязати
                          </button>
                        )}
                      </div>
                      {assigningSpondChild === child.profileId && (
                        <div className="px-3 py-2 border-t border-amber-200 bg-amber-50/50 flex gap-2 items-end">
                          <div className="flex-1">
                            <label className="block text-[10px] uppercase text-slate-500 font-medium mb-0.5">Хто в календарі</label>
                            <select value={spondAssignMemberId} onChange={e => setSpondAssignMemberId(Number(e.target.value))}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                          </div>
                          <button onClick={() => assignSpondChild(child)}
                            className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg transition-colors">
                            OK
                          </button>
                          <button onClick={() => setAssigningSpondChild(null)}
                            className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 text-sm rounded-lg transition-colors border border-slate-200">
                            X
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Mapped Spond children */}
            {spondMappings.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-600 mb-1">Привʼязані діти:</p>
                {spondMappings.map((mapping, idx) => {
                  const member = members.find(m => m.id === mapping.member_id);
                  const child = spondChildren.find(c => c.profileId === mapping.profileId);
                  const groupNames = child?.groups.map(g => g.name).join(', ') || '';
                  return (
                    <div key={idx} className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: member?.color || '#94a3b8' }} />
                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                        <span className="text-sm font-semibold" style={{ color: member?.color || '#475569' }}>{member?.name || '?'}</span>
                        <span className="text-slate-300 text-xs">=</span>
                        <span className="text-sm text-slate-700">{mapping.childName}</span>
                        {groupNames && (
                          <span className="text-[10px] text-slate-400 truncate max-w-[200px]" title={groupNames}>({groupNames})</span>
                        )}
                      </div>
                      <button onClick={() => removeSpondMapping(idx)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {spondMappings.length === 0 && unmappedChildren.length === 0 && spondChildren.length === 0 && (
              <p className="text-sm text-slate-400 italic">Завантаження дітей зі Spond...</p>
            )}

            {/* Unmapped Spond groups (parent groups, school groups, etc.) */}
            {unmappedSpondGroups.length > 0 && (
              <div className="mt-4 pt-3 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-purple-500">&#128279;</span>
                  <p className="text-sm font-semibold text-purple-800">
                    Непривʼязані групи ({unmappedSpondGroups.length})
                  </p>
                </div>
                <p className="text-xs text-purple-600 mb-2">
                  Ці групи Spond мають події без привʼязки до дитини (батьківські, шкільні групи тощо):
                </p>
                <div className="space-y-2">
                  {unmappedSpondGroups.map(g => (
                    <div key={g.groupId} className="bg-purple-50 rounded-lg border border-purple-200 overflow-hidden">
                      <div className="px-3 py-2 flex items-center justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-800">{g.groupName}</p>
                          <p className="text-[11px] text-slate-500">{g.eventCount} подій</p>
                        </div>
                        {assigningGroupId !== g.groupId && (
                          <button onClick={() => { setAssigningGroupId(g.groupId); setGroupAssignMemberId(members[0]?.id || 0); }}
                            className="shrink-0 px-3 py-1 bg-purple-200 hover:bg-purple-300 text-purple-800 text-xs font-medium rounded-lg transition-colors">
                            Привʼязати
                          </button>
                        )}
                      </div>
                      {assigningGroupId === g.groupId && (
                        <div className="px-3 py-2 border-t border-purple-200 bg-purple-50/50 flex gap-2 items-end">
                          <div className="flex-1">
                            <label className="block text-[10px] uppercase text-slate-500 font-medium mb-0.5">Хто в календарі</label>
                            <select value={groupAssignMemberId} onChange={e => setGroupAssignMemberId(Number(e.target.value))}
                              className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                          </div>
                          <button onClick={() => { saveGroupMapping([...groupMappings, { groupId: g.groupId, groupName: g.groupName, member_id: groupAssignMemberId }]); setAssigningGroupId(null); }}
                            className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg transition-colors">
                            OK
                          </button>
                          <button onClick={() => setAssigningGroupId(null)}
                            className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 text-sm rounded-lg transition-colors border border-slate-200">
                            X
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Mapped Spond groups */}
            {groupMappings.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium text-slate-600 mb-1">Привʼязані групи:</p>
                {groupMappings.map((mapping, idx) => {
                  const member = members.find(m => m.id === mapping.member_id);
                  return (
                    <div key={idx} className="flex items-center gap-2 p-2.5 rounded-lg border border-purple-200 bg-purple-50">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: member?.color || '#94a3b8' }} />
                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                        <span className="text-sm font-semibold" style={{ color: member?.color || '#475569' }}>{member?.name || '?'}</span>
                        <span className="text-slate-300 text-xs">=</span>
                        <span className="text-sm text-purple-700">{mapping.groupName}</span>
                      </div>
                      <button onClick={() => removeGroupMapping(idx)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors shrink-0">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══ GOOGLE CALENDAR UNMATCHED EVENTS ═══ */}
      {unmatchedGroups.length > 0 && (
        <div className="bg-amber-50 p-5 md:p-6 rounded-2xl shadow-sm border-2 border-amber-300">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xl">⚠️</span>
            <h2 className="text-lg font-bold text-amber-800">
              Нерозпізнані події Google Calendar ({unmatchedGroups.reduce((a, g) => a + g.events.length, 0)})
            </h2>
          </div>
          <p className="text-sm text-amber-700 mb-4">
            Ці події не прив'язані до жодного члена сім'ї. Присвойте кожну групу:
          </p>
          <div className="space-y-3">
            {unmatchedGroups.map(group => (
              <div key={group.title} className="bg-white rounded-xl border border-amber-200 overflow-hidden shadow-sm">
                <div className="px-3 py-2 bg-amber-100/50 border-b border-amber-200">
                  <p className="text-sm font-semibold text-slate-800 truncate" title={group.title}>
                    {group.title}
                  </p>
                </div>
                <div className="px-3 py-2 space-y-1.5 max-h-[200px] overflow-y-auto">
                  {group.events.map(ev => (
                    <div key={ev.id} className="text-xs text-slate-600">
                      <div className="flex items-center gap-2">
                        <span className="text-green-600 shrink-0">📅</span>
                        <span className="font-medium text-slate-700 w-16 shrink-0">
                          {format(new Date(ev.start_time), 'd MMM', { locale: uk })}
                        </span>
                        <span className="text-slate-500 truncate">
                          {format(new Date(ev.start_time), 'EEEE', { locale: uk })}
                        </span>
                        <span className="ml-auto font-mono text-slate-500 shrink-0">
                          {format(new Date(ev.start_time), 'HH:mm')}–{format(new Date(ev.end_time), 'HH:mm')}
                        </span>
                      </div>
                      {ev.location && (
                        <div className="flex items-start gap-2 ml-5 mt-0.5">
                          <span className="text-slate-400 shrink-0">📍</span>
                          <span className="text-[11px] text-slate-500 truncate" title={ev.location}>{ev.location}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {assigningTitle === group.title ? (
                  <div className="px-3 py-3 border-t border-amber-200 bg-amber-50/50 space-y-2">
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-[10px] uppercase text-slate-500 font-medium mb-0.5">Хто</label>
                        <select value={assignMemberId} onChange={e => setAssignMemberId(Number(e.target.value))}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                          {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-[10px] uppercase text-slate-500 font-medium mb-0.5">Назва</label>
                        <input type="text" value={assignLabel} onChange={e => setAssignLabel(e.target.value)}
                          placeholder="напр: Гімнастика"
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                          onKeyDown={e => e.key === 'Enter' && assignUnmatched(group.title)} autoFocus />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => assignUnmatched(group.title)}
                        className="flex-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-bold rounded-lg transition-colors">
                        Присвоїти
                      </button>
                      <button onClick={() => setAssigningTitle(null)}
                        className="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 text-sm rounded-lg transition-colors border border-slate-200">
                        Скасувати
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="px-3 py-2 border-t border-amber-200">
                    <button onClick={() => { setAssigningTitle(group.title); setAssignMemberId(members[0]?.id || 0); setAssignLabel(''); }}
                      className="w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-amber-100 hover:bg-amber-200 text-amber-800 text-sm font-medium rounded-lg transition-colors">
                      Присвоїти члену сім'ї
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══ Google Calendar keyword rules ═══ */}
      {(rules.length > 0 || unmatchedGroups.length > 0) && (
        <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-slate-200">
          <h2 className="text-xl font-bold mb-2 text-slate-800">Google Calendar — ключові слова</h2>
          <p className="text-sm text-slate-500 mb-4">
            Правила автоматичного розпізнавання подій з Google Calendar за ключовими словами.
          </p>

          {rules.length > 0 ? (
            <div className="mb-4 space-y-2">
              {rules.map((rule, idx) => {
                const member = members.find(m => m.id === rule.member_id);
                return (
                  <div key={idx} className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: member?.color || '#94a3b8' }} />
                    <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1">
                      <span className="text-sm font-semibold" style={{ color: member?.color || '#475569' }}>{member?.name || '?'}</span>
                      <span className="text-slate-300 text-xs">←</span>
                      <span className="font-mono text-[11px] bg-white px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 truncate max-w-[180px]" title={rule.keyword}>"{rule.keyword}"</span>
                      {rule.label && (
                        <span className="text-xs text-green-700 bg-green-50 px-1.5 py-0.5 rounded font-medium">{rule.label}</span>
                      )}
                    </div>
                    <button onClick={() => removeRule(idx)} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors shrink-0">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-400 italic mb-4">
              Присвойте нерозпізнані події зверху — вони з'являться тут.
            </p>
          )}

          <details className="group">
            <summary className="cursor-pointer text-sm text-indigo-600 hover:text-indigo-700 font-medium select-none">
              + Додати правило вручну
            </summary>
            <div className="mt-3 flex flex-col gap-2 p-3 rounded-lg border-2 border-dashed border-slate-200 bg-slate-50/50">
              <div className="flex gap-2">
                <input type="text" value={newKeyword} onChange={e => setNewKeyword(e.target.value)}
                  placeholder="Ключове слово" className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
                <select value={newMemberId} onChange={e => setNewMemberId(Number(e.target.value))}
                  className="px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none">
                  {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                  placeholder="Скорочена назва (необов'язково)" className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  onKeyDown={e => e.key === 'Enter' && addRule()} />
                <button onClick={addRule} disabled={!newKeyword.trim()}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-40">
                  Додати
                </button>
              </div>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Settings Tab ────────────────────────────────────────────

function SettingsTab({ useApi }: { useApi: boolean }) {
  const [token, setToken] = useState('');
  const [chatIds, setChatIds] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (useApi) {
      fetch('/api/settings').then(res => res.json()).then(data => {
        setToken(data.telegramToken || '');
        setChatIds(data.adminChatIds || '');
      });
    } else {
      setToken(loadFromStorage('calendar_tg_token', ''));
      setChatIds(loadFromStorage('calendar_tg_chat_ids', ''));
    }
  }, [useApi]);

  const saveSettings = async () => {
    setSaving(true);
    if (useApi) {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramToken: token, adminChatIds: chatIds }),
      });
    } else {
      saveToStorage('calendar_tg_token', token);
      saveToStorage('calendar_tg_chat_ids', chatIds);
    }
    setSaving(false);
    alert('Налаштування збережено!');
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-slate-200">
        <h2 className="text-xl font-bold mb-4 text-slate-800">Telegram Бот</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Bot Token</label>
            <input type="text" value={token} onChange={e => setToken(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm"
              placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ" />
            <p className="text-xs text-slate-500 mt-1">Отримайте токен у @BotFather в Telegram.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Admin Chat IDs (через кому)</label>
            <input type="text" value={chatIds} onChange={e => setChatIds(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm"
              placeholder="123456789, 987654321" />
          </div>
          <button onClick={saveSettings} disabled={saving}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors disabled:opacity-50 text-sm">
            {saving ? 'Зберігаю...' : 'Зберегти'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Members Tab ─────────────────────────────────────────────

function MembersTab({ members, setMembers, useApi, photosToken, onPhotosChanged }: {
  members: Member[];
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  useApi: boolean;
  photosToken: string;
  onPhotosChanged: () => void;
}) {
  const [memberPhotos, setMemberPhotos] = useState<Record<number, MemberPhoto[]>>({});
  const [uploading, setUploading] = useState<number | null>(null);
  const [pickerMemberId, setPickerMemberId] = useState<number | null>(null);
  const fileInputRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!useApi) return;
    members.forEach(async (m) => {
      const res = await fetch(`/api/members/${m.id}/photos`);
      if (res.ok) {
        const photos = await res.json();
        setMemberPhotos(prev => ({ ...prev, [m.id]: photos }));
      }
    });
  }, [useApi, members]);

  const updateMember = async (id: number, field: string, value: string) => {
    const member = members.find(m => m.id === id);
    if (!member) return;
    if (useApi) {
      await fetch(`/api/members/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...member, [field]: value }),
      });
    }
    setMembers(prev => prev.map(m => m.id === id ? { ...m, [field]: value } : m));
  };

  const uploadPhotos = async (memberId: number, files: FileList) => {
    if (!useApi || files.length === 0) return;
    setUploading(memberId);
    const formData = new FormData();
    for (const file of Array.from(files)) {
      formData.append('photos', file);
    }
    try {
      await fetch(`/api/members/${memberId}/photos/upload`, {
        method: 'POST',
        body: formData,
      });
      const res = await fetch(`/api/members/${memberId}/photos`);
      if (res.ok) {
        const photos = await res.json();
        setMemberPhotos(prev => ({ ...prev, [memberId]: photos }));
      }
      onPhotosChanged();
    } catch (err) {
      console.error('Upload error:', err);
    }
    setUploading(null);
  };

  const deletePhoto = async (memberId: number, photoId: number) => {
    if (!useApi) return;
    await fetch(`/api/members/${memberId}/photos/${photoId}`, { method: 'DELETE' });
    const res = await fetch(`/api/members/${memberId}/photos`);
    if (res.ok) {
      const photos = await res.json();
      setMemberPhotos(prev => ({ ...prev, [memberId]: photos }));
    }
    onPhotosChanged();
  };

  const clearAllPhotos = async (memberId: number) => {
    if (!useApi) return;
    await fetch(`/api/members/${memberId}/photos`, { method: 'DELETE' });
    setMemberPhotos(prev => ({ ...prev, [memberId]: [] }));
    onPhotosChanged();
  };

  const addPhotosFromPicker = async (memberId: number, urls: string[]) => {
    console.log('📸 addPhotosFromPicker called!', { memberId, urlCount: urls.length, hasToken: !!photosToken, urls });
    if (!useApi) { console.log('📸 useApi is false, aborting'); return; }
    try {
      // Download photos to server with access token (Google URLs need auth)
      const downloadRes = await fetch(`/api/members/${memberId}/photos/from-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${photosToken}`,
        },
        body: JSON.stringify({ urls }),
      });
      const downloadData = await downloadRes.json();
      console.log('📸 Download result:', downloadData);
      const res = await fetch(`/api/members/${memberId}/photos`);
      if (res.ok) {
        const photos = await res.json();
        console.log('📸 Updated photos for member:', memberId, photos);
        setMemberPhotos(prev => ({ ...prev, [memberId]: photos }));
      }
      onPhotosChanged();
      setPickerMemberId(null);
    } catch (err) {
      console.error('📸 addPhotosFromPicker error:', err);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-slate-800">Члени сім'ї</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        {members.map(member => {
          const photos = memberPhotos[member.id] || [];
          return (
            <div key={member.id} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center text-center">
              <div className="relative mb-4">
                <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white shadow-lg" style={{ backgroundColor: member.color }}>
                  <PhotoSlideshow
                    photos={photos.map(p => p.photo_url)}
                    fallbackUrl={member.avatar_url}
                    color={member.color}
                    mode="avatar"
                  />
                </div>
                {photos.length > 1 && (
                  <span className="absolute -bottom-1 -right-1 bg-indigo-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full">
                    {photos.length}
                  </span>
                )}
              </div>
              <input type="text" value={member.name} onChange={(e) => updateMember(member.id, 'name', e.target.value)}
                className="text-lg font-bold text-slate-800 text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 outline-none transition-colors w-full mb-1" />
              <span className="text-sm text-slate-500 capitalize mb-4">{member.role === 'parent' ? 'Батько/Мати' : 'Дитина'}</span>

              <div className="w-full space-y-3 mt-auto">
                {/* Photo gallery */}
                {photos.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs font-medium text-slate-500">Фото ({photos.length})</label>
                      <button onClick={() => clearAllPhotos(member.id)} className="text-[10px] text-red-400 hover:text-red-600">Очистити все</button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {photos.map(p => (
                        <div key={p.id} className="relative group">
                          <img src={p.photo_url} className="w-10 h-10 rounded object-cover" referrerPolicy="no-referrer" />
                          <button
                            onClick={() => deletePhoto(member.id, p.id)}
                            className="absolute -top-1 -right-1 hidden group-hover:flex w-4 h-4 bg-red-500 text-white rounded-full items-center justify-center text-[8px]"
                          >x</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Upload photos from device */}
                {useApi && (
                  <div>
                    <input
                      ref={el => { fileInputRefs.current[member.id] = el; }}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        if (e.target.files) uploadPhotos(member.id, e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => fileInputRefs.current[member.id]?.click()}
                      disabled={uploading === member.id}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-sm font-medium rounded-lg transition-colors border border-indigo-200 disabled:opacity-50"
                    >
                      {uploading === member.id ? (
                        'Завантаження...'
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                          Додати фото
                        </>
                      )}
                    </button>

                    {/* Google Photos Picker button */}
                    {photosToken && (
                      <GooglePhotosPickerButton
                        accessToken={photosToken}
                        onPhotosSelected={(urls) => addPhotosFromPicker(member.id, urls)}
                      />
                    )}
                  </div>
                )}

                <div>
                  <label className="block text-xs text-left font-medium text-slate-500 mb-1">Колір (HEX)</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={member.color} onChange={(e) => updateMember(member.id, 'color', e.target.value)} className="w-8 h-8 rounded cursor-pointer" />
                    <span className="text-sm font-mono text-slate-600">{member.color}</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Google Photos Picker button component
function GooglePhotosPickerButton({ accessToken, onPhotosSelected }: { accessToken: string; onPhotosSelected: (urls: string[]) => void }) {
  const { startPicking, picking, status, confirmSelection, cancelPicking, hasSession } = useGooglePhotosPicker(accessToken, onPhotosSelected);

  return (
    <div className="mt-2">
      {!picking ? (
        <button
          onClick={startPicking}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 text-green-700 text-sm font-medium rounded-lg transition-colors border border-green-200"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
          Google Photos
        </button>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[11px] text-green-700 text-center font-medium">{status || 'Очікування...'}</p>
          {hasSession && (
            <div className="flex gap-1.5">
              <button
                onClick={confirmSelection}
                className="flex-1 px-2 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded-lg transition-colors"
              >
                Готово — завантажити
              </button>
              <button
                onClick={cancelPicking}
                className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs rounded-lg transition-colors"
              >
                Скасувати
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
