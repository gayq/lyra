import { useEffect, useRef } from "preact/hooks";
import { attachSearchLight } from "../../core/ui/searchLight.ts";
import { useSearchInputBindings } from "../../features/search/search.ts";
import { IconMagnifyingGlass2 } from "../icons";

const placeholders = [
  "have anything in mind?",
  "( • ̀ω•́ )✧",
  "join the discord server!",
  "1 update per year",
  "hi lol",
  "yo search something here",
];
const PLACEHOLDER_INDEX_STORAGE_KEY = "lyra-search-placeholder-index";

function pickPlaceholder(): string {
  let previousIndex = -1;
  try {
    const storedIndex = localStorage.getItem(PLACEHOLDER_INDEX_STORAGE_KEY);
    if (storedIndex !== null) previousIndex = Number(storedIndex);
  } catch {
    
  }

  let nextIndex = Math.floor(Math.random() * placeholders.length);
  if (placeholders.length > 1 && nextIndex === previousIndex) {
    nextIndex =
      (nextIndex +
        1 +
        Math.floor(Math.random() * (placeholders.length - 1))) %
      placeholders.length;
  }

  try {
    localStorage.setItem(PLACEHOLDER_INDEX_STORAGE_KEY, String(nextIndex));
  } catch {
    
  }
  return placeholders[nextIndex]!;
}

export default function SearchBar() {
  const barRef = useRef(null);
  const placeholderRef = useRef(pickPlaceholder());

  useSearchInputBindings({
    inputId: "searchInput",
    suggestionsId: "suggestions-container",
  });

  useEffect(() => {
    if (barRef.current) {
      return attachSearchLight(barRef.current);
    }
    return undefined;
  }, []);

  return (
    <div class="search-bar" ref={barRef}>
      <div class="light-border"></div>
      <div class="light-inset-bg"></div>
      <div class="light"></div>
      <IconMagnifyingGlass2 class="search-icon" />
      <input
        type="text"
        id="searchInput"
        placeholder={placeholderRef.current}
        autocomplete="off"
      />
      <div id="suggestions-container" class="suggestions-box"></div>
    </div>
  );
}
