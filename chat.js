// FreeZone BD - Chat: inbox + one-to-one conversations (realtime)
// Loaded on demand (dynamic import) from feed.js.
//
// Data (Firebase Realtime Database):
//   chats/{chatId}/members/{uid}          = true
//   chats/{chatId}/messages/{messageId}   = { from, text, createdAt, imageURL?, images?, imgW?, imgH?, replyTo?, forwarded?, editedAt?, deleted?, deletedAt? }
//     (a photo message: pictures are uploaded to imgbb, only their links are saved; text is the optional caption.
//      imageURL = first picture; images = all pictures when 2-4 were sent together.
//      replyTo = { id, from, text?, photo? } the message this one answers; forwarded = true when it was forwarded)
//   chats/{chatId}/messages/{messageId}/reactions/{uid} = one emoji per person (tap the same emoji again to take it back)
//   chats/{chatId}/delivered/{uid}        = time (ms) when that person's app last received a message  -> the "Delivered" mark
//   chats/{chatId}/typing/{uid}           = true while that person is typing
//   chats/{chatId}/reads/{uid}            = time (ms) when that person last read the chat  -> the "Seen" mark
//   userChats/{uid}/{chatId}              = { with, lastMessage, lastFrom, lastAt, unread }   <- the inbox of each person
//   presence/{uid}                        = { online, lastSeen }   <- the green "Active now" dot (only followers can read it)
// chatId = the two user ids sorted and joined with "_".

import {
  ref,
  get,
  set,
  onValue,
  onDisconnect,
  push,
  update,
  query,
  limitToLast,
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, timeAgo, showToast, openImageViewer, downloadImage } from "./post.js";
import { uploadToImgbb, prepareImage } from "./imgbb.js";
import { startCall } from "./call.js";
import { isBlocked, onBlocksChange, blockAccount, unblockAccount, openActionMenu, openBlockedAccounts, getBlockedIds } from "./block.js";

const MESSAGE_MAX = 1000; // characters per message
const PAGE = 40; // messages loaded at a time
const GROUP_MS = 5 * 60 * 1000; // messages sent within 5 minutes by the same person share one time label
const MAX_PRESENCE_WATCH = 40; // online status of at most this many followed people is watched

const userCache = new Map();

/* ---------------------------------------------------------------
   Helpers
---------------------------------------------------------------- */
export function chatIdFor(a, b) {
  return [a, b].sort().join("_");
}

async function readUser(db, uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  try {
    const snap = await get(ref(db, `users/${uid}`));
    const user = snap.exists()
      ? { uid, name: snap.val().name || "FreeZone User", username: snap.val().username || "", photoURL: snap.val().photoURL || "" }
      : null;
    userCache.set(uid, user);
    return user;
  } catch (error) {
    return null;
  }
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();
const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(ts) {
  const date = new Date(ts);
  const now = new Date();
  if (sameDay(date, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function inboxTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  const now = new Date();
  if (sameDay(date, now)) return timeOf(ts);
  const days = (now - date) / 86400000;
  if (days < 2) return "Yesterday";
  if (days < 7) return date.toLocaleDateString([], { weekday: "short" });
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

function skeletonRows(count = 5) {
  return Array.from({ length: count })
    .map(
      () => `
    <div class="flex items-center gap-3 px-4 py-3 bg-slate-surface rounded-2xl border border-slate-border">
      <div class="skeleton w-12 h-12 rounded-full flex-shrink-0"></div>
      <div class="flex-1 space-y-2">
        <div class="skeleton h-3.5 w-1/2 rounded"></div>
        <div class="skeleton h-3 w-3/4 rounded"></div>
      </div>
    </div>`
    )
    .join("");
}

function emptyState(icon, title, text) {
  return `
    <div class="text-center py-16 px-6">
      <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-surface-container flex items-center justify-center">
        <span class="material-symbols-outlined text-[30px] text-primary-container">${icon}</span>
      </div>
      <p class="font-headline-sm text-headline-sm text-on-surface font-semibold mb-1">${title}</p>
      <p class="font-body-md text-body-md text-slate-muted max-w-xs mx-auto">${text}</p>
    </div>`;
}

// Bottom sheet with a list of actions. Resolves with the chosen key, or null when cancelled.
const REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🙏"]; // quick emoji reactions on a message

// Resolves with the chosen action key, "react:<emoji>" for an emoji, or null when cancelled.
// options.emojis = row of emojis on top; options.current = the emoji I already gave (highlighted)
function openActionSheet(actions, { emojis = [], current = "" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 pb-5" role="dialog" aria-modal="true">
        ${
          emojis.length
            ? `<div class="flex items-center justify-between gap-1 mb-2 px-1 py-1.5 rounded-2xl bg-surface-container">${emojis
                .map(
                  (emoji) =>
                    `<button type="button" class="as-emoji flex-1 h-11 rounded-xl text-[26px] leading-none flex items-center justify-center active:scale-90 transition-transform ${emoji === current ? "bg-primary-container/20 ring-2 ring-primary-container" : ""}" data-emoji="${emoji}" aria-label="React ${emoji}" aria-pressed="${emoji === current}">${emoji}</button>`
                )
                .join("")}</div>`
            : ""
        }
        ${actions
          .map(
            (action) => `
          <button type="button" class="as-action w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left font-body-md text-body-md hover:bg-surface-container-low active:bg-surface-container ${action.danger ? "text-error" : "text-on-surface"}" data-key="${action.key}">
            <span class="material-symbols-outlined text-[22px]">${action.icon}</span> ${escapeHtml(action.label)}
          </button>`
          )
          .join("")}
        <button type="button" class="as-cancel w-full mt-2 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Cancel</button>
      </div>`;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === overlay) return close(null);
      const emoji = event.target.closest(".as-emoji");
      if (emoji) return close("react:" + emoji.dataset.emoji);
      const action = event.target.closest(".as-action");
      if (action) close(action.dataset.key);
    });
    overlay.querySelector(".as-cancel").addEventListener("click", () => close(null));
    document.body.appendChild(overlay);
  });
}

// Simple confirmation sheet. Resolves true (confirm) or false.
function confirmSheet({ title, text, confirmLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-5" role="dialog" aria-modal="true">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">${escapeHtml(title)}</h2>
        <p class="font-body-md text-body-md text-slate-muted mt-1">${escapeHtml(text)}</p>
        <div class="flex gap-2.5 mt-5">
          <button type="button" class="cs-cancel flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-95 transition-all">Cancel</button>
          <button type="button" class="cs-confirm flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-white bg-error active:scale-95 transition-all">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === overlay) close(false);
    });
    overlay.querySelector(".cs-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".cs-confirm").addEventListener("click", () => close(true));
    document.body.appendChild(overlay);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied");
  } catch (error) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      area.remove();
      showToast(ok ? "Copied" : "Could not copy");
    } catch (fallbackError) {
      showToast("Could not copy");
    }
  }
}

/* ---------------------------------------------------------------
   Photos in a message, quotes and forwarding
---------------------------------------------------------------- */
const MAX_PHOTOS = 4; // pictures per message

// The valid picture links of a message (older messages have only imageURL, newer ones may have images)
function photoUrlsOf(message) {
  if (!message || message.deleted === true) return [];
  let list = [];
  if (Array.isArray(message.images)) list = message.images;
  else if (message.images && typeof message.images === "object") list = Object.values(message.images);
  else if (message.imageURL) list = [message.imageURL];
  return list.filter((url) => typeof url === "string" && url.startsWith("https://")).slice(0, MAX_PHOTOS);
}

// What a reply stores about the message it answers
function replyPayload(message) {
  const payload = { id: message.id, from: message.from };
  if (message.text) payload.text = String(message.text).slice(0, 150);
  if (photoUrlsOf(message).length) payload.photo = true;
  return payload;
}

// "Forward to..." sheet. people = [{ uid, name, username, photoURL }]. onSend(uid) resolves true when it was sent.
function openForwardSheet({ people, preview, onSend }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 pb-5 flex flex-col" style="max-height:80vh;" role="dialog" aria-modal="true" aria-label="Forward to">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold px-1">Forward to</h2>
        <p class="px-1 mt-0.5 mb-3 text-[13px] text-slate-muted truncate">${escapeHtml(preview)}</p>
        <input type="search" class="fw-search w-full bg-surface-container rounded-xl px-4 py-2.5 text-[15px] outline-none mb-2" placeholder="Search people" autocomplete="off" />
        <div class="fw-list flex-1 overflow-y-auto min-h-0">
          ${
            people.length
              ? people
                  .map(
                    (person) => `
            <div class="fw-row flex items-center gap-3 px-1 py-2" data-search="${escapeHtml((person.name + " " + (person.username || "")).toLowerCase())}">
              ${avatarHtml(person.photoURL, "w-10 h-10")}
              <div class="min-w-0 flex-1">
                <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(person.name)}</div>
                ${person.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(person.username)}</div>` : ""}
              </div>
              <button type="button" class="fw-send px-4 py-1.5 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60" data-uid="${escapeHtml(person.uid)}">Send</button>
            </div>`
                  )
                  .join("")
              : `<p class="text-center text-slate-muted font-body-md text-body-md py-8">No one to forward to yet.</p>`
          }
        </div>
        <button type="button" class="fw-done w-full mt-3 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Done</button>
      </div>`;

    const close = () => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (event.target === overlay || event.target.closest(".fw-done")) return close();
      const button = event.target.closest(".fw-send");
      if (!button || button.disabled) return;
      button.disabled = true;
      button.textContent = "Sending...";
      const ok = await onSend(button.dataset.uid);
      button.textContent = ok ? "Sent" : "Retry";
      button.disabled = !!ok;
      if (ok) button.className = button.className.replace("bg-primary-container text-white", "bg-surface-container text-on-surface-variant");
    });
    overlay.querySelector(".fw-search").addEventListener("input", (event) => {
      const term = event.target.value.trim().toLowerCase();
      overlay.querySelectorAll(".fw-row").forEach((row) => {
        row.style.display = term && !row.dataset.search.includes(term) ? "none" : ""; // style, not [hidden]: the row has display:flex
      });
    });
    document.body.appendChild(overlay);
  });
}

/**
 * Sends one message from `me` to `otherUid` in one atomic update: the message itself, both inboxes and the
 * unread counter of the other person. `extra` adds fields to the message (e.g. the story it replies to).
 * Also used by story.js for story replies and reactions.
 */
export async function sendChatMessage(db, me, otherUid, text, extra = {}, previewText = text) {
  const chatId = chatIdFor(me, otherUid);
  const messageRef = push(ref(db, `chats/${chatId}/messages`));
  const preview = String(previewText).slice(0, 120);
  const now = serverTimestamp();

  await update(ref(db), {
    [`chats/${chatId}/members/${me}`]: true,
    [`chats/${chatId}/members/${otherUid}`]: true,
    [`chats/${chatId}/messages/${messageRef.key}`]: { from: me, text, createdAt: now, ...extra },

    [`userChats/${me}/${chatId}/with`]: otherUid,
    [`userChats/${me}/${chatId}/lastMessage`]: preview,
    [`userChats/${me}/${chatId}/lastFrom`]: me,
    [`userChats/${me}/${chatId}/lastAt`]: now,
    [`userChats/${me}/${chatId}/unread`]: 0,

    [`userChats/${otherUid}/${chatId}/with`]: me,
    [`userChats/${otherUid}/${chatId}/lastMessage`]: preview,
    [`userChats/${otherUid}/${chatId}/lastFrom`]: me,
    [`userChats/${otherUid}/${chatId}/lastAt`]: now,
    [`userChats/${otherUid}/${chatId}/unread`]: increment(1)
  });
  return messageRef.key;
}

// Profile photo with the green "active now" dot in the corner
function avatarWithStatus(photoURL, size, online, dot = "w-3.5 h-3.5") {
  return `<div class="relative flex-shrink-0">${avatarHtml(photoURL, size)}${
    online ? `<span class="absolute bottom-0 right-0 ${dot} rounded-full bg-online-emerald ring-2 ring-white" aria-label="Active now"></span>` : ""
  }</div>`;
}

/* ---------------------------------------------------------------
   "Delivered": when a message reaches this app (open on this phone), the sender is told.
   startPresence() starts it once after login, so it works on every screen, not only inside the chat.
---------------------------------------------------------------- */
function startDelivery(db, me) {
  const marked = new Map(); // chatId -> lastAt already acknowledged
  onValue(
    ref(db, `userChats/${me}`),
    (snap) => {
      const updates = {};
      snap.forEach((child) => {
        const value = child.val();
        if (!value || value.lastFrom === me || !value.lastAt) return;
        if (marked.get(child.key) === value.lastAt) return;
        marked.set(child.key, value.lastAt);
        updates[`chats/${child.key}/delivered/${me}`] = serverTimestamp();
      });
      if (Object.keys(updates).length) update(ref(db), updates).catch(() => {});
    },
    () => {} // no permission or no network: nothing is marked
  );
}

/* ---------------------------------------------------------------
   Online status. feed.js calls startPresence() once after login; it keeps presence/{myUid} up to date.
   The inbox and the conversation header read the presence of the people you follow.
---------------------------------------------------------------- */
let presenceStarted = false;
let showActiveStatus = true; // "Show my active status" (userSettings/{uid}/showActive); on by default

export function startPresence({ db, currentUser } = {}) {
  if (presenceStarted || !db || !currentUser) return;
  presenceStarted = true;
  startDelivery(db, currentUser.uid);

  const myRef = ref(db, `presence/${currentUser.uid}`);
  let connected = false;
  let settingKnown = false; // nothing is published before the saved setting is known, so a hidden status never flashes

  const goOnline = () => {
    // If the connection drops (app closed, no network) the server marks me offline by itself
    onDisconnect(myRef)
      .set({ online: false, lastSeen: serverTimestamp() })
      .then(() => set(myRef, { online: true, lastSeen: serverTimestamp() }))
      .catch(() => {});
  };
  const goOffline = () => set(myRef, { online: false, lastSeen: serverTimestamp() }).catch(() => {});

  // Status hidden: nothing about me is stored at all, so nobody sees "Active now" or "Active 5m ago"
  const hide = () => {
    onDisconnect(myRef).cancel().catch(() => {});
    set(myRef, null).catch(() => {});
  };

  const apply = () => {
    if (!connected || !settingKnown) return;
    if (!showActiveStatus) hide();
    else if (document.visibilityState === "visible") goOnline();
    else goOffline();
  };

  onValue(ref(db, ".info/connected"), (snap) => {
    connected = snap.val() === true;
    apply();
  }, () => {});

  // The setting itself (also changes live when it is switched on another device)
  onValue(
    ref(db, `userSettings/${currentUser.uid}/showActive`),
    (snap) => {
      showActiveStatus = snap.val() !== false;
      settingKnown = true;
      apply();
    },
    () => {
      settingKnown = true; // the setting cannot be read: keep the default (on)
      apply();
    }
  );

  // The app in the background does not count as online
  document.addEventListener("visibilitychange", () => {
    if (showActiveStatus) apply();
  });
  window.addEventListener("pagehide", () => {
    if (showActiveStatus) goOffline();
  });
}

// Chat settings (opened by the gear icon in the page header). More options are added here step by step.
function openChatSettings({ db, me, onChange }) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
  overlay.innerHTML = `
    <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[85vh] flex flex-col" role="dialog" aria-modal="true" aria-label="Chat settings">
      <div class="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-border">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Chat settings</h2>
        <button type="button" class="cs-close w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close">
          <span class="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>

      <div class="overflow-y-auto">
        <div class="px-5 pt-4 pb-1 font-label-md text-label-md text-slate-subtle uppercase tracking-wide">Privacy</div>

        <div class="flex items-start justify-between gap-4 px-5 py-3">
          <div class="min-w-0">
            <div class="font-label-lg text-label-lg text-on-surface">Show my active status</div>
            <p class="cs-note font-body-sm text-body-sm text-slate-muted mt-0.5"></p>
          </div>
          <button type="button" role="switch" aria-checked="true" aria-label="Show my active status" class="cs-switch relative flex-shrink-0 w-12 h-7 mt-0.5 rounded-full transition-colors disabled:opacity-60">
            <span class="cs-knob absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform"></span>
          </button>
        </div>
        <button type="button" class="cs-blocked w-full flex items-center justify-between gap-4 py-4 text-left border-t border-slate-border/70" aria-label="Blocked accounts">
          <div class="flex items-center gap-3.5 min-w-0">
            <div class="w-11 h-11 rounded-full bg-error-container text-error flex items-center justify-center flex-shrink-0">
              <span class="material-symbols-outlined text-[22px]">block</span>
            </div>
            <div class="min-w-0">
              <div class="font-label-lg text-label-lg text-on-surface">Blocked accounts</div>
              <p class="cs-blocked-note font-body-sm text-body-sm text-slate-muted mt-0.5"></p>
            </div>
          </div>
          <span class="material-symbols-outlined text-slate-subtle">chevron_right</span>
        </button>
        <div class="h-4"></div>
      </div>
    </div>`;

  const switchEl = overlay.querySelector(".cs-switch");
  const knobEl = overlay.querySelector(".cs-knob");
  const noteEl = overlay.querySelector(".cs-note");

  const paint = (on) => {
    switchEl.setAttribute("aria-checked", String(on));
    switchEl.className = `cs-switch relative flex-shrink-0 w-12 h-7 mt-0.5 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-online-emerald" : "bg-slate-border"}`;
    knobEl.style.transform = on ? "translateX(20px)" : "translateX(0)";
    noteEl.textContent = on
      ? "People you follow can see when you are active. Turn this off to hide it; you will then not see when others are active either."
      : "Hidden: nobody can see when you are active, and you cannot see when others are active.";
  };
  paint(showActiveStatus);

  switchEl.addEventListener("click", async () => {
    const next = !(switchEl.getAttribute("aria-checked") === "true");
    switchEl.disabled = true;
    paint(next);
    try {
      await set(ref(db, `userSettings/${me}/showActive`), next);
      showActiveStatus = next;
      onChange?.();
      showToast(next ? "Active status is on" : "Active status is hidden");
    } catch (error) {
      console.error("Chat settings:", error);
      paint(!next); // put the switch back
      showToast(error.code === "PERMISSION_DENIED" ? "Could not save: database rules block it" : "Could not save the setting");
    }
    switchEl.disabled = false;
  });

  // The saved value (it may differ from the default on this device)
  get(ref(db, `userSettings/${me}/showActive`))
    .then((snap) => {
      if (!overlay.isConnected) return;
      showActiveStatus = snap.val() !== false;
      paint(showActiveStatus);
    })
    .catch(() => {});

  const close = () => {
    stopWatchingBlocks();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === overlay || event.target.closest(".cs-close")) close();
  });
    // Blocked accounts: shows how many, opens the list
  const blockedNote = overlay.querySelector(".cs-blocked-note");
  const paintBlocked = () => {
    const count = getBlockedIds().length;
    blockedNote.textContent = count ? `${count} blocked` : "No blocked accounts";
  };
  paintBlocked();
  const stopWatchingBlocks = onBlocksChange(paintBlocked);
  overlay.querySelector(".cs-blocked").addEventListener("click", () => openBlockedAccounts({ db, me, onChange }));

document.body.appendChild(overlay);
}

// Choose how to delete a chat. Resolves "me" (only my side), "everyone" (both sides) or null.
function openDeleteChatSheet(name) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-5" role="dialog" aria-modal="true" aria-label="Delete chat">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Delete chat with ${escapeHtml(name)}?</h2>
        <p class="font-body-md text-body-md text-slate-muted mt-1 mb-4">Choose who the chat is deleted for.</p>

        <button type="button" class="dc-option w-full flex items-start gap-3.5 p-3.5 rounded-2xl border border-slate-border text-left hover:bg-surface-container-low active:scale-[.99] transition-all mb-2.5" data-key="me">
          <span class="w-10 h-10 rounded-full bg-surface-container text-on-surface flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined text-[22px]">person</span></span>
          <span class="min-w-0">
            <span class="block font-label-lg text-label-lg text-on-surface">Delete for me</span>
            <span class="block font-body-sm text-body-sm text-slate-muted mt-0.5">Removes this chat from your account only. ${escapeHtml(name)} keeps their copy.</span>
          </span>
        </button>

        <button type="button" class="dc-option w-full flex items-start gap-3.5 p-3.5 rounded-2xl border border-error/30 text-left hover:bg-error-container/30 active:scale-[.99] transition-all" data-key="everyone">
          <span class="w-10 h-10 rounded-full bg-error-container text-error flex items-center justify-center flex-shrink-0"><span class="material-symbols-outlined text-[22px]">delete_forever</span></span>
          <span class="min-w-0">
            <span class="block font-label-lg text-label-lg text-error">Delete for everyone</span>
            <span class="block font-body-sm text-body-sm text-slate-muted mt-0.5">Deletes the whole conversation and all its messages for both of you.</span>
          </span>
        </button>

        <button type="button" class="dc-cancel w-full mt-4 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Cancel</button>
      </div>`;

    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      const option = event.target.closest(".dc-option");
      if (option) return close(option.dataset.key);
      if (event.target === overlay || event.target.closest(".dc-cancel")) close(null);
    });
    document.body.appendChild(overlay);
  });
}

/**
 * Deletes a conversation.
 *   "me":       only my side - the chat leaves my inbox and its old messages stay hidden for me
 *               (chatClears/{me}/{chatId} remembers when); the other person keeps everything.
 *   "everyone": the whole conversation is removed for both people.
 */
async function deleteChat(db, me, otherUid, mode) {
  const chatId = chatIdFor(me, otherUid);

  if (mode === "everyone") {
    await update(ref(db), {
      [`chats/${chatId}`]: null,
      [`userChats/${me}/${chatId}`]: null,
      [`userChats/${otherUid}/${chatId}`]: null,
      [`chatClears/${me}/${chatId}`]: null
    });
    return;
  }

  await update(ref(db), {
    [`chatClears/${me}/${chatId}`]: serverTimestamp(),
    [`userChats/${me}/${chatId}`]: null
  });
}

/* ---------------------------------------------------------------
   View
---------------------------------------------------------------- */
/**
 * @param {HTMLElement} container
 * @param {object} ctx  { db, currentUser, openWithUid?, onOpenProfile?, setTitle?, setBack? }
 *   openWithUid: open the conversation with this person straight away.
 */
export async function mount(container, ctx = {}) {
  const { db, currentUser } = ctx;

  if (!db || !currentUser) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">Please log in to use chat.</p>`;
    return;
  }

  const me = currentUser.uid;
  container.innerHTML = `<div class="fz-chat flex-1 flex flex-col"></div>`;
  const root = container.querySelector(".fz-chat");

  // Asks how to delete (for me / for everyone), then deletes. Resolves true when the chat was deleted.
  const startDeleteChat = async (otherUid, name) => {
    const mode = await openDeleteChatSheet(name || "this person");
    if (!mode) return false;

    if (mode === "everyone") {
      const sure = await confirmSheet({
        title: "Delete for everyone?",
        text: `The whole conversation with ${name || "this person"} will be deleted for both of you. This cannot be undone.`,
        confirmLabel: "Delete for everyone"
      });
      if (!sure) return false;
    }

    try {
      await deleteChat(db, me, otherUid, mode);
    } catch (error) {
      console.error("Delete chat:", error);
      showToast(error.code === "PERMISSION_DENIED" ? "Could not delete: database rules block it" : "Could not delete the chat. Try again.");
      return false;
    }
    showToast(mode === "everyone" ? "Chat deleted for everyone" : "Chat deleted");
    return true;
  };

  let stopView = () => {}; // stops the realtime listeners of the current view
  let viewToken = 0; // a newer view replaces older async work

  const enterView = () => {
    stopView();
    stopView = () => {};
    return ++viewToken;
  };
  const stale = (token) => token !== viewToken || !root.isConnected;

  /* =============================================================
     INBOX
  ============================================================= */
  const showInbox = () => {
    const token = enterView();
    ctx.setTitle?.("Chat");
    ctx.setBack?.(null);
    ctx.setActions?.([{ icon: "settings", label: "Chat settings", onClick: () => openChatSettings({ db, me, onChange: showInbox }) }]);

    root.innerHTML = `
      <div class="px-3 sm:px-4 pt-3 pb-3 space-y-3">
        <div class="fz-active"></div>
        <div class="fz-convs space-y-2.5">${skeletonRows()}</div>
      </div>`;
    const activeEl = root.querySelector(".fz-active");
    const convsEl = root.querySelector(".fz-convs");

    let items = [];
    let loaded = false;
    const presence = new Map(); // uid -> { online, lastSeen } of the people I follow
    const unsubscribers = [];
    let paintTimer = null;

    const isOnline = (uid) => !!(presence.get(uid) && presence.get(uid).online === true);

    /* ---- the "Active now" strip: followed people who are online, at the top ---- */
    const paintActive = async () => {
      const online = [...presence.entries()]
        .filter(([, value]) => value && value.online === true)
        .sort((a, b) => (Number(b[1].lastSeen) || 0) - (Number(a[1].lastSeen) || 0))
        .map(([uid]) => uid);

      const users = await Promise.all(online.map((uid) => readUser(db, uid)));
      if (stale(token)) return;

      const people = online.map((uid, index) => ({ uid, user: users[index] })).filter((person) => person.user);
      if (!people.length) {
        activeEl.innerHTML = "";
        return;
      }

      activeEl.innerHTML = `
        <div class="bg-slate-surface border border-slate-border rounded-2xl shadow-sm py-3">
          <div class="flex items-center justify-between px-4 mb-2.5">
            <h3 class="font-label-lg text-label-lg text-on-surface">Active now</h3>
            <span class="inline-flex items-center gap-1.5 text-[12px] text-online-emerald font-semibold">
              <span class="w-2 h-2 rounded-full bg-online-emerald"></span>${people.length} online
            </span>
          </div>
          <div class="flex gap-3.5 overflow-x-auto px-4 [&::-webkit-scrollbar]:hidden" style="scrollbar-width:none;">
            ${people
              .map(
                ({ uid, user }) => `
              <button type="button" class="fz-active-item flex-shrink-0 w-[64px] flex flex-col items-center gap-1.5 active:scale-95 transition-transform" data-uid="${escapeHtml(uid)}" aria-label="Message ${escapeHtml(user.name)}, active now">
                ${avatarWithStatus(user.photoURL, "w-14 h-14", true, "w-4 h-4")}
                <span class="w-full text-center text-[12px] text-on-surface truncate">${escapeHtml(user.username || user.name.split(" ")[0])}</span>
              </button>`
              )
              .join("")}
          </div>
        </div>`;
    };

    /* ---- the conversations ---- */
    const paintConversations = () => {
      if (!loaded) return;

      const visible = items.filter((item) => !isBlocked(item.with)); // blocked people's chats are hidden

      if (!visible.length) {
        convsEl.innerHTML = emptyState("chat_bubble", "No messages yet", "Open a profile or your Friends list and tap Message to start a conversation.");
        return;
      }

      convsEl.innerHTML = visible
        .map((item) => {
          const user = item.user || { name: "FreeZone User", username: "", photoURL: "" };
          const unread = Number(item.unread) || 0;
          return `
          <div role="button" tabindex="0" class="fz-conv w-full flex items-center gap-3 pl-4 pr-2 py-3 bg-slate-surface rounded-2xl border border-slate-border active:bg-surface-container-low text-left cursor-pointer" data-uid="${escapeHtml(item.with)}">
            ${avatarWithStatus(user.photoURL, "w-12 h-12", isOnline(item.with))}
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline justify-between gap-2">
                <span class="font-label-lg text-label-lg text-on-surface truncate ${unread ? "font-bold" : ""}">${escapeHtml(user.name)}</span>
                <span class="flex-shrink-0 text-[12px] ${unread ? "text-primary font-semibold" : "text-slate-subtle"}">${inboxTime(Number(item.lastAt))}</span>
              </div>
              <div class="flex items-center justify-between gap-2 mt-0.5">
                <span class="font-body-sm text-body-sm truncate ${unread ? "text-on-surface font-medium" : "text-slate-muted"}">${item.lastFrom === me ? "You: " : ""}${escapeHtml(item.lastMessage)}</span>
                ${unread ? `<span class="flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-primary-container text-white text-[11px] font-bold flex items-center justify-center">${unread > 99 ? "99+" : unread}</span>` : ""}
              </div>
            </div>
            <button type="button" class="fz-conv-menu flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-subtle hover:bg-surface-container" aria-label="Chat options" data-uid="${escapeHtml(item.with)}">
              <span class="material-symbols-outlined text-[20px] pointer-events-none">more_vert</span>
            </button>
          </div>`;
        })
        .join("");
    };

    const schedulePaint = () => {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => {
        paintActive();
        paintConversations();
      }, 120);
    };

    /* ---- listeners ---- */
    const unsubscribeChats = onValue(
      ref(db, `userChats/${me}`),
      async (snap) => {
        if (stale(token)) return unsubscribeChats();

        const list = [];
        snap.forEach((child) => {
          const value = child.val();
          if (value && value.with && value.lastMessage) list.push({ id: child.key, ...value });
        });
        list.sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0));

        await Promise.all(list.map(async (item) => (item.user = await readUser(db, item.with))));
        if (stale(token)) return;

        items = list;
        loaded = true;
        paintConversations();
      },
      (error) => {
        console.error("Chat inbox:", error);
        if (stale(token)) return;
        convsEl.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-16 px-6">Could not load your messages.</p>`;
      }
    );
    unsubscribers.push(unsubscribeChats);
    unsubscribers.push(
      onBlocksChange(() => {
        paintConversations();
        paintActive();
      })
    );

    // ⋮ on a chat: delete it
    convsEl.addEventListener("click", async (event) => {
      const menuBtn = event.target.closest(".fz-conv-menu");
      if (!menuBtn) return;
      event.stopPropagation(); // do not open the conversation
      const item = items.find((entry) => entry.with === menuBtn.dataset.uid);
      const choice = await openActionMenu([{ key: "delete", label: "Delete chat", icon: "delete", danger: true }]);
      if (choice === "delete") await startDeleteChat(menuBtn.dataset.uid, item && item.user ? item.user.name : "");
    });

    // Online status of the people I follow (only followers of a person can read their status).
    // With "Show my active status" off, others are not shown either.
    (async () => {
      if (!showActiveStatus) return;
      let ids = Object.keys(ctx.followingIds || {});
      if (!ids.length) {
        try {
          const snap = await get(ref(db, `following/${me}`));
          if (snap.exists()) ids = Object.keys(snap.val());
        } catch (error) {
          // no following list: no "Active now" strip
        }
      }
      if (stale(token)) return;

      ids
        .filter((uid) => uid !== me)
        .slice(0, MAX_PRESENCE_WATCH)
        .forEach((uid) => {
          const unsubscribe = onValue(
            ref(db, `presence/${uid}`),
            (snap) => {
              presence.set(uid, snap.exists() ? snap.val() : null);
              if (!stale(token)) schedulePaint();
            },
            () => {} // no permission: this person's status is simply not shown
          );
          unsubscribers.push(unsubscribe);
        });
    })();

    stopView = () => {
      clearTimeout(paintTimer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  };

  root.addEventListener("click", (event) => {
    const row = event.target.closest(".fz-conv, .fz-active-item");
    if (row) showConversation(row.dataset.uid, { fromInbox: true });
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.target.closest(".fz-conv-menu")) return;
    const row = event.target.closest(".fz-conv");
    if (row) showConversation(row.dataset.uid, { fromInbox: true });
  });

  /* =============================================================
     CONVERSATION
  ============================================================= */
  const showConversation = async (otherUid, { fromInbox = false } = {}) => {
    if (!otherUid || otherUid === me) return;
    const token = enterView();
    const chatId = chatIdFor(me, otherUid);

    if (fromInbox) ctx.setBack?.(() => showInbox());
    ctx.setActions?.([]); // the settings gear belongs to the inbox only
    ctx.setTitle?.("Chat");
    root.innerHTML = `<div class="px-3 sm:px-4 py-3 space-y-2.5">${skeletonRows(3)}</div>`;

    const other = await readUser(db, otherUid);
    if (stale(token)) return;

    if (!other) {
      root.innerHTML = emptyState("person_off", "User not available", "This account could not be found.");
      return;
    }
    ctx.setTitle?.(other.name);

    // I blocked this person: no messages, only a way to unblock
    if (isBlocked(otherUid)) {
      ctx.setActions?.([
        {
          icon: "more_vert",
          label: "More options",
          onClick: async () => {
            const choice = await openActionMenu([{ key: "delete", label: "Delete chat", icon: "delete", danger: true }]);
            if (choice === "delete" && (await startDeleteChat(otherUid, other.name)) && !stale(token)) showInbox();
          }
        }
      ]);
      root.innerHTML = `
        <div class="text-center py-16 px-6">
          <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-error-container text-error flex items-center justify-center">
            <span class="material-symbols-outlined text-[30px]">block</span>
          </div>
          <p class="font-headline-sm text-headline-sm text-on-surface font-semibold mb-1">You blocked ${escapeHtml(other.username ? "@" + other.username : other.name)}</p>
          <p class="font-body-md text-body-md text-slate-muted max-w-xs mx-auto mb-5">You cannot message each other while the account is blocked.</p>
          <button type="button" class="fz-unblock px-6 py-2.5 rounded-full bg-primary-container text-white font-label-lg text-label-lg font-semibold active:scale-95 transition-all disabled:opacity-60">Unblock</button>
        </div>`;
      root.querySelector(".fz-unblock").addEventListener("click", async (event) => {
        event.currentTarget.disabled = true;
        const ok = await unblockAccount({ db, me, uid: otherUid, name: other.name });
        if (ok && !stale(token)) showConversation(otherUid, { fromInbox });
        else if (!ok) event.currentTarget.disabled = false;
      });
      return;
    }

    root.innerHTML = `
      <div class="fz-head sticky top-0 z-10 bg-background/95 backdrop-blur px-4 py-2.5 border-b border-slate-border/60 flex items-center gap-3 cursor-pointer">
        <div class="relative flex-shrink-0">
          ${avatarHtml(other.photoURL, "w-10 h-10")}
          <span class="fz-dot hidden absolute bottom-0 right-0 w-3 h-3 rounded-full bg-online-emerald ring-2 ring-white" aria-label="Active now"></span>
        </div>
        <div class="min-w-0">
          <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(other.name)}</div>
          <div class="fz-status font-body-sm text-body-sm text-slate-muted truncate">${other.username ? "@" + escapeHtml(other.username) : ""}</div>
        </div>
      </div>

      <div class="fz-messages flex-1 px-3 sm:px-4 py-3"></div>
      <div class="fz-typing hidden px-4 pb-2" aria-live="polite">
        <span class="inline-flex items-center gap-1 rounded-2xl rounded-bl-md bg-slate-surface border border-slate-border px-3.5 py-2.5" aria-label="${escapeHtml(other.name)} is typing">
          <span class="w-1.5 h-1.5 rounded-full bg-slate-subtle animate-bounce" style="animation-delay:0ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-slate-subtle animate-bounce" style="animation-delay:150ms"></span>
          <span class="w-1.5 h-1.5 rounded-full bg-slate-subtle animate-bounce" style="animation-delay:300ms"></span>
        </span>
      </div>

      <div class="sticky bottom-0 z-10 bg-background/95 backdrop-blur border-t border-slate-border/60">
        <div class="fz-editbar hidden items-center justify-between gap-2 px-4 pt-2.5 text-[13px] text-primary font-semibold">
          <span class="flex items-center gap-1.5 min-w-0"><span class="material-symbols-outlined text-[18px]">edit</span><span class="truncate">Editing message</span></span>
          <button type="button" class="fz-edit-cancel w-7 h-7 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Cancel editing">
            <span class="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>
        <div class="fz-replybar hidden items-center gap-2 px-4 pt-2.5">
          <span class="material-symbols-outlined text-[20px] text-primary">reply</span>
          <div class="min-w-0 flex-1 border-l-4 border-primary-container pl-2.5">
            <div class="fz-reply-name text-[12.5px] font-semibold text-primary truncate"></div>
            <div class="fz-reply-text text-[13px] text-slate-muted truncate"></div>
          </div>
          <button type="button" class="fz-reply-cancel w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Cancel reply"><span class="material-symbols-outlined text-[20px]">close</span></button>
        </div>
        <div class="fz-attachbar hidden items-center gap-3 px-4 pt-2.5">
          <div class="fz-attach-list flex items-center gap-2 flex-shrink-0 max-w-[60%] overflow-x-auto"></div>
          <div class="min-w-0 flex-1 text-[13px] text-slate-muted truncate fz-attach-note">Photo ready to send</div>
          <button type="button" class="fz-attach-remove w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Remove photos"><span class="material-symbols-outlined text-[20px]">close</span></button>
        </div>
        <div class="px-3 py-2.5 flex items-end gap-2">
          <button type="button" class="fz-attach flex-shrink-0 w-11 h-11 rounded-full text-primary flex items-center justify-center hover:bg-surface-container active:scale-90 transition-all" aria-label="Send photos"><span class="material-symbols-outlined text-[24px]">image</span></button>
          <input type="file" class="fz-file" accept="image/*" multiple hidden />
          <textarea class="fz-input flex-1 resize-none bg-slate-surface border border-slate-border focus:border-primary-container focus:ring-2 focus:ring-primary-container/15 rounded-2xl px-4 py-2.5 text-[16px] leading-snug outline-none max-h-[120px]" rows="1" maxlength="${MESSAGE_MAX}" placeholder="Message ${escapeHtml(other.name.split(" ")[0])}..."></textarea>
          <button type="button" class="fz-send flex-shrink-0 w-11 h-11 rounded-full bg-primary-container text-white flex items-center justify-center shadow-md shadow-primary-container/30 active:scale-90 transition-all disabled:opacity-40" aria-label="Send" disabled>
            <span class="fz-send-icon material-symbols-outlined text-[22px]" style="font-variation-settings:'FILL' 1;">send</span>
          </button>
        </div>
      </div>
    `;

    const messagesEl = root.querySelector(".fz-messages");
    const inputEl = root.querySelector(".fz-input");
    const sendBtn = root.querySelector(".fz-send");

    root.querySelector(".fz-head").addEventListener("click", () => ctx.onOpenProfile?.(otherUid));

    const callOther = { uid: otherUid, name: other.name, photoURL: other.photoURL };
    ctx.setActions?.([
      { icon: "call", label: "Voice call", onClick: () => startCall({ db, me, other: callOther, video: false }) },
      { icon: "videocam", label: "Video call", onClick: () => startCall({ db, me, other: callOther, video: true }) },
      {
        icon: "more_vert",
        label: "More options",
        onClick: async () => {
          const handle = other.username ? `@${other.username}` : other.name;
          const choice = await openActionMenu([
            { key: "delete", label: "Delete chat", icon: "delete", danger: true },
            { key: "block", label: `Block ${handle}`, icon: "block", danger: true }
          ]);

          if (choice === "delete") {
            if ((await startDeleteChat(otherUid, other.name)) && !stale(token)) showInbox();
          } else if (choice === "block") {
            const ok = await blockAccount({ db, me, user: { uid: otherUid, name: other.name, username: other.username }, followingIds: ctx.followingIds || {} });
            if (ok && !stale(token)) showInbox();
          }
        }
      }
    ]);

    // Green dot and "Active now" / "Active 5m ago" (only visible if you follow this person); "typing..." wins while they type
    const dotEl = root.querySelector(".fz-dot");
    const statusEl = root.querySelector(".fz-status");
    const typingEl = root.querySelector(".fz-typing");
    const plainStatus = other.username ? `@${other.username}` : "";
    let presenceValue = null;
    let typingNow = false;
    const paintStatus = () => {
      const online = !!(presenceValue && presenceValue.online === true);
      dotEl.classList.toggle("hidden", !online);
      if (typingNow) {
        statusEl.textContent = "typing...";
        statusEl.className = "fz-status font-body-sm text-body-sm text-online-emerald font-semibold truncate";
      } else if (online) {
        statusEl.textContent = "Active now";
        statusEl.className = "fz-status font-body-sm text-body-sm text-online-emerald font-semibold truncate";
      } else {
        statusEl.textContent = presenceValue && Number(presenceValue.lastSeen) ? `Active ${timeAgo(Number(presenceValue.lastSeen))}` : plainStatus;
        statusEl.className = "fz-status font-body-sm text-body-sm text-slate-muted truncate";
      }
    };
    const unsubscribePresence = !showActiveStatus ? () => {} : onValue(
      ref(db, `presence/${otherUid}`),
      (snap) => {
        if (stale(token)) return unsubscribePresence();
        presenceValue = snap.exists() ? snap.val() : null;
        paintStatus();
      },
      () => {} // no permission: only the @username is shown
    );

    /* ---- rendering ---- */
    let limit = PAGE;
    let currentMessages = []; // what is on screen now
    let hasMore = false; // there may be earlier messages to load
    let otherReadAt = 0; // when the other person last read this chat
    let otherDeliveredAt = 0; // when a message last reached the other person's app
    let replyingTo = null; // the message I am answering: { id, from, text, photo }
    let editing = null; // the message being edited: { id, from, text, createdAt }
    let saveEdit = async () => {}; // set below, used by send()
    let firstRender = true;
    let lastMarkedId = "";
    let keepScrollFrom = null; // scrollHeight before "Load earlier"

    const scrollToBottom = () => {
      container.scrollTop = container.scrollHeight;
    };

    // Marks the chat as read: clears the unread counter and tells the other person "Seen"
    const markRead = () => {
      const newest = currentMessages[currentMessages.length - 1];
      if (!newest || newest.from === me || newest.id === lastMarkedId) return;
      if (document.visibilityState !== "visible") return; // only when the person can really see it
      lastMarkedId = newest.id;
      update(ref(db), {
        [`userChats/${me}/${chatId}/unread`]: 0,
        [`chats/${chatId}/reads/${me}`]: serverTimestamp()
      }).catch(() => {});
    };

    const renderMessages = (messages, mayHaveMore) => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
      const last = messages[messages.length - 1];
      currentMessages = messages;
      hasMore = mayHaveMore;
      const lastMineIndex = messages.reduce((found, m, i) => (m.from === me && !m.deleted ? i : found), -1);

      let html = mayHaveMore
        ? `<div class="text-center mb-3"><button type="button" class="fz-earlier px-4 py-1.5 rounded-full bg-surface-container text-on-surface-variant font-label-md text-label-md font-semibold">Load earlier messages</button></div>`
        : "";

      if (!messages.length) {
        html += `<p class="text-center text-slate-muted font-body-md text-body-md py-10">No messages yet. Say hello to ${escapeHtml(other.name)}.</p>`;
      }

      let currentDay = "";
      messages.forEach((message, index) => {
        const time = Number(message.createdAt) || Date.now();
        const day = new Date(time).toDateString();
        if (day !== currentDay) {
          currentDay = day;
          html += `<div class="text-center my-3"><span class="px-3 py-1 rounded-full bg-surface-container text-slate-muted text-[12px] font-medium">${dayLabel(time)}</span></div>`;
        }

        const mine = message.from === me;
        const deleted = message.deleted === true;
        const edited = !deleted && !!message.editedAt;
        const next = messages[index + 1];
        const nextTime = next ? Number(next.createdAt) || Date.now() : 0;
        const groupedWithNext = next && next.from === message.from && new Date(nextTime).toDateString() === day && nextTime - time < GROUP_MS;
        const isLastMine = index === lastMineIndex;
        const showMeta = !groupedWithNext || edited || isLastMine;
        const status = isLastMine ? (otherReadAt >= time ? `<span class="text-primary font-semibold">Seen</span>` : otherDeliveredAt >= time ? "Delivered" : "Sent") : "";

        // A reply or reaction to a story shows the story picture above the text
        const story = !deleted && message.story && message.story.imageURL ? message.story : null;
        const isReaction = !deleted && message.reaction === true;
        const storyLabel = story
          ? isReaction
            ? mine ? "You reacted to their story" : "Reacted to your story"
            : mine ? "You replied to their story" : "Replied to your story"
          : "";
        const storyHtml = story
          ? `<span class="flex items-center gap-2 mb-1.5"><img src="${escapeHtml(story.imageURL)}" alt="" class="w-9 h-12 rounded-md object-cover flex-shrink-0 bg-black/10" onerror="this.remove()" /><span class="text-[12px] ${mine && !isReaction ? "text-white/80" : "text-slate-muted"}">${storyLabel}</span></span>`
          : "";
        const photos = photoUrlsOf(message);
        const hasPhotos = photos.length > 0;
        const moreBtn = `<button type="button" class="fz-img-more absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-black/45 text-white flex items-center justify-center" aria-label="Message options" data-more="${escapeHtml(message.id)}"><span class="material-symbols-outlined text-[18px]">more_horiz</span></button>`;
        const tile = (url, i, style) => `<img src="${escapeHtml(url)}" alt="Photo ${i + 1}" class="fz-chat-img cursor-zoom-in" data-pi="${i}" loading="lazy" style="display:block;width:100%;object-fit:cover;${style}" onerror="this.style.visibility='hidden'" />`;
        const ratio = message.imgW > 0 && message.imgH > 0 ? Math.min(Math.max(message.imgW / message.imgH, 0.5), 2) : 1;
        let photoHtml = "";
        if (photos.length === 1) {
          photoHtml = `<span class="relative block overflow-hidden rounded-xl bg-black/10" style="width:min(240px,62vw);aspect-ratio:${ratio.toFixed(3)};"><img src="${escapeHtml(photos[0])}" alt="Photo" class="fz-chat-img w-full h-full object-cover cursor-zoom-in" data-pi="0" loading="lazy" onerror="this.parentNode.classList.add('flex','items-center','justify-center');this.replaceWith('Photo unavailable')" />${moreBtn}</span>`;
        } else if (photos.length > 1) {
          photoHtml = `<span class="relative block overflow-hidden rounded-xl bg-black/10" style="width:min(260px,66vw);"><span class="grid" style="grid-template-columns:1fr 1fr;gap:2px;">${photos
            .map((url, i) => tile(url, i, photos.length === 3 && i === 0 ? "grid-column:1 / 3;aspect-ratio:2 / 1;" : "aspect-ratio:1 / 1;"))
            .join("")}</span>${moreBtn}</span>`;
        }
        const captionHtml = hasPhotos ? (message.text ? `<span class="block px-2.5 pt-1.5 pb-1">${escapeHtml(message.text)}</span>` : "") : "";

        // "Forwarded" label and the quoted message of a reply (tap the quote to jump to the original)
        const forwardedHtml = !deleted && message.forwarded === true
          ? `<span class="flex items-center gap-1 text-[11.5px] italic mb-1 ${mine ? "text-white/80" : "text-slate-muted"}${hasPhotos ? " px-2 pt-1" : ""}"><span class="material-symbols-outlined text-[14px]">forward</span>Forwarded</span>`
          : "";
        let quoteHtml = "";
        if (!deleted && message.replyTo && message.replyTo.id) {
          const reply = message.replyTo;
          const original = messages.find((m) => m.id === reply.id);
          const gone = !!original && original.deleted === true;
          const who = reply.from === me ? "You" : other.name;
          const snippet = gone ? "Message deleted" : `${reply.photo ? "📷 " : ""}${reply.text || (reply.photo ? "Photo" : "")}`;
          quoteHtml = `<span class="fz-quote block rounded-lg px-2.5 py-1.5 mb-1.5 text-[12.5px] leading-snug border-l-4 cursor-pointer ${hasPhotos ? "mx-1 mt-1 " : ""}${mine ? "bg-white/15 border-white/70 text-white/90" : "bg-surface-container border-primary-container text-on-surface-variant"}" data-goto="${escapeHtml(reply.id)}"><span class="block font-semibold truncate">${escapeHtml(who)}</span><span class="block truncate ${gone ? "italic" : ""}">${escapeHtml(snippet)}</span></span>`;
        }

        const contentHtml = deleted
          ? "This message was deleted"
          : hasPhotos
            ? `${forwardedHtml}${quoteHtml}${photoHtml}${captionHtml}`
            : `${forwardedHtml}${quoteHtml}${storyHtml}${isReaction ? `<span class="text-[34px] leading-none">${escapeHtml(message.text)}</span>` : escapeHtml(message.text)}`;

        const bubbleClass = deleted
          ? "border border-dashed border-slate-border text-slate-subtle italic"
          : isReaction
            ? "bg-slate-surface border border-slate-border text-on-surface cursor-pointer"
            : mine
            ? "bg-primary-container text-white rounded-br-md cursor-pointer"
            : "bg-slate-surface border border-slate-border text-on-surface rounded-bl-md cursor-pointer";

        // Emoji reactions: a small pill under the bubble (tap it to take back my own reaction)
        const reactionMap = !deleted && message.reactions && typeof message.reactions === "object" ? message.reactions : {};
        const reactionList = Object.values(reactionMap).filter((emoji) => typeof emoji === "string" && emoji);
        const iReacted = typeof reactionMap[me] === "string" && reactionMap[me] !== "";
        const reactionPill = reactionList.length
          ? `<button type="button" class="fz-react-pill relative z-[1] -mt-2.5 ${mine ? "mr-2" : "ml-2"} inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-slate-surface border ${iReacted ? "border-primary-container" : "border-slate-border"} shadow-sm text-[14px] leading-none" data-react="${escapeHtml(message.id)}" aria-label="Reactions: ${escapeHtml([...new Set(reactionList)].join(" "))}">${[...new Set(reactionList)].join("")}${reactionList.length > 1 ? `<span class="text-[11px] text-slate-muted font-semibold ml-0.5">${reactionList.length}</span>` : ""}</button>`
          : "";

        html += `
          <div class="flex ${mine ? "justify-end" : "justify-start"} ${groupedWithNext ? "mb-0.5" : "mb-2.5"}">
            <div class="max-w-[80%] flex flex-col ${mine ? "items-end" : "items-start"}">
              <div class="fz-bubble ${hasPhotos ? "p-1" : "px-3.5 py-2"} rounded-2xl font-body-md text-body-md whitespace-pre-wrap break-words ${bubbleClass}" ${deleted ? "" : `data-mid="${escapeHtml(message.id)}"`}>${contentHtml}</div>
              ${reactionPill}
              ${showMeta ? `<span class="text-[11px] text-slate-subtle mt-1 px-1">${timeOf(time)}${edited ? " · edited" : ""}${status ? ` · ${status}` : ""}</span>` : ""}
            </div>
          </div>`;
      });

      messagesEl.innerHTML = html;

      if (keepScrollFrom !== null) {
        container.scrollTop = container.scrollHeight - keepScrollFrom; // stay where the person was reading
        keepScrollFrom = null;
      } else if (firstRender || nearBottom || (last && last.from === me)) {
        scrollToBottom();
      }
      firstRender = false;

      markRead(); // opening the chat, or a message arriving while it is open
    };

    /* ---- realtime messages ---- */
    let unsubscribe = () => {};
    const subscribe = () => {
      unsubscribe();
      unsubscribe = onValue(
        query(ref(db, `chats/${chatId}/messages`), limitToLast(limit)),
        (snap) => {
          if (stale(token)) return unsubscribe();
          const raw = [];
          snap.forEach((child) => {
            raw.push({ id: child.key, ...child.val() });
          });

          // Messages from before "Delete for me" stay hidden
          const timeOf = (message) => Number(message.createdAt) || Date.now();
          const messages = raw.filter((message) => timeOf(message) > clearedAt);
          renderMessages(messages, raw.length >= limit && raw.length > 0 && timeOf(raw[0]) > clearedAt);
        },
        (error) => {
          console.error("Chat messages:", error);
          if (stale(token)) return;
          messagesEl.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Could not load messages. Check your connection and database rules.</p>`;
        }
      );
    };
    // When did I last "Delete for me" this chat? Older messages are not shown.
    let clearedAt = 0;
    try {
      const clearSnap = await get(ref(db, `chatClears/${me}/${chatId}`));
      clearedAt = clearSnap.exists() ? Number(clearSnap.val()) || 0 : 0;
    } catch (error) {
      // no marker: show everything
    }
    if (stale(token)) return;

    subscribe();

    // "Seen": when the other person last read the chat
    const unsubscribeReads = onValue(
      ref(db, `chats/${chatId}/reads/${otherUid}`),
      (snap) => {
        if (stale(token)) return unsubscribeReads();
        otherReadAt = Number(snap.val()) || 0;
        renderMessages(currentMessages, hasMore);
      },
      () => {} // no permission: the mark simply stays "Sent"
    );

    // "Delivered": the other person's app received a message
    const unsubscribeDelivered = onValue(
      ref(db, `chats/${chatId}/delivered/${otherUid}`),
      (snap) => {
        if (stale(token)) return unsubscribeDelivered();
        otherDeliveredAt = Number(snap.val()) || 0;
        renderMessages(currentMessages, hasMore);
      },
      () => {} // no permission: the mark stays "Sent"
    );

    // "typing...": the other person is writing to me right now
    const unsubscribeTyping = onValue(
      ref(db, `chats/${chatId}/typing/${otherUid}`),
      (snap) => {
        if (stale(token)) return unsubscribeTyping();
        const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
        typingNow = snap.val() === true;
        typingEl.classList.toggle("hidden", !typingNow);
        paintStatus();
        if (typingNow && nearBottom) scrollToBottom();
      },
      () => {}
    );

    // My own typing mark: set while I write, removed after a pause, on send, and when the connection drops
    const typingRef = ref(db, `chats/${chatId}/typing/${me}`);
    let typingOn = false;
    let typingTimer = null;
    const setTyping = (on) => {
      clearTimeout(typingTimer);
      if (on === typingOn) {
        if (on) typingTimer = setTimeout(() => setTyping(false), 3500);
        return;
      }
      typingOn = on;
      if (on) {
        onDisconnect(typingRef).remove().catch(() => {});
        set(typingRef, true).catch(() => {});
        typingTimer = setTimeout(() => setTyping(false), 3500);
      } else {
        set(typingRef, null).catch(() => {});
      }
    };

    // Coming back to the app with the chat open counts as reading it
    const onVisible = () => {
      if (!stale(token)) markRead();
    };
    document.addEventListener("visibilitychange", onVisible);

    stopView = () => {
      setTyping(false);
      unsubscribe();
      unsubscribeReads();
      unsubscribeDelivered();
      unsubscribeTyping();
      unsubscribePresence();
      document.removeEventListener("visibilitychange", onVisible);
    };

    messagesEl.addEventListener("click", (event) => {
      if (!event.target.closest(".fz-earlier")) return;
      keepScrollFrom = container.scrollHeight - container.scrollTop;
      limit += PAGE;
      subscribe();
    });

    /* ---- sending ---- */
    const autosize = () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
      sendBtn.disabled = uploading || !(inputEl.value.trim() || pendingImages.length);
    };
    inputEl.addEventListener("input", () => {
      autosize();
      if (showActiveStatus && !editing && inputEl.value.trim()) setTyping(true);
      else setTyping(false);
    });

    const canEnterSend = window.matchMedia && window.matchMedia("(pointer: fine)").matches; // Enter sends on computers only
    inputEl.addEventListener("keydown", (event) => {
      if (canEnterSend && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });

    /* ---- sending photos (up to 4 together) ---- */
    const attachBtn = root.querySelector(".fz-attach");
    const fileInput = root.querySelector(".fz-file");
    const attachBar = root.querySelector(".fz-attachbar");
    const attachList = root.querySelector(".fz-attach-list");
    const attachNote = root.querySelector(".fz-attach-note");
    let pendingImages = []; // [{ blob, url, w, h }]
    let uploading = false;
    let uploadAbort = null;
    let uploadNote = "";

    const paintAttach = () => {
      const has = pendingImages.length > 0;
      attachBar.classList.toggle("hidden", !has);
      attachBar.classList.toggle("flex", has);
      attachList.innerHTML = pendingImages
        .map(
          (image, i) => `
        <div class="relative w-14 h-14 flex-shrink-0 rounded-xl overflow-hidden bg-surface-container">
          <img src="${image.url}" alt="Photo ${i + 1}" class="w-full h-full object-cover ${uploading ? "opacity-60" : ""}" />
          ${uploading ? "" : `<button type="button" class="fz-attach-x absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center" data-i="${i}" aria-label="Remove photo ${i + 1}"><span class="material-symbols-outlined text-[14px]">close</span></button>`}
        </div>`
        )
        .join("");
      attachNote.textContent = uploading ? uploadNote : pendingImages.length > 1 ? `${pendingImages.length} photos ready to send` : "Photo ready to send";
      autosize();
    };

    const clearPending = () => {
      pendingImages.forEach((image) => image.url && URL.revokeObjectURL(image.url));
      pendingImages = [];
      paintAttach();
    };

    attachBtn.addEventListener("click", () => {
      if (editing || uploading) return;
      if (pendingImages.length >= MAX_PHOTOS) return showToast(`Up to ${MAX_PHOTOS} photos at a time`);
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      if (!files.length) return;
      const room = MAX_PHOTOS - pendingImages.length;
      if (files.length > room) showToast(`Up to ${MAX_PHOTOS} photos at a time`);
      attachBtn.disabled = true;
      try {
        for (const file of files.slice(0, Math.max(room, 0))) {
          if (!file.type.startsWith("image/")) {
            showToast("Please choose pictures only");
            continue;
          }
          if (file.size > 25 * 1024 * 1024) {
            showToast("A picture is too large (25 MB max)");
            continue;
          }
          try {
            const blob = await prepareImage(file, 1280, 0.85);
            let w = 0;
            let h = 0;
            try {
              const bitmap = await createImageBitmap(blob);
              w = bitmap.width;
              h = bitmap.height;
              bitmap.close?.();
            } catch (error) {
              /* the size is only used to reserve space */
            }
            pendingImages.push({ blob, url: URL.createObjectURL(blob), w, h });
            paintAttach();
          } catch (error) {
            console.error("Chat photo:", error);
            showToast(error && error.message ? error.message : "Could not open a picture");
          }
        }
        inputEl.focus();
      } finally {
        attachBtn.disabled = false;
      }
    });
    attachList.addEventListener("click", (event) => {
      const button = event.target.closest(".fz-attach-x");
      if (!button || uploading) return;
      const [removed] = pendingImages.splice(Number(button.dataset.i), 1);
      if (removed && removed.url) URL.revokeObjectURL(removed.url);
      paintAttach();
    });
    root.querySelector(".fz-attach-remove").addEventListener("click", () => {
      if (uploading && uploadAbort) uploadAbort.abort(); // cancel the upload
      else clearPending();
    });

    /* ---- replying to a message ---- */
    const replyBar = root.querySelector(".fz-replybar");
    const replyName = root.querySelector(".fz-reply-name");
    const replyText = root.querySelector(".fz-reply-text");
    const setReply = (message) => {
      replyingTo = message ? { id: message.id, from: message.from, text: message.text || "", photo: photoUrlsOf(message).length > 0 } : null;
      replyBar.classList.toggle("hidden", !message);
      replyBar.classList.toggle("flex", !!message);
      if (message) {
        replyName.textContent = message.from === me ? "You" : other.name;
        replyText.textContent = `${replyingTo.photo ? "📷 " : ""}${replyingTo.text || (replyingTo.photo ? "Photo" : "")}`;
        inputEl.focus();
      }
    };
    root.querySelector(".fz-reply-cancel").addEventListener("click", () => setReply(null));
    // What goes into the new message when I am answering one
    const replyExtra = () => (replyingTo ? { replyTo: replyPayload(replyingTo) } : {});

    async function sendPhotos(text) {
      const images = pendingImages.slice();
      uploading = true;
      uploadAbort = new AbortController();
      uploadNote = images.length > 1 ? `Sending photo 1 of ${images.length}...` : "Sending photo... 0%";
      paintAttach();
      try {
        const urls = [];
        for (let i = 0; i < images.length; i++) {
          const label = images.length > 1 ? `Sending photo ${i + 1} of ${images.length}` : "Sending photo";
          const url = await uploadToImgbb(images[i].blob, "chat.jpg", {
            signal: uploadAbort.signal,
            onProgress: (fraction) => {
              uploadNote = `${label}... ${Math.round(fraction * 100)}%`;
              attachNote.textContent = uploadNote;
            }
          });
          urls.push(url);
        }
        const extra = { imageURL: urls[0], ...replyExtra() };
        if (urls.length > 1) extra.images = urls;
        else if (images[0].w > 0 && images[0].h > 0) {
          extra.imgW = Math.min(images[0].w, 6000);
          extra.imgH = Math.min(images[0].h, 6000);
        }
        const what = urls.length > 1 ? `${urls.length} photos` : "Photo";
        await sendChatMessage(db, me, otherUid, text, extra, text ? `📷 ${text}` : `📷 ${what}`);
        inputEl.value = "";
        setTyping(false);
        setReply(null);
        uploading = false;
        clearPending();
      } catch (error) {
        uploading = false;
        if (error && error.name === "AbortError") {
          clearPending();
        } else {
          console.error("Chat photo send:", error);
          showToast(error && error.code === "PERMISSION_DENIED" ? "Could not send: database rules block it" : "Could not send the photos. Try again.");
          paintAttach();
        }
      } finally {
        uploading = false;
        uploadAbort = null;
        paintAttach();
      }
    }

    let sending = false;
    async function send() {
      const text = inputEl.value.trim();
      if ((!text && !pendingImages.length) || sending || uploading) return;

      if (pendingImages.length && !editing) {
        sending = true;
        try {
          await sendPhotos(text);
        } finally {
          sending = false;
        }
        return;
      }
      if (!text) return;

      if (editing) {
        sending = true;
        try {
          await saveEdit(text);
        } finally {
          sending = false;
        }
        return;
      }

      sending = true;

      inputEl.value = "";
      autosize();
      setTyping(false);
      const repliedTo = replyingTo;
      const extra = replyExtra();
      setReply(null);

      try {
        await sendChatMessage(db, me, otherUid, text, extra);
      } catch (error) {
        console.error("Chat send:", error);
        if (repliedTo && !replyingTo) setReply(currentMessages.find((m) => m.id === repliedTo.id) || null);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not send: database rules block it" : "Could not send. Try again.");
        if (!inputEl.value) {
          inputEl.value = text; // give the text back so nothing is lost
          autosize();
        }
      } finally {
        sending = false;
      }
    }
    sendBtn.addEventListener("click", send);

    /* ---- edit and delete your own messages ---- */
    const editBar = root.querySelector(".fz-editbar");
    const sendIcon = root.querySelector(".fz-send-icon");

    const setEditMode = (message) => {
      editing = message;
      editBar.classList.toggle("hidden", !message);
      editBar.classList.toggle("flex", !!message);
      sendIcon.textContent = message ? "check" : "send";
      sendBtn.setAttribute("aria-label", message ? "Save" : "Send");
      inputEl.value = message ? message.text : "";
      attachBtn.style.display = message ? "none" : ""; // a message being edited cannot get a picture
      if (message) setReply(null);
      autosize();
      if (message) inputEl.focus();
    };
    root.querySelector(".fz-edit-cancel").addEventListener("click", () => setEditMode(null));

    // The inbox preview only changes when the newest message changes
    const previewPaths = (message, preview) => {
      const isNewest = currentMessages.length && currentMessages[currentMessages.length - 1].id === message.id;
      if (!isNewest) return {};
      return {
        [`userChats/${me}/${chatId}/lastMessage`]: preview,
        [`userChats/${otherUid}/${chatId}/lastMessage`]: preview
      };
    };

    // Whole-message writes keep the message valid for the database rules (from and createdAt never change)
    saveEdit = async (text) => {
      const message = editing;
      if (text === message.text) return setEditMode(null);

      try {
        await update(ref(db), {
          [`chats/${chatId}/messages/${message.id}`]: {
            from: me,
            text,
            createdAt: message.createdAt,
            editedAt: serverTimestamp(),
            ...(message.story ? { story: message.story } : {}),
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            ...(message.forwarded ? { forwarded: true } : {}),
            ...(message.reactions ? { reactions: message.reactions } : {})
          },
          ...previewPaths(message, text.slice(0, 120))
        });
        setEditMode(null);
      } catch (error) {
        console.error("Chat edit:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not edit: database rules block it" : "Could not edit. Try again.");
      }
    };

    const deleteMessage = async (message) => {
      const confirmed = await confirmSheet({
        title: "Delete message?",
        text: "This message will be deleted for everyone in this chat.",
        confirmLabel: "Delete"
      });
      if (!confirmed) return;

      try {
        await update(ref(db), {
          [`chats/${chatId}/messages/${message.id}`]: { from: me, text: "", createdAt: message.createdAt, deleted: true, deletedAt: serverTimestamp() },
          ...previewPaths(message, "This message was deleted")
        });
        if (editing && editing.id === message.id) setEditMode(null);
      } catch (error) {
        console.error("Chat delete:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not delete: database rules block it" : "Could not delete. Try again.");
      }
    };

    // Jump to the original message of a reply
    const jumpTo = (id) => {
      const target = Array.from(messagesEl.querySelectorAll("[data-mid]")).find((el) => el.dataset.mid === id);
      if (!target) return showToast("The original message is further up. Load earlier messages.");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("ring-2", "ring-primary-container");
      setTimeout(() => target.classList.remove("ring-2", "ring-primary-container"), 1400);
    };

    // People a message can be forwarded to: my recent chats first, then the people I follow
    const forwardTargets = async () => {
      const ids = [];
      try {
        const snap = await get(ref(db, `userChats/${me}`));
        const list = [];
        snap.forEach((child) => {
          const value = child.val();
          if (value && value.with) list.push(value);
        });
        list.sort((a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0));
        list.forEach((value) => ids.push(value.with));
      } catch (error) {
        // no recent chats
      }
      Object.keys(ctx.followingIds || {}).forEach((uid) => ids.push(uid));
      const unique = [...new Set(ids)].filter((uid) => uid && uid !== me && !isBlocked(uid)).slice(0, 40);
      const users = await Promise.all(unique.map((uid) => readUser(db, uid)));
      return users.filter(Boolean);
    };

    const forwardMessage = async (message) => {
      const photos = photoUrlsOf(message);
      const people = await forwardTargets();
      const text = message.text || "";
      const extra = { forwarded: true };
      if (photos.length) {
        extra.imageURL = photos[0];
        if (photos.length > 1) extra.images = photos;
        else if (message.imgW > 0 && message.imgH > 0) {
          extra.imgW = message.imgW;
          extra.imgH = message.imgH;
        }
      }
      const preview = photos.length ? (text ? `📷 ${text}` : photos.length > 1 ? `📷 ${photos.length} photos` : "📷 Photo") : text;
      await openForwardSheet({
        people,
        preview: preview || "Message",
        onSend: async (uid) => {
          try {
            await sendChatMessage(db, me, uid, text, extra, preview);
            return true;
          } catch (error) {
            console.error("Forward:", error);
            showToast(error && error.code === "PERMISSION_DENIED" ? "Could not forward: not allowed" : "Could not forward. Try again.");
            return false;
          }
        }
      });
    };

    // One emoji per person on a message; null takes it back. Written under the message, so the other person can react too.
    const setReaction = async (message, emoji) => {
      try {
        await update(ref(db), { [`chats/${chatId}/messages/${message.id}/reactions/${me}`]: emoji || null });
      } catch (error) {
        console.error("Chat reaction:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not react: database rules block it" : "Could not react. Try again.");
      }
    };

    // Tap a message: react, reply, forward, copy, save the photos, edit or delete
    messagesEl.addEventListener("click", async (event) => {
      // Tap my own reaction pill: take the reaction back
      const pill = event.target.closest(".fz-react-pill");
      if (pill) {
        event.stopPropagation();
        const target = currentMessages.find((m) => m.id === pill.dataset.react);
        if (target && target.reactions && target.reactions[me]) setReaction(target, null);
        return;
      }

      const quote = event.target.closest(".fz-quote");
      if (quote) {
        event.stopPropagation();
        return jumpTo(quote.dataset.goto);
      }

      const bubble = event.target.closest("[data-mid]");
      if (!bubble) return;
      const message = currentMessages.find((m) => m.id === bubble.dataset.mid);
      if (!message || message.deleted) return;
      const photos = photoUrlsOf(message);

      // Tap a picture: full-screen viewer (swipe through all pictures of this chat)
      const tapped = event.target.closest(".fz-chat-img");
      if (tapped && !event.target.closest(".fz-img-more")) {
        const all = [];
        let start = 0;
        const tappedIndex = Number(tapped.dataset.pi) || 0;
        currentMessages.forEach((m) => {
          photoUrlsOf(m).forEach((url, i) => {
            if (m.id === message.id && i === tappedIndex) start = all.length;
            all.push(url);
          });
        });
        openImageViewer(all, start);
        return;
      }

      const actions = [{ key: "reply", label: "Reply", icon: "reply" }];
      if ((message.text || photos.length) && !message.reaction && !message.story) actions.push({ key: "forward", label: "Forward", icon: "forward" });
      if (message.text) actions.push({ key: "copy", label: "Copy", icon: "content_copy" });
      if (photos.length) actions.push({ key: "save", label: photos.length > 1 ? "Save photos" : "Save photo", icon: "download" });
      if (message.from === me) {
        if (!message.reaction && !photos.length) actions.push({ key: "edit", label: "Edit", icon: "edit" });
        actions.push({ key: "delete", label: "Delete", icon: "delete", danger: true });
      }

      const myEmoji = message.reactions && typeof message.reactions[me] === "string" ? message.reactions[me] : "";
      const choice = await openActionSheet(actions, { emojis: REACTIONS, current: myEmoji });
      if (typeof choice === "string" && choice.startsWith("react:")) {
        const emoji = choice.slice(6);
        setReaction(message, emoji === myEmoji ? null : emoji); // the same emoji again takes it back
      } else if (choice === "reply") setReply(message);
      else if (choice === "forward") forwardMessage(message);
      else if (choice === "copy") copyText(message.text);
      else if (choice === "save") {
        for (const url of photos) await downloadImage(url);
      } else if (choice === "edit") setEditMode({ id: message.id, from: message.from, text: message.text, createdAt: message.createdAt, story: message.story, replyTo: message.replyTo, forwarded: message.forwarded, reactions: message.reactions });
      else if (choice === "delete") deleteMessage(message);
    });
  };

  /* =============================================================
     Start
  ============================================================= */
  if (ctx.openWithUid) await showConversation(ctx.openWithUid);
  else showInbox();
}