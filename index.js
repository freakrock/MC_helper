const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const CHANNEL = process.env.CHANNEL_ID;
const SUMMARY_HOUR = parseInt(process.env.SUMMARY_HOUR || '8', 10);

const CAT = { equipment: '🔧 Оборудование', facility: '🏢 Помещения', tools: '🔨 Инструмент', other: '📝 Другое' };
const STATUS = { open: '🔴 Открыт', in_progress: '🟡 В работе', resolved: '🟢 Решено', closed: '⚪ Закрыт' };
const ASSIGNEES = ['Бухтияров А.С.', 'Мурадян В.А.', 'Зуев А.А.', 'Солодовников В.В.', 'Солодовников А.В.'];

const esc = (t) => String(t || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
const trunc = (t, n) => (t && t.length > n ? t.substring(0, n) + '…' : t || '');
const DAY = 24 * 60 * 60 * 1000;

let pool;

// ---------- ФОРМАТИРОВАНИЕ ----------

function buildText(p) {
    const d = new Date(p.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let s = `🆕 *ОБРАЩЕНИЕ*\n\n👤 *${esc(p.username)}*\n${CAT[p.category] || p.category}\n\n*Тема:* ${esc(p.subject)}\n${esc(trunc(p.description, 300))}\n\n📅 ${d}\n${STATUS[p.status] || p.status}`;
    if (p.assignee) s += ` · 👷 ${esc(p.assignee)}`;
    if (p.deadline) s += ` · ⏰ до ${new Date(p.deadline).toLocaleDateString('ru-RU')}`;
    if (p.responsesCount) s += `\n\n💬 _Ответов: ${p.responsesCount}_\nПоследний (${esc(p.lastResponse.author)}): ${esc(trunc(p.lastResponse.text, 120))}`;
    return s;
}

const keyboard = (id) => ({
    inline_keyboard: [
        [{ text: '🟡 В работу', callback_data: `status:${id}:in_progress` }, { text: '🟢 Решено', callback_data: `status:${id}:resolved` }],
        [{ text: '🔴 Открыть', callback_data: `status:${id}:open` }, { text: '⚪ Закрыть', callback_data: `status:${id}:closed` }],
        [{ text: '👷 Назначить ▾', callback_data: `amenu:${id}` }, { text: '💬 Ответить', callback_data: `reply:${id}` }],
        [{ text: '⏰ Срок ▾', callback_data: `dlmenu:${id}` }],
    ]
});

// 🆕 КНОПКИ ПОД ПОЛЕМ ВВОДА (появляются после /start)
const mainKeyboard = {
    keyboard: [
        [{ text: '📋 Обращения' }, { text: '🔴 Просроченные' }],
        [{ text: '👷 Без ответственного' }, { text: '☀️ Сводка' }],
        [{ text: '❓ Справка' }],
    ],
    resize_keyboard: true,
};

const daysLeft = (deadline) => Math.ceil((new Date(deadline) - Date.now()) / DAY);

function moscowNow() {
    const parts = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) };
}

// ---------- БАЗА ----------

async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_outbox (
        id SERIAL PRIMARY KEY, type VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL, done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE INDEX IF NOT EXISTS idx_outbox_done ON tg_outbox(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_commands (
        id SERIAL PRIMARY KEY, action VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL,
        value TEXT, author VARCHAR(128), done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW());
        CREATE INDEX IF NOT EXISTS idx_commands_done ON tg_commands(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_messages (ticket_id VARCHAR(64) PRIMARY KEY, message_id BIGINT NOT NULL);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_tickets_cache (ticket_id VARCHAR(64) PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_reminder_log (ticket_id VARCHAR(64), kind VARCHAR(24), PRIMARY KEY (ticket_id, kind));`);
}

async function getMessageId(ticketId) {
    const { rows } = await pool.query('SELECT message_id FROM tg_messages WHERE ticket_id = $1', [ticketId]);
    return rows[0]?.message_id || null;
}

async function upsertCache(ticketId, payload) {
    await pool.query(
        `INSERT INTO tg_tickets_cache (ticket_id, payload) VALUES ($1, $2)
         ON CONFLICT (ticket_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [ticketId, JSON.stringify(payload)]
    );
}

// ---------- СИНХРОНИЗАЦИЯ С ЗАВОДОМ ----------

async function syncOutbox() {
    try {
        const { rows: items } = await pool.query('SELECT * FROM tg_outbox WHERE done = FALSE ORDER BY created_at ASC LIMIT 10');
        for (const item of items) {
            try {
                const existingId = await getMessageId(item.ticket_id);
                if (existingId) {
                    await bot.editMessageText(buildText(item.payload), {
                        chat_id: CHANNEL, message_id: existingId,
                        parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id),
                    }).catch(() => {});
                } else {
                    const msg = await bot.sendMessage(CHANNEL, buildText(item.payload), {
                        parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id),
                    });
                    await pool.query('INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO NOTHING',
                        [item.ticket_id, msg.message_id]);
                }
                await upsertCache(item.ticket_id, item.payload);
            } catch (e) { console.error('outbox item error:', e.message); }
            await pool.query('UPDATE tg_outbox SET done = TRUE WHERE id = $1', [item.id]).catch(() => {});
        }
    } catch (e) { /* тихо */ }
}

// ---------- СПИСКИ ----------

const FILTERS = {
    active: { label: '🔥 Активные (открытые + в работе)', test: p => p.status === 'open' || p.status === 'in_progress' },
    overdue: { label: '🔴 Просроченные', test: p => (p.status === 'open' || p.status === 'in_progress') && p.deadline && daysLeft(p.deadline) < 0 },
    noassign: { label: '👷 Без ответственного', test: p => (p.status === 'open' || p.status === 'in_progress') && !p.assignee },
    all: { label: '📦 Все обращения', test: () => true },
};

async function listToChat(chatId, filterKey) {
    const filter = FILTERS[filterKey] || FILTERS.active;
    const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache ORDER BY updated_at DESC');
    const items = rows.filter(r => filter.test(r.payload)).slice(0, 12);
    if (items.length === 0) return bot.sendMessage(chatId, `😌 ${filter.label}: ничего не найдено`);
    await bot.sendMessage(chatId, `${filter.label} — ${items.length} шт. Нажми на тикет:`, {
        inline_keyboard: items.map(r => {
            const p = r.payload;
            const dl = p.deadline ? ` · ⏰${daysLeft(p.deadline) < 0 ? '🔴' : ''}${new Date(p.deadline).toLocaleDateString('ru-RU')}` : '';
            return [{ text: `${STATUS[p.status]?.split(' ')[0] || ''} ${trunc(p.subject, 32)}${dl}`, callback_data: `ticket:${r.ticket_id}` }];
        })
    });
}

// ---------- СВОДКА ----------

async function buildSummaryText() {
    const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache ORDER BY updated_at DESC');
    const active = rows.filter(r => r.payload.status === 'open' || r.payload.status === 'in_progress');
    const opened = active.filter(r => r.payload.status === 'open');
    const overdue = active.filter(r => r.payload.deadline && daysLeft(r.payload.deadline) < 0);
    const today = active.filter(r => r.payload.deadline && daysLeft(r.payload.deadline) === 0);
    const soon = active.filter(r => r.payload.deadline && daysLeft(r.payload.deadline) > 0 && daysLeft(r.payload.deadline) <= 3);
    const noAssign = active.filter(r => !r.payload.assignee);

    const dateRu = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
    let s = `☀️ *СВОДКА* — ${dateRu}\n\n`;
    s += `📊 Активных: *${active.length}* (🔴 ${opened.length} открыто / 🟡 ${active.length - opened.length} в работе)\n`;
    s += `🔴 Просрочено: *${overdue.length}* · ⏰ Срок сегодня: *${today.length}* · 🟠 Ближайшие 3 дня: *${soon.length}*\n`;
    s += `👷 Без ответственного: *${noAssign.length}*\n`;

    const line = (r) => {
        const p = r.payload;
        const dl = p.deadline ? ` · ⏰ ${new Date(p.deadline).toLocaleDateString('ru-RU')}` : '';
        const who = p.assignee ? ` · 👷 ${p.assignee}` : ' · 👷 —';
        return `• ${esc(trunc(p.subject, 40))}${dl}${who}`;
    };
    if (overdue.length) s += `\n🔴 *ПРОСРОЧЕНЫ:*\n` + overdue.slice(0, 8).map(line).join('\n') + '\n';
    if (today.length) s += `\n⏰ *СРОК СЕГОДНЯ:*\n` + today.slice(0, 8).map(line).join('\n') + '\n';
    if (soon.length) s += `\n🟠 *БЛИЖАЙШИЕ 3 ДНЯ:*\n` + soon.slice(0, 8).map(line).join('\n') + '\n';
    if (noAssign.length && !overdue.length && !today.length && !soon.length) {
        s += `\n👷 *БЕЗ ОТВЕТСТВЕННОГО:*\n` + noAssign.slice(0, 8).map(line).join('\n') + '\n';
    }
    if (active.length === 0) s += `\n😌 Все обращения закрыты. Отличная работа!`;
    return s;
}

async function sendSummaryNow(chatId) {
    await bot.sendMessage(chatId, await buildSummaryText(), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] }
    });
}

const HELP_TEXT = `❓ *Справка*
📋 Обращения — список активных тикетов
🔴 Просроченные — только просроченные
👷 Без ответственного — никем не взятые
☀️ Сводка — картина дня на сейчас

В канале на каждом тикете кнопки: статусы, назначить, срок, ответить.
Команды: /tickets /overdue /summary /help`;

// ---------- КНОПКИ НА ПОСТАХ ----------

const replyWait = new Map();

bot.on('callback_query', async (q) => {
    const d = q.data;
    try {
        if (d.startsWith('status:')) {
            const [, id, status] = d.split(':');
            await pool.query('INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)', ['status', id, status]);
            await bot.editMessageReplyMarkup(keyboard(id), { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            return bot.answerCallbackQuery(q.id, { text: `Статус: ${STATUS[status]} (применится за ~3 сек)` });
        }
        if (d.startsWith('amenu:')) {
            const id = d.split(':')[1];
            return bot.editMessageReplyMarkup({
                inline_keyboard: [
                    ...ASSIGNEES.map(n => [{ text: `👷 ${n}`, callback_data: `assign:${id}:${n}` }]),
                    [{ text: '❌ Снять', callback_data: `assign:${id}:__clear__` }],
                    [{ text: '◀️ Назад', callback_data: `back:${id}` }],
                ]
            }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('assign:')) {
            const [, id, who] = d.split(':');
            await pool.query('INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)', ['assignee', id, who]);
            await bot.editMessageReplyMarkup(keyboard(id), { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            return bot.answerCallbackQuery(q.id, { text: who === '__clear__' ? 'Назначение снято' : `Назначен: ${who}` });
        }
        if (d.startsWith('dlmenu:')) {
            const id = d.split(':')[1];
            return bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [{ text: '📅 Сегодня', callback_data: `dl:${id}:0` }, { text: '📅 Завтра', callback_data: `dl:${id}:1` }],
                    [{ text: '+3 дня', callback_data: `dl:${id}:3` }, { text: '+7 дней', callback_data: `dl:${id}:7` }],
                    [{ text: '❌ Снять срок', callback_data: `dl:${id}:clear` }],
                    [{ text: '◀️ Назад', callback_data: `back:${id}` }],
                ]
            }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('dl:')) {
            const [, id, days] = d.split(':');
            let value = '';
            if (days !== 'clear') {
                const dt = new Date();
                dt.setDate(dt.getDate() + parseInt(days, 10));
                dt.setHours(23, 59, 0, 0);
                value = dt.toISOString();
            }
            await pool.query('INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)', ['deadline', id, value]);
            await bot.editMessageReplyMarkup(keyboard(id), { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            return bot.answerCallbackQuery(q.id, { text: days === 'clear' ? 'Срок снят' : 'Срок установлен' });
        }
        if (d.startsWith('reply:')) {
            replyWait.set(q.from.id, d.split(':')[1]);
            await bot.sendMessage(q.from.id, '✍️ Напишите ответ одним сообщением. Отмена: /cancel');
            return bot.answerCallbackQuery(q.id, { text: 'Пиши ответ в личку' });
        }
        if (d.startsWith('back:')) {
            const id = d.split(':')[1];
            return bot.editMessageReplyMarkup(keyboard(id), { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('ticket:')) {
            const id = d.split(':')[1];
            const { rows } = await pool.query('SELECT payload FROM tg_tickets_cache WHERE ticket_id = $1', [id]);
            if (!rows[0]) return bot.answerCallbackQuery(q.id, { text: 'Нет данных' });
            await bot.sendMessage(q.from.id, buildText(rows[0].payload), { parse_mode: 'Markdown', reply_markup: keyboard(id) });
            return bot.answerCallbackQuery(q.id);
        }
        if (d.startsWith('list:')) {
            await listToChat(q.from.id, d.split(':')[1]);
            return bot.answerCallbackQuery(q.id);
        }
    } catch (e) {
        bot.answerCallbackQuery(q.id, { text: '⚠️ Ошибка' }).catch(() => {});
    }
});

// ---------- КОМАНДЫ ----------

bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id,
        `👋 Привет, *${esc(msg.from.first_name)}!*\nЯ бот производственных обращений.\nЖми кнопки ниже или пиши команды.`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard }
    );
});

bot.onText(/\/(tickets|menu)/, (msg) => listToChat(msg.chat.id, 'active'));
bot.onText(/\/overdue/, (msg) => listToChat(msg.chat.id, 'overdue'));
bot.onText(/\/summary/, (msg) => sendSummaryNow(msg.chat.id));
bot.onText(/\/(help|справка)/, (msg) => bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' }));

// ---------- СООБЩЕНИЯ: КНОПКИ ПОД ПОЛЕМ + ОТВЕТЫ ----------

bot.on('message', async (msg) => {
    if (!msg.text) return;
    const t = msg.text.trim();

    // 🆕 Кнопки под полем ввода
    if (t === '📋 Обращения') return listToChat(msg.chat.id, 'active');
    if (t === '🔴 Просроченные') return listToChat(msg.chat.id, 'overdue');
    if (t === '👷 Без ответственного') return listToChat(msg.chat.id, 'noassign');
    if (t === '☀️ Сводка') return sendSummaryNow(msg.chat.id);
    if (t === '❓ Справка') return bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });

    if (t === '/cancel') { replyWait.delete(msg.from.id); return bot.sendMessage(msg.from.id, 'Отменено'); }

    const ticketId = replyWait.get(msg.from.id);
    if (!ticketId) return;
    replyWait.delete(msg.from.id);
    const author = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    await pool.query('INSERT INTO tg_commands (action, ticket_id, value, author) VALUES ($1, $2, $3, $4)',
        ['response', ticketId, msg.text, author || 'Администрация']);
    await bot.sendMessage(msg.from.id, '✅ Ответ поставлен в очередь — сотрудник увидит его в кабинете через пару секунд');
});

// ---------- НАПОМИНАНИЯ О СРОКАХ ----------

async function checkDeadlines() {
    try {
        const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache');
        for (const r of rows) {
            const p = r.payload;
            if (!p.deadline || (p.status !== 'open' && p.status !== 'in_progress')) continue;
            const left = daysLeft(p.deadline);
            let kind = null, text = null;
            if (left < 0) { kind = `over_${new Date().toDateString()}`; text = `🔴 *ПРОСРОЧЕН!* Тикет «${esc(p.subject)}» просрочен на ${Math.abs(left)} дн.`; }
            else if (left === 3) { kind = 'd3'; text = `⏰ *Напоминание:* до срока тикета «${esc(p.subject)}» осталось *3 дня*.`; }
            else if (left === 1) { kind = 'd1'; text = `⚠️ *Срочно:* до срока тикета «${esc(p.subject)}» остался *1 день*!`; }
            else if (left === 0) { kind = 'd0'; text = `🚨 *Сегодня!* Срок тикета «${esc(p.subject)}» истекает сегодня.`; }
            if (!kind) continue;
            const { rows: logged } = await pool.query('SELECT 1 FROM tg_reminder_log WHERE ticket_id = $1 AND kind = $2', [r.ticket_id, kind]);
            if (logged.length) continue;
            const who = p.assignee ? `👷 Ответственный: *${esc(p.assignee)}*\n` : '👷 Ответственный не назначен\n';
            await bot.sendMessage(CHANNEL, `⏰ *НАПОМИНАНИЕ О СРОКЕ*\n\n${who}🎫 ${text}\n📅 Срок: ${new Date(p.deadline).toLocaleDateString('ru-RU')}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '👁 Открыть тикет', callback_data: `ticket:${r.ticket_id}` }]] }
            });
            await pool.query('INSERT INTO tg_reminder_log (ticket_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', [r.ticket_id, kind]);
        }
    } catch (e) { console.error('checkDeadlines error:', e.message); }
}

// ---------- УТРЕННЯЯ СВОДКА ----------

async function checkDailySummary() {
    try {
        const now = moscowNow();
        if (now.hour < SUMMARY_HOUR) return;
        const kind = `daily_${now.date}`;
        const { rows: logged } = await pool.query('SELECT 1 FROM tg_reminder_log WHERE ticket_id = $1 AND kind = $2', ['__system__', kind]);
        if (logged.length) return;
        await bot.sendMessage(CHANNEL, await buildSummaryText(), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] }
        });
        await pool.query('INSERT INTO tg_reminder_log (ticket_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['__system__', kind]);
        console.log('☀️ Утренняя сводка отправлена');
    } catch (e) { console.error('daily summary error:', e.message); }
}

// ---------- СТАРТ ----------

(async () => {
    pool = new Pool({ connectionString: process.env.PG_URI, max: 5 });
    await initDb();
    await bot.setMyCommands([
        { command: 'tickets', description: '📋 Активные обращения' },
        { command: 'overdue', description: '🔴 Просроченные' },
        { command: 'summary', description: '☀️ Сводка на сейчас' },
        { command: 'help', description: '❓ Справка' },
    ]).catch(() => {});
    setInterval(syncOutbox, 3000);
    setInterval(checkDeadlines, 30 * 60 * 1000);
    setInterval(checkDailySummary, 10 * 60 * 1000);
    setTimeout(() => { checkDeadlines(); checkDailySummary(); }, 10000);
    console.log('🤖 Бот запущен, канал:', CHANNEL, '| сводка в', SUMMARY_HOUR + ':00 МСК');
})();
