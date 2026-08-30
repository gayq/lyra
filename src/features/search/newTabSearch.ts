type NewTabSearchMode = "web" | "games" | "anime";

export interface ParsedNewTabQuery {
  mode: NewTabSearchMode;
  query: string;
}

export function parseNewTabQuery(value: string): ParsedNewTabQuery {
  const trimmed = value.trim();
  const modePrefix = trimmed.match(/^([ga]):\s*/i);
  if (!modePrefix) {
    return { mode: "web", query: trimmed };
  }

  return {
    mode: modePrefix[1]?.toLowerCase() === "g" ? "games" : "anime",
    query: trimmed.slice(modePrefix[0].length).trim(),
  };
}
