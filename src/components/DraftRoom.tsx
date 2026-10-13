import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import type {
  GameRoom, GameParticipant, Character, Auction, Bid, RosterItem,
} from '@/types';
import { SLOT_COLORS, TIER_COLORS, PUBLISHER_COLORS, CATEGORIES, CATEGORY_LABELS } from '@/types';
import {
  Search, X, Check, Gavel, Clock, Users, Loader2, AlertCircle,
  TrendingUp, DollarSign, ArrowRight, RefreshCw, Info, ChevronDown,
} from 'lucide-react';

interface DraftRoomProps {
  game: GameRoom;
  onGameComplete: () => void;
}

export function DraftRoom({ game, onGameComplete }: DraftRoomProps) {
  const { user } = useAuth();
  const [participants, setParticipants] = useState<GameParticipant[]>([]);
  const [currentAuction, setCurrentAuction] = useState<Auction | null>(null);
  const [currentCharacter, setCurrentCharacter] = useState<Character | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [rosters, setRosters] = useState<RosterItem[]>([]);
  const [allCharacters, setAllCharacters] = useState<Character[]>([]);
  const [draftedIds, setDraftedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [showCharPool, setShowCharPool] = useState(false);
  const [showCharDetail, setShowCharDetail] = useState<Character | null>(null);
  const [showRoster, setShowRoster] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(game.bid_timer_seconds);
  const [room, setRoom] = useState(game);
  const bidTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastBidTimeRef = useRef<number>(0);

  const mySlot = participants.find((p) => p.user_id === user?.id)?.slot ?? null;
  const isMyTurnToNominate = mySlot === room.current_nominator_slot && room.status === 'drafting';
  const activeBidders = 3 - new Set(bids.filter((b) => b.is_pass).map((b) => b.bidder_slot)).size;

  const fetchAll = useCallback(async () => {
    const [partsRes, auctionRes, bidsRes, rostersRes, charsRes] = await Promise.all([
      supabase.from('game_participants').select('*').eq('game_id', game.id).order('slot'),
      supabase.from('auctions').select('*').eq('game_id', game.id).order('round', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('bids').select('*').eq('game_id', game.id).order('created_at', { ascending: true }),
      supabase.from('roster_items').select('*').eq('game_id', game.id).order('acquired_at'),
      supabase.from('characters').select('*').eq('is_enabled', true).order('name'),
    ]);

    if (partsRes.data) setParticipants(partsRes.data);
    if (auctionRes.data) {
      setCurrentAuction(auctionRes.data);
      if (auctionRes.data.character_id) {
        const char = charsRes.data?.find((c) => c.id === auctionRes.data.character_id);
        setCurrentCharacter(char ?? null);
      }
      if (auctionRes.data.status === 'bidding') {
        lastBidTimeRef.current = Date.now();
        setTimeLeft(game.bid_timer_seconds);
      }
    } else {
      setCurrentAuction(null);
      setCurrentCharacter(null);
    }
    if (bidsRes.data) {
      setBids(bidsRes.data.filter((b) => b.auction_id === auctionRes.data?.id));
    }
    if (rostersRes.data) setRosters(rostersRes.data);
    if (charsRes.data) setAllCharacters(charsRes.data);
  }, [game.id, game.bid_timer_seconds]);

  const fetchRoom = useCallback(async () => {
    const { data } = await supabase.from('game_rooms').select('*').eq('id', game.id).maybeSingle();
    if (data) {
      setRoom(data);
      if (data.status === 'evaluating' || data.status === 'completed') {
        onGameComplete();
      }
    }
  }, [game.id, onGameComplete]);

  useEffect(() => {
    fetchAll();
    fetchRoom();

    const channel = supabase
      .channel(`draft-${game.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_participants', filter: `game_id=eq.${game.id}` },
        () => {
          supabase.from('game_participants').select('*').eq('game_id', game.id).order('slot')
            .then(({ data }) => data && setParticipants(data));
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'auctions', filter: `game_id=eq.${game.id}` },
        () => fetchAll()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bids', filter: `game_id=eq.${game.id}` },
        () => {
          supabase.from('bids').select('*').eq('game_id', game.id).order('created_at')
            .then(({ data }) => {
              if (data && currentAuction) {
                setBids(data.filter((b) => b.auction_id === currentAuction.id));
                lastBidTimeRef.current = Date.now();
                setTimeLeft(game.bid_timer_seconds);
              }
            });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'roster_items', filter: `game_id=eq.${game.id}` },
        () => {
          supabase.from('roster_items').select('*').eq('game_id', game.id).order('acquired_at')
            .then(({ data }) => data && setRosters(data));
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'game_rooms', filter: `id=eq.${game.id}` },
        () => fetchRoom()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (bidTimerRef.current) clearInterval(bidTimerRef.current);
    };
  }, [game.id, fetchAll, fetchRoom, currentAuction, game.bid_timer_seconds]);

  // Update drafted IDs
  useEffect(() => {
    const ids = new Set<string>();
    rosters.forEach((r) => ids.add(r.character_id));
    if (currentAuction) ids.add(currentAuction.character_id);
    setDraftedIds(ids);
  }, [rosters, currentAuction]);

  // Bid timer
  useEffect(() => {
    if (currentAuction?.status === 'bidding') {
      if (bidTimerRef.current) clearInterval(bidTimerRef.current);
      bidTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - lastBidTimeRef.current) / 1000);
        const remaining = game.bid_timer_seconds - elapsed;
        setTimeLeft(remaining);

        if (remaining <= 0) {
          clearInterval(bidTimerRef.current!);
          // Auto-close auction
          supabase.rpc('close_auction', {
            p_game_id: game.id,
            p_auction_id: currentAuction.id,
          }).then(() => fetchAll());
        }
      }, 1000);
    } else {
      if (bidTimerRef.current) clearInterval(bidTimerRef.current);
    }

    return () => {
      if (bidTimerRef.current) clearInterval(bidTimerRef.current);
    };
  }, [currentAuction?.id, currentAuction?.status, game.id, game.bid_timer_seconds, fetchAll]);

  async function handleNominate(charId: string) {
    setError(null);
    setActionLoading(true);
    const { error: err } = await supabase.rpc('nominate_character', {
      p_game_id: game.id,
      p_character_id: charId,
    });
    if (err) setError(err.message);
    setActionLoading(false);
  }

  async function handleBid(increment: number) {
    if (!currentAuction) return;
    setError(null);
    setActionLoading(true);
    const { error: err } = await supabase.rpc('place_bid', {
      p_game_id: game.id,
      p_auction_id: currentAuction.id,
      p_increment: increment,
    });
    if (err) setError(err.message);
    setActionLoading(false);
  }

  async function handlePass() {
    if (!currentAuction) return;
    setError(null);
    setActionLoading(true);
    const { error: err } = await supabase.rpc('pass_auction', {
      p_game_id: game.id,
      p_auction_id: currentAuction.id,
    });
    if (err) setError(err.message);
    setActionLoading(false);
  }

  async function handleAutoFill() {
    setError(null);
    setActionLoading(true);
    const { error: err } = await supabase.rpc('auto_fill_rosters', { p_game_id: game.id });
    if (err) setError(err.message);
    setActionLoading(false);
  }

  const availableCharacters = allCharacters.filter((c) => !draftedIds.has(c.id));
  const filteredCharacters = availableCharacters.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return c.name.toLowerCase().includes(q) ||
      c.publisher.toLowerCase().includes(q) ||
      c.version_name.toLowerCase().includes(q) ||
      c.tier.toLowerCase().includes(q);
  });

  const totalAcquired = participants.reduce((sum, p) => sum + p.characters_acquired, 0);
  const targetTotal = room.roster_size * 3;

  const myParticipant = participants.find((p) => p.user_id === user?.id);
  const amHighestBidder = currentAuction?.high_bidder_slot === mySlot;
  const haveIPassed = bids.some((b) => b.bidder_slot === mySlot && b.is_pass);
  const canBid = currentAuction?.status === 'bidding' && !amHighestBidder && !haveIPassed;

  // Calculate if player can afford bid with reserve
  const slotsRemaining = myParticipant ? room.roster_size - myParticipant.characters_acquired : 0;
  const minReserve = Math.max(slotsRemaining - 1, 0);
  const myBudget = myParticipant?.budget ?? 0;

  function canAffordBid(increment: number): boolean {
    if (!currentAuction) return false;
    const newBid = currentAuction.high_bid + increment;
    return newBid + minReserve <= myBudget;
  }

  const isAuctionActive = currentAuction?.status === 'bidding';
  const nominator = participants.find((p) => p.slot === room.current_nominator_slot);
  const highBidder = participants.find((p) => p.slot === currentAuction?.high_bidder_slot);

  // Recent auction results
  const recentRosters = [...rosters].sort((a, b) =>
    new Date(b.acquired_at).getTime() - new Date(a.acquired_at).getTime()
  ).slice(0, 5);

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Top bar */}
      <header className="border-b border-gray-800 bg-[#0d0d14] sticky top-0 z-40">
        <div className="max-w-[1600px] mx-auto px-4 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Gavel className="w-5 h-5 text-red-500" />
              <span className="font-bold text-sm hidden sm:block">Superhero Auction</span>
            </div>
            <div className="h-5 w-px bg-gray-800 hidden sm:block" />
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-400">Round</span>
              <span className="font-bold text-base">{room.current_round}<span className="text-gray-500 text-xs">/{room.roster_size * 3}</span></span>
              <span className="text-gray-500 text-xs hidden sm:block">({totalAcquired}/{targetTotal} picks)</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <code className="px-2.5 py-1 bg-[#14141c] border border-gray-800 rounded-lg font-mono text-xs text-gray-400">
              {room.room_code}
            </code>
            <button
              onClick={() => setShowCharPool(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-lg text-xs transition-colors"
            >
              <Search className="w-3.5 h-3.5" /> Pool ({availableCharacters.length})
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto p-4 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        {/* Main column */}
        <div className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-4 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-300">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Nomination or Auction panel */}
          {!isAuctionActive && room.status === 'drafting' && (
            <NominationPanel
              isMyTurn={isMyTurnToNominate}
              nominatorName={nominator?.display_name ?? '???'}
              onNominate={handleNominate}
              characters={availableCharacters}
              loading={actionLoading}
              onShowDetail={(c) => setShowCharDetail(c)}
              onOpenPool={() => setShowCharPool(true)}
            />
          )}

          {isAuctionActive && currentCharacter && (
            <AuctionPanel
              character={currentCharacter}
              auction={currentAuction}
              highBidderName={highBidder?.display_name}
              timeLeft={timeLeft}
              maxTime={game.bid_timer_seconds}
              amHighestBidder={amHighestBidder}
              haveIPassed={haveIPassed}
              canBid={canBid}
              canAffordBid={canAffordBid}
              myBudget={myBudget}
              minReserve={minReserve}
              onBid={handleBid}
              onPass={handlePass}
              loading={actionLoading}
              activeBidders={activeBidders}
              onShowDetail={() => setShowCharDetail(currentCharacter)}
            />
          )}

          {room.status === 'evaluating' && (
            <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-12 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500 mx-auto mb-3" />
              <h2 className="text-xl font-bold mb-1">Evaluating Teams</h2>
              <p className="text-gray-400 text-sm">Running battle analysis on all three teams...</p>
            </div>
          )}

          {/* Recent results */}
          {recentRosters.length > 0 && (
            <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Recent Acquisitions</h3>
              <div className="space-y-2">
                {recentRosters.map((r) => {
                  const char = allCharacters.find((c) => c.id === r.character_id);
                  const buyer = participants.find((p) => p.id === r.participant_id);
                  const color = buyer ? SLOT_COLORS[buyer.slot] : SLOT_COLORS[0];
                  return (
                    <div key={r.id} className="flex items-center gap-3 text-sm">
                      <div className="w-1 h-8 rounded-full" style={{ background: color.primary }} />
                      <div className="flex-1">
                        <span className="font-medium">{char?.name}</span>
                        {char && char.version_name !== 'Standard' && (
                          <span className="text-gray-500 text-xs ml-1">({char.version_name})</span>
                        )}
                      </div>
                      <span className="text-xs text-gray-400">{buyer?.display_name}</span>
                      <span className="font-bold text-sm tabular-nums" style={{ color: color.primary }}>
                        ${r.purchase_price}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Player status cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {participants.map((p) => {
              const color = SLOT_COLORS[p.slot];
              const roster = rosters.filter((r) => r.participant_id === p.id);
              const slotsLeft = room.roster_size - p.characters_acquired;
              return (
                <div
                  key={p.id}
                  className="bg-[#14141c] border rounded-2xl p-4 cursor-pointer hover:border-gray-600 transition-all"
                  style={{ borderColor: p.slot === mySlot ? color.primary + '60' : '#1f1f2a' }}
                  onClick={() => setShowRoster(p.slot)}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs"
                        style={{ background: color.primary + '20', color: color.primary }}
                      >
                        {p.slot + 1}
                      </div>
                      <span className="font-semibold text-sm">{p.display_name}</span>
                      {p.slot === mySlot && <span className="text-xs text-gray-500">(You)</span>}
                    </div>
                    <div className={`w-2 h-2 rounded-full ${p.is_connected ? 'bg-green-400' : 'bg-gray-600'}`} />
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-gray-500">Budget</div>
                      <div className="font-bold text-base" style={{ color: color.primary }}>${p.budget}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Spent</div>
                      <div className="font-bold text-base text-gray-300">${p.total_spent}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Roster</div>
                      <div className="font-bold text-sm">{p.characters_acquired}/{room.roster_size}</div>
                    </div>
                    <div>
                      <div className="text-gray-500">Slots left</div>
                      <div className="font-bold text-sm">{slotsLeft}</div>
                    </div>
                  </div>
                  {/* Mini roster preview */}
                  {roster.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-800 flex flex-wrap gap-1">
                      {roster.slice(0, 6).map((r) => {
                        const char = allCharacters.find((c) => c.id === r.character_id);
                        if (!char) return null;
                        return (
                          <div
                            key={r.id}
                            className="text-xs px-1.5 py-0.5 rounded border truncate max-w-[80px]"
                            style={{
                              borderColor: PUBLISHER_COLORS[char.publisher] + '40',
                              color: PUBLISHER_COLORS[char.publisher],
                            }}
                            title={`${char.name} - $${r.purchase_price}`}
                          >
                            {char.name.split(' ').slice(-1)[0]}
                          </div>
                        );
                      })}
                      {roster.length > 6 && (
                        <span className="text-xs text-gray-500">+{roster.length - 6}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Auto-fill option */}
          {room.status === 'drafting' && (
            <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Info className="w-4 h-4" />
                <span>If any player can't afford remaining characters, auto-fill assigns them at $0.</span>
              </div>
              <button
                onClick={handleAutoFill}
                disabled={actionLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-lg text-xs transition-colors shrink-0"
              >
                {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Auto-fill
              </button>
            </div>
          )}
        </div>

        {/* Sidebar: Rosters */}
        <aside className="space-y-3">
          {participants.map((p) => {
            const color = SLOT_COLORS[p.slot];
            const roster = rosters.filter((r) => r.participant_id === p.id);
            const totalCost = roster.reduce((sum, r) => sum + r.purchase_price, 0);
            const avgCost = roster.length > 0 ? Math.round(totalCost / roster.length) : 0;
            const maxPrice = Math.max(...roster.map((r) => r.purchase_price), 0);

            return (
              <div key={p.id} className="bg-[#14141c] border border-gray-800 rounded-2xl overflow-hidden">
                <div
                  className="px-4 py-3 border-b border-gray-800 flex items-center justify-between"
                  style={{ background: color.bg }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-6 h-6 rounded flex items-center justify-center font-bold text-xs"
                      style={{ background: color.primary + '20', color: color.primary }}
                    >
                      {p.slot + 1}
                    </div>
                    <span className="font-semibold text-sm">{p.display_name}</span>
                  </div>
                  <div className="text-right">
                    <span className="font-bold text-sm" style={{ color: color.primary }}>${p.budget}</span>
                  </div>
                </div>
                <div className="p-3">
                  <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
                    <div className="text-center">
                      <div className="text-gray-500">Spent</div>
                      <div className="font-semibold">${p.total_spent}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-gray-500">Avg</div>
                      <div className="font-semibold">${avgCost}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-gray-500">Picks</div>
                      <div className="font-semibold">{p.characters_acquired}/{room.roster_size}</div>
                    </div>
                  </div>
                  {roster.length === 0 ? (
                    <div className="text-center py-4 text-xs text-gray-600">No picks yet</div>
                  ) : (
                    <div className="space-y-1 max-h-[200px] overflow-y-auto">
                      {roster.map((r) => {
                        const char = allCharacters.find((c) => c.id === r.character_id);
                        if (!char) return null;
                        const isExpensive = r.purchase_price >= maxPrice && maxPrice > 10;
                        const isBargain = r.purchase_price <= 2 && !r.is_auto_filled;
                        return (
                          <div
                            key={r.id}
                            className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-[#0a0a0f] transition-colors text-xs"
                          >
                            <div
                              className="w-1 h-6 rounded-full shrink-0"
                              style={{ background: PUBLISHER_COLORS[char.publisher] }}
                            />
                            <div className="flex-1 truncate">
                              <span className="font-medium">{char.name}</span>
                              {char.version_name !== 'Standard' && (
                                <span className="text-gray-500 text-[10px] ml-1">{char.version_name}</span>
                              )}
                              {r.is_auto_filled && (
                                <span className="text-purple-400 text-[10px] ml-1">(auto)</span>
                              )}
                            </div>
                            <span
                              className={`font-bold tabular-nums shrink-0 ${
                                isExpensive ? 'text-amber-400' : isBargain ? 'text-green-400' : 'text-gray-300'
                              }`}
                            >
                              ${r.purchase_price}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </aside>
      </div>

      {/* Character pool modal */}
      {showCharPool && (
        <CharacterPoolModal
          characters={filteredCharacters}
          searchQuery={searchQuery}
          onSearch={setSearchQuery}
          onClose={() => setShowCharPool(false)}
          onShowDetail={(c) => setShowCharDetail(c)}
          onNominate={isMyTurnToNominate ? handleNominate : undefined}
          loading={actionLoading}
        />
      )}

      {/* Character detail modal */}
      {showCharDetail && (
        <CharacterDetailModal
          character={showCharDetail}
          onClose={() => setShowCharDetail(null)}
        />
      )}

      {/* Full roster modal */}
      {showRoster !== null && (
        <RosterModal
          slot={showRoster}
          participant={participants.find((p) => p.slot === showRoster)}
          roster={rosters.filter((r) => r.participant_id === participants.find((p) => p.slot === showRoster)?.id)}
          characters={allCharacters}
          onClose={() => setShowRoster(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// NOMINATION PANEL
// ============================================================================
function NominationPanel({
  isMyTurn, nominatorName, onNominate, characters, loading, onShowDetail, onOpenPool,
}: {
  isMyTurn: boolean;
  nominatorName: string;
  onNominate: (id: string) => void;
  characters: Character[];
  loading: boolean;
  onShowDetail: (c: Character) => void;
  onOpenPool: () => void;
}) {
  const [selected, setSelected] = useState<Character | null>(null);

  return (
    <div className="bg-[#14141c] border border-gray-800 rounded-2xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-600/40 flex items-center justify-center">
          <Gavel className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h2 className="text-lg font-bold">
            {isMyTurn ? 'Your Turn to Nominate' : `${nominatorName}'s Turn to Nominate`}
          </h2>
          <p className="text-sm text-gray-400">
            {isMyTurn
              ? 'Select a character from the pool to put up for auction.'
              : 'Waiting for nomination...'}
          </p>
        </div>
      </div>

      {isMyTurn && (
        <>
          {selected ? (
            <div className="space-y-4">
              <div className="bg-[#0a0a0f] border border-gray-800 rounded-xl p-4 flex items-center gap-4">
                <div
                  className="w-3 h-12 rounded-full shrink-0"
                  style={{ background: PUBLISHER_COLORS[selected.publisher] }}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold">{selected.name}</span>
                    {selected.version_name !== 'Standard' && (
                      <span className="text-xs text-gray-500">({selected.version_name})</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    {selected.publisher} · {selected.tier} tier · Starting bid $1
                  </div>
                </div>
                <button
                  onClick={() => onShowDetail(selected)}
                  className="p-2 text-gray-400 hover:text-white transition-colors"
                >
                  <Info className="w-4 h-4" />
                </button>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => setSelected(null)}
                  className="flex-1 py-2.5 bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-xl text-sm transition-colors"
                >
                  Choose Different
                </button>
                <button
                  onClick={() => onNominate(selected.id)}
                  disabled={loading}
                  className="flex-1 py-2.5 bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500 disabled:opacity-50 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Gavel className="w-4 h-4" />}
                  Nominate for Auction
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-[#0a0a0f] border border-gray-800 rounded-xl p-6 text-center">
              <Users className="w-8 h-8 text-gray-600 mx-auto mb-2" />
              <p className="text-sm text-gray-400 mb-3">
                {characters.length} characters available. Pick one to nominate.
              </p>
              <button
                onClick={onOpenPool}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-xl text-sm transition-colors"
              >
                <Search className="w-4 h-4" /> Browse Character Pool
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// AUCTION PANEL
// ============================================================================
function AuctionPanel({
  character, auction, highBidderName, timeLeft, maxTime,
  amHighestBidder, haveIPassed, canBid, canAffordBid, myBudget, minReserve,
  onBid, onPass, loading, activeBidders, onShowDetail,
}: {
  character: Character;
  auction: Auction;
  highBidderName?: string;
  timeLeft: number;
  maxTime: number;
  amHighestBidder: boolean;
  haveIPassed: boolean;
  canBid: boolean;
  canAffordBid: (inc: number) => boolean;
  myBudget: number;
  minReserve: number;
  onBid: (inc: number) => void;
  onPass: () => void;
  loading: boolean;
  activeBidders: number;
  onShowDetail: () => void;
}) {
  const timerPct = Math.max(0, (timeLeft / maxTime) * 100);
  const isLow = timeLeft <= 5;
  const [showPassConfirm, setShowPassConfirm] = useState(false);

  return (
    <div className="bg-[#14141c] border border-gray-800 rounded-2xl overflow-hidden">
      {/* Character header */}
      <div className="relative p-6 border-b border-gray-800">
        <div
          className="absolute inset-0 opacity-10"
          style={{ background: `linear-gradient(135deg, ${PUBLISHER_COLORS[character.publisher]}, transparent)` }}
        />
        <div className="relative flex items-start gap-4">
          <div
            className="w-4 h-16 rounded-lg shrink-0 mt-1"
            style={{ background: PUBLISHER_COLORS[character.publisher] }}
          />
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{
                  background: PUBLISHER_COLORS[character.publisher] + '20',
                  color: PUBLISHER_COLORS[character.publisher],
                }}
              >
                {character.publisher}
              </span>
              <span
                className="text-xs font-medium px-2 py-0.5 rounded-full"
                style={{
                  background: TIER_COLORS[character.tier] + '20',
                  color: TIER_COLORS[character.tier],
                }}
              >
                {character.tier}
              </span>
              {character.version_name !== 'Standard' && (
                <span className="text-xs text-gray-400">{character.version_name}</span>
              )}
            </div>
            <h2 className="text-2xl font-bold mb-1">{character.name}</h2>
            <p className="text-sm text-gray-400 line-clamp-2">{character.abilities}</p>
            <button
              onClick={onShowDetail}
              className="mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-white transition-colors"
            >
              <Info className="w-3 h-3" /> View full details
            </button>
          </div>
        </div>
      </div>

      {/* Auction status */}
      <div className="p-6">
        {/* Timer */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Clock className={`w-4 h-4 ${isLow ? 'text-red-400' : 'text-gray-400'}`} />
              <span className="text-sm text-gray-400">Auction Timer</span>
            </div>
            <span className={`font-bold tabular-nums ${isLow ? 'text-red-400' : 'text-white'}`}>
              {timeLeft}s
            </span>
          </div>
          <div className="h-2 bg-[#0a0a0f] rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${
                isLow ? 'bg-red-500' : 'bg-gradient-to-r from-red-600 to-blue-600'
              }`}
              style={{ width: `${timerPct}%` }}
            />
          </div>
        </div>

        {/* Current bid */}
        <div className="bg-[#0a0a0f] border border-gray-800 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-500 mb-1">Current High Bid</div>
              <div className="flex items-center gap-2">
                <span className="text-3xl font-bold tabular-nums">
                  ${auction.high_bid}
                </span>
                {highBidderName && (
                  <span className="text-sm text-gray-400">by {highBidderName}</span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-gray-500 mb-1">Active Bidders</div>
              <div className="text-xl font-bold">{activeBidders}</div>
            </div>
          </div>
        </div>

        {/* Bid buttons */}
        {amHighestBidder ? (
          <div className="bg-green-950/30 border border-green-800/50 rounded-xl p-4 text-center">
            <Check className="w-5 h-5 text-green-400 mx-auto mb-1" />
            <p className="text-sm text-green-400 font-medium">You are the highest bidder at ${auction.high_bid}</p>
            <p className="text-xs text-gray-500 mt-1">Wait for others to bid or pass</p>
          </div>
        ) : haveIPassed ? (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
            <p className="text-sm text-gray-400">You have passed on this auction</p>
          </div>
        ) : showPassConfirm ? (
          <div className="bg-[#0a0a0f] border border-gray-800 rounded-xl p-4">
            <p className="text-sm text-center mb-3">
              Are you sure you want to pass? You cannot re-enter this auction.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowPassConfirm(false)}
                className="flex-1 py-2.5 bg-[#14141c] border border-gray-800 hover:border-gray-600 rounded-xl text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onPass(); setShowPassConfirm(false); }}
                disabled={loading}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded-xl text-sm font-medium transition-colors"
              >
                Confirm Pass
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              {[1, 5, 25].map((inc) => {
                const newBid = auction.high_bid + inc;
                const affordable = canAffordBid(inc);
                return (
                  <button
                    key={inc}
                    onClick={() => onBid(inc)}
                    disabled={!canBid || !affordable || loading}
                    className="py-3 rounded-xl font-bold transition-all disabled:opacity-30 disabled:cursor-not-allowed bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500"
                  >
                    <div className="text-lg leading-none">+${inc}</div>
                    <div className="text-[10px] mt-1 opacity-80 tabular-nums">
                      ${newBid}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Budget info */}
            <div className="flex items-center justify-between text-xs text-gray-500 px-1">
              <span>Your budget: <span className="font-bold text-gray-300">${myBudget}</span></span>
              <span>Reserve for {minReserve} slot{minReserve !== 1 ? 's' : ''}: ${minReserve}</span>
            </div>

            <button
              onClick={() => setShowPassConfirm(true)}
              disabled={loading}
              className="w-full py-2.5 bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-xl text-sm text-gray-400 transition-colors"
            >
              Pass
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// CHARACTER POOL MODAL
// ============================================================================
function CharacterPoolModal({
  characters, searchQuery, onSearch, onClose, onShowDetail, onNominate, loading,
}: {
  characters: Character[];
  searchQuery: string;
  onSearch: (q: string) => void;
  onClose: () => void;
  onShowDetail: (c: Character) => void;
  onNominate?: (id: string) => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#14141c] border border-gray-800 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="font-bold text-lg">Character Pool ({characters.length})</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 border-b border-gray-800">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              autoFocus
              type="text"
              value={searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search by name, publisher, version, or tier..."
              className="w-full bg-[#0a0a0f] border border-gray-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>
        <div className="overflow-y-auto flex-1 p-4">
          {characters.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">No characters match your search.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {characters.map((char) => (
                <div
                  key={char.id}
                  className="bg-[#0a0a0f] border border-gray-800 hover:border-gray-600 rounded-xl p-3 flex items-center gap-3 transition-all"
                >
                  <div
                    className="w-1 h-10 rounded-full shrink-0"
                    style={{ background: PUBLISHER_COLORS[char.publisher] }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{char.name}</span>
                      {char.version_name !== 'Standard' && (
                        <span className="text-xs text-gray-500 shrink-0">{char.version_name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-gray-500">{char.publisher}</span>
                      <span
                        className="text-xs px-1.5 py-0 rounded-full"
                        style={{ background: TIER_COLORS[char.tier] + '20', color: TIER_COLORS[char.tier] }}
                      >
                        {char.tier}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => onShowDetail(char)}
                    className="p-1.5 text-gray-400 hover:text-white transition-colors shrink-0"
                  >
                    <Info className="w-4 h-4" />
                  </button>
                  {onNominate && (
                    <button
                      onClick={() => onNominate(char.id)}
                      disabled={loading}
                      className="px-2.5 py-1 bg-gradient-to-r from-red-600 to-blue-600 hover:from-red-500 hover:to-blue-500 disabled:opacity-50 rounded-lg text-xs font-medium shrink-0 transition-all"
                    >
                      Nominate
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CHARACTER DETAIL MODAL
// ============================================================================
function CharacterDetailModal({ character, onClose }: { character: Character; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#14141c] border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-[#14141c] border-b border-gray-800 p-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <div
              className="w-1.5 h-8 rounded-full"
              style={{ background: PUBLISHER_COLORS[character.publisher] }}
            />
            <div>
              <h3 className="font-bold text-lg leading-tight">{character.name}</h3>
              <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                <span>{character.publisher}</span>
                <span>·</span>
                <span>{character.version_name}</span>
                <span>·</span>
                <span>{character.universe}</span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Biography</h4>
            <p className="text-sm text-gray-300">{character.biography}</p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Abilities</h4>
            <p className="text-sm text-gray-300">{character.abilities}</p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Notable Feats</h4>
            <p className="text-sm text-gray-300">{character.notable_feats}</p>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Limitations</h4>
            <p className="text-sm text-gray-300">{character.limitations}</p>
          </div>

          {/* Ratings */}
          <div>
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Battle Ratings</h4>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {CATEGORIES.map((cat) => (
                <div key={cat} className="bg-[#0a0a0f] border border-gray-800 rounded-lg p-2.5">
                  <div className="text-xs text-gray-400 mb-1">{CATEGORY_LABELS[cat]}</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${character[cat]}%`,
                          background: character[cat] >= 80 ? '#c026d3' : character[cat] >= 60 ? '#2563eb' : '#64748b',
                        }}
                      />
                    </div>
                    <span className="text-xs font-bold tabular-nums">{character[cat]}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {character.sources && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Sources</h4>
              <p className="text-xs text-gray-400">{character.sources}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ROSTER MODAL
// ============================================================================
function RosterModal({
  participant, roster, characters, onClose,
}: {
  slot: number;
  participant?: GameParticipant;
  roster: RosterItem[];
  characters: Character[];
  onClose: () => void;
}) {
  if (!participant) return null;
  const color = SLOT_COLORS[participant.slot];
  const totalCost = roster.reduce((s, r) => s + r.purchase_price, 0);
  const avg = roster.length > 0 ? Math.round(totalCost / roster.length) : 0;

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-[#14141c] border border-gray-800 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-800 flex items-center justify-between" style={{ background: color.bg }}>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center font-bold"
              style={{ background: color.primary + '20', color: color.primary }}
            >
              {participant.slot + 1}
            </div>
            <div>
              <h3 className="font-bold">{participant.display_name}'s Roster</h3>
              <p className="text-xs text-gray-400">{roster.length} characters · ${totalCost} spent · ${avg} avg</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-4">
          {roster.length === 0 ? (
            <div className="text-center py-12 text-gray-500 text-sm">No characters acquired yet.</div>
          ) : (
            <div className="space-y-1.5">
              {roster.map((r, idx) => {
                const char = characters.find((c) => c.id === r.character_id);
                if (!char) return null;
                return (
                  <div key={r.id} className="flex items-center gap-3 bg-[#0a0a0f] border border-gray-800 rounded-lg p-3">
                    <span className="text-xs text-gray-600 w-6 tabular-nums">{idx + 1}.</span>
                    <div className="w-1 h-8 rounded-full" style={{ background: PUBLISHER_COLORS[char.publisher] }} />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{char.name}</span>
                        {char.version_name !== 'Standard' && (
                          <span className="text-xs text-gray-500">{char.version_name}</span>
                        )}
                        {r.is_auto_filled && (
                          <span className="text-xs text-purple-400">(auto-filled)</span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {char.publisher} · {char.tier}
                      </div>
                    </div>
                    <span className="font-bold text-sm tabular-nums" style={{ color: color.primary }}>
                      ${r.purchase_price}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
