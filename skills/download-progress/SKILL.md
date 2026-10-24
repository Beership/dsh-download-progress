---
name: download-progress
description: Agent 专用智能下载器：实时进度百分比、速度、预计剩余时间(ETA)、当前阶段与断点续传。Use whenever downloading any file from the internet (软件、安装包、模型、数据集、skill/插件包、大文件) instead of raw curl/wget, so progress, speed, ETA and the current step stay visible, and interrupted downloads can be resumed.
---

# download-progress — 可视化下载工具

为 agent 下载网上的文件（安装包、二进制、模型、zip、skill 包等）时，用本工具代替裸 `curl`/`wget`，让用户能随时看到：**百分比、已下载/总大小、实时速度、预计剩余时间（ETA）、当前进行到哪一步（阶段）**。

**工具脚本**：`scripts/dl.mjs`（本技能目录下，Node ≥ 16，零依赖；下文用 `$DL` 代表它的绝对路径）。在 DeepSeek Harness 桌面端即 `$DSH_HOME/skills/download-progress/scripts/dl.mjs`（默认 `C:\Users\<用户名>\.dsh\skills\download-progress\scripts\dl.mjs`）。

## 何时使用

- 需要从互联网下载任何文件，且文件较大（>1MB）或用户可能关心进度时——一律用本工具。
- 用户问"下载到哪了 / 还要多久 / 卡住了吗"时，运行 `status` 命令并如实汇报。
- 极小的 API 响应、仓库内文件复制不需要本工具。

## 命令速查

```bash
# 1) 后台启动（推荐）：先探测文件大小并估算耗时，立即返回任务 ID
node "$DL" start <URL> -o <保存路径>
node "$DL" start <URL> --dir <保存目录>        # 不指定文件名时自动从 URL/响应头推断

# 2) 查看所有任务进度（也可 status --json 拿机器可读输出）
node "$DL" status

# 3) 等待某任务完成（阻塞；注意：阻塞期间的输出用户看不到，给用户看实时进度请改用轮询 status + 播报）
node "$DL" wait <任务ID>
node "$DL" wait <任务ID> --timeout 60          # 最多等 60s，超时任务仍在后台继续

# 4) 前台直接下载（终端显示实时进度条，适合短下载或交互场景）
node "$DL" run <URL> -o <保存路径>

# 5) 取消 / 断点续传 / 清理任务记录
node "$DL" cancel <任务ID>
node "$DL" resume <任务ID>
node "$DL" clean
```

## 推荐 Agent 工作流

1. **启动**：用 `start` 后台启动。`start` 会**先预探测**（HEAD/Range 请求）拿到文件大小，并按该站点的历史速度给出**预计总耗时**；把启动输出里的任务 ID、文件大小、预计耗时、保存路径立刻告诉用户。首次从某站点下载没有历史速度时，预计剩余时间会在下载开始 1~2 秒后由实测速度给出（轮询 status 可见）。
2. **实时播报（默认模式，让用户看到"实时进度"的关键）**：agent 界面通常只在命令结束后才显示终端输出，`wait` 阻塞期间的进度行用户是看不到的。所以下载进行中**不要用 `wait` 干等**，改为启动后 1~2 秒做第一次 `dl status` 播报，之后每隔 3~5 秒一次（短命令，秒回），每次结果一回来就立刻向用户播报一行进度，例如：
   `⬇️ node.msi 42.4% · 46.5/110 MB · 14.4 MB/s · 剩余 4 秒 · 正在下载`
   直到任务结束。预计耗时超过 2 分钟的下载，播报间隔可放宽到 15~30 秒。
   在装了本插件集成补丁的 **DeepSeek Harness 桌面端**，聊天窗口右上角会自动显示实时进度条（含百分比、速度、预计剩余时间），无需额外操作；聊天里仍按上述节奏做关键节点播报。
3. **收尾**：终态确认后向用户报告：保存路径、文件大小、总耗时、平均速度；失败/取消时附上 `message`/`error` 里的原因。
4. **失败不要从头重来**：失败/中断后先 `resume <任务ID>`（服务器支持 Range 时自动从断点续传），只有 `resume` 也彻底失败才考虑换源重新下载。换参数重下同一文件前，先 `cancel` 旧任务，避免同一文件出现两张并行进度卡。
5. **并行场景**：下载期间你需要做其他工作时，做完一段就用 `status` 查看并播报一次；不要启动后不闻不问。用户问"到哪了/还要多久"时，运行 `status` 并如实转述。

`wait` 的适用场景：仅当你需要阻塞拿到确定结果再继续后续步骤（如下载后立刻安装）时使用；配合 `--timeout` 分段等待，防止长时间无输出。

## 阶段（phase）含义

`probe`（预探测大小与预计耗时）→ `queued` → `connecting` → `downloading` → `finalizing` → `done`；异常分支：`reconnecting`（断流后自动重连续传，与 downloading 循环）、`failed`、`canceled`。字段 `percent/speedBps/etaSeconds/estimatedSeconds/receivedBytes/totalBytes` 是数值，适合程序读取；`message` 是中文人话。

## 注意事项

- **系统代理**（Clash/V2Ray 等）：dl.mjs 自动读取 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 环境变量（`NO_PROXY` 可设例外，本地地址永不走代理）。直连不稳的环境（GitHub 等）请确保代理环境变量已设置；重试探续传同样走代理。若预探测拿不到文件大小而系统正开着代理，多半是环境变量没传进来。
- 任务记录在 `~/.agent-downloads/jobs/`（环境变量 `AGENT_DL_HOME` 可改），多任务并行安全（每任务独立进程+状态文件）。
- 未完成任务的数据文件是目标路径旁的 `<任务ID>.part`，完成后自动改名为最终文件；同名文件自动加 " (1)" 后缀，不会覆盖。
- 服务器不支持断点续传（Accept-Ranges）时，重试会从头开始；服务器未返回 Content-Length 时没有百分比，但仍显示速度和已下载量。
- 网络断流 20 秒判定为断线，自动重连续传，最多 8 次，重试间隔 1s→5s 递增。
- 建议传 `-o` 指定保存路径；不指定时保存到当前工作目录，文件名自动从 URL 或 Content-Disposition 推断。
