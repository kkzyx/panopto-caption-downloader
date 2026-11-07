/**
 * content.js — 核心逻辑：找字幕 -> 转格式 -> 交给 background 下载
 *
 * 字幕来源（按可靠性排序，逐个尝试）：
 *   1. GenerateSRT.ashx         —— Panopto 自带的“导出 SRT”接口，格式最准
 *   2. DeliveryInfo.aspx (JSON) —— 播放器自己用来渲染 Transcript 面板的数据
 *   3. Panopto REST API         —— /api/v1/sessions/{id} -> Urls.CaptionDownloadUrl
 *   4. 网络监听缓存             —— 页面自己请求过的 .vtt / 字幕 JSON
 *   5. 页面 DOM                 —— 兜底：直接读 Transcript 面板里的行
 */
(function () {
  "use strict";

  if (window.__PCD_CONTENT_INSTALLED__) return;
  window.__PCD_CONTENT_INSTALLED__ = true;

  const PCD = window.PCD;
  const UA_IS_EMBED = (function () {
    try { return window.top !== window.self; } catch (e) { return true; }
  })();

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SETTINGS_KEY = "pcdSettings";
  const DONE_KEY = "pcdDone";
  const DEFAULT_SETTINGS = { format: "srt", folder: true, auto: false };

  const hookCache = [];
  const trace = [];

  let busy = false;

  /** 记录每条取字幕通道的结果，失败时展示给用户，方便排查 */
  function note(message) {
    if (trace.length < 12) trace.push(message);
  }

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function safeJson(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
    try { return JSON.parse(trimmed); } catch (e) { return null; }
  }

  function storageGet(key, fallback) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(key, function (data) {
          const value = data && data[key];
          resolve(value === undefined ? fallback : value);
        });
      } catch (e) { resolve(fallback); }
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve) {
      try { chrome.storage.local.set({ [key]: value }, resolve); } catch (e) { resolve(); }
    });
  }

  function getSettings() {
    return storageGet(SETTINGS_KEY, {}).then(function (saved) {
      return Object.assign({}, DEFAULT_SETTINGS, saved || {});
    });
  }

  function sendBackground(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(response || { ok: false, error: "no response" });
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 页面识别                                                             */
  /* ------------------------------------------------------------------ */

  function currentDeliveryId() {
    try {
      const url = new URL(location.href);
      if (!/\/Panopto\/Pages\//i.test(url.pathname)) return null;
      const id = url.searchParams.get("id");
      return id && UUID_RE.test(id) ? id : null;
    } catch (e) { return null; }
  }

  function isViewerPage() {
    return /\/Panopto\/Pages\/(Viewer|Embed)\.aspx/i.test(location.pathname) && !!currentDeliveryId();
  }

  function isListPage() {
    return /\/Panopto\/Pages\/(Sessions\/List|Folder)\.aspx/i.test(location.pathname);
  }

  function pageTitle() {
    let title = (document.title || "").replace(/\s*[-–|]\s*Panopto\s*$/i, "").trim();
    return title;
  }

  /* ------------------------------------------------------------------ */
  /* 网络请求                                                             */
  /* ------------------------------------------------------------------ */

  async function requestText(url, init) {
    const options = Object.assign({ credentials: "include", cache: "no-store" }, init || {});
    const response = await fetch(url, options);
    const text = await response.text();
    return { ok: response.ok, status: response.status, text: text };
  }

  /** 同源拿不到（CORS）时交给 background 再试一次 */
  async function requestTextSmart(url) {
    try {
      return await requestText(url);
    } catch (e) {
      const viaBackground = await sendBackground({ type: "PCD_FETCH", url: url });
      if (viaBackground && viaBackground.ok) {
        return { ok: true, status: 200, text: viaBackground.text };
      }
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 字幕来源 1：GenerateSRT.ashx                                        */
  /* ------------------------------------------------------------------ */

  async function tryGenerateSRT(deliveryId) {
    const languages = ["0", "1", "2"];
    for (let i = 0; i < languages.length; i++) {
      const url = "/Panopto/Pages/Transcription/GenerateSRT.ashx?id=" +
        encodeURIComponent(deliveryId) + "&language=" + encodeURIComponent(languages[i]);
      let result;
      try {
        result = await requestText(url);
      } catch (e) {
        note("GenerateSRT/" + languages[i] + "→网络错误");
        continue;
      }
      if (!result.ok) {
        note("GenerateSRT/" + languages[i] + "→HTTP " + result.status);
        if (result.status === 401 || result.status === 403 || result.status === 404) continue;
        continue;
      }
      if (PCD.detectFormat(result.text) === "unknown") {
        note("GenerateSRT/" + languages[i] + "→无字幕内容");
        continue;
      }
      const cues = PCD.parseSubtitles(result.text);
      if (cues.length) {
        note("GenerateSRT/" + languages[i] + "→成功 " + cues.length + " 条");
        return { cues: cues, source: "GenerateSRT (language=" + languages[i] + ")", raw: result.text };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 字幕来源 2：DeliveryInfo.aspx                                       */
  /* ------------------------------------------------------------------ */

  function deliveryInfoParams(deliveryId) {
    return {
      deliveryId: deliveryId,
      invokeConsiderDisk: "false",
      isLiveNotes: "false",
      refreshAuthCookie: "true",
      isActiveBroadcast: "false",
      isEditing: "false",
      isKollectiveAgentInstalled: "false",
      isEmbed: UA_IS_EMBED ? "true" : "false",
      responseType: "json"
    };
  }

  async function tryDeliveryInfo(deliveryId) {
    const params = deliveryInfoParams(deliveryId);
    const query = new URLSearchParams(params).toString();
    let text = null;

    try {
      const result = await requestText("/Panopto/Pages/Viewer/DeliveryInfo.aspx?" + query);
      if (result.ok) text = result.text;
    } catch (e) {}

    let json = safeJson(text);
    if (!json) {
      try {
        const result = await requestText("/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          body: query
        });
        text = result.text;
        json = safeJson(text);
      } catch (e) {}
    }
    if (!json) {
      note("DeliveryInfo→非 JSON（可能未登录）");
      return null;
    }

    const cues = PCD.cuesFromDeliveryInfo(json);
    const meta = PCD.deliveryMeta(json);
    note("DeliveryInfo→" + (cues.length ? "成功 " + cues.length + " 条" : "无字幕字段"));
    return { cues: cues, meta: meta, json: json };
  }

  /* ------------------------------------------------------------------ */
  /* 字幕来源 3：Panopto REST API                                        */
  /* ------------------------------------------------------------------ */

  async function tryCaptionApi(sessionId) {
    if (!sessionId || !UUID_RE.test(sessionId)) return null;
    let json = null;
    try {
      const result = await requestText("/Panopto/api/v1/sessions/" + encodeURIComponent(sessionId));
      if (!result.ok) return null;
      json = safeJson(result.text);
    } catch (e) { return null; }
    if (!json) return null;

    const urls = json.Urls || json.urls || {};
    const captionUrl = urls.CaptionDownloadUrl || urls.captionDownloadUrl || urls.CaptionDownloadURL;
    if (!captionUrl) {
      note("API→无 CaptionDownloadUrl");
      return null;
    }

    try {
      const result = await requestTextSmart(captionUrl);
      if (!result.ok) return null;
      const format = PCD.detectFormat(result.text);
      if (format === "unknown") return null;
      const cues = PCD.parseSubtitles(result.text);
      if (!cues.length) {
        note("API→字幕文件为空");
        return null;
      }
      note("API→成功 " + cues.length + " 条");
      return { cues: cues, source: "Panopto API (CaptionDownloadUrl)", raw: result.text };
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------ */
  /* 字幕来源 4：页面自己请求过的数据                                     */
  /* ------------------------------------------------------------------ */

  function cuesFromHook() {
    for (let i = hookCache.length - 1; i >= 0; i--) {
      const entry = hookCache[i];
      const body = entry.body;

      if (PCD.detectFormat(body) !== "unknown") {
        const cues = PCD.parseSubtitles(body);
        if (cues.length) return { cues: cues, source: "页面网络请求 (WebVTT/SRT)", raw: body };
      }

      const json = safeJson(body);
      if (json) {
        const cues = PCD.cuesFromDeliveryInfo(json);
        if (cues.length) return { cues: cues, source: "页面网络请求 (JSON)", meta: PCD.deliveryMeta(json) };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 字幕来源 5：DOM                                                     */
  /* ------------------------------------------------------------------ */

  function clockToSeconds(text) {
    const m = String(text || "").trim().match(/^(\d{1,3}:)?\d{1,2}:\d{1,2}$/);
    if (!m) return null;
    const parts = String(text).trim().split(":").map(Number);
    if (parts.some(function (n) { return !Number.isFinite(n); })) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function scrapeTranscriptPane() {
    const rows = document.querySelectorAll(
      "#transcriptTabPane li.index-event, #editTranscriptTabPane li.index-event, li.index-event"
    );
    const cues = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const timeEl = row.querySelector(".event-time") || row.querySelector(".index-event-time");
      const textEl = row.querySelector(".event-text") || row.querySelector(".index-event-text");
      if (!timeEl || !textEl) continue;
      const seconds = clockToSeconds(timeEl.textContent);
      const text = textEl.textContent || "";
      if (seconds === null || !text.trim()) continue;
      cues.push({ start: seconds, text: text });
    }
    return PCD.normalizeCues(cues);
  }

  /** 新版播放器 DOM 结构不固定：找“只有时间”的元素，再取同一行的其他文字 */
  function scrapeGeneric() {
    const cues = [];
    const nodes = document.querySelectorAll("span, div, td, p");
    const limit = Math.min(nodes.length, 6000);

    for (let i = 0; i < limit; i++) {
      const node = nodes[i];
      if (node.childElementCount !== 0) continue;
      const seconds = clockToSeconds(node.textContent);
      if (seconds === null) continue;

      let container = node.parentElement;
      for (let depth = 0; container && depth < 4; depth++) {
        const text = (container.textContent || "").replace(node.textContent, " ").replace(/\s+/g, " ").trim();
        if (text.length > 12 && text.length < 600) {
          cues.push({ start: seconds, text: text });
          break;
        }
        container = container.parentElement;
      }
    }
    return PCD.normalizeCues(cues);
  }

  function cuesFromDom() {
    let cues = scrapeTranscriptPane();
    if (!cues.length) cues = scrapeGeneric();
    if (!cues.length) return null;
    return { cues: cues, source: "页面 Transcript 面板" };
  }

  /* ------------------------------------------------------------------ */
  /* 汇总                                                                */
  /* ------------------------------------------------------------------ */

  async function collectCaptions(deliveryId, options) {
    const opts = options || {};
    const meta = { title: "", sessionId: "", duration: 0 };
    trace.length = 0;

    // 2 和 1 并行：DeliveryInfo 顺带给出标题和 sessionId
    const [delivery, srt] = await Promise.all([
      tryDeliveryInfo(deliveryId).catch(function () { return null; }),
      tryGenerateSRT(deliveryId).catch(function () { return null; })
    ]);

    if (delivery && delivery.meta) {
      Object.assign(meta, delivery.meta);
    }

    // 有些实例的 GenerateSRT 只认 SessionPublicID，用交付 ID 失败后再试一次
    let generated = srt;
    if (!generated && meta.sessionId && meta.sessionId !== deliveryId) {
      generated = await tryGenerateSRT(meta.sessionId).catch(function () { return null; });
    }

    if (generated && generated.cues.length) {
      return { cues: generated.cues, source: generated.source, meta: meta, raw: generated.raw };
    }
    if (delivery && delivery.cues.length) {
      return { cues: delivery.cues, source: "DeliveryInfo (播放器数据)", meta: meta };
    }

    const api = await tryCaptionApi(meta.sessionId).catch(function () { return null; });
    if (api) return { cues: api.cues, source: api.source, meta: meta, raw: api.raw };

    const hooked = cuesFromHook();
    if (hooked) return { cues: hooked.cues, source: hooked.source, meta: meta, raw: hooked.raw };

    if (opts.dom !== false && !opts.noDom) {
      const dom = cuesFromDom();
      if (dom) return { cues: dom.cues, source: dom.source, meta: meta };
    }

    return { cues: [], source: "none", meta: meta };
  }

  /* ------------------------------------------------------------------ */
  /* 下载                                                                */
  /* ------------------------------------------------------------------ */

  async function buildAndDownload(deliveryId, format, overrideTitle) {
    const settings = await getSettings();
    const chosen = format || settings.format || "srt";

    const result = await collectCaptions(deliveryId);
    if (!result.cues.length) {
      const detail = trace.length ? "［" + trace.slice(0, 6).join("；") + "］" : "";
      const error = new Error(
        "没有找到字幕。可能这节课还没生成字幕，或需要先在播放器里打开 Transcript 标签页。" + detail
      );
      error.code = "NO_CAPTIONS";
      throw error;
    }

    const title = PCD.sanitizeFilename(
      (result.meta && result.meta.title) || overrideTitle || pageTitle() || deliveryId,
      deliveryId
    );
    const rendered = PCD.render(result.cues, chosen);
    if (!rendered.text.trim()) {
      const error = new Error("字幕内容为空。");
      error.code = "EMPTY";
      throw error;
    }

    const prefix = settings.folder ? "Panopto字幕/" : "";
    const filename = prefix + title + "." + rendered.ext;
    const response = await sendBackground({
      type: "PCD_DOWNLOAD",
      filename: filename,
      text: rendered.text,
      mime: rendered.mime
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || "浏览器下载失败");
    }

    const done = await storageGet(DONE_KEY, {});
    done[deliveryId] = { at: Date.now(), filename: filename };
    await storageSet(DONE_KEY, done);

    return {
      ok: true,
      count: result.cues.length,
      source: result.source,
      filename: filename,
      title: title,
      format: chosen
    };
  }

  /* ------------------------------------------------------------------ */
  /* 批量下载（课程列表页）                                              */
  /* ------------------------------------------------------------------ */

  function collectPageDeliveryIds() {
    const ids = [];
    const seen = new Set();

    function add(id) {
      if (id && UUID_RE.test(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }

    const links = document.querySelectorAll("a[href*='Viewer.aspx?id='], a[href*='Embed.aspx?id=']");
    for (let i = 0; i < links.length; i++) {
      try { add(new URL(links[i].href).searchParams.get("id")); } catch (e) {}
    }

    const rows = document.querySelectorAll("[id]");
    for (let i = 0; i < rows.length; i++) add(rows[i].id);

    return ids;
  }

  async function downloadAll(format) {
    const ids = collectPageDeliveryIds();
    if (!ids.length) {
      throw new Error("这一页没有找到录屏链接。请在 Panopto 的课程/文件夹列表页使用这个按钮。");
    }

    let ok = 0;
    let failed = 0;

    for (let i = 0; i < ids.length; i++) {
      let title = "";
      try {
        const result = await buildAndDownload(ids[i], format);
        ok++;
        title = result.title || "";
      } catch (e) {
        failed++;
        title = (e && e.message) || "失败";
      }
      chrome.runtime.sendMessage({
        type: "PCD_PROGRESS",
        done: i + 1,
        total: ids.length,
        ok: failed === 0,
        title: title
      }, function () { void chrome.runtime.lastError; });
      await sleep(600);
    }

    return { ok: true, total: ids.length, downloaded: ok, failed: failed };
  }

  /* ------------------------------------------------------------------ */
  /* 页面内提示（自动下载时告知用户）                                     */
  /* ------------------------------------------------------------------ */

  let toastHost = null;

  function toast(message, kind) {
    try {
      if (!toastHost || !toastHost.isConnected) {
        toastHost = document.createElement("div");
        toastHost.style.cssText = "position:fixed;z-index:2147483647;right:20px;bottom:20px;pointer-events:none;";
        const shadow = toastHost.attachShadow({ mode: "open" });
        shadow.innerHTML =
          "<style>" +
          ".box{font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
          "background:#101828;color:#f9fafb;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);" +
          "max-width:320px;opacity:0;transform:translateY(6px);transition:all .18s ease}" +
          ".box.show{opacity:1;transform:none}" +
          ".ok{background:#065f46}.err{background:#7f1d1d}" +
          "</style><div class='box'></div>";
        document.documentElement.appendChild(toastHost);
      }
      const box = toastHost.shadowRoot.querySelector(".box");
      box.textContent = message;
      box.className = "box show " + (kind === "error" ? "err" : "ok");
      clearTimeout(toast._timer);
      toast._timer = setTimeout(function () {
        box.className = "box " + (kind === "error" ? "err" : "ok");
      }, 3600);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* 自动下载                                                            */
  /* ------------------------------------------------------------------ */

  async function maybeAutoDownload() {
    if (!isViewerPage()) return;
    const settings = await getSettings();
    if (!settings.auto) return;

    const deliveryId = currentDeliveryId();
    const done = await storageGet(DONE_KEY, {});
    if (done && done[deliveryId]) return;

    await sleep(1500);
    try {
      const result = await buildAndDownload(deliveryId, settings.format);
      toast("已自动下载字幕：" + result.filename + "（" + result.count + " 条）");
    } catch (e) {
      // 自动模式下安静失败，用户点开插件仍可手动重试
      console.warn("[Panopto 字幕下载器] 自动下载失败：", e && e.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 消息处理                                                            */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message !== "object") return;

    if (message.type === "PCD_PROBE") {
      const viewer = isViewerPage();
      const list = isListPage();
      if (message.want === "viewer" && !viewer) return;
      if (message.want === "list" && !list) return;
      if (!viewer && !list) return;
      sendResponse({
        ok: true,
        isViewer: viewer,
        isList: list,
        deliveryId: currentDeliveryId(),
        title: pageTitle(),
        count: list ? collectPageDeliveryIds().length : 0
      });
      return;
    }

    if (message.type === "PCD_DOWNLOAD") {
      if (!isViewerPage()) return;
      if (busy) { sendResponse({ ok: false, error: "正在下载中，请稍候…" }); return true; }
      busy = true;
      buildAndDownload(currentDeliveryId(), message.format)
        .then(function (result) { sendResponse(result); })
        .catch(function (error) { sendResponse({ ok: false, error: (error && error.message) || "未知错误" }); })
        .finally(function () { busy = false; });
      return true;
    }

    if (message.type === "PCD_DOWNLOAD_ALL") {
      if (!isListPage()) return;
      if (busy) { sendResponse({ ok: false, error: "正在下载中，请稍候…" }); return true; }
      busy = true;
      downloadAll(message.format)
        .then(function (result) { sendResponse(result); })
        .catch(function (error) { sendResponse({ ok: false, error: (error && error.message) || "未知错误" }); })
        .finally(function () { busy = false; });
      return true;
    }

    return;
  });

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__PCD_HOOK__ !== true) return;
    hookCache.push({ url: data.url, body: data.body, at: Date.now() });
    if (hookCache.length > 20) hookCache.shift();
  });

  try { window.postMessage({ __PCD_HOOK_REPLAY__: true }, "*"); } catch (e) {}

  if (isViewerPage()) {
    maybeAutoDownload();
  }
})();
