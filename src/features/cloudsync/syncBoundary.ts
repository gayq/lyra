import {
  exportSyncSnapshot,
  importSyncSnapshot,
  type SyncSnapshot,
} from "./syncSnapshot.ts";

declare global {
  interface Window {
    lyraExportAllData?: () => Promise<SyncSnapshot>;
    lyraImportDataFromObject?: (
      data: unknown,
      callback?: (progressText: string) => void,
    ) => Promise<void>;
  }
}

window.lyraExportAllData = exportSyncSnapshot;
window.lyraImportDataFromObject = importSyncSnapshot;
