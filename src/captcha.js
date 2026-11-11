// Капча «Нажмите на <фрукт>»: показывается после /start, пока пользователь не пройдёт проверку.
const FRUITS = [['🍎', 'яблоко'], ['🍌', 'банан'], ['🥝', 'киви'], ['🍒', 'вишню'], ['🍉', 'арбуз'], ['🍇', 'виноград'],
  ['🍓', 'клубнику'], ['🍊', 'апельсин'], ['🍋', 'лимон'], ['🍍', 'ананас'], ['🍑', 'персик'], ['🍐', 'грушу']];
const TTL = 5 * 60 * 1000, MAX_FAILS = 5, LOCK = 60 * 1000;
const pending = new Map(); // tg_id -> { list, target, name, exp, fails, lockUntil }
setInterval(() => { const n = Date.now(); for (const [k, c] of pending) if (c.exp < n) pending.delete(k); }, 10 * 60 * 1000).unref();

// Колонка users.captcha_ok; все, кто уже был в базе, считаются прошедшими проверку
async function migrate(query) {
  const had = await query("SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='captcha_ok'");
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS captcha_ok INTEGER DEFAULT 0');
  if (!had.rows[0]) await query('UPDATE users SET captcha_ok=1');
}

function make(prev) {
  const pool = [...FRUITS].sort(() => Math.random() - 0.5).slice(0, 6);
  const t = pool[Math.floor(Math.random() * 6)];
  return { list: pool.map(f => f[0]), target: t[0], name: t[1], exp: Date.now() + TTL, fails: prev ? prev.fails : 0, lockUntil: prev ? prev.lockUntil : 0 };
}
const view = c => ({
  text: `🔑 <b>Проверка, что вы не бот</b>\n\nНажмите на <b>${c.name}</b>.`,
  opts: { parse_mode: 'HTML', reply_markup: { inline_keyboard: [0, 1].map(r => [0, 1, 2].map(i => ({ text: c.list[r * 3 + i], callback_data: 'cap:' + (r * 3 + i) }))) } },
});

function send(bot, chatId, uid) {
  const c = make(pending.get(uid)); pending.set(uid, c);
  const v = view(c); return bot.sendMessage(chatId, v.text, v.opts);
}

async function handle(bot, q, onPass) {
  const uid = q.from.id, c = pending.get(uid), idx = Number(String(q.data).slice(4)), m = q.message;
  const ans = (text, alert) => bot.answerCallbackQuery(q.id, { text, show_alert: !!alert }).catch(() => {});
  const del = () => bot.deleteMessage(m.chat.id, m.message_id).catch(() => {});
  if (!c || c.exp < Date.now()) { await ans('Проверка устарела — отправьте /start', true); return del(); }
  if (c.lockUntil > Date.now()) return ans('Слишком много попыток, подождите минуту', true);
  if (c.list[idx] === c.target) { pending.delete(uid); await ans('✅ Проверка пройдена'); await del(); return onPass(); }
  c.fails++; if (c.fails >= MAX_FAILS) { c.fails = 0; c.lockUntil = Date.now() + LOCK; }
  const n = make(c); pending.set(uid, n);
  await ans(c.lockUntil > Date.now() ? 'Много ошибок, попробуйте через минуту' : '❌ Неверно, попробуйте ещё раз');
  const v = view(n);
  return bot.editMessageText(v.text, { ...v.opts, chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
}

module.exports = { migrate, send, handle };
