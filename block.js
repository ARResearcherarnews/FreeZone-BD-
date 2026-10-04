// FreeZone BD - Blocked accounts
//
// Data (Firebase Realtime Database):  blocks/{myUid}/{blockedUid} = time   (only I can read or change it)
//
// When I block someone:
//   - we stop following each other,
//   - they can no longer message me, follow me, comment on my posts or notify me (enforced by the database rules),
//   - I no longer see their posts, comments, messages, suggestions or search results.
// They are not told. Unblocking is done from Chat settings -> Blocked accounts (or the person's profile).
//
// feed.js calls startBlocks() once after login; the other files use isBlocked() / blockAccount() / unblockAccount().

import {
  ref,
  get,
  update,
  remove,
  onValue,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, showToast, updateFollowButtons } from "./post.js";

/* ---------------------------------------------------------------
   Who is blocked (always up to date)
---------------------------------------------------------------- */
let blocked = new Set();
const listeners = new Set();
let started = false;

export function startBlocks({ db, currentUser } = {}) {
  if (started || !db || !currentUser) return;
  started = true;

  onValue(
    ref(db, `blocks/${currentUser.uid}`),
    (snap) => {
      blocked = new Set(snap.exists() ? Object.keys(snap.val()) : []);
      listeners.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          console.warn("Blocks listener failed:", error);
        }
      });
    },
    () => {} // no permission: nobody is treated as blocked
  );
}

export const isBlocked = (uid) => blocked.has(uid);
export const getBlockedIds = () => [...blocked];

/** Calls `callback` whenever the blocked list changes. Returns a function that stops it. */
export function onBlocksChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/* ---------------------------------------------------------------
   Sheets
---------------------------------------------------------------- */
function sheet(innerHtml, label) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
  overlay.innerHTML = `<div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">${innerHtml}</div>`;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.body.appendChild(overlay);
  return { overlay, close };
}

/** A list of actions in a bottom sheet. Resolves with the chosen key, or null when cancelled. */
export function openActionMenu(actions) {
  return new Promise((resolve) => {
    const { overlay, close } = sheet(
      `<div class="p-4 pb-5">
        ${actions
          .map(
            (action) => `
          <button type="button" class="am-action w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left font-body-md text-body-md hover:bg-surface-container-low active:bg-surface-container ${action.danger ? "text-error" : "text-on-surface"}" data-key="${action.key}">
            <span class="material-symbols-outlined text-[22px]">${action.icon}</span> ${escapeHtml(action.label)}
          </button>`
          )
          .join("")}
        <button type="button" class="am-cancel w-full mt-2 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Cancel</button>
      </div>`,
      "Options"
    );
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = event.target.closest(".am-action");
      if (action) {
        close();
        resolve(action.dataset.key);
      } else if (event.target === overlay || event.target.closest(".am-cancel")) {
        close();
        resolve(null);
      }
    });
  });
}

function confirmBlock(handle) {
  return new Promise((resolve) => {
    const { overlay, close } = sheet(
      `<div class="p-5">
        <div class="w-12 h-12 rounded-full bg-error-container text-error flex items-center justify-center mb-3">
          <span class="material-symbols-outlined">block</span>
        </div>
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Block ${escapeHtml(handle)}?</h2>
        <ul class="font-body-md text-body-md text-slate-muted mt-2 space-y-1.5 list-disc pl-5">
          <li>They will not be told that you blocked them.</li>
          <li>They cannot message you or follow you.</li>
          <li>You will stop following each other.</li>
          <li>You will not see their posts, comments or messages.</li>
        </ul>
        <p class="font-body-sm text-body-sm text-slate-subtle mt-3">You can unblock them any time in Chat settings, under Blocked accounts.</p>
        <div class="flex gap-2.5 mt-5">
          <button type="button" class="cb-cancel flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-95 transition-all">Cancel</button>
          <button type="button" class="cb-confirm flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-white bg-error active:scale-95 transition-all">Block</button>
        </div>
      </div>`,
      "Block account"
    );
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target.closest(".cb-confirm")) {
        close();
        resolve(true);
      } else if (event.target === overlay || event.target.closest(".cb-cancel")) {
        close();
        resolve(false);
      }
    });
  });
}

/* ---------------------------------------------------------------
   Block / unblock
---------------------------------------------------------------- */
/**
 * Asks, then blocks. user = { uid, name, username }.  followingIds is feed.js's live "who I follow" object,
 * so the Follow buttons everywhere switch back to "Follow". Resolves true when the person was blocked.
 */
export async function blockAccount({ db, me, user, followingIds = {} } = {}) {
  if (!db || !me || !user || !user.uid || user.uid === me) return false;

  const handle = user.username ? `@${user.username}` : user.name || "this account";
  if (!(await confirmBlock(handle))) return false;

  try {
    // One atomic update: the block itself, and both follow links removed in both directions
    await update(ref(db), {
      [`blocks/${me}/${user.uid}`]: serverTimestamp(),
      [`following/${me}/${user.uid}`]: null,
      [`followers/${user.uid}/${me}`]: null,
      [`following/${user.uid}/${me}`]: null,
      [`followers/${me}/${user.uid}`]: null
    });
  } catch (error) {
    console.error("Block failed:", error);
    showToast(error.code === "PERMISSION_DENIED" ? "Could not block: database rules block it" : "Could not block this account");
    return false;
  }

  blocked.add(user.uid); // immediately, before the database tells us
  delete followingIds[user.uid];
  updateFollowButtons(user.uid, false);
  listeners.forEach((listener) => listener());
  showToast(`Blocked ${handle}`);
  return true;
}

export async function unblockAccount({ db, me, uid, name = "" } = {}) {
  if (!db || !me || !uid) return false;
  try {
    await remove(ref(db, `blocks/${me}/${uid}`));
  } catch (error) {
    console.error("Unblock failed:", error);
    showToast("Could not unblock. Try again.");
    return false;
  }
  blocked.delete(uid);
  listeners.forEach((listener) => listener());
  showToast(name ? `Unblocked ${name}` : "Unblocked");
  return true;
}

/* ---------------------------------------------------------------
   Blocked accounts list (Chat settings -> Blocked accounts)
---------------------------------------------------------------- */
export async function openBlockedAccounts({ db, me, onChange } = {}) {
  const { overlay, close } = sheet(
    `<div class="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-border">
       <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Blocked accounts</h2>
       <button type="button" class="ba-close w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close">
         <span class="material-symbols-outlined text-[20px]">close</span>
       </button>
     </div>
     <div class="ba-list overflow-y-auto px-2 py-2"><p class="text-center text-slate-muted font-body-md text-body-md py-10">Loading...</p></div>`,
    "Blocked accounts"
  );
  const listEl = overlay.querySelector(".ba-list");

  const empty = () => {
    listEl.innerHTML = `
      <div class="text-center py-12 px-6">
        <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-surface-container flex items-center justify-center">
          <span class="material-symbols-outlined text-[28px] text-primary-container">block</span>
        </div>
        <p class="font-label-lg text-label-lg text-on-surface mb-1">No blocked accounts</p>
        <p class="font-body-md text-body-md text-slate-muted">People you block will appear here.</p>
      </div>`;
  };

  const ids = getBlockedIds();
  if (!ids.length) empty();
  else {
    const users = await Promise.all(
      ids.map((uid) =>
        get(ref(db, `users/${uid}`))
          .then((snap) => (snap.exists() ? snap.val() : null))
          .catch(() => null)
      )
    );
    if (!overlay.isConnected) return;

    listEl.innerHTML = ids
      .map((uid, index) => {
        const data = users[index] || {};
        const name = data.name || "FreeZone User";
        return `
        <div class="ba-row flex items-center gap-3 px-3 py-2.5" data-uid="${escapeHtml(uid)}" data-name="${escapeHtml(data.username ? "@" + data.username : name)}">
          ${avatarHtml(data.photoURL || "", "w-11 h-11")}
          <div class="min-w-0 flex-1">
            <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(name)}</div>
            ${data.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(data.username)}</div>` : ""}
          </div>
          <button type="button" class="ba-unblock flex-shrink-0 px-4 py-1.5 rounded-full bg-surface-container text-on-surface font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60">Unblock</button>
        </div>`;
      })
      .join("");
  }

  overlay.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (event.target === overlay || event.target.closest(".ba-close")) return close();

    const button = event.target.closest(".ba-unblock");
    if (!button) return;
    const row = button.closest(".ba-row");
    button.disabled = true;
    const ok = await unblockAccount({ db, me, uid: row.dataset.uid, name: row.dataset.name });
    if (!ok) {
      button.disabled = false;
      return;
    }
    row.remove();
    if (!listEl.querySelector(".ba-row")) empty();
    onChange?.();
  });
}