// Динамический курс: берём рыночный USDT/RUB, добавляем спред и фиксируем котировку на 10 минут.
// Подключается из index.js одной строкой (см. инструкцию), старые обработчики ниже по файлу
// для /api/exchange, /api/buy, /api/deposit и отзывов перекрываются этим модулем.
const https = require('https');

const SPREAD = Number(process.env.SPREAD_RUB ?? 5);   // ± к рыночному курсу, ₽
const TTL_SEC = 600;          // котировка живёт 10 минут
const REUSE_MIN_LEFT = 30;    // отдаём ту же котировку, пока до конца > 30 сек
const GRACE_SEC = 10;         // допуск на задержку при создании заявки
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
    await query("DELETE FROM quotes WHERE created_at < NOW() - INTERVAL '2 days'");
  })().catch(e => { tableReady = null; throw e; });
  return tableReady;
}

const LEFT = 'EXTRACT(EPOCH FROM (expires_at - NOW())) AS "left"';

async function getQuote(query, bot, tgId) {
  await ensureTable(query);
  const ex = await query(`SELECT *, ${LEFT} FROM quotes WHERE tg_id=$1 AND expires_at > NOW() + make_interval(secs => $2::double precision)
                          ORDER BY id DESC LIMIT 1`, [tgId, REUSE_MIN_LEFT]);
  if (ex.rows[0]) return ex.rows[0];
  const m = await getMarket(bot);
  const sell = round2(m.rate - SPREAD), buy = round2(m.rate + SPREAD);
  const r = await query(`INSERT INTO quotes (tg_id, market, sell_rate, buy_rate, expires_at)
    VALUES ($1,$2,$3,$4, NOW() + make_interval(secs => $5::double precision)) RETURNING *, ${LEFT}`, [tgId, m.rate, sell, buy, TTL_SEC]);
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
  const { app, query, authMiddleware, upsertUser, getEffectiveRate, notifyManager, formatMsk, bot, MIN_RUB } = d;
  const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' }); });

  // Текущая котировка пользователя (с учётом реферальной наценки)
  app.get('/api/quote', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const q = await getQuote(query, bot, user.tg_id);
    const sell = await getEffectiveRate(user, Number(q.sell_rate), 'sell');
    const buy = await getEffectiveRate(user, Number(q.buy_rate), 'buy');
    res.json({ id: q.id, seconds_left: Math.max(0, Math.floor(Number(q.left))),
      base_sell: Number(q.sell_rate), base_buy: Number(q.buy_rate),
      sell_rate: round2(sell.rate), buy_rate: round2(buy.rate) });
  }));

  // Продажа USDT → ₽ по зафиксированному курсу
  app.post('/api/exchange', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const { usdt, requisites, quote_id } = req.body;
    if (!usdt || typeof usdt !== 'number' || usdt <= 0) return res.status(400).json({ error: 'Некорректная сумма' });
    const q = await loadQuote(query, quote_id, user.tg_id);
    if (!q) return res.status(409).json(EXPIRED);
    const base = Number(q.sell_rate);
    const eff = await getEffectiveRate(user, base, 'sell');
    const rate = round2(eff.rate), refTgId = eff.refTgId;
    const rub = usdt * rate;
    if (rub < MIN_RUB) return res.status(400).json({ error: `Минимум ${MIN_RUB} ₽ (~${(MIN_RUB / rate).toFixed(2)} USDT)` });
    if (!requisites || requisites.trim().length < 5) return res.status(400).json({ error: 'Укажите реквизиты' });
    const refEarnRub = refTgId ? Number((usdt * (base - rate)).toFixed(2)) : 0;
    const refEarnUsdt = refTgId ? Number((refEarnRub / base).toFixed(2)) : 0;
    // атомарное списание: не уйдёт в минус даже при двух одновременных запросах
    const dbt = await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2 AND balance>=$1 RETURNING balance', [usdt, user.tg_id]);
    if (!dbt.rows[0]) {
      const bal = Number(user.balance);
      return res.status(400).json({ error: `Недостаточно средств. Баланс: ${bal.toFixed(2)} USDT`, code: 'INSUFFICIENT_BALANCE', balance: bal });
    }
    if (refTgId && refEarnUsdt > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarnUsdt, refTgId]);
    const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites,ref_tg_id,ref_earn,ref_earn_usdt)
      VALUES ($1,'exchange',$2,$3,$4,$5,$6,$7) RETURNING *`, [user.tg_id, usdt, rub, requisites.trim(), refTgId, refEarnRub, refEarnUsdt]);
    notifyManager(r.rows[0], user);
    res.json({ success: true, order: r.rows[0], balance: Number(dbt.rows[0].balance) });
  }));

  // Покупка USDT за ₽ по зафиксированному курсу
  app.post('/api/buy', authMiddleware, wrap(async (req, res) => {
    const user = await upsertUser(req.tgUser);
    const { wallet, quote_id } = req.body;
    const rub = Number(req.body.rub);
    if (!Number.isFinite(rub) || rub < MIN_RUB) return res.status(400).json({ error: 'Минимальная сумма 4 000 ₽' });
    if (!wallet || wallet.length < 10) return res.status(400).json({ error: 'Укажите USDT кошелёк' });
    const q = await loadQuote(query, quote_id, user.tg_id);
    if (!q) return res.status(409).json(EXPIRED);
    const base = Number(q.buy_rate);
    const eff = await getEffectiveRate(user, base, 'buy');
    const rate = round2(eff.rate), refTgId = eff.refTgId;
    const usdt = Number((rub / rate).toFixed(2));
    const refEarnRub = refTgId ? Number((usdt * (rate - base)).toFixed(2)) : 0;
    const refEarnUsdt = refTgId ? Number((refEarnRub / base).toFixed(2)) : 0;
    const r = await query(`INSERT INTO orders (tg_id,type,usdt,rub,requisites,ref_tg_id,ref_earn,ref_earn_usdt)
      VALUES ($1,'buy',$2,$3,$4,$5,$6,$7) RETURNING *`, [user.tg_id, usdt, rub, wallet, refTgId, refEarnRub, refEarnUsdt]);
    const order = r.rows[0];
    if (refTgId && refEarnUsdt > 0) await query('UPDATE users SET balance=balance+$1 WHERE tg_id=$2', [refEarnUsdt, refTgId]);
    if (process.env.MANAGER_CHAT_ID) {
      const tag = user.username ? `@${user.username}` : `#${user.tg_id}`;
      const text = `💰 Покупка USDT за ₽\n\n👤 ${tag} (${user.first_name || ''})\n🆔 Заявка: #${order.id}\n` +
        `💴 Отдаёт: ${Math.round(rub).toLocaleString('ru-RU')} ₽\n💵 Получает: ${usdt.toFixed(2)} USDT\n` +
        `📈 Курс: ${rate.toFixed(2)} ₽\n👛 Кошелёк: ${wallet}\n⏰ ${formatMsk(order.created_at)}`;
      bot.sendMessage(process.env.MANAGER_CHAT_ID, text, { reply_markup: { inline_keyboard: [[
        { text: '✅ Выполнено', callback_data: `done_${order.id}` }, { text: '❌ Отклонить', callback_data: `cancel_${order.id}` }]] } })
        .catch(e => console.error('Buy notify error:', e.message));
    }
    res.json({ success: true, order });
  }));

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
