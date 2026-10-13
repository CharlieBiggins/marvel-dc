import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import type { GameRoom } from '@/types';
import {
  Shield, Plus, LogOut, ArrowRight, Clock, Users, Lock, Globe, Search
} from 'lucide-react';

interface HomeProps {
  onJoinGame: (game: GameRoom) => void;
}

export function Home({ onJoinGame }: HomeProps) {
  const { profile, signOut } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [publicGames, setPublicGames] = useState<GameRoom[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPublicGames = useCallback(async () => {
    const { data } = await supabase
      .from('game_rooms')
      .select('*')
      .eq('status', 'lobby')
      .eq('is_private', false)
      .order('created_at', { ascending: false })
      .limit(10);
    if (data) setPublicGames(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPublicGames();
    const interval = setInterval(fetchPublicGames, 5000);
    return () => clearInterval(interval);
  }, [fetchPublicGames]);

  async function handleCreate(isPrivate: boolean) {
    const { data, error } = await supabase
      .from('game_rooms')
      .insert({
        created_by: profile?.id,
        is_private: isPrivate,
      })
      .select()
      .maybeSingle();

    if (error || !data) return;

    const { error: joinError } = await supabase.rpc('join_game', {
      p_game_id: data.id,
      p_display_name: profile?.display_name ?? 'Player',
    });

    if (joinError) return;
    onJoinGame(data);
  }

  async function handleJoinByCode() {
    setJoinError(null);
    if (joinCode.trim().length < 4) {
      setJoinError('Enter a valid room code');
      return;
    }

    const { data: room } = await supabase
      .from('game_rooms')
      .select('*')
      .eq('room_code', joinCode.trim().toUpperCase())
      .maybeSingle();

    if (!room) {
      setJoinError('Room not found');
      return;
    }

    if (room.status !== 'lobby') {
      setJoinError('Game has already started');
      return;
    }

    const { error } = await supabase.rpc('join_game', {
      p_game_id: room.id,
      p_display_name: profile?.display_name ?? 'Player',
    });

    if (error) {
      setJoinError(error.message);
      return;
    }

    onJoinGame(room);
  }

  async function handleJoinPublic(game: GameRoom) {
    const { error } = await supabase.rpc('join_game', {
      p_game_id: game.id,
      p_display_name: profile?.display_name ?? 'Player',
    });

    if (error) {
      setJoinError(error.message);
      return;
    }

    onJoinGame(game);
  }

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white relative overflow-hidden">
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-red-600 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-600 rounded-full blur-[150px]" />
      </div>

      <div className="relative z-10 max-w-5xl mx-auto p-4 sm:p-6">
        {/* Header */}
        <header className="flex items-center justify-between mb-8 pt-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-blue-600 flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight">Superhero Auction</h1>
              <p className="text-xs text-gray-400">Marvel vs. DC</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400 hidden sm:block">{profile?.display_name}</span>
            <button
              onClick={signOut}
              className="p-2 text-gray-400 hover:text-white transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Hero section */}
        <div className="text-center mb-10">
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
            Draft Your Dream Team
          </h2>
          <p className="text-gray-400 max-w-xl mx-auto">
            Compete in a live auction draft with $100. Bid on Marvel and DC characters,
            build synergistic teams, and let the battle engine decide the winner.
          </p>
        </div>

        {/* Action cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          {/* Create game */}
          <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-6">
            <h3 className="font-semibold mb-1 flex items-center gap-2">
              <Plus className="w-4 h-4 text-red-500" /> Create a Game
            </h3>
            <p className="text-sm text-gray-400 mb-4">Start a new draft and invite two friends.</p>

            {!showCreate ? (
              <button
                onClick={() => setShowCreate(true)}
                className="w-full py-2.5 bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500 rounded-xl font-medium text-sm transition-all"
              >
                Create New Game
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  onClick={() => handleCreate(false)}
                  className="w-full py-2.5 bg-[#0a0a0f] border border-gray-800 hover:border-blue-500 rounded-xl text-sm flex items-center justify-between px-4 transition-all"
                >
                  <span className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-green-400" /> Public Game
                  </span>
                  <ArrowRight className="w-4 h-4 text-gray-500" />
                </button>
                <button
                  onClick={() => handleCreate(true)}
                  className="w-full py-2.5 bg-[#0a0a0f] border border-gray-800 hover:border-purple-500 rounded-xl text-sm flex items-center justify-between px-4 transition-all"
                >
                  <span className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-purple-400" /> Private Game
                  </span>
                  <ArrowRight className="w-4 h-4 text-gray-500" />
                </button>
              </div>
            )}
          </div>

          {/* Join by code */}
          <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-6">
            <h3 className="font-semibold mb-1 flex items-center gap-2">
              <Search className="w-4 h-4 text-blue-500" /> Join by Code
            </h3>
            <p className="text-sm text-gray-400 mb-4">Enter a room code from a friend.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinByCode()}
                className="flex-1 bg-[#0a0a0f] border border-gray-800 rounded-xl px-4 py-2.5 text-sm font-mono tracking-wider focus:border-blue-500 focus:outline-none transition-colors uppercase"
                placeholder="ABC123"
                maxLength={8}
              />
              <button
                onClick={handleJoinByCode}
                className="px-4 py-2.5 bg-white text-black hover:bg-gray-200 rounded-xl font-medium text-sm transition-all"
              >
                Join
              </button>
            </div>
            {joinError && (
              <p className="text-xs text-red-400 mt-2">{joinError}</p>
            )}
          </div>
        </div>

        {/* Public games */}
        <div>
          <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
            <Users className="w-5 h-5" /> Open Games
          </h3>
          {loading ? (
            <div className="text-center py-8 text-gray-500 text-sm">Loading...</div>
          ) : publicGames.length === 0 ? (
            <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-8 text-center">
              <p className="text-gray-500 text-sm">No open games right now.</p>
              <p className="text-gray-600 text-xs mt-1">Create one and invite your friends!</p>
            </div>
          ) : (
            <div className="space-y-2">
              {publicGames.map((game) => {
                const age = Date.now() - new Date(game.created_at).getTime();
                const minsAgo = Math.floor(age / 60000);
                return (
                  <button
                    key={game.id}
                    onClick={() => handleJoinPublic(game)}
                    className="w-full bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-xl p-4 flex items-center justify-between transition-all group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600/30 to-blue-600/30 border border-gray-700 flex items-center justify-center">
                        <Globe className="w-4 h-4 text-gray-400" />
                      </div>
                      <div className="text-left">
                        <div className="font-medium text-sm">Room {game.room_code}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                          <Clock className="w-3 h-3" />
                          {minsAgo < 1 ? 'just now' : `${minsAgo}m ago`}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-gray-400 group-hover:text-white transition-colors">
                      <span>Join</span>
                      <ArrowRight className="w-4 h-4" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
