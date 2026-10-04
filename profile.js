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
  onValue
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb } from "./imgbb.js";
import { isBlocked, blockAccount, unblockAccount, openActionMenu } from "./block.js";
import { escapeHtml, timeAgo, showToast, avatarHtml, updateSaveButtons, createPostCard, shareProfile, postImagesHtml, postImageUrls } from "./post.js";

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
    return `<img class="w-24 h-24 rounded-full object-cover ring-4 ring-slate-surface shadow-md" src="${escapeHtml(photoURL)}" alt="avatar" />`;
  }
  return `<div class="w-24 h-24 rounded-full bg-gradient-to-br from-primary-fixed to-secondary-container flex items-center justify-center ring-4 ring-slate-surface shadow-md">
    <span class="material-symbols-outlined text-primary text-[48px]">person</span>
  </div>`;
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
    <article class="bg-slate-surface border border-slate-border rounded-2xl p-4 shadow-sm space-y-2.5" data-post-id="${escapeHtml(post.id)}">
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

  container.innerHTML = `
    <div class="bg-slate-surface border-b border-slate-border px-5 pt-6 pb-5">
      <div class="flex flex-col items-center text-center">
        ${
          isMe
            ? `<div class="relative">
                 <button type="button" class="change-photo block rounded-full active:scale-95 transition-transform" aria-label="Change profile photo">${bigAvatar(user.photoURL)}</button>
                 <span class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-primary-container text-white ring-2 ring-slate-surface flex items-center justify-center pointer-events-none">
                   <span class="material-symbols-outlined text-[18px]">photo_camera</span>
                 </span>
                 <div class="photo-loading absolute inset-0 rounded-full bg-black/50 text-white text-xs font-semibold flex items-center justify-center" hidden>Uploading...</div>
                 <input type="file" class="photo-input" accept="image/*" hidden />
               </div>`
            : bigAvatar(user.photoURL)
        }
        <h2 class="font-headline-md text-headline-md text-on-surface font-semibold mt-3 break-words max-w-full">${escapeHtml(name)}</h2>
        ${user.username ? `<p class="font-body-md text-body-md text-primary/80">@${escapeHtml(user.username)}</p>` : ""}
        ${user.bio ? `<p class="font-body-md text-body-md text-on-surface-variant mt-2 whitespace-pre-wrap break-words max-w-sm">${escapeHtml(user.bio)}</p>` : ""}
      </div>

      <div class="flex items-center mt-5 py-3 border-y border-slate-border/70">
        ${stat("Posts", posts.length, "posts-count")}
        ${stat("Followers", followersCount ?? "–", "followers-count")}
        ${stat("Following", following ?? "–", "")}
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
        isMe
          ? `<div class="flex gap-1 p-1 bg-surface-container rounded-xl">
               <button type="button" class="tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all" data-tab="posts">Posts</button>
               <button type="button" class="tab-btn flex-1 py-2 rounded-lg font-label-lg text-label-lg font-semibold transition-all flex items-center justify-center gap-1.5" data-tab="saved">
                 <span class="material-symbols-outlined text-[18px]">bookmark</span> Saved
               </button>
             </div>`
          : `<h3 class="font-label-lg text-label-lg text-on-surface px-1">Posts</h3>`
      }
      <div class="tab-content space-y-4"></div>
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
    },
    (error) => console.warn("Could not watch posts:", error)
  );

  // Posts / Saved tabs (own profile only)
  if (isMe && tabButtons.length) {
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

      tabContent.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Loading saved posts...</p>`;
      try {
        const saved = await loadSavedPosts(db, uid);
        // The user may have switched tabs while loading
        if (activeTab !== "saved") return;
        tabContent.innerHTML = saved.length
          ? saved.map((post) => postCardHtml(post, { showAuthor: true, showUnsave: true })).join("")
          : SAVED_EMPTY_HTML;
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

    photoBtn.addEventListener("click", () => photoInput.click());

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
            { key: "share", label: "Share profile", icon: "share" }
          ]);

          if (choice === "block") {
            const ok = await blockAccount({ db, me: currentUser.uid, user: { uid, name, username: user.username || "" }, followingIds: ctx.followingIds || {} });
            if (ok) mount(container, ctx);
          } else if (choice === "unblock") {
            if (await unblockAccount({ db, me: currentUser.uid, uid, name: handle })) mount(container, ctx);
          } else if (choice === "share") {
            shareProfile({ uid, name, username: user.username || "" });
          }
        }
      }
    ]);
  }

  const shareBtn = container.querySelector(".share-profile");
  if (shareBtn) shareBtn.addEventListener("click", () => shareProfile({ uid, name, username: user.username || "" }));

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