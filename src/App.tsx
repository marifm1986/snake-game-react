import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, getDoc, setDoc, getDocs, query, orderBy, limit } from "firebase/firestore";
import { db, dbEnabled } from "./firebase";
import { useServiceWorker } from "./useServiceWorker";

type Point = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";
type GameDifficulty = "easy" | "hard";

type LeaderboardEntry = {
  id: string;
  name: string;
  bestScore: number;
  level: number;
  updatedAt: string;
};

// ─── Snake Skins ───
type SnakeSkin = {
  id: string;
  name: string;
  cost: number;
  headGradient: string;
  bodyColor: (t: number, idx: number) => string;
  tailColor: (t: number) => string;
  glowColor: string;
  eyeBg: string;
};

const SNAKE_SKINS: SnakeSkin[] = [
  {
    id: "classic",
    name: "Classic Green",
    cost: 0,
    headGradient: "linear-gradient(135deg, #9ef01a 0%, #70e000 100%)",
    bodyColor: (t, idx) => `rgb(${Math.round(80 + t * 30)}, ${Math.round(224 - t * 60) + (idx % 2 === 0 ? 8 : 0)}, 0)`,
    tailColor: (t) => `rgb(${Math.round(60 + t * 40)}, ${Math.round(224 - t * 80)}, 0)`,
    glowColor: "rgba(158,240,26,0.6)",
    eyeBg: "#1a1a2e",
  },
  {
    id: "neon_blue",
    name: "Neon Blue",
    cost: 15,
    headGradient: "linear-gradient(135deg, #00f5ff 0%, #0077ff 100%)",
    bodyColor: (t, idx) => `rgb(${Math.round(0 + t * 20)}, ${Math.round(180 - t * 60) + (idx % 2 === 0 ? 10 : 0)}, ${Math.round(255 - t * 40)})`,
    tailColor: (t) => `rgb(${Math.round(0 + t * 30)}, ${Math.round(120 - t * 50)}, ${Math.round(200 - t * 40)})`,
    glowColor: "rgba(0,245,255,0.6)",
    eyeBg: "#0a0a2e",
  },
  {
    id: "fire",
    name: "Fire",
    cost: 30,
    headGradient: "linear-gradient(135deg, #ffdd00 0%, #ff6600 100%)",
    bodyColor: (t, idx) => `rgb(${Math.round(255 - t * 60)}, ${Math.round(120 - t * 80) + (idx % 2 === 0 ? 15 : 0)}, ${Math.round(0 + t * 10)})`,
    tailColor: (t) => `rgb(${Math.round(200 - t * 60)}, ${Math.round(50 - t * 30)}, 0)`,
    glowColor: "rgba(255,102,0,0.6)",
    eyeBg: "#1a0a00",
  },
  {
    id: "galaxy",
    name: "Galaxy",
    cost: 50,
    headGradient: "linear-gradient(135deg, #e040fb 0%, #7c4dff 100%)",
    bodyColor: (t, idx) => `rgb(${Math.round(160 - t * 60) + (idx % 2 === 0 ? 10 : 0)}, ${Math.round(40 + t * 20)}, ${Math.round(220 - t * 40)})`,
    tailColor: (t) => `rgb(${Math.round(100 - t * 30)}, ${Math.round(30 + t * 10)}, ${Math.round(180 - t * 50)})`,
    glowColor: "rgba(224,64,251,0.6)",
    eyeBg: "#1a0a2e",
  },
  {
    id: "gold",
    name: "Gold",
    cost: 75,
    headGradient: "linear-gradient(135deg, #ffd700 0%, #daa520 100%)",
    bodyColor: (t, idx) => `rgb(${Math.round(218 - t * 40) + (idx % 2 === 0 ? 8 : 0)}, ${Math.round(165 - t * 40)}, ${Math.round(32 + t * 10)})`,
    tailColor: (t) => `rgb(${Math.round(180 - t * 40)}, ${Math.round(130 - t * 40)}, ${Math.round(20 + t * 10)})`,
    glowColor: "rgba(255,215,0,0.6)",
    eyeBg: "#2e2a1a",
  },
];

const GRID_SIZE = 20;
const MAX_LEVEL = 20;
const APPLES_PER_LEVEL = 5;
const LOCAL_LEADERBOARD_KEY = "snake-local-leaderboard";
const COIN_BALANCE_KEY = "snake-coin-balance";
const PURCHASED_SKINS_KEY = "snake-purchased-skins";
const ACTIVE_SKIN_KEY = "snake-active-skin";
const PENDING_SYNC_KEY = "snake-pending-sync";

// ─── Offline pending sync queue ───
type PendingSync = {
  playerName: string;
  score: number;
  level: number;
  coins: number;
  purchasedSkins: string[];
  activeSkin: string;
  timestamp: string;
};

function loadPendingSync(): PendingSync[] {
  const raw = window.localStorage.getItem(PENDING_SYNC_KEY);
  if (!raw) return [];
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}

function savePendingSync(queue: PendingSync[]) {
  window.localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(queue));
}

function addPendingSync(entry: PendingSync) {
  const queue = loadPendingSync();
  // Merge with existing entry for same player: keep highest score & latest coins
  const idx = queue.findIndex((q) => q.playerName.toLowerCase() === entry.playerName.toLowerCase());
  if (idx >= 0) {
    const existing = queue[idx];
    queue[idx] = {
      ...entry,
      score: Math.max(existing.score, entry.score),
      coins: entry.coins,
    };
  } else {
    queue.push(entry);
  }
  savePendingSync(queue);
}

function speedForLevel(level: number, difficulty: GameDifficulty) {
  if (difficulty === "hard") {
    return Math.max(50, Math.round(180 - level * 12));
  }
  return Math.round(200 - level * 7);
}

// ─── Hard mode obstacle generation ───
function generateObstacles(level: number, excluded: Set<string>): Point[] {
  if (level <= 0) return [];
  const obstacles: Point[] = [];
  const count = Math.min(level * 2 + 1, 30);
  const center = Math.floor(GRID_SIZE / 2);
  const attempts = count * 20;
  let tries = 0;

  while (obstacles.length < count && tries < attempts) {
    tries++;
    // Place obstacles in the middle area (avoiding edges where snake starts)
    const x = Math.floor(Math.random() * (GRID_SIZE - 4)) + 2;
    const y = Math.floor(Math.random() * (GRID_SIZE - 4)) + 2;
    const key = `${x}:${y}`;

    // Don't place too close to start position or on excluded cells
    if (excluded.has(key)) continue;
    if (Math.abs(x - 10) <= 2 && Math.abs(y - 10) <= 1) continue;
    // Avoid blocking the very center completely at low levels
    if (level < 3 && Math.abs(x - center) <= 1 && Math.abs(y - center) <= 1) continue;
    if (obstacles.some((o) => o.x === x && o.y === y)) continue;

    obstacles.push({ x, y });
  }
  return obstacles;
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

function getSegmentRadius(snake: Point[], idx: number, cellPct: number) {
  const seg = snake[idx];
  const prev = idx > 0 ? snake[idx - 1] : null;
  const next = idx < snake.length - 1 ? snake[idx + 1] : null;
  const r = `${cellPct * 0.42}%`;
  const zero = "0";

  const hasUp = (prev && prev.x === seg.x && prev.y === seg.y - 1) || (next && next.x === seg.x && next.y === seg.y - 1);
  const hasDown = (prev && prev.x === seg.x && prev.y === seg.y + 1) || (next && next.x === seg.x && next.y === seg.y + 1);
  const hasLeft = (prev && prev.y === seg.y && prev.x === seg.x - 1) || (next && next.y === seg.y && next.x === seg.x - 1);
  const hasRight = (prev && prev.y === seg.y && prev.x === seg.x + 1) || (next && next.y === seg.y && next.x === seg.x + 1);

  const tl = (hasUp || hasLeft) ? zero : r;
  const tr = (hasUp || hasRight) ? zero : r;
  const br = (hasDown || hasRight) ? zero : r;
  const bl = (hasDown || hasLeft) ? zero : r;

  return `${tl} ${tr} ${br} ${bl}`;
}

// ─── localStorage helpers for shop ───
function loadCoinBalance(): number {
  const raw = window.localStorage.getItem(COIN_BALANCE_KEY);
  return raw ? (Number(raw) || 0) : 0;
}
function saveCoinBalance(val: number) {
  window.localStorage.setItem(COIN_BALANCE_KEY, String(val));
}
function loadPurchasedSkins(): string[] {
  const raw = window.localStorage.getItem(PURCHASED_SKINS_KEY);
  if (!raw) return ["classic"];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : ["classic"];
  } catch { return ["classic"]; }
}
function savePurchasedSkins(skins: string[]) {
  window.localStorage.setItem(PURCHASED_SKINS_KEY, JSON.stringify(skins));
}
function loadActiveSkin(): string {
  return window.localStorage.getItem(ACTIVE_SKIN_KEY) || "classic";
}
function saveActiveSkin(id: string) {
  window.localStorage.setItem(ACTIVE_SKIN_KEY, id);
}

type GameScreen = "name" | "playing" | "shop";
type MobileTab = "play" | "ranks" | "shop";

export function App() {
  const { updateAvailable, applyUpdate } = useServiceWorker();

  const [screen, setScreen] = useState<GameScreen>("name");
  const [mobileTab, setMobileTab] = useState<MobileTab>("play");
  const [playerName, setPlayerName] = useState(() => {
    return window.localStorage.getItem("snake-player-name") || "";
  });
  const nameInputRef = useRef<HTMLInputElement>(null);

  // ─── Difficulty ───
  const [difficulty, setDifficulty] = useState<GameDifficulty>("easy");

  // ─── Online / Offline state ───
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // ─── Snake Skin Shop ───
  const [coinBalance, setCoinBalance] = useState(loadCoinBalance);
  const [purchasedSkins, setPurchasedSkins] = useState(loadPurchasedSkins);
  const [activeSkinId, setActiveSkinId] = useState(loadActiveSkin);
  const activeSkin = SNAKE_SKINS.find((s) => s.id === activeSkinId) || SNAKE_SKINS[0];

  // ─── Game state ───
  const [snake, setSnake] = useState<Point[]>(START_SNAKE);
  const [food, setFood] = useState<Point>(() => randomFood(new Set(START_SNAKE.map(toKey))));
  const [obstacles, setObstacles] = useState<Point[]>([]);
  const [bonusApple, setBonusApple] = useState<Point | null>(null);
  const bonusTimerRef = useRef<number | null>(null);
  const [bonusCelebration, setBonusCelebration] = useState<Point | null>(null);
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
  const difficultyRef = useRef<GameDifficulty>(difficulty);
  difficultyRef.current = difficulty;

  const baseSpeed = speedForLevel(level, difficulty);
  const speed = boosting ? Math.max(40, Math.round(baseSpeed * 0.45)) : baseSpeed;

  useEffect(() => {
    const storedBest = window.localStorage.getItem("snake-best-score");
    if (storedBest) setBestScore(Number(storedBest) || 0);
    // Auto-fetch user profile from Firestore if username is saved
    const savedName = window.localStorage.getItem("snake-player-name");
    if (savedName && dbEnabled && db) {
      const playerKey = toSafeKey(savedName);
      const playerDoc = doc(db, "snake_players", playerKey);
      getDoc(playerDoc).then((snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          const remoteCoins = Number(data.coins || 0);
          setCoinBalance(remoteCoins);
          saveCoinBalance(remoteCoins);
          const remoteBest = Number(data.bestScore || 0);
          if (remoteBest > 0) {
            setBestScore(remoteBest);
            window.localStorage.setItem("snake-best-score", String(remoteBest));
          }
          if (Array.isArray(data.purchasedSkins) && data.purchasedSkins.length > 0) {
            setPurchasedSkins(data.purchasedSkins);
            savePurchasedSkins(data.purchasedSkins);
          }
          if (data.activeSkin && typeof data.activeSkin === "string") {
            setActiveSkinId(data.activeSkin);
            saveActiveSkin(data.activeSkin);
          }
        }
      }).catch(() => {});
    }
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
        const q = query(collection(db, "snake_players"), orderBy("bestScore", "desc"), limit(10));
        const snapshot = await getDocs(q);
        entries = snapshot.docs.map((d) => {
          const val = d.data();
          return {
            id: d.id,
            name: String(val.name || "Unnamed"),
            bestScore: Number(val.bestScore || 0),
            level: Number(val.level || 0),
            updatedAt: String(val.updatedAt || ""),
          };
        });
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

  // Sync coins & skins to Firestore for the current user
  const syncUserToFirestore = useCallback(
    async (overrides?: { coins?: number; skins?: string[] }) => {
      const normalized = playerName.trim();
      if (!normalized || !dbEnabled || !db) return;
      const playerKey = toSafeKey(normalized);
      const playerDoc = doc(db, "snake_players", playerKey);
      try {
        const snapshot = await getDoc(playerDoc);
        const prev = snapshot.exists() ? snapshot.data() : {};
        await setDoc(playerDoc, {
          ...prev,
          name: normalized,
          coins: overrides?.coins ?? coinBalance,
          purchasedSkins: overrides?.skins ?? purchasedSkins,
          activeSkin: activeSkinId,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } catch (e) {
        console.warn("syncUserToFirestore failed:", e);
      }
    },
    [playerName, coinBalance, purchasedSkins, activeSkinId]
  );

  const submitScore = useCallback(
    async (scoreValue: number, levelValue: number, newCoinBalance: number) => {
      const normalized = playerName.trim();
      if (!normalized) return;
      if (dbEnabled && db) {
        const playerKey = toSafeKey(normalized);
        const playerDoc = doc(db, "snake_players", playerKey);
        const snapshot = await getDoc(playerDoc);
        const now = new Date().toISOString();
        if (!snapshot.exists()) {
          await setDoc(playerDoc, { name: normalized, bestScore: scoreValue, level: levelValue, lastScore: scoreValue, coins: newCoinBalance, purchasedSkins, activeSkin: activeSkinId, updatedAt: now });
        } else {
          const data = snapshot.data();
          const previousBest = Number(data.bestScore || 0);
          const updates: Record<string, unknown> = { lastScore: scoreValue, level: levelValue, coins: newCoinBalance, purchasedSkins, activeSkin: activeSkinId, updatedAt: now };
          if (scoreValue > previousBest) {
            updates.bestScore = scoreValue;
          }
          await setDoc(playerDoc, { ...data, name: normalized, ...updates });
        }
        await fetchLeaderboard();
      } else {
        updateLocalLeaderboard(normalized, scoreValue, levelValue);
      }
    },
    [fetchLeaderboard, playerName, purchasedSkins, activeSkinId]
  );

  useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

  // ─── Flush pending offline sync queue ───
  const flushPendingSync = useCallback(async () => {
    if (!dbEnabled || !db) return;
    const queue = loadPendingSync();
    if (queue.length === 0) return;
    const remaining: PendingSync[] = [];
    for (const entry of queue) {
      try {
        const playerKey = toSafeKey(entry.playerName);
        const playerDoc = doc(db, "snake_players", playerKey);
        const snapshot = await getDoc(playerDoc);
        const now = entry.timestamp;
        if (!snapshot.exists()) {
          await setDoc(playerDoc, { name: entry.playerName, bestScore: entry.score, level: entry.level, lastScore: entry.score, coins: entry.coins, purchasedSkins: entry.purchasedSkins, activeSkin: entry.activeSkin, updatedAt: now });
        } else {
          const data = snapshot.data();
          const previousBest = Number(data.bestScore || 0);
          const updates: Record<string, unknown> = { lastScore: entry.score, level: entry.level, coins: entry.coins, purchasedSkins: entry.purchasedSkins, activeSkin: entry.activeSkin, updatedAt: now };
          if (entry.score > previousBest) updates.bestScore = entry.score;
          await setDoc(playerDoc, { ...data, name: entry.playerName, ...updates });
        }
      } catch {
        remaining.push(entry);
      }
    }
    savePendingSync(remaining);
    if (remaining.length < queue.length) {
      try { await fetchLeaderboard(); } catch {}
    }
  }, [fetchLeaderboard]);

  // Online/offline event listeners
  useEffect(() => {
    const goOnline = () => {
      setIsOnline(true);
      flushPendingSync();
    };
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    if (navigator.onLine) flushPendingSync();
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [flushPendingSync]);

  // Award coins + submit score on game over (queue offline if no connection)
  useEffect(() => {
    if (gameOver && score > 0) {
      const newBalance = coinBalance + score;
      setCoinBalance(newBalance);
      saveCoinBalance(newBalance);

      if (navigator.onLine && dbEnabled && db) {
        submitScore(score, level, newBalance).catch(() => {
          // Network failed mid-request — queue for later
          addPendingSync({
            playerName: playerName.trim(),
            score, level, coins: newBalance,
            purchasedSkins, activeSkin: activeSkinId,
            timestamp: new Date().toISOString(),
          });
        });
      } else {
        // Offline — save to pending queue
        addPendingSync({
          playerName: playerName.trim(),
          score, level, coins: newBalance,
          purchasedSkins, activeSkin: activeSkinId,
          timestamp: new Date().toISOString(),
        });
        updateLocalLeaderboard(playerName.trim(), score, level);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameOver]);

  useEffect(() => { directionRef.current = direction; pendingDirectionRef.current = direction; }, [direction]);
  useEffect(() => {
    if (score > bestScore) { setBestScore(score); window.localStorage.setItem("snake-best-score", String(score)); }
  }, [score, bestScore]);

  // Level up: generate new obstacles in hard mode
  useEffect(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(score / APPLES_PER_LEVEL));
    if (newLevel !== level) {
      setLevel(newLevel);
      setLevelUpFlash(true);
      setTimeout(() => setLevelUpFlash(false), 3000);
      if (difficultyRef.current === "hard") {
        setObstacles(() => {
          const snakeKeys = new Set(snake.map(toKey));
          // Also exclude food
          snakeKeys.add(toKey(food));
          return generateObstacles(newLevel, snakeKeys);
        });
      }
    }
  }, [score, level, snake, food]);

  const obstacleSet = useMemo(() => new Set(obstacles.map(toKey)), [obstacles]);

  const resetGame = useCallback(() => {
    setSnake(START_SNAKE);
    setDirection("right");
    directionRef.current = "right";
    pendingDirectionRef.current = "right";
    const startKeys = new Set(START_SNAKE.map(toKey));
    setFood(randomFood(startKeys));
    setScore(0);
    setLevel(0);
    setGameOver(false);
    setIsRunning(false);
    setBoosting(false);
    boostingRef.current = false;
    setBonusApple(null);
    setBonusCelebration(null);
    if (bonusTimerRef.current) { clearTimeout(bonusTimerRef.current); bonusTimerRef.current = null; }
    // Generate initial obstacles for hard mode (level 0 = none)
    setObstacles([]);
  }, []);

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
  }, [gameOver, queueDirection, screen, resetGame]);

  // Swipe anywhere on screen to control snake
  useEffect(() => {
    if (screen !== "playing") return;
    const onTouchStart = (e: TouchEvent) => {
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

  // ─── Bonus apple spawner (appears every 15-30s, lasts 5s) ───
  useEffect(() => {
    if (!isRunning || gameOver) {
      setBonusApple(null);
      if (bonusTimerRef.current) { clearTimeout(bonusTimerRef.current); bonusTimerRef.current = null; }
      return;
    }
    const scheduleNext = () => {
      const delay = (15 + Math.random() * 15) * 1000;
      return window.setTimeout(() => {
        // Spawn bonus apple at random position not occupied
        const excluded = new Set([...snake.map(toKey), toKey(food), ...obstacles.map(toKey)]);
        const pos = randomFood(excluded);
        setBonusApple(pos);
        // Auto-remove after 5 seconds
        const removeTimer = window.setTimeout(() => {
          setBonusApple(null);
          // Schedule next bonus
          bonusTimerRef.current = scheduleNext();
        }, 5000);
        bonusTimerRef.current = removeTimer;
      }, delay);
    };
    bonusTimerRef.current = scheduleNext();
    return () => {
      if (bonusTimerRef.current) { clearTimeout(bonusTimerRef.current); bonusTimerRef.current = null; }
    };
    // Only re-run when game starts/stops, not on every snake move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, gameOver]);

  // ─── Game tick ───
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
        // Obstacle collision (hard mode)
        if (obstacleSet.has(toKey(nextHead))) { setGameOver(true); setIsRunning(false); return currentSnake; }
        const ateFood = nextHead.x === food.x && nextHead.y === food.y;
        const nextSnake = [nextHead, ...currentSnake];
        if (!ateFood) nextSnake.pop();
        if (nextSnake.slice(1).some((s) => s.x === nextHead.x && s.y === nextHead.y)) { setGameOver(true); setIsRunning(false); return currentSnake; }
        if (ateFood) { setScore((v) => v + 1); setFood(randomFood(new Set([...nextSnake.map(toKey), ...obstacles.map(toKey)]))); }
        // Bonus apple collision — +10 coins instantly + celebration
        setBonusApple((currentBonus) => {
          if (currentBonus && nextHead.x === currentBonus.x && nextHead.y === currentBonus.y) {
            setCoinBalance((c) => { const nb = c + 10; saveCoinBalance(nb); return nb; });
            if (bonusTimerRef.current) { clearTimeout(bonusTimerRef.current); bonusTimerRef.current = null; }
            setBonusCelebration({ x: currentBonus.x, y: currentBonus.y });
            setTimeout(() => setBonusCelebration(null), 2000);
            return null;
          }
          return currentBonus;
        });
        return nextSnake;
      });
    }, speed);
    return () => window.clearInterval(timer);
  }, [food, gameOver, isRunning, solidWalls, speed, obstacleSet, obstacles]);

  const snakeMap = useMemo(() => new Set(snake.map(toKey)), [snake]);

  const snakeIndexMap = useMemo(() => {
    const m = new Map<string, number>();
    snake.forEach((s, i) => m.set(toKey(s), i));
    return m;
  }, [snake]);

  // Fetch user profile from Firestore when entering the game
  const fetchUserProfile = useCallback(async (username: string) => {
    if (!dbEnabled || !db) return;
    const playerKey = toSafeKey(username);
    const playerDoc = doc(db, "snake_players", playerKey);
    try {
      const snapshot = await getDoc(playerDoc);
      if (snapshot.exists()) {
        const data = snapshot.data();
        // Load coins
        const remoteCoins = Number(data.coins || 0);
        setCoinBalance(remoteCoins);
        saveCoinBalance(remoteCoins);
        // Load best score
        const remoteBest = Number(data.bestScore || 0);
        if (remoteBest > 0) {
          setBestScore(remoteBest);
          window.localStorage.setItem("snake-best-score", String(remoteBest));
        }
        // Load purchased skins
        if (Array.isArray(data.purchasedSkins) && data.purchasedSkins.length > 0) {
          setPurchasedSkins(data.purchasedSkins);
          savePurchasedSkins(data.purchasedSkins);
        }
        // Load active skin
        if (data.activeSkin && typeof data.activeSkin === "string") {
          setActiveSkinId(data.activeSkin);
          saveActiveSkin(data.activeSkin);
        }
      }
    } catch (e) {
      console.warn("fetchUserProfile failed:", e);
    }
  }, []);

  const startGame = async () => {
    if (!playerName.trim()) return;
    window.localStorage.setItem("snake-player-name", playerName.trim());
    await fetchUserProfile(playerName.trim());
    resetGame();
    setScreen("playing");
  };

  // ─── Shop actions ───
  const buySkin = (skinId: string) => {
    const skin = SNAKE_SKINS.find((s) => s.id === skinId);
    if (!skin || purchasedSkins.includes(skinId)) return;
    if (coinBalance < skin.cost) return;
    const newBalance = coinBalance - skin.cost;
    const newPurchased = [...purchasedSkins, skinId];
    setCoinBalance(newBalance);
    saveCoinBalance(newBalance);
    setPurchasedSkins(newPurchased);
    savePurchasedSkins(newPurchased);
    // Sync to Firestore
    syncUserToFirestore({ coins: newBalance, skins: newPurchased });
  };

  const selectSkin = (skinId: string) => {
    if (!purchasedSkins.includes(skinId)) return;
    setActiveSkinId(skinId);
    saveActiveSkin(skinId);
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

  const offlineBadge = !isOnline ? (
    <div className="fixed bottom-16 left-1/2 z-50 -translate-x-1/2 rounded-full bg-yellow-500/90 px-4 py-1.5 text-xs font-bold text-black shadow-lg sm:bottom-20 sm:text-sm lg:bottom-4">
      Offline — scores will sync when connected
    </div>
  ) : null;

  // ─── Render a single snake cell with skin ───
  const renderSnakeCell = (x: number, y: number) => {
    const idx = snakeIndexMap.get(`${x}:${y}`);
    if (idx === undefined) return null;
    const isHead = idx === 0;
    const isTail = idx === snake.length - 1;
    const skin = activeSkin;

    if (isHead) {
      const dir = pendingDirectionRef.current;
      const radius = getSegmentRadius(snake, idx, cellPct);
      let eye1Style: React.CSSProperties = {};
      let eye2Style: React.CSSProperties = {};
      const eyeSize = "20%";

      if (dir === "right") {
        eye1Style = { top: "20%", right: "15%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "20%", right: "15%", width: eyeSize, height: eyeSize };
      } else if (dir === "left") {
        eye1Style = { top: "20%", left: "15%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "20%", left: "15%", width: eyeSize, height: eyeSize };
      } else if (dir === "up") {
        eye1Style = { top: "15%", left: "20%", width: eyeSize, height: eyeSize };
        eye2Style = { top: "15%", right: "20%", width: eyeSize, height: eyeSize };
      } else {
        eye1Style = { bottom: "15%", left: "20%", width: eyeSize, height: eyeSize };
        eye2Style = { bottom: "15%", right: "20%", width: eyeSize, height: eyeSize };
      }

      return (
        <div
          className="relative"
          style={{
            width: "92%",
            height: "92%",
            background: skin.headGradient,
            borderRadius: radius,
            boxShadow: `0 0 8px ${skin.glowColor}`,
          }}
        >
          <div className="absolute rounded-full bg-white" style={eye1Style}>
            <div className="absolute inset-[20%] rounded-full" style={{ background: skin.eyeBg }} />
          </div>
          <div className="absolute rounded-full bg-white" style={eye2Style}>
            <div className="absolute inset-[20%] rounded-full" style={{ background: skin.eyeBg }} />
          </div>
        </div>
      );
    }

    if (isTail) {
      const prev = snake[idx - 1];
      const dx = prev.x - snake[idx].x;
      const dy = prev.y - snake[idx].y;
      let clipPath = "";
      if (dx > 0) clipPath = "polygon(30% 15%, 100% 0%, 100% 100%, 30% 85%)";
      else if (dx < 0) clipPath = "polygon(0% 0%, 70% 15%, 70% 85%, 0% 100%)";
      else if (dy > 0) clipPath = "polygon(15% 30%, 85% 30%, 100% 100%, 0% 100%)";
      else clipPath = "polygon(0% 0%, 100% 0%, 85% 70%, 15% 70%)";

      const radius = getSegmentRadius(snake, idx, cellPct);
      const t = idx / snake.length;

      return (
        <div
          style={{
            width: "88%",
            height: "88%",
            background: skin.tailColor(t),
            borderRadius: radius,
            clipPath,
            opacity: 0.7,
          }}
        />
      );
    }

    const t = idx / snake.length;
    const radius = getSegmentRadius(snake, idx, cellPct);

    return (
      <div
        style={{
          width: "92%",
          height: "92%",
          background: skin.bodyColor(t, idx),
          borderRadius: radius,
          boxShadow: idx < 3 ? `0 0 4px ${skin.glowColor.replace("0.6", "0.3")}` : "none",
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
          <span className="text-[20px] font-bold uppercase tracking-wider text-[#39ff14] sm:text-[20px]">
            {difficulty === "hard" ? "HARD" : "EASY"}
          </span>
        </div>
      )}

      {/* Coin balance overlay */}
      {isRunning && !gameOver && (
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full bg-[#0d1117]/80 px-2.5 py-0.5 backdrop-blur sm:right-3 sm:top-3 sm:px-3 sm:py-1">
          <span className="text-[20px] sm:text-xl">🪙</span>
          <span className="text-[20px] font-bold text-yellow-400 sm:text-[20px]">{coinBalance + score}</span>
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
          const isBonus = bonusApple !== null && bonusApple.x === x && bonusApple.y === y;
          const isObstacle = obstacleSet.has(key);

          return (
            <div key={key} className="flex items-center justify-center">
              {isSnake ? (
                renderSnakeCell(x, y)
              ) : isBonus ? (
                <div
                  className="animate-bounce flex items-center justify-center"
                  style={{ width: "100%", height: "100%", fontSize: "min(5.5vw, 2rem)", lineHeight: 1 }}
                >
                  <span style={{ filter: "drop-shadow(0 0 8px rgba(255,215,0,0.8)) drop-shadow(0 0 16px rgba(255,215,0,0.4))" }}>🍎</span>
                  <span className="absolute text-[7px] font-black text-yellow-300 sm:text-[9px]" style={{ bottom: "0%", textShadow: "0 0 4px rgba(0,0,0,0.8)" }}>+10</span>
                </div>
              ) : isFood ? (
                <div className="flex items-center justify-center" style={{ width: "95%", height: "95%", fontSize: "min(4.5vw, 1.5rem)", lineHeight: 1 }}>
                  <span style={{ filter: "drop-shadow(0 0 4px rgba(255,0,0,0.5))" }}>🍎</span>
                </div>
              ) : isObstacle ? (
                <div
                  style={{
                    width: "85%",
                    height: "85%",
                    borderRadius: "3px",
                    background: "linear-gradient(135deg, #4a3728 0%, #2d1f14 50%, #3e2c1e 100%)",
                    boxShadow: "inset 1px 1px 2px rgba(255,255,255,0.1), inset -1px -1px 2px rgba(0,0,0,0.3)",
                    border: "1px solid #1a1008",
                  }}
                />
              ) : (
                <div className="h-[3px] w-[3px] rounded-full bg-[#162016] sm:h-1 sm:w-1" />
              )}
            </div>
          );
        })}
      </div>

      {bonusCelebration && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div className="animate-bounce text-center">
            <span className="text-5xl drop-shadow-[0_0_12px_rgba(255,215,0,0.8)] sm:text-6xl">😄</span>
            <p className="mt-1 text-sm font-black text-yellow-300 drop-shadow-[0_0_6px_rgba(0,0,0,0.8)] sm:text-base">+10 Coins!</p>
          </div>
        </div>
      )}

      {gameOver && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/75 backdrop-blur-sm">
          <p className="text-4xl font-black uppercase tracking-wider text-[#39ff14] drop-shadow-[0_0_10px_rgba(57,255,20,0.5)] sm:text-4xl">Game Over</p>
          <p className="text-2xl font-semibold text-[#39ff14]/70 sm:text-2xl">{playerName}</p>
          <p className="text-sm text-white sm:text-lg">Score: {score} | Level: {level}</p>
          <p className="text-xl text-yellow-400">+{score} coins earned!</p>
          <button
            onClick={resetGame}
            className="mt-2 rounded-xl bg-[#39ff14] px-5 py-2 text-xs font-bold text-black transition active:scale-95 sm:px-8 sm:text-lg"
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
        <span className="rounded-full bg-[#39ff14]/10 px-2 py-0.5 text-xs font-bold text-[#39ff14]">
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
                  "flex h-6 w-6 items-center justify-center rounded-lg text-xs font-black sm:h-7 sm:w-7 sm:text-xs",
                  index === 0 ? "bg-[#39ff14] text-black" : index === 1 ? "bg-gray-600 text-white" : index === 2 ? "bg-amber-700 text-white" : "bg-[#1f2a1f] text-gray-400",
                ].join(" ")}>
                  {index + 1}
                </span>
                <span className="text-xs font-bold text-white sm:text-sm">{entry.name}</span>
              </div>
              <div className="text-right">
                <p className="text-xs font-bold text-[#39ff14] sm:text-sm">{entry.bestScore.toLocaleString()}</p>
                <p className="text-xs text-gray-500 sm:text-sm">LVL {entry.level}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  // ─── Shop panel ───
  const shopPanel = (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-black uppercase tracking-wider text-[#39ff14] sm:text-lg">Skin Shop</h2>
        <div className="flex items-center gap-1.5 rounded-full bg-yellow-500/10 px-3 py-1">
          <span className="text-xl">🪙</span>
          <span className="text-xl font-black text-yellow-400">{coinBalance}</span>
        </div>
      </div>
      <p className="text-[20px] text-gray-500">Earn coins by scoring points. Coins are awarded after each game.</p>
      <div className="space-y-2">
        {SNAKE_SKINS.map((skin) => {
          const owned = purchasedSkins.includes(skin.id);
          const isActive = activeSkinId === skin.id;
          const canAfford = coinBalance >= skin.cost;

          return (
            <div
              key={skin.id}
              className={[
                "flex items-center justify-between rounded-xl px-3 py-2.5 transition",
                isActive ? "border border-[#39ff14]/40 bg-[#39ff14]/10" : "bg-[#1a1f1a]",
              ].join(" ")}
            >
              <div className="flex items-center gap-3">
                {/* Skin preview: small snake segment */}
                <div
                  className="h-8 w-8 rounded-lg sm:h-9 sm:w-9"
                  style={{ background: skin.headGradient, boxShadow: `0 0 6px ${skin.glowColor}` }}
                />
                <div>
                  <p className="text font-bold text-white sm:text">{skin.name}</p>
                  {!owned && (
                    <p className="flex items-center gap-1 text-[20px] text-yellow-400">
                      <span>🪙</span> {skin.cost}
                    </p>
                  )}
                  {owned && !isActive && (
                    <p className="text-[15px] text-gray-500">Owned</p>
                  )}
                  {isActive && (
                    <p className="text-[15px] font-bold text-[#39ff14]">Equipped</p>
                  )}
                </div>
              </div>

              {!owned ? (
                <button
                  onClick={() => buySkin(skin.id)}
                  disabled={!canAfford}
                  className="rounded-lg bg-yellow-500 px-3 py-1.5 text-[15px] font-bold text-black transition active:scale-95 disabled:opacity-30 sm:text"
                >
                  Buy
                </button>
              ) : !isActive ? (
                <button
                  onClick={() => selectSkin(skin.id)}
                  className="rounded-lg border border-[#39ff14]/30 px-3 py-1.5 text-[15px] font-bold text-[#39ff14] transition active:scale-95 sm:text"
                >
                  Equip
                </button>
              ) : (
                <span className="rounded-lg bg-[#39ff14]/20 px-3 py-1.5 text-xs font-bold text-[#39ff14] sm:text-xs">Active</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── NAME ENTRY SCREEN ───
  if (screen === "name") {
    return (
      <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#0d1117] px-4 py-6">
        {updateBanner}
        {offlineBadge}
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
            <p className="mt-1 text-xs uppercase tracking-[0.25em] text-gray-500 sm:text-xs">Arcade Snake</p>
          </div>

          {/* Coin balance */}
          <div className="flex items-center gap-2 rounded-full bg-yellow-500/10 px-4 py-1.5">
            <span className="text-base">🪙</span>
            <span className="text-base font-black text-yellow-400">{coinBalance}</span>
            <span className="text-xs text-gray-500">coins</span>
          </div>

          <div className="w-full space-y-2">
            <label htmlFor="player-name" className="block text-xs font-bold uppercase tracking-wider text-gray-400 sm:text-xs">
              Username
            </label>
            <input
              ref={nameInputRef}
              id="player-name"
              type="text"
              maxLength={20}
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") startGame(); }}
              placeholder="Enter username..."
              autoFocus
              className="w-full rounded-xl border border-[#39ff14]/20 bg-[#0a0f0a] px-4 py-2.5 text-base font-bold text-[#39ff14] outline-none transition placeholder:text-gray-600 focus:border-[#39ff14]/50 focus:shadow-[0_0_15px_rgba(57,255,20,0.1)] sm:py-3 sm:text-lg"
            />
          </div>

          {/* Difficulty selection */}
          <div className="w-full space-y-2">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-400 sm:text-xs">Difficulty</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setDifficulty("easy")}
                className={[
                  "rounded-xl px-3 py-2.5 text-sm font-bold transition active:scale-95",
                  difficulty === "easy"
                    ? "bg-[#39ff14] text-black shadow-[0_0_15px_rgba(57,255,20,0.3)]"
                    : "border border-[#39ff14]/20 bg-[#0a0f0a] text-gray-400",
                ].join(" ")}
              >
                Easy
              </button>
              <button
                onClick={() => setDifficulty("hard")}
                className={[
                  "rounded-xl px-3 py-2.5 text-sm font-bold transition active:scale-95",
                  difficulty === "hard"
                    ? "bg-red-500 text-white shadow-[0_0_15px_rgba(239,68,68,0.3)]"
                    : "border border-red-500/20 bg-[#0a0f0a] text-gray-400",
                ].join(" ")}
              >
                Hard
              </button>
            </div>
            <p className="text-center text-xs text-gray-600">
              {difficulty === "easy" ? "Normal speed, no obstacles" : "Faster speed + obstacles that increase each level"}
            </p>
          </div>

          <button
            onClick={startGame}
            disabled={!playerName.trim()}
            className="w-full rounded-2xl bg-[#39ff14] px-6 py-3 text-base font-black uppercase text-black shadow-[0_0_20px_rgba(57,255,20,0.3)] transition hover:shadow-[0_0_30px_rgba(57,255,20,0.5)] active:scale-95 disabled:opacity-30 disabled:shadow-none sm:py-3.5 sm:text-lg"
          >
            Play Game
          </button>

          {/* Skin Shop button */}
          <button
            onClick={() => setScreen("shop")}
            className="w-full rounded-2xl border border-yellow-500/30 bg-yellow-500/10 px-6 py-2.5 text-sm font-bold text-yellow-400 transition active:scale-95 sm:text-base"
          >
            🐍 Skin Shop
          </button>

          <div className="grid w-full grid-cols-2 gap-3 text-center">
            <div className="rounded-xl border border-[#39ff14]/10 bg-[#0a0f0a] px-3 py-2.5">
              <p className="text-base font-black text-[#39ff14] sm:text-lg">20</p>
              <p className="text-xs uppercase tracking-wider text-gray-500 sm:text-sm">Levels</p>
            </div>
            <div className="rounded-xl border border-[#39ff14]/10 bg-[#0a0f0a] px-3 py-2.5">
              <p className="text-base font-black text-[#39ff14] sm:text-lg">{bestScore.toLocaleString()}</p>
              <p className="text-xs uppercase tracking-wider text-gray-500 sm:text-sm">Best Score</p>
            </div>
          </div>
        </div>
      </main>
    );
  }

  // ─── SHOP SCREEN ───
  if (screen === "shop") {
    return (
      <main className="relative flex min-h-[100dvh] flex-col items-center overflow-y-auto bg-[#0d1117] px-4 py-6">
        {updateBanner}
        {offlineBadge}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(57,255,20,0.03)_1px,transparent_1px),linear-gradient(to_bottom,rgba(57,255,20,0.03)_1px,transparent_1px)] bg-[size:40px_40px]" />

        <div className="relative w-full max-w-sm">
          <button
            onClick={() => setScreen("name")}
            className="mb-4 flex items-center gap-2 text-sm font-bold text-gray-400 transition hover:text-white"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><path d="M19 12H5m7-7-7 7 7 7"/></svg>
            Back
          </button>
          {shopPanel}
        </div>
      </main>
    );
  }

  // ─── GAME SCREEN ───
  return (
    <main className="relative flex h-[100vh] flex-col bg-[#0d1117] text-white">
      {updateBanner}
        {offlineBadge}
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
          className={["flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition sm:h-9 sm:w-9 sm:text-xs", solidWalls ? "text-[#39ff14]" : "text-gray-500"].join(" ")}
          title={solidWalls ? "Solid walls ON" : "Wrap-around"}
        >
          Wall
        </button>
      </header>

      {/* ── Desktop layout (lg+): game board full + sidebar ── */}
      <div className="relative z-10 hidden min-h-0 flex-1 gap-4 px-4 pb-4 lg:flex">
        <div className="flex flex-1 items-center justify-center">
          <div className="h-full max-h-full" style={{ aspectRatio: "1" }}>
            {gameBoard}
          </div>
        </div>

        {/* Desktop sidebar */}
        <aside className="flex w-72 flex-shrink-0 flex-col gap-3 overflow-y-auto xl:w-80">
          <div className="flex items-center justify-between rounded-xl bg-[#1a1f1a] px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-white">{playerName}</span>
              {difficulty === "hard" && <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[11px] font-bold text-red-400">HARD</span>}
            </div>
            <div className="flex items-center gap-2">
              {boosting && <span className="animate-pulse rounded-full bg-orange-500/20 px-2 py-0.5 text-xs font-bold text-orange-400">BOOST</span>}
              <div className="flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5">
                <span className="text-xs">🪙</span>
                <span className="text-xs font-bold text-yellow-400">{coinBalance}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[#1a1f1a] px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Score</p>
              <p className="text-2xl font-black text-[#39ff14] drop-shadow-[0_0_6px_rgba(57,255,20,0.3)]">{score.toLocaleString()}</p>
            </div>
            <div className="rounded-xl bg-[#1a1f1a] px-4 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Level</p>
              <div className="flex items-end justify-between">
                <p className="text-2xl font-black text-cyan-400">{String(level).padStart(2, "0")}</p>
                <span className="text-xs font-bold uppercase text-cyan-400/60">{levelTitle(level)}</span>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-3 rounded-xl bg-[#1a1f1a] px-4 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-500/10">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 text-orange-400"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Speed</p>
                <p className="text-base font-black text-orange-400">{Math.round((1000 / speed) * 10) / 10}x</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-[#1a1f1a] px-4 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#39ff14]/10">
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[#39ff14]"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
              </div>
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Best</p>
                <p className="text-base font-black text-[#39ff14]">{bestScore.toLocaleString()}</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 px-0.5">
            <span className="text-xs font-bold text-gray-500">LVL {level}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1f1a]">
              <div className="h-full rounded-full bg-gradient-to-r from-[#39ff14] to-[#70e000] transition-all duration-300" style={{ width: level >= MAX_LEVEL ? "100%" : `${(applesInLevel / APPLES_PER_LEVEL) * 100}%` }} />
            </div>
            <span className="text-xs font-bold text-gray-500">{level >= MAX_LEVEL ? "MAX" : `LVL ${level + 1}`}</span>
          </div>

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

          <p className="text-center text-xs text-gray-600">Arrow keys / WASD to move, hold to boost, Space to pause</p>

          {leaderboardPanel}
        </aside>
      </div>

      {/* ── Mobile/tablet layout (below lg) ── */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-20 sm:gap-3 sm:px-4 sm:pb-24 lg:hidden">
        {mobileTab === "play" ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div className="rounded-xl bg-[#1a1f1a] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 sm:text-sm">Current Score</p>
                <div className="flex items-end justify-between">
                  <p className="text-xl font-black text-[#39ff14] drop-shadow-[0_0_6px_rgba(57,255,20,0.3)] sm:text-3xl">
                    {score.toLocaleString()}
                  </p>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 text-[#39ff14]/30 sm:h-5 sm:w-5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
              </div>
              <div className="rounded-xl bg-[#1a1f1a] px-3 py-2 sm:rounded-2xl sm:px-4 sm:py-3">
                <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 sm:text-sm">Level</p>
                <div className="flex items-end justify-between">
                  <p className="text-xl font-black text-cyan-400 sm:text-3xl">{String(level).padStart(2, "0")}</p>
                  <span className="text-[11px] font-bold uppercase text-cyan-400/60 sm:text-sm">{levelTitle(level)}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:gap-3">
              <div className="flex items-center gap-2 rounded-xl bg-[#1a1f1a] px-3 py-2 sm:gap-3 sm:rounded-2xl sm:px-4 sm:py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/10 sm:h-8 sm:w-8">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-3.5 w-3.5 text-orange-400 sm:h-4 sm:w-4"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 sm:text-sm">Speed</p>
                  <p className="text-sm font-black text-orange-400 sm:text-base">{Math.round((1000 / speed) * 10) / 10}x</p>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-xl bg-[#1a1f1a] px-3 py-2 sm:gap-3 sm:rounded-2xl sm:px-4 sm:py-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-yellow-500/10 sm:h-8 sm:w-8">
                  <span className="text-sm">🪙</span>
                </div>
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500 sm:text-sm">Coins</p>
                  <p className="text-sm font-black text-yellow-400 sm:text-base">{coinBalance}</p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 px-0.5">
              <span className="text-[11px] font-bold text-gray-500 sm:text-sm">LVL {level}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#1a1f1a] sm:h-1.5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#39ff14] to-[#70e000] transition-all duration-300"
                  style={{ width: level >= MAX_LEVEL ? "100%" : `${(applesInLevel / APPLES_PER_LEVEL) * 100}%` }}
                />
              </div>
              <span className="text-[11px] font-bold text-gray-500 sm:text-sm">
                {level >= MAX_LEVEL ? "MAX" : `LVL ${level + 1}`}
              </span>
            </div>

            {boosting && (
              <div className="flex items-center justify-center">
                <span className="animate-pulse rounded-full bg-orange-500/20 px-3 py-1 text-xs font-bold uppercase tracking-wider text-orange-400">Boost Active</span>
              </div>
            )}

            <div className="flex min-h-0 flex-1 items-center justify-center">
              <div className="h-full max-h-full w-full" style={{ aspectRatio: "1", maxWidth: "100%" }}>
                {gameBoard}
              </div>
            </div>

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
        ) : mobileTab === "ranks" ? (
          <div className="py-2">{leaderboardPanel}</div>
        ) : (
          <div className="py-2">{shopPanel}</div>
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
          <span className="text-xs font-bold uppercase sm:text-sm">Play</span>
        </button>

        <button
          onClick={() => setMobileTab("shop")}
          className={["flex flex-col items-center gap-0.5 transition", mobileTab === "shop" ? "text-yellow-400" : "text-gray-500"].join(" ")}
        >
          {mobileTab === "shop" ? (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.3)] sm:h-12 sm:w-12 sm:rounded-2xl">
              <span className="text-lg">🐍</span>
            </div>
          ) : (
            <span className="text-xl sm:text-2xl">🐍</span>
          )}
          <span className="text-xs font-bold uppercase sm:text-sm">Skins</span>
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
          <span className="text-xs font-bold uppercase sm:text-sm">Ranks</span>
        </button>
      </nav>
    </main>
  );
}
