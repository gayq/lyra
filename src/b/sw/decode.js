function upstreamHostname(realUrlStr) {
  try {
    return new URL(realUrlStr).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const DISCORD_RELAY_SUFFIXES = [
  "discord.com",
  "discord.gg",
  "discord.media",
  "discordapp.com",
  "discordapp.net",
  "discordstatus.com",
];

function isDiscordRelayOnlyHost(hostname) {
  const normalizedHostname = (hostname || "").replace(/^www\./, "").toLowerCase();
  if (!normalizedHostname) return false;
  for (const suffix of DISCORD_RELAY_SUFFIXES) {
    if (normalizedHostname === suffix || normalizedHostname.endsWith("." + suffix)) return true;
  }
  return false;
}

function unwrapUrl(url) {
  if (!url) return null;
  if (url.pathname.startsWith(MOCHI_PREFIX)) return null;
  if (url.origin !== self.location.origin) {
    try {
      return new URL(url.href).href;
    } catch {
      return null;
    }
  }
  if (isFolio && url.pathname === "/f") {
    try { return folio.routeDestination(url.href); } catch { return null; }
  }

  return null;
}

const _AD_MK2 = "q7Zx!9pL";
function _adXorDec(encoded) {
  let decoded = "";
  for (let index = 0; index < encoded.length; index++) {
    decoded += String.fromCharCode(
      encoded.charCodeAt(index) ^ _AD_MK2.charCodeAt(index % _AD_MK2.length),
    );
  }
  return decoded;
}
