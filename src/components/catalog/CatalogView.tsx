import type { JSX } from "preact";
import type { RefObject } from "preact";
import { IconMagnifyingGlass2 } from "../icons";
import { useVirtualGrid } from "../../hooks/useVirtualGrid.ts";

interface CatalogViewProps<T> {
  id: string;
  className: string;
  topbarClassName: string;
  searchBarClassName: string;
  searchIconClassName: string;
  inputId: string;
  gridContainerClassName: string;
  gridClassName: string;
  visible: boolean;
  active: boolean;
  searchBarRef: RefObject<HTMLDivElement>;
  query: string;
  placeholder: string;
  onQueryChange: (value: string) => void;
  gridVisible: boolean;
  showSkeleton: boolean;
  skeletonKeys: readonly string[];
  items: readonly T[];
  renderSkeleton: (key: string) => JSX.Element;
  renderItem: (item: T) => JSX.Element;
  emptyMessage?: string | null;
  statusMessage?: string | null;
}

export default function CatalogView<T>({
  id,
  className,
  topbarClassName,
  searchBarClassName,
  searchIconClassName,
  inputId,
  gridContainerClassName,
  gridClassName,
  visible,
  active,
  searchBarRef,
  query,
  placeholder,
  onQueryChange,
  gridVisible,
  showSkeleton,
  skeletonKeys,
  items,
  renderSkeleton,
  renderItem,
  emptyMessage,
  statusMessage,
}: CatalogViewProps<T>) {
  const { gridRef, range, visibleItems } = useVirtualGrid(
    items,
    visible && gridVisible && !showSkeleton,
  );

  if (!visible) return null;

  return (
    <section
      id={id}
      class={`${className}${visible ? " is-visible" : ""}${active ? " is-active" : ""}`}
      aria-hidden={!active}
    >
      <div class={topbarClassName}>
        <div
          class={`search-bar catalog-search-bar ${searchBarClassName}`}
          ref={searchBarRef}
        >
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <IconMagnifyingGlass2 class={searchIconClassName} />
          <input
            type="text"
            id={inputId}
            placeholder={placeholder}
            autocomplete="off"
            value={query}
            onInput={(event) => onQueryChange(event.currentTarget.value)}
          />
        </div>
      </div>

      <div class={gridContainerClassName}>
        <div
          ref={gridRef}
          class={gridClassName}
          style={gridVisible ? "display:grid" : "display:none"}
        >
          {showSkeleton
            ? skeletonKeys.map(renderSkeleton)
            : [
                range.topSpacer > 0 ? (
                  <div
                    key="virtual-top"
                    class="catalog-virtual-spacer"
                    style={`height:${range.topSpacer}px`}
                  />
                ) : null,
                ...visibleItems.map(renderItem),
                range.bottomSpacer > 0 ? (
                  <div
                    key="virtual-bottom"
                    class="catalog-virtual-spacer"
                    style={`height:${range.bottomSpacer}px`}
                  />
                ) : null,
              ]}
        </div>
        {emptyMessage && <p class="no-results">{emptyMessage}</p>}
        {statusMessage && <p class="no-results">{statusMessage}</p>}
      </div>
    </section>
  );
}
