import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_REACTIONS, NOTICE_LIMITS, noticeSocketPath } from "../server/notice.mjs";
import { NEGATIVE, POSITIVE } from "../src/core/runtime/messages.ts";

const CONSOLE_HELP = `  /poll question: option, option     send a poll
  /for 30s message                   keep it up for 30s, 2m or 1m30s, works with /poll too
  /status                            who is online and what is showing right now
  /end [number]                      take down your last message, or a number from /status
  /reactions 🔥 💀 | off | default   pick the reaction emoji for what you send next
  /clear                             take every live message down
  /help                              show this list
  /quit                              leave`;

const USAGE = `usage:
  bun run notice                                   live console, every line you type pops up for everyone
  bun run notice "message"                         pop a message up for everyone online
  bun run notice "question" --poll "a, b, c"       pop up a poll and print the results when it ends
  bun run notice "message" --for 20s               keep it up for 20s, 2m or 1m30s (${NOTICE_LIMITS.minSeconds} to ${NOTICE_LIMITS.maxSeconds} seconds)
  bun run notice "message" --reactions "🔥 💀"     pick the reaction emoji, or --no-reactions
  bun run notice --status                          see who is online and what is showing
  bun run notice --clear                           take every live message down

live console:
${CONSOLE_HELP}`;

const COMMANDS = ["/poll ", "/for ", "/status", "/end", "/reactions ", "/clear", "/help", "/quit"];

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const socketPath = noticeSocketPath(root);
const dim = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${text}\x1b[22m` : text);

function fail(message) {
  console.error(`${message}${NEGATIVE}`);
  process.exit(1);
}

function parseDuration(value) {
  const match = /^(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value ?? "");
  if (!value || !match) return NaN;
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function parseArgs(args) {
  const text = [];
  const fields = {};
  let target = text;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--poll") target = fields.poll = [];
    else if (arg === "--reactions") target = fields.reactions = [];
    else if (arg === "--no-reactions") fields.reactions = [];
    else if (arg === "--for") fields.seconds = parseDuration(args[++index]);
    else if (arg.startsWith("--")) {
      console.error(USAGE);
      fail(`unknown option ${arg}`);
    } else target.push(arg);
  }
  if (fields.poll) fields.poll = fields.poll.flatMap(splitOptions);
  if (fields.reactions) fields.reactions = fields.reactions.flatMap(splitEmoji);
  return { text: text.join(" "), ...fields };
}

function splitOptions(value) {
  return value.split(",").map((option) => option.trim()).filter(Boolean);
}

function splitEmoji(value) {
  return value.split(/[\s,]+/).filter(Boolean);
}

function splitCommand(input) {
  const [name] = input.split(/\s/, 1);
  return [name, input.slice(name.length).trim()];
}

function parseMessage(input) {
  const [name, argument] = splitCommand(input);
  if (name === "/for") {
    const [amount, rest] = splitCommand(argument);
    const seconds = parseDuration(amount);
    if (Number.isNaN(seconds) || !rest) return { error: "write it like /for 30s message" };
    const message = parseMessage(rest);
    return message.error ? message : { ...message, seconds };
  }
  if (name === "/poll") {
    const colon = argument.indexOf(":");
    if (colon < 0) return { error: "write a poll like /poll question: option, option" };
    return { text: argument.slice(0, colon).trim(), poll: splitOptions(argument.slice(colon + 1)) };
  }
  if (name.startsWith("/")) return { error: `unknown command ${name}, type /help to see them all` };
  return { text: input };
}

const people = (count) => `${count} ${count === 1 ? "person" : "people"}`;
const headline = (text) => text.split("\n")[0].slice(0, 60);
const sentLine = (message) => `message sent to ${people(message.online)}, live for ${message.seconds}s${POSITIVE}`;

function bar(count, total) {
  const filled = total ? Math.round((count / total) * 12) : 0;
  return "█".repeat(filled) + "░".repeat(12 - filled);
}

function describeTally(result, indent) {
  const lines = [];
  if (result.poll) {
    const total = result.votes.reduce((sum, count) => sum + count, 0);
    const width = Math.max(...result.poll.map((option) => option.length));
    lines.push(`${indent}${total} ${total === 1 ? "vote" : "votes"}`);
    result.poll.forEach((option, index) => {
      const share = total ? Math.round((result.votes[index] / total) * 100) : 0;
      lines.push(`${indent}${option.padEnd(width)}  ${bar(result.votes[index], total)}  ${result.votes[index]} (${share}%)`);
    });
  }
  if (result.reactions.length) {
    lines.push(`${indent}${result.reactions.map((emoji, index) => `${emoji} ${result.reacted[index]}`).join("   ")}`);
  }
  return lines;
}

function describeEnd(result) {
  return [`ended: ${headline(result.text)}`, ...describeTally(result, "  ")].join("\n");
}

function describeStatus(status) {
  const lines = [`${status.online} online, ${status.live.length ? `${status.live.length} live` : "nothing showing"}`];
  status.live.forEach((entry, index) => {
    lines.push(`  ${index + 1}. ${headline(entry.text)}  (${entry.seconds}s left)`);
    lines.push(...describeTally(entry, "     "));
  });
  return lines.join("\n");
}

function connect(onMessage) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => resolve(socket));
    socket.on("error", (error) => {
      if (["ENOENT", "ECONNREFUSED"].includes(error.code)) fail("lyra is not running in this folder, start the server first");
      fail("could not reach the lyra server");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          onMessage(JSON.parse(line));
        } catch {}
      }
    });
  });
}

const send = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);

async function once(command) {
  const socket = await connect((message) => {
    if (message.type === "error") fail(message.message);
    if (message.type === "cleared") {
      console.log(`every live message is down${POSITIVE}`);
      socket.end();
    }
    if (message.type === "status") {
      console.log(describeStatus(message));
      socket.end();
    }
    if (message.type === "sent") {
      console.log(sentLine(message));
      if (!command.poll) socket.end();
      else console.log("waiting for votes, ctrl+c stops watching but the poll keeps going");
    }
    if (message.type === "ended") {
      console.log(describeEnd(message));
      socket.end();
    }
  });
  send(socket, command);
}

async function liveConsole() {
  let rl;
  let quitting = false;
  let listed = [];
  let reactions;
  const mine = [];
  const print = (text) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(text);
    if (!quitting) rl?.prompt(true);
  };
  const socket = await connect((message) => {
    if (message.type === "error") print(`${message.message}${NEGATIVE}`);
    if (message.type === "online") {
      rl?.setPrompt(`notice (${message.online} online)> `);
      if (!quitting) rl?.prompt(true);
    }
    if (message.type === "sent") {
      mine.push(message.id);
      print(sentLine(message));
    }
    if (message.type === "status") {
      listed = message.live.map((entry) => entry.id);
      print(describeStatus(message));
    }
    if (message.type === "stopped") print(`message taken down${POSITIVE}`);
    if (message.type === "cleared") print(`every live message is down${POSITIVE}`);
    if (message.type === "ended") {
      if (mine.includes(message.id)) mine.splice(mine.indexOf(message.id), 1);
      print(describeEnd(message));
    }
  });
  socket.on("close", () => {
    if (quitting) process.exit(0);
    print(`lost connection to the lyra server${NEGATIVE}`);
    process.exit(1);
  });
  print(`connected${POSITIVE}`);
  console.log(dim("type /help to see every command"));
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "notice> ",
    completer: (line) => [line.startsWith("/") ? COMMANDS.filter((name) => name.startsWith(line)) : [], line],
  });
  send(socket, { type: "watch" });
  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    const [name, argument] = splitCommand(input);
    if (!input) return rl.prompt();
    if (name === "/quit" || name === "/exit") return rl.close();
    if (name === "/help") return print(dim(CONSOLE_HELP));
    if (name === "/clear") return send(socket, { type: "clear" });
    if (name === "/status") return send(socket, { type: "status" });
    if (name === "/end") {
      const id = argument ? listed[Number(argument) - 1] : mine.at(-1);
      if (id) return send(socket, { type: "end", id });
      if (argument) return print(`there is no message ${argument} in your last /status${NEGATIVE}`);
      return print(`you have nothing live to take down${NEGATIVE}`);
    }
    if (name === "/reactions") {
      if (argument === "off") reactions = [];
      else if (argument === "default") reactions = undefined;
      else if (argument) reactions = splitEmoji(argument);
      return print(reactions?.length === 0 ? "reactions are off" : `reactions: ${(reactions ?? DEFAULT_REACTIONS).join(" ")}`);
    }
    const message = parseMessage(input);
    if (message.error) return print(`${message.error}${NEGATIVE}`);
    send(socket, { type: "send", ...message, ...(reactions && { reactions }) });
  });
  rl.on("close", () => {
    quitting = true;
    socket.end();
  });
}

const args = process.argv.slice(2);
if (!args.length) await liveConsole();
else if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) console.log(USAGE);
else if (args.length === 1 && args[0] === "--clear") await once({ type: "clear" });
else if (args.length === 1 && args[0] === "--status") await once({ type: "status" });
else await once({ type: "send", ...parseArgs(args) });
