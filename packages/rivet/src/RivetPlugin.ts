import { injectContentScripts } from "./contentScripts";
import {
  CONTENT_SCRIPT_STYLE_ATTRIBUTE,
  type NativeDomOperations,
} from "./htmlInject";
import type { Rivet } from "./rivet";

export type FolioManagedPluginConstructor = new (
  name: string,
  dependencies: string[],
) => {
  install(frame: unknown): void;
  tap(
    hook: unknown,
    callback: (
      context: FolioFrameInitContext,
      props: unknown,
    ) => void | Promise<void>,
  ): void;
};

type FolioFrameInitContext = {
  window?: Window;
  client?: {
    url?: { href?: string };
    natives?: NativeDomOperations["natives"];
    descriptors?: NativeDomOperations["descriptors"];
    locationProxy?: Location;
  };
  isTopLevel?: boolean;
};

type FolioFrame = {
  hooks: { init: { pre: unknown; post: unknown } };
};

const contextMenuWindows = new WeakSet<Window>();

function isCloudflareChallengeFrame(url: string): boolean {
  try {
    return new URL(url).hostname === "challenges.cloudflare.com";
  } catch {
    return false;
  }
}

function contentScriptDocumentBindings(
  win: Window,
  location: Location,
): Record<string, unknown> {
  const nativeStyleSheets = win.document.styleSheets;
  const contentStyleSheets = new Proxy(nativeStyleSheets, {
    get(target, property) {
      const visible = Array.from(target).filter((sheet) => {
        const owner = sheet.ownerNode;
        return (
          !owner ||
          !("hasAttribute" in owner) ||
          !owner.hasAttribute(CONTENT_SCRIPT_STYLE_ATTRIBUTE)
        );
      });
      if (property === "length") return visible.length;
      if (property === "item") {
        return (index: number) => visible[index] ?? null;
      }
      if (property === Symbol.iterator)
        return visible[Symbol.iterator].bind(visible);
      if (typeof property === "string" && /^\d+$/.test(property)) {
        return visible[Number(property)];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const documentProxy: Document = new Proxy(win.document, {
    get(target, property) {
      if (property === "location") return location;
      if (property === "styleSheets") return contentStyleSheets;
      if (property === "createTreeWalker") {
        return (
          root: Node,
          whatToShow?: number,
          filter?: NodeFilter | null,
        ) => {
          let bridgedFilter = filter;
          if (typeof filter === "function") {
            bridgedFilter = (node) => Reflect.apply(filter, undefined, [node]);
          } else if (filter && typeof filter.acceptNode === "function") {
            const acceptNode = filter.acceptNode;
            bridgedFilter = {
              acceptNode: (node) => Reflect.apply(acceptNode, filter, [node]),
            };
          }
          return target.createTreeWalker(
            root === documentProxy ? target : root,
            whatToShow,
            bridgedFilter,
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
  const NativeMutationObserver = (
    win as unknown as { MutationObserver: typeof MutationObserver }
  ).MutationObserver;
  class ContentScriptMutationObserver extends NativeMutationObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      super.observe(target === documentProxy ? win.document : target, options);
    }
  }
  return {
    document: documentProxy,
    MutationObserver: ContentScriptMutationObserver,
  };
}

function installContextMenuBridge(
  win: Window,
  rivet: Rivet,
  tabId: number,
): void {
  if (contextMenuWindows.has(win) || !rivet.host.showContextMenu) return;
  contextMenuWindows.add(win);
  win.addEventListener("contextmenu", (rawEvent) => {
    const event = rawEvent as MouseEvent;
    const target =
      event.target && typeof (event.target as Element).closest === "function"
        ? (event.target as Element)
        : null;
    const link = target?.closest("a[href]") as HTMLAnchorElement | null;
    const media = target?.closest("img,video,audio") as
      HTMLImageElement | HTMLMediaElement | null;
    const editable =
      target?.tagName === "INPUT" ||
      target?.tagName === "TEXTAREA" ||
      Boolean(target?.closest("[contenteditable='true']"));
    const selectionText = win.getSelection?.()?.toString().trim() || undefined;
    const context = selectionText
      ? "selection"
      : link
        ? "link"
        : (media?.tagName.toLowerCase() ?? (editable ? "editable" : "page"));
    const info = {
      pageUrl: win.location.href,
      frameUrl: win.location.href,
      ...(link?.href ? { linkUrl: link.href } : {}),
      ...(media && "src" in media && media.src ? { srcUrl: media.src } : {}),
      ...(selectionText ? { selectionText } : {}),
      ...(editable ? { editable: true } : {}),
    };
    const items = rivet.getContextMenuItems(context, info);
    if (!items.length) return;
    event.preventDefault();
    event.stopPropagation();
    rivet.host.showContextMenu?.({
      tabId,
      clientX: event.clientX,
      clientY: event.clientY,
      items,
      info,
    });
  });
}

export function createRivetContentScriptPlugin(
  ManagedPlugin: FolioManagedPluginConstructor,
  rivet: Rivet,
  tabId: number,
): InstanceType<FolioManagedPluginConstructor> {
  return new (class RivetContentScriptPlugin extends ManagedPlugin {
    override install(frame: FolioFrame): void {
      super.install(frame);
      this.tap(frame.hooks.init.post, async (context) => {
        const win = context?.window;
        if (!win) return;
        const url = context.client?.url?.href || win.location.href;
        if (isCloudflareChallengeFrame(url)) return;
        installContextMenuBridge(win, rivet, tabId);
        const nativeDom =
          context.client?.natives && context.client.descriptors
            ? {
                natives: context.client.natives,
                descriptors: context.client.descriptors,
              }
            : undefined;
        const scopeBindings =
          context.client?.locationProxy && nativeDom
            ? contentScriptDocumentBindings(win, context.client.locationProxy)
            : {};
        await injectContentScripts(
          win,
          tabId,
          url,
          context.isTopLevel === true,
          rivet.registry,
          rivet.host,
          nativeDom,
          scopeBindings,
        );
      });
    }
  })("rivet-content-scripts", []);
}
