import type { JSX } from "preact";
import type { IconPathData } from "./paths";

export interface IconProps {
  size?: number | undefined;
  solid?: boolean | undefined;
  class?: string | undefined;
  style?: string | JSX.CSSProperties | undefined;
  onClick?: ((e: MouseEvent) => void) | undefined;
}

interface IconBaseProps extends IconProps {
  icon: IconPathData;
}

export default function IconBase({
  icon,
  size = 18,
  solid = false,
  class: cls = "",
  style,
  onClick,
}: IconBaseProps) {
  const source = solid ? icon.solid : icon;
  return (
    <svg
      {...(source.attributes as JSX.SVGAttributes<SVGSVGElement>)}
      viewBox={source.viewBox}
      width={size}
      height={size}
      class={cls}
      style={style}
      aria-hidden="true"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: source.content }}
    />
  );
}
