function upstreamHostname(realUrlStr) {
  try {
    return new URL(realUrlStr).hostname.toLowerCase();
  } catch (e) {
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
  const h = (hostname || "").replace(/^www\./, "").toLowerCase();
  if (!h) return false;
  for (let i = 0; i < DISCORD_RELAY_SUFFIXES.length; i++) {
    const s = DISCORD_RELAY_SUFFIXES[i];
    if (h === s || h.endsWith("." + s)) return true;
  }
  return false;
}

function unwrapUrl(url) {
  if (!url) return null;
  if (url.pathname.startsWith(MOCHI_PREFIX)) return null;
  if (url.origin !== self.location.origin) {
    try {
      return new URL(url.href).href;
    } catch (e) {
      return null;
    }
  }
  if (isScramjet && url.pathname.startsWith("/b/s/")) {
    const raw = url.pathname.slice(5) + url.search;
    const httpIndex = raw.indexOf("http");
    if (httpIndex !== -1) {
      const candidate = raw.substring(httpIndex);
      try {
        const decoded = decodeURIComponent(candidate);
        return new URL(decoded).href;
      } catch (e) {
        try {
          return new URL(candidate).href;
        } catch (err) {
          return null;
        }
      }
    }
  }
  if (
    isUltraviolet &&
    self.__uv$config &&
    typeof self.__uv$config.decodeUrl === "function"
  ) {
    const prefix = self.__uv$config.prefix || "/b/u/hi/";
    if (url.pathname.startsWith(prefix)) {
      const encoded = url.pathname.slice(prefix.length);
      try {
        const decoded = self.__uv$config.decodeUrl(encoded);
        if (!decoded) return null;
        if (decoded.includes(self.location.host)) {
          const decodedObj = new URL(decoded);
          if (decodedObj.origin === self.location.origin) return null;
        }
        return new URL(decoded + url.search, "http://somthing").href.replace(
          "http://somthing",
          "",
        );
      } catch (e) {}
    }
  }
  return null;
}

const _AD_MK2 = "q7Zx!9pL";
function _adXorDec(s) {
  let o = "";
  for (let i = 0; i < s.length; i++) {
    o += String.fromCharCode(
      s.charCodeAt(i) ^ _AD_MK2.charCodeAt(i % _AD_MK2.length),
    );
  }
  return o;
}

function adTarget(requestUrl) {
  try {
    const u = new URL(requestUrl);
    if (u.origin !== self.location.origin) return u.href;
    if (u.pathname.startsWith(MOCHI_PREFIX)) {
      let encodedPart = u.pathname.slice(MOCHI_PREFIX.length);
      if (encodedPart.endsWith("/")) encodedPart = encodedPart.slice(0, -1);
      try {
        let p = encodedPart.replace(/-/g, "+").replace(/_/g, "/");
        while (p.length % 4) p += "=";
        const raw = atob(p);
        const dec = _adXorDec(raw);
        const result = decodeURIComponent(dec);
        if (result.startsWith("http")) return result;
      } catch (e) {}
      if (encodedPart.startsWith("http")) return encodedPart;
    }
    if (isScramjet && u.pathname.startsWith("/b/s/")) {
      const raw = u.pathname.slice(5) + u.search;
      const httpIndex = raw.indexOf("http");
      if (httpIndex !== -1) {
        const candidate = raw.substring(httpIndex);
        try {
          return decodeURIComponent(candidate);
        } catch (e) {
          return candidate;
        }
      }
    }
    if (
      isUltraviolet &&
      self.__uv$config &&
      typeof self.__uv$config.decodeUrl === "function"
    ) {
      const prefix = self.__uv$config.prefix || "/b/u/hi/";
      if (u.pathname.startsWith(prefix)) {
        try {
          return self.__uv$config.decodeUrl(u.pathname.slice(prefix.length));
        } catch (e) {}
      }
    }
  } catch (e) {}
  return requestUrl;
}