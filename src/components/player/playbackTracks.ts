import Hls from "hls.js";
import type {
  AudioTrack,
  NativeAudioTrackList,
  SubtitleTrack,
} from "./tracks.ts";

interface PlaybackTracksOptions {
  video: HTMLVideoElement;
  hls?: Hls;
  isCurrent: () => boolean;
  selectAudio: (tracks: AudioTrack[]) => number;
  onSubtitles: (tracks: SubtitleTrack[]) => void;
  onAudio: (tracks: AudioTrack[]) => void;
  onAudioLoading?: () => void;
  onActiveAudio: (index: number) => void;
}

function nativeSubtitle(track: TextTrack, index: number): SubtitleTrack {
  return {
    id: `native:${track.id || index}:${track.language}:${track.label}`,
    label: track.label,
    language: track.language,
    kind: track.kind,
    nativeTrack: track,
  };
}

/** Owns discovery/listener lifetimes; preferences and user choices stay in Player. */
export function attachPlaybackTracks({
  video,
  hls,
  isCurrent,
  selectAudio,
  onSubtitles,
  onAudio,
  onAudioLoading,
  onActiveAudio,
}: PlaybackTracksOptions): () => void {
  let disposed = false;
  const current = () => !disposed && isCurrent();
  const sidecars = () =>
    new Set(
      Array.from(video.querySelectorAll("track"), (element) => element.track),
    );

  if (hls) {
    const nativeCaptions = new Set<TextTrack>();
    const matchesRendition = (
      track: TextTrack,
      rendition: { name: string; lang?: string },
    ) =>
      rendition.name.toLowerCase() === track.label.toLowerCase() &&
      (!track.language ||
        track.language.toLowerCase() === (rendition.lang || "").toLowerCase());
    const updateSubtitles = () => {
      if (!current()) return;
      const renditions: SubtitleTrack[] = hls.subtitleTracks.map(
        (track, index) => ({
          id: `hls:${track.groupId}:${track.url}:${track.name}:${track.lang}`,
          label: track.name || "",
          language: track.lang || "und",
          hlsIndex: index,
          default: track.default,
          forced: track.forced,
          characteristics: track.characteristics || "",
        }),
      );
      const captions = Array.from(nativeCaptions)
        .filter(
          (track) =>
            !hls.subtitleTracks.some((rendition) =>
              matchesRendition(track, rendition),
            ),
        )
        .map(nativeSubtitle);
      onSubtitles([...renditions, ...captions]);
    };
    const onTextTrack = (event: Event) => {
      if (!current()) return;
      const track = (event as TrackEvent).track;
      if (!track || (track.kind !== "subtitles" && track.kind !== "captions"))
        return;
      if (
        sidecars().has(track) ||
        hls.allSubtitleTracks.some((rendition) =>
          matchesRendition(track, rendition),
        )
      )
        return;
      nativeCaptions.add(track);
      updateSubtitles();
    };
    const reset = () => {
      if (!current()) return;
      nativeCaptions.clear();
      onSubtitles([]);
      onAudioLoading?.();
    };
    const updateAudio = () => {
      if (!current()) return;
      const tracks = hls.audioTracks.map((track, index) => ({
        id: `hls:${track.groupId}:${track.url}:${track.name}:${track.lang}`,
        label: track.name || "",
        language: track.lang || "und",
        hlsIndex: index,
        default: track.default,
        characteristics: track.characteristics || "",
      }));
      onAudio(tracks);
      const next = selectAudio(tracks);
      onActiveAudio(hls.audioTrack === next ? next : -1);
      if (next >= 0 && hls.audioTrack !== next) hls.audioTrack = next;
    };
    video.textTracks.addEventListener("addtrack", onTextTrack);
    video.addEventListener("addtrack", onTextTrack);
    hls.on(Hls.Events.MANIFEST_LOADING, reset);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateSubtitles);
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, updateAudio);
    hls.on(Hls.Events.MANIFEST_PARSED, updateAudio);
    return () => {
      disposed = true;
      video.textTracks.removeEventListener("addtrack", onTextTrack);
      video.removeEventListener("addtrack", onTextTrack);
      hls.off(Hls.Events.MANIFEST_LOADING, reset);
      hls.off(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateSubtitles);
      hls.off(Hls.Events.AUDIO_TRACKS_UPDATED, updateAudio);
      hls.off(Hls.Events.MANIFEST_PARSED, updateAudio);
    };
  }

  const audioList = (
    video as HTMLVideoElement & { audioTracks?: NativeAudioTrackList }
  ).audioTracks;
  const updateSubtitles = () => {
    if (!current()) return;
    const external = sidecars();
    onSubtitles(
      Array.from(video.textTracks)
        .filter(
          (track) =>
            !external.has(track) &&
            (track.kind === "subtitles" || track.kind === "captions"),
        )
        .map(nativeSubtitle),
    );
  };
  const updateAudio = () => {
    if (!current()) return;
    if (!audioList) {
      onAudio([]);
      onActiveAudio(-1);
      return;
    }
    const tracks = Array.from(audioList, (track, index) => ({
      id: `native:${track.id || index}:${track.language}:${track.label}`,
      label: track.label,
      language: track.language,
      kind: track.kind,
      nativeTrack: track,
      default: track.kind === "main",
    }));
    const next = selectAudio(tracks);
    for (const [index, track] of tracks.entries()) {
      if (track.nativeTrack.enabled !== (index === next))
        track.nativeTrack.enabled = index === next;
    }
    onAudio(tracks);
    onActiveAudio(next);
  };
  const syncAudio = () => {
    if (current() && audioList)
      onActiveAudio(Array.from(audioList).findIndex((track) => track.enabled));
  };
  video.textTracks.addEventListener("addtrack", updateSubtitles);
  video.textTracks.addEventListener("removetrack", updateSubtitles);
  video.addEventListener("loadedmetadata", updateSubtitles);
  video.addEventListener("loadedmetadata", updateAudio);
  audioList?.addEventListener("addtrack", updateAudio);
  audioList?.addEventListener("removetrack", updateAudio);
  audioList?.addEventListener("change", syncAudio);
  return () => {
    disposed = true;
    video.textTracks.removeEventListener("addtrack", updateSubtitles);
    video.textTracks.removeEventListener("removetrack", updateSubtitles);
    video.removeEventListener("loadedmetadata", updateSubtitles);
    video.removeEventListener("loadedmetadata", updateAudio);
    audioList?.removeEventListener("addtrack", updateAudio);
    audioList?.removeEventListener("removetrack", updateAudio);
    audioList?.removeEventListener("change", syncAudio);
  };
}
