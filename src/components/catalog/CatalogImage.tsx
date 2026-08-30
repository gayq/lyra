import { useImageLoad } from "../../hooks/useImageLoad.ts";
import { IconImageAltText } from "../icons";

interface CatalogImageProps {
  src?: string | null;
  lowBandwidthSrc?: string | null | undefined;
  alt?: string;
  className: string;
  fallbackSize?: number;
}

interface NetworkInformationLike {
  effectiveType?: string;
  saveData?: boolean;
}

function prefersLowBandwidthImage(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (
    navigator as Navigator & { connection?: NetworkInformationLike }
  ).connection;
  return Boolean(
    connection?.saveData ||
    connection?.effectiveType === "slow-2g" ||
    connection?.effectiveType === "2g" ||
    connection?.effectiveType === "3g",
  );
}

export default function CatalogImage({
  src,
  lowBandwidthSrc,
  alt = "",
  className,
  fallbackSize = 32,
}: CatalogImageProps) {
  const preferredSrc =
    lowBandwidthSrc && prefersLowBandwidthImage() ? lowBandwidthSrc : src;
  const image = useImageLoad(preferredSrc, src);

  return (
    <div
      class={`${className}${!image.loaded && !image.errored ? " skeleton" : ""}${image.errored ? " no-cover" : ""}${image.loaded && !image.errored ? " loaded" : ""}`}
    >
      {image.src && !image.errored && (
        <img
          key={image.requestKey}
          ref={image.imgRef}
          loading="lazy"
          decoding="async"
          src={image.src}
          alt={alt}
          onLoad={image.onLoad}
          onError={image.onError}
        />
      )}
      {image.errored && (
        <IconImageAltText size={fallbackSize} class="no-cover-icon" />
      )}
    </div>
  );
}
