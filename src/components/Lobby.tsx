import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import type { GameRoom, GameParticipant } from '@/types';
import { SLOT_COLORS } from '@/types';
import {
  Shield, Copy, Check, Users, Circle, Play, ArrowLeft, Lock, Globe, Settings, Clock
} from 'lucide-react';

interface LobbyProps {
  game: GameRoom;
  onBack: () => void;
  onGameStart: () => void;
}

export function Lobby({ game, onBack, onGameStart }: LobbyProps) {
  const { user, profile } = useAuth();
  const [participants, setParticipants] = useState<GameParticipant[]>([]);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchParticipants = useCallback(async () => {
    const { data } = await supabase
      .from('game_participants')
      .select('*')
      .eq('game_id', game.id)
      .order('slot');
    if (data) setParticipants(data);
  }, [game.id]);

  useEffect(() => {
    fetchParticipants();

    const channel = supabase
      .channel(`lobby-${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_participants', filter: `game_id=eq.${game.id}` },
        () => fetchParticipants()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_rooms', filter: `id=eq.${game.id}` },
        (payload) => {
          if (payload.new && (payload.new as GameRoom).status === 'drafting') {
            onGameStart();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [game.id, fetchParticipants, onGameStart]);

  async function handleReady() {
    setError(null);
    const { error: err } = await supabase.rpc('toggle_ready', { p_game_id: game.id });
    if (err) setError(err.message);
  }

  async function handleStart() {
    setError(null);
    setStarting(true);
    const { error: err } = await supabase.rpc('start_draft', { p_game_id: game.id });
    if (err) setError(err.message);
    setStarting(false);
  }

  function copyInviteLink() {
    const url = `${window.location.origin}?room=${game.room_code}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const isHost = game.created_by === user?.id;
  const myParticipant = participants.find((p) => p.user_id === user?.id);
  const allReady = participants.length === 3 && participants.every((p) => p.is_ready);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-0 left-1/3 w-96 h-96 bg-red-600 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/3 w-96 h-96 bg-blue-600 rounded-full blur-[150px]" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto p-4 sm:p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Lobby
          </button>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-red-500" />
            <span className="font-bold">Superhero Auction</span>
          </div>
        </div>

        {/* Room info */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-6 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-2xl font-bold">Game Room</h2>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium flex items-center gap-1 ${
                  game.is_private ? 'bg-purple-950/50 text-purple-300 border border-purple-800' : 'bg-green-950/50 text-green-300 border border-green-800'
                }`}>
                  {game.is_private ? <Lock className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                  {game.is_private ? 'Private' : 'Public'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <span>Room Code:</span>
                <code className="px-3 py-1 bg-[#0a0a0f] border border-gray-800 rounded-lg font-mono text-white text-base tracking-wider">
                  {game.room_code}
                </code>
                <button
                  onClick={copyInviteLink}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-lg text-xs transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied!' : 'Copy Invite'}
                </button>
              </div>
            </div>
            <div className="flex gap-3 text-sm">
              <div className="text-center">
                <div className="flex items-center justify-center w-10 h-10 bg-[#0a0a0f] border border-gray-800 rounded-xl mb-1">
                  <span className="font-bold text-base">${game.starting_budget}</span>
                </div>
                <span className="text-gray-500 text-xs">Budget</span>
              </div>
              <div className="text-center">
                <div className="flex items-center justify-center w-10 h-10 bg-[#0a0a0f] border border-gray-800 rounded-xl mb-1">
                  <span className="font-bold text-base">{game.roster_size}</span>
                </div>
                <span className="text-gray-500 text-xs">Roster</span>
              </div>
              <div className="text-center">
                <div className="flex items-center justify-center w-10 h-10 bg-[#0a0a0f] border border-gray-800 rounded-xl mb-1">
                  <Clock className="w-5 h-5 text-gray-400" />
                </div>
                <span className="text-gray-500 text-xs">{game.bid_timer_seconds}s</span>
              </div>
            </div>
          </div>
        </div>

        {/* Player slots */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Users className="w-5 h-5" /> Players
            </h3>
            <span className="text-sm text-gray-400">{participants.length}/3 joined</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[0, 1, 2].map((slot) => {
              const p = participants.find((part) => part.slot === slot);
              const color = SLOT_COLORS[slot];
              return (
                <div
                  key={slot}
                  className="bg-[#14141c] border rounded-2xl p-4 transition-all"
                  style={{ borderColor: p ? color.primary + '40' : '#1f1f2a' }}
                >
                  {p ? (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm"
                            style={{ background: color.primary + '20', color: color.primary }}
                          >
                            {slot + 1}
                          </div>
                          <div>
                            <div className="font-semibold text-sm">{p.display_name}</div>
                            <div className="flex items-center gap-1 text-xs">
                              <Circle
                                className={`w-2 h-2 ${p.is_connected ? 'fill-green-400 text-green-400' : 'fill-gray-600 text-gray-600'}`}
                              />
                              <span className={p.is_connected ? 'text-green-400' : 'text-gray-500'}>
                                {p.is_connected ? 'Online' : 'Offline'}
                              </span>
                            </div>
                          </div>
                        </div>
                        {p.is_ready && (
                          <span className="text-xs px-2 py-0.5 bg-green-950/50 text-green-400 border border-green-800 rounded-full font-medium">
                            Ready
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">
                        Starting budget: <span className="text-gray-300 font-medium">${game.starting_budget}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-6 text-gray-600">
                      <div
                        className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm mb-2 border border-dashed"
                        style={{ borderColor: color.primary + '30', color: color.primary + '60' }}
                      >
                        {slot + 1}
                      </div>
                      <span className="text-xs">Waiting for player...</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rules summary */}
        <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-5 mb-6">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3 text-gray-300">
            <Settings className="w-4 h-4" /> Draft Rules
          </h3>
          <div className="grid grid-cols-2 gap-2 text-xs text-gray-400">
            <div>• 3 players compete</div>
            <div>• ${game.starting_budget} starting budget</div>
            <div>• {game.roster_size} characters per team</div>
            <div>• {game.roster_size * 3} total draft picks</div>
            <div>• Bid increments: $1, $5, $25</div>
            <div>• {game.bid_timer_seconds}s bid timer</div>
            <div>• Rotating nomination order</div>
            <div>• Must reserve budget for all slots</div>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="text-sm text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-4 py-2.5 mb-4">
            {error}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          {myParticipant && (
            <button
              onClick={handleReady}
              className={`flex-1 py-3 rounded-xl font-semibold transition-all ${
                myParticipant.is_ready
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-[#14141c] border border-gray-800 hover:border-gray-600 text-white'
              }`}
            >
              {myParticipant.is_ready ? 'Ready!' : 'Ready Up'}
            </button>
          )}
          {isHost && (
            <button
              onClick={handleStart}
              disabled={!allReady || starting}
              className="flex-1 py-3 rounded-xl font-semibold bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all flex items-center justify-center gap-2"
            >
              <Play className="w-4 h-4" />
              {starting ? 'Starting...' : 'Start Draft'}
            </button>
          )}
        </div>
        {!allReady && isHost && (
          <p className="text-center text-xs text-gray-500 mt-3">
            All 3 players must be ready to start the draft
          </p>
        )}
      </div>
    </div>
  );
}
