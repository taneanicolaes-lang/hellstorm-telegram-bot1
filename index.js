require('dotenv').config();

const http = require('http');
const { createClient } = require('@supabase/supabase-js');

let supabase;

function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
  }
  return supabase;
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  })[character]);
}

function keyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Мой замок', callback_data: 'castle' }, { text: 'Добыть ресурсы', callback_data: 'mine' }],
      [{ text: 'Атаковать', callback_data: 'attack' }, { text: 'Рейтинг', callback_data: 'top' }],
      [{ text: 'Ежедневная награда', callback_data: 'daily' }, { text: 'Помощь', callback_data: 'help' }],
    ],
  };
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Telegram API returned ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || 'Telegram API error');
  return result;
}

async function send(chatId, text, extra = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard(),
    ...extra,
  });
}

async function getOrCreatePlayer(user) {
  const sb = getSupabase();
  const { data: existing, error: lookupError } = await sb
    .from('telegram_players')
    .select('*')
    .eq('telegram_user_id', user.id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { player: existing, created: false };

  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Воин';
  const { data, error } = await sb
    .from('telegram_players')
    .insert({
      telegram_user_id: user.id,
      username: user.username || null,
      display_name: displayName,
      shield_until: new Date(Date.now() + 12 * HOUR).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return { player: data, created: true };
}

function levelFor(player) {
  return player.level * 100;
}

function castleText(player, intro = '') {
  const shield = player.shield_until && new Date(player.shield_until) > new Date() ? 'активен' : 'нет';
  return `${intro ? `${intro}\n\n` : ''}<b>Крепость ${html(player.display_name)}</b>\n\n` +
    `Уровень: <b>${player.level}</b> · Опыт: ${player.xp}/${levelFor(player)}\n` +
    `Золото: <b>${player.gold}</b> · Дерево: <b>${player.wood}</b> · Камень: <b>${player.stone}</b>\n` +
    `Атака: ${player.attack} · Защита: ${player.defense}\n` +
    `Победы: ${player.wins} · Поражения: ${player.losses}\n` +
    `Энергия: ${player.energy}/5 · Щит: ${shield}`;
}

async function updatePlayer(id, patch) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('telegram_players')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function mine(chatId, player) {
  const now = Date.now();
  if (player.last_mined_at && now - new Date(player.last_mined_at).getTime() < HOUR) {
    const minutes = Math.ceil((HOUR - (now - new Date(player.last_mined_at).getTime())) / 60000);
    return send(chatId, `Шахты ещё работают. Возвращайся через <b>${minutes} мин.</b>`);
  }
  const updated = await updatePlayer(player.id, {
    gold: player.gold + 80 + player.level * 10,
    wood: player.wood + 45,
    stone: player.stone + 30,
    last_mined_at: new Date().toISOString(),
  });
  return send(chatId, castleText(updated, 'Ресурсы доставлены в крепость.'));
}

async function daily(chatId, player) {
  const now = Date.now();
  if (player.last_daily_at && now - new Date(player.last_daily_at).getTime() < DAY) {
    const hours = Math.ceil((DAY - (now - new Date(player.last_daily_at).getTime())) / HOUR);
    return send(chatId, `Ежедневная награда уже получена. Следующая будет через <b>${hours} ч.</b>`);
  }
  const updated = await updatePlayer(player.id, {
    gold: player.gold + 300,
    wood: player.wood + 100,
    stone: player.stone + 100,
    energy: 5,
    last_daily_at: new Date().toISOString(),
  });
  return send(chatId, castleText(updated, 'Казна пополнена: +300 золота, +100 дерева, +100 камня.'));
}

async function attack(chatId, player) {
  if (player.energy < 1) return send(chatId, 'Войско устало. Забери ежедневную награду или дождись нового дня.');
  const sb = getSupabase();
  const { data: defenders, error } = await sb
    .from('telegram_players')
    .select('*')
    .neq('id', player.id)
    .order('wins', { ascending: true })
    .limit(10);
  if (error) throw error;
  if (!defenders?.length) return send(chatId, 'Пока нет других замков для штурма. Позови друзей в игру.');

  const defender = defenders[Math.floor(Math.random() * defenders.length)];
  if (defender.shield_until && new Date(defender.shield_until) > new Date()) {
    return send(chatId, `Замок <b>${html(defender.display_name)}</b> скрыт под защитным куполом.`);
  }

  const attackerPower = player.attack + Math.floor(Math.random() * (player.level * 8 + 1));
  const defenderPower = defender.defense + Math.floor(Math.random() * (defender.level * 8 + 1));
  const won = attackerPower >= defenderPower;
  const stolen = won ? Math.min(defender.gold, 40 + player.level * 15) : 0;
  const attackerXp = won ? 35 : 10;
  const nextXp = player.xp + attackerXp;
  const leveledUp = nextXp >= levelFor(player);
  const nextLevel = leveledUp ? player.level + 1 : player.level;

  await updatePlayer(player.id, {
    energy: player.energy - 1,
    gold: player.gold + stolen,
    wins: player.wins + (won ? 1 : 0),
    losses: player.losses + (won ? 0 : 1),
    xp: leveledUp ? nextXp - levelFor(player) : nextXp,
    level: nextLevel,
    attack: player.attack + (leveledUp ? 3 : 0),
    defense: player.defense + (leveledUp ? 3 : 0),
  });

  await updatePlayer(defender.id, {
    gold: Math.max(0, defender.gold - stolen),
    losses: defender.losses + (won ? 1 : 0),
    wins: defender.wins + (won ? 0 : 1),
  });

  const { error: battleError } = await sb.from('telegram_battles').insert({
    attacker_id: player.id,
    defender_id: defender.id,
    attacker_won: won,
    attacker_power: attackerPower,
    defender_power: defenderPower,
    gold_stolen: stolen,
  });
  if (battleError) throw battleError;

  const result = won
    ? `Победа. Штурм замка <b>${html(defender.display_name)}</b> удался, добыча: <b>${stolen} золота</b>.`
    : `Отступление. Замок <b>${html(defender.display_name)}</b> оказался сильнее.`;
  const levelNote = leveledUp ? '\n\nНовый уровень. Атака и защита выросли на 3.' : '';
  return send(chatId, `${result}\nСилы: ${attackerPower} против ${defenderPower}.${levelNote}`);
}

async function top(chatId) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('telegram_players')
    .select('display_name, level, wins, xp')
    .order('wins', { ascending: false })
    .order('xp', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = (data || []).map((item, index) => `${index + 1}. <b>${html(item.display_name)}</b> — ${item.wins} побед · ур. ${item.level}`);
  return send(chatId, `<b>Зал славы Hellstorm</b>\n\n${rows.length ? rows.join('\n') : 'Пока пусто. Стань первым.'}`);
}

function help(chatId) {
  return send(chatId, '<b>Hellstorm — битва замков</b>\n\nРазвивай крепость, добывай ресурсы и штурмуй чужие замки.\n\n<b>Команды:</b>\n/castle — твоя крепость\n/mine — добыть ресурсы раз в час\n/attack — случайный штурм\n/daily — награда раз в день\n/top — зал славы\n/help — помощь');
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  if (!message?.chat?.id) return;
  const user = callback?.from || update.message?.from;
  if (!user) return;
  if (callback) await telegram('answerCallbackQuery', { callback_query_id: callback.id });

  const { player, created } = await getOrCreatePlayer(user);
  const command = callback?.data || (update.message?.text || '').trim().split(/\s+/)[0].toLowerCase();
  const chatId = message.chat.id;
  if (created && command !== '/start') await send(chatId, 'Крепость создана. Добро пожаловать в Hellstorm.');
  if (command === '/start') return send(chatId, castleText(player, created ? 'Крепость создана. Добро пожаловать в Hellstorm.' : 'С возвращением, командир.'));
  if (command === 'castle' || command === '/castle') return send(chatId, castleText(player));
  if (command === 'mine' || command === '/mine') return mine(chatId, player);
  if (command === 'attack' || command === '/attack') return attack(chatId, player);
  if (command === 'daily' || command === '/daily') return daily(chatId, player);
  if (command === 'top' || command === '/top') return top(chatId);
  return help(chatId);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function registerWebhook(baseUrl) {
  const webhookUrl = `${baseUrl}/telegram`;
  try {
    const result = await telegram('setWebhook', {
      url: webhookUrl,
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      max_connections: 40,
    });
    return { webhookUrl, result };
  } catch (err) {
    return { webhookUrl, error: err.message };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/telegram' || url.pathname === '/telegram' || url.pathname === '/health') {
    if (req.method === 'GET') {
      if (url.searchParams.get('setup') === '1') {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const baseUrl = `${proto}://${host}`;
        const reg = await registerWebhook(baseUrl);
        return sendJSON(res, 200, { ok: true, service: 'hellstorm-telegram-bot', webhook: reg });
      }
      return sendJSON(res, 200, { ok: true, service: 'hellstorm-telegram-bot' });
    }

    if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });

    if (!TELEGRAM_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return sendJSON(res, 500, { error: 'Bot is not configured' });
    }

    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== TELEGRAM_WEBHOOK_SECRET) {
      return sendJSON(res, 401, { error: 'Unauthorized' });
    }

    try {
      const body = await readBody(req);
      await handleUpdate(JSON.parse(body || '{}'));
      return sendJSON(res, 200, { ok: true });
    } catch (error) {
      console.error(error);
      return sendJSON(res, 500, { error: 'Unable to process update' });
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hellstorm</title></head><body><main><h1>Hellstorm</h1><p>Эта страница нужна только для проверки подключения. Игра живёт внутри Telegram.</p></main></body></html>');
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Hellstorm bot server listening on port ${PORT}`);
  });
}

module.exports = { handler: async (event) => {
  const url = new URL(event.path || '/api/telegram', 'http://localhost');
  const headers = event.headers || {};
  if (event.httpMethod === 'GET') {
    if (event.queryStringParameters?.setup === '1') {
      const proto = headers['x-forwarded-proto'] || 'https';
      const host = headers['x-forwarded-host'] || headers.host;
      const baseUrl = `${proto}://${host}`;
      const reg = await registerWebhook(baseUrl);
      return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, service: 'hellstorm-telegram-bot', webhook: reg }) };
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, service: 'hellstorm-telegram-bot' }) };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!TELEGRAM_TOKEN || !TELEGRAM_WEBHOOK_SECRET || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Bot is not configured' }) };
  }
  if (headers['x-telegram-bot-api-secret-token'] !== TELEGRAM_WEBHOOK_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  try {
    await handleUpdate(JSON.parse(event.body || '{}'));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unable to process update' }) };
  }
}, server };
