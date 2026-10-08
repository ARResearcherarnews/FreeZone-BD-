// FreeZone BD - About
// Loaded by settings.js (Settings > About FreeZone BD). Values come from app-info.js.

import { escapeHtml } from "./post.js";
import { APP_NAME, APP_TAGLINE, APP_VERSION, SUPPORT_EMAIL } from "./app-info.js";

export function render(root, ctx) {
  const { ui } = ctx;

  const row = (icon, label, value, extra = "") => `
    <div class="flex items-center justify-between gap-4 px-4 py-3.5 ${extra}">
      <div class="flex items-center gap-3 min-w-0">
        <span class="material-symbols-outlined text-slate-muted text-[22px]">${icon}</span>
        <span class="font-label-lg text-label-lg text-on-surface">${escapeHtml(label)}</span>
      </div>
      <span class="font-body-md text-body-md text-slate-muted truncate">${value}</span>
    </div>`;

  const linkRow = (icon, label, href) => `
    <a href="${href}" target="_blank" rel="noopener" class="flex items-center justify-between gap-4 px-4 py-3.5 hover:bg-surface-container-low active:bg-surface-container transition-colors">
      <div class="flex items-center gap-3 min-w-0">
        <span class="material-symbols-outlined text-slate-muted text-[22px]">${icon}</span>
        <span class="font-label-lg text-label-lg text-on-surface">${escapeHtml(label)}</span>
      </div>
      <span class="material-symbols-outlined text-slate-subtle">open_in_new</span>
    </a>`;

  root.innerHTML = `
    <div class="max-w-lg mx-auto pb-12">
      <div class="px-4 pt-8 pb-4 text-center">
        <div class="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary-container to-secondary-container mx-auto flex items-center justify-center shadow-md">
          <span class="material-symbols-outlined text-white text-[40px]" style="font-variation-settings:'FILL' 1;">forum</span>
        </div>
        <h1 class="font-headline-sm text-headline-sm text-on-surface font-semibold mt-4">${escapeHtml(APP_NAME)}</h1>
        <p class="font-body-md text-body-md text-slate-muted">${escapeHtml(APP_TAGLINE)}</p>
        <p class="font-body-md text-body-md text-slate-muted mt-3 max-w-sm mx-auto">A friendly place to connect with people in Bangladesh: share posts and stories, follow friends and chat with them.</p>
      </div>

      <div class="px-4 mt-2">
        <div class="rounded-2xl border border-slate-border bg-slate-surface divide-y divide-slate-border/60 overflow-hidden">
          ${row("info", "Version", escapeHtml(APP_VERSION))}
          ${
            SUPPORT_EMAIL
              ? `<a href="mailto:${escapeHtml(SUPPORT_EMAIL)}" class="block hover:bg-surface-container-low">${row("mail", "Contact", escapeHtml(SUPPORT_EMAIL))}</a>`
              : `<button type="button" class="ab-report block w-full text-left hover:bg-surface-container-low">${row("mail", "Contact", "Report a problem")}</button>`
          }
        </div>

        <div class="px-1 pt-6 pb-1 font-label-md text-label-md text-slate-subtle uppercase tracking-wide">Legal</div>
        <div class="rounded-2xl border border-slate-border bg-slate-surface divide-y divide-slate-border/60 overflow-hidden">
          ${linkRow("description", "Terms of Service", "terms.html")}
          ${linkRow("privacy_tip", "Privacy Policy", "privacy.html")}
          ${linkRow("diversity_3", "Community Guidelines", "guidelines.html")}
        </div>

        <p class="text-center font-body-sm text-body-sm text-slate-subtle mt-8">&copy; ${new Date().getFullYear()} ${escapeHtml(APP_NAME)}. Made in Bangladesh.</p>
      </div>
    </div>`;

  const reportBtn = root.querySelector(".ab-report");
  if (reportBtn) reportBtn.addEventListener("click", () => ctx.go("report-problem"));
}