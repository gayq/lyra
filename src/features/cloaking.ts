import {
  DEFAULT_SETTINGS,
  SITE_CLOAKING_OPTIONS,
} from "../core/config/settingsOptions.ts";

interface CloakingAppearance {
  title: string;
  icon: string;
}

const LYRA_APPEARANCE: CloakingAppearance = {
  title: "lyra :3",
  icon: "/assets/images/peaks/natsu.png",
};

const SITE_APPEARANCES: Record<string, CloakingAppearance> = {
  none: LYRA_APPEARANCE,
  google: {
    title: "Google",
    icon: "https://www.google.com/favicon.ico",
  },
  "google classroom": {
    title: "Home - Classroom",
    icon: "https://www.gstatic.com/classroom/logo_square_rounded.svg",
  },
  "google docs": {
    title: "Google Docs",
    icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon-2023q4.ico",
  },
  youtube: {
    title: "YouTube",
    icon: "https://www.youtube.com/s/desktop/014dbbed/img/favicon_32x32.png",
  },
  "google drive": {
    title: "Google Drive",
    icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png",
  },
  schoology: {
    title: "Home | Schoology",
    icon: "https://asset-cdn.schoology.com/sites/all/themes/schoology_theme/favicon.ico",
  },
  wikipedia: {
    title: "Wikipedia, the free encyclopedia",
    icon: "https://en.wikipedia.org/static/favicon/wikipedia.ico",
  },
  canva: {
    title: "Home - Canva",
    icon: "https://static.canva.com/domain-assets/canva/static/images/favicon-1.ico",
  },
};

let initialized = false;

function resolveSiteCloaking(value: string | null): string {
  if (value === "default") return DEFAULT_SETTINGS.siteCloaking;
  return value && (SITE_CLOAKING_OPTIONS as readonly string[]).includes(value)
    ? value
    : DEFAULT_SETTINGS.siteCloaking;
}

function resolveCloakingAppearance(
  siteCloaking: string,
  focusCloaking: boolean,
  tabActive: boolean,
  original: CloakingAppearance,
): CloakingAppearance {
  if (focusCloaking && tabActive) return LYRA_APPEARANCE;

  const resolvedSite = resolveSiteCloaking(siteCloaking);
  if (resolvedSite === DEFAULT_SETTINGS.siteCloaking) return original;
  return SITE_APPEARANCES[resolvedSite] ?? original;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildCloakedPage(
  appearance: CloakingAppearance,
  appUrl: string,
): string {
  const title = escapeHtml(appearance.title);
  const icon = escapeHtml(appearance.icon);
  const iframeUrl = escapeHtml(appUrl);
  return `<!doctype html><html><head><title>${title}</title><link rel="icon" href="${icon}"></head><body style="margin:0"><iframe title="lyra" style="height:100%;width:100%;border:0;position:fixed;inset:0" src="${iframeUrl}"></iframe></body></html>`;
}

function isFramed(): boolean {
  try {
    return window !== window.top;
  } catch {
    return true;
  }
}

function openCloakedTab(
  linkCloaking: string,
  siteCloaking: string,
  original: CloakingAppearance,
): void {
  if (linkCloaking === "none" || isFramed()) return;

  const appearance = resolveCloakingAppearance(
    siteCloaking,
    false,
    false,
    original,
  );
  const appUrl = window.location.origin;
  let popup: Window | null = null;

  if (linkCloaking === "about:blank") {
    popup = window.open("", "_blank");
    if (popup && !popup.closed) {
      popup.document.open();
      popup.document.write(buildCloakedPage(appearance, appUrl));
      popup.document.close();
    }
  } else if (linkCloaking === "blob:") {
    const blobUrl = URL.createObjectURL(
      new Blob([buildCloakedPage(appearance, appUrl)], { type: "text/html" }),
    );
    popup = window.open(blobUrl, "_blank");
    if (!popup || popup.closed) {
      URL.revokeObjectURL(blobUrl);
    } else {
      popup.addEventListener("load", () => URL.revokeObjectURL(blobUrl), {
        once: true,
      });
    }
  }

  if (!popup || popup.closed) return;
  window.bypassPreventClosing = true;
  window.location.replace("https://classroom.google.com/");
}

export function initCloaking(): void {
  if (initialized) return;
  initialized = true;

  const originalIcon =
    document.querySelector<HTMLLinkElement>("link[rel*='icon']")?.href ||
    LYRA_APPEARANCE.icon;
  const original: CloakingAppearance = {
    title: document.title,
    icon: originalIcon,
  };
  let focusCloaking = localStorage.getItem("focusCloaking") !== "false";
  let expectedTitle = original.title;

  const applyAppearance = (appearance: CloakingAppearance) => {
    expectedTitle = appearance.title;
    if (document.title !== appearance.title) document.title = appearance.title;
    const iconUrl = new URL(appearance.icon, window.location.href).href;

    let icons = document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']");
    if (icons.length === 0) {
      const icon = document.createElement("link");
      icon.rel = "icon";
      document.head.appendChild(icon);
      icons = document.querySelectorAll<HTMLLinkElement>("link[rel*='icon']");
    }
    icons.forEach((icon) => {
      if (icon.href !== iconUrl) icon.href = iconUrl;
    });
  };

  const updateAppearance = () => {
    const siteCloaking = resolveSiteCloaking(
      localStorage.getItem("siteCloaking"),
    );
    if (localStorage.getItem("siteCloaking") !== siteCloaking) {
      localStorage.setItem("siteCloaking", siteCloaking);
    }
    applyAppearance(
      resolveCloakingAppearance(
        siteCloaking,
        focusCloaking,
        !document.hidden && document.hasFocus(),
        original,
      ),
    );
  };

  const title = document.querySelector("title");
  if (title) {
    new MutationObserver(() => {
      if (document.title !== expectedTitle) document.title = expectedTitle;
    }).observe(title, { childList: true, subtree: true, characterData: true });
  }

  window.addEventListener("focus", () => setTimeout(updateAppearance, 10));
  window.addEventListener("blur", () => setTimeout(updateAppearance, 10));
  document.addEventListener("visibilitychange", updateAppearance);

  document.addEventListener("siteCloakingUpdated", (event) => {
    const siteCloaking = resolveSiteCloaking(
      (event as CustomEvent<string>).detail,
    );
    localStorage.setItem("siteCloaking", siteCloaking);
    updateAppearance();
  });

  document.addEventListener("focusCloakingUpdated", (event) => {
    focusCloaking = (event as CustomEvent<boolean>).detail;
    updateAppearance();
  });

  document.addEventListener("linkCloakingUpdated", (event) => {
    const detail = (
      event as CustomEvent<{
        linkCloaking: string;
        siteCloaking: string;
      }>
    ).detail;
    openCloakedTab(detail.linkCloaking, detail.siteCloaking, original);
  });

  updateAppearance();

  const applySavedLinkCloaking = () => {
    openCloakedTab(
      localStorage.getItem("linkCloaking") || DEFAULT_SETTINGS.linkCloaking,
      resolveSiteCloaking(localStorage.getItem("siteCloaking")),
      original,
    );
  };
  if (document.readyState === "complete") {
    applySavedLinkCloaking();
  } else {
    window.addEventListener("load", applySavedLinkCloaking, { once: true });
  }
}
