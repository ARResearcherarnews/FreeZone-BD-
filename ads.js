/* ============================================================
   Ads.js — AR News কেন্দ্রীয় বিজ্ঞাপন ব্যবস্থাপনা (Ad Management)
   ------------------------------------------------------------
   সব বিজ্ঞাপন সংক্রান্ত কোড ও লজিক এই একটি ফাইলে রাখা আছে।
   "feed.html"-এর ভেতরে সরাসরি কোনো Ad Code নেই — feed.html শুধু
   নিচের পাবলিক ফাংশনগুলো কল করে।

   ভবিষ্যতে Ad Network বা Ad Code পরিবর্তন করতে হলে শুধু এই
   ফাইলের CONFIG অবজেক্ট (আর দরকার হলে loadDirectLinkAd /
   loadAdSenseCreative ফাংশন) বদলালেই হবে — "feed.html"-এ আর হাত
   দেওয়ার দরকার নেই।

   পাবলিক API (window.AdsManager):
     - mountDesktopAd(containerId)
         পেজের টপ ব্যানার Ad Container-এ বিজ্ঞাপন বসায়:
         ডেস্কটপে 728x90, মোবাইলে 320x50 — ডিভাইস অনুযায়ী কোনটা
         দেখাবে সেটা এই ফাইলই স্বয়ংক্রিয়ভাবে ঠিক করে।

     - renderFeedWithAds(items, renderItemFn)
         পোস্টের অ্যারে ([id, post] জোড়ার লিস্ট) ও একটি পোস্ট
         রেন্ডার করার ফাংশন নিয়ে, নির্দিষ্ট বিরতিতে Ad Slot বসিয়ে
         সম্পূর্ণ HTML string রিটার্ন করে।

     - loadFeedAds(rootEl)
         renderFeedWithAds() থেকে তৈরি HTML DOM-এ বসানোর পর এটি
         কল করলে, সেই মুহূর্তে DOM-এ থাকা সব pending Ad Slot লোড
         হওয়া শুরু করে।

   গুরুত্বপূর্ণ নকশা-সিদ্ধান্ত:
     - কোনো Ad Slot ডিফল্টভাবে "display:none" (CSS-এ, feed.html
       দেখুন)। Ad সফলভাবে Fill হলে তবেই "ar-ad-loaded" ক্লাস যোগ
       হয়ে জায়গা তৈরি হয়। Fill না হলে/এরর হলে Slot চিরকাল
       display:none-ই থেকে যায় — তাই কখনো ফাঁকা বক্স বা ভাঙা
       iframe দেখা যায় না।
     - প্রতিটি পাবলিক ফাংশন ও তার ভেতরের প্রতিটি ধাপ try/catch-এ
       মোড়ানো। এই ফাইলে যেকোনো সমস্যা হলেও তা কখনো বাইরে ছুড়ে
       মারা হয় না — feed.html-এর পোস্ট রেন্ডারিং বা বাকি সাইট
       কখনো ভাঙবে না।
   ============================================================ */
(function (global) {
  "use strict";

  /* ======================================================
     ১) কনফিগারেশন — নতুন Ad Network / Ad Code ব্যবহার করতে
        শুধু এখানের মান বদলান। বাকি ফাইলে হাত দেওয়ার দরকার নেই।
     ====================================================== */
  const CONFIG = {
    // কনসোলে (F12 → Console) ডায়াগনস্টিক লগ দেখাবে কিনা — সমস্যা ধরার পর false করে দিন
    debug: true,

    /* ---- টপ ব্যানার: ডেস্কটপে 728x90, মোবাইলে 320x50 ----
       "provider": "directlink" (atOptions + invoke.js ধরনের নেটওয়ার্ক,
       যেমন highrevenueformat.com) | "adsense" | "none" */
    desktop: {
      enabled: true,
      provider: "directlink",
      key: "2a055eaf6e8b28080d8ab36185f15101",
      scriptHost: "https://www.highrevenueformat.com",
      width: 728,
      height: 90,
      // এই ভিউপোর্ট প্রস্থের নিচে সবকিছুকে "মোবাইল" ধরা হয় (feed.html-এর CSS ব্রেকপয়েন্টের সাথে মিলিয়ে রাখা)
      minViewportWidth: 760,

      // মোবাইলে ঠিক এই জায়গাতেই আলাদা, ছোট সাইজের বিজ্ঞাপন দেখানো হয়।
      // 728x90 ডেস্কটপ Ad মোবাইলে কখনোই লোড হয় না — এর বদলে এই কনফিগ ব্যবহার হয়।
      mobile: {
        enabled: true,
        provider: "directlink",
        key: "c71f8a3099f27536be6a3a3b33eee2a0",
        scriptHost: "https://www.highrevenueformat.com",
        width: 320,
        height: 50,
      },
    },

    // ---- ফিডের পোস্টগুলোর মাঝে বিজ্ঞাপন (আপাতত AdSense — চাইলে এখানেও provider:"directlink" করে দেওয়া যাবে) ----
    inFeed: {
      enabled: true,
      provider: "adsense",
      adsenseClientId: "ca-pub-XXXXXXXXXXXXXXXX", // নিজের AdSense পাবলিশার আইডি বসান
      interval: 3,          // প্রতি কতগুলো পোস্ট পরপর একটি Ad আসবে
      startAfter: 3,         // প্রথম Ad কততম পোস্টের পর দেখাবে
      showOnMobile: true,    // মোবাইলে ফিডের ভেতরের Ad দেখাতে চাইলে true রাখুন
      desktopAdSlotId: "2222222222",
      mobileAdSlotId: "3333333333",
      format: "fluid",
      layoutKey: "-6t+ed+2i-1n-4w",
    },

    // এই সময়ের (মিলিসেকেন্ড) মধ্যে কোনো Ad Slot Fill না হলে সেটি সম্পূর্ণ Hide হয়ে যাবে
    fillTimeoutMs: 5000,
  };

  /* ======================================================
     ২) অভ্যন্তরীণ অবস্থা
     ====================================================== */
  let slotCounter = 0;
  const adSenseScriptPromises = {}; // clientId অনুযায়ী ক্যাশ করা থাকে, একই ক্লায়েন্টের স্ক্রিপ্ট বারবার লোড হয় না

  /* ======================================================
     ৩) সাধারণ সহায়ক ফাংশন
     ====================================================== */

  // বর্তমান ভিউপোর্ট মোবাইল কিনা — matchMedia না থাকলেও নিরাপদভাবে fallback করে
  function isMobileViewport() {
    try {
      return !global.matchMedia("(min-width: " + CONFIG.desktop.minViewportWidth + "px)").matches;
    } catch (_) {
      try {
        return global.innerWidth < CONFIG.desktop.minViewportWidth;
      } catch (__) {
        return true; // নির্ণয় করা না গেলে নিরাপদ পথ: মোবাইল ধরে নাও, ভারী Desktop Ad লোড হবে না
      }
    }
  }

  function nextSlotId(prefix) {
    slotCounter += 1;
    return prefix + "-" + Date.now() + "-" + slotCounter;
  }

  // ডায়াগনস্টিক লগ — শুধু কনসোলে দেখায় (F12), কখনো কিছু throw করে না, পেজে কোনো প্রভাব ফেলে না
  function log(msg) {
    if (!CONFIG.debug) return;
    try { console.info("[AR News Ads] " + msg); } catch (_) {}
  }
  function logWarn(msg) {
    if (!CONFIG.debug) return;
    try { console.warn("[AR News Ads] " + msg); } catch (_) {}
  }

  // Ad Slot সম্পূর্ণভাবে লুকিয়ে দেয় — কোনো ফাঁকা জায়গা/মার্জিন থাকে না, ফলে ফিডের লেআউট স্বাভাবিকভাবে উপরে উঠে আসে
  function hideSlot(container) {
    if (!container) return;
    try {
      container.dataset.adPending = "false";
      container.dataset.adStatus = "hidden";
      container.classList.remove("ar-ad-loaded");
      container.classList.add("ar-ad-hidden");
      container.innerHTML = "";
      container.style.width = "";
      container.style.height = "";
    } catch (_) {}
  }

  // Ad সফলভাবে দেখানো গেলে Slot-কে দৃশ্যমান করে, তখনই এটি জায়গা নেয়
  function showSlot(container) {
    if (!container) return;
    try {
      container.dataset.adPending = "false";
      container.dataset.adStatus = "filled";
      container.classList.remove("ar-ad-hidden");
      container.classList.add("ar-ad-loaded");
    } catch (_) {}
  }

  /* ======================================================
     ৪) Provider: "directlink" — atOptions + invoke.js ধরনের নেটওয়ার্ক
        (যেমন highrevenueformat.com / profitableratecpmnetwork.com জাতীয় নেটওয়ার্ক)
        এই নেটওয়ার্কগুলোর কোড পুরনো ধাঁচের document.write ব্যবহার করে, তাই
        সরাসরি মূল পেজে বসালে DOM-এর ক্ষতি হতে পারে। তাই এখানে প্রতিটি Ad
        একটি আলাদা, sandbox করা <iframe>-এর ভেতরে বসানো হয় — মূল পেজ
        সবসময় নিরাপদ থাকে, এবং postMessage দিয়ে Load/Error সংকেত পাওয়া যায়।
     ====================================================== */
  function loadDirectLinkAd(container, opts) {
    if (!container) return;
    try {
      const width = opts.width;
      const height = opts.height;

      const iframe = document.createElement("iframe");
      iframe.setAttribute("scrolling", "no");
      iframe.setAttribute("frameborder", "0");
      iframe.setAttribute("marginwidth", "0");
      iframe.setAttribute("marginheight", "0");
      // sandbox: স্ক্রিপ্ট চলবে, ক্লিকে নতুন ট্যাব খুলতে পারবে (স্বাভাবিক Ad ক্লিক-থ্রু), কিন্তু
      // মূল পেজকে জোর করে অন্য কোনো সাইটে রিডাইরেক্ট করতে পারবে না
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
      iframe.title = "Advertisement";
      iframe.style.border = "0";
      iframe.style.overflow = "hidden";
      iframe.style.width = width + "px";
      iframe.style.height = height + "px";

      container.style.width = width + "px";
      container.style.height = height + "px";
      container.innerHTML = "";
      container.appendChild(iframe);

      const slotToken = nextSlotId("dl");
      let settled = false;

      function finish(ok, reason) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        global.removeEventListener("message", onMessage);
        if (ok) {
          log("Ad সফলভাবে লোড হয়েছে ✅ (" + width + "x" + height + ", key: " + opts.key + ")");
          showSlot(container);
        } else {
          logWarn("Ad লোড ব্যর্থ — Slot Hide করা হলো। কারণ: " + reason + " (key: " + opts.key + ")");
          hideSlot(container);
        }
      }

      function onMessage(event) {
        try {
          if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
          if (!event.data || event.data.arAdSlot !== slotToken) return;
          if (event.data.status === "loaded") finish(true);
          else finish(false, "invoke.js script load ব্যর্থ হয়েছে (সম্ভবত AdBlock বা নেটওয়ার্ক সমস্যা)");
        } catch (_) {}
      }

      global.addEventListener("message", onMessage);
      const timer = setTimeout(function () {
        finish(false, "নির্ধারিত " + CONFIG.fillTimeoutMs + "ms-এর মধ্যে কোনো সাড়া আসেনি (Timeout) — AdBlock, ধীর নেটওয়ার্ক, বা Ad Network-এ এই Zone অ্যাপ্রুভড/অ্যাক্টিভ না থাকলে এমন হয়");
      }, CONFIG.fillTimeoutMs);

      const doc = iframe.contentWindow && iframe.contentWindow.document;
      if (!doc) { finish(false, "iframe.contentWindow.document অ্যাক্সেস করা যায়নি"); return; }

      const scriptUrl = String(opts.scriptHost).replace(/\/+$/, "") + "/" + opts.key + "/invoke.js";
      const atOptionsJSON = JSON.stringify({
        key: opts.key, format: "iframe", height: height, width: width, params: {}
      });

      // iframe-এর নিজস্ব, বিচ্ছিন্ন ডকুমেন্টের ভেতরে atOptions + invoke.js বসানো হচ্ছে —
      // মূল পেজে কখনোই document.write চলে না, তাই পুরো সাইট নিরাপদ থাকে
      log("Ad Script অনুরোধ পাঠানো হচ্ছে: " + scriptUrl);
      const html =
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
        "<style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}</style></head><body>" +
        "<script>window.atOptions=" + atOptionsJSON + ";</script>" +
        "<script src=\"" + scriptUrl + "\" " +
        "onload=\"parent.postMessage({arAdSlot:'" + slotToken + "',status:'loaded'}, '*')\" " +
        "onerror=\"parent.postMessage({arAdSlot:'" + slotToken + "',status:'error'}, '*')\"></script>" +
        "</body></html>";

      doc.open();
      doc.write(html);
      doc.close();
    } catch (err) {
      // এই Ad Slot-এ যেকোনো সমস্যা হলেও বাকি পেজ/ফিড স্বাভাবিকভাবে চলবে
      logWarn("loadDirectLinkAd-এ অপ্রত্যাশিত এরর: " + (err && err.message ? err.message : err));
      hideSlot(container);
    }
  }

  /* ======================================================
     ৫) Provider: "adsense" — Google AdSense (ইন-ফিড বিজ্ঞাপনের জন্য ব্যবহৃত)
     ====================================================== */
  function ensureAdSenseScript(clientId) {
    if (!clientId || clientId.indexOf("XXXX") !== -1) {
      logWarn("AdSense client id কনফিগার করা হয়নি (CONFIG.inFeed.adsenseClientId এখনো প্লেসহোল্ডার)");
      return Promise.reject(new Error("AdSense client id কনফিগার করা হয়নি"));
    }
    if (adSenseScriptPromises[clientId]) return adSenseScriptPromises[clientId];

    adSenseScriptPromises[clientId] = new Promise(function (resolve, reject) {
      try {
        if (global.adsbygoogle) { resolve(); return; }
        const script = document.createElement("script");
        script.async = true;
        script.src =
          "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" +
          encodeURIComponent(clientId);
        script.crossOrigin = "anonymous";
        script.onload = function () { log("AdSense মূল স্ক্রিপ্ট লোড হয়েছে"); resolve(); };
        script.onerror = function () {
          logWarn("AdSense স্ক্রিপ্ট লোড ব্যর্থ (সম্ভবত AdBlock বা নেটওয়ার্ক সমস্যা)");
          reject(new Error("AdSense script load failed"));
        };
        document.head.appendChild(script);
      } catch (err) {
        reject(err);
      }
    });
    return adSenseScriptPromises[clientId];
  }

  // <ins class="adsbygoogle"> এলিমেন্টে Google data-ad-status="filled"/"unfilled" বসার জন্য অপেক্ষা করে
  function watchAdSenseFill(insEl, container) {
    let settled = false;
    let observer = null;

    function finish(filled, reason) {
      if (settled) return;
      settled = true;
      try { if (observer) observer.disconnect(); } catch (_) {}
      clearTimeout(timer);
      if (filled) {
        log("AdSense Ad সফলভাবে Fill হয়েছে ✅");
        showSlot(container);
      } else {
        logWarn("AdSense Ad Unfilled/Timeout — Slot Hide করা হলো। কারণ: " + reason);
        hideSlot(container);
      }
    }

    try {
      observer = new MutationObserver(function () {
        const status = insEl.getAttribute("data-ad-status");
        if (status === "filled") finish(true);
        else if (status === "unfilled") finish(false, "Google থেকে data-ad-status=\"unfilled\" পাওয়া গেছে (এই Slot-এর জন্য কোনো বিজ্ঞাপন নেই)");
      });
      observer.observe(insEl, { attributes: true, attributeFilter: ["data-ad-status"] });
    } catch (_) {
      // MutationObserver না থাকলেও নিচের টাইমআউটের উপর ভরসা করা হবে
    }

    const timer = setTimeout(function () {
      finish(false, "নির্ধারিত " + CONFIG.fillTimeoutMs + "ms-এর মধ্যে data-ad-status বসেনি (Timeout)");
    }, CONFIG.fillTimeoutMs);
  }

  function loadAdSenseCreative(container, slotId, size, clientId) {
    if (!container) return;
    try {
      const ins = document.createElement("ins");
      ins.className = "adsbygoogle";
      ins.style.display = "block";
      ins.setAttribute("data-ad-client", clientId);
      ins.setAttribute("data-ad-slot", slotId);

      if (size === "fluid") {
        ins.setAttribute("data-ad-format", CONFIG.inFeed.format);
        ins.setAttribute("data-ad-layout-key", CONFIG.inFeed.layoutKey);
        ins.style.width = "100%";
      } else {
        ins.style.width = size.width + "px";
        ins.style.height = size.height + "px";
        container.style.width = size.width + "px";
        container.style.height = size.height + "px";
      }

      container.innerHTML = "";
      container.appendChild(ins);

      ensureAdSenseScript(clientId)
        .then(function () {
          try {
            (global.adsbygoogle = global.adsbygoogle || []).push({});
          } catch (_) {
            hideSlot(container);
            return;
          }
          watchAdSenseFill(ins, container);
        })
        .catch(function () {
          hideSlot(container);
        });
    } catch (err) {
      hideSlot(container);
    }
  }

  /* ======================================================
     ৬) পাবলিক: টপ ব্যানার — ডেস্কটপে 728x90, মোবাইলে 320x50
     ====================================================== */
  function loadDesktopVariant(container, variant) {
    if (!variant || !variant.enabled) { hideSlot(container); return; }
    if (variant.provider === "directlink") {
      loadDirectLinkAd(container, variant);
    } else if (variant.provider === "adsense") {
      loadAdSenseCreative(
        container,
        variant.adSlotId,
        { width: variant.width, height: variant.height },
        variant.adsenseClientId
      );
    } else {
      hideSlot(container);
    }
  }

  function mountDesktopAd(containerId) {
    try {
      if (!CONFIG.desktop.enabled) { log("desktop.enabled = false — টপ ব্যানার সম্পূর্ণ নিষ্ক্রিয় করা আছে"); return; }
      const container = document.getElementById(containerId);
      if (!container) {
        logWarn('mountDesktopAd("' + containerId + '") — এই id-র কোনো এলিমেন্ট DOM-এ পাওয়া যায়নি');
        return;
      }

      function pickAndLoad() {
        try {
          if (isMobileViewport()) {
            const m = CONFIG.desktop.mobile;
            if (m && m.enabled) {
              log("মোবাইল ভিউপোর্ট শনাক্ত — " + m.width + "x" + m.height + " Ad লোড হচ্ছে (key: " + m.key + ")");
              loadDesktopVariant(container, m);
            } else {
              log("মোবাইলে টপ ব্যানার নিষ্ক্রিয় (desktop.mobile.enabled = false) — Slot Hide থাকছে");
              hideSlot(container);
            }
          } else {
            log("ডেস্কটপ ভিউপোর্ট শনাক্ত — " + CONFIG.desktop.width + "x" + CONFIG.desktop.height + " Ad লোড হচ্ছে (key: " + CONFIG.desktop.key + ")");
            loadDesktopVariant(container, CONFIG.desktop);
          }
        } catch (_) {
          hideSlot(container);
        }
      }

      let currentlyMobile = isMobileViewport();
      pickAndLoad();

      // ব্রাউজার উইন্ডো রিসাইজ করে মোবাইল ↔ ডেস্কটপ ব্রেকপয়েন্ট পার হলে সঠিক ভ্যারিয়েন্টটা (আবার) লোড করে
      let resizeTimer;
      global.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          try {
            const nowMobile = isMobileViewport();
            if (nowMobile !== currentlyMobile) {
              currentlyMobile = nowMobile;
              pickAndLoad();
            }
          } catch (_) {}
        }, 150);
      });
    } catch (err) {
      // টপ ব্যানার Ad ব্যর্থ হলেও বাকি পেজ স্বাভাবিকভাবে চলবে
    }
  }

  /* ======================================================
     ৭) পাবলিক: ফিডের পোস্টগুলোর মাঝে Ad Slot তৈরি ও লোড করা
     ====================================================== */

  function buildFeedAdSlotHTML() {
    const id = nextSlotId("ar-ad-infeed");
    return (
      '<div class="ar-ad-slot ar-ad-infeed" id="' + id + '" ' +
      'data-ad-pending="true" data-ad-role="infeed"></div>'
    );
  }

  // Feed-এর পোস্টগুলোর HTML-এর সাথে নির্দিষ্ট বিরতিতে Ad Slot বসিয়ে সম্পূর্ণ HTML string রিটার্ন করে।
  // Firebase থেকে যতগুলো পোস্টই লোড হোক, Ad Placement এই লজিক অনুযায়ী স্বয়ংক্রিয়ভাবে ঠিক জায়গায় বসে যায়।
  function renderFeedWithAds(items, renderItemFn) {
    try {
      if (!Array.isArray(items) || typeof renderItemFn !== "function") return "";
      if (!CONFIG.inFeed.enabled) return items.map(renderItemFn).join("");

      let html = "";
      items.forEach(function (item, i) {
        html += renderItemFn(item);
        const postNumber = i + 1;
        const afterStart = postNumber >= CONFIG.inFeed.startAfter;
        const onInterval = (postNumber - CONFIG.inFeed.startAfter) % CONFIG.inFeed.interval === 0;
        if (afterStart && onInterval) {
          html += buildFeedAdSlotHTML();
        }
      });
      return html;
    } catch (err) {
      try { return items.map(renderItemFn).join(""); } catch (_) { return ""; }
    }
  }

  // renderFeedWithAds() থেকে তৈরি HTML DOM-এ বসানোর পর এটি কল করলে pending সব ইন-ফিড Ad Slot লোড হওয়া শুরু করে
  function loadFeedAds(rootEl) {
    try {
      if (!CONFIG.inFeed.enabled) return;
      const root = rootEl || document;
      const pending = root.querySelectorAll(
        '.ar-ad-slot[data-ad-role="infeed"][data-ad-pending="true"]'
      );
      pending.forEach(function (container) {
        try {
          const mobile = isMobileViewport();
          if (mobile && !CONFIG.inFeed.showOnMobile) {
            hideSlot(container);
            return;
          }
          const slotId = mobile
            ? (CONFIG.inFeed.mobileAdSlotId || CONFIG.inFeed.desktopAdSlotId)
            : CONFIG.inFeed.desktopAdSlotId;

          if (CONFIG.inFeed.provider === "adsense") {
            loadAdSenseCreative(container, slotId, "fluid", CONFIG.inFeed.adsenseClientId);
          } else if (CONFIG.inFeed.provider === "directlink") {
            loadDirectLinkAd(container, {
              key: slotId,
              scriptHost: CONFIG.desktop.scriptHost,
              width: mobile ? CONFIG.desktop.mobile.width : CONFIG.desktop.width,
              height: mobile ? CONFIG.desktop.mobile.height : CONFIG.desktop.height,
            });
          } else {
            hideSlot(container);
          }
        } catch (err) {
          hideSlot(container);
        }
      });
    } catch (err) {
      // pending স্লট খুঁজতে সমস্যা হলেও Feed রেন্ডারিং কখনো থেমে থাকবে না
    }
  }

  /* ======================================================
     ৮) পাবলিক API এক্সপোজ
     ====================================================== */
  global.AdsManager = {
    mountDesktopAd: mountDesktopAd,
    renderFeedWithAds: renderFeedWithAds,
    loadFeedAds: loadFeedAds,
  };
})(window);
