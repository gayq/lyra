import { useEffect, useRef } from "preact/hooks";
import { attachSearchLight } from "../core/searchLight.js";
import { useSearchInputBindings } from "../search/search.ts";

const placeholders = [
  "have anything in mind?",
  "( • ̀ω•́ )✧",
  "join the discord server!",
  "1 update per year",
  "waves is such a good site!!",
];

const pickPlaceholder = () =>
  placeholders[Math.floor(Math.random() * placeholders.length)];

export default function SearchBar() {
  const barRef = useRef(null);
  const placeholderRef = useRef(pickPlaceholder());

  useSearchInputBindings({
    inputId: "searchInput",
    suggestionsId: "suggestions-container",
  });

  useEffect(() => {
    if (barRef.current) {
      attachSearchLight(barRef.current);
    }
  }, []);

  return (
    <div class="search-bar" ref={barRef}>
      <div class="light-border"></div>
      <div class="light-inset-bg"></div>
      <div class="light"></div>
      <i class="fa-light fa-magnifying-glass search-icon"></i>
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