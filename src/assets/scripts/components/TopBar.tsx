import { useEffect } from "preact/hooks";

export default function TopBar() {
  useEffect(() => {
    const user = JSON.parse(localStorage.getItem("auth_user") || "{}");
    if (user.username) {
      const statusEl = document.getElementById("auth-status");
      if (statusEl) statusEl.textContent = user.username;
    }
  }, []);

  return (
    <>
      <div id="top-left-stuff">
        <div id="branding-container" class="icon-btn">
          <span id="brand">waves!!</span>
          <div id="oneko"></div>
        </div>
        <a
          href="https://discord.gg/dJvdkPRheV"
          target="_blank"
          id="discord-btn"
          class="icon-btn"
        >
          <i class="fa-brands fa-discord"></i>
        </a>
        <a href="#" id="choi" class="icon-btn">
          <i class="fa-solid fa-gamepad-modern"></i>
        </a>
      </div>
      <div id="top-right-stuff">
        <div
          id="auth-container"
          class="text-icon-btn"
          onClick={() =>
            document.dispatchEvent(new CustomEvent("toggleAuthModal"))
          }
        >
          <i class="fa-solid fa-cloud"></i>
          <span id="auth-status">cloud sync</span>
        </div>
        <a href="#" id="settings" class="icon-btn">
          <i class="settings fa-solid fa-gear"></i>
        </a>
      </div>
    </>
  );
}