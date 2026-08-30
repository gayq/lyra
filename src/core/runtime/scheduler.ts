export function scheduleIdleTask(
  callback: () => void,
  timeout = 250,
): () => void {
  let active = true;
  const run = () => {
    if (!active) return;
    callback();
  };

  if (typeof window.requestIdleCallback === "function") {
    const idleId = window.requestIdleCallback(run, { timeout });
    return () => {
      active = false;
      window.cancelIdleCallback(idleId);
    };
  }

  const timeoutId = window.setTimeout(run, Math.min(timeout, 250));
  return () => {
    active = false;
    window.clearTimeout(timeoutId);
  };
}
