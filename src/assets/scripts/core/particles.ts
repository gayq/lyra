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

function ensureCanvas(): void {
  if (canvas) return;
  canvas = document.createElement("canvas");
  canvas.id = "click-particles-canvas";
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
  window.addEventListener("resize", syncSize, { passive: true });
}

function syncSize(): void {
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
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
      size: 1 + Math.random() * 1,
      alpha: 1,
    });
  }
}

function tick(time: number): void {
  if (!ctx || !canvas) return;
  const dt = Math.min((time - lastTime) / 1000, 0.05);
  lastTime = time;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let alive = 0;
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!;
    p.life -= dt;
    if (p.life <= 0) continue;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 1 - 3.5 * dt;
    p.vy *= 1 - 3.5 * dt;

    const t = p.life / p.maxLife;
    p.alpha = t;
    const size = p.size * t;

    ctx.globalAlpha = p.alpha;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
    ctx.fill();

    if (alive !== i) particles[alive] = p;
    alive++;
  }
  particles.length = alive;
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