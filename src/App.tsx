import React, { useState, useEffect, useCallback } from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, addMonths, setHours, setMinutes, isWeekend, getYear, startOfWeek, endOfWeek } from 'date-fns';
import { uk } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Settings, Users, X, Trash2, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

type Member = {
  id: number;
  name: string;
  role: string;
  avatar_url: string;
  color: string;
};

type Event = {
  id: number;
  member_id: number;
  title: string;
  start_time: string;
  end_time: string;
  location: string;
};

type Holiday = {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
};

const DEFAULT_MEMBERS: Member[] = [
  { id: 1, name: 'Папа', role: 'parent', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Dad', color: '#3b82f6' },
  { id: 2, name: 'Мама', role: 'parent', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Mom', color: '#ec4899' },
  { id: 3, name: 'Мирон', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Miron', color: '#10b981' },
  { id: 4, name: 'Дитина 2', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child2', color: '#f59e0b' },
  { id: 5, name: 'Дитина 3', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child3', color: '#8b5cf6' },
  { id: 6, name: 'Дитина 4', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child4', color: '#ef4444' },
  { id: 7, name: 'Дитина 5', role: 'child', avatar_url: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child5', color: '#06b6d4' },
];

// localStorage helpers
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

// Try API first, fallback to localStorage
async function tryApi<T>(url: string, options?: RequestInit): Promise<{ ok: boolean; data?: T }> {
  try {
    const res = await fetch(url, options);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data };
    }
  } catch {
    // API not available
  }
  return { ok: false };
}

export default function App() {
  const [members, setMembers] = useState<Member[]>(() => loadFromStorage('calendar_members', DEFAULT_MEMBERS));
  const [events, setEvents] = useState<Event[]>(() => loadFromStorage('calendar_events', []));
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [activeTab, setActiveTab] = useState<'calendar' | 'settings' | 'members'>('calendar');
  const [monthOffset, setMonthOffset] = useState(() => loadFromStorage('calendar_month_offset', 0));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [useApi, setUseApi] = useState(false);

  // Check if API is available on mount
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
      const result = await tryApi<Event[]>('/api/events');
      if (result.ok && result.data) setEvents(result.data);
    }
  }, [useApi]);

  // Save to localStorage when data changes
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

  const displayDate = addMonths(new Date(), monthOffset);

  useEffect(() => {
    fetchHolidays(getYear(displayDate));
  }, [getYear(displayDate)]);

  const monthStart = startOfMonth(displayDate);
  const monthEnd = endOfMonth(monthStart);

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

  const addEvent = async (event: Omit<Event, 'id'>) => {
    if (useApi) {
      await tryApi('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      });
      fetchEvents();
    } else {
      const newEvent: Event = { ...event, id: Date.now() };
      setEvents(prev => [...prev, newEvent]);
    }
  };

  const deleteEvent = (eventId: number) => {
    setEvents(prev => prev.filter(e => e.id !== eventId));
  };

  return (
    <div className="h-screen bg-slate-50 text-slate-900 font-sans flex flex-col overflow-hidden">
      <header className="bg-white shadow-sm border-b border-slate-200 p-2 md:p-3 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2 md:gap-4">
          <h1 className="text-lg md:text-xl font-bold text-slate-800 tracking-tight hidden sm:block">📅 Сімейний Календар</h1>
          {activeTab === 'calendar' && (
            <div className="flex items-center gap-1 md:gap-2 bg-slate-50 px-1 md:px-2 py-1 rounded-lg border border-slate-100">
              <button onClick={prevMonth} className="p-1 md:p-1.5 rounded-full hover:bg-slate-200 transition-colors">
                <ChevronLeft className="w-4 h-4 md:w-5 md:h-5 text-slate-600" />
              </button>
              <h2 className="text-base md:text-lg font-semibold capitalize text-slate-800 min-w-[110px] md:min-w-[130px] text-center">
                {format(displayDate, 'LLLL yyyy', { locale: uk })}
              </h2>
              <button onClick={nextMonth} className="p-1 md:p-1.5 rounded-full hover:bg-slate-200 transition-colors">
                <ChevronRight className="w-4 h-4 md:w-5 md:h-5 text-slate-600" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 md:gap-2">
          {!useApi && (
            <span className="text-[10px] md:text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full font-medium">Demo режим</span>
          )}
          <button onClick={() => setActiveTab('calendar')} className={cn("px-2 py-1.5 md:px-3 md:py-2 rounded-lg font-medium transition-colors text-xs md:text-sm", activeTab === 'calendar' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            Календар
          </button>
          <button onClick={() => setActiveTab('members')} className={cn("p-1.5 md:p-2 rounded-lg transition-colors", activeTab === 'members' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            <Users className="w-4 h-4 md:w-5 md:h-5" />
          </button>
          <button onClick={() => setActiveTab('settings')} className={cn("p-1.5 md:p-2 rounded-lg transition-colors", activeTab === 'settings' ? "bg-indigo-100 text-indigo-700" : "text-slate-600 hover:bg-slate-100")}>
            <Settings className="w-4 h-4 md:w-5 md:h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 p-2 md:p-4 w-full flex flex-col min-h-0">
        {activeTab === 'calendar' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col flex-1 min-h-0 overflow-hidden">
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex flex-col flex-1 min-h-0 border-t border-slate-200">
                {/* Header */}
                <div className="flex bg-slate-50 border-b border-slate-200 shadow-[0_1px_2px_rgba(0,0,0,0.05)] shrink-0">
                  <div className="w-20 md:w-28 shrink-0 p-1 md:p-2 text-center font-semibold text-slate-500 border-r border-slate-200 flex items-center justify-center text-[10px] md:text-xs">Дата</div>
                  {members.map(m => (
                    <div key={m.id} className="flex-1 p-1 md:p-2 text-center font-semibold text-slate-500 border-r border-slate-200 flex flex-col items-center gap-0.5 min-w-0">
                      <img src={m.avatar_url} alt={m.name} className="w-5 h-5 md:w-6 md:h-6 rounded-full object-cover bg-white" style={{ borderColor: m.color, borderWidth: 2 }} />
                      <span className="truncate w-full text-[9px] md:text-[10px] uppercase tracking-wider">{m.name}</span>
                    </div>
                  ))}
                </div>

                {/* Body */}
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
                  {eachDayOfInterval({ start: monthStart, end: monthEnd }).map(day => {
                    const isToday = isSameDay(day, new Date());
                    const isWknd = isWeekend(day);
                    const dayHolidays = holidays.filter(h => h.date === format(day, 'yyyy-MM-dd'));
                    const dayEvents = events.filter(e => isSameDay(new Date(e.start_time), day));

                    const renderEvents = (cellEvents: Event[], member?: Member) => (
                      <div className="flex flex-wrap gap-0.5 h-full overflow-hidden items-start content-start">
                        {cellEvents.map(event => (
                          <div
                            key={event.id}
                            className="group px-1 py-0.5 rounded-[3px] text-[9px] md:text-[10px] font-medium leading-none truncate max-w-full flex items-center gap-0.5"
                            style={{
                              backgroundColor: member ? `${member.color}20` : '#f1f5f9',
                              color: member ? member.color : '#475569',
                              borderLeft: `2px solid ${member ? member.color : '#94a3b8'}`
                            }}
                            title={`${format(new Date(event.start_time), 'HH:mm')} ${event.title}`}
                          >
                            <span className="opacity-75 mr-0.5">{format(new Date(event.start_time), 'HH:mm')}</span>
                            {event.title}
                            {!useApi && (
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteEvent(event.id); }}
                                className="hidden group-hover:inline-flex ml-auto p-0.5 rounded hover:bg-red-100 text-red-400 hover:text-red-600"
                              >
                                <Trash2 className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    );

                    return (
                      <div key={day.toString()} className={cn("flex flex-1 border-b border-slate-100 hover:bg-slate-50/50 transition-colors min-h-[32px]", isToday && "bg-indigo-50/30", isWknd && "bg-pink-50/30")}>
                        {/* Date Cell */}
                        <div className={cn("w-20 md:w-28 shrink-0 border-r border-slate-100 flex flex-row", isWknd ? "bg-pink-100/50" : (isToday ? "bg-indigo-50" : "bg-white"))}>
                          <div className="w-4 md:w-5 shrink-0 flex items-center justify-center border-r border-slate-100/50 bg-slate-50/30">
                            {(day.getDay() === 1 || day.getDate() === 1) && (
                              <span className="text-[7px] md:text-[8px] text-slate-400 uppercase tracking-widest whitespace-nowrap" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                                Тиждень {format(day, 'I')}
                              </span>
                            )}
                          </div>
                          <div className="flex-1 flex flex-col items-center justify-center p-1 text-center min-w-0">
                            <div className="flex items-baseline gap-1">
                              <span className={cn("text-sm md:text-base font-bold leading-tight", isWknd ? "text-pink-600" : (isToday ? "text-indigo-600" : "text-slate-700"))}>
                                {format(day, 'd')}
                              </span>
                              <span className={cn("text-[9px] md:text-[10px] uppercase font-medium", isWknd ? "text-pink-500" : (isToday ? "text-indigo-500" : "text-slate-500"))}>
                                {format(day, 'EEEEEE', { locale: uk })}
                              </span>
                            </div>
                            {dayHolidays.length > 0 && (
                              <div className="mt-1 flex flex-col gap-0.5 w-full px-0.5">
                                {dayHolidays.map((h, i) => (
                                  <span key={i} className="text-[6px] md:text-[7px] leading-tight bg-white/60 border border-slate-200/50 text-slate-600 rounded px-1 py-0.5 truncate w-full" title={h.localName}>
                                    {h.countryCode === 'NO' ? '🇳🇴' : '🇺🇦'} {h.localName}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Member Cells */}
                        {members.map(m => (
                          <div
                            key={m.id}
                            className="flex-1 p-0.5 border-r border-slate-100 min-w-0 overflow-hidden cursor-pointer hover:brightness-95 transition-all"
                            style={{ backgroundColor: `${m.color}05` }}
                            onClick={() => handleCellClick(day, m.id)}
                          >
                            {renderEvents(dayEvents.filter(e => e.member_id === m.id), m)}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="overflow-y-auto flex-1">
            <SettingsTab useApi={useApi} />
          </div>
        )}
        {activeTab === 'members' && (
          <div className="overflow-y-auto flex-1">
            <MembersTab members={members} setMembers={setMembers} useApi={useApi} />
          </div>
        )}
      </main>

      {isModalOpen && (
        <EventModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          selectedDate={selectedDate}
          selectedMemberId={selectedMemberId}
          members={members}
          onSave={addEvent}
        />
      )}
    </div>
  );
}

function EventModal({ isOpen, onClose, selectedDate, selectedMemberId, members, onSave }: {
  isOpen: boolean;
  onClose: () => void;
  selectedDate: Date;
  selectedMemberId: number | null;
  members: Member[];
  onSave: (event: Omit<Event, 'id'>) => void;
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
            <input
              type="text"
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Наприклад: Плавання"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Час</label>
              <input
                type="time"
                required
                value={time}
                onChange={e => setTime(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Хто</label>
              <select
                required
                value={memberId}
                onChange={e => setMemberId(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Місце (необов'язково)</label>
            <input
              type="text"
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Наприклад: Басейн"
            />
          </div>

          <div className="pt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Скасувати
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Зберігаю...' : 'Зберегти'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
    <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
      <h2 className="text-2xl font-bold mb-6 text-slate-800">Налаштування Telegram Бота</h2>

      {!useApi && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            <strong>Demo режим:</strong> Застосунок працює без серверу. Дані зберігаються в браузері (localStorage).
            Для повної функціональності (Telegram бот, Gemini AI) потрібен бекенд-сервер.
          </p>
        </div>
      )}

      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Telegram Bot Token</label>
          <input
            type="text"
            value={token}
            onChange={e => setToken(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
            placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
          />
          <p className="text-sm text-slate-500 mt-2">Отримайте токен у @BotFather в Telegram.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Admin Chat IDs (через кому)</label>
          <input
            type="text"
            value={chatIds}
            onChange={e => setChatIds(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
            placeholder="123456789, 987654321"
          />
          <p className="text-sm text-slate-500 mt-2">Надішліть боту команду /start, щоб дізнатися свій Chat ID.</p>
        </div>

        <div className="pt-6 border-t border-slate-200">
          <h3 className="text-lg font-semibold text-slate-800 mb-4">Інтеграція з Google Календарем (Опціонально)</h3>
          <p className="text-sm text-slate-600 mb-4">
            Наразі події зберігаються локально. Для інтеграції з Google Календарем потрібен Service Account.
          </p>
          <div className="space-y-4 opacity-50 pointer-events-none">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Google Calendar ID</label>
              <input type="text" className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-50" placeholder="family@group.calendar.google.com" />
            </div>
          </div>
        </div>

        <button
          onClick={saveSettings}
          disabled={saving}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Зберігаю...' : 'Зберегти налаштування'}
        </button>
      </div>
    </div>
  );
}

function MembersTab({ members, setMembers, useApi }: { members: Member[]; setMembers: React.Dispatch<React.SetStateAction<Member[]>>; useApi: boolean }) {
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

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-slate-800">Члени сім'ї</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        {members.map(member => (
          <div key={member.id} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col items-center text-center">
            <div className="relative mb-4">
              <div className="w-24 h-24 rounded-full overflow-hidden border-4 border-white shadow-lg" style={{ backgroundColor: member.color }}>
                <img src={member.avatar_url} alt={member.name} className="w-full h-full object-cover" />
              </div>
            </div>
            <input
              type="text"
              value={member.name}
              onChange={(e) => updateMember(member.id, 'name', e.target.value)}
              className="text-lg font-bold text-slate-800 text-center bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 outline-none transition-colors w-full mb-1"
            />
            <span className="text-sm text-slate-500 capitalize mb-4">{member.role === 'parent' ? 'Батько/Мати' : 'Дитина'}</span>

            <div className="w-full space-y-3 mt-auto">
              <div>
                <label className="block text-xs text-left font-medium text-slate-500 mb-1">URL Аватара</label>
                <input
                  type="text"
                  value={member.avatar_url}
                  onChange={(e) => updateMember(member.id, 'avatar_url', e.target.value)}
                  className="w-full text-sm px-2 py-1 border border-slate-200 rounded focus:ring-1 focus:ring-indigo-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-left font-medium text-slate-500 mb-1">Колір (HEX)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={member.color}
                    onChange={(e) => updateMember(member.id, 'color', e.target.value)}
                    className="w-8 h-8 rounded cursor-pointer"
                  />
                  <span className="text-sm font-mono text-slate-600">{member.color}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
