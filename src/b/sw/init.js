if (isFolio) {
  importScripts("/b/fl/controller.sw.js");
  folio = self.$folioController;
}

let rivetRouter = null;
try {
  importScripts("/b/rv/router.js");
  rivetRouter = self.$rivetRouter || null;
} catch (error) {
  console.error(
    "failed to load rivet service-worker router:",
    error,
    NEGATIVE,
  );
}
