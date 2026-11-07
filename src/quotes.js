// Динамический курс: берём рыночный USDT/RUB, добавляем спред и фиксируем котировку на 10 минут.
// Подключается из index.js одной строкой (см. инструкцию), старые обработчики ниже по файлу
// для /api/exchange, /api/buy, /api/deposit и отзывов перекрываются этим модулем.
const https = require('https');

const SPREAD = Number(process.env.SPREAD_RUB ?? 5);   // ± к рыночному курсу, ₽
const TTL_SEC = 600;          // котировка живёт 10 минут
const REUSE_MIN_LEFT = 30;    // отдаём ту же котировку, пока до конца > 30 сек
const GRACE_SEC = 10;         // допуск на задержку при создании заявки
const HC_DISCOUNT = Number(process.env.HIGH_CHECK_DISCOUNT ?? 0.01);  // High-check: курс ниже на 1%
const HC_MIN_RUB = Number(process.env.HIGH_CHECK_MIN_RUB ?? 5000);    // High-check: выплата от 5 000 ₽
const CACHE_MS = 60 * 1000;   // рыночный курс кэшируем на минуту

const round2 = n => Math.round(n * 100) / 100;
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function httpJson(url, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, timeout: 7000,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json (' + res.statusCode + ')')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Источники рыночного курса (по порядку; следующий — запасной) ───────────────
async function bybitSide(side) {
  const j = await httpJson('https://api2.bybit.com/fiat/otc/item/online', { method: 'POST', body: {
    userId: '', tokenId: 'USDT', currencyId: 'RUB', payment: [], side, size: '10', page: '1', amount: '', authMaker: false, canTrade: false } });
  const prices = (j?.result?.items || []).map(i => Number(i.price)).filter(Number.isFinite);
  if (prices.length < 3) throw new Error('few ads');
  return median(prices);
}
const SOURCES = [
  ['bybit-p2p', async () => {
    const r = await Promise.allSettled([bybitSide('1'), bybitSide('0')]);
    const v = r.filter(x => x.status === 'fulfilled').map(x => x.value);
    if (!v.length) throw new Error('no data');
    return v.reduce((a, b) => a + b, 0) / v.length;
  }],
  ['coingecko', async () => (await httpJson('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=rub')).tether.rub],
  ['cbr-usd', async () => (await httpJson('https://www.cbr-xml-daily.ru/daily_json.js')).Valute.USD.Value],
];

// Курс TON в USDT (рубли считаем как TON/USDT × курс USDT → тот же спред)
const TON_SOURCES = [
  ['okx', async () => Number((await httpJson('https://www.okx.com/api/v5/market/ticker?instId=TON-USDT')).data[0].last)],
  ['bybit', async () => Number((await httpJson('https://api.bybit.com/v5/market/tickers?category=spot&symbol=TONUSDT')).result.list[0].lastPrice)],
  ['coingecko', async () => (await httpJson('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd'))['the-open-network'].usd],
];
let tonCache = { v: null, at: 0 };
async function getTon() {
  if (process.env.MARKET_TON_USDT_OVERRIDE) return Number(process.env.MARKET_TON_USDT_OVERRIDE);
  if (tonCache.v && Date.now() - tonCache.at < CACHE_MS) return tonCache.v;
  for (const [name, fn] of TON_SOURCES) {
    try {
      const v = Number(await fn());
      const jump = tonCache.v && Date.now() - tonCache.at < 6 * 3600 * 1000 && Math.abs(v / tonCache.v - 1) > 0.3;
      if (Number.isFinite(v) && v > 0.05 && v < 200 && !jump) { tonCache = { v, at: Date.now() }; console.log(`[rates] TON ${name}: ${v}`); return v; }
      console.warn(`[rates] TON ${name}: отклонено (${v})`);
    } catch (e) { console.warn(`[rates] TON ${name} failed: ${e.message}`); }
  }
  return tonCache.v || null;
}

let cache = { rate: null, at: 0, source: null };
let lastAlert = 0;

function sane(v) {
  if (!Number.isFinite(v) || v < 30 || v > 300) return false;
  // не принимаем скачок >15% относительно недавнего значения (защита от кривых данных)
  if (cache.rate && Date.now() - cache.at < 6 * 3600 * 1000 && Math.abs(v / cache.rate - 1) > 0.15) return false;
  return true;
}

async function getMarket(bot) {
  if (process.env.MARKET_RATE_OVERRIDE) return { rate: Number(process.env.MARKET_RATE_OVERRIDE), source: 'override' };
  if (cache.rate && Date.now() - cache.at < CACHE_MS) return cache;
  for (const [name, fn] of SOURCES) {
    try {
      const v = Number(await fn());
      if (sane(v)) { cache = { rate: v, at: Date.now(), source: name }; console.log(`[rates] ${name}: ${v.toFixed(2)}`); return cache; }
      console.warn(`[rates] ${name}: отклонено (${v})`);
    } catch (e) { console.warn(`[rates] ${name} failed: ${e.message}`); }
  }
  if (cache.rate) {
    if (bot && process.env.MANAGER_CHAT_ID && Date.now() - lastAlert > 3600 * 1000) {
      lastAlert = Date.now();
      bot.sendMessage(process.env.MANAGER_CHAT_ID, '⚠️ Не удалось обновить рыночный курс, используется последний известный: ' + cache.rate.toFixed(2)).catch(() => {});
    }
    return cache; // последний известный
  }
  throw new Error('нет доступных источников курса');
}

// ── Котировки ────────────────────────────────────────────────────────────────
let tableReady = null;
function ensureTable(query) {
  if (!tableReady) tableReady = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY, tg_id BIGINT, market NUMERIC, sell_rate NUMERIC, buy_rate NUMERIC,
      expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query('CREATE INDEX IF NOT EXISTS quotes_user_idx ON quotes (tg_id, expires_at DESC)');
    await query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS high_check BOOLEAN DEFAULT FALSE');
    await query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'USDT'");
    await query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount NUMERIC');
    await query('ALTER TABLE quotes ADD COLUMN IF NOT EXISTS ton_usdt NUMERIC');
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_at TIMESTAMPTZ');
    await query('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
    await query("DELETE FROM quotes WHERE created_at < NOW() - INTERVAL '2 days'");
  })().catch(e => { tableReady = null; throw e; });
  return tableReady;
}

async function getSetting(query, key, def) {
  await ensureTable(query);
  const r = await query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return r.rows[0] ? r.rows[0].value : def;
}
async function setSetting(query, key, value) {
  await ensureTable(query);
  await query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, String(value)]);
}
async function getStatus(query) {
  return { open: (await getSetting(query, 'accepting', '1')) === '1', operators: Number(await getSetting(query, 'operators', '1')) || 0 };
}

const LEFT = 'EXTRACT(EPOCH FROM (expires_at - NOW())) AS "left"';

async function getQuote(query, bot, tgId) {
  await ensureTable(query);
  const ex = await query(`SELECT *, ${LEFT} FROM quotes WHERE tg_id=$1 AND expires_at > NOW() + make_interval(secs => $2::double precision)
                          ORDER BY id DESC LIMIT 1`, [tgId, REUSE_MIN_LEFT]);
  if (ex.rows[0]) return ex.rows[0];
  const m = await getMarket(bot);
  const sell = round2(m.rate - SPREAD), buy = round2(m.rate + SPREAD);
  const ton = await getTon().catch(() => null);
  const r = await query(`INSERT INTO quotes (tg_id, market, sell_rate, buy_rate, expires_at, ton_usdt)
    VALUES ($1,$2,$3,$4, NOW() + make_interval(secs => $5::double precision), $6) RETURNING *, ${LEFT}`,
    [tgId, m.rate, sell, buy, TTL_SEC, ton ? Math.round(ton * 10000) / 10000 : null]);
  return r.rows[0];
}

async function loadQuote(query, id, tgId) {
  id = Number(id);
  if (!Number.isInteger(id)) return null;
  await ensureTable(query);
  const r = await query(`SELECT * FROM quotes WHERE id=$1 AND tg_id=$2 AND expires_at > NOW() - make_interval(secs => $3::double precision)`, [id, tgId, GRACE_SEC]);
  return r.rows[0] || null;
}

const EXPIRED = { error: 'Курс обновился. Проверьте сумму и повторите', code: 'QUOTE_EXPIRED' };
const CHECK_RE = /^https?:\/\/(?:www\.)?(?:t|telegram)\.me\/(?:xrocket|tonrocketbot|cryptobot|send)(?:[/?]|$)/i;

function register(d) {
  const { app, query, authMiddleware, adminMiddleware, upsertUser, getEffectiveRate, notifyManager, formatMsk, bot, MIN_RUB } = d;
  const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); });

  // Текущая котировка пользователя (с учётом реферальной наценки)
  app.get('/api/quote', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const q = await getQuote(query, bot, user.tg_id);
    const sell = await getEffectiveRate(user, Number(q.sell_rate), 'sell');
    const buy = await getEffectiveRate(user, Number(q.buy_rate), 'buy');
    res.json({ id: q.id, seconds_left: Math.max(0, Math.floor(Number(q.left))),
      base_sell: Number(q.sell_rate), base_buy: Number(q.buy_rate),
      sell_rate: round2(sell.rate), buy_rate: round2(buy.rate),
      hc_discount: HC_DISCOUNT, hc_min_rub: HC_MIN_RUB,
      ton_usdt: q.ton_usdt ? Number(q.ton_usdt) : null, updated_at: q.created_at });
  }));

  // Заказ может создать только тот, кто принял условия, и только пока приём открыт
  const orderGate = async user => {
    if (!user.agreed) return { status: 403, body: { error: 'Примите условия обмена, чтобы продолжить', code: 'NOT_AGREED' } };
    if (!(await getStatus(query)).open) return { status: 403, body: { error: 'Приём заявок сейчас закрыт', code: 'CLOSED' } };
    return null;
  };

  // Продажа USDT или TON → ₽: чек прикладывается к заявке, баланс не используется
  app.post('/api/exchange', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const asset = req.body.asset === 'TON' ? 'TON' : 'USDT';
    const amount = Number(req.body.amount ?? req.body.usdt);
    const { requisites, quote_id, check_url } = req.body;
    const hc = req.body.high_check === true;
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Некорректная сумма' });
    if (!check_url || typeof check_url !== 'string' || !CHECK_RE.test(check_url.trim()))
      return res.status(400).json({ error: 'Приложите ссылку на чек xRocket или Crypto Bot' });
    if (!requisites || requisites.trim().length < 5) return res.status(400).json({ error: 'Укажите реквизиты' });
    const gate = await orderGate(user); if (gate) return res.status(gate.status).json(gate.body);
    const q = await loadQuote(query, quote_id, user.tg_id);
    if (!q) return res.status(409).json(EXPIRED);
    const unit = asset === 'TON' ? Number(q.ton_usdt) : 1;           // сколько USDT стоит 1 монета
    if (!unit) return res.status(503).json({ error: 'Курс TON временно недоступен, попробуйте позже' });
    const baseU = Number(q.sell_rate);                                 // базовый курс за 1 USDT
    const eff = await getEffectiveRate(user, baseU, 'sell');
    const rateU = round2(eff.rate), refTgId = eff.refTgId;             // курс за 1 USDT с учётом реферала
    const rateRef = round2(unit * rateU);                              // курс за 1 монету
    const rate = hc ? round2(rateRef * (1 - HC_DISCOUNT)) : rateRef;   // скидка High-check не входит в доход реферера
    const rub = amount * rate, usdtEq = amount * unit;
    const minRub = hc ? Math.max(MIN_RUB, HC_MIN_RUB) : MIN_RUB;
    if (rub < minRub) return res.status(400).json({ error: `Минимум ${minRub.toLocaleString('ru-RU')} ₽ (~${Math.ceil(minRub / rate)} ${asset})` });
    const dup = await query("SELECT 1 FROM orders WHERE check_url=$1 AND status<>'cancelled' LIMIT 1", [check_url.trim()]);
    if (dup.rows[0]) return res.status(400).json({ error: 'Этот чек уже использован в другой заявке' });
    const refEarnRub = refTgId ? Number((usdtEq * (baseU - rateU)).toFixed(2)) : 0;
    const refEarnUsdt = refTgId ? Number((refEarnRub / baseU).toFixed(2)) : 0;
    const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites,check_url,ref_tg_id,ref_earn,ref_earn_usdt,high_check,asset,amount)
      VALUES ($1,'exchange',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [user.tg_id, usdtEq, rub, requisites.trim(), check_url.trim(), refTgId, refEarnRub, refEarnUsdt, hc, asset, amount]);
    const order = r.rows[0];
    if (refTgId && refEarnUsdt > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarnUsdt, refTgId]);
    if (process.env.MANAGER_CHAT_ID) {
      const tag = user.username ? `@${user.username}` : `#${user.tg_id}`;
      const text = `${hc ? '⭐ HIGH-CHECK · приоритет\n\n' : ''}🔄 Продажа ${asset} → ₽\n\n👤 ${tag} (${user.first_name || ''})\n🆔 Заявка: #${order.id}\n` +
        `💵 Отдаёт: ${amount} ${asset}${asset === 'TON' ? ` (≈ ${usdtEq.toFixed(2)} USDT)` : ''}\n💴 Получает: ${Math.round(rub).toLocaleString('ru-RU')} ₽ (курс ${rate.toFixed(2)})\n` +
        `🏦 Реквизиты: ${requisites.trim()}\n🔗 Чек: ${check_url.trim()}\n⏰ ${formatMsk(order.created_at)}`;
      bot.sendMessage(process.env.MANAGER_CHAT_ID, text, { reply_markup: { inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${order.id}` }, { text: '❌ Отклонить', callback_data: `cancel_${order.id}` }]] } })
        .catch(e => console.error('Exchange notify error:', e.message));
    }
    res.json({ success: true, order });
  }));

  // Покупка USDT за ₽ больше не предоставляется
  app.post('/api/buy', (req, res) => res.status(410).json({ error: 'Покупка USDT недоступна' }));

  // Статус приёма заявок + настройки (ссылки на канал и документы задаются переменными Railway)
  app.get('/api/status', authMiddleware, wrap(async (req, res) => {
    const st = await getStatus(query);
    const terms = process.env.TERMS_URL || 'https://telegra.ph/Eclipse-Exchange-05-23';
    res.json({ ...st, channel_url: process.env.CHANNEL_URL || null, channel_title: process.env.CHANNEL_TITLE || 'Наш Telegram-канал',
      channel_desc: process.env.CHANNEL_DESC || 'Новости сервиса, изменения курса и важные объявления',
      terms_url: terms, privacy_url: process.env.PRIVACY_URL || terms, pd_url: process.env.PD_URL || terms });
  }));

  // Согласие с условиями (онбординг)
  app.post('/api/agree', authMiddleware, wrap(async (req, res) => {
    const b = req.body || {};
    if (!(b.terms === true && b.privacy === true && b.pd === true)) return res.status(400).json({ error: 'Нужно принять все условия' });
    const user = await upsertUser(req.tgUser);
    await ensureTable(query);
    await query('UPDATE users SET agreed=1, agreed_at=COALESCE(agreed_at, NOW()) WHERE tg_id=$1', [user.tg_id]);
    res.json({ success: true });
  }));

  // Админка и команды менеджера: открыть / закрыть приём заявок
  if (adminMiddleware) app.post('/api/admin/status', adminMiddleware, wrap(async (req, res) => {
    const { open, operators } = req.body || {};
    if (typeof open === 'boolean') await setSetting(query, 'accepting', open ? '1' : '0');
    if (Number.isInteger(operators) && operators >= 0 && operators <= 99) await setSetting(query, 'operators', operators);
    res.json({ success: true, ...(await getStatus(query)) });
  }));
  const isMgr = m => process.env.MANAGER_CHAT_ID && String(m.from.id) === String(process.env.MANAGER_CHAT_ID);
  bot.onText(/^\/open\b/, async m => { if (!isMgr(m)) return; await setSetting(query, 'accepting', '1'); bot.sendMessage(m.chat.id, '✅ Приём заявок открыт'); });
  bot.onText(/^\/close\b/, async m => { if (!isMgr(m)) return; await setSetting(query, 'accepting', '0'); bot.sendMessage(m.chat.id, '⛔ Приём заявок закрыт'); });

  // Пополнение чеком: xRocket и Crypto Bot (ссылки любого регистра, в т.ч. t.me/send и tonRocketBot)
  app.post('/api/deposit', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const { check_url, usdt } = req.body;
    if (!check_url || typeof check_url !== 'string') return res.status(400).json({ error: 'Ссылка обязательна' });
    if (!CHECK_RE.test(check_url.trim())) return res.status(400).json({ error: 'Принимаются только чеки xRocket и Crypto Bot' });
    const amount = parseFloat(usdt);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Укажите сумму' });
    const r = await query(`INSERT INTO orders (tg_id,type,usdt,check_url) VALUES ($1,'deposit',$2,$3) RETURNING *`, [user.tg_id, amount, check_url.trim()]);
    notifyManager(r.rows[0], user);
    res.json({ success: true, order: r.rows[0] });
  }));

  // Отзывы убраны из приложения: закрываем старые эндпоинты
  app.all(/^\/api\/(admin\/)?reviews/, (req, res) => res.status(410).json({ error: 'Отзывы отключены' }));
}

module.exports = { register, _test: { median, round2, CHECK_RE } };
