const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RATE = 79;
const MIN_RUB = 4000;
const TERMS_URL = 'https://telegra.ph/Eclipse-Exchange-05-23';

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN not set.'); process.exit(1); }

// ── MSK time ─────────────────────────────────────────────────────────────────
function formatMsk(isoOrSqlite) {
  if (!isoOrSqlite) return '—';
  const str = isoOrSqlite.includes('T') ? isoOrSqlite : isoOrSqlite + 'Z';
  const msk = new Date(new Date(str).getTime() + 3 * 60 * 60 * 1000);
  return msk.toLocaleString('ru-RU', { timeZone: 'UTC',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit' }) + ' МСК';
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './eclipse.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    tg_id        INTEGER PRIMARY KEY,
    username     TEXT,
    first_name   TEXT,
    last_name    TEXT,
    balance      REAL DEFAULT 0,
    agreed       INTEGER DEFAULT 0,
    blocked      INTEGER DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id        INTEGER,
    type         TEXT,
    usdt         REAL DEFAULT 0,
    rub          REAL DEFAULT 0,
    requisites   TEXT,
    check_url    TEXT,
    status       TEXT DEFAULT 'pending',
    created_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (tg_id) REFERENCES users(tg_id)
  );
`);
// migrate: add columns if missing
['agreed INTEGER DEFAULT 0','blocked INTEGER DEFAULT 0'].forEach(col => {
  try { db.prepare(`ALTER TABLE users ADD COLUMN ${col}`).run(); } catch(e) {}
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function verifyTelegramData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const sorted = [...params.entries()].sort(([a],[b]) => a.localeCompare(b));
  const dcs = sorted.map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256',secret).update(dcs).digest('hex');
  if (computed !== hash) return null;
  const u = params.get('user');
  return u ? JSON.parse(u) : null;
}

function upsertUser(tgUser) {
  db.prepare(`
    INSERT INTO users (tg_id, username, first_name, last_name)
    VALUES (@tg_id, @username, @first_name, @last_name)
    ON CONFLICT(tg_id) DO UPDATE SET
      username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name
  `).run({ tg_id: tgUser.id, username: tgUser.username||null,
           first_name: tgUser.first_name||null, last_name: tgUser.last_name||null });
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgUser.id);
}

function isAdmin(tgId) {
  const adminId = process.env.MANAGER_CHAT_ID;
  return adminId && String(tgId) === String(adminId);
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const webAppUrl = () => process.env.WEBAPP_URL || 'https://your-app.railway.app';

bot.onText(/\/start/, (msg) => {
  const user = upsertUser({ id: msg.from.id, username: msg.from.username,
    first_name: msg.from.first_name, last_name: msg.from.last_name });

  if (user.blocked) {
    return bot.sendMessage(msg.chat.id, '🚫 Ваш аккаунт заблокирован. Обратитесь в поддержку.');
  }

  if (!user.agreed) {
    return bot.sendMessage(msg.chat.id,
      `👋 Привет, *${msg.from.first_name || 'друг'}*!\n\nДобро пожаловать в *Eclipse Exchange*.\n\nПеред началом работы ознакомьтесь с пользовательским соглашением и примите его.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📄 Читать соглашение', url: TERMS_URL }],
            [{ text: '✅ Принять и продолжить', callback_data: 'agree' }],
          ]
        }
      }
    );
  }

  sendMainMenu(msg.chat.id, msg.from.first_name);
});

// Admin commands
bot.onText(/\/admin/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const adminUrl = webAppUrl() + '/admin.html';
  bot.sendMessage(msg.chat.id, '🛡 Админ-панель:', {
    reply_markup: { inline_keyboard: [[{ text: '🛡 Открыть панель', web_app: { url: adminUrl } }]] }
  });
});

bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  sendStats(msg.chat.id);
});

function sendMainMenu(chatId, firstName) {
  bot.sendMessage(chatId,
    `🌑 *Eclipse Exchange*\n\nОбмен USDT → ₽ по фиксированному курсу.\n\n💰 Курс: *79 ₽/USDT*\n📊 Без скрытых комиссий`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🌑 Открыть обменник', web_app: { url: webAppUrl() } }]] }
    }
  );
}

async function sendStats(chatId) {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE agreed=1").get().c;
  const activeUsers = db.prepare("SELECT COUNT(DISTINCT tg_id) as c FROM orders WHERE created_at >= datetime('now','-30 days')").get().c;
  const monthOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at >= datetime('now','-30 days')").get().c;
  const totalRub = db.prepare("SELECT COALESCE(SUM(rub),0) as s FROM orders WHERE type='exchange' AND status='done'").get().s;
  const totalUsdt = db.prepare("SELECT COALESCE(SUM(usdt),0) as s FROM orders WHERE type='exchange' AND status='done'").get().s;
  const pending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending'").get().c;

  bot.sendMessage(chatId,
    `📊 *Статистика Eclipse Exchange*\n\n` +
    `👥 Пользователей всего: *${totalUsers}*\n` +
    `📅 Активных за месяц: *${activeUsers}*\n` +
    `📋 Заявок за месяц: *${monthOrders}*\n` +
    `⏳ Ожидают выполнения: *${pending}*\n\n` +
    `💴 Оборот (₽): *${Math.round(totalRub).toLocaleString('ru-RU')} ₽*\n` +
    `💵 Оборот (USDT): *${totalUsdt.toFixed(2)} USDT*`,
    { parse_mode: 'Markdown' }
  );
}

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const data = query.data;
  const tgId = query.from.id;

  // Agreement
  if (data === 'agree') {
    db.prepare('UPDATE users SET agreed=1 WHERE tg_id=?').run(tgId);
    await bot.answerCallbackQuery(query.id, { text: '✅ Соглашение принято!' });
    await bot.editMessageText(
      `✅ Соглашение принято!\n\nТеперь вы можете пользоваться сервисом.`,
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    ).catch(() => {});
    return sendMainMenu(tgId, query.from.first_name);
  }

  // Order actions (done / cancel)
  if (data.startsWith('done_') || data.startsWith('cancel_')) {
    const [action, orderId] = data.split('_');
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(orderId));
    if (!order) return bot.answerCallbackQuery(query.id, { text: 'Заявка не найдена' });

    if (action === 'done') {
      db.prepare("UPDATE orders SET status='done' WHERE id=?").run(order.id);
      if (order.type === 'deposit') {
        db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(order.usdt, order.tg_id);
      }
      try {
        await bot.sendMessage(order.tg_id,
          `✅ Заявка #${order.id} выполнена!\n\n` +
          (order.type === 'exchange'
            ? `💴 ${Math.round(order.rub).toLocaleString('ru-RU')} ₽ отправлены на ваши реквизиты.`
            : order.type === 'withdrawal'
            ? `💵 Чек на ${order.usdt} USDT отправлен в этот чат.`
            : `💵 ${order.usdt} USDT зачислены на ваш баланс.`)
        );
      } catch(e) {}
      await bot.answerCallbackQuery(query.id, { text: '✅ Выполнено' });
      await bot.editMessageText(query.message.text + '\n\n✅ ВЫПОЛНЕНО', {
        chat_id: query.message.chat.id, message_id: query.message.message_id
      }).catch(() => {});
    }

    if (action === 'cancel') {
      db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
      if (order.type === 'exchange' || order.type === 'withdrawal') {
        db.prepare('UPDATE users SET balance=balance+? WHERE tg_id=?').run(order.usdt, order.tg_id);
      }
      try {
        await bot.sendMessage(order.tg_id,
          `❌ Заявка #${order.id} отклонена.\nЕсли есть вопросы — напишите менеджеру.`
        );
      } catch(e) {}
      await bot.answerCallbackQuery(query.id, { text: '❌ Отклонено' });
      await bot.editMessageText(query.message.text + '\n\n❌ ОТКЛОНЕНО', {
        chat_id: query.message.chat.id, message_id: query.message.message_id
      }).catch(() => {});
    }
  }
});

// ── Notify manager ────────────────────────────────────────────────────────────
async function notifyManager(order, user) {
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!managerChatId) return;
  const typeLabel = { exchange:'🔄 Обмен USDT→₽', deposit:'📥 Пополнение', withdrawal:'📤 Вывод USDT' }[order.type] || '📋 Заявка';
  const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
  let text = `${typeLabel}\n\n👤 ${userTag} (${user.first_name||''})\n🆔 Заявка: #${order.id}\n`;
  if (order.type === 'exchange') {
    text += `💵 Отдаёт: ${order.usdt} USDT\n💴 Получает: ${Math.round(order.rub).toLocaleString('ru-RU')} ₽\n🏦 Реквизиты: ${order.requisites}\n`;
  } else if (order.type === 'deposit') {
    text += `💵 Сумма: ${order.usdt} USDT\n🔗 Чек: ${order.check_url}\n`;
  } else if (order.type === 'withdrawal') {
    text += `💵 Сумма: ${order.usdt} USDT\n📝 Примечание: отправьте чек пользователю в ЛС\n`;
  }
  text += `⏰ ${formatMsk(order.created_at)}`;
  try {
    await bot.sendMessage(managerChatId, text, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${order.id}` },
        { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
      ]]}
    });
  } catch(e) { console.error('Notify manager error:', e.message); }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.prepare('SELECT * FROM users WHERE tg_id=?').get(tgUser.id);
  if (user && user.blocked) return res.status(403).json({ error: 'Заблокирован' });
  req.tgUser = tgUser;
  next();
}

function adminMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser || !isAdmin(tgUser.id)) return res.status(403).json({ error: 'Forbidden' });
  req.tgUser = tgUser;
  next();
}

// ── API: User ─────────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const stats = db.prepare(`
    SELECT COUNT(*) as total_orders,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done_orders,
      SUM(CASE WHEN type='exchange' AND status='done' THEN usdt ELSE 0 END) as total_usdt
    FROM orders WHERE tg_id=?`).get(user.tg_id);
  res.json({ id:user.tg_id, username:user.username, first_name:user.first_name,
    last_name:user.last_name, balance:user.balance, agreed:user.agreed,
    created_at:user.created_at, stats:{
      total_orders:stats.total_orders||0, done_orders:stats.done_orders||0,
      total_usdt:stats.total_usdt||0 }});
});

app.get('/api/orders', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const orders = db.prepare('SELECT * FROM orders WHERE tg_id=? ORDER BY created_at DESC LIMIT 50').all(user.tg_id);
  res.json(orders);
});

app.post('/api/exchange', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const { usdt, requisites } = req.body;
  if (!usdt || typeof usdt!=='number' || usdt<=0) return res.status(400).json({ error:'Некорректная сумма' });
  const rub = usdt * RATE;
  if (rub < MIN_RUB) return res.status(400).json({ error:`Минимум ${MIN_RUB} ₽ (~${(MIN_RUB/RATE).toFixed(2)} USDT)` });
  if (!requisites || requisites.trim().length<5) return res.status(400).json({ error:'Укажите реквизиты' });
  if (user.balance < usdt) return res.status(400).json({
    error:`Недостаточно средств. Баланс: ${user.balance.toFixed(2)} USDT`,
    code:'INSUFFICIENT_BALANCE', balance:user.balance });
  db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(usdt, user.tg_id);
  const order = db.prepare(`INSERT INTO orders (tg_id,type,usdt,rub,requisites) VALUES (?,?,?,?,?)`)
    .run(user.tg_id,'exchange',usdt,rub,requisites.trim());
  const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.lastInsertRowid);
  notifyManager(newOrder, user);
  res.json({ success:true, order:newOrder, balance:user.balance-usdt });
});

app.post('/api/deposit', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const { check_url, usdt } = req.body;
  if (!check_url || typeof check_url!=='string') return res.status(400).json({ error:'Ссылка обязательна' });
  if (!check_url.includes('t.me/CryptoBot') && !check_url.includes('t.me/xRocket'))
    return res.status(400).json({ error:'Только чеки Crypto Bot и xRocket' });
  const usdtAmount = parseFloat(usdt);
  if (!usdtAmount || usdtAmount<=0) return res.status(400).json({ error:'Укажите сумму' });
  const order = db.prepare(`INSERT INTO orders (tg_id,type,usdt,check_url) VALUES (?,?,?,?)`)
    .run(user.tg_id,'deposit',usdtAmount,check_url.trim());
  const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.lastInsertRowid);
  notifyManager(newOrder, user);
  res.json({ success:true, order:newOrder });
});

app.post('/api/withdrawal', authMiddleware, (req, res) => {
  const user = upsertUser(req.tgUser);
  const { usdt } = req.body;
  if (!usdt || typeof usdt!=='number' || usdt<=0) return res.status(400).json({ error:'Некорректная сумма' });
  if (user.balance < usdt) return res.status(400).json({
    error:`Недостаточно средств. Баланс: ${user.balance.toFixed(2)} USDT`, code:'INSUFFICIENT_BALANCE' });
  db.prepare('UPDATE users SET balance=balance-? WHERE tg_id=?').run(usdt, user.tg_id);
  const order = db.prepare(`INSERT INTO orders (tg_id,type,usdt) VALUES (?,?,?)`)
    .run(user.tg_id,'withdrawal',usdt);
  const newOrder = db.prepare('SELECT * FROM orders WHERE id=?').get(order.lastInsertRowid);
  notifyManager(newOrder, user);
  res.json({ success:true, order:newOrder, balance:user.balance-usdt });
});

// ── API: Admin ────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE agreed=1").get().c;
  const activeUsers = db.prepare("SELECT COUNT(DISTINCT tg_id) as c FROM orders WHERE created_at>=datetime('now','-30 days')").get().c;
  const monthOrders = db.prepare("SELECT COUNT(*) as c FROM orders WHERE created_at>=datetime('now','-30 days')").get().c;
  const totalRub = db.prepare("SELECT COALESCE(SUM(rub),0) as s FROM orders WHERE type='exchange' AND status='done'").get().s;
  const totalUsdt = db.prepare("SELECT COALESCE(SUM(usdt),0) as s FROM orders WHERE type='exchange' AND status='done'").get().s;
  const pending = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending'").get().c;
  const newToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at>=datetime('now','start of day')").get().c;
  res.json({ totalUsers, activeUsers, monthOrders, totalRub, totalUsdt, pending, newToday });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.*, COUNT(o.id) as order_count,
      COALESCE(SUM(CASE WHEN o.type='exchange' AND o.status='done' THEN o.usdt ELSE 0 END),0) as volume_usdt
    FROM users u LEFT JOIN orders o ON u.tg_id=o.tg_id
    WHERE u.agreed=1
    GROUP BY u.tg_id ORDER BY order_count DESC LIMIT 10
  `).all();
  res.json(users);
});

app.post('/api/admin/block', adminMiddleware, (req, res) => {
  const { tg_id, blocked } = req.body;
  db.prepare('UPDATE users SET blocked=? WHERE tg_id=?').run(blocked ? 1 : 0, tg_id);
  if (blocked) {
    bot.sendMessage(tg_id, '🚫 Ваш аккаунт заблокирован администратором.').catch(()=>{});
  } else {
    bot.sendMessage(tg_id, '✅ Ваш аккаунт разблокирован.').catch(()=>{});
  }
  res.json({ success:true });
});

app.post('/api/admin/broadcast', adminMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length < 2) return res.status(400).json({ error:'Пустое сообщение' });
  const users = db.prepare("SELECT tg_id FROM users WHERE agreed=1 AND blocked=0").all();
  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      await bot.sendMessage(u.tg_id, message, { parse_mode:'Markdown' });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50)); // rate limit
  }
  res.json({ success:true, sent, failed });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌑 Eclipse Exchange on port ${PORT}`);
});
