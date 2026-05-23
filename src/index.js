const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RATE = 79;
const MIN_RUB = 4000;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN not set.');
  process.exit(1);
}

// ── Timezone helper (MSK = UTC+3) ─────────────────────────────────────────────
function mskNow() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

function formatMsk(isoOrSqlite) {
  if (!isoOrSqlite) return '—';
  // sqlite stores UTC datetime('now') without Z, treat as UTC
  const d = new Date(isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite + 'Z');
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return msk.toLocaleString('ru-RU', { timeZone: 'UTC' }); // already shifted
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './eclipse.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id       INTEGER PRIMARY KEY,
    username    TEXT,
    first_name  TEXT,
    last_name   TEXT,
    balance     REAL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id       INTEGER,
    type        TEXT,
    usdt        REAL,
    rub         REAL,
    requisites  TEXT,
    check_url   TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  );
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function verifyTelegramData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (computed !== hash) return null;
  const userParam = params.get('user');
  return userParam ? JSON.parse(userParam) : null;
}

function upsertUser(tgUser) {
  db.prepare(`
    INSERT INTO users (tg_id, username, first_name, last_name)
    VALUES (@tg_id, @username, @first_name, @last_name)
    ON CONFLICT(tg_id) DO UPDATE SET
      username   = excluded.username,
      first_name = excluded.first_name,
      last_name  = excluded.last_name
  `).run({
    tg_id: tgUser.id,
    username: tgUser.username || null,
    first_name: tgUser.first_name || null,
    last_name: tgUser.last_name || null,
  });
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgUser.id);
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  upsertUser({
    id: msg.from.id,
    username: msg.from.username,
    first_name: msg.from.first_name,
    last_name: msg.from.last_name,
  });
  const webAppUrl = process.env.WEBAPP_URL || 'https://your-app.railway.app';
  bot.sendMessage(msg.chat.id,
    `👋 Привет, ${msg.from.first_name || 'друг'}!\n\nДобро пожаловать в *Eclipse Exchange* — обмен USDT → ₽ по фиксированному курсу.\n\n💰 Курс: *79 ₽/USDT*\n📊 Без скрытых комиссий`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🌑 Открыть обменник', web_app: { url: webAppUrl } }
        ]]
      }
    }
  );
});

// ── Notify manager ────────────────────────────────────────────────────────────
async function notifyManager(order, user) {
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!managerChatId) return;

  const typeLabel = order.type === 'exchange' ? '🔄 Обмен USDT→₽' : '📥 Пополнение баланса';
  const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
  const time = formatMsk(order.created_at);

  let text = `${typeLabel}\n\n`;
  text += `👤 Пользователь: ${userTag} (${user.first_name || ''})\n`;
  text += `🆔 ID заявки: #${order.id}\n`;

  if (order.type === 'exchange') {
    text += `💵 Отдаёт: ${order.usdt} USDT\n`;
    text += `💴 Получает: ${Math.round(order.rub).toLocaleString('ru-RU')} ₽\n`;
    text += `🏦 Реквизиты: ${order.requisites}\n`;
  } else {
    text += `💵 Сумма: ${order.usdt} USDT\n`;
    if (order.check_url) text += `🔗 Чек: ${order.check_url}\n`;
  }

  text += `\n⏰ ${time} МСК`;

  try {
    await bot.sendMessage(managerChatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Выполнено', callback_data: `done_${order.id}` },
          { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
        ]]
      }
    });
  } catch (e) {
    console.error('Failed to notify manager:', e.message);
  }
}

// ── Manager callbacks ─────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const [action, orderId] = query.data.split('_');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(orderId));
  if (!order) return;

  if (action === 'done') {
    db.prepare("UPDATE orders SET status = 'done' WHERE id = ?").run(order.id);
    if (order.type === 'deposit') {
      db.prepare('UPDATE users SET balance = balance + ? WHERE tg_id = ?').run(order.usdt, order.tg_id);
    }
    try {
      await bot.sendMessage(order.tg_id,
        `✅ Заявка #${order.id} выполнена!\n\n` +
        (order.type === 'exchange'
          ? `💴 ${Math.round(order.rub).toLocaleString('ru-RU')} ₽ отправлены на ваши реквизиты.`
          : `💵 ${order.usdt} USDT зачислены на ваш баланс.`)
      );
    } catch (e) {}
    await bot.answerCallbackQuery(query.id, { text: '✅ Выполнено' });
    await bot.editMessageText(query.message.text + '\n\n✅ ВЫПОЛНЕНО', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});
  }

  if (action === 'cancel') {
    db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    // If exchange was cancelled — refund balance
    if (order.type === 'exchange') {
      db.prepare('UPDATE users SET balance = balance + ? WHERE tg_id = ?').run(order.usdt, order.tg_id);
    }
    try {
      await bot.sendMessage(order.tg_id,
        `❌ Заявка #${order.id} отклонена.\nЕсли есть вопросы — напишите менеджеру.`
      );
    } catch (e) {}
    await bot.answerCallbackQuery(query.id, { text: '❌ Отклонено' });
    await bot.editMessageText(query.message.text + '\n\n❌ ОТКЛОНЕНО', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
    }).catch(() => {});
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  req.tgUser = tgUser;
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/me
app.get('/api/me', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_orders,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_orders,
      SUM(CASE WHEN type='exchange' AND status='done' THEN usdt ELSE 0 END) as total_usdt
    FROM orders WHERE tg_id = ?
  `).get(user.tg_id);

  res.json({
    id: user.tg_id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    balance: user.balance,
    created_at: user.created_at,
    stats: {
      total_orders: stats.total_orders || 0,
      done_orders: stats.done_orders || 0,
      total_usdt: stats.total_usdt || 0,
    }
  });
});

// GET /api/orders
app.get('/api/orders', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const orders = db.prepare(
    'SELECT * FROM orders WHERE tg_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(user.tg_id);
  res.json(orders);
});

// POST /api/exchange — requires balance
app.post('/api/exchange', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const { usdt, requisites } = req.body;

  if (!usdt || typeof usdt !== 'number' || usdt <= 0)
    return res.status(400).json({ error: 'Некорректная сумма USDT' });

  const rub = usdt * RATE;
  if (rub < MIN_RUB)
    return res.status(400).json({ error: `Минимальная сумма — ${MIN_RUB} ₽ (~${(MIN_RUB/RATE).toFixed(2)} USDT)` });

  if (!requisites || requisites.trim().length < 5)
    return res.status(400).json({ error: 'Укажите реквизиты для получения ₽' });

  if (user.balance < usdt)
    return res.status(400).json({
      error: `Недостаточно средств. Баланс: ${user.balance.toFixed(2)} USDT. Пополните баланс перед обменом.`,
      code: 'INSUFFICIENT_BALANCE',
      balance: user.balance,
    });

  db.prepare('UPDATE users SET balance = balance - ? WHERE tg_id = ?').run(usdt, user.tg_id);

  const order = db.prepare(`
    INSERT INTO orders (tg_id, type, usdt, rub, requisites, status)
    VALUES (?, 'exchange', ?, ?, ?, 'pending')
  `).run(user.tg_id, usdt, rub, requisites.trim());

  const newOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.lastInsertRowid);
  notifyManager(newOrder, user);

  const newBalance = user.balance - usdt;
  res.json({ success: true, order: newOrder, balance: newBalance });
});

// POST /api/deposit — manual amount + check link, manager confirms
app.post('/api/deposit', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const { check_url, usdt } = req.body;

  if (!check_url || typeof check_url !== 'string')
    return res.status(400).json({ error: 'Ссылка на чек обязательна' });

  const isValid = check_url.includes('t.me/CryptoBot') ||
                  check_url.includes('t.me/xRocket');
  if (!isValid)
    return res.status(400).json({ error: 'Принимаются только чеки Crypto Bot и xRocket' });

  const usdtAmount = parseFloat(usdt);
  if (!usdtAmount || usdtAmount <= 0)
    return res.status(400).json({ error: 'Укажите сумму пополнения' });

  const order = db.prepare(`
    INSERT INTO orders (tg_id, type, usdt, rub, check_url, status)
    VALUES (?, 'deposit', ?, 0, ?, 'pending')
  `).run(user.tg_id, usdtAmount, check_url.trim());

  const newOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.lastInsertRowid);
  notifyManager(newOrder, user);

  res.json({ success: true, order: newOrder });
});

// ── Static ────────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌑 Eclipse Exchange running on port ${PORT}`);
  console.log(`📡 Bot polling active`);
  console.log(`🌐 WebApp: ${process.env.WEBAPP_URL || 'set WEBAPP_URL env var'}\n`);
});
