import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { getStoredGameSource } from "../../core/config/settingsOptions.ts";
import {
  fetchGameData,
  gameCatalogErrorMessage,
  type GameEntry,
} from "./games.ts";

/** Each view owns its presentation state; only games.ts writes the catalog/cache. */
export function useGameCatalog(active: boolean) {
  const [games, setGames] = useState<GameEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(() => {
    const request = ++generation.current;
    const source = getStoredGameSource();
    const current = () =>
      request === generation.current && source === getStoredGameSource();
    setLoading(true);
    setError(null);
    void fetchGameData()
      .then((entries) => {
        if (!current()) return;
        setGames(entries);
        setLoaded(true);
        setLoading(false);
      })
      .catch((cause) => {
        if (!current()) return;
        setError(gameCatalogErrorMessage(cause));
        setLoaded(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    const updated = (event: Event) => {
      const detail = (
        event as CustomEvent<{ source?: string; games?: GameEntry[] }>
      ).detail;
      if (!detail?.games || detail.source !== getStoredGameSource()) return;
      generation.current += 1;
      setGames(detail.games);
      setLoaded(true);
      setLoading(false);
      setError(null);
    };
    const sourceChanged = () => {
      generation.current += 1;
      setGames([]);
      setLoaded(false);
      setLoading(false);
      setError(null);
      if (active) load();
    };
    window.addEventListener("lyra:game-catalog-updated", updated);
    document.addEventListener("gameSourceUpdated", sourceChanged);
    if (active && (!loaded || games.length === 0)) load();
    return () => {
      window.removeEventListener("lyra:game-catalog-updated", updated);
      document.removeEventListener("gameSourceUpdated", sourceChanged);
      generation.current += 1;
    };
  }, [active, load]);

  return { games, loaded, loading, error };
}
