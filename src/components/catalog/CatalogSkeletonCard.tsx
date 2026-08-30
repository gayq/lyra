import { memo } from "preact/compat";

export const CATALOG_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, i) => `catalog-skeleton-${i}`,
);

const SKELETON_LINES = ["title", "meta"] as const;

interface CatalogSkeletonCardProps {
  cardClassName: string;
  coverClassName: string;
  infoClassName: string;
}

const CatalogSkeletonCard = memo(function CatalogSkeletonCard({
  cardClassName,
  coverClassName,
  infoClassName,
}: CatalogSkeletonCardProps) {
  return (
    <article class={`${cardClassName} skeleton-card`}>
      <div class={`${coverClassName} skeleton`} />
      <div class={infoClassName}>
        {SKELETON_LINES.map((key) => (
          <div key={key} />
        ))}
      </div>
    </article>
  );
});

export default CatalogSkeletonCard;
