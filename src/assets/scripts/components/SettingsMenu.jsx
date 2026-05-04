import { useState, useEffect, useRef, useCallback } from "preact/hooks";

function Selector({ label, value, options, onChange, isOpen, onOpen, onClose }) {
  const open = isOpen === label;
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [open, onClose]);

  return (
    <div class={`${label}-selector`} ref={ref}>
      <div
        class={`${label}-selected${open ? ` ${label}-arrow-active` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          if (open) {
            onClose();
          } else {
            onOpen(label);
          }
        }}
      >
        {value}
      </div>
      {open && (
        <div class={`${label}-options ${label}-show`}>
          {options
            .filter((o) => o !== value)
            .map((opt) => (
              <div
                key={opt}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(opt);
                  onClose();
                }}
              >
                {opt}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function Toggle({ id, checked, onChange }) {
  const onToggle = (e) => {
    const el = e.currentTarget;
    const isChecked = el.checked;
    el.classList.remove("animate-on", "animate-off");
    requestAnimationFrame(() => {
      el.classList.add(isChecked ? "animate-on" : "animate-off");
    });
    onChange(isChecked);
  };

  return (
    <input type="checkbox" id={id} checked={checked} onChange={onToggle} />
  );
}

export default function SettingsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [activeTab, setActiveTab] = useState("preferences");
  const [openSelector, setOpenSelector] = useState(null);
  const menuRef = useRef(null);

  const [backend, setBackend] = useState(
    () => localStorage.getItem("backend") || "scramjet",
  );
  const [transport, setTransport] = useState(
    () => localStorage.getItem("transport") || "epoxy",
  );
  const [searchEngine, setSearchEngine] = useState(
    () => localStorage.getItem("searchEngine") || "duckduckgo",
  );
  const [gameSource, setGameSource] = useState(
    () => localStorage.getItem("gameSource") || "selenite",
  );
  const [theme, setTheme] = useState(
    () => localStorage.getItem("theme") || "default",
  );
  const [siteCloaking, setSiteCloaking] = useState(() => {
    const v = localStorage.getItem("siteCloaking") || "coursera";
    return v === "default" ? "coursera" : v;
  });
  const [linkCloaking, setLinkCloaking] = useState(
    () => localStorage.getItem("linkCloaking") || "none",
  );
  const [preventClosing, setPreventClosing] = useState(
    () => localStorage.getItem("preventClosing") !== "false",
  );
  const [focusCloaking, setFocusCloaking] = useState(
    () => localStorage.getItem("focusCloaking") !== "false",
  );

  const toggleMenu = useCallback(() => {
    if (isClosing) return;

    if (isOpen) {
      setIsClosing(true);
      const icon = document.querySelector("#settings i.settings");
      if (icon) icon.classList.remove("active-icon");
      const overlay = document.getElementById("overlay");
      if (overlay) overlay.classList.remove("show");
    } else {
      setIsOpen(true);
      const icon = document.querySelector("#settings i.settings");
      if (icon) icon.classList.add("active-icon");
      const overlay = document.getElementById("overlay");
      if (overlay) overlay.classList.add("show");
    }
  }, [isOpen, isClosing]);

  const onAnimEnd = useCallback(
    (e) => {
      if (isClosing && e.animationName === "fadeOut") {
        setIsOpen(false);
        setIsClosing(false);
      }
    },
    [isClosing],
  );

  useEffect(() => {
    window.toggleSettingsMenu = toggleMenu;
    window.initializeSettingsMenu = () => {};
    return () => {
      delete window.toggleSettingsMenu;
      delete window.initializeSettingsMenu;
    };
  }, [toggleMenu]);

  useEffect(() => {
    const handler = (e) => {
      if (e.target.closest("#settings")) {
        e.preventDefault();
        toggleMenu();
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [toggleMenu]);

  useEffect(() => {
    const overlay = document.getElementById("overlay");
    if (!overlay) return;
    const handler = (e) => {
      if (e.target === overlay && isOpen && !isClosing) toggleMenu();
    };
    overlay.addEventListener("click", handler);
    return () => overlay.removeEventListener("click", handler);
  }, [isOpen, isClosing, toggleMenu]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && isOpen && !isClosing) toggleMenu();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, isClosing, toggleMenu]);

  const save = (key, value) => {
    localStorage.setItem(key, value);
    window.showToast?.("success", "settings saved");
  };

  const handleSetting = (key, value, setter) => {
    setter(value);
    save(key, value);

    if (key === "theme") {
      const applyTheme = () => {
        if (value === "default")
          document.documentElement.removeAttribute("data-theme");
        else document.documentElement.setAttribute("data-theme", value);
      };

      if (!document.startViewTransition) {
        applyTheme();
      } else {
        document.documentElement.classList.add("theme-transitioning");
        const transition = document.startViewTransition(() => {
          applyTheme();
        });
        transition.finished.then(() => {
          document.documentElement.classList.remove("theme-transitioning");
        });
      }
    } else if (key === "gameSource") {
      document.dispatchEvent(
        new CustomEvent("gameSourceUpdated", { detail: value }),
      );
    } else if (key === "backend") {
      document.dispatchEvent(
        new CustomEvent("backendUpdated", { detail: value }),
      );
      window.bypassPreventClosing = true;
      window.location.reload();
    } else if (key === "transport") {
      document.dispatchEvent(
        new CustomEvent("newTransport", { detail: value }),
      );
    } else if (key === "siteCloaking") {
      document.dispatchEvent(
        new CustomEvent("siteCloakingUpdated", { detail: value }),
      );
    } else if (key === "linkCloaking") {
      window.bypassPreventClosing = true;
      const siteCloakName = localStorage.getItem("siteCloaking") || "coursera";
      document.dispatchEvent(
        new CustomEvent("linkCloakingUpdated", {
          detail: { linkCloaking: value, siteCloaking: siteCloakName },
        }),
      );
    }
  };

  const handleToggle = (key, value, setter) => {
    setter(value);
    save(key, String(value));

    if (key === "focusCloaking") {
      document.dispatchEvent(
        new CustomEvent("focusCloakingUpdated", { detail: value }),
      );
    }
  };

  const handleExport = async () => {
    if (typeof window.wavesExportAllData === "function") {
      try {
        const data = await window.wavesExportAllData();
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
        const blob = new Blob([JSON.stringify(data, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `waves-data-${ts}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("export error:", err);
      }
    }
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (typeof window.wavesImportDataFromObject === "function") {
            await window.wavesImportDataFromObject(data);
            window.showToast?.("success", "data imported");
          }
        } catch (err) {
          console.error("import error:", err);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const tabs = [
    { id: "preferences", icon: "fa-sliders", label: "preferences" },
    { id: "appearance", icon: "fa-palette", label: "appearance" },
    { id: "cloaking", icon: "fa-ghost", label: "cloaking" },
    { id: "advanced", icon: "fa-server", label: "advanced" },
    { id: "about", icon: "fa-heart", label: "credits" },
  ];

  const allBackends = ["ultraviolet", "scramjet"];
  const allTransports = ["epoxy", "libcurl"];
  const allSearchEngines = [
    "google",
    "bing",
    "duckduckgo",
    "startpage",
    "brave",
    "mojeek",
    "swisscows",
  ];
  const allSiteCloaking = [
    "coursera",
    "none",
    "google",
    "google classroom",
    "google docs",
    "youtube",
    "google drive",
    "schoology",
    "wikipedia",
    "canva",
  ];
  const allLinkCloaking = ["none", "about:blank", "blob:"];
  const allGameSources = ["selenite", "gn-math", "edurocks", "velara"];
  const allThemes = [
    "default",
    "catppuccin",
    "nord",
    "rose pine",
    "gruvbox",
    "dracula",
    "synthwave",
    "tokyo night",
    "everforest",
    "kanagawa",
    "solarized",
    "sakura",
  ];

  if (!isOpen) return <div id="settings-menu" class="settings-menu" />;

  const menuClass = `settings-menu${isOpen ? " open" : ""}${isClosing ? " close" : ""}`;

  return (
    <div
      id="settings-menu"
      class={menuClass}
      ref={menuRef}
      onAnimationEnd={onAnimEnd}
    >
      <h2>settings</h2>
      <div class="settings-container">
        <div class="settings-tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              class={`tab-button${activeTab === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              <i
                class={`${activeTab === t.id ? "fa-solid" : "fa-regular"} ${t.icon}`}
              />{" "}
              {t.label}
            </button>
          ))}
          <div class="settings-bottom">≽^•⩊•^≼</div>
        </div>
        <div class="settings-content-wrapper">
          <div
            class={`tab-content${activeTab === "preferences" ? " active" : ""}`}
          >
            <div class="settings-item">
              <label>search engine</label>
              <p>the engine that is used for your search queries.</p>
              <Selector
                label="search-engine"
                value={searchEngine}
                options={allSearchEngines}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) =>
                  handleSetting("searchEngine", v, setSearchEngine)
                }
              />
            </div>
            <div class="settings-item">
              <label>game source</label>
              <p>where all the games are fetched from.</p>
              <Selector
                label="game-source"
                value={gameSource}
                options={allGameSources}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) => handleSetting("gameSource", v, setGameSource)}
              />
            </div>
            <div class="settings-item">
              <label>prevent closing</label>
              <p>prevent the tab from being closed.</p>
              <Toggle
                id="prevent-closing-toggle"
                checked={preventClosing}
                onChange={(v) =>
                  handleToggle("preventClosing", v, setPreventClosing)
                }
              />
            </div>
          </div>

          <div
            class={`tab-content${activeTab === "appearance" ? " active" : ""}`}
          >
            <div class="settings-item">
              <label>theme</label>
              <p>change the look and feel of waves.</p>
              <Selector
                label="theme"
                value={theme}
                options={allThemes}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) => handleSetting("theme", v, setTheme)}
              />
            </div>
          </div>

          <div
            class={`tab-content${activeTab === "cloaking" ? " active" : ""}`}
          >
            <div class="settings-item">
              <label>site cloaking</label>
              <p>cloak the site title and favicon as a different site.</p>
              <Selector
                label="site-cloaking"
                value={siteCloaking}
                options={allSiteCloaking}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) =>
                  handleSetting("siteCloaking", v, setSiteCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>link cloaking</label>
              <p>cloak the site link in the url bar.</p>
              <Selector
                label="link-cloaking"
                value={linkCloaking}
                options={allLinkCloaking}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) =>
                  handleSetting("linkCloaking", v, setLinkCloaking)
                }
              />
            </div>
            <div class="settings-item">
              <label>focus cloaking</label>
              <p>cloak the title and favicon when clicking off the tab.</p>
              <Toggle
                id="focus-cloaking-toggle"
                checked={focusCloaking}
                onChange={(v) =>
                  handleToggle("focusCloaking", v, setFocusCloaking)
                }
              />
            </div>
          </div>

          <div
            class={`tab-content${activeTab === "advanced" ? " active" : ""}`}
          >
            <div class="settings-item">
              <label>backend</label>
              <p>the engine responsible for loading all your sites.</p>
              <Selector
                label="backend"
                value={backend}
                options={allBackends}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) => handleSetting("backend", v, setBackend)}
              />
            </div>
            <div class="settings-item">
              <label>transport</label>
              <p>how all the information will be sent.</p>
              <Selector
                label="transport"
                value={transport}
                options={allTransports}
                isOpen={openSelector}
                onOpen={setOpenSelector}
                onClose={() => setOpenSelector(null)}
                onChange={(v) => handleSetting("transport", v, setTransport)}
              />
            </div>
          </div>

          <div class={`tab-content${activeTab === "about" ? " active" : ""}`}>
            <div class="settings-item">
              <label>credits</label>
              <p>selenite - game source</p>
              <p>gn-math - game source</p>
              <p>edurocks - game source</p>
              <p>velara - game source</p>
              <p>bog - ports for hollow knight, re:run, and touhou mother</p>
              <p>titanium network - ultraviolet</p>
              <p>mercury workshop - scramjet, epoxy, and libcurl</p>
            </div>
            <div class="settings-item">
              <label>you have reached the end!</label>
              <p>
                thank you so much for using{" "}
                <a href="https://waves.lat/" target="_blank" class="hover-link">
                  waves!!
                </a>{" "}
                if you have any suggestions or issues, please contact us on our{" "}
                <a
                  href="https://discord.gg/dJvdkPRheV"
                  target="_blank"
                  class="hover-link"
                >
                  discord server
                </a>{" "}
                or open an issue on our{" "}
                <a
                  href="https://github.com/l4uy/Waves"
                  target="_blank"
                  class="hover-link"
                >
                  github repository
                </a>{" "}
                &lt;3
              </p>
            </div>
          </div>
        </div>
      </div>
      <button id="close-settings-menu" onClick={toggleMenu}>
        <i class="fa-regular fa-times" />
      </button>
    </div>
  );
}