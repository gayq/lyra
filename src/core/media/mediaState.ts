type MediaStatus =
  | "loading"
  | "buffering"
  | "waiting"
  | "stalled"
  | "playing"
  | "paused"
  | "ended"
  | "error";

type MediaBufferingReason = "waiting" | "stalled" | "seeking" | null;

interface MediaBufferedRange {
  start: number;
  end: number;
}

export interface MediaLike {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  readyState: number;
  networkState: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  videoWidth: number;
  videoHeight: number;
  buffered: {
    length: number;
    start(index: number): number;
    end(index: number): number;
  };
  error: { code?: number; message?: string } | null;
}

export interface MediaStateHints {
   
  sourceReady?: boolean;
   
  buffering?: boolean;
  bufferingReason?: Exclude<MediaBufferingReason, null> | null;
   
  error?: string | null;
   
  durationHint?: number | null;
   
  logicalOffset?: number;
}

export interface MediaState {
  status: MediaStatus;
  sourceReady: boolean;
  buffering: boolean;
  bufferingReason: MediaBufferingReason;
  playing: boolean;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  currentTime: number | null;
  duration: number | null;
  progress: number | null;
  buffered: MediaBufferedRange[];
  volume: number;
  muted: boolean;
  playbackRate: number;
  renderedWidth: number;
  renderedHeight: number;
  readyState: number;
  networkState: number;
  error: string | null;
}

function finiteNonNegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function mediaErrorMessage(media: MediaLike): string | null {
  if (!media.error) return null;
  const code = Number.isInteger(media.error.code) ? media.error.code : "unknown";
  return negativeMessage(`media playback failed (code ${code})`);
}

function readBufferedRanges(
  media: MediaLike,
  logicalOffset: number,
): MediaBufferedRange[] {
  const ranges: MediaBufferedRange[] = [];
  for (let index = 0; index < media.buffered.length; index += 1) {
    try {
      const start = media.buffered.start(index) + logicalOffset;
      const end = media.buffered.end(index) + logicalOffset;
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        ranges.push({ start, end });
      }
    } catch {
      
    }
  }
  return ranges;
}

export function readMediaState(
  media: MediaLike,
  hints: MediaStateHints = {},
): MediaState {
  const logicalOffset = finiteNonNegative(hints.logicalOffset ?? 0) ?? 0;
  const sourceReady = hints.sourceReady ?? media.readyState > 0;
  const metadataReady = sourceReady && media.readyState > 0;
  const currentTime = metadataReady ? finiteNonNegative(media.currentTime) : null;
  const rawDuration = metadataReady ? finiteNonNegative(media.duration) : null;
  const durationHint = finiteNonNegative(hints.durationHint ?? Number.NaN);
  const duration =
    rawDuration === null
      ? durationHint === null
        ? null
        : durationHint + logicalOffset
      : rawDuration + logicalOffset;
  const progress =
    currentTime !== null && duration !== null && duration > 0
      ? Math.max(0, Math.min(100, ((currentTime + logicalOffset) / duration) * 100))
      : null;
  const mediaError = mediaErrorMessage(media);
  const error = hints.error?.trim() || mediaError;
  const staleWaitingHint =
    hints.buffering === true &&
    hints.bufferingReason === "waiting" &&
    !media.paused &&
    !media.seeking &&
    media.readyState >= 3;
  const buffering = hints.buffering === true && !staleWaitingHint;
  let status: MediaStatus;

  if (error) status = "error";
  else if (!sourceReady || media.readyState === 0) status = "loading";
  else if (media.ended) status = "ended";
  else if (media.paused) status = "paused";
  else if (buffering) {
    status =
      hints.bufferingReason === "stalled"
        ? "stalled"
        : hints.bufferingReason === "waiting"
          ? "waiting"
          : "buffering";
  }
  else status = "playing";

  return {
    status,
    sourceReady,
    buffering:
      status === "buffering" || status === "waiting" || status === "stalled",
    bufferingReason:
      status === "buffering" || status === "waiting" || status === "stalled"
        ? hints.bufferingReason ?? (status === "stalled" ? "stalled" : "waiting")
        : null,
    playing: status === "playing",
    paused: media.paused,
    ended: media.ended,
    seeking: media.seeking,
    currentTime:
      currentTime === null ? null : currentTime + logicalOffset,
    duration,
    progress,
    buffered: metadataReady ? readBufferedRanges(media, logicalOffset) : [],
    volume: Number.isFinite(media.volume)
      ? Math.max(0, Math.min(1, media.volume)) * 100
      : 0,
    muted: Boolean(media.muted),
    playbackRate: Number.isFinite(media.playbackRate) ? media.playbackRate : 1,
    renderedWidth: Number.isFinite(media.videoWidth) ? Math.max(0, media.videoWidth) : 0,
    renderedHeight: Number.isFinite(media.videoHeight)
      ? Math.max(0, media.videoHeight)
      : 0,
    readyState: media.readyState,
    networkState: media.networkState,
    error,
  };
}
import { negativeMessage } from "../runtime/messages.ts";
