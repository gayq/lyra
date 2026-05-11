export function attachSearchLight(searchBar: HTMLElement): void {
  if (!searchBar || searchBar.dataset["lightAttached"] === "true") return;

  const lightBg = searchBar.querySelector(".light") as HTMLElement | null;
  const lightBorder = searchBar.querySelector(
    ".light-border",
  ) as HTMLElement | null;
  if (!lightBg || !lightBorder) return;

  searchBar.dataset["lightAttached"] = "true";
  const lightSize = 300;

  let targetX: number = 0,
    currentX: number = 0,
    lastX: number = 0,
    velocityX: number = 0;
  let targetY: number = 0,
    currentY: number = 0,
    lastY: number = 0,
    velocityY: number = 0;
  let raf: number | null = null;
  let rect: DOMRect = searchBar.getBoundingClientRect();
  let isHovering: boolean = false;
  let isSettled: boolean = false;
  let rectRaf: number | null = null;

  const updateRect = (): void => {
    rect = searchBar.getBoundingClientRect();
  };

  const scheduleRectUpdate = (): void => {
    if (rectRaf) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = null;
      if (isHovering) updateRect();
    });
  };

  const setBgPosition = (x: string, y: string): void => {
    lightBg.style.setProperty("--bg-x", x);
    lightBg.style.setProperty("--bg-y", y);
    lightBorder.style.setProperty("--bg-x", x);
    lightBorder.style.setProperty("--bg-y", y);
  };

  function animate(): void {
    const deltaX = targetX - currentX;
    const deltaY = targetY - currentY;

    currentX += deltaX * 0.15;
    currentY += deltaY * 0.15;

    const elasticX = Math.min(Math.max(velocityX * 0.5, -20), 20);
    const elasticY = Math.min(Math.max(velocityY * 0.5, -20), 20);

    if (
      Math.abs(deltaX) < 0.1 &&
      Math.abs(deltaY) < 0.1 &&
      Math.abs(elasticX) < 0.1 &&
      Math.abs(elasticY) < 0.1
    ) {
      isSettled = true;
      raf = null;

      const finalBgX = `${targetX}px`;
      const finalBgY = `${targetY}px`;

      setBgPosition(finalBgX, finalBgY);
      return;
    }

    const bgX = `${currentX + elasticX}px`;
    const bgY = `${currentY + elasticY}px`;

    setBgPosition(bgX, bgY);

    raf = requestAnimationFrame(animate);
  }

  searchBar.addEventListener("mouseenter", () => {
    isHovering = true;
    updateRect();
    if (raf) cancelAnimationFrame(raf);
    isSettled = false;
    raf = requestAnimationFrame(animate);

    lightBg.style.opacity = "1";
    lightBorder.style.opacity = "1";
    lightBg.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBg.style.filter = "blur(20px)";
    lightBorder.style.filter = "blur(6px)";

    setTimeout(() => {
      lightBg.style.transform = "scale(1)";
      lightBg.style.filter = "blur(12px)";
      lightBorder.style.transform = "scale(1)";
      lightBorder.style.filter = "blur(4px)";
    }, 300);
  });

  searchBar.addEventListener("mouseleave", () => {
    isHovering = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lightBg.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBg.style.opacity = "0";
    lightBorder.style.opacity = "0";
    lightBg.style.transform = "scale(0.95)";
    lightBorder.style.transform = "scale(0.95)";
    lightBg.style.filter = "blur(30px)";
    lightBorder.style.filter = "blur(12px)";
  });

  searchBar.addEventListener("mousemove", (e: MouseEvent) => {
    targetX = e.clientX - rect.left - lightSize / 2;
    targetY = e.clientY - rect.top - lightSize / 2;

    velocityX = targetX - lastX;
    velocityY = targetY - lastY;
    lastX = targetX;
    lastY = targetY;

    const glowStrength = Math.min(
      1.2,
      1.2 + ((e.clientX - rect.left) / rect.width) * 0.4,
    );
    lightBg.style.transform = `scale(${glowStrength})`;

    if (isSettled && !raf) {
      isSettled = false;
      raf = requestAnimationFrame(animate);
    }
  });

  window.addEventListener("scroll", scheduleRectUpdate, { passive: true });
  window.addEventListener("resize", scheduleRectUpdate, { passive: true });
}
