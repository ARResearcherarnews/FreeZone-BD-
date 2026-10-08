// FreeZone BD - Report a problem
// Loaded by settings.js (Settings > Report a problem).
//
// Data (Firebase Realtime Database):  feedback/{myUid}/{id} = {
//   category, message, screenshotURL?, device?, appVersion, status: "new", createdAt }
// Only the sender can write it; the team reads it in the Firebase console (nobody can read it inside the app).

import { ref, push, set, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb, prepareImage } from "./imgbb.js";
import { escapeHtml, showToast } from "./post.js";
import { APP_VERSION } from "./app-info.js";

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 1000;
const SHOT_MAX_MB = 10;
const COOLDOWN_MS = 30 * 1000; // one report every 30 seconds
let lastSentAt = 0;

const CATEGORIES = [
  { key: "bug", label: "Something is broken", icon: "bug_report" },
  { key: "suggestion", label: "Suggestion", icon: "lightbulb" },
  { key: "account", label: "Account problem", icon: "manage_accounts" },
  { key: "safety", label: "Abuse or safety", icon: "shield" },
  { key: "other", label: "Something else", icon: "chat" }
];

const PLACEHOLDERS = {
  bug: "What did you do, what did you expect, and what happened instead?",
  suggestion: "What would make FreeZone BD better for you?",
  account: "Describe the problem with your account (never write your password).",
  safety: "Tell us what happened and the @username involved, if you know it.",
  other: "Tell us what is on your mind."
};

export function render(root, ctx) {
  const { ui, db, currentUser } = ctx;
  let category = "bug";
  let screenshotURL = "";
  let uploading = false;

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-12">
      ${ui.introHtml({
        icon: "flag",
        iconClass: "bg-primary-container/10 text-primary-container",
        title: "Report a problem",
        text: "Found a bug, have an idea, or need help? Tell us. Your message goes straight to the FreeZone BD team."
      })}

      <div class="rp-form px-4 mt-4 space-y-5">
        <div>
          <div class="${ui.LABEL}">What is it about?</div>
          <div class="rp-cats flex flex-wrap gap-2">
            ${CATEGORIES.map(
              (c) => `
              <button type="button" class="rp-cat flex items-center gap-1.5 px-3 py-2 rounded-full border font-label-md text-label-md transition-colors" data-key="${c.key}">
                <span class="material-symbols-outlined text-[18px]">${c.icon}</span>${escapeHtml(c.label)}
              </button>`
            ).join("")}
          </div>
        </div>

        <div>
          <label class="${ui.LABEL}" for="rpMessage">Describe it</label>
          <textarea id="rpMessage" rows="6" maxlength="${MESSAGE_MAX}" class="${ui.INPUT} resize-none"></textarea>
          <div class="flex items-start justify-between gap-3">
            <p class="${ui.HINT}">At least ${MESSAGE_MIN} characters. The more detail, the faster we can help.</p>
            <div class="rp-count font-body-sm text-body-sm text-slate-subtle mt-1 flex-shrink-0">0/${MESSAGE_MAX}</div>
          </div>
        </div>

        <div>
          <div class="${ui.LABEL}">Screenshot <span class="font-body-sm text-slate-subtle">(optional)</span></div>
          <input type="file" accept="image/*" class="rp-file" hidden />
          <button type="button" class="rp-pick w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-slate-border text-slate-muted font-label-lg text-label-lg hover:bg-surface-container-low active:scale-[.99] transition-all">
            <span class="material-symbols-outlined text-[20px]">add_photo_alternate</span><span class="rp-pick-text">Add a screenshot</span>
          </button>
          <div class="rp-shot mt-2" hidden>
            <div class="relative inline-block">
              <img class="rp-shot-img h-28 rounded-xl border border-slate-border object-cover" alt="Screenshot" />
              <button type="button" class="rp-shot-remove absolute -top-2 -right-2 w-7 h-7 rounded-full bg-black/70 text-white flex items-center justify-center" aria-label="Remove screenshot">
                <span class="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
          </div>
        </div>

        <label class="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" class="rp-device mt-1 w-4 h-4 accent-blue-600" checked />
          <span class="font-body-md text-body-md text-on-surface-variant">Include my device and browser details (helps us find the problem). No personal data is added.</span>
        </label>

        <p class="rp-error font-body-md text-body-md text-error" hidden></p>
        <button type="button" class="rp-send ${ui.BTN_PRIMARY}" disabled>Send report</button>
      </div>
    </div>`;

  const messageEl = root.querySelector("#rpMessage");
  const countEl = root.querySelector(".rp-count");
  const errorEl = root.querySelector(".rp-error");
  const sendBtn = root.querySelector(".rp-send");
  const fileEl = root.querySelector(".rp-file");
  const pickBtn = root.querySelector(".rp-pick");
  const pickText = root.querySelector(".rp-pick-text");
  const shotBox = root.querySelector(".rp-shot");
  const shotImg = root.querySelector(".rp-shot-img");

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };
  const refresh = () => {
    countEl.textContent = `${messageEl.value.length}/${MESSAGE_MAX}`;
    sendBtn.disabled = uploading || messageEl.value.trim().length < MESSAGE_MIN;
  };
  const paintCategories = () => {
    root.querySelectorAll(".rp-cat").forEach((button) => {
      const on = button.dataset.key === category;
      button.className = `rp-cat flex items-center gap-1.5 px-3 py-2 rounded-full border font-label-md text-label-md transition-colors ${
        on ? "bg-primary-container text-white border-primary-container" : "bg-slate-surface text-on-surface border-slate-border hover:bg-surface-container-low"
      }`;
    });
    messageEl.placeholder = PLACEHOLDERS[category];
  };
  paintCategories();
  refresh();

  root.querySelector(".rp-cats").addEventListener("click", (event) => {
    const button = event.target.closest(".rp-cat");
    if (!button) return;
    category = button.dataset.key;
    paintCategories();
  });
  messageEl.addEventListener("input", () => {
    showError("");
    refresh();
  });

  // Screenshot
  pickBtn.addEventListener("click", () => fileEl.click());
  fileEl.addEventListener("change", async () => {
    const file = fileEl.files[0];
    fileEl.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return showToast("Please choose an image file");
    if (file.size > SHOT_MAX_MB * 1024 * 1024) return showToast(`Image is too large (max ${SHOT_MAX_MB} MB)`);

    uploading = true;
    pickBtn.disabled = true;
    refresh();
    try {
      const blob = await prepareImage(file);
      screenshotURL = await uploadToImgbb(blob, "screenshot.jpg", {
        onProgress: (fraction) => (pickText.textContent = fraction < 1 ? `Uploading ${Math.round(fraction * 100)}%` : "Finishing...")
      });
      shotImg.src = screenshotURL;
      shotBox.hidden = false;
      pickBtn.hidden = true;
    } catch (error) {
      console.error("Screenshot upload:", error);
      showToast("Could not upload the screenshot. Try again.");
    }
    pickText.textContent = "Add a screenshot";
    pickBtn.disabled = false;
    uploading = false;
    refresh();
  });
  root.querySelector(".rp-shot-remove").addEventListener("click", () => {
    screenshotURL = "";
    shotBox.hidden = true;
    pickBtn.hidden = false;
  });

  // Send
  sendBtn.addEventListener("click", async () => {
    const message = messageEl.value.trim();
    if (message.length < MESSAGE_MIN) return showError(`Please write at least ${MESSAGE_MIN} characters.`);

    const wait = COOLDOWN_MS - (Date.now() - lastSentAt);
    if (wait > 0) return showError(`Please wait ${Math.ceil(wait / 1000)} seconds before sending another report.`);

    showError("");
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
    try {
      const entryRef = push(ref(db, `feedback/${currentUser.uid}`));
      const entry = {
        category,
        message,
        appVersion: APP_VERSION,
        status: "new",
        createdAt: serverTimestamp()
      };
      if (screenshotURL) entry.screenshotURL = screenshotURL;
      if (root.querySelector(".rp-device").checked) {
        entry.device = `${navigator.userAgent} | ${screen.width}x${screen.height}`.slice(0, 250);
      }
      await set(entryRef, entry);
      lastSentAt = Date.now();

      root.innerHTML = `
        <div class="max-w-lg mx-auto px-4 py-16 text-center">
          <div class="w-16 h-16 rounded-full bg-online-emerald/15 text-online-emerald mx-auto flex items-center justify-center">
            <span class="material-symbols-outlined text-[34px]">check_circle</span>
          </div>
          <h1 class="font-headline-sm text-headline-sm text-on-surface font-semibold mt-4">Thank you!</h1>
          <p class="font-body-md text-body-md text-slate-muted mt-2">We received your report and will look into it. Your reference is <b class="text-on-surface">#${escapeHtml(entryRef.key.slice(-6).toUpperCase())}</b>.</p>
          <button type="button" class="rp-done ${ui.BTN_PRIMARY} mt-6">Back to settings</button>
        </div>`;
      root.querySelector(".rp-done").addEventListener("click", () => ctx.goMain());
    } catch (error) {
      console.error("Report a problem:", error);
      showError(
        error.code === "PERMISSION_DENIED"
          ? "Could not send: publish the latest database.rules.json (it adds the feedback rules) and try again."
          : "Could not send your report. Check your internet and try again."
      );
      sendBtn.textContent = "Send report";
      sendBtn.disabled = false;
    }
  });
}