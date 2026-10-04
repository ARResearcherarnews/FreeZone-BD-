// FreeZone BD - Post Card component
export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

export function timeAgo(timestamp) {
  if (!timestamp) return "just now";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(timestamp).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short"
  });
}

export function avatarHtml(photoURL, size = "w-11 h-11") {
  if (photoURL) {
    return `<img class="${size} rounded-full object-cover ring-1 ring-slate-border/60" src="${escapeHtml(photoURL)}" alt="avatar" loading="lazy" />`;
  }
  return `<div class="${size} rounded-full bg-gradient-to-br from-primary-fixed to-secondary-container flex items-center justify-center ring-1 ring-slate-border/40">
    <span class="material-symbols-outlined text-primary text-[20px]">person</span>
  </div>`;
}

export function showToast(message) {
  const old = document.getElementById("fzToast");
  if (old) old.remove();

  const toast = document.createElement("div");
  toast.id = "fzToast";
  toast.textContent = message;
  toast.setAttribute("role", "status");
  toast.style.cssText =
    "position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:9999;" +
    "background:#1e293b;color:#fff;padding:10px 18px;border-radius:9999px;" +
    "font-size:13px;font-weight:500;box-shadow:0 8px 24px rgba(15,23,42,.25);" +
    "max-width:85vw;text-align:center;";
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

export function getPostLink(postId) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("post", postId);
  return url.toString();
}

export async function copyPostLink(postId) {
  return copyLink(getPostLink(postId));
}

// Copies any link to the clipboard (with a fallback for in-app browsers) and shows "Link copied"
export async function copyLink(link) {

  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copied");
    return true;
  } catch (error) {
    // Fallback for WebView / older browsers
    try {
      const input = document.createElement("textarea");
      input.value = link;
      input.setAttribute("readonly", "");
      input.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(input);
      input.select();
      input.setSelectionRange(0, link.length);
      const ok = document.execCommand("copy");
      input.remove();
      showToast(ok ? "Link copied" : "Could not copy link");
      return ok;
    } catch (fallbackError) {
      console.error(fallbackError);
      showToast("Could not copy link");
      return false;
    }
  }
}

const REPORT_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or bullying" },
  { value: "hate", label: "Hate speech" },
  { value: "sexual", label: "Nudity or sexual content" },
  { value: "violence", label: "Violence or dangerous content" },
  { value: "scam", label: "Scam or fraud" },
  { value: "false_info", label: "False information" },
  { value: "other", label: "Something else" }
];

// Opens a bottom sheet and resolves with { reason, details } or null if cancelled
export function openReportDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[90vh] flex flex-col" role="dialog" aria-modal="true" aria-label="Report post">
        <div class="px-5 pt-5 pb-3 border-b border-slate-border">
          <div class="flex items-center justify-between">
            <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">Report post</h2>
            <button type="button" class="report-close w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close">
              <span class="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          <p class="font-body-md text-body-md text-slate-muted mt-1">Why are you reporting this post?</p>
        </div>

        <div class="overflow-y-auto px-2 py-2">
          ${REPORT_REASONS.map(
            (r) => `
            <label class="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-surface-container-low cursor-pointer">
              <input type="radio" name="reportReason" value="${r.value}" class="w-4 h-4 accent-[#2563eb]" />
              <span class="font-body-md text-body-md text-on-surface">${r.label}</span>
            </label>`
          ).join("")}
          <div class="px-3 pt-2 pb-1">
            <textarea class="report-details w-full bg-surface-container-low border border-transparent focus:border-primary-container focus:ring-2 focus:ring-primary-container/15 rounded-xl px-3.5 py-2.5 text-body-md text-body-md outline-none resize-none" rows="3" maxlength="300" placeholder="Add more details (optional)"></textarea>
          </div>
        </div>

        <div class="flex items-center gap-2.5 px-5 py-4 border-t border-slate-border">
          <button type="button" class="report-cancel flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-95 transition-all">Cancel</button>
          <button type="button" class="report-submit flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-white bg-error disabled:opacity-40 active:scale-95 transition-all" disabled>Submit report</button>
        </div>
      </div>
    `;

    const submitBtn = overlay.querySelector(".report-submit");
    const detailsEl = overlay.querySelector(".report-details");

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
      if (event.target === overlay) close(null);
    });
    overlay.querySelector(".report-close").addEventListener("click", () => close(null));
    overlay.querySelector(".report-cancel").addEventListener("click", () => close(null));
    overlay.querySelectorAll('input[name="reportReason"]').forEach((input) => {
      input.addEventListener("change", () => (submitBtn.disabled = false));
    });
    submitBtn.addEventListener("click", () => {
      const checked = overlay.querySelector('input[name="reportReason"]:checked');
      if (!checked) return;
      close({ reason: checked.value, details: detailsEl.value.trim() });
    });

    document.body.appendChild(overlay);
  });
}

const FOLLOW_CHIP_BASE = "follow-chip ml-auto flex-shrink-0 h-8 px-3 rounded-full flex items-center gap-1 font-label-md text-label-md font-semibold active:scale-95 transition-all disabled:opacity-60 ";

function followChipClasses(following) {
  return FOLLOW_CHIP_BASE + (following ? "bg-surface-container text-slate-muted" : "bg-primary-container/10 text-primary");
}

// Keeps the Follow / Following button of every visible post by the same author in sync
export function updateFollowButtons(authorUid, following) {
  document.querySelectorAll(".follow-chip").forEach((chip) => {
    if (chip.dataset.authorUid !== authorUid) return;
    chip.dataset.following = following ? "1" : "0";
    chip.className = followChipClasses(following);
    chip.querySelector(".follow-chip-label").textContent = following ? "Following" : "Follow";
    chip.querySelector(".follow-chip-icon").textContent = following ? "check" : "add";
  });
}

// Keeps the Save/Unsave menu item of every visible card in sync
export function updateSaveButtons(postId, saved) {
  document.querySelectorAll(".save-btn").forEach((btn) => {
    if (btn.dataset.postId !== postId) return;
    btn.dataset.saved = saved ? "1" : "0";
    btn.querySelector(".save-label").textContent = saved ? "Unsave post" : "Save post";
    btn.querySelector(".save-icon").style.fontVariationSettings = `'FILL' ${saved ? 1 : 0}`;
  });
}

/* ---------------------------------------------------------------
   Share
---------------------------------------------------------------- */
// Our own share sheet. Used when the phone's share menu is not available (many in-app browsers / WebViews
// do not have navigator.share) or when it fails.
function openShareSheet({ link, text, title = "Share post" }) {
  const encodedLink = encodeURIComponent(link);
  const encodedText = encodeURIComponent(text);
  const encodedBoth = encodeURIComponent(`${text}\n${link}`);

  const apps = [
    { label: "WhatsApp", color: "#25D366", mark: "W", href: `https://wa.me/?text=${encodedBoth}` },
    { label: "Facebook", color: "#1877F2", mark: "f", href: `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}` },
    { label: "Telegram", color: "#229ED9", mark: "T", href: `https://t.me/share/url?url=${encodedLink}&text=${encodedText}` },
    { label: "X", color: "#111827", mark: "X", href: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedLink}` },
    { label: "Email", color: "#64748b", icon: "mail", href: `mailto:?subject=${encodeURIComponent("FreeZone BD")}&body=${encodedBoth}`, sameTab: true },
    { label: "SMS", color: "#16a34a", icon: "sms", href: `sms:?&body=${encodedBoth}`, sameTab: true }
  ];

  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40";
  overlay.innerHTML = `
    <div class="w-full max-w-lg bg-slate-surface rounded-t-3xl sm:rounded-3xl shadow-2xl p-5" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">${escapeHtml(title)}</h2>
        <button type="button" class="share-close w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close">
          <span class="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>

      <div class="flex items-center gap-2 bg-surface-container-low rounded-xl p-1.5 pl-3.5 mb-5">
        <input type="text" readonly value="${escapeHtml(link)}" class="share-link flex-1 min-w-0 bg-transparent text-[14px] text-on-surface-variant outline-none truncate" aria-label="Link" />
        <button type="button" class="share-copy flex-shrink-0 px-4 py-2 rounded-lg bg-primary-container text-white font-label-md text-label-md font-semibold active:scale-95 transition-all">Copy</button>
      </div>

      <div class="grid grid-cols-3 gap-y-5 gap-x-2">
        ${apps
          .map(
            (app) => `
          <a href="${app.href}" ${app.sameTab ? "" : 'target="_blank" rel="noopener noreferrer"'} class="share-app flex flex-col items-center gap-2 active:scale-95 transition-transform">
            <span class="w-14 h-14 rounded-full flex items-center justify-center text-white font-bold text-[22px]" style="background:${app.color}">
              ${app.icon ? `<span class="material-symbols-outlined text-[26px]">${app.icon}</span>` : app.mark}
            </span>
            <span class="font-body-sm text-body-sm text-on-surface">${app.label}</span>
          </a>`
          )
          .join("")}
      </div>
    </div>`;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === overlay || event.target.closest(".share-close")) return close();
    if (event.target.closest(".share-app")) return setTimeout(close, 150);
    if (event.target.closest(".share-copy")) {
      copyLink(link).then((ok) => ok && close());
    }
  });

  document.body.appendChild(overlay);
}

// The phone's own share menu when it exists, otherwise our share sheet
async function shareLink({ link, text, title }) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "FreeZone BD", text, url: link });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return; // the person closed the share menu
      // Any other error (blocked in this browser): continue with our own sheet
    }
  }
  openShareSheet({ link, text, title });
}

/** Shares a post. */
export async function sharePost(post) {
  if (!post || !post.id) return;

  const who = post.username ? `@${post.username}` : post.name || "FreeZone User";
  const body = String(post.text || "").trim();
  const text = body ? `${who} on FreeZone BD: ${body.length > 140 ? body.slice(0, 140) + "…" : body}` : `${who} shared a post on FreeZone BD`;
  return shareLink({ link: getPostLink(post.id), text, title: "Share post" });
}

/**
 * The unique link of a profile. It uses the @username (?u=abdul) when there is one, so it is short and easy to read,
 * and the account id (?profile=...) otherwise. feed.js opens the profile when the page is loaded with either.
 */
export function getProfileLink(user) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (user.username) url.searchParams.set("u", user.username);
  else url.searchParams.set("profile", user.uid);
  return url.toString();
}

/** Shares a profile: { uid, name, username }. */
export async function shareProfile(user) {
  if (!user || !user.uid) return;
  const name = user.name || "FreeZone User";
  const text = user.username ? `${name} (@${user.username}) on FreeZone BD` : `${name} on FreeZone BD`;
  return shareLink({ link: getProfileLink(user), text, title: "Share profile" });
}

/* ---------------------------------------------------------------
   Post photos: one to four per post
---------------------------------------------------------------- */
// New posts keep every photo in `imageURLs` (and the first one also in `imageURL`); old posts only have `imageURL`.
export function postImageUrls(post) {
  if (!post) return [];
  const list = post.imageURLs ? (Array.isArray(post.imageURLs) ? post.imageURLs : Object.values(post.imageURLs)) : [];
  const urls = list.filter((url) => typeof url === "string" && url);
  if (!urls.length && post.imageURL) urls.push(post.imageURL);
  return urls.slice(0, 4);
}

// The photo lists are kept here, so the page does not carry huge (or repeated) links in its markup
const imageSets = new Map();

function hashString(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  return (hash >>> 0).toString(36) + text.length.toString(36);
}

/** Markup of the photo grid: 1 photo = full width, 2 = side by side, 3 = one big and two small, 4 = a 2x2 grid. */
export function postImagesHtml(urls) {
  if (!urls || !urls.length) return "";
  const list = urls.slice(0, 4);
  const count = list.length;

  const key = hashString(list.join("\n"));
  imageSets.set(key, list);

  const tile = (url, index, extra = "") => `
    <button type="button" class="post-img-tile relative block overflow-hidden bg-surface-container ${extra}" data-img-index="${index}" aria-label="Open photo ${index + 1} of ${count}">
      <img src="${escapeHtml(url)}" alt="" loading="lazy" class="${count === 1 ? "w-full max-h-[420px] object-cover block" : "absolute inset-0 w-full h-full object-cover"}"
           onerror="${count === 1 ? "this.closest('.post-images')?.remove();" : "this.closest('.post-img-tile')?.remove();"}" />
    </button>`;

  let inner;
  if (count === 1) {
    inner = tile(list[0], 0, "w-full");
  } else if (count === 2) {
    inner = `<div class="grid grid-cols-2 grid-rows-1 gap-0.5 aspect-[16/9]">${list.map((url, i) => tile(url, i)).join("")}</div>`;
  } else if (count === 3) {
    inner = `<div class="grid grid-cols-2 grid-rows-2 gap-0.5 aspect-[4/3]">${tile(list[0], 0, "row-span-2")}${tile(list[1], 1)}${tile(list[2], 2)}</div>`;
  } else {
    inner = `<div class="grid grid-cols-2 grid-rows-2 gap-0.5 aspect-square">${list.map((url, i) => tile(url, i)).join("")}</div>`;
  }

  return `<div class="post-images rounded-xl overflow-hidden border border-slate-border bg-surface-container mt-1" data-set="${key}">${inner}</div>`;
}

/** Full-screen photo viewer: swipe or use the arrows to move between the photos, swipe down or tap X to close. */
export function openImageViewer(urls, startIndex = 0) {
  if (!urls || !urls.length) return;
  let index = Math.min(Math.max(startIndex, 0), urls.length - 1);

  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9996] bg-black flex flex-col select-none touch-none";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Photo viewer");
  overlay.innerHTML = `
    <div class="flex items-center justify-between px-3" style="padding-top:max(0.75rem, env(safe-area-inset-top));">
      <span class="iv-count text-white/90 font-label-md text-label-md px-2"></span>
      <button type="button" class="iv-close w-10 h-10 rounded-full flex items-center justify-center text-white hover:bg-white/10" aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="iv-stage flex-1 min-h-0 relative flex items-center justify-center" style="padding-bottom:max(0.75rem, env(safe-area-inset-bottom));">
      <img class="iv-img max-w-full max-h-full object-contain" alt="" />
      ${
        urls.length > 1
          ? `<button type="button" class="iv-prev absolute left-2 w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center" aria-label="Previous photo"><span class="material-symbols-outlined">chevron_left</span></button>
             <button type="button" class="iv-next absolute right-2 w-10 h-10 rounded-full bg-black/40 text-white flex items-center justify-center" aria-label="Next photo"><span class="material-symbols-outlined">chevron_right</span></button>`
          : ""
      }
    </div>`;

  const imgEl = overlay.querySelector(".iv-img");
  const countEl = overlay.querySelector(".iv-count");
  const stage = overlay.querySelector(".iv-stage");

  const show = () => {
    imgEl.src = urls[index];
    countEl.textContent = urls.length > 1 ? `${index + 1} / ${urls.length}` : "";
  };
  const move = (step) => {
    if (urls.length < 2) return;
    index = (index + step + urls.length) % urls.length;
    show();
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
    else if (event.key === "ArrowRight") move(1);
    else if (event.key === "ArrowLeft") move(-1);
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelector(".iv-close").addEventListener("click", close);
  overlay.querySelector(".iv-prev")?.addEventListener("click", () => move(-1));
  overlay.querySelector(".iv-next")?.addEventListener("click", () => move(1));

  let startX = 0;
  let startY = 0;
  stage.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startY = event.clientY;
  });
  stage.addEventListener("pointerup", (event) => {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (dy > 90 && dy > Math.abs(dx)) return close(); // swipe down
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1); // swipe sideways
  });

  document.body.appendChild(overlay);
  show();
}

// One handler for every photo grid on the page (feed, post page, profile): it runs before the card's own
// "open post" click, so tapping a photo opens the viewer instead.
document.addEventListener(
  "click",
  (event) => {
    const tile = event.target.closest(".post-images [data-img-index]");
    if (!tile) return;
    const urls = imageSets.get(tile.closest(".post-images").dataset.set);
    if (!urls || !urls.length) return;
    event.stopPropagation();
    event.preventDefault();
    openImageViewer(urls, Number(tile.dataset.imgIndex) || 0);
  },
  true
);

let globalMenuCloserAttached = false;
function ensureGlobalMenuCloser() {
  if (globalMenuCloserAttached) return;
  globalMenuCloserAttached = true;
  document.addEventListener("click", () => {
    document.querySelectorAll(".menu-dropdown").forEach((el) => {
      el.hidden = true;
    });
  });
}

export function createPostCard(post, options = {}) {
  const { currentUserUid, savedPostIds, followingIds, onOpen, onLike, onShare, onDelete, onEdit, onReport, onSave, onFollow, onProfile, onBlock, showFollowChip = true } = options;

  const likedByMe = !!(post.likes && currentUserUid && post.likes[currentUserUid]);
  const likesCount = post.likesCount || 0;
  const commentsCount = post.commentsCount || 0;
  const isOwner = !!(currentUserUid && post.uid === currentUserUid);
  let isSaved = !!(savedPostIds && savedPostIds[post.id]);
  const canFollow = !!(onFollow && currentUserUid && post.uid && post.uid !== currentUserUid);
  const canBlock = !!(onBlock && currentUserUid && post.uid && post.uid !== currentUserUid);
  const isFollowing = !!(followingIds && followingIds[post.uid]);
  const followHandle = post.username ? `@${post.username}` : post.name || "this user";

  const article = document.createElement("article");
  article.className =
    "group bg-slate-surface border border-slate-border rounded-2xl p-4 shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer active:scale-[0.995]";
  article.dataset.postId = post.id;

  const imageBlock = postImagesHtml(postImageUrls(post));

  article.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <div class="profile-link flex items-center gap-3 min-w-0 ${onProfile && post.uid ? "cursor-pointer" : ""}">
        ${avatarHtml(post.photoURL)}
        <div class="min-w-0">
          <div class="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">${escapeHtml(post.name || "FreeZone User")}</div>
          <div class="flex items-center gap-1.5 text-slate-muted font-body-sm text-body-sm flex-wrap">
            ${post.username ? `<span class="text-primary/80">@${escapeHtml(post.username)}</span><span class="text-slate-border">•</span>` : ""}
            <span>${timeAgo(post.createdAt)}</span>
            ${post.editedAt ? `<span class="text-slate-border">•</span><span class="italic">edited</span>` : ""}
          </div>
        </div>
      </div>

      ${
        canFollow && showFollowChip
          ? `<button type="button" class="${followChipClasses(isFollowing)}" data-author-uid="${escapeHtml(post.uid)}" data-handle="${escapeHtml(followHandle)}" data-following="${isFollowing ? "1" : "0"}" aria-label="Follow or unfollow ${escapeHtml(followHandle)}">
               <span class="follow-chip-icon material-symbols-outlined text-[16px]">${isFollowing ? "check" : "add"}</span>
               <span class="follow-chip-label">${isFollowing ? "Following" : "Follow"}</span>
             </button>`
          : ""
      }

      <div class="relative menu-wrap flex-shrink-0">
        <button class="menu-btn w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container hover:text-on-surface active:scale-95 transition-all" aria-label="More options">
          <span class="material-symbols-outlined text-[20px]">more_horiz</span>
        </button>
        <div class="menu-dropdown absolute right-0 top-9 z-20 w-48 bg-slate-surface border border-slate-border rounded-xl shadow-xl py-1.5 overflow-hidden" hidden>
          <button class="copy-link-btn w-full text-left px-3.5 py-2.5 text-sm text-on-surface hover:bg-surface-container-low flex items-center gap-2.5">
            <span class="material-symbols-outlined text-[18px]">link</span> Copy link
          </button>
          ${
            onSave
              ? `<button class="save-btn w-full text-left px-3.5 py-2.5 text-sm text-on-surface hover:bg-surface-container-low flex items-center gap-2.5" data-post-id="${escapeHtml(post.id)}" data-saved="${isSaved ? "1" : "0"}">
                   <span class="save-icon material-symbols-outlined text-[18px]" style="font-variation-settings: 'FILL' ${isSaved ? 1 : 0};">bookmark</span>
                   <span class="save-label">${isSaved ? "Unsave post" : "Save post"}</span>
                 </button>`
              : ""
          }
          ${
            isOwner
              ? `<button class="edit-btn w-full text-left px-3.5 py-2.5 text-sm text-on-surface hover:bg-surface-container-low flex items-center gap-2.5">
                   <span class="material-symbols-outlined text-[18px]">edit</span> Edit post
                 </button>
                 <button class="delete-btn w-full text-left px-3.5 py-2.5 text-sm text-error hover:bg-error-container/40 flex items-center gap-2.5">
                   <span class="material-symbols-outlined text-[18px]">delete</span> Delete post
                 </button>`
              : `${
                  onReport
                    ? `<button class="report-btn w-full text-left px-3.5 py-2.5 text-sm text-error hover:bg-error-container/40 flex items-center gap-2.5">
                         <span class="material-symbols-outlined text-[18px]">flag</span> Report post
                       </button>`
                    : ""
                }${
                  canBlock
                    ? `<button class="block-btn w-full text-left px-3.5 py-2.5 text-sm text-error hover:bg-error-container/40 flex items-center gap-2.5">
                         <span class="material-symbols-outlined text-[18px]">block</span> <span class="truncate">Block ${escapeHtml(followHandle)}</span>
                       </button>`
                    : ""
                }`
          }
        </div>
      </div>
    </div>

    <p class="post-text font-body-md text-body-md text-on-surface leading-relaxed whitespace-pre-wrap break-words mt-3">${escapeHtml(post.text)}</p>

    <div class="edit-wrap space-y-2.5 mt-3" hidden>
      <textarea class="edit-textarea w-full bg-surface-container-low border border-transparent focus:border-primary-container focus:ring-2 focus:ring-primary-container/20 rounded-xl px-3.5 py-2.5 text-body-md text-body-md outline-none resize-none transition-all" rows="3" maxlength="500">${escapeHtml(post.text)}</textarea>
      <div class="flex items-center justify-between">
        <span class="edit-char-count text-slate-subtle font-label-sm text-label-sm">0/500</span>
        <div class="flex items-center gap-2">
          <button type="button" class="edit-cancel px-3.5 py-1.5 rounded-lg text-slate-muted font-label-md text-label-md font-semibold hover:bg-surface-container transition-colors">Cancel</button>
          <button type="button" class="edit-save px-4 py-1.5 rounded-lg bg-primary-container text-white font-label-md text-label-md font-semibold disabled:opacity-50 active:scale-95 transition-all">Save</button>
        </div>
      </div>
    </div>

    ${imageBlock}

    <div class="flex items-center justify-between py-2 mt-1 text-slate-muted font-body-sm text-body-sm border-b border-slate-border/70">
      <span class="likes-count">${likesCount} like${likesCount === 1 ? "" : "s"}</span>
      <span>${commentsCount} comment${commentsCount === 1 ? "" : "s"}</span>
    </div>

    <div class="flex items-center justify-between pt-1">
      <button class="like-btn flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-label-md text-label-md font-semibold hover:bg-surface-container active:scale-95 transition-all ${likedByMe ? "text-primary-container liked" : "text-slate-muted"}">
        <span class="material-symbols-outlined text-[20px] like-icon transition-transform">thumb_up</span>
        <span class="like-label">${likedByMe ? "Liked" : "Like"}</span>
      </button>
      <button class="comment-btn flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-slate-muted hover:text-on-surface font-label-md text-label-md font-medium hover:bg-surface-container active:scale-95 transition-all">
        <span class="material-symbols-outlined text-[20px]">chat_bubble</span>
        <span>Comment</span>
      </button>
      <button class="share-btn flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-slate-muted hover:text-on-surface font-label-md text-label-md font-medium hover:bg-surface-container active:scale-95 transition-all">
        <span class="material-symbols-outlined text-[20px]">share</span>
        <span>Share</span>
      </button>
    </div>
  `;

  const likeBtn = article.querySelector(".like-btn");
  likeBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const icon = likeBtn.querySelector(".like-icon");
    icon.style.transform = "scale(1.25)";
    setTimeout(() => (icon.style.transform = ""), 180);
    onLike?.(post.id);
  });

  article.querySelector(".comment-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    onOpen?.(post.id);
  });

  article.querySelector(".share-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    onShare?.(post);
  });

  const menuBtn = article.querySelector(".menu-btn");
  const menuDropdown = article.querySelector(".menu-dropdown");

  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll(".menu-dropdown").forEach((el) => {
      if (el !== menuDropdown) el.hidden = true;
    });
    menuDropdown.hidden = !menuDropdown.hidden;
  });

  ensureGlobalMenuCloser();

  article.querySelector(".copy-link-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    menuDropdown.hidden = true;
    copyPostLink(post.id);
  });

  const profileLink = article.querySelector(".profile-link");
  if (profileLink && onProfile && post.uid) {
    profileLink.addEventListener("click", (event) => {
      event.stopPropagation();
      onProfile(post.uid);
    });
  }

  const followChip = article.querySelector(".follow-chip");
  if (followChip) {
    followChip.addEventListener("click", async (event) => {
      event.stopPropagation();
      const currentlyFollowing = followChip.dataset.following === "1";
      if (currentlyFollowing && !confirm(`Unfollow ${followHandle}?`)) return;

      followChip.disabled = true;
      await onFollow(post, currentlyFollowing); // on success updateFollowButtons() refreshes every chip of this author
      followChip.disabled = false;
    });
  }

  const saveBtn = article.querySelector(".save-btn");
  if (saveBtn) {
    saveBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      menuDropdown.hidden = true;
      const wasSaved = saveBtn.dataset.saved === "1";
      const ok = await onSave(post, wasSaved);
      if (ok) updateSaveButtons(post.id, !wasSaved);
    });
  }

  const blockBtn = article.querySelector(".block-btn");
  if (blockBtn) {
    blockBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      menuDropdown.hidden = true;
      onBlock(post);
    });
  }

  const reportBtn = article.querySelector(".report-btn");
  if (reportBtn) {
    reportBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      menuDropdown.hidden = true;
      const result = await openReportDialog();
      if (result) onReport?.(post, result);
    });
  }

  const deleteBtn = article.querySelector(".delete-btn");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      menuDropdown.hidden = true;
      onDelete?.(post.id);
    });
  }

  const postTextEl = article.querySelector(".post-text");
  const editWrap = article.querySelector(".edit-wrap");
  const editBtn = article.querySelector(".edit-btn");

  if (editBtn) {
    const editTextarea = article.querySelector(".edit-textarea");
    const editCancelBtn = article.querySelector(".edit-cancel");
    const editSaveBtn = article.querySelector(".edit-save");
    const editCharCount = article.querySelector(".edit-char-count");

    const updateCharCount = () => {
      editCharCount.textContent = `${editTextarea.value.length}/500`;
    };

    const enterEditMode = () => {
      postTextEl.hidden = true;
      editWrap.hidden = false;
      editTextarea.value = post.text || "";
      updateCharCount();
      editTextarea.focus();
    };

    const exitEditMode = () => {
      postTextEl.hidden = false;
      editWrap.hidden = true;
    };

    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      menuDropdown.hidden = true;
      enterEditMode();
    });

    editWrap.addEventListener("click", (event) => event.stopPropagation());
    editTextarea.addEventListener("input", updateCharCount);

    editCancelBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      exitEditMode();
    });

    editSaveBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const newText = editTextarea.value.trim();
      if (!newText) return;

      editSaveBtn.disabled = true;
      try {
        await onEdit?.(post.id, newText);
        exitEditMode();
      } catch (error) {
        console.error(error);
        alert("Could not save the edit. Please try again.");
      } finally {
        editSaveBtn.disabled = false;
      }
    });
  }

  article.addEventListener("click", () => onOpen?.(post.id));

  return article;
}