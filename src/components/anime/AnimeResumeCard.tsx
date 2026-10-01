import {
  animeProgressLabel,
  type AnimeProgress,
} from "../../features/anime/animeProgress.ts";
import { useImageLoad } from "../../hooks/useImageLoad.ts";
import { IconPlay } from "../icons";
import IconBase from "../icons/IconBase.tsx";
import { ICON_PATHS } from "../icons/paths.ts";

export default function AnimeResumeCard({
  progress,
  onResume,
}: {
  progress: AnimeProgress;
  onResume: () => void;
}) {
  const image = useImageLoad(progress.posterUrl);
  return (
    <button type="button" class="anime-card anime-resume-card" onClick={onResume}>
      <span
        class={`poster-cover${image.loaded ? " loaded" : ""}${image.errored ? " no-cover" : ""}`}
      >
        {image.errored ? (
          <span class="no-cover-icon">
            <IconBase icon={ICON_PATHS.IconImageAltText} />
          </span>
        ) : (
          <img
            ref={image.imgRef}
            src={image.src}
            alt=""
            onLoad={image.onLoad}
            onError={image.onError}
          />
        )}
      </span>
      <span class="anime-info">
        <span class="anime-resume-caption">continue watching...</span>
        <span class="anime-resume-title">{progress.title}</span>
        <span class="anime-resume-caption">
          {animeProgressLabel(progress, "resume")} · {progress.language}
        </span>
      </span>
      <IconPlay class="anime-resume-play" />
    </button>
  );
}
