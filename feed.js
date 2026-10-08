// FreeZone BD - Feed (Phase 2) - FIXED
import { auth, db } from "./config.js";
import { initTheme } from "./theme.js";
initTheme();

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

import {
  ref,
  push,
  set,
  get,
  remove,
  update,
  onValue,
  increment,
  serverTimestamp,
  query,
  orderByChild,
  equalTo,
  limitToFirst
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, timeAgo, avatarHtml, createPostCard, showToast, updateFollowButtons, sharePost, postImagesHtml, postImageUrls } from "./post.js";
import { startBlocks, isBlocked, onBlocksChange, blockAccount } from "./block.js";
import { startMutes, isMuted, onMutesChange } from "./mute.js";
import { openCommentsSheet, mountComments } from "./comments.js";

const $ = (selector) => document.querySelector(selector);

const postsContainer = $("#postsContainer");
const emptyState = $("#emptyState");
const navAvatar = $("#navAvatar");

const postDetail = $("#postDetail");
const postDetailBody = $("#postDetailBody");
const postDetailBack = $("#postDetailBack");
const postDetailCommentForm = $("#postDetailCommentForm");
const postDetailCommentInput = $("#postDetailCommentInput");

const pageView = $("#pageView");
const pageViewBody = $("#pageViewBody");
const pageViewTitle = $("#pageViewTitle");
const pageViewBack = $("#pageViewBack");
const pageViewActions = $("#pageViewActions");

const pageModules = {
  notifications: () => import("./notification.js"),
  friends: () => import("./friends.js"),
  create: () => import("./create.js"),
  chat: () => import("./chat.js"),
  profile: () => import("./profile.js"),
  settings: () => import("./settings.js")
};

let unsubscribePostDetail = null;
let detailComments = null; // the comments list of the open post page (comments.js)
let currentDetailPostId = null;

let currentUser = null;
let currentProfile = null;
let savedPostIds = {};
let followingIds = {};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Send the person to the login page and bring them back to this exact page (and post) afterwards
    const here = window.location.pathname.split("/").pop() || "feed.html";
    window.location.href = "./login.html?next=" + encodeURIComponent(here + window.location.search);
    return;
  }

  currentUser = user;

  const profileSnap = await get(ref(db, `users/${user.uid}`));
  currentProfile = profileSnap.exists()
    ? profileSnap.val()
    : { name: user.displayName || "FreeZone User", username: "", photoURL: "" };

  // A suspended account can read but not post, comment or message (enforced by the database rules)
  if (currentProfile.suspended === true) {
    const bar = document.createElement("div");
    bar.className = "bg-error-container text-on-error-container text-center text-[13px] font-semibold px-4 py-2";
    bar.textContent = `Your account is suspended${currentProfile.suspendReason ? ": " + currentProfile.suspendReason : ""}. You can read, but you cannot post, comment or send messages.`;
    document.body.insertBefore(bar, document.body.firstChild);
  }

  navAvatar.innerHTML = currentProfile.photoURL
    ? `<img class="w-full h-full object-cover" src="${escapeHtml(currentProfile.photoURL)}" alt="avatar" />`
    : `<span class="material-symbols-outlined text-[16px] text-slate-subtle">person</span>`;

  // One-time cleanup of data saved in older versions of the app (safe to run every time)
  try {
    const moves = {};
    const oldSaved = await get(ref(db, `users/${user.uid}/savedPosts`));
    if (oldSaved.exists()) {
      Object.entries(oldSaved.val()).forEach(([postId, value]) => {
        moves[`savedPosts/${user.uid}/${postId}`] = typeof value === "number" ? value : Date.now();
      });
      moves[`users/${user.uid}/savedPosts`] = null; // saved posts must stay private
    }
    if (profileSnap.exists() && profileSnap.val().email !== undefined) {
      moves[`users/${user.uid}/email`] = null; // emails must not be readable by other users
    }
    if (Object.keys(moves).length) await update(ref(db), moves);
  } catch (error) {
    console.warn("Cleanup of old data skipped:", error?.code || error);
  }

  try {
    const savedSnap = await get(ref(db, `savedPosts/${user.uid}`));
    savedPostIds = savedSnap.exists() ? savedSnap.val() : {};
  } catch (error) {
    console.error("Could not load saved posts:", error);
    savedPostIds = {};
  }

  try {
    const followingSnap = await get(ref(db, `following/${user.uid}`));
    followingIds = followingSnap.exists() ? followingSnap.val() : {};
  } catch (error) {
    console.error("Could not load following list:", error);
    followingIds = {};
  }

  startBlocks({ db, currentUser }); // who I blocked (block.js), before any post is drawn
  startMutes({ db, currentUser }); // who I muted (mute.js)
  listenPosts();
  watchUnreadMessages(user.uid);

  // Online status (the green "Active now" dots) is kept up to date by chat.js
  import("./chat.js")
    .then((module) => module.startPresence({ db, currentUser }))
    .catch((error) => console.warn("Online status is not available:", error));

  // Incoming audio / video calls (call.js; rings only while the app is open)
  import("./call.js")
    .then((module) => module.startCallListener({ db, currentUser }))
    .catch((error) => console.warn("Calls are not available:", error));

  // Announcement banner and maintenance mode (status.js, controlled from the admin panel)
  import("./status.js")
    .then((module) => module.startAppStatus({ db, auth, currentUser }))
    .catch((error) => console.warn("App status is not available:", error));

  // Notifications (the bell badge and writing notifications) live in notification.js
  import("./notification.js")
    .then((module) => module.start({ db, currentUser, currentProfile }))
    .catch((error) => console.warn("Notifications are not available:", error));

  // Stories: the bar, the viewer and adding a story all live in story.js, so that file can be
  // changed without touching this one. If story.js is missing or fails, the feed is unaffected.
  import("./story.js")
    .then((module) =>
      module.mount($("#storiesBar"), {
        db,
        auth,
        currentUser,
        currentProfile,
        followingIds,
        openProfile: (uid) => openUserProfile(uid)
      })
    )
    .catch((error) => console.warn("Stories are not available:", error));

  // Open a post directly when the page is opened from a shared link (?post=ID)
  // Open a post or a profile directly when the page is opened from a shared link
  const linkParams = new URLSearchParams(window.location.search);
  const sharedPostId = linkParams.get("post");
  const sharedProfileUid = linkParams.get("profile");
  const sharedUsername = linkParams.get("u");
  if (sharedPostId) openPostDetail(sharedPostId);
  else if (sharedProfileUid) openUserProfile(sharedProfileUid);
  else if (sharedUsername) openProfileByUsername(sharedUsername);
});

function postActions() {
  return {
    onOpen: openPostDetail,
    onComments: openComments,
    onLike: toggleLike,
    onShare: sharePost,
    onReport: reportPost,
    onBlock: blockPost,
    onDelete: deletePost,
    onEdit: editPost,
    onSave: toggleSavePost,
    onFollow: toggleFollow,
    isBlocked
  };
}

// Icon buttons at the right end of the page header (e.g. the settings gear of the Chat page).
// actions: [{ icon: "settings", label: "Chat settings", onClick }]  - an empty list removes them.
function setPageActions(actions = []) {
  if (!pageViewActions) return;
  pageViewActions.innerHTML = "";
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "w-10 h-10 rounded-full flex items-center justify-center text-on-surface-variant hover:bg-surface-container active:scale-95 transition-all";
    button.setAttribute("aria-label", action.label || "");
    button.innerHTML = `<span class="material-symbols-outlined text-[24px]">${action.icon}</span>`;
    button.addEventListener("click", action.onClick);
    pageViewActions.appendChild(button);
  });
}

async function openPageView(pageKey, title) {
  pageBackTarget = null;
  setPageActions();
  pageViewTitle.textContent = title;
  pageViewBody.innerHTML = "";
  pageView.hidden = false;
  document.body.style.overflow = "hidden";

  try {
    const module = await pageModules[pageKey]();
    module.mount(pageViewBody, {
      currentUser,
      currentProfile,
      auth,
      db,
      savedPostIds,
      followingIds,
      postActions: postActions(),
      onToggleFollow: toggleFollow,
      onOpenProfile: (uid) =>
        openUserProfile(uid, { backTo: pageKey === "chat" ? () => openChatWith(uid) : () => openPageView(pageKey, title) }),
      onOpenChat: (uid) => openChatWith(uid, { backTo: () => openPageView(pageKey, title) }),
      setTitle: (text) => (pageViewTitle.textContent = text),
      setBack: (handler) => (pageBackTarget = handler),
      setActions: setPageActions,
      closePage: closePageView,
      openPost: (postId) => openPostDetail(postId),
      onOpenSettings: () => openSettings(),
      onOpenEditProfile: () => openSettings("edit-profile")
    });
  } catch (error) {
    console.error(error);
    pageViewBody.innerHTML = `<p class="text-center text-slate-muted text-sm py-10">Could not load this section.</p>`;
  }
}

// Settings (the menu icon at the top right of my own Profile). Back returns to my Profile.
async function openSettings(startPage = null) {
  if (!currentUser) return;

  const backToProfile = () => openPageView("profile", "Profile");
  pageBackTarget = backToProfile;
  setPageActions();
  pageViewTitle.textContent = "Settings";
  pageViewBody.innerHTML = "";
  pageView.hidden = false;
  document.body.style.overflow = "hidden";

  try {
    const module = await pageModules.settings();
    await module.mount(pageViewBody, {
      db,
      auth,
      currentUser,
      currentProfile,
      startPage,
      setTitle: (text) => (pageViewTitle.textContent = text),
      setBack: (handler) => (pageBackTarget = handler),
      setActions: setPageActions,
      onBack: backToProfile
    });
  } catch (error) {
    console.error(error);
    pageViewBody.innerHTML = `<p class="text-center text-slate-muted text-sm py-10">Could not load settings.</p>`;
  }
}

// A profile link looks like  feed.html?u=username  : find the account with that @username and open it
async function openProfileByUsername(username) {
  const wanted = String(username).trim().replace(/^@/, "").toLowerCase();
  if (!wanted) return;

  try {
    const snap = await get(query(ref(db, "users"), orderByChild("username"), equalTo(wanted), limitToFirst(1)));
    let uid = "";
    snap.forEach((child) => {
      uid = child.key;
    });
    if (uid) openUserProfile(uid);
    else showToast("Profile not found");
  } catch (error) {
    console.error(error);
    showToast("Could not open this profile");
  }
}

async function openUserProfile(uid, { backTo = null } = {}) {
  if (!uid || !currentUser) return;

  // Own profile: use the normal Profile page
  if (uid === currentUser.uid) {
    openPageView("profile", "Profile");
    return;
  }

  pageBackTarget = backTo;
  setPageActions();
  pageViewTitle.textContent = "Profile";
  pageViewBody.innerHTML = "";
  pageView.hidden = false;
  document.body.style.overflow = "hidden";

  try {
    const module = await pageModules.profile();
    await module.mount(pageViewBody, {
      db,
      auth,
      uid,
      currentUser,
      currentProfile,
      savedPostIds,
      followingIds,
      postActions: postActions(),
      isFollowing: !!followingIds[uid],
      setActions: setPageActions,
      onToggleFollow: toggleFollow,
      // people in this profile's Followers / Following list; Back returns to this profile
      onOpenProfile: (otherUid) => openUserProfile(otherUid, { backTo: () => openUserProfile(uid, { backTo }) }),
      onOpenChat: (chatUid) => openChatWith(chatUid, { backTo: () => openUserProfile(uid, { backTo }) })
    });
  } catch (error) {
    console.error(error);
    pageViewBody.innerHTML = `<p class="text-center text-slate-muted text-sm py-10">Could not load this profile.</p>`;
  }
}

// Opens the conversation with one person (used by the Message buttons)
async function openChatWith(uid, { backTo = null } = {}) {
  if (!uid || !currentUser || uid === currentUser.uid) return;

  pageBackTarget = backTo;
  setPageActions();
  pageViewTitle.textContent = "Chat";
  pageViewBody.innerHTML = "";
  pageView.hidden = false;
  document.body.style.overflow = "hidden";

  try {
    const module = await pageModules.chat();
    await module.mount(pageViewBody, {
      db,
      currentUser,
      openWithUid: uid,
      followingIds,
      onOpenProfile: (profileUid) => openUserProfile(profileUid, { backTo: () => openChatWith(uid) }),
      setTitle: (text) => (pageViewTitle.textContent = text),
      setBack: (handler) => (pageBackTarget = handler),
      setActions: setPageActions
    });
  } catch (error) {
    console.error(error);
    pageViewBody.innerHTML = `<p class="text-center text-slate-muted text-sm py-10">Could not open the chat.</p>`;
  }
}

// Red badge on the Chat tab with the number of unread messages
function watchUnreadMessages(uid) {
  const chatTab = document.querySelector('.nav-link[data-page="chat"]');
  if (!chatTab) return;

  chatTab.classList.add("relative");
  let badge = chatTab.querySelector(".fz-chat-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "fz-chat-badge absolute -top-0.5 left-1/2 ml-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-bold items-center justify-center";
    badge.style.display = "none";
    chatTab.appendChild(badge);
  }

  onValue(
    ref(db, `userChats/${uid}`),
    (snap) => {
      let total = 0;
      snap.forEach((child) => {
        total += Number(child.val()?.unread) || 0;
      });
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.style.display = total > 0 ? "flex" : "none";
    },
    () => {} // no permission or no network: simply no badge
  );
}

// Post detail: tapping the author or a commenter's photo/name opens their profile
if (postDetailBody) {
  postDetailBody.addEventListener("click", (event) => {
    const target = event.target.closest("[data-profile-uid]");
    if (target) openUserProfile(target.dataset.profileUid);
  });
}

function closePageView() {
  pageBackTarget = null;
  setPageActions();
  pageView.hidden = true;
  document.body.style.overflow = "";
  pageViewBody.innerHTML = "";
}

// When a profile was opened from the Friends list, Back returns to that list
let pageBackTarget = null;

if (pageViewBack) {
  pageViewBack.addEventListener("click", () => {
    if (pageBackTarget) {
      const goBack = pageBackTarget;
      pageBackTarget = null;
      goBack();
    } else {
      closePageView();
    }
  });
}

document.querySelectorAll(".nav-link[data-page]").forEach((button) => {
  button.addEventListener("click", () => {
    openPageView(button.dataset.page, button.dataset.title);
  });
});

// Ads are optional: if ads.js is missing or fails, the feed simply stays as it is
let adsModule = null;
function showAds(container, placement) {
  if (!adsModule) adsModule = import("./ads.js").catch(() => null);
  adsModule.then((module) => module && module.insertAds(container, { placement })).catch(() => {});
}

function listenPosts() {
  const postsRef = ref(db, "posts");
  let latestPosts = null;

  // Posts of people I blocked are not shown
  const renderPosts = () => {
    if (!latestPosts) return;
    postsContainer.innerHTML = "";

    const visible = latestPosts.filter((post) => !isBlocked(post.uid) && !isMuted(post.uid));
    if (emptyState) emptyState.hidden = visible.length > 0;

    visible.forEach((post) => {
      postsContainer.appendChild(
        createPostCard(post, {
          currentUserUid: currentUser?.uid,
          savedPostIds,
          followingIds,
          onSave: toggleSavePost,
          onFollow: toggleFollow,
          onProfile: openUserProfile,
          onOpen: openPostDetail,
          onComments: openComments,
          onLike: toggleLike,
          onShare: sharePost,
          onReport: reportPost,
          onBlock: blockPost,
          onDelete: deletePost,
          onEdit: editPost,
          isBlocked
        })
      );
    });

    showAds(postsContainer, "feed");
  };
  onBlocksChange(renderPosts);
  onMutesChange(renderPosts);

  onValue(
    postsRef,
    (snapshot) => {
      if (emptyState) emptyState.textContent = "No posts yet. Be the first to share something!";

      latestPosts = [];
      snapshot.forEach((child) => {
        latestPosts.push({ id: child.key, ...child.val() });
      });
      latestPosts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      renderPosts();
    },
    (error) => {
      console.error("Could not read posts:", error.code, error.message);
      postsContainer.innerHTML = "";
      if (emptyState) {
        emptyState.textContent =
          error.code === "PERMISSION_DENIED"
            ? 'Could not load posts: Database rules are blocking read access to "posts". Update your Realtime Database rules and reload.'
            : `Could not load posts: ${error.message}`;
        emptyState.hidden = false;
      }
    }
  );
}

// "Block @username" in the menu of a post
function blockPost(post) {
  if (!currentUser || !post || !post.uid) return;
  blockAccount({
    db,
    me: currentUser.uid,
    user: { uid: post.uid, name: post.name, username: post.username },
    followingIds
  });
}

async function toggleFollow(post, wasFollowing) {
  if (!currentUser || !post.uid || post.uid === currentUser.uid) return false;

  const me = currentUser.uid;
  const target = post.uid;
  const handle = post.username ? `@${post.username}` : post.name || "this user";

  try {
    // Both sides are written together so the two lists never disagree
    await update(ref(db), {
      [`following/${me}/${target}`]: wasFollowing ? null : serverTimestamp(),
      [`followers/${target}/${me}`]: wasFollowing ? null : serverTimestamp()
    });

    if (wasFollowing) delete followingIds[target];
    else followingIds[target] = Date.now();

    updateFollowButtons(target, !wasFollowing);
    emitNotify({ type: "follow", toUid: target, undo: wasFollowing });
    showToast(wasFollowing ? `Unfollowed ${handle}` : `Following ${handle}`);
    return true;
  } catch (error) {
    console.error(error);
    showToast(
      error.code === "PERMISSION_DENIED"
        ? "Could not follow: database rules block it"
        : "Something went wrong. Try again."
    );
    return false;
  }
}

async function toggleSavePost(post, wasSaved) {
  if (!currentUser) return false;

  const saveRef = ref(db, `savedPosts/${currentUser.uid}/${post.id}`);
  try {
    if (wasSaved) {
      await remove(saveRef);
      delete savedPostIds[post.id];
      showToast("Removed from saved");
    } else {
      await set(saveRef, serverTimestamp());
      savedPostIds[post.id] = Date.now();
      showToast("Post saved");
    }
    return true;
  } catch (error) {
    console.error(error);
    showToast(
      error.code === "PERMISSION_DENIED"
        ? "Could not save: database rules block it"
        : "Could not save post. Try again."
    );
    return false;
  }
}

async function reportPost(post, { reason, details }) {
  if (!currentUser) return;

  // One report per user per post
  const reportRef = ref(db, `reports/${post.id}/${currentUser.uid}`);
  try {
    const existing = await get(reportRef);
    if (existing.exists()) {
      showToast("You already reported this post");
      return;
    }

    await set(reportRef, {
      postId: post.id,
      postOwnerUid: post.uid || "",
      reporterUid: currentUser.uid,
      reason,
      details: details || "",
      postText: (post.text || "").slice(0, 200),
      status: "pending",
      createdAt: serverTimestamp()
    });
    showToast("Report submitted. Thank you.");
  } catch (error) {
    console.error(error);
    showToast(
      error.code === "PERMISSION_DENIED"
        ? "Could not report: database rules block it"
        : "Could not submit report. Try again."
    );
  }
}

async function editPost(postId, newText) {
  await update(ref(db, `posts/${postId}`), {
    text: newText,
    editedAt: serverTimestamp()
  });
}

async function deletePost(postId) {
  if (!confirm("Delete this post? This cannot be undone.")) return;
  try {
    await remove(ref(db, `posts/${postId}`));
    if (currentDetailPostId === postId) closePostDetail();
  } catch (error) {
    console.error(error);
    alert("Could not delete the post. Please try again.");
  }
}

// feed.js only announces what happened; notification.js decides who gets a notification and writes it
function emitNotify(detail) {
  document.dispatchEvent(new CustomEvent("fz:notify", { detail }));
}

async function toggleLike(postId) {
  if (!currentUser) return;

  const likeRef = ref(db, `posts/${postId}/likes/${currentUser.uid}`);
  const snap = await get(likeRef);

  if (snap.exists()) {
    await remove(likeRef);
    await update(ref(db, `posts/${postId}`), { likesCount: increment(-1) });
    emitNotify({ type: "like", postId, undo: true });
  } else {
    await set(likeRef, true);
    await update(ref(db, `posts/${postId}`), { likesCount: increment(1) });
    emitNotify({ type: "like", postId });
  }
}

function openPostDetail(postId) {
  currentDetailPostId = postId;
  postDetail.hidden = false;
  document.body.style.overflow = "hidden";

  const postRef = ref(db, `posts/${postId}`);
  unsubscribePostDetail = onValue(postRef, (snapshot) => {
    if (!snapshot.exists()) {
      closePostDetail();
      return;
    }
    renderPostDetail(postId, snapshot.val());
  });
}

function closePostDetail() {
  postDetail.hidden = true;
  document.body.style.overflow = pageView && !pageView.hidden ? "hidden" : "";
  if (unsubscribePostDetail) unsubscribePostDetail();
  if (detailComments) detailComments.destroy();
  unsubscribePostDetail = null;
  detailComments = null;
  currentDetailPostId = null;
}

if (postDetailBack) postDetailBack.addEventListener("click", closePostDetail);

function renderPostDetail(postId, post) {
  // The same card as in the feed (new design); the full comment list is mounted below it
  const keepScroll = postDetailBody.scrollTop;
  postDetailBody.innerHTML = `<div id="postDetailCard" class="-mx-3 sm:-mx-4 -mt-4"></div><div id="postDetailComments" class="space-y-4 px-1 pb-4"></div>`;
  $("#postDetailCard").appendChild(
    createPostCard(
      { ...post, id: postId },
      {
        ...postActions(),
        currentUserUid: currentUser?.uid,
        savedPostIds,
        followingIds,
        onSave: toggleSavePost,
        onFollow: toggleFollow,
        onProfile: openUserProfile,
        onOpen: undefined,
        onComments: () => postDetailCommentInput?.focus()
      }
    )
  );
  postDetailBody.scrollTop = keepScroll;

  // Comments (like, reply, delete) are handled by comments.js; keep the same list when only the post changed
  if (detailComments && detailComments.postId === postId) {
    detailComments.rebind($("#postDetailComments"));
  } else {
    if (detailComments) detailComments.destroy();
    detailComments = mountComments({
      db,
      postId,
      getMe,
      listEl: $("#postDetailComments"),
      formEl: postDetailCommentForm,
      inputEl: postDetailCommentInput,
      isBlocked // profile taps are handled by the page (data-profile-uid)
    });
  }
}

// Who is writing (read when a comment is sent, so a changed name or photo is used)
function getMe() {
  if (!currentUser) return {};
  const profile = currentProfile || {};
  return {
    uid: currentUser.uid,
    name: profile.name || "FreeZone User",
    username: profile.username || "",
    photoURL: profile.photoURL || ""
  };
}

// The Comment button of a post: the comments open in a sheet that slides up (comments.js)
function openComments(postId) {
  if (!currentUser) return;
  openCommentsSheet({
    db,
    postId,
    getMe,
    isBlocked,
    onProfile: (uid) => openUserProfile(uid)
  });
}