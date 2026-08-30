import { render } from "preact";
import Player from "../components/player/Player.tsx";
import { resolveTheme } from "../core/config/settingsOptions.ts";
import {
  applyMotionPreference,
  readMotionPreference,
} from "../core/config/advancedSettings.ts";
import "../assets/styles/base/themes.css";
import "../assets/styles/anime/episode-selector.css";
import "../assets/styles/player/player.css";
import "../assets/styles/toast/toast.css";
import "../features/ui/toast.ts";

const recoveryUrl = new URL(window.location.href);
if (recoveryUrl.searchParams.has("lyra-recovery")) {
  recoveryUrl.searchParams.delete("lyra-recovery");
  history.replaceState(history.state, "", recoveryUrl.href);
}

const savedTheme = resolveTheme(localStorage.getItem("theme"));
if (savedTheme !== "default") {
  document.documentElement.setAttribute("data-theme", savedTheme);
} else {
  document.documentElement.removeAttribute("data-theme");
}

applyMotionPreference(readMotionPreference());

const root = document.getElementById("player-root");
if (root) {
  render(<Player />, root);
}
