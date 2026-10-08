// FreeZone BD - Mute: hide someone's posts from my feed without blocking them.
// Data: mutes/{myUid}/{theirUid} = timestamp (only I can read or write it). The other person is never told.
import { ref, set, remove, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

let muted = new Set();
const listeners = new Set();
let started = false;

export function startMutes({ db, currentUser } = {}) {
  if (started || !db || !currentUser) return;
  started = true;
  onValue(
    ref(db, `mutes/${currentUser.uid}`),
    (snap) => {
      muted = new Set(snap.exists() ? Object.keys(snap.val()) : []);
      listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn("Mutes listener failed:", e); } });
    },
    () => {}
  );
}

export const isMuted = (uid) => muted.has(uid);

/** Calls `callback` whenever the muted list changes. Returns a function that stops it. */
export function onMutesChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export async function muteAccount({ db, me, uid }) {
  try { await set(ref(db, `mutes/${me}/${uid}`), serverTimestamp()); return true; } catch (e) { console.error(e); return false; }
}

export async function unmuteAccount({ db, me, uid }) {
  try { await remove(ref(db, `mutes/${me}/${uid}`)); return true; } catch (e) { console.error(e); return false; }
}