// FreeZone BD - Ads
//
// How it works
//  1. Nothing changes on the page by default: no space is reserved for ads.
//  2. When ad data is ready and the ad image has loaded, a slot is inserted between two posts,
//     the gap opens smoothly and the ad appears.
//  3. If anything fails (no ads, no permission, no network, image error, ads.js problem),
//     nothing is inserted and the feed stays exactly as it was.
//
// Use:  import("./ads.js").then((m) => m.insertAds(container, { placement: "feed" }))
//       Call it after the posts have been rendered into `container`.
//
// Firebase data (add from the Firebase Console):
//   ads/{adId} = {
//     active: true, advertiser: "Shop name", logoURL: "https://...", title: "Headline",
//     text: "Short description", imageURL: "https://...", link: "https://...", cta: "Learn more",
//     startAt: 1767225600000, endAt: 1769904000000,          // optional, milliseconds
//     placements: { feed: true, profile: true },             // optional, default: everywhere
//     impressions: 0, clicks: 0
//   }
//   config/ads = { enabled: true, feed: { firstAfter: 3, every: 5 }, profile: { firstAfter: 2, every: 6 } }   // optional

import { db } from "./config.js";

import {
  ref,
  get,
  update,
  increment
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, showToast } from "./post.js";

/* ---------------------------------------------------------------
   Settings
---------------------------------------------------------------- */
const DEFAULT_CONFIG = {
  enabled: true,
  feed: { firstAfter: 3, every: 5 },
  profile: { firstAfter: 2, every: 6 }
};

const CACHE_MS = 5 * 60 * 1000; // re-read ads from Firebase at most every 5 minutes
const IMAGE_TIMEOUT_MS = 6000; // give up on an ad whose image does not load in time
const VISIBLE_MS = 1000; // an ad counts as "seen" after 1 second at least half visible
const HIDDEN_KEY = "fz_hidden_ads";

/* ---------------------------------------------------------------
   Styles (injected once). The slot has no size until the ad is ready.
---------------------------------------------------------------- */
function injectStyles() {
  if (document.getElementById("fz-ads-style")) return;
  const style = document.createElement("style");
  style.id = "fz-ads-style";
  style.textContent = `
    .fz-ad-slot {
      display: grid; grid-template-rows: 0fr; opacity: 0; margin-top: -0.5rem !important; /* cancels the 8px gap while closed */
      transition: grid-template-rows .5s cubic-bezier(.2,.8,.2,1), opacity .4s ease .1s, margin-top .5s cubic-bezier(.2,.8,.2,1);
    }
    .fz-ad-slot.fz-open { grid-template-rows: 1fr; opacity: 1; margin-top: 0 !important; }
    .fz-ad-slot.fz-instant { transition: none; }
    .fz-ad-inner { min-height: 0; overflow: hidden; }
    @media (prefers-reduced-motion: reduce) { .fz-ad-slot { transition: none; } }
  `;
  document.head.appendChild(style);
}

/* ---------------------------------------------------------------
   Data
---------------------------------------------------------------- */
let dataCache = { time: 0, promise: null };

function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch (error) {
    return "";
  }
}

function mergeConfig(remote) {
  const config = {
    enabled: DEFAULT_CONFIG.enabled,
    feed: { ...DEFAULT_CONFIG.feed },
    profile: { ...DEFAULT_CONFIG.profile }
  };
  if (!remote || typeof remote !== "object") return config;

  if (remote.enabled === false) config.enabled = false;
  ["feed", "profile"].forEach((key) => {
    const value = remote[key];
    if (!value || typeof value !== "object") return;
    if (Number.isFinite(value.firstAfter) && value.firstAfter >= 1) config[key].firstAfter = Math.floor(value.firstAfter);
    if (Number.isFinite(value.every) && value.every >= 2) config[key].every = Math.floor(value.every);
  });
  return config;
}

function loadData() {
  if (dataCache.promise && Date.now() - dataCache.time < CACHE_MS) return dataCache.promise;

  dataCache.time = Date.now();
  dataCache.promise = (async () => {
    let config = mergeConfig(null);
    try {
      const configSnap = await get(ref(db, "config/ads"));
      if (configSnap.exists()) config = mergeConfig(configSnap.val());
    } catch (error) {
      // No config is fine: defaults are used
    }

    const ads = [];
    try {
      const adsSnap = await get(ref(db, "ads"));
      adsSnap.forEach((child) => {
        ads.push({ id: child.key, ...child.val() });
      });
    } catch (error) {
      console.warn("Ads: could not read ads (the feed is unaffected):", error?.code || error);
    }
    return { config, ads };
  })();

  return dataCache.promise;
}

/* ---------------------------------------------------------------
   Hidden ads (the user pressed X)
---------------------------------------------------------------- */
const memoryHidden = new Set();

function getHiddenIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]");
    return new Set([...stored, ...memoryHidden]);
  } catch (error) {
    return new Set(memoryHidden);
  }
}

function rememberHidden(adId) {
  memoryHidden.add(adId);
  try {
    const list = [...getHiddenIds()].slice(-100);
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
  } catch (error) {
    // Storage unavailable: the ad stays hidden until the page is reloaded
  }
}

/* ---------------------------------------------------------------
   Choosing ads
---------------------------------------------------------------- */
function isEligible(ad, placement, now, hidden) {
  if (ad.active !== true || hidden.has(ad.id)) return false;
  if (Number.isFinite(ad.startAt) && now < ad.startAt) return false;
  if (Number.isFinite(ad.endAt) && now > ad.endAt) return false;
  if (ad.placements && typeof ad.placements === "object" && ad.placements[placement] !== true) return false;
  if (!ad.text && !ad.title && !ad.imageURL) return false;
  return true;
}

// A random starting point per page load, so different people see different ads first
let rotation = Math.floor(Math.random() * 1000);

/* ---------------------------------------------------------------
   Image preloading: an ad is only shown once its image is ready
---------------------------------------------------------------- */
const readyImages = new Map(); // url -> { width, height }

function preloadImage(url) {
  if (!url) return Promise.resolve({ width: 0, height: 0 });
  if (readyImages.has(url)) return Promise.resolve(readyImages.get(url));

  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = "";
      resolve(null);
    }, IMAGE_TIMEOUT_MS);

    img.onload = () => {
      clearTimeout(timer);
      const size = { width: img.naturalWidth, height: img.naturalHeight };
      readyImages.set(url, size);
      resolve(size);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/* ---------------------------------------------------------------
   Tracking
---------------------------------------------------------------- */
const countedImpressions = new Set();
const shownBefore = new Set(); // ads already opened once: re-renders show them without animation

function track(adId, field) {
  update(ref(db, `ads/${adId}`), { [field]: increment(1) }).catch(() => {});
}

function watchImpression(slot, adId, placement) {
  const key = `${adId}:${placement}`;
  if (countedImpressions.has(key) || !("IntersectionObserver" in window)) return;

  let timer = null;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!slot.isConnected) {
        clearTimeout(timer);
        observer.disconnect();
        return;
      }
      if (entry.isIntersecting) {
        if (timer) return;
        timer = setTimeout(() => {
          if (countedImpressions.has(key)) return;
          countedImpressions.add(key);
          track(adId, "impressions");
          observer.disconnect();
        }, VISIBLE_MS);
      } else {
        clearTimeout(timer);
        timer = null;
      }
    },
    { threshold: 0.5 }
  );
  observer.observe(slot);
}

/* ---------------------------------------------------------------
   The ad card
---------------------------------------------------------------- */
function buildAdCard(ad, imageSize) {
  const link = safeUrl(ad.link);
  const imageURL = imageSize && ad.imageURL ? safeUrl(ad.imageURL) : "";
  const advertiser = ad.advertiser || ad.title || "Sponsored";
  const initial = escapeHtml(String(advertiser).trim().charAt(0).toUpperCase() || "A");
  const logoURL = safeUrl(ad.logoURL);
  const ratio = imageSize && imageSize.width && imageSize.height ? `${imageSize.width} / ${imageSize.height}` : "16 / 9";

  const body = `
    ${ad.title && ad.text ? `<h3 class="font-label-lg text-label-lg text-on-surface px-4 pt-3 break-words">${escapeHtml(ad.title)}</h3>` : ""}
    ${
      ad.text || ad.title
        ? `<p class="font-body-md text-body-md text-on-surface leading-relaxed whitespace-pre-wrap break-words px-4 ${ad.title && ad.text ? "pt-1" : "pt-3"}">${escapeHtml(ad.text || ad.title)}</p>`
        : ""
    }
    ${
      imageURL
        ? `<div class="mt-3 bg-surface-container"><img src="${escapeHtml(imageURL)}" alt="" class="w-full object-cover block" style="aspect-ratio:${ratio};max-height:24rem;" /></div>`
        : ""
    }
    ${
      link
        ? `<div class="flex items-center justify-between gap-3 px-4 py-3 ${imageURL ? "" : "mt-1"}">
             <span class="font-body-sm text-body-sm text-slate-muted truncate">${escapeHtml(new URL(link).hostname.replace(/^www\./, ""))}</span>
             <span class="flex-shrink-0 px-4 py-1.5 rounded-full bg-primary-container text-white font-label-md text-label-md font-semibold">${escapeHtml(ad.cta || "Learn more")}</span>
           </div>`
        : `<div class="pb-4"></div>`
    }
  `;

  const card = document.createElement("article");
  card.className = "bg-slate-surface border-y border-slate-border overflow-hidden";
  card.dataset.adId = ad.id;
  card.innerHTML = `
    <div class="flex items-center justify-between gap-3 px-4 pt-4">
      <div class="flex items-center gap-3 min-w-0">
        <div class="relative w-10 h-10 rounded-full bg-primary-fixed text-primary flex items-center justify-center font-label-lg text-label-lg flex-shrink-0 overflow-hidden">
          ${initial}
          ${logoURL ? `<img src="${escapeHtml(logoURL)}" alt="" class="absolute inset-0 w-full h-full object-cover bg-white" onerror="this.remove()" />` : ""}
        </div>
        <div class="min-w-0">
          <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(advertiser)}</div>
          <div class="font-body-sm text-body-sm text-slate-muted">Sponsored</div>
        </div>
      </div>
      <button type="button" class="fz-ad-hide w-8 h-8 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container active:scale-95 transition-all flex-shrink-0" aria-label="Hide this ad">
        <span class="material-symbols-outlined text-[20px]">close</span>
      </button>
    </div>
    ${link ? `<a class="fz-ad-link block" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer sponsored">${body}</a>` : body}
  `;
  return card;
}

/* ---------------------------------------------------------------
   Slots
---------------------------------------------------------------- */
function closeSlot(slot) {
  slot.classList.remove("fz-open");
  setTimeout(() => slot.remove(), 600);
}

function openSlot(slot, instant) {
  if (instant) {
    slot.classList.add("fz-instant", "fz-open");
    return;
  }
  slot.getBoundingClientRect(); // make sure the closed state is painted first
  requestAnimationFrame(() => requestAnimationFrame(() => slot.classList.add("fz-open")));
}

function createSlot(ad, imageSize, placement) {
  const slot = document.createElement("div");
  slot.className = "fz-ad-slot";
  slot.dataset.adId = ad.id;

  const inner = document.createElement("div");
  inner.className = "fz-ad-inner";
  const card = buildAdCard(ad, imageSize);
  inner.appendChild(card);
  slot.appendChild(inner);

  card.querySelector(".fz-ad-hide").addEventListener("click", () => {
    rememberHidden(ad.id);
    document.querySelectorAll(`.fz-ad-slot[data-ad-id="${CSS.escape(ad.id)}"]`).forEach(closeSlot);
    showToast("Ad hidden");
  });

  const linkEl = card.querySelector(".fz-ad-link");
  if (linkEl) linkEl.addEventListener("click", () => track(ad.id, "clicks"));

  watchImpression(slot, ad.id, placement);
  return slot;
}

/* ---------------------------------------------------------------
   Public API
---------------------------------------------------------------- */
export function clearAds(container) {
  container.querySelectorAll(":scope > .fz-ad-slot").forEach((slot) => slot.remove());
}

/**
 * Inserts ads between the posts that are already in `container`.
 * Safe to call after every render: it never throws and never leaves an empty gap.
 */
export async function insertAds(container, { placement = "feed" } = {}) {
  try {
    if (!container) return;
    injectStyles();

    // Only the latest call for this container may insert anything
    const run = (container.__fzAdsRun = (container.__fzAdsRun || 0) + 1);
    clearAds(container);

    const { config, ads } = await loadData();
    if (container.__fzAdsRun !== run) return;
    if (!config.enabled) return;

    const hidden = getHiddenIds();
    const now = Date.now();
    const eligible = ads.filter((ad) => isEligible(ad, placement, now, hidden));
    if (!eligible.length) return;

    // Which posts get an ad after them
    const posts = Array.from(container.children).filter((el) => el.tagName === "ARTICLE");
    const { firstAfter, every } = config[placement] || config.feed;
    const anchors = [];
    posts.forEach((post, index) => {
      const position = index + 1;
      const isSpot = position === firstAfter || (position > firstAfter && (position - firstAfter) % every === 0);
      if (isSpot && position < posts.length) anchors.push(post);
    });
    if (!anchors.length) return;

    await Promise.all(
      anchors.map(async (anchor, slotIndex) => {
        // Try up to 3 different ads for this spot; if all fail, the spot simply stays empty
        for (let attempt = 0; attempt < Math.min(3, eligible.length); attempt++) {
          const ad = eligible[(rotation + slotIndex + attempt) % eligible.length];
          const imageSize = await preloadImage(safeUrl(ad.imageURL));
          if (imageSize === null) continue; // image failed: try the next ad

          if (container.__fzAdsRun !== run || !anchor.isConnected) return;

          const slot = createSlot(ad, imageSize, placement);
          anchor.after(slot);
          const instant = shownBefore.has(`${ad.id}:${placement}`);
          shownBefore.add(`${ad.id}:${placement}`);
          openSlot(slot, instant);
          return;
        }
      })
    );
  } catch (error) {
    // Ads must never break the page
    console.warn("Ads: skipped because of an error:", error);
  }
}