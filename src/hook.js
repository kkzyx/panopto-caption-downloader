/**
 * hook.js — 运行在页面主世界（MAIN world），
 * 旁路监听页面自己发出的字幕 / 文字稿请求，把响应内容交给 content.js。
 *
 * 为什么需要它：Panopto 新版播放器的字幕可能来自一个临时签名的 .vtt / JSON 地址，
 * 地址随版本变化。监听页面本身的请求比猜接口更稳。
 */
(function () {
  "use strict";
  if (window.__PCD_HOOK_INSTALLED__) return;
  window.__PCD_HOOK_INSTALLED__ = true;

  const URL_PATTERN = /(caption|transcript|transcription|\.vtt(\?|$)|\.srt(\?|$)|GenerateSRT|DeliveryInfo)/i;
  const MAX_BODY = 8 * 1024 * 1024;
  const CACHE_LIMIT = 12;
  const cache = [];

  function remember(url, body) {
    if (typeof body !== "string" || !body) return;
    if (body.length > MAX_BODY) return;
    const entry = { url: String(url), body: body, at: Date.now() };
    cache.push(entry);
    if (cache.length > CACHE_LIMIT) cache.shift();
    try {
      window.postMessage({ __PCD_HOOK__: true, url: entry.url, body: entry.body }, "*");
    } catch (e) {
      /* postMessage 失败就只留在本地缓存里 */
    }
  }

  function shouldCapture(url) {
    try {
      return URL_PATTERN.test(String(url));
    } catch (e) {
      return false;
    }
  }

  // ---- fetch ----
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === "function") {
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const promise = nativeFetch.apply(this, arguments);
        if (!shouldCapture(url)) return promise;
        return promise.then(function (response) {
          try {
            const type = (response.headers && response.headers.get("content-type")) || "";
            if (/json|text|xml|vtt|subrip/i.test(type) || /\.(vtt|srt)|GenerateSRT|DeliveryInfo/i.test(url)) {
              response.clone().text().then(function (body) {
                remember(url, body);
              }).catch(function () {});
            }
          } catch (e) {}
          return response;
        });
      };
    }
  } catch (e) {}

  // ---- XMLHttpRequest ----
  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__pcdUrl = url; } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = xhr.__pcdUrl;
      if (url && shouldCapture(url)) {
        xhr.addEventListener("load", function () {
          try {
            const type = xhr.getResponseHeader("content-type") || "";
            if (/json|text|xml|vtt|subrip/i.test(type) || xhr.responseType === "" || xhr.responseType === "text") {
              remember(url, xhr.responseText);
            }
          } catch (e) {}
        });
      }
      return nativeSend.apply(this, arguments);
    };
  } catch (e) {}

  // content.js 启动较晚时，可以主动要一份缓存
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__PCD_HOOK_REPLAY__ !== true) return;
    cache.forEach(function (entry) {
      try {
        window.postMessage({ __PCD_HOOK__: true, url: entry.url, body: entry.body }, "*");
      } catch (e) {}
    });
  });
})();
