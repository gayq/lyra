const PRESENCE_ID_KEY = "lyraPresenceId";
const PRESENCE_ID = /^[A-Za-z0-9_-]{16,64}$/;

let current: string | undefined;

function createPresenceId(): string {
  try {
    const saved = localStorage.getItem(PRESENCE_ID_KEY);
    if (saved && PRESENCE_ID.test(saved)) return saved;
    const created = crypto.randomUUID();
    localStorage.setItem(PRESENCE_ID_KEY, created);
    return created;
  } catch {
    try {
      return crypto.randomUUID();
    } catch {
      return "";
    }
  }
}

export function presenceId(): string {
  return (current ??= createPresenceId());
}
