export function attachCaptionLayout(
  video: HTMLVideoElement,
  controls: HTMLElement,
  visible: boolean,
): () => void {
  const adjusted = new Map<
    VTTCue,
    { line: VTTCue["line"]; snap: boolean; align: VTTCue["lineAlign"] }
  >();
  const tracks = new Set<TextTrack>();
  const restore = (cue: VTTCue) => {
    const original = adjusted.get(cue);
    if (!original) return;
    cue.line = original.line;
    cue.snapToLines = original.snap;
    cue.lineAlign = original.align;
    adjusted.delete(cue);
  };
  const position = () => {
    const rect = video.getBoundingClientRect();
    if (!rect.height || !rect.width) return;
    const pictureHeight =
      video.videoWidth > 0
        ? Math.min(
            rect.height,
            (rect.width * video.videoHeight) / video.videoWidth,
          )
        : rect.height;
    const fontSize = Math.max(16, Math.min(28, window.innerWidth * 0.022));
    const lineHeight = fontSize * 1.4;
    const inset = Math.max(16, Math.min(32, pictureHeight * 0.05));
    let bottom = Math.min(
      (rect.height + pictureHeight) / 2 - inset,
      visible
        ? controls.getBoundingClientRect().top - rect.top - 12
        : rect.height,
    );
    const active = new Set<VTTCue>();
    for (const track of Array.from(video.textTracks)) {
      if (!tracks.has(track)) {
        tracks.add(track);
        track.addEventListener("cuechange", position);
      }
      if (track.mode !== "showing") continue;
      for (const cue of (
        Array.from(track.activeCues || []) as VTTCue[]
      ).reverse()) {
        if (
          cue.vertical ||
          !(adjusted.has(cue) || (cue.line === "auto" && cue.snapToLines))
        )
          continue;
        active.add(cue);
        if (!adjusted.has(cue))
          adjusted.set(cue, {
            line: cue.line,
            snap: cue.snapToLines,
            align: cue.lineAlign,
          });
        const line = Math.max(0, Math.min(100, (bottom / rect.height) * 100));
        if (cue.snapToLines) cue.snapToLines = false;
        if (cue.lineAlign !== "end") cue.lineAlign = "end";
        if (cue.line !== line) cue.line = line;
        const columns = Math.max(
          1,
          (rect.width * cue.size) / 100 / (fontSize * 0.6),
        );
        const rows = cue.text
          .replace(/<[^>]*>/g, "")
          .split("\n")
          .reduce(
            (count, text) =>
              count + Math.max(1, Math.ceil(text.length / columns)),
            0,
          );
        bottom -= rows * lineHeight + 4;
      }
    }
    for (const cue of adjusted.keys()) if (!active.has(cue)) restore(cue);
  };
  const observer = new ResizeObserver(position);
  observer.observe(video);
  observer.observe(controls);
  video.textTracks.addEventListener("addtrack", position);
  video.addEventListener("loadedmetadata", position);
  position();
  return () => {
    observer.disconnect();
    video.textTracks.removeEventListener("addtrack", position);
    video.removeEventListener("loadedmetadata", position);
    for (const track of tracks)
      track.removeEventListener("cuechange", position);
    for (const cue of adjusted.keys()) restore(cue);
  };
}
