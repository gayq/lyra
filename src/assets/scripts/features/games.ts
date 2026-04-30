export interface GameEntry {
  id: string | number;
  name: string;
  author?: string | undefined;
  coverUrl: string;
  gameUrl: string;
  isExternal: boolean;
  featured: boolean;
  sourceKey: string;
  _nameLc?: string;
  _authorLc?: string;
}

interface SourceConfig {
  selenite: { games: string; assets: string };
  "gn-math": { zones: string; covers: string; html: string };
  velara: { games: string; assets: string };
  edurocks: { games: string; assets: string };
}

type SourceKey = keyof SourceConfig;

interface SeleniteGame {
  name: string;
  directory: string;
  image?: string;
}

interface VelaraGame {
  title: string;
  location?: string;
  image?: string;
  grdmca?: unknown;
}

interface EdurocksGame {
  id?: string | number;
  legacyId?: string | number;
  name: string;
  url: string;
  img: string;
}

interface GnMathZone {
  id: string | number;
  name: string;
  author?: string;
  cover: string;
  url: string;
  featured?: boolean;
}

const SOURCE_CONFIG: SourceConfig = {
  selenite: {
    games: "/!!/https://selenite.cc/resources/games.json",
    assets: "https://selenite.cc/resources/semag/",
  },
  "gn-math": {
    zones: "/!!/https://cdn.jsdelivr.net/gh/freebuisness/assets@main/zones.json",
    covers: "https://cdn.jsdelivr.net/gh/freebuisness/covers@main",
    html: "https://cdn.jsdelivr.net/gh/freebuisness/html@main",
  },
  velara: {
    games: "/!!/https://velara.cc/data/games.json",
    assets: "https://velara.cc",
  },
  edurocks: {
    games: "/!!/https://www.edurocks.org/gxxes.json",
    assets: "https://www.edurocks.org",
  },
};

let allGames: GameEntry[] = [];
let gameDataPromise: Promise<GameEntry[]> | null = null;

function getSourceKey(): SourceKey {
  const source = localStorage.getItem("gameSource") || "selenite";
  if (!["selenite", "gn-math", "edurocks", "velara"].includes(source)) {
    return "selenite";
  }
  return source as SourceKey;
}

function getCacheKey(sourceKey: SourceKey = getSourceKey()): string {
  return `waves-game-cache${sourceKey}`;
}

function applySearchCacheFields(games: GameEntry[]): GameEntry[] {
  for (const g of games) {
    g._nameLc = (g.name || "").toLowerCase();
    g._authorLc = (g.author || "").toLowerCase();
  }
  return games;
}

function normalizeGameMatchUrl(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.hostname.includes("gn-math.dev")) {
      const rawId = parsed.searchParams.get("id");
      if (rawId) {
        const cleanId = decodeURIComponent(rawId).trim().split(/[?&#]/)[0]!.trim();
        if (cleanId) {
          return `${parsed.protocol}//${parsed.host}/?id=${encodeURIComponent(cleanId)}`;
        }
      }
    }
    let pathname = parsed.pathname || "/";
    pathname = pathname.replace(/\/+$/, "") || "/";
    pathname = pathname.replace(/\/index\.(html?|php)$/i, "") || "/";
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return candidate.trim().replace(/\/+$/, "").toLowerCase();
  }
}

function saveToCache(source: SourceKey, games: GameEntry[]): GameEntry[] {
  try {
    sessionStorage.setItem(getCacheKey(source), JSON.stringify(games));
  } catch (e) {
    console.warn("unable to cache games", e);
  }
  return games;
}

function mapSeleniteGames(data: unknown): GameEntry[] {
  const games = Array.isArray(data) ? (data as SeleniteGame[]) : [];
  return games
    .filter((g) => g && g.name && g.directory)
    .map((game) => {
      const gamePath = String(game.directory).replace(/^\/+/, "");
      const imagePath = String(game.image || "").replace(/^\/+/, "");
      const finalUrl = `${SOURCE_CONFIG.selenite.assets}${gamePath}`;
      const finalCover = imagePath
        ? `${SOURCE_CONFIG.selenite.assets}${gamePath}/${imagePath}`
        : "";
      return {
        id: game.name,
        name: game.name,
        coverUrl: finalCover ? `/!cover!/${finalCover}` : "",
        gameUrl: finalUrl,
        isExternal: false,
        featured: false,
        sourceKey: "selenite",
      } satisfies GameEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapVelaraGames(data: unknown): GameEntry[] {
  const games = Array.isArray(data) ? (data as VelaraGame[]) : [];
  return games
    .filter(
      (g) =>
        g &&
        g.title &&
        g.title !== "!!DMCA" &&
        g.title !== "!!Game Request" &&
        !g.title.includes("[!]") &&
        !(g.location?.includes("astra")),
    )
    .map((game) => {
      let finalUrl = game.location ?? "";
      if (finalUrl && !finalUrl.startsWith("http")) {
        finalUrl = SOURCE_CONFIG.velara.assets + (finalUrl.startsWith("/") ? "" : "/") + finalUrl;
      }
      return {
        id: game.title,
        name: game.title,
        coverUrl: `/!cover!/${SOURCE_CONFIG.velara.assets}/${game.image ?? ""}`,
        gameUrl: finalUrl,
        isExternal: !game.location && !!game.grdmca,
        featured: false,
        sourceKey: "velara",
      } satisfies GameEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapEdurocksGames(data: unknown): GameEntry[] {
  const games = Array.isArray(data) ? (data as EdurocksGame[]) : [];
  return games
    .map((game) => {
      const base = SOURCE_CONFIG.edurocks.assets + "/";
      const finalUrl = game.url.startsWith("http")
        ? game.url
        : base + game.url.replace(/^\.\//, "");
      const finalCover = game.img.startsWith("http")
        ? game.img
        : base + game.img.replace(/^\.\//, "");
      return {
        id: game.id ?? game.legacyId ?? game.name,
        name: game.name,
        coverUrl: `/!cover!/${finalCover}`,
        gameUrl: finalUrl,
        isExternal: false,
        featured: false,
        sourceKey: "edurocks",
      } satisfies GameEntry;
    })
    .filter((g) => !g.name.includes("[!]"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapGnMathGames(data: unknown): GameEntry[] {
  const zones = Array.isArray(data) ? (data as GnMathZone[]) : [];
  return zones
    .map((zone) => {
      const isExternal = zone.url ? zone.url.startsWith("http") : false;
      const finalUrl = zone.url ? zone.url.replace("{HTML_URL}", SOURCE_CONFIG["gn-math"].html) : `https://gn-math.dev/?id=${zone.id}`;
      return {
        id: zone.id,
        name: zone.name,
        author: zone.author,
        coverUrl: `/!cover!/${zone.cover.replace("{COVER_URL}", SOURCE_CONFIG["gn-math"].covers)}`,
        gameUrl: isExternal ? zone.url : finalUrl,
        isExternal,
        featured: zone.featured ?? false,
        sourceKey: "gn-math",
      } satisfies GameEntry;
    })
    .filter((g) => !g.name.includes("[!]") && !g.name.startsWith("Chat Bot"))
    .sort((a, b) =>
      a.featured === b.featured ? a.name.localeCompare(b.name) : a.featured ? -1 : 1,
    );
}

export function fetchGameData(): Promise<GameEntry[]> {
  if (gameDataPromise) return gameDataPromise;

  const source = getSourceKey();
  const cacheKey = getCacheKey(source);

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      allGames = JSON.parse(cached) as GameEntry[];
      return Promise.resolve(allGames);
    }
  } catch {
    sessionStorage.removeItem(cacheKey);
  }

  const ok = (res: Response) => (res.ok ? res.json() : Promise.reject(res.statusText));

  const mappers: Record<SourceKey, () => Promise<GameEntry[]>> = {
    velara: () =>
      fetch(SOURCE_CONFIG.velara.games)
        .then(ok)
        .then((d) => saveToCache(source, applySearchCacheFields(mapVelaraGames(d)))),
    selenite: () =>
      fetch(SOURCE_CONFIG.selenite.games)
        .then(ok)
        .then((d) => saveToCache(source, applySearchCacheFields(mapSeleniteGames(d)))),
    edurocks: () =>
      fetch(SOURCE_CONFIG.edurocks.games)
        .then(ok)
        .then((d) => saveToCache(source, applySearchCacheFields(mapEdurocksGames(d)))),
    "gn-math": () =>
      fetch(SOURCE_CONFIG["gn-math"].zones)
        .then(ok)
        .then((d) => saveToCache(source, applySearchCacheFields(mapGnMathGames(d)))),
  };

  gameDataPromise = (mappers[source] ?? mappers.selenite)().then((games) => {
    allGames = games;
    return games;
  });

  gameDataPromise.catch((err) => {
    console.error("game fetch failed:", err);
    gameDataPromise = null;
  });

  return gameDataPromise;
}

export function resetGameCache(): void {
  allGames = [];
  gameDataPromise = null;
  try {
    sessionStorage.removeItem(getCacheKey());
  } catch {}
}

export function getGameDisplayLabel(realUrl: string): string | null {
  try {
    if (!realUrl || !allGames.length) return null;

    let match = allGames.find((g) => g.gameUrl === realUrl);

    if (!match) {
      const normalized = normalizeGameMatchUrl(realUrl);
      if (normalized) {
        match = allGames.find((g) => normalizeGameMatchUrl(g.gameUrl) === normalized);
      }
    }

    if (!match) {
      try {
        const u = new URL(realUrl);
        if (u.hostname.includes("gn-math.dev")) {
          const id = u.searchParams.get("id");
          if (id) {
            const rawId = String(id).trim();
            const decodedId = decodeURIComponent(rawId);
            match = allGames.find(
              (g) =>
                g.sourceKey === "gn-math" &&
                (String(g.id) === rawId || String(g.id) === decodedId),
            );
            if (!match) {
              const numericId = rawId.match(/\d+/)?.[0];
              if (numericId) {
                match = allGames.find(
                  (g) => g.sourceKey === "gn-math" && String(g.id) === numericId,
                );
              }
            }
          }
        }
      } catch {}
    }

    if (!match) return null;

    const sourceKey = (
      match.sourceKey ||
      localStorage.getItem("gameSource") ||
      "selenite"
    ).toLowerCase();

    return `game: ${String(match.name || match.id || realUrl).toLowerCase()} / source: ${sourceKey}`;
  } catch {
    return null;
  }
}