export {};

interface SiteCloakingPreset {
  title: string;
  icon: string;
}

interface DBExportRecord {
  key: unknown;
  value: unknown;
}

interface DBExportStore {
  __isExportFormatV2: boolean;
  usesOutOfLineKeys: boolean;
  data: DBExportRecord[];
}

type DBExport = Record<string, DBExportStore>;

interface MasterExport {
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: string;
  indexedDB: Record<string, DBExport>;
  [key: string]: unknown;
}

declare global {
  interface Window {
    wavesUpdate?: { hideSuccess: (calledByOther: boolean) => void };
    bypassPreventClosing?: boolean;
    initializeSettingsMenu?: () => void;
    hideWatchMenu?: () => void;
  }
}

function _initSettings(): void {
  function openDB(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        return reject(new Error("indexeddb is not supported in this browser."));
      }
      const request = indexedDB.open(dbName);
      request.onerror = (event: Event) =>
        reject(`error opening db: ${(event.target as IDBOpenDBRequest).error}`);
      request.onsuccess = (event: Event) =>
        resolve((event.target as IDBOpenDBRequest).result);
    });
  }

  async function _exportDB(dbName: string): Promise<DBExport | null> {
    const db = await openDB(dbName);
    const exportData: DBExport = {};
    const storeNames = Array.from(db.objectStoreNames);

    if (storeNames.length === 0) {
      db.close();
      return null;
    }

    const transaction = db.transaction(storeNames, "readonly");
    await Promise.all(
      storeNames.map((storeName) => {
        return new Promise<void>((resolve, reject) => {
          const store = transaction.objectStore(storeName);
          const usesOutOfLineKeys = !store.keyPath && !store.autoIncrement;

          const valuesRequest: IDBRequest<unknown[]> = store.getAll();
          valuesRequest.onerror = (event: Event) => {
            console.error(
              `error reading values from store ${storeName}:`,
              (event.target as IDBRequest).error,
            );
            reject((event.target as IDBRequest).error);
          };
          valuesRequest.onsuccess = (event: Event) => {
            const values = (event.target as IDBRequest<unknown[]>).result;

            if (usesOutOfLineKeys) {
              const keysRequest: IDBRequest<IDBValidKey[]> = store.getAllKeys();
              keysRequest.onerror = (event: Event) => {
                console.error(
                  `error reading keys from store ${storeName}:`,
                  (event.target as IDBRequest).error,
                );
                reject((event.target as IDBRequest).error);
              };
              keysRequest.onsuccess = (keyEvent: Event) => {
                const keys = (keyEvent.target as IDBRequest<IDBValidKey[]>)
                  .result;
                exportData[storeName] = {
                  __isExportFormatV2: true,
                  usesOutOfLineKeys: true,
                  data: keys.map((key, i) => ({
                    key: key,
                    value: values[i],
                  })),
                };
                resolve();
              };
            } else {
              exportData[storeName] = {
                __isExportFormatV2: true,
                usesOutOfLineKeys: false,
                data: values as DBExportRecord[],
              };
              resolve();
            }
          };
        });
      }),
    );

    db.close();
    return exportData;
  }

  window.wavesExportAllData = async function (): Promise<MasterExport> {
    const masterExport: MasterExport = {
      localStorage: Object.keys(localStorage).reduce(
        (acc: Record<string, string>, key: string) => {
          if (key !== "waves-sync-meta") {
            acc[key] = localStorage.getItem(key) as string;
          }
          return acc;
        },
        {},
      ),
      sessionStorage: {
        ...(sessionStorage as unknown as Record<string, string>),
      },
      cookies: document.cookie,
      indexedDB: {},
    };

    if ("indexedDB" in window && typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      if (dbs && dbs.length > 0) {
        await Promise.all(
          dbs.map(async (dbInfo: IDBDatabaseInfo) => {
            const dbName = dbInfo.name;
            if (!dbName) return;
            try {
              const dbData = await _exportDB(dbName);
              if (dbData) {
                masterExport.indexedDB[dbName] = dbData;
              }
            } catch (err) {
              console.error(`failed to export db: ${dbName}`, err);
            }
          }),
        );
      }
    } else {
      try {
        const dbData = await _exportDB("__op");
        if (dbData) {
          masterExport.indexedDB["__op"] = dbData;
        }
      } catch (err) {
        console.error("failed to export default db: __op", err);
      }
    }
    return masterExport;
  };

  async function exportAllData(fileName: string): Promise<void> {
    try {
      const masterExport = await window.wavesExportAllData!();

      const dataStr = JSON.stringify(masterExport, null, 2);
      const dataBlob = new Blob([dataStr], {
        type: "application/json",
      });
      const url = URL.createObjectURL(dataBlob);

      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("error exporting all data:", err);
    }
  }

  window.wavesImportDataFromObject = async function (
    data: unknown,
    progressCallback: (msg: string) => void = () => {},
  ): Promise<void> {
    const importedData = data as MasterExport;
    if (
      !importedData ||
      !importedData.localStorage ||
      !importedData.indexedDB
    ) {
      return;
    }

    try {
      progressCallback("clearing local storage...");
      localStorage.clear();
      const totalKeys = Object.keys(importedData.localStorage).length;
      let currentKey = 0;

      for (const [key, value] of Object.entries(importedData.localStorage)) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          console.warn(`failed to import localStorage key: ${key}`, e);
        }
        currentKey++;
        if (currentKey % 10 === 0)
          progressCallback(
            `importing settings (${Math.round((currentKey / totalKeys) * 100)}%)...`,
          );
      }

      if (importedData.cookies) {
        progressCallback("importing cookies...");
        try {
          const cookies = importedData.cookies.split(";");
          cookies.forEach((cookie) => {
            const eqPos = cookie.indexOf("=");
            if (eqPos > -1) {
              const name = cookie.substring(0, eqPos).trim();
              const value = cookie.substring(eqPos + 1).trim();
              document.cookie = `${name}=${value}; path=/; max-age=31536000`;
            }
          });
        } catch (e) {
          console.warn(`failed to import cookies`, e);
        }
      }

      const dbNames = Object.keys(importedData.indexedDB);
      if (dbNames.length > 0) {
        let dbIndex = 0;
        await Promise.all(
          dbNames.map(async (dbName) => {
            dbIndex++;
            progressCallback(
              `importing database... (${dbIndex}/${dbNames.length})`,
            );

            const dbData = importedData.indexedDB[dbName];
            if (!dbData) return;
            const storeNames = Object.keys(dbData);
            if (storeNames.length === 0) return;

            try {
              const db = await openDB(dbName);
              const dbStoreNames = Array.from(db.objectStoreNames);
              const validStoreNames = storeNames.filter((name) => {
                if (!dbStoreNames.includes(name)) {
                  return false;
                }
                return true;
              });

              if (validStoreNames.length === 0) {
                db.close();
                return;
              }

              const transaction = db.transaction(validStoreNames, "readwrite");

              await Promise.all(
                validStoreNames.map((storeName) => {
                  return new Promise<void>((resolve, reject) => {
                    const store = transaction.objectStore(storeName);
                    store.clear().onsuccess = () => {
                      const storeData = dbData[storeName];
                      let records: unknown[] = [];
                      let usesOutOfLineKeys = false;
                      if (
                        storeData &&
                        typeof storeData === "object" &&
                        storeData.hasOwnProperty("__isExportFormatV2")
                      ) {
                        records = storeData.data;
                        usesOutOfLineKeys = storeData.usesOutOfLineKeys;
                      } else {
                        records = storeData as unknown as unknown[];
                      }

                      if (!Array.isArray(records)) {
                        resolve();
                        return;
                      }

                      Promise.all(
                        records.map((record) => {
                          return new Promise<void>((resolveAdd) => {
                            let addRequest: IDBRequest;
                            if (usesOutOfLineKeys) {
                              const rec = record as DBExportRecord;
                              if (
                                rec &&
                                typeof rec === "object" &&
                                rec.hasOwnProperty("key") &&
                                rec.hasOwnProperty("value")
                              ) {
                                addRequest = store.put(
                                  rec.value,
                                  rec.key as IDBValidKey,
                                );
                              } else {
                                resolveAdd();
                                return;
                              }
                            } else {
                              addRequest = store.put(record);
                            }
                            addRequest.onsuccess = () => resolveAdd();
                            addRequest.onerror = () => resolveAdd();
                          });
                        }),
                      ).then(() => resolve());
                    };
                  });
                }),
              );
              db.close();
            } catch (err) {
              console.error(`failed to import data for db: ${dbName}`, err);
            }
          }),
        );
      }
    } catch (err) {
      console.error("error importing data:", err);
      progressCallback("import error!");
    }
  };

  function importAllData(): void {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";

      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event: ProgressEvent<FileReader>) => {
          let importedData: MasterExport;
          try {
            importedData = JSON.parse(event.target!.result as string);
          } catch (err) {
            console.error("error parsing data file:", err);
            return;
          }

          if (
            !importedData ||
            !importedData.localStorage ||
            !importedData.sessionStorage ||
            !importedData.indexedDB
          ) {
            return;
          }

          try {
            localStorage.clear();
            for (const [key, value] of Object.entries(
              importedData.localStorage,
            )) {
              try {
                localStorage.setItem(key, value);
              } catch (e) {
                console.warn(`failed to import localStorage key: ${key}`, e);
              }
            }

            if (importedData.sessionStorage) {
              sessionStorage.clear();
              for (const [key, value] of Object.entries(
                importedData.sessionStorage,
              )) {
                try {
                  sessionStorage.setItem(key, value);
                } catch (e) {
                  console.warn(`failed to import sessionStorage key: ${key}`, e);
                }
              }
            }

            const dbNames = Object.keys(importedData.indexedDB);
            if (dbNames.length > 0) {
              await Promise.all(
                dbNames.map(async (dbName) => {
                  const dbData = importedData.indexedDB[dbName];
                  if (!dbData) return;
                  const storeNames = Object.keys(dbData);
                  if (storeNames.length === 0) return;

                  try {
                    const db = await openDB(dbName);
                    const dbStoreNames = Array.from(db.objectStoreNames);

                    const validStoreNames = storeNames.filter((name) => {
                      if (!dbStoreNames.includes(name)) {
                        console.warn(
                          `skipping unknown store: ${name} in db: ${dbName}`,
                        );
                        return false;
                      }
                      return true;
                    });

                    if (validStoreNames.length === 0) {
                      db.close();
                      return;
                    }

                    const transaction = db.transaction(
                      validStoreNames,
                      "readwrite",
                    );
                    let importCount = 0;

                    await Promise.all(
                      validStoreNames.map((storeName) => {
                        return new Promise<void>((resolve, reject) => {
                          const store = transaction.objectStore(storeName);
                          const clearRequest = store.clear();

                          clearRequest.onerror = (event: Event) =>
                            reject(
                              `Failed to clear store ${storeName}: ${(event.target as IDBRequest).error}`,
                            );
                          clearRequest.onsuccess = () => {
                            const storeData = dbData[storeName];
                            let records: unknown[] = [];
                            let usesOutOfLineKeys = false;

                            if (
                              storeData &&
                              typeof storeData === "object" &&
                              storeData.hasOwnProperty("__isExportFormatV2")
                            ) {
                              records = storeData.data;
                              usesOutOfLineKeys = storeData.usesOutOfLineKeys;
                            } else {
                              records = storeData as unknown as unknown[];
                              usesOutOfLineKeys = false;
                            }

                            if (!Array.isArray(records)) {
                              reject(
                                `Data for store ${storeName} is not an array.`,
                              );
                              return;
                            }

                            Promise.all(
                              records.map((record) => {
                                return new Promise<void>((resolveAdd) => {
                                  let addRequest: IDBRequest;
                                  if (usesOutOfLineKeys) {
                                    const rec = record as DBExportRecord;
                                    if (
                                      rec &&
                                      typeof rec === "object" &&
                                      rec.hasOwnProperty("key") &&
                                      rec.hasOwnProperty("value")
                                    ) {
                                      addRequest = store.put(
                                        rec.value,
                                        rec.key as IDBValidKey,
                                      );
                                    } else {
                                      console.warn(
                                        `skipping malformed out-of-line record in ${storeName}`,
                                      );
                                      resolveAdd();
                                      return;
                                    }
                                  } else {
                                    addRequest = store.put(record);
                                  }

                                  addRequest.onsuccess = () => {
                                    importCount++;
                                    resolveAdd();
                                  };
                                  addRequest.onerror = (event: Event) => {
                                    const keyInfo = usesOutOfLineKeys
                                      ? (record as DBExportRecord)
                                        ? (record as DBExportRecord).key
                                        : "unknown"
                                      : "N/A";
                                    console.warn(
                                      `failed to add record to ${storeName} (key: ${keyInfo}):`,
                                      (event.target as IDBRequest).error,
                                    );
                                    resolveAdd();
                                  };
                                });
                              }),
                            ).then(() => resolve());
                          };
                        });
                      }),
                    );

                    transaction.oncomplete = () => {
                      console.log(
                        `imported ${importCount} records into ${dbName}.`,
                      );
                    };

                    db.close();
                  } catch (err) {
                    console.error(
                      `failed to import data for db: ${dbName}`,
                      err,
                    );
                  }
                }),
              );
            }
          } catch (err) {
            console.error("error importing data:", err);
          }
        };
        reader.readAsText(file);
      };

      input.click();
    } catch (err) {
      console.error("error importing settings:", err);
    }
  }

  window.addEventListener("beforeunload", function (e: BeforeUnloadEvent) {
    if (window.bypassPreventClosing) return;
    const preventClosingEnabled =
      localStorage.getItem("preventClosing") !== "false";
    if (preventClosingEnabled) {
      e.preventDefault();
      e.returnValue = "";
      return "";
    }
  });

  const originalTitle = (window as any)._title || document.title;
  const originalFavicon = document.querySelector("link[rel*='icon']")
    ? (document.querySelector("link[rel*='icon']") as HTMLLinkElement).href
    : "logo.png";
  let titleObserver: MutationObserver | null = null;

  const siteCloakingPresets: Record<string, SiteCloakingPreset> = {
    none: {
      title: "waves!!",
      icon: "/assets/images/icons/favicon.ico",
    },
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
    "google drive": {
      title: "Google Drive",
      icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png",
    },
    youtube: {
      title: "YouTube",
      icon: "https://www.youtube.com/s/desktop/014dbbed/img/favicon_32x32.png",
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

  let focusCloakingEnabled: boolean =
    localStorage.getItem("focusCloaking") !== "false";
  let expectedTitle: string = originalTitle;
  let isUnloading: boolean = false;

  function applyExpectedTitleAndIcon(
    titleToSet: string,
    iconToSet: string,
  ): void {
    expectedTitle = titleToSet;
    if (document.title !== titleToSet) {
      document.title = titleToSet;
    }

    let favicons = document.querySelectorAll("link[rel*='icon']");
    if (favicons.length === 0) {
      let favicon = document.createElement("link");
      favicon.rel = "shortcut icon";
      favicon.href = iconToSet;
      document.head.appendChild(favicon);
    } else {
      favicons.forEach((el) => {
        if ((el as HTMLLinkElement).href !== iconToSet) {
          (el as HTMLLinkElement).href = iconToSet;
        }
      });
    }
  }

  function updateTitleAndIcon(): void {
    const titleTag = document.querySelector("title");
    let currentSiteCloakingName =
      localStorage.getItem("siteCloaking") || "coursera";
    if (currentSiteCloakingName === "default") {
      currentSiteCloakingName = "coursera";
      localStorage.setItem("siteCloaking", "coursera");
    }

    let titleToSet = originalTitle;
    let iconToSet = originalFavicon;

    let isTabActive = !isUnloading && !document.hidden && document.hasFocus();

    if (focusCloakingEnabled && isTabActive) {
      titleToSet = "waves!!";
      iconToSet = "/assets/images/icons/favicon.ico";
    } else {
      const preset = siteCloakingPresets[currentSiteCloakingName];
      if (
        currentSiteCloakingName === "coursera" ||
        (!preset && currentSiteCloakingName !== "none")
      ) {
        titleToSet = originalTitle;
        iconToSet = originalFavicon;
      } else if (preset) {
        titleToSet = preset.title;
        iconToSet = preset.icon;
      }
    }

    applyExpectedTitleAndIcon(titleToSet, iconToSet);
  }

  const titleTag = document.querySelector("title");
  if (titleTag && !titleObserver) {
    titleObserver = new MutationObserver(function (
      _mutations: MutationRecord[],
    ) {
      if (document.title !== expectedTitle) {
        document.title = expectedTitle;
      }
    });
    titleObserver.observe(titleTag, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function applyInitialSiteCloaking(siteCloakingName: string): void {
    if (siteCloakingName) {
      localStorage.setItem(
        "siteCloaking",
        siteCloakingName === "default" ? "coursera" : siteCloakingName,
      );
    }
    updateTitleAndIcon();
  }

  window.addEventListener("focus", () => {
    setTimeout(updateTitleAndIcon, 10);
  });

  window.addEventListener("blur", () => {
    setTimeout(updateTitleAndIcon, 10);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      updateTitleAndIcon();
    } else {
      setTimeout(updateTitleAndIcon, 10);
    }
  });

  window.addEventListener("beforeunload", () => {
    isUnloading = true;
    updateTitleAndIcon();
  });

  function executeTabCloak(
    linkCloaking: string,
    siteCloakingName: string,
  ): void {
    let inFrame: boolean;
    try {
      inFrame = window !== top;
    } catch (e) {
      inFrame = true;
    }

    if (linkCloaking.toLowerCase() === "none" || inFrame) return;

    const preset = siteCloakingPresets[siteCloakingName];

    let title: string;
    let icon: string;

    if (siteCloakingName !== "coursera" && preset) {
      title = preset.title;
      icon = preset.icon;
    } else {
      title = localStorage.getItem("siteTitle") || originalTitle;
      icon = localStorage.getItem("faviconURL") || originalFavicon;
    }

    let popup: Window | null;

    if (linkCloaking === "about:blank") {
      popup = window.open("", "_blank");
      if (!popup || popup.closed) {
        return;
      }
      const doc = popup.document;
      doc.title = title;

      const linkRel = doc.createElement("link");
      linkRel.rel = "icon";
      linkRel.href = icon;
      doc.head.appendChild(linkRel);

      const iframe = doc.createElement("iframe");
      iframe.style.cssText =
        "height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;";
      iframe.src = window.location.origin;
      doc.body.appendChild(iframe);
    } else if (linkCloaking === "blob:") {
      const iframeSrc = window.location.origin;
      const safeTitle = title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
      const safeIcon = icon.replace(/"/g, "&quot;");

      const html = `<html><head><title>${safeTitle}</title><link rel="icon" href="${safeIcon}"></head><body><iframe style="height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;" src="${iframeSrc}"></iframe></body></html>`;
      const blob = new Blob([html], {
        type: "text/html",
      });
      const blobUrl = URL.createObjectURL(blob);
      popup = window.open(blobUrl, "_blank");
      if (!popup || popup.closed) {
        return;
      }
    }

    window.bypassPreventClosing = true;
    window.location.replace("https://classroom.google.com/");
  }

  function runInitialCloak(linkCloakingValue: string): void {
    let siteCloakingName = localStorage.getItem("siteCloaking") || "coursera";
    if (siteCloakingName === "default") siteCloakingName = "coursera";
    executeTabCloak(linkCloakingValue, siteCloakingName);
  }

  let initialSiteCloaking = localStorage.getItem("siteCloaking") || "coursera";
  if (initialSiteCloaking === "default") {
    initialSiteCloaking = "coursera";
    localStorage.setItem("siteCloaking", "coursera");
  }
  const initialLinkCloaking = localStorage.getItem("linkCloaking") || "none";

  applyInitialSiteCloaking(initialSiteCloaking);

  const savedTheme = localStorage.getItem("theme") || "default";
  if (savedTheme && savedTheme !== "default") {
    document.documentElement.setAttribute("data-theme", savedTheme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  window.addEventListener("load", () => runInitialCloak(initialLinkCloaking));

  document.addEventListener("linkCloakingUpdated", (e: Event) => {
    const detail = (
      e as CustomEvent<{ linkCloaking: string; siteCloaking: string }>
    ).detail;
    executeTabCloak(detail.linkCloaking, detail.siteCloaking);
  });

  document.addEventListener("focusCloakingUpdated", (e: Event) => {
    focusCloakingEnabled = (e as CustomEvent<boolean>).detail;
    updateTitleAndIcon();
  });

  {
    const applyText = (textStr: string): void => {
      const stuffDiv = document.getElementById("stuff");
      if (stuffDiv) {
        stuffDiv.textContent = textStr;
      }
    };

    window.__wavesStuffData!
      .then((data: Record<string, unknown> | null) => {
        const location =
          data && typeof data.location === "string"
            ? data.location
            : "unknown";
        applyText(`server: ${location.toLowerCase()}`);
      })
      .catch(() => applyText(`server: unknown`));
  }

  document.addEventListener("siteCloakingUpdated", (e: Event) =>
    applyInitialSiteCloaking((e as CustomEvent<string>).detail),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initSettings, { once: true });
} else {
  _initSettings();
}