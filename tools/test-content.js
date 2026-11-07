/**
 * 在 Node 里用 vm 模拟浏览器环境，跑一遍 content.js 的完整取字幕流程。
 * 用法：node tools/test-content.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const parseSource = fs.readFileSync(path.join(ROOT, "src", "lib", "parse.js"), "utf8");
const contentSource = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");

const DELIVERY_ID = "03037baf-4638-4390-bb59-b4fa0080c130";

function makeEnv(routes) {
  const calls = { fetch: [], downloads: [], storage: {} };
  const listeners = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Map,
    Set,
    Promise,
    JSON,
    Date,
    Math,
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          if (message.type === "PCD_DOWNLOAD") {
            calls.downloads.push(message);
            if (callback) callback({ ok: true, id: 1 });
            return;
          }
          if (callback) callback({ ok: true, text: "" });
        },
        onMessage: { addListener(fn) { listeners.push(fn); } }
      },
      storage: {
        local: {
          get(key, callback) { callback({}); },
          set(value, callback) { Object.assign(calls.storage, value); if (callback) callback(); }
        }
      }
    },
    fetch(url) {
      calls.fetch.push(String(url));
      const route = routes.find((rule) => String(url).includes(rule.match));
      if (!route) {
        return Promise.resolve({ ok: false, status: 404, text: async () => "not found" });
      }
      return Promise.resolve({
        ok: route.status ? route.status < 400 : true,
        status: route.status || 200,
        text: async () => route.body
      });
    },
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    document: {
      title: "COMP7104 Lecture 1 - Panopto",
      querySelectorAll() { return []; },
      documentElement: { appendChild() {} },
      createElement() { return { style: {}, attachShadow() { return { querySelector() { return {}; }, innerHTML: "" }; } }; }
    },
    location: {
      href: "https://hku.ap.panopto.com/Panopto/Pages/Viewer.aspx?id=" + DELIVERY_ID,
      pathname: "/Panopto/Pages/Viewer.aspx",
      origin: "https://hku.ap.panopto.com"
    }
  };

  const context = vm.createContext(sandbox);
  sandbox.window = context;
  sandbox.self = context;
  sandbox.globalThis = context;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  vm.runInContext(parseSource, context, { filename: "parse.js" });
  vm.runInContext(contentSource, context, { filename: "content.js" });

  return { sandbox, listeners, calls };
}

function request(listener, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: 没有收到响应")), 4000);
    const handled = listener(message, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    if (handled !== true) {
      // content.js 对不能处理的消息不返回 true
      setTimeout(() => { clearTimeout(timer); resolve(null); }, 50);
    }
  });
}

async function run() {
  let passed = 0;
  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log("  ok  " + name);
    } catch (error) {
      console.error("  FAIL " + name + "\n       " + error.stack.split("\n").slice(0, 4).join("\n       "));
      process.exitCode = 1;
    }
  }

  console.log("content.js");

  await test("GenerateSRT 可用时优先使用它", async () => {
    const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:05,000\nSecond line.\n";
    const env = makeEnv([
      { match: "Transcription/GenerateSRT.ashx", body: srt },
      {
        match: "DeliveryInfo.aspx",
        body: JSON.stringify({
          Delivery: { SessionName: "COMP7104 L1", SessionPublicID: "11111111-2222-3333-4444-555555555555", Timestamps: [] }
        })
      }
    ]);

    const response = await request(env.listeners[0], { type: "PCD_DOWNLOAD", format: "srt" });
    assert.ok(response && response.ok, JSON.stringify(response));
    assert.strictEqual(response.count, 2);
    assert.ok(/GenerateSRT/.test(response.source), response.source);
    assert.strictEqual(env.calls.downloads.length, 1);

    const download = env.calls.downloads[0];
    assert.strictEqual(download.filename, "Panopto字幕/COMP7104 L1.srt");
    assert.ok(download.text.includes("Hello there."), download.text);
    assert.strictEqual(download.mime, "application/x-subrip");
  });

  await test("GenerateSRT 失败时回退到 DeliveryInfo 的 Timestamps", async () => {
    const env = makeEnv([
      { match: "Transcription/GenerateSRT.ashx", status: 404, body: "" },
      {
        match: "DeliveryInfo.aspx",
        body: JSON.stringify({
          Delivery: {
            SessionName: "COMP7503 Lecture 2",
            SessionPublicID: "11111111-2222-3333-4444-555555555555",
            Timestamps: [
              { Caption: "First caption.", Time: 12.5 },
              { Caption: "Second caption.", Time: 15.0 }
            ]
          }
        })
      }
    ]);

    const response = await request(env.listeners[0], { type: "PCD_DOWNLOAD", format: "txt" });
    assert.ok(response.ok, JSON.stringify(response));
    assert.strictEqual(response.count, 2);
    assert.ok(/DeliveryInfo/.test(response.source), response.source);
    const download = env.calls.downloads[0];
    assert.strictEqual(download.filename, "Panopto字幕/COMP7503 Lecture 2.txt");
    assert.strictEqual(download.text, "[0:12] First caption.\n[0:15] Second caption.\n");
  });

  await test("全部接口失败时给出可读错误", async () => {
    const env = makeEnv([]);
    const response = await request(env.listeners[0], { type: "PCD_DOWNLOAD", format: "srt" });
    assert.strictEqual(response.ok, false);
    assert.ok(/没有找到字幕/.test(response.error), response.error);
    assert.strictEqual(env.calls.downloads.length, 0);
  });

  await test("登录页 / HTML 不会被当成字幕", async () => {
    const env = makeEnv([
      { match: "Transcription/GenerateSRT.ashx", body: "<!DOCTYPE html><html><body>Login</body></html>" },
      { match: "DeliveryInfo.aspx", body: "<html><body>Sign in</body></html>" }
    ]);
    const response = await request(env.listeners[0], { type: "PCD_DOWNLOAD", format: "srt" });
    assert.strictEqual(response.ok, false);
    assert.ok(/没有找到字幕/.test(response.error));
  });

  await test("非录屏页不会响应下载", async () => {
    const env = makeEnv([]);
    env.sandbox.location.pathname = "/Panopto/Pages/Sessions/List.aspx";
    const response = await request(env.listeners[0], { type: "PCD_DOWNLOAD", format: "srt" });
    assert.strictEqual(response, null);
  });

  await test("PROBE 返回页面信息", async () => {
    const env = makeEnv([]);
    const response = await request(env.listeners[0], { type: "PCD_PROBE", want: "viewer" });
    assert.ok(response && response.ok);
    assert.strictEqual(response.isViewer, true);
    assert.strictEqual(response.deliveryId, DELIVERY_ID);
  });

  console.log("\n" + passed + " passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
