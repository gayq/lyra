import type { PlayerStatus } from "../../state/store.ts";
import { negativeMessage, positiveMessage } from "../../core/runtime/messages.ts";

const FOOTER_TEXT: Record<PlayerStatus, string> = {
  idle: "",
  loading: "loading...",
  buffering: "buffering...",
  waiting: "waiting for data...",
  stalled: negativeMessage("playback stalled"),
  playing: "",
  paused: "",
  ended: positiveMessage("ended"),
  error: negativeMessage("stream error"),
};

export function getSidebarFooterStatus(
  status: PlayerStatus,
  pageLoading = false,
): PlayerStatus {
  if (pageLoading) return "loading";
  return status === "playing" || status === "paused" ? "idle" : status;
}

export function getSidebarFooterText(
  status: PlayerStatus,
  pageLoading = false,
): string {
  return FOOTER_TEXT[getSidebarFooterStatus(status, pageLoading)];
}
