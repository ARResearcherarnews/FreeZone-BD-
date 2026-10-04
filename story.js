// FreeZone BD - Stories (photo stories that disappear after 24 hours)
//
// Everything about stories lives in this file: the bar at the top of the Feed, the full-screen
// viewer and adding a story. feed.js only calls  mount(container, context)  once, so changing
// this file never requires changing feed.js.
//
// Data (Firebase Realtime Database):
//   stories/{uid}/{storyId}                   = { imageURL, caption?, createdAt }
//   storyViews/{uid}/{storyId}/{viewerUid}    = time      (only the owner can read it -> "N views")
//   storyReactions/{uid}/{storyId}/{viewerUid} = emoji   (the owner sees who reacted; a viewer sees their own)
//   storySeen/{myUid}/{authorUid}             = createdAt of the newest story of that person I have seen
// Replies and reactions are also sent as chat messages to the owner (see chat.js), with the story attached.
// Who sees whose stories: you see your own and the stories of people YOU FOLLOW.

import {
  ref,
  get,
  push,
  set,
  update,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb, prepareImage } from "./imgbb.js";
import { sendChatMessage } from "./chat.js";
import { escapeHtml, avatarHtml, timeAgo, showToast } from "./post.js";

const TTL_MS = 24 * 60 * 60 * 1000; // a story lives 24 hours
const SLIDE_MS = 5000; // each story is shown for 5 seconds
const MAX_FOLLOWED = 40; // stories of at most this many followed people are loaded
const MAX_FILE_MB = 10;
const CAPTION_MAX = 200;
const REFRESH_AFTER_MS = 2 * 60 * 1000; // reload the bar when the app comes back after 2 minutes
const REACTIONS = ["❤️", "😂", "😮", "😢", "👏", "🔥"];
const REPLY_MAX = 300;

function injectStyles() {
  if (document.getElementById("fz-story-style")) return;
  const style = document.createElement("style");
  style.id = "fz-story-style";
  style.textContent = `
    .fz-pop { animation: fz-pop .9s ease-out forwards; }
    @keyframes fz-pop {
      0% { transform: translateY(0) scale(.4); opacity: 0; }
      30% { transform: translateY(-20px) scale(1.25); opacity: 1; }
      100% { transform: translateY(-120px) scale(1); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

const userCache = new Map();

async function readUser(db, uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  try {
    const snap = await get(ref(db, `users/${uid}`));
    const data = snap.exists() ? snap.val() : null;
    const user = data ? { uid, name: data.name || "FreeZone User", username: data.username || "", photoURL: data.photoURL || "" } : null;
    userCache.set(uid, user);
    return user;
  } catch (error) {
    return null;
  }
}

/* ---------------------------------------------------------------
   Mount
---------------------------------------------------------------- */
/**
 * @param {HTMLElement} container  where the stories bar is drawn
 * @param {object} ctx  { db, currentUser, currentProfile, followingIds, openProfile? }
 */
export async function mount(container, ctx = {}) {
  const { db, currentUser } = ctx;
  if (!container || !db || !currentUser) return;

  const me = currentUser.uid;
  let groups = []; // people (other than me) who have stories, plus me when I have some
  let seen = {}; // authorUid -> createdAt of the newest story already seen
  let loadedAt = 0;
  const viewedThisSession = new Set();

  const myProfile = () => ctx.currentProfile || { name: "You", username: "", photoURL: "" };

  /* =============================================================
     Loading
  ============================================================= */
  const readStories = async (uid, cutoff) => {
    try {
      const snap = await get(ref(db, `stories/${uid}`));
      const stories = [];
      const expired = {};
      snap.forEach((child) => {
        const value = child.val() || {};
        if (!value.imageURL) return;
        const createdAt = Number(value.createdAt) || 0;
        if (createdAt >= cutoff) {
          stories.push({ id: child.key, imageURL: value.imageURL, caption: value.caption || "", createdAt });
        } else if (uid === me) {
          expired[`stories/${uid}/${child.key}`] = null; // my own expired stories are cleaned up
          expired[`storyViews/${uid}/${child.key}`] = null;
          expired[`storyReactions/${uid}/${child.key}`] = null;
        }
      });
      stories.sort((a, b) => a.createdAt - b.createdAt);
      return { uid, stories, expired };
    } catch (error) {
      return { uid, stories: [], expired: {} }; // no permission or no network: just no stories
    }
  };

  const loadGroups = async () => {
    const cutoff = Date.now() - TTL_MS;
    const followed = Object.keys(ctx.followingIds || {}).filter((id) => id !== me).slice(0, MAX_FOLLOWED);

    const [seenSnap, results] = await Promise.all([
      get(ref(db, `storySeen/${me}`)).catch(() => null),
      Promise.all([me, ...followed].map((uid) => readStories(uid, cutoff)))
    ]);
    seen = seenSnap && seenSnap.exists() ? seenSnap.val() : {};

    const expired = Object.assign({}, ...results.map((result) => result.expired));
    if (Object.keys(expired).length) update(ref(db), expired).catch(() => {});

    const found = await Promise.all(
      results
        .filter((result) => result.stories.length)
        .map(async (result) => ({
          uid: result.uid,
          isMine: result.uid === me,
          user: result.uid === me ? myProfile() : await readUser(db, result.uid),
          stories: result.stories
        }))
    );

    const others = found.filter((group) => !group.isMine && group.user);
    const newest = (group) => group.stories[group.stories.length - 1].createdAt;
    others.sort((a, b) => Number(hasUnseen(b)) - Number(hasUnseen(a)) || newest(b) - newest(a));

    const mine = found.find((group) => group.isMine);
    return mine ? [mine, ...others] : others;
  };

  const hasUnseen = (group) => !group.isMine && group.stories[group.stories.length - 1].createdAt > (Number(seen[group.uid]) || 0);

  const reload = async () => {
    try {
      groups = await loadGroups();
    } catch (error) {
      console.warn("Stories: could not load:", error?.code || error);
    }
    loadedAt = Date.now();
    renderBar();
  };

  /* =============================================================
     The bar
  ============================================================= */
  const ringed = (ringClass, inner) => `
    <div class="p-[2.5px] rounded-full ${ringClass}">
      <div class="p-[2px] rounded-full bg-slate-surface">${inner}</div>
    </div>`;

  const renderBar = () => {
    const mine = groups.find((group) => group.isMine);
    const me_ = myProfile();

    // "Your story" shows my stories; a separate "Add story" card next to it adds a new one
    const addItem = (withAvatar) => `
      <div class="fz-story-item flex-shrink-0 w-[72px] flex flex-col items-center gap-1.5 cursor-pointer" role="button" tabindex="0" data-action="add" aria-label="Add a story">
        <div class="relative">
          ${
            withAvatar
              ? `${ringed("bg-transparent", avatarHtml(me_.photoURL, "w-14 h-14"))}
                 <span class="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-primary-container text-white ring-2 ring-white flex items-center justify-center">
                   <span class="material-symbols-outlined text-[16px] pointer-events-none">add</span>
                 </span>`
              : `<div class="w-[66px] h-[66px] rounded-full border-2 border-dashed border-primary-container bg-primary-fixed/30 flex items-center justify-center text-primary">
                   <span class="material-symbols-outlined text-[30px] pointer-events-none">add</span>
                 </div>`
          }
        </div>
        <span class="w-full text-center text-[12px] ${withAvatar ? "text-on-surface" : "text-primary font-semibold"} truncate">Add story</span>
      </div>`;

    // "Your story" shows the picture of my newest story (not my profile photo)
    const yourItem = mine
      ? `
      <div class="fz-story-item flex-shrink-0 w-[72px] flex flex-col items-center gap-1.5 cursor-pointer" role="button" tabindex="0" data-action="open" data-uid="${escapeHtml(me)}" aria-label="View your story">
        ${ringed(
          "bg-gradient-to-tr from-primary-container via-sky-400 to-emerald-400",
          `<div class="relative w-14 h-14 rounded-full overflow-hidden bg-surface-container">
             <img src="${escapeHtml(mine.stories[mine.stories.length - 1].imageURL)}" alt="" class="absolute inset-0 w-full h-full object-cover" onerror="this.remove()" />
           </div>`
        )}
        <span class="w-full text-center text-[12px] text-on-surface font-semibold truncate">Your story</span>
      </div>`
      : "";

    // "Add story" is the first (left) card; before the first story it carries my profile photo with a +
    const firstItems = mine ? `${addItem(false)}${yourItem}` : addItem(true);

    const others = groups
      .filter((group) => !group.isMine)
      .map((group) => {
        const label = group.user.username ? group.user.username : group.user.name.split(" ")[0];
        return `
        <div class="fz-story-item flex-shrink-0 w-[72px] flex flex-col items-center gap-1.5 cursor-pointer" role="button" tabindex="0" data-action="open" data-uid="${escapeHtml(group.uid)}" aria-label="View ${escapeHtml(group.user.name)}'s story">
          ${ringed(hasUnseen(group) ? "bg-gradient-to-tr from-primary-container via-sky-400 to-emerald-400" : "bg-slate-border", avatarHtml(group.user.photoURL, "w-14 h-14"))}
          <span class="w-full text-center text-[12px] ${hasUnseen(group) ? "text-on-surface font-semibold" : "text-slate-muted"} truncate">${escapeHtml(label)}</span>
        </div>`;
      })
      .join("");

    container.innerHTML = `
      <div class="fz-stories flex gap-3 overflow-x-auto px-3 py-3 bg-slate-surface border border-slate-border rounded-2xl shadow-sm [&::-webkit-scrollbar]:hidden" style="scrollbar-width:none;">
        ${firstItems}${others}
      </div>`;
  };

  const showSkeleton = () => {
    container.innerHTML = `
      <div class="flex gap-3 overflow-hidden px-3 py-3 bg-slate-surface border border-slate-border rounded-2xl shadow-sm">
        ${Array.from({ length: 5 })
          .map(
            () => `<div class="flex-shrink-0 w-[72px] flex flex-col items-center gap-2"><div class="skeleton w-[66px] h-[66px] rounded-full"></div><div class="skeleton h-2.5 w-12 rounded"></div></div>`
          )
          .join("")}
      </div>`;
  };

  container.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="add"]')) return pickImage();

    const item = event.target.closest('[data-action="open"]');
    if (!item) return;
    const index = groups.findIndex((group) => group.uid === item.dataset.uid);
    if (index === -1) return pickImage(); // no story of mine yet: tapping "Your story" adds one
    openViewer(index);
  });

  container.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      const item = event.target.closest('[data-action="open"]');
      if (item) {
        event.preventDefault();
        item.click();
      }
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - loadedAt > REFRESH_AFTER_MS) reload();
  });

  /* =============================================================
     Adding a story
  ============================================================= */
  function pickImage() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) return showToast("Please choose an image");
      if (file.size > MAX_FILE_MB * 1024 * 1024) return showToast(`Image is too large (max ${MAX_FILE_MB} MB)`);

      try {
        openComposer(await prepareImage(file));
      } catch (error) {
        console.error(error);
        showToast("Could not open this image");
      }
    });
    input.click();
  }

  function openComposer(blob) {
    const previewUrl = URL.createObjectURL(blob);
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9997] bg-black flex flex-col";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "New story");
    overlay.innerHTML = `
      <div class="flex items-center justify-between px-3" style="padding-top:max(0.75rem, env(safe-area-inset-top));">
        <button type="button" class="fz-c-close w-10 h-10 rounded-full flex items-center justify-center text-white hover:bg-white/10" aria-label="Cancel">
          <span class="material-symbols-outlined">close</span>
        </button>
        <span class="text-white font-label-lg text-label-lg">New story</span>
        <span class="w-10"></span>
      </div>
      <div class="flex-1 min-h-0 flex items-center justify-center p-3">
        <img src="${previewUrl}" alt="Story preview" class="max-w-full max-h-full object-contain rounded-2xl" />
      </div>
      <div class="px-4 pt-2 space-y-3" style="padding-bottom:max(1rem, env(safe-area-inset-bottom));">
        <textarea class="fz-c-caption w-full resize-none rounded-2xl bg-white/10 text-white placeholder:text-white/50 px-4 py-3 text-[16px] outline-none focus:bg-white/15" rows="2" maxlength="${CAPTION_MAX}" placeholder="Add a caption (optional)"></textarea>
        <button type="button" class="fz-c-share w-full py-3 rounded-xl bg-primary-container text-white font-label-lg text-label-lg font-semibold active:scale-[.98] transition-all disabled:opacity-60">Share story</button>
      </div>`;

    const close = () => {
      URL.revokeObjectURL(previewUrl);
      overlay.remove();
    };
    overlay.querySelector(".fz-c-close").addEventListener("click", close);

    const shareBtn = overlay.querySelector(".fz-c-share");
    shareBtn.addEventListener("click", async () => {
      shareBtn.disabled = true;
      shareBtn.textContent = "Sharing...";
      try {
        const imageURL = await uploadToImgbb(blob, "story.jpg", {
          onProgress: (fraction) => {
            shareBtn.textContent = fraction < 1 ? `Sharing ${Math.round(fraction * 100)}%` : "Finishing...";
          }
        });
        const caption = overlay.querySelector(".fz-c-caption").value.trim();
        const storyRef = push(ref(db, `stories/${me}`));
        await set(storyRef, { imageURL, ...(caption ? { caption } : {}), createdAt: serverTimestamp() });
        close();
        showToast("Story shared");
        await reload();
      } catch (error) {
        console.error(error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not share: database rules block it" : "Could not share your story. Try again.");
        shareBtn.disabled = false;
        shareBtn.textContent = "Share story";
      }
    });

    document.body.appendChild(overlay);
  }

  /* =============================================================
     The viewer
  ============================================================= */
  function openViewer(startGroup) {
    let gi = startGroup; // which person
    let si = 0; // which of their stories
    let raf = null;
    let last = 0;
    let elapsed = 0;
    let paused = false;
    let ready = false;
    let closed = false;
    let inputPause = false; // typing a reply or reading the viewers list also pauses the story
    const myReactions = new Map(); // storyId -> emoji I reacted with ("" = none)
    const previousOverflow = document.body.style.overflow;

    // Start with the first story the person has not seen yet
    const startGroupData = groups[gi];
    if (startGroupData && !startGroupData.isMine) {
      const seenUpTo = Number(seen[startGroupData.uid]) || 0;
      const firstUnseen = startGroupData.stories.findIndex((story) => story.createdAt > seenUpTo);
      si = firstUnseen === -1 ? 0 : firstUnseen;
    }

    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9997] bg-black flex flex-col select-none touch-none";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Story viewer");
    overlay.innerHTML = `
      <div class="absolute top-0 inset-x-0 z-20 px-3 pb-8 bg-gradient-to-b from-black/70 to-transparent" style="padding-top:max(0.75rem, env(safe-area-inset-top));">
        <div class="fz-bars flex gap-1"></div>
        <div class="flex items-center justify-between mt-3">
          <div class="fz-author flex items-center gap-2.5 min-w-0"></div>
          <div class="flex items-center flex-shrink-0">
            <button type="button" class="fz-delete hidden w-10 h-10 rounded-full items-center justify-center text-white hover:bg-white/10" aria-label="Delete story"><span class="material-symbols-outlined">delete</span></button>
            <button type="button" class="fz-close w-10 h-10 rounded-full flex items-center justify-center text-white hover:bg-white/10" aria-label="Close"><span class="material-symbols-outlined">close</span></button>
          </div>
        </div>
      </div>

      <div class="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        <img class="fz-img max-w-full max-h-full object-contain" alt="" />
        <div class="fz-spinner absolute w-9 h-9 rounded-full border-[3px] border-white/25 border-t-white animate-spin"></div>
      </div>

      <div class="absolute bottom-0 inset-x-0 z-20 px-4 pt-12 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" style="padding-bottom:max(1rem, env(safe-area-inset-bottom));">
        <p class="fz-caption hidden text-white text-[16px] leading-snug text-center whitespace-pre-wrap break-words px-1"></p>
        <div class="fz-views hidden mt-3 items-center justify-center gap-1.5 text-white/90 text-[13px] pointer-events-auto cursor-pointer" role="button" tabindex="0" aria-label="See who viewed this story"></div>

        <div class="fz-reply hidden pointer-events-auto mt-3 space-y-3">
          <div class="fz-reactions flex items-center justify-center gap-2"></div>
          <div class="flex items-center gap-2">
            <input type="text" class="fz-reply-input flex-1 min-w-0 bg-white/10 border border-white/30 focus:border-white rounded-full px-4 py-2.5 text-white placeholder:text-white/60 text-[16px] outline-none" maxlength="${REPLY_MAX}" autocomplete="off" />
            <button type="button" class="fz-reply-send flex-shrink-0 w-11 h-11 rounded-full bg-primary-container text-white flex items-center justify-center active:scale-90 transition-all disabled:opacity-40" aria-label="Send reply" disabled>
              <span class="material-symbols-outlined text-[22px]" style="font-variation-settings:'FILL' 1;">send</span>
            </button>
          </div>
        </div>
      </div>

      <div class="fz-tap absolute inset-0 z-10"></div>`;

    const barsEl = overlay.querySelector(".fz-bars");
    const authorEl = overlay.querySelector(".fz-author");
    const imgEl = overlay.querySelector(".fz-img");
    const spinnerEl = overlay.querySelector(".fz-spinner");
    const captionEl = overlay.querySelector(".fz-caption");
    const viewsEl = overlay.querySelector(".fz-views");
    const deleteBtn = overlay.querySelector(".fz-delete");
    const tapEl = overlay.querySelector(".fz-tap");
    const replyEl = overlay.querySelector(".fz-reply");
    const reactionsEl = overlay.querySelector(".fz-reactions");
    const replyInput = overlay.querySelector(".fz-reply-input");
    const replySend = overlay.querySelector(".fz-reply-send");

    const group = () => groups[gi];
    const story = () => group().stories[si];

    /* ---- progress ---- */
    const setProgress = (fraction) => {
      const bar = barsEl.children[si]?.firstElementChild;
      if (bar) bar.style.width = `${Math.min(100, fraction * 100)}%`;
    };

    const buildBars = () => {
      barsEl.innerHTML = group()
        .stories.map(() => `<div class="flex-1 h-[3px] rounded-full bg-white/30 overflow-hidden"><div class="h-full bg-white" style="width:0%"></div></div>`)
        .join("");
    };

    const paintBars = () => {
      Array.from(barsEl.children).forEach((segment, index) => {
        segment.firstElementChild.style.width = index < si ? "100%" : "0%";
      });
    };

    const tick = (timestamp) => {
      if (closed) return;
      if (!last) last = timestamp;
      const delta = timestamp - last;
      last = timestamp;

      if (!paused && !inputPause && ready) {
        elapsed += delta;
        setProgress(elapsed / SLIDE_MS);
        if (elapsed >= SLIDE_MS) return next();
      }
      raf = requestAnimationFrame(tick);
    };

    const restartTimer = () => {
      cancelAnimationFrame(raf);
      elapsed = 0;
      last = 0;
      raf = requestAnimationFrame(tick);
    };

    /* ---- showing one story ---- */
    const markSeen = (currentGroup, currentStory) => {
      if (currentGroup.isMine) return;
      if ((Number(seen[currentGroup.uid]) || 0) < currentStory.createdAt) {
        seen[currentGroup.uid] = currentStory.createdAt;
        update(ref(db), { [`storySeen/${me}/${currentGroup.uid}`]: currentStory.createdAt }).catch(() => {});
      }
      const key = `${currentGroup.uid}/${currentStory.id}`;
      if (!viewedThisSession.has(key)) {
        viewedThisSession.add(key);
        update(ref(db), { [`storyViews/${currentGroup.uid}/${currentStory.id}/${me}`]: serverTimestamp() }).catch(() => {});
      }
    };

    const showViews = async (currentStory) => {
      viewsEl.classList.remove("hidden");
      viewsEl.classList.add("flex");
      viewsEl.innerHTML = `<span class="material-symbols-outlined text-[18px]">visibility</span><span class="fz-views-text">...</span>`;
      try {
        const [viewsSnap, reactSnap] = await Promise.all([
          get(ref(db, `storyViews/${me}/${currentStory.id}`)),
          get(ref(db, `storyReactions/${me}/${currentStory.id}`)).catch(() => null)
        ]);
        if (closed || story().id !== currentStory.id) return;

        const views = viewsSnap.exists() ? viewsSnap.size : 0;
        const reactions = reactSnap && reactSnap.exists() ? Object.values(reactSnap.val()) : [];
        let text = views === 1 ? "1 view" : `${views} views`;
        if (reactions.length) text += ` · ${[...new Set(reactions)].slice(0, 3).join("")} ${reactions.length}`;
        viewsEl.querySelector(".fz-views-text").textContent = text;
      } catch (error) {
        viewsEl.classList.add("hidden");
        viewsEl.classList.remove("flex");
      }
    };

    // Who viewed my story, and with which reaction
    const openViewersSheet = async (targetStory) => {
      inputPause = true;
      const sheet = document.createElement("div");
      sheet.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/50";
      sheet.innerHTML = `
        <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[75vh] flex flex-col" role="dialog" aria-modal="true" aria-label="Viewers">
          <div class="flex items-center justify-between px-5 pt-4 pb-2">
            <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Viewers</h2>
            <button type="button" class="fz-v-close w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close"><span class="material-symbols-outlined text-[20px]">close</span></button>
          </div>
          <div class="fz-v-list overflow-y-auto px-2 pb-5"><p class="text-center text-slate-muted font-body-md text-body-md py-8">Loading...</p></div>
        </div>`;

      const closeSheet = () => {
        sheet.remove();
        inputPause = false;
      };
      sheet.addEventListener("click", (event) => {
        event.stopPropagation();
        if (event.target === sheet || event.target.closest(".fz-v-close")) closeSheet();
      });
      document.body.appendChild(sheet);

      const listEl = sheet.querySelector(".fz-v-list");
      try {
        const [viewsSnap, reactSnap] = await Promise.all([
          get(ref(db, `storyViews/${me}/${targetStory.id}`)),
          get(ref(db, `storyReactions/${me}/${targetStory.id}`)).catch(() => null)
        ]);
        const views = viewsSnap.exists() ? viewsSnap.val() : {};
        const reactions = reactSnap && reactSnap.exists() ? reactSnap.val() : {};
        const ids = [...new Set([...Object.keys(views), ...Object.keys(reactions)])]
          .sort((a, b) => (Number(views[b]) || 0) - (Number(views[a]) || 0))
          .slice(0, 100);
        const users = await Promise.all(ids.map((id) => readUser(db, id)));

        const rows = ids
          .map((id, index) => ({ id, user: users[index] }))
          .filter((row) => row.user)
          .map(
            ({ id, user }) => `
          <div class="flex items-center gap-3 px-3 py-2.5">
            ${avatarHtml(user.photoURL, "w-10 h-10")}
            <div class="min-w-0 flex-1">
              <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(user.name)}</div>
              <div class="font-body-sm text-body-sm text-slate-muted truncate">${user.username ? "@" + escapeHtml(user.username) + " · " : ""}${views[id] ? timeAgo(Number(views[id])) : ""}</div>
            </div>
            ${reactions[id] ? `<span class="text-[24px] flex-shrink-0">${escapeHtml(reactions[id])}</span>` : ""}
          </div>`
          )
          .join("");
        listEl.innerHTML = rows || `<p class="text-center text-slate-muted font-body-md text-body-md py-8">No views yet.</p>`;
      } catch (error) {
        listEl.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-8">Could not load the viewers.</p>`;
      }
    };

    // ---- reactions and replies to other people's stories ----
    const renderReactions = () => {
      const current = myReactions.get(story().id) || "";
      reactionsEl.innerHTML = REACTIONS.map(
        (emoji) =>
          `<button type="button" data-emoji="${emoji}" class="w-11 h-11 rounded-full flex items-center justify-center text-[24px] ${
            emoji === current ? "bg-white/25 ring-2 ring-white" : "bg-white/10"
          } active:scale-90 transition-transform" aria-label="React ${emoji}">${emoji}</button>`
      ).join("");
    };

    const loadMyReaction = async (currentGroup, currentStory) => {
      if (!myReactions.has(currentStory.id)) {
        try {
          const snap = await get(ref(db, `storyReactions/${currentGroup.uid}/${currentStory.id}/${me}`));
          myReactions.set(currentStory.id, snap.exists() ? snap.val() : "");
        } catch (error) {
          myReactions.set(currentStory.id, "");
        }
      }
      if (!closed && story().id === currentStory.id) renderReactions();
    };

    const storyRef = (currentGroup, currentStory) => ({ id: currentStory.id, imageURL: currentStory.imageURL, ownerUid: currentGroup.uid });

    const popEmoji = (emoji) => {
      const el = document.createElement("div");
      el.className = "fz-pop pointer-events-none absolute left-1/2 top-1/2 z-30 text-[72px] leading-none";
      el.style.marginLeft = "-36px";
      el.textContent = emoji;
      overlay.appendChild(el);
      setTimeout(() => el.remove(), 950);
    };

    const react = async (emoji) => {
      const currentGroup = group();
      const currentStory = story();
      popEmoji(emoji);
      if (myReactions.get(currentStory.id) === emoji) return; // the same reaction is not sent twice

      const before = myReactions.get(currentStory.id) || "";
      myReactions.set(currentStory.id, emoji);
      renderReactions();

      try {
        await Promise.all([
          update(ref(db), { [`storyReactions/${currentGroup.uid}/${currentStory.id}/${me}`]: emoji }),
          sendChatMessage(db, me, currentGroup.uid, emoji, { story: storyRef(currentGroup, currentStory), reaction: true }, `Reacted ${emoji} to a story`)
        ]);
      } catch (error) {
        console.error("Story reaction:", error);
        myReactions.set(currentStory.id, before);
        if (!closed && story().id === currentStory.id) renderReactions();
        showToast(error.code === "PERMISSION_DENIED" ? "Could not react: database rules block it" : "Could not send your reaction");
      }
    };

    const sendReply = async () => {
      const text = replyInput.value.trim();
      if (!text) return;
      const currentGroup = group();
      const currentStory = story();

      replySend.disabled = true;
      try {
        await sendChatMessage(db, me, currentGroup.uid, text, { story: storyRef(currentGroup, currentStory) }, `Story reply: ${text}`);
        replyInput.value = "";
        replyInput.blur();
        inputPause = false;
        showToast("Reply sent");
      } catch (error) {
        console.error("Story reply:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not reply: database rules block it" : "Could not send your reply");
      }
      replySend.disabled = !replyInput.value.trim();
    };

    reactionsEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-emoji]");
      if (button) react(button.dataset.emoji);
    });
    const updateInputPause = () => {
      inputPause = document.activeElement === replyInput || replyInput.value.trim() !== "";
      replySend.disabled = !replyInput.value.trim();
    };
    replyInput.addEventListener("focus", updateInputPause);
    replyInput.addEventListener("blur", updateInputPause);
    replyInput.addEventListener("input", updateInputPause);
    replyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendReply();
      }
    });
    replySend.addEventListener("click", sendReply);
    viewsEl.addEventListener("click", () => openViewersSheet(story()));

    const showStory = () => {
      const currentGroup = group();
      const currentStory = story();

      paintBars();
      ready = false;
      spinnerEl.classList.remove("hidden");
      imgEl.style.opacity = "0";
      imgEl.onload = () => {
        if (closed) return;
        spinnerEl.classList.add("hidden");
        imgEl.style.opacity = "1";
        ready = true;
      };
      imgEl.onerror = () => {
        if (closed) return;
        showToast("Could not load this story");
        next();
      };
      imgEl.src = currentStory.imageURL;

      authorEl.innerHTML = `
        ${avatarHtml(currentGroup.user.photoURL, "w-9 h-9")}
        <div class="min-w-0">
          <div class="text-white font-label-lg text-label-lg truncate">${escapeHtml(currentGroup.isMine ? "Your story" : currentGroup.user.username ? "@" + currentGroup.user.username : currentGroup.user.name)}</div>
          <div class="text-white/70 text-[12px]">${timeAgo(currentStory.createdAt)}</div>
        </div>`;

      captionEl.textContent = currentStory.caption;
      captionEl.classList.toggle("hidden", !currentStory.caption);

      deleteBtn.classList.toggle("hidden", !currentGroup.isMine);
      deleteBtn.classList.toggle("flex", currentGroup.isMine);

      viewsEl.classList.add("hidden");
      viewsEl.classList.remove("flex");

      // Other people's stories can be replied to and reacted to; my own show who viewed them
      const canReply = !currentGroup.isMine;
      replyEl.classList.toggle("hidden", !canReply);
      replyInput.value = "";
      inputPause = false;
      replySend.disabled = true;
      if (canReply) {
        replyInput.placeholder = `Reply to ${currentGroup.user.username ? "@" + currentGroup.user.username : currentGroup.user.name}...`;
        renderReactions();
        loadMyReaction(currentGroup, currentStory);
      }

      if (currentGroup.isMine) showViews(currentStory);
      else markSeen(currentGroup, currentStory);

      restartTimer();
    };

    /* ---- moving around ---- */
    const close = () => {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisibility);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", fitToViewport);
        window.visualViewport.removeEventListener("scroll", fitToViewport);
      }
      document.body.style.overflow = previousOverflow;
      overlay.remove();
      renderBar(); // rings turn grey for the stories that were seen
    };

    function next() {
      if (si < group().stories.length - 1) {
        si++;
        setProgress(1);
        return showStory();
      }
      if (gi < groups.length - 1) {
        gi++;
        si = 0;
        buildBars();
        return showStory();
      }
      close();
    }

    const previous = () => {
      if (si > 0) {
        si--;
        return showStory();
      }
      if (gi > 0) {
        gi--;
        si = 0;
        buildBars();
      }
      showStory();
    };

    /* ---- input ---- */
    let pressStart = 0;
    let pressX = 0;
    let pressY = 0;

    tapEl.addEventListener("pointerdown", (event) => {
      pressStart = Date.now();
      pressX = event.clientX;
      pressY = event.clientY;
      paused = true; // holding a finger on the screen pauses the story
    });

    const release = (event) => {
      paused = false;
      const held = Date.now() - pressStart;
      const dx = Math.abs(event.clientX - pressX);
      const dy = event.clientY - pressY;

      if (dy > 90 && dy > dx) return close(); // swipe down closes
      if (held < 250 && dx < 12 && Math.abs(dy) < 12) {
        const width = overlay.clientWidth || window.innerWidth;
        if (event.clientX < width * 0.33) previous();
        else next();
      }
    };
    tapEl.addEventListener("pointerup", release);
    tapEl.addEventListener("pointercancel", () => (paused = false));

    overlay.querySelector(".fz-close").addEventListener("click", close);

    authorEl.addEventListener("click", () => {
      if (group().isMine || !ctx.openProfile) return;
      const uid = group().uid;
      close();
      ctx.openProfile(uid);
    });

    deleteBtn.addEventListener("click", async () => {
      paused = true;
      if (!confirm("Delete this story?")) {
        paused = false;
        return;
      }

      const target = story();
      try {
        await update(ref(db), {
          [`stories/${me}/${target.id}`]: null,
          [`storyViews/${me}/${target.id}`]: null,
          [`storyReactions/${me}/${target.id}`]: null
        });
      } catch (error) {
        console.error(error);
        showToast("Could not delete the story. Try again.");
        paused = false;
        return;
      }

      const current = group();
      current.stories.splice(si, 1);
      showToast("Story deleted");

      if (!current.stories.length) {
        groups = groups.filter((item) => item !== current);
        close();
        return;
      }
      si = Math.min(si, current.stories.length - 1);
      buildBars();
      paused = false;
      showStory();
    });

    const onKey = (event) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight") next();
      else if (event.key === "ArrowLeft") previous();
    };
    const onVisibility = () => {
      paused = document.visibilityState !== "visible";
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisibility);

    // On phones the keyboard covers the bottom of the screen: follow the visible area
    const viewport = window.visualViewport;
    const fitToViewport = () => {
      if (!viewport) return;
      overlay.style.bottom = "auto";
      overlay.style.top = `${viewport.offsetTop}px`;
      overlay.style.height = `${viewport.height}px`;
    };
    if (viewport) {
      viewport.addEventListener("resize", fitToViewport);
      viewport.addEventListener("scroll", fitToViewport);
    }

    injectStyles();
    document.body.style.overflow = "hidden";
    document.body.appendChild(overlay);
    buildBars();
    showStory();
  }

  /* =============================================================
     Start
  ============================================================= */
  showSkeleton();
  await reload();
}