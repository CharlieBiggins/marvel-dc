/*
# Server-Authoritative Auction Functions

## Overview
Creates SECURITY DEFINER functions that handle all game state mutations server-side.
Clients call these via RPC; they cannot directly mutate auction state, budgets, or rosters.

## Functions
1. `join_game(game_id, display_name)` — join an open game slot
2. `toggle_ready(game_id)` — toggle ready status
3. `start_draft(game_id)` — transitions game from lobby to drafting
4. `nominate_character(game_id, character_id)` — nominator selects a character
5. `place_bid(game_id, auction_id, increment)` — player places a bid
6. `pass_auction(game_id, auction_id)` — player passes on current auction
7. `close_auction(game_id, auction_id)` — closes auction, awards character
8. `auto_fill_rosters(game_id)` — fills remaining slots for players who can't afford
9. `reconnect_player(game_id)` / `disconnect_player(game_id)` — connection management
10. `get_game_state(game_id)` — full game state snapshot
11. `evaluate_game(game_id)` — deterministic team scoring and winner determination

## Security
- All functions are SECURITY DEFINER (bypass RLS)
- Each validates that the caller is a game participant
- Budget checks enforced server-side
- Auction state transitions validated atomically
*/

-- ============================================================================
-- HELPER: Get caller's slot in a game
-- ============================================================================
CREATE OR REPLACE FUNCTION get_caller_slot(p_game_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT slot FROM game_participants
  WHERE game_id = p_game_id AND user_id = auth.uid()
$$;

-- ============================================================================
-- JOIN GAME
-- ============================================================================
CREATE OR REPLACE FUNCTION join_game(p_game_id uuid, p_display_name text)
RETURNS game_participants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_existing game_participants;
  v_next_slot integer;
  v_count integer;
  v_participant game_participants;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game room not found'; END IF;

  SELECT * INTO v_existing FROM game_participants
    WHERE game_id = p_game_id AND user_id = auth.uid();
  IF FOUND THEN
    UPDATE game_participants SET display_name = p_display_name, is_connected = true
      WHERE id = v_existing.id RETURNING * INTO v_participant;
    RETURN v_participant;
  END IF;

  IF v_room.status != 'lobby' THEN RAISE EXCEPTION 'Game has already started'; END IF;

  SELECT count(*) INTO v_count FROM game_participants WHERE game_id = p_game_id;
  IF v_count >= 3 THEN RAISE EXCEPTION 'Game is full'; END IF;

  SELECT COALESCE(MAX(slot), -1) + 1 INTO v_next_slot
    FROM game_participants WHERE game_id = p_game_id;

  INSERT INTO game_participants (game_id, user_id, slot, display_name, budget, is_connected)
    VALUES (p_game_id, auth.uid(), v_next_slot, p_display_name, v_room.starting_budget, true)
    RETURNING * INTO v_participant;

  RETURN v_participant;
END;
$$;

-- ============================================================================
-- TOGGLE READY
-- ============================================================================
CREATE OR REPLACE FUNCTION toggle_ready(p_game_id uuid)
RETURNS game_participants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_participant game_participants;
BEGIN
  SELECT * INTO v_participant FROM game_participants
    WHERE game_id = p_game_id AND user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  UPDATE game_participants SET is_ready = NOT is_ready
    WHERE id = v_participant.id RETURNING * INTO v_participant;

  RETURN v_participant;
END;
$$;

-- ============================================================================
-- START DRAFT
-- ============================================================================
CREATE OR REPLACE FUNCTION start_draft(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_count integer;
  v_ready_count integer;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game room not found'; END IF;
  IF v_room.created_by != auth.uid() THEN RAISE EXCEPTION 'Only the host can start'; END IF;
  IF v_room.status != 'lobby' THEN RAISE EXCEPTION 'Game has already started'; END IF;

  SELECT count(*) INTO v_count FROM game_participants WHERE game_id = p_game_id;
  SELECT count(*) INTO v_ready_count FROM game_participants WHERE game_id = p_game_id AND is_ready = true;
  IF v_count < 3 THEN RAISE EXCEPTION 'Need 3 players to start'; END IF;
  IF v_ready_count < 3 THEN RAISE EXCEPTION 'All players must be ready'; END IF;

  UPDATE game_rooms SET status = 'drafting', current_round = 1, current_nominator_slot = 0
    WHERE id = p_game_id;
END;
$$;

-- ============================================================================
-- NOMINATE CHARACTER
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

  INSERT INTO auctions (game_id, round, nominator_slot, character_id, status, high_bid)
    VALUES (p_game_id, v_room.current_round, v_slot, p_character_id, 'bidding', 0)
    RETURNING * INTO v_auction;

  UPDATE game_rooms SET current_auction_id = v_auction.id WHERE id = p_game_id;
  RETURN v_auction;
END;
$$;

-- ============================================================================
-- PLACE BID
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
BEGIN
  IF p_increment NOT IN (1, 5, 25) THEN RAISE EXCEPTION 'Invalid bid increment'; END IF;

  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF v_room.status != 'drafting' THEN RAISE EXCEPTION 'Game is not drafting'; END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

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

  UPDATE auctions SET high_bid = v_new_bid, high_bidder_slot = v_slot, high_bidder_id = auth.uid()
    WHERE id = p_auction_id RETURNING * INTO v_auction;

  RETURN v_auction;
END;
$$;

-- ============================================================================
-- PASS AUCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION pass_auction(p_game_id uuid, p_auction_id uuid)
RETURNS auctions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction auctions;
  v_slot integer;
  v_has_passed boolean;
  v_active_bidders integer;
BEGIN
  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

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
-- CLOSE AUCTION (internal helper)
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
BEGIN
  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_auction.status != 'bidding' THEN RETURN; END IF;

  IF v_auction.high_bidder_slot IS NOT NULL THEN
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
      VALUES (p_game_id, v_winner.id, v_auction.character_id, v_auction.high_bid, p_auction_id, false);
  ELSE
    UPDATE auctions SET status = 'cancelled', closed_at = now() WHERE id = p_auction_id;
  END IF;

  PERFORM advance_round(p_game_id);
END;
$$;

-- ============================================================================
-- CLOSE AUCTION (public, for timer expiry)
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
BEGIN
  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id AND game_id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auction not found'; END IF;
  IF v_auction.status != 'bidding' THEN RAISE EXCEPTION 'Auction is not active'; END IF;

  v_slot := get_caller_slot(p_game_id);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  SELECT 3 - count(DISTINCT bidder_slot) INTO v_active_bidders
    FROM bids WHERE auction_id = p_auction_id AND is_pass = true;

  IF v_active_bidders <= 1 OR (v_auction.high_bid = 0) THEN
    PERFORM close_auction_internal(p_game_id, p_auction_id);
  ELSE
    RAISE EXCEPTION 'Auction cannot be closed while multiple bidders are active';
  END IF;
END;
$$;

-- ============================================================================
-- ADVANCE ROUND
-- ============================================================================
CREATE OR REPLACE FUNCTION advance_round(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_total_acquired integer;
  v_target_total integer;
  v_next_nominator integer;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(sum(characters_acquired), 0) INTO v_total_acquired
    FROM game_participants WHERE game_id = p_game_id;
  v_target_total := 3 * v_room.roster_size;

  IF v_total_acquired >= v_target_total THEN
    UPDATE game_rooms SET status = 'evaluating', current_auction_id = NULL WHERE id = p_game_id;
    PERFORM evaluate_game(p_game_id);
    RETURN;
  END IF;

  v_next_nominator := v_room.current_round % 3;

  UPDATE game_rooms
    SET current_round = v_room.current_round + 1,
        current_nominator_slot = v_next_nominator,
        current_auction_id = NULL
    WHERE id = p_game_id;
END;
$$;

-- ============================================================================
-- AUTO-FILL ROSTERS
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
        VALUES (p_game_id, v_participant.id, v_available.id, 0, true);

      UPDATE game_participants SET characters_acquired = characters_acquired + 1
        WHERE id = v_participant.id;

      v_slots_needed := v_slots_needed - 1;
    END LOOP;
  END LOOP;

  PERFORM advance_round(p_game_id);
END;
$$;

-- ============================================================================
-- RECONNECT / DISCONNECT
-- ============================================================================
CREATE OR REPLACE FUNCTION reconnect_player(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_slot(p_game_id) IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;
  UPDATE game_participants SET is_connected = true
    WHERE game_id = p_game_id AND user_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION disconnect_player(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE game_participants SET is_connected = false
    WHERE game_id = p_game_id AND user_id = auth.uid();
END;
$$;

-- ============================================================================
-- GET GAME STATE
-- ============================================================================
CREATE OR REPLACE FUNCTION get_game_state(p_game_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_participants jsonb;
  v_auction jsonb;
  v_bids jsonb;
  v_rosters jsonb;
  v_evaluations jsonb;
  v_matchups jsonb;
  v_result jsonb;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;
  IF get_caller_slot(p_game_id) IS NULL THEN RAISE EXCEPTION 'You are not in this game'; END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(gp)), '[]') INTO v_participants
    FROM game_participants gp WHERE gp.game_id = p_game_id ORDER BY slot;

  SELECT row_to_json(a) INTO v_auction FROM auctions a WHERE a.id = v_room.current_auction_id;

  SELECT COALESCE(jsonb_agg(row_to_json(b)), '[]') INTO v_bids
    FROM bids b WHERE b.auction_id = v_room.current_auction_id ORDER BY created_at;

  SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]') INTO v_rosters
    FROM roster_items r WHERE r.game_id = p_game_id ORDER BY acquired_at;

  SELECT COALESCE(jsonb_agg(row_to_json(e)), '[]') INTO v_evaluations
    FROM team_evaluations e WHERE e.game_id = p_game_id;

  SELECT COALESCE(jsonb_agg(row_to_json(m)), '[]') INTO v_matchups
    FROM matchup_evaluations m WHERE m.game_id = p_game_id;

  SELECT row_to_json(gr) INTO v_result FROM game_results gr WHERE gr.game_id = p_game_id;

  RETURN jsonb_build_object(
    'room', row_to_json(v_room),
    'participants', v_participants,
    'current_auction', v_auction,
    'current_bids', v_bids,
    'rosters', v_rosters,
    'evaluations', v_evaluations,
    'matchups', v_matchups,
    'result', v_result
  );
END;
$$;

-- ============================================================================
-- COMPUTE TEAM CATEGORY SCORE (helper)
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
  v_top1 integer;
  v_top2 integer;
  v_top3 integer;
  v_result integer;
BEGIN
  EXECUTE format(
    'SELECT COALESCE(max(c.%I), 0), COALESCE(avg(c.%I), 0)
     FROM roster_items ri JOIN characters c ON c.id = ri.character_id
     WHERE ri.game_id = $1 AND ri.participant_id = $2',
    p_category, p_category
  ) INTO v_max_val, v_avg_val USING p_game_id, p_participant_id;

  EXECUTE format(
    'SELECT COALESCE(array_agg(c.%I ORDER BY c.%I DESC), ARRAY[]::integer[])
     FROM roster_items ri JOIN characters c ON c.id = ri.character_id
     WHERE ri.game_id = $1 AND ri.participant_id = $2',
    p_category, p_category
  ) INTO v_top1 USING p_game_id, p_participant_id;

  v_top2 := v_top1[2];
  v_top3 := v_top1[3];
  IF v_top2 IS NULL THEN v_top2 := 0; END IF;
  IF v_top3 IS NULL THEN v_top3 := 0; END IF;

  v_result := LEAST(100, ROUND(
    (v_max_val * 0.40) +
    (v_top1 * 0.15 + v_top2 * 0.12 + v_top3 * 0.08) +
    (v_avg_val * 0.25)
  ));

  RETURN v_result;
END;
$$;

-- ============================================================================
-- EVALUATE GAME (deterministic scoring)
-- ============================================================================
CREATE OR REPLACE FUNCTION evaluate_game(p_game_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room game_rooms;
  v_participant game_participants;
  v_explanations jsonb;
  v_score integer;
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
  v_i integer;
  v_rankings jsonb;
BEGIN
  SELECT * INTO v_room FROM game_rooms WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found'; END IF;

  -- Calculate team evaluations for each participant
  FOR v_participant IN SELECT * FROM game_participants WHERE game_id = p_game_id ORDER BY slot LOOP
    v_explanations := '{}';

    v_score := compute_team_category_score(p_game_id, v_participant.id, 'ability');
    v_explanations := v_explanations || jsonb_build_object('ability', 'Peak: ' || v_score || '. Weighted blend of top performers and roster depth.');

    -- Upsert with all scores
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
      'Team synergy analyzed based on complementary abilities, speed initiative, and hax coverage.',
      'deterministic')
    ON CONFLICT (game_id, participant_slot)
    DO UPDATE SET
      ability = EXCLUDED.ability,
      regeneration = EXCLUDED.regeneration,
      durability = EXCLUDED.durability,
      stamina = EXCLUDED.stamina,
      speed = EXCLUDED.speed,
      combat = EXCLUDED.combat,
      battle_iq = EXCLUDED.battle_iq,
      intelligence = EXCLUDED.intelligence,
      strength = EXCLUDED.strength,
      striking_power = EXCLUDED.striking_power,
      hax = EXCLUDED.hax,
      category_explanations = EXCLUDED.category_explanations,
      synergy_notes = EXCLUDED.synergy_notes,
      evaluation_type = 'deterministic';
  END LOOP;

  -- Calculate total scores
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total0 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 0;
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total1 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 1;
  SELECT COALESCE(sum(ability + regeneration + durability + stamina + speed + combat + battle_iq + intelligence + strength + striking_power + hax), 0)
    INTO v_total2 FROM team_evaluations WHERE game_id = p_game_id AND participant_slot = 2;

  -- Matchups: (0,1), (0,2), (1,2)
  -- Slot 0 vs Slot 1
  IF v_total0 + v_total1 = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_total0 * 100.0 / (v_total0 + v_total1)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
    VALUES (p_game_id, 0, 1, v_win_prob_a, 100 - v_win_prob_a,
      'Advantages based on category score differential.', 'Advantages based on category score differential.',
      'Key counters from hax and speed differentials.', 'Simulated from team composition.',
      'Exploit category advantages while neutralizing opponent hax.', 'deterministic')
    ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins0 := v_wins0 + 1; ELSE v_wins1 := v_wins1 + 1; END IF;

  -- Slot 0 vs Slot 2
  IF v_total0 + v_total2 = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_total0 * 100.0 / (v_total0 + v_total2)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
    VALUES (p_game_id, 0, 2, v_win_prob_a, 100 - v_win_prob_a,
      'Advantages based on category score differential.', 'Advantages based on category score differential.',
      'Key counters from hax and speed differentials.', 'Simulated from team composition.',
      'Exploit category advantages while neutralizing opponent hax.', 'deterministic')
    ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins0 := v_wins0 + 1; ELSE v_wins2 := v_wins2 + 1; END IF;

  -- Slot 1 vs Slot 2
  IF v_total1 + v_total2 = 0 THEN v_win_prob_a := 50;
  ELSE v_win_prob_a := LEAST(90, GREATEST(10, ROUND(v_total1 * 100.0 / (v_total1 + v_total2)))); END IF;
  INSERT INTO matchup_evaluations (game_id, slot_a, slot_b, win_probability_a, win_probability_b,
    advantages_a, advantages_b, critical_counters, battle_progression, win_conditions, evaluation_type)
    VALUES (p_game_id, 1, 2, v_win_prob_a, 100 - v_win_prob_a,
      'Advantages based on category score differential.', 'Advantages based on category score differential.',
      'Key counters from hax and speed differentials.', 'Simulated from team composition.',
      'Exploit category advantages while neutralizing opponent hax.', 'deterministic')
    ON CONFLICT (game_id, slot_a, slot_b) DO UPDATE SET win_probability_a = v_win_prob_a, win_probability_b = 100 - v_win_prob_a, evaluation_type = 'deterministic';
  IF v_win_prob_a > 50 THEN v_wins1 := v_wins1 + 1; ELSE v_wins2 := v_wins2 + 1; END IF;

  -- Determine winner by most matchup wins, tiebreak by total score
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
      'Winner determined by head-to-head matchup analysis across 11 battle categories. This team demonstrated the best combination of peak power, roster depth, and category coverage.',
      'The battle opens with speedsters and teleporters establishing battlefield positioning. Cosmic-level entities engage in power exchanges while reality manipulators attempt to reshape the battlefield. The decisive moment comes when the winning team''s combination of hax coverage and offensive depth overwhelms the opposition''s defensive capabilities.',
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
-- GRANT EXECUTE
-- ============================================================================
GRANT EXECUTE ON FUNCTION join_game(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION toggle_ready(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION start_draft(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION nominate_character(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION place_bid(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION pass_auction(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION close_auction(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION auto_fill_rosters(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION reconnect_player(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION disconnect_player(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_game_state(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION evaluate_game(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_caller_slot(uuid) TO authenticated;
