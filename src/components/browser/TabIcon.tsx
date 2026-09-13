import { useState } from "preact/hooks";
import { svgIcon } from "../../core/ui/svgIcon";

const DEFAULT_FAVICON =
  `data:image/svg+xml,${encodeURIComponent(
    svgIcon("IconGlobe", { size: 18, style: "color:#818181" }),
  )}`;

export function TabIcon({
  favicon,
  eager,
}: {
  favicon: string | null | undefined;
  eager: boolean | undefined;
}) {
  return <TabIconInner key={favicon || "default"} favicon={favicon} eager={eager} />;
}

function TabIconInner({
  favicon,
  eager,
}: {
  favicon: string | null | undefined;
  eager: boolean | undefined;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src = favicon || DEFAULT_FAVICON;

  return (
    <div class={`tab-icon${!loaded && !errored ? " skeleton" : ""}`}>
      <img
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        src={errored ? DEFAULT_FAVICON : src}
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(true);
          setErrored(true);
        }}
      />
    </div>
  );
}
