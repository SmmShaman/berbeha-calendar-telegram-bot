import express from 'express';
import { createServer as createViteServer } from 'vite';
import Database from 'better-sqlite3';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize SQLite Database
const dbDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir);
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
`);

// Pre-populate family members if empty
const countMembers = db.prepare('SELECT COUNT(*) as count FROM members').get() as { count: number };
if (countMembers.count === 0) {
  const insertMember = db.prepare('INSERT INTO members (name, role, avatar_url, color) VALUES (?, ?, ?, ?)');
  insertMember.run('Папа', 'parent', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Dad', '#3b82f6');
  insertMember.run('Мама', 'parent', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Mom', '#ec4899');
  insertMember.run('Мирон', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Miron', '#10b981');
  insertMember.run('Ребенок 2', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child2', '#f59e0b');
  insertMember.run('Ребенок 3', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child3', '#8b5cf6');
  insertMember.run('Ребенок 4', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child4', '#ef4444');
  insertMember.run('Ребенок 5', 'child', 'https://api.dicebear.com/9.x/avataaars/svg?seed=Child5', '#06b6d4');
}

// Helper functions for settings
const getSetting = (key: string) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
};

const setSetting = (key: string, value: string) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
};

// API Routes
app.get('/api/settings', (req, res) => {
  const telegramToken = getSetting('telegram_token') || '';
  const adminChatIds = getSetting('admin_chat_ids') || '';
  const monthOffset = parseInt(getSetting('month_offset') || '0', 10);
  res.json({ telegramToken, adminChatIds, monthOffset });
});

app.post('/api/settings', async (req, res) => {
  const { telegramToken, adminChatIds, monthOffset } = req.body;
  if (telegramToken !== undefined) setSetting('telegram_token', telegramToken);
  if (adminChatIds !== undefined) setSetting('admin_chat_ids', adminChatIds);
  if (monthOffset !== undefined) setSetting('month_offset', monthOffset.toString());

  // Setup webhook if token provided
  if (telegramToken) {
    const appUrl = process.env.APP_URL;
    if (appUrl) {
      try {
        const webhookUrl = `${appUrl}/api/telegram/webhook`;
        const response = await fetch(`https://api.telegram.org/bot${telegramToken}/setWebhook?url=${webhookUrl}`);
        const data = await response.json();
        console.log('Webhook setup response:', data);
      } catch (err) {
        console.error('Failed to set webhook:', err);
      }
    }
  }

  res.json({ success: true });
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

// Telegram Webhook
app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body;
    if (!update.message) return res.sendStatus(200);

    const chatId = update.message.chat.id.toString();
    const adminChatIds = (getSetting('admin_chat_ids') || '').split(',').map((id: string) => id.trim());

    const telegramToken = getSetting('telegram_token');
    if (!telegramToken) return res.sendStatus(200);

    const sendMessage = async (text: string) => {
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    };

    if (update.message.text === '/start') {
      await sendMessage(`Привет! Твой Chat ID: ${chatId}. Добавь его в настройки администраторов в веб-интерфейсе.`);
      return res.sendStatus(200);
    }

    if (update.message.text === '/next') {
      const currentOffset = parseInt(getSetting('month_offset') || '0', 10);
      setSetting('month_offset', (currentOffset + 1).toString());
      await sendMessage('Календарь переключен на следующий месяц.');
      return res.sendStatus(200);
    }

    if (update.message.text === '/prev') {
      const currentOffset = parseInt(getSetting('month_offset') || '0', 10);
      setSetting('month_offset', (currentOffset - 1).toString());
      await sendMessage('Календарь переключен на предыдущий месяц.');
      return res.sendStatus(200);
    }

    if (update.message.text === '/today') {
      setSetting('month_offset', '0');
      await sendMessage('Календарь переключен на текущий месяц.');
      return res.sendStatus(200);
    }

    if (!adminChatIds.includes(chatId)) {
      await sendMessage('У вас нет прав администратора для добавления событий.');
      return res.sendStatus(200);
    }

    let textToProcess = update.message.text;
    let audioBase64 = null;

    if (update.message.voice) {
      const fileId = update.message.voice.file_id;
      const fileRes = await fetch(`https://api.telegram.org/bot${telegramToken}/getFile?file_id=${fileId}`);
      const fileData = await fileRes.json();
      if (fileData.ok) {
        const filePath = fileData.result.file_path;
        const audioRes = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${filePath}`);
        const arrayBuffer = await audioRes.arrayBuffer();
        audioBase64 = Buffer.from(arrayBuffer).toString('base64');
      }
    }

    if (!textToProcess && !audioBase64) {
      return res.sendStatus(200);
    }

    // Process with Gemini
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const members = db.prepare('SELECT id, name FROM members').all();
    const membersList = members.map((m: any) => `${m.id}: ${m.name}`).join(', ');

    const prompt = `
      Ты помощник для семейного календаря. Извлеки информацию о событии из сообщения пользователя.
      Текущая дата и время: ${new Date().toISOString()}.
      Члены семьи (ID: Имя): ${membersList}.
      
      Определи:
      - memberId (ID члена семьи, к которому относится событие. Если не указано, выбери 0 или null)
      - title (Название события)
      - startTime (ISO 8601 формат)
      - endTime (ISO 8601 формат, если не указано, сделай на 1 час позже startTime)
      - location (Место проведения, если есть)
    `;

    const parts: any[] = [];
    if (audioBase64) {
      parts.push({
        inlineData: {
          data: audioBase64,
          mimeType: 'audio/ogg',
        },
      });
      parts.push({ text: prompt });
    } else {
      parts.push({ text: prompt + "\\nСообщение: " + textToProcess });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: { parts },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            memberId: { type: Type.INTEGER },
            title: { type: Type.STRING },
            startTime: { type: Type.STRING },
            endTime: { type: Type.STRING },
            location: { type: Type.STRING },
          },
          required: ['title', 'startTime', 'endTime'],
        },
      },
    });

    const resultText = response.text;
    if (resultText) {
      const eventData = JSON.parse(resultText);
      
      db.prepare('INSERT INTO events (member_id, title, start_time, end_time, location) VALUES (?, ?, ?, ?, ?)')
        .run(eventData.memberId || null, eventData.title, eventData.startTime, eventData.endTime, eventData.location || '');
      
      const member = members.find((m: any) => m.id === eventData.memberId);
      const memberName = member ? member.name : 'Семья';
      const dateStr = new Date(eventData.startTime).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
      
      await sendMessage(`✅ Событие добавлено:\n${eventData.title}\nКто: ${memberName}\nКогда: ${dateStr}\nГде: ${eventData.location || 'Не указано'}`);
    }

  } catch (error) {
    console.error('Webhook error:', error);
  }
  res.sendStatus(200);
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
