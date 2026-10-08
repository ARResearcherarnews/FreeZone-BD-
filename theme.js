// FreeZone BD - Light / Dark theme
//
// Modes:  "light" | "dark" | "system" (follow the phone's setting; this is the default)
// The choice is saved on this device (localStorage "fz-theme"), so the app opens in the right colours at once.
// The colours themselves live in theme.css. The pages also run a tiny script in <head> that sets the
// "dark" class before anything is drawn, so there is no white flash.

const KEY = "fz-theme";
const LIGHT_BAR = "#004ac6";
const DARK_BAR = "#0f172a";
const listeners = new Set();
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function getThemeMode() {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch (error) {
    return "system";
  }
}

export function isDark(mode = getThemeMode()) {
  return mode === "dark" || (mode === "system" && !!media && media.matches);
}

// Puts the theme on the page (the "dark" class on <html>) and colours the phone's status bar
export function applyTheme(mode = getThemeMode(), { animate = false } = {}) {
  const root = document.documentElement;
  const dark = isDark(mode);

  if (animate) {
    root.classList.add("theme-fade");
    setTimeout(() => root.classList.remove("theme-fade"), 400);
  }
  root.classList.toggle("dark", dark);

  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.setAttribute("content", dark ? DARK_BAR : LIGHT_BAR));
  listeners.forEach((listener) => listener(mode, dark));
}

export function setThemeMode(mode) {
  const next = mode === "light" || mode === "dark" ? mode : "system";
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch (error) {
    // storage blocked: the theme still changes for this visit
  }
  applyTheme(next, { animate: true });
}

// Calls back whenever the theme changes. Returns a function that stops it.
export function onThemeChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

// Call once when a page starts: applies the saved theme and follows the phone's setting while on "system"
let started = false;
export function initTheme() {
  applyTheme();
  if (started) return;
  started = true;
  if (media) {
    const follow = () => {
      if (getThemeMode() === "system") applyTheme("system", { animate: true });
    };
    if (media.addEventListener) media.addEventListener("change", follow);
    else if (media.addListener) media.addListener(follow);
  }
}