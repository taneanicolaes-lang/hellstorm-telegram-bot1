import { createClient } from 'npm:@supabase/supabase-js@2.57.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const TELEGRAM_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[ch]!);
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

async function telegram(method: string, body: Record<string, unknown>) {
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

async function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return telegram('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: keyboard(), ...extra });
}

interface Player {
  id: string;
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  level: number;
  xp: number;
  gold: number;
  wood: number;
  stone: number;
  attack: number;
  defense: number;
  wins: number;
  losses: number;
  energy: number;
  last_mined_at: string | null;
  last_daily_at: string | null;
  shield_until: string | null;
}

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

async function getOrCreatePlayer(user: TgUser): Promise<{ player: Player; created: boolean }> {
  const { data: existing, error: lookupError } = await supabase
    .from('telegram_players')
    .select('*')
    .eq('telegram_user_id', user.id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { player: existing as Player, created: false };

  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Воин';
  const { data, error } = await supabase
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
  return { player: data as Player, created: true };
}

function levelFor(player: Player): number {
  return player.level * 100;
}

function castleText(player: Player, intro = ''): string {
  const shield = player.shield_until && new Date(player.shield_until) > new Date() ? 'активен' : 'нет';
  return `${intro ? `${intro}\n\n` : ''}<b>Крепость ${html(player.display_name)}</b>\n\n` +
    `Уровень: <b>${player.level}</b> · Опыт: ${player.xp}/${levelFor(player)}\n` +
    `Золото: <b>${player.gold}</b> · Дерево: <b>${player.wood}</b> · Камень: <b>${player.stone}</b>\n` +
    `Атака: ${player.attack} · Защита: ${player.defense}\n` +
    `Победы: ${player.wins} · Поражения: ${player.losses}\n` +
    `Энергия: ${player.energy}/5 · Щит: ${shield}`;
}

async function updatePlayer(id: string, patch: Record<string, unknown>): Promise<Player> {
  const { data, error } = await supabase
    .from('telegram_players')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as Player;
}

async function mine(chatId: number, player: Player) {
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

async function daily(chatId: number, player: Player) {
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

async function attack(chatId: number, player: Player) {
  if (player.energy < 1) return send(chatId, 'Войско устало. Забери ежедневную награду или дождись нового дня.');
  const { data: defenders, error } = await supabase
    .from('telegram_players')
    .select('*')
    .neq('id', player.id)
    .order('wins', { ascending: true })
    .limit(10);
  if (error) throw error;
  if (!defenders?.length) return send(chatId, 'Пока нет других замков для штурма. Позови друзей в игру.');

  const defender = defenders[Math.floor(Math.random() * defenders.length)] as Player;
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

  const { error: battleError } = await supabase.from('telegram_battles').insert({
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

async function top(chatId: number) {
  const { data, error } = await supabase
    .from('telegram_players')
    .select('display_name, level, wins, xp')
    .order('wins', { ascending: false })
    .order('xp', { ascending: false })
    .limit(10);
  if (error) throw error;
  const rows = (data || []).map((item: { display_name: string; wins: number; level: number }, index: number) =>
    `${index + 1}. <b>${html(item.display_name)}</b> — ${item.wins} побед · ур. ${item.level}`);
  return send(chatId, `<b>Зал славы Hellstorm</b>\n\n${rows.length ? rows.join('\n') : 'Пока пусто. Стань первым.'}`);
}

function help(chatId: number) {
  return send(chatId, '<b>Hellstorm — битва замков</b>\n\nРазвивай крепость, добывай ресурсы и штурмуй чужие замки.\n\n<b>Команды:</b>\n/castle — твоя крепость\n/mine — добыть ресурсы раз в час\n/attack — случайный штурм\n/daily — награда раз в день\n/top — зал славы\n/help — помощь');
}

interface TgUpdate {
  callback_query?: { id: string; from: TgUser; message?: { chat: { id: number } } };
  message?: { chat: { id: number }; from?: TgUser; text?: string };
}

async function handleUpdate(update: TgUpdate) {
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('setup') === '1') {
      const webhookUrl = `${url.origin}/functions/v1/telegram-bot`;
      try {
        const result = await telegram('setWebhook', {
          url: webhookUrl,
          secret_token: TELEGRAM_WEBHOOK_SECRET,
          max_connections: 40,
        });
        return new Response(JSON.stringify({ ok: true, webhook: webhookUrl, result }), {
          headers: { ...corsHeaders, 'content-type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
          status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ ok: true, service: 'hellstorm-telegram-bot' }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  if (!TELEGRAM_TOKEN || !TELEGRAM_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Bot is not configured' }), {
      status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    await handleUpdate(body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Unable to process update' }), {
      status: 500, headers: { ...corsHeaders, 'content-type': 'application/json' },
    });
  }
});
