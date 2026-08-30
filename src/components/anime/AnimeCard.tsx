import { memo } from "preact/compat";
import type { AnimeEntry } from "../../features/anime/anime.ts";
import CatalogImage from "../catalog/CatalogImage.tsx";

interface AnimeCardProps {
  anime: AnimeEntry;
  onPlay: (anime: AnimeEntry) => void;
}

const AnimeCard = memo(function AnimeCard({ anime, onPlay }: AnimeCardProps) {
  const ratingColor =
    anime.rating && anime.rating >= 8
      ? "var(--color-green)"
      : anime.rating && anime.rating >= 6
        ? "var(--color-yellow)"
        : "var(--color-red)";

  return (
    <article
      class="anime-card"
      onClick={() => onPlay(anime)}
    >
      <CatalogImage
        className="poster-cover"
        src={anime.posterUrl}
        lowBandwidthSrc={anime.posterSmallUrl}
        alt={anime.title}
        fallbackSize={36}
      />
      <div class="anime-info">
        <h1>{anime.title}</h1>
        <div class="anime-meta">
          {anime.year && <span class="anime-year">{anime.year}</span>}
          {anime.rating && (
            <span class="anime-rating" style={{ color: ratingColor }}>
              ★ {anime.rating}
            </span>
          )}
          {anime.adult && <span class="anime-adult-badge">18+</span>}
        </div>
      </div>
    </article>
  );
});

export default AnimeCard;
