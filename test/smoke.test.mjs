// dsh-download-progress 冒烟测试：不依赖外网，用本地 HTTP 服务验证 dl.mjs 完整链路。
// 覆盖：help / 预探测 / 后台下载 / 状态文件 / 断点续传（取消后 resume）/ clean。
// 运行：npm test（Node >= 18）
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DL = path.join(HERE, "..", "skills", "download-progress", "scripts", "dl.mjs");

const SIZE = 6 * 1024 * 1024; // 6 MiB
const PAYLOAD = crypto.randomBytes(SIZE);
const SHA = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

function makeServer({ throttleMs = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    let start = 0;
    let end = SIZE - 1;
    if (m) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    }
    if (start > end || start >= SIZE) {
      res.writeHead(416, { "content-range": `bytes */${SIZE}` });
      res.end();
      return;
    }
    const body = PAYLOAD.subarray(start, end + 1);
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(body.length),
      "accept-ranges": "bytes",
      "last-modified": new Date(0).toUTCString()
    };
    if (m) headers["content-range"] = `bytes ${start}-${end}/${SIZE}`;
    res.writeHead(m ? 206 : 200, headers);
    if (req.method === "HEAD" || throttleMs <= 0) {
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    let off = 0;
    const timer = setInterval(() => {
      if (off >= body.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(body.subarray(off, off + 32 * 1024));
      off += 32 * 1024;
    }, throttleMs);
    res.on("close", () => clearInterval(timer));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/payload.bin` });
    });
  });
}

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dlp-test-"));
  const out = path.join(home, "out");
  fs.mkdirSync(out, { recursive: true });
  const env = {
    ...process.env,
    AGENT_DL_HOME: path.join(home, "agent-dl"),
    DL_NO_SYSTEM_PROXY: "1",
    NO_PROXY: "*"
  };
  return { home, out, env };
}

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [DL, ...args], { env, encoding: "utf8", timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

async function statusOf(id, env) {
  const r = await run(["status", id, "--json"], env);
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

async function waitFor(id, env, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await statusOf(id, env);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待超时：${JSON.stringify(last)}`);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("help 输出包含全部子命令", async () => {
  const { env } = makeEnv();
  const r = await run(["help"], env);
  assert.equal(r.code, 0);
  for (const cmd of ["start", "status", "wait", "cancel", "resume", "clean"]) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `帮助缺少 ${cmd}`);
  }
});

test("完整下载：预探测 → 后台下载 → 大小与 sha256 一致", async () => {
  const { server, url } = await makeServer();
  const { out, env } = makeEnv();
  try {
    const started = await run(["start", url, "--dir", out], env);
    assert.equal(started.code, 0, started.stderr);
    const id = /\[([\w.-]+)\]/.exec(started.stdout)?.[1];
    assert.ok(id, `无法解析任务 ID：${started.stdout}`);

    const done = await waitFor(id, env, (s) => s.status === "done");
    assert.equal(done.receivedBytes, SIZE);
    assert.equal(done.totalBytes, SIZE);
    assert.equal(done.percent, 100);
    const file = path.join(out, "payload.bin");
    assert.equal(fs.statSync(file).size, SIZE);
    assert.equal(sha256(file), SHA);
  } finally {
    server.close();
  }
});

test("断点续传：取消保留 .part，resume 续传后内容正确", async () => {
  const { server, url } = await makeServer({ throttleMs: 40 }); // ~800 KB/s，便于在中途取消
  const { out, env } = makeEnv();
  try {
    const started = await run(["start", url, "--dir", out], env);
    const id = /\[([\w.-]+)\]/.exec(started.stdout)?.[1];
    assert.ok(id, started.stdout);

    const partial = await waitFor(id, env, (s) => (s.receivedBytes || 0) > 512 * 1024, 20000);
    assert.equal(partial.status, "running");

    await run(["cancel", id], env);
    const stopped = await waitFor(id, env, (s) => s.status === "canceled" || s.status === "failed", 20000);
    assert.ok(stopped.receivedBytes > 0, "取消后应保留进度");
    const partFile = path.join(out, `${id}.part`);
    assert.ok(fs.existsSync(partFile), "取消后应保留 .part 文件");
    const partSize = fs.statSync(partFile).size;
    assert.ok(partSize >= stopped.receivedBytes * 0.9, `part 大小异常：${partSize}`);

    const resumed = await run(["resume", id], env);
    assert.equal(resumed.code, 0, resumed.stderr);
    const done = await waitFor(id, env, (s) => s.status === "done");
    assert.equal(done.receivedBytes, SIZE);
    const file = path.join(out, "payload.bin");
    assert.equal(fs.statSync(file).size, SIZE);
    assert.equal(sha256(file), SHA);
  } finally {
    server.close();
  }
});

test("clean 删除任务记录但保留已下载文件", async () => {
  const { server, url } = await makeServer();
  const { out, env } = makeEnv();
  try {
    const started = await run(["start", url, "--dir", out], env);
    const id = /\[([\w.-]+)\]/.exec(started.stdout)?.[1];
    await waitFor(id, env, (s) => s.status === "done");
    const r = await run(["clean", "--force"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, "payload.bin")), "clean 不应删除已下载文件");
    const after = await run(["status", "--json"], env);
    const list = JSON.parse(after.stdout || "[]");
    assert.ok(!list.some((j) => j.id === id), "任务记录应已清理");
  } finally {
    server.close();
  }
});
