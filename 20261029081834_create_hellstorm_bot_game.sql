/*
# Create Hellstorm Castle Battle game storage

1. New Tables
- `telegram_players`: one persistent castle profile per Telegram user, including display name, resources, combat stats, energy and shield timers.
- `telegram_battles`: immutable combat history for attacks between Telegram players.

2. Security
- Row Level Security is enabled on both tables.
- Browser roles are not granted access because this is a bot-only backend.
- Only the server-side `service_role` can read and write game data.

3. Important Notes
- Telegram numeric user IDs are stored as bigint and are unique.
- Timers use timestamptz so cooldowns remain correct across server instances.
- Resources and combat results are kept in the database rather than process memory, so the bot works after redeploys and across multiple instances.
*/

CREATE TABLE IF NOT EXISTS public.telegram_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id bigint NOT NULL UNIQUE,
  username text,
  display_name text NOT NULL,
  level integer NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  gold integer NOT NULL DEFAULT 250 CHECK (gold >= 0),
  wood integer NOT NULL DEFAULT 150 CHECK (wood >= 0),
  stone integer NOT NULL DEFAULT 100 CHECK (stone >= 0),
  attack integer NOT NULL DEFAULT 12 CHECK (attack >= 1),
  defense integer NOT NULL DEFAULT 10 CHECK (defense >= 1),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  energy integer NOT NULL DEFAULT 5 CHECK (energy >= 0 AND energy <= 5),
  last_mined_at timestamptz,
  last_daily_at timestamptz,
  shield_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.telegram_battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id uuid NOT NULL REFERENCES public.telegram_players(id) ON DELETE CASCADE,
  defender_id uuid NOT NULL REFERENCES public.telegram_players(id) ON DELETE CASCADE,
  attacker_won boolean NOT NULL,
  attacker_power integer NOT NULL CHECK (attacker_power >= 0),
  defender_power integer NOT NULL CHECK (defender_power >= 0),
  gold_stolen integer NOT NULL DEFAULT 0 CHECK (gold_stolen >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telegram_players_leaderboard_idx
  ON public.telegram_players (wins DESC, xp DESC);
CREATE INDEX IF NOT EXISTS telegram_battles_attacker_idx
  ON public.telegram_battles (attacker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS telegram_battles_defender_idx
  ON public.telegram_battles (defender_id, created_at DESC);

ALTER TABLE public.telegram_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_battles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.telegram_players FROM anon, authenticated;
REVOKE ALL ON TABLE public.telegram_battles FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_players TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.telegram_battles TO service_role;
