const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, {
    polling: {
        interval: 300,
        params: { timeout: 10 }
    }
});

bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM' && error.message.includes('409')) return;
    if (error.code === 'ETELEGRAM' && error.message.includes('429')) return;
    console.error('polling_error:', error.message);
});

// Каналы
const CHANNEL = process.env.CHANNEL_ID;
const SHIPMENT_CHANNEL = process.env.SHIPMENT_CHANNEL_ID || CHANNEL;
const TOOL_CHANNEL = process.env.TOOL_CHANNEL_ID || CHANNEL;

const SUMMARY_HOUR = parseInt(process.env.SUMMARY_HOUR || '8', 10);
const INITIAL_ADMIN_ID = process.env.INITIAL_ADMIN_ID;

const statusManagers = process.env.STATUS_MANAGERS
    ? process.env.STATUS_MANAGERS.split(',').map(id => parseInt(id.trim(), 10))
    : [];

const CAT = { equipment: '🔧 Оборудование', facility: '🏢 Помещения', tools: '🔨 Инструмент', other: '📝 Другое' };
const STATUS = { open: '🔴 Открыт', in_progress: '🟡 В работе', resolved: '🟢 Решено', closed: '⚪ Закрыт' };
const ASSIGNEES = ['Бухтияров А.С.', 'Мурадян В.А.', 'Зуев А.А.', 'Солодовников В.В.', 'Солодовников А.В.'];

const esc = (t) => String(t || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
const trunc = (t, n) => (t && t.length > n ? t.substring(0, n) + '…' : t || '');
const DAY = 24 * 60 * 60 * 1000;

let pool;

// ========== СИСТЕМА АДМИНИСТРАТОРОВ ==========
async function initAdminsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tg_admins (
            user_id BIGINT PRIMARY KEY,
            username VARCHAR(128),
            added_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    if (INITIAL_ADMIN_ID) {
        const { rows } = await pool.query(
            'SELECT 1 FROM tg_admins WHERE user_id = $1',
            [INITIAL_ADMIN_ID]
        );
        if (rows.length === 0) {
            await pool.query(
                'INSERT INTO tg_admins (user_id, username) VALUES ($1, $2)',
                [INITIAL_ADMIN_ID, 'Первичный админ']
            );
            console.log(`✅ Первичный админ добавлен: ${INITIAL_ADMIN_ID}`);
        }
    }
}

async function isAdmin(userId) {
    if (!userId) return false;
    const { rows } = await pool.query(
        'SELECT 1 FROM tg_admins WHERE user_id = $1',
        [userId]
    );
    return rows.length > 0;
}

async function canChangeStatus(userId) {
    const isAdminUser = await isAdmin(userId);
    return isAdminUser || statusManagers.includes(userId);
}

async function addAdmin(userId, username) {
    await pool.query(
        'INSERT INTO tg_admins (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username',
        [userId, username]
    );
}

async function removeAdmin(userId) {
    await pool.query('DELETE FROM tg_admins WHERE user_id = $1', [userId]);
}

async function getAdmins() {
    const { rows } = await pool.query('SELECT user_id, username, added_at FROM tg_admins ORDER BY added_at');
    return rows;
}
// ========== КОНЕЦ СИСТЕМЫ АДМИНИСТРАТОРОВ ==========

// ---------- ФОРМИРОВАНИЕ ТЕКСТА ТИКЕТА ----------
function buildText(p) {
    if (!p || typeof p !== 'object') {
        return `⚠️ *ОБРАЩЕНИЕ (без данных)*\n\nТикет получен, но данные не были переданы. Проверьте backend.`;
    }
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

// ---------- БАЗА ДАННЫХ ----------
async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_outbox (id SERIAL PRIMARY KEY, type VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL, payload JSONB NOT NULL, done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_outbox_done ON tg_outbox(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_commands (id SERIAL PRIMARY KEY, action VARCHAR(32) NOT NULL, ticket_id VARCHAR(64) NOT NULL, value TEXT, author VARCHAR(128), done BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()); CREATE INDEX IF NOT EXISTS idx_commands_done ON tg_commands(done, created_at);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_messages (ticket_id VARCHAR(64) PRIMARY KEY, message_id BIGINT NOT NULL);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_tickets_cache (ticket_id VARCHAR(64) PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tg_reminder_log (ticket_id VARCHAR(64), kind VARCHAR(24), PRIMARY KEY (ticket_id, kind));`);
    await initAdminsTable();
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

// ---------- 📦 ОТГРУЗКИ ----------
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
    return `${HEADER}\n\n🏢 *Заказчик:* ${esc(p.customer)}\n📅 *Дата:* ${date}\n📦 *Состав:* ${esc(p.itemName || p.name || 'Без названия')}\nПлан: *${p.quantity ?? '—'} шт* / Факт: *${p.fact ?? '—'} шт*`;
}

async function sendShipmentPost(type, payload) {
    if (!payload || (!payload.customer && !payload.items?.length)) {
        console.warn('⚠️ Пустая отгрузка:', type, JSON.stringify(payload));
        return;
    }
    const text = buildShipmentText(type, payload);
    try {
        await bot.sendMessage(SHIPMENT_CHANNEL, text, { parse_mode: 'Markdown' });
    } catch (e) {
        if (e.message && e.message.includes('400')) {
            await bot.sendMessage(SHIPMENT_CHANNEL, text.replace(/[*_\\]/g, '')).catch(() => {});
        } else {
            console.error('sendShipmentPost error:', e.message);
        }
    }
}

// ---------- 🛠️ ЗАЯВКИ НА ИНСТРУМЕНТ ОТ СОТРУДНИКОВ ----------
const TOOLREQ_REASON = { wear: '📉 Износ', broken: '💥 Поломка', new_op: '🆕 Новая операция', other: '📝 Другое' };
const TOOLREQ_STATUS = {
    pending: '🟡 Ожидает одобрения',
    approved: '✅ Одобрена',
    rejected: '❌ Отклонена',
    sent_to_warehouse: '📦 Отправлена на склад',
};

function buildToolRequestText(p) {
    if (!p || typeof p !== 'object') return '⚠️ Заявка без данных';
    const d = p.createdAt
        ? new Date(p.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        : '—';
    const items = (p.items || []).map((it, i) =>
        `${i + 1}\\. ${esc(it.toolName || '?')} — *${it.quantity} шт*`
    ).join('\n');
    let s = `🛠️ *ЗАЯВКА НА ИНСТРУМЕНТ*\n\n`;
    s += `👤 *${esc(p.employeeName || 'Сотрудник')}*\n`;
    s += `🏭 Оборудование: ${esc(p.equipmentName || '?')}\n`;
    if (p.productName) s += `⚙️ Деталь: ${esc(p.productName)}\n`;
    s += `📅 ${d}\n\n*Состав:*\n${items || '_пусто_'}\n\n`;
    s += `📝 Причина: ${TOOLREQ_REASON[p.reason] || esc(p.reason || '—')}`;
    if (p.comment) s += `\n💬 ${esc(trunc(p.comment, 200))}`;
    s += `\n\n${TOOLREQ_STATUS[p.status] || p.status || '—'}`;
    if (p.approvedBy) s += ` · 👤 ${esc(p.approvedBy)}`;
    if (p.rejectComment) s += `\n⚠️ _${esc(trunc(p.rejectComment, 200))}_`;
    return s;
}

const toolReqKeyboard = (id, status) => {
    if (status !== 'pending') return { inline_keyboard: [] };
    return {
        inline_keyboard: [
            [{ text: '✅ Одобрить и на склад', callback_data: `toolreq_approve:${id}` }],
            [{ text: '❌ Отклонить', callback_data: `toolreq_reject:${id}` }],
        ]
    };
};

async function sendToolRequestPost(item) {
    const p = item.payload || {};
    const id = String(p._id || '').replace('toolreq_', '');
    if (!id) return;
    const mapId = `toolreq_${id}`;
    const text = buildToolRequestText(p);
    const existingId = await getMessageId(mapId);

    try {
        if (item.type === 'employee_tool_request' && !existingId) {
            const msg = await bot.sendMessage(TOOL_CHANNEL, text, {
                parse_mode: 'Markdown',
                reply_markup: toolReqKeyboard(id, p.status || 'pending')
            });
            await pool.query(
                'INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET message_id = EXCLUDED.message_id',
                [mapId, msg.message_id]
            );
        } else if (existingId) {
            await bot.editMessageText(text, {
                chat_id: TOOL_CHANNEL,
                message_id: existingId,
                parse_mode: 'Markdown',
                reply_markup: toolReqKeyboard(id, p.status || 'pending')
            }).catch((e) => {
                if (e.message && e.message.includes('not found')) {
                    bot.sendMessage(TOOL_CHANNEL, text, {
                        parse_mode: 'Markdown',
                        reply_markup: toolReqKeyboard(id, p.status || 'pending')
                    }).then(msg => {
                        pool.query(
                            'INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET message_id = EXCLUDED.message_id',
                            [mapId, msg.message_id]
                        ).catch(() => {});
                    }).catch(() => {});
                }
            });
        }
    } catch (e) {
        if (e.message && e.message.includes('400')) {
            const safeText = text.replace(/[*_\\]/g, '');
            if (existingId) {
                await bot.editMessageText(safeText, {
                    chat_id: TOOL_CHANNEL, message_id: existingId,
                    reply_markup: toolReqKeyboard(id, p.status || 'pending')
                }).catch(() => {});
            } else {
                await bot.sendMessage(TOOL_CHANNEL, safeText, {
                    reply_markup: toolReqKeyboard(id, p.status || 'pending')
                }).catch(() => {});
            }
        } else {
            console.error('sendToolRequestPost error:', e.message);
        }
    }
}

// ---------- 🆕 УНИВЕРСАЛЬНАЯ ОТПРАВКА ТЕКСТА В КАНАЛ ----------
async function sendTextToChannel(channelId, text) {
    try {
        await bot.sendMessage(channelId, text, { parse_mode: 'Markdown' });
        return true;
    } catch (e) {
        console.error(`Ошибка отправки в ${channelId}:`, e.message);
        if (e.message && e.message.includes('400')) {
            await bot.sendMessage(channelId, text.replace(/[*_\\]/g, '')).catch(() => {});
            return true;
        }
        return false;
    }
}

// ---------- СИНХРОНИЗАЦИЯ OUTBOX ----------
let isSyncing = false;

async function syncOutbox() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const { rows: items } = await pool.query(
            `UPDATE tg_outbox SET done = TRUE
             WHERE id IN (
                 SELECT id FROM tg_outbox
                 WHERE done = FALSE
                 ORDER BY created_at ASC
                 LIMIT 5
                 FOR UPDATE SKIP LOCKED
             )
             RETURNING *`
        );

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (i > 0) await new Promise(resolve => setTimeout(resolve, 1200));

            try {
                // 🆕 ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ПО ТИКЕТАМ → канал обращений
                if (item.type === 'weekly_report_tickets') {
                    console.log('📊 Отправка еженедельного отчёта по тикетам...');
                    await sendTextToChannel(CHANNEL, item.payload?.text || '❌ Отчёт недоступен');
                }
                // 🆕 ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ПО ИНСТРУМЕНТУ → канал заявок
                else if (item.type === 'weekly_report_tools') {
                    console.log('🛠️ Отправка еженедельного отчёта по инструменту...');
                    await sendTextToChannel(TOOL_CHANNEL, item.payload?.text || '❌ Отчёт недоступен');
                }
                // 🆕 ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ ПО ОТГРУЗКАМ → канал отгрузок
                else if (item.type === 'weekly_report_shipments') {
                    console.log('📦 Отправка еженедельного отчёта по отгрузкам...');
                    await sendTextToChannel(SHIPMENT_CHANNEL, item.payload?.text || '❌ Отчёт недоступен');
                }
                // 🆕 ПРОГНОЗ РАСХОДА ИНСТРУМЕНТА → канал заявок
                else if (item.type === 'tool_forecast') {
                    console.log('🔮 Отправка прогноза расхода инструмента...');
                    await sendTextToChannel(TOOL_CHANNEL, item.payload?.text || 'Прогноз недоступен');
                }
                else if (item.type === 'employee_tool_request' || item.type === 'employee_tool_request_updated') {
                    await sendToolRequestPost(item);
                }
                else if (item.type === 'sync') {
                    const payload = item.payload || {};
                    await upsertCache(item.ticket_id, payload);
                    if (payload.subject || payload.description || payload.username) {
                        const existingId = await getMessageId(item.ticket_id);
                        if (existingId) {
                            await bot.editMessageText(buildText(payload), {
                                chat_id: CHANNEL,
                                message_id: existingId,
                                parse_mode: 'Markdown',
                                reply_markup: keyboard(item.ticket_id)
                            }).catch(() => {});
                        }
                    }
                }
                else if (item.type.startsWith('shipment_')) {
                    await sendShipmentPost(item.type, item.payload);
                }
                else if (item.type === 'web_tool_request') {
                    const p = item.payload || {};
                    const itemsList = (p.items || []).map((it, i) =>
                        `${i + 1}. ${it.toolName} — ${it.orderQuantity || it.quantity} шт`
                    ).join('\n');

                    const text = `🌐 *НОВАЯ ЗАЯВКА ИЗ ВЕБ-ВЕРСИИ*\n\n` +
                                 `👤 *Инициатор:* ${p.createdBy || 'Технолог'}\n` +
                                 `📦 *Позиций:* ${p.items?.length || 0}\n` +
                                 `🔢 *Всего штук:* ${p.totalOrderQty || 0}\n` +
                                 `📝 *Комментарий:* ${p.note || '—'}\n\n` +
                                 `*Состав:*\n${itemsList}\n\n` +
                                 `_✅ Заявка уже создана и передана на склад._`;

                    await sendTextToChannel(TOOL_CHANNEL, text);
                }
                else {
                    const payload = item.payload || {};
                    if (!payload.subject && !payload.description && !payload.username) {
                        console.warn('⚠️ Пустой payload в outbox:', item.ticket_id, JSON.stringify(payload));
                        continue;
                    }
                    console.log(`📤 Тикет ${item.ticket_id}: user="${payload.username || 'UNDEFINED'}", subject="${(payload.subject || '').substring(0, 40)}"`);
                    const text = buildText(payload);
                    const existingId = await getMessageId(item.ticket_id);
                    if (existingId) {
                        const editResult = await bot.editMessageText(text, {
                            chat_id: CHANNEL,
                            message_id: existingId,
                            parse_mode: 'Markdown',
                            reply_markup: keyboard(item.ticket_id)
                        }).catch((e) => (e.message && e.message.includes('not found')) ? 'STALE' : null);
                        if (editResult === 'STALE') {
                            await pool.query('DELETE FROM tg_messages WHERE ticket_id = $1', [item.ticket_id]);
                            const msg = await bot.sendMessage(CHANNEL, text, { parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) });
                            await pool.query(
                                'INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET message_id = EXCLUDED.message_id',
                                [item.ticket_id, msg.message_id]
                            );
                        }
                    } else {
                        const msg = await bot.sendMessage(CHANNEL, text, { parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) });
                        await pool.query(
                            'INSERT INTO tg_messages (ticket_id, message_id) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET message_id = EXCLUDED.message_id',
                            [item.ticket_id, msg.message_id]
                        );
                    }
                    await upsertCache(item.ticket_id, payload);
                }
            } catch (e) {
                if (e.message && e.message.includes('429')) {
                    console.warn('⚠️ 429 при отправке, событие возвращено в очередь:', item.id);
                    await pool.query(
                        'INSERT INTO tg_outbox (type, ticket_id, payload) VALUES ($1, $2, $3)',
                        [item.type, item.ticket_id, JSON.stringify(item.payload)]
                    ).catch(() => {});
                } else {
                    console.error(`⚠️ Ошибка обработки события ${item.type}:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('syncOutbox error:', e.message);
    }
    finally {
        isSyncing = false;
    }
}

// ---------- СПИСКИ И СВОДКА ----------
const FILTERS = {
    active: { label: '🔥 Активные', test: p => p.status === 'open' || p.status === 'in_progress' },
    overdue: { label: '🔴 Просроченные', test: p => (p.status === 'open' || p.status === 'in_progress') && p.deadline && daysLeft(p.deadline) < 0 },
    noassign: { label: '👷 Без ответственного', test: p => (p.status === 'open' || p.status === 'in_progress') && !p.assignee },
    all: { label: '📦 Все обращения', test: () => true },
};

async function listToChat(chatId, filterKey) {
    const filter = FILTERS[filterKey] || FILTERS.active;
    const { rows } = await pool.query('SELECT ticket_id, payload FROM tg_tickets_cache ORDER BY updated_at DESC');
    const items = rows.filter(r => filter.test(r.payload)).slice(0, 12);
    if (items.length === 0) {
        return bot.sendMessage(chatId, `😌 ${filter.label}: ничего не найдено`);
    }
    const inlineKeyboard = items.map(r => {
        const p = r.payload;
        const dl = p.deadline ? ` · ⏰${daysLeft(p.deadline) < 0 ? '🔴' : ''}${new Date(p.deadline).toLocaleDateString('ru-RU')}` : '';
        const statusIcon = STATUS[p.status]?.split(' ')[0] || '📝';
        const subject = trunc(p.subject || '(без темы)', 32);
        const ticketId = String(r.ticket_id);
        const safeCallbackData = `ticket:${ticketId}`.length > 64 ? `ticket:${ticketId.substring(0, 56)}` : `ticket:${ticketId}`;
        return [{ text: `${statusIcon} ${subject}${dl}`, callback_data: safeCallbackData }];
    });
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
    await bot.sendMessage(chatId, await buildSummaryText(), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] }
    });
}

// ---------- 🚨 УМНЫЕ НАПОМИНАНИЯ ----------
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
            await bot.sendMessage(CHANNEL, text, { parse_mode: 'Markdown' });
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
        await bot.sendMessage(CHANNEL, await buildSummaryText(), {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '📋 Открыть список активных', callback_data: 'list:active' }]] }
        });
        await pool.query('INSERT INTO tg_reminder_log (ticket_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING', ['__system__', kind]);
        console.log('☀️ Утренняя сводка отправлена');
    } catch (e) { console.error('daily summary error:', e.message); }
}

// ========== ОБРАБОТЧИКИ КОМАНД АДМИНИСТРАТОРОВ ==========
bot.onText(/\/admin_add/, async (msg) => {
    const userId = msg.from.id;
    if (!(await isAdmin(userId))) {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав для выполнения этой команды.');
    }

    const parts = msg.text.split(' ');
    if (parts.length < 2) {
        return bot.sendMessage(msg.chat.id, '📝 Использование: `/admin_add <user_id> [имя]`', { parse_mode: 'Markdown' });
    }

    const newAdminId = parseInt(parts[1], 10);
    const newAdminName = parts.slice(2).join(' ') || 'Админ';

    if (isNaN(newAdminId)) {
        return bot.sendMessage(msg.chat.id, '❌ Неверный формат ID. ID должен быть числом.');
    }

    await addAdmin(newAdminId, newAdminName);
    bot.sendMessage(msg.chat.id, `✅ Пользователь *${esc(newAdminName)}* (ID: \`${newAdminId}\`) добавлен в список администраторов.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/admin_remove/, async (msg) => {
    const userId = msg.from.id;
    if (!(await isAdmin(userId))) {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав для выполнения этой команды.');
    }

    const parts = msg.text.split(' ');
    if (parts.length < 2) {
        return bot.sendMessage(msg.chat.id, '📝 Использование: `/admin_remove <user_id>`', { parse_mode: 'Markdown' });
    }

    const removeId = parseInt(parts[1], 10);
    if (isNaN(removeId)) {
        return bot.sendMessage(msg.chat.id, '❌ Неверный формат ID.');
    }

    if (removeId === userId) {
        return bot.sendMessage(msg.chat.id, '⚠️ Вы не можете удалить сами себя из списка администраторов.');
    }

    await removeAdmin(removeId);
    bot.sendMessage(msg.chat.id, `✅ Пользователь с ID \`${removeId}\` удалён из списка администраторов.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/admins/, async (msg) => {
    const userId = msg.from.id;
    if (!(await isAdmin(userId))) {
        return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав для просмотра списка администраторов.');
    }

    const admins = await getAdmins();
    if (admins.length === 0) {
        return bot.sendMessage(msg.chat.id, '📋 Список администраторов пуст.');
    }

    let text = '👥 *Список администраторов:*\n\n';
    admins.forEach((a, i) => {
        text += `${i + 1}. *${esc(a.username)}* (ID: \`${a.user_id}\`)\n   Добавлен: ${new Date(a.added_at).toLocaleDateString('ru-RU')}\n`;
    });

    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});
// ========== КОНЕЦ ОБРАБОТЧИКОВ АДМИНИСТРАТОРОВ ==========

// ---------- ОБРАБОТЧИКИ КНОПОК ----------
const replyWait = new Map();
bot.on('callback_query', async (q) => {
    const d = q.data;
    const userId = q.from.id;

    try {
        if (d.startsWith('toolreq_approve:') || d.startsWith('toolreq_reject:')) {
            const [action, id] = d.split(':');
            const act = action === 'toolreq_approve' ? 'tool_request_approve' : 'tool_request_reject';
            const author = [q.from.first_name, q.from.last_name].filter(Boolean).join(' ') || 'Telegram';
            await pool.query(
                'INSERT INTO tg_commands (action, ticket_id, value, author) VALUES ($1, $2, $3, $4)',
                [act, id, '', author]
            );
            return bot.answerCallbackQuery(q.id, {
                text: action === 'toolreq_approve'
                    ? '✅ Команда одобрения поставлена в очередь'
                    : '❌ Отклонение записано'
            });
        }

        if (d.startsWith('status:') || d.startsWith('amenu:') || d.startsWith('assign:') ||
            d.startsWith('dlmenu:') || d.startsWith('dl:')) {

            if (!(await canChangeStatus(userId))) {
                return bot.answerCallbackQuery(q.id, {
                    text: '⛔ У вас нет прав менять статус, сроки или назначать исполнителя. Вы можете только писать ответы.',
                    show_alert: true
                });
            }
        }

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
                    [{ text: '◀️ Назад', callback_data: `back:${id}` }]
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
                    [{ text: '◀️ Назад', callback_data: `back:${id}` }]
                ]
            }, { chat_id: q.message.chat.id, message_id: q.message.message_id });
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
            await bot.sendMessage(q.from.id, buildText(rows[0].payload), { parse_mode: 'Markdown', reply_markup: keyboard(id) })
                .catch(() => bot.sendMessage(q.from.id, buildText(rows[0].payload).replace(/[*_\\]/g, ''), { reply_markup: keyboard(id) }));
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

// ---------- КОМАНДЫ И КЛАВИАТУРА ----------
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
    await bot.setMyCommands([
        { command: 'tickets', description: '📋 Активные' },
        { command: 'summary', description: '☀️ Сводка' },
        { command: 'admins', description: '👥 Список админов' },
        { command: 'admin_add', description: '➕ Добавить админа' },
        { command: 'admin_remove', description: '➖ Удалить админа' }
    ]).catch(() => {});

    setInterval(syncOutbox, 3000);
    setInterval(checkDailySummary, 10 * 60 * 1000);
    setInterval(checkStale, 10 * 60 * 1000);

    setTimeout(() => { checkDailySummary(); checkStale(); }, 10000);
    console.log('🤖 Бот запущен');
    console.log(`📋 Канал тикетов: ${CHANNEL}`);
    console.log(`📦 Канал отгрузок: ${SHIPMENT_CHANNEL}`);
    console.log(`🛠️ Канал заявок на инструмент: ${TOOL_CHANNEL}`);
    console.log(`👑 Первичный админ: ${INITIAL_ADMIN_ID || 'не задан'}`);
    console.log(`🔧 Менеджеры статусов: ${statusManagers.join(', ') || 'не заданы'}`);
})();
