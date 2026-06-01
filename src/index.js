const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const RATE = 79;
const MIN_RUB = 5000;
const TERMS_URL = 'https://telegra.ph/Eclipse-Exchange-05-23';

if (!BOT_TOKEN) { console.error('❌ BOT_TOKEN not set.'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL not set.'); process.exit(1); }

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id       BIGINT PRIMARY KEY,
      username    TEXT,
      first_name  TEXT,
      last_name   TEXT,
      balance     NUMERIC DEFAULT 0,
      agreed      INTEGER DEFAULT 0,
      blocked     INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      tg_id       BIGINT,
      type        TEXT,
      usdt        NUMERIC DEFAULT 0,
      rub         NUMERIC DEFAULT 0,
      requisites  TEXT,
      check_url   TEXT,
      status      TEXT DEFAULT 'pending',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (tg_id) REFERENCES users(tg_id)
    );
  `);
  console.log('✅ Database ready');
}

// ── MSK time ──────────────────────────────────────────────────────────────────
function formatMsk(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }) + ' МСК';
}

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

async function upsertUser(tgUser) {
  const res = await query(`
    INSERT INTO users (tg_id, username, first_name, last_name)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tg_id) DO UPDATE SET
      username=EXCLUDED.username,
      first_name=EXCLUDED.first_name,
      last_name=EXCLUDED.last_name
    RETURNING *
  `, [tgUser.id, tgUser.username||null, tgUser.first_name||null, tgUser.last_name||null]);
  return res.rows[0];
}

async function getUser(tgId) {
  const res = await query('SELECT * FROM users WHERE tg_id=$1', [tgId]);
  return res.rows[0] || null;
}

function isAdmin(tgId) {
  return process.env.MANAGER_CHAT_ID && String(tgId) === String(process.env.MANAGER_CHAT_ID);
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const webAppUrl = () => process.env.WEBAPP_URL || 'https://your-app.railway.app';

bot.onText(/\/start/, async (msg) => {
  const user = await upsertUser({ id: msg.from.id, username: msg.from.username,
    first_name: msg.from.first_name, last_name: msg.from.last_name });

  if (user.blocked) return bot.sendMessage(msg.chat.id, '🚫 Ваш аккаунт заблокирован.');

  if (!user.agreed) {
    return bot.sendMessage(msg.chat.id,
      `👋 Привет, *${msg.from.first_name || 'друг'}*!\n\nДобро пожаловать в *Eclipse Exchange*.\n\nПеред началом работы ознакомьтесь с пользовательским соглашением.`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '📄 Читать соглашение', url: TERMS_URL }],
        [{ text: '✅ Принять и продолжить', callback_data: 'agree' }],
      ]}}
    );
  }
  sendMainMenu(msg.chat.id, msg.from.first_name);
});

bot.onText(/\/admin/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, '🛡 Админ-панель:', {
    reply_markup: { inline_keyboard: [[
      { text: '🛡 Открыть панель', web_app: { url: webAppUrl() + '/admin.html' } }
    ]]}
  });
});

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  await sendStats(msg.chat.id);
});

function sendMainMenu(chatId, firstName) {
  bot.sendMessage(chatId,
    `🌑 *Eclipse Exchange*\n\nОбмен USDT → ₽ по фиксированному курсу.\n\n💰 Курс: *79 ₽/USDT*\n📊 Без скрытых комиссий`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '🌑 Открыть обменник', web_app: { url: webAppUrl() } }
    ]]}}
  );
}

async function sendStats(chatId) {
  const [tu, au, mo, tr, tu2, pe] = await Promise.all([
    query("SELECT COUNT(*) as c FROM users WHERE agreed=1"),
    query("SELECT COUNT(DISTINCT tg_id) as c FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"),
    query("SELECT COUNT(*) as c FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"),
    query("SELECT COALESCE(SUM(rub),0) as s FROM orders WHERE type='exchange' AND status='done'"),
    query("SELECT COALESCE(SUM(usdt),0) as s FROM orders WHERE type='exchange' AND status='done'"),
    query("SELECT COUNT(*) as c FROM orders WHERE status='pending'"),
  ]);
  bot.sendMessage(chatId,
    `📊 *Статистика Eclipse Exchange*\n\n` +
    `👥 Пользователей: *${tu.rows[0].c}*\n` +
    `📅 Активных за месяц: *${au.rows[0].c}*\n` +
    `📋 Заявок за месяц: *${mo.rows[0].c}*\n` +
    `⏳ Ожидают: *${pe.rows[0].c}*\n\n` +
    `💴 Оборот: *${Math.round(Number(tr.rows[0].s)).toLocaleString('ru-RU')} ₽*\n` +
    `💵 Оборот: *${Number(tu2.rows[0].s).toFixed(2)} USDT*`,
    { parse_mode: 'Markdown' }
  );
}

// ── Notify manager ────────────────────────────────────────────────────────────
async function notifyManager(order, user) {
  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (!managerChatId) return;
  const typeLabel = { exchange:'🔄 Обмен USDT→₽', deposit:'📥 Пополнение', withdrawal:'📤 Вывод USDT' }[order.type] || '📋';
  const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
  let text = `${typeLabel}\n\n👤 ${userTag} (${user.first_name||''})\n🆔 Заявка: #${order.id}\n`;
  if (order.type === 'exchange') {
    text += `💵 Отдаёт: ${Number(order.usdt)} USDT\n💴 Получает: ${Math.round(Number(order.rub)).toLocaleString('ru-RU')} ₽\n🏦 Реквизиты: ${order.requisites}\n`;
  } else if (order.type === 'deposit') {
    text += `💵 Сумма: ${Number(order.usdt)} USDT\n🔗 Чек: ${order.check_url}\n`;
  } else if (order.type === 'withdrawal') {
    text += `💵 Сумма: ${Number(order.usdt)} USDT\n📝 Отправьте чек пользователю в ЛС\n`;
  }
  text += `⏰ ${formatMsk(order.created_at)}`;
  try {
    await bot.sendMessage(managerChatId, text, { reply_markup: { inline_keyboard: [[
      { text: '✅ Выполнено', callback_data: `done_${order.id}` },
      { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
    ]]}});
  } catch(e) { console.error('Notify error:', e.message); }
}

// ── Callback queries ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query_cb) => {
  const data = query_cb.data;
  const tgId = query_cb.from.id;

  if (data === 'agree') {
    await query('UPDATE users SET agreed=1 WHERE tg_id=$1', [tgId]);
    await bot.answerCallbackQuery(query_cb.id, { text: '✅ Соглашение принято!' });
    await bot.editMessageText('✅ Соглашение принято! Теперь вы можете пользоваться сервисом.',
      { chat_id: query_cb.message.chat.id, message_id: query_cb.message.message_id }).catch(()=>{});
    return sendMainMenu(tgId, query_cb.from.first_name);
  }

  if (data.startsWith('done_') || data.startsWith('cancel_')) {
    const [action, orderId] = data.split('_');
    const orderRes = await query('SELECT * FROM orders WHERE id=$1', [Number(orderId)]);
    const order = orderRes.rows[0];
    if (!order) return bot.answerCallbackQuery(query_cb.id, { text: 'Заявка не найдена' });

    if (action === 'done') {
      await query("UPDATE orders SET status='done' WHERE id=$1", [order.id]);
      if (order.type === 'deposit') {
        await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [order.usdt, order.tg_id]);
      }
      try {
        await bot.sendMessage(order.tg_id,
          `✅ Заявка #${order.id} выполнена!\n\n` +
          (order.type === 'exchange' ? `💴 ${Math.round(Number(order.rub)).toLocaleString('ru-RU')} ₽ отправлены на ваши реквизиты.`
          : order.type === 'withdrawal' ? `💵 Чек на ${Number(order.usdt)} USDT отправлен вам в Telegram.`
          : `💵 ${Number(order.usdt)} USDT зачислены на ваш баланс.`)
        );
      } catch(e) {}
      await bot.answerCallbackQuery(query_cb.id, { text: '✅ Выполнено' });
      await bot.editMessageText(query_cb.message.text + '\n\n✅ ВЫПОЛНЕНО',
        { chat_id: query_cb.message.chat.id, message_id: query_cb.message.message_id }).catch(()=>{});
    }

    if (action === 'cancel') {
      await query("UPDATE orders SET status='cancelled' WHERE id=$1", [order.id]);
      if (order.type === 'exchange' || order.type === 'withdrawal') {
        await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [order.usdt, order.tg_id]);
      }
      try {
        await bot.sendMessage(order.tg_id, `❌ Заявка #${order.id} отклонена.\nЕсть вопросы — напишите менеджеру.`);
      } catch(e) {}
      await bot.answerCallbackQuery(query_cb.id, { text: '❌ Отклонено' });
      await bot.editMessageText(query_cb.message.text + '\n\n❌ ОТКЛОНЕНО',
        { chat_id: query_cb.message.chat.id, message_id: query_cb.message.message_id }).catch(()=>{});
    }
  }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

async function authMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser) return res.status(401).json({ error: 'Unauthorized' });
  const user = await getUser(tgUser.id);
  if (user && user.blocked) return res.status(403).json({ error: 'Заблокирован' });
  req.tgUser = tgUser;
  next();
}

async function adminMiddleware(req, res, next) {
  const initData = req.headers['x-telegram-init-data'];
  const tgUser = verifyTelegramData(initData);
  if (!tgUser || !isAdmin(tgUser.id)) return res.status(403).json({ error: 'Forbidden' });
  req.tgUser = tgUser;
  next();
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const stats = await query(`
    SELECT COUNT(*) as total_orders,
      SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done_orders,
      SUM(CASE WHEN type='exchange' AND status='done' THEN usdt ELSE 0 END) as total_usdt
    FROM orders WHERE tg_id=$1`, [user.tg_id]);
  const s = stats.rows[0];
  res.json({ id:user.tg_id, username:user.username, first_name:user.first_name,
    last_name:user.last_name, balance:Number(user.balance), agreed:user.agreed,
    created_at:user.created_at, stats:{
      total_orders:Number(s.total_orders)||0,
      done_orders:Number(s.done_orders)||0,
      total_usdt:Number(s.total_usdt)||0 }});
});

app.get('/api/orders', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const result = await query('SELECT * FROM orders WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 50', [user.tg_id]);
  res.json(result.rows);
});

app.post('/api/exchange', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { usdt, requisites } = req.body;
  if (!usdt || typeof usdt!=='number' || usdt<=0) return res.status(400).json({ error:'Некорректная сумма' });
  const rub = usdt * RATE;
  if (rub < MIN_RUB) return res.status(400).json({ error:`Минимум ${MIN_RUB} ₽ (~${(MIN_RUB/RATE).toFixed(2)} USDT)` });
  if (!requisites || requisites.trim().length<5) return res.status(400).json({ error:'Укажите реквизиты' });
  const balance = Number(user.balance);
  if (balance < usdt) return res.status(400).json({
    error:`Недостаточно средств. Баланс: ${balance.toFixed(2)} USDT`, code:'INSUFFICIENT_BALANCE', balance });
  await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2', [usdt, user.tg_id]);
  const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites) VALUES ($1,'exchange',$2,$3,$4) RETURNING *`,
    [user.tg_id, usdt, rub, requisites.trim()]);
  notifyManager(r.rows[0], user);
  res.json({ success:true, order:r.rows[0], balance:balance-usdt });
});

app.post('/api/deposit', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { check_url, usdt } = req.body;
  if (!check_url || typeof check_url!=='string') return res.status(400).json({ error:'Ссылка обязательна' });
  if (!check_url.includes('t.me/CryptoBot') && !check_url.includes('t.me/xRocket'))
    return res.status(400).json({ error:'Только чеки Crypto Bot и xRocket' });
  const usdtAmount = parseFloat(usdt);
  if (!usdtAmount || usdtAmount<=0) return res.status(400).json({ error:'Укажите сумму' });
  const r = await query(`INSERT INTO orders (tg_id,type,usdt,check_url) VALUES ($1,'deposit',$2,$3) RETURNING *`,
    [user.tg_id, usdtAmount, check_url.trim()]);
  notifyManager(r.rows[0], user);
  res.json({ success:true, order:r.rows[0] });
});


// POST /api/deposit/fiat — SIM deposit
app.post('/api/deposit/fiat', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { dep_type, rub_per_number, phones, total_rub, usdt_amount, check_url } = req.body;

  if (!dep_type) return res.status(400).json({ error: 'Тип пополнения обязателен' });
  if (!total_rub || total_rub <= 0) return res.status(400).json({ error: 'Укажите сумму' });
  if (!check_url) return res.status(400).json({ error: 'Ссылка на чек обязательна' });

  const r = await query(
    `INSERT INTO orders (tg_id, type, usdt, rub, requisites, check_url) VALUES ($1, 'deposit', $2, $3, $4, $5) RETURNING *`,
    [user.tg_id, usdt_amount, total_rub, dep_type, check_url]
  );
  const order = r.rows[0];

  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (managerChatId) {
    const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
    let text = `📥 Пополнение (${dep_type})\n\n`;
    text += `👤 ${userTag} (${user.first_name || ''})\n`;
    text += `🆔 Заявка: #${order.id}\n`;
    text += `💵 К зачислению: ${Number(usdt_amount).toFixed(2)} USDT\n`;
    text += `💴 Сумма: ${total_rub} ₽\n`;
    text += `☎️ Номера: ${(phones || []).join(', ')}\n`;
    text += `💰 На номер: ${rub_per_number} ₽\n`;
    text += `🔗 Чек: ${check_url}\n`;
    text += `⏰ ${formatMsk(order.created_at)}`;
    try {
      await bot.sendMessage(managerChatId, text, { reply_markup: { inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${order.id}` },
        { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
      ]]}});
    } catch(e) { console.error('SIM notify error:', e.message); }
  }
  res.json({ success: true, order });
});

// POST /api/deposit/fiat-qr — QR deposit with image upload
app.post('/api/deposit/fiat-qr', authMiddleware, upload.single('qr_image_file'), async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { dep_type, total_rub, usdt_amount, check_url } = req.body;

  if (!total_rub || total_rub <= 0) return res.status(400).json({ error: 'Укажите сумму' });
  if (!check_url) return res.status(400).json({ error: 'Ссылка на чек обязательна' });
  if (!req.file) return res.status(400).json({ error: 'QR-изображение обязательно' });

  const r = await query(
    `INSERT INTO orders (tg_id, type, usdt, rub, requisites, check_url) VALUES ($1, 'deposit', $2, $3, 'QR', $4) RETURNING *`,
    [user.tg_id, usdt_amount, total_rub, check_url]
  );
  const order = r.rows[0];

  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (managerChatId) {
    const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
    let text = `📥 Пополнение (QR)\n\n`;
    text += `👤 ${userTag} (${user.first_name || ''})\n`;
    text += `🆔 Заявка: #${order.id}\n`;
    text += `💵 К зачислению: ${Number(usdt_amount).toFixed(2)} USDT\n`;
    text += `💴 Сумма: ${total_rub} ₽\n`;
    text += `🔗 Чек: ${check_url}\n`;
    text += `⏰ ${formatMsk(order.created_at)}`;
    try {
      await bot.sendPhoto(managerChatId, req.file.buffer, {
        caption: text,
        reply_markup: { inline_keyboard: [[
          { text: '✅ Выполнено', callback_data: `done_${order.id}` },
          { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
        ]]}
      });
    } catch(e) { console.error('QR notify error:', e.message); }
  }
  res.json({ success: true, order });
});

app.post('/api/withdrawal', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { usdt } = req.body;
  if (!usdt || typeof usdt!=='number' || usdt<=0) return res.status(400).json({ error:'Некорректная сумма' });
  const balance = Number(user.balance);
  if (balance < usdt) return res.status(400).json({
    error:`Недостаточно средств. Баланс: ${balance.toFixed(2)} USDT`, code:'INSUFFICIENT_BALANCE' });
  await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2', [usdt, user.tg_id]);
  const r = await query(`INSERT INTO orders (tg_id,type,usdt) VALUES ($1,'withdrawal',$2) RETURNING *`,
    [user.tg_id, usdt]);
  notifyManager(r.rows[0], user);
  res.json({ success:true, order:r.rows[0], balance:balance-usdt });
});

// Admin
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  const [tu, au, mo, tr, tu2, pe, nt] = await Promise.all([
    query("SELECT COUNT(*) as c FROM users WHERE agreed=1"),
    query("SELECT COUNT(DISTINCT tg_id) as c FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"),
    query("SELECT COUNT(*) as c FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'"),
    query("SELECT COALESCE(SUM(rub),0) as s FROM orders WHERE type='exchange' AND status='done'"),
    query("SELECT COALESCE(SUM(usdt),0) as s FROM orders WHERE type='exchange' AND status='done'"),
    query("SELECT COUNT(*) as c FROM orders WHERE status='pending'"),
    query("SELECT COUNT(*) as c FROM users WHERE created_at >= CURRENT_DATE"),
  ]);
  res.json({
    totalUsers:Number(tu.rows[0].c), activeUsers:Number(au.rows[0].c),
    monthOrders:Number(mo.rows[0].c), totalRub:Number(tr.rows[0].s),
    totalUsdt:Number(tu2.rows[0].s), pending:Number(pe.rows[0].c),
    newToday:Number(nt.rows[0].c)
  });
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 100);
  const offset = Number(req.query.offset) || 0;
  const search = req.query.search ? `%${req.query.search}%` : null;
  const sort = req.query.sort === 'balance' ? 'u.balance' :
               req.query.sort === 'date' ? 'u.created_at' : 'order_count';

  const whereClause = search
    ? `WHERE (u.username ILIKE $3 OR u.first_name ILIKE $3 OR CAST(u.tg_id AS TEXT) LIKE $3)`
    : '';

  const params = search ? [limit, offset, search] : [limit, offset];

  const result = await query(`
    SELECT u.tg_id, u.username, u.first_name, u.last_name,
           u.balance, u.agreed, u.blocked, u.created_at,
           COUNT(o.id) as order_count,
           COALESCE(SUM(CASE WHEN o.type='exchange' AND o.status='done' THEN o.usdt ELSE 0 END),0) as volume_usdt
    FROM users u LEFT JOIN orders o ON u.tg_id=o.tg_id
    ${whereClause}
    GROUP BY u.tg_id
    ORDER BY ${sort} DESC
    LIMIT $1 OFFSET $2
  `, params);

  const total = await query(`SELECT COUNT(*) as c FROM users`);

  res.json({
    users: result.rows.map(u => ({
      ...u,
      balance: Number(u.balance),
      volume_usdt: Number(u.volume_usdt),
      order_count: Number(u.order_count)
    })),
    total: Number(total.rows[0].c),
    limit, offset
  });
});

app.post('/api/admin/block', adminMiddleware, async (req, res) => {
  const { tg_id, blocked } = req.body;
  await query('UPDATE users SET blocked=$1 WHERE tg_id=$2', [blocked?1:0, tg_id]);
  bot.sendMessage(tg_id, blocked ? '🚫 Ваш аккаунт заблокирован администратором.' : '✅ Ваш аккаунт разблокирован.').catch(()=>{});
  res.json({ success:true });
});

app.post('/api/admin/broadcast', adminMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length<2) return res.status(400).json({ error:'Пустое сообщение' });
  const users = await query("SELECT tg_id FROM users WHERE agreed=1 AND blocked=0");
  let sent=0, failed=0;
  for (const u of users.rows) {
    try { await bot.sendMessage(u.tg_id, message, { parse_mode:'Markdown' }); sent++; }
    catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  res.json({ success:true, sent, failed });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`\n🌑 Eclipse Exchange on port ${PORT}\n`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
