import React, { useState, useEffect } from 'react';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay, addMonths, subMonths, setHours, setMinutes, isWeekend, getYear } from 'date-fns';
import { ru, uk } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Settings, Users, X } from 'lucide-react';
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

export default function App() {
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [activeTab, setActiveTab] = useState<'calendar' | 'settings' | 'members'>('calendar');
  const [monthOffset, setMonthOffset] = useState(0);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);

  const fetchMembers = async () => {
    const res = await fetch('/api/members');
    setMembers(await res.json());
  };

  const fetchEvents = async () => {
    const res = await fetch('/api/events');
    setEvents(await res.json());
  };

  const fetchSettings = async () => {
    const res = await fetch('/api/settings');
    const data = await res.json();
    setMonthOffset(data.monthOffset || 0);
  };

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
    fetchMembers();
    fetchEvents();
    fetchSettings();
    const interval = setInterval(() => {
      fetchEvents();
      fetchSettings();
    }, 5000); // Poll every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const displayDate = addMonths(new Date(), monthOffset);
  
  useEffect(() => {
    fetchHolidays(getYear(displayDate));
  }, [getYear(displayDate)]);

  const monthStart = startOfMonth(displayDate);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
  const endDate = endOfWeek(monthEnd, { weekStartsOn: 1 });
  const dateFormat = "d";
  const days = eachDayOfInterval({ start: startDate, end: endDate });

  const updateMonthOffset = async (newOffset: number) => {
    setMonthOffset(newOffset);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthOffset: newOffset }),
    });
  };

  const nextMonth = () => updateMonthOffset(monthOffset + 1);
  const prevMonth = () => updateMonthOffset(monthOffset - 1);

  const handleCellClick = (day: Date, memberId: number | null) => {
    setSelectedDate(day);
    setSelectedMemberId(memberId);
    setIsModalOpen(true);
  };

  return (
    <div className="h-screen bg-slate-50 text-slate-900 font-sans flex flex-col overflow-hidden">
      <header className="bg-white shadow-sm border-b border-slate-200 p-2 md:p-3 flex items-center justify-between shrink-0 gap-2">
        <div className="flex items-center gap-2 md:gap-4">
          <h1 className="text-lg md:text-xl font-bold text-slate-800 tracking-tight hidden sm:block">Календар</h1>
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
                <div className="flex flex-col flex-1 min-h-0">
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
                            className="px-1 py-0.5 rounded-[3px] text-[9px] md:text-[10px] font-medium leading-none truncate max-w-full"
                            style={{ 
                              backgroundColor: member ? `${member.color}20` : '#f1f5f9',
                              color: member ? member.color : '#475569',
                              borderLeft: `2px solid ${member ? member.color : '#94a3b8'}`
                            }}
                            title={`${format(new Date(event.start_time), 'HH:mm')} ${event.title}`}
                          >
                            <span className="opacity-75 mr-0.5">{format(new Date(event.start_time), 'HH:mm')}</span>
                            {event.title}
                          </div>
                        ))}
                      </div>
                    );

                    return (
                      <div key={day.toString()} className={cn("flex flex-1 border-b border-slate-100 hover:bg-slate-50/50 transition-colors min-h-0", isToday && "bg-indigo-50/30", isWknd && "bg-pink-50/30")}>
                        {/* Date Cell */}
                        <div className={cn("w-20 md:w-28 shrink-0 border-r border-slate-100 flex flex-row", isWknd ? "bg-pink-100/50" : (isToday ? "bg-indigo-50" : "bg-white"))}>
                          {/* Vertical Week Number */}
                          <div className="w-4 md:w-5 shrink-0 flex items-center justify-center border-r border-slate-100/50 bg-slate-50/30">
                            {(day.getDay() === 1 || day.getDate() === 1) && (
                              <span className="text-[7px] md:text-[8px] text-slate-400 uppercase tracking-widest whitespace-nowrap" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                                Тиждень {format(day, 'I')}
                              </span>
                            )}
                          </div>
                          
                          {/* Date & Holidays */}
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
            <SettingsTab />
          </div>
        )}
        {activeTab === 'members' && (
          <div className="overflow-y-auto flex-1">
            <MembersTab members={members} refresh={fetchMembers} />
          </div>
        )}
      </main>

      {/* Event Modal */}
      {isModalOpen && (
        <EventModal 
          isOpen={isModalOpen} 
          onClose={() => setIsModalOpen(false)} 
          selectedDate={selectedDate} 
          selectedMemberId={selectedMemberId} 
          members={members}
          onSave={fetchEvents}
        />
      )}
    </div>
  );
}

function EventModal({ isOpen, onClose, selectedDate, selectedMemberId, members, onSave }: any) {
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
      await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: Number(memberId),
          title,
          start_time: eventDate.toISOString(),
          location
        })
      });
      onSave();
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
            Добавить событие ({format(selectedDate, 'd MMMM', { locale: uk })})
          </h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Название</label>
            <input 
              type="text" 
              required
              value={title}
              onChange={e => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Например: Плавание"
              autoFocus
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Время</label>
              <input 
                type="time" 
                required
                value={time}
                onChange={e => setTime(e.target.value)}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Кто</label>
              <select 
                required
                value={memberId}
                onChange={e => setMemberId(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
              >
                {members.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Место (необязательно)</label>
            <input 
              type="text" 
              value={location}
              onChange={e => setLocation(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Например: Бассейн"
            />
          </div>

          <div className="pt-4 flex justify-end gap-2">
            <button 
              type="button" 
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Отмена
            </button>
            <button 
              type="submit" 
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SettingsTab() {
  const [token, setToken] = useState('');
  const [chatIds, setChatIds] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings').then(res => res.json()).then(data => {
      setToken(data.telegramToken || '');
      setChatIds(data.adminChatIds || '');
    });
  }, []);

  const saveSettings = async () => {
    setSaving(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegramToken: token, adminChatIds: chatIds }),
    });
    setSaving(false);
    alert('Настройки сохранены!');
  };

  return (
    <div className="max-w-2xl mx-auto bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
      <h2 className="text-2xl font-bold mb-6 text-slate-800">Настройки Telegram Бота</h2>
      
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
          <p className="text-sm text-slate-500 mt-2">Получите токен у @BotFather в Telegram.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Admin Chat IDs (через запятую)</label>
          <input
            type="text"
            value={chatIds}
            onChange={e => setChatIds(e.target.value)}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
            placeholder="123456789, 987654321"
          />
          <p className="text-sm text-slate-500 mt-2">Отправьте боту команду /start, чтобы узнать свой Chat ID.</p>
        </div>

        <div className="pt-6 border-t border-slate-200">
          <h3 className="text-lg font-semibold text-slate-800 mb-4">Интеграция с Google Календарем (Опционально)</h3>
          <p className="text-sm text-slate-600 mb-4">
            В данный момент события сохраняются в локальную базу данных, чтобы приложение работало сразу.
            Для интеграции с реальным Google Календарем потребуется создать Service Account в Google Cloud и указать его данные здесь.
          </p>
          <div className="space-y-4 opacity-50 pointer-events-none">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Google Calendar ID</label>
              <input type="text" className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-50" placeholder="family@group.calendar.google.com" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Service Account JSON</label>
              <textarea className="w-full px-4 py-2 border border-slate-300 rounded-lg bg-slate-50 h-24" placeholder="{...}"></textarea>
            </div>
          </div>
        </div>

        <button
          onClick={saveSettings}
          disabled={saving}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {saving ? 'Сохранение...' : 'Сохранить настройки'}
        </button>
      </div>
    </div>
  );
}

function MembersTab({ members, refresh }: { members: Member[], refresh: () => void }) {
  const updateMember = async (id: number, field: string, value: string) => {
    const member = members.find(m => m.id === id);
    if (!member) return;
    
    await fetch(`/api/members/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...member, [field]: value }),
    });
    refresh();
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-bold mb-6 text-slate-800">Члены семьи</h2>
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
            <span className="text-sm text-slate-500 capitalize mb-4">{member.role === 'parent' ? 'Родитель' : 'Ребенок'}</span>
            
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
                <label className="block text-xs text-left font-medium text-slate-500 mb-1">Цвет (HEX)</label>
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
