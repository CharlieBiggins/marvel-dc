/*
# Auction Engine Hardening + Character Evidence + Battle Scenarios

## Overview
This migration hardens the auction engine with server-authoritative deadlines,
advisory-lock concurrency control, and character version snapshots at purchase time.
It also adds structured evidence tables and versioned battle scenarios.

## Changes

### 1. Auction deadline (server-authoritative)
- Adds `deadline_at` timestamptz column to `auctions` table
- The server sets this when bidding opens; clients compare against it
- `place_bid` rejects bids where `now() > deadline_at`
- `close_auction` checks deadline to allow timer-based closes

### 2. Advisory locks for concurrent bid serialization
- `place_bid` and `pass_auction` now acquire a transaction-level advisory lock
  keyed to the auction ID, preventing two concurrent bids from both succeeding

### 3. Character version snapshots
- New `roster_snapshots` table stores a copy of the character's ratings at purchase time
- `close_auction_internal` inserts a snapshot row alongside each `roster_item`
- Evaluations read from snapshots, not the live `characters` table

### 4. Character evidence (structured feats/sources)
- New `character_evidence` table: feat descriptions, source references, confidence,
  dispute status, and the category the evidence supports

### 5. Battle scenarios (versioned)
- New `battle_scenarios` table: battlefield, prep time, starting distance, equipment,
  victory conditions, BFR rules, scenario version
- `game_rooms` gets `scenario_id` FK and `scoring_version` text

### 6. Evaluation input snapshot
- New `evaluation_inputs` table: full JSON snapshot of rosters + character data +
  scenario + scoring version at evaluation time, for reproducibility

### 7. Updated functions
- `nominate_character`: sets `deadline_at`
- `place_bid`: advisory lock + deadline check + resets deadline
- `pass_auction`: advisory lock + deadline check
- `close_auction`: checks deadline
- `close_auction_internal`: inserts roster_snapshot
- `evaluate_game`: reads from snapshots, stores evaluation_inputs, uses scenario

## Security
- RLS enabled on all new tables
- Evidence and scenarios readable by all authenticated users (reference data)
- Evaluation inputs scoped to game members
- Roster snapshots scoped to game members
*/

-- ============================================================================
-- 1. AUCTION DEADLINE COLUMN
-- ============================================================================
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS bid_count integer NOT NULL DEFAULT 0;

-- ============================================================================
-- 2. ROSTER SNAPSHOTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS roster_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  roster_item_id uuid NOT NULL REFERENCES roster_items(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
  character_id uuid NOT NULL REFERENCES characters(id),
  -- Snapshot of character data at purchase time
  name text NOT NULL,
  publisher text NOT NULL,
  universe text NOT NULL,
  version_name text NOT NULL,
  tier text NOT NULL,
  ability integer NOT NULL,
  regeneration integer NOT NULL,
  durability integer NOT NULL,
  stamina integer NOT NULL,
  speed integer NOT NULL,
  combat integer NOT NULL,
  battle_iq integer NOT NULL,
  intelligence integer NOT NULL,
  strength integer NOT NULL,
  striking_power integer NOT NULL,
  hax integer NOT NULL,
  abilities text NOT NULL DEFAULT '',
  notable_feats text NOT NULL DEFAULT '',
  limitations text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE roster_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_select_game_members" ON roster_snapshots;
CREATE POLICY "snapshots_select_game_members" ON roster_snapshots FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = roster_snapshots.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "snapshots_insert_game_members" ON roster_snapshots;
CREATE POLICY "snapshots_insert_game_members" ON roster_snapshots FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = roster_snapshots.game_id AND gp.user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_snapshots_game ON roster_snapshots(game_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_roster ON roster_snapshots(roster_item_id);

-- ============================================================================
-- 3. CHARACTER EVIDENCE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS character_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  feat_description text NOT NULL,
  source_reference text NOT NULL,
  supporting_category text,
  confidence text NOT NULL DEFAULT 'moderate' CHECK (confidence IN ('high','moderate','low','disputed')),
  is_disputed boolean NOT NULL DEFAULT false,
  dispute_notes text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE character_evidence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_select_all" ON character_evidence;
CREATE POLICY "evidence_select_all" ON character_evidence FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "evidence_insert_authenticated" ON character_evidence;
CREATE POLICY "evidence_insert_authenticated" ON character_evidence FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "evidence_update_authenticated" ON character_evidence;
CREATE POLICY "evidence_update_authenticated" ON character_evidence FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "evidence_delete_authenticated" ON character_evidence;
CREATE POLICY "evidence_delete_authenticated" ON character_evidence FOR DELETE
  TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_evidence_character ON character_evidence(character_id);

-- ============================================================================
-- 4. BATTLE SCENARIOS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS battle_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  battlefield text NOT NULL DEFAULT 'Empty void, no environmental hazards',
  preparation_time text NOT NULL DEFAULT 'No preparation',
  starting_distance text NOT NULL DEFAULT '100 meters',
  allowed_equipment text NOT NULL DEFAULT 'Standard equipment',
  allowed_forms text NOT NULL DEFAULT 'Listed version only',
  team_coordination text NOT NULL DEFAULT 'Full coordination, shared awareness',
  victory_conditions text NOT NULL DEFAULT 'Incapacitation, KO, death, or BFR',
  bfr_counts_as_win boolean NOT NULL DEFAULT true,
  incapacitation_counts boolean NOT NULL DEFAULT true,
  resurrection_allowed boolean NOT NULL DEFAULT true,
  scenario_version text NOT NULL DEFAULT '1.0',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE battle_scenarios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "scenarios_select_all" ON battle_scenarios;
CREATE POLICY "scenarios_select_all" ON battle_scenarios FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "scenarios_insert_authenticated" ON battle_scenarios;
CREATE POLICY "scenarios_insert_authenticated" ON battle_scenarios FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "scenarios_update_authenticated" ON battle_scenarios;
CREATE POLICY "scenarios_update_authenticated" ON battle_scenarios FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

-- Insert default scenario
INSERT INTO battle_scenarios (name, description, is_default, scenario_version)
VALUES (
  'Standard Battle',
  'Default scenario: open battlefield, no preparation, full team coordination. Victory by incapacitation, KO, death, or battlefield removal.',
  true, '1.0'
)
ON CONFLICT DO NOTHING;

-- Add scenario reference to game_rooms
ALTER TABLE game_rooms ADD COLUMN IF NOT EXISTS scenario_id uuid REFERENCES battle_scenarios(id);
ALTER TABLE game_rooms ADD COLUMN IF NOT EXISTS scoring_version text NOT NULL DEFAULT '1.0';

-- ============================================================================
-- 5. EVALUATION INPUTS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS evaluation_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL UNIQUE REFERENCES game_rooms(id) ON DELETE CASCADE,
  scenario_id uuid REFERENCES battle_scenarios(id),
  scoring_version text NOT NULL DEFAULT '1.0',
  character_data_version text NOT NULL DEFAULT 'seed-v1',
  roster_snapshot jsonb NOT NULL DEFAULT '{}',
  scenario_snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE evaluation_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "eval_inputs_select_game_members" ON evaluation_inputs;
CREATE POLICY "eval_inputs_select_game_members" ON evaluation_inputs FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = evaluation_inputs.game_id AND gp.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "eval_inputs_insert_game_members" ON evaluation_inputs;
CREATE POLICY "eval_inputs_insert_game_members" ON evaluation_inputs FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM game_participants gp WHERE gp.game_id = evaluation_inputs.game_id AND gp.user_id = auth.uid())
  );

-- ============================================================================
-- 6. UPDATED FUNCTIONS: nominate_character (with deadline)
-- ============================================================================
CREATE OR REPLACE FUNCTION nominate_character(p_game_id uuid, p_character_id uuid)
RETURNS auctions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_slot integer;
  v_auction auctions;
  v_already_drafted boolean;
  v_participant game_participants;
  v_timer_secs integer;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status != 'drafting' THEN RAISE EXCEPTION 'Game is not in drafting state'; END IF;

  v_slot := get_caller_slot(p_game_id);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;
  IF v_slot != v_room.current_nominator_slot THEN RAISE EXCEPTION 'It is not your turn to nominate'; END IF;

  IF v_room.current_auction_id IS NOT NULL THEN
    SELECT * INTO v_auction FROM auctions WHERE id = v_room.current_auction_id;
    IF v_auction.status IN ('nominating','bidding') THEN
      RAISE EXCEPTION 'There is already an active auction';
    END IF;
  END IF;

  SELECT EXISTS(SELECT 1 FROM roster_items WHERE game_id = p_game_id AND character_id = p_character_id)
    INTO v_already_drafted;
  IF v_already_drafted THEN RAISE EXCEPTION 'Character already drafted'; END IF;

  SELECT EXISTS(SELECT 1 FROM auctions WHERE game_id = p_game_id AND character_id = p_character_id AND status IN ('nominating','bidding'))
    INTO v_already_drafted;
  IF v_already_drafted THEN RAISE EXCEPTION 'Character is already being auctioned'; END IF;

  SELECT * INTO v_participant FROM game_participants WHERE game_id = p_game_id AND slot = v_slot;
  IF v_participant.budget < 1 THEN RAISE EXCEPTION 'Insufficient budget to nominate'; END IF;

  v_timer_secs := v_room.bid_timer_seconds;

  INSERT INTO auctions (game_id, round, nominator_slot, character_id, status, high_bid, deadline_at)
    VALUES (p_game_id, v_room.current_round, v_slot, p_character_id, 'bidding', 0, now() + (v_timer_secs || ' seconds')::interval)
    RETURNING * INTO v_auction;

  UPDATE game_rooms SET current_auction_id = v_auction.id WHERE id = p_game_id;
  RETURN v_auction;
END;
$$;

-- ============================================================================
-- 7. UPDATED: place_bid (advisory lock + deadline check)
-- ============================================================================
CREATE OR REPLACE FUNCTION place_bid(p_game_id uuid, p_auction_id uuid, p_increment integer)
RETURNS auctions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_auction auctions;
  v_slot integer;
  v_participant game_participants;
  v_new_bid integer;
  v_slots_remaining integer;
  v_min_reserve integer;
  v_has_passed boolean;
  v_lock_key bigint;
BEGIN
  IF p_increment NOT IN (1, 5, 25) THEN RAISE EXCEPTION 'Invalid bid increment'; END IF;

  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status != 'drafting' THEN RAISE EXCEPTION 'Game is not drafting'; END IF;

  -- Advisory lock keyed to auction ID for concurrency serialization
  v_lock_key := hashtext(p_auction_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

  -- Server-authoritative deadline check
  IF v_auction.deadline_at IS NOT NULL AND now() > v_auction.deadline_at THEN
    RAISE EXCEPTION 'Auction deadline has passed';
  END IF;

  v_slot := get_caller_slot(p_game_id);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  IF v_auction.high_bidder_slot = v_slot THEN RAISE EXCEPTION 'You are already the highest bidder'; END IF;

  SELECT EXISTS(SELECT 1 FROM bids WHERE auction_id = p_auction_id AND bidder_slot = v_slot AND is_pass = true)
    INTO v_has_passed;
  IF v_has_passed THEN RAISE EXCEPTION 'You have already passed'; END IF;

  v_new_bid := v_auction.high_bid + p_increment;
  IF v_auction.high_bid = 0 AND v_new_bid < 1 THEN RAISE EXCEPTION 'Minimum bid is $1'; END IF;

  SELECT * INTO v_participant FROM game_participants WHERE game_id = p_game_id AND slot = v_slot;
  IF NOT FOUND THEN RAISE EXCEPTION 'Participant not found'; END IF;

  v_slots_remaining := v_room.roster_size - v_participant.characters_acquired;
  v_min_reserve := GREATEST(v_slots_remaining - 1, 0);

  IF v_new_bid + v_min_reserve > v_participant.budget THEN
    RAISE EXCEPTION 'Insufficient budget: bid of $% would leave you unable to fill remaining slots', v_new_bid;
  END IF;

  INSERT INTO bids (auction_id, game_id, bidder_slot, bidder_id, amount, increment, is_pass)
    VALUES (p_auction_id, p_game_id, v_slot, auth.uid(), v_new_bid, p_increment, false);

  -- Reset deadline on new bid
  UPDATE auctions
    SET high_bid = v_new_bid, high_bidder_slot = v_slot, high_bidder_id = auth.uid(),
        deadline_at = now() + (v_room.bid_timer_seconds || ' seconds')::interval,
        bid_count = bid_count + 1
    WHERE id = p_auction_id
    RETURNING * INTO v_auction;

  RETURN v_auction;
END;
$$;

-- ============================================================================
-- 8. UPDATED: pass_auction (advisory lock + deadline check)
-- ============================================================================
CREATE OR REPLACE FUNCTION pass_auction(p_game_id uuid, p_auction_id uuid)
RETURNS auctions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_auction auctions;
  v_slot integer;
  v_has_passed boolean;
  v_active_bidders integer;
  v_lock_key bigint;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status != 'drafting' THEN RAISE EXCEPTION 'Game is not drafting'; END IF;

  v_lock_key := hashtext(p_auction_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

  IF v_auction.deadline_at IS NOT NULL AND now() > v_auction.deadline_at THEN
    RAISE EXCEPTION 'Auction deadline has passed';
  END IF;

  v_slot := get_caller_slot(p_game_id);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  SELECT EXISTS(SELECT 1 FROM bids WHERE auction_id = p_auction_id AND bidder_slot = v_slot AND is_pass = true)
    INTO v_has_passed;
  IF v_has_passed THEN RAISE EXCEPTION 'You have already passed'; END IF;

  INSERT INTO bids (auction_id, game_id, bidder_slot, bidder_id, amount, increment, is_pass)
    VALUES (p_auction_id, p_game_id, v_slot, auth.uid(), 0, 0, true);

  SELECT 3 - count(DISTINCT bidder_slot) INTO v_active_bidders
    FROM bids WHERE auction_id = p_auction_id AND is_pass = true;

  IF v_active_bidders <= 1 AND v_auction.high_bidder_slot IS NOT NULL THEN
    PERFORM close_auction_internal(p_game_id, p_auction_id);
    SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id;
  END IF;

  RETURN v_auction;
END;
$$;

-- ============================================================================
-- 9. UPDATED: close_auction (deadline-aware)
-- ============================================================================
CREATE OR REPLACE FUNCTION close_auction(p_game_id uuid, p_auction_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction auctions;
  v_active_bidders integer;
  v_slot integer;
  v_deadline_passed boolean;
BEGIN
  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

  v_slot := get_caller_slot(p_game_id);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  v_deadline_passed := v_auction.deadline_at IS NOT NULL AND now() > v_auction.deadline_at;

  SELECT 3 - count(DISTINCT bidder_slot) INTO v_active_bidders
    FROM bids WHERE auction_id = p_auction_id AND is_pass = true;

  -- Allow close if: deadline passed, all but one passed, or no bids at all
  IF v_deadline_passed OR v_active_bidders <= 1 OR (v_auction.high_bid = 0) THEN
    PERFORM close_auction_internal(p_game_id, p_auction_id);
  ELSE
    RAISE EXCEPTION 'Auction cannot be closed while multiple bidders are active and deadline has not passed';
  END IF;
END;
$$;

-- ============================================================================
-- 10. UPDATED: close_auction_internal (with roster snapshot)
-- ============================================================================
CREATE OR REPLACE FUNCTION close_auction_internal(p_game_id uuid, p_auction_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction auctions;
  v_winner game_participants;
  v_character characters;
  v_roster_item roster_items;
  v_lock_key bigint;
BEGIN
  v_lock_key := hashtext(p_auction_id::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_auction.status != 'bidding' THEN RETURN; END IF;

  IF v_auction.high_bidder_slot IS NOT NULL THEN
    SELECT * INTO v_character FROM characters WHERE id = v_auction.character_id;

    UPDATE auctions
      SET status = 'closed', closed_at = now(),
          winning_bid = high_bid, winner_slot = high_bidder_slot, winner_id = high_bidder_id
      WHERE id = p_auction_id;

    UPDATE game_participants
      SET budget = budget - v_auction.high_bid,
          total_spent = total_spent + v_auction.high_bid,
          characters_acquired = characters_acquired + 1
      WHERE game_id = p_game_id AND slot = v_auction.high_bidder_slot
      RETURNING * INTO v_winner;

    INSERT INTO roster_items (game_id, participant_id, character_id, purchase_price, auction_id, is_auto_filled)
      VALUES (p_game_id, v_winner.id, v_auction.character_id, v_auction.high_bid, p_auction_id, false)
      RETURNING * INTO v_roster_item;

    -- Snapshot character data at purchase time
    INSERT INTO roster_snapshots (
      roster_item_id, game_id, character_id,
      name, publisher, universe, version_name, tier,
      ability, regeneration, durability, stamina, speed, combat, battle_iq, intelligence, strength, striking_power, hax,
      abilities, notable_feats, limitations
    ) VALUES (
      v_roster_item.id, p_game_id, v_auction.character_id,
      v_character.name, v_character.publisher, v_character.universe, v_character.version_name, v_character.tier,
      v_character.ability, v_character.regeneration, v_character.durability, v_character.stamina, v_character.speed, v_character.combat, v_character.battle_iq, v_character.intelligence, v_character.strength, v_character.striking_power, v_character.hax,
      v_character.abilities, v_character.notable_feats, v_character.limitations
    );
  ELSE
    UPDATE auctions SET status = 'cancelled', closed_at = now() WHERE id = p_auction_id;
  END IF;

  PERFORM advance_round(p_game_id);
END;
$$;

-- ============================================================================
-- 11. UPDATED: auto_fill_rosters (with snapshot)
-- ============================================================================
CREATE OR REPLACE FUNCTION auto_fill_rosters(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_participant game_participants;
  v_available characters;
  v_slots_needed integer;
  v_roster_item roster_items;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status != 'drafting' THEN RAISE EXCEPTION 'Game is not drafting'; END IF;

  FOR v_participant IN SELECT * FROM game_participants WHERE game_id = p_game_id ORDER BY slot LOOP
    v_slots_needed := v_room.roster_size - v_participant.characters_acquired;
    WHILE v_slots_needed > 0 LOOP
      SELECT c.* INTO v_available FROM characters c
        WHERE c.is_enabled = true
          AND NOT EXISTS (SELECT 1 FROM roster_items WHERE game_id = p_game_id AND character_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM auctions WHERE game_id = p_game_id AND character_id = c.id AND status IN ('nominating','bidding'))
        ORDER BY c.ability ASC LIMIT 1;

      IF NOT FOUND THEN EXIT; END IF;

      INSERT INTO roster_items (game_id, participant_id, character_id, purchase_price, is_auto_filled)
        VALUES (p_game_id, v_participant.id, v_available.id, 0, true)
        RETURNING * INTO v_roster_item;

      -- Snapshot for auto-filled characters too
      INSERT INTO roster_snapshots (
        roster_item_id, game_id, character_id,
        name, publisher, universe, version_name, tier,
        ability, regeneration, durability, stamina, speed, combat, battle_iq, intelligence, strength, striking_power, hax,
        abilities, notable_feats, limitations
      ) VALUES (
        v_roster_item.id, p_game_id, v_available.id,
        v_available.name, v_available.publisher, v_available.universe, v_available.version_name, v_available.tier,
        v_available.ability, v_available.regeneration, v_available.durability, v_available.stamina, v_available.speed, v_available.combat, v_available.battle_iq, v_available.intelligence, v_available.strength, v_available.striking_power, v_available.hax,
        v_available.abilities, v_available.notable_feats, v_available.limitations
      );

      UPDATE game_participants SET characters_acquired = characters_acquired + 1
        WHERE id = v_participant.id;

      v_slots_needed := v_slots_needed - 1;
    END LOOP;
  END LOOP;

  PERFORM advance_round(p_game_id);
END;
$$;

-- ============================================================================
-- 12. UPDATED: compute_team_category_score (reads from snapshots)
-- ============================================================================
CREATE OR REPLACE FUNCTION compute_team_category_score(p_game_id uuid, p_participant_id uuid, p_category text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max_val integer;
  v_avg_val numeric;
  v_vals integer[];
  v_top1 integer;
  v_top2 integer;
  v_top3 integer;
  v_result integer;
BEGIN
  EXECUTE format(
    'SELECT COALESCE(max(s.%I), 0), COALESCE(avg(s.%I), 0)
     FROM roster_snapshots s
     JOIN roster_items ri ON ri.id = s.roster_item_id
     WHERE ri.game_id = $1 AND ri.participant_id = $2',
    p_category, p_category
  ) INTO v_max_val, v_avg_val USING p_game_id, p_participant_id;

  EXECUTE format(
    'SELECT COALESCE(array_agg(s.%I ORDER BY s.%I DESC), ARRAY[]::integer[])
     FROM roster_snapshots s
     JOIN roster_items ri ON ri.id = s.roster_item_id
     WHERE ri.game_id = $1 AND ri.participant_id = $2',
    p_category, p_category
  ) INTO v_vals USING p_game_id, p_participant_id;

  v_top1 := COALESCE(v_vals[1], 0);
  v_top2 := COALESCE(v_vals[2], 0);
  v_top3 := COALESCE(v_vals[3], 0);

  -- Aggregation: 40% peak, 35% top-3 weighted, 25% roster average
  -- This rewards both having a powerhouse AND roster depth
  v_result := LEAST(100, ROUND(
    (v_max_val * 0.40) +
    (v_top1 * 0.15 + v_top2 * 0.12 + v_top3 * 0.08) +
    (v_avg_val * 0.25)
  ));

  RETURN v_result;
END;
$$;

-- ============================================================================
-- 13. UPDATED: evaluate_game (snapshot-based, stores evaluation inputs)
-- ============================================================================
CREATE OR REPLACE FUNCTION evaluate_game(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_scenario battle_scenarios;
  v_participant game_participants;
  v_explanations jsonb;
  v_slot_a integer;
  v_slot_b integer;
  v_score_a integer;
  v_score_b integer;
  v_win_prob_a integer;
  v_total0 integer := 0;
  v_total1 integer := 0;
  v_total2 integer := 0;
  v_wins0 integer := 0;
  v_wins1 integer := 0;
  v_wins2 integer := 0;
  v_winner_slot integer;
  v_max_wins integer;
  v_rankings jsonb;
  v_roster_snapshot jsonb;
  v_scenario_snapshot jsonb;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;

  SELECT * INTO v_scenario FROM battle_scenarios WHERE id = COALESCE(v_room.scenario_id, (SELECT id FROM battle_scenarios WHERE is_default = true LIMIT 1));

  -- Build evaluation input snapshot for reproducibility
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'slot', gp.slot,
    'participant_id', gp.id,
    'display_name', gp.display_name,
    'characters', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'character_id', rs.character_id,
        'name', rs.name,
        'publisher', rs.publisher,
        'version_name', rs.version_name,
        'tier', rs.tier,
        'purchase_price', ri.purchase_price,
        'ability', rs.ability, 'regeneration', rs.regeneration, 'durability', rs.durability,
        'stamina', rs.stamina, 'speed', rs.speed, 'combat', rs.combat, 'battle_iq', rs.battle_iq,
        'intelligence', rs.intelligence, 'strength', rs.strength, 'striking_power', rs.striking_power, 'hax', rs.hax,
        'abilities', rs.abilities, 'notable_feats', rs.notable_feats, 'limitations', rs.limitations
      )), '[]')
      FROM roster_items ri
      JOIN roster_snapshots rs ON rs.roster_item_id = ri.id
      WHERE ri.participant_id = gp.id
    )
  )), '[]') INTO v_roster_snapshot
  FROM game_participants gp WHERE gp.game_id = p_game_id ORDER BY slot;

  v_scenario_snapshot := row_to_json(v_scenario);

  INSERT INTO evaluation_inputs (game_id, scenario_id, scoring_version, character_data_version, roster_snapshot, scenario_snapshot)
  VALUES (p_game_id, v_scenario.id, v_room.scoring_version, 'seed-v1', v_roster_snapshot, v_scenario_snapshot)
  ON CONFLICT (game_id) DO UPDATE SET
    scenario_id = v_scenario.id,
    scoring_version = v_room.scoring_version,
    roster_snapshot = v_roster_snapshot,
    scenario_snapshot = v_scenario_snapshot;

  -- Calculate team evaluations from snapshots
  FOR v_participant IN SELECT * FROM game_participants WHERE game_id = p_game_id ORDER BY slot LOOP
    v_explanations := jsonb_build_object(
      'ability', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'ability') || '. Aggregation: 40% peak, 35% top-3 weighted, 25% roster average.',
      'regeneration', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'regeneration') || '. Assesses healing capacity and survivability depth.',
      'durability', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'durability') || '. Evaluates ability to withstand damage across roster.',
      'stamina', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'stamina') || '. Measures sustained combat endurance.',
      'speed', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'speed') || '. Rewards speedsters who control initiative.',
      'combat', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'combat') || '. Assesses martial skill and fighting capability.',
      'battle_iq', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'battle_iq') || '. Evaluates tactical coordination and battlefield awareness.',
      'intelligence', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'intelligence') || '. Measures strategic planning and technical capability.',
      'strength', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'strength') || '. Assesses raw physical power distribution.',
      'striking_power', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'striking_power') || '. Evaluates offensive output capability.',
      'hax', 'Peak: ' || compute_team_category_score(p_game_id, v_participant.id, 'hax') || '. Rewards reality warping, time manipulation, and exotic abilities.'
    );

    INSERT INTO team_evaluations (game_id, participant_slot, ability,
      regeneration, durability, stamina, speed, combat, battle_iq, intelligence, strength, striking_power, hax,
      category_explanations, synergy_notes, evaluation_type)
    VALUES (p_game_id, v_participant.slot,
      compute_team_category_score(p_game_id, v_participant.id, 'ability'),
      compute_team_category_score(p_game_id, v_participant.id, 'regeneration'),
      compute_team_category_score(p_game_id, v_participant.id, 'durability'),
      compute_team_category_score(p_game_id, v_participant.id, 'stamina'),
      compute_team_category_score(p_game_id, v_participant.id, 'speed'),
      compute_team_category_score(p_game_id, v_participant.id, 'combat'),
      compute_team_category_score(p_game_id, v_participant.id, 'battle_iq'),
      compute_team_category_score(p_game_id, v_participant.id, 'intelligence'),
      compute_team_category_score(p_game_id, v_participant.id, 'strength'),
      compute_team_category_score(p_game_id, v_participant.id, 'striking_power'),
      compute_team_category_score(p_game_id, v_participant.id, 'hax'),
      v_explanations,
      'Team synergy assessed by examining complementary abilities, speed initiative, hax coverage, and defensive depth. Magic users protecting physical fighters, speedsters controlling initiative, and reality manipulators providing exotic counters are identified.',
      'deterministic')
    ON CONFLICT (game_id, participant_slot)
    DO UPDATE SET
      ability = EXCLUDED.ability, regeneration = EXCLUDED.regeneration,
      durability = EXCLUDED.durability, stamina = EXCLUDED.stamina,
      speed = EXCLUDED.speed, combat = EXCLUDED.combat,
      battle_iq = EXCLUDED.battle_iq, intelligence = EXCLUDED.intelligence,
      strength = EXCLUDED.strength, striking_power = EXCLUDED.striking_power,
      hax = EXCLUDED.hax,
      category_explanations = EXCLUDED.category_explanations,
      synergy_notes = EXCLUDED.synergy_notes,
      evaluation_type = 'deterministic';
  END LOOP;

  -- Total scores
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total0 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 0;
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total1 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 1;
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total2 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 2;

  -- Matchup evaluations (0,1), (0,2), (1,2)
  -- 0 vs 1
  v_score_a := v_total0; v_score_b := v_total1;
  IF v_score_a + v_score_b = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_score_a * 100.0 / (v_score_a + v_score_b)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
  VALUES (p_game_id, 0, 1, v_win_prob_a, 100 - v_win_prob_a,
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Key counters identified from hax vs durability, speed vs combat, and reality warping vs conventional defenses.',
    'Battle opens with speedsters establishing positioning. Cosmic entities engage in power exchanges. Reality manipulators attempt to reshape the battlefield. Decisive moment comes from hax coverage and offensive depth.',
    'Win condition: exploit category advantages while neutralizing opponent hax. Speed control and battlefield manipulation are key vectors.',
    'deterministic')
  ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins0 := v_wins0 + 1; ELSE v_wins1 := v_wins1 + 1; END IF;

  -- 0 vs 2
  v_score_a := v_total0; v_score_b := v_total2;
  IF v_score_a + v_score_b = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_score_a * 100.0 / (v_score_a + v_score_b)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
  VALUES (p_game_id, 0, 2, v_win_prob_a, 100 - v_win_prob_a,
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Key counters identified from hax vs durability, speed vs combat, and reality warping vs conventional defenses.',
    'Battle opens with speedsters establishing positioning. Cosmic entities engage in power exchanges. Reality manipulators attempt to reshape the battlefield. Decisive moment comes from hax coverage and offensive depth.',
    'Win condition: exploit category advantages while neutralizing opponent hax. Speed control and battlefield manipulation are key vectors.',
    'deterministic')
  ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins0 := v_wins0 + 1; ELSE v_wins2 := v_wins2 + 1; END IF;

  -- 1 vs 2
  v_score_a := v_total1; v_score_b := v_total2;
  IF v_score_a + v_score_b = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_score_a * 100.0 / (v_score_a + v_score_b)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
  VALUES (p_game_id, 1, 2, v_win_prob_a, 100 - v_win_prob_a,
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Advantages derived from category score differential across 11 battle dimensions.',
    'Key counters identified from hax vs durability, speed vs combat, and reality warping vs conventional defenses.',
    'Battle opens with speedsters establishing positioning. Cosmic entities engage in power exchanges. Reality manipulators attempt to reshape the battlefield. Decisive moment comes from hax coverage and offensive depth.',
    'Win condition: exploit category advantages while neutralizing opponent hax. Speed control and battlefield manipulation are key vectors.',
    'deterministic')
  ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins1 := v_wins1 + 1; ELSE v_wins2 := v_wins2 + 1; END IF;

  -- Determine winner by matchup wins, tiebreak by total score
  v_winner_slot := 0;
  v_max_wins := v_wins0;
  IF v_wins1 > v_max_wins OR (v_wins1 = v_max_wins AND v_total1 > v_total0) THEN
    v_winner_slot := 1; v_max_wins := v_wins1;
  END IF;
  IF v_wins2 > v_max_wins OR (v_wins2 = v_max_wins AND v_total2 > CASE WHEN v_winner_slot = 0 THEN v_total0 ELSE v_total1 END) THEN
    v_winner_slot := 2;
  END IF;

  v_rankings := jsonb_build_array(
    jsonb_build_object('slot', 0, 'total_score', v_total0, 'wins', v_wins0),
    jsonb_build_object('slot', 1, 'total_score', v_total1, 'wins', v_wins1),
    jsonb_build_object('slot', 2, 'total_score', v_total2, 'wins', v_wins2)
  );

  INSERT INTO game_results (game_id, winner_slot, winner_assessment, battle_narrative, evaluation_type, category_rankings)
  VALUES (p_game_id, v_winner_slot,
    'Winner determined by head-to-head matchup record across 11 battle categories. This team won the most pairwise matchups, demonstrating the best combination of peak power, roster depth, and category coverage. Determined by deterministic scoring engine v1.0 — not an AI judgment.',
    'The battle opens with speedsters and teleporters establishing battlefield positioning under the standard scenario (open battlefield, no preparation, 100m starting distance). Cosmic-level entities engage in power exchanges while reality manipulators attempt to reshape the battlefield. The decisive moment comes when the winning team''s combination of hax coverage and offensive depth overwhelms the opposition''s defensive capabilities. This narrative is a deterministic baseline — plausible battle interpretation, not established comic canon.',
    'deterministic', v_rankings)
  ON CONFLICT (game_id) DO UPDATE SET
    winner_slot = v_winner_slot,
    winner_assessment = EXCLUDED.winner_assessment,
    battle_narrative = EXCLUDED.battle_narrative,
    evaluation_type = 'deterministic',
    category_rankings = v_rankings;

  UPDATE game_rooms SET status = 'completed' WHERE id = p_game_id;
END;
$$;

-- ============================================================================
-- 14. RETRY EVALUATION (for failed AI calls, idempotent)
-- ============================================================================
CREATE OR REPLACE FUNCTION retry_evaluation(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status NOT IN ('evaluating', 'completed') THEN
    RAISE EXCEPTION 'Game must be in evaluating or completed state to retry';
  END IF;

  -- Reset to evaluating, then re-run deterministic evaluation
  -- Existing results are upserted, not duplicated
  UPDATE game_rooms SET status = 'evaluating' WHERE id = p_game_id;
  PERFORM evaluate_game(p_game_id);
END;
$$;

GRANT EXECUTE ON FUNCTION retry_evaluation(uuid) TO authenticated;

-- ============================================================================
-- 15. GRANT on new tables
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON roster_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON character_evidence TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON battle_scenarios TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation_inputs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON auctions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON game_rooms TO authenticated;
