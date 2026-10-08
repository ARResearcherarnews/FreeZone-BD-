// FreeZone BD - Notifications (likes, comments, replies, comment likes, new followers)
//
// Everything about notifications lives in this file, so it can be changed without touching feed.js:
//   start(ctx)  - called once by feed.js after login. It
//                   1. listens for the "fz:notify" events that feed.js sends when someone likes, comments or follows,
//                      and writes the notification for the right person,
//                   2. keeps the red number on the bell icon up to date.
//   mount(container, ctx) - draws the Notifications page (opened by the bell icon).
//
// Data (Firebase Realtime Database):
//   notifications/{recipientUid}/{notificationId} = { type, from, fromName, fromUsername, fromPhotoURL,
//                                                      postId?, text?, createdAt, read }
//   type is "like", "comment", "reply", "commentLike" or "follow". Ids are fixed (like_{postId}_{from}, follow_{from}, comment_{commentId}),
//   so liking the same post twice never creates two notifications, and unliking removes it.

import {
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  query,
  limitToLast,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, timeAgo, showToast } from "./post.js";

const LIST_LIMIT = 50; // newest notifications shown
const SNIPPET_MAX = 100; // characters of a post or comment shown in a notification

const TYPES = {
  like: { icon: "thumb_up", color: "bg-primary-container", label: "liked your post" },
  comment: { icon: "chat_bubble", color: "bg-online-emerald", label: "commented on your post" },
  follow: { icon: "person_add", color: "bg-violet-500", label: "started following you" },
  reply: { icon: "reply", color: "bg-sky-500", label: "replied to your comment" },
  commentLike: { icon: "favorite", color: "bg-notification-rose", label: "liked your comment" }
};

const snippet = (text) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > SNIPPET_MAX ? clean.slice(0, SNIPPET_MAX) + "…" : clean;
};

/* ===============================================================
   BACKGROUND: sending notifications + the bell badge
=============================================================== */
let started = false;

/**
 * @param {object} ctx  { db, currentUser, currentProfile }
 */
export function start(ctx = {}) {
  const { db, currentUser } = ctx;
  if (started || !db || !currentUser) return;
  started = true;

  const me = currentUser.uid;

  /* ---- sending ---- */
  const readValue = async (path) => {
    const snap = await get(ref(db, path));
    return snap.exists() ? snap.val() : null;
  };

  const send = (toUid, id, data) => {
    const profile = ctx.currentProfile || {};
    const notification = {
      ...data,
      from: me,
      fromName: String(profile.name || "FreeZone User").slice(0, 60),
      createdAt: serverTimestamp(),
      read: false
    };
    if (profile.username) notification.fromUsername = String(profile.username).slice(0, 20);
    if (profile.photoURL) notification.fromPhotoURL = String(profile.photoURL).slice(0, 600);
    Object.keys(notification).forEach((key) => notification[key] === undefined && delete notification[key]);
    return set(ref(db, `notifications/${toUid}/${id}`), notification);
  };

  const handle = async (detail) => {
    const { type, postId, commentId, toUid, undo } = detail || {};

    if (type === "like" || type === "comment") {
      if (!postId) return;
      const owner = await readValue(`posts/${postId}/uid`);
      if (!owner || owner === me) return; // never notify yourself

      if (type === "like") {
        const id = `like_${postId}_${me}`;
        if (undo) return remove(ref(db, `notifications/${owner}/${id}`));
        const postText = await readValue(`posts/${postId}/text`);
        return send(owner, id, { type, postId, ...(snippet(postText) ? { text: snippet(postText) } : {}) });
      }

      const commentText = snippet(detail.text);
      return send(owner, `comment_${commentId || Date.now()}`, { type, postId, ...(commentText ? { text: commentText } : {}) });
    }

    // Someone answered a comment: tell the owner of the comment (and the person who was answered)
    if (type === "reply") {
      if (!postId) return;
      const replyText = snippet(detail.text);
      const targets = new Set([toUid, detail.replyToUid].filter((uid) => uid && uid !== me));
      return Promise.all(
        [...targets].map((uid) => send(uid, `reply_${detail.replyId || Date.now()}`, { type, postId, ...(replyText ? { text: replyText } : {}) }))
      );
    }

    // Someone liked a comment or a reply
    if (type === "commentLike") {
      if (!postId || !toUid || toUid === me) return;
      const id = `clike_${commentId}_${detail.replyId || "c"}_${me}`;
      if (undo) return remove(ref(db, `notifications/${toUid}/${id}`));
      const likeText = snippet(detail.text);
      return send(toUid, id, { type, postId, ...(likeText ? { text: likeText } : {}) });
    }

    if (type === "follow") {
      if (!toUid || toUid === me) return;
      const id = `follow_${me}`;
      if (undo) return remove(ref(db, `notifications/${toUid}/${id}`));
      return send(toUid, id, { type });
    }
  };

  document.addEventListener("fz:notify", (event) => {
    handle(event.detail).catch((error) => console.warn("Notification not sent:", error?.code || error));
  });

  /* ---- the bell badge ---- */
  const bell = document.querySelector('.nav-link[data-page="notifications"]');
  if (!bell) return;

  bell.classList.add("relative");
  let badge = bell.querySelector(".fz-notif-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className =
      "fz-notif-badge absolute top-0 right-0 min-w-[18px] h-[18px] px-1 rounded-full bg-notification-rose text-white text-[10px] font-bold items-center justify-center ring-2 ring-white pointer-events-none";
    badge.style.display = "none";
    bell.appendChild(badge);
  }

  onValue(
    query(ref(db, `notifications/${me}`), limitToLast(LIST_LIMIT)),
    (snap) => {
      let unread = 0;
      snap.forEach((child) => {
        if (child.val() && child.val().read === false) unread++;
      });
      badge.textContent = unread > 99 ? "99+" : String(unread);
      badge.style.display = unread > 0 ? "flex" : "none";
    },
    () => {} // no permission or no network: simply no badge
  );
}

/* ===============================================================
   PAGE: the list
=============================================================== */
function emptyState() {
  return `
    <div class="text-center py-20 px-6">
      <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-surface-container flex items-center justify-center">
        <span class="material-symbols-outlined text-[30px] text-primary-container">notifications</span>
      </div>
      <p class="font-headline-sm text-headline-sm text-on-surface font-semibold mb-1">No notifications yet</p>
      <p class="font-body-md text-body-md text-slate-muted max-w-xs mx-auto">When someone likes or comments on your posts, or follows you, it will show up here.</p>
    </div>`;
}

function skeleton() {
  return Array.from({ length: 5 })
    .map(
      () => `
    <div class="flex items-start gap-3 px-4 py-3 bg-slate-surface rounded-2xl border border-slate-border">
      <div class="skeleton w-12 h-12 rounded-full flex-shrink-0"></div>
      <div class="flex-1 space-y-2 pt-1">
        <div class="skeleton h-3.5 w-3/4 rounded"></div>
        <div class="skeleton h-3 w-1/3 rounded"></div>
      </div>
    </div>`
    )
    .join("");
}

/**
 * @param {HTMLElement} container
 * @param {object} ctx  { db, currentUser, openPost?, onOpenProfile? }
 */
export function mount(container, ctx = {}) {
  const { db, currentUser } = ctx;
  if (!db || !currentUser) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">Please log in to see your notifications.</p>`;
    return;
  }

  const me = currentUser.uid;
  let items = [];
  let fresh = null; // ids that were unread when the page opened (they stay highlighted while you read)

  container.innerHTML = `
    <div class="fz-notifs px-3 sm:px-4 py-3 space-y-2.5">
      <div class="fz-n-list space-y-2.5">${skeleton()}</div>
    </div>`;

  const root = container.querySelector(".fz-notifs");
  const listEl = container.querySelector(".fz-n-list");
  const alive = () => root.isConnected;

  /* ---- rendering ---- */
  const rowHtml = (n) => {
    const type = TYPES[n.type];
    if (!type) return "";

    const who = n.fromUsername ? `@${n.fromUsername}` : n.fromName || "Someone";
    const quote = n.text ? `<p class="font-body-md text-body-md text-slate-muted truncate">“${escapeHtml(n.text)}”</p>` : "";
    const isNew = fresh && fresh.has(n.id);

    return `
      <div class="fz-n-row flex items-start gap-3 pl-4 pr-2 py-3 rounded-2xl border cursor-pointer active:bg-surface-container-low transition-colors ${
        isNew ? "bg-primary-fixed/40 border-primary-fixed" : "bg-slate-surface border-slate-border"
      }" data-id="${escapeHtml(n.id)}">
        <div class="relative flex-shrink-0">
          ${avatarHtml(n.fromPhotoURL || "", "w-12 h-12")}
          <span class="absolute -bottom-1 -right-1 w-6 h-6 rounded-full ${type.color} text-white ring-2 ring-white flex items-center justify-center">
            <span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">${type.icon}</span>
          </span>
        </div>
        <div class="min-w-0 flex-1">
          <p class="font-body-md text-body-md text-on-surface"><span class="font-semibold">${escapeHtml(who)}</span> ${type.label}</p>
          ${quote}
          <p class="text-[12px] ${isNew ? "text-primary font-semibold" : "text-slate-subtle"} mt-0.5">${timeAgo(Number(n.createdAt))}</p>
        </div>
        <button type="button" class="fz-n-del flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-subtle hover:bg-surface-container" aria-label="Remove notification">
          <span class="material-symbols-outlined text-[18px]">close</span>
        </button>
      </div>`;
  };

  const render = () => {
    if (!alive()) return;
    const shown = items.filter((n) => TYPES[n.type]);

    if (!shown.length) {
      listEl.innerHTML = emptyState();
      return;
    }

    const newOnes = shown.filter((n) => fresh && fresh.has(n.id));
    const older = shown.filter((n) => !(fresh && fresh.has(n.id)));

    listEl.innerHTML =
      (newOnes.length
        ? `<h3 class="font-label-lg text-label-lg text-on-surface px-1 pt-1">New</h3>${newOnes.map(rowHtml).join("")}`
        : "") +
      (older.length
        ? `<div class="flex items-center justify-between px-1 pt-2">
             <h3 class="font-label-lg text-label-lg text-on-surface">${newOnes.length ? "Earlier" : "All notifications"}</h3>
             <button type="button" class="fz-n-clear text-primary font-label-md text-label-md font-semibold">Clear all</button>
           </div>${older.map(rowHtml).join("")}`
        : `<div class="text-right px-1 pt-2"><button type="button" class="fz-n-clear text-primary font-label-md text-label-md font-semibold">Clear all</button></div>`);
  };

  /* ---- realtime list ---- */
  let readTimer = null;
  const markRead = () => {
    clearTimeout(readTimer);
    // A short delay, so the person sees what is new before the highlight and the bell badge go away
    readTimer = setTimeout(() => {
      const unread = items.filter((n) => n.read === false);
      if (!unread.length) return;
      const updates = {};
      unread.forEach((n) => {
        updates[`notifications/${me}/${n.id}/read`] = true;
      });
      update(ref(db), updates).catch(() => {});
    }, 1200);
  };

  const unsubscribe = onValue(
    query(ref(db, `notifications/${me}`), limitToLast(LIST_LIMIT)),
    (snap) => {
      if (!alive()) {
        clearTimeout(readTimer);
        return unsubscribe();
      }

      const list = [];
      snap.forEach((child) => {
        list.push({ id: child.key, ...child.val() });
      });
      list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
      items = list;

      if (fresh === null) fresh = new Set();
      list.forEach((n) => {
        if (n.read === false) fresh.add(n.id);
      });

      render();
      markRead();
    },
    (error) => {
      console.error("Notifications:", error);
      if (alive()) listEl.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-16 px-6">Could not load your notifications.</p>`;
    }
  );

  /* ---- taps ---- */
  listEl.addEventListener("click", async (event) => {
    if (event.target.closest(".fz-n-clear")) {
      if (!items.length || !confirm("Remove all notifications?")) return;
      const updates = {};
      items.forEach((n) => {
        updates[`notifications/${me}/${n.id}`] = null;
      });
      try {
        await update(ref(db), updates);
        showToast("Notifications cleared");
      } catch (error) {
        console.error(error);
        showToast("Could not clear notifications");
      }
      return;
    }

    const row = event.target.closest(".fz-n-row");
    if (!row) return;
    const n = items.find((item) => item.id === row.dataset.id);
    if (!n) return;

    if (event.target.closest(".fz-n-del")) {
      remove(ref(db, `notifications/${me}/${n.id}`)).catch(() => showToast("Could not remove this notification"));
      return;
    }

    if (["like", "comment", "reply", "commentLike"].includes(n.type) && n.postId) ctx.openPost?.(n.postId);
    else if (n.type === "follow") ctx.onOpenProfile?.(n.from);
  });
}