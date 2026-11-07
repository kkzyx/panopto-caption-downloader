/**
 * parse.js — 字幕解析 / 转换工具（无依赖，可在 content script、popup 和 Node 中运行）
 *
 * 输入可以是：
 *   - Panopto SRT / VTT 文本
 *   - DeliveryInfo.aspx 返回的 JSON（Delivery.Timestamps[].Caption + .Time）
 *   - [{start, end, text}] 形式的字幕条目
 * 输出：SRT / VTT / 带时间戳的 TXT / 纯文本
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.PCD = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
    ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00b7",
    eacute: "\u00e9", egrave: "\u00e8", agrave: "\u00e0", ccedil: "\u00e7"
  };

  function decodeEntities(input) {
    return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (match, body) {
      if (body.charAt(0) === "#") {
        const hex = body.charAt(1).toLowerCase() === "x";
        const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        if (Number.isFinite(code) && code > 0 && code < 0x110000) {
          try { return String.fromCodePoint(code); } catch (e) { return match; }
        }
        return match;
      }
      const value = ENTITIES[body.toLowerCase()];
      return value === undefined ? match : value;
    });
  }

  /** 去掉 HTML 标签 / 实体，压缩空白 */
  function cleanText(input) {
    if (input === null || input === undefined) return "";
    return decodeEntities(
      String(input)
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    )
      .replace(/[\u200b\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function pad(value, width) {
    return String(Math.max(0, value)).padStart(width || 2, "0");
  }

  function splitSeconds(seconds) {
    let ms = Math.round((Number(seconds) || 0) * 1000);
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const s = Math.floor(ms / 1000); ms -= s * 1000;
    return { h: h, m: m, s: s, ms: ms };
  }

  /** 00:01:23,456 */
  function formatSrtTime(seconds) {
    const t = splitSeconds(seconds);
    return pad(t.h) + ":" + pad(t.m) + ":" + pad(t.s) + "," + pad(t.ms, 3);
  }

  /** 00:01:23.456 */
  function formatVttTime(seconds) {
    const t = splitSeconds(seconds);
    return pad(t.h) + ":" + pad(t.m) + ":" + pad(t.s) + "." + pad(t.ms, 3);
  }

  /** 1:23 / 01:23 / 1:02:03（用于 TXT 里的时间戳） */
  function formatClock(seconds) {
    const t = splitSeconds(seconds);
    if (t.h > 0) return t.h + ":" + pad(t.m) + ":" + pad(t.s);
    return t.m + ":" + pad(t.s);
  }

  function parseTimecode(input) {
    const m = String(input || "").match(/(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/);
    if (!m) return NaN;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    const frac = parseInt(m[4].padEnd(3, "0"), 10);
    return h * 3600 + min * 60 + sec + frac / 1000;
  }

  const TIME_RANGE_RE = /((?:\d{1,3}:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}[,.]\d{1,3})/;

  /**
   * 解析 SRT / VTT 文本 -> [{start, end, text}]
   */
  function parseSubtitles(raw) {
    const text = String(raw || "")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n");
    if (!text.trim()) return [];

    const cues = [];
    const blocks = text.split(/\n{2,}/);

    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].split("\n").filter(function (line) { return line.trim() !== ""; });
      if (!lines.length) continue;

      let rangeLine = -1;
      for (let j = 0; j < lines.length; j++) {
        if (TIME_RANGE_RE.test(lines[j])) { rangeLine = j; break; }
      }
      if (rangeLine === -1) continue;

      const range = lines[rangeLine].match(TIME_RANGE_RE);
      const start = parseTimecode(range[1]);
      const end = parseTimecode(range[2]);
      if (!Number.isFinite(start)) continue;

      const bodyLines = lines.slice(rangeLine + 1).filter(function (line) {
        return !/^(NOTE|STYLE|REGION|WEBVTT)\b/.test(line);
      });
      const body = cleanText(bodyLines.join(" "));
      if (!body) continue;

      cues.push({ start: start, end: Number.isFinite(end) ? end : null, text: body });
    }

    return normalizeCues(cues);
  }

  /**
   * 整理字幕：排序、去重、补齐结束时间、避免重叠
   */
  function normalizeCues(input, options) {
    const opts = options || {};
    const maxGap = Number.isFinite(opts.maxGap) ? opts.maxGap : 8;
    const tail = Number.isFinite(opts.tail) ? opts.tail : 4;

    const cues = [];
    const seen = new Set();

    (Array.isArray(input) ? input : []).forEach(function (cue) {
      if (!cue) return;
      const text = cleanText(cue.text);
      const start = Number(cue.start);
      if (!text || !Number.isFinite(start) || start < 0) return;
      const key = start.toFixed(3) + "|" + text;
      if (seen.has(key)) return;
      seen.add(key);
      let end = Number(cue.end);
      cues.push({ start: start, end: Number.isFinite(end) ? end : null, text: text });
    });

    cues.sort(function (a, b) {
      return a.start - b.start || a.text.length - b.text.length;
    });

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const next = cues[i + 1];
      if (cue.end === null || cue.end === undefined || cue.end <= cue.start) {
        cue.end = next ? Math.min(next.start, cue.start + maxGap) : cue.start + tail;
      }
      if (cue.end <= cue.start) cue.end = cue.start + 0.8;
      if (next && cue.end > next.start) cue.end = next.start;
      if (cue.end <= cue.start) cue.end = cue.start + 0.8;
    }

    return cues;
  }

  function buildSRT(cues) {
    return cues
      .map(function (cue, index) {
        return (index + 1) + "\n" + formatSrtTime(cue.start) + " --> " + formatSrtTime(cue.end) + "\n" + cue.text + "\n";
      })
      .join("\n");
  }

  function buildVTT(cues) {
    const body = cues
      .map(function (cue) {
        return formatVttTime(cue.start) + " --> " + formatVttTime(cue.end) + "\n" + cue.text + "\n";
      })
      .join("\n");
    return "WEBVTT\n\n" + body;
  }

  /** [12:34] 每行一条，适合做笔记 / 对齐录像 */
  function buildTimedText(cues) {
    return cues
      .map(function (cue) { return "[" + formatClock(cue.start) + "] " + cue.text; })
      .join("\n") + "\n";
  }

  /** 纯文字稿：按句子合并，约 600 字符一段 */
  function buildPlainText(cues) {
    const joined = cues.map(function (cue) { return cue.text; }).join(" ").replace(/\s+/g, " ").trim();
    if (!joined) return "";
    const sentences = joined.split(/(?<=[.!?\u3002\uff01\uff1f])\s+/);
    const paragraphs = [];
    let buffer = "";
    sentences.forEach(function (sentence) {
      if (buffer && (buffer + " " + sentence).length > 600) {
        paragraphs.push(buffer);
        buffer = sentence;
      } else {
        buffer = buffer ? buffer + " " + sentence : sentence;
      }
    });
    if (buffer) paragraphs.push(buffer);
    return paragraphs.join("\n\n") + "\n";
  }

  function looksLikeTimestamps(list) {
    if (!Array.isArray(list) || !list.length) return false;
    const first = list[0];
    if (!first || typeof first !== "object") return false;
    return (
      Object.prototype.hasOwnProperty.call(first, "Caption") ||
      Object.prototype.hasOwnProperty.call(first, "caption") ||
      Object.prototype.hasOwnProperty.call(first, "Text") ||
      Object.prototype.hasOwnProperty.call(first, "text")
    );
  }

  /**
   * 在 Panopto 的 DeliveryInfo JSON 里找到字幕数组（结构随版本变化，做宽松匹配）
   */
  function findCaptionArray(node, depth) {
    if (!node || typeof node !== "object" || (depth || 0) > 6) return null;

    if (Array.isArray(node)) {
      return looksLikeTimestamps(node) ? node : null;
    }

    const keys = ["Timestamps", "timestamps", "Captions", "captions", "Transcript", "transcript"];
    for (let i = 0; i < keys.length; i++) {
      const value = node[keys[i]];
      if (looksLikeTimestamps(value)) return value;
    }

    const containers = ["Delivery", "delivery", "d", "Data", "data", "Result", "result", "CaptionInfo"];
    for (let i = 0; i < containers.length; i++) {
      if (node[containers[i]] && typeof node[containers[i]] === "object") {
        const found = findCaptionArray(node[containers[i]], (depth || 0) + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * DeliveryInfo.aspx JSON -> 字幕
   */
  function cuesFromDeliveryInfo(json) {
    const list = findCaptionArray(json, 0);
    if (!list) return [];

    const cues = [];
    list.forEach(function (item) {
      if (!item || typeof item !== "object") return;
      let text = item.Caption;
      if (typeof text !== "string") text = item.caption;
      if (typeof text !== "string") text = item.Text;
      if (typeof text !== "string") text = item.text;
      if (!text || !text.trim()) return;

      let start = item.Time;
      if (!Number.isFinite(start)) start = item.time;
      if (!Number.isFinite(start)) start = item.Start;
      if (!Number.isFinite(start)) start = item.start;
      if (typeof start === "string") start = parseFloat(start);
      if (!Number.isFinite(start) || start < 0) return;

      cues.push({ start: start, text: text });
    });

    return normalizeCues(cues);
  }

  /** 从 DeliveryInfo JSON 里取标题等元信息 */
  function deliveryMeta(json) {
    const delivery =
      (json && (json.Delivery || json.delivery)) ||
      (json && json.d && json.d.Delivery) ||
      json ||
      {};
    return {
      title: delivery.SessionName || delivery.sessionName || "",
      sessionId: delivery.SessionPublicID || delivery.sessionPublicID || "",
      duration: Number(delivery.Duration || delivery.duration) || 0
    };
  }

  function sanitizeFilename(name, fallback) {
    let out = String(name || "")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .trim();
    if (out.length > 120) out = out.slice(0, 120).trim();
    return out || fallback || "panopto-captions";
  }

  function detectFormat(text) {
    const head = String(text || "").slice(0, 2000);
    if (/^\uFEFF?WEBVTT/.test(head)) return "vtt";
    if (/\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/.test(head)) return "srt";
    if (/\d{1,2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(head)) return "vtt";
    return "unknown";
  }

  /** 过滤掉 Panopto 自动生成字幕时的提示行 */
  function dropAutoNote(cues) {
    return cues.filter(function (cue, index) {
      if (index > 1) return true;
      return !/^\[?\s*auto[- ]?generated/i.test(cue.text);
    });
  }

  function render(cues, format) {
    const list = dropAutoNote(normalizeCues(cues));
    switch (format) {
      case "vtt": return { text: buildVTT(list), ext: "vtt", mime: "text/vtt" };
      case "txt": return { text: buildTimedText(list), ext: "txt", mime: "text/plain" };
      case "plain": return { text: buildPlainText(list), ext: "txt", mime: "text/plain" };
      case "srt":
      default: return { text: buildSRT(list), ext: "srt", mime: "application/x-subrip" };
    }
  }

  return {
    decodeEntities: decodeEntities,
    cleanText: cleanText,
    formatSrtTime: formatSrtTime,
    formatVttTime: formatVttTime,
    formatClock: formatClock,
    parseTimecode: parseTimecode,
    parseSubtitles: parseSubtitles,
    normalizeCues: normalizeCues,
    buildSRT: buildSRT,
    buildVTT: buildVTT,
    buildTimedText: buildTimedText,
    buildPlainText: buildPlainText,
    cuesFromDeliveryInfo: cuesFromDeliveryInfo,
    deliveryMeta: deliveryMeta,
    sanitizeFilename: sanitizeFilename,
    detectFormat: detectFormat,
    render: render
  };
});
