interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  alpha: number;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let raf: number | null = null;
let lastTime = 0;
let resizeRaf: number | null = null;

function ensureCanvas(): void {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.id = "particles-canva";
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "2147483647",
  });
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d")!;
  syncSize();
  window.addEventListener("resize", onResize, { passive: true });
}

function onResize(): void {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    syncSize();
  });
}

function syncSize(): void {
  if (!canvas) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function spawnBurst(x: number, y: number): void {
  const count = 12 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const speed = 100 + Math.random() * 160;
    const life = 0.35 + Math.random() * 0.3;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      size: 1 + Math.random(),
      alpha: 1,
    });
  }
}

function tick(time: number): void {
  if (!ctx || !canvas) return;
  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";

  const len = particles.length;
  let alive = 0;

  for (let i = 0; i < len; i++) {
    const p = particles[i]!;
    p.life -= dt;
    if (p.life <= 0) continue;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 3.5 * dt;
    p.vy *= 1 - 3.5 * dt;

    const t = p.life / p.maxLife;
    ctx.globalAlpha = t;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * t, 0, Math.PI * 2);
    ctx.fill();

    if (alive !== i) particles[alive] = p;
    alive++;
  }

  if (alive < len) particles.length = alive;
  ctx.globalAlpha = 1;

  if (alive > 0) {
    raf = requestAnimationFrame(tick);
  } else {
    raf = null;
  }
}

function onClick(e: MouseEvent): void {
  ensureCanvas();
  spawnBurst(e.clientX, e.clientY);
  if (raf === null) {
    lastTime = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

export function initClickParticles(): void {
  document.addEventListener("click", onClick, { passive: true, capture: true });
}