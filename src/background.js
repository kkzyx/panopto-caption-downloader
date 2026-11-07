/**
 * background.js — 负责真正的“写文件”和必要的跨域请求
 * MV3 service worker
 */

const DATA_URL_LIMIT = 1500000; // 超过这个长度改用 Blob URL

async function downloadText(message) {
  const text = String(message.text || "");
  const mime = message.mime || "text/plain";
  const filename = message.filename || "panopto-captions.txt";

  const dataUrl = "data:" + mime + ";charset=utf-8," + encodeURIComponent(text);
  if (dataUrl.length <= DATA_URL_LIMIT) {
    try {
      const id = await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false,
        conflictAction: "uniquify"
      });
      return { ok: true, id: id };
    } catch (error) {
      // 继续尝试 Blob 方案
      console.warn("[PCD] data URL 下载失败，改用 Blob：", error);
    }
  }

  try {
    const blobUrl = URL.createObjectURL(new Blob([text], { type: mime }));
    const id = await chrome.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 60000);
    return { ok: true, id: id };
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) };
  }
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) {
      return { ok: false, status: response.status, error: "HTTP " + response.status };
    }
    const text = await response.text();
    return { ok: true, status: response.status, text: text };
  } catch (error) {
    return { ok: false, error: (error && error.message) || String(error) };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== "object") return;

  if (message.type === "PCD_DOWNLOAD") {
    downloadText(message).then(sendResponse);
    return true;
  }

  if (message.type === "PCD_FETCH") {
    fetchText(message.url).then(sendResponse);
    return true;
  }

  if (message.type === "PCD_PROGRESS") {
    // 只是转发给 popup 显示进度，不需要回复
    return;
  }

  return;
});

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get("pcdSettings", function (data) {
    if (!data || !data.pcdSettings) {
      chrome.storage.local.set({
        pcdSettings: { format: "srt", folder: true, auto: false }
      });
    }
  });
});
