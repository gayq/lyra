import { normalizeCatalogText } from "./catalogSearch.ts";
import {
  GameCatalogError,
  parseGameCatalog,
  type GameEntry,
} from "./gameSources.ts";
import type { GameSourceKey } from "../../core/config/settingsOptions.ts";

export function prepareCatalogGames(games: readonly GameEntry[]): GameEntry[] {
  const seenUrls = new Set<string>();
  const uniqueGames: GameEntry[] = [];
  for (const game of games) {
    if (seenUrls.has(game.gameUrl)) continue;
    seenUrls.add(game.gameUrl);
    game._normalizedName = normalizeCatalogText(game.name || "");
    game._normalizedAuthor = normalizeCatalogText(game.author || "");
    uniqueGames.push(game);
  }
  return uniqueGames;
}

export function processCatalog(input: {
  source: GameSourceKey;
  payload: unknown;
  json: boolean;
}) {
  let payload = input.payload;
  if (input.json) {
    try {
      payload = JSON.parse(payload as string);
    } catch {
      throw new GameCatalogError("catalog response could not be parsed", {
        kind: "upstream-data",
        source: input.source,
      });
    }
  }
  return prepareCatalogGames(parseGameCatalog(input.source, payload));
}
