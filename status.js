// FreeZone BD - app status: the announcement banner and maintenance mode, both controlled from the admin panel.
//   config/announcement = { enabled, text, kind: "info"|"warning", link?, id }   -> closable banner at the top
//   config/maintenance  = { enabled, message }                                   -> full-screen "back soon" for everyone except admins
// feed.js calls startAppStatus() once after login.
import { ref, get, onValue } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { signOut } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { escapeHtml } from "./post.js";

const DISMISS_KEY = "fz-announcement-dismissed";
let started = false;

const safeLink = (url) => {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" ? u.href : "";
  } catch (error) {
    return "";
  }
};

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) || ""; } catch (error) { return ""; }
}

function showAnnouncement(data) {
  document.getElementById("fzAnnouncement")?.remove();
  if (!data || data.enabled !== true || !data.text) return;
  if (String(data.id || "") === readDismissed()) return;

  const warning = data.kind === "warning";
  const link = safeLink(data.link);
  const bar = document.createElement("div");
  bar.id = "fzAnnouncement";
  bar.setAttribute("role", "status");
  bar.className = `${warning ? "bg-error-container text-on-error-container" : "bg-primary-fixed text-primary"} flex items-center gap-2 px-4 py-2 text-[13px] font-semibold`;
  bar.innerHTML = `
    <span class="material-symbols-outlined text-[18px] flex-shrink-0">${warning ? "warning" : "campaign"}</span>
    <span class="flex-1 min-w-0 break-words">${escapeHtml(data.text)}${link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="underline">Learn more</a>` : ""}</span>
    <button type="button" class="fz-ann-x w-7 h-7 -mr-1 rounded-full flex items-center justify-center flex-shrink-0 active:scale-90" aria-label="Close"><span class="material-symbols-outlined text-[18px]">close</span></button>`;
  bar.querySelector(".fz-ann-x").addEventListener("click", () => {
    try { localStorage.setItem(DISMISS_KEY, String(data.id || "")); } catch (error) { /* ignore */ }
    bar.remove();
  });
  document.body.insertBefore(bar, document.body.firstChild);
}

function showMaintenance(data, isAdmin, auth) {
  document.getElementById("fzMaintenance")?.remove();
  document.getElementById("fzMaintenanceAdmin")?.remove();
  if (!data || data.enabled !== true) return;

  if (isAdmin) {
    const bar = document.createElement("div");
    bar.id = "fzMaintenanceAdmin";
    bar.className = "bg-error text-on-error text-center text-[12px] font-semibold px-4 py-1.5";
    bar.textContent = "Maintenance mode is ON. Only admins can see the app.";
    document.body.insertBefore(bar, document.body.firstChild);
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "fzMaintenance";
  overlay.className = "fixed inset-0 z-[10000] bg-background text-on-surface flex items-center justify-center p-6 text-center";
  overlay.setAttribute("role", "alert");
  overlay.innerHTML = `
    <div class="max-w-sm">
      <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-primary-fixed text-primary flex items-center justify-center"><span class="material-symbols-outlined text-[34px]">construction</span></div>
      <h1 class="font-headline-md text-headline-md font-semibold mb-2">We will be back soon</h1>
      <p class="text-slate-muted text-body-md whitespace-pre-line">${escapeHtml(data.message || "FreeZone BD is being updated. Please come back in a little while.")}</p>
      ${auth ? `<button type="button" class="fz-mt-out mt-6 px-6 py-2.5 rounded-full bg-surface-container text-on-surface font-label-lg text-label-lg font-semibold active:scale-95">Log out</button>` : ""}
    </div>`;
  overlay.querySelector(".fz-mt-out")?.addEventListener("click", async () => {
    try { await signOut(auth); } catch (error) { /* ignore */ }
    location.href = "login.html";
  });
  document.body.appendChild(overlay);
}

export function startAppStatus({ db, auth, currentUser } = {}) {
  if (started || !db || !currentUser) return;
  started = true;

  let adminPromise = null;
  const isAdmin = () => {
    if (!adminPromise) {
      adminPromise = get(ref(db, `admins/${currentUser.uid}`)).then((s) => s.exists()).catch(() => false);
    }
    return adminPromise;
  };

  onValue(ref(db, "config/announcement"), (snap) => showAnnouncement(snap.exists() ? snap.val() : null), () => {});
  onValue(ref(db, "config/maintenance"), async (snap) => showMaintenance(snap.exists() ? snap.val() : null, await isAdmin(), auth), () => {});
}