// FreeZone BD - app information in ONE place.
// Used by: settings.js, about.js, feedback.js, help.js and the pages terms.html / privacy.html / guidelines.html.
// Change a value here and it changes everywhere.

export const APP_NAME = "FreeZone BD";
export const APP_TAGLINE = "Connect. Share. Chat.";
export const APP_VERSION = "1.0.0";
export const LEGAL_UPDATED = "October 4, 2026";

// Put your real support email here (for example "support@yourdomain.com").
// While it is empty, the app shows "Settings > Report a problem" as the way to reach you instead.
export const SUPPORT_EMAIL = "";

// The link people receive when they are invited
export function getInviteLink() {
  return new URL("login.html", location.href).href;
}