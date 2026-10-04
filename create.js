// FreeZone BD - Create Post page (opened by the + button in the bottom bar)
// A post can have up to 4 photos. The photos are uploaded to imgbb and only their links are saved in the database.
// While posting, the page shows a progress bar with the real upload percentage, one percentage per photo, and a Cancel button.

import {
  ref,
  push,
  set,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb, prepareImage } from "./imgbb.js";
import { escapeHtml, avatarHtml, showToast } from "./post.js";

const TEXT_MAX = 500;
const MAX_IMAGES = 4;
const MAX_FILE_MB = 10;

/**
 * @param {HTMLElement} container
 * @param {object} ctx  { db, currentUser, currentProfile, closePage? }
 */
export function mount(container, ctx = {}) {
  const { db, currentUser } = ctx;
  const profile = ctx.currentProfile || { name: "You", username: "", photoURL: "" };

  if (!db || !currentUser) {
    container.innerHTML = `<p class="text-center text-slate-muted text-sm py-16 px-6">Please log in to create a post.</p>`;
    return;
  }

  let images = []; // [{ blob, url }]  url is only for the preview on this page
  let posting = false;
  let controller = null; // lets the Cancel button stop the uploads

  container.innerHTML = `
    <div class="fz-create px-3 sm:px-4 py-4 space-y-4">
      <div class="bg-slate-surface border border-slate-border rounded-2xl shadow-sm p-4 space-y-3">
        <div class="flex items-center gap-3">
          ${avatarHtml(profile.photoURL, "w-11 h-11")}
          <div class="min-w-0">
            <div class="font-label-lg text-label-lg text-on-surface truncate">${escapeHtml(profile.name || "FreeZone User")}</div>
            ${profile.username ? `<div class="font-body-sm text-body-sm text-slate-muted truncate">@${escapeHtml(profile.username)}</div>` : ""}
          </div>
        </div>

        <textarea class="fz-text w-full resize-none bg-transparent text-[17px] leading-relaxed text-on-surface placeholder:text-slate-subtle outline-none min-h-[140px] disabled:opacity-60" maxlength="${TEXT_MAX}" placeholder="What's on your mind?"></textarea>

        <div class="fz-previews grid grid-cols-2 gap-2 hidden"></div>

        <div class="flex items-center justify-between pt-2 border-t border-slate-border/70">
          <button type="button" class="fz-add-photo flex items-center gap-1.5 px-3 py-2 rounded-xl text-primary hover:bg-primary-fixed/40 active:scale-95 transition-all font-label-md text-label-md font-semibold disabled:opacity-40 disabled:pointer-events-none">
            <span class="material-symbols-outlined text-[20px]">add_photo_alternate</span>
            <span class="fz-photo-label">Photo</span>
          </button>
          <span class="fz-count text-slate-subtle font-body-sm text-body-sm">0/${TEXT_MAX}</span>
        </div>
      </div>

      <input type="file" accept="image/*" multiple class="fz-file" hidden />

      <!-- Shown while posting -->
      <div class="fz-progress hidden bg-slate-surface border border-slate-border rounded-2xl shadow-sm p-4 space-y-3" role="status" aria-live="polite">
        <div class="flex items-center justify-between gap-3">
          <span class="fz-p-title font-label-lg text-label-lg text-on-surface">Uploading photos</span>
          <span class="fz-p-percent font-label-lg text-label-lg text-primary">0%</span>
        </div>
        <div class="h-2.5 rounded-full bg-surface-container overflow-hidden">
          <div class="fz-p-bar h-full rounded-full bg-primary-container transition-all duration-200 ease-out" style="width:0%"></div>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="fz-p-sub font-body-sm text-body-sm text-slate-muted"></span>
          <button type="button" class="fz-p-cancel font-label-md text-label-md font-semibold text-error">Cancel</button>
        </div>
      </div>

      <button type="button" class="fz-post w-full py-3 rounded-xl bg-primary-container text-white font-label-lg text-label-lg font-semibold shadow-md shadow-primary-container/25 active:scale-[.98] transition-all disabled:opacity-50" disabled>Post</button>
    </div>
  `;

  const textEl = container.querySelector(".fz-text");
  const countEl = container.querySelector(".fz-count");
  const fileEl = container.querySelector(".fz-file");
  const previewsEl = container.querySelector(".fz-previews");
  const addBtn = container.querySelector(".fz-add-photo");
  const photoLabel = container.querySelector(".fz-photo-label");
  const postBtn = container.querySelector(".fz-post");
  const progressEl = container.querySelector(".fz-progress");
  const titleEl = container.querySelector(".fz-p-title");
  const percentEl = container.querySelector(".fz-p-percent");
  const barEl = container.querySelector(".fz-p-bar");
  const subEl = container.querySelector(".fz-p-sub");

  /* ---- form state ---- */
  const refresh = () => {
    countEl.textContent = `${textEl.value.length}/${TEXT_MAX}`;
    postBtn.disabled = posting || (!textEl.value.trim() && !images.length);
    addBtn.disabled = posting || images.length >= MAX_IMAGES;
    textEl.disabled = posting;
    photoLabel.textContent = images.length ? `Photo ${images.length}/${MAX_IMAGES}` : "Photo";
  };

  const renderPreviews = () => {
    previewsEl.className = `fz-previews grid ${images.length === 1 ? "grid-cols-1" : "grid-cols-2"} gap-2 ${images.length ? "" : "hidden"}`;
    previewsEl.innerHTML = images
      .map(
        (image, index) => `
        <div class="relative ${images.length === 1 ? "" : "aspect-square"} rounded-xl overflow-hidden border border-slate-border bg-surface-container">
          <img src="${image.url}" alt="Photo ${index + 1}" class="${images.length === 1 ? "w-full max-h-80 object-cover block" : "absolute inset-0 w-full h-full object-cover"}" />
          <button type="button" class="fz-remove absolute top-2 right-2 w-8 h-8 rounded-full bg-black/60 text-white flex items-center justify-center active:scale-90 transition-transform" data-index="${index}" aria-label="Remove photo ${index + 1}">
            <span class="material-symbols-outlined text-[18px]">close</span>
          </button>
          <div class="fz-tile-ov hidden absolute inset-0 bg-black/55 flex-col items-center justify-center text-white font-label-lg text-label-lg" data-ov="${index}"></div>
        </div>`
      )
      .join("");
    refresh();
  };

  /* ---- progress display ---- */
  // state of each photo while uploading: "waiting" | "uploading" | "processing" | "done" | "failed"
  const showTile = (index, state, fraction = 0) => {
    const el = previewsEl.querySelector(`[data-ov="${index}"]`);
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
    el.innerHTML =
      state === "done"
        ? `<span class="material-symbols-outlined text-[34px] text-emerald-300" style="font-variation-settings:'FILL' 1;">check_circle</span>`
        : state === "failed"
          ? `<span class="material-symbols-outlined text-[34px] text-red-300" style="font-variation-settings:'FILL' 1;">error</span><span class="text-[12px] mt-1">Failed</span>`
          : state === "processing"
            ? `<span class="text-[14px]">Processing...</span>`
            : `<span class="text-[22px] font-bold">${Math.round(fraction * 100)}%</span>`;
  };

  const hideTileOverlays = () => {
    previewsEl.querySelectorAll(".fz-tile-ov").forEach((el) => {
      el.classList.add("hidden");
      el.classList.remove("flex");
    });
  };

  const setProgress = (fraction, title, sub) => {
    const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
    barEl.style.width = `${percent}%`;
    percentEl.textContent = `${percent}%`;
    if (title) titleEl.textContent = title;
    if (sub !== undefined) subEl.textContent = sub;
  };

  const setPosting = (value) => {
    posting = value;
    progressEl.classList.toggle("hidden", !value);
    previewsEl.querySelectorAll(".fz-remove").forEach((button) => button.classList.toggle("hidden", value));
    if (!value) hideTileOverlays();
    refresh();
  };

  /* ---- events ---- */
  textEl.addEventListener("input", refresh);
  addBtn.addEventListener("click", () => fileEl.click());

  previewsEl.addEventListener("click", (event) => {
    const button = event.target.closest(".fz-remove");
    if (!button || posting) return;
    const [removed] = images.splice(Number(button.dataset.index), 1);
    if (removed) URL.revokeObjectURL(removed.url);
    renderPreviews();
  });

  container.querySelector(".fz-p-cancel").addEventListener("click", () => controller && controller.abort());

  fileEl.addEventListener("change", async () => {
    const files = Array.from(fileEl.files);
    fileEl.value = "";
    if (!files.length) return;

    const room = MAX_IMAGES - images.length;
    if (files.length > room) showToast(`You can add up to ${MAX_IMAGES} photos`);

    for (const file of files.slice(0, Math.max(room, 0))) {
      if (!file.type.startsWith("image/")) {
        showToast("Only photos can be added");
        continue;
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        showToast(`A photo is too large (max ${MAX_FILE_MB} MB)`);
        continue;
      }
      try {
        const blob = await prepareImage(file);
        images.push({ blob, url: URL.createObjectURL(blob) });
      } catch (error) {
        console.error(error);
        showToast("Could not open one of the photos");
      }
    }
    renderPreviews();
  });

  postBtn.addEventListener("click", async () => {
    const text = textEl.value.trim();
    if (posting || (!text && !images.length)) return;

    setPosting(true);
    controller = new AbortController();

    try {
      /* 1. Upload every photo at the same time, keeping their order */
      let urls = [];
      if (images.length) {
        const progress = images.map(() => 0);
        const total = images.length;
        const overall = () => progress.reduce((sum, value) => sum + value, 0) / total;
        const finished = () => progress.filter((value) => value >= 1).length;

        setProgress(0, "Uploading photos", `0 of ${total} photos done`);
        images.forEach((image, index) => showTile(index, "uploading", 0));

        const results = await Promise.allSettled(
          images.map((image, index) =>
            uploadToImgbb(image.blob, `photo-${index + 1}.jpg`, {
              signal: controller.signal,
              onProgress: (fraction) => {
                progress[index] = fraction;
                // The bytes are sent, now imgbb is saving the photo
                showTile(index, fraction >= 1 ? "processing" : "uploading", fraction);
                setProgress(overall() * 0.97, "Uploading photos", `${finished()} of ${total} photos done`);
              }
            }).then(
              (url) => {
                showTile(index, "done");
                return url;
              },
              (error) => {
                showTile(index, error && error.name === "AbortError" ? "uploading" : "failed", progress[index]);
                throw error;
              }
            )
          )
        );

        const cancelled = results.some((result) => result.status === "rejected" && result.reason && result.reason.name === "AbortError");
        if (cancelled) {
          showToast("Upload cancelled");
          setPosting(false);
          return;
        }

        urls = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
        const failed = total - urls.length;

        if (failed > 0) {
          console.error("Photo upload failed:", results.filter((result) => result.status === "rejected"));
          const message = urls.length
            ? `${failed}টি ছবি আপলোড হয়নি। বাকি ${urls.length}টি ছবি নিয়ে পোস্ট করবেন?\n\n${failed} photo(s) failed to upload. Post with the other ${urls.length}?`
            : "ছবি আপলোড হয়নি। ছবি ছাড়া শুধু লেখা পোস্ট করবেন?\n\nImage upload failed. Post the text without the photos?";
          if ((!text && !urls.length) || !confirm(message)) {
            setPosting(false);
            return;
          }
        }
      }

      /* 2. Save the post */
      controller = null;
      container.querySelector(".fz-p-cancel").classList.add("hidden"); // too late to cancel now
      setProgress(1, "Publishing your post", "Almost done...");

      const postRef = push(ref(db, "posts"));
      await set(postRef, {
        uid: currentUser.uid,
        name: profile.name || "FreeZone User",
        username: profile.username || "",
        photoURL: profile.photoURL || "",
        text,
        imageURL: urls[0] || "", // the first photo, for older parts of the app
        ...(urls.length ? { imageURLs: urls } : {}),
        createdAt: serverTimestamp(),
        likesCount: 0,
        commentsCount: 0
      });

      images.forEach((image) => URL.revokeObjectURL(image.url));
      showToast("Posted");
      if (ctx.closePage) ctx.closePage();
      else container.innerHTML = "";
    } catch (error) {
      console.error(error);
      showToast(error.code === "PERMISSION_DENIED" ? "Could not post: database rules block it" : "Could not post right now. Try again.");
      container.querySelector(".fz-p-cancel")?.classList.remove("hidden");
      setPosting(false);
    }
  });
}