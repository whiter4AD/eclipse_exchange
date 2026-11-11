// Заявки на продажу: ожидание оператора → принята → выплата одним или несколькими переводами → выполнена.
// Клиент видит статус и подтверждает каждый перевод, оператор работает в админке (список заявок, выплаты, чат).
const quotes = require('./quotes');
const { esc, ce, sendRich } = quotes;

const round2 = n => Math.round(n * 100) / 100;
const fmt = n => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskReq = r => String(r || '').replace(/\d{9,}/g, m => '•••• ' + m.slice(-4));
const num = o => '#' + (o.code || o.id);   // публичный номер заявки, например #FG418ADF
const opName = u => (u.username ? '@' + u.username : (u.first_name || 'оператор'));

// ── Схема ─────────────────────────────────────────────────────────────────────
let ready = null;
function initSchema(query) {
  if (!ready) ready = (async () => {
    const stmts = [
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS code TEXT',
      `CREATE OR REPLACE FUNCTION gen_order_code() RETURNS text AS $$
        DECLARE c text; L text := 'ABCDEFGHJKLMNPQRSTUVWXYZ'; i int;
        BEGIN LOOP
          c := '';
          FOR i IN 1..2 LOOP c := c || substr(L, 1 + floor(random()*24)::int, 1); END LOOP;
          FOR i IN 1..3 LOOP c := c || floor(random()*10)::int::text; END LOOP;
          FOR i IN 1..3 LOOP c := c || substr(L, 1 + floor(random()*24)::int, 1); END LOOP;
          EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE code = c);
        END LOOP; RETURN c; END $$ LANGUAGE plpgsql`,
      'UPDATE orders SET code = gen_order_code() WHERE code IS NULL',
      'CREATE UNIQUE INDEX IF NOT EXISTS orders_code_uq ON orders (code)',
      'ALTER TABLE orders ALTER COLUMN code SET DEFAULT gen_order_code()',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_id BIGINT',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_name TEXT',
      'ALTER TABLE orders ADD COLUMN IF NOT EXISTS decline_reason TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_status INTEGER DEFAULT 1',
      `CREATE TABLE IF NOT EXISTS order_parts (id SERIAL PRIMARY KEY, order_id INTEGER, seq INTEGER, amount NUMERIC,
        method TEXT DEFAULT 'СБП', status TEXT DEFAULT 'planned', sent_at TIMESTAMPTZ, confirmed_at TIMESTAMPTZ, note TEXT)`,
      'CREATE INDEX IF NOT EXISTS order_parts_order ON order_parts (order_id)',
      `CREATE TABLE IF NOT EXISTS order_messages (id SERIAL PRIMARY KEY, order_id INTEGER, sender TEXT, sender_name TEXT, text TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
      'CREATE INDEX IF NOT EXISTS order_messages_order ON order_messages (order_id, id)',
    ];
    for (const sql of stmts) {
      try { await query(sql); } catch (e) { if (!/already exists|duplicate column/i.test(e.message)) throw e; }
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

// ── Представление заявки ─────────────────────────────────────────────────────
function viewOrder(o, parts, extra = {}, admin = false) {
  const total = Number(o.rub);
  const amount = o.amount != null ? Number(o.amount) : Number(o.usdt);
  const sent = round2(parts.filter(p => p.status === 'sent' || p.status === 'confirmed').reduce((a, p) => a + Number(p.amount), 0));
  const v = {
    id: o.id, code: o.code || null, type: o.type, status: o.status, asset: o.asset || 'USDT', amount, rub: round2(total), rate: amount ? round2(total / amount) : null,
    high_check: !!o.high_check, created_at: o.created_at, accepted_at: o.accepted_at || null, finished_at: o.finished_at || null,
    decline_reason: o.decline_reason || null, operator: o.operator_name || null,
    requisites: admin ? o.requisites : maskReq(o.requisites),
    parts: parts.map((p, i) => ({ id: p.id, n: i + 1, amount: Number(p.amount), method: p.method, status: p.status })),
    sent_total: sent, remaining: round2(Math.max(0, total - sent)), ...extra,
  };
  if (admin) {
    v.check_url = o.check_url;
    v.user = { tg_id: Number(o.tg_id), username: o.u_username || null, first_name: o.u_first_name || null };
  }
  return v;
}

function register(d) {
  const { app, query, bot, authMiddleware, adminMiddleware, upsertUser, webAppUrl } = d;
  const wrap = fn => (req, res) => fn(req, res).catch(e => {
    console.error(`${req.method} ${req.path} error:`, e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' });
  });
  const one = async (sql, p) => (await query(sql, p)).rows[0] || null;
  const parts = async id => (await query('SELECT * FROM order_parts WHERE order_id=$1 ORDER BY seq, id', [id])).rows;
  const sys = (id, text) => query("INSERT INTO order_messages (order_id, sender, sender_name, text) VALUES ($1,'system','',$2)", [id, text]);
  const idOf = req => { const n = parseInt(req.params.id, 10); return Number.isInteger(n) && n > 0 ? n : null; };
  const baseUrl = () => { const b = webAppUrl ? webAppUrl() : (process.env.WEBAPP_URL || ''); return /^https:\/\//.test(b) ? b : null; };
  const kb = (path, text) => (baseUrl() ? { reply_markup: { inline_keyboard: [[{ text, web_app: { url: baseUrl() + path } }]] } } : {});

  // Уведомления в Telegram (не критичны — ошибки только в лог)
  const tell = (o, html, plain) => sendRich(bot, o.tg_id, html, plain, kb(`/?order=${o.id}`, 'Открыть заявку')).catch(e => console.warn('[orders] notify user:', e.message));
  const tellAdmins = (id, html, plain) => quotes.adminIds().forEach(a =>
    sendRich(bot, a, html, plain, kb(`/admin.html?order=${id}`, 'Открыть заявку')).catch(e => console.warn('[orders] notify admin:', e.message)));
  const pings = new Map();
  const throttled = (key, ms) => { const n = Date.now(); if (n - (pings.get(key) || 0) < ms) return true; pings.set(key, n); return false; };
  const hits = new Map();
  const limited = uid => { const n = Date.now(); const a = (hits.get(uid) || []).filter(t => n - t < 60000); a.push(n); hits.set(uid, a); return a.length > 20; };

  // Если все переводы подтверждены — заявка выполнена
  async function finalizeIfDone(orderId) {
    const ps = await parts(orderId);
    if (!ps.length || !ps.every(p => p.status === 'confirmed')) return null;
    const o = (await query("UPDATE orders SET status='done', finished_at=NOW() WHERE id=$1 AND status='accepted' RETURNING *", [orderId])).rows[0];
    if (!o) return null;
    await sys(orderId, 'Все переводы подтверждены — заявка выполнена. Спасибо!');
    tell(o, `${ce('done')}Заявка ${num(o)} выполнена!\n\n${ce('get')}${esc(fmt(o.rub))} ₽ выплачено на ваши реквизиты.`, `✅ Заявка ${num(o)} выполнена!\n\n💴 ${fmt(o.rub)} ₽ выплачено на ваши реквизиты.`);
    return o;
  }

  // ── Клиент ─────────────────────────────────────────────────────────────────
  async function mine(req) {
    await initSchema(query);
    const id = idOf(req); if (!id) return null;
    const user = await upsertUser(req.tgUser);
    const o = await one('SELECT * FROM orders WHERE id=$1', [id]);
    return o && String(o.tg_id) === String(user.tg_id) ? { o, user } : null;
  }

  app.get('/api/orders/:id', authMiddleware, wrap(async (req, res) => {
    const m = await mine(req); if (!m) return res.status(404).json({ error: 'Заявка не найдена' });
    const c = await one("SELECT COUNT(*) AS c FROM order_messages WHERE order_id=$1 AND sender='operator'", [m.o.id]);
    res.json(viewOrder(m.o, await parts(m.o.id), { op_msg_count: Number(c.c) }));
  }));

  app.get('/api/orders/:id/messages', authMiddleware, wrap(async (req, res) => {
    const m = await mine(req); if (!m) return res.status(404).json({ error: 'Заявка не найдена' });
    const r = await query('SELECT id, sender, sender_name, text, created_at FROM order_messages WHERE order_id=$1 AND id>$2 ORDER BY id LIMIT 200', [m.o.id, Number(req.query.after) || 0]);
    res.json({ messages: r.rows });
  }));

  app.post('/api/orders/:id/messages', authMiddleware, wrap(async (req, res) => {
    const m = await mine(req); if (!m) return res.status(404).json({ error: 'Заявка не найдена' });
    if (!['pending', 'accepted'].includes(m.o.status)) return res.status(409).json({ error: 'Чат по этой заявке закрыт' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    if (limited(String(m.user.tg_id))) return res.status(429).json({ error: 'Слишком часто, подождите минуту' });
    await query("INSERT INTO order_messages (order_id, sender, sender_name, text) VALUES ($1,'user',$2,$3)", [m.o.id, m.user.username ? '@' + m.user.username : (m.user.first_name || ''), text]);
    if (!throttled('u' + m.o.id, 30000))
      tellAdmins(m.o.id, `<b>Сообщение по заявке ${num(m.o)}</b>\n${esc(text)}`, `Сообщение по заявке ${num(m.o)}\n${text}`);
    res.json({ success: true });
  }));

  // Клиент подтверждает (или оспаривает) полученный перевод
  app.post('/api/orders/:id/parts/:pid/confirm', authMiddleware, wrap(async (req, res) => {
    const m = await mine(req); if (!m) return res.status(404).json({ error: 'Заявка не найдена' });
    const pid = parseInt(req.params.pid, 10);
    const received = req.body && req.body.received === true;
    const to = received ? 'confirmed' : 'disputed';
    const p = (await query(`UPDATE order_parts SET status=$3, confirmed_at=${received ? 'NOW()' : 'confirmed_at'} WHERE id=$1 AND order_id=$2 AND status='sent' RETURNING *`, [pid, m.o.id, to])).rows[0];
    if (!p) return res.status(409).json({ error: 'Этот перевод уже обработан' });
    if (received) { await sys(m.o.id, `Клиент подтвердил получение ${fmt(p.amount)} ₽.`); await finalizeIfDone(m.o.id); }
    else {
      await sys(m.o.id, `Клиент отметил: перевод ${fmt(p.amount)} ₽ не пришёл.`);
      tellAdmins(m.o.id, `${ce('rejected')}<b>Клиент не получил перевод</b>\nЗаявка ${num(m.o)}, ${esc(fmt(p.amount))} ₽ — откройте чат`, `❌ Клиент не получил перевод\nЗаявка ${num(m.o)}, ${fmt(p.amount)} ₽ — откройте чат`);
    }
    res.json({ success: true });
  }));

  // Уведомления о приёме заявок можно отключить
  app.post('/api/settings/notify', authMiddleware, wrap(async (req, res) => {
    await initSchema(query);
    const user = await upsertUser(req.tgUser);
    await query('UPDATE users SET notify_status=$1 WHERE tg_id=$2', [req.body && req.body.status === false ? 0 : 1, user.tg_id]);
    res.json({ success: true });
  }));

  // ── Оператор (админка) ─────────────────────────────────────────────────────
  const ADMIN_Q = 'SELECT o.*, u.username AS u_username, u.first_name AS u_first_name FROM orders o LEFT JOIN users u ON u.tg_id=o.tg_id';
  async function adminView(id) {
    const o = await one(`${ADMIN_Q} WHERE o.id=$1 AND o.type='exchange'`, [id]);
    return o ? viewOrder(o, await parts(id), {}, true) : null;
  }
  const guard = fn => wrap(async (req, res) => {
    await initSchema(query);
    const id = idOf(req); if (!id) return res.status(400).json({ error: 'Неверный номер заявки' });
    return fn(req, res, id);
  });

  app.get('/api/admin/orders', adminMiddleware, wrap(async (req, res) => {
    await initSchema(query);
    const where = ["o.type='exchange'"], p = [];
    const st = req.query.status;
    if (st === 'pending') where.push("o.status='pending'");
    else if (st === 'active') where.push("o.status IN ('pending','accepted')");
    const q = String(req.query.q || '').trim().toLowerCase().replace(/^[#№]/, '');
    if (q) {
      if (/^[a-z]{2}\d{3}[a-z]{3}$/.test(q)) { p.push(q.toUpperCase()); where.push(`o.code=$${p.length}`); }
      else if (/^\d+$/.test(q)) { p.push(Number(q)); where.push(`o.id=$${p.length}`); }
      else { p.push('%' + q.replace(/^@/, '') + '%'); where.push(`(LOWER(COALESCE(u.username,'')) LIKE $${p.length} OR LOWER(COALESCE(u.first_name,'')) LIKE $${p.length})`); }
    }
    const r = await query(`SELECT o.id, o.code, o.status, o.asset, o.amount, o.usdt, o.rub, o.high_check, o.created_at, o.operator_name,
        u.username AS u_username, u.first_name AS u_first_name,
        (SELECT sender FROM order_messages m WHERE m.order_id=o.id ORDER BY m.id DESC LIMIT 1) AS last_sender
      FROM orders o LEFT JOIN users u ON u.tg_id=o.tg_id WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN o.status='pending' THEN 0 WHEN o.status='accepted' THEN 1 ELSE 2 END, o.id DESC LIMIT 100`, p);
    res.json({ orders: r.rows.map(o => ({ id: o.id, code: o.code || null, status: o.status, asset: o.asset || 'USDT', amount: Number(o.amount != null ? o.amount : o.usdt), rub: round2(Number(o.rub)),
      high_check: !!o.high_check, created_at: o.created_at, operator: o.operator_name || null, user: o.u_username ? '@' + o.u_username : (o.u_first_name || '—'), last_sender: o.last_sender || null })) });
  }));

  app.get('/api/admin/orders/:id', adminMiddleware, guard(async (req, res, id) => {
    const v = await adminView(id); if (!v) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json(v);
  }));

  app.post('/api/admin/orders/:id/accept', adminMiddleware, guard(async (req, res, id) => {
    const o = (await query("UPDATE orders SET status='accepted', accepted_at=NOW(), operator_id=$2, operator_name=$3 WHERE id=$1 AND status='pending' AND type='exchange' RETURNING *", [id, req.tgUser.id, opName(req.tgUser)])).rows[0];
    if (!o) return res.status(409).json({ error: 'Заявка уже обработана или не найдена' });
    await query("INSERT INTO order_parts (order_id, seq, amount, method) VALUES ($1,1,$2,'СБП')", [id, round2(Number(o.rub))]);
    await sys(id, 'Оператор принял заявку. Здесь вы можете написать ему и следить за выплатой.');
    tell(o, `${ce('done')}Заявка ${num(o)} принята — оператор уже на связи.\nСледите за выплатой в приложении.`, `✅ Заявка ${num(o)} принята — оператор уже на связи.\nСледите за выплатой в приложении.`);
    res.json(await adminView(id));
  }));

  app.post('/api/admin/orders/:id/decline', adminMiddleware, guard(async (req, res, id) => {
    if ((await parts(id)).some(p => p.status !== 'planned')) return res.status(409).json({ error: 'Часть выплат уже отправлена — завершите заявку, а не отклоняйте' });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
    const o = (await query("UPDATE orders SET status='cancelled', finished_at=NOW(), decline_reason=$2 WHERE id=$1 AND status IN ('pending','accepted') AND type='exchange' RETURNING *", [id, reason || null])).rows[0];
    if (!o) return res.status(409).json({ error: 'Заявка уже обработана или не найдена' });
    if (o.ref_tg_id && Number(o.ref_earn_usdt) > 0) await query('UPDATE users SET balance=balance-$1 WHERE tg_id=$2', [o.ref_earn_usdt, o.ref_tg_id]);
    await sys(id, 'Заявка отклонена' + (reason ? `: ${reason}` : '.'));
    tell(o, `${ce('rejected')}Заявка ${num(o)} отклонена.${reason ? '\nПричина: ' + esc(reason) : ''}\nЕсть вопросы — напишите в поддержку.`, `❌ Заявка ${num(o)} отклонена.${reason ? '\nПричина: ' + reason : ''}\nЕсть вопросы — напишите в поддержку.`);
    res.json(await adminView(id));
  }));

  // План выплат: разбивка ещё не отправленной части суммы на переводы
  app.post('/api/admin/orders/:id/plan', adminMiddleware, guard(async (req, res, id) => {
    const o = await one("SELECT * FROM orders WHERE id=$1 AND status='accepted'", [id]);
    if (!o) return res.status(409).json({ error: 'Заявка не в работе' });
    const ps = await parts(id);
    const locked = ps.filter(p => p.status !== 'planned');
    const remaining = round2(Number(o.rub) - locked.reduce((a, p) => a + Number(p.amount), 0));
    const amounts = Array.isArray(req.body && req.body.amounts) ? req.body.amounts.map(Number) : [];
    if (remaining <= 0.005) return res.status(409).json({ error: 'Вся сумма уже распределена' });
    if (!amounts.length || amounts.some(a => !Number.isFinite(a) || a < 1)) return res.status(400).json({ error: 'Укажите суммы переводов (каждая от 1 ₽)' });
    const sum = amounts.reduce((a, b) => a + b, 0);
    if (sum > remaining + 0.01) return res.status(400).json({ error: `Сумма переводов больше остатка: ${fmt(remaining)} ₽` });
    // остаток, не вошедший в список, добавляется последним переводом; копейки до остатка — к последнему
    const rest = round2(remaining - sum);
    if (rest >= 1) amounts.push(rest); else amounts[amounts.length - 1] = round2(amounts[amounts.length - 1] + rest);
    if (amounts.length > 10) return res.status(400).json({ error: 'Не больше 10 переводов' });
    await query("DELETE FROM order_parts WHERE order_id=$1 AND status='planned'", [id]);
    let seq = ps.reduce((a, p) => Math.max(a, p.seq), 0);
    for (const a of amounts) await query("INSERT INTO order_parts (order_id, seq, amount, method) VALUES ($1,$2,$3,'СБП')", [id, ++seq, round2(a)]);
    res.json(await adminView(id));
  }));

  app.post('/api/admin/orders/:id/parts/:pid/sent', adminMiddleware, guard(async (req, res, id) => {
    const pid = parseInt(req.params.pid, 10);
    if (!(await one("SELECT 1 AS x FROM orders WHERE id=$1 AND status='accepted'", [id]))) return res.status(409).json({ error: 'Заявка не в работе' });
    if (await one("SELECT 1 AS x FROM order_parts WHERE order_id=$1 AND status='sent'", [id])) return res.status(409).json({ error: 'Дождитесь подтверждения предыдущего перевода' });
    const ps = await parts(id);
    const part = ps.find(p => p.id === pid);
    const firstPlanned = ps.find(p => p.status === 'planned');
    if (!part || !(part.status === 'disputed' || (part.status === 'planned' && firstPlanned && firstPlanned.id === pid))) return res.status(409).json({ error: 'Переводы отправляются по порядку' });
    await query("UPDATE order_parts SET status='sent', sent_at=NOW() WHERE id=$1 AND status IN ('planned','disputed')", [pid]);
    const n = ps.indexOf(part) + 1;
    await sys(id, ps.length > 1 ? `Перевод ${n} из ${ps.length} отправлен: ${fmt(part.amount)} ₽. Подтвердите получение.` : `Перевод отправлен: ${fmt(part.amount)} ₽. Подтвердите получение.`);
    const o = await one('SELECT * FROM orders WHERE id=$1', [id]);
    const label = ps.length > 1 ? `Перевод ${n} из ${ps.length}` : 'Перевод';
    tell(o, `${ce('get')}${label}: ${esc(fmt(part.amount))} ₽ отправлен.\nПодтвердите получение в приложении.`, `💴 ${label}: ${fmt(part.amount)} ₽ отправлен.\nПодтвердите получение в приложении.`);
    res.json(await adminView(id));
  }));

  // Если клиент не нажал «Да, получил» — оператор может подтвердить вручную
  app.post('/api/admin/orders/:id/parts/:pid/force', adminMiddleware, guard(async (req, res, id) => {
    const pid = parseInt(req.params.pid, 10);
    const p = (await query("UPDATE order_parts SET status='confirmed', confirmed_at=NOW(), note='подтверждено оператором' WHERE id=$1 AND order_id=$2 AND status IN ('sent','disputed') RETURNING *", [pid, id])).rows[0];
    if (!p) return res.status(409).json({ error: 'Перевод нельзя подтвердить' });
    await sys(id, `Оператор подтвердил перевод ${fmt(p.amount)} ₽.`);
    await finalizeIfDone(id);
    res.json(await adminView(id));
  }));

  app.get('/api/admin/orders/:id/messages', adminMiddleware, guard(async (req, res, id) => {
    const r = await query('SELECT id, sender, sender_name, text, created_at FROM order_messages WHERE order_id=$1 AND id>$2 ORDER BY id LIMIT 200', [id, Number(req.query.after) || 0]);
    res.json({ messages: r.rows });
  }));

  app.post('/api/admin/orders/:id/messages', adminMiddleware, guard(async (req, res, id) => {
    const o = await one("SELECT * FROM orders WHERE id=$1 AND status IN ('pending','accepted')", [id]);
    if (!o) return res.status(409).json({ error: 'Чат по этой заявке закрыт' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    await query("INSERT INTO order_messages (order_id, sender, sender_name, text) VALUES ($1,'operator',$2,$3)", [id, opName(req.tgUser), text]);
    if (!throttled('o' + id, 20000)) tell(o, `<b>Сообщение от оператора</b> по заявке ${num(o)}\n${esc(text)}`, `Сообщение от оператора по заявке ${num(o)}\n${text}`);
    res.json({ success: true });
  }));
}

module.exports = { register, initSchema, _test: { viewOrder, maskReq } };
