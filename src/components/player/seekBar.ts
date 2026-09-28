interface SeekBarOptions {
  duration(): number;
  currentTime(): number | null;
  render(time: number | null): void;
  commit(time: number): void;
  interaction(active: boolean): void;
  preview: HTMLElement;
  format(time: number): string;
}

export function attachSeekBar(
  bar: HTMLElement,
  options: SeekBarOptions,
): () => void {
  let pointer: number | null = null;
  let frame: number | null = null;
  let clientX = 0;
  let bounds: DOMRect | null = null;

  const position = () => {
    bounds ??= bar.getBoundingClientRect();
    const duration = options.duration();
    if (!(duration > 0) || !Number.isFinite(duration) || bounds.width <= 0)
      return null;
    return (
      Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) *
      duration
    );
  };
  const paint = () => {
    frame = null;
    const time = position();
    if (time === null || !bounds) return;
    options.preview.style.left = `clamp(32px, ${(time / options.duration()) * 100}%, calc(100% - 32px))`;
    options.preview.textContent = options.format(time);
    options.preview.hidden = false;
    if (pointer !== null) options.render(time);
  };
  const cancelFrame = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const finish = (commit: boolean) => {
    if (pointer === null) return;
    const id = pointer;
    const time = position();
    pointer = null;
    cancelFrame();
    bar.classList.remove("is-dragging");
    options.interaction(false);
    if (bar.hasPointerCapture(id)) bar.releasePointerCapture(id);
    if (commit && time !== null) {
      options.render(time);
      options.commit(time);
    } else {
      options.render(options.currentTime());
    }
    options.preview.hidden = true;
    bounds = null;
  };
  const down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || pointer !== null) return;
    bounds = bar.getBoundingClientRect();
    clientX = event.clientX;
    if (position() === null) return;
    event.preventDefault();
    pointer = event.pointerId;
    bar.setPointerCapture(pointer);
    bar.focus({ preventScroll: true });
    bar.classList.add("is-dragging");
    options.interaction(true);
    cancelFrame();
    paint();
  };
  const move = (event: PointerEvent) => {
    if (pointer !== null && event.pointerId !== pointer) return;
    if (pointer === null && event.pointerType === "touch") return;
    clientX = event.clientX;
    if (frame === null) frame = requestAnimationFrame(paint);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    clientX = event.clientX;
    finish(true);
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointer) finish(false);
  };
  const leave = () => {
    if (pointer !== null) return;
    cancelFrame();
    bounds = null;
    options.preview.hidden = true;
  };
  const resize = () => {
    bounds = null;
  };
  const blur = () => finish(false);
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && pointer !== null) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || pointer !== null)
      return;
    const duration = options.duration();
    if (!(duration > 0) || !Number.isFinite(duration)) return;
    const current = options.currentTime() ?? 0;
    const targets: Record<string, number> = {
      ArrowLeft: current - 5,
      ArrowRight: current + 5,
      ArrowDown: current - 5,
      ArrowUp: current + 5,
      Home: 0,
      End: duration,
      PageDown: current - duration / 10,
      PageUp: current + duration / 10,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    event.stopPropagation();
    const time = Math.max(0, Math.min(duration, targets[event.key]!));
    options.render(time);
    options.commit(time);
  };
  bar.addEventListener("pointerdown", down);
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up);
  bar.addEventListener("pointercancel", cancel);
  bar.addEventListener("lostpointercapture", cancel);
  bar.addEventListener("pointerleave", leave);
  bar.addEventListener("keydown", keydown);
  window.addEventListener("resize", resize);
  window.addEventListener("blur", blur);
  return () => {
    finish(false);
    leave();
    bar.removeEventListener("pointerdown", down);
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", up);
    bar.removeEventListener("pointercancel", cancel);
    bar.removeEventListener("lostpointercapture", cancel);
    bar.removeEventListener("pointerleave", leave);
    bar.removeEventListener("keydown", keydown);
    window.removeEventListener("resize", resize);
    window.removeEventListener("blur", blur);
  };
}
