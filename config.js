/* AR News — একমাত্র শেয়ার্ড ফাইল: Firebase কনফিগ + ছোট কিছু হেল্পার।
   feed.html ও admin.html দুটোই এটা লোড করে window.auth / window.rtdb ব্যবহার করে। */
(function () {
  "use strict";

  const firebaseConfig = {
    apiKey: "AIzaSyCzHyMqAOy94aFwdUBPIgamwX1TtFXGSEI",
    authDomain: "ar-news-ai.firebaseapp.com",
    databaseURL: "https://ar-news-ai-default-rtdb.firebaseio.com",
    projectId: "ar-news-ai",
    storageBucket: "ar-news-ai.firebasestorage.app",
    messagingSenderId: "1033140400791",
    appId: "1:1033140400791:web:f111b1a70e8c6c9140efd2",
    measurementId: "G-QBX3BF84E8",
  };

  if (!window.firebase) throw new Error("Firebase SDK পাওয়া যায়নি।");
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);

  window.auth = firebase.auth();
  window.rtdb = firebase.database();

  // "2026-01-05" style Bangla তারিখ ফরম্যাট করার জন্য
  window.formatDate = function (value) {
    const d = new Date(Number(value) || 0);
    return Number.isNaN(d.getTime())
      ? "তারিখ অনুপলব্ধ"
      : new Intl.DateTimeFormat("bn-BD", { year: "numeric", month: "short", day: "numeric" }).format(d);
  };

  // users/{uid}/role === "admin" হলেই অ্যাডমিন হিসেবে গণ্য হবে
  window.isAdmin = async function (user) {
    if (!user || !window.rtdb) return false;
    try {
      const snap = await window.rtdb.ref(`users/${user.uid}/role`).once("value");
      return snap.val() === "admin";
    } catch (_) {
      return false;
    }
  };
})();