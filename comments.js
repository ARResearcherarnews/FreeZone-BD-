// FreeZone BD - Comments (Facebook style)
//
// Used in two places:
//   openCommentsSheet()  the bottom sheet that opens when you tap Comment on a post (feed.js -> openComments)
//   mountComments()      the same list + writing bar inside the full post page (feed.js -> renderPostDetail)
//
// Each comment can be liked, replied to and deleted. Replies sit under their comment.
//
// Data (Firebase Realtime Database):
//   posts/{postId}/comments/{commentId}                           = { uid, name, username, photoURL, text, createdAt }
//   posts/{postId}/comments/{commentId}/likes/{uid}               = true
//   posts/{postId}/comments/{commentId}/replies/{replyId}         = { uid, name, username, photoURL, text, createdAt,
//                                                                      replyToUid?, replyToName? }   (replyTo* = answering another reply)
//   posts/{postId}/comments/{commentId}/replies/{replyId}/likes/{uid} = true
// posts/{postId}/commentsCount counts the comments (not the replies).
// Notifications are announced with the "fz:notify" event; notification.js writes them.

import {
  ref,
  push,
  set,
  get,
  remove,
  update,
  onValue,
  increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-database.js";

import { escapeHtml, avatarHtml, timeAgo, showToast } from "./post.js";

const TEXT_MAX = 1000;

const HEART_PATH = "M12 20.5s-7.5-4.6-9.3-9.2C1.6 8.2 3.4 5 6.6 5c2 0 3.6 1.2 5.4 3.3C13.8 6.2 15.4 5 17.4 5c3.2 0 5 3.2 3.9 6.3-1.8 4.6-9.3 9.2-9.3 9.2z";
const heartSvg = (filled) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true"><path d="${HEART_PATH}"/></svg>`;

const notify = (detail) => document.dispatchEvent(new CustomEvent("fz:notify", { detail }));

/* ---------------------------------------------------------------
   Older comments may have no saved photo or username: look them up once
---------------------------------------------------------------- */
const userInfoCache = {};
function getUserInfo(db, uid) {
  if (!uid) return Promise.resolve({ photoURL: "", username: "" });
  if (!userInfoCache[uid]) {
    userInfoCache[uid] = Promise.all([get(ref(db, `users/${uid}/photoURL`)), get(ref(db, `users/${uid}/username`))])
      .then(([photoSnap, usernameSnap]) => ({
        photoURL: photoSnap.exists() ? photoSnap.val() : "",
        username: usernameSnap.exists() ? usernameSnap.val() : ""
      }))
      .catch(() => ({ photoURL: "", username: "" }));
  }
  return userInfoCache[uid];
}

/* ---------------------------------------------------------------
   Markup of one comment or reply
---------------------------------------------------------------- */
function itemHtml(item, { isReply, cid, canDelete, meUid }) {
  const handle = item.username ? `@${item.username}` : item.name || "FreeZone User";
  const likeCount = item.likes ? Object.keys(item.likes).length : 0;
  const liked = !!(meUid && item.likes && item.likes[meUid]);
  const mention = item.replyToName ? `<span class="font-semibold text-primary">${escapeHtml(item.replyToName)}</span> ` : "";
  const profileAttr = item.uid ? `data-profile-uid="${escapeHtml(item.uid)}"` : "";

  return `
    <div class="cm-item flex items-start gap-2.5 ${isReply ? "pt-2.5" : "px-4 py-2.5"}" data-cid="${escapeHtml(cid)}" ${isReply ? `data-rid="${escapeHtml(item.id)}"` : ""} data-uid="${escapeHtml(item.uid || "")}">
      <button type="button" class="cm-avatar flex-shrink-0 ${item.uid ? "" : "pointer-events-none"}" ${profileAttr} data-act="profile" aria-label="Open profile">${avatarHtml(item.photoURL || "", isReply ? "w-7 h-7" : "w-9 h-9")}</button>
      <div class="min-w-0 flex-1">
        <div class="flex items-baseline gap-1.5 min-w-0">
          <button type="button" class="cm-author font-semibold text-[14px] leading-5 text-on-surface truncate text-left min-w-0 ${item.uid ? "" : "pointer-events-none"}" ${profileAttr} data-act="profile">${escapeHtml(handle)}</button>
          <span class="text-slate-muted text-[13px] flex-shrink-0">· ${timeAgo(item.createdAt)}</span>
        </div>
        <p class="text-[15px] leading-[21px] text-on-surface whitespace-pre-wrap break-words mt-0.5">${mention}${escapeHtml(item.text)}</p>
        <div class="flex items-center gap-5 mt-1 text-[13px] font-semibold text-slate-muted">
          <button type="button" data-act="reply" class="py-1 active:opacity-60">Reply</button>
          ${canDelete ? `<button type="button" data-act="delete" class="py-1 hover:text-error active:opacity-60">Delete</button>` : ""}
        </div>
      </div>
      <div class="flex flex-col items-center flex-shrink-0 w-8">
        <button type="button" data-act="like" class="w-8 h-8 rounded-full flex items-center justify-center active:bg-surface-container ${liked ? "text-notification-rose" : "text-slate-muted"}" aria-pressed="${liked}" aria-label="${liked ? "Unlike" : "Like"} this ${isReply ? "reply" : "comment"}">${heartSvg(liked)}</button>
        ${likeCount ? `<span class="text-[12px] leading-3 text-slate-muted tabular-nums">${likeCount}</span>` : ""}
      </div>
    </div>`;
}

const EMPTY_HTML = `
  <div class="text-center py-12 px-6">
    <span class="material-symbols-outlined text-[40px] text-slate-subtle">chat_bubble</span>
    <p class="text-slate-muted font-body-md text-body-md mt-1.5">No comments yet</p>
    <p class="text-slate-subtle font-body-sm text-body-sm">Be the first to comment.</p>
  </div>`;

/* ---------------------------------------------------------------
   The list + the writing bar
---------------------------------------------------------------- */
/**
 * @param {object} o
 *   db, postId
 *   getMe()      -> { uid, name, username, photoURL }  (read when something is sent)
 *   listEl       element the comments are drawn into
 *   formEl, inputEl   the writing bar (a <form> with a text input)
 *   onProfile(uid)    optional; if missing, the page handles [data-profile-uid] clicks itself
 *   isBlocked(uid)    optional; comments of blocked accounts are hidden
 * @returns {{ destroy(), rebind(newListEl), postId }}
 */
export function mountComments(o) {
  const { db, postId, getMe, formEl, inputEl, onProfile, isBlocked } = o;
  let listEl = o.listEl;

  let comments = [];
  let postOwnerUid = "";
  let loaded = false;
  let dead = false;
  const expanded = new Set(); // comments whose replies are open
  let replyTo = null; // { cid, uid, handle, isReply }

  get(ref(db, `posts/${postId}/uid`))
    .then((snap) => {
      postOwnerUid = snap.exists() ? snap.val() : "";
      if (loaded) render();
    })
    .catch(() => {});

  /* ---- the "Replying to" bar above the writing bar ---- */
  const bar = document.createElement("div");
  bar.className = "flex items-center justify-between gap-3 px-4 py-2 bg-surface-container-low border-t border-slate-border text-[13px] text-slate-muted";
  bar.hidden = true;
  bar.innerHTML = `<span class="cm-reply-label min-w-0 truncate"></span>
    <button type="button" class="cm-reply-cancel w-7 h-7 rounded-full flex items-center justify-center hover:bg-surface-container flex-shrink-0" aria-label="Cancel reply">
      <span class="material-symbols-outlined text-[18px]">close</span>
    </button>`;
  formEl.parentNode.insertBefore(bar, formEl);

  const basePlaceholder = inputEl.placeholder || "Write a comment...";
  const setReply = (target) => {
    replyTo = target;
    bar.hidden = !target;
    inputEl.placeholder = target ? "Write a reply..." : basePlaceholder;
    if (target) {
      bar.querySelector(".cm-reply-label").innerHTML = `Replying to <b class="text-on-surface">${escapeHtml(target.handle)}</b>`;
      inputEl.focus();
    }
  };
  bar.querySelector(".cm-reply-cancel").addEventListener("click", () => setReply(null));

  /* ---- drawing ---- */
  const visible = (uid) => !(isBlocked && uid && isBlocked(uid));

  function render() {
    if (dead || !listEl) return;
    const me = getMe?.() || {};
    const shown = comments.filter((c) => visible(c.uid));

    if (!shown.length) {
      listEl.innerHTML = EMPTY_HTML;
      return;
    }

    listEl.innerHTML = shown
      .map((c) => {
        const replies = c.replies.filter((r) => visible(r.uid));
        const open = expanded.has(c.id);
        const canDeleteComment = me.uid && (c.uid === me.uid || postOwnerUid === me.uid);
        return `
          <div class="cm-thread" data-cid="${escapeHtml(c.id)}">
            ${itemHtml(c, { isReply: false, cid: c.id, canDelete: canDeleteComment, meUid: me.uid })}
            ${
              replies.length
                ? `<div class="pl-[3.9rem] pr-4 pb-1.5">
                     <button type="button" data-act="toggle" class="flex items-center gap-2 py-1 text-[13px] font-semibold text-slate-muted active:opacity-60">
                       <span class="inline-block w-6 border-t border-slate-border"></span>
                       ${open ? "Hide replies" : `View ${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
                     </button>
                     ${
                       open
                         ? replies
                             .map((r) =>
                               itemHtml(r, {
                                 isReply: true,
                                 cid: c.id,
                                 canDelete: me.uid && (r.uid === me.uid || postOwnerUid === me.uid || c.uid === me.uid),
                                 meUid: me.uid
                               })
                             )
                             .join("")
                         : ""
                     }
                   </div>`
                : ""
            }
          </div>`;
      })
      .join("");

    // Older comments without a saved photo or username: fill them in
    listEl.querySelectorAll(".cm-item").forEach((row) => {
      const c = comments.find((x) => x.id === row.dataset.cid);
      const item = row.dataset.rid ? c && c.replies.find((r) => r.id === row.dataset.rid) : c;
      if (!item || !item.uid || (item.photoURL && item.username)) return;
      getUserInfo(db, item.uid).then(({ photoURL, username }) => {
        if (dead || !row.isConnected) return;
        if (!item.photoURL && photoURL) row.querySelector(".cm-avatar").innerHTML = avatarHtml(photoURL, row.dataset.rid ? "w-7 h-7" : "w-9 h-9");
        if (!item.username && username) row.querySelector(".cm-author").textContent = `@${username}`;
      });
    });
  }

  /* ---- live data ---- */
  const unsubscribe = onValue(
    ref(db, `posts/${postId}/comments`),
    (snapshot) => {
      comments = [];
      snapshot.forEach((child) => {
        const value = child.val() || {};
        const replies = [];
        if (value.replies) {
          Object.entries(value.replies).forEach(([rid, reply]) => replies.push({ id: rid, ...reply }));
          replies.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }
        comments.push({ ...value, id: child.key, replies });
      });
      comments.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      loaded = true;
      render();
    },
    (error) => {
      console.error("Comments:", error.code, error.message);
      if (listEl) listEl.innerHTML = `<p class="text-center text-slate-muted font-body-md text-body-md py-10">Could not load the comments.</p>`;
    }
  );

  /* ---- taps inside the list ---- */
  const onListClick = async (event) => {
    const button = event.target.closest("[data-act]");
    if (!button || !listEl.contains(button)) return;
    const act = button.dataset.act;
    const threadEl = button.closest(".cm-thread");
    const row = button.closest(".cm-item");
    const cid = (row && row.dataset.cid) || (threadEl && threadEl.dataset.cid);
    const rid = row ? row.dataset.rid : "";
    const comment = comments.find((c) => c.id === cid);
    if (!comment) return;
    const item = rid ? comment.replies.find((r) => r.id === rid) : comment;
    if (!item) return;
    const me = getMe?.() || {};
    if (!me.uid) return;
    const handle = item.username ? `@${item.username}` : item.name || "FreeZone User";

    if (act === "profile") {
      if (onProfile && item.uid) onProfile(item.uid);
      return;
    }

    if (act === "toggle") {
      if (expanded.has(cid)) expanded.delete(cid);
      else expanded.add(cid);
      render();
      return;
    }

    if (act === "reply") {
      // Answering a reply: it stays in the same thread and starts with that person's name
      setReply({ cid, uid: item.uid, handle, isReply: !!rid });
      expanded.add(cid);
      render();
      return;
    }

    if (act === "like") {
      const path = `posts/${postId}/comments/${cid}${rid ? `/replies/${rid}` : ""}/likes/${me.uid}`;
      const wasLiked = !!(item.likes && item.likes[me.uid]);
      try {
        if (wasLiked) await remove(ref(db, path));
        else await set(ref(db, path), true);
        notify({ type: "commentLike", postId, commentId: cid, replyId: rid || "", toUid: item.uid, text: item.text, undo: wasLiked });
      } catch (error) {
        console.error("Like comment:", error);
        showToast(error.code === "PERMISSION_DENIED" ? "Could not like: database rules block it" : "Could not like. Try again");
      }
      return;
    }

    if (act === "delete") {
      if (!confirm(rid ? "Delete this reply?" : "Delete this comment and its replies?")) return;
      try {
        if (rid) {
          await remove(ref(db, `posts/${postId}/comments/${cid}/replies/${rid}`));
        } else {
          await remove(ref(db, `posts/${postId}/comments/${cid}`));
          await update(ref(db, `posts/${postId}`), { commentsCount: increment(-1) });
        }
        if (replyTo && replyTo.cid === cid && !rid) setReply(null);
      } catch (error) {
        console.error("Delete comment:", error);
        showToast("Could not delete. Please try again");
      }
    }
  };
  listEl.addEventListener("click", onListClick);

  /* ---- sending ---- */
  let sending = false;
  const onSubmit = async (event) => {
    event.preventDefault();
    const text = inputEl.value.trim().slice(0, TEXT_MAX);
    const me = getMe?.() || {};
    if (!text || !me.uid || sending) return;

    sending = true;
    inputEl.disabled = true;
    const author = {
      uid: me.uid,
      name: me.name || "FreeZone User",
      username: me.username || "",
      photoURL: me.photoURL || "",
      text,
      createdAt: serverTimestamp()
    };

    try {
      if (replyTo) {
        const target = replyTo;
        const replyRef = push(ref(db, `posts/${postId}/comments/${target.cid}/replies`));
        const data = { ...author };
        if (target.isReply && target.uid && target.handle) {
          data.replyToUid = target.uid;
          data.replyToName = target.handle.slice(0, 60);
        }
        await set(replyRef, data);
        expanded.add(target.cid);
        const parent = comments.find((c) => c.id === target.cid);
        notify({
          type: "reply",
          postId,
          commentId: target.cid,
          replyId: replyRef.key,
          toUid: parent ? parent.uid : "",
          replyToUid: target.isReply ? target.uid : "",
          text
        });
        setReply(null);
        inputEl.value = "";
        requestAnimationFrame(() => {
          const thread = listEl.querySelector(`.cm-thread[data-cid="${CSS.escape(target.cid)}"]`);
          if (thread) thread.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      } else {
        const commentRef = push(ref(db, `posts/${postId}/comments`));
        await set(commentRef, author);
        await update(ref(db, `posts/${postId}`), { commentsCount: increment(1) });
        notify({ type: "comment", postId, commentId: commentRef.key, text });
        inputEl.value = "";
        requestAnimationFrame(() => {
          const last = listEl.lastElementChild;
          if (last) last.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
      }
    } catch (error) {
      console.error("Send comment:", error);
      showToast(error.code === "PERMISSION_DENIED" ? "Could not send: database rules block it" : "Could not send. Try again");
    } finally {
      sending = false;
      inputEl.disabled = false;
      inputEl.dispatchEvent(new Event("input"));
    }
  };
  formEl.addEventListener("submit", onSubmit);

  return {
    postId,
    // The page redrew its container: draw the comments into the new one
    rebind(newListEl) {
      listEl.removeEventListener("click", onListClick);
      listEl = newListEl;
      listEl.addEventListener("click", onListClick);
      if (loaded) render();
    },
    destroy() {
      dead = true;
      unsubscribe();
      listEl.removeEventListener("click", onListClick);
      formEl.removeEventListener("submit", onSubmit);
      bar.remove();
      inputEl.placeholder = basePlaceholder;
    }
  };
}

/* ---------------------------------------------------------------
   The bottom sheet
---------------------------------------------------------------- */
export function openCommentsSheet({ db, postId, getMe, onProfile, isBlocked }) {
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[9997] bg-black/40 flex items-end justify-center";
  overlay.style.opacity = "0";
  overlay.style.transition = "opacity .25s ease";
  overlay.innerHTML = `
    <div class="cs-sheet w-full max-w-lg bg-slate-surface rounded-t-3xl shadow-2xl flex flex-col" role="dialog" aria-modal="true" aria-label="Comments"
         style="height:88vh;max-height:88vh;height:88dvh;max-height:88dvh;transform:translateY(100%);transition:transform .3s cubic-bezier(.2,.8,.2,1);">
      <div class="cs-drag flex-shrink-0 cursor-grab" style="touch-action:none;">
        <div class="pt-2.5"><div class="w-10 h-1 rounded-full bg-slate-border mx-auto"></div></div>
        <div class="flex items-center justify-between px-4 pt-2.5 pb-2.5">
          <div class="cs-likes flex items-center gap-2 font-semibold text-[16px] text-on-surface">
            <span class="w-6 h-6 rounded-full bg-notification-rose text-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${HEART_PATH}"/></svg>
            </span>
            <span class="cs-likes-count tabular-nums">0</span>
          </div>
          <button type="button" class="cs-close w-9 h-9 rounded-full flex items-center justify-center text-slate-muted hover:bg-surface-container" aria-label="Close comments">
            <span class="material-symbols-outlined text-[22px]">close</span>
          </button>
        </div>
      </div>

      <div class="cs-list flex-1 min-h-0 overflow-y-auto overscroll-contain border-t border-slate-border/60 pb-2">
        <p class="text-center text-slate-muted font-body-md text-body-md py-12">Loading...</p>
      </div>

      <form class="cs-form flex items-center gap-2.5 px-3 pt-2.5 border-t border-slate-border flex-shrink-0 bg-slate-surface" style="padding-bottom:calc(.625rem + env(safe-area-inset-bottom, 0px));" autocomplete="off">
        <input type="text" class="cs-input flex-1 min-w-0 bg-surface-container-low rounded-full px-4 py-2.5 text-[16px] text-on-surface placeholder:text-slate-subtle outline-none focus:ring-2 focus:ring-primary-container/20" placeholder="Write a comment..." maxlength="${TEXT_MAX}" enterkeyhint="send" aria-label="Write a comment" />
        <button type="submit" class="cs-send text-primary font-semibold text-[15px] px-2 py-2 disabled:opacity-40" disabled>Send</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const sheet = overlay.querySelector(".cs-sheet");
  const listEl = overlay.querySelector(".cs-list");
  const formEl = overlay.querySelector(".cs-form");
  const inputEl = overlay.querySelector(".cs-input");
  const sendBtn = overlay.querySelector(".cs-send");

  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
    sheet.style.transform = "translateY(0)";
  });

  // Send only lights up when there is something to send
  const syncSend = () => (sendBtn.disabled = inputEl.disabled || !inputEl.value.trim());
  inputEl.addEventListener("input", syncSend);

  const comments = mountComments({
    db,
    postId,
    getMe,
    listEl,
    formEl,
    inputEl,
    isBlocked,
    onProfile: (uid) => {
      close();
      onProfile?.(uid);
    }
  });

  // The like count of the post at the top
  const likesCountEl = overlay.querySelector(".cs-likes-count");
  const stopLikes = onValue(
    ref(db, `posts/${postId}/likesCount`),
    (snap) => (likesCountEl.textContent = String(snap.exists() ? snap.val() : 0)),
    () => {}
  );

  /* ---- closing ---- */
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.style.opacity = "0";
    sheet.style.transform = "translateY(100%)";
    document.body.style.overflow = previousOverflow;
    comments.destroy();
    stopLikes();
    setTimeout(() => overlay.remove(), 320);
  }
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  overlay.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target === overlay || event.target.closest(".cs-close")) close();
  });

  // Drag the top of the sheet down to close it
  const drag = overlay.querySelector(".cs-drag");
  let startY = null;
  drag.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".cs-close")) return;
    startY = event.clientY;
    drag.setPointerCapture(event.pointerId);
    sheet.style.transition = "none";
  });
  drag.addEventListener("pointermove", (event) => {
    if (startY === null) return;
    sheet.style.transform = `translateY(${Math.max(0, event.clientY - startY)}px)`;
  });
  const endDrag = (event) => {
    if (startY === null) return;
    const distance = event.clientY - startY;
    startY = null;
    sheet.style.transition = "transform .3s cubic-bezier(.2,.8,.2,1)";
    if (distance > 110) close();
    else sheet.style.transform = "translateY(0)";
  };
  drag.addEventListener("pointerup", endDrag);
  drag.addEventListener("pointercancel", endDrag);

  return { close };
}