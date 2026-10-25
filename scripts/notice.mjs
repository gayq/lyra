import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { NOTICE_LIMITS, noticeSocketPath } from "../server/notice.mjs";
import { NEGATIVE, POSITIVE } from "../src/core/runtime/messages.ts";

const USAGE = `usage:
  bun run notice                                   live console, every line you type pops up for everyone
  bun run notice "message"                         pop a message up for everyone online
  bun run notice "question" --poll "a, b, c"       pop up a poll and print the results when it ends
  bun run notice "message" --for 20s               keep it up for 20s or 2m (${NOTICE_LIMITS.minSeconds} to ${NOTICE_LIMITS.maxSeconds} seconds)
  bun run notice "message" --reactions "🔥 💀"      pick the reaction emoji, or --no-reactions
  bun run notice --clear                           take every live message down

live console:
  /poll question, option, option                   send a poll
  /clear                                           take every live message down
  /quit                                            leave`;

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const socketPath = noticeSocketPath(root);

function fail(message) {
  console.error(`${message}${NEGATIVE}`);
  process.exit(1);
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
    else if (arg === "--for") {
      const [, amount, unit] = /^(\d+)(s|m)?$/.exec(args[++index] ?? "") ?? [];
      fields.seconds = amount ? Number(amount) * (unit === "m" ? 60 : 1) : NaN;
    }
    else if (arg.startsWith("--")) {
      console.error(USAGE);
      fail(`unknown option ${arg}`);
    } else target.push(arg);
  }
  if (fields.poll) fields.poll = fields.poll.flatMap(splitOptions);
  if (fields.reactions) fields.reactions = fields.reactions.flatMap((value) => value.split(/[\s,]+/).filter(Boolean));
  return { text: text.join(" "), ...fields };
}

function splitOptions(value) {
  return value.split(",").map((option) => option.trim()).filter(Boolean);
}

function bar(count, total) {
  const filled = total ? Math.round((count / total) * 12) : 0;
  return "█".repeat(filled) + "░".repeat(12 - filled);
}

function describeEnd(result) {
  const lines = [`ended: ${result.text.split("\n")[0].slice(0, 60)}`];
  if (result.poll) {
    const total = result.votes.reduce((sum, count) => sum + count, 0);
    const width = Math.max(...result.poll.map((option) => option.length));
    lines.push(`  ${total} ${total === 1 ? "vote" : "votes"}`);
    result.poll.forEach((option, index) => {
      const share = total ? Math.round((result.votes[index] / total) * 100) : 0;
      lines.push(`  ${option.padEnd(width)}  ${bar(result.votes[index], total)}  ${result.votes[index]} (${share}%)`);
    });
  }
  if (result.reactions.length) {
    lines.push(`  ${result.reactions.map((emoji, index) => `${emoji} ${result.reacted[index]}`).join("   ")}`);
  }
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
    if (message.type === "sent") {
      console.log(`message sent, live for ${message.seconds}s${POSITIVE}`);
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
  const print = (text) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(text);
    rl?.prompt(true);
  };
  const socket = await connect((message) => {
    if (message.type === "error") print(`${message.message}${NEGATIVE}`);
    if (message.type === "sent") print(`sent, live for ${message.seconds}s${POSITIVE}`);
    if (message.type === "cleared") print(`every live message is down${POSITIVE}`);
    if (message.type === "ended") print(describeEnd(message));
  });
  let quitting = false;
  socket.on("close", () => {
    if (quitting) process.exit(0);
    print(`lost connection to the lyra server${NEGATIVE}`);
    process.exit(1);
  });
  console.log("live console connected, type a message and press enter to pop it up for everyone");
  console.log("/poll question, option, option   /clear   /quit");
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "notice> " });
  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    if (!input) return rl.prompt();
    if (input === "/quit") return rl.close();
    if (input === "/clear") return send(socket, { type: "clear" });
    if (input.startsWith("/poll ")) {
      const [text, ...poll] = splitOptions(input.slice(6));
      return send(socket, { type: "send", text, poll });
    }
    if (input.startsWith("/")) return print(`unknown command ${input.split(" ")[0]}${NEGATIVE}`);
    send(socket, { type: "send", text: input });
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
else await once({ type: "send", ...parseArgs(args) });
