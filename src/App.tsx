import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Point = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";

const GRID_SIZE = 20;
const BASE_SPEED = 180;
const MIN_SPEED = 70;
const SPEED_STEP = 8;
const SPEED_EVERY = 4;

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

function clampSpeed(score: number) {
  const levels = Math.floor(score / SPEED_EVERY);
  return Math.max(MIN_SPEED, BASE_SPEED - levels * SPEED_STEP);
}

const SWIPE_THRESHOLD = 20;

export function App() {
  const [snake, setSnake] = useState<Point[]>(START_SNAKE);
  const [food, setFood] = useState<Point>(() => randomFood(new Set(START_SNAKE.map(toKey))));
  const [direction, setDirection] = useState<Direction>("right");
  const [isRunning, setIsRunning] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [solidWalls, setSolidWalls] = useState(true);

  const directionRef = useRef<Direction>("right");
  const pendingDirectionRef = useRef<Direction>("right");
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const speed = clampSpeed(score);

  useEffect(() => {
    const storedBest = window.localStorage.getItem("snake-best-score");
    if (storedBest) {
      setBestScore(Number(storedBest) || 0);
    }
  }, []);

  useEffect(() => {
    directionRef.current = direction;
    pendingDirectionRef.current = direction;
  }, [direction]);

  useEffect(() => {
    if (score > bestScore) {
      setBestScore(score);
      window.localStorage.setItem("snake-best-score", String(score));
    }
  }, [score, bestScore]);

  const resetGame = () => {
    setSnake(START_SNAKE);
    setDirection("right");
    directionRef.current = "right";
    pendingDirectionRef.current = "right";
    setFood(randomFood(new Set(START_SNAKE.map(toKey))));
    setScore(0);
    setGameOver(false);
    setIsRunning(false);
  };

  const queueDirection = useCallback((next: Direction) => {
    const current = pendingDirectionRef.current;
    if (OPPOSITE[current] === next) {
      return;
    }
    pendingDirectionRef.current = next;
    setDirection(next);
  }, []);

  // Keyboard controls
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keyMap: Record<string, Direction> = {
        ArrowUp: "up",
        w: "up",
        W: "up",
        ArrowDown: "down",
        s: "down",
        S: "down",
        ArrowLeft: "left",
        a: "left",
        A: "left",
        ArrowRight: "right",
        d: "right",
        D: "right",
      };

      if (event.code === "Space") {
        event.preventDefault();
        if (gameOver) {
          resetGame();
        } else {
          setIsRunning((running) => !running);
        }
        return;
      }

      const next = keyMap[event.key];
      if (next) {
        event.preventDefault();
        queueDirection(next);
        if (!gameOver) {
          setIsRunning(true);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gameOver, queueDirection]);

  // Touch swipe controls on the game board
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!touchStartRef.current) return;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartRef.current.x;
      const dy = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return;

      let next: Direction;
      if (Math.abs(dx) > Math.abs(dy)) {
        next = dx > 0 ? "right" : "left";
      } else {
        next = dy > 0 ? "down" : "up";
      }

      queueDirection(next);
      if (!gameOver) {
        setIsRunning(true);
      }
    };

    board.addEventListener("touchstart", onTouchStart, { passive: true });
    board.addEventListener("touchmove", onTouchMove, { passive: false });
    board.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      board.removeEventListener("touchstart", onTouchStart);
      board.removeEventListener("touchmove", onTouchMove);
      board.removeEventListener("touchend", onTouchEnd);
    };
  }, [gameOver, queueDirection]);

  // Prevent pull-to-refresh and bounce scrolling on mobile
  useEffect(() => {
    const preventScroll = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        e.preventDefault();
      }
    };
    document.body.addEventListener("touchmove", preventScroll, { passive: false });
    return () => document.body.removeEventListener("touchmove", preventScroll);
  }, []);

  // Game loop
  useEffect(() => {
    if (!isRunning || gameOver) {
      return;
    }

    const timer = window.setInterval(() => {
      const activeDirection = pendingDirectionRef.current;
      directionRef.current = activeDirection;
      const vector = DIRECTION_VECTORS[activeDirection];

      setSnake((currentSnake) => {
        const head = currentSnake[0];
        let nextHead: Point = { x: head.x + vector.x, y: head.y + vector.y };

        if (!solidWalls) {
          nextHead = {
            x: (nextHead.x + GRID_SIZE) % GRID_SIZE,
            y: (nextHead.y + GRID_SIZE) % GRID_SIZE,
          };
        }

        if (
          solidWalls &&
          (nextHead.x < 0 || nextHead.y < 0 || nextHead.x >= GRID_SIZE || nextHead.y >= GRID_SIZE)
        ) {
          setGameOver(true);
          setIsRunning(false);
          return currentSnake;
        }

        const ateFood = nextHead.x === food.x && nextHead.y === food.y;
        const nextSnake = [nextHead, ...currentSnake];

        if (!ateFood) {
          nextSnake.pop();
        }

        const hitSelf = nextSnake.slice(1).some((segment) => segment.x === nextHead.x && segment.y === nextHead.y);
        if (hitSelf) {
          setGameOver(true);
          setIsRunning(false);
          return currentSnake;
        }

        if (ateFood) {
          setScore((value) => value + 1);
          setFood(randomFood(new Set(nextSnake.map(toKey))));
        }

        return nextSnake;
      });
    }, speed);

    return () => window.clearInterval(timer);
  }, [food, gameOver, isRunning, solidWalls, speed]);

  const snakeMap = useMemo(() => new Set(snake.map(toKey)), [snake]);

  const handleDirButton = (dir: Direction) => {
    queueDirection(dir);
    if (!gameOver) {
      setIsRunning(true);
    }
  };

  return (
    <main className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_#fdf2e9,_#ffd7a8_45%,_#f4a261_100%)] px-2 py-4 text-stone-900 sm:px-4 sm:py-8 md:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.15)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.15)_1px,transparent_1px)] bg-[size:38px_38px] opacity-30" />

      <section className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col gap-3 rounded-2xl border border-amber-100/70 bg-[#fff7ec]/85 p-3 shadow-[0_18px_60px_rgba(134,71,26,0.2)] backdrop-blur sm:gap-6 sm:rounded-3xl sm:p-5 md:p-8">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-2 sm:gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.22em] text-amber-800/80 sm:text-sm">Arcade Classic</p>
            <h1 className="text-2xl font-black uppercase leading-none text-amber-950 sm:text-4xl md:text-5xl">Snake</h1>
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-center text-xs sm:gap-2 sm:text-base">
            <div className="rounded-lg bg-white px-2 py-1.5 shadow-sm sm:rounded-xl sm:px-3 sm:py-2">
              <p className="text-[9px] uppercase tracking-wider text-amber-700 sm:text-xs">Score</p>
              <p className="text-base font-bold sm:text-xl">{score}</p>
            </div>
            <div className="rounded-lg bg-white px-2 py-1.5 shadow-sm sm:rounded-xl sm:px-3 sm:py-2">
              <p className="text-[9px] uppercase tracking-wider text-amber-700 sm:text-xs">Best</p>
              <p className="text-base font-bold sm:text-xl">{bestScore}</p>
            </div>
            <div className="rounded-lg bg-white px-2 py-1.5 shadow-sm sm:rounded-xl sm:px-3 sm:py-2">
              <p className="text-[9px] uppercase tracking-wider text-amber-700 sm:text-xs">Speed</p>
              <p className="text-base font-bold sm:text-xl">{Math.round((1000 / speed) * 10) / 10}x</p>
            </div>
          </div>
        </header>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button
            onClick={() => {
              if (gameOver) {
                resetGame();
                return;
              }
              setIsRunning((running) => !running);
            }}
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-amber-700 active:scale-95 sm:rounded-xl sm:px-4 sm:py-2 sm:text-base"
          >
            {gameOver ? "Reset" : isRunning ? "Pause" : "Start"}
          </button>
          <button
            onClick={resetGame}
            className="rounded-lg border border-amber-700/30 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 transition hover:bg-amber-50 active:scale-95 sm:rounded-xl sm:px-4 sm:py-2 sm:text-base"
          >
            New Game
          </button>
          <label className="ml-auto flex items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-xs font-medium shadow-sm sm:gap-2 sm:rounded-xl sm:px-3 sm:py-2 sm:text-sm">
            <input
              type="checkbox"
              checked={solidWalls}
              onChange={(event) => setSolidWalls(event.target.checked)}
              className="h-3.5 w-3.5 accent-amber-700 sm:h-4 sm:w-4"
            />
            Solid walls
          </label>
        </div>

        {/* Game area */}
        <div className="flex flex-1 flex-col gap-3 lg:flex-row lg:gap-6">
          {/* Game board */}
          <div className="flex flex-1 items-center justify-center">
            <div
              ref={boardRef}
              className="relative aspect-square w-full max-w-[min(100%,600px)] overflow-hidden rounded-xl border-4 border-amber-900/20 bg-[#1f1308] p-1.5 shadow-inner sm:rounded-2xl sm:p-2"
              style={{ touchAction: "none" }}
            >
              <div
                className="grid h-full w-full gap-px rounded-lg bg-[#3d2715]/40"
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
                    <div
                      key={key}
                      className={[
                        "rounded-[2px] transition-colors duration-75",
                        isHead && "bg-[#9ef01a]",
                        !isHead && isBody && "bg-[#70e000]",
                        isFood && "bg-[#ff4d6d]",
                        !isBody && !isFood && "bg-[#2f1d0f]",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    />
                  );
                })}
              </div>
              {gameOver && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 text-center text-white">
                  <p className="text-xl font-black uppercase tracking-wider sm:text-3xl">Game Over</p>
                  <p className="mt-1 text-sm sm:mt-2 sm:text-lg">Final score: {score}</p>
                  <p className="text-xs text-amber-200 sm:text-sm">Tap Reset or swipe to play again</p>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar / Controls */}
          <aside className="flex flex-col gap-3 lg:w-56">
            {/* D-pad controls - always visible, extra useful on mobile */}
            <div className="rounded-xl border border-amber-900/15 bg-white/90 p-3 sm:rounded-2xl sm:p-4">
              <h2 className="mb-2 text-center text-sm font-bold uppercase tracking-wide text-amber-900 sm:text-lg">Controls</h2>
              <div className="mx-auto grid w-40 grid-cols-3 gap-2 sm:w-36">
                <div />
                <button
                  onClick={() => handleDirButton("up")}
                  className="flex h-12 items-center justify-center rounded-xl bg-amber-100 text-xl font-bold text-amber-900 transition hover:bg-amber-200 active:scale-90 active:bg-amber-300 sm:h-auto sm:p-2"
                >
                  ↑
                </button>
                <div />
                <button
                  onClick={() => handleDirButton("left")}
                  className="flex h-12 items-center justify-center rounded-xl bg-amber-100 text-xl font-bold text-amber-900 transition hover:bg-amber-200 active:scale-90 active:bg-amber-300 sm:h-auto sm:p-2"
                >
                  ←
                </button>
                <button
                  onClick={() => handleDirButton("down")}
                  className="flex h-12 items-center justify-center rounded-xl bg-amber-100 text-xl font-bold text-amber-900 transition hover:bg-amber-200 active:scale-90 active:bg-amber-300 sm:h-auto sm:p-2"
                >
                  ↓
                </button>
                <button
                  onClick={() => handleDirButton("right")}
                  className="flex h-12 items-center justify-center rounded-xl bg-amber-100 text-xl font-bold text-amber-900 transition hover:bg-amber-200 active:scale-90 active:bg-amber-300 sm:h-auto sm:p-2"
                >
                  →
                </button>
              </div>
              <p className="mt-2 text-center text-[10px] text-stone-500 sm:text-xs">Swipe on board or use buttons</p>
            </div>

            {/* Info */}
            <div className="rounded-xl border border-amber-900/15 bg-white/90 p-3 text-xs text-stone-600 sm:rounded-2xl sm:p-4 sm:text-xs">
              <p>
                Wall mode: <span className="font-semibold">{solidWalls ? "Solid" : "Wrap-around"}</span>
              </p>
              <p>Speed increases every {SPEED_EVERY} apples.</p>
              <p className="mt-1 hidden text-stone-400 sm:block">Keyboard: Arrow keys / WASD, Space to pause.</p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
