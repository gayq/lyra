import { useEffect, lazy, Suspense } from "preact/compat";
import Sidebar from "./components/Sidebar.tsx";
import NavBar from "./components/NavBar.tsx";
import SearchBar from "./components/SearchBar.tsx";
import Bookmarks from "./components/Bookmarks.tsx";
import Footer from "./components/Footer.tsx";
import TopBar from "./components/TopBar.tsx";

const loadGamesPage = () => import("./components/GamesPage.tsx");
const GamesPage = lazy(loadGamesPage);
const NewTabModal = lazy(() => import("./components/NewTabModal.tsx"));
const SettingsMenu = lazy(() => import("./components/SettingsMenu.tsx"));

export default function App() {
  useEffect(() => {
    const onekoEl = document.getElementById("oneko");
    if (!onekoEl) return;
    const frames = [
      [-2, 0],
      [-2, -1],
    ];
    let idx = 0;
    const sprite = frames[0]!;
    onekoEl.style.backgroundPosition = `${sprite[0]! * 32}px ${sprite[1]! * 32}px`;
    idx++;
    const interval = setInterval(() => {
      if (document.hidden || !onekoEl.isConnected || onekoEl.style.display === "none") return;
      const s = frames[idx % frames.length]!;
      onekoEl.style.backgroundPosition = `${s[0]! * 32}px ${s[1]! * 32}px`;
      idx++;
    }, 400);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <TopBar />
      <Sidebar />
      <div class="content-area">
        <NavBar />
        <div class="main-container">
          <div class="title"><img src="/assets/images/peaks/hachii.webp" /></div>
          <SearchBar />
        </div>
        <Bookmarks />
        <Suspense fallback={null}>
          <GamesPage />
        </Suspense>
        <div id="iframe-container">
          <div id="iframe-resize-divider"></div>
        </div>
        <Footer />
      </div>
      <Suspense fallback={null}>
        <NewTabModal />
      </Suspense>
      <Suspense fallback={null}>
        <SettingsMenu />
      </Suspense>
      <div id="overlay" class="overlay" />
    </>
  );
}