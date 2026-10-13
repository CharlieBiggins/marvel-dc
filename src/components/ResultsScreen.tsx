import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import type {
  GameRoom, GameParticipant, TeamEvaluation, MatchupEvaluation, GameResult,
  RosterItem, Character, Category,
} from '@/types';
import {
  SLOT_COLORS, TIER_COLORS, PUBLISHER_COLORS, CATEGORIES, CATEGORY_LABELS,
} from '@/types';
import {
  Trophy, Crown, Swords, Shield, Zap, Brain, Eye, Heart, Dumbbell, Sparkles,
  ArrowLeft, Copy, Check, RotateCcw, BarChart3, Table, TrendingUp,
  DollarSign, Star, AlertTriangle, Loader2, Target, Flame,
} from 'lucide-react';

interface ResultsScreenProps {
  game: GameRoom;
  onBack: () => void;
  onRematch: () => void;
}

export function ResultsScreen({ game, onBack, onRematch }: ResultsScreenProps) {
  const { user } = useAuth();
  const [participants, setParticipants] = useState<GameParticipant[]>([]);
  const [evaluations, setEvaluations] = useState<TeamEvaluation[]>([]);
  const [matchups, setMatchups] = useState<MatchupEvaluation[]>([]);
  const [result, setResult] = useState<GameResult | null>(null);
  const [rosters, setRosters] = useState<RosterItem[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [chartMode, setChartMode] = useState<'radar' | 'bar' | 'table'>('radar');
  const [selectedMatchup, setSelectedMatchup] = useState<[number, number] | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  const fetchAll = useCallback(async () => {
    const [partsRes, evalRes, matchRes, resultRes, rosterRes, charRes] = await Promise.all([
      supabase.from('game_participants').select('*').eq('game_id', game.id).order('slot'),
      supabase.from('team_evaluations').select('*').eq('game_id', game.id),
      supabase.from('matchup_evaluations').select('*').eq('game_id', game.id),
      supabase.from('game_results').select('*').eq('game_id', game.id).maybeSingle(),
      supabase.from('roster_items').select('*').eq('game_id', game.id).order('acquired_at'),
      supabase.from('characters').select('*'),
    ]);

    if (partsRes.data) setParticipants(partsRes.data);
    if (evalRes.data) setEvaluations(evalRes.data);
    if (matchRes.data) setMatchups(matchRes.data);
    if (resultRes.data) setResult(resultRes.data);
    if (rosterRes.data) setRosters(rosterRes.data);
    if (charRes.data) setCharacters(charRes.data);
    setLoading(false);
  }, [game.id]);

  useEffect(() => {
    fetchAll();

    const channel = supabase
      .channel(`results-${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_results', filter: `game_id=eq.${game.id}` },
        () => fetchAll()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_rooms', filter: `id=eq.${game.id}` },
        () => fetchAll()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [game.id, fetchAll]);

  async function handleRetry() {
    setRetrying(true);
    await supabase.rpc('retry_evaluation', { p_game_id: game.id });
    await fetchAll();
    setRetrying(false);
  }

  function copyResultsLink() {
    const url = `${window.location.origin}?room=${game.room_code}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] text-white flex flex-col items-center justify-center p-4">
        <AlertTriangle className="w-8 h-8 text-amber-500 mb-3" />
        <h2 className="text-xl font-bold mb-1">Evaluation Not Available</h2>
        <p className="text-gray-400 text-sm mb-4">The battle evaluation hasn't been generated yet.</p>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="px-4 py-2 bg-gradient-to-r from-red-600 to-blue-600 rounded-xl text-sm font-medium flex items-center gap-2"
        >
          {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          Retry Evaluation
        </button>
        <button onClick={onBack} className="mt-3 text-sm text-gray-400 hover:text-white">
          Back to Home
        </button>
      </div>
    );
  }

  const winner = participants.find((p) => p.slot === result.winner_slot);
  const winnerColor = winner ? SLOT_COLORS[winner.slot] : SLOT_COLORS[0];
  const winnerRoster = rosters.filter((r) => r.participant_id === winner?.id);

  // Find MVP (highest total stats) for winning team
  const mvp = winnerRoster
    .map((r) => characters.find((c) => c.id === r.character_id))
    .filter((c): c is Character => c !== undefined)
    .sort((a, b) => CATEGORIES.reduce((s, cat) => s + b[cat], 0) - CATEGORIES.reduce((s, cat) => s + a[cat], 0))[0] ?? null;

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white relative overflow-hidden">
      {/* Atmospheric background */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 rounded-full blur-[150px]" style={{ background: winnerColor.primary }} />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-blue-600 rounded-full blur-[150px]" />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto p-4 sm:p-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-6 pt-2">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Home
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={copyResultsLink}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-lg text-xs transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied!' : 'Share'}
            </button>
            <button
              onClick={onRematch}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500 rounded-lg text-xs font-medium transition-all"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Rematch
            </button>
          </div>
        </header>

        {/* Champion Reveal */}
        <div className="text-center mb-8 animate-in fade-in duration-1000">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-4 relative">
            <div className="absolute inset-0 rounded-2xl blur-xl opacity-50" style={{ background: winnerColor.primary }} />
            <div className="relative w-full h-full rounded-2xl flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${winnerColor.primary}, ${winnerColor.primary}80)` }}>
              <Trophy className="w-10 h-10 text-white" />
            </div>
          </div>
          <div className="text-sm text-gray-400 uppercase tracking-widest mb-1">Champion</div>
          <h1 className="text-4xl sm:text-5xl font-bold mb-2" style={{ color: winnerColor.primary }}>
            {winner?.display_name}
          </h1>
          {mvp && (
            <p className="text-gray-400 text-sm">
              Led by <span className="font-semibold text-white">{mvp.name}</span>
              {mvp.version_name !== 'Standard' && <span className="text-gray-500"> ({mvp.version_name})</span>}
            </p>
          )}
          <div className="inline-flex items-center gap-2 mt-3 px-4 py-1.5 bg-[#14141c] border border-gray-800 rounded-full text-xs">
            <span className="text-gray-500">Evaluation:</span>
            <span className={result.evaluation_type === 'ai' ? 'text-purple-400' : 'text-blue-400'}>
              {result.evaluation_type === 'ai' ? 'AI-Assisted' : 'Deterministic Baseline'}
            </span>
          </div>
        </div>

        {/* Winner Assessment */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
            <Crown className="w-4 h-4" style={{ color: winnerColor.primary }} /> Final Assessment
          </h3>
          <p className="text-sm text-gray-400 leading-relaxed">{result.winner_assessment}</p>
          <div className="mt-3 pt-3 border-t border-gray-800 grid grid-cols-3 gap-3 text-center">
            {result.category_rankings.map((rank) => {
              const p = participants.find((part) => part.slot === rank.slot);
              const c = p ? SLOT_COLORS[p.slot] : SLOT_COLORS[0];
              return (
                <div key={rank.slot}>
                  <div className="text-xs text-gray-500 mb-1">{p?.display_name ?? `Player ${rank.slot + 1}`}</div>
                  <div className="text-lg font-bold" style={{ color: c.primary }}>{rank.wins}W</div>
                  <div className="text-xs text-gray-500">{rank.total_score} pts</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart section */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" /> Team Comparison
            </h3>
            <div className="flex gap-1 p-1 bg-[#0a0a0f] rounded-lg">
              {(['radar', 'bar', 'table'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setChartMode(mode)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-all capitalize ${
                    chartMode === mode ? 'bg-white text-black' : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {chartMode === 'radar' && <RadarChart evaluations={evaluations} participants={participants} />}
          {chartMode === 'bar' && <BarChart evaluations={evaluations} participants={participants} />}
          {chartMode === 'table' && <ComparisonTable evaluations={evaluations} participants={participants} />}
        </div>

        {/* Head-to-head matchups */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-4 flex items-center gap-2">
            <Swords className="w-4 h-4" /> Head-to-Head Matchups
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {matchups.map((m) => {
              const pA = participants.find((p) => p.slot === m.slot_a);
              const pB = participants.find((p) => p.slot === m.slot_b);
              const cA = pA ? SLOT_COLORS[pA.slot] : SLOT_COLORS[0];
              const cB = pB ? SLOT_COLORS[pB.slot] : SLOT_COLORS[1];
              return (
                <button
                  key={m.id}
                  onClick={() => setSelectedMatchup([m.slot_a, m.slot_b])}
                  className="bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-xl p-4 text-left transition-all"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium" style={{ color: cA.primary }}>{pA?.display_name}</span>
                    <span className="text-xs text-gray-500">vs</span>
                    <span className="text-sm font-medium" style={{ color: cB.primary }}>{pB?.display_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <div className="text-xs text-gray-500 mb-0.5 text-right">{m.win_probability_a}%</div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${m.win_probability_a}%`, background: cA.primary }} />
                      </div>
                    </div>
                    <div className="text-xs font-bold text-gray-400 px-1">{100 - m.win_probability_a}%</div>
                    <div className="flex-1">
                      <div className="text-xs text-gray-500 mb-0.5">{m.win_probability_b}%</div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full rounded-full ml-auto" style={{ width: `${m.win_probability_b}%`, background: cB.primary }} />
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-gray-500 text-center">
                    Estimated win probability (simulation, not measurement)
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Character impact + Draft economics for each team */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {participants.map((p) => {
            const color = SLOT_COLORS[p.slot];
            const roster = rosters.filter((r) => r.participant_id === p.id);
            return (
              <TeamImpactCard
                key={p.id}
                participant={p}
                roster={roster}
                characters={characters}
                color={color}
                isWinner={p.slot === result.winner_slot}
              />
            );
          })}
        </div>

        {/* Battle Narrative */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-5 mb-6">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" /> Battle Narrative
          </h3>
          <p className="text-sm text-gray-400 leading-relaxed">{result.battle_narrative}</p>
          <div className="mt-3 pt-3 border-t border-gray-800">
            <p className="text-xs text-gray-500">
              This narrative is a deterministic baseline interpretation based on category scores and matchup analysis.
              It distinguishes plausible battle interpretation from established comic canon. Estimates are not
              scientifically measured combat probabilities.
            </p>
          </div>
        </div>

        {/* Retry button */}
        <div className="text-center mb-4">
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-xl text-xs text-gray-400 transition-colors"
          >
            {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Re-run Evaluation
          </button>
        </div>
      </div>

      {/* Matchup detail modal */}
      {selectedMatchup && (
        <MatchupDetailModal
          slotA={selectedMatchup[0]}
          slotB={selectedMatchup[1]}
          participants={participants}
          matchup={matchups.find((m) => m.slot_a === selectedMatchup[0] && m.slot_b === selectedMatchup[1])}
          onClose={() => setSelectedMatchup(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// RADAR CHART (SVG)
// ============================================================================
function RadarChart({ evaluations, participants }: { evaluations: TeamEvaluation[]; participants: GameParticipant[] }) {
  const size = 320;
  const center = size / 2;
  const radius = 120;
  const labels = CATEGORIES;

  function getPoint(angle: number, r: number) {
    return {
      x: center + r * Math.cos(angle - Math.PI / 2),
      y: center + r * Math.sin(angle - Math.PI / 2),
    };
  }

  const angleStep = (2 * Math.PI) / labels.length;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="max-w-full">
        {/* Grid circles */}
        {[0.2, 0.4, 0.6, 0.8, 1.0].map((scale) => (
          <circle
            key={scale}
            cx={center}
            cy={center}
            r={radius * scale}
            fill="none"
            stroke="#1f1f2a"
            strokeWidth={1}
          />
        ))}
        {/* Grid lines */}
        {labels.map((_, i) => {
          const pt = getPoint(i * angleStep, radius);
          return (
            <line
              key={i}
              x1={center}
              y1={center}
              x2={pt.x}
              y2={pt.y}
              stroke="#1f1f2a"
              strokeWidth={1}
            />
          );
        })}
        {/* Data polygons */}
        {evaluations.map((eval_) => {
          const p = participants.find((part) => part.slot === eval_.participant_slot);
          const color = p ? SLOT_COLORS[p.slot] : SLOT_COLORS[0];
          const points = labels.map((cat, i) => {
            const val = eval_[cat as Category] / 100;
            const pt = getPoint(i * angleStep, radius * val);
            return `${pt.x},${pt.y}`;
          }).join(' ');
          return (
            <polygon
              key={eval_.id}
              points={points}
              fill={color.primary + '20'}
              stroke={color.primary}
              strokeWidth={2}
            />
          );
        })}
        {/* Labels */}
        {labels.map((cat, i) => {
          const pt = getPoint(i * angleStep, radius + 20);
          return (
            <text
              key={cat}
              x={pt.x}
              y={pt.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-gray-500"
              style={{ fontSize: '9px' }}
            >
              {CATEGORY_LABELS[cat]}
            </text>
          );
        })}
      </svg>
      {/* Legend */}
      <div className="flex gap-4 mt-2">
        {evaluations.map((eval_) => {
          const p = participants.find((part) => part.slot === eval_.participant_slot);
          const color = p ? SLOT_COLORS[p.slot] : SLOT_COLORS[0];
          return (
            <div key={eval_.id} className="flex items-center gap-1.5 text-xs">
              <div className="w-3 h-3 rounded" style={{ background: color.primary }} />
              <span>{p?.display_name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// BAR CHART
// ============================================================================
function BarChart({ evaluations, participants }: { evaluations: TeamEvaluation[]; participants: GameParticipant[] }) {
  return (
    <div className="space-y-2">
      {CATEGORIES.map((cat) => (
        <div key={cat} className="flex items-center gap-3">
          <div className="w-24 text-xs text-gray-400 text-right shrink-0">{CATEGORY_LABELS[cat]}</div>
          <div className="flex-1 flex gap-1">
            {evaluations.map((eval_) => {
              const p = participants.find((part) => part.slot === eval_.participant_slot);
              const color = p ? SLOT_COLORS[p.slot] : SLOT_COLORS[0];
              const val = eval_[cat as Category];
              return (
                <div key={eval_.id} className="flex-1">
                  <div className="h-5 bg-[#0a0a0f] rounded overflow-hidden">
                    <div
                      className="h-full rounded transition-all"
                      style={{ width: `${val}%`, background: color.primary }}
                    />
                  </div>
                  <div className="text-[10px] text-gray-500 text-center mt-0.5">{val}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// COMPARISON TABLE
// ============================================================================
function ComparisonTable({ evaluations, participants }: { evaluations: TeamEvaluation[]; participants: GameParticipant[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 px-2 text-xs text-gray-500 font-medium">Category</th>
            {participants.map((p) => {
              const color = SLOT_COLORS[p.slot];
              return (
                <th key={p.id} className="text-center py-2 px-2 text-xs font-medium" style={{ color: color.primary }}>
                  {p.display_name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map((cat) => {
            const values = evaluations.map((e) => e[cat as Category]);
            const maxVal = Math.max(...values);
            return (
              <tr key={cat} className="border-b border-gray-800/50">
                <td className="py-2 px-2 text-xs text-gray-400">{CATEGORY_LABELS[cat]}</td>
                {evaluations.map((eval_) => {
                  const val = eval_[cat as Category];
                  const isMax = val === maxVal;
                  return (
                    <td key={eval_.id} className={`text-center py-2 px-2 text-sm tabular-nums ${isMax ? 'font-bold text-white' : 'text-gray-400'}`}>
                      {val}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          <tr className="border-t-2 border-gray-700">
            <td className="py-2 px-2 text-xs font-semibold text-gray-300">Total</td>
            {evaluations.map((eval_) => {
              const total = CATEGORIES.reduce((sum, cat) => sum + eval_[cat as Category], 0);
              return (
                <td key={eval_.id} className="text-center py-2 px-2 text-sm font-bold tabular-nums text-white">
                  {total}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ============================================================================
// TEAM IMPACT CARD
// ============================================================================
function TeamImpactCard({
  participant, roster, characters, color, isWinner,
}: {
  participant: GameParticipant;
  roster: RosterItem[];
  characters: Character[];
  color: typeof SLOT_COLORS[0];
  isWinner: boolean;
}) {
  const totalSpent = roster.reduce((s, r) => s + r.purchase_price, 0);
  const avgCost = roster.length > 0 ? Math.round(totalSpent / roster.length) : 0;
  const maxItem = roster.reduce((max, r) => (r.purchase_price > max.purchase_price ? r : max), roster[0]);
  const maxChar = maxItem ? characters.find((c) => c.id === maxItem.character_id) : null;

  // MVP: highest total stats
  let mvpChar: Character | null = null;
  let mvpScore = 0;
  roster.forEach((r) => {
    const char = characters.find((c) => c.id === r.character_id);
    if (char) {
      const total = CATEGORIES.reduce((sum, cat) => sum + char![cat], 0);
      if (total > mvpScore) { mvpScore = total; mvpChar = char; }
    }
  });

  // Best bargain: best stats per dollar
  let bargainChar: Character | null = null;
  let bargainRatio = 0;
  roster.forEach((r) => {
    const char = characters.find((c) => c.id === r.character_id);
    if (char && r.purchase_price > 0) {
      const total = CATEGORIES.reduce((sum, cat) => sum + char![cat], 0);
      const ratio = total / r.purchase_price;
      if (ratio > bargainRatio) { bargainRatio = ratio; bargainChar = char; }
    }
  });

  return (
    <div className={`bg-[#14141c] border rounded-2xl p-4 ${isWinner ? 'ring-1' : ''}`} style={{ borderColor: isWinner ? color.primary + '60' : '#1f1f2a' }}>
      {isWinner && (
        <div className="flex items-center gap-1 text-xs mb-2" style={{ color: color.primary }}>
          <Crown className="w-3 h-3" /> Winner
        </div>
      )}
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs" style={{ background: color.primary + '20', color: color.primary }}>
          {participant.slot + 1}
        </div>
        <span className="font-semibold text-sm">{participant.display_name}</span>
      </div>

      {/* Economics */}
      <div className="grid grid-cols-2 gap-2 mb-3 text-xs">
        <div>
          <div className="text-gray-500">Spent</div>
          <div className="font-semibold">${totalSpent}</div>
        </div>
        <div>
          <div className="text-gray-500">Remaining</div>
          <div className="font-semibold">${participant.budget}</div>
        </div>
        <div>
          <div className="text-gray-500">Avg Price</div>
          <div className="font-semibold">${avgCost}</div>
        </div>
        <div>
          <div className="text-gray-500">Picks</div>
          <div className="font-semibold">{roster.length}</div>
        </div>
      </div>

      {/* Impact designations */}
      <div className="space-y-1.5 text-xs">
        {mvpChar && (
          <div className="flex items-center gap-2 py-1.5 px-2 bg-[#0a0a0f] rounded-lg">
            <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-gray-500">MVP:</span>
            <span className="font-medium truncate">{mvpChar.name}</span>
          </div>
        )}
        {bargainChar && (
          <div className="flex items-center gap-2 py-1.5 px-2 bg-[#0a0a0f] rounded-lg">
            <TrendingUp className="w-3.5 h-3.5 text-green-400 shrink-0" />
            <span className="text-gray-500">Bargain:</span>
            <span className="font-medium truncate">{bargainChar.name}</span>
          </div>
        )}
        {maxChar && maxItem && (
          <div className="flex items-center gap-2 py-1.5 px-2 bg-[#0a0a0f] rounded-lg">
            <DollarSign className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span className="text-gray-500">Priciest:</span>
            <span className="font-medium truncate">{maxChar.name}</span>
            <span className="ml-auto font-bold" style={{ color: color.primary }}>${maxItem.purchase_price}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MATCHUP DETAIL MODAL
// ============================================================================
function MatchupDetailModal({
  slotA, slotB, participants, matchup, onClose,
}: {
  slotA: number;
  slotB: number;
  participants: GameParticipant[];
  matchup?: MatchupEvaluation;
  onClose: () => void;
}) {
  if (!matchup) return null;
  const pA = participants.find((p) => p.slot === slotA);
  const pB = participants.find((p) => p.slot === slotB);
  const cA = pA ? SLOT_COLORS[pA.slot] : SLOT_COLORS[0];
  const cB = pB ? SLOT_COLORS[pB.slot] : SLOT_COLORS[1];

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#14141c] border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-[#14141c] border-b border-gray-800 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-lg" style={{ color: cA.primary }}>{pA?.display_name}</span>
            <span className="text-gray-500 text-sm">vs</span>
            <span className="font-bold text-lg" style={{ color: cB.primary }}>{pB?.display_name}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="p-4 space-y-4">
          {/* Win probability */}
          <div className="bg-[#0a0a0f] rounded-xl p-4">
            <div className="text-xs text-gray-500 mb-2 text-center">Estimated Win Probability</div>
            <div className="flex items-center gap-3">
              <div className="text-2xl font-bold" style={{ color: cA.primary }}>{matchup.win_probability_a}%</div>
              <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden flex">
                <div className="h-full" style={{ width: `${matchup.win_probability_a}%`, background: cA.primary }} />
                <div className="h-full" style={{ width: `${matchup.win_probability_b}%`, background: cB.primary }} />
              </div>
              <div className="text-2xl font-bold" style={{ color: cB.primary }}>{matchup.win_probability_b}%</div>
            </div>
            <div className="text-xs text-gray-500 text-center mt-2">
              Simulated estimate based on category scores — not an objectively measured probability
            </div>
          </div>

          {/* Advantages */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#0a0a0f] rounded-xl p-3">
              <div className="text-xs font-semibold mb-1" style={{ color: cA.primary }}>{pA?.display_name} Advantages</div>
              <p className="text-xs text-gray-400">{matchup.advantages_a}</p>
            </div>
            <div className="bg-[#0a0a0f] rounded-xl p-3">
              <div className="text-xs font-semibold mb-1" style={{ color: cB.primary }}>{pB?.display_name} Advantages</div>
              <p className="text-xs text-gray-400">{matchup.advantages_b}</p>
            </div>
          </div>

          {/* Critical counters */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" /> Critical Counters
            </h4>
            <p className="text-xs text-gray-400">{matchup.critical_counters}</p>
          </div>

          {/* Battle progression */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-1.5">
              <Flame className="w-3.5 h-3.5" /> Battle Progression
            </h4>
            <p className="text-xs text-gray-400">{matchup.battle_progression}</p>
          </div>

          {/* Win conditions */}
          <div>
            <h4 className="text-xs font-semibold text-gray-300 mb-1 flex items-center gap-1.5">
              <Swords className="w-3.5 h-3.5" /> Win Conditions
            </h4>
            <p className="text-xs text-gray-400">{matchup.win_conditions}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
