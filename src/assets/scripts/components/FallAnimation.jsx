import { useEffect } from "preact/hooks";
import { initializeFall } from "../core/layout.js";

let initialized = false;

export default function FallAnimation() {
  useEffect(() => {
    if (!initialized) {
      initialized = true;
      initializeFall();
    }
  }, []);
  return null;
}