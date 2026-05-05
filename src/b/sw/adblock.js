const ADBLOCK_LISTS = [
  "/!!/https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt",
  "/!!/https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext",
  "/!!/https://s3.amazonaws.com/lists.disconnect.me/simple_ad.txt",
  "/!!/https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt",
];

const ADBLOCK_KEYWORDS = [
  "/ads/", "/adserver/", "/adtracking/", "-ad-track.", "/analytics.js",
  "/tracking.js", "/pixel.js", "/gpt.js", "/prebid.js", "/ads.min.js",
  "/ad-script.js", "/tracker.js", "/beacon.js", "/events.js", "/gtm.js",
  "/fbevents.js", "/insight.min.js", "/beacon.min.js", "banner_ad",
  "google_ads", "/pagead/", "/ad/g/cors", "pagead2.googlesyndication.com",
  "doubleclick.net", "adsystem.com", "yandex.ru/metrika", "vk.com/rtrg",
  "clarity.ms", "tracking/pixel", "/track/event",
];

const ADBLOCK_KEYWORD_REGEX = new RegExp(
  ADBLOCK_KEYWORDS.map((k) => k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|"),
  "i",
);

const ADBLOCK_SKIP = ["archiveofourown.org"];

function adblockSkip(hostname) {
  const h = (hostname || "").toLowerCase();
  for (let i = 0; i < ADBLOCK_SKIP.length; i++) {
    const s = ADBLOCK_SKIP[i];
    if (h === s || (s && h.endsWith("." + s))) return true;
  }
  return false;
}

async function loadAdLists() {
  try {
    const listCache = await caches.open("waves-adblock-v1");
    const newDomains = new Set(["doubleclick.net", "google-analytics.com"]);
    await Promise.all(
      ADBLOCK_LISTS.map(async (url) => {
        try {
          let text = "";
          const cached = await listCache.match(url);
          let shouldFetch = !cached;
          if (cached) {
            const dateStr = cached.headers.get("date");
            const age = dateStr
              ? Date.now() - new Date(dateStr).getTime()
              : Infinity;
            if (age > 86400000) shouldFetch = true;
          }
          if (shouldFetch) {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 3000);
            try {
              const res = await fetch(url, { signal: ctrl.signal });
              clearTimeout(timeoutId);
              if (res.ok) {
                text = await res.text();
                listCache
                  .put(
                    url,
                    new Response(text, {
                      headers: {
                        date: new Date().toUTCString(),
                        "content-type": "text/plain",
                      },
                    }),
                  )
                  .catch(() => {});
              } else if (cached) {
                text = await cached.text();
              }
            } catch (e) {
              if (cached) text = await cached.text();
            }
          } else {
            text = await cached.text();
          }
          if (!text) return;
          let start = 0;
          let end = text.indexOf("\n");
          while (end !== -1) {
            let line = text.substring(start, end).trim();
            start = end + 1;
            end = text.indexOf("\n", start);
            if (!line || line[0] === "#") continue;
            const hashIdx = line.indexOf("#");
            if (hashIdx !== -1) line = line.substring(0, hashIdx).trim();
            if (line.startsWith("0.0.0.0 ")) {
              const domain = line.substring(8).trim();
              if (domain && domain !== "0.0.0.0") newDomains.add(domain);
            } else if (line.startsWith("127.0.0.1 ")) {
              const domain = line.substring(10).trim();
              if (domain && domain !== "localhost") newDomains.add(domain);
            } else if (line.indexOf(" ") === -1 && line.indexOf(".") !== -1) {
              newDomains.add(line.toLowerCase());
            }
          }
        } catch (err) {}
      }),
    );
    adblockDomains = newDomains;
    isAdblockReady = true;
  } catch (globalErr) {}
}

function readyAds() {
  if (isAdblockReady) return Promise.resolve();
  if (!adblockInitPromise) adblockInitPromise = loadAdLists();
  return adblockInitPromise;
}

function adBlocked(candidate, isNavigate) {
  if (!isAdblockReady || !candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const host = candidateUrl.hostname.toLowerCase();
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      if (adblockDomains.has(parts.slice(i).join("."))) return true;
    }
    if (host === self.location.hostname) return false;
    if (!isNavigate && !adblockSkip(host)) {
      const pathInfo = (
        candidateUrl.pathname + candidateUrl.search
      ).toLowerCase();
      if (ADBLOCK_KEYWORD_REGEX.test(pathInfo)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

readyAds();