import { useState, useMemo, useCallback } from "preact/hooks";
import { store, useStore } from "../state/store.js";
import { sidebarHiddenSignal, setSidebarHidden } from "../core/uiSignals";

const DEFAULT_FAVICON =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23818181" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1h-2v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

function TabIcon({ favicon }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src = favicon || DEFAULT_FAVICON;

  return (
    <div class={`tab-icon${!loaded && !errored ? " skeleton" : ""}`}>
      <img
        loading="eager"
        decoding="async"
        src={errored ? DEFAULT_FAVICON : src}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(true);
          setErrored(true);
        }}
      />
    </div>
  );
}

function Tab({ tab, isActive, isSplitPair, splitSide, showClose }) {
  const classes = ["tab"];
  if (isActive) classes.push("active");
  if (isSplitPair) {
    classes.push("split-pair");
    if (splitSide === "left")
      classes.push("split-pair-left", "split-active-left");
    if (splitSide === "right")
      classes.push("split-pair-right", "split-active-right");
  }

  const onTabClick = useCallback(
    (e) => {
      if (e.target.closest(".tab-close")) return;
      store.switchTab(tab.id);
    },
    [tab.id],
  );

  const onCloseClick = useCallback(
    (e) => {
      e.stopPropagation();
      store.closeTab(tab.id);
    },
    [tab.id],
  );

  return (
    <div
      class={classes.join(" ")}
      data-tab-id={tab.id}
      onClick={onTabClick}
    >
      <TabIcon favicon={tab.favicon} key={tab.favicon} />
      <span class="tab-title">{tab.title}</span>
      <button
        class="tab-close"
        style={{ display: showClose ? "" : "none" }}
        onClick={onCloseClick}
      >
        <i class="fa-regular fa-times"></i>
      </button>
    </div>
  );
}

export default function Sidebar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair);
  const isSplitPairDefined =
    splitPair.left !== null && splitPair.right !== null;
  const isSplitLayout = isSplitPairDefined &&
    (activeTabId === splitPair.left || activeTabId === splitPair.right);
  const showClose = tabs.length > 1;

  const tabViewModels = useMemo(() => {
    return tabs.map((tab) => {
      let isActive = false;
      let isSplitPairTab = false;
      let splitSide = null;

      if (
        isSplitPairDefined &&
        (tab.id === splitPair.left || tab.id === splitPair.right)
      ) {
        isSplitPairTab = true;
        splitSide = tab.id === splitPair.left ? "left" : "right";
      }

      if (isSplitLayout) {
        isActive = tab.id === splitPair.left || tab.id === splitPair.right;
      } else {
        isActive = tab.id === activeTabId;
      }

      return {
        tab,
        isActive,
        isSplitPair: isSplitPairTab,
        splitSide,
      };
    });
  }, [
    tabs,
    isSplitLayout,
    isSplitPairDefined,
    splitPair.left,
    splitPair.right,
    activeTabId,
  ]);

  const openNewTabModal = useCallback(() => {
    document.getElementById("new-tab-modal")?.classList.add("is-visible");
  }, []);

  const handleToggleSidebar = (e) => {
    e.preventDefault();
    setSidebarHidden(!sidebarHiddenSignal.value);
  };

  return (
    <nav class="sidebar">
      <div class="tabs-header">
        <span>tabs</span>
      </div>
      <button
        id="add-tab-btn"
        onClick={openNewTabModal}
        aria-pressed={sidebarHiddenSignal.value}
      >
        <i class="fa-regular fa-plus"></i> new tab
      </button>
      <div id="tabs-container" class="tabs-container">
        {tabViewModels.map(({ tab, isActive, isSplitPair, splitSide }) => {
          return (
            <Tab
              key={tab.id}
              tab={tab}
              isActive={isActive}
              isSplitPair={isSplitPair}
              splitSide={splitSide}
              showClose={showClose}
            />
          );
        })}
      </div>
    </nav>
  );
}