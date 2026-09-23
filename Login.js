// FreeZone BD — Authentication
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  ref, set, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { auth, db } from "./config.js";

const $ = s => document.querySelector(s);

function message(text, type="info") {
  const el = $("#authMessage");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.className = `message ${type}`;
}

export async function register() {
  const name = $("#regName")?.value.trim();
  const username = $("#regUsername")?.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const email = $("#regEmail")?.value.trim();
  const password = $("#regPassword")?.value || "";

  if (!name || !username || !email || password.length < 6) {
    message("সব তথ্য দিন। Password কমপক্ষে ৬ অক্ষরের হতে হবে।", "error");
    return;
  }

  try {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });

    await set(ref(db, `users/${credential.user.uid}`), {
      uid: credential.user.uid,
      name,
      username,
      email,
      photoURL: "",
      bio: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      online: true
    });

    location.href = "Feed.html";
  } catch (error) {
    message(error.message || "Registration failed.", "error");
  }
}

export async function login() {
  const email = $("#loginEmail")?.value.trim();
  const password = $("#loginPassword")?.value || "";

  if (!email || !password) {
    message("Email এবং password দিন।", "error");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
    location.href = "Feed.html";
  } catch (error) {
    message(error.message || "Login failed.", "error");
  }
}

export async function logout() {
  if (auth.currentUser) {
    await update(ref(db, `users/${auth.currentUser.uid}`), {
      online: false,
      updatedAt: serverTimestamp()
    }).catch(() => {});
  }
  await signOut(auth);
  location.href = "Index.html";
}
