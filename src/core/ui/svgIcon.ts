import { ICON_PATHS } from "../../components/icons/paths";

export function svgIcon(
  name: string,
  options?: { size?: number; solid?: boolean; style?: string },
): string {
  const icon = ICON_PATHS[name as keyof typeof ICON_PATHS];
  if (!icon) return "";
  const source = options?.solid ? icon.solid : icon;
  const size = options?.size ?? 18;
  const openingEnd = source.svg.indexOf(">", 4);
  const openingTag = source.svg.slice(0, openingEnd);
  const style = options?.style
    ? ` style="${escapeAttribute(options.style)}"`
    : "";
  return `${openingTag} width="${size}" height="${size}" aria-hidden="true"${style}>${source.content}</svg>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
