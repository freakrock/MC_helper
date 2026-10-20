const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
require('dotenv').config();

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const CHANNEL = process.env.CHANNEL_ID;

const CAT = { equipment: '🔧 Оборудование', facility: '🏢 Помещения', tools: '🔨 Инструмент', other: '📝 Другое' };
const STATUS = { open: '🔴 Открыт', in_progress: '🟡 В работе', resolved: '🟢 Решено', closed: '⚪ Закрыт' };
const ASSIGNEES = ['Бухтияров А.С.', 'Мурадян В.А.', 'Зуев А.А.', 'Солодовников В.В.', 'Солодовников А.В.'];

const esc = (t) => String(t || '').replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
const trunc = (t, n) => (t && t.length > n ? t.substring(0, n) + '…' : t || '');

let pool;

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
    ]
});

async function syncOutbox() {
    try {
        const { rows: items } = await pool.query(
            'SELECT * FROM tg_outbox WHERE done = FALSE ORDER BY created_at ASC LIMIT 10'
        );
        for (const item of items) {
            try {
                if (item.type === 'created') {
                    const msg = await bot.sendMessage(CHANNEL, buildText(item.payload), { parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) });
                    await pool.query('UPDATE tg_outbox SET message_id = $1 WHERE id = $2', [msg.message_id, item.id]);
                } else if (item.type === 'updated' && item.message_id) {
                    await bot.editMessageText(buildText(item.payload), {
                        chat_id: CHANNEL, message_id: item.message_id,
                        parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id),
                    }).catch(() => {});
                } else if (item.type === 'updated' && !item.message_id) {
                    const msg = await bot.sendMessage(CHANNEL, buildText(item.payload), { parse_mode: 'Markdown', reply_markup: keyboard(item.ticket_id) });
                    await pool.query('UPDATE tg_outbox SET message_id = $1 WHERE id = $2', [msg.message_id, item.id]);
                }
            } catch (e) { console.error('outbox item error:', e.message); }
            await pool.query('UPDATE tg_outbox SET done = TRUE WHERE id = $1', [item.id]).catch(() => {});
        }
    } catch (e) { console.error('syncOutbox error:', e.message); }
}

const replyWait = new Map();

bot.on('callback_query', async (q) => {
    const d = q.data;
    try {
        if (d.startsWith('status:')) {
            const [, id, status] = d.split(':');
            await pool.query(
                'INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)',
                ['status', id, status]
            );
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
            }, { chat_id: CHANNEL, message_id: q.message.message_id });
        }
        if (d.startsWith('assign:')) {
            const [, id, who] = d.split(':');
            await pool.query(
                'INSERT INTO tg_commands (action, ticket_id, value) VALUES ($1, $2, $3)',
                ['assignee', id, who]
            );
            return bot.answerCallbackQuery(q.id, { text: who === '__clear__' ? 'Снято' : `Назначен: ${who}` });
        }
        if (d.startsWith('reply:')) {
            replyWait.set(q.from.id, d.split(':')[1]);
            await bot.sendMessage(q.from.id, '✍️ Напишите ответ одним сообщением. Отмена: /cancel');
            return bot.answerCallbackQuery(q.id, { text: 'Пиши ответ в личку' });
        }
        if (d.startsWith('back:')) {
            const id = d.split(':')[1];
            const { rows } = await pool.query(
                'SELECT message_id FROM tg_outbox WHERE ticket_id = $1 AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
                [id]
            );
            if (rows[0]?.message_id) {
                return bot.editMessageReplyMarkup(keyboard(id), { chat_id: CHANNEL, message_id: rows[0].message_id });
            }
        }
    } catch (e) {
        bot.answerCallbackQuery(q.id, { text: '⚠️ Ошибка' }).catch(() => {});
    }
});

bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (msg.text === '/cancel') { replyWait.delete(msg.from.id); return bot.sendMessage(msg.from.id, 'Отменено'); }
    const ticketId = replyWait.get(msg.from.id);
    if (!ticketId) return;
    replyWait.delete(msg.from.id);
    const author = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
    await pool.query(
        'INSERT INTO tg_commands (action, ticket_id, value, author) VALUES ($1, $2, $3, $4)',
        ['response', ticketId, msg.text, author || 'Администрация']
    );
    await bot.sendMessage(msg.from.id, '✅ Ответ поставлен в очередь — сотрудник увидит его в кабинете через пару секунд');
});

(async () => {
    pool = new Pool({ connectionString: process.env.PG_URI, max: 5 });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS tg_outbox (
            id SERIAL PRIMARY KEY,
            type VARCHAR(32) NOT NULL,
            ticket_id VARCHAR(64) NOT NULL,
            payload JSONB NOT NULL,
            message_id BIGINT,
            done BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_done ON tg_outbox(done, created_at);
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tg_commands (
            id SERIAL PRIMARY KEY,
            action VARCHAR(32) NOT NULL,
            ticket_id VARCHAR(64) NOT NULL,
            value TEXT,
            author VARCHAR(128),
            done BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_commands_done ON tg_commands(done, created_at);
    `);
    await pool.query(`ALTER TABLE tg_outbox ADD COLUMN IF NOT EXISTS message_id BIGINT`).catch(() => {});

    setInterval(syncOutbox, 3000);
    console.log('🤖 Бот запущен, канал:', CHANNEL);
})();