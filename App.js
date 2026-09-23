// FreeZone BD — Main Application
// Feed + Posts + Like + Comment + Share + Report + Block
// Friends + Notifications + Chat + Profile + Settings
// Firebase Realtime Database only. No Firebase Storage.

import { auth, db } from "./config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  ref, push, set, update, get, remove, onValue, query,
  orderByChild, limitToLast, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";
import { logout } from "./Login.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let user = null;
let feedListener = null;
let notificationListener = null;
let chatListener = null;
let selectedChatUser = null;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c])
);

const nowText = value => {
  const n = Number(value);
  return n ? new Intl.DateTimeFormat("bn-BD", {
    dateStyle:"medium", timeStyle:"short"
  }).format(new Date(n)) : "এখন";
};

function toast(text, type="info") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.className = `toast show ${type}`;
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function getUser(uid=user.uid) {
  const s = await get(ref(db, `users/${uid}`));
  return s.exists() ? s.val() : null;
}

function chatId(a,b) {
  return [a,b].sort().join("_");
}

function showSection(name) {
  $$(".section").forEach(el => {
    el.hidden = el.id !== `section-${name}`;
  });
  $$(".nav-btn").forEach(el => {
    el.classList.toggle("active", el.dataset.section === name);
  });

  if (name === "home") loadFeed();
  if (name === "profile") loadProfile();
  if (name === "friends") loadFriends();
  if (name === "notifications") loadNotifications();
  if (name === "chat") loadChats();
  if (name === "settings") loadSettings();
}

/* ==================== FEED ==================== */

function loadFeed() {
  const box = $("#feedList");
  if (!box || feedListener) return;

  box.innerHTML = `<div class="state">পোস্ট লোড হচ্ছে...</div>`;

  const q = query(
    ref(db, "posts"),
    orderByChild("createdAt"),
    limitToLast(30)
  );

  feedListener = onValue(q, snap => {
    const posts = [];
    snap.forEach(c => posts.push({ id:c.key, ...c.val() }));
    posts.reverse();

    box.innerHTML = posts.length
      ? posts.map(renderPost).join("")
      : `<div class="state">এখনও কোনো পোস্ট নেই।</div>`;
  }, error => {
    box.innerHTML = `<div class="state error">${esc(error.message)}</div>`;
  });
}

function renderPost(p) {
  return `
  <article class="post" data-post="${esc(p.id)}">
    <div class="post-head">
      <div class="avatar">${esc((p.authorName || "?").charAt(0))}</div>
      <div>
        <b>${esc(p.authorName || "User")}</b>
        <small>${nowText(p.createdAt)}</small>
      </div>
      ${p.userId === user.uid
        ? `<button class="delete-post" data-id="${esc(p.id)}">×</button>` : ""}
    </div>

    ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
    ${p.imageURL ? `<img class="post-image" src="${esc(p.imageURL)}" loading="lazy" alt="Post image">` : ""}

    <div class="stats">
      <span>${Number(p.likesCount || 0)} Likes</span>
      <span>${Number(p.commentsCount || 0)} Comments</span>
      <span>${Number(p.sharesCount || 0)} Shares</span>
    </div>

    <div class="actions">
      <button data-action="like" data-id="${esc(p.id)}">♡ Like</button>
      <button data-action="comment" data-id="${esc(p.id)}">💬 Comment</button>
      <button data-action="share" data-id="${esc(p.id)}">↗ Share</button>
      <button data-action="report" data-id="${esc(p.id)}">⚑ Report</button>
    </div>
  </article>`;
}

async function createPost() {
  const text = $("#postText").value.trim();
  const imageURL = $("#postImageURL").value.trim();

  if (!text && !imageURL) {
    toast("কিছু লিখুন অথবা Image URL দিন।", "error");
    return;
  }

  const profile = await getUser();
  const post = push(ref(db, "posts"));

  await set(post, {
    userId: user.uid,
    authorName: profile?.name || user.displayName || "User",
    authorEmail: user.email,
    text,
    imageURL,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    likesCount: 0,
    commentsCount: 0,
    sharesCount: 0
  });

  $("#postText").value = "";
  $("#postImageURL").value = "";
  toast("Post প্রকাশ হয়েছে।", "success");
}

async function deletePost(id) {
  const s = await get(ref(db, `posts/${id}`));
  if (!s.exists() || s.val().userId !== user.uid) return;
  await remove(ref(db, `posts/${id}`));
  toast("Post মুছে ফেলা হয়েছে।", "success");
}

async function likePost(id) {
  const likeRef = ref(db, `likes/${id}/${user.uid}`);
  const existing = await get(likeRef);

  if (existing.exists()) {
    await remove(likeRef);
    await runTransaction(
      ref(db, `posts/${id}/likesCount`),
      value => Math.max(0, Number(value || 0) - 1)
    );
  } else {
    await set(likeRef, {
      userId: user.uid,
      createdAt: serverTimestamp()
    });
    await runTransaction(
      ref(db, `posts/${id}/likesCount`),
      value => Number(value || 0) + 1
    );
  }
}

async function commentPost(id) {
  const text = prompt("Comment লিখুন:");
  if (!text?.trim()) return;

  const profile = await getUser();
  const comment = push(ref(db, `comments/${id}`));

  await set(comment, {
    userId: user.uid,
    authorName: profile?.name || "User",
    text: text.trim(),
    createdAt: serverTimestamp()
  });

  await runTransaction(
    ref(db, `posts/${id}/commentsCount`),
    value => Number(value || 0) + 1
  );

  toast("Comment যোগ হয়েছে।", "success");
}

async function sharePost(id) {
  const url = `${location.origin}${location.pathname}?post=${encodeURIComponent(id)}`;

  try {
    if (navigator.share) {
      await navigator.share({ title:"FreeZone BD", url });
    } else {
      await navigator.clipboard.writeText(url);
    }
  } catch {}

  await push(ref(db, `shares/${id}`), {
    userId:user.uid,
    createdAt:serverTimestamp()
  });

  await runTransaction(
    ref(db, `posts/${id}/sharesCount`),
    value => Number(value || 0) + 1
  );

  toast("Post share হয়েছে।", "success");
}

async function reportPost(id) {
  const reason = prompt(
    "কারণ লিখুন: spam / harassment / hate / violence / misinformation / copyright / other"
  );

  if (!reason?.trim()) return;

  const report = push(ref(db, `reports/${id}`));

  await set(report, {
    userId:user.uid,
    reason:reason.trim(),
    details:"",
    status:"open",
    createdAt:serverTimestamp()
  });

  toast("Report জমা হয়েছে।", "success");
}

/* ==================== PROFILE ==================== */

async function loadProfile() {
  const box = $("#profileView");
  const p = await getUser();

  box.innerHTML = `
    <div class="cover"></div>
    <div class="profile">
      <div class="big-avatar">
        ${p?.photoURL
          ? `<img src="${esc(p.photoURL)}" alt="">`
          : esc((p?.name || "?").charAt(0))}
      </div>
      <h2>${esc(p?.name || "")}</h2>
      <p>@${esc(p?.username || "")}</p>
      <p>${esc(p?.bio || "")}</p>
      <small>${esc(p?.email || "")}</small>
    </div>`;
}

/* ==================== FRIENDS ==================== */

async function sendFriendRequest(targetUid) {
  if (!targetUid || targetUid === user.uid) return;

  const profile = await getUser();

  await set(ref(db, `friendRequests/${targetUid}/${user.uid}`), {
    senderId:user.uid,
    receiverId:targetUid,
    senderName:profile?.name || "User",
    senderEmail:user.email,
    status:"pending",
    createdAt:serverTimestamp(),
    updatedAt:serverTimestamp()
  });

  const n = push(ref(db, `notifications/${targetUid}`));

  await set(n, {
    recipientId:targetUid,
    senderId:user.uid,
    type:"friend_request",
    text:`${profile?.name || "Someone"} sent you a friend request.`,
    read:false,
    createdAt:serverTimestamp()
  });

  toast("Friend request পাঠানো হয়েছে।", "success");
}

async function acceptFriend(senderId) {
  await set(ref(db, `friends/${user.uid}/${senderId}`), {
    friendId:senderId,
    createdAt:serverTimestamp()
  });

  await set(ref(db, `friends/${senderId}/${user.uid}`), {
    friendId:user.uid,
    createdAt:serverTimestamp()
  });

  await update(ref(db, `friendRequests/${user.uid}/${senderId}`), {
    status:"accepted",
    updatedAt:serverTimestamp()
  });

  const n = push(ref(db, `notifications/${senderId}`));

  await set(n, {
    recipientId:senderId,
    senderId:user.uid,
    type:"friend_accepted",
    text:"Your friend request was accepted.",
    read:false,
    createdAt:serverTimestamp()
  });

  loadFriends();
}

async function loadFriends() {
  const box = $("#friendsView");
  const requestSnap = await get(ref(db, `friendRequests/${user.uid}`));
  const friendSnap = await get(ref(db, `friends/${user.uid}`));

  let html = `<h2>Friend Requests</h2>`;

  if (requestSnap.exists()) {
    requestSnap.forEach(c => {
      const r = c.val();

      if (r.status === "pending") {
        html += `
        <div class="list-row">
          <div>
            <b>${esc(r.senderName)}</b>
            <small>${esc(r.senderEmail)}</small>
          </div>
          <button data-accept="${esc(r.senderId)}">Accept</button>
        </div>`;
      }
    });
  }

  html += `<h2>Friends</h2>`;

  if (friendSnap.exists()) {
    friendSnap.forEach(c => {
      const f = c.val();

      html += `
      <div class="list-row">
        <span>${esc(f.friendId)}</span>
        <button data-chat-user="${esc(f.friendId)}">Chat</button>
      </div>`;
    });
  }

  box.innerHTML = html;
}

/* ==================== NOTIFICATIONS ==================== */

function loadNotifications() {
  const box = $("#notificationList");

  if (notificationListener) notificationListener();

  const q = query(
    ref(db, `notifications/${user.uid}`),
    orderByChild("createdAt"),
    limitToLast(50)
  );

  notificationListener = onValue(q, snap => {
    const list = [];

    snap.forEach(c => list.push({
      id:c.key,
      ...c.val()
    }));

    list.reverse();

    const unread = list.filter(n => !n.read).length;
    $("#notifBadge").textContent = unread || "";

    box.innerHTML = list.length
      ? list.map(n => `
        <div class="notification ${n.read ? "" : "unread"}"
             data-notification="${esc(n.id)}">
          <b>${esc(n.type || "Notification")}</b>
          <p>${esc(n.text || "")}</p>
          <small>${nowText(n.createdAt)}</small>
        </div>`).join("")
      : `<div class="state">কোনো notification নেই।</div>`;
  });
}

/* ==================== CHAT ==================== */

async function loadChats() {
  const box = $("#chatList");
  const snap = await get(ref(db, "chats"));
  const chats = [];

  if (snap.exists()) {
    snap.forEach(c => {
      const data = c.val();

      if (data?.participants?.[user.uid]) {
        chats.push({ id:c.key, ...data });
      }
    });
  }

  chats.sort((a,b) =>
    Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0)
  );

  box.innerHTML = chats.length
    ? chats.map(c => {
        const other = Object.keys(c.participants || {})
          .find(id => id !== user.uid) || "";

        return `
        <button class="chat-item" data-chat-user="${esc(other)}">
          <b>${esc(other)}</b>
          <small>${esc(c.lastMessage || "No messages")}</small>
        </button>`;
      }).join("")
    : `<div class="state">কোনো chat নেই। Friend list থেকে Chat শুরু করুন।</div>`;
}

async function openChat(targetUid) {
  selectedChatUser = targetUid;

  $("#chatTarget").textContent = targetUid;

  if (chatListener) chatListener();

  const id = chatId(user.uid, targetUid);

  const q = query(
    ref(db, `messages/${id}`),
    orderByChild("createdAt"),
    limitToLast(100)
  );

  chatListener = onValue(q, async snap => {
    const list = [];

    snap.forEach(c => list.push({
      id:c.key,
      ...c.val()
    }));

    $("#messages").innerHTML = list.map(m => `
      <div class="bubble ${m.senderId === user.uid ? "mine" : ""}">
        <p>${esc(m.text)}</p>
        <small>${nowText(m.createdAt)} ${m.seen ? "✓✓" : ""}</small>
      </div>`).join("");

    $("#messages").scrollTop = $("#messages").scrollHeight;

    const updates = {};

    list.forEach(m => {
      if (m.receiverId === user.uid && !m.seen) {
        updates[`messages/${id}/${m.id}/seen`] = true;
        updates[`messages/${id}/${m.id}/seenAt`] = serverTimestamp();
      }
    });

    if (Object.keys(updates).length) await update(ref(db), updates);
  });

  showSection("chat");
}

async function sendChat() {
  const text = $("#chatText").value.trim();

  if (!text || !selectedChatUser) return;

  const id = chatId(user.uid, selectedChatUser);
  const chatRef = ref(db, `chats/${id}`);
  const existing = await get(chatRef);

  if (!existing.exists()) {
    await set(chatRef, {
      participants:{
        [user.uid]:true,
        [selectedChatUser]:true
      },
      lastMessage:"",
      lastMessageAt:serverTimestamp(),
      lastSenderId:"",
      createdAt:serverTimestamp()
    });
  }

  const m = push(ref(db, `messages/${id}`));

  await set(m, {
    senderId:user.uid,
    receiverId:selectedChatUser,
    text,
    createdAt:serverTimestamp(),
    seen:false,
    seenAt:null
  });

  await update(chatRef, {
    lastMessage:text,
    lastMessageAt:serverTimestamp(),
    lastSenderId:user.uid
  });

  $("#chatText").value = "";
}

/* ==================== SETTINGS ==================== */

async function loadSettings() {
  const p = await getUser();
  const s = await get(ref(db, `users/${user.uid}/settings`));
  const data = s.exists() ? s.val() : {};

  $("#profileName").value = p?.name || "";
  $("#profilePhoto").value = p?.photoURL || "";
  $("#profileBio").value = p?.bio || "";

  $("#profileVisible").checked = data.profileVisible !== false;
  $("#showOnline").checked = data.showOnlineStatus !== false;
  $("#allowRequests").checked = data.allowFriendRequests !== false;
  $("#notifyEnabled").checked = data.notifications !== false;
}

async function saveSettings() {
  await update(ref(db, `users/${user.uid}`), {
    name:$("#profileName").value.trim(),
    photoURL:$("#profilePhoto").value.trim(),
    bio:$("#profileBio").value.trim(),
    updatedAt:serverTimestamp()
  });

  await update(ref(db, `users/${user.uid}/settings`), {
    profileVisible:$("#profileVisible").checked,
    showOnlineStatus:$("#showOnline").checked,
    allowFriendRequests:$("#allowRequests").checked,
    notifications:$("#notifyEnabled").checked,
    updatedAt:serverTimestamp()
  });

  toast("Settings saved.", "success");
}

/* ==================== EVENTS ==================== */

document.addEventListener("click", async event => {
  const nav = event.target.closest("[data-section]");
  if (nav) {
    showSection(nav.dataset.section);
    return;
  }

  const action = event.target.closest("[data-action]");

  if (action) {
    try {
      if (action.dataset.action === "like") await likePost(action.dataset.id);
      if (action.dataset.action === "comment") await commentPost(action.dataset.id);
      if (action.dataset.action === "share") await sharePost(action.dataset.id);
      if (action.dataset.action === "report") await reportPost(action.dataset.id);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  const del = event.target.closest(".delete-post");

  if (del && confirm("এই post মুছে ফেলবেন?")) {
    await deletePost(del.dataset.id);
  }

  const accept = event.target.closest("[data-accept]");
  if (accept) await acceptFriend(accept.dataset.accept);

  const chat = event.target.closest("[data-chat-user]");
  if (chat) await openChat(chat.dataset.chatUser);

  const notification = event.target.closest("[data-notification]");

  if (notification) {
    await update(
      ref(db, `notifications/${user.uid}/${notification.dataset.notification}`),
      { read:true }
    );
    notification.classList.remove("unread");
  }
});

$("#createPostBtn")?.addEventListener("click", () =>
  createPost().catch(e => toast(e.message, "error"))
);

$("#saveSettingsBtn")?.addEventListener("click", () =>
  saveSettings().catch(e => toast(e.message, "error"))
);

$("#sendChatBtn")?.addEventListener("click", () =>
  sendChat().catch(e => toast(e.message, "error"))
);

$("#logoutBtn")?.addEventListener("click", () => logout());

onAuthStateChanged(auth, async current => {
  user = current;

  if (!user) {
    location.href = "Index.html";
    return;
  }

  await update(ref(db, `users/${user.uid}`), {
    online:true,
    updatedAt:serverTimestamp()
  });

  $("#currentUserName").textContent =
    user.displayName || "User";

  showSection("home");
  loadNotifications();
});

window.FreeZoneBD = {
  showSection,
  createPost,
  likePost,
  commentPost,
  sharePost,
  reportPost,
  sendFriendRequest,
  openChat,
  sendChat,
  logout
};
