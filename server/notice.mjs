import fs from "fs";
import net from "net";
import path from "path";
import { randomBytes } from "crypto";
import { httpError } from "./errors.mjs";
import { BROWSER_ID } from "./presence.mjs";
import { NEGATIVE } from "../src/core/runtime/messages.ts";

export const NOTICE_LIMITS = { text: 500, options: 6, option: 80, reactions: 8, live: 3, minSeconds: 3, maxSeconds: 600 };
export const DEFAULT_REACTIONS = ["❤️", "👍", "❓", "😭", "❌", "🔥"];
const ACTION_MAX_BYTES = 1024;
const COMMAND_MAX_BYTES = 16 * 1024;
const ACTION_GRACE_MS = 15_000;
const ZWJ = String.fromCodePoint(0x200d);
const INVISIBLE = new RegExp(`(?![\n${ZWJ}])[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]`, "gu");
const EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Component}]{1,16}$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function noticeSocketPath(root) {
  return process.env.LYRA_NOTICE_SOCKET || path.join(root, "cache", "notice", "control.sock");
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanLine(value) {
  return String(value ?? "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

export function normalizeNotice(fields) {
  const text = cleanText(fields?.text);
  if (!text || text.length > NOTICE_LIMITS.text) {
    throw new Error(`message must be 1 to ${NOTICE_LIMITS.text} characters`);
  }
  const notice = { text };
  if (fields.poll !== undefined) {
    const poll = Array.isArray(fields.poll) ? fields.poll.map(cleanLine) : [];
    if (
      poll.length < 2 ||
      poll.length > NOTICE_LIMITS.options ||
      poll.some((option) => !option || option.length > NOTICE_LIMITS.option) ||
      new Set(poll).size !== poll.length
    ) {
      throw new Error(`a poll needs 2 to ${NOTICE_LIMITS.options} different options of up to ${NOTICE_LIMITS.option} characters`);
    }
    notice.poll = poll;
  }
  const reactions = fields.reactions === undefined ? DEFAULT_REACTIONS : fields.reactions;
  if (
    !Array.isArray(reactions) ||
    reactions.length > NOTICE_LIMITS.reactions ||
    reactions.some((emoji) => typeof emoji !== "string" || !EMOJI.test(emoji) || !PICTOGRAPH.test(emoji)) ||
    new Set(reactions).size !== reactions.length
  ) {
    throw new Error(`reactions must be up to ${NOTICE_LIMITS.reactions} different emoji`);
  }
  notice.reactions = [...reactions];
  const seconds = fields.seconds ?? (notice.poll ? 45 : Math.min(20, Math.max(6, Math.round(4 + text.length / 12))));
  if (!Number.isInteger(seconds) || seconds < NOTICE_LIMITS.minSeconds || seconds > NOTICE_LIMITS.maxSeconds) {
    throw new Error(`a message can stay up for ${NOTICE_LIMITS.minSeconds} to ${NOTICE_LIMITS.maxSeconds} seconds`);
  }
  notice.seconds = seconds;
  return notice;
}

async function readAction(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ACTION_MAX_BYTES) throw new Error();
      chunks.push(value);
    }
    const action = JSON.parse(Buffer.concat(chunks).toString());
    return action && typeof action === "object" && !Array.isArray(action) ? action : null;
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  }
}

export function createNoticeBoard({ tallyDelayMs = 250, actionLimit = 20, actionWindowMs = 10_000, now = Date.now } = {}) {
  const encoder = new TextEncoder();
  const live = new Map();
  const pendingTallies = new Set();
  const actionHits = new Map();
  let actionWindowStart = 0;
  let presence;
  let tallyTimer;

  const frame = (event, value) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  const tally = (entry) => ({ votes: [...entry.voteCounts], reactions: entry.reacted.map((set) => set.size) });
  const mine = (entry, browser) => ({
    vote: entry.votes.get(browser) ?? -1,
    reactions: entry.reacted.flatMap((set, index) => (set.has(browser) ? [index] : [])),
  });
  const showing = () => [...live.values()].filter((entry) => entry.expires - now() > 1_000);
  const view = (entry, browser) => ({
    id: entry.id,
    text: entry.text,
    ...(entry.poll && { poll: entry.poll }),
    reactions: entry.reactions,
    ms: entry.expires - now(),
    tally: tally(entry),
    ...(browser && { mine: mine(entry, browser) }),
  });
  const results = (entry) => ({
    id: entry.id,
    text: entry.text,
    ...(entry.poll && { poll: entry.poll }),
    votes: [...entry.voteCounts],
    reactions: entry.reactions,
    reacted: entry.reacted.map((set) => set.size),
  });
  const publishShowing = () => presence?.publish(frame("notice", showing().map((entry) => view(entry))));

  function finish(id) {
    const entry = live.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    live.delete(id);
    pendingTallies.delete(id);
    entry.onEnd?.(results(entry));
  }

  function send(fields, onEnd) {
    const notice = normalizeNotice(fields);
    while (live.size >= NOTICE_LIMITS.live) finish(live.keys().next().value);
    const entry = {
      id: randomBytes(12).toString("base64url"),
      ...notice,
      expires: now() + notice.seconds * 1_000,
      votes: new Map(),
      voteCounts: (notice.poll ?? []).map(() => 0),
      reacted: notice.reactions.map(() => new Set()),
      onEnd,
    };
    entry.timer = setTimeout(() => finish(entry.id), notice.seconds * 1_000 + ACTION_GRACE_MS);
    entry.timer.unref?.();
    live.set(entry.id, entry);
    publishShowing();
    return entry;
  }

  function clear() {
    for (const id of [...live.keys()]) finish(id);
    publishShowing();
  }

  function queueTally(id) {
    pendingTallies.add(id);
    if (tallyTimer) return;
    tallyTimer = setTimeout(() => {
      tallyTimer = undefined;
      const updates = [...pendingTallies].flatMap((pending) => {
        const entry = live.get(pending);
        return entry ? [{ id: pending, ...tally(entry) }] : [];
      });
      pendingTallies.clear();
      if (updates.length) presence?.publish(frame("tally", updates));
    }, tallyDelayMs);
    tallyTimer.unref?.();
  }

  function toggle(entry, browser, action) {
    if (action.vote !== undefined) {
      const option = action.vote;
      if (!entry.poll || !Number.isInteger(option) || option < 0 || option >= entry.poll.length) return false;
      const previous = entry.votes.get(browser);
      if (previous !== undefined) entry.voteCounts[previous]--;
      if (previous === option) entry.votes.delete(browser);
      else {
        entry.votes.set(browser, option);
        entry.voteCounts[option]++;
      }
      return true;
    }
    const index = action.react;
    if (!Number.isInteger(index) || index < 0 || index >= entry.reacted.length) return false;
    const set = entry.reacted[index];
    if (!set.delete(browser)) set.add(browser);
    return true;
  }

  function command(socket, line) {
    const reply = (value) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
    };
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      reply({ type: "error", message: "command is not valid json" });
      return;
    }
    if (request?.type === "send") {
      try {
        const entry = send(request, (result) => reply({ type: "ended", ...result }));
        reply({ type: "sent", id: entry.id, seconds: entry.seconds });
      } catch (error) {
        reply({ type: "error", message: error.message });
      }
    } else if (request?.type === "clear") {
      clear();
      reply({ type: "cleared" });
    } else {
      reply({ type: "error", message: "unknown command" });
    }
  }

  function listen(socketPath, control) {
    const dir = path.dirname(socketPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      console.error("global notice control socket is already used by another server:", socketPath, NEGATIVE);
    });
    probe.once("error", (error) => {
      if (control.stopped) return;
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) {
        console.error("global notice control socket failed:", error, NEGATIVE);
        return;
      }
      fs.rmSync(socketPath, { force: true });
      control.server = createControlServer();
      control.server.listen(socketPath, () => {
        control.owned = true;
        fs.chmodSync(socketPath, 0o600);
      });
    });
  }

  function createControlServer() {
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line.trim()) command(socket, line);
        }
        if (buffer.length > COMMAND_MAX_BYTES) socket.destroy();
      });
    });
    server.on("error", (error) => console.error("global notice control socket failed:", error, NEGATIVE));
    server.unref();
    return server;
  }

  return {
    send,
    clear,
    greet(browser) {
      const entries = showing();
      return entries.length ? frame("notice", entries.map((entry) => view(entry, browser))) : undefined;
    },
    serve({ presence: connectedPresence, socketPath }) {
      presence = connectedPresence;
      const control = { server: undefined, owned: false, stopped: false };
      if (socketPath) listen(socketPath, control);
      return () => {
        control.stopped = true;
        clearTimeout(tallyTimer);
        for (const entry of live.values()) clearTimeout(entry.timer);
        control.server?.close();
        if (control.owned) fs.rmSync(socketPath, { force: true });
      };
    },
    async handle(request) {
      if (request.method !== "POST") return httpError(405, "METHOD_NOT_ALLOWED", "request method is not supported");
      if (["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site"))) {
        return httpError(403, "NOTICE_REQUEST_DENIED", "this request is not allowed");
      }
      const length = request.headers.get("content-length");
      if (length && !(Number(length) <= ACTION_MAX_BYTES)) return httpError(413, "NOTICE_ACTION_TOO_LARGE", "request is too large");
      const action = await readAction(request);
      if (!action) return httpError(400, "NOTICE_ACTION_INVALID", "this action is not valid");
      const entry = typeof action.notice === "string" ? live.get(action.notice) : undefined;
      if (!entry) return httpError(409, "NOTICE_ENDED", "this message has ended");
      const { browser } = action;
      if (typeof browser !== "string" || !BROWSER_ID.test(browser) || !presence?.has(browser)) {
        return httpError(403, "NOTICE_VOTER_UNKNOWN", "reconnect and try again");
      }
      const at = now();
      if (at - actionWindowStart > actionWindowMs) {
        actionHits.clear();
        actionWindowStart = at;
      }
      const hits = (actionHits.get(browser) || 0) + 1;
      actionHits.set(browser, hits);
      if (hits > actionLimit) return httpError(429, "RATE_LIMITED", "too many requests, please try again later");
      if (!toggle(entry, browser, action)) return httpError(400, "NOTICE_ACTION_INVALID", "this action is not valid");
      queueTally(entry.id);
      return { status: 200, body: { id: entry.id, tally: tally(entry), mine: mine(entry, browser) } };
    },
  };
}
