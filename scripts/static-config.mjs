import { createInterface } from "node:readline";

export function staticBackends(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("static backends are required... /ᐠ - ˕ -マ");
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.length > 8) throw new Error("invalid static backend list... /ᐠ - ˕ -マ");
  return entries.map((entry) => {
    let url;
    try { url = new URL(entry); } catch { throw new Error("invalid static backend... /ᐠ - ˕ -マ"); }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error("invalid static backend... /ᐠ - ˕ -マ");
    }
    return url.origin;
  }).filter((entry, index, all) => all.indexOf(entry) === index);
}

export async function promptStaticBackends(value, { input = process.stdin, output = process.stdout } = {}) {
  if (value !== undefined) return staticBackends(value);
  if (!input.isTTY) throw new Error("set LYRA_STATIC_BACKEND for a non-interactive static build... /ᐠ - ˕ -マ");
  const prompt = "backend urls (comma-separated, in fallback order): ";
  const reader = createInterface({ input, output });
  try {
    output.write(prompt);
    for await (const answer of reader) {
      try { return staticBackends(answer); }
      catch { output.write("enter 1 to 8 https origins without credentials, paths, queries, or fragments; localhost http is allowed... /ᐠ - ˕ -マ\n"); }
      output.write(prompt);
    }
  } finally { reader.close(); }
  throw new Error("static backend selection cancelled... /ᐠ - ˕ -マ");
}
