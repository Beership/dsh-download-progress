// 生成 UI 截图：用真实的 lib/client.js 渲染右上角进度卡片（数据为本地 mock，不联网、不改宿主）。
// 用法：node scripts/screenshot.mjs            # 输出 docs/screenshot-{dark,light}.png
//       CHROME_PATH=/path/to/chrome node scripts/screenshot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const CLIENT = path.join(ROOT, "lib", "client.js");
const DOCS = path.join(ROOT, "docs");

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  throw new Error("找不到 Chrome/Edge，请设置 CHROME_PATH 环境变量");
}

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

// mock 任务：一条下载中、一条断流重连、一条已完成、一条失败
const JOBS = [
  {
    id: "dl-20261024-171138-xkgw80",
    url: "https://downloads.example.net/apps/Example-Suite-2.4.1-Windows-x64-Installer.exe",
    status: "running", phase: "downloading",
    filename: "Example-Suite-2.4.1-Windows-x64-Installer.exe",
    totalBytes: 214748364, receivedBytes: 136102000, percent: 63.4,
    speedBps: 43_000_000, etaSeconds: 52, updatedAt: iso(400)
  },
  {
    id: "dl-20261024-171502-p4k2mq",
    url: "https://example.com/datasets/wiki-dump.tar.zst",
    status: "reconnecting", phase: "reconnecting",
    filename: "wiki-dump.tar.zst",
    totalBytes: 4_404_019_200, receivedBytes: 1_258_291_200, percent: 28.6,
    speedBps: 0, etaSeconds: null, updatedAt: iso(300),
    message: "断流重连中（第 2/8 次）…"
  },
  {
    id: "dl-20261024-165833-hn7c1a",
    url: "https://example.com/tools/toolchain-2026.10.zip",
    status: "done", phase: "done",
    filename: "toolchain-2026.10.zip",
    totalBytes: 104_857_600, receivedBytes: 104_857_600, percent: 100,
    speedBps: 0, avgSpeedBps: 26_400_000, elapsedSeconds: 178,
    finishedAt: iso(1500), updatedAt: iso(1500)
  },
  {
    id: "dl-20261024-170002-zz91kd",
    url: "https://example.com/missing/model-weights.bin",
    status: "failed", phase: "failed",
    filename: "model-weights.bin",
    totalBytes: null, receivedBytes: 0, percent: null,
    speedBps: 0, etaSeconds: null, updatedAt: iso(2000),
    message: "HTTP 404 Not Found"
  }
];
const ACTIVE_ONLY = JOBS.filter((j) => ["running", "reconnecting"].includes(j.status));

function html(theme) {
  const dark = theme === "dark";
  const bg = dark ? "#16181c" : "#f6f7f9";
  const fg = dark ? "#d8dbdf" : "#1f2328";
  const sub = dark ? "#9aa0a6" : "#5f6368";
  const bubble = dark ? "#23262c" : "#ffffff";
  const mine = dark ? "#2d3b55" : "#dfe9fb";
  return `<!doctype html><html lang="zh-CN" class="${dark ? "dark" : ""}"><head><meta charset="utf-8">
<title>dsh-download-progress UI</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:${bg};color:${fg};
    font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px}
  .app{display:flex;height:100vh}
  .side{width:180px;border-right:1px solid ${dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.07)"};padding:14px 12px;color:${sub};font-size:12px}
  .side b{display:block;color:${fg};font-size:13px;margin-bottom:10px}
  .side div{padding:5px 0}
  .chat{flex:1;padding:16px 20px;display:flex;flex-direction:column;gap:12px;max-width:760px}
  .msg{padding:10px 12px;border-radius:10px;max-width:78%;line-height:1.55;
    background:${bubble};border:1px solid ${dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)"}}
  .mine{align-self:flex-end;background:${mine};border-color:transparent}
  .meta{font-size:11px;color:${sub};margin-bottom:4px}
</style></head><body>
<div class="app">
  <div class="side"><b>DeepSeek Harness</b><div>新会话</div><div>下载大文件</div><div>插件市场</div><div>设置</div></div>
  <div class="chat">
    <div class="msg mine"><div class="meta">你</div>下载 https://downloads.example.net/apps/Example-Suite-2.4.1-Windows-x64-Installer.exe 到 D:\\Downloads，实时显示进度</div>
    <div class="msg"><div class="meta">Assistant</div>已交给下载器，右上角进度条会实时刷新（百分比 / 速度 / 剩余时间 / 阶段）。</div>
  </div>
</div>
<script>
  // 最小化 __ModuleLoader__ 桩：拿到 factory 导出的插件模块
  window.__JOBS_ALL__ = ${JSON.stringify(JOBS)};
  window.__JOBS_ACTIVE__ = ${JSON.stringify(ACTIVE_ONLY)};
  window.__ModuleLoader__ = { load(mod) { window.__dlp = mod.factory(() => ({})); } };
  // 第一次轮询只给活动任务（模拟「首屏不弹历史终态任务」的真实行为），之后给全部
  var n = 0;
  window.fetch = function (url) {
    if (String(url).indexOf("/list") >= 0) {
      n += 1;
      var jobs = n === 1 ? window.__JOBS_ACTIVE__ : window.__JOBS_ALL__;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ jobs: jobs }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
</script>
<script src="${pathToFileURL(CLIENT).href}"></script>
<script>window.__dlp.apply({});</script>
</body></html>`;
}

function shoot(chrome, theme, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dlp-shot-"));
  const page = path.join(tmp, `harness-${theme}.html`);
  fs.writeFileSync(page, html(theme), "utf8");
  const args = [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--force-device-scale-factor=2",
    "--virtual-time-budget=3000", "--window-size=1100,470",
    `--screenshot=${out}`, pathToFileURL(page).href
  ];
  execFileSync(chrome, args, { stdio: "pipe", timeout: 60000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  const size = fs.statSync(out).size;
  console.log(`✔ ${path.relative(ROOT, out)}  ${(size / 1024).toFixed(0)} KB`);
}

const chrome = findChrome();
fs.mkdirSync(DOCS, { recursive: true });
shoot(chrome, "dark", path.join(DOCS, "screenshot-dark.png"));
shoot(chrome, "light", path.join(DOCS, "screenshot-light.png"));
console.log("完成。");
