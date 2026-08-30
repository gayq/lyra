interface GameMetadataProvider {
  getCover(realUrl: string): string | null;
  getDisplayLabel(realUrl: string): string | null;
}

let provider: GameMetadataProvider | null = null;

export function registerGameMetadataProvider(next: GameMetadataProvider): void {
  provider = next;
}

export function getLoadedGameCover(realUrl: string): string | null {
  return provider?.getCover(realUrl) ?? null;
}

export function getLoadedGameDisplayLabel(realUrl: string): string | null {
  return provider?.getDisplayLabel(realUrl) ?? null;
}
