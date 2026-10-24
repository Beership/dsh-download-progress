#!/usr/bin/env node
// dl.mjs — 面向 Agent 的下载管理器：实时进度百分比、速度、预计剩余时间(ETA)、阶段跟踪、断点续传。
// 零依赖，Node >= 16。用法：node dl.mjs <start|run|status|wait|cancel|resume|clean|help> ...
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// 数据根目录：优先 --home 显式指定（WMI/Start-Process 代启的 worker 继承不到父进程自定义环境变量），
// 其次 AGENT_DL_HOME，最后 ~/.agent-downloads。
function resolveHome(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--home=')) return path.resolve(a.slice(7));
    if (a === '--home' && argv[i + 1]) return path.resolve(argv[i + 1]);
  }
  return process.env.AGENT_DL_HOME || path.join(os.homedir(), '.agent-downloads');
}
const HOME = resolveHome(process.argv);
const JOBS_DIR = path.join(HOME, 'jobs');
const TICK_MS = 250;            // 状态文件刷新间隔
const STALL_TIMEOUT_MS = 20000; // 无数据超时（视为断流，自动重连续传）
const MAX_ATTEMPTS = 8;
const STALE_MS = 15000;         // 状态超过该时长未更新且进程不在，视为中断
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) agent-dl/0.1 (download-progress plugin)';

// ---------- 系统代理支持 ----------
// 优先级：HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量 → Windows 系统代理（注册表，Clash 等会写入）。
// DL_NO_SYSTEM_PROXY=1 可禁用系统代理回退；NO_PROXY 例外始终生效。
let winSystemProxyCache; // undefined=未读取, null=无代理, string=代理地址

function readWindowsSystemProxy() {
  if (winSystemProxyCache !== undefined) return winSystemProxyCache;
  winSystemProxyCache = null;
  try {
    if (process.platform === 'win32' && process.env.DL_NO_SYSTEM_PROXY !== '1') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const out = execFileSync('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) {
        const out2 = execFileSync('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
        const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out2);
        if (m) {
          let server = m[1];
          if (server.includes('=') || server.includes(';')) {
            // "http=host:port;https=host:port" 形式，取 https 或 http 项
            const parts = {};
            for (const kv of server.split(';')) {
              const [k, v] = kv.split('=');
              if (k && v) parts[k.trim().toLowerCase()] = v.trim();
            }
            server = parts.https || parts.http || null;
          }
          if (server && !/^(socks|ftp)=/i.test(server)) winSystemProxyCache = `http://${server}`;
        }
      }
    }
  } catch { winSystemProxyCache = null; }
  return winSystemProxyCache;
}

function proxyFor(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch { return null; }
  const host = (u.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return null;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const p of noProxy) {
    if (p === '*') return null;
    const bare = p.replace(/^\./, '');
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  const list = u.protocol === 'https:'
    ? [process.env.HTTPS_PROXY, process.env.https_proxy, process.env.ALL_PROXY, process.env.all_proxy]
    : [process.env.HTTP_PROXY, process.env.http_proxy, process.env.ALL_PROXY, process.env.all_proxy];
  return list.find(Boolean) || readWindowsSystemProxy();
}

function connectViaProxy(targetUrl, proxyUrl, cb) {
  const t = new URL(targetUrl);
  const p = new URL(proxyUrl);
  const port = t.port || (t.protocol === 'https:' ? 443 : 80);
  const headers = { Host: `${t.hostname}:${port}`, 'User-Agent': UA };
  if (p.username || p.password) {
    headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64');
  }
  const req = http.request({
    host: p.hostname,
    port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80),
    method: 'CONNECT',
    path: `${t.hostname}:${port}`,
    headers,
    timeout: 15000,
  });
  req.on('connect', (res, socket) => {
    if (res.statusCode !== 200) { socket.destroy(); return cb(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`)); }
    if (t.protocol === 'https:') {
      const tlsSock = tls.connect({ socket, servername: t.hostname });
      tlsSock.once('secureConnect', () => cb(null, tlsSock));
      tlsSock.once('error', (err) => cb(err));
    } else {
      cb(null, socket);
    }
  });
  req.on('timeout', () => req.destroy(new Error('代理连接超时')));
  req.on('error', (err) => cb(err));
  req.end();
}

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const pad = (n, w = 2) => String(n).padStart(w, '0');
// 同步小睡（rename 重试用），不阻塞事件循环太久
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ } };

function makeId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `dl-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

const jobDir = (id) => path.join(JOBS_DIR, id);
const statusPath = (id) => path.join(jobDir(id), 'status.json');
const cancelFlagPath = (id) => path.join(jobDir(id), 'cancel.flag');
const checkCancelFlag = (id) => { try { return fs.existsSync(cancelFlagPath(id)); } catch { return false; } };

function readStatus(id) {
  try { return JSON.parse(fs.readFileSync(statusPath(id), 'utf8')); } catch { return null; }
}

function writeStatusAtomic(st) {
  const p = statusPath(st.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = JSON.stringify(st, null, 2);
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, body);
    // Windows 上读侧（插件 API / status 命令）恰好打开了 status.json 时 rename 会偶发 EPERM/EBUSY，
    // 重试几次仍失败就退化为直接覆盖写，保证进度不会因为一次失败就冻住。
    let lastErr;
    for (let i = 0; i < 6; i += 1) {
      try { fs.renameSync(tmp, p); return; } catch (err) { lastErr = err; sleepSync(5 + i * 5); }
    }
    throw lastErr;
  } catch {
    try { fs.writeFileSync(p, body); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function listJobs() {
  let names = [];
  try { names = fs.readdirSync(JOBS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.map(readStatus).filter(Boolean)
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function procAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) {
    // Windows 下 EPERM 表示进程存在但无权限信号——视为存活，避免误报「已中断」
    return !!(err && err.code === 'EPERM');
  }
}

function isStale(st) {
  const age = Date.now() - Date.parse(st.updatedAt || st.startedAt || nowIso());
  if (age < 3000) return false; // 刚启动，给子进程一点时间
  if (!procAlive(st.pid)) return true;
  return age > STALE_MS;
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
const fmtSpeed = (bps) => `${fmtBytes(bps) || '0 B'}/s`;
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function bar(percent, width = 20) {
  const p = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function compactLine(st) {
  const icon = st.status === 'done' ? '✅' : st.status === 'failed' ? '❌' : st.status === 'canceled' ? '⏹' : '⬇️';
  const size = st.totalBytes != null ? `${fmtBytes(st.receivedBytes)}/${fmtBytes(st.totalBytes)}` : fmtBytes(st.receivedBytes);
  const pct = st.percent != null ? `${st.percent.toFixed(1)}%` : '--';
  const sp = st.status === 'running' ? `  ${fmtSpeed(st.speedBps)}` : '';
  const eta = st.status === 'running'
    ? (st.etaSeconds != null ? `  剩余 ${fmtEta(st.etaSeconds)}` : (st.estimatedSeconds != null ? `  预计 ${fmtEta(st.estimatedSeconds)}` : ''))
    : (st.status === 'queued' && st.estimatedSeconds != null ? `  预计 ${fmtEta(st.estimatedSeconds)}` : '');
  return `${icon} [${st.id}] ${st.filename}  ${bar(st.percent)} ${pct}  ${size}${sp}${eta}  | ${st.message || st.phase}`;
}

function renderJob(st) {
  const size = st.totalBytes != null ? `${fmtBytes(st.receivedBytes)}/${fmtBytes(st.totalBytes)}` : fmtBytes(st.receivedBytes);
  const pct = st.percent != null ? `${st.percent.toFixed(1)}%` : '--';
  const lines = [`[${st.id}] ${st.filename} — ${st.status}`];
  let stat = `  ${bar(st.percent)} ${pct}  ${size}`;
  if (st.status === 'running') stat += `  ${fmtSpeed(st.speedBps)}${st.etaSeconds != null ? `  ETA ${fmtEta(st.etaSeconds)}` : (st.estimatedSeconds != null ? `  预计总用时 ${fmtEta(st.estimatedSeconds)}` : '')}`;
  if (st.status === 'queued' && st.estimatedSeconds != null) stat += `  预计总用时 ${fmtEta(st.estimatedSeconds)}`;
  if (st.status === 'done' && st.avgSpeedBps != null) stat += `  平均 ${fmtSpeed(st.avgSpeedBps)}  用时 ${fmtEta(st.elapsedSeconds)}`;
  lines.push(stat);
  lines.push(`  ${st.message || st.phase}`);
  if (st.error) lines.push(`  错误: ${st.error}`);
  lines.push(`  文件: ${path.join(st.file, st.filename)}`);
  return lines.join('\n');
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 180) || 'download.bin';
}

// ---------- 按站点记录历史速度，用于下载前估算耗时 ----------
const statsFile = () => path.join(HOME, 'speed-history.json');
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

function readSpeedHistory() {
  try { return JSON.parse(fs.readFileSync(statsFile(), 'utf8')); } catch { return {}; }
}

function recordSpeed(host, bps) {
  if (!host || !(bps > 0)) return;
  const stats = readSpeedHistory();
  stats[host] = Math.round(stats[host] ? stats[host] * 0.7 + bps * 0.3 : bps);
  try {
    fs.mkdirSync(HOME, { recursive: true });
    const tmp = statsFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, statsFile());
  } catch { /* ignore */ }
}

// ---------- 下载前预探测：HEAD（必要时退回 GET Range: 0-1）取大小 ----------
function probeOnce(urlStr, method, extraHeaders) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let u;
    try { u = new URL(urlStr); } catch { return done(null); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return done(null);
    try {
      const mod = u.protocol === 'http:' ? http : https;
      const proxyUrl = proxyFor(urlStr);
      const reqOpts = { method, headers: { 'User-Agent': UA, Accept: '*/*', ...extraHeaders }, timeout: 8000 };
      if (proxyUrl) {
        const agent = new (u.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: false });
        agent.createConnection = (opts, cb) => connectViaProxy(urlStr, proxyUrl, cb);
        reqOpts.agent = agent;
      }
      const req = mod.request(u, reqOpts, (res) => {
        res.resume();
        const info = {
          statusCode: res.statusCode,
          location: res.headers.location || null,
          contentLength: isNaN(parseInt(res.headers['content-length'], 10)) ? null : parseInt(res.headers['content-length'], 10),
          contentRange: res.headers['content-range'] || null,
          contentDisposition: res.headers['content-disposition'] || null,
          acceptRanges: res.headers['accept-ranges'] === 'bytes',
        };
        res.on('end', () => done(info));
        res.on('close', () => done(info));
        setTimeout(() => done(info), 800).unref();
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.end();
    } catch { done(null); }
  });
}

async function probeRedirects(urlStr, method, extraHeaders, maxHops = 5) {
  let current = urlStr;
  for (let i = 0; i <= maxHops; i += 1) {
    const info = await probeOnce(current, method, extraHeaders);
    if (!info) return null;
    if (info.statusCode >= 300 && info.statusCode < 400 && info.location) {
      try { current = String(new URL(info.location, current)); } catch { return null; }
      continue;
    }
    return { ...info, finalUrl: current };
  }
  return null;
}

async function probePreflight(urlStr) {
  const head = await probeRedirects(urlStr, 'HEAD');
  let total = head && head.statusCode === 200 ? head.contentLength : null;
  let acceptRanges = head ? head.acceptRanges : false;
  let filename = head && head.contentDisposition ? pickFilename({ url: urlStr }, head, new URL(head.finalUrl)) : null;
  const finalUrl = head ? head.finalUrl : urlStr;
  if (total == null) {
    // 服务器不支持 HEAD 或未返回长度：退回 GET Range: 0-1
    const g = await probeRedirects(finalUrl, 'GET', { Range: 'bytes=0-1' });
    if (g) {
      if (g.statusCode === 206 && g.contentRange) {
        const m = /\/(\d+)\s*$/.exec(g.contentRange);
        if (m) { total = parseInt(m[1], 10); acceptRanges = true; }
      } else if (g.statusCode === 200 && g.contentLength != null) {
        total = g.contentLength;
      }
      if (!filename) filename = pickFilename({ url: urlStr }, g, new URL(g.finalUrl));
    }
  }
  return { totalBytes: total, acceptRanges, filename, finalUrl };
}

function pickFilename(st, headers, u) {
  const cd = headers['content-disposition'];
  if (cd) {
    const mStar = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
    if (mStar) { try { return sanitize(decodeURIComponent(mStar[1].trim())); } catch { /* ignore */ } }
    const m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    if (m) { try { return sanitize(decodeURIComponent(m[1].trim())); } catch { /* ignore */ } }
  }
  let base = null;
  try { base = decodeURIComponent(u.pathname).split('/').filter(Boolean).pop() || null; } catch { /* ignore */ }
  if (base && /\.[A-Za-z0-9]{1,8}$/.test(base)) return sanitize(base);
  return null; // 拿不到像样的文件名时保留占位名
}

function validateUrl(u) {
  let x;
  try { x = new URL(u); } catch { bad(); }
  if (!x || (x.protocol !== 'http:' && x.protocol !== 'https:')) bad();
  function bad() { console.error(`无效的 http/https URL: ${u}`); process.exit(1); }
  return x;
}

function parseArgs(argv, flagValues) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a.startsWith('-')) {
      const key = a.replace(/^--?/, '');
      if (flagValues.has(key)) opts[key] = argv[i += 1];
      else opts[key] = true;
    } else opts._.push(a);
  }
  return opts;
}

const FLAG_VALUES = new Set(['o', 'out', 'dir', 'job', 'interval', 'timeout', 'home']);

// ---------- 下载 worker（run 命令，前台/后台共用） ----------
async function cmdRun(opts) {
  const url = opts._[0];
  if (!url) { console.error('用法: dl run <URL> [-o 保存路径] [--dir 目录] [--quiet] [--job 任务ID]'); process.exitCode = 1; return; }
  validateUrl(url);

  const id = opts.job || makeId();
  let st = readStatus(id);
  const partPath = () => path.join(st.file, `${st.id}.part`);

  if (!st) {
    let dir = opts.dir ? path.resolve(String(opts.dir)) : null;
    let name = null;
    const outv = opts.out || opts.o;
    if (outv) { const p = path.resolve(String(outv)); dir = path.dirname(p); name = path.basename(p); }
    dir = dir || process.cwd();
    st = {
      id, url, createdAt: nowIso(), startedAt: nowIso(), updatedAt: nowIso(),
      status: 'running', phase: 'connecting', message: '正在连接服务器…',
      pid: process.pid, file: dir, filename: name || `download-${id}.bin`, explicitName: !!name,
      totalBytes: null, receivedBytes: 0, percent: null, speedBps: 0, etaSeconds: null,
      attempt: 0, maxAttempts: MAX_ATTEMPTS, redirects: 0, finalUrl: null, server: null,
      acceptRanges: false, etag: null, contentType: null, resumed: false,
      avgSpeedBps: null, elapsedSeconds: null, finishedAt: null, error: null, cancelRequested: false,
    };
    writeStatusAtomic(st);
  } else {
    Object.assign(st, {
      status: 'running', phase: 'connecting', message: '正在连接服务器（续传）…',
      pid: process.pid, error: null, cancelRequested: false, updatedAt: nowIso(),
    });
    writeStatusAtomic(st);
  }
  try { fs.rmSync(cancelFlagPath(id), { force: true }); } catch { /* ignore */ }

  const quiet = !!opts.quiet;
  let lastBar = '';
  let lastLineAt = 0;
  const printBar = () => {
    if (quiet) return;
    const line = compactLine(st);
    if (process.stderr.isTTY) {
      process.stderr.write(`\r\x1b[K${line}`);
      lastBar = line;
    } else {
      const t = Date.now();
      if (t - lastLineAt >= 2000) { lastLineAt = t; console.error(line); }
    }
  };

  function finalize() {
    st.phase = 'finalizing';
    st.message = '正在完成（写入最终文件）…';
    st.updatedAt = nowIso();
    writeStatusAtomic(st);
    fs.mkdirSync(st.file, { recursive: true });
    let target = path.join(st.file, st.filename);
    if (fs.existsSync(target)) {
      const ext = path.extname(st.filename);
      const base = path.basename(st.filename, ext);
      let i = 1;
      while (fs.existsSync(path.join(st.file, `${base} (${i})${ext}`))) i += 1;
      target = path.join(st.file, `${base} (${i})${ext}`);
    }
    fs.renameSync(partPath(), target);
    st.filename = path.basename(target);
    st.status = 'done';
    st.phase = 'done';
    st.percent = st.totalBytes != null ? 100 : st.percent;
    st.speedBps = 0;
    st.etaSeconds = null;
    st.finishedAt = nowIso();
    st.updatedAt = nowIso();
    st.elapsedSeconds = Math.max(0.1, (Date.parse(st.finishedAt) - Date.parse(st.startedAt)) / 1000);
    st.avgSpeedBps = st.totalBytes != null ? st.totalBytes / st.elapsedSeconds : null;
    st.message = '下载完成';
    if (st.avgSpeedBps > 0) recordSpeed(hostOf(st.finalUrl || st.url), st.avgSpeedBps);
    writeStatusAtomic(st);
  }

  function attemptOnce() {
    return new Promise((resolve, reject) => {
      const u = new URL(st.finalUrl || st.url);
      const mod = u.protocol === 'http:' ? http : https;
      const part = partPath();
      const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;
      if (partSize > 0 && st.receivedBytes !== partSize) st.receivedBytes = partSize; // 以 .part 实际大小为准
      const canResume = partSize > 0 && st.acceptRanges && (st.attempt > 1 || st.resumed);
      const headers = { 'User-Agent': UA, Accept: '*/*' };
      if (canResume) {
        headers.Range = `bytes=${partSize}-`;
        if (st.etag) headers['If-Range'] = st.etag;
      }
      let cleanupTimers = () => {};

      const proxyUrl = proxyFor(st.finalUrl || st.url);
      const reqOpts = { headers, timeout: 30000 };
      if (proxyUrl) {
        // 注意：Node 会忽略构造参数里的 createConnection（Agent 构造器不读取它），
        // agent:false 也会实例化默认 Agent 从而走默认连接。必须直接覆盖实例属性。
        const agent = new (u.protocol === 'https:' ? https.Agent : http.Agent)({ keepAlive: false });
        agent.createConnection = (opts, cb) => connectViaProxy(u, proxyUrl, cb);
        reqOpts.agent = agent;
      }
      const req = mod.get(u, reqOpts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (st.redirects >= 8) return reject(new Error('重定向次数过多'));
          st.redirects += 1;
          try { st.finalUrl = String(new URL(res.headers.location, u)); } catch { return reject(new Error(`无效的重定向地址: ${res.headers.location}`)); }
          return resolve(attemptOnce());
        }

        const code = res.statusCode;
        if (code === 416) {
          res.resume();
          if (st.totalBytes != null && partSize >= st.totalBytes) { st.receivedBytes = st.totalBytes; return resolve(finalize()); }
          st.acceptRanges = false;
          st.receivedBytes = 0;
          try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
          return resolve(attemptOnce());
        }
        if (code < 200 || code >= 300) { res.resume(); return reject(new Error(`HTTP ${code} ${res.statusMessage || ''}`)); }

        let resumeBase = 0;
        if (code === 206) {
          const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(String(res.headers['content-range'] || ''));
          const start = m ? parseInt(m[1], 10) : NaN;
          const total = m && m[3] !== '*' ? parseInt(m[3], 10) : null;
          if (!Number.isNaN(start) && start === partSize) resumeBase = start;
          else if (start === 0) resumeBase = 0;
          else if (!Number.isNaN(start)) { res.resume(); return reject(new Error(`续传位置不匹配（服务器从 ${start} 开始，本地已有 ${partSize}）`)); }
          if (total != null) st.totalBytes = total;
        } else {
          st.acceptRanges = res.headers['accept-ranges'] === 'bytes';
          if (partSize > 0) { try { fs.rmSync(part, { force: true }); } catch { /* ignore */ } }
        }

        const clen = parseInt(res.headers['content-length'], 10);
        if (!Number.isNaN(clen)) st.totalBytes = resumeBase + clen;
        st.receivedBytes = resumeBase;
        st.etag = res.headers.etag || st.etag || null;
        st.contentType = res.headers['content-type'] || null;
        st.server = res.headers.server || null;
        if (!st.explicitName) {
          const picked = pickFilename(st, res.headers, u);
          if (picked) st.filename = picked;
        }
        st.phase = 'downloading';
        st.message = st.totalBytes == null
          ? '正在下载（服务器未提供文件大小，无百分比，可看速度和已下载量）…'
          : `正在下载（第 ${st.attempt} 次尝试${resumeBase > 0 ? '，已续传' : ''}）…`;
        st.updatedAt = nowIso();
        writeStatusAtomic(st);

        try { fs.mkdirSync(st.file, { recursive: true }); } catch { /* ignore */ }
        const out = fs.createWriteStream(part, { flags: resumeBase > 0 ? 'a' : 'w' });
        let lastBytes = st.receivedBytes;
        let lastTick = Date.now();
        let ema = st.speedBps || 0;
        let stall = setTimeout(() => req.destroy(new Error('STALL')), STALL_TIMEOUT_MS);
        const timer = setInterval(() => {
          const t = Date.now();
          const inst = ((st.receivedBytes - lastBytes) * 1000) / Math.max(t - lastTick, 1);
          lastBytes = st.receivedBytes;
          lastTick = t;
          if (inst > 0) ema = ema ? ema * 0.6 + inst * 0.4 : inst;
          else if (ema > 0) ema *= 0.85;
          st.speedBps = ema;
          if (st.totalBytes != null) {
            st.percent = Math.min(100, (st.receivedBytes / st.totalBytes) * 100);
            st.etaSeconds = Math.max(0, (st.totalBytes - st.receivedBytes) / Math.max(ema, 1));
          } else { st.percent = null; st.etaSeconds = null; }
          st.updatedAt = nowIso();
          if (st.cancelRequested || checkCancelFlag(st.id)) { st.cancelRequested = true; req.destroy(new Error('CANCELLED')); return; }
          writeStatusAtomic(st);
          printBar();
        }, TICK_MS);
        cleanupTimers = () => { clearInterval(timer); clearTimeout(stall); };

        res.on('data', (chunk) => {
          st.receivedBytes += chunk.length;
          clearTimeout(stall);
          stall = setTimeout(() => req.destroy(new Error('STALL')), STALL_TIMEOUT_MS);
          if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()); }
        });
        res.on('error', (err) => { cleanupTimers(); out.end(); reject(err); });
        out.on('error', (err) => { cleanupTimers(); req.destroy(); reject(err); });
        res.on('end', () => {
          cleanupTimers();
          out.end(() => {
            if (st.cancelRequested) return reject(new Error('CANCELLED'));
            if (st.totalBytes != null && st.receivedBytes < st.totalBytes) {
              return reject(new Error(`连接提前结束（已收 ${fmtBytes(st.receivedBytes)}/${fmtBytes(st.totalBytes)}）`));
            }
            try { finalize(); resolve(); } catch (err) { reject(err); }
          });
        });
      });
      req.on('timeout', () => req.destroy(new Error('连接超时')));
      req.on('error', (err) => { cleanupTimers(); reject(err); });
    });
  }

  process.on('SIGINT', () => {
    st.cancelRequested = true;
    st.updatedAt = nowIso();
    try { writeStatusAtomic(st); } catch { /* ignore */ }
    setTimeout(() => process.exit(130), 300).unref();
  });
  // worker 不允许静默崩溃：任何未捕获异常都落盘为 failed，状态才能正确结束/续传
  const crash = (kind, err) => {
    const detail = String((err && err.message) || err);
    try {
      Object.assign(st, {
        status: 'failed', phase: 'failed', error: `${kind}: ${detail}`,
        message: `内部错误（${kind}）：${detail}`,
        speedBps: 0, etaSeconds: null, finishedAt: nowIso(), updatedAt: nowIso(),
      });
      writeStatusAtomic(st);
    } catch { /* ignore */ }
    console.error(`${kind}: ${String((err && err.stack) || err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', (err) => crash('uncaughtException', err));
  process.on('unhandledRejection', (err) => crash('unhandledRejection', err));

  const retryDelay = (attempt) => Math.min(1000 * 2 ** (attempt - 1), 5000);

  while (true) {
    if (!st.cancelRequested && checkCancelFlag(st.id)) st.cancelRequested = true;
    st.attempt += 1;
    try {
      await attemptOnce();
      break;
    } catch (err) {
      const msg = String((err && err.message) || err);
      const httpCode = /^HTTP (\d{3}) /.exec(msg);
      const definiteFail = (httpCode && httpCode[1] !== '408' && httpCode[1] !== '429' && httpCode[1][0] === '4')
        || /续传位置不匹配|重定向次数过多|无效的|EACCES|EPERM|ENOENT|EXDEV|ENOSPC/.test(msg)
        || (/ENOTFOUND|EAI_AGAIN/.test(msg) && st.receivedBytes === 0 && st.attempt >= 2);
      if (st.cancelRequested || msg === 'CANCELLED') {
        Object.assign(st, {
          status: 'canceled', phase: 'canceled', error: null, speedBps: 0, etaSeconds: null,
          message: '已取消（保留 .part，可 dl resume 续传）',
          finishedAt: nowIso(), updatedAt: nowIso(),
        });
        writeStatusAtomic(st);
        if (lastBar && process.stderr.isTTY) process.stderr.write('\r\x1b[K');
        console.log(renderJob(st));
        process.exitCode = 130;
        return;
      }
      if (definiteFail || st.attempt >= st.maxAttempts) {
        Object.assign(st, {
          status: 'failed', phase: 'failed', error: msg, speedBps: 0, etaSeconds: null,
          message: `失败：${msg}（已尝试 ${st.attempt} 次，保留 .part，可 dl resume 续传）`,
          finishedAt: nowIso(), updatedAt: nowIso(),
        });
        writeStatusAtomic(st);
        if (lastBar && process.stderr.isTTY) process.stderr.write('\r\x1b[K');
        console.log(renderJob(st));
        process.exitCode = 1;
        return;
      }
      Object.assign(st, {
        phase: 'reconnecting', speedBps: 0, etaSeconds: null,
        message: `网络中断，${Math.round(retryDelay(st.attempt) / 1000)}s 后自动续传（第 ${st.attempt + 1} 次尝试）… 原因：${msg}`,
        updatedAt: nowIso(),
      });
      writeStatusAtomic(st);
      printBar();
      await sleep(retryDelay(st.attempt));
    }
  }
  if (lastBar && process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  console.log(renderJob(st));
  process.exitCode = 0;
}

// ---------- start：预探测文件信息后后台启动 ----------
async function cmdStart(opts) {
  const url = opts._[0];
  if (!url) { console.error('用法: dl start <URL> [-o 保存路径] [--dir 目录]'); process.exitCode = 1; return; }
  validateUrl(url);

  const id = opts.job || makeId();
  let dir = opts.dir ? path.resolve(String(opts.dir)) : null;
  let name = null;
  const outv = opts.out || opts.o;
  if (outv) { const p = path.resolve(String(outv)); dir = path.dirname(p); name = path.basename(p); }
  dir = dir || process.cwd();

  const st = {
    id, url, createdAt: nowIso(), startedAt: nowIso(), updatedAt: nowIso(),
    status: 'queued', phase: 'probe', message: '正在探测文件大小与预计耗时…',
    pid: process.pid, file: dir, filename: name || `download-${id}.bin`, explicitName: !!name,
    totalBytes: null, receivedBytes: 0, percent: null, speedBps: 0, etaSeconds: null,
    estimatedSeconds: null,
    attempt: 0, maxAttempts: MAX_ATTEMPTS, redirects: 0, finalUrl: null, server: null,
    acceptRanges: false, etag: null, contentType: null, resumed: false,
    avgSpeedBps: null, elapsedSeconds: null, finishedAt: null, error: null, cancelRequested: false,
  };
  writeStatusAtomic(st);

  const probe = await probePreflight(url);
  if (probe.totalBytes != null) st.totalBytes = probe.totalBytes;
  if (probe.acceptRanges) st.acceptRanges = true;
  if (probe.filename && !st.explicitName) st.filename = probe.filename;
  if (probe.finalUrl) st.finalUrl = probe.finalUrl;
  const histSpeed = readSpeedHistory()[hostOf(probe.finalUrl || url)] || null;
  if (st.totalBytes != null && histSpeed > 0) {
    st.estimatedSeconds = Math.max(1, Math.round(st.totalBytes / histSpeed));
    st.message = `已就绪：${fmtBytes(st.totalBytes)}，按历史速度预计约 ${fmtEta(st.estimatedSeconds)}`;
  } else if (st.totalBytes != null) {
    st.message = `已就绪：${fmtBytes(st.totalBytes)}，开始下载后测速给出预计剩余时间`;
  } else {
    st.message = '已就绪（服务器未提供文件大小），开始下载后自动测速';
  }
  st.updatedAt = nowIso();
  writeStatusAtomic(st);

  const args = [SCRIPT_PATH, 'run', url, '--job', id, '--home', HOME];
  if (outv) args.push('-o', String(outv));
  if (opts.dir) args.push('--dir', String(opts.dir));
  try {
    // 目标目录不存在就建出来：否则 worker 的 cwd 无效，启动即失败
    fs.mkdirSync(dir, { recursive: true });
    st.pid = launchWorker(args, dir);
  } catch (err) {
    Object.assign(st, {
      status: 'failed', phase: 'failed', speedBps: 0, etaSeconds: null,
      message: `启动失败：${err?.message || err}`, error: String(err?.message || err),
      finishedAt: nowIso(), updatedAt: nowIso(),
    });
    writeStatusAtomic(st);
    console.error(`启动下载失败 [${id}]：${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  writeStatusAtomic(st);

  console.log(`已启动后台下载 [${id}]`);
  console.log(renderJob(st));
  console.log(`\n接下来：`);
  console.log(`  node "${SCRIPT_PATH}" status            # 查看所有任务进度`);
  console.log(`  node "${SCRIPT_PATH}" wait ${id}        # 等待完成（周期输出进度）`);
  console.log(`  node "${SCRIPT_PATH}" cancel ${id}      # 取消`);
  console.log(`  node "${SCRIPT_PATH}" resume ${id}      # 中断后续传`);
}

// ---------- worker 启动：绕开 shell 的进程树回收 ----------
// 问题现场：Agent 通过一次性的命令执行器（DSH ops_bash / 终端会话）调用 `dl start`，
// 命令返回后执行器会回收该命令派生出的整棵进程树（Windows 作业对象 / POSIX 进程组），
// 于是「detached spawn」出来的 worker 也会在几秒内被杀掉 → status.json 停止刷新，
// 界面就永远停在 3% 那里（用户看到的「进度冻结 / 进程已中断」）。
// 解决办法：Windows 下改用 WMI（Win32_Process.Create）由 WmiPrvSE 代启 worker，
// 它的父进程不是那个 shell，作业对象管不到它；POSIX 下用 setsid（detached spawn 本身即是）。
function psLiteral(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

function launchViaWmi(args, cwd) {
  if (process.platform !== 'win32') return 0;
  try {
    const q = (s) => '"' + String(s) + '"';
    const commandLine = [process.execPath, ...args].map(q).join(' ');
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '$ProgressPreference = "SilentlyContinue"',
      '$arg = @{ CommandLine = ' + psLiteral(commandLine)
        + (cwd ? '; CurrentDirectory = ' + psLiteral(cwd) : '') + ' }',
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arg',
      'if ([int]$r.ReturnValue -ne 0) { Write-Output ("FAIL " + $r.ReturnValue); exit 1 }',
      'Write-Output ("PID " + $r.ProcessId)',
    ].join('; ');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const m = /PID\s+(\d+)/.exec(String(out || ''));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function launchWorker(args, cwd) {
  const viaWmi = launchViaWmi(args, cwd);
  if (viaWmi) return viaWmi;
  // 退路：普通 detached spawn（在 POSIX 上就是 setsid，能活下来）
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: cwd || undefined });
  child.unref();
  if (!child.pid) throw new Error('后台进程启动失败（目标目录不可用或 Node 不可执行）');
  return child.pid;
}

// ---------- status / wait / cancel / resume / clean ----------
function cmdStatus(opts) {
  let jobs;
  if (opts._.length) {
    jobs = [];
    const missing = [];
    for (const id of opts._) {
      const st = readStatus(id);
      if (st) jobs.push(st); else missing.push(id);
    }
    if (missing.length) console.error(`未找到任务: ${missing.join(', ')}`);
  } else {
    jobs = listJobs();
  }
  if (!jobs.length) {
    // --json 必须永远输出合法 JSON（脚本/测试会直接 parse）
    if (opts.json) { console.log('[]'); return; }
    console.log('当前没有下载任务。用 start <url> 或 run <url> 开始。');
    return;
  }
  for (const st of jobs) {
    if ((st.status === 'running' || st.status === 'queued') && isStale(st)) {
      st.stale = true;
      st.message = `${st.message || st.phase} ⚠ 进程可能已中断，可用 resume 恢复`;
    }
  }
  if (opts.json) { console.log(JSON.stringify(jobs, null, 2)); return; }
  for (const st of jobs) { console.log(renderJob(st)); console.log(''); }
}

async function cmdWait(opts) {
  const id = opts._[0];
  if (!id) { console.error('用法: dl wait <任务ID> [--interval 秒] [--timeout 秒]'); process.exitCode = 1; return; }
  const interval = Math.max(0.5, parseFloat(opts.interval || '2')) * 1000;
  const deadline = opts.timeout ? Date.now() + parseFloat(opts.timeout) * 1000 : null;
  let st = readStatus(id);
  if (!st) { console.error(`未找到任务: ${id}`); process.exitCode = 1; return; }

  let lastPct = null;
  let lastState = '';
  let lastBytes = -1;
  while (true) {
    st = readStatus(id);
    if (!st) { console.error('任务状态文件丢失'); process.exitCode = 1; return; }
    if ((st.status === 'running' || st.status === 'queued') && isStale(st)) {
      st.message = `${st.message || st.phase} ⚠ 进程可能已中断（可 resume）`;
    }
    const changed = st.status !== lastState
      || (st.percent != null && (lastPct == null || Math.abs(st.percent - lastPct) >= 0.5))
      || (st.percent == null && st.receivedBytes - lastBytes > 1024 * 1024);
    if (changed) {
      console.log(compactLine(st));
      lastPct = st.percent;
      lastState = st.status;
      lastBytes = st.receivedBytes;
    }
    if (st.status === 'done') { process.exitCode = 0; return; }
    if (st.status === 'failed' || st.status === 'canceled') { process.exitCode = 1; return; }
    if (deadline && Date.now() > deadline) {
      console.log('⏱ 等待超时，任务仍在后台继续，可用 status 查询。');
      process.exitCode = 124;
      return;
    }
    await sleep(interval);
  }
}

function cmdCancel(opts) {
  const id = opts._[0];
  const st = readStatus(id);
  if (!st) { console.error(`未找到任务: ${id}`); process.exitCode = 1; return; }
  if (st.status !== 'running' && st.status !== 'queued') {
    console.log(`任务 [${id}] 已是终态（${st.status}），无需取消。`);
    process.exitCode = 1;
    return;
  }
  st.cancelRequested = true;
  st.updatedAt = nowIso();
  try { fs.writeFileSync(cancelFlagPath(id), nowIso()); } catch { /* ignore */ }
  if (isStale(st)) {
    Object.assign(st, { status: 'canceled', phase: 'canceled', message: '已取消（进程已不在）', finishedAt: nowIso() });
  } else {
    st.message = '正在取消…';
  }
  writeStatusAtomic(st);
  console.log(`已发送取消请求 [${id}]，用 status 确认。`);
}

function cmdResume(opts) {
  const id = opts._[0];
  const st = readStatus(id);
  if (!st) { console.error(`未找到任务: ${id}`); process.exitCode = 1; return; }
  if (st.status === 'running' && !isStale(st)) { console.log('任务仍在运行，无需 resume。'); process.exitCode = 1; return; }
  if (st.status === 'done') { console.log('任务已完成，无需 resume。'); process.exitCode = 1; return; }
  st.resumed = true;
  st.updatedAt = nowIso();
  writeStatusAtomic(st);
  const args = [SCRIPT_PATH, 'run', st.finalUrl || st.url, '--job', id, '--home', HOME];
  const cwd = st.file ? (isDirectory(st.file) ? st.file : path.dirname(st.file)) : undefined;
  try {
    if (cwd) fs.mkdirSync(cwd, { recursive: true });
    st.pid = launchWorker(args, cwd);
    writeStatusAtomic(st);
  } catch (err) {
    Object.assign(st, { status: 'failed', phase: 'failed', message: `续传启动失败：${err?.message || err}`, updatedAt: nowIso() });
    writeStatusAtomic(st);
    console.error(`续传启动失败 [${id}]：${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  console.log(`已恢复下载 [${id}]（本地已有 ${fmtBytes(st.receivedBytes)}，服务器支持断点续传时从断点继续）`);
}

function cmdClean(opts) {
  const doneStates = ['done', 'failed', 'canceled'];
  let n = 0;
  for (const st of listJobs()) {
    const finished = doneStates.includes(st.status);
    if (!finished && !opts.force) { console.log(`跳过进行中的 ${st.id}（--force 可连同进行中任务一起删除）`); continue; }
    try { fs.rmSync(jobDir(st.id), { recursive: true, force: true }); n += 1; } catch { /* ignore */ }
  }
  console.log(`已清理 ${n} 个任务记录（已下载的文件不受影响）。`);
}

// ---------- 入口 ----------
const HELP = `dl — Agent 下载管理器（进度 / 速度 / ETA / 阶段 / 断点续传）

用法: node dl.mjs <命令> [参数]

  start <URL> [-o 路径] [--dir 目录]   后台启动下载，立即返回任务 ID（推荐）
  run <URL> [-o 路径] [--quiet]        前台下载，终端显示实时进度条
  status [任务ID...] [--json]          查看任务进度（默认全部）
  wait <任务ID> [--interval 秒] [--timeout 秒]
                                       阻塞等待完成，周期打印进度
                                       退出码: 0 成功 / 1 失败或取消 / 124 超时
  cancel <任务ID>                      取消任务（保留 .part）
  resume <任务ID>                      从断点续传
  clean [--force]                      清理已结束任务的记录

说明:
  - 任务状态存放在 ~/.agent-downloads/jobs/（环境变量 AGENT_DL_HOME 可改）
  - 未完成的数据文件为目标路径旁的 <任务ID>.part，完成后自动改名
  - 网络中断自动重连续传（最多 ${MAX_ATTEMPTS} 次）`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opts = parseArgs(args.slice(1), FLAG_VALUES);
  if (opts.help || !cmd || cmd === 'help') { console.log(HELP); return; }
  switch (cmd) {
    case 'start': await cmdStart(opts); break;
    case 'run': await cmdRun(opts); break;
    case 'status':
    case 'list': cmdStatus(opts); break;
    case 'wait': await cmdWait(opts); break;
    case 'cancel': cmdCancel(opts); break;
    case 'resume': cmdResume(opts); break;
    case 'clean': cmdClean(opts); break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
