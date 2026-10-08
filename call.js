// FreeZone BD - one-to-one audio / video calls (WebRTC; Firebase Realtime Database is only the "signalling" channel)
//
// Data (Firebase Realtime Database):
//   calls/{calleeUid}/{callId} = { callerUid, callerName, callerPhoto, video, status, createdAt, offer, answer?,
//                                  callerIce/{id}, calleeIce/{id} }
//   status: ringing -> accepted -> ended   (or declined / missed / busy)
// The sound and picture go directly between the two phones; nothing but the connection details is stored.
// feed.js calls startCallListener() once after login; chat.js calls startCall() from the call buttons.

import {
  ref,
  set,
  update,
  remove,
  push,
  child,
  get,
  onValue,
  onChildAdded,
  onDisconnect,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, showToast } from "./post.js";
import { isBlocked } from "./block.js";
import { sendChatMessage } from "./chat.js";
import { ICE_SERVERS, RING_TIMEOUT_MS } from "./call-config.js";

const STALE_MS = 2 * 60 * 1000; // an old, unanswered call is ignored
let active = null; // the call that is going on right now (only one at a time)
let listenerStarted = false;

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const supported = () => !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

async function getMedia(video, facingMode = "user") {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode, width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (error) {
    showToast(
      error && error.name === "NotAllowedError"
        ? `Please allow the ${video ? "camera and " : ""}microphone to make calls`
        : "Could not open the microphone or camera"
    );
    return null;
  }
}

/* ---------------- ringtone (no audio file needed) ---------------- */
function startRingtone() {
  let ctx = null;
  let timer = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      [0, 0.25].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.2);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.22);
      });
      navigator.vibrate?.([300, 200, 300]);
    };
    beep();
    timer = setInterval(beep, 2000);
  } catch (error) {
    /* sound is optional */
  }
  return () => {
    clearInterval(timer);
    navigator.vibrate?.(0);
    try { ctx && ctx.close(); } catch (error) { /* ignore */ }
  };
}

/* ---------------- screens ---------------- */
function callScreen({ name, photoURL, video }) {
  const el = document.createElement("div");
  el.className = "fixed inset-0 z-[9999] bg-[#0b0f14] text-white flex flex-col select-none";
  el.innerHTML = `
    <video class="cl-remote absolute inset-0 w-full h-full object-cover" autoplay playsinline ${video ? "" : "hidden"}></video>
    <div class="cl-avatar relative flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center" style="padding-top:env(safe-area-inset-top);">
      <div class="cl-avatar-pic [&_img]:w-28 [&_img]:h-28 [&_div]:w-28 [&_div]:h-28">${avatarHtml(photoURL, "w-28 h-28")}</div>
      <div class="cl-name text-[24px] font-semibold">${escapeHtml(name)}</div>
      <div class="cl-status text-white/70 text-[15px]">Calling...</div>
    </div>
    <div class="cl-top absolute left-0 right-0 top-0 px-4 text-center pointer-events-none" style="padding-top:max(0.75rem, env(safe-area-inset-top)); display:none;">
      <div class="text-[16px] font-semibold drop-shadow">${escapeHtml(name)}</div>
      <div class="cl-timer text-[13px] text-white/80 drop-shadow"></div>
    </div>
    <video class="cl-local absolute right-3 w-28 h-40 rounded-xl object-cover bg-black/40 shadow-lg ${video ? "" : "hidden"}" style="top:max(4rem, calc(env(safe-area-inset-top) + 3rem)); transform:scaleX(-1);" autoplay playsinline muted></video>
    <div class="cl-controls relative flex items-center justify-center gap-4 pt-4" style="padding-bottom:max(1.5rem, env(safe-area-inset-bottom));">
      <button type="button" class="cl-mute w-14 h-14 rounded-full bg-white/15 flex items-center justify-center active:scale-95" aria-label="Mute"><span class="material-symbols-outlined">mic</span></button>
      ${video ? `<button type="button" class="cl-cam w-14 h-14 rounded-full bg-white/15 flex items-center justify-center active:scale-95" aria-label="Camera"><span class="material-symbols-outlined">videocam</span></button>
      <button type="button" class="cl-flip w-14 h-14 rounded-full bg-white/15 flex items-center justify-center active:scale-95" aria-label="Switch camera"><span class="material-symbols-outlined">cameraswitch</span></button>` : ""}
      <button type="button" class="cl-end w-16 h-16 rounded-full bg-[#e5383b] flex items-center justify-center active:scale-95" aria-label="End call"><span class="material-symbols-outlined text-[30px]">call_end</span></button>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function incomingScreen({ name, photoURL, video }) {
  const el = document.createElement("div");
  el.className = "fixed inset-0 z-[9999] bg-[#0b0f14] text-white flex flex-col items-center justify-between select-none";
  el.style.padding = "max(3rem, env(safe-area-inset-top)) 1.5rem max(2.5rem, env(safe-area-inset-bottom))";
  el.innerHTML = `
    <div class="flex flex-col items-center gap-3 text-center mt-10">
      ${avatarHtml(photoURL, "w-28 h-28")}
      <div class="text-[26px] font-semibold">${escapeHtml(name)}</div>
      <div class="text-white/70 text-[15px]">Incoming ${video ? "video" : "audio"} call...</div>
    </div>
    <div class="flex items-center justify-center gap-16">
      <button type="button" class="in-decline w-16 h-16 rounded-full bg-[#e5383b] flex items-center justify-center active:scale-95" aria-label="Decline"><span class="material-symbols-outlined text-[30px]">call_end</span></button>
      <button type="button" class="in-accept w-16 h-16 rounded-full bg-[#2fb344] flex items-center justify-center active:scale-95" aria-label="Accept"><span class="material-symbols-outlined text-[30px]">${video ? "videocam" : "call"}</span></button>
    </div>`;
  document.body.appendChild(el);
  return el;
}

/* ---------------- the call itself (same for caller and receiver) ---------------- */
function runCall({ db, me, callRef, role, video, stream, peerName, peerPhoto, onFinish }) {
  const screen = callScreen({ name: peerName, photoURL: peerPhoto, video });
  const $ = (s) => screen.querySelector(s);
  const remoteEl = $(".cl-remote");
  const localEl = $(".cl-local");
  const statusEl = $(".cl-status");
  const timerEl = $(".cl-timer");

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const remoteStream = new MediaStream();
  let localStream = stream;
  let finished = false;
  let connectedAt = 0;
  let tick = null;
  let failTimer = null;
  const unsubs = [];
  let existed = false;

  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  if (localEl) localEl.srcObject = localStream;
  remoteEl.srcObject = remoteStream;
  pc.ontrack = (event) => event.streams[0]?.getTracks().forEach((t) => remoteStream.addTrack(t));

  const myIce = role === "caller" ? "callerIce" : "calleeIce";
  const theirIce = role === "caller" ? "calleeIce" : "callerIce";

  // My connection details are sent only after the call node exists (the caller creates it a moment later),
  // and the other side's details wait until the remote description is set.
  let iceReady = role !== "caller";
  const outQueue = [];
  const sendIce = (json) => set(push(child(callRef, myIce)), json).catch(() => {});
  const inQueue = [];
  pc.onicecandidate = (event) => {
    if (!event.candidate || finished) return;
    const json = JSON.stringify(event.candidate);
    if (iceReady) sendIce(json);
    else outQueue.push(json);
  };
  const addIce = (candidate) => pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  unsubs.push(
    onChildAdded(child(callRef, theirIce), (snap) => {
      try {
        const candidate = JSON.parse(snap.val());
        if (pc.remoteDescription) addIce(candidate);
        else inQueue.push(candidate);
      } catch (error) { /* ignore a bad candidate */ }
    })
  );
  const releaseIce = () => {
    iceReady = true;
    outQueue.splice(0).forEach(sendIce);
  };
  const remoteReady = () => inQueue.splice(0).forEach(addIce);

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      clearTimeout(failTimer);
      if (!connectedAt) {
        connectedAt = Date.now();
        $(".cl-top").style.display = "block";
        if (video) $(".cl-avatar").style.display = "none";
        else statusEl.textContent = "Connected";
        tick = setInterval(() => (timerEl.textContent = fmtTime(Math.floor((Date.now() - connectedAt) / 1000))), 1000);
      }
    } else if (state === "disconnected") {
      statusEl.textContent = "Reconnecting...";
      failTimer = setTimeout(() => finish("Connection lost"), 10000);
    } else if (state === "failed") {
      finish("Connection failed. A TURN server may be needed on this network.");
    }
  };

  // The other side ended / declined / the node vanished
  unsubs.push(
    onValue(callRef, (snap) => {
      if (!snap.exists()) {
        if (existed) finish(null, true); // (the caller's node is created a moment after the screen opens)
        return;
      }
      existed = true;
      const status = snap.val().status;
      if (status === "ended") finish(null, true);
    })
  );

  onDisconnect(callRef).update({ status: "ended" }).catch(() => {});

  const finish = async (message, remoteEnded = false) => {
    if (finished) return;
    finished = true;
    clearInterval(tick);
    clearTimeout(failTimer);
    unsubs.forEach((u) => { try { u(); } catch (e) { /* ignore */ } });
    const seconds = connectedAt ? Math.floor((Date.now() - connectedAt) / 1000) : 0;
    try { pc.close(); } catch (e) { /* ignore */ }
    localStream.getTracks().forEach((t) => t.stop());
    screen.remove();
    if (message) showToast(message);
    try { await onDisconnect(callRef).cancel(); } catch (e) { /* ignore */ }
    if (!remoteEnded) {
      await update(callRef, { status: "ended" }).catch(() => {});
    }
    onFinish?.(seconds);
  };

  /* controls */
  let muted = false;
  $(".cl-mute").addEventListener("click", (e) => {
    muted = !muted;
    localStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    e.currentTarget.classList.toggle("bg-white", muted);
    e.currentTarget.classList.toggle("text-black", muted);
    e.currentTarget.querySelector("span").textContent = muted ? "mic_off" : "mic";
  });
  if (video) {
    let camOff = false;
    $(".cl-cam").addEventListener("click", (e) => {
      camOff = !camOff;
      localStream.getVideoTracks().forEach((t) => (t.enabled = !camOff));
      e.currentTarget.classList.toggle("bg-white", camOff);
      e.currentTarget.classList.toggle("text-black", camOff);
      e.currentTarget.querySelector("span").textContent = camOff ? "videocam_off" : "videocam";
    });
    let facing = "user";
    $(".cl-flip").addEventListener("click", async () => {
      facing = facing === "user" ? "environment" : "user";
      try {
        localStream.getVideoTracks().forEach((t) => t.stop()); // some phones cannot open two cameras at once
        const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
        const track = fresh.getVideoTracks()[0];
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) await sender.replaceTrack(track);
        localStream.getVideoTracks().forEach((t) => { t.stop(); localStream.removeTrack(t); });
        localStream.addTrack(track);
        localEl.srcObject = localStream;
        localEl.style.transform = facing === "user" ? "scaleX(-1)" : "none";
      } catch (error) {
        showToast("Could not switch the camera");
      }
    });
  }
  $(".cl-end").addEventListener("click", () => finish());

  return { pc, finish, releaseIce, remoteReady, setStatus: (t) => (statusEl.textContent = t) };
}

/* ---------------- caller ---------------- */
export async function startCall({ db, me, other, video = false }) {
  if (!supported()) return showToast("Calls are not supported in this browser");
  if (active) return showToast("You are already in a call");
  if (!navigator.onLine) return showToast("You are offline");
  if (isBlocked(other.uid)) return showToast("You blocked this account");

  active = { pending: true };
  const stream = await getMedia(video);
  if (!stream) {
    active = null;
    return;
  }

  const callId = push(ref(db, `calls/${other.uid}`)).key;
  const callRef = ref(db, `calls/${other.uid}/${callId}`);
  let answered = false;
  let missedTimer = null;
  let session = null;

  const cleanup = (seconds) => {
    clearTimeout(missedTimer);
    active = null;
    // The caller writes one line into the chat: a missed call or how long the call lasted
    const label = video ? "video call" : "call";
    const text = answered
      ? `${video ? "🎥" : "📞"} ${video ? "Video" : "Voice"} call · ${fmtTime(seconds || 0)}`
      : `${video ? "🎥" : "📞"} Missed ${label}`;
    sendChatMessage(db, me, other.uid, text).catch(() => {});
    setTimeout(() => remove(callRef).catch(() => {}), 3000);
  };

  try {
    let meSnap = {};
    try {
      const mine = await get(ref(db, `users/${me}`));
      if (mine.exists()) meSnap = mine.val();
    } catch (error) { /* the name is optional */ }
    session = runCall({
      db, me, callRef, role: "caller", video, stream, peerName: other.name, peerPhoto: other.photoURL,
      onFinish: cleanup
    });
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);

    await set(callRef, {
      callerUid: me,
      callerName: meSnap.name || "FreeZone User",
      callerPhoto: meSnap.photoURL || "",
      video: !!video,
      status: "ringing",
      createdAt: serverTimestamp(),
      offer: { type: offer.type, sdp: offer.sdp }
    });
    active = { callId, role: "caller" };
    session.releaseIce();

    // wait for the answer
    let gotAnswer = false;
    const stopAnswer = onValue(callRef, async (snap) => {
      if (!snap.exists()) return;
      const data = snap.val();
      if (data.status === "declined") {
        stopAnswer();
        session.finish("Call declined");
      } else if (data.status === "busy") {
        stopAnswer();
        session.finish(`${other.name} is on another call`);
      } else if (data.answer && !gotAnswer) {
        gotAnswer = true;
        answered = true;
        clearTimeout(missedTimer);
        session.setStatus("Connecting...");
        try {
          await session.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          session.remoteReady();
        } catch (error) {
          session.finish("Could not connect the call");
        }
      }
    });
    missedTimer = setTimeout(() => {
      if (!answered) session.finish(`${other.name} did not answer`);
    }, RING_TIMEOUT_MS);
  } catch (error) {
    console.error("Call:", error);
    stream.getTracks().forEach((t) => t.stop());
    document.querySelectorAll(".cl-end").forEach((b) => b.click());
    active = null;
    showToast(error && error.code === "PERMISSION_DENIED" ? "Could not call: database rules block it" : "Could not start the call");
  }
}

/* ---------------- receiver ---------------- */
async function handleIncoming(db, me, callId, data) {
  const callRef = ref(db, `calls/${me}/${callId}`);

  if (!data || data.status !== "ringing" || !data.offer) return;
  if (isBlocked(data.callerUid)) return remove(callRef).catch(() => {});
  if (active) return update(callRef, { status: "busy" }).catch(() => {});
  if (!supported()) return update(callRef, { status: "declined" }).catch(() => {});

  active = { callId, role: "callee", pending: true };
  const stopRing = startRingtone();
  const screen = incomingScreen({ name: data.callerName || "FreeZone User", photoURL: data.callerPhoto, video: !!data.video });

  let handled = false;
  const stopWatch = onValue(callRef, (snap) => {
    // the caller hung up (or gave up) before I answered
    if (handled) return;
    if (!snap.exists() || snap.val().status !== "ringing") {
      handled = true;
      stopWatch();
      stopRing();
      screen.remove();
      active = null;
    }
  });

  screen.querySelector(".in-decline").addEventListener("click", () => {
    if (handled) return;
    handled = true;
    stopWatch();
    stopRing();
    screen.remove();
    active = null;
    update(callRef, { status: "declined" }).catch(() => {});
  });

  screen.querySelector(".in-accept").addEventListener("click", async () => {
    if (handled) return;
    handled = true;
    stopWatch();
    stopRing();
    screen.remove();

    const stream = await getMedia(!!data.video);
    if (!stream) {
      active = null;
      return update(callRef, { status: "declined" }).catch(() => {});
    }
    try {
      const session = runCall({
        db, me, callRef, role: "callee", video: !!data.video, stream,
        peerName: data.callerName || "FreeZone User", peerPhoto: data.callerPhoto,
        onFinish: () => {
          active = null;
          setTimeout(() => remove(callRef).catch(() => {}), 3000);
        }
      });
      session.setStatus("Connecting...");
      await session.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      session.remoteReady();
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      await update(callRef, { answer: { type: answer.type, sdp: answer.sdp }, status: "accepted" });
      active = { callId, role: "callee" };
    } catch (error) {
      console.error("Answer call:", error);
      showToast("Could not connect the call");
      document.querySelectorAll(".cl-end").forEach((b) => b.click());
      active = null;
    }
  });
}

// Listens for calls made to me (only while the app is open)
export function startCallListener({ db, currentUser } = {}) {
  if (listenerStarted || !db || !currentUser) return;
  listenerStarted = true;
  const me = currentUser.uid;

  onChildAdded(ref(db, `calls/${me}`), (snap) => {
    const data = snap.val();
    const age = Math.abs(Date.now() - (Number(data && data.createdAt) || 0));
    if (!data || age > STALE_MS) {
      // an old leftover: clean it up
      remove(snap.ref).catch(() => {});
      return;
    }
    handleIncoming(db, me, snap.key, data);
  });
}