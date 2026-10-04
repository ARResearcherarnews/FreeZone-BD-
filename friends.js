// FreeZone BD - Friends view: Suggestions, Followers, Following and Find people (with Message / Remove follower / Unfollow menu)
// Loaded on demand (dynamic import) from feed.js so it never slows down the initial Feed load.

import {
  ref,
  get,
  update,
  query,
  orderByChild,
  startAt,
  endAt,
  limitToFirst,
  limitToLast
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, showToast } from "./post.js";
import { isBlocked } from "./block.js";

const PAGE_SIZE = 20; // profiles loaded per "Show more"
const SEARCH_CAP = 300; // most profiles loaded when the person filters their own lists
const FIND_MIN_CHARS = 2; // letters needed before searching the whole app
const FIND_LIMIT = 20; // results per search query
const SUGGEST_CACHE_MS = 3 * 60 * 1000; // reuse suggestions for 3 minutes (e.g. when coming back from a profile)
const DISMISSED_KEY = "fz_dismissed_suggestions";

let lastTab = "suggestions"; // remembered, so coming back from a profile opens the same tab
const lastFind = { text: "", results: [], state: "idle" }; // ...and the same search results
let suggestCache = { time: 0, items: null };
const userCache = new Map(); // uid -> { uid, name, username, photoURL } or null when the account is gone

/* ---------------------------------------------------------------
   Data
---------------------------------------------------------------- */
// ids from following/{uid} or followers/{uid}, newest first
async function readIds(db, path) {
  const snap = await get(ref(db, path));
  if (!snap.exists()) return [];
  const time = (value) => (typeof value === "number" ? value : 0);
  return Object.entries(snap.val())
    .sort((a, b) => time(b[1]) - time(a[1]))
    .map(([id]) => id);
}

async function readUser(db, uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  let user = null;
  try {
    const snap = await get(ref(db, `users/${uid}`));
    if (snap.exists()) {
      const data = snap.val();
      user = {
        uid,
        name: data.name || "FreeZone User",
        username: data.username || "",
        photoURL: data.photoURL || ""
      };
    }
  } catch (error) {
    console.warn("Friends: could not read user", uid, error?.code || error);
    return null; // not cached, so a later try can succeed
  }
  userCache.set(uid, user);
  return user;
}

// Searches every user by the beginning of their @username or name.
// Firebase can only match the start of a value, so "rah" finds "rahim" and "Rahim Uddin", not "Abdur Rahim".
// Needs  "users": { ".indexOn": ["username", "name", "nameLower"] }  in the database rules to be fast.
async function searchUsers(db, raw, me) {
  const q = raw.trim().replace(/^@/, "");
  const lower = q.toLowerCase();
  const capitalized = q.charAt(0).toUpperCase() + q.slice(1);

  const byPrefix = (field, value) =>
    get(query(ref(db, "users"), orderByChild(field), startAt(value), endAt(value + "\uf8ff"), limitToFirst(FIND_LIMIT))).catch((error) => {
      console.warn(`Friends: search by ${field} failed:`, error?.code || error);
      return null;
    });

  const jobs = [byPrefix("username", lower), byPrefix("nameLower", lower), byPrefix("name", q)];
  if (capitalized !== q) jobs.push(byPrefix("name", capitalized));

  const snaps = await Promise.all(jobs);
  if (snaps.every((snap) => snap === null)) throw new Error("Search failed");

  const found = new Map();
  snaps.forEach((snap) => {
    if (!snap) return;
    snap.forEach((child) => {
      const uid = child.key;
      const data = child.val();
      if (uid === me || !data || found.has(uid) || isBlocked(uid)) return;
      const user = {
        uid,
        name: data.name || "FreeZone User",
        username: data.username || "",
        photoURL: data.photoURL || ""
      };
      userCache.set(uid, user);
      found.set(uid, user);
    });
  });

  // Exact @username first, then usernames that start with the text, then names
  const rank = (user) => {
    const username = user.username.toLowerCase();
    if (username === lower) return 0;
    if (username.startsWith(lower)) return 1;
    return 2;
  };
  return [...found.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 30);
}

// A pasted profile link (https://.../feed.html?u=abdul or ?profile=uid) is understood as a search
function parseProfileLink(text) {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    const username = url.searchParams.get("u");
    const uid = url.searchParams.get("profile");
    if (username) return { username: username.replace(/^@/, "").toLowerCase() };
    if (uid) return { uid };
  } catch (error) {
    // not a link
  }
  return null;
}

/* ---------------------------------------------------------------
   Suggestions ("People you may know")
---------------------------------------------------------------- */
const memoryDismissed = new Set();

function getDismissed() {
  try {
    return new Set([...JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]"), ...memoryDismissed]);
  } catch (error) {
    return new Set(memoryDismissed);
  }
}

function rememberDismissed(uid) {
  memoryDismissed.add(uid);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...getDismissed()].slice(-200)));
  } catch (error) {
    // Storage unavailable: the suggestion stays hidden until the page is reloaded
  }
}

// Ranks people from four sources; every source may fail without breaking the others:
//   1. people who follow you but you do not follow back      (score 100)
//   2. people followed by the people you follow              (score 10 per shared person)
//   3. people who posted recently                            (score 3)
//   4. people who joined recently                            (score 2)
async function buildSuggestions({ db, me, followingIds, followerIds, followingList }) {
  const dismissed = getDismissed();
  const candidates = new Map();

  const add = (uid, info, score, reason) => {
    if (!uid || uid === me || followingIds[uid] || dismissed.has(uid) || isBlocked(uid)) return;
    let candidate = candidates.get(uid);
    if (!candidate) {
      candidate = { uid, name: "", username: "", photoURL: "", score: 0, reason: "", reasonScore: -1 };
      candidates.set(uid, candidate);
    }
    if (info?.name) {
      candidate.name = info.name;
      candidate.username = info.username || "";
      candidate.photoURL = info.photoURL || "";
    }
    candidate.score += score;
    if (score > candidate.reasonScore) {
      candidate.reason = reason;
      candidate.reasonScore = score;
    }
  };

  let anySourceWorked = false;

  // 1. Followers you do not follow back
  followerIds.filter((id) => !followingIds[id]).slice(0, 10).forEach((id) => add(id, null, 100, "Follows you"));

  // 2. Friends of friends
  try {
    const seeds = followingList.slice(0, 8);
    const lists = await Promise.all(
      seeds.map((id) =>
        get(ref(db, `following/${id}`))
          .then((snap) => ({ id, ids: snap.exists() ? Object.keys(snap.val()) : [] }))
          .catch(() => null)
      )
    );

    const counts = new Map();
    lists.forEach((entry) => {
      if (!entry) return;
      anySourceWorked = true;
      entry.ids.forEach((target) => {
        if (target === me || followingIds[target]) return;
        const item = counts.get(target) || { n: 0, via: [] };
        item.n++;
        if (item.via.length < 2) item.via.push(entry.id);
        counts.set(target, item);
      });
    });

    const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    const viaIds = [...new Set(top.flatMap(([, item]) => item.via))];
    const viaUsers = new Map(await Promise.all(viaIds.map(async (id) => [id, await readUser(db, id)])));

    top.forEach(([uid, item]) => {
      const names = item.via.map((id) => viaUsers.get(id)?.name).filter(Boolean);
      let reason = `Followed by ${item.n} ${item.n === 1 ? "person" : "people"} you follow`;
      if (names.length) {
        const others = item.n - 1;
        reason = others === 0 ? `Followed by ${names[0]}` : `Followed by ${names[0]} and ${others} other${others === 1 ? "" : "s"}`;
      }
      add(uid, null, 10 * item.n, reason);
    });
  } catch (error) {
    console.warn("Suggestions: friends of friends failed:", error?.code || error);
  }

  // 3. Recently active people (their name and photo come with the post, so no extra reads)
  try {
    const snap = await get(query(ref(db, "posts"), orderByChild("createdAt"), limitToLast(40)));
    anySourceWorked = true;
    const posts = [];
    snap.forEach((child) => {
      posts.push(child.val());
    });
    const seen = new Set();
    posts.reverse().forEach((post) => {
      if (!post?.uid || seen.has(post.uid)) return;
      seen.add(post.uid);
      add(post.uid, { name: post.name, username: post.username, photoURL: post.photoURL }, 3, "Active recently");
    });
  } catch (error) {
    console.warn("Suggestions: recent posts failed:", error?.code || error);
  }

  // 4. New members
  try {
    const snap = await get(query(ref(db, "users"), orderByChild("createdAt"), limitToLast(12)));
    anySourceWorked = true;
    const users = [];
    snap.forEach((child) => {
      users.push([child.key, child.val()]);
    });
    users.reverse().forEach(([uid, user]) => {
      if (!user?.createdAt) return;
      add(uid, { name: user.name, username: user.username, photoURL: user.photoURL }, 2, "New to FreeZone");
    });
  } catch (error) {
    console.warn("Suggestions: new members failed:", error?.code || error);
  }

  if (!anySourceWorked && !candidates.size) throw new Error("Suggestions failed");

  // Fill in the name and photo of people found only by their id
  await Promise.all(
    [...candidates.values()]
      .filter((candidate) => !candidate.name)
      .map(async (candidate) => {
        const user = await readUser(db, candidate.uid);
        if (user) Object.assign(candidate, { name: user.name, username: user.username, photoURL: user.photoURL });
      })
  );

  return [...candidates.values()]
    .filter((candidate) => candidate.name)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 25);
}

// Bottom sheet that asks before removing a follower. Resolves true (remove) or false (cancel).
function confirmRemoveFollower(user) {
  return new Promise((resolve) => {
    const handle = user.username ? `@${user.username}` : user.name;
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-5" role="dialog" aria-modal="true" aria-label="Remove follower">
        <div class="flex items-center gap-3 mb-3">
          ${avatarHtml(user.photoURL, "w-12 h-12")}
          <div class="min-w-0">
            <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(user.name)}</div>
            ${user.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(user.username)}</div>` : ""}
          </div>
        </div>
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Remove follower?</h2>
        <p class="font-body-md text-body-md text-slate-muted mt-1">${escapeHtml(handle)} will stop following you. They will not be told, and they can follow you again.</p>
        <div class="flex gap-2.5 mt-5">
          <button type="button" class="rf-cancel flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-95 transition-all">Cancel</button>
          <button type="button" class="rf-confirm flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-white bg-error active:scale-95 transition-all">Remove</button>
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
    overlay.querySelector(".rf-cancel").addEventListener("click", () => close(false));
    overlay.querySelector(".rf-confirm").addEventListener("click", () => close(true));
    document.body.appendChild(overlay);
  });
}

// Bottom sheet with actions for one person. Resolves with the chosen action key, or null.
function openRowSheet(user, actions) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-4 pb-5" role="dialog" aria-modal="true">
        <div class="flex items-center gap-3 px-1 pb-3 mb-1 border-b border-slate-border/70">
          ${avatarHtml(user.photoURL, "w-11 h-11")}
          <div class="min-w-0">
            <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(user.name)}</div>
            ${user.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(user.username)}</div>` : ""}
          </div>
        </div>
        ${actions
          .map(
            (action) => `
          <button type="button" class="rs-action w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left font-body-md text-body-md hover:bg-surface-container-low active:bg-surface-container ${action.danger ? "text-error" : "text-on-surface"}" data-key="${action.key}">
            <span class="material-symbols-outlined text-[22px]">${action.icon}</span> ${escapeHtml(action.label)}
          </button>`
          )
          .join("")}
        <button type="button" class="rs-cancel w-full mt-2 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Cancel</button>
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
      const action = event.target.closest(".rs-action");
      if (action) close(action.dataset.key);
    });
    overlay.querySelector(".rs-cancel").addEventListener("click", () => close(null));
    document.body.appendChild(overlay);
  });
}

/* ---------------------------------------------------------------
   Markup
---------------------------------------------------------------- */
function skeletonRows(count = 6) {
  return Array.from({ length: count })
    .map(
      () => `
    <div class="flex items-center gap-3 px-4 py-3 bg-slate-surface rounded-2xl border border-slate-border">
      <div class="skeleton w-12 h-12 rounded-full flex-shrink-0"></div>
      <div class="flex-1 space-y-2">
        <div class="skeleton h-3.5 w-1/2 rounded"></div>
        <div class="skeleton h-3 w-1/3 rounded"></div>
      </div>
      <div class="skeleton h-8 w-20 rounded-full"></div>
    </div>`
    )
    .join("");
}

function emptyState(icon, title, text) {
  return `
    <div class="text-center py-14 px-6">
      <div class="w-16 h-16 mx-auto mb-3 rounded-2xl bg-surface-container flex items-center justify-center">
        <span class="material-symbols-outlined text-[30px] text-primary-container">${icon}</span>
      </div>
      <p class="font-headline-sm text-headline-sm text-on-surface font-semibold mb-1">${title}</p>
      <p class="font-body-md text-body-md text-slate-muted max-w-xs mx-auto">${text}</p>
    </div>`;
}

function followButtonHtml(isFollowing, followsMe) {
  if (isFollowing) {
    return `<button type="button" class="fz-follow flex-shrink-0 min-w-[84px] px-3.5 py-1.5 rounded-full bg-surface-container text-on-surface font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60">Following</button>`;
  }
  const label = followsMe ? "Follow back" : "Follow";
  return `<button type="button" class="fz-follow flex-shrink-0 min-w-[84px] px-3.5 py-1.5 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60">${label}</button>`;
}

/* ---------------------------------------------------------------
   View
---------------------------------------------------------------- */
export async function mount(container, context = {}) {
  const { db, currentUser, followingIds = {}, onToggleFollow, onOpenProfile, onOpenChat } = context;

  if (!db || !currentUser) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">Please log in to see your friends.</p>`;
    return;
  }

  const me = currentUser.uid;
  const tabs = {
    followers: { key: "followers", ids: [], users: [], cursor: 0 },
    following: { key: "following", ids: [], users: [], cursor: 0 }
  };
  const find = lastFind; // state: idle | loading | done | error
  if (find.state === "loading") find.state = "idle";
  const suggest = { state: "idle", items: [] }; // state: idle | loading | done | error
  let suggestToken = 0;
  let findToken = 0;
  let activeTab = lastTab;
  let filter = "";
  let busy = false;

  container.innerHTML = `
    <div class="fz-friends flex flex-col min-h-full">
      <div class="sticky top-0 z-10 bg-background px-3 sm:px-4 pt-3 pb-2 space-y-3">
        <div class="fz-searchwrap relative">
          <span class="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-muted pointer-events-none">search</span>
          <input type="search" class="fz-search w-full bg-slate-surface border border-slate-border focus:border-primary-container focus:ring-2 focus:ring-primary-container/15 rounded-full py-2.5 pl-11 pr-4 text-[16px] outline-none" placeholder="Filter this list by name or @username" autocomplete="off" autocapitalize="none" spellcheck="false" />
        </div>
        <div class="fz-tabs flex gap-2 overflow-x-auto -mx-3 px-3 pb-1" style="scrollbar-width:none;">
          <button type="button" class="fz-tab" data-tab="suggestions">Suggested</button>
          <button type="button" class="fz-tab" data-tab="followers">Followers <span class="fz-count opacity-80" data-count="followers"></span></button>
          <button type="button" class="fz-tab" data-tab="following">Following <span class="fz-count opacity-80" data-count="following"></span></button>
          <button type="button" class="fz-tab" data-tab="find">Find</button>
        </div>
      </div>
      <div class="fz-list px-3 sm:px-4 pt-1 pb-10 space-y-2.5">${skeletonRows()}</div>
    </div>
  `;

  const root = container.querySelector(".fz-friends");
  const listEl = container.querySelector(".fz-list");
  const searchEl = container.querySelector(".fz-search");
  const searchWrap = container.querySelector(".fz-searchwrap");
  const alive = () => root.isConnected;

  const followsMe = (uid) => tabs.followers.ids.includes(uid);

  /* ---- rendering ---- */
  const paintTabs = () => {
    container.querySelectorAll(".fz-tab").forEach((btn) => {
      const on = btn.dataset.tab === activeTab;
      btn.className =
        "fz-tab flex-shrink-0 px-4 py-2 rounded-full font-label-lg text-label-lg font-semibold whitespace-nowrap border transition-all " +
        (on ? "bg-primary-container text-white border-transparent" : "bg-slate-surface text-on-surface border-slate-border");
    });
    Object.values(tabs).forEach((tab) => {
      const el = container.querySelector(`.fz-count[data-count="${tab.key}"]`);
      el.textContent = tab.loadedIds ? tab.ids.length : "";
    });
    searchWrap.hidden = activeTab === "suggestions";
    searchEl.placeholder = activeTab === "find" ? "Search everyone by name or @username" : "Filter this list by name or @username";
  };

  const rowHtml = (user) => `
    <div class="fz-row flex items-center gap-3 pl-4 pr-2 py-3 bg-slate-surface rounded-2xl border border-slate-border active:bg-surface-container-low cursor-pointer" data-uid="${escapeHtml(user.uid)}">
      ${avatarHtml(user.photoURL, "w-12 h-12")}
      <div class="min-w-0 flex-1">
        <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(user.name)}</div>
        ${user.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(user.username)}</div>` : ""}
      </div>
      ${followButtonHtml(!!followingIds[user.uid], followsMe(user.uid))}
      <button type="button" class="fz-menu-open flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="More options">
        <span class="material-symbols-outlined text-[20px]">more_vert</span>
      </button>
    </div>`;

  const suggestRowHtml = (user) => `
    <div class="fz-row flex items-center gap-3 pl-4 pr-2 py-3 bg-slate-surface rounded-2xl border border-slate-border active:bg-surface-container-low cursor-pointer" data-uid="${escapeHtml(user.uid)}">
      ${avatarHtml(user.photoURL, "w-12 h-12")}
      <div class="min-w-0 flex-1">
        <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(user.name)}</div>
        ${user.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(user.username)}</div>` : ""}
        <div class="font-body-sm text-body-sm text-primary/80 truncate">${escapeHtml(user.reason)}</div>
      </div>
      ${followButtonHtml(!!followingIds[user.uid], followsMe(user.uid))}
      <button type="button" class="fz-dismiss flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-subtle hover:bg-surface-container" aria-label="Remove suggestion">
        <span class="material-symbols-outlined text-[18px]">close</span>
      </button>
    </div>`;

  const renderSuggest = () => {
    const shown = suggest.items.filter((item) => !isBlocked(item.uid));
    if (suggest.state === "loading" || suggest.state === "idle") {
      listEl.innerHTML = skeletonRows(5);
    } else if (suggest.state === "error") {
      listEl.innerHTML = `
        <div class="text-center py-14 px-6">
          <p class="text-slate-muted font-body-md text-body-md mb-3">Could not load suggestions.</p>
          <button type="button" class="fz-refresh px-5 py-2 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold">Try again</button>
        </div>`;
    } else if (!shown.length) {
      listEl.innerHTML =
        emptyState("diversity_3", "No suggestions right now", "Check again later when more people join, or use the Find tab to search for someone.") +
        `<div class="text-center"><button type="button" class="fz-refresh px-5 py-2 rounded-full bg-surface-container text-on-surface font-label-md text-label-md font-semibold">Refresh</button></div>`;
    } else {
      listEl.innerHTML =
        `<div class="flex items-center justify-between px-1 pb-1">
           <h3 class="font-label-lg text-label-lg text-on-surface">People you may know</h3>
           <button type="button" class="fz-refresh flex items-center gap-1 text-primary font-label-md text-label-md font-semibold">
             <span class="material-symbols-outlined text-[18px]">refresh</span> Refresh
           </button>
         </div>` + shown.map(suggestRowHtml).join("");
    }
  };

  const renderFind = () => {
    const results = find.results.filter((user) => !isBlocked(user.uid));
    if (find.state === "idle") {
      listEl.innerHTML = emptyState(
        "travel_explore",
        "Find people",
        `Type at least ${FIND_MIN_CHARS} letters of a name or @username. The search matches the beginning, for example "rah" finds "Rahim".`
      );
    } else if (find.state === "loading") {
      listEl.innerHTML = skeletonRows(5);
    } else if (find.state === "error") {
      listEl.innerHTML = `
        <div class="text-center py-14 px-6">
          <p class="text-slate-muted font-body-md text-body-md mb-3">Search is not available right now.</p>
          <button type="button" class="fz-retry-find px-5 py-2 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold">Try again</button>
        </div>`;
    } else if (!results.length) {
      listEl.innerHTML = emptyState("search_off", "No people found", `Nobody matches "${escapeHtml(find.text)}". Check the spelling or try the @username.`);
    } else {
      listEl.innerHTML = results.map(rowHtml).join("");
    }
  };

  const render = () => {
    if (!alive()) return;
    paintTabs();

    if (activeTab === "suggestions") return renderSuggest();
    if (activeTab === "find") return renderFind();

    const tab = tabs[activeTab];

    if (!tab.ids.length) {
      listEl.innerHTML =
        activeTab === "followers"
          ? emptyState("group", "No followers yet", "When someone follows you, they will show up here.")
          : emptyState("person_add", "You are not following anyone", "Use the Find tab to search for people and follow them.");
      return;
    }

    const people = tab.users.filter((u) => !isBlocked(u.uid));
    const rows = filter
      ? people.filter((u) => u.name.toLowerCase().includes(filter) || u.username.toLowerCase().includes(filter))
      : people;

    if (filter && !rows.length) {
      const stillLoading = tab.cursor < tab.ids.length;
      listEl.innerHTML = emptyState(
        "search_off",
        "No results",
        stillLoading ? "Only the first people were searched. Clear the search and tap Show more." : `Nobody matches "${escapeHtml(searchEl.value.trim())}".`
      );
      return;
    }

    const hasMore = !filter && tab.cursor < tab.ids.length;
    listEl.innerHTML =
      rows.map(rowHtml).join("") +
      (hasMore
        ? `<button type="button" class="fz-more w-full py-3 rounded-xl bg-surface-container text-on-surface font-label-lg text-label-lg font-semibold active:scale-[.98] transition-all">Show more</button>`
        : "");
  };

  /* ---- loading ---- */
  // Loads the next batch of profiles for a tab (skips accounts that no longer exist)
  const loadMore = async (tab, limit = PAGE_SIZE) => {
    const batch = tab.ids.slice(tab.cursor, tab.cursor + limit);
    const users = await Promise.all(batch.map((id) => readUser(db, id)));
    tab.cursor += batch.length;
    tab.users.push(...users.filter(Boolean));
  };

  const loadSuggestions = async (force = false) => {
    const dismissed = getDismissed();
    if (!force && suggestCache.items && Date.now() - suggestCache.time < SUGGEST_CACHE_MS) {
      suggest.items = suggestCache.items.filter((item) => !followingIds[item.uid] && !dismissed.has(item.uid));
      suggest.state = "done";
      return render();
    }

    const token = ++suggestToken;
    suggest.state = "loading";
    render();
    try {
      const items = await buildSuggestions({
        db,
        me,
        followingIds,
        followerIds: tabs.followers.ids,
        followingList: tabs.following.ids
      });
      if (token !== suggestToken) return;
      suggestCache = { time: Date.now(), items };
      suggest.items = items;
      suggest.state = "done";
    } catch (error) {
      console.error(error);
      if (token !== suggestToken) return;
      suggest.state = "error";
    }
    render();
  };

  const start = async () => {
    listEl.innerHTML = skeletonRows();
    try {
      const [followerIds, followingList] = await Promise.all([readIds(db, `followers/${me}`), readIds(db, `following/${me}`)]);
      tabs.followers.ids = followerIds;
      tabs.following.ids = followingList;
      tabs.followers.loadedIds = tabs.following.loadedIds = true;
      if (activeTab === "suggestions") return loadSuggestions();
      if (activeTab !== "find") await loadMore(tabs[activeTab]);
      render();
    } catch (error) {
      console.error(error);
      if (!alive()) return;
      listEl.innerHTML = `
        <div class="text-center py-14 px-6">
          <p class="text-slate-muted font-body-md text-body-md mb-3">Could not load your friends.</p>
          <button type="button" class="fz-retry px-5 py-2 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold">Try again</button>
        </div>`;
    }
  };

  const runFind = async () => {
    const text = searchEl.value.trim().replace(/^@/, "");
    find.text = text;

    if (text.length < FIND_MIN_CHARS) {
      findToken++;
      find.state = "idle";
      find.results = [];
      return render();
    }

    const token = ++findToken;
    find.state = "loading";
    render();
    try {
      let results;
      const link = parseProfileLink(text);
      if (link && link.uid) {
        if (link.uid === me) return onOpenProfile?.(me);
        const user = await readUser(db, link.uid);
        results = user ? [user] : [];
      } else if (link && link.username) {
        const found = await searchUsers(db, link.username, me);
        results = found.filter((user) => user.username.toLowerCase() === link.username);
        if (!results.length && !found.length) {
          // the link may be your own profile
          const own = await searchUsers(db, link.username, "");
          if (own.some((user) => user.uid === me)) return onOpenProfile?.(me);
        }
      } else {
        results = await searchUsers(db, text, me);
      }
      if (token !== findToken) return; // a newer search replaced this one
      find.results = results;
      find.state = "done";
    } catch (error) {
      console.error(error);
      if (token !== findToken) return;
      find.state = "error";
    }
    render();
  };

  /* ---- events ---- */
  container.querySelectorAll(".fz-tab").forEach((btn) => {
    btn.addEventListener("click", async () => {
      activeTab = lastTab = btn.dataset.tab;
      searchEl.value = "";
      filter = "";
      render();
      if (activeTab === "find") {
        searchEl.focus();
        return;
      }
      if (activeTab === "suggestions") {
        // Lists are loaded first; start() then loads the suggestions itself
        if (tabs.followers.loadedIds && suggest.state === "idle") loadSuggestions();
        return;
      }

      const tab = tabs[activeTab];
      if (!tab.cursor && tab.ids.length) {
        listEl.innerHTML = skeletonRows(4);
        await loadMore(tab);
        render();
      }
    });
  });

  let searchTimer = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);

    if (activeTab === "find") {
      searchTimer = setTimeout(runFind, 350);
      return;
    }

    searchTimer = setTimeout(async () => {
      filter = searchEl.value.trim().toLowerCase().replace(/^@/, "");
      const tab = tabs[activeTab];
      // To filter everyone in the list, load the remaining profiles first (up to a limit)
      if (filter && tab.cursor < tab.ids.length && tab.cursor < SEARCH_CAP) {
        listEl.innerHTML = skeletonRows(4);
        await loadMore(tab, SEARCH_CAP - tab.cursor);
        if (!alive()) return;
      }
      render();
    }, 250);
  });

  const removeFollower = async (user) => {
    if (!(await confirmRemoveFollower(user))) return;
    const uid = user.uid;

    try {
      // Both sides are removed together so the two lists never disagree
      await update(ref(db), {
        [`followers/${me}/${uid}`]: null,
        [`following/${uid}/${me}`]: null
      });
    } catch (error) {
      console.error(error);
      showToast(error.code === "PERMISSION_DENIED" ? "Could not remove: database rules block it" : "Could not remove the follower. Try again.");
      return;
    }
    if (!alive()) return;

    const followers = tabs.followers;
    const index = followers.ids.indexOf(uid);
    if (index !== -1) {
      followers.ids.splice(index, 1);
      if (index < followers.cursor) followers.cursor--;
    }
    followers.users = followers.users.filter((u) => u.uid !== uid);

    // They no longer follow you, so "Follows you" suggestions must not show them
    suggest.items = suggest.items.filter((item) => item.uid !== uid);
    if (suggestCache.items) suggestCache.items = suggestCache.items.filter((item) => item.uid !== uid);

    showToast(`Removed ${user.username ? "@" + user.username : user.name} from your followers`);
    render();
  };

  listEl.addEventListener("click", async (event) => {
    if (event.target.closest(".fz-retry")) return start();
    if (event.target.closest(".fz-refresh")) return loadSuggestions(true);

    const dismissBtn = event.target.closest(".fz-dismiss");
    if (dismissBtn) {
      const row = dismissBtn.closest(".fz-row");
      const uid = row.dataset.uid;
      rememberDismissed(uid);
      suggest.items = suggest.items.filter((item) => item.uid !== uid);
      if (suggestCache.items) suggestCache.items = suggestCache.items.filter((item) => item.uid !== uid);
      row.remove();
      if (!suggest.items.length) render();
      return;
    }
    if (event.target.closest(".fz-retry-find")) return runFind();

    if (event.target.closest(".fz-more")) {
      if (busy) return;
      busy = true;
      const button = event.target.closest(".fz-more");
      button.textContent = "Loading...";
      await loadMore(tabs[activeTab]);
      busy = false;
      return render();
    }

    const menuBtn = event.target.closest(".fz-menu-open");
    if (menuBtn) {
      const uid = menuBtn.closest(".fz-row").dataset.uid;
      const source = activeTab === "find" ? find.results : tabs[activeTab].users;
      const user = source.find((u) => u.uid === uid);
      if (!user) return;

      const actions = [];
      if (onOpenChat) actions.push({ key: "message", label: "Message", icon: "chat_bubble" });
      actions.push({ key: "profile", label: "View profile", icon: "person" });
      if (activeTab === "followers") actions.push({ key: "remove", label: "Remove follower", icon: "person_remove", danger: true });
      if (followingIds[uid]) actions.push({ key: "unfollow", label: "Unfollow", icon: "person_off", danger: true });

      const choice = await openRowSheet(user, actions);
      if (choice === "message") onOpenChat(uid);
      else if (choice === "profile") onOpenProfile?.(uid);
      else if (choice === "unfollow") {
        if (onToggleFollow && (await onToggleFollow(user, true))) {
          if (!alive()) return;
          tabs.following.ids = tabs.following.ids.filter((id) => id !== uid);
          render(); // the person stays in the list, so an accidental unfollow can be undone
        }
      } else if (choice === "remove") await removeFollower(user);
      return;
    }

    const followBtn = event.target.closest(".fz-follow");
    const row = event.target.closest(".fz-row");
    if (!row) return;
    const uid = row.dataset.uid;

    if (followBtn) {
      const source = activeTab === "find" ? find.results : activeTab === "suggestions" ? suggest.items : tabs[activeTab].users;
      const user = source.find((u) => u.uid === uid);
      if (!user || !onToggleFollow) return;

      followBtn.disabled = true;
      const wasFollowing = !!followingIds[uid];
      const ok = await onToggleFollow(user, wasFollowing);
      if (!alive()) return;

      if (ok) {
        // The list itself keeps the person, so an accidental unfollow can be undone
        const nowFollowing = !!followingIds[uid];
        if (nowFollowing && !tabs.following.ids.includes(uid)) tabs.following.ids.unshift(uid);
        if (!nowFollowing) tabs.following.ids = tabs.following.ids.filter((id) => id !== uid);
        followBtn.outerHTML = followButtonHtml(nowFollowing, followsMe(uid));
        paintTabs();
      } else {
        followBtn.disabled = false;
      }
      return;
    }

    if (onOpenProfile) onOpenProfile(uid);
    else showToast("Profile is not available here");
  });

  paintTabs();
  if (activeTab === "find") {
    searchEl.value = find.text;
    render();
  }
  await start();
}