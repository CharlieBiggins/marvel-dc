/*
# Core Game Schema — Superhero Auction: Marvel vs. DC

## Overview
Creates the foundational relational schema for a multiplayer superhero auction draft game.
All tables are created first, then RLS and policies are applied to avoid forward-reference issues.

## Tables
1. `profiles` — display names for authenticated users
2. `game_rooms` — game metadata, state, timer config
3. `game_participants` — 3 slots per game, budget, ready status
4. `characters` — Marvel/DC character records with 11 category ratings
5. `character_versions` — specific versions/forms of characters
6. `auctions` — per-round auction state
7. `bids` — individual bid records
8. `roster_items` — completed character acquisitions
9. `team_evaluations` — 11-category scores per team
10. `matchup_evaluations` — head-to-head matchup results
11. `game_results` — overall winner and narrative
12. `audit_events` — admin action trail

## Security
- RLS enabled on all tables
- Owner-scoped for profiles
- Game-participant-scoped for game data
- Characters readable by all authenticated users
*/

-- ============================================================================
-- TABLE CREATION (all tables first, no policies yet)
-- ============================================================================

CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'Player',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code text UNIQUE NOT NULL DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  status text NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','drafting','evaluating','completed')),
  is_private boolean NOT NULL DEFAULT false,
  starting_budget integer NOT NULL DEFAULT 100,
  roster_size integer NOT NULL DEFAULT 18,
  bid_timer_seconds integer NOT NULL DEFAULT 20,
  current_round integer NOT NULL DEFAULT 0,
  current_nominator_slot integer NOT NULL DEFAULT 0,
  current_auction_id uuid,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slot integer NOT NULL CHECK (slot IN (0, 1, 2)),
  display_name text NOT NULL,
  budget integer NOT NULL DEFAULT 100,
  total_spent integer NOT NULL DEFAULT 0,
  characters_acquired integer NOT NULL DEFAULT 0,
  is_ready boolean NOT NULL DEFAULT false,
  is_connected boolean NOT NULL DEFAULT false,
  joined_at timestamptz DEFAULT now(),
  UNIQUE (game_id, slot),
  UNIQUE (game_id, user_id)
);

CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  publisher text NOT NULL CHECK (publisher IN ('Marvel', 'DC')),
  universe text NOT NULL DEFAULT 'Main',
  version_name text NOT NULL DEFAULT 'Standard',
  version_id uuid DEFAULT gen_random_uuid(),
  portrait_url text,
  biography text NOT NULL DEFAULT '',
  abilities text NOT NULL DEFAULT '',
  notable_feats text NOT NULL DEFAULT '',
  limitations text NOT NULL DEFAULT '',
  sources text NOT NULL DEFAULT '',
  is_enabled boolean NOT NULL DEFAULT true,
  tier text NOT NULL DEFAULT 'street' CHECK (tier IN ('street','mid','high','cosmic','reality')),
  ability integer NOT NULL DEFAULT 50 CHECK (ability >= 0 AND ability <= 100),
  regeneration integer NOT NULL DEFAULT 50 CHECK (regeneration >= 0 AND regeneration <= 100),
  durability integer NOT NULL DEFAULT 50 CHECK (durability >= 0 AND durability <= 100),
  stamina integer NOT NULL DEFAULT 50 CHECK (stamina >= 0 AND stamina <= 100),
  speed integer NOT NULL DEFAULT 50 CHECK (speed >= 0 AND speed <= 100),
  combat integer NOT NULL DEFAULT 50 CHECK (combat >= 0 AND combat <= 100),
  battle_iq integer NOT NULL DEFAULT 50 CHECK (battle_iq >= 0 AND battle_iq <= 100),
  intelligence integer NOT NULL DEFAULT 50 CHECK (intelligence >= 0 AND intelligence <= 100),
  strength integer NOT NULL DEFAULT 50 CHECK (strength >= 0 AND strength <= 100),
  striking_power integer NOT NULL DEFAULT 50 CHECK (striking_power >= 0 AND striking_power <= 100),
  hax integer NOT NULL DEFAULT 50 CHECK (hax >= 0 AND hax <= 100),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS character_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_name text NOT NULL,
  publisher text NOT NULL CHECK (publisher IN ('Marvel', 'DC')),
  version_label text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  round integer NOT NULL,
  nominator_slot integer NOT NULL CHECK (nominator_slot IN (0, 1, 2)),
  character_id uuid NOT NULL REFERENCES characters(id),
  status text NOT NULL DEFAULT 'nominating' CHECK (status IN ('nominating','bidding','closed','cancelled')),
  high_bid integer NOT NULL DEFAULT 0,
  high_bidder_slot integer,
  high_bidder_id uuid,
  started_at timestamptz DEFAULT now(),
  closed_at timestamptz,
  winning_bid integer,
  winner_slot integer,
  winner_id uuid,
  UNIQUE (game_id, round)
);

CREATE TABLE IF NOT EXISTS bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  bidder_slot integer NOT NULL CHECK (bidder_slot IN (0, 1, 2)),
  bidder_id uuid NOT NULL REFERENCES auth.users(id),
  amount integer NOT NULL,
  increment integer NOT NULL CHECK (increment IN (1, 5, 25)),
  is_pass boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roster_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES game_participants(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id),
  purchase_price integer NOT NULL DEFAULT 0,
  auction_id uuid REFERENCES auctions(id),
  acquired_at timestamptz DEFAULT now(),
  is_auto_filled boolean NOT NULL DEFAULT false,
  UNIQUE (game_id, character_id)
);

CREATE TABLE IF NOT EXISTS team_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  participant_slot integer NOT NULL CHECK (participant_slot IN (0, 1, 2)),
  ability integer NOT NULL DEFAULT 50,
  regeneration integer NOT NULL DEFAULT 50,
  durability integer NOT NULL DEFAULT 50,
  stamina integer NOT NULL DEFAULT 50,
  speed integer NOT NULL DEFAULT 50,
  combat integer NOT NULL DEFAULT 50,
  battle_iq integer NOT NULL DEFAULT 50,
  intelligence integer NOT NULL DEFAULT 50,
  strength integer NOT NULL DEFAULT 50,
  striking_power integer NOT NULL DEFAULT 50,
  hax integer NOT NULL DEFAULT 50,
  evaluation_type text NOT NULL DEFAULT 'deterministic' CHECK (evaluation_type IN ('deterministic','ai')),
  category_explanations jsonb NOT NULL DEFAULT '{}',
  synergy_notes text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now(),
  UNIQUE (game_id, participant_slot)
);

CREATE TABLE IF NOT EXISTS matchup_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  slot_a integer NOT NULL CHECK (slot_a IN (0, 1, 2)),
  slot_b integer NOT NULL CHECK (slot_b IN (0, 1, 2)),
  win_probability_a integer NOT NULL DEFAULT 50 CHECK (win_probability_a >= 0 AND win_probability_a <= 100),
  win_probability_b integer NOT NULL DEFAULT 50 CHECK (win_probability_b >= 0 AND win_probability_b <= 100),
  advantages_a text NOT NULL DEFAULT '',
  advantages_b text NOT NULL DEFAULT '',
  critical_counters text NOT NULL DEFAULT '',
  battle_progression text NOT NULL DEFAULT '',
  win_conditions text NOT NULL DEFAULT '',
  evaluation_type text NOT NULL DEFAULT 'deterministic' CHECK (evaluation_type IN ('deterministic','ai')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (game_id, slot_a, slot_b)
);

CREATE TABLE IF NOT EXISTS game_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL UNIQUE REFERENCES game_rooms(id) ON DELETE CASCADE,
  winner_slot integer NOT NULL CHECK (winner_slot IN (0, 1, 2)),
  winner_assessment text NOT NULL DEFAULT '',
  battle_narrative text NOT NULL DEFAULT '',
  evaluation_type text NOT NULL DEFAULT 'deterministic' CHECK (evaluation_type IN ('deterministic','ai')),
  category_rankings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid REFERENCES game_rooms(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- ============================================================================
-- RLS ENABLE
-- ============================================================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE matchup_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- POLICIES
-- ============================================================================

-- Profiles
DROP POLICY IF EXISTS "profiles_select_own" ON profiles;
CREATE POLICY "profiles_select_own" ON profiles FOR SELECT
  TO authenticated USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON profiles;
CREATE POLICY "profiles_insert_own" ON profiles FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
CREATE POLICY "profiles_update_own" ON profiles FOR UPDATE
  TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- Game Rooms
DROP POLICY IF EXISTS "rooms_select_participants" ON game_rooms;
CREATE POLICY "rooms_select_participants" ON game_rooms FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = game_rooms.id AND gp.user_id = auth.uid())
    OR status = 'lobby'
  );

DROP POLICY IF EXISTS "rooms_insert_authenticated" ON game_rooms;
CREATE POLICY "rooms_insert_authenticated" ON game_rooms FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "rooms_update_creator" ON game_rooms;
CREATE POLICY "rooms_update_creator" ON game_rooms FOR UPDATE
  TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

-- Game Participants
DROP POLICY IF EXISTS "participants_select_game_members" ON game_participants;
CREATE POLICY "participants_select_game_members" ON game_participants FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = game_participants.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "participants_insert_own" ON game_participants;
CREATE POLICY "participants_insert_own" ON game_participants FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "participants_update_own" ON game_participants;
CREATE POLICY "participants_update_own" ON game_participants FOR UPDATE
  TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Characters
DROP POLICY IF EXISTS "characters_select_all" ON characters;
CREATE POLICY "characters_select_all" ON characters FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "characters_insert_authenticated" ON characters;
CREATE POLICY "characters_insert_authenticated" ON characters FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "characters_update_authenticated" ON characters;
CREATE POLICY "characters_update_authenticated" ON characters FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "character_versions_select_all" ON character_versions;
CREATE POLICY "character_versions_select_all" ON character_versions FOR SELECT
  TO authenticated USING (true);

-- Auctions
DROP POLICY IF EXISTS "auctions_select_game_members" ON auctions;
CREATE POLICY "auctions_select_game_members" ON auctions FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = auctions.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "auctions_insert_game_members" ON auctions;
CREATE POLICY "auctions_insert_game_members" ON auctions FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = auctions.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "auctions_update_game_members" ON auctions;
CREATE POLICY "auctions_update_game_members" ON auctions FOR UPDATE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = auctions.game_id AND gp.user_id = auth.uid())
  );

-- Bids
DROP POLICY IF EXISTS "bids_select_game_members" ON bids;
CREATE POLICY "bids_select_game_members" ON bids FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = bids.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "bids_insert_own" ON bids;
CREATE POLICY "bids_insert_own" ON bids FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = bidder_id);

-- Roster Items
DROP POLICY IF EXISTS "roster_select_game_members" ON roster_items;
CREATE POLICY "roster_select_game_members" ON roster_items FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = roster_items.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "roster_insert_game_members" ON roster_items;
CREATE POLICY "roster_insert_game_members" ON roster_items FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = roster_items.game_id AND gp.user_id = auth.uid())
  );

-- Team Evaluations
DROP POLICY IF EXISTS "evaluations_select_game_members" ON team_evaluations;
CREATE POLICY "evaluations_select_game_members" ON team_evaluations FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = team_evaluations.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "evaluations_insert_game_members" ON team_evaluations;
CREATE POLICY "evaluations_insert_game_members" ON team_evaluations FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = team_evaluations.game_id AND gp.user_id = auth.uid())
  );

-- Matchup Evaluations
DROP POLICY IF EXISTS "matchups_select_game_members" ON matchup_evaluations;
CREATE POLICY "matchups_select_game_members" ON matchup_evaluations FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = matchup_evaluations.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "matchups_insert_game_members" ON matchup_evaluations;
CREATE POLICY "matchups_insert_game_members" ON matchup_evaluations FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = matchup_evaluations.game_id AND gp.user_id = auth.uid())
  );

-- Game Results
DROP POLICY IF EXISTS "results_select_game_members" ON game_results;
CREATE POLICY "results_select_game_members" ON game_results FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = game_results.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "results_insert_game_members" ON game_results;
CREATE POLICY "results_insert_game_members" ON game_results FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = game_results.game_id AND gp.user_id = auth.uid())
  );

-- Audit Events
DROP POLICY IF EXISTS "audit_select_game_members" ON audit_events;
CREATE POLICY "audit_select_game_members" ON audit_events FOR SELECT
  TO authenticated USING (
    actor_id = auth.uid()
    OR EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = audit_events.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "audit_insert_own" ON audit_events;
CREATE POLICY "audit_insert_own" ON audit_events FOR INSERT
  TO authenticated WITH CHECK (actor_id = auth.uid());

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_participants_game ON game_participants(game_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON game_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_auctions_game ON auctions(game_id);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
CREATE INDEX IF NOT EXISTS idx_bids_game ON bids(game_id);
CREATE INDEX IF NOT EXISTS idx_roster_game ON roster_items(game_id);
CREATE INDEX IF NOT EXISTS idx_roster_participant ON roster_items(participant_id);
CREATE INDEX IF NOT EXISTS idx_characters_publisher ON characters(publisher);
CREATE INDEX IF NOT EXISTS idx_evaluations_game ON team_evaluations(game_id);
CREATE INDEX IF NOT EXISTS idx_matchups_game ON matchup_evaluations(game_id);
CREATE INDEX IF NOT EXISTS idx_audit_game ON audit_events(game_id);
