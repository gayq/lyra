if (isScramjet) {
  importScripts("/b/s/jetty.all.js");
  const { ScramjetServiceWorker } = $scramjetLoadWorker();
  scramjet = new ScramjetServiceWorker();
} else if (isUltraviolet) {
  importScripts("/b/u/bunbun.js", "/b/u/concon.js", "/b/u/serser.js");
  uv = new UVServiceWorker();
}