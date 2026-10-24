export const ADCASH_LIBRARY_PATH = "/_lyra/assets/core.js";

export function loadAdcash(origin = ""): void {
  const page = window as Window & { __lyraAdcashLoading?: boolean };
  if (page.top !== page.self || page.__lyraAdcashLoading) return;
  page.__lyraAdcashLoading = true;
  const library = document.createElement("script");
  library.async = true;
  library.src = origin + ADCASH_LIBRARY_PATH;
  document.head.appendChild(library);
}
