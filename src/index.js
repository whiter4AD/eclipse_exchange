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
const RATE = 80;
const RATE_BUY = 90;
const MIN_RUB = 4000;
const TERMS_URL = 'https://telegra.ph/Eclipse-Exchange-05-23';
const REQUIRE_AGREEMENT = false; // временно отключено по просьбе — верните true, чтобы включить обратно

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
  `);
  await query(`
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
  await query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id          SERIAL PRIMARY KEY,
      tg_id       BIGINT,
      order_id    INTEGER,
      rating      INTEGER DEFAULT 5,
      text        TEXT,
      avatar_url  TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (tg_id) REFERENCES users(tg_id),
      UNIQUE (order_id)
    );
  `);
  // migrations
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`); } catch(e) {}
  try { await query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS avatar_url TEXT`); } catch(e) {}
  // referral program
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT UNIQUE`); } catch(e) {}
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by BIGINT`); } catch(e) {}
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_delta NUMERIC`); } catch(e) {}
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_delta_type TEXT DEFAULT 'rub'`); } catch(e) {}
  try { await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ref_tg_id BIGINT`); } catch(e) {}
  try { await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ref_earn NUMERIC DEFAULT 0`); } catch(e) {}
  console.log('✅ Database ready');
}

// Fetch avatar and return as permanent base64 data URL
async function getTelegramAvatarUrl(tgId) {
  try {
    const photos = await bot.getUserProfilePhotos(tgId, { limit: 1 });
    if (!photos.total_count) return null;
    // Use smallest size to keep DB size reasonable
    const sizes = photos.photos[0];
    const fileId = sizes[0].file_id; // smallest
    const file = await bot.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Download and convert to base64
    const response = await new Promise((resolve, reject) => {
      const https = require('https');
      const http = require('http');
      const client = url.startsWith('https') ? https : http;
      client.get(url, (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });

    const base64 = response.toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch(e) {
    return null;
  }
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

// ── Referral program ──────────────────────────────────────────────────────────
async function generateRefCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const exists = await query('SELECT 1 FROM users WHERE ref_code=$1', [code]);
    if (!exists.rows[0]) return code;
  }
  throw new Error('Не удалось сгенерировать реферальный код');
}

// Применяет реферальную наценку/скидку к базовому курсу.
// direction: 'sell' — пользователь продаёт USDT (получает меньше при наличии реферера),
//            'buy'  — пользователь покупает USDT (платит больше при наличии реферера).
function applyReferralRate(baseRate, delta, deltaType, direction) {
  if (!delta) return baseRate;
  const diff = deltaType === 'percent' ? baseRate * (Number(delta) / 100) : Number(delta);
  return direction === 'sell' ? baseRate - diff : baseRate + diff;
}

// Возвращает { rate, refTgId, refDelta, refDeltaType } — эффективный курс для пользователя
// с учётом того, кто его пригласил, плюс данные для начисления рефереру.
async function getEffectiveRate(user, baseRate, direction) {
  if (!user.referred_by) return { rate: baseRate, refTgId: null };
  const refUser = await getUser(user.referred_by);
  if (!refUser || !refUser.ref_delta) return { rate: baseRate, refTgId: null };
  const rate = applyReferralRate(baseRate, Number(refUser.ref_delta), refUser.ref_delta_type, direction);
  return { rate, refTgId: refUser.tg_id };
}

const botUsernameCache = { value: null };
async function getBotUsername() {
  if (botUsernameCache.value) return botUsernameCache.value;
  const me = await bot.getMe();
  botUsernameCache.value = me.username;
  return me.username;
}

function refLink(username, code) {
  return `https://t.me/${username}?start=ref_${code}`;
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const webAppUrl = () => process.env.WEBAPP_URL || 'https://your-app.railway.app';

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const isNewUser = !(await getUser(msg.from.id));
  const user = await upsertUser({ id: msg.from.id, username: msg.from.username,
    first_name: msg.from.first_name, last_name: msg.from.last_name });

  // Привязываем реферала, только если это новый пользователь и ссылка валидна
  const payload = match && match[1];
  if (isNewUser && payload && payload.startsWith('ref_')) {
    const code = payload.slice(4);
    const refRes = await query('SELECT tg_id FROM users WHERE ref_code=$1', [code]);
    const refUser = refRes.rows[0];
    if (refUser && Number(refUser.tg_id) !== Number(msg.from.id)) {
      await query('UPDATE users SET referred_by=$1 WHERE tg_id=$2', [refUser.tg_id, msg.from.id]);
    }
  }

  // Fetch and save avatar in background
  getTelegramAvatarUrl(msg.from.id).then(url => {
    if (url) query('UPDATE users SET avatar_url=$1 WHERE tg_id=$2', [url, msg.from.id]).catch(()=>{});
  });

  if (user.blocked) return bot.sendMessage(msg.chat.id, '🚫 Ваш аккаунт заблокирован.');

  if (REQUIRE_AGREEMENT && !user.agreed) {
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
    `🌑 *Eclipse Exchange*\n\nОбмен USDT ⇄ ₽ по фиксированному курсу в обе стороны.\n\n💰 Продажа USDT → ₽: *80 ₽/USDT*\n💰 Покупка USDT за ₽: *90 ₽/USDT*\n📊 Без скрытых комиссий`,
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
      const isCryptoDeposit = order.type === 'deposit' && order.check_url &&
          !['SIM','QR','СБП'].includes(order.requisites);
      if (isCryptoDeposit) {
        await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [order.usdt, order.tg_id]);
      }
      try {
        const msg =
          order.type === 'exchange'    ? `💴 ${Math.round(Number(order.rub)).toLocaleString('ru-RU')} ₽ отправлены на ваши реквизиты.`
          : order.type === 'withdrawal' ? `💵 Чек на ${Number(order.usdt)} USDT отправлен вам в Telegram.`
          : order.type === 'buy'        ? `💵 ${Number(order.usdt).toFixed(2)} USDT отправлены на ваш кошелёк.`
          : isCryptoDeposit             ? `💵 ${Number(order.usdt)} USDT зачислены на ваш баланс.`
          : `✅ Ваша заявка выполнена!`;
        await bot.sendMessage(order.tg_id, `✅ Заявка #${order.id} выполнена!\n\n${msg}`);
      } catch(e) {}
      await bot.answerCallbackQuery(query_cb.id, { text: '✅ Выполнено' });
      await bot.editMessageText(query_cb.message.text + '\n\n✅ ВЫПОЛНЕНО',
        { chat_id: query_cb.message.chat.id, message_id: query_cb.message.message_id }).catch(()=>{});
    }

    if (action === 'cancel') {
      await query("UPDATE orders SET status='cancelled' WHERE id=$1", [order.id]);
      // Refund balance only for exchange/withdrawal (buy — user hasn't sent money yet)
      if (order.type === 'exchange' || order.type === 'withdrawal') {
        await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [order.usdt, order.tg_id]);
      }
      // Отменяем начисление рефереру, если оно было
      if (order.ref_tg_id && Number(order.ref_earn) > 0) {
        await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2', [order.ref_earn, order.ref_tg_id]);
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
    avatar_url:user.avatar_url || null,
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

// GET /api/referral — current user's referral link + stats
app.get('/api/referral', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  if (!user.ref_code || !user.ref_delta) {
    return res.json({ has_link: false });
  }
  const [countRes, earnRes] = await Promise.all([
    query('SELECT COUNT(*) as c FROM users WHERE referred_by=$1', [user.tg_id]),
    query('SELECT COALESCE(SUM(ref_earn),0) as s FROM orders WHERE ref_tg_id=$1', [user.tg_id]),
  ]);
  const username = await getBotUsername();
  res.json({
    has_link: true,
    link: refLink(username, user.ref_code),
    delta: Number(user.ref_delta),
    delta_type: user.ref_delta_type,
    invited: Number(countRes.rows[0].c),
    earned: Number(earnRes.rows[0].s),
  });
});

// POST /api/referral — create or update the referral rate delta
app.post('/api/referral', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { delta, delta_type } = req.body;
  const type = delta_type === 'percent' ? 'percent' : 'rub';
  const value = Number(delta);
  if (!value || value <= 0 || (type === 'percent' && value >= 100)) {
    return res.status(400).json({ error: type === 'percent' ? 'Введите число от 0 до 100' : 'Введите положительное число' });
  }
  let refCode = user.ref_code;
  if (!refCode) refCode = await generateRefCode();
  await query('UPDATE users SET ref_code=$1, ref_delta=$2, ref_delta_type=$3 WHERE tg_id=$4',
    [refCode, value, type, user.tg_id]);
  const username = await getBotUsername();
  res.json({ success: true, link: refLink(username, refCode), delta: value, delta_type: type });
});

app.post('/api/exchange', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { usdt, requisites } = req.body;
  if (!usdt || typeof usdt!=='number' || usdt<=0) return res.status(400).json({ error:'Некорректная сумма' });
  const { rate, refTgId } = await getEffectiveRate(user, RATE, 'sell');
  const rub = usdt * rate;
  if (rub < MIN_RUB) return res.status(400).json({ error:`Минимум ${MIN_RUB} ₽ (~${(MIN_RUB/rate).toFixed(2)} USDT)` });
  if (!requisites || requisites.trim().length<5) return res.status(400).json({ error:'Укажите реквизиты' });
  const balance = Number(user.balance);
  if (balance < usdt) return res.status(400).json({
    error:`Недостаточно средств. Баланс: ${balance.toFixed(2)} USDT`, code:'INSUFFICIENT_BALANCE', balance });
  const refEarn = refTgId ? Number((usdt * (RATE - rate)).toFixed(2)) : 0;
  await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2', [usdt, user.tg_id]);
  if (refTgId && refEarn > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarn, refTgId]);
  const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites,ref_tg_id,ref_earn) VALUES ($1,'exchange',$2,$3,$4,$5,$6) RETURNING *`,
    [user.tg_id, usdt, rub, requisites.trim(), refTgId, refEarn]);
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

// POST /api/buy — buy USDT for RUB
app.post('/api/buy', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { rub, wallet } = req.body;
  if (!rub || rub < 4000) return res.status(400).json({ error: 'Минимальная сумма 4 000 ₽' });
  if (!wallet || wallet.length < 10) return res.status(400).json({ error: 'Укажите USDT кошелёк' });

  const { rate, refTgId } = await getEffectiveRate(user, RATE_BUY, 'buy');
  const usdt = Number((rub / rate).toFixed(2));
  const refEarn = refTgId ? Number((usdt * (rate - RATE_BUY)).toFixed(2)) : 0;

  const r = await query(
    `INSERT INTO orders (tg_id, type, usdt, rub, requisites, ref_tg_id, ref_earn) VALUES ($1, 'buy', $2, $3, $4, $5, $6) RETURNING *`,
    [user.tg_id, usdt, rub, wallet, refTgId, refEarn]
  );
  const order = r.rows[0];
  if (refTgId && refEarn > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarn, refTgId]);

  const managerChatId = process.env.MANAGER_CHAT_ID;
  if (managerChatId) {
    const userTag = user.username ? `@${user.username}` : `#${user.tg_id}`;
    const text = `💰 Покупка USDT за ₽\n\n` +
      `👤 ${userTag} (${user.first_name || ''})\n` +
      `🆔 Заявка: #${order.id}\n` +
      `💴 Отдаёт: ${Math.round(rub).toLocaleString('ru-RU')} ₽\n` +
      `💵 Получает: ${Number(usdt).toFixed(2)} USDT\n` +
      `👛 Кошелёк: ${wallet}\n` +
      `⏰ ${formatMsk(order.created_at)}`;
    try {
      await bot.sendMessage(managerChatId, text, { reply_markup: { inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${order.id}` },
        { text: '❌ Отклонить', callback_data: `cancel_${order.id}` },
      ]]}});
    } catch(e) { console.error('Buy notify error:', e.message); }
  }
  res.json({ success: true, order });
});

// POST /api/avatar/me — refresh avatar on WebApp open (no /start needed)
app.post('/api/avatar/me', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  // Only re-fetch if no avatar saved yet
  if (user.avatar_url) return res.json({ avatar_url: user.avatar_url });
  const avatarUrl = await getTelegramAvatarUrl(user.tg_id);
  if (avatarUrl) {
    await query('UPDATE users SET avatar_url=$1 WHERE tg_id=$2', [avatarUrl, user.tg_id]);
  }
  res.json({ avatar_url: avatarUrl });
});

// GET /api/reviews — public, last reviews + count
app.get('/api/reviews', async (req, res) => {
  const reviews = await query(`
    SELECT r.id, r.rating, r.text, r.created_at, r.order_id, r.avatar_url,
           u.first_name, u.last_name, u.username,
           o.usdt, o.rub, o.type
    FROM reviews r
    JOIN users u ON r.tg_id = u.tg_id
    JOIN orders o ON r.order_id = o.id
    ORDER BY r.created_at DESC LIMIT 3
  `);
  const total = await query('SELECT COUNT(*) as c FROM reviews');
  const avg = await query('SELECT COALESCE(AVG(rating),5) as a FROM reviews');
  const REVIEWS_OFFSET = 391; // старая база отзывов утеряна, показываем правдоподобный счётчик
  res.json({
    reviews: reviews.rows,
    total: Number(total.rows[0].c) + REVIEWS_OFFSET,
    avg: Number(Number(avg.rows[0].a).toFixed(1)),
  });
});

// GET /api/reviews/eligible — check if user can leave a review
app.get('/api/reviews/eligible', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  // Find completed exchange orders without a review
  const eligible = await query(`
    SELECT o.id, o.usdt, o.rub, o.type, o.created_at
    FROM orders o
    LEFT JOIN reviews r ON r.order_id = o.id
    WHERE o.tg_id = $1
      AND o.status = 'done'
      AND o.type IN ('exchange', 'deposit', 'withdrawal')
      AND r.id IS NULL
    ORDER BY o.created_at DESC LIMIT 1
  `, [user.tg_id]);
  res.json({ eligible: eligible.rows.length > 0, order: eligible.rows[0] || null });
});

// POST /api/reviews — submit a review
app.post('/api/reviews', authMiddleware, async (req, res) => {
  const user = await upsertUser(req.tgUser);
  const { order_id, rating, text } = req.body;

  if (!order_id) return res.status(400).json({ error: 'order_id обязателен' });
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Оценка от 1 до 5' });

  // Verify order belongs to user and is done
  const order = await query(
    "SELECT * FROM orders WHERE id=$1 AND tg_id=$2 AND status='done'",
    [order_id, user.tg_id]
  );
  if (!order.rows[0]) return res.status(403).json({ error: 'Сделка не найдена или не завершена' });

  // Check not already reviewed
  const exists = await query('SELECT id FROM reviews WHERE order_id=$1', [order_id]);
  if (exists.rows[0]) return res.status(400).json({ error: 'Отзыв уже оставлен' });

  const avatarUrl = user.avatar_url || await getTelegramAvatarUrl(user.tg_id);

  const r = await query(
    'INSERT INTO reviews (tg_id, order_id, rating, text, avatar_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [user.tg_id, order_id, rating, (text || '').trim().slice(0, 300), avatarUrl]
  );
  res.json({ success: true, review: r.rows[0] });
});

// GET /api/admin/reviews — all reviews for admin
app.get('/api/admin/reviews', adminMiddleware, async (req, res) => {
  const result = await query(`
    SELECT r.id, r.rating, r.text, r.created_at, r.order_id, r.avatar_url, r.tg_id,
           u.first_name, u.last_name, u.username,
           o.usdt, o.rub, o.type
    FROM reviews r
    JOIN users u ON r.tg_id = u.tg_id
    JOIN orders o ON r.order_id = o.id
    ORDER BY r.created_at DESC
  `);
  const total = await query('SELECT COUNT(*) as c FROM reviews');
  res.json({ reviews: result.rows, total: Number(total.rows[0].c) });
});

// DELETE /api/admin/reviews/:id
app.delete('/api/admin/reviews/:id', adminMiddleware, async (req, res) => {
  await query('DELETE FROM reviews WHERE id=$1', [Number(req.params.id)]);
  res.json({ success: true });
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
           u.balance, u.agreed, u.blocked, u.created_at, u.avatar_url,
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

// POST /api/admin/broadcast-photo — broadcast with photo attachment
app.post('/api/admin/broadcast-photo', adminMiddleware, upload.single('photo'), async (req, res) => {
  const { message } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Фото обязательно' });

  const users = await query("SELECT tg_id FROM users WHERE agreed=1 AND blocked=0");
  let sent = 0, failed = 0;

  for (const u of users.rows) {
    try {
      await bot.sendPhoto(u.tg_id, req.file.buffer, {
        caption: message || undefined,
        parse_mode: message ? 'Markdown' : undefined,
      });
      sent++;
    } catch(e) { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  res.json({ success: true, sent, failed });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`\n🌑 Eclipse Exchange on port ${PORT}\n`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
