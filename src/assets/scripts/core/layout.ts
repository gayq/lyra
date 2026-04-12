interface FallRuntime {
  pool: HTMLImageElement[];
  rafId: number | null;
  spawnRate: number;
  lastSpawnAt: number;
  spawnIndex: number;
}

let fallRuntime: FallRuntime | null = null;

function resetFallPool(): void {
  if (!fallRuntime) return;
  for (const img of fallRuntime.pool) {
    img.style.display = "none";
    img.style.animationName = "none";
    img.style.animationDuration = "";
  }
}

function stopFallLoop(): void {
  if (fallRuntime?.rafId != null) {
    cancelAnimationFrame(fallRuntime.rafId);
    fallRuntime.rafId = null;
  }
}

export function fallOnBrowserView(): void {
  if (!fallRuntime) return;
  stopFallLoop();
  resetFallPool();
}

export function fallOnHomeView(): void {
  if (!fallRuntime) return;
  stopFallLoop();
  fallRuntime.lastSpawnAt = performance.now() - fallRuntime.spawnRate;
  fallRuntime.rafId = requestAnimationFrame(function fallTick(time) {
    if (!fallRuntime) return;
    fallRuntime.rafId = requestAnimationFrame(fallTick);
    if (document.hidden || document.body.classList.contains("browser-view"))
      return;
    if (time - fallRuntime.lastSpawnAt < fallRuntime.spawnRate) return;
    fallRuntime.lastSpawnAt = time;
    spawnFallImage();
  });
}

function spawnFallImage(): void {
  if (!fallRuntime) return;
  const { pool } = fallRuntime;
  let img: HTMLImageElement | null = null;
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[i];
    if (candidate && candidate.style.display === "none") {
      img = candidate;
      break;
    }
  }
  if (!img) return;

  fallRuntime.spawnIndex++;

  const duration = 10 + Math.random() * 6;
  const startX = Math.random() * 100;
  const driftX = (Math.random() - 0.5) * 400;
  const rotationEnd = (Math.random() - 0.5) * 200;

  img.style.left = `${startX}vw`;
  img.style.animationDuration = `${duration}s`;
  img.style.setProperty("--drift-x", `${driftX}px`);
  img.style.setProperty("--rot-end", `${rotationEnd}deg`);

  void img.offsetWidth;

  img.style.display = "block";
  img.style.animationName = "fallAndFade";
}

export function initializeFall(): void {
  const CONTAINER_ID = "fall-container";
  const IMAGE_SOURCES = [
    "/assets/images/peaks/chii.avif",
    "/assets/images/peaks/pochi.avif",
  ];
  const SPAWN_RATE = 400;
  const MAX_PARTICLES = 100;
  const fallEnabled = localStorage.getItem("fallEnabled") !== "false";

  try {
    if (!document.getElementById("fall-styles")) {
      const style = document.createElement("style");
      style.id = "fall-styles";
      style.innerHTML = `
                #fall-container {
                    contain: paint;
                }
                .falling {
                    position: fixed;
                    top: -8%;
                    left: 40%;
                    width: 50px;
                    height: auto;
                    pointer-events: none;
                    z-index: -1;
                    opacity: 0;
                    animation-name: fallAndFade;
                    animation-timing-function: linear;
                    animation-fill-mode: forwards;
                }
                @keyframes fallAndFade {
                    0% {
                        opacity: 0.8;
                        transform: translate(-50%, 0) rotate(0deg);
                    }
                    100% {
                        opacity: 0;
                        transform: translate(calc(-50% + var(--drift-x)), 110vh) rotate(var(--rot-end));
                    }
                }
            `;
      document.head.appendChild(style);
    }

    let container = document.getElementById(CONTAINER_ID);
    if (!container) {
      container = document.createElement("div");
      container.id = CONTAINER_ID;
      Object.assign(container.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: "-1",
      });
      document.body.appendChild(container);
    }

    if (!fallEnabled) {
      container.style.display = "none";
      return;
    }

    const imgPool: HTMLImageElement[] = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const img = document.createElement("img");
      img.className = "falling";
      img.decoding = "async";
      img.loading = "eager";
      img.style.display = "none";
      img.src =
        IMAGE_SOURCES[Math.floor(Math.random() * IMAGE_SOURCES.length)]!;
      img.addEventListener("animationend", () => {
        img.style.display = "none";
        img.style.animationName = "none";
      });
      container.appendChild(img);
      imgPool.push(img);
    }

    fallRuntime = {
      pool: imgPool,
      rafId: null,
      spawnRate: SPAWN_RATE,
      lastSpawnAt: 0,
      spawnIndex: 0,
    };

    document.addEventListener("visibilitychange", () => {
      if (!fallRuntime) return;
      if (document.hidden) {
        stopFallLoop();
      } else if (!document.body.classList.contains("browser-view")) {
        fallOnHomeView();
      }
    });

    function startWhenReady(): void {
      const start = () => {
        if (document.body.classList.contains("browser-view")) {
          fallOnBrowserView();
        } else {
          fallOnHomeView();
        }
      };
      if (document.readyState === "complete") {
        start();
      } else {
        window.addEventListener("load", start, { once: true });
      }
    }

    startWhenReady();
  } catch (e) {
    console.error("fall error:", e);
  }
}