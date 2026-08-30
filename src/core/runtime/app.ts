interface LyraAppSurface {
  handleSearch?: (
    query: string,
    gameName?: string | number,
    gameIcon?: string | null,
  ) => Promise<void> | void;
  getGameDisplayLabel?: (realUrl: string) => string | null;
}

export function app(): LyraAppSurface {
  return (window.Lyra ??= {}) as LyraAppSurface;
}
