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

// Compute snake segment shape: which neighbors are also snake?
function getSegmentRadius(
  snake: Point[],
  idx: number,
  cellPct: number
) {
  const seg = snake[idx];
  const prev = idx > 0 ? snake[idx - 1] : null;
  const next = idx < snake.length - 1 ? snake[idx + 1] : null;
  const r = `${cellPct * 0.42}%`;
  const zero = "0";

  const hasUp = (prev && prev.x === seg.x && prev.y === seg.y - 1) || (next && next.x === seg.x && next.y === seg.y - 1);
  const hasDown = (prev && prev.x === seg.x && prev.y === seg.y + 1) || (next && next.x === seg.x && next.y === seg.y + 1);
  const hasLeft = (prev && prev.y === seg.y && prev.x === seg.x - 1) || (next && next.y === seg.y && next.x === seg.x - 1);
  const hasRight = (prev && prev.y === seg.y && prev.x === seg.x + 1) || (next && next.y === seg.y && next.x === seg.x + 1);

  // top-left, top-right, bottom-right, bottom-left
  const tl = (hasUp || hasLeft) ? zero : r;
  const tr = (hasUp || hasRight) ? zero : r;
  const br = (hasDown || hasRight) ? zero : r;
  const bl = (hasDown || hasLeft) ? zero : r;

  return `${tl} ${tr} ${br} ${bl}`;
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
  const [boosting, setBoosting] = useState(false);
  const boostingRef = useRef(false);
  const baseSpeed = speedForLevel(level);
  const speed = boosting ? Math.max(40, Math.round(baseSpeed * 0.45)) : baseSpeed;

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
    setBoosting(false);
    boostingRef.current = false;
  };

  const queueDirection = useCallback((next: Direction) => {
    const current = pendingDirectionRef.current;
    if (OPPOSITE[current] === next) return;
    pendingDirectionRef.current = next;
    setDirection(next);
  }, []);

  useEffect(() => {
    if (screen !== "playing") return;
    const keyMap: Record<string, Direction> = { ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") { event.preventDefault(); if (gameOver) resetGame(); else setIsRunning((r) => !r); return; }
      const next = keyMap[event.key];
      if (!next) return;
      event.preventDefault();
      if (!gameOver) setIsRunning(true);
      // If holding the same direction as current, activate boost
      if (event.repeat && next === pendingDirectionRef.current) {
        if (!boostingRef.current) { boostingRef.current = true; setBoosting(true); }
        return;
      }
      queueDirection(next);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const dir = keyMap[event.key];
      if (dir && boostingRef.current) {
        boostingRef.current = false;
        setBoosting(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [gameOver, queueDirection, screen]);

  // Swipe anywhere on screen to control snake
  useEffect(() => {
    if (screen !== "playing") return;
    const onTouchStart = (e: TouchEvent) => {
      // Skip if touching an interactive element (buttons, inputs)
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "LABEL") return;
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
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
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => { document.removeEventListener("touchstart", onTouchStart); document.removeEventListener("touchend", onTouchEnd); };
  }, [gameOver, queueDirection, screen]);

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

  // Build a lookup: key -> snake index (for fast neighbor checks in render)
  const snakeIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    snake.forEach((s, i) => m.set(toKey(s), i));
    return m;
  }, [snake]);

  const startGame = () => {
    if (!playerName.trim()) return;
    window.localStorage.setItem("snake-player-name", playerName.trim());
    resetGame();
    setScreen("playing");
  };

  const applesInLevel = score % APPLES_PER_LEVEL;
  const cellPct = 100 / GRID_SIZE;

  const updateBanner = updateAvailable ? (
    <div className="fixed left-0 right-0 top-0 z-50 flex items-center justify-center gap-3 bg-[#39ff14]/90 px-4 py-2 text-sm font-bold text-black shadow-lg">
      <span>New update available!</span>
      <button onClick={applyUpdate} className="rounded-lg bg-black px-3 py-1 text-xs font-bold text-[#39ff14] transition active:scale-95">
        Update Now
      </button>
    </div>
  ) : null;

  // ─── Render a single snake cell with organic shape ───
  const renderSnakeCell = (x: number, y: number) => {
    const idx = snakeIndexMap.get(`${x}:${y}`);
    if (idx === undefined) return null;
    const isHead = idx === 0;
    const isTail = idx === snake.length - 1;

    // Head: direction-aware eyes + fully rounded front
    if (isHead) {
      const dir = pendingDirectionRef.current;
      const radius = getSegmentRadius(snake, idx, cellPct);

      // Eye positions relative to head direction
      let eye1Style: React.CSSProperties = {};
      let eye2Style: React.CSSProperties = {};
      const eyeSize = "18%";

      if (dir === "right") {
        eye1Style = { top: "18%", right: "15%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "18%", right: "15%", width: eyeSize, height: eyeSize };
      } else if (dir === "left") {
        eye1Style = { top: "18%", left: "15%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "18%", left: "15%", width: eyeSize, height: eyeSize };
      } else if (dir === "up") {
        eye1Style = { top: "15%", left: "18%", width: eyeSize, height: eyeSize };
        eye2Style = { top: "15%", right: "18%", width: eyeSize, height: eyeSize };
      } else {
        eye1Style = { bottom: "15%", left: "18%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "15%", right: "18%", width: eyeSize, height: eyeSize };
      }

      return (
        <div
          className="relative"
          style={{
            width: "92%",
            height: "92%",
            background: "linear-gradient(135deg, #9ef01a 0%, #70e000 100%)",
            borderRadius: radius,
            boxShadow: "0 0 8px rgba(158,240,26,0.6)",
          }}
        >
          <div className="absolute rounded-full bg-white" style={eye1Style}>
            <div className="absolute inset-[20%] rounded-full bg-[#1a1a2e]" />
          </div>
          <div className="absolute rounded-full bg-white" style={eye2Style}>
            <div className="absolute inset-[20%] rounded-full bg-[#1a1a2e]" />
          </div>
        </div>
      );
    }

    // Tail: tapered with rounded end
    if (isTail) {
      const prev = snake[idx - 1];
      const dx = prev.x - snake[idx].x;
      const dy = prev.y - snake[idx].y;
      // Taper toward the opposite of the direction to prev
      let clipPath = "";
      if (dx > 0) clipPath = "polygon(30% 15%, 100% 0%, 100% 100%, 30% 85%)";
      else if (dx < 0) clipPath = "polygon(0% 0%, 70% 15%, 70% 85%, 0% 100%)";
      else if (dy > 0) clipPath = "polygon(15% 30%, 85% 30%, 100% 100%, 0% 100%)";
      else clipPath = "polygon(0% 0%, 100% 0%, 85% 70%, 15% 70%)";

      const radius = getSegmentRadius(snake, idx, cellPct);
      const t = idx / snake.length;
      const green = Math.round(224 - t * 80);

      return (
        <div
          style={{
            width: "88%",
            height: "88%",
            background: `rgb(${Math.round(60 + t * 40)}, ${green}, 0)`,
            borderRadius: radius,
            clipPath,
            opacity: 0.7,
          }}
        />
      );
    }

    // Body: gradient from bright to darker, rounded corners based on neighbors
    const t = idx / snake.length;
    const green = Math.round(224 - t * 60);
    const radius = getSegmentRadius(snake, idx, cellPct);

    // Subtle scale pattern: alternate slightly different shade
    const scaleShift = (idx % 2 === 0) ? 8 : 0;

    return (
      <div
        style={{
          width: "92%",
          height: "92%",
          background: `rgb(${Math.round(80 + t * 30)}, ${green + scaleShift}, 0)`,
          borderRadius: radius,
          boxShadow: idx < 3 ? "0 0 4px rgba(112,224,0,0.3)" : "none",
        }}
      />
    );
  };

  // ─── Game board ───
  const gameBoard = (
    <div
      ref={boardRef}
      className={["relative w-full overflow-hidden rounded-2xl bg-[#080c08]", solidWalls ? "border-2 border-[#39ff14]/50 shadow-[inset_0_0_15px_rgba(57,255,20,0.1)]" : "border border-[#39ff14]/10"].join(" ")}
      style={{ touchAction: "none", aspectRatio: "1" }}
    >
      {isRunning && !gameOver && (
        <div className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-full bg-[#0d1117]/80 px-2.5 py-0.5 backdrop-blur sm:left-3 sm:top-3 sm:px-3 sm:py-1">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#39ff14] sm:h-2 sm:w-2" />
          <span className="text-[8px] font-bold uppercase tracking-wider text-[#39ff14] sm:text-[10px]">Session Active</span>
        </div>
      )}

      <div
        className="absolute inset-0 grid"
        style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`, gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)` }}
      >
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, index) => {
          const x = index % GRID_SIZE;
          const y = Math.floor(index / GRID_SIZE);
          const key = `${x}:${y}`;
          const isSnake = snakeMap.has(key);
          const isFood = food.x === x && food.y === y;

          return (
            <div key={key} className="flex items-center justify-center">
              {isSnake ? (
                renderSnakeCell(x, y)
              ) : isFood ? (
                <div
                  className="animate-pulse"
                  style={{
                    width: "65%",
                    height: "65%",
                    borderRadius: "50%",
                    background: "radial-gradient(circle at 35% 35%, #ff9a56, #ff4d2b)",
                    boxShadow: "0 0 10px rgba(255,77,43,0.6), 0 0 20px rgba(255,77,43,0.2)",
                  }}
                />
              ) : (
                <div className="h-[3px] w-[3px] rounded-full bg-[#162016] sm:h-1 sm:w-1" />
              )}
            </div>
          );
        })}
      </div>

      {gameOver && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <p className="text-2xl font-black uppercase tracking-wider text-[#39ff14] drop-shadow-[0_0_10px_rgba(57,255,20,0.5)] sm:text-3xl">Game Over</p>
          <p className="text-xs font-semibold text-[#39ff14]/70 sm:text-sm">{playerName}</p>
          <p className="text-sm text-white sm:text-lg">Score: {score} | Level: {level}</p>
          <button
            onClick={resetGame}
            className="mt-2 rounded-xl bg-[#39ff14] px-5 py-2 text-xs font-bold text-black transition active:scale-95 sm:px-6 sm:text-sm"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );

  // ─── Leaderboard panel ───
  const leaderboardPanel = (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-black uppercase tracking-wider text-[#39ff14] sm:text-lg">Top 10 Ranks</h2>
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
                "flex items-center justify-between rounded-xl px-3 py-2",
                index === 0 ? "bg-[#39ff14]/10 border border-[#39ff14]/20" : "bg-[#1a1f1a]",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 sm:gap-3">
                <span className={[
                  "flex h-6 w-6 items-center justify-center rounded-lg text-[10px] font-black sm:h-7 sm:w-7 sm:text-xs",
                  index === 0 ? "bg-[#39ff14] text-black" : index === 1 ? "bg-gray-600 text-white" : index === 2 ? "bg-amber-700 text-white" : "bg-[#1f2a1f] text-gray-400",
                ].join(" ")}>
                  {index + 1}
                </span>
                <span className="text-xs font-bold text-white sm:text-sm">{entry.name}</span>
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-[#39ff14] sm:text-sm">{entry.bestScore.toLocaleString()}</p>
                <p className="text-[9px] text-gray-500 sm:text-[10px]">LVL {entry.level}</p>
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
      <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#0d1117] px-4 py-6">
        {updateBanner}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(57,255,20,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(57,255,20,0.03)_1px,transparent_1px)] bg-[size:40px_40px]" />

        <div className="relative flex w-full max-w-sm flex-col items-center gap-5 rounded-3xl border border-[#39ff14]/10 bg-[#111a11]/90 p-6 shadow-[0_0_60px_rgba(57,255,20,0.05)] backdrop-blur sm:gap-6 sm:p-8">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#0a0f0a] shadow-[0_0_20px_rgba(57,255,20,0.15)] sm:h-20 sm:w-20">
            <div className="grid grid-cols-3 gap-0.5">
              <div className="h-3 w-3 rounded-sm bg-[#70e000] shadow-[0_0_4px_rgba(112,224,0,0.4)] sm:h-4 sm:w-4" />
              <div className="h-3 w-3 rounded-sm bg-[#70e000] shadow-[0_0_4px_rgba(112,224,0,0.4)] sm:h-4 sm:w-4" />
              <div className="h-3 w-3 rounded-sm bg-[#9ef01a] shadow-[0_0_4px_rgba(158,240,26,0.4)] sm:h-4 sm:w-4" />
              <div /><div /><div />
              <div className="h-3 w-3 rounded-full bg-[#ff6b2b] shadow-[0_0_6px_rgba(255,107,43,0.5)] sm:h-4 sm:w-4" />
              <div /><div />
            </div>
          </div>

          <div className="text-center">
            <h1 className="text-2xl font-black uppercase italic tracking-wider text-[#39ff14] drop-shadow-[0_0_10px_rgba(57,255,20,0.4)] sm:text-3xl">
              Snake Game 360
            </h1>
            <p className="mt-1 text-[10px] uppercase tracking-[0.25em] text-gray-500 sm:text-xs">Arcade Snake</p>
          </div>

          <div className="w-full space-y-2">
            <label htmlFor="player-name" className="block text-[10px] font-bold uppercase tracking-wider text-gray-400 sm:text-xs">
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
              className="w-full rounded-xl border border-[#39ff14]/20 bg-[#0a0f0a] px-4 py-2.5 text-base font-bold text-[#39ff14] outline-none transition placeholder:text-gray-600 focus:border-[#39ff14]/50 focus:shadow-[0_0_15px_rgba(57,255,20,0.1)] sm:py-3 sm:text-lg"
            />
          </div>

          <button
            onClick={startGame}
            disabled={!playerName.trim()}
            className="w-full rounded-2xl bg-[#39ff14] px-6 py-3 text-base font-black uppercase text-black shadow-[0_0_20px_rgba(57,255,20,0.3)] transition hover:shadow-[0_0_30px_rgba(57,255,20,0.5)] active:scale-95 disabled:opacity-30 disabled:shadow-none sm:py-3.5 sm:text-lg"
          >
            Play Game
          </button>

          <div className="grid w-full grid-cols-2 gap-3 text-center">
            <div className="rounded-xl border border-[#39ff14]/10 bg-[#0a0f0a] px-3 py-2.5">
              <p className="text-base font-black text-[#39ff14] sm:text-lg">20</p>
              <p className="text-[9px] uppercase tracking-wider text-gray-500 sm:text-[10px]">Levels</p>
            </div>
            <div className="rounded-xl border border-[#39ff14]/10 bg-[#0a0f0a] px-3 py-2.5">
              <p className="text-base font-black text-[#39ff14] sm:text-lg">{bestScore.toLocaleString()}</p>
              <p className="text-[9px] uppercase tracking-wider text-gray-500 sm:text-[10px]">Best Score</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ─── GAME SCREEN ───
  return (
    <main className="relative flex h-[100vh] flex-col bg-[#0d1117] text-white">
      {updateBanner}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(57,255,20,0.02)_1px,transparent_1px),linear-gradient(to_bottom,rgba(57,255,20,0.02)_1px,transparent_1px)] bg-[size:40px_40px]" />

      {/* Top bar */}
      <header className="relative z-10 flex flex-shrink-0 items-center justify-between px-3 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4 sm:pb-2 sm:pt-3">
        <button
          onClick={() => { resetGame(); setScreen("name"); }}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition hover:text-white sm:h-9 sm:w-9"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 sm:h-5 sm:w-5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </button>
        <h1 className="text-sm font-black uppercase italic tracking-wider text-[#39ff14] drop-shadow-[0_0_8px_rgba(57,255,20,0.4)] sm:text-lg">
          Snake Game 360
        </h1>
        <button
          onClick={() => setSolidWalls((w) => !w)}
          className={["flex h-8 w-8 items-center justify-center rounded-lg transition sm:h-9 sm:w-9", solidWalls ? "text-[#39ff14]" : "text-gray-500"].join(" ")}
          title={solidWalls ? "Solid walls ON" : "Wrap-around"}
        >
          {solidWalls?'Wall':'Wall'}

          {/* <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 sm:h-5 sm:w-5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg> */}
        </button>
      </header>

      {/* ── Desktop layout (lg+): game board full + sidebar ── */}
      <div className="relative z-10 hidden min-h-0 flex-1 gap-4 px-4 pb-4 lg:flex">
        {/* Game board — fills all available height */}
        <div className="flex flex-1 items-center justify-center">
          <div className="h-full max-h-full" style={{ aspectRatio: "1" }}>
            {gameBoard}
          </div>
        </div>

        {/* Desktop sidebar */}
        <aside className="flex w-72 flex-shrink-0 flex-col gap-3 overflow-y-auto xl:w-80">
          {/* Player */}
          <div className="flex items-center justify-between rounded-xl bg-[#1a1f1a] px-4 py-2">
            <span className="text-sm font-bold text-white">{playerName}</span>
            {boosting && <span className="animate-pulse rounded-full bg-orange-500/20 px-2 py-0.5 text-[9px] font-bold text-orange-400">BOOST</span>}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[#1a1f1a] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Score</p>
              <p className="text-2xl font-black text-[#39ff14] drop-shadow-[0_0_6px_rgba(57,255,20,0.3)]">{score.toLocaleString()}</p>
            </div>
            <div className="rounded-xl bg-[#1a1f1a] px-4 py-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Level</p>
              <div className="flex items-end justify-between">
                <p className="text-2xl font-black text-cyan-400">{String(level).padStart(2, "0")}</p>
                <span className="text-[9px] font-bold uppercase text-cyan-400/60">{levelTitle(level)}</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-3 rounded-xl bg-[#1a1f1a] px-4 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 text-orange-400"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
              <div>
                <p className="text-[9px] font-bold uppercase tracking-wider text-gray-500">Speed</p>
                <p className="text-base font-black text-orange-400">{Math.round((1000 / speed) * 10) / 10}x</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-[#1a1f1a] px-4 py-2.5">
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
          <div className="flex items-center gap-2 px-0.5">
            <span className="text-[10px] font-bold text-gray-500">LVL {level}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1f1a]">
              <div className="h-full rounded-full bg-gradient-to-r from-[#39ff14] to-[#70e000] transition-all duration-300" style={{ width: level >= MAX_LEVEL ? "100%" : `${(applesInLevel / APPLES_PER_LEVEL) * 100}%` }} />
            </div>
            <span className="text-[10px] font-bold text-gray-500">{level >= MAX_LEVEL ? "MAX" : `LVL ${level + 1}`}</span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (gameOver) resetGame(); else setIsRunning((r) => !r); }}
              className="flex-1 rounded-xl bg-[#39ff14] py-2.5 text-sm font-bold text-black transition active:scale-95"
            >
              {gameOver ? "Reset" : isRunning ? "Pause" : "Start"}
            </button>
            <button
              onClick={resetGame}
              className="rounded-xl border border-[#39ff14]/20 bg-[#1a1f1a] px-4 py-2.5 text-sm font-bold text-gray-300 transition hover:text-white active:scale-95"
            >
              New
            </button>
          </div>

          <p className="text-center text-[10px] text-gray-600">Arrow keys / WASD to move, hold to boost, Space to pause</p>

          {/* Leaderboard */}
          {leaderboardPanel}
        </aside>
      </div>

      {/* ── Mobile/tablet layout (below lg) ── */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-20 sm:gap-3 sm:px-4 sm:pb-24 lg:hidden">
        {mobileTab === "play" ? (
          <>
            {/* Stat cards row 1 */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div className="rounded-xl bg-[#1a1f1a] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3">
                <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 sm:text-[10px]">Current Score</p>
                <div className="flex items-end justify-between">
                  <p className="text-xl font-black text-[#39ff14] drop-shadow-[0_0_6px_rgba(57,255,20,0.3)] sm:text-3xl">
                    {score.toLocaleString()}
                  </p>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[#39ff14]/30 sm:h-5 sm:w-5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
              </div>
              <div className="rounded-xl bg-[#1a1f1a] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3">
                <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 sm:text-[10px]">Level</p>
                <div className="flex items-end justify-between">
                  <p className="text-xl font-black text-cyan-400 sm:text-3xl">{String(level).padStart(2, "0")}</p>
                  <span className="text-[8px] font-bold uppercase text-cyan-400/60 sm:text-[10px]">{levelTitle(level)}</span>
                </div>
              </div>
            </div>

            {/* Stat cards row 2 */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div className="flex items-center gap-2 rounded-xl bg-[#1a1f1a] px-3 py-2 sm:gap-3 sm:rounded-2xl sm:px-4 sm:py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/10 sm:h-8 sm:w-8">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 text-orange-400 sm:h-4 sm:w-4"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                </div>
                <div>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 sm:text-[9px]">Speed</p>
                  <p className="text-sm font-black text-orange-400 sm:text-base">{Math.round((1000 / speed) * 10) / 10}x</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-[#1a1f1a] px-3 py-2 sm:gap-3 sm:rounded-2xl sm:px-4 sm:py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#39ff14]/10 sm:h-8 sm:w-8">
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5 text-[#39ff14] sm:h-4 sm:w-4"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                </div>
                <div>
                  <p className="text-[8px] font-bold uppercase tracking-wider text-gray-500 sm:text-[9px]">Best</p>
                  <p className="text-sm font-black text-[#39ff14] sm:text-base">{bestScore.toLocaleString()}</p>
                </div>
              </div>
            </div>

            {/* Level progress */}
            <div className="flex items-center gap-2 px-0.5">
              <span className="text-[8px] font-bold text-gray-500 sm:text-[10px]">LVL {level}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#1a1f1a] sm:h-1.5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#39ff14] to-[#70e000] transition-all duration-300"
                  style={{ width: level >= MAX_LEVEL ? "100%" : `${(applesInLevel / APPLES_PER_LEVEL) * 100}%` }}
                />
              </div>
              <span className="text-[8px] font-bold text-gray-500 sm:text-[10px]">
                {level >= MAX_LEVEL ? "MAX" : `LVL ${level + 1}`}
              </span>
            </div>

            {/* Boost indicator */}
            {boosting && (
              <div className="flex items-center justify-center">
                <span className="animate-pulse rounded-full bg-orange-500/20 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-400">Boost Active</span>
              </div>
            )}

            {/* Game board — fill available space */}
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="h-full max-h-full w-full" style={{ aspectRatio: "1", maxWidth: "100%" }}>
                {gameBoard}
              </div>
            </div>

            {/* Floating pause/play button */}
            <div className="flex justify-end px-2 py-1">
              <button
                onClick={() => { if (gameOver) resetGame(); else setIsRunning((r) => !r); }}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-[#39ff14] shadow-[0_0_20px_rgba(57,255,20,0.3)] transition active:scale-90 sm:h-14 sm:w-14"
              >
                {gameOver ? (
                  <svg viewBox="0 0 24 24" fill="black" className="h-5 w-5 sm:h-6 sm:w-6"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                ) : isRunning ? (
                  <svg viewBox="0 0 24 24" fill="black" className="h-5 w-5 sm:h-6 sm:w-6"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="black" className="h-5 w-5 sm:h-6 sm:w-6"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="py-2">{leaderboardPanel}</div>
        )}
      </div>

      {/* Bottom nav — mobile/tablet only */}
      <nav className="fixed bottom-0 left-0 right-0 z-20 flex items-end justify-around border-t border-[#1a1f1a] bg-[#0d1117]/95 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur sm:pt-2 lg:hidden">
        <button
          onClick={() => setMobileTab("play")}
          className={["flex flex-col items-center gap-0.5 transition", mobileTab === "play" ? "text-[#39ff14]" : "text-gray-500"].join(" ")}
        >
          {mobileTab === "play" ? (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#39ff14] shadow-[0_0_15px_rgba(57,255,20,0.3)] sm:h-12 sm:w-12 sm:rounded-2xl">
              <svg viewBox="0 0 24 24" fill="black" className="h-4 w-4 sm:h-5 sm:w-5"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 15H5v-2H7v2zm0-4H5V9H7v2zm4 0H9V9h2v2zm8 4h-2v-2h2v2zm0-4h-2V9h2v2z"/></svg>
            </div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 sm:h-6 sm:w-6"><path d="M21 6H3a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 15H5v-2H7v2zm0-4H5V9H7v2zm4 0H9V9h2v2zm8 4h-2v-2h2v2zm0-4h-2V9h2v2z"/></svg>
          )}
          <span className="text-[9px] font-bold uppercase sm:text-[10px]">Play</span>
        </button>

        <button
          onClick={() => { setMobileTab("ranks"); fetchLeaderboard(); }}
          className={["flex flex-col items-center gap-0.5 transition", mobileTab === "ranks" ? "text-[#39ff14]" : "text-gray-500"].join(" ")}
        >
          {mobileTab === "ranks" ? (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#39ff14] shadow-[0_0_15px_rgba(57,255,20,0.3)] sm:h-12 sm:w-12 sm:rounded-2xl">
              <svg viewBox="0 0 24 24" fill="black" className="h-4 w-4 sm:h-5 sm:w-5"><path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4"/></svg>
            </div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-5 w-5 sm:h-6 sm:w-6"><path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4"/></svg>
          )}
          <span className="text-[9px] font-bold uppercase sm:text-[10px]">Ranks</span>
        </button>
      </nav>
    </main>
  );
}
