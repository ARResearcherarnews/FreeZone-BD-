// FreeZone BD - Login / Sign up / Forgot password
import { auth, db } from "./config.js";
import { initTheme } from "./theme.js";
initTheme();

import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

import {
  ref,
  get,
  set,
  query,
  orderByChild,
  equalTo,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

/* ---------------------------------------------------------------
   Settings
---------------------------------------------------------------- */
const DEFAULT_PAGE = "./feed.html";
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------------------------------------------------------
   Messages (Bangla first, English below)
---------------------------------------------------------------- */
const MESSAGES = {
  "auth/invalid-credential": ["ইমেইল বা পাসওয়ার্ড ভুল হয়েছে।", "Incorrect email or password."],
  "auth/wrong-password": ["পাসওয়ার্ড ভুল হয়েছে।", "Incorrect password."],
  "auth/user-not-found": ["এই ইমেইলে কোনো অ্যাকাউন্ট নেই।", "No account found with this email."],
  "auth/invalid-email": ["ইমেইল ঠিকানাটি সঠিক নয়।", "Please enter a valid email address."],
  "auth/missing-password": ["পাসওয়ার্ড লিখুন।", "Please enter your password."],
  "auth/too-many-requests": ["অনেকবার চেষ্টা করা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।", "Too many attempts. Please try again later."],
  "auth/network-request-failed": ["ইন্টারনেট সংযোগ পাওয়া যাচ্ছে না।", "Please check your internet connection."],
  "auth/user-disabled": ["এই অ্যাকাউন্টটি বন্ধ করে দেওয়া হয়েছে।", "This account has been disabled."],
  "auth/email-already-in-use": ["এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট খোলা হয়েছে। লগইন করুন।", "This email is already registered. Try logging in."],
  "auth/weak-password": ["পাসওয়ার্ড অন্তত ৬ অক্ষরের হতে হবে।", "Password must be at least 6 characters."],
  "auth/operation-not-allowed": ["ইমেইল দিয়ে লগইন চালু করা নেই।", "Email/password sign-in is not enabled in Firebase."],
  "auth/requires-recent-login": ["আবার লগইন করে চেষ্টা করুন।", "Please log in again and retry."]
};

const CUSTOM = {
  "need-email": ["ইমেইল লিখুন।", "Please enter your email."],
  "need-password": ["পাসওয়ার্ড লিখুন।", "Please enter your password."],
  "need-name": ["নাম কমপক্ষে ২ অক্ষরের হতে হবে।", "Name must be at least 2 characters."],
  "bad-username": ["ইউজারনেম ৩–২০ অক্ষরের হতে হবে। শুধু ছোট হাতের ইংরেজি অক্ষর, সংখ্যা, _ এবং . চলবে।", "Username must be 3–20 characters: small letters, numbers, _ and . only."],
  "username-taken": ["এই ইউজারনেম আগে থেকেই আছে। অন্যটি চেষ্টা করুন।", "This username is already taken. Try another one."],
  "need-terms": ["চালিয়ে যেতে শর্তাবলী ও গোপনীয়তা নীতিতে সম্মতি দিন।", "Please accept the Terms and Privacy Policy to continue."],
  "profile-failed": ["প্রোফাইল তৈরি করা যায়নি। আবার চেষ্টা করুন।", "Could not create your profile. Please try again."],
  "reset-sent": ["পাসওয়ার্ড রিসেটের লিংক পাঠানো হয়েছে। ইনবক্স (এবং স্প্যাম) দেখুন।", "If an account exists for this email, a reset link has been sent."],
  "unknown": ["কিছু একটা ভুল হয়েছে। আবার চেষ্টা করুন।", "Something went wrong. Please try again."]
};

/* ---------------------------------------------------------------
   Elements
---------------------------------------------------------------- */
const $ = (selector) => document.querySelector(selector);

const bootEl = $("#boot");
const pageEl = $("#page");
const tabsEl = $("#tabs");
const alertEl = $("#alert");

const forms = {
  login: $("#loginForm"),
  signup: $("#signupForm"),
  reset: $("#resetForm")
};

const loginEmail = $("#loginEmail");
const loginPassword = $("#loginPassword");
const rememberMe = $("#rememberMe");
const loginBtn = $("#loginBtn");

const signupName = $("#signupName");
const signupUsername = $("#signupUsername");
const signupEmail = $("#signupEmail");
const signupPassword = $("#signupPassword");
const agreeTerms = $("#agreeTerms");
const signupBtn = $("#signupBtn");
const usernameHint = $("#usernameHint");

const resetEmail = $("#resetEmail");
const resetBtn = $("#resetBtn");

/* ---------------------------------------------------------------
   Redirect helpers
---------------------------------------------------------------- */
// Where to go after login. Supports ?next=feed.html?post=ID (same site only).
function getNextUrl() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return DEFAULT_PAGE;

  try {
    const url = new URL(next, window.location.href);
    const sameSite = url.origin === window.location.origin;
    const isLoginPage = /login\.html$/i.test(url.pathname);
    if (!sameSite || isLoginPage) return DEFAULT_PAGE;
    return url.pathname + url.search + url.hash;
  } catch (error) {
    return DEFAULT_PAGE;
  }
}

function goNext() {
  window.location.replace(getNextUrl());
}

/* ---------------------------------------------------------------
   UI helpers
---------------------------------------------------------------- */
function showAlert(type, key) {
  const pair = MESSAGES[key] || CUSTOM[key] || CUSTOM.unknown;
  const styles = {
    error: { box: "bg-error-container text-on-error-container", icon: "error" },
    success: { box: "bg-emerald-50 text-emerald-800", icon: "check_circle" }
  }[type];

  alertEl.className = `mb-4 rounded-xl px-3.5 py-3 flex items-start gap-2.5 text-[14px] ${styles.box}`;
  $("#alertIcon").textContent = styles.icon;
  $("#alertBn").textContent = pair[0];
  $("#alertEn").textContent = pair[1];
  alertEl.hidden = false;
}

function clearAlert() {
  alertEl.hidden = true;
  document.querySelectorAll(".field[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
}

function fail(input, key) {
  showAlert("error", key);
  if (input) {
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }
}

function setLoading(button, loading, label) {
  button.disabled = loading;
  button.innerHTML = loading ? `<span class="spinner"></span><span>${label}</span>` : label;
}

function showView(view, { focus = true } = {}) {
  clearAlert();
  Object.entries(forms).forEach(([name, form]) => (form.hidden = name !== view));
  tabsEl.hidden = view === "reset";

  [["login", $("#tabLogin")], ["signup", $("#tabSignup")]].forEach(([name, btn]) => {
    const active = name === view;
    btn.setAttribute("aria-selected", String(active));
    btn.className =
      "flex-1 py-2.5 rounded-lg text-[14px] font-semibold transition-all " +
      (active ? "bg-slate-surface text-primary shadow-sm" : "text-slate-muted");
  });

  const firstField = { login: loginEmail, signup: signupName, reset: resetEmail }[view];
  if (focus) firstField.focus();
}

function friendlyKey(error) {
  return MESSAGES[error?.code] ? error.code : "unknown";
}

/* ---------------------------------------------------------------
   Show / hide password
---------------------------------------------------------------- */
document.querySelectorAll("[data-toggle-password]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = button.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
    button.querySelector(".material-symbols-outlined").textContent = show ? "visibility_off" : "visibility";
  });
});

/* ---------------------------------------------------------------
   View switching
---------------------------------------------------------------- */
document.querySelectorAll("[data-view]").forEach((el) => {
  el.addEventListener("click", () => showView(el.dataset.view));
});

$("#forgotBtn").addEventListener("click", () => {
  resetEmail.value = loginEmail.value.trim();
  showView("reset");
});

// Clear the red border as soon as the user edits a field
document.addEventListener("input", (event) => {
  if (event.target.matches(".field")) event.target.removeAttribute("aria-invalid");
});

/* ---------------------------------------------------------------
   LOGIN
---------------------------------------------------------------- */
forms.login.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAlert();

  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email) return fail(loginEmail, "need-email");
  if (!EMAIL_RE.test(email)) return fail(loginEmail, "auth/invalid-email");
  if (!password) return fail(loginPassword, "need-password");

  setLoading(loginBtn, true, "Logging in...");
  try {
    // Remember me: stay logged in, or only until the browser/tab is closed
    await setPersistence(auth, rememberMe.checked ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    goNext();
  } catch (error) {
    console.error(error);
    showAlert("error", friendlyKey(error));
    setLoading(loginBtn, false, "Login");
  }
});

/* ---------------------------------------------------------------
   FORGOT PASSWORD
---------------------------------------------------------------- */
forms.reset.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAlert();

  const email = resetEmail.value.trim();
  if (!email) return fail(resetEmail, "need-email");
  if (!EMAIL_RE.test(email)) return fail(resetEmail, "auth/invalid-email");

  setLoading(resetBtn, true, "Sending...");
  try {
    await sendPasswordResetEmail(auth, email);
    showAlert("success", "reset-sent");
  } catch (error) {
    console.error(error);
    // For privacy we do not reveal whether the email exists
    if (error.code === "auth/user-not-found") showAlert("success", "reset-sent");
    else showAlert("error", friendlyKey(error));
  }
  setLoading(resetBtn, false, "Send reset link");
});

/* ---------------------------------------------------------------
   SIGN UP: username check + password strength
---------------------------------------------------------------- */
async function isUsernameTaken(username, ownUid) {
  const snap = await get(query(ref(db, "users"), orderByChild("username"), equalTo(username)));
  let taken = false;
  snap.forEach((child) => {
    if (child.key !== ownUid) taken = true;
  });
  return taken;
}

let usernameTimer = null;
let usernameRun = 0;

function setUsernameHint(text, tone) {
  const tones = { neutral: "text-slate-subtle", good: "text-online-emerald", bad: "text-error" };
  usernameHint.textContent = text;
  usernameHint.className = `text-[12.5px] mt-1 ${tones[tone]}`;
}

signupUsername.addEventListener("input", () => {
  signupUsername.value = signupUsername.value.replace(/^@/, "").toLowerCase().replace(/\s/g, "");
  const value = signupUsername.value;

  clearTimeout(usernameTimer);
  usernameRun++;

  if (!value) return setUsernameHint("3–20 characters: small letters, numbers, _ and .", "neutral");
  if (!USERNAME_RE.test(value)) {
    return setUsernameHint("Use 3–20 small letters, numbers, _ or . only", "bad");
  }

  setUsernameHint("Checking...", "neutral");
  const run = usernameRun;
  usernameTimer = setTimeout(async () => {
    try {
      const taken = await isUsernameTaken(value, null);
      if (run !== usernameRun) return;
      setUsernameHint(taken ? "This username is already taken" : "Username is available", taken ? "bad" : "good");
    } catch (error) {
      // Not logged in yet, so the database may not allow this lookup. It is checked again on sign up.
      if (run === usernameRun) setUsernameHint("Looks good", "neutral");
    }
  }, 500);
});

signupPassword.addEventListener("input", () => {
  const value = signupPassword.value;
  let score = 0;
  if (value.length >= 6) score++;
  if (value.length >= 10) score++;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
  if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
  if (!value) score = 0;

  const colors = ["bg-error", "bg-orange-400", "bg-yellow-400", "bg-online-emerald"];
  const labels = ["", "Weak", "Fair", "Good", "Strong"];
  document.querySelectorAll(".strength").forEach((bar, index) => {
    bar.className = "strength h-1 flex-1 rounded-full transition-colors " + (index < score ? colors[score - 1] : "bg-surface-container");
  });
  $("#strengthText").textContent = value ? labels[score] : "";
});

/* ---------------------------------------------------------------
   SIGN UP
---------------------------------------------------------------- */
let signingUp = false; // stops the "already logged in" redirect while the profile is being created

forms.signup.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearAlert();

  const name = signupName.value.trim().replace(/\s+/g, " ");
  const username = signupUsername.value.trim().replace(/^@/, "").toLowerCase();
  const email = signupEmail.value.trim();
  const password = signupPassword.value;

  if (name.length < 2) return fail(signupName, "need-name");
  if (!USERNAME_RE.test(username)) return fail(signupUsername, "bad-username");
  if (!email) return fail(signupEmail, "need-email");
  if (!EMAIL_RE.test(email)) return fail(signupEmail, "auth/invalid-email");
  if (password.length < 6) return fail(signupPassword, "auth/weak-password");
  if (!agreeTerms.checked) return showAlert("error", "need-terms");

  signingUp = true;
  setLoading(signupBtn, true, "Creating account...");

  let user = null;
  try {
    await setPersistence(auth, browserLocalPersistence);
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    user = credential.user;

    // Username must be unique (checked now, because the database needs a logged-in user)
    let taken = false;
    try {
      taken = await isUsernameTaken(username, user.uid);
    } catch (error) {
      console.warn("Could not verify username uniqueness:", error);
    }
    if (taken) {
      await user.delete().catch(() => signOut(auth));
      user = null;
      signingUp = false;
      setLoading(signupBtn, false, "Create account");
      return fail(signupUsername, "username-taken");
    }

    await updateProfile(user, { displayName: name }).catch(() => {});

    try {
      await set(ref(db, `users/${user.uid}`), {
        name,
        nameLower: name.toLowerCase(),
        username,
        photoURL: "",
        bio: "",
        createdAt: serverTimestamp()
      });
    } catch (error) {
      console.error("Profile write failed:", error);
      // Do not leave an account without a profile behind
      await user.delete().catch(() => signOut(auth));
      user = null;
      signingUp = false;
      setLoading(signupBtn, false, "Create account");
      return showAlert("error", "profile-failed");
    }

    goNext();
  } catch (error) {
    console.error(error);
    signingUp = false;
    showAlert("error", friendlyKey(error));
    setLoading(signupBtn, false, "Create account");
  }
});

/* ---------------------------------------------------------------
   Start: already logged in? go straight to the feed
---------------------------------------------------------------- */
let firstAuthCheck = true;

onAuthStateChanged(auth, (user) => {
  if (user && !signingUp) {
    goNext();
    return;
  }

  if (firstAuthCheck) {
    firstAuthCheck = false;
    bootEl.hidden = true;
    pageEl.hidden = false;

    const tab = new URLSearchParams(window.location.search).get("tab");
    showView(tab === "signup" ? "signup" : "login", { focus: false }); // no keyboard pop-up on load
  }
});