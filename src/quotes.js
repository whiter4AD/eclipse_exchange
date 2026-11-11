// Динамический курс: берём рыночный USDT/RUB, добавляем спред и фиксируем котировку на 10 минут.
// Подключается из index.js одной строкой (см. инструкцию), старые обработчики ниже по файлу
// для /api/exchange, /api/buy, /api/deposit и отзывов перекрываются этим модулем.
const https = require('https');

const SPREAD = Number(process.env.SPREAD_RUB ?? 0);   // наценка к рыночному курсу, ₽ (0 = клиент получает рыночный курс)
const TTL_SEC = 600;          // котировка живёт 10 минут
const REUSE_MIN_LEFT = 30;    // отдаём ту же котировку, пока до конца > 30 сек
const GRACE_SEC = 10;         // допуск на задержку при создании заявки
const HC_DISCOUNT = Number(process.env.HIGH_CHECK_DISCOUNT ?? 0.01);  // High-check: курс ниже на 1%
const HC_MIN_RUB = Number(process.env.HIGH_CHECK_MIN_RUB ?? 5000);
const MIN_AMOUNT = Number(process.env.MIN_AMOUNT ?? 5);   // минимальная сумма обмена: 5 USDT / 5 TON    // High-check: выплата от 5 000 ₽
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
  ['okx-p2p', async () => {
    const side = async sd => {
      const j = await httpJson(`https://www.okx.com/v3/c2c/tradingOrders/books?quoteCurrency=RUB&baseCurrency=USDT&side=${sd}&paymentMethod=all&userType=all&showTrade=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false`);
      const p = ((j && j.data && j.data[sd]) || []).map(i => Number(i.price)).filter(Number.isFinite).slice(0, 10);
      if (p.length < 3) throw new Error('few ads');
      return median(p);
    };
    const r = await Promise.allSettled([side('sell'), side('buy')]);
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
    await query('CREATE TABLE IF NOT EXISTS rate_history (id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(), sell NUMERIC, ton_usdt NUMERIC, source TEXT)');
    await query('CREATE INDEX IF NOT EXISTS rate_history_ts ON rate_history (ts)');
    await query("DELETE FROM rate_history WHERE ts < NOW() - INTERVAL '30 days'");
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
  const m = { ...(await getMarket(bot)) };
  const adj = Number(await getSetting(query, 'market_adjust', '0')) || 0;   // поправка из админки, ₽
  m.rate = m.rate + adj;
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

let historyStarted = false;
async function recordRate(query, bot) {
  try {
    await ensureTable(query);
    const m = await getMarket(bot);
    const adj = Number(await getSetting(query, 'market_adjust', '0')) || 0;
    const ton = await getTon().catch(() => null);
    await query('INSERT INTO rate_history (sell, ton_usdt, source) VALUES ($1,$2,$3)',
      [round2(m.rate + adj - SPREAD), ton ? Math.round(ton * 10000) / 10000 : null, m.source]);
  } catch (e) { console.warn('[rates] history:', e.message); }
}

const formatMskTime = ts => ts ? new Date(ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' МСК' : '—';

function register(d) {
  const { app, query, authMiddleware, adminMiddleware, webAppUrl, upsertUser, getEffectiveRate, notifyManager, formatMsk, bot, MIN_RUB } = d;
  if (!historyStarted) {   // точка истории каждые 5 минут, независимо от посещаемости
    historyStarted = true;
    setTimeout(() => recordRate(query, bot), 8000).unref();
    setInterval(() => recordRate(query, bot), 5 * 60 * 1000).unref();
  }
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
      hc_discount: HC_DISCOUNT, hc_min_rub: HC_MIN_RUB, min_amount: MIN_AMOUNT,
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
    if (amount < MIN_AMOUNT) return res.status(400).json({ error: `Минимальная сумма — ${MIN_AMOUNT} ${asset}` });
    if (hc && rub < HC_MIN_RUB) return res.status(400).json({ error: `High-check: выплата от ${HC_MIN_RUB.toLocaleString('ru-RU')} ₽` });
    const dup = await query("SELECT 1 FROM orders WHERE check_url=$1 AND status<>'cancelled' LIMIT 1", [check_url.trim()]);
    if (dup.rows[0]) return res.status(400).json({ error: 'Этот чек уже использован в другой заявке' });
    const refEarnRub = refTgId ? Number((usdtEq * (baseU - rateU)).toFixed(2)) : 0;
    const refEarnUsdt = refTgId ? Number((refEarnRub / baseU).toFixed(2)) : 0;
    const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites,check_url,ref_tg_id,ref_earn,ref_earn_usdt,high_check,asset,amount)
      VALUES ($1,'exchange',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [user.tg_id, usdtEq, rub, requisites.trim(), check_url.trim(), refTgId, refEarnRub, refEarnUsdt, hc, asset, amount]);
    const order = r.rows[0];
    if (refTgId && refEarnUsdt > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarnUsdt, refTgId]);
    {
      const t = managerOrderTexts({ hc, asset, user, order, amount, usdtEq, rub, rate, requisites: requisites.trim(), check: check_url.trim() });
      const base = webAppUrl ? webAppUrl() : (process.env.WEBAPP_URL || '');
      const kb = /^https:\/\//.test(base) ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть заявку', web_app: { url: `${base}/admin.html?order=${order.id}` } }]] } } : {};
      for (const aid of adminIds()) sendRich(bot, aid, t.html, t.plain, kb).catch(e => console.error('Exchange notify error:', e.message));
    }
    res.json({ success: true, order });
  }));

  // История курса для графика на главной (курс продажи за 1 USDT и 1 TON без персональной комиссии)
  app.get('/api/rate-history', authMiddleware, wrap(async (req, res) => {
    await ensureTable(query);
    const range = req.query.range === '7d' ? '7d' : '24h';
    const r = await query('SELECT ts, sell, ton_usdt FROM rate_history WHERE ts > NOW() - make_interval(hours => $1::int) ORDER BY ts', [range === '7d' ? 168 : 24]);
    let rows = r.rows;
    if (rows.length > 120) { const step = rows.length / 120; const last = rows[rows.length - 1]; rows = Array.from({ length: 120 }, (_, i) => rows[Math.floor(i * step)]); rows.push(last); }
    res.json({ range, points: rows.map(p => ({ t: p.ts, usdt: Number(p.sell), ton: p.ton_usdt ? round2(Number(p.ton_usdt) * Number(p.sell)) : null })) });
  }));

  // Админка: откуда взят рыночный курс и ручная поправка к нему
  if (adminMiddleware) {
    app.get('/api/admin/rate', adminMiddleware, wrap(async (req, res) => {
      const m = await getMarket(bot).catch(() => null);
      const adjust = Number(await getSetting(query, 'market_adjust', '0')) || 0;
      res.json({ market: m ? m.rate : null, source: m ? m.source : null, age_sec: m && m.at ? Math.round((Date.now() - m.at) / 1000) : null,
        adjust, spread: SPREAD, sell: m ? round2(m.rate + adjust - SPREAD) : null, override: !!process.env.MARKET_RATE_OVERRIDE });
    }));
    app.post('/api/admin/rate', adminMiddleware, wrap(async (req, res) => {
      const adjust = Number(req.body && req.body.adjust);
      if (!Number.isFinite(adjust) || Math.abs(adjust) > 50) return res.status(400).json({ error: 'Поправка должна быть от −50 до 50 ₽' });
      await setSetting(query, 'market_adjust', adjust);
      res.json({ success: true, adjust });
    }));
  }

  // Экспорт данных пользователя: JSON-файл отправляется ботом в личный чат (скачивание внутри Telegram WebView ненадёжно)
  const exportTs = new Map();
  app.post('/api/export', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    if (Date.now() - (exportTs.get(String(user.tg_id)) || 0) < 60000) return res.status(429).json({ error: 'Подождите минуту перед повторным экспортом' });
    await ensureTable(query);
    const [orders, invited, earned] = await Promise.all([
      query('SELECT id, type, asset, amount, usdt, rub, requisites, check_url, status, high_check, created_at FROM orders WHERE tg_id=$1 ORDER BY id', [user.tg_id]),
      query('SELECT COUNT(*) AS c FROM users WHERE referred_by=$1', [user.tg_id]),
      query('SELECT COALESCE(SUM(ref_earn_usdt),0) AS s FROM orders WHERE ref_tg_id=$1', [user.tg_id]),
    ]);
    const data = {
      service: 'Eclipse Exchange', exported_at: new Date().toISOString(),
      profile: { telegram_id: Number(user.tg_id), username: user.username || null, first_name: user.first_name || null, last_name: user.last_name || null,
        registered_at: user.created_at, terms_accepted_at: user.agreed_at || null, balance_usdt: Number(user.balance) },
      referral: { code: user.ref_code || null, commission: user.ref_delta ? { value: Number(user.ref_delta), type: user.ref_delta_type } : null,
        invited_users: Number(invited.rows[0].c), earned_usdt: Number(earned.rows[0].s), came_by_referral_link: !!user.referred_by },
      orders: orders.rows.map(o => ({ ...o, amount: o.amount != null ? Number(o.amount) : null, usdt: Number(o.usdt), rub: Number(o.rub) })),
    };
    try {
      await bot.sendDocument(user.tg_id, Buffer.from(JSON.stringify(data, null, 2), 'utf8'), { caption: 'Экспорт ваших данных Eclipse Exchange' },
        { filename: `eclipse-export-${new Date().toISOString().slice(0, 10)}.json`, contentType: 'application/json' });
    } catch (e) {
      console.error('Export send error:', e.message);
      return res.status(502).json({ error: 'Не удалось отправить файл. Напишите боту /start и повторите' });
    }
    exportTs.set(String(user.tg_id), Date.now());
    res.json({ success: true });
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
    if (typeof open === 'boolean') await setAccepting(query, bot, open, webAppUrl);
    if (Number.isInteger(operators) && operators >= 0 && operators <= 99) await setSetting(query, 'operators', operators);
    res.json({ success: true, ...(await getStatus(query)) });
  }));
  bot.onText(/^\/open\b/, async m => { if (!isAdminId(m.from.id)) return; const ch = await setAccepting(query, bot, true, webAppUrl); bot.sendMessage(m.chat.id, ch ? '✅ Приём заявок открыт, клиентам отправлено уведомление' : 'Приём заявок уже открыт'); });
  bot.onText(/^\/close\b/, async m => { if (!isAdminId(m.from.id)) return; const ch = await setAccepting(query, bot, false, webAppUrl); bot.sendMessage(m.chat.id, ch ? '⛔ Приём заявок закрыт, клиентам отправлено уведомление' : 'Приём заявок уже закрыт'); });

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

// ── Приветствие бота: статус приёма, актуальные курсы, операторы ───────────────
const fmtRub = n => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';

// Курсы берутся из той же 10-минутной котировки, что видит пользователь в приложении (с учётом его реферальной комиссии)
async function getGreetingData(query, bot, user, getEffectiveRate) {
  const st = await getStatus(query).catch(() => ({ open: true, operators: 1 }));
  let usdt = null, ton = null;
  try {
    const qt = await getQuote(query, bot, user.tg_id);
    const eff = await getEffectiveRate(user, Number(qt.sell_rate), 'sell');
    usdt = round2(eff.rate);
    ton = qt.ton_usdt ? round2(Number(qt.ton_usdt) * usdt) : null;
  } catch (e) { console.warn('[greeting] курс недоступен:', e.message); }
  return { open: st.open, operators: st.operators, usdt, ton };
}

// Кастомные эмодзи (ID можно переопределить переменной EMOJI_<ИМЯ>, пустое значение отключает одно, CUSTOM_EMOJI=off — все)
const EMOJI_IDS = { title: '5893365462837760511', open: '5447464938874348535', closed: '5246821534437221767', usdt: '5893473283696759404',
  ton: '5260681660189408650', payout: '5893450623449305489', operators: '5902335789798265487', admin: '5445033158456145975',
  btn: '5895652322469482989', id: '5226573147343449978', user: '5902335789798265487', give: '5406920593629024429', get: '5406730197728790719', requisites: '5902056028513505203',
  check: '5444961234933806330', time: '5902050947567194830', done: '5447464938874348535', rejected: '5246821534437221767' };
const EMOJI_FALLBACK = { title: '🌑', open: '🟢', closed: '🔴', usdt: '💵', ton: '💎', payout: '✈️', operators: '👤', admin: '🛡',
  btn: '🌑', id: '🆔', user: '👤', give: '💵', get: '💴', requisites: '🏦', check: '🔗', time: '⏰', done: '✅', rejected: '❌' };
function emojiId(key) {
  if ((process.env.CUSTOM_EMOJI || '').toLowerCase() === 'off') return null;
  const env = process.env['EMOJI_' + key.toUpperCase()];
  const id = env !== undefined ? env.trim() : EMOJI_IDS[key];
  return /^\d+$/.test(id || '') ? id : null;
}
const customEmojiEnabled = () => Object.keys(EMOJI_IDS).some(k => emojiId(k));
const ce = key => { const id = emojiId(key); return id ? `<tg-emoji emoji-id="${id}">${EMOJI_FALLBACK[key]}</tg-emoji> ` : ''; };
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// То же приветствие в HTML-режиме — с кастомными эмодзи
function greetingHtml(d) {
  const L = [`${ce('title')}<b>Eclipse Exchange</b> — обмен USDT и TON на рубли`, ''];
  L.push(d.open ? `${ce('open')}<b>Приём заявок открыт</b> — можно обменивать прямо сейчас` : `${ce('closed')}<b>Приём заявок закрыт</b> — заявки временно не принимаются`, '');
  if (d.usdt) L.push(`${ce('usdt')}USDT: ${fmtRub(d.usdt)}`);
  if (d.ton) L.push(`${ce('ton')}TON: ${fmtRub(d.ton)}`);
  if (d.usdt || d.ton) L.push('');
  L.push(`${ce('payout')}Рубли на карту или по СБП, обычно за ${esc(process.env.PAYOUT_ETA || '5–15 минут')}`);
  if (d.open) L.push('', `${ce('operators')}Операторов на смене: ${d.operators}`);
  return L.join('\n');
}

// Отправка с кастомными эмодзи (HTML); если Telegram не принял — обычный текст
async function sendRich(bot, chatId, html, plain, opts = {}) {
  if (customEmojiEnabled()) {
    try { const r = await bot.sendMessage(chatId, html, { ...opts, parse_mode: 'HTML' }); if (r) return r; }
    catch (e) { console.warn('[emoji] вариант с кастомными эмодзи не отправился:', e.message); }
  }
  return bot.sendMessage(chatId, plain, opts);
}

// Текст сообщения → HTML с сохранением кастомных эмодзи (offset/length у Telegram — в UTF-16, как и строки JS)
function messageToHtml(m) {
  const text = m.text || m.caption || '';
  const ents = (m.entities || m.caption_entities || []).filter(e => e.type === 'custom_emoji').sort((a, b) => a.offset - b.offset);
  let out = '', pos = 0;
  for (const e of ents) {
    out += esc(text.slice(pos, e.offset)) + `<tg-emoji emoji-id="${e.custom_emoji_id}">${esc(text.slice(e.offset, e.offset + e.length))}</tg-emoji>`;
    pos = e.offset + e.length;
  }
  return out + esc(text.slice(pos));
}

// Дописывает статус к сообщению менеджера, не теряя кастомные эмодзи (для фото-заявок правится подпись)
async function editStatus(bot, m, suffix) {
  const opts = { chat_id: m.chat.id, message_id: m.message_id, parse_mode: 'HTML' };
  const html = messageToHtml(m) + '\n\n' + esc(suffix);
  try { return m.photo ? await bot.editMessageCaption(html, opts) : await bot.editMessageText(html, opts); }
  catch (e) { console.warn('[status edit]', e.message); }
}

// Заявка на продажу — сообщение оператору
function managerOrderTexts({ hc, asset, user, order, amount, usdtEq, rub, rate, requisites, check }) {
  const tag = user.username ? `@${user.username}` : `#${user.tg_id}`;
  const give = `${amount} ${asset}${asset === 'TON' ? ` (≈ ${usdtEq.toFixed(2)} USDT)` : ''}`;
  const get = `${Math.round(rub).toLocaleString('ru-RU')} ₽ (курс ${rate.toFixed(2)})`;
  const time = formatMskTime(order.created_at);
  return {
    plain: `${hc ? '⭐ HIGH-CHECK · приоритет\n\n' : ''}🔄 Продажа ${asset} → ₽\n\n👤 ${tag} (${user.first_name || ''})\n🆔 Заявка: #${order.code || order.id}\n` +
      `💵 Отдаёт: ${give}\n💴 Получает: ${get}\n🏦 Реквизиты: ${requisites}\n🔗 Чек: ${check}\n⏰ ${time}`,
    html: `${hc ? '⭐ HIGH-CHECK · приоритет\n\n' : ''}${ce('title')}Продажа ${asset} → ₽\n\n${ce('user')}${esc(tag)} (${esc(user.first_name || '')})\n${ce('id')}Заявка: #${order.code || order.id}\n` +
      `${ce('give')}Отдаёт: ${esc(give)}\n${ce('get')}Получает: ${esc(get)}\n${ce('requisites')}Реквизиты: ${esc(requisites)}\n${ce('check')}Чек: ${esc(check)}\n${ce('time')}${esc(time)}`,
  };
}

// Сообщения клиенту: заявка выполнена / отклонена
function doneNotice(order, isCryptoDeposit) {
  const n = Math.round(Number(order.rub)).toLocaleString('ru-RU');
  const [text, key, plainEmoji] = order.type === 'exchange' ? [`${n} ₽ отправлены на ваши реквизиты.`, 'get', '💴']
    : order.type === 'withdrawal' ? [`Чек на ${Number(order.usdt)} USDT отправлен вам в Telegram.`, 'get', '💵']
    : isCryptoDeposit ? [`${Number(order.usdt)} USDT зачислены на ваш баланс.`, 'get', '💵'] : [null];
  if (!text) return { plain: `✅ Заявка #${order.code || order.id} выполнена!\n\n✅ Ваша заявка выполнена!`, html: `${ce('done')}Заявка #${order.code || order.id} выполнена!\n\n${ce('done')}Ваша заявка выполнена!` };
  return { plain: `✅ Заявка #${order.code || order.id} выполнена!\n\n${plainEmoji} ${text}`, html: `${ce('done')}Заявка #${order.code || order.id} выполнена!\n\n${ce(key)}${esc(text)}` };
}
const rejectNotice = order => ({
  plain: `❌ Заявка #${order.code || order.id} отклонена.\nЕсть вопросы — напишите менеджеру.`,
  html: `${ce('rejected')}Заявка #${order.code || order.id} отклонена.\nЕсть вопросы — напишите менеджеру.`,
});

// Операторы: MANAGER_CHAT_ID + необязательный список ADMIN_IDS через запятую
function adminIds() {
  const s = new Set();
  if (process.env.MANAGER_CHAT_ID) s.add(String(process.env.MANAGER_CHAT_ID).trim());
  (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean).forEach(x => s.add(x));
  return [...s];
}
const isAdminId = id => adminIds().includes(String(id));

// Автоматическое уведомление клиентов об открытии / закрытии приёма заявок
async function broadcastStatus(query, bot, open, webAppUrl) {
  try {
    const head = open ? 'Приём заявок открыт' : 'Приём заявок закрыт';
    const sub = open ? 'Можно обменивать USDT или TON на рубли.' : 'Заявки временно не принимаются.';
    const base = webAppUrl ? webAppUrl() : '';
    const kb = open && /^https:\/\//.test(base) ? { reply_markup: { inline_keyboard: [[{ text: 'Открыть обменник', web_app: { url: base } }]] } } : {};
    const r = await query('SELECT tg_id FROM users WHERE blocked=0 AND agreed=1 AND COALESCE(notify_status,1)=1');
    let sent = 0;
    for (const u of r.rows) {
      try { if (await sendRich(bot, u.tg_id, `${ce(open ? 'open' : 'closed')}<b>${head}</b>\n${sub}`, `${open ? '🟢' : '🔴'} ${head}\n${sub}`, kb)) sent++; } catch (e) {}
      await new Promise(r2 => setTimeout(r2, 40));
    }
    console.log(`[status] уведомление «${head}»: ${sent}/${r.rows.length}`);
  } catch (e) { console.warn('[status] рассылка не удалась:', e.message); }
}
async function setAccepting(query, bot, open, webAppUrl) {
  const prev = (await getSetting(query, 'accepting', '1')) === '1';
  await setSetting(query, 'accepting', open ? '1' : '0');
  if (prev !== open) broadcastStatus(query, bot, open, webAppUrl);   // в фоне, ответ не ждёт рассылку
  return prev !== open;
}

function greetingText(d) {
  const L = ['*Eclipse Exchange* — обмен USDT и TON на рубли', ''];
  L.push(d.open ? '*Приём заявок открыт* — можно обменивать прямо сейчас' : '*Приём заявок закрыт* — заявки временно не принимаются', '');
  if (d.usdt) L.push('USDT: ' + fmtRub(d.usdt));
  if (d.ton) L.push('TON: ' + fmtRub(d.ton));
  if (d.usdt || d.ton) L.push('');
  L.push('Рубли на карту или по СБП, обычно за ' + (process.env.PAYOUT_ETA || '5–15 минут'));
  if (d.open) L.push('', 'Операторов на смене: ' + d.operators);
  return L.join('\n');
}

module.exports = { register, getGreetingData, greetingText, greetingHtml, emojiId, customEmojiEnabled, esc, ce, adminIds, isAdminId, setAccepting, sendRich, editStatus, messageToHtml, doneNotice, rejectNotice, _test: { median, round2, CHECK_RE } };
