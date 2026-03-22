import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ref, get, set, query, orderByChild, limitToLast } from "firebase/database";
import { db, dbEnabled } from "./firebase";
import { useServiceWorker } from "./useServiceWorker";

type Point = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";

type LeaderboardEntry = {
  id: string;
  name: string;
  bestScore: number;
  level: number;
  updatedAt: string;
};

const GRID_SIZE = 20;
const MAX_LEVEL = 20;
const APPLES_PER_LEVEL = 5;
const LOCAL_LEADERBOARD_KEY = "snake-local-leaderboard";

function speedForLevel(level: number) {
  return Math.round(200 - level * 7);
}

const DIRECTION_VECTORS: Record<Direction, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

const START_SNAKE: Point[] = [
  { x: 10, y: 10 },
  { x: 9, y: 10 },
  { x: 8, y: 10 },
];

function toKey({ x, y }: Point) {
  return `${x}:${y}`;
}

function randomFood(excluded: Set<string>) {
  let point: Point;
  do {
    point = {
      x: Math.floor(Math.random() * GRID_SIZE),
      y: Math.floor(Math.random() * GRID_SIZE),
    };
  } while (excluded.has(toKey(point)));
  return point;
}

const SWIPE_THRESHOLD = 20;

function toSafeKey(name: string) {
  return name.toLowerCase().replace(/[.#$\[\]/]/g, "_");
}

function levelTitle(lvl: number) {
  if (lvl >= 18) return "LEGEND";
  if (lvl >= 14) return "MASTER";
  if (lvl >= 10) return "EXPERT";
  if (lvl >= 6) return "ELITE";
  if (lvl >= 3) return "SKILLED";
  return "ROOKIE";
}

type GameScreen = "name" | "playing";
type MobileTab = "play" | "ranks";

export function App() {
  const { updateAvailable, applyUpdate } = useServiceWorker();

  const [screen, setScreen] = useState<GameScreen>("name");
  const [mobileTab, setMobileTab] = useState<MobileTab>("play");
  const [playerName, setPlayerName] = useState(() => {
    return window.localStorage.getItem("snake-player-name") || "";
  });
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [snake, setSnake] = useState<Point[]>(START_SNAKE);
  const [food, setFood] = useState<Point>(() => randomFood(new Set(START_SNAKE.map(toKey))));
  const [direction, setDirection] = useState<Direction>("right");
  const [isRunning, setIsRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [solidWalls, setSolidWalls] = useState(true);
  const [levelUpFlash, setLevelUpFlash] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);

  const directionRef = useRef<Direction>("right");
  const pendingDirectionRef = useRef<Direction>("right");
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const speed = speedForLevel(level);

  useEffect(() => {
    const storedBest = window.localStorage.getItem("snake-best-score");
    if (storedBest) setBestScore(Number(storedBest) || 0);
  }, []);

  const loadLocalLeaderboard = () => {
    const raw = window.localStorage.getItem(LOCAL_LEADERBOARD_KEY);
    if (!raw) return [] as LeaderboardEntry[];
    try {
      const parsed = JSON.parse(raw) as LeaderboardEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const persistLocalLeaderboard = (entries: LeaderboardEntry[]) => {
    window.localStorage.setItem(LOCAL_LEADERBOARD_KEY, JSON.stringify(entries));
  };

  const fetchLeaderboard = useCallback(async () => {
    try {
      let entries: LeaderboardEntry[] = [];
      if (dbEnabled && db) {
        const leaderboardRef = query(ref(db, "snake_players"), orderByChild("bestScore"), limitToLast(10));
        const snapshot = await get(leaderboardRef);
        if (snapshot.exists()) {
          const data = snapshot.val() as Record<string, any>;
          entries = Object.entries(data)
            .map(([key, val]) => ({
              id: key,
              name: String(val.name || "Unnamed"),
              bestScore: Number(val.bestScore || 0),
              level: Number(val.level || 0),
              updatedAt: String(val.updatedAt || ""),
            }))
            .sort((a, b) => b.bestScore - a.bestScore);
        }
      } else {
        entries = loadLocalLeaderboard();
      }
      setLeaderboard(entries);
      setLeaderboardError(null);
    } catch (error) {
      console.error("Fetch leaderboard failed:", error);
      setLeaderboardError("Unable to fetch leaderboard.");
      setLeaderboard(loadLocalLeaderboard());
    }
  }, []);

  const updateLocalLeaderboard = (name: string, scoreValue: number, levelValue: number) => {
    const list = loadLocalLeaderboard();
    const normalized = name.trim();
    const existing = list.find((item) => item.name.toLowerCase() === normalized.toLowerCase());
    if (existing) {
      if (scoreValue > existing.bestScore) existing.bestScore = scoreValue;
      existing.level = levelValue;
      existing.updatedAt = new Date().toISOString();
    } else {
      list.push({ id: crypto.randomUUID(), name: normalized, bestScore: scoreValue, level: levelValue, updatedAt: new Date().toISOString() });
    }
    const sorted = list.sort((a, b) => b.bestScore - a.bestScore || (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 10);
    persistLocalLeaderboard(sorted);
    setLeaderboard(sorted);
  };

  const submitScore = useCallback(
    async (scoreValue: number, levelValue: number) => {
      const normalized = playerName.trim();
      if (!normalized) return;
      if (dbEnabled && db) {
        const playerKey = toSafeKey(normalized);
        const playerRef = ref(db, `snake_players/${playerKey}`);
        const snapshot = await get(playerRef);
        const now = new Date().toISOString();
        if (!snapshot.exists()) {
          await set(playerRef, { name: normalized, bestScore: scoreValue, level: levelValue, lastScore: scoreValue, updatedAt: now });
        } else {
          const data = snapshot.val();
          const previousBest = Number(data.bestScore || 0);
          if (scoreValue > previousBest) {
            await set(playerRef, { ...data, name: normalized, bestScore: scoreValue, level: levelValue, lastScore: scoreValue, updatedAt: now });
          } else {
            await set(playerRef, { ...data, lastScore: scoreValue, level: levelValue, updatedAt: now });
          }
        }
        await fetchLeaderboard();
      } else {
        updateLocalLeaderboard(normalized, scoreValue, levelValue);
      }
    },
    [fetchLeaderboard, playerName]
  );

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);
  useEffect(() => {
    if (gameOver) {
      submitScore(score, level).catch((error) => {
        console.error("submitScore failed:", error);
        setLeaderboardError("Could not update leaderboard.");
      });
    }
  }, [gameOver, score, level, submitScore]);

  useEffect(() => { directionRef.current = direction; pendingDirectionRef.current = direction; }, [direction]);
  useEffect(() => {
    if (score > bestScore) { setBestScore(score); window.localStorage.setItem("snake-best-score", String(score)); }
  }, [score, bestScore]);
  useEffect(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(score / APPLES_PER_LEVEL));
    if (newLevel !== level) { setLevel(newLevel); setLevelUpFlash(true); setTimeout(() => setLevelUpFlash(false), 3000); }
  }, [score, level]);

  const resetGame = () => {
    setSnake(START_SNAKE);
    setDirection("right");
    directionRef.current = "right";
    pendingDirectionRef.current = "right";
    setFood(randomFood(new Set(START_SNAKE.map(toKey))));
    setScore(0);
    setLevel(0);
    setGameOver(false);
    setIsRunning(false);
  };

  const queueDirection = useCallback((next: Direction) => {
    const current = pendingDirectionRef.current;
    if (OPPOSITE[current] === next) return;
    pendingDirectionRef.current = next;
    setDirection(next);
  }, []);

  useEffect(() => {
    if (screen !== "playing") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const keyMap: Record<string, Direction> = { ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" };
      if (event.code === "Space") { event.preventDefault(); if (gameOver) resetGame(); else setIsRunning((r) => !r); return; }
      const next = keyMap[event.key];
      if (next) { event.preventDefault(); queueDirection(next); if (!gameOver) setIsRunning(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gameOver, queueDirection, screen]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const onTouchStart = (e: TouchEvent) => { touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const onTouchMove = (e: TouchEvent) => { e.preventDefault(); };
    const onTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;
      if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;
      const next: Direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      queueDirection(next);
      if (!gameOver) setIsRunning(true);
    };
    board.addEventListener("touchstart", onTouchStart, { passive: true });
    board.addEventListener("touchmove", onTouchMove, { passive: false });
    board.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => { board.removeEventListener("touchstart", onTouchStart); board.removeEventListener("touchmove", onTouchMove); board.removeEventListener("touchend", onTouchEnd); };
  }, [gameOver, queueDirection]);

  useEffect(() => {
    const preventScroll = (e: TouchEvent) => { if (e.touches.length === 1) e.preventDefault(); };
    document.body.addEventListener("touchmove", preventScroll, { passive: false });
    return () => document.body.removeEventListener("touchmove", preventScroll);
  }, []);

  useEffect(() => {
    if (!isRunning || gameOver) return;
    const timer = window.setInterval(() => {
      const activeDirection = pendingDirectionRef.current;
      directionRef.current = activeDirection;
      const vector = DIRECTION_VECTORS[activeDirection];
      setSnake((currentSnake) => {
        const head = currentSnake[0];
        let nextHead: Point = { x: head.x + vector.x, y: head.y + vector.y };
        if (!solidWalls) nextHead = { x: (nextHead.x + GRID_SIZE) % GRID_SIZE, y: (nextHead.y + GRID_SIZE) % GRID_SIZE };
        if (solidWalls && (nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= GRID_SIZE || nextHead.y >= GRID_SIZE)) { setGameOver(true); setIsRunning(false); return currentSnake; }
        const ateFood = nextHead.x === food.x && nextHead.y === food.y;
        const nextSnake = [nextHead, ...currentSnake];
        if (!ateFood) nextSnake.pop();
        if (nextSnake.slice(1).some((s) => s.x === nextHead.x && s.y === nextHead.y)) { setGameOver(true); setIsRunning(false); return currentSnake; }
        if (ateFood) { setScore((v) => v + 1); setFood(randomFood(new Set(nextSnake.map(toKey)))); }
        return nextSnake;
      });
    }, speed);
    return () => window.clearInterval(timer);
  }, [food, gameOver, isRunning, solidWalls, speed]);

  const snakeMap = useMemo(() => new Set(snake.map(toKey)), [snake]);

  const handleDirButton = (dir: Direction) => {
    queueDirection(dir);
    if (!gameOver) setIsRunning(true);
  };

  const startGame = () => {
    if (!playerName.trim()) return;
    window.localStorage.setItem("snake-player-name", playerName.trim());
    resetGame();
    setScreen("playing");
  };

  const applesInLevel = score % APPLES_PER_LEVEL;

  const updateBanner = updateAvailable ? (
    <div className="fixed left-0 right-0 top-0 z-50 flex items-center justify-center gap-3 bg-[#39ff14]/90 px-4 py-2 text-sm font-bold text-black shadow-lg">
      <span>New update available!</span>
      <button onClick={applyUpdate} className="rounded-lg bg-black px-3 py-1 text-xs font-bold text-[#39ff14] transition active:scale-95">
        Update Now
      </button>
    </div>
  ) : null;

  // ─── Shared: D-pad arrows SVGs ───
  const ArrowUp = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
  const ArrowDown = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
  const ArrowLeft = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
  const ArrowRight = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );

  // ─── Game board component (shared) ───
  const gameBoard = (
    <div
      ref={boardRef}
      className="relative aspect-square w-full overflow-hidden rounded-2xl border border-[#39ff14]/20 bg-[#0a0f0a] p-1"
      style={{ touchAction: "none" }}
    >
      {/* Session active badge */}
      {isRunning && !gameOver && (
        <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-[#1a1f1a]/80 px-3 py-1 backdrop-blur">
          <div className="h-2 w-2 animate-pulse rounded-full bg-[#39ff14]" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#39ff14]">Session Active</span>
        </div>
      )}

      {/* Dot grid background + snake cells */}
      <div
        className="grid h-full w-full"
        style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
          const x = index % GRID_SIZE;
          const y = Math.floor(index / GRID_SIZE);
          const key = `${x}:${y}`;
          const isHead = snake[0].x === x && snake[0].y === y;
          const isBody = snakeMap.has(key);
          const isFood = food.x === x && food.y === y;

          return (
            <div key={key} className="flex items-center justify-center">
              {isHead ? (
                <div className="h-[85%] w-[85%] rounded-sm bg-[#9ef01a] shadow-[0_0_6px_rgba(158,240,26,0.6)]" />
              ) : isBody ? (
                <div className="h-[85%] w-[85%] rounded-sm bg-[#70e000] shadow-[0_0_4px_rgba(112,224,0,0.3)]" />
              ) : isFood ? (
                <div className="h-[70%] w-[70%] rounded-full bg-[#ff6b2b] shadow-[0_0_8px_rgba(255,107,43,0.6)]" />
              ) : (
                <div className="h-1 w-1 rounded-full bg-[#1a2a1a]" />
              )}
            </div>
          );
        })}
      </div>

      {/* Game Over overlay */}
      {gameOver && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 backdrop-blur-sm">
          <p className="text-3xl font-black uppercase tracking-wider text-[#39ff14] drop-shadow-[0_0_10px_rgba(57,255,20,0.5)]">Game Over</p>
          <p className="text-sm font-semibold text-[#39ff14]/70">{playerName}</p>
          <p className="text-lg text-white">Score: {score} | Level: {level}</p>
          <button
            onClick={resetGame}
            className="mt-2 rounded-xl bg-[#39ff14] px-6 py-2 text-sm font-bold text-black transition active:scale-95"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );

  // ─── Leaderboard panel (shared) ───
  const leaderboardPanel = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-black uppercase tracking-wider text-[#39ff14]">Top 10 Ranks</h2>
        <span className="rounded-full bg-[#39ff14]/10 px-2 py-0.5 text-[10px] font-bold text-[#39ff14]">
          {dbEnabled ? "LIVE" : "LOCAL"}
        </span>
      </div>

      {leaderboardError && <p className="text-xs text-red-400">{leaderboardError}</p>}

      {leaderboard.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">No scores yet. Play to submit!</p>
      ) : (
        <ol className="space-y-1.5">
          {leaderboard.map((entry, index) => (
            <li
              key={entry.id}
              className={[
                "flex items-center justify-between rounded-xl px-3 py-2.5",
                index === 0 ? "bg-[#39ff14]/10 border border-[#39ff14]/20" : "bg-[#1a1f1a]",
              ].join(" ")}
            >
              <div className="flex items-center gap-3">
                <span className={[
                  "flex h-7 w-7 items-center justify-center rounded-lg text-xs font-black",
                  index === 0 ? "bg-[#39ff14] text-black" : index === 1 ? "bg-gray-600 text-white" : index === 2 ? "bg-amber-700 text-white" : "bg-[#1f2a1f] text-gray-400",
                ].join(" ")}>
                  {index + 1}
                </span>
                <span className="text-sm font-bold text-white">{entry.name}</span>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-[#39ff14]">{entry.bestScore.toLocaleString()}</p>
                <p className="text-[10px] text-gray-500">LVL {entry.level}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  // ─── NAME ENTRY SCREEN ───
  if (screen === "name") {
    return (
      <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#0d1117] px-4 py-8">
        {updateBanner}

        {/* Grid background */}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(57,255,20,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(57,255,20,0.03)_1px,transparent_1px)] bg-[size:40px_40px]" />

        <div className="relative flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl border border-[#39ff14]/10 bg-[#111a11]/90 p-8 shadow-[0_0_60px_rgba(57,255,20,0.05)] backdrop-blur">
          {/* Snake icon */}
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-[#0a0f0a] shadow-[0_0_20px_rgba(57,255,20,0.15)]">
            <div className="grid grid-cols-3 gap-0.5">
              <div className="h-4 w-4 rounded-sm bg-[#70e000] shadow-[0_0_4px_rgba(112,224,0,0.4)]" />
              <div className="h-4 w-4 rounded-sm bg-[#70e000] shadow-[0_0_4px_rgba(112,224,0,0.4)]" />
              <div className="h-4 w-4 rounded-sm bg-[#9ef01a] shadow-[0_0_4px_rgba(158,240,26,0.4)]" />
              <div />
              <div />
              <div />
              <div className="h-4 w-4 rounded-full bg-[#ff6b2b] shadow-[0_0_6px_rgba(255,107,43,0.5)]" />
              <div />
              <div />
            </div>
          </div>

          <div className="text-center">
            <h1 className="text-3xl font-black uppercase italic tracking-wider text-[#39ff14] drop-shadow-[0_0_10px_rgba(57,255,20,0.4)]">
              Neon Slither
            </h1>
            <p className="mt-1 text-xs uppercase tracking-[0.25em] text-gray-500">Arcade Snake</p>
          </div>

          <div className="w-full space-y-2">
            <label htmlFor="player-name" className="block text-xs font-bold uppercase tracking-wider text-gray-400">
              Player Name
            </label>
            <input
              ref={nameInputRef}
              id="player-name"
              type="text"
              maxLength={20}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startGame(); }}
              placeholder="Enter your name..."
              autoFocus
              className="w-full rounded-xl border border-[#39ff14]/20 bg-[#0a0f0a] px-4 py-3 text-lg font-bold text-[#39ff14] outline-none transition placeholder:text-gray-600 focus:border-[#39ff14]/50 focus:shadow-[0_0_15px_rgba(57,255,20,0.1)]"
            />
          </div>

          <button
            onClick={startGame}
            disabled={!playerName.trim()}
            className="w-full rounded-2xl bg-[#39ff14] px-6 py-3.5 text-lg font-black uppercase text-black shadow-[0_0_20px_rgba(57,255,20,0.3)] transition hover:shadow-[0_0_30px_rgba(57,255,20,0.5)] active:scale-95 disabled:opacity-30 disabled:shadow-none"
          >
            Play Game
          </button>

          <div className="grid w-full grid-cols-2 gap-3 text-center">
            <div className="rounded-xl bg-[#0a0f0a] px-3 py-3 border border-[#39ff14]/10">
              <p className="text-lg font-black text-[#39ff14]">20</p>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Levels</p>
            </div>
            <div className="rounded-xl bg-[#0a0f0a] px-3 py-3 border border-[#39ff14]/10">
              <p className="text-lg font-black text-[#39ff14]">{bestScore.toLocaleString()}</p>
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Best Score</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ─── GAME SCREEN ───
  return (
    <main className="relative flex min-h-[100dvh] flex-col bg-[#0d1117] text-white">
      {updateBanner}

      {/* Subtle grid background */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(57,255,20,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(57,255,20,0.02)_1px,transparent_1px)] bg-[size:40px_40px]" />

      {/* ── Top bar ── */}
      <header className="relative z-10 flex items-center justify-between px-4 pb-2 pt-3">
        <button
          onClick={() => { resetGame(); setScreen("name"); }}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition hover:text-white"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <h1 className="text-lg font-black uppercase italic tracking-wider text-[#39ff14] drop-shadow-[0_0_8px_rgba(57,255,20,0.4)]">
          Neon Slither
        </h1>
        <button
          onClick={() => setSolidWalls((w) => !w)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 transition hover:text-[#39ff14]"
          title={solidWalls ? "Solid walls ON" : "Wrap-around"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </header>

      {/* ── Content area ── */}
      <div className="relative z-10 flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-24">

        {/* Show Play tab or Ranks tab on mobile */}
        {mobileTab === "play" ? (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-[#1a1f1a] px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Current Score</p>
                <div className="flex items-end justify-between">
                  <p className="text-3xl font-black text-[#39ff14] drop-shadow-[0_0_6px_rgba(57,255,20,0.3)]">
                    {score.toLocaleString()}
                  </p>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-[#39ff14]/40"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
              </div>
              <div className="rounded-2xl bg-[#1a1f1a] px-4 py-3">
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Level</p>
                <div className="flex items-end justify-between">
                  <p className="text-3xl font-black text-cyan-400">{String(level).padStart(2, "0")}</p>
                  <span className="text-[10px] font-bold uppercase text-cyan-400/60">{levelTitle(level)}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-3 rounded-2xl bg-[#1a1f1a] px-4 py-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 text-orange-400"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Speed</p>
                  <p className="text-base font-black text-orange-400">{Math.round((1000 / speed) * 10) / 10}x</p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-[#1a1f1a] px-4 py-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#39ff14]/10">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[#39ff14]"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                </div>
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Best</p>
                  <p className="text-base font-black text-[#39ff14]">{bestScore.toLocaleString()}</p>
                </div>
              </div>
            </div>

            {/* Level progress */}
            <div className="flex items-center gap-2 px-1">
              <span className="text-[10px] font-bold text-gray-500">LVL {level}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1f1a]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#39ff14] to-[#70e000] transition-all duration-300"
                  style={{ width: level >= MAX_LEVEL ? "100%" : `${(applesInLevel / APPLES_PER_LEVEL) * 100}%` }}
                />
              </div>
              <span className="text-[10px] font-bold text-gray-500">
                {level >= MAX_LEVEL ? "MAX" : `LVL ${level + 1}`}
              </span>
            </div>

            {/* Game board */}
            {gameBoard}

            {/* D-pad controls */}
            <div className="relative flex flex-col items-center gap-2 py-2">
              {/* Floating pause button */}
              <button
                onClick={() => {
                  if (gameOver) resetGame();
                  else setIsRunning((r) => !r);
                }}
                className="absolute -top-1 right-0 flex h-14 w-14 items-center justify-center rounded-full bg-[#39ff14] shadow-[0_0_20px_rgba(57,255,20,0.3)] transition active:scale-90"
              >
                {gameOver ? (
                  <svg viewBox="0 0 24 24" fill="black" className="h-6 w-6"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8V3h-1.59L17.6 4.81A8.96 8.96 0 0 0 12 3a9 9 0 0 0 0 18 9 9 0 0 0 9-9z"/></svg>
                ) : isRunning ? (
                  <svg viewBox="0 0 24 24" fill="black" className="h-6 w-6"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="black" className="h-6 w-6"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </button>

              <button
                onClick={() => handleDirButton("up")}
                className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1f2a1f] text-gray-300 transition active:scale-90 active:bg-[#39ff14]/20 active:text-[#39ff14]"
              >
                <ArrowUp />
              </button>
              <div className="flex gap-8">
                <button
                  onClick={() => handleDirButton("left")}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1f2a1f] text-gray-300 transition active:scale-90 active:bg-[#39ff14]/20 active:text-[#39ff14]"
                >
                  <ArrowLeft />
                </button>
                <button
                  onClick={() => handleDirButton("down")}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1f2a1f] text-gray-300 transition active:scale-90 active:bg-[#39ff14]/20 active:text-[#39ff14]"
                >
                  <ArrowDown />
                </button>
                <button
                  onClick={() => handleDirButton("right")}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1f2a1f] text-gray-300 transition active:scale-90 active:bg-[#39ff14]/20 active:text-[#39ff14]"
                >
                  <ArrowRight />
                </button>
              </div>
            </div>
          </>
        ) : (
          /* ── Ranks tab ── */
          <div className="py-2">
            {leaderboardPanel}
          </div>
        )}
      </div>

      {/* ── Bottom navigation bar ── */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 flex items-end justify-around border-t border-[#1a1f1a] bg-[#0d1117]/95 px-4 pb-[env(safe-area-inset-bottom,8px)] pt-2 backdrop-blur">
        <button
          onClick={() => setMobileTab("play")}
          className={[
            "flex flex-col items-center gap-0.5 transition",
            mobileTab === "play" ? "text-[#39ff14]" : "text-gray-500",
          ].join(" ")}
        >
          {mobileTab === "play" ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#39ff14] shadow-[0_0_15px_rgba(57,255,20,0.3)]">
              <svg viewBox="0 0 24 24" fill="black" className="h-5 w-5"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 15H5v-2H7v2zm0-4H5V9H7v2zm4 0H9V9h2v2zm8 4h-2v-2h2v2zm0-4h-2V9h2v2z"/></svg>
            </div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 15H5v-2H7v2zm0-4H5V9H7v2zm4 0H9V9h2v2zm8 4h-2v-2h2v2zm0-4h-2V9h2v2z"/></svg>
          )}
          <span className="text-[10px] font-bold uppercase">{mobileTab === "play" ? "Play" : "Play"}</span>
        </button>

        <button
          onClick={() => { setMobileTab("ranks"); fetchLeaderboard(); }}
          className={[
            "flex flex-col items-center gap-0.5 transition",
            mobileTab === "ranks" ? "text-[#39ff14]" : "text-gray-500",
          ].join(" ")}
        >
          {mobileTab === "ranks" ? (
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#39ff14] shadow-[0_0_15px_rgba(57,255,20,0.3)]">
              <svg viewBox="0 0 24 24" fill="black" className="h-5 w-5"><path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4"/></svg>
            </div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6"><path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4"/></svg>
          )}
          <span className="text-[10px] font-bold uppercase">Ranks</span>
        </button>
      </nav>
    </main>
  );
}
