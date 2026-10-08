// FreeZone BD - Help center / FAQ
// Loaded by settings.js (Settings > Help center). Add a question by adding one line to FAQ below.
//   render(root, ctx)  ctx.ui = shared look helpers, ctx.go(page) = open another settings page

import { escapeHtml } from "./post.js";

const FAQ = [
  {
    title: "Getting started",
    icon: "rocket_launch",
    items: [
      ["How do I create an account?", "Open the login page and choose <b>Sign up</b>. Enter your name, a username, your email and a password, accept the Terms and Privacy Policy, then continue."],
      ["I forgot my password. What can I do?", "On the login page tap <b>Forgot password</b> and enter your email. We send you a link to choose a new password. If you are already logged in, use <b>Settings &gt; Change password</b> instead."],
      ["Can I change my username?", "No. Your username stays the same because it is part of your profile link and how people find you. You can change your display <b>name</b> once every 60 days in <b>Settings &gt; Edit profile</b>."],
      ["How do I change my profile photo or bio?", "Open <b>Settings &gt; Edit profile</b> (or tap <b>Edit profile</b> on your profile). Tap the photo to choose a new one. You can change your photo and bio as often as you like."]
    ]
  },
  {
    title: "Posts and stories",
    icon: "article",
    items: [
      ["How many photos can I add to a post?", "Up to 4 photos. Tap the <b>+</b> button in the bottom bar, write something, add photos and post. You will see the upload percentage while it uploads."],
      ["How do I edit or delete my post?", "Tap the <b>⋮</b> menu on your own post and choose <b>Edit</b> or <b>Delete</b>. A deleted post cannot be brought back."],
      ["How long does a story last?", "A story disappears after <b>24 hours</b>. Tap <b>Add story</b> in the stories bar to share a photo. People can reply to your story or react to it."],
      ["How do I save a post for later?", "Tap <b>⋮</b> on a post and choose <b>Save</b>. Your saved posts are on your profile under <b>Saved</b>. Only you can see them."],
      ["How do I share a post or my profile?", "Use the <b>Share</b> button on a post, or <b>Copy link</b> in its ⋮ menu. On your profile, tap <b>Share profile</b> to get your own link; anyone with the link can open your profile."]
    ]
  },
  {
    title: "Friends and followers",
    icon: "group",
    items: [
      ["How do I find people?", "Open <b>Friends</b>. <b>Suggested</b> shows people you may know, and <b>Find</b> lets you search the whole app by name or username."],
      ["What is the difference between Followers and Following?", "<b>Following</b> are the people you follow. <b>Followers</b> are the people who follow you."],
      ["How do I remove a follower?", "Open <b>Friends &gt; Followers</b>, tap the <b>⋮</b> next to the person and choose <b>Remove follower</b>. They are not told."]
    ]
  },
  {
    title: "Chat",
    icon: "chat",
    items: [
      ["How do I start a chat?", "Open someone's profile and tap <b>Message</b>, or tap a person in the <b>Active now</b> row on the Chat page."],
      ["What does the green dot mean?", "It means the person is active right now. You see it only for people you follow, and only if you also share your own active status."],
      ["How do I hide my active status?", "Go to <b>Settings &gt; Show my active status</b> and turn it off. Then nobody sees when you are active, and you also cannot see when others are active."],
      ["Can I edit or delete a message?", "Yes, your own messages. Use the options on your message to <b>Edit</b> or <b>Delete</b> it. Edited messages show an \"edited\" mark."],
      ["How do I delete a whole chat?", "Open the chat's <b>⋮</b> menu (or the ⋮ on its row in the inbox) and choose <b>Delete chat</b>. You can delete it only for yourself, or for everyone."],
      ["What does Seen mean?", "Under your last message, <b>Seen</b> shows that the other person has opened the chat and read it."]
    ]
  },
  {
    title: "Privacy and safety",
    icon: "shield",
    items: [
      ["How do I block someone?", "Open their profile and tap <b>⋮ &gt; Block</b>. You will stop following each other, and you will no longer see each other's posts, comments or messages. They are not told. You can unblock in <b>Settings &gt; Blocked accounts</b>."],
      ["How do I report a post?", "Tap <b>⋮</b> on the post, choose <b>Report</b>, and pick a reason. Reports are private."],
      ["Who can see my posts and stories?", "Your posts can be seen by other signed-in people. Your stories can be seen by the people who follow you. Read the <b>Privacy Policy</b> for the full details."],
      ["Are my messages private?", "Only the people in the chat can read it. Messages are not end-to-end encrypted, so please never send passwords or bank details in a chat."]
    ]
  },
  {
    title: "Account",
    icon: "manage_accounts",
    items: [
      ["How do I change my password?", "Go to <b>Settings &gt; Change password</b>, enter your current password and choose a new one."],
      ["How do I delete my account?", "Go to <b>Settings &gt; Delete account</b>. The page explains what is deleted, and you must confirm with your password. Deleting is permanent."],
      ["Something is not working. Who can I tell?", "Use <b>Settings &gt; Report a problem</b> and describe what happened. A screenshot helps a lot."]
    ]
  }
];

const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase();

export function render(root, ctx) {
  const { ui } = ctx;

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-12">
      ${ui.introHtml({
        icon: "help",
        iconClass: "bg-primary-container/10 text-primary-container",
        title: "Help center",
        text: "Answers to common questions about FreeZone BD. Search, or open a topic below."
      })}

      <div class="px-4 mt-4">
        <div class="relative">
          <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-muted text-[20px]">search</span>
          <input type="search" class="hc-search ${ui.INPUT} pl-10" placeholder="Search help" aria-label="Search help" autocomplete="off" />
        </div>
      </div>

      <div class="hc-list px-4 mt-4 space-y-5"></div>

      <p class="hc-empty text-center text-slate-muted font-body-md text-body-md py-8" hidden>No answers found. Try different words, or tell us what you need.</p>

      <div class="px-4 mt-6">
        <div class="rounded-2xl border border-slate-border bg-slate-surface p-4 text-center">
          <div class="font-label-lg text-label-lg text-on-surface font-semibold">Still need help?</div>
          <p class="font-body-sm text-body-sm text-slate-muted mt-1">Tell us what went wrong and we will look into it.</p>
          <div class="flex gap-2.5 mt-3">
            <button type="button" class="hc-report ${ui.BTN_PRIMARY}">Report a problem</button>
          </div>
          <div class="mt-3 flex justify-center gap-4 font-label-md text-label-md">
            <a class="text-primary-container" href="guidelines.html" target="_blank" rel="noopener">Community guidelines</a>
            <a class="text-primary-container" href="privacy.html" target="_blank" rel="noopener">Privacy policy</a>
          </div>
        </div>
      </div>
    </div>`;

  const listEl = root.querySelector(".hc-list");
  const emptyEl = root.querySelector(".hc-empty");
  const searchEl = root.querySelector(".hc-search");

  const draw = (term) => {
    const needle = term.trim().toLowerCase();
    let shown = 0;

    listEl.innerHTML = FAQ.map((group) => {
      const items = group.items.filter(([q, a]) => !needle || q.toLowerCase().includes(needle) || plain(a).includes(needle));
      if (!items.length) return "";
      shown += items.length;
      return `
        <section>
          <h2 class="flex items-center gap-2 font-label-md text-label-md text-slate-subtle uppercase tracking-wide mb-2">
            <span class="material-symbols-outlined text-[18px]">${group.icon}</span>${escapeHtml(group.title)}
          </h2>
          <div class="rounded-2xl border border-slate-border bg-slate-surface divide-y divide-slate-border/60 overflow-hidden">
            ${items
              .map(
                ([q, a]) => `
              <details class="hc-item group" ${needle ? "open" : ""}>
                <summary class="flex items-center justify-between gap-3 px-4 py-3.5 cursor-pointer select-none list-none font-label-lg text-label-lg text-on-surface hover:bg-surface-container-low">
                  <span>${escapeHtml(q)}</span>
                  <span class="material-symbols-outlined text-slate-subtle transition-transform group-open:rotate-180">expand_more</span>
                </summary>
                <div class="px-4 pb-4 font-body-md text-body-md text-on-surface-variant">${a}</div>
              </details>`
              )
              .join("")}
          </div>
        </section>`;
    }).join("");

    emptyEl.hidden = shown > 0;
  };

  draw("");
  searchEl.addEventListener("input", () => draw(searchEl.value));
  root.querySelector(".hc-report").addEventListener("click", () => ctx.go("report-problem"));
}