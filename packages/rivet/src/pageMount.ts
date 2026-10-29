import { installChromeApi } from "./chromeApi";
import { readExtFileText } from "./fileStore";
import {
  bootstrapExtensionFrame,
  rewriteExtHtml,
  writeDocument,
} from "./htmlInject";
import type { RivetRegistry } from "./registry";
import type { RivetHostBindings } from "./types";
import { NEGATIVE } from "./messages";
import {
  buildExtensionUrl,
  chromeExtensionUrl,
  decodeRivetUrl,
  extensionDocumentUrl,
  RIVET_CHILD_FRAME_MOUNT_KEY,
  RIVET_PREFIX,
} from "./urlScheme";

const extensionPageMountVersions = new WeakMap<HTMLIFrameElement, number>();
const mountedExtensionDocuments = new WeakSet<Document>();

export function isMountedExtensionDocument(
  document: Document | null | undefined,
): boolean {
  return !!document && mountedExtensionDocuments.has(document);
}

export function cancelExtensionPageMount(frame: HTMLIFrameElement): void {
  extensionPageMountVersions.set(
    frame,
    (extensionPageMountVersions.get(frame) ?? 0) + 1,
  );
  try {
    frame.removeAttribute("srcdoc");
    frame.src = "about:blank";
  } catch {}
}

function isTampermonkey(manifestName: string): boolean {
  return manifestName.startsWith("Tampermonkey");
}

function extensionPageDocumentPath(
  pagePath: string,
  tabId: number | null,
  isPopup: boolean,
  manifestName = "",
): string {
  if (
    !isPopup ||
    !isTampermonkey(manifestName) ||
    tabId === null ||
    pagePath.includes("#")
  )
    return pagePath;
  return `${pagePath}#${tabId}`;
}

export function extensionPageReloadTarget(
  pagePath: string,
  currentUrl: string,
  appOrigin: string,
  extId?: string,
): string | null {
  const resourcePath = pagePath.replace(/[?#].*$/, "").replace(/^\/+/, "");
  if (!resourcePath) return null;
  try {
    const url = new URL(currentUrl);
    if (
      url.protocol === "chrome-extension:" &&
      extId &&
      url.hostname === extId
    ) {
      const target = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      return target ? `${target}${url.search}${url.hash}` : null;
    }
    if (url.origin !== appOrigin) return null;
    if (url.pathname === `/${resourcePath}`) {
      return `${resourcePath}${url.search}${url.hash}`;
    }
    if (!extId) return null;
    const extensionPrefix = `${RIVET_PREFIX}${extId}/`;
    if (!url.pathname.startsWith(extensionPrefix)) return null;
    const target = decodeURIComponent(
      url.pathname.slice(extensionPrefix.length),
    );
    if (target === "__bootstrap__") return null;
    return target ? `${target}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

function keepBaseRelativeNavigationsInDocument(realm: Window): void {
  const navigation = realm.navigation as Navigation | undefined;
  navigation?.addEventListener("navigate", (event) => {
    if (
      !event.cancelable ||
      event.hashChange ||
      event.formData ||
      (event.navigationType !== "push" && event.navigationType !== "replace")
    )
      return;
    let destination: URL;
    let base: URL;
    try {
      destination = new URL(event.destination.url);
      base = new URL(realm.document.baseURI);
    } catch {
      return;
    }
    if (
      destination.origin !== base.origin ||
      destination.pathname !== base.pathname
    )
      return;
    const target = new URL(realm.location.href);
    if (destination.search) target.search = destination.search;
    target.hash = destination.hash;
    if (target.href === destination.href) return;
    event.preventDefault();
    navigation.navigate(target.href, {
      history: event.navigationType,
      info: event.info,
    });
  });
}

function exposeChildFrameMount(
  realm: Window,
  extId: string,
  mountChild: (
    frame: HTMLIFrameElement,
    pagePath: string,
    childWindow: Window,
  ) => void,
): void {
  Object.defineProperty(realm, Symbol.for(RIVET_CHILD_FRAME_MOUNT_KEY), {
    configurable: true,
    value: (childWindow: Window) => {
      try {
        const frame = childWindow.frameElement;
        if (childWindow.parent !== realm || frame?.tagName !== "IFRAME")
          return false;
        const target = decodeRivetUrl(childWindow.location.href);
        if (target?.extId !== extId) return false;
        mountChild(frame as HTMLIFrameElement, target.path, childWindow);
        return true;
      } catch {
        return false;
      }
    },
  });
}

function extensionPageSenderUrl(
  extId: string,
  pagePath: string,
  manifestName = "",
): string {
  if (isTampermonkey(manifestName)) {
    return chromeExtensionUrl(extId, pagePath);
  }
  return buildExtensionUrl(extId, pagePath);
}

export async function mountExtensionPage(
  frame: HTMLIFrameElement,
  extId: string,
  pagePath: string,
  tabId: number | null,
  registry: RivetRegistry,
  host: RivetHostBindings,
  skipTabRegistration: boolean,
  childFrameWindow?: Window,
): Promise<boolean> {
  const mountVersion = (extensionPageMountVersions.get(frame) ?? 0) + 1;
  extensionPageMountVersions.set(frame, mountVersion);
  const isCurrent = () =>
    extensionPageMountVersions.get(frame) === mountVersion &&
    frame.isConnected !== false &&
    (!childFrameWindow || frame.contentWindow === childFrameWindow);
  const isPopup = skipTabRegistration && !childFrameWindow;
  const win =
    childFrameWindow ??
    (await bootstrapExtensionFrame(frame, extId, isCurrent));
  if (!win || !isCurrent()) return false;
  const resourcePath = pagePath.replace(/[?#].*$/, "").replace(/^\//, "");
  if (!resourcePath) return false;

  const raw = await readExtFileText(extId, resourcePath);
  if (raw === null || !isCurrent()) return false;
  const ext = registry.get(extId);
  const html = await rewriteExtHtml(extId, raw, pagePath);
  if (!isCurrent()) return false;
  const documentPath = extensionPageDocumentPath(
    pagePath,
    tabId,
    isPopup,
    ext?.manifest.name,
  );
  win.history.replaceState(null, "", buildExtensionUrl(extId, documentPath));
  let events: ReturnType<typeof installChromeApi> | null = null;
  await writeDocument(
    win,
    html,
    (realm) => {
      mountedExtensionDocuments.add(realm.document);
      keepBaseRelativeNavigationsInDocument(realm);
      exposeChildFrameMount(realm, extId, (childFrame, childPath, childWin) => {
        void mountExtensionPage(
          childFrame,
          extId,
          childPath,
          tabId,
          registry,
          host,
          true,
          childWin,
        ).catch((error) =>
          console.warn(
            "[rivet] child extension frame failed to mount",
            error,
            NEGATIVE,
          ),
        );
      });
      if (isPopup && host.closeExtensionPopup) {
        const closePopup = () => host.closeExtensionPopup?.(extId);
        try {
          Object.defineProperty(realm, "close", {
            configurable: true,
            value: closePopup,
          });
        } catch {
          realm.close = closePopup;
        }
      }

      events = installChromeApi(realm, {
        extId,
        tabId,
        isBackground: false,
        registry,
        host,
        skipTabRegistration,
        senderUrl: extensionPageSenderUrl(
          extId,
          documentPath,
          ext?.manifest.name,
        ),
      });
    },
    extensionDocumentUrl(documentPath),
    isCurrent,
  );

  if (!isCurrent()) return false;

  if (isPopup) {
    if (ext) ext.popupEvents = events;
  }
  return true;
}
