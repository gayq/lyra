import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

const IMAGE_RETRY_DELAYS_MS = [300, 1_000, 2_500] as const;

function retryImageSrc(src: string, attempt: number): string {
  if (attempt <= 0 || !src.startsWith("/") || src.startsWith("//")) {
    return src;
  }

  const hashIndex = src.indexOf("#");
  const base = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : "";
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}image-retry=${attempt}${hash}`;
}

export function useImageLoad(
  initialSrc?: string | null,
  fallbackSrc?: string | null,
) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSrc, setActiveSrc] = useState(initialSrc);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(!initialSrc);

  const clearRetry = useCallback(() => {
    if (retryTimerRef.current === null) return;
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  useLayoutEffect(() => {
    clearRetry();
    setActiveSrc(initialSrc);
    setAttempt(0);
  }, [clearRetry, fallbackSrc, initialSrc]);

  const src = activeSrc ? retryImageSrc(activeSrc, attempt) : "";

  useLayoutEffect(() => {
    setLoaded(false);
    setErrored(!activeSrc);

    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, [activeSrc, src]);

  useLayoutEffect(() => {
    return clearRetry;
  }, [clearRetry]);

  const onLoad = useCallback(() => {
    clearRetry();
    setLoaded(true);
    setErrored(false);
  }, [clearRetry]);

  const onError = useCallback(() => {
    clearRetry();

    if (fallbackSrc && activeSrc !== fallbackSrc) {
      setActiveSrc(fallbackSrc);
      setAttempt(0);
      return;
    }

    const delay = IMAGE_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) {
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        setAttempt((value) => value + 1);
      }, delay);
      return;
    }

    setLoaded(true);
    setErrored(true);
  }, [activeSrc, attempt, clearRetry, fallbackSrc]);

  return {
    errored,
    imgRef,
    loaded,
    onError,
    onLoad,
    requestKey: attempt,
    src,
  };
}
