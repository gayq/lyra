import type { ExtensionState, RealmEvents, RivetRegistry } from "../registry";
import type { RivetHostBindings } from "../types";

export interface ChromeApiContext {
  realm: Window;
  extId: string;
  tabId: number | null;
  registry: RivetRegistry;
  host: RivetHostBindings;
  ext: ExtensionState;
  events: RealmEvents;
  isBackground?: boolean;
  senderUrl: string | undefined;
  senderFrameId: number | undefined;
  senderDocumentId: string | undefined;
}

export type InstallApiInTab = (realm: Window, tabId: number) => void;
