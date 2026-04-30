import { useEffect, lazy, Suspense } from "preact/compat";
import Sidebar from "./components/Sidebar.jsx";
import NavBar from "./components/NavBar.jsx";
import SearchBar from "./components/SearchBar.jsx";
import Bookmarks from "./components/Bookmarks.jsx";
import Footer from "./components/Footer.jsx";
import TopBar from "./components/TopBar.jsx";

const loadGamesPage = () => import("./components/GamesPage.jsx");
const GamesPage = lazy(loadGamesPage);
const NewTabModal = lazy(() => import("./components/NewTabModal.jsx"));
const SettingsMenu = lazy(() => import("./components/SettingsMenu.jsx"));

export default function App() {
  useEffect(() => {
    const onekoEl = document.getElementById("oneko");
    if (!onekoEl) return;
    const frames = [
      [-2, 0],
      [-2, -1],
    ];
    let idx = 0;
    const sprite = frames[0];
    onekoEl.style.backgroundPosition = `${sprite[0] * 32}px ${sprite[1] * 32}px`;
    idx++;
    const interval = setInterval(() => {
      if (!onekoEl.isConnected || onekoEl.style.display === "none") return;
      const s = frames[idx % frames.length];
      onekoEl.style.backgroundPosition = `${s[0] * 32}px ${s[1] * 32}px`;
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
          <div class="title">waves!!</div>
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
      <IconPreloader />
    </>
  );
}

function IconPreloader() {
  return (
    <div class="icon-preloader" aria-hidden="true">
      <i class="fa-regular fa-table-rows"></i>
      <i class="fa-regular fa-chevron-left"></i>
      <i class="fa-regular fa-chevron-right"></i>
      <i class="fa-regular fa-arrow-rotate-right"></i>
      <i class="fa-regular fa-unlock-keyhole"></i>
      <i class="fa-regular fa-lock-keyhole"></i>
      <i class="fa-regular fa-house-chimney-window"></i>
      <i class="fa-regular fa-expand"></i>
      <i class="fa-regular fa-table-columns"></i>
      <i class="fa-regular fa-square-code"></i>
      <i class="fa-regular fa-magnifying-glass"></i>
      <i class="fa-regular fa-plus"></i>
      <i class="fa-solid fa-gear"></i>
      <i class="fa-solid fa-ghost"></i>
      <i class="fa-solid fa-server"></i>
      <i class="fa-solid fa-user"></i>
      <i class="fa-solid fa-heart"></i>
      <i class="fa-solid fa-file-export"></i>
      <i class="fa-solid fa-file-import"></i>
      <i class="fa-regular fa-times"></i>
      <i class="fa-solid fa-angle-down"></i>
      <i class="fa-regular fa-pencil"></i>
    </div>
  );
}