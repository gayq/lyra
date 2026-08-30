import { negativeMessage } from "./messages.ts";
import { clientBuildId } from "./build.ts";

export { clientBuildId } from "./build.ts";

export type StuffResponse = {
  version: string;
  build?: string;
};

const UPDATE_PARAM = "lyra-update";

export function parseStuffResponse(input: unknown): StuffResponse {
  if (!input || typeof input !== "object") {
    throw new Error(negativeMessage("invalid /api/stuff response payload"));
  }

  const payload = input as Record<string, unknown>;
  if (typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error(
      negativeMessage(
        "invalid /api/stuff response: version must be a non-empty string",
      ),
    );
  }

  if (payload.build !== undefined && typeof payload.build !== "string") {
    throw new Error(
      negativeMessage(
        "invalid /api/stuff response: build must be a string when present",
      ),
    );
  }

  const parsed: StuffResponse = { version: payload.version };
  if (typeof payload.build === "string") parsed.build = payload.build;
  return parsed;
}

export function buildStamp(metadata: StuffResponse): string {
  return `${metadata.version}:${metadata.build || ""}`;
}

export function isUpdateNeeded(
  metadata: StuffResponse,
  runningBuild: string,
  previousStamp: string | null,
  previousVersion: string | null,
): boolean {
  if (metadata.build && runningBuild) {
    return metadata.build !== runningBuild;
  }

  const currentStamp = buildStamp(metadata);
  if (previousStamp) return previousStamp !== currentStamp;
  return Boolean(previousVersion && previousVersion !== metadata.version);
}

export function isUpdateApplied(
  metadata: StuffResponse,
  runningBuild: string,
  pendingTarget: string | null,
): boolean {
  if (!pendingTarget || pendingTarget !== buildStamp(metadata)) return false;
  return Boolean(
    metadata.build && runningBuild && metadata.build === runningBuild,
  );
}

export function addUpdateMarker(href: string, target: string): string {
  const url = new URL(href);
  url.searchParams.set(UPDATE_PARAM, target);
  return url.href;
}

export function hasUpdateMarker(href: string, target: string): boolean {
  return new URL(href).searchParams.get(UPDATE_PARAM) === target;
}

export function removeUpdateMarker(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(UPDATE_PARAM);
  return url.href;
}
