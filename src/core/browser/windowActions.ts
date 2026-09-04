const pendingActions: Partial<Record<string, number>> = {};

export function invokeWindowAction(name: string): void {
  const action = window[name as keyof Window];
  if (typeof action === "function") {
    action.call(window);
    return;
  }

  if (pendingActions[name]) return;

  let attempts = 0;
  pendingActions[name] = window.setInterval(() => {
    attempts += 1;
    const pendingAction = window[name as keyof Window];
    if (typeof pendingAction === "function") {
      window.clearInterval(pendingActions[name]);
      delete pendingActions[name];
      pendingAction.call(window);
    } else if (attempts >= 20) {
      window.clearInterval(pendingActions[name]);
      delete pendingActions[name];
    }
  }, 50);
}
