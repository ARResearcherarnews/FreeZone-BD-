// FreeZone BD - Settings
//
// Opened from the menu icon at the top right of the (own) Profile page, or from "Edit profile".
//
// Pages (each one is a full page with its own explanation):
//   main             the list of settings
//   edit-profile     photo, name (once every 60 days), bio. The username can never be changed.
//   change-password  current password + new password
//   delete-account   permanently deletes the account and its data
//
// Data (Firebase Realtime Database):
//   users/{uid}/name, nameLower, bio, photoURL
//   users/{uid}/nameChangedAt        time of the last name change (server time) -> 60 day rule
//   userSettings/{uid}/showActive    same value the Chat page uses
//
// To add a new setting to the list, add one row to buildSections(). To add a new page, add it to PAGES.

import {
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  sendPasswordResetEmail,
  deleteUser
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  update,
  query,
  orderByChild,
  equalTo,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { uploadToImgbb } from "./imgbb.js";
import { escapeHtml, avatarHtml, showToast } from "./post.js";
import { onBlocksChange, getBlockedIds, openBlockedAccounts } from "./block.js";
import { cropToSquareBlob, syncAuthorFields } from "./profile.js";

const NAME_MIN = 2;
const NAME_MAX = 40;
const BIO_MAX = 150;
const PASSWORD_MIN = 6;
const NAME_COOLDOWN_DAYS = 60;
const NAME_COOLDOWN_MS = NAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000; // must match database.rules.json
const PHOTO_MAX_MB = 10;
const DELETE_WORD = "DELETE";

const INPUT =
  "w-full bg-surface-container-low border border-transparent focus:border-primary-container focus:ring-2 focus:ring-primary-container/15 rounded-xl px-3.5 py-2.5 text-body-md text-body-md outline-none disabled:opacity-60";
const LABEL = "block font-label-lg text-label-lg text-on-surface mb-1.5";
const HINT = "font-body-sm text-body-sm text-slate-subtle mt-1";
const BTN_PRIMARY =
  "w-full py-3 rounded-xl font-label-lg text-label-lg font-semibold text-white bg-primary-container disabled:opacity-50 active:scale-[.98] transition-all";
const BTN_DANGER =
  "w-full py-3 rounded-xl font-label-lg text-label-lg font-semibold text-white bg-error disabled:opacity-50 active:scale-[.98] transition-all";

const formatDate = (ms) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

/* ---------------------------------------------------------------
   Small helpers
---------------------------------------------------------------- */
function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 px-6";
    overlay.innerHTML = `
      <div class="w-full max-w-sm bg-slate-surface rounded-3xl shadow-2xl p-5" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <h2 class="font-headline-sm text-headline-sm text-on-surface font-semibold">${escapeHtml(title)}</h2>
        <p class="font-body-md text-body-md text-slate-muted mt-2">${escapeHtml(message)}</p>
        <div class="flex gap-2.5 mt-5">
          <button type="button" class="cd-cancel flex-1 py-2.5 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-95 transition-all">Cancel</button>
          <button type="button" class="cd-ok flex-1 py-2.5 rounded-xl font-label-lg text-label-lg font-semibold text-white ${danger ? "bg-error" : "bg-primary-container"} active:scale-95 transition-all">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;

    const done = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") done(false);
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target === overlay || event.target.closest(".cd-cancel")) done(false);
      else if (event.target.closest(".cd-ok")) done(true);
    });
    document.body.appendChild(overlay);
    overlay.querySelector(".cd-cancel").focus();
  });
}

// Intro block at the top of every full page: icon, title and a short explanation
function introHtml({ icon, iconClass, title, text }) {
  return `
    <div class="px-4 pt-6 pb-2 text-center">
      <div class="w-14 h-14 rounded-full ${iconClass} mx-auto flex items-center justify-center">
        <span class="material-symbols-outlined text-[28px]">${icon}</span>
      </div>
      <h1 class="font-headline-sm text-headline-sm text-on-surface font-semibold mt-3">${escapeHtml(title)}</h1>
      <p class="font-body-md text-body-md text-slate-muted mt-1.5 max-w-sm mx-auto">${text}</p>
    </div>`;
}

function infoBox({ icon, tone = "info", html }) {
  const tones = {
    info: "bg-primary-container/10 text-on-surface",
    warn: "bg-error-container/60 text-on-surface",
    ok: "bg-online-emerald/10 text-on-surface"
  };
  return `
    <div class="flex items-start gap-3 rounded-2xl p-3.5 ${tones[tone]}">
      <span class="material-symbols-outlined text-[20px] mt-0.5 flex-shrink-0">${icon}</span>
      <div class="font-body-sm text-body-sm">${html}</div>
    </div>`;
}

function passwordField({ id, label, autocomplete }) {
  return `
    <div>
      <label class="${LABEL}" for="${id}">${label}</label>
      <div class="relative">
        <input id="${id}" type="password" autocomplete="${autocomplete}" class="${INPUT} pr-11" />
        <button type="button" class="pw-eye absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Show password" data-for="${id}">
          <span class="material-symbols-outlined text-[20px]">visibility</span>
        </button>
      </div>
    </div>`;
}

function wirePasswordEyes(root) {
  root.querySelectorAll(".pw-eye").forEach((button) => {
    button.addEventListener("click", () => {
      const input = root.querySelector(`#${button.dataset.for}`);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-label", show ? "Hide password" : "Show password");
      button.querySelector(".material-symbols-outlined").textContent = show ? "visibility_off" : "visibility";
    });
  });
}

function authMessage(error) {
  switch (error && error.code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
      return "Your current password is not correct.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few minutes and try again.";
    case "auth/weak-password":
      return `The new password is too weak. Use at least ${PASSWORD_MIN} characters.`;
    case "auth/network-request-failed":
      return "No internet connection. Please check your network and try again.";
    case "auth/requires-recent-login":
      return "For your security, please log out, log in again and then retry.";
    default:
      return "Something went wrong. Please try again.";
  }
}

const hasPasswordLogin = (user) => !!user && !!user.email && user.providerData.some((p) => p.providerId === "password");

/* ---------------------------------------------------------------
   Page: main list
---------------------------------------------------------------- */
const switchClass = (on) =>
  `st-switch relative flex-shrink-0 w-12 h-7 rounded-full transition-colors disabled:opacity-60 ${on ? "bg-online-emerald" : "bg-slate-border"}`;

function buildSections({ ctx, state, go }) {
  return [
    {
      title: "Your account",
      rows: [
        {
          id: "edit-profile",
          type: "link",
          icon: "edit",
          iconClass: "bg-primary-container/10 text-primary-container",
          label: "Edit profile",
          note: () => "Change your photo, name and bio",
          onClick: () => go("edit-profile")
        },
        {
          id: "change-password",
          type: "link",
          icon: "lock",
          iconClass: "bg-primary-container/10 text-primary-container",
          label: "Change password",
          note: () => "Keep your account safe with a strong password",
          onClick: () => go("change-password")
        }
      ]
    },
    {
      title: "Privacy",
      rows: [
        {
          id: "showActive",
          type: "switch",
          icon: "circle",
          iconClass: "bg-online-emerald/15 text-online-emerald",
          label: "Show my active status",
          note: (on) =>
            on
              ? "People you follow can see when you are active. Turn this off to hide it; you will then not see when others are active either."
              : "Hidden: nobody can see when you are active, and you cannot see when others are active.",
          get: () => state.showActive,
          save: async (value) => {
            await set(ref(ctx.db, `userSettings/${ctx.currentUser.uid}/showActive`), value);
            state.showActive = value;
          }
        },
        {
          id: "blocked",
          type: "link",
          icon: "block",
          iconClass: "bg-error-container text-error",
          label: "Blocked accounts",
          note: () => {
            const count = getBlockedIds().length;
            return count ? `${count} blocked` : "No blocked accounts";
          },
          onClick: () => openBlockedAccounts({ db: ctx.db, me: ctx.currentUser.uid })
        }
      ]
    },
    {
      title: "Log out and delete",
      rows: [
        {
          id: "logout",
          type: "link",
          icon: "logout",
          iconClass: "bg-surface-container text-on-surface-variant",
          label: "Log out",
          note: () => "Sign out of FreeZone BD on this device",
          onClick: async () => {
            const ok = await confirmDialog({
              title: "Log out?",
              message: "You will need your email and password to log in again.",
              confirmLabel: "Log out"
            });
            if (!ok) return;
            try {
              await signOut(ctx.auth); // feed.js notices the sign-out and sends the person to the login page
            } catch (error) {
              console.error("Log out:", error);
              showToast("Could not log out. Try again");
            }
          }
        },
        {
          id: "delete-account",
          type: "link",
          icon: "delete_forever",
          iconClass: "bg-error-container text-error",
          label: "Delete account",
          labelClass: "text-error",
          note: () => "Permanently delete your account and all your data",
          onClick: () => go("delete-account")
        }
      ]
    }
  ];
}

function rowHtml(row) {
  const icon = `
    <div class="w-11 h-11 rounded-full ${row.iconClass} flex items-center justify-center flex-shrink-0">
      <span class="material-symbols-outlined text-[22px]">${row.icon}</span>
    </div>`;
  const text = `
    <div class="min-w-0">
      <div class="font-label-lg text-label-lg ${row.labelClass || "text-on-surface"}">${escapeHtml(row.label)}</div>
      <p class="st-note font-body-sm text-body-sm text-slate-muted mt-0.5">${escapeHtml(row.note(row.type === "switch" ? row.get() : undefined))}</p>
    </div>`;

  if (row.type === "switch") {
    const on = row.get();
    return `
      <div class="st-row flex items-start justify-between gap-4 px-4 py-3.5" data-row="${row.id}">
        <div class="flex items-start gap-3.5 min-w-0">${icon}${text}</div>
        <button type="button" role="switch" aria-checked="${on}" aria-label="${escapeHtml(row.label)}" class="${switchClass(on)} mt-2">
          <span class="st-knob absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform" style="transform:translateX(${on ? 20 : 0}px)"></span>
        </button>
      </div>`;
  }

  return `
    <button type="button" class="st-row w-full flex items-center justify-between gap-4 px-4 py-3.5 text-left hover:bg-surface-container-low active:bg-surface-container transition-colors" data-row="${row.id}">
      <div class="flex items-center gap-3.5 min-w-0">${icon}${text}</div>
      <span class="material-symbols-outlined text-slate-subtle">chevron_right</span>
    </button>`;
}

async function renderMain(root, ctx, { go }) {
  const { currentUser, db } = ctx;
  const profile = ctx.currentProfile || {};
  const name = profile.name || currentUser.displayName || "You";
  const handle = profile.username ? `@${profile.username}` : "";

  // Saved values (default: on)
  const state = { showActive: true };
  try {
    const snap = await get(ref(db, `userSettings/${currentUser.uid}/showActive`));
    state.showActive = snap.val() !== false;
  } catch (error) {
    console.error("Settings:", error);
  }

  const sections = buildSections({ ctx, state, go });
  const rowsById = new Map();
  sections.forEach((section) => section.rows.forEach((row) => rowsById.set(row.id, row)));

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-10">
      <button type="button" class="st-account w-full flex items-center gap-4 px-4 py-4 text-left hover:bg-surface-container-low active:bg-surface-container transition-colors" aria-label="Open my profile">
        ${avatarHtml(profile.photoURL, "w-14 h-14")}
        <div class="min-w-0 flex-1">
          <div class="font-headline-sm text-headline-sm text-on-surface font-semibold truncate">${escapeHtml(name)}</div>
          <div class="font-body-sm text-body-sm text-slate-muted truncate">${escapeHtml(handle)}</div>
        </div>
        <span class="material-symbols-outlined text-slate-subtle">chevron_right</span>
      </button>

      ${sections
        .map(
          (section) => `
        <div class="px-4 pt-5 pb-1 font-label-md text-label-md text-slate-subtle uppercase tracking-wide">${escapeHtml(section.title)}</div>
        <div class="bg-slate-surface divide-y divide-slate-border/60 border-y border-slate-border/60">
          ${section.rows.map((row) => rowHtml(row)).join("")}
        </div>`
        )
        .join("")}
    </div>`;

  root.querySelector(".st-account").addEventListener("click", () => ctx.onBack?.());

  root.querySelectorAll(".st-row").forEach((el) => {
    const row = rowsById.get(el.dataset.row);
    if (!row) return;
    const noteEl = el.querySelector(".st-note");

    if (row.type === "switch") {
      const switchEl = el.querySelector(".st-switch");
      const knobEl = el.querySelector(".st-knob");
      const paint = (on) => {
        switchEl.setAttribute("aria-checked", String(on));
        switchEl.className = `${switchClass(on)} mt-2`;
        knobEl.style.transform = `translateX(${on ? 20 : 0}px)`;
        noteEl.textContent = row.note(on);
      };

      switchEl.addEventListener("click", async () => {
        const next = !(switchEl.getAttribute("aria-checked") === "true");
        switchEl.disabled = true;
        paint(next);
        try {
          await row.save(next);
        } catch (error) {
          console.error("Settings:", error);
          paint(!next); // put the switch back
          showToast(error.code === "PERMISSION_DENIED" ? "Could not save: database rules block it" : "Could not save the setting");
        }
        switchEl.disabled = false;
      });
    } else {
      el.addEventListener("click", () => row.onClick());
    }
  });

  // The "Blocked accounts" count follows changes made in the list
  const blockedNote = root.querySelector('[data-row="blocked"] .st-note');
  let stop = () => {};
  if (blockedNote) {
    stop = onBlocksChange(() => {
      if (!blockedNote.isConnected) return stop();
      blockedNote.textContent = rowsById.get("blocked").note();
    });
  }
  return stop; // called when this page is replaced
}

/* ---------------------------------------------------------------
   Page: Edit profile
---------------------------------------------------------------- */
async function renderEditProfile(root, ctx) {
  const { db, currentUser } = ctx;
  const uid = currentUser.uid;

  root.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-16">Loading...</p>`;

  let user;
  try {
    const snap = await get(ref(db, `users/${uid}`));
    user = snap.val() || {};
  } catch (error) {
    console.error("Edit profile:", error);
    root.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-16">Could not load your profile. Please try again.</p>`;
    return;
  }

  const lastChange = Number(user.nameChangedAt) || 0;
  const nextChange = lastChange + NAME_COOLDOWN_MS;
  const nameLocked = lastChange > 0 && Date.now() < nextChange;

  const nameNote = nameLocked
    ? infoBox({
        icon: "schedule",
        tone: "warn",
        html: `You changed your name on <b>${formatDate(lastChange)}</b>. You can change it again on <b>${formatDate(nextChange)}</b>.`
      })
    : infoBox({
        icon: "info",
        html: `You can change your name <b>once every ${NAME_COOLDOWN_DAYS} days</b>. After you change it, it stays locked for ${NAME_COOLDOWN_DAYS} days. Bio and photo can be changed any time.`
      });

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-10">
      ${introHtml({
        icon: "edit",
        iconClass: "bg-primary-container/10 text-primary-container",
        title: "Edit profile",
        text: "This is how other people see you on FreeZone BD: on your posts, comments, stories and in chats."
      })}

      <div class="px-4 mt-4 space-y-5">
        <div class="flex flex-col items-center">
          <button type="button" class="ep-photo relative rounded-full active:scale-95 transition-transform" aria-label="Change profile photo">
            <span class="ep-avatar block">${avatarHtml(user.photoURL, "w-24 h-24")}</span>
            <span class="ep-photo-busy absolute inset-0 rounded-full bg-black/45 text-white font-label-lg text-label-lg flex items-center justify-center" hidden></span>
            <span class="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-primary-container text-white flex items-center justify-center ring-2 ring-slate-surface">
              <span class="material-symbols-outlined text-[18px]">photo_camera</span>
            </span>
          </button>
          <input type="file" accept="image/*" class="ep-photo-input" hidden />
          <p class="${HINT} text-center">Tap the photo to change it. A new photo is saved as soon as it is uploaded (max ${PHOTO_MAX_MB} MB).</p>
        </div>

        <div>
          <label class="${LABEL}" for="epName">Name</label>
          <input id="epName" type="text" maxlength="${NAME_MAX}" value="${escapeHtml(user.name || "")}" class="${INPUT}" ${nameLocked ? "disabled" : ""} />
          <p class="${HINT}">${NAME_MIN}-${NAME_MAX} characters. This is your display name; it can be your real name or any name you like.</p>
          <div class="mt-2">${nameNote}</div>
        </div>

        <div>
          <label class="${LABEL}" for="epUsername">Username</label>
          <div class="flex items-center bg-surface-container rounded-xl px-3.5 opacity-80">
            <span class="text-slate-muted text-body-md">@</span>
            <input id="epUsername" type="text" value="${escapeHtml(user.username || "")}" class="flex-1 bg-transparent py-2.5 pl-1 text-body-md text-body-md outline-none" readonly />
            <span class="material-symbols-outlined text-slate-muted text-[20px]">lock</span>
          </div>
          <p class="${HINT}">Your username cannot be changed. It is used in your profile link and for people to find you, so it stays the same.</p>
        </div>

        <div>
          <label class="${LABEL}" for="epBio">Bio</label>
          <textarea id="epBio" rows="4" maxlength="${BIO_MAX}" class="${INPUT} resize-none" placeholder="Tell people a little about yourself">${escapeHtml(user.bio || "")}</textarea>
          <div class="flex items-start justify-between gap-3">
            <p class="${HINT}">A short line shown under your name on your profile.</p>
            <div class="ep-count font-body-sm text-body-sm text-slate-subtle mt-1 flex-shrink-0">0/${BIO_MAX}</div>
          </div>
        </div>

        <p class="ep-error font-body-md text-body-md text-error" hidden></p>
        <button type="button" class="ep-save ${BTN_PRIMARY}" disabled>Save changes</button>
      </div>
    </div>`;

  const nameEl = root.querySelector("#epName");
  const bioEl = root.querySelector("#epBio");
  const countEl = root.querySelector(".ep-count");
  const errorEl = root.querySelector(".ep-error");
  const saveBtn = root.querySelector(".ep-save");

  const cleanName = () => nameEl.value.trim().replace(/\s+/g, " ");
  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };
  const changed = () => (!nameLocked && cleanName() !== (user.name || "")) || bioEl.value.trim() !== (user.bio || "");
  const refresh = () => {
    countEl.textContent = `${bioEl.value.length}/${BIO_MAX}`;
    saveBtn.disabled = !changed();
  };
  refresh();
  nameEl.addEventListener("input", () => {
    showError("");
    refresh();
  });
  bioEl.addEventListener("input", refresh);

  // Photo
  const photoBtn = root.querySelector(".ep-photo");
  const photoInput = root.querySelector(".ep-photo-input");
  const busyEl = root.querySelector(".ep-photo-busy");
  photoBtn.addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files[0];
    photoInput.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return showToast("Please choose an image file");
    if (file.size > PHOTO_MAX_MB * 1024 * 1024) return showToast(`Image is too large (max ${PHOTO_MAX_MB} MB)`);

    busyEl.hidden = false;
    busyEl.textContent = "0%";
    photoBtn.disabled = true;
    try {
      const blob = await cropToSquareBlob(file);
      const photoURL = await uploadToImgbb(blob, "avatar.jpg", {
        onProgress: (fraction) => (busyEl.textContent = fraction < 1 ? `${Math.round(fraction * 100)}%` : "...")
      });
      await update(ref(db, `users/${uid}`), { photoURL });
      user.photoURL = photoURL;
      if (ctx.currentProfile) ctx.currentProfile.photoURL = photoURL;
      root.querySelector(".ep-avatar").innerHTML = avatarHtml(photoURL, "w-24 h-24");
      const navAvatarEl = document.getElementById("navAvatar");
      if (navAvatarEl) navAvatarEl.innerHTML = `<img class="w-full h-full object-cover" src="${escapeHtml(photoURL)}" alt="avatar" />`;
      syncAuthorFields(db, uid, { photoURL });
      showToast("Profile photo updated");
    } catch (error) {
      console.error("Edit profile photo:", error);
      showToast("Could not update photo. Try again.");
    }
    busyEl.hidden = true;
    photoBtn.disabled = false;
  });

  // Save
  saveBtn.addEventListener("click", async () => {
    const name = cleanName();
    const bio = bioEl.value.trim();
    const nameChanged = !nameLocked && name !== (user.name || "");
    const bioChanged = bio !== (user.bio || "");
    if (!nameChanged && !bioChanged) return;

    if (nameChanged && name.length < NAME_MIN) return showError(`Name must be at least ${NAME_MIN} characters.`);
    if (name.length > NAME_MAX) return showError(`Name can be at most ${NAME_MAX} characters.`);

    if (nameChanged) {
      const ok = await confirmDialog({
        title: "Change your name?",
        message: `Your name will change to "${name}". You will not be able to change it again for ${NAME_COOLDOWN_DAYS} days.`,
        confirmLabel: "Change name"
      });
      if (!ok) return;
    }

    showError("");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      const values = {};
      if (bioChanged) values.bio = bio;
      if (nameChanged) {
        values.name = name;
        values.nameLower = name.toLowerCase();
        values.nameChangedAt = serverTimestamp();
      }
      await update(ref(db, `users/${uid}`), values);

      if (ctx.currentProfile) {
        if (bioChanged) ctx.currentProfile.bio = bio;
        if (nameChanged) {
          ctx.currentProfile.name = name;
          ctx.currentProfile.nameLower = name.toLowerCase();
          ctx.currentProfile.nameChangedAt = Date.now();
        }
      }
      // Old posts and comments show the new name too (best effort)
      if (nameChanged) await syncAuthorFields(db, uid, { name });

      showToast("Profile updated");
      await renderEditProfile(root, ctx);
    } catch (error) {
      console.error("Edit profile:", error);
      showError(
        error.code === "PERMISSION_DENIED"
          ? nameChanged
            ? `Could not save. Your name can only be changed once every ${NAME_COOLDOWN_DAYS} days (or the database rules are not published).`
            : "Could not save: the database rules block it."
          : "Could not save your profile. Please try again."
      );
      saveBtn.textContent = "Save changes";
      saveBtn.disabled = false;
    }
  });
}

/* ---------------------------------------------------------------
   Page: Change password
---------------------------------------------------------------- */
function passwordStrength(value) {
  let score = 0;
  if (value.length >= PASSWORD_MIN) score++;
  if (value.length >= 10) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
  return value ? Math.max(1, score) : 0;
}

function renderChangePassword(root, ctx) {
  const { auth } = ctx;
  const user = auth.currentUser;

  if (!hasPasswordLogin(user)) {
    root.innerHTML = `
      <div class="max-w-lg mx-auto pb-10">
        ${introHtml({
          icon: "lock",
          iconClass: "bg-primary-container/10 text-primary-container",
          title: "Change password",
          text: "Your account does not use an email and password to log in, so there is no password to change here."
        })}
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-10">
      ${introHtml({
        icon: "lock",
        iconClass: "bg-primary-container/10 text-primary-container",
        title: "Change password",
        text: `Choose a new password for <b class="text-on-surface">${escapeHtml(user.email)}</b>. You will need your current password to confirm that it is you.`
      })}

      <form class="cp-form px-4 mt-4 space-y-4" novalidate>
        ${passwordField({ id: "cpCurrent", label: "Current password", autocomplete: "current-password" })}
        <div class="-mt-2 text-right">
          <button type="button" class="cp-forgot font-label-md text-label-md text-primary-container font-semibold">Forgot your password?</button>
        </div>

        ${passwordField({ id: "cpNew", label: "New password", autocomplete: "new-password" })}
        <div>
          <div class="cp-bars flex gap-1.5">
            <span class="h-1.5 flex-1 rounded-full bg-slate-border"></span><span class="h-1.5 flex-1 rounded-full bg-slate-border"></span><span class="h-1.5 flex-1 rounded-full bg-slate-border"></span><span class="h-1.5 flex-1 rounded-full bg-slate-border"></span>
          </div>
          <p class="cp-strength ${HINT}">At least ${PASSWORD_MIN} characters.</p>
        </div>

        ${passwordField({ id: "cpConfirm", label: "Confirm new password", autocomplete: "new-password" })}

        ${infoBox({
          icon: "tips_and_updates",
          html: `<b>Tips for a strong password</b><ul class="list-disc pl-4 mt-1 space-y-0.5"><li>Use 10 or more characters</li><li>Mix capital and small letters, numbers and symbols</li><li>Do not use your name, phone number or birth date</li><li>Do not reuse a password from another app</li></ul>`
        })}

        <p class="cp-error font-body-md text-body-md text-error" hidden></p>
        <button type="submit" class="cp-save ${BTN_PRIMARY}">Change password</button>
      </form>
    </div>`;

  wirePasswordEyes(root);

  const currentEl = root.querySelector("#cpCurrent");
  const newEl = root.querySelector("#cpNew");
  const confirmEl = root.querySelector("#cpConfirm");
  const errorEl = root.querySelector(".cp-error");
  const saveBtn = root.querySelector(".cp-save");
  const bars = [...root.querySelectorAll(".cp-bars span")];
  const strengthEl = root.querySelector(".cp-strength");

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };

  const STRENGTH = [
    { text: `At least ${PASSWORD_MIN} characters.`, color: "bg-slate-border" },
    { text: "Weak", color: "bg-error" },
    { text: "Fair", color: "bg-amber-500" },
    { text: "Good", color: "bg-online-emerald" },
    { text: "Strong", color: "bg-online-emerald" }
  ];
  newEl.addEventListener("input", () => {
    const score = passwordStrength(newEl.value);
    bars.forEach((bar, index) => {
      bar.className = `h-1.5 flex-1 rounded-full ${index < score ? STRENGTH[score].color : "bg-slate-border"}`;
    });
    strengthEl.textContent = score ? `Strength: ${STRENGTH[score].text}` : STRENGTH[0].text;
  });

  root.querySelector(".cp-forgot").addEventListener("click", async () => {
    try {
      await sendPasswordResetEmail(auth, user.email);
      showToast(`Reset link sent to ${user.email}`);
    } catch (error) {
      console.error("Reset email:", error);
      showError(authMessage(error));
    }
  });

  root.querySelector(".cp-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = currentEl.value;
    const next = newEl.value;
    const again = confirmEl.value;

    if (!current) return showError("Enter your current password.");
    if (next.length < PASSWORD_MIN) return showError(`The new password must be at least ${PASSWORD_MIN} characters.`);
    if (next === current) return showError("The new password must be different from the current one.");
    if (next !== again) return showError("The new password and the confirmation do not match.");

    showError("");
    saveBtn.disabled = true;
    saveBtn.textContent = "Changing...";
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      await updatePassword(user, next);
      showToast("Password changed");
      renderChangePassword(root, ctx); // fresh, empty form
      const done = document.createElement("div");
      done.className = "px-4 mt-4";
      done.innerHTML = infoBox({
        icon: "check_circle",
        tone: "ok",
        html: "<b>Your password was changed.</b> Use the new password the next time you log in."
      });
      root.querySelector(".cp-form").prepend(done);
    } catch (error) {
      console.error("Change password:", error);
      showError(authMessage(error));
      saveBtn.disabled = false;
      saveBtn.textContent = "Change password";
    }
  });
}

/* ---------------------------------------------------------------
   Page: Delete account
---------------------------------------------------------------- */
// Removes my data from the database step by step (every step is best effort, so one blocked step does not
// stop the rest), then the profile, then the login itself.
async function deleteAccountData({ db, user, onStep }) {
  const uid = user.uid;
  const run = async (label, build) => {
    onStep(label);
    try {
      const paths = await build();
      if (paths && Object.keys(paths).length) await update(ref(db), paths);
    } catch (error) {
      console.warn(`Delete account - "${label}" skipped:`, error);
    }
  };

  // Do not let the presence "offline" write run after the account is gone
  try {
    await onDisconnect(ref(db, `presence/${uid}`)).cancel();
  } catch (error) {
    // ignore
  }

  await run("Removing your follows and followers...", async () => {
    const [followers, following] = await Promise.all([get(ref(db, `followers/${uid}`)), get(ref(db, `following/${uid}`))]);
    const paths = {};
    followers.forEach((child) => {
      paths[`followers/${uid}/${child.key}`] = null;
      paths[`following/${child.key}/${uid}`] = null;
    });
    following.forEach((child) => {
      paths[`following/${uid}/${child.key}`] = null;
      paths[`followers/${child.key}/${uid}`] = null;
    });
    return paths;
  });

  let chatLinks = [];
  await run("Deleting your chats...", async () => {
    const snap = await get(ref(db, `userChats/${uid}`));
    const paths = {};
    snap.forEach((child) => {
      const other = (child.val() || {}).with;
      chatLinks.push({ chatId: child.key, other });
      paths[`chats/${child.key}`] = null;
      paths[`userChats/${uid}/${child.key}`] = null;
      paths[`chatClears/${uid}/${child.key}`] = null;
    });
    return paths;
  });
  await run("Removing the chats from other inboxes...", async () => {
    const paths = {};
    chatLinks.forEach(({ chatId, other }) => {
      if (other) paths[`userChats/${other}/${chatId}`] = null;
    });
    return paths;
  });

  await run("Deleting your posts...", async () => {
    const snap = await get(query(ref(db, "posts"), orderByChild("uid"), equalTo(uid)));
    const paths = {};
    snap.forEach((child) => {
      paths[`posts/${child.key}`] = null;
    });
    return paths;
  });

  let storyIds = [];
  await run("Deleting your stories...", async () => {
    const snap = await get(ref(db, `stories/${uid}`));
    const paths = {};
    snap.forEach((child) => {
      storyIds.push(child.key);
      paths[`stories/${uid}/${child.key}`] = null;
    });
    return paths;
  });
  await run("Removing story views and reactions...", async () => {
    const paths = {};
    storyIds.forEach((id) => {
      paths[`storyViews/${uid}/${id}`] = null;
      paths[`storyReactions/${uid}/${id}`] = null;
    });
    return paths;
  });

  await run("Clearing your notifications...", async () => {
    const snap = await get(ref(db, `notifications/${uid}`));
    const paths = {};
    snap.forEach((child) => {
      paths[`notifications/${uid}/${child.key}`] = null;
    });
    return paths;
  });

  await run("Clearing your saved posts and settings...", async () => ({
    [`savedPosts/${uid}`]: null,
    [`storySeen/${uid}`]: null,
    [`blocks/${uid}`]: null,
    [`userSettings/${uid}`]: null,
    [`presence/${uid}`]: null
  }));

  // These two must succeed; if not, nothing is lost and the person can try again
  onStep("Deleting your profile...");
  await update(ref(db), { [`users/${uid}`]: null });

  onStep("Deleting your login...");
  await deleteUser(user);
}

function renderDeleteAccount(root, ctx) {
  const { auth, db } = ctx;
  const user = auth.currentUser;
  const canReauth = hasPasswordLogin(user);

  const li = (icon, text) =>
    `<li class="flex items-start gap-2.5"><span class="material-symbols-outlined text-[18px] mt-0.5 flex-shrink-0">${icon}</span><span>${text}</span></li>`;

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-12">
      ${introHtml({
        icon: "delete_forever",
        iconClass: "bg-error-container text-error",
        title: "Delete account",
        text: "This permanently deletes your FreeZone BD account. <b class='text-on-surface'>This cannot be undone.</b>"
      })}

      <div class="px-4 mt-4 space-y-4">
        <div class="rounded-2xl border border-slate-border bg-slate-surface p-4">
          <h2 class="font-label-lg text-label-lg text-on-surface font-semibold">What will be deleted</h2>
          <ul class="mt-2.5 space-y-2 font-body-md text-body-md text-on-surface-variant">
            ${li("person", "Your profile: name, username, photo and bio")}
            ${li("article", "All your posts, with their likes and comments")}
            ${li("auto_stories", "Your stories, and who viewed or reacted to them")}
            ${li("group", "Your followers and the people you follow")}
            ${li("chat", "Your chats. Messages in your conversations are deleted for the other person too")}
            ${li("bookmark", "Your saved posts, blocked list, notifications and settings")}
          </ul>
        </div>

        <div class="rounded-2xl border border-slate-border bg-slate-surface p-4">
          <h2 class="font-label-lg text-label-lg text-on-surface font-semibold">What may remain</h2>
          <ul class="mt-2.5 space-y-2 font-body-md text-body-md text-on-surface-variant">
            ${li("chat_bubble", "Comments you wrote on other people's posts may stay until those posts are removed")}
            ${li("image", "Photos are kept by our image host. FreeZone BD removes every link to them, but the image file itself may stay there for a while")}
          </ul>
        </div>

        ${infoBox({
          icon: "lightbulb",
          html: "Only need a break? You can simply <b>log out</b>, or turn off <b>Show my active status</b>. Your account and posts stay safe."
        })}

        ${
          canReauth
            ? `
        <form class="da-form space-y-4 pt-1" novalidate>
          <h2 class="font-label-lg text-label-lg text-on-surface font-semibold">Confirm it is you</h2>
          ${passwordField({ id: "daPassword", label: "Your password", autocomplete: "current-password" })}
          <div>
            <label class="${LABEL}" for="daWord">Type <b class="text-error">${DELETE_WORD}</b> to confirm</label>
            <input id="daWord" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" class="${INPUT}" placeholder="${DELETE_WORD}" />
          </div>
          <label class="flex items-start gap-3 cursor-pointer">
            <input id="daAgree" type="checkbox" class="mt-1 w-4 h-4 accent-red-600" />
            <span class="font-body-md text-body-md text-on-surface-variant">I understand that my account and data will be deleted forever and cannot be recovered.</span>
          </label>

          <p class="da-error font-body-md text-body-md text-error" hidden></p>
          <p class="da-step font-body-md text-body-md text-slate-muted text-center" hidden></p>
          <button type="submit" class="da-delete ${BTN_DANGER}" disabled>Delete my account permanently</button>
          <button type="button" class="da-cancel w-full py-3 rounded-xl font-label-lg text-label-lg text-on-surface bg-surface-container hover:bg-surface-container-high active:scale-[.98] transition-all">Keep my account</button>
        </form>`
            : `<div class="pt-1">${infoBox({
                icon: "info",
                tone: "warn",
                html: "Your account does not use an email and password, so it cannot be deleted from here. Please contact support."
              })}</div>`
        }
      </div>
    </div>`;

  if (!canReauth) return;
  wirePasswordEyes(root);

  const form = root.querySelector(".da-form");
  const passwordEl = root.querySelector("#daPassword");
  const wordEl = root.querySelector("#daWord");
  const agreeEl = root.querySelector("#daAgree");
  const errorEl = root.querySelector(".da-error");
  const stepEl = root.querySelector(".da-step");
  const deleteBtn = root.querySelector(".da-delete");

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };
  const ready = () => passwordEl.value.length > 0 && wordEl.value.trim() === DELETE_WORD && agreeEl.checked;
  const refresh = () => (deleteBtn.disabled = !ready());
  [passwordEl, wordEl].forEach((el) => el.addEventListener("input", refresh));
  agreeEl.addEventListener("change", refresh);

  root.querySelector(".da-cancel").addEventListener("click", () => ctx.goMain());

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!ready()) return;

    const ok = await confirmDialog({
      title: "Delete your account forever?",
      message: "Everything listed on this page will be deleted. You will not be able to get it back.",
      confirmLabel: "Delete forever",
      danger: true
    });
    if (!ok) return;

    showError("");
    form.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
    stepEl.hidden = false;
    stepEl.textContent = "Checking your password...";

    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, passwordEl.value));
    } catch (error) {
      console.error("Delete account (password):", error);
      form.querySelectorAll("input, button").forEach((el) => (el.disabled = false));
      stepEl.hidden = true;
      showError(authMessage(error));
      refresh();
      return;
    }

    try {
      await deleteAccountData({ db, user, onStep: (text) => (stepEl.textContent = text) });
      stepEl.textContent = "Your account was deleted. Goodbye!";
      setTimeout(() => location.replace("login.html"), 1200);
    } catch (error) {
      console.error("Delete account:", error);
      form.querySelectorAll("input, button").forEach((el) => (el.disabled = false));
      stepEl.hidden = true;
      showError(
        error.code === "PERMISSION_DENIED"
          ? "Could not delete your profile: the database rules block it. Publish the latest database.rules.json and try again."
          : authMessage(error)
      );
      refresh();
    }
  });
}

/* ---------------------------------------------------------------
   Pages and navigation
---------------------------------------------------------------- */
const PAGES = {
  main: { title: "Settings", render: renderMain },
  "edit-profile": { title: "Edit profile", render: (root, ctx) => renderEditProfile(root, ctx) },
  "change-password": { title: "Change password", render: (root, ctx) => renderChangePassword(root, ctx) },
  "delete-account": { title: "Delete account", render: (root, ctx) => renderDeleteAccount(root, ctx) }
};

export async function mount(container, ctx = {}) {
  if (!ctx.currentUser) {
    container.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Please log in again.</p>`;
    return;
  }

  const startPage = PAGES[ctx.startPage] ? ctx.startPage : "main";
  let stopMain = () => {};
  let token = 0; // ignores a page that finished loading after the person already went somewhere else

  const go = async (key) => {
    const page = PAGES[key] || PAGES.main;
    const mine = ++token;
    stopMain();
    stopMain = () => {};

    ctx.setTitle?.(page.title);
    ctx.setActions?.([]);
    // Back: a sub page returns to the list (or to the profile when it was opened straight from there)
    ctx.setBack?.(key === "main" ? () => ctx.onBack?.() : () => (startPage === key && key !== "main" ? ctx.onBack?.() : go("main")));
    container.scrollTop = 0;
    container.parentElement && (container.parentElement.scrollTop = 0);

    const result = await page.render(container, { ...ctx, goMain: () => go("main") }, { go });
    if (mine === token && typeof result === "function") stopMain = result;
    else if (typeof result === "function") result();
  };

  await go(startPage);
}