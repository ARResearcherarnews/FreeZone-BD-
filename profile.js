// FreeZone BD - Profile view
// Loaded on demand (dynamic import) from feed.js.
// - Bottom nav "Profile"  -> shows the logged-in user's own profile
// - Tapping a post's photo/name -> shows that user's profile (context.uid)
import {
  ref,
  get,
  update,
  query,
  orderByChild,
  equalTo,
  onValue,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb } from "./imgbb.js";
import { isBlocked, blockAccount, unblockAccount, openActionMenu } from "./block.js";
import { isMuted, muteAccount, unmuteAccount } from "./mute.js";
import { escapeHtml, timeAgo, showToast, avatarHtml, updateSaveButtons, createPostCard, shareProfile, postImagesHtml, postImageUrls, openImageViewer, openReportDialog } from "./post.js";

// Profile photos are uploaded to imgbb (see imgbb.js); only the returned link is saved in Firebase.
const PHOTO_SIZE = 512; // saved photo is a square of this many pixels
const PHOTO_MAX_MB = 10;

export function cropToSquareBlob(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      const size = Math.min(PHOTO_SIZE, side);

      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, size, size);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not process the image"))),
        "image/jpeg",
        0.88
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file is not a valid image"));
    };
    img.src = url;
  });
}

// Keeps name/username/photo shown on old posts and comments in sync (best effort)
export async function syncAuthorFields(db, uid, fields) {
  try {
    const snap = await get(ref(db, "posts"));
    const updates = {};
    snap.forEach((postSnap) => {
      const post = postSnap.val();
      if (post.uid === uid) {
        Object.entries(fields).forEach(([key, value]) => {
          updates[`posts/${postSnap.key}/${key}`] = value;
        });
      }
      Object.entries(post.comments || {}).forEach(([commentId, comment]) => {
        if (comment.uid !== uid) return;
        Object.entries(fields).forEach(([key, value]) => {
          updates[`posts/${postSnap.key}/comments/${commentId}/${key}`] = value;
        });
      });
    });
    if (Object.keys(updates).length) await update(ref(db), updates);
  } catch (error) {
    console.warn("Could not refresh old posts/comments:", error);
  }
}

// Ads are optional: if ads.js is missing or fails, the profile simply stays as it is
let adsModule = null;
function showAds(container, placement) {
  if (!adsModule) adsModule = import("./ads.js").catch(() => null);
  adsModule.then((module) => module && module.insertAds(container, { placement })).catch(() => {});
}

function bigAvatar(photoURL) {
  if (photoURL) {
    return `<img class="w-[92px] h-[92px] rounded-full object-cover ring-4 ring-slate-surface shadow-md" src="${escapeHtml(photoURL)}" alt="avatar" />`;
  }
  return `<div class="w-[92px] h-[92px] rounded-full bg-gradient-to-br from-primary-fixed to-secondary-container flex items-center justify-center ring-4 ring-slate-surface shadow-md">
    <span class="material-symbols-outlined text-primary text-[48px]">person</span>
  </div>`;
}

// Followers / Following: tapping opens the list of people (see openFollowList)
function statButton(label, value, cls, list) {
  return `<button type="button" class="stat-btn flex-1 text-center rounded-xl py-1 active:bg-surface-container transition-colors" data-list="${list}" aria-label="Show ${label.toLowerCase()}">
    <div class="${cls} font-headline-sm text-headline-sm text-on-surface font-semibold">${value}</div>
    <div class="font-body-sm text-body-sm text-slate-muted">${label}</div>
  </button>`;
}

function stat(label, value, cls) {
  return `<div class="flex-1 text-center">
    <div class="${cls} font-headline-sm text-headline-sm text-on-surface font-semibold">${value}</div>
    <div class="font-body-sm text-body-sm text-slate-muted">${label}</div>
  </div>`;
}

async function readCount(db, path) {
  try {
    const snap = await get(ref(db, path));
    return snap.exists() ? snap.size : 0;
  } catch (error) {
    return null; // rules may block it: show a dash instead of failing
  }
}

function postCardHtml(post, { showAuthor = false, showUnsave = false } = {}) {
  const likes = post.likesCount || 0;
  const comments = post.commentsCount || 0;
  return `
    <article class="mx-3 sm:mx-4 bg-slate-surface border border-slate-border rounded-2xl p-4 shadow-sm space-y-2.5" data-post-id="${escapeHtml(post.id)}">
      <div class="flex items-center justify-between gap-2">
        ${
          showAuthor
            ? `<div class="flex items-center gap-2.5 min-w-0">
                 ${avatarHtml(post.photoURL, "w-9 h-9")}
                 <div class="min-w-0">
                   <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(post.name || "FreeZone User")}</div>
                   <div class="font-body-sm text-body-sm text-slate-muted truncate">${post.username ? `@${escapeHtml(post.username)} • ` : ""}${timeAgo(post.createdAt)}</div>
                 </div>
               </div>`
            : `<div class="font-body-sm text-body-sm text-slate-muted">${timeAgo(post.createdAt)}${post.editedAt ? " • edited" : ""}</div>`
        }
        ${
          showUnsave
            ? `<button type="button" class="unsave-btn flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full bg-primary-fixed/50 text-primary font-label-md text-label-md font-semibold active:scale-95 transition-all" data-post-id="${escapeHtml(post.id)}">
                 <span class="material-symbols-outlined text-[18px]" style="font-variation-settings: 'FILL' 1;">bookmark</span> Unsave
               </button>`
            : ""
        }
      </div>
      ${post.text ? `<p class="font-body-md text-body-md text-on-surface leading-relaxed whitespace-pre-wrap break-words">${escapeHtml(post.text)}</p>` : ""}
      ${postImagesHtml(postImageUrls(post))}
      <div class="flex items-center gap-4 pt-1 font-body-sm text-body-sm text-slate-muted">
        <span>${likes} like${likes === 1 ? "" : "s"}</span>
        <span>${comments} comment${comments === 1 ? "" : "s"}</span>
      </div>
    </article>`;
}

const SAVED_EMPTY_HTML = `
  <div class="text-center py-12 px-6">
    <div class="w-14 h-14 mx-auto mb-3 rounded-full bg-primary-fixed/50 flex items-center justify-center">
      <span class="material-symbols-outlined text-[28px] text-primary">bookmark</span>
    </div>
    <p class="font-headline-sm text-headline-sm text-on-surface font-semibold mb-1">No saved posts yet</p>
    <p class="font-body-md text-body-md text-slate-muted">Tap the ⋯ menu on any post and choose "Save post".</p>
  </div>`;

// Returns saved posts (newest saved first). Posts that were deleted are cleaned out of the list.
async function loadSavedPosts(db, uid) {
  const snap = await get(ref(db, `savedPosts/${uid}`));
  if (!snap.exists()) return [];

  const entries = Object.entries(snap.val()).sort(
    (a, b) => (typeof b[1] === "number" ? b[1] : 0) - (typeof a[1] === "number" ? a[1] : 0)
  );

  const found = [];
  const deleted = {};
  await Promise.all(
    entries.map(async ([postId]) => {
      try {
        const postSnap = await get(ref(db, `posts/${postId}`));
        if (postSnap.exists()) found.push({ id: postId, ...postSnap.val() });
        else deleted[`savedPosts/${uid}/${postId}`] = null;
      } catch (error) {
        console.warn("Could not read saved post", postId, error);
      }
    })
  );

  if (Object.keys(deleted).length) {
    update(ref(db), deleted).catch(() => {});
  }

  const order = new Map(entries.map(([id], index) => [id, index]));
  return found.sort((a, b) => order.get(a.id) - order.get(b.id));
}

/**
 * @param {HTMLElement} container - element to fill with this view's markup.
 * @param {object} ctx - { currentUser, currentProfile, auth, db } from feed.js,
 *   plus { uid, isFollowing, onToggleFollow } when opening someone else's profile.
 */

/* ---------------------------------------------------------------
   Followers / Following list (a sheet opened from the two numbers on a profile)
---------------------------------------------------------------- */
const LIST_PAGE = 20; // people shown at a time ("Show more" adds the next ones)
const LIST_SEARCH_CAP = 300; // most people loaded when the list is searched
const listUserCache = new Map(); // uid -> { uid, name, username, photoURL } or null when the account is gone

// ids from followers/{uid} or following/{uid}, newest first
async function readListIds(db, path) {
  const snap = await get(ref(db, path));
  if (!snap.exists()) return [];
  const time = (value) => (typeof value === "number" ? value : 0);
  return Object.entries(snap.val())
    .sort((a, b) => time(b[1]) - time(a[1]))
    .map(([id]) => id);
}

async function readListUser(db, uid) {
  if (listUserCache.has(uid)) return listUserCache.get(uid);
  try {
    const snap = await get(ref(db, `users/${uid}`));
    const data = snap.exists() ? snap.val() : null;
    const user = data ? { uid, name: data.name || "FreeZone User", username: data.username || "", photoURL: data.photoURL || "" } : null;
    listUserCache.set(uid, user);
    return user;
  } catch (error) {
    return null; // not cached: a later try may work
  }
}

/**
 * opts: { db, ctx, uid (whose lists), handle, isMe, startTab: "followers" | "following",
 *         counts: { followers, following }, onCounts({ followers?, following? }) }
 * Tap a person: open their profile. Follow / Following button on every row. On my own Followers: remove a follower.
 */
function openFollowList({ db, ctx, uid, handle, isMe, startTab = "followers", counts = {}, onCounts = () => {} }) {
  const me = ctx.currentUser.uid;
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9997] flex items-end sm:items-center justify-center bg-black/40";
  overlay.innerHTML = `
    <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col" style="height:min(85vh,720px);" role="dialog" aria-modal="true" aria-label="Followers and following">
      <div class="flex items-center justify-between px-4 pt-3.5 pb-1">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">${escapeHtml(handle)}</h2>
        <button type="button" class="fl-close w-9 h-9 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close"><span class="material-symbols-outlined text-[22px]">close</span></button>
      </div>
      <div class="flex gap-1 p-1 mx-4 mt-1 bg-surface-container rounded-xl">
        <button type="button" class="fl-tab flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all" data-tab="followers"></button>
        <button type="button" class="fl-tab flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all" data-tab="following"></button>
      </div>
      <div class="px-4 pt-3">
        <input type="search" class="fl-search w-full bg-surface-container rounded-xl px-4 py-2.5 text-[15px] outline-none" placeholder="Search" autocomplete="off" />
      </div>
      <div class="fl-list flex-1 min-h-0 overflow-y-auto pt-2 pb-4"></div>
    </div>`;
  const listEl = overlay.querySelector(".fl-list");
  const searchEl = overlay.querySelector(".fl-search");
  const tabEls = overlay.querySelectorAll(".fl-tab");

  // per tab: ids (null until loaded), users = resolved people in order, cursor = how many ids were looked at
  const tabs = {
    followers: { ids: null, users: [], cursor: 0, path: `followers/${uid}`, count: counts.followers },
    following: { ids: null, users: [], cursor: 0, path: `following/${uid}`, count: counts.following }
  };
  let tab = startTab === "following" ? "following" : "followers";
  let shown = LIST_PAGE;
  let query = "";
  let token = 0; // a newer paint replaces older async work

  const myFollowing = () => (ctx.followingIds ||= {});

  const paintTabs = () => {
    tabEls.forEach((btn) => {
      const name = btn.dataset.tab;
      const state = tabs[name];
      // on my own profile the Following number follows every follow / unfollow done in the list
      const n = isMe && name === "following" ? Object.keys(myFollowing()).length : state.ids ? state.ids.length : state.count;
      btn.textContent = `${name === "followers" ? "Followers" : "Following"}${typeof n === "number" ? " " + n : ""}`;
      btn.className =
        "fl-tab flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all " +
        (name === tab ? "bg-slate-surface text-primary shadow-sm" : "text-slate-muted");
    });
  };

  // Looks up more people until `want` are ready (blocked and deleted accounts are skipped)
  const resolve = async (state, want) => {
    while (state.users.length < want && state.cursor < state.ids.length) {
      const batch = state.ids.slice(state.cursor, state.cursor + LIST_PAGE);
      state.cursor += batch.length;
      const people = await Promise.all(batch.map((id) => readListUser(db, id)));
      people.forEach((person) => {
        if (person && !isBlocked(person.uid)) state.users.push(person);
      });
    }
  };

  const rowHtml = (person) => {
    const isSelf = person.uid === me;
    const following = !!myFollowing()[person.uid];
    let actions = "";
    if (isSelf) actions = `<span class="text-[12px] text-slate-muted px-2">You</span>`;
    else {
      actions = `<button type="button" class="fl-follow px-4 py-1.5 rounded-full font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60 ${following ? "bg-surface-container text-on-surface" : "bg-primary-container text-white"}" data-uid="${escapeHtml(person.uid)}">${following ? "Following" : tab === "followers" && isMe ? "Follow back" : "Follow"}</button>`;
      if (isMe && tab === "followers")
        actions += `<button type="button" class="fl-remove w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container flex-shrink-0" data-uid="${escapeHtml(person.uid)}" aria-label="Remove follower"><span class="material-symbols-outlined text-[20px]">person_remove</span></button>`;
    }
    return `
      <div class="fl-row flex items-center gap-2 px-4 py-2" data-uid="${escapeHtml(person.uid)}">
        <button type="button" class="fl-open flex items-center gap-3 min-w-0 flex-1 text-left active:opacity-70" data-uid="${escapeHtml(person.uid)}">
          ${avatarHtml(person.photoURL, "w-11 h-11")}
          <span class="min-w-0">
            <span class="block font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(person.name)}</span>
            ${person.username ? `<span class="block font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(person.username)}</span>` : ""}
          </span>
        </button>
        ${actions}
      </div>`;
  };

  const message = (text) => `<p class="text-center text-slate-muted font-body-md text-body-md py-12 px-6">${text}</p>`;

  const paint = async () => {
    const mine = ++token;
    const state = tabs[tab];
    paintTabs();

    if (!state.ids) {
      listEl.innerHTML = Array.from({ length: 5 })
        .map(() => `<div class="flex items-center gap-3 px-4 py-2 animate-pulse"><div class="w-11 h-11 rounded-full bg-surface-container"></div><div class="flex-1 space-y-2"><div class="h-3 w-1/2 rounded bg-surface-container"></div><div class="h-3 w-1/3 rounded bg-surface-container"></div></div></div>`)
        .join("");
      try {
        state.ids = await readListIds(db, state.path);
      } catch (error) {
        console.error("Follow list:", error);
        if (mine === token) listEl.innerHTML = message("Could not load this list. Check your connection and database rules.");
        return;
      }
      state.count = state.ids.length;
      if (mine !== token) return;
      paintTabs();
    }

    const term = query.trim().toLowerCase();
    try {
      await resolve(state, term ? LIST_SEARCH_CAP : shown);
    } catch (error) {
      console.error("Follow list:", error);
    }
    if (mine !== token) return;

    const people = term ? state.users.filter((person) => (person.name + " " + person.username).toLowerCase().includes(term)) : state.users.slice(0, shown);
    if (!people.length) {
      listEl.innerHTML = message(
        term
          ? "No one found."
          : tab === "followers"
            ? isMe ? "No followers yet." : "No followers yet."
            : isMe ? "You are not following anyone yet." : "Not following anyone yet."
      );
      return;
    }
    const more = !term && (state.users.length > shown || state.cursor < state.ids.length);
    listEl.innerHTML =
      people.map(rowHtml).join("") +
      (more ? `<div class="text-center py-3"><button type="button" class="fl-more px-5 py-2 rounded-full bg-surface-container text-on-surface font-label-md text-label-md font-semibold active:scale-95 transition-all">Show more</button></div>` : "");
  };

  const close = () => {
    token++;
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  // numbers shown on my own profile follow what happens in the list
  const syncMyCounts = () => {
    const n = Object.keys(myFollowing()).length;
    tabs.following.count = n;
    if (isMe) {
      if (tabs.following.ids) tabs.following.count = n;
      onCounts({ following: n });
    }
  };

  overlay.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (event.target === overlay || event.target.closest(".fl-close")) return close();

    const tabBtn = event.target.closest(".fl-tab");
    if (tabBtn) {
      if (tabBtn.dataset.tab === tab) return;
      tab = tabBtn.dataset.tab;
      shown = LIST_PAGE;
      searchEl.value = "";
      query = "";
      listEl.scrollTop = 0;
      return paint();
    }

    if (event.target.closest(".fl-more")) {
      shown += LIST_PAGE;
      return paint();
    }

    const open = event.target.closest(".fl-open");
    if (open) {
      const target = open.dataset.uid;
      close();
      if (target === uid) return; // already on this profile
      if (ctx.onOpenProfile) ctx.onOpenProfile(target);
      else if (ctx.__remount) ctx.__remount(target);
      return;
    }

    const followBtn = event.target.closest(".fl-follow");
    if (followBtn && !followBtn.disabled) {
      const person = tabs[tab].users.find((u) => u.uid === followBtn.dataset.uid);
      if (!person || !ctx.onToggleFollow) return;
      const wasFollowing = !!myFollowing()[person.uid];
      followBtn.disabled = true;
      const ok = await ctx.onToggleFollow({ uid: person.uid, name: person.name, username: person.username }, wasFollowing);
      followBtn.disabled = false;
      if (!ok) return;
      // the other list may show the same person: its buttons are repainted when it is opened
      const nowFollowing = !wasFollowing;
      if (nowFollowing) myFollowing()[person.uid] = myFollowing()[person.uid] || Date.now(); // feed.js already did this; keeps other callers right
      else delete myFollowing()[person.uid];
      followBtn.textContent = nowFollowing ? "Following" : tab === "followers" && isMe ? "Follow back" : "Follow";
      followBtn.className = `fl-follow px-4 py-1.5 rounded-full font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60 ${nowFollowing ? "bg-surface-container text-on-surface" : "bg-primary-container text-white"}`;
      syncMyCounts();
      paintTabs();
      return;
    }

    const removeBtn = event.target.closest(".fl-remove");
    if (removeBtn) {
      const person = tabs.followers.users.find((u) => u.uid === removeBtn.dataset.uid);
      if (!person) return;
      const choice = await openActionMenu([{ key: "remove", label: `Remove ${person.username ? "@" + person.username : person.name}`, icon: "person_remove", danger: true }]);
      if (choice !== "remove") return;
      try {
        await update(ref(db), { [`followers/${me}/${person.uid}`]: null, [`following/${person.uid}/${me}`]: null });
      } catch (error) {
        console.error("Remove follower:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not remove: database rules block it" : "Could not remove. Try again.");
        return;
      }
      const state = tabs.followers;
      state.users = state.users.filter((u) => u.uid !== person.uid);
      if (state.ids) state.ids = state.ids.filter((id) => id !== person.uid);
      state.cursor = Math.max(0, state.cursor - 1);
      state.count = state.ids ? state.ids.length : Math.max(0, (state.count || 1) - 1);
      onCounts({ followers: state.count });
      showToast("Follower removed");
      return paint();
    }
  });

  searchEl.addEventListener("input", () => {
    query = searchEl.value;
    shown = LIST_PAGE;
    paint();
  });

  document.body.appendChild(overlay);
  paint();
}

export async function mount(container, ctx = {}) {
  const { db, currentUser, isFollowing, onToggleFollow } = ctx;
  const uid = ctx.uid || currentUser?.uid;

  if (!db || !uid) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">This profile could not be loaded.</p>`;
    return;
  }

  container.innerHTML = `<div class="flex-1 flex items-center justify-center py-16 text-slate-muted font-body-md text-body-md">Loading profile...</div>`;

  let user;
  try {
    const snap = await get(ref(db, `users/${uid}`));
    user = snap.exists() ? snap.val() : null;
  } catch (error) {
    console.error(error);
  }

  if (!user) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">This profile could not be loaded.</p>`;
    return;
  }

  let [followers, following, posts] = await Promise.all([
    readCount(db, `followers/${uid}`),
    readCount(db, `following/${uid}`),
    (async () => {
      try {
        const snap = await get(ref(db, "posts"));
        const list = [];
        snap.forEach((child) => {
          const post = child.val();
          if (post.uid === uid) list.push({ id: child.key, ...post });
        });
        return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      } catch (error) {
        console.error(error);
        return [];
      }
    })()
  ]);

  const name = user.name || "FreeZone User";
  const handle = user.username ? `@${user.username}` : name;
  const isMe = !!(currentUser && currentUser.uid === uid);
  const blocked = !isMe && isBlocked(uid); // I blocked this account
  let followingNow = !!isFollowing;
  let followersCount = followers;

  const hasPhoto = typeof user.photoURL === "string" && user.photoURL.startsWith("https://");

  container.innerHTML = `
    <div class="bg-slate-surface border-b border-slate-border px-5 pt-6 pb-5">
      <div class="flex items-center gap-4 text-left">
        ${
          isMe
            ? `<div class="relative flex-shrink-0">
                 <button type="button" class="change-photo block rounded-full active:scale-95 transition-transform" aria-label="Change profile photo">${bigAvatar(user.photoURL)}</button>
                 <span class="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-primary-container text-white ring-2 ring-slate-surface flex items-center justify-center pointer-events-none">
                   <span class="material-symbols-outlined text-[16px]">photo_camera</span>
                 </span>
                 <div class="photo-loading absolute inset-0 rounded-full bg-black/50 text-white text-xs font-semibold flex items-center justify-center" hidden>Uploading...</div>
                 <input type="file" class="photo-input" accept="image/*" hidden />
               </div>`
            : hasPhoto
              ? `<button type="button" class="view-photo flex-shrink-0 block rounded-full active:scale-95 transition-transform" aria-label="View profile photo">${bigAvatar(user.photoURL)}</button>`
              : `<div class="flex-shrink-0">${bigAvatar(user.photoURL)}</div>`
        }
        <div class="min-w-0 flex-1">
          <h2 class="font-headline-md text-headline-md text-on-surface font-semibold break-words">${escapeHtml(name)}</h2>
          ${user.username ? `<p class="font-body-md text-body-md text-primary/80">@${escapeHtml(user.username)}</p>` : ""}
          ${user.bio ? `<p class="font-body-md text-body-md text-on-surface-variant mt-2 whitespace-pre-wrap break-words">${escapeHtml(user.bio)}</p>` : ""}
        </div>
      </div>

      <div class="flex items-center mt-5 py-3 border-y border-slate-border/70">
        ${stat("Posts", posts.length, "posts-count")}
        ${blocked ? stat("Followers", followersCount ?? "–", "followers-count") : statButton("Followers", followersCount ?? "–", "followers-count", "followers")}
        ${blocked ? stat("Following", following ?? "–", "following-count") : statButton("Following", following ?? "–", "following-count", "following")}
      </div>

      ${
        isMe
          ? `<div class="flex gap-2 mt-4">
               <button type="button" class="edit-profile flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-95 transition-all flex items-center justify-center gap-2">
                 <span class="material-symbols-outlined text-[18px]">edit</span> Edit profile
               </button>
               <button type="button" class="share-profile flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-95 transition-all flex items-center justify-center gap-2">
                 <span class="material-symbols-outlined text-[18px]">share</span> Share profile
               </button>
             </div>`
          : blocked
            ? `<div class="mt-4 rounded-xl bg-surface-container p-3.5 text-center">
                 <p class="font-body-md text-body-md text-on-surface-variant mb-2.5">You blocked ${escapeHtml(handle)}.</p>
                 <button type="button" class="unblock-btn px-6 py-2 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60">Unblock</button>
               </div>`
            : `<div class="flex gap-2 mt-4">
               <button type="button" class="follow-toggle flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold active:scale-95 transition-all"></button>
               ${
                 ctx.onOpenChat
                   ? `<button type="button" class="message-btn flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-95 transition-all flex items-center justify-center gap-2">
                        <span class="material-symbols-outlined text-[18px]">chat_bubble</span> Message
                      </button>`
                   : ""
               }
               <button type="button" class="share-profile flex-shrink-0 w-11 py-2.5 rounded-xl bg-surface-container text-on-surface hover:bg-surface-container-high active:scale-95 transition-all flex items-center justify-center" aria-label="Share profile">
                 <span class="material-symbols-outlined text-[20px]">share</span>
               </button>
             </div>`
      }
    </div>

    <div class="px-3 sm:px-4 py-4 space-y-3 pb-10">
      ${
        !blocked
          ? `<div class="flex gap-1 p-1 bg-surface-container rounded-xl">
               <button type="button" class="tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all" data-tab="posts">Posts</button>
               <button type="button" class="tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all flex items-center justify-center gap-1.5" data-tab="photos">
                 <span class="material-symbols-outlined text-[18px]">photo_library</span> Photos
               </button>
               ${
                 isMe
                   ? `<button type="button" class="tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all flex items-center justify-center gap-1.5" data-tab="saved">
                 <span class="material-symbols-outlined text-[18px]">bookmark</span> Saved
               </button>`
                   : ""
               }
             </div>`
          : `<h3 class="font-label-lg text-label-lg text-on-surface px-1">Posts</h3>`
      }
      <div class="tab-content -mx-3 sm:-mx-4 flex flex-col gap-2"></div>
    </div>
  `;

  // Posts: same cards as the Feed (author, menu, like / comment / share) and live updates
  const tabContent = container.querySelector(".tab-content");
  const tabButtons = container.querySelectorAll(".tab-btn");
  let activeTab = "posts";

  const cardOptions = {
    ...(ctx.postActions || {}),
    currentUserUid: currentUser?.uid,
    savedPostIds: ctx.savedPostIds,
    followingIds: ctx.followingIds,
    isBlocked,
    showFollowChip: false // the profile already has its own Follow button
  };

  const renderPosts = () => {
    tabContent.innerHTML = "";
    if (blocked) {
      tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-8">Posts are hidden because you blocked this account.</p>`;
      return;
    }
    if (!posts.length) {
      tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-8">${escapeHtml(isMe ? "You have" : handle + " has")} not posted yet.</p>`;
      return;
    }
    posts.forEach((post) => tabContent.appendChild(createPostCard(post, cardOptions)));
    showAds(tabContent, "profile");
  };
  renderPosts();

  // Photos: every picture from this person's posts in a grid; tap one to see it big and swipe through the rest
  const renderPhotos = () => {
    tabContent.innerHTML = "";
    const urls = [];
    posts.forEach((post) => postImageUrls(post).forEach((url) => urls.push(url)));
    if (!urls.length) {
      tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">${escapeHtml(isMe ? "You have" : handle + " has")} no photos yet.</p>`;
      return;
    }
    const grid = document.createElement("div");
    grid.className = "grid grid-cols-3 gap-0.5 px-3 sm:px-4";
    grid.style.gridTemplateColumns = "repeat(3, minmax(0, 1fr))";
    urls.forEach((url, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "ph-tile relative block overflow-hidden bg-surface-container active:opacity-80";
      tile.style.aspectRatio = "1 / 1";
      tile.setAttribute("aria-label", `Photo ${index + 1} of ${urls.length}`);
      tile.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()" />`;
      tile.addEventListener("click", () => openImageViewer(urls, index));
      grid.appendChild(tile);
    });
    tabContent.appendChild(grid);
  };

  let firstSnapshot = true;
  const unsubscribePosts = onValue(
    ref(db, "posts"),
    (snap) => {
      // The profile was closed or re-rendered: stop listening
      if (!tabContent.isConnected) {
        unsubscribePosts();
        return;
      }
      if (firstSnapshot) {
        firstSnapshot = false;
        return;
      }

      const list = [];
      snap.forEach((child) => {
        const post = child.val();
        if (post.uid === uid) list.push({ id: child.key, ...post });
      });
      posts = list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      const countEl = container.querySelector(".posts-count");
      if (countEl) countEl.textContent = posts.length;
      if (activeTab === "posts") renderPosts();
      else if (activeTab === "photos") renderPhotos();
    },
    (error) => console.warn("Could not watch posts:", error)
  );

  // Posts / Photos tabs (and Saved on my own profile)
  if (tabButtons.length) {
    const paintTabs = (active) => {
      tabButtons.forEach((btn) => {
        const on = btn.dataset.tab === active;
        btn.className =
          "tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all flex items-center justify-center gap-1.5 " +
          (on ? "bg-slate-surface text-primary shadow-sm" : "text-slate-muted");
      });
    };

    const showTab = async (tab) => {
      activeTab = tab;
      paintTabs(tab);
      if (tab === "posts") {
        renderPosts();
        return;
      }
      if (tab === "photos") {
        renderPhotos();
        return;
      }

      tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Loading saved posts...</p>`;
      try {
        const saved = await loadSavedPosts(db, uid);
        // The user may have switched tabs while loading
        if (activeTab !== "saved") return;
        if (!saved.length) {
          tabContent.innerHTML = SAVED_EMPTY_HTML;
          return;
        }
        // Same cards as the Feed; unsaving from the card's menu removes it from this list
        tabContent.innerHTML = "";
        const savedOptions = {
          ...cardOptions,
          showFollowChip: true,
          onSave: async (post, wasSaved) => {
            const ok = await cardOptions.onSave?.(post, wasSaved);
            if (ok && wasSaved) {
              tabContent.querySelector(`.save-btn[data-post-id="${post.id}"]`)?.closest("article")?.remove();
              if (!tabContent.querySelector("article")) tabContent.innerHTML = SAVED_EMPTY_HTML;
            }
            return ok;
          }
        };
        saved.forEach((post) => tabContent.appendChild(createPostCard(post, savedOptions)));
      } catch (error) {
        console.error(error);
        tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Could not load saved posts.</p>`;
      }
    };

    tabButtons.forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

    tabContent.addEventListener("click", async (event) => {
      const unsaveBtn = event.target.closest(".unsave-btn");
      if (!unsaveBtn) return;

      const postId = unsaveBtn.dataset.postId;
      unsaveBtn.disabled = true;
      try {
        await update(ref(db), { [`savedPosts/${uid}/${postId}`]: null });
        if (ctx.savedPostIds) delete ctx.savedPostIds[postId];
        updateSaveButtons(postId, false);

        unsaveBtn.closest("article").remove();
        if (!tabContent.querySelector("article")) tabContent.innerHTML = SAVED_EMPTY_HTML;
        showToast("Removed from saved");
      } catch (error) {
        console.error(error);
        unsaveBtn.disabled = false;
        showToast("Could not remove. Try again.");
      }
    });

    paintTabs("posts");
  }

  const photoBtn = container.querySelector(".change-photo");
  if (photoBtn) {
    const photoInput = container.querySelector(".photo-input");
    const loadingEl = container.querySelector(".photo-loading");

    // My own photo: View (bigger) or Change. Without a photo yet, tapping goes straight to choosing one.
    photoBtn.addEventListener("click", async () => {
      if (!hasPhoto) return photoInput.click();
      const choice = await openActionMenu([
        { key: "view", label: "View photo", icon: "visibility" },
        { key: "change", label: "Change photo", icon: "photo_camera" }
      ]);
      if (choice === "view") openImageViewer([user.photoURL], 0);
      else if (choice === "change") photoInput.click();
    });

    photoInput.addEventListener("change", async () => {
      const file = photoInput.files[0];
      photoInput.value = "";
      if (!file) return;

      if (!file.type.startsWith("image/")) {
        showToast("Please choose an image file");
        return;
      }
      if (file.size > PHOTO_MAX_MB * 1024 * 1024) {
        showToast(`Image is too large (max ${PHOTO_MAX_MB} MB)`);
        return;
      }

      loadingEl.hidden = false;
      photoBtn.disabled = true;
      try {
        const blob = await cropToSquareBlob(file);
        const photoURL = await uploadToImgbb(blob, "avatar.jpg", {
          onProgress: (fraction) => {
            loadingEl.textContent = fraction < 1 ? `${Math.round(fraction * 100)}%` : "...";
          }
        });

        await update(ref(db, `users/${uid}`), { photoURL });
        if (ctx.currentProfile) ctx.currentProfile.photoURL = photoURL;

        // Update the avatars already on the Feed screen
        const navAvatarEl = document.getElementById("navAvatar");
        if (navAvatarEl) {
          navAvatarEl.innerHTML = `<img class="w-full h-full object-cover" src="${escapeHtml(photoURL)}" alt="avatar" />`;
        }

        showToast("Profile photo updated");
        syncAuthorFields(db, uid, { photoURL });
        mount(container, ctx);
      } catch (error) {
        console.error(error);
        loadingEl.hidden = true;
        photoBtn.disabled = false;
        showToast("Could not update photo. Try again.");
      }
    });
  }

  // Someone else's photo: tap to see it bigger (swipe down or tap X to close; the menu can save it)
  const viewPhotoBtn = container.querySelector(".view-photo");
  if (viewPhotoBtn) viewPhotoBtn.addEventListener("click", () => openImageViewer([user.photoURL], 0));

  const unblockBtn = container.querySelector(".unblock-btn");
  if (unblockBtn) {
    unblockBtn.addEventListener("click", async () => {
      unblockBtn.disabled = true;
      const ok = await unblockAccount({ db, me: currentUser.uid, uid, name: handle });
      if (ok) mount(container, ctx);
      else unblockBtn.disabled = false;
    });
  }

  // The ⋮ menu at the top right of another person's profile: Block / Unblock, Share
  if (isMe) {
    // The menu icon at the top right of my own profile opens Settings (settings.js)
    ctx.setActions?.(
      ctx.onOpenSettings ? [{ icon: "menu", label: "Settings", onClick: () => ctx.onOpenSettings() }] : []
    );
  } else {
    ctx.setActions?.([
      {
        icon: "more_vert",
        label: "More options",
        onClick: async () => {
          const choice = await openActionMenu([
            blocked
              ? { key: "unblock", label: `Unblock ${handle}`, icon: "lock_open" }
              : { key: "block", label: `Block ${handle}`, icon: "block", danger: true },
            isMuted(uid)
              ? { key: "unmute", label: `Unmute ${handle}`, icon: "volume_up" }
              : { key: "mute", label: `Mute ${handle}`, icon: "volume_off" },
            { key: "share", label: "Share profile", icon: "share" },
            { key: "report", label: `Report ${handle}`, icon: "flag", danger: true }
          ]);

          if (choice === "block") {
            const ok = await blockAccount({ db, me: currentUser.uid, user: { uid, name, username: user.username || "" }, followingIds: ctx.followingIds || {} });
            if (ok) mount(container, ctx);
          } else if (choice === "unblock") {
            if (await unblockAccount({ db, me: currentUser.uid, uid, name: handle })) mount(container, ctx);
          } else if (choice === "mute") {
            if (await muteAccount({ db, me: currentUser.uid, uid })) showToast(`${handle} muted. Their posts are hidden from your feed.`);
            else showToast("Could not mute. Try again.");
          } else if (choice === "unmute") {
            if (await unmuteAccount({ db, me: currentUser.uid, uid })) showToast(`${handle} unmuted`);
            else showToast("Could not unmute. Try again.");
          } else if (choice === "report") {
            reportProfile({ db, me: currentUser.uid, uid, name, username: user.username || "" });
          } else if (choice === "share") {
            shareProfile({ uid, name, username: user.username || "" });
          }
        }
      }
    ]);
  }

  const shareBtn = container.querySelector(".share-profile");
  if (shareBtn) shareBtn.addEventListener("click", () => shareProfile({ uid, name, username: user.username || "" }));

  // Followers / Following: the numbers open the list of people
  container.querySelectorAll(".stat-btn").forEach((btn) =>
    btn.addEventListener("click", () =>
      openFollowList({
        db,
        // without an "open profile" handler (older callers) the list reopens this page for the chosen person
        ctx: ctx.onOpenProfile ? ctx : { ...ctx, __remount: (target) => mount(container, { ...ctx, uid: target, isFollowing: !!(ctx.followingIds || {})[target] }) },
        uid,
        handle: handle,
        isMe,
        startTab: btn.dataset.list,
        counts: { followers: followersCount, following },
        onCounts: (next) => {
          if (typeof next.followers === "number") {
            followersCount = next.followers;
            const el = container.querySelector(".followers-count");
            if (el) el.textContent = next.followers;
          }
          if (typeof next.following === "number") {
            following = next.following;
            const el = container.querySelector(".following-count");
            if (el) el.textContent = next.following;
          }
        }
      })
    )
  );

  // Edit profile is a full page inside Settings (settings.js)
  const editBtn = container.querySelector(".edit-profile");
  if (editBtn) {
    editBtn.addEventListener("click", () => ctx.onOpenEditProfile?.());
    return;
  }

  const messageBtn = container.querySelector(".message-btn");
  if (messageBtn) messageBtn.addEventListener("click", () => ctx.onOpenChat(uid));

  const followBtn = container.querySelector(".follow-toggle");
  if (!followBtn) return;

  const followersEl = container.querySelector(".followers-count");

  const paint = () => {
    followBtn.textContent = followingNow ? "Following" : "Follow";
    followBtn.className =
      "follow-toggle flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold active:scale-95 transition-all " +
      (followingNow
        ? "bg-surface-container text-on-surface hover:bg-surface-container-high"
        : "bg-primary-container text-white");
  };
  paint();

  followBtn.addEventListener("click", async () => {
    followBtn.disabled = true;
    const ok = await onToggleFollow({ uid, name, username: user.username || "" }, followingNow);
    followBtn.disabled = false;
    if (!ok) return;

    followingNow = !followingNow;
    if (followersCount !== null) {
      followersCount = Math.max(0, followersCount + (followingNow ? 1 : -1));
      followersEl.textContent = followersCount;
    }
    paint();
  });
}

/* ---------------------------------------------------------------
   Report a profile (goes to the admin panel, Reports > Profiles)
---------------------------------------------------------------- */
async function reportProfile({ db, me, uid, name, username }) {
  const result = await openReportDialog({ title: "Report account", question: "Why are you reporting this account?" });
  if (!result) return;
  const reportRef = ref(db, `userReports/${uid}/${me}`);
  try {
    if ((await get(reportRef)).exists()) { showToast("You already reported this account"); return; }
    await set(reportRef, {
      targetUid: uid,
      reporterUid: me,
      reason: result.reason,
      details: result.details || "",
      name: (name || "").slice(0, 60),
      username: (username || "").slice(0, 40),
      status: "pending",
      createdAt: serverTimestamp()
    });
    showToast("Report submitted. Thank you.");
  } catch (error) {
    console.error(error);
    showToast(error.code === "PERMISSION_DENIED" ? "Could not report: database rules block it" : "Could not submit report. Try again.");
  }
}