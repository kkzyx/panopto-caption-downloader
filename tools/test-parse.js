/**
 * 纯 Node 单元测试：node tools/test-parse.js
 * 只测试解析 / 转换逻辑（不涉及浏览器 API）。
 */
const assert = require("assert");
const path = require("path");
const PCD = require(path.join(__dirname, "..", "src", "lib", "parse.js"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (error) {
    console.error("  FAIL " + name + "\n       " + error.message);
    process.exitCode = 1;
  }
}

console.log("parse.js");

test("时间格式化", () => {
  assert.strictEqual(PCD.formatSrtTime(0), "00:00:00,000");
  assert.strictEqual(PCD.formatSrtTime(3723.456), "01:02:03,456");
  assert.strictEqual(PCD.formatVttTime(3723.456), "01:02:03.456");
  assert.strictEqual(PCD.formatClock(83), "1:23");
  assert.strictEqual(PCD.formatClock(3723), "1:02:03");
});

test("SRT 解析 + 重新生成", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:03,500",
    "Hello <i>world</i> &amp; friends",
    "",
    "2",
    "00:00:03,500 --> 00:00:06,000",
    "Second line",
    ""
  ].join("\n");

  const cues = PCD.parseSubtitles(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].text, "Hello world & friends");
  assert.strictEqual(cues[0].start, 1);
  assert.strictEqual(cues[1].start, 3.5);

  const out = PCD.buildSRT(cues);
  assert.ok(/^1\n00:00:01,000 --> 00:00:03,500\nHello world & friends\n/.test(out), out);
});

test("VTT 解析（含 cue 设置与多行）", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000 align:start position:0%",
    "第一行",
    "第二行",
    "",
    "00:00:02.000 --> 00:00:04.000",
    "<c.colorE5E5E5>styled</c> text",
    ""
  ].join("\n");

  const cues = PCD.parseSubtitles(vtt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].text, "第一行 第二行");
  assert.strictEqual(cues[1].text, "styled text");
  assert.strictEqual(PCD.detectFormat(vtt), "vtt");
});

test("DeliveryInfo JSON -> 字幕（真实结构）", () => {
  const json = {
    Delivery: {
      SessionName: "COMP7104 Lecture 01",
      SessionPublicID: "11111111-2222-3333-4444-555555555555",
      Duration: 5400.5,
      Timestamps: [
        { Caption: null, Time: 0, EventTargetType: "ObjectVideo" },
        { Caption: "Good afternoon everyone.", Time: 13.2 },
        { Caption: "  ", Time: 15 },
        { Caption: "Can you hear me?", Time: 18.75 },
        { Caption: "Okay, great.", Time: 21.5 }
      ]
    }
  };

  const cues = PCD.cuesFromDeliveryInfo(json);
  assert.strictEqual(cues.length, 3);
  assert.strictEqual(cues[0].start, 13.2);
  assert.strictEqual(cues[0].end, 18.75);
  assert.strictEqual(cues[2].start, 21.5);
  assert.ok(cues[2].end > cues[2].start);

  const meta = PCD.deliveryMeta(json);
  assert.strictEqual(meta.title, "COMP7104 Lecture 01");
  assert.strictEqual(meta.sessionId, "11111111-2222-3333-4444-555555555555");
});

test("DeliveryInfo 变体：大写字段 / 数组根节点", () => {
  const json = {
    d: { Delivery: { Timestamps: [{ Caption: "A", Time: 1 }, { Caption: "B", Time: 3 }] } }
  };
  assert.strictEqual(PCD.cuesFromDeliveryInfo(json).length, 2);

  const arrayRoot = [{ Caption: "x", Start: 0 }, { Caption: "y", Start: 2 }];
  const cues = PCD.cuesFromDeliveryInfo(arrayRoot);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[1].start, 2);
});

test("重叠 / 缺失结束时间会被修正", () => {
  const cues = PCD.normalizeCues([
    { start: 5, text: "b" },
    { start: 1, text: "a", end: 9 },
    { start: 1, text: "a" }
  ]);
  assert.deepStrictEqual(cues.map((c) => c.text), ["a", "b"]);
  assert.ok(cues[0].end <= cues[1].start);
  assert.ok(cues[1].end > cues[1].start);
});

test("纯文本按句分段", () => {
  const cues = [
    { start: 0, text: "First sentence. Second one!" },
    { start: 4, text: "Third sentence?" }
  ];
  const text = PCD.buildPlainText(cues);
  assert.strictEqual(text.trim(), "First sentence. Second one! Third sentence?");
});

test("TXT 时间戳格式", () => {
  const text = PCD.buildTimedText([
    { start: 65, end: 70, text: "hello" },
    { start: 3725, end: 3730, text: "world" }
  ]);
  assert.strictEqual(text, "[1:05] hello\n[1:02:05] world\n");
});

test("文件名清洗", () => {
  assert.strictEqual(PCD.sanitizeFilename("COMP7104: L1 / Intro?"), "COMP7104 L1 Intro");
  assert.strictEqual(PCD.sanitizeFilename("   "), "panopto-captions");
  assert.strictEqual(PCD.sanitizeFilename("", "abc"), "abc");
});

test("render 输出扩展名 / 内容", () => {
  const cues = [{ start: 0, end: 2, text: "Hello." }, { start: 2, end: 4, text: "Bye." }];
  const srt = PCD.render(cues, "srt");
  assert.strictEqual(srt.ext, "srt");
  assert.ok(srt.text.includes("00:00:00,000 --> 00:00:02,000"));

  const vtt = PCD.render(cues, "vtt");
  assert.strictEqual(vtt.ext, "vtt");
  assert.ok(vtt.text.startsWith("WEBVTT\n\n"));

  const txt = PCD.render(cues, "txt");
  assert.strictEqual(txt.ext, "txt");
  assert.ok(txt.text.startsWith("[0:00] Hello."));

  const plain = PCD.render(cues, "plain");
  assert.strictEqual(plain.text.trim(), "Hello. Bye.");
});

test("自动生成字幕的提示行会被丢弃", () => {
  const cues = PCD.normalizeCues([
    { start: 0, text: "[Auto-generated transcript]. To make better captions, please edit them." },
    { start: 3, text: "Real content." }
  ]);
  const rendered = PCD.render(cues, "plain");
  assert.strictEqual(rendered.text.trim(), "Real content.");
});

console.log("\n" + passed + " passed");
