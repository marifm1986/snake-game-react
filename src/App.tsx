import { useEffect, useMemo, useRef, useState } from "react";

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

  const queueDirection = (next: Direction) => {
    const current = pendingDirectionRef.current;
    if (OPPOSITE[current] === next) {
      return;
    }
    pendingDirectionRef.current = next;
    setDirection(next);
  };

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
  }, [gameOver]);

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

  return (
    <main className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_#fdf2e9,_#ffd7a8_45%,_#f4a261_100%)] px-4 py-8 text-stone-900 sm:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.15)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.15)_1px,transparent_1px)] bg-[size:38px_38px] opacity-30" />

      <section className="relative mx-auto flex w-full max-w-5xl flex-col gap-6 rounded-3xl border border-amber-100/70 bg-[#fff7ec]/85 p-5 shadow-[0_18px_60px_rgba(134,71,26,0.2)] backdrop-blur md:p-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-amber-800/80">Arcade Classic</p>
            <h1 className="text-4xl font-black uppercase leading-none text-amber-950 sm:text-5xl">Snake</h1>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-sm sm:text-base">
            <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-amber-700">Score</p>
              <p className="text-xl font-bold">{score}</p>
            </div>
            <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-amber-700">Best</p>
              <p className="text-xl font-bold">{bestScore}</p>
            </div>
            <div className="rounded-xl bg-white px-3 py-2 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-amber-700">Speed</p>
              <p className="text-xl font-bold">{Math.round((1000 / speed) * 10) / 10}x</p>
            </div>
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              if (gameOver) {
                resetGame();
                return;
              }
              setIsRunning((running) => !running);
            }}
            className="rounded-xl bg-amber-600 px-4 py-2 font-semibold text-white transition hover:bg-amber-700"
          >
            {gameOver ? "Reset" : isRunning ? "Pause" : "Start"}
          </button>
          <button
            onClick={resetGame}
            className="rounded-xl border border-amber-700/30 bg-white px-4 py-2 font-semibold text-amber-900 transition hover:bg-amber-50"
          >
            New Game
          </button>
          <label className="ml-auto flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-medium shadow-sm">
            <input
              type="checkbox"
              checked={solidWalls}
              onChange={(event) => setSolidWalls(event.target.checked)}
              className="h-4 w-4 accent-amber-700"
            />
            Solid walls
          </label>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(280px,1fr)_220px]">
          <div className="relative aspect-square w-full max-w-[600px] overflow-hidden rounded-2xl border-4 border-amber-900/20 bg-[#1f1308] p-2 shadow-inner">
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
                <p className="text-3xl font-black uppercase tracking-wider">Game Over</p>
                <p className="mt-2 text-lg">Final score: {score}</p>
                <p className="text-sm text-amber-200">Press Reset or Space to play again</p>
              </div>
            )}
          </div>

          <aside className="space-y-3 rounded-2xl border border-amber-900/15 bg-white/90 p-4">
            <h2 className="text-lg font-bold uppercase tracking-wide text-amber-900">Controls</h2>
            <p className="text-sm text-stone-700">Arrow keys / WASD to move, Space to pause.</p>
            <div className="mx-auto grid w-36 grid-cols-3 gap-2">
              <div />
              <button
                onClick={() => queueDirection("up")}
                className="rounded-lg bg-amber-100 p-2 text-xl font-bold text-amber-900 hover:bg-amber-200"
              >
                ↑
              </button>
              <div />
              <button
                onClick={() => queueDirection("left")}
                className="rounded-lg bg-amber-100 p-2 text-xl font-bold text-amber-900 hover:bg-amber-200"
              >
                ←
              </button>
              <button
                onClick={() => queueDirection("down")}
                className="rounded-lg bg-amber-100 p-2 text-xl font-bold text-amber-900 hover:bg-amber-200"
              >
                ↓
              </button>
              <button
                onClick={() => queueDirection("right")}
                className="rounded-lg bg-amber-100 p-2 text-xl font-bold text-amber-900 hover:bg-amber-200"
              >
                →
              </button>
            </div>
            <p className="text-xs text-stone-600">
              Wall mode: <span className="font-semibold">{solidWalls ? "Solid" : "Wrap-around"}</span>. Speed increases
              every {SPEED_EVERY} apples.
            </p>
          </aside>
        </div>
      </section>
    </main>
  );
}
