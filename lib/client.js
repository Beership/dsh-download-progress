// dsh-download-progress — Web 客户端插件（聊天窗口右上角实时下载进度条）
// 由 DSH 运行时按 ./client 导出注入 Web 客户端（window.__ModuleLoader__ 约定，
// 与 @michengai/dsh-codex-ui 相同）。纯 DOM 渲染，无外部依赖。
// 位置避开系统标题栏（top:48px）；配色跟随系统/应用亮暗主题。
window.__ModuleLoader__.load({
	id: "dsh-download-progress",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		var API_LIST = "/api/dsh-download-progress/list";
		var API_CANCEL = "/api/dsh-download-progress/cancel";
		var BOX_ID = "dlp-progress-box";
		var POLL_MS = 450;           // 有活动任务时的刷新节奏（本地接口，开销极小）
		var IDLE_POLL_MS = 1500;     // 无活动任务时的降频节奏
		var STALE_MS = 6000;         // 状态文件超过该时长没更新 → 客户端自行判定「已中断」
		var HIDE_DONE_MS = 4000;     // 完成卡片自动收起
		var HIDE_FAIL_MS = 12000;    // 失败/取消卡片自动收起（鼠标悬停时暂停）
		var TOP_OFFSET = 48; // 避开窗口标题栏（最小化/最大化/关闭按钮）
		var ACTIVE = { probe: 1, queued: 1, running: 1, connecting: 1, downloading: 1, reconnecting: 1, finalizing: 1 };
		var dismissed = new Set();   // 用户手动关闭（或自动收起）的任务
		var firstLoadDone = false;   // 首屏时把历史上早已结束的任务直接视为已关闭
		var terminalSince = {};      // 任务进入终态的时间戳（自动收起计时）
		var hovering = false;

		function fmtBytes(n) {
			if (n == null || isNaN(n)) return "?";
			var u = ["B", "KB", "MB", "GB", "TB"];
			var i = 0, v = n;
			while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
			return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + " " + u[i];
		}
		function fmtTime(s) {
			if (s == null || !isFinite(s) || s < 0) return "--:--";
			s = Math.round(s);
			var p = function (x) { return String(x).padStart(2, "0"); };
			var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
			return h > 0 ? h + ":" + p(m) + ":" + p(x) : p(m) + ":" + p(x);
		}

		function isDark() {
			try {
				var root = document.documentElement;
				if (root.classList.contains("dark")) return true;
				var t = root.getAttribute("data-theme") || (document.body && document.body.getAttribute("data-theme"));
				if (t === "dark") return true;
				if (t === "light") return false;
				return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
			} catch (e) { return false; }
		}

		function palette() {
			return isDark() ? {
				card: "background:rgba(28,30,36,.94);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:10px 12px;color:#e8eaed;box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:12px;line-height:1.5;",
				sub: "#bdc1c6", faint: "#9aa0a6", track: "background:rgba(255,255,255,.10);",
				accent: "linear-gradient(90deg,#5b8def,#7aa8ff)", border: "rgba(255,255,255,.09)"
			} : {
				card: "background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:10px 12px;color:#1f2328;box-shadow:0 6px 20px rgba(0,0,0,.12);font-size:12px;line-height:1.5;",
				sub: "#5f6368", faint: "#9aa0a6", track: "background:rgba(0,0,0,.08);",
				accent: "linear-gradient(90deg,#1a73e8,#4a8df0)", border: "rgba(0,0,0,.08)"
			};
		}

		function mk(tag, css, text) {
			var el = document.createElement(tag);
			if (css) el.style.cssText = css;
			if (text != null) el.textContent = text;
			return el;
		}

		var box = null;
		var lastSig = "";
		var timers = [];

		function ensureBox() {
			if (box && document.body && document.body.contains(box)) return box;
			box = mk("div", "position:fixed;top:" + TOP_OFFSET + "px;right:12px;z-index:2147483646;display:none;flex-direction:column;gap:8px;pointer-events:none;max-height:calc(100vh - " + (TOP_OFFSET + 40) + "px);overflow-y:auto;scrollbar-width:none;font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;");
			box.id = BOX_ID;
			// 鼠标停在卡片上时不自动收起，方便看错误详情
			box.addEventListener("mouseenter", function () { hovering = true; });
			box.addEventListener("mouseleave", function () { hovering = false; lastSig = ""; });
			(document.body || document.documentElement).appendChild(box);
			return box;
		}

		function renderCard(j, pal) {
			var total = j.totalBytes, recv = j.receivedBytes || 0;
			var pct = total != null && total > 0 ? Math.max(0, Math.min(100, (recv / total) * 100)) : null;
			var done = j.status === "done";
			var failed = j.status === "failed" || j.status === "canceled";
			// 双保险：宿主侧的 dlpStale，或客户端按 updatedAt 自行判定（worker 被杀/断流时立刻灰显）
			var stale = !!j.dlpStale || (!!ACTIVE[j.status] && j.updatedAt && (Date.now() - Date.parse(j.updatedAt) > STALE_MS));
			var active = !done && !failed && !stale;
			var color = done ? "#31c48d" : failed ? "#f05252" : stale ? pal.faint : "#1a73e8";
			var statusText = done ? "完成" : (j.status === "canceled" ? "已取消" : j.status === "failed" ? "失败" : stale ? "已中断" : (pct != null ? pct.toFixed(1) + "%" : "…"));
			var etaText = stale ? "" : (active
				? (j.etaSeconds != null ? "剩余 " + fmtTime(j.etaSeconds)
					: (j.estimatedSeconds != null ? "预计 " + fmtTime(j.estimatedSeconds)
						: (total != null ? "测速中…" : "")))
				: (done ? "用时 " + fmtTime(j.elapsedSeconds) : ""));
			// 断流重连时不要显示「测速中…」，直接说明正在重连
			if (active && j.status === "reconnecting" && j.etaSeconds == null) etaText = "重连中…";

			var card = mk("div", "pointer-events:auto;min-width:280px;max-width:380px;" + pal.card);

			var row1 = mk("div", "display:flex;align-items:center;gap:6px;");
			row1.appendChild(mk("span", "width:8px;height:8px;border-radius:50%;flex:none;background:" + color + (active ? ";box-shadow:0 0 6px " + color : ""), null));
			var name = mk("span", "flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;", j.filename || j.id);
			name.title = j.filename || j.id;
			row1.appendChild(name);
			row1.appendChild(mk("span", "flex:none;color:" + color + ";font-variant-numeric:tabular-nums;", statusText));
			var cancel = mk("span", "flex:none;cursor:pointer;color:" + pal.faint + ";padding:0 3px;border-radius:4px;", "✕");
			cancel.title = active ? "取消下载" : "关闭";
			cancel.setAttribute("role", "button");
			cancel.setAttribute("tabindex", "0");
			cancel.setAttribute("aria-label", active ? "取消下载" : "关闭进度卡片");
			var closeIt = function () {
				dismissed.add(String(j.id));
				lastSig = "";
				if (active) {
					fetch(API_CANCEL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ id: String(j.id) })
					}).catch(function () { /* ignore */ });
				}
			};
			cancel.addEventListener("click", closeIt);
			cancel.addEventListener("keydown", function (e) {
				if (e.key === "Enter" || e.key === " ") { e.preventDefault(); closeIt(); }
			});
			row1.appendChild(cancel);
			card.appendChild(row1);

			var track = mk("div", "margin-top:6px;height:6px;border-radius:3px;" + pal.track + "overflow:hidden;", null);
			var fill = mk("div", "height:100%;border-radius:3px;transition:width .3s;", null);
			if (failed) fill.style.cssText += "width:100%;background:#f05252;";
			else if (done) fill.style.cssText += "width:100%;background:#31c48d;";
			else if (stale) fill.style.cssText += "width:" + (pct != null ? pct + "%" : "100%") + ";background:" + pal.faint + ";opacity:.5;";
			else if (pct != null) fill.style.cssText += "width:" + pct + "%;background:" + pal.accent + ";";
			else fill.style.cssText += "width:100%;background:" + pal.accent + ";opacity:.45;";
			track.appendChild(fill);
			card.appendChild(track);

			var row2 = mk("div", "margin-top:5px;display:flex;justify-content:space-between;gap:8px;color:" + pal.sub + ";font-variant-numeric:tabular-nums;white-space:nowrap;");
			row2.appendChild(mk("span", null, fmtBytes(recv) + (total != null ? " / " + fmtBytes(total) : "")));
			if (active && j.speedBps > 0) row2.appendChild(mk("span", null, fmtBytes(j.speedBps) + "/s"));
			if (done && j.avgSpeedBps > 0) row2.appendChild(mk("span", null, "均速 " + fmtBytes(j.avgSpeedBps) + "/s"));
			if (etaText) row2.appendChild(mk("span", null, etaText));
			card.appendChild(row2);

			if (j.message) {
				var msg = mk("div", "margin-top:3px;color:" + pal.faint + ";overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", j.message);
				msg.title = j.message;
				card.appendChild(msg);
			}
			return card;
		}

		function render(jobs) {
			if (!document.body) return;
			var pal = palette();
			var all = (jobs || []);
			if (!firstLoadDone && all.length) {
				// 首屏：历史上早已结束的任务不弹卡片，只跟踪本次会话的下载
				all.forEach(function (j) { if (!ACTIVE[j.status]) dismissed.add(String(j.id)); });
				firstLoadDone = true;
			}
			var now = Date.now();
			var list = [];
			for (var i = 0; i < all.length && list.length < 8; i += 1) {
				var j = all[i];
				var key = String(j.id);
				if (dismissed.has(key)) continue;
				if (!ACTIVE[j.status]) {
					// 终态卡片自动收起：完成 4s、失败/取消 12s；鼠标停在卡片上时暂停计时
					if (terminalSince[key] == null) terminalSince[key] = now;
					var hideMs = j.status === "done" ? HIDE_DONE_MS : HIDE_FAIL_MS;
					if (!hovering && (now - terminalSince[key]) >= hideMs) {
						dismissed.add(key);
						// 长会话下避免 dismissed/terminalSince 无限增长（只保留最近 200 条）
						if (dismissed.size > 200) {
							var drop = dismissed.values().next().value;
							dismissed.delete(drop);
							delete terminalSince[drop];
						}
						continue;
					}
				} else {
					terminalSince[key] = null;
				}
				list.push(j);
			}
			var sig = JSON.stringify([isDark(), list.map(function (j) {
				return [j.id, j.status, j.dlpStale || false, j.updatedAt || "", j.receivedBytes, j.speedBps, j.etaSeconds, j.message, j.finishedAt];
			})]);
			if (sig === lastSig && box && document.body.contains(box)) return;
			lastSig = sig;
			var b = ensureBox();
			b.innerHTML = "";
			if (!list.length) { b.style.display = "none"; return; }
			b.style.display = "flex";
			list.forEach(function (j) { b.appendChild(renderCard(j, pal)); });
		}

		function poll() {
			if (document.hidden) return; // 后台标签页不请求，切回来立刻补一次
			fetch(API_LIST, { cache: "no-store" })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (data) { if (data) render(data.jobs); })
				.catch(function () { /* 运行时未就绪等情况忽略 */ });
		}

		var tickTimer = null;

		exports.apply = function apply(ctx) {
			var start = function () {
				ensureBox();
				// 自适应节奏：有卡片可见时 450ms，空屏/后台时 1.5s，兼顾实时与开销
				var tick = function () {
					poll();
					var visible = !!box && box.style.display !== "none" && !document.hidden;
					tickTimer = setTimeout(tick, visible ? POLL_MS : IDLE_POLL_MS);
				};
				tick();
				if (window.matchMedia) {
					try {
						var mq = matchMedia("(prefers-color-scheme: dark)");
						var onChange = function () { lastSig = ""; };
						if (mq.addEventListener) mq.addEventListener("change", onChange);
						else if (mq.addListener) mq.addListener(onChange);
					} catch (e) { /* ignore */ }
				}
			};
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(function () {
					start();
					return function () {
						if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
						timers.forEach(function (t) { clearInterval(t); });
						timers = [];
						if (box && box.parentNode) box.parentNode.removeChild(box);
						box = null;
						lastSig = "";
					};
				});
			} else {
				start();
			}
		};
		exports.inject = [];

		return module.exports;
	}
});
