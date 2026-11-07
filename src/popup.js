/**
 * popup.js — 弹窗界面逻辑
 */

const $ = (id) => document.getElementById(id);

const els = {
  dot: $("dot"),
  statusText: $("statusText"),
  titleText: $("titleText"),
  format: $("format"),
  folder: $("folder"),
  auto: $("auto"),
  download: $("download"),
  downloadAll: $("downloadAll"),
  message: $("message"),
  hint: $("hint")
};

const DEFAULT_SETTINGS = { format: "srt", folder: true, auto: false };

let settings = Object.assign({}, DEFAULT_SETTINGS);
let activeTabId = null;
let activeTabUrl = "";
let currentMode = "unknown"; // viewer | list | unknown
let busy = false;

/* ---------------------------------------------------------------- */

function setMessage(text, kind) {
  els.message.textContent = text || "";
  els.message.className = "message" + (kind ? " " + kind : "");
}

function setStatus(kind, text) {
  els.dot.className = "dot" + (kind ? " " + kind : "");
  els.statusText.textContent = text;
}

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get("pcdSettings");
    settings = Object.assign({}, DEFAULT_SETTINGS, data.pcdSettings || {});
  } catch (e) {
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
  els.format.value = settings.format;
  els.folder.checked = !!settings.folder;
  els.auto.checked = !!settings.auto;
}

async function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  try {
    await chrome.storage.local.set({ pcdSettings: settings });
  } catch (e) {}
}

/* ---------------------------------------------------------------- */

function sendToTab(message) {
  return new Promise((resolve) => {
    if (activeTabId === null) {
      resolve({ ok: false, error: "no-tab" });
      return;
    }
    try {
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message || "no-receiver" });
          return;
        }
        resolve(response || { ok: false, error: "no-response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

async function injectContentScripts() {
  if (activeTabId === null) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      files: ["src/lib/parse.js", "src/content.js"]
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function probe(want) {
  let response = await sendToTab({ type: "PCD_PROBE", want: want });
  const isPanoptoTab = /^https?:\/\/[^/]*panopto\.[a-z.]+/i.test(activeTabUrl || "");
  if (!response.ok && isPanoptoTab) {
    const injected = await injectContentScripts();
    if (injected) {
      await new Promise((r) => setTimeout(r, 150));
      response = await sendToTab({ type: "PCD_PROBE", want: want });
    }
  }
  return response;
}

/* ---------------------------------------------------------------- */

function showViewer(info) {
  currentMode = "viewer";
  setStatus("ok", "已连接 Panopto 播放器");
  els.titleText.textContent = info.title || "未命名录屏";
  els.download.disabled = false;
  els.downloadAll.hidden = true;
  els.hint.innerHTML = "如果没反应：先点开播放器里的 <b>Transcript / 文字稿</b> 标签，再点一次。";
}

function showList(info) {
  currentMode = "list";
  setStatus("ok", "这是一个课程 / 文件夹列表页");
  els.titleText.textContent = "共检测到 " + info.count + " 个录屏";
  els.download.disabled = true;
  els.downloadAll.hidden = false;
  els.downloadAll.disabled = false;
  els.downloadAll.textContent = "下载本页全部 " + info.count + " 个录屏字幕";
  els.hint.innerHTML = "批量下载会依次处理每个录屏，过程中请不要关闭这个页面。";
}

function showUnavailable(reason) {
  currentMode = "unknown";
  setStatus("err", reason || "当前页面不是 Panopto 录屏页");
  els.titleText.textContent = "";
  els.download.disabled = true;
  els.downloadAll.hidden = true;
  els.hint.innerHTML =
    "请在 <b>Panopto 播放页</b> 或 <b>课程列表页</b> 使用。" +
    "如果播放器嵌在 Moodle 里，直接在网页内点开视频再试。";
}

async function refresh() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  activeTabId = tab && tab.id !== undefined ? tab.id : null;
  activeTabUrl = (tab && tab.url) || "";

  const viewer = await probe("viewer");
  if (viewer && viewer.ok && viewer.isViewer) {
    showViewer(viewer);
    return;
  }

  const list = await probe("list");
  if (list && list.ok && list.isList && list.count > 0) {
    showList(list);
    return;
  }

  if (!tab) {
    showUnavailable("没有可用的标签页");
    return;
  }
  if (/^chrome|^edge|^about/i.test(tab.url || "")) {
    showUnavailable("浏览器内部页面无法使用");
    return;
  }
  showUnavailable("这个页面不是 Panopto 录屏页");
}

/* ---------------------------------------------------------------- */

function setBusy(state, label) {
  busy = state;
  els.download.disabled = state || currentMode !== "viewer";
  els.downloadAll.disabled = state || currentMode !== "list";
  if (state) {
    els.download.querySelector(".btn-label").textContent = label || "正在提取字幕…";
    els.download.querySelector(".spinner").hidden = false;
  } else {
    els.download.querySelector(".btn-label").textContent = "下载当前录屏字幕";
    els.download.querySelector(".spinner").hidden = true;
  }
}

async function handleDownload() {
  if (busy) return;
  setBusy(true, "正在提取字幕…");
  setMessage("正在从 Panopto 读取字幕…");

  const response = await sendToTab({ type: "PCD_DOWNLOAD", format: settings.format });
  setBusy(false);

  if (response && response.ok) {
    const source = response.source ? "，来源：" + response.source : "";
    setMessage("已下载 " + response.filename + "（" + response.count + " 条" + source + "）", "ok");
  } else {
    setMessage((response && response.error) || "下载失败，请重试", "err");
  }
}

async function handleDownloadAll() {
  if (busy) return;
  setBusy(true, "批量处理中…");
  els.downloadAll.textContent = "准备中…";
  setMessage("开始批量下载…");

  const response = await sendToTab({ type: "PCD_DOWNLOAD_ALL", format: settings.format });
  setBusy(false);
  els.downloadAll.textContent = "下载本页全部录屏字幕";

  if (response && response.ok) {
    setMessage("完成：" + response.downloaded + " 个成功，" + response.failed + " 个失败", response.failed ? "err" : "ok");
  } else {
    setMessage((response && response.error) || "批量下载失败", "err");
  }
}

/* ---------------------------------------------------------------- */

els.download.addEventListener("click", handleDownload);
els.downloadAll.addEventListener("click", handleDownloadAll);

els.format.addEventListener("change", () => saveSettings({ format: els.format.value }));
els.folder.addEventListener("change", () => saveSettings({ folder: els.folder.checked }));
els.auto.addEventListener("change", () => {
  saveSettings({ auto: els.auto.checked });
  setMessage(
    els.auto.checked ? "已开启：每次打开新的录屏页会自动下载一次字幕" : "已关闭自动下载",
    "ok"
  );
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "PCD_PROGRESS") return;
  els.downloadAll.textContent = "下载中 " + message.done + "/" + message.total;
  setMessage("已完成 " + message.done + "/" + message.total + (message.title ? "：" + message.title : ""), "ok");
});

(async function init() {
  await loadSettings();
  await refresh();
})();
