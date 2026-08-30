declare const __LYRA_BUILD_ID__: string;

export type RuntimeMount = "bmux" | "epoxy" | "libcurl";

export const clientBuildId =
  typeof __LYRA_BUILD_ID__ === "string" ? __LYRA_BUILD_ID__ : "";

export function runtimeAssetPath(
  mount: RuntimeMount,
  fileName: string,
  buildId = clientBuildId,
): string {
  const relativeFileName = fileName.replace(/^\/+/, "");
  return buildId
    ? `/${mount}/${buildId}/${relativeFileName}`
    : `/${mount}/${relativeFileName}`;
}
