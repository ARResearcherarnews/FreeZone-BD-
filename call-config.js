// FreeZone BD - settings for audio / video calls (call.js)
//
// STUN lets two phones find each other. It is free and enough for most Wi-Fi calls.
// Some mobile-data networks (4G) also need a TURN relay. If a call says "Connection failed" only on
// mobile data, add a TURN server below. Free options: https://www.metered.ca/tools/openrelay/ or Cloudflare Calls TURN.
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
  // , { urls: "turn:YOUR_TURN_HOST:443?transport=tcp", username: "YOUR_USERNAME", credential: "YOUR_PASSWORD" }
];

export const RING_TIMEOUT_MS = 45000; // the caller gives up (missed call) after this long