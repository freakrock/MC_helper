const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { 
    polling: {
        interval: 300,
        timeout: 10,
        params: { timeout: 10 }
    }
});

// Тихая обработка ошибок polling (не спамит в лог)
bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) {
        // Два бота с одним токеном — просто ждём, не логируем
        return;
    }
    if (error.code === 'ETELEGRAM' && error.message.includes('429')) {
        // Лимит запросов — тоже ждём
        return;
    }
    console.error('polling_error:', error.message);
});

// 🆕 Разделяем каналы: один для тикетов, другой для отгрузок
const CHANNEL = process.env.CHANNEL_ID; 
const SHIPMENT_CHANNEL = process.env.SHIPMENT_CHANNEL_ID || CHANNEL; 

const SUMMARY_HOUR = parseInt(process.env.SUMMARY_HOUR || '8', 10);

const CAT = { equipment: '🔧 Оборудование', facility: '🏢 Помещения', tools: '🔨 Инструмент', other: '📝 Другое' };
const STATUS = { open: '🔴 Открыт', in_progress: '🟡 В работе', resolved: '🟢 Решено', closed: '⚪ Закрыт' };
const ASSIGNEES = ['Бухтияров А.С.', 'Мурадян В.А.', 'Зуев А.А.', 'Солодовников В.В.', 'Солодовников А.В.'];

const esc = (t) => String(t || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
const trunc = (t, n) => (t && t.length > n ? t.substring(0, n) + '…' : t || '');
const DAY = 24 * 60 * 60 * 1000;

let pool;

// 🆕 Устойчивая версия buildText с защитой от пустых данных
function buildText(p) {
    if (!p || typeof p !== 'object') {
        return `⚠️ *ОБРАЩЕНИЕ (без данных)*\n\nТикет получен, но данные не были переданы. Проверьте backend.`;
    }

    // Fallback для username: ищем любое имя, иначе — ID или "Аноним"
    const username = (p.username && String(p.username).trim())
        || (p.fullName && String(p.fullName).trim())
        || (p.firstName && String(p.firstName).trim())
        || (p.userId && `Пользователь #${p.userId}`)
        || 'Анонимный пользователь';

    const d = p.createdAt
        ? new Date(p.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—';

    const subject = (p.subject && String(p.subject).trim()) || '(тема не указана)';
    const description = (p.description && String(p.description).trim()) || '(описание не указано)';
    const category = CAT[p.category] || p.category || '📝 Другое';
    const status = STATUS[p.status] || p.status || '🔴 Открыт';

    let s = `🆕 *ОБРАЩЕНИЕ*\n\n👤 *${esc(username)}*\n${category}\n\n*Тема:* ${esc(subject)}\n${esc(trunc(description, 300))}\n\n📅 ${d}\n${status}`;
    if (p.assignee) s += ` · 👷 ${esc(p.assignee)}`;
    if (p.deadline) s += ` · ⏰ до ${new Date(p.deadline).toLocaleDateString('ru-RU')}`;
    if (p.responsesCount) s += `\n\n💬 _Ответов: ${p.responsesCount}_\nПоследний (${esc(p.lastResponse?.author || '?')}): ${esc(trunc(p.lastResponse?.text || '', 120))}`;
    return s;
}

const keyboard = (id) => ({
    inline_keyboard: [
        [{ text: '🟡 В работу', callback_data: `status:${id}:in_progress` }, { text: '🟢 Решено', callback_data: `status:${id}:resolved` }],
        [{ text: '🔴 Открыть', callback_data: `status:${id}:open` }, { text: '⚪ Закрыть', callback_data: `status:${id}:closed` }],
        [{ text: '👷 Назначить ▾', callback_data: `amenu:${id}` }, { text: '💬 Ответить', callback_data: `reply:${id}` }],
        [{ text: '⏰ Срок ', callback_data: `dlmenu:${id}` }],
    ]
});

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

async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_outbox (id SERIAL PRIMARY KEY, type VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL, payload JSONB NOT NULL, done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_outbox_done ON tg_outbox(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_commands (id SERIAL PRIMARY KEY, action VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL, value TEXT, author VARCHAR(128), done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_commands_done ON tg_commands(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_messages (ticket_id VARCHAR(64) PRIMARY KEY, message_id BIGINT NOT NULL);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_tickets_cache (ticket_id VARCHAR(64) PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_reminder_log (ticket_id VARCHAR(64), kind VARCHAR(24), PRIMARY KEY (ticket_id, kind));`);
}

async function getMessageId(ticketId) {
    const { rows } = await pool.query('SELECT message_id FROM tg_messages WHERE ticket_id = $1', [ticketId]);
    return rows[0]?.message_id || null;
}

async function upsertCache(ticketId, payload) {
    await pool.query(`INSERT INTO tg_tickets_cache (ticket_id, payload) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [ticketId, JSON.stringify(payload)]);
}

// ---------- 📦 ОТГРУЗКИ (Идут в SHIPMENT_CHANNEL) ----------

function buildShipmentText(type, p) {
    if (type.endsWith('_batch') && p.items) {
        const isShipped = type.includes('shipped');
        const isUpdated = type.includes('updated');
        const HEADER = isShipped ? '✅ *ОТГРУЖЕНО*' : (isUpdated ? '📊 *ОБНОВЛЕНИЕ ОТГРУЗКИ*' : '📦 *НОВАЯ ОТГРУЗКА*');
        
        const date = p.shipmentDate ? new Date(p.shipmentDate).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
        let s = `${HEADER}\n\n`;
        if (p.customer) s += `🏢 *Заказчик:* ${esc(p.customer)}\n`;
        s += `📅 *Дата:* ${date}\n`;
        s += `📋 *Статус:* ${esc(p.status || 'Запланировано')}\n`;
        
        s += `\n| № | Наименование | План | Факт |\n|---|---|---|---|\n`;
        
        p.items.forEach((item, idx) => {
            const name = esc(item.itemName || item.name || 'Без названия');
            const spec = item.specification ? ` (${esc(item.specification)})` : '';
            const qty = item.quantity ?? '—';
            const fact = item.fact !== undefined && item.fact !== null ? item.fact : '—';
            const safeName = `${name}${spec}`.replace(/\|/g, '\\|');
            s += `| ${idx + 1} | ${safeName} | ${qty} | ${fact} |\n`;
        });
        return s;
    }

    const HEADER = { shipment_shipped: '✅ *ОТГРУЖЕНО*', shipment_updated: '📊 *ОБНОВЛЕНИЕ*', shipment_deleted: '🗑 *УДАЛЕНА*' }[type] || '📦 *ОТГРУЗКА*';
    const date = p.shipmentDate ? new Date(p.shipmentDate).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
    let s = `${HEADER}\n\n🏢 *Заказчик:* ${esc(p.customer)}\n📅 *Дата:* ${date}\n📦 *Состав:* ${esc(p.itemName || p.name || 'Без названия')}\nПлан: *${p.quantity ?? '—'} шт* / Факт: *${p.fact ?? '—'} шт*`;
    return s;
}

// 🆕 Отправляем отгрузки в специальный канал (с защитой от пустых данных)
async function sendShipmentPost(type, payload) {
    if (!payload || (!payload.customer && !payload.items?.length)) {
        console.warn('⚠️ Пустая отгрузка:', type, JSON.stringify(payload));
        return;
    }
    const text = buildShipmentText(type, payload);
    try {
        await bot.sendMessage(SHIPMENT_CHANNEL, text, { parse_mode: 'Markdown' });
    } catch (e) {
        // Если Markdown сломался — шлём без разметки (один раз, без fallback-дубля)
        if (e.message && e.message.includes('400')) {
            await bot.sendMessage(SHIPMENT_CHANNEL, text.replace(/[*_\\]/g, '')).catch(() => {});
        } else {
            console.error('sendShipmentPost error:', e.message);
        }
    }
}

// ---------- СИНХРОНИЗАЦИЯ ----------

async function syncOutbox() {
    try {
        const { rows: items } = await pool.query('SELECT * FROM tg_outbox WHERE done = FALSE ORDER BY created_at ASC LIMIT 5');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1200)); // Защита от 429
            
            try {
                if (item.type === 'sync') {
                    const payload = item.payload || {};
                    await upsertCache(item.ticket_id, payload);

                    // 🆕 Синхронизация чинит пост в канале: редактируем или отправляем заново
                    if (payload.subject || payload.description || payload.username) {
                        const text = buildText(payload);
                        const existingId = await getMessageId(item.ticket_id);
                        if (existingId) {
                            await bot.editMessageText(text, {
                                chat_id: CHANNEL,
                                message_id: existingId,
                                parse_mode: 'Markdown',
                                reply_markup: keyboard(item.ticket_id)
                            }).catch(() => {});
                        } else {
                            try {
                                const msg = await bot.sendMessage(CHANNEL, text, {
                                    parse_mode: 'Markdown',
                                    reply_markup: keyboard(item.ticket_id)
                                });
                                await pool.query(
                                    'INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO NOTHING',
                                    [item.ticket_id, msg.message_id]
                                );
                            } catch (e) { /* тихо */ }
                        }
                    }
                } else if (item.type.startsWith('shipment_')) {
                    await sendShipmentPost(item.type, item.payload); // Уйдет в SHIPMENT_CHANNEL
                } else {
                    // Тикеты уходят в основной CHANNEL
                    const payload = item.payload || {};

                    // 🆕 Защита: если payload пустой или без ключевых полей — логируем и пропускаем
                    if (!payload.subject && !payload.description && !payload.username) {
                        console.warn('⚠️ Пустой payload в outbox:', item.ticket_id, JSON.stringify(payload));
                        await pool.query('UPDATE tg_outbox SET done = TRUE WHERE id = $1', [item.id]);
                        continue;
                    }

                    // 🆕 Логируем имя пользователя для отладки
                    console.log(`📤 Тикет ${item.ticket_id}: user="${payload.username || 'UNDEFINED'}", subject="${(payload.subject || '').substring(0, 40)}"`);

                    const text = buildText(payload);
                    const existingId = await getMessageId(item.ticket_id);
                    if (existingId) {
                        await bot.editMessageText(text, { chat_id: CHANNEL, message_id: existingId, parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) }).catch(() => {});
                    } else {
                        const msg = await bot.sendMessage(CHANNEL, text, { parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) });
                        await pool.query('INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO NOTHING', [item.ticket_id, msg.message_id]);
                    }
                    await upsertCache(item.ticket_id, payload);
                }
            } catch (e) { 
                if (e.message.includes('429')) break; 
            }
            await pool.query('UPDATE tg_outbox SET done = TRUE WHERE id = $1', [item.id]).catch(() => {});
        }
    } catch (e) { /* тихо */ }
}

// ---------- СПИСКИ И СВОДКА ----------
const FILTERS = {
    active: { label: '🔥 Активные', test: p => p.status === 'open' || p.status === 'in_progress' },
    overdue: { label: '🔴 Просроченные', test: p => (p.status === 'open' || p.status === 'in_progress') && p.deadline && daysLeft(p.deadline) < 0 },
    noassign: { label: '👷 Без ответственного', test: p => (p.status === 'open' || p.status === 'in_progress') && !p.assignee },
    all: { label: '📦 Все обращения', test: () => true },
};

// 🆕 ИСПРАВЛЕНО: inline_keyboard теперь правильно обёрнут в reply_markup
async function listToChat(chatId, filterKey) {
    const filter = FILTERS[filterKey] || FILTERS.active;
    const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache ORDER BY updated_at DESC');
    const items = rows.filter(r => filter.test(r.payload)).slice(0, 12);
    
    if (items.length === 0) {
        return bot.sendMessage(chatId, `😌 ${filter.label}: ничего не найдено`);
    }
    
    const inlineKeyboard = items.map(r => {
        const p = r.payload;
        const dl = p.deadline 
            ? ` · ⏰${daysLeft(p.deadline) < 0 ? '🔴' : ''}${new Date(p.deadline).toLocaleDateString('ru-RU')}` 
            : '';
        const statusIcon = STATUS[p.status]?.split(' ')[0] || '📝';
        const subject = trunc(p.subject || '(без темы)', 32);
        
        // Telegram ограничивает callback_data 64 байтами — обрезаем ticket_id если нужно
        const ticketId = String(r.ticket_id);
        const safeCallbackData = `ticket:${ticketId}`.length > 64 
            ? `ticket:${ticketId.substring(0, 56)}` 
            : `ticket:${ticketId}`;
        
        return [{ 
            text: `${statusIcon} ${subject}${dl}`, 
            callback_data: safeCallbackData 
        }];
    });
    
    // ПРАВИЛЬНО: reply_markup: { inline_keyboard: [...] }
    await bot.sendMessage(chatId, `${filter.label} — ${items.length} шт. Нажми на тикет:`, {
        reply_markup: { inline_keyboard: inlineKeyboard }
    });
}

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
    if (active.length === 0) s += `\n😌 Все обращения закрыты. Отличная работа!`;
    return s;
}

async function sendSummaryNow(chatId) {
    await bot.sendMessage(chatId, await buildSummaryText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] } });
}

// ---------- 🚨 УМНЫЕ НАПОМИНАНИЯ (ТОЛЬКО В 09:00) ----------

async function checkStale() {
    try {
        const now = moscowNow();
        if (now.hour !== 9) return; 
        
        const kind = `stale_daily_${now.date}`;
        const { rows: logged } = await pool.query('SELECT 1 FROM tg_reminder_log WHERE ticket_id = $1 AND kind = $2', ['__system__', kind]);
        if (logged.length) return; 

        const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache');
        const problematic = [];

        for (const r of rows) {
            const p = r.payload;
            if (p.status !== 'open' && p.status !== 'in_progress') continue;

            const daysToDeadline = p.deadline ? daysLeft(p.deadline) : null;
            const ageDays = Math.floor((Date.now() - new Date(p.createdAt)) / DAY);

            if (daysToDeadline !== null && daysToDeadline >= 0 && daysToDeadline <= 3) {
                problematic.push(`⏳ *Подходит срок* (осталось ${daysToDeadline} дн.)\n🎫 «${esc(p.subject)}» (👷 ${esc(p.assignee) || 'не назначен'})`);
            } else if (!p.assignee && !p.deadline && ageDays >= 3) {
                problematic.push(`⚠️ *Требует внимания* (нет ответственного и срока, висит ${ageDays} дн.)\n🎫 «${esc(p.subject)}» от ${esc(p.username)}`);
            }
        }

        if (problematic.length > 0) {
            const text = `🚨 *ОТЧЁТ: ПРОБЛЕМНЫЕ ТИКЕТЫ*\n\n${problematic.slice(0, 15).join('\n\n')}${problematic.length > 15 ? `\n\n_...и ещё ${problematic.length - 15} тикетов_` : ''}`;
            await bot.sendMessage(CHANNEL, text, { parse_mode: 'Markdown' }); // Уходит в основной канал тикетов
            await pool.query('INSERT INTO tg_reminder_log (ticket_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['__system__', kind]);
            console.log('☀️ Отчёт о проблемных тикетах отправлен');
        }
    } catch (e) { console.error('checkStale error:', e.message); }
}

async function checkDailySummary() {
    try {
        const now = moscowNow();
        if (now.hour < SUMMARY_HOUR) return;
        const kind = `daily_${now.date}`;
        const { rows: logged } = await pool.query('SELECT 1 FROM tg_reminder_log WHERE ticket_id = $1 AND kind = $2', ['__system__', kind]);
        if (logged.length) return;
        await bot.sendMessage(CHANNEL, await buildSummaryText(), { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] } });
        await pool.query('INSERT INTO tg_reminder_log (ticket_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['__system__', kind]);
        console.log('☀️ Утренняя сводка отправлена');
    } catch (e) { console.error('daily summary error:', e.message); }
}

// ---------- ОБРАБОТЧИКИ ----------

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
            return bot.editMessageReplyMarkup({ inline_keyboard: [...ASSIGNEES.map(n => [{ text: `👷 ${n}`, callback_data: `assign:${id}:${n}` }]), [{ text: '❌ Снять', callback_data: `assign:${id}:__clear__` }], [{ text: '◀️ Назад', callback_data: `back:${id}` }]] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('assign:')) {
            const [, id, who] = d.split(':');
            await pool.query('INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)', ['assignee', id, who]);
            await bot.editMessageReplyMarkup(keyboard(id), { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
            return bot.answerCallbackQuery(q.id, { text: who === '__clear__' ? 'Назначение снято' : `Назначен: ${who}` });
        }
        if (d.startsWith('dlmenu:')) {
            const id = d.split(':')[1];
            return bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '📅 Сегодня', callback_data: `dl:${id}:0` }, { text: '📅 Завтра', callback_data: `dl:${id}:1` }], [{ text: '+3 дня', callback_data: `dl:${id}:3` }, { text: '+7 дней', callback_data: `dl:${id}:7` }], [{ text: '❌ Снять срок', callback_data: `dl:${id}:clear` }], [{ text: '◀️ Назад', callback_data: `back:${id}` }]] }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('dl:')) {
            const [, id, days] = d.split(':');
            let value = days !== 'clear' ? new Date(Date.now() + parseInt(days, 10) * DAY).toISOString() : '';
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
            return bot.editMessageReplyMarkup(keyboard(d.split(':')[1]), { chat_id: q.message.chat.id, message_id: q.message.message_id });
        }
        if (d.startsWith('ticket:')) {
            const id = d.split(':')[1];
            const { rows } = await pool.query('SELECT payload FROM tg_tickets_cache WHERE ticket_id = $1', [id]);
            if (!rows || !rows[0]) return bot.answerCallbackQuery(q.id, { text: '⚠️ Тикет не найден в кэше' });
            await bot.sendMessage(q.from.id, buildText(rows[0].payload), { parse_mode: 'Markdown', reply_markup: keyboard(id) }).catch(() => bot.sendMessage(q.from.id, buildText(rows[0].payload).replace(/[*_\\]/g, ''), { reply_markup: keyboard(id) }));
            return bot.answerCallbackQuery(q.id);
        }
        if (d.startsWith('list:')) {
            await listToChat(q.from.id, d.split(':')[1]);
            return bot.answerCallbackQuery(q.id, { text: '📨 Список отправлен в личку' });
        }
    } catch (e) {
        bot.answerCallbackQuery(q.id, { text: '⚠️ Ошибка' }).catch(() => {});
    }
});

bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, `👋 Привет, *${esc(msg.from.first_name)}!*`, { parse_mode: 'Markdown', reply_markup: mainKeyboard }));
bot.onText(/\/(tickets|menu)/, (msg) => listToChat(msg.chat.id, 'active'));
bot.onText(/\/overdue/, (msg) => listToChat(msg.chat.id, 'overdue'));
bot.onText(/\/summary/, (msg) => sendSummaryNow(msg.chat.id));

bot.on('message', async (msg) => {
    if (!msg.text) return;
    const t = msg.text.trim();
    if (t === '📋 Обращения') return listToChat(msg.chat.id, 'active');
    if (t === '🔴 Просроченные') return listToChat(msg.chat.id, 'overdue');
    if (t === '👷 Без ответственного') return listToChat(msg.chat.id, 'noassign');
    if (t === '☀️ Сводка') return sendSummaryNow(msg.chat.id);
    if (t === '/cancel') { replyWait.delete(msg.from.id); return bot.sendMessage(msg.from.id, 'Отменено'); }

    const ticketId = replyWait.get(msg.from.id);
    if (!ticketId) return;
    replyWait.delete(msg.from.id);
    const author = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || 'Администрация';
    await pool.query('INSERT INTO tg_commands (action, ticket_id, value, author) VALUES ($1, $2, $3, $4)', ['response', ticketId, msg.text, author]);
    await bot.sendMessage(msg.from.id, '✅ Ответ поставлен в очередь');
});

// ---------- СТАРТ ----------
(async () => {
    pool = new Pool({ connectionString: process.env.PG_URI, max: 5 });
    await initDb();
    await bot.setMyCommands([{ command: 'tickets', description: '📋 Активные' }, { command: 'summary', description: '☀️ Сводка' }]).catch(() => {});
    
    setInterval(syncOutbox, 3000);
    setInterval(checkDailySummary, 10 * 60 * 1000);
    setInterval(checkStale, 10 * 60 * 1000);
    
    setTimeout(() => { checkDailySummary(); checkStale(); }, 10000);
    console.log('🤖 Бот запущен');
    console.log(`📋 Канал тикетов: ${CHANNEL}`);
    console.log(`📦 Канал отгрузок: ${SHIPMENT_CHANNEL}`);
})();
