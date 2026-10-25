import { uiSignal } from "../../core/ui/uiSignals.ts";
import { appPath } from "../../core/runtime/hosting.ts";
import { presenceId } from "../../core/runtime/presenceId.ts";
import { toast } from "../../core/ui/toast.ts";

export interface LiveNotice {
  id: string;
  text: string;
  poll?: string[];
  reactions: string[];
  ms: number;
  tally: { votes: number[]; reactions: number[] };
  mine: { vote: number; reactions: number[] };
}

type NoticeAction = { vote: number } | { react: number };
type NoticeShape = { poll?: string[] | undefined; reactions: string[] };

const NOTICE_ID = /^[A-Za-z0-9_-]{16}$/;
const LIVE_LIMIT = 3;
const dismissed = new Set<string>();

export const liveNoticesSignal = uiSignal<LiveNotice[]>([]);

function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

function isStringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string");
}

function isCountList(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((count) => Number.isSafeInteger(count) && count >= 0)
  );
}

function readTally(value: unknown, notice: NoticeShape): LiveNotice["tally"] | null {
  const tally = value as Partial<LiveNotice["tally"]> | null;
  if (!tally || typeof tally !== "object") return null;
  if (!isCountList(tally.votes, notice.poll?.length ?? 0)) return null;
  if (!isCountList(tally.reactions, notice.reactions.length)) return null;
  return { votes: tally.votes, reactions: tally.reactions };
}

function readMine(value: unknown, notice: NoticeShape): LiveNotice["mine"] | null {
  const mine = value as Partial<LiveNotice["mine"]> | null;
  if (!mine || typeof mine !== "object") return null;
  const vote = mine.vote;
  if (!Number.isInteger(vote) || vote! < -1 || vote! >= (notice.poll?.length ?? 0)) return null;
  if (
    !Array.isArray(mine.reactions) ||
    !mine.reactions.every((index) => Number.isInteger(index) && index >= 0 && index < notice.reactions.length)
  ) {
    return null;
  }
  return { vote: vote!, reactions: mine.reactions };
}

function readNotice(value: unknown, current: LiveNotice | undefined): LiveNotice | null {
  const notice = value as Partial<LiveNotice> | null;
  if (
    !notice ||
    typeof notice !== "object" ||
    typeof notice.id !== "string" ||
    !NOTICE_ID.test(notice.id) ||
    typeof notice.text !== "string" ||
    !notice.text ||
    notice.text.length > 500 ||
    (notice.poll !== undefined && !isStringList(notice.poll, 6)) ||
    !isStringList(notice.reactions, 8) ||
    !Number.isFinite(notice.ms)
  ) {
    return null;
  }
  const shape = { poll: notice.poll, reactions: notice.reactions };
  const tally = readTally(notice.tally, shape);
  if (!tally) return null;
  if (current) return { ...current, tally, mine: readMine(notice.mine, shape) ?? current.mine };
  return {
    id: notice.id,
    text: notice.text,
    ...(notice.poll && { poll: notice.poll }),
    reactions: notice.reactions,
    ms: Math.min(Math.max(notice.ms!, 0), 600_000),
    tally,
    mine: readMine(notice.mine, shape) ?? { vote: -1, reactions: [] },
  };
}

export function clearGlobalNotice(): void {
  liveNoticesSignal.value = [];
}

export function applyGlobalNotice(payload: string): void {
  const list = parse(payload);
  if (!Array.isArray(list)) return;
  const current = new Map(liveNoticesSignal.value.map((notice) => [notice.id, notice]));
  liveNoticesSignal.value = list.slice(-LIVE_LIMIT).flatMap((value) => {
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || dismissed.has(id)) return [];
    const notice = readNotice(value, current.get(id));
    return notice && notice.ms > 0 ? [notice] : [];
  });
}

export function applyGlobalNoticeTally(payload: string): void {
  const updates = parse(payload);
  if (!Array.isArray(updates)) return;
  const byId = new Map(updates.map((update) => [(update as { id?: unknown } | null)?.id, update]));
  let changed = false;
  const next = liveNoticesSignal.value.map((notice) => {
    const tally = byId.has(notice.id) ? readTally(byId.get(notice.id), notice) : null;
    if (!tally) return notice;
    changed = true;
    return { ...notice, tally };
  });
  if (changed) liveNoticesSignal.value = next;
}

export function dismissGlobalNotice(id: string): void {
  dismissed.add(id);
  liveNoticesSignal.value = liveNoticesSignal.value.filter((notice) => notice.id !== id);
}

function updateNotice(id: string, update: (notice: LiveNotice) => LiveNotice): LiveNotice | undefined {
  let found: LiveNotice | undefined;
  liveNoticesSignal.value = liveNoticesSignal.value.map((notice) => {
    if (notice.id !== id) return notice;
    found = notice;
    return update(notice);
  });
  return found;
}

function predict(notice: LiveNotice, action: NoticeAction): LiveNotice {
  const votes = [...notice.tally.votes];
  const reactions = [...notice.tally.reactions];
  let { vote, reactions: mine } = notice.mine;
  if ("vote" in action) {
    if (vote >= 0) votes[vote]!--;
    vote = vote === action.vote ? -1 : action.vote;
    if (vote >= 0) votes[vote]!++;
  } else if (mine.includes(action.react)) {
    reactions[action.react]!--;
    mine = mine.filter((index) => index !== action.react);
  } else {
    reactions[action.react]!++;
    mine = [...mine, action.react];
  }
  return { ...notice, tally: { votes, reactions }, mine: { vote, reactions: mine } };
}

const FAILURE_TEXT: Record<string, string> = {
  NOTICE_ENDED: "that one already ended",
  NOTICE_VOTER_UNKNOWN: "still connecting, try again in a sec",
  RATE_LIMITED: "slow down a little",
};

export async function sendGlobalNoticeAction(id: string, action: NoticeAction): Promise<void> {
  const browser = presenceId();
  if (!browser) return;
  const previous = updateNotice(id, (notice) => predict(notice, action));
  if (!previous) return;
  let code = "";
  try {
    const response = await fetch(appPath("/api/notice"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notice: id, browser, ...action }),
    });
    const result = (await response.json().catch(() => null)) as
      | { tally?: unknown; mine?: unknown; code?: unknown }
      | null;
    if (response.ok && result) {
      updateNotice(id, (notice) => {
        const tally = readTally(result.tally, notice);
        const mine = readMine(result.mine, notice);
        return tally && mine ? { ...notice, tally, mine } : notice;
      });
      return;
    }
    code = typeof result?.code === "string" ? result.code : "";
  } catch {}
  updateNotice(id, (notice) => ({ ...notice, tally: previous.tally, mine: previous.mine }));
  toast.error(FAILURE_TEXT[code] ?? ("vote" in action ? "your vote did not go through" : "your reaction did not go through"));
}
