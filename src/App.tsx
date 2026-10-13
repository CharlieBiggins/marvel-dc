import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { AuthScreen } from '@/components/AuthScreen';
import { Home } from '@/components/Home';
import { Lobby } from '@/components/Lobby';
import { DraftRoom } from '@/components/DraftRoom';
import { ResultsScreen } from '@/components/ResultsScreen';
import { supabase } from '@/lib/supabase';
import type { GameRoom } from '@/types';
import { Loader2 } from 'lucide-react';

type View = 'home' | 'lobby' | 'draft' | 'results';

function AppContent() {
  const { session, loading } = useAuth();
  const [view, setView] = useState<View>('home');
  const [currentGame, setCurrentGame] = useState<GameRoom | null>(null);

  // Check URL for room code on load
  useEffect(() => {
    if (!session) return;
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    if (roomCode) {
      supabase
        .from('game_rooms')
        .select('*')
        .eq('room_code', roomCode.toUpperCase())
        .maybeSingle()
        .then(({ data }) => {
          if (data) {
            setCurrentGame(data);
            setView(data.status === 'lobby' ? 'lobby' : data.status === 'drafting' ? 'draft' : 'results');
          }
        });
    }
  }, [session]);

  // Restore active game from DB on login
  useEffect(() => {
    if (!session || currentGame) return;
    supabase
      .from('game_participants')
      .select('game_id, game_rooms!inner(*)')
      .eq('user_id', session.user.id)
      .in('game_rooms.status', ['lobby', 'drafting', 'evaluating'])
      .order('joined_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const room = (data as { game_rooms: GameRoom }).game_rooms;
          setCurrentGame(room);
          setView(room.status === 'lobby' ? 'lobby' : room.status === 'drafting' ? 'draft' : 'results');
        }
      });
  }, [session, currentGame]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0f] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (!session) {
    return <AuthScreen />;
  }

  function handleJoinGame(game: GameRoom) {
    setCurrentGame(game);
    setView('lobby');
  }

  function handleGameStart() {
    if (!currentGame) return;
    setView('draft');
  }

  function handleGameComplete() {
    if (!currentGame) return;
    // Fetch fresh room data
    supabase
      .from('game_rooms')
      .select('*')
      .eq('id', currentGame.id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setCurrentGame(data);
        setView('results');
      });
  }

  function handleBackToHome() {
    setCurrentGame(null);
    setView('home');
    // Clear URL param
    if (window.location.search) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  function handleRematch() {
    // Create a new game with same settings
    if (!currentGame) return;
    supabase
      .from('game_rooms')
      .insert({
        created_by: session?.user.id,
        is_private: currentGame.is_private,
        starting_budget: currentGame.starting_budget,
        roster_size: currentGame.roster_size,
        bid_timer_seconds: currentGame.bid_timer_seconds,
      })
      .select()
      .maybeSingle()
      .then(({ data, error }) => {
        if (error || !data) return;
        const profileName = session?.user.email?.split('@')[0] ?? 'Player';
        supabase.rpc('join_game', { p_game_id: data.id, p_display_name: profileName }).then(() => {
          setCurrentGame(data);
          setView('lobby');
        });
      });
  }

  if (view === 'home' || !currentGame) {
    return <Home onJoinGame={handleJoinGame} />;
  }

  if (view === 'lobby') {
    return <Lobby game={currentGame} onBack={handleBackToHome} onGameStart={handleGameStart} />;
  }

  if (view === 'draft') {
    return <DraftRoom game={currentGame} onGameComplete={handleGameComplete} />;
  }

  if (view === 'results') {
    return (
      <ResultsScreen
        game={currentGame}
        onBack={handleBackToHome}
        onRematch={handleRematch}
      />
    );
  }

  return <Home onJoinGame={handleJoinGame} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
