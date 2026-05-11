import { memo, createPortal } from "preact/compat";
import { useEffect, useRef, useState, useCallback } from "preact/hooks";
import { DEFAULT_BOOKMARKS, type Bookmark } from "../core/config.ts";
import { canonicalize } from "../core/utils.ts";

function getBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem("waves-bookmarks");
    if (!raw) {
      const defaults = DEFAULT_BOOKMARKS.slice();
      localStorage.setItem("waves-bookmarks", JSON.stringify(defaults));
      return defaults;
    }
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveBookmarks(bookmarks: Bookmark[]) {
  localStorage.setItem("waves-bookmarks", JSON.stringify(bookmarks));
}

const BookmarkIcon = memo(function BookmarkIcon({ bookmark }: { bookmark: Bookmark }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const isFaIcon =
    bookmark.icon &&
    (bookmark.icon.startsWith("fa-") ||
      bookmark.icon.includes(" fa-") ||
      /^fa[srbltd]? /.test(bookmark.icon));

  if (isFaIcon) {
    return (
      <div
        class="bookmark-icon"
        style="display:flex;align-items:center;justify-content:center;color:#fff"
        data-bookmark-url={bookmark.url}
      >
        <i class={bookmark.icon} style="font-size:16px"></i>
      </div>
    );
  }

  let src = bookmark.icon;
  if (!src) {
    try {
      src =
        "/!cover!/" +
        `https://www.google.com/s2/favicons?domain=${new URL(bookmark.url).hostname}&sz=64`;
    } catch {
      src = "";
    }
  }

  if (errored) {
    return (
      <div
        class="bookmark-icon"
        style="display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:#fff"
      >
        {bookmark.name.charAt(0).toUpperCase()}
      </div>
    );
  }

  return (
    <div
      class={`bookmark-icon${!loaded ? " skeleton" : ""}`}
      data-bookmark-url={bookmark.url}
    >
      <img
        class="bookmark-icon-img"
        loading="lazy"
        decoding="async"
        src={src}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(true);
          setErrored(true);
        }}
      />
    </div>
  );
});

export default function Bookmarks() {
  const [bookmarks, setBookmarks] = useState(() => getBookmarks());
  const [isEditMode, setIsEditMode] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{ draggedIndex: number | null }>({ draggedIndex: null });

  const reload = useCallback(() => setBookmarks(getBookmarks()), []);

  useEffect(() => {
    const handler = () => reload();
    document.addEventListener("cloudsync-restored", handler);
    const storageHandler = (e: StorageEvent) => {
      if (e.key === "waves-bookmarks") reload();
    };
    window.addEventListener("storage", storageHandler);
    return () => {
      document.removeEventListener("cloudsync-restored", handler);
      window.removeEventListener("storage", storageHandler);
    };
  }, [reload]);

  const deleteBookmark = (index: number) => {
    const bm = [...bookmarks];
    bm.splice(index, 1);
    saveBookmarks(bm);
    setBookmarks(bm);
  };

  const openPrompt = (index: number | null = null) => {
    setEditIndex(index);
    setShowPrompt(true);
    if (index !== null) {
      requestAnimationFrame(() => {
        const bm = bookmarks[index];
        if (bm) {
          if (nameRef.current) nameRef.current.value = bm.name || "";
          if (urlRef.current) urlRef.current.value = bm.url || "";
        }
      });
    }
  };

  const closePrompt = () => {
    setShowPrompt(false);
    setEditIndex(null);
  };

  const handleSave = (closeWithAnimation?: () => void) => {
    const name = nameRef.current?.value?.trim() ?? "";
    let rawUrl = urlRef.current?.value?.trim() ?? "";
    if (!name || !rawUrl) {
      window.showToast?.("error", "Name and URL cannot be empty!", "warning");
      return;
    }
    if (!/^https?:\/\//i.test(rawUrl)) rawUrl = "https://" + rawUrl;
    try {
      new URL(rawUrl);
    } catch {
      window.showToast?.("error", "Please enter a valid URL!", "warning");
      return;
    }
    const canonUrl = canonicalize(rawUrl);
    const bm = [...bookmarks];
    const others =
      editIndex !== null ? bm.filter((_, i) => i !== editIndex) : bm;
    if (others.some((s) => canonicalize(s.url) === canonUrl)) {
      window.showToast?.(
        "error",
        "That bookmark URL already exists!",
        "warning",
      );
      return;
    }
    if (editIndex === null && bm.length >= 5) {
      window.showToast?.("error", "You can only have 5 bookmarks!", "warning");
      return;
    }

    const newBm: Bookmark = { name, url: canonUrl };
    if (editIndex !== null && bookmarks[editIndex]?.icon)
      newBm.icon = bookmarks[editIndex]!.icon;
    if (editIndex !== null) bm[editIndex] = newBm;
    else bm.push(newBm);
    saveBookmarks(bm);
    setBookmarks(bm);
    closeWithAnimation?.();
  };

  const handleDragStart = (e: DragEvent, index: number) => {
    if (!isEditMode) {
      e.preventDefault();
      return;
    }
    dragRef.current.draggedIndex = index;
    (e.currentTarget as HTMLElement).classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
  };

  const handleDrop = (e: DragEvent, dropIndex: number) => {
    e.preventDefault();
    const draggedIndex = dragRef.current.draggedIndex;
    if (draggedIndex === null || draggedIndex === dropIndex) return;
    const bm = [...bookmarks];
    const dragged = bm.splice(draggedIndex, 1)[0]!;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let insertAt =
      e.clientX >= rect.left + rect.width / 2 ? dropIndex + 1 : dropIndex;
    if (insertAt > draggedIndex) insertAt--;
    bm.splice(insertAt, 0, dragged);
    saveBookmarks(bm);
    setBookmarks(bm);
    dragRef.current.draggedIndex = null;
  };

  useEffect(() => {
    window.hideBookmarkPrompt = () => closePrompt();
  }, []);

  return (
    <div
      id="bookmarks-container"
      class={isEditMode ? "bookmarks-edit-mode" : ""}
    >
      <div class="bookmarks-header">
        <h3 id="bookmarks-title">bookmarks</h3>
        <button
          id="bookmarks-edit-toggle"
          onClick={() => setIsEditMode(!isEditMode)}
        >
          {isEditMode ? "done" : "edit"}
        </button>
      </div>
      <div class="bookmarks-wrapper">
        <ul id="bookmarks-list">
          {bookmarks.map((bookmark, index) => (
            <li
              key={bookmark.url + index}
              class="bookmark-item"
              data-index={index}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={(e) => e.currentTarget.classList.remove("dragging")}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
            >
              <a
                href="#"
                class="bookmark-link"
                  onClick={(e) => {
                  e.preventDefault();
                  (window.WavesApp as any)?.handleSearch(bookmark.url);
                }}
              >
                <BookmarkIcon bookmark={bookmark} />
                <span class="bookmark-name">{bookmark.name}</span>
              </a>
              <button
                class="bookmark-delete-trigger"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteBookmark(index);
                }}
              >
                <i class="fa-regular fa-times"></i>
              </button>
              <button
                class="bookmark-edit-trigger"
                onClick={(e) => {
                  e.stopPropagation();
                  openPrompt(index);
                }}
              >
                <i class="fa-regular fa-pencil"></i>
              </button>
            </li>
          ))}
          <li
            class="bookmark-item-add"
            style={{
              display:
                isEditMode && bookmarks.length < 5 ? "list-item" : "none",
            }}
          >
            <button id="add-bookmark-btn" onClick={() => openPrompt()}>
              <i class="fa-regular fa-plus"></i>
            </button>
          </li>
        </ul>
      </div>
      {showPrompt && createPortal(
        <BookmarkPrompt
          nameRef={nameRef}
          urlRef={urlRef}
          onSave={handleSave}
          onCancel={closePrompt}
        />,
        document.body
      )}
    </div>
  );
}

function BookmarkPrompt({ nameRef, urlRef, onSave, onCancel }: {
  nameRef: { current: HTMLInputElement | null };
  urlRef: { current: HTMLInputElement | null };
  onSave: (closeWithAnimation: () => void) => void;
  onCancel: () => void;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const isClosingRef = useRef(false);
  const promptRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    const overlay = document.getElementById("overlay");
    if (overlay) overlay.classList.remove("show");
  }, []);

  useEffect(() => {
    const overlay = document.getElementById("overlay");
    if (overlay) overlay.classList.add("show");
    return () => {
      if (!isClosingRef.current) {
        const o = document.getElementById("overlay");
        if (o) o.classList.remove("show");
      }
    };
  }, []);

  useEffect(() => {
    if (!isClosing) return;
    const el = promptRef.current;
    if (!el) {
      onCancel();
      return;
    }
    const handler = (e: AnimationEvent) => {
      if (e.animationName === "fadeOut") onCancel();
    };
    el.addEventListener("animationend", handler, { once: true });
    return () => el.removeEventListener("animationend", handler);
  }, [isClosing, onCancel]);

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [handleClose]);

  useEffect(() => {
    const fn = (e: MouseEvent) => {
      const overlay = document.getElementById("overlay");
      if (overlay && e.target === overlay) handleClose();
    };
    document.addEventListener("click", fn);
    return () => document.removeEventListener("click", fn);
  }, [handleClose]);

  return (
    <div
      ref={promptRef}
      id="bookmark-prompt"
      class={`popup ${isClosing ? "fade-out-prompt" : "fade-in-prompt"}`}
      style="display:flex;"
    >
      <div class="input-container">
        <label>bookmark name</label>
        <input
          type="text"
          id="bookmarkName"
          ref={nameRef}
          placeholder="my cool site"
          autocomplete="off"
        />
        <label style="margin-top:15px;">bookmark url</label>
        <input
          type="text"
          id="bookmarkUrl"
          ref={urlRef}
          placeholder="https://example.com/"
          autocomplete="off"
        />
        <div style="display:flex;justify-content:center;gap:10px;margin-top:20px;">
          <button id="saveBookmarkBtn" onClick={() => onSave(handleClose)}>
            save
          </button>
          <button id="cancelBookmarkBtn" onClick={handleClose}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}