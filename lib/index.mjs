// dsh-download-progress — 运行时侧 cordis 插件
// 职责：
//   1. 暴露本地 HTTP API：/api/dsh-download-progress/list 读取下载任务状态，
//      /api/dsh-download-progress/cancel 写入取消标记（供 Web 客户端右上角进度条使用）；
//   2. 僵尸任务自愈：下载进程已死但状态仍为 running 的任务，短暂灰显「已中断」，
//      超过 60s 自动落盘为 failed，避免卡片永远挂在屏幕上；
//   3. 把 agent 技能（skills/download-progress）安装到 $DSH_HOME/skills，让会话里的
//      agent 自动获得 dl.mjs 下载工具。
// 数据源与 dl.mjs 约定一致：~/.agent-downloads/jobs/<id>/status.json（AGENT_DL_HOME 可改）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const name = "dsh-download-progress";
export const inject = ["webServer"];

const API_BASE = "/api/dsh-download-progress";
const ACTIVE_STATUSES = new Set(["probe", "queued", "running", "connecting", "downloading", "reconnecting", "finalizing"]);
const STALE_MIN_MS = 6000;    // 超过该时长未更新且进程不在 → 界面灰显「已中断」
const STALE_HEAL_MS = 20000;  // 超过该时长 → 直接落盘 failed（自愈），卡片随后自动消失
// 终态任务仍返回给客户端，由客户端在若干秒后自动收起（也支持手动关闭）

function jobsRoot() {
	return path.join(process.env.AGENT_DL_HOME || path.join(os.homedir(), ".agent-downloads"), "jobs");
}

function procAlive(pid) {
	if (!pid) return false;
	try { process.kill(pid, 0); return true; } catch (err) {
		// Windows 下 EPERM 表示进程存在但无权限信号——视为存活，避免把正在下载的任务误判为已中断
		return !!(err && err.code === "EPERM");
	}
}

function writeStatusAtomic(st) {
	const p = path.join(jobsRoot(), st.id, "status.json");
	try {
		fs.mkdirSync(path.dirname(p), { recursive: true });
		const tmp = p + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
		fs.renameSync(tmp, p);
	} catch { /* ignore */ }
}

function isStaleRunning(s) {
	if (!ACTIVE_STATUSES.has(s.status)) return false;
	const age = Date.now() - Date.parse(s.updatedAt || s.startedAt || "");
	if (!(age >= STALE_MIN_MS)) return false;
	if (!procAlive(s.pid)) return true;
	return age > STALE_MIN_MS * 2;
}

function readJobs() {
	let names = [];
	try {
		names = fs.readdirSync(jobsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
	return names
		.map((dir) => {
			try {
				return JSON.parse(fs.readFileSync(path.join(jobsRoot(), dir, "status.json"), "utf8"));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
		.slice(0, 10)
		.map((s) => {
			const finished = s.status === "done" || s.status === "failed" || s.status === "canceled";
			if (finished) return s;
			if (isStaleRunning(s)) {
				const age = Date.now() - Date.parse(s.updatedAt || s.startedAt || "");
				if (age >= STALE_HEAL_MS) {
					// 自愈：进程已死且状态陈旧，落盘为 failed（保留现场供 dl resume 续传）
					const healed = {
						...s,
						status: "failed",
						phase: "interrupted",
						speedBps: 0,
						etaSeconds: null,
						message: "进程已中断，可用 dl resume 续传",
						finishedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					writeStatusAtomic(healed);
					return healed;
				}
				return { ...s, dlpStale: true, message: "已中断（进程不在），可 dl resume 续传" };
			}
			return s;
		})
		.filter(Boolean);
}

function sendJson(res, code, payload) {
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(payload));
}

function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) return reject(new Error("body too large"));
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 与 codex-ui 相同的宿主认证约定：connection.requestRejection 返回拒绝状态码或 undefined。 */
function rejectIfUntrusted(ctx, req, res) {
	try {
		const connection = ctx.get("connection");
		const rejection = typeof connection?.requestRejection === "function" ? connection.requestRejection(req) : undefined;
		if (rejection !== undefined) {
			sendJson(res, rejection, { error: rejection === 401 ? "请先登录 DSH。" : "已拒绝不可信或跨站请求。" });
			return true;
		}
	} catch {
		sendJson(res, 503, { error: "宿主认证服务暂不可用。" });
		return true;
	}
	return false;
}

export function apply(ctx, config = {}) {
	const log = (...args) => ctx.logger?.info?.(...args);
	const warn = (...args) => ctx.logger?.warn?.(...args);
	const webServer = typeof ctx.get === "function" ? ctx.get("webServer") : null;
	if (!webServer || typeof webServer.register !== "function") {
		warn("[download-progress] webServer 服务不可用，右上角进度条接口未注册。");
		return;
	}

	ctx.effect(() => {
		const disposeList = webServer.register({
			kind: "exact",
			path: `${API_BASE}/list`,
			handler: async (request, response) => {
				if (rejectIfUntrusted(ctx, request, response)) return;
				if (request.method !== "GET" && request.method !== "HEAD") {
					response.writeHead(405);
					response.end();
					return;
				}
				sendJson(response, 200, { jobs: readJobs() });
			}
		});

		const disposeCancel = webServer.register({
			kind: "exact",
			path: `${API_BASE}/cancel`,
			handler: async (request, response) => {
				if (rejectIfUntrusted(ctx, request, response)) return;
				if (request.method !== "POST") {
					response.writeHead(405);
					response.end();
					return;
				}
				let id = "";
				try {
					id = String(JSON.parse(await readBody(request)).id || "");
				} catch {
					id = "";
				}
				if (!/^[\w.-]+$/.test(id) || id.includes("..")) {
					sendJson(response, 400, { error: "无效任务 ID。" });
					return;
				}
				try {
					const flag = path.join(jobsRoot(), id, "cancel.flag");
					fs.mkdirSync(path.dirname(flag), { recursive: true });
					fs.writeFileSync(flag, new Date().toISOString());
					// 进程已死的任务永远不会处理取消标记：直接落盘 canceled，卡片立刻进入终态
					let st = null;
					try { st = JSON.parse(fs.readFileSync(path.join(jobsRoot(), id, "status.json"), "utf8")); } catch { /* ignore */ }
					if (st && ACTIVE_STATUSES.has(st.status) && !procAlive(st.pid)) {
						writeStatusAtomic({
							...st,
							status: "canceled",
							phase: "canceled",
							speedBps: 0,
							etaSeconds: null,
							message: "已取消（进程已不在）",
							finishedAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						});
					}
					sendJson(response, 200, { ok: true });
				} catch {
					sendJson(response, 500, { error: "写入取消标记失败。" });
				}
			}
		});

		log("[download-progress] 进度接口已注册: %s/list, %s/cancel", API_BASE, API_BASE);
		return () => {
			try { disposeList?.(); } catch { /* ignore */ }
			try { disposeCancel?.(); } catch { /* ignore */ }
		};
	});

	installSkill(ctx, config);
}

/** 把 skills/download-progress 复制到 $DSH_HOME/skills（幂等：版本未变且文件齐全时不重写）。 */
function installSkill(ctx, config = {}) {
	try {
		if (config.poll === false) return;
		const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
		const skillsDir = path.join(home, "skills");
		if (!fs.existsSync(skillsDir)) return; // 不是常规 DSH home 布局，跳过（不凭空创建）
		const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
		const source = path.join(pluginRoot, "skills", "download-progress");
		if (!fs.existsSync(path.join(source, "SKILL.md"))) return;
		let version = "";
		try { version = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version || ""; } catch { /* ignore */ }
		const target = path.join(skillsDir, "download-progress");
		const marker = path.join(target, ".installed-version");
		let installed = "";
		try { installed = fs.readFileSync(marker, "utf8").trim(); } catch { /* ignore */ }
		// 幂等短路：版本一致且技能文件在，就不动用户目录（避免每次启动覆盖用户对技能的本地修改）
		if (version && installed === version && fs.existsSync(path.join(target, "SKILL.md"))) {
			ctx.logger?.debug?.("[download-progress] agent 技能已是最新: %s", version);
			return;
		}
		fs.rmSync(target, { recursive: true, force: true });
		fs.cpSync(source, target, { recursive: true });
		if (version) fs.writeFileSync(marker, version + "\n");
		ctx.logger?.info?.("[download-progress] agent 技能已更新: %s", target);
	} catch (error) {
		ctx.logger?.warn?.("[download-progress] 技能安装失败: %s", error?.message || error);
	}
}
