let _overlayUsers = 0;

export function showOverlay(): void {
  _overlayUsers++;
  document.getElementById("overlay")?.classList.add("show");
}

export function hideOverlay(): void {
  _overlayUsers = Math.max(0, _overlayUsers - 1);
  if (_overlayUsers <= 0) {
    _overlayUsers = 0;
    document.getElementById("overlay")?.classList.remove("show");
  }
}
