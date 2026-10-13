export interface Profile {
  id: string;
  display_name: string;
  created_at: string;
}

export interface GameRoom {
  id: string;
  room_code: string;
  status: 'lobby' | 'drafting' | 'evaluating' | 'completed';
  is_private: boolean;
  starting_budget: number;
  roster_size: number;
  bid_timer_seconds: number;
  current_round: number;
  current_nominator_slot: number;
  current_auction_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface GameParticipant {
  id: string;
  game_id: string;
  user_id: string;
  slot: number;
  display_name: string;
  budget: number;
  total_spent: number;
  characters_acquired: number;
  is_ready: boolean;
  is_connected: boolean;
  joined_at: string;
}

export interface Character {
  id: string;
  name: string;
  publisher: 'Marvel' | 'DC';
  universe: string;
  version_name: string;
  version_id: string;
  portrait_url: string | null;
  biography: string;
  abilities: string;
  notable_feats: string;
  limitations: string;
  sources: string;
  is_enabled: boolean;
  tier: 'street' | 'mid' | 'high' | 'cosmic' | 'reality';
  ability: number;
  regeneration: number;
  durability: number;
  stamina: number;
  speed: number;
  combat: number;
  battle_iq: number;
  intelligence: number;
  strength: number;
  striking_power: number;
  hax: number;
  created_at: string;
}

export interface Auction {
  id: string;
  game_id: string;
  round: number;
  nominator_slot: number;
  character_id: string;
  status: 'nominating' | 'bidding' | 'closed' | 'cancelled';
  high_bid: number;
  high_bidder_slot: number | null;
  high_bidder_id: string | null;
  started_at: string;
  closed_at: string | null;
  winning_bid: number | null;
  winner_slot: number | null;
  winner_id: string | null;
}

export interface Bid {
  id: string;
  auction_id: string;
  game_id: string;
  bidder_slot: number;
  bidder_id: string;
  amount: number;
  increment: number;
  is_pass: boolean;
  created_at: string;
}

export interface RosterItem {
  id: string;
  game_id: string;
  participant_id: string;
  character_id: string;
  purchase_price: number;
  auction_id: string | null;
  acquired_at: string;
  is_auto_filled: boolean;
}

export interface TeamEvaluation {
  id: string;
  game_id: string;
  participant_slot: number;
  ability: number;
  regeneration: number;
  durability: number;
  stamina: number;
  speed: number;
  combat: number;
  battle_iq: number;
  intelligence: number;
  strength: number;
  striking_power: number;
  hax: number;
  evaluation_type: 'deterministic' | 'ai';
  category_explanations: Record<string, string>;
  synergy_notes: string;
  created_at: string;
}

export interface MatchupEvaluation {
  id: string;
  game_id: string;
  slot_a: number;
  slot_b: number;
  win_probability_a: number;
  win_probability_b: number;
  advantages_a: string;
  advantages_b: string;
  critical_counters: string;
  battle_progression: string;
  win_conditions: string;
  evaluation_type: 'deterministic' | 'ai';
  created_at: string;
}

export interface GameResult {
  id: string;
  game_id: string;
  winner_slot: number;
  winner_assessment: string;
  battle_narrative: string;
  evaluation_type: 'deterministic' | 'ai';
  category_rankings: Array<{ slot: number; total_score: number; wins: number }>;
  created_at: string;
}

export const CATEGORIES = [
  'ability',
  'regeneration',
  'durability',
  'stamina',
  'speed',
  'combat',
  'battle_iq',
  'intelligence',
  'strength',
  'striking_power',
  'hax',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  ability: 'Ability',
  regeneration: 'Regeneration',
  durability: 'Durability',
  stamina: 'Stamina',
  speed: 'Speed',
  combat: 'Combat',
  battle_iq: 'Battle IQ',
  intelligence: 'Intelligence',
  strength: 'Strength',
  striking_power: 'Striking Power',
  hax: 'Hax',
};

export const SLOT_COLORS = [
  { name: 'Crimson', primary: '#dc2626', light: '#fee2e2', text: '#991b1b', bg: 'rgba(220,38,38,0.1)' },
  { name: 'Azure', primary: '#2563eb', light: '#dbeafe', text: '#1e40af', bg: 'rgba(37,99,235,0.1)' },
  { name: 'Emerald', primary: '#059669', light: '#d1fae5', text: '#065f46', bg: 'rgba(5,150,105,0.1)' },
];

export const TIER_COLORS: Record<string, string> = {
  street: '#64748b',
  mid: '#0891b2',
  high: '#7c3aed',
  cosmic: '#c026d3',
  reality: '#f59e0b',
};

export const PUBLISHER_COLORS: Record<string, string> = {
  Marvel: '#dc2626',
  DC: '#2563eb',
};
