#!/usr/bin/env node
// 开源前的一次性配置：把仓库里的占位符 YOUR_GH_USER 换成你的 GitHub 用户名，并添加 origin。
// 用法：node scripts/set-owner.mjs <github-username>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const OWNER = process.argv[2];
const REPO = "dsh-download-progress";
if (!OWNER || !/^[A-Za-z0-9-]+$/.test(OWNER)) {
  console.error("用法: node scripts/set-owner.mjs <github-username>");
  process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = "YOUR_GH_USER";
const targets = ["package.json", "README.md", "README.zh-CN.md"];

let touched = 0;
for (const rel of targets) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, "utf8");
  const after = before.split(PLACEHOLDER).join(OWNER);
  if (after !== before) {
    fs.writeFileSync(file, after);
    const n = before.split(PLACEHOLDER).length - 1;
    touched += n;
    console.log(`✔ ${rel}: 替换 ${n} 处`);
  } else {
    console.log(`- ${rel}: 无需修改`);
  }
}

const url = `https://github.com/${OWNER}/${REPO}.git`;
try {
  const remotes = execFileSync("git", ["remote"], { cwd: ROOT, encoding: "utf8" });
  if (!remotes.split("\n").includes("origin")) {
    execFileSync("git", ["remote", "add", "origin", url], { cwd: ROOT, stdio: "inherit" });
    console.log(`✔ 已添加 origin → ${url}`);
  } else {
    console.log(`- origin 已存在，如需修改：git remote set-url origin ${url}`);
  }
} catch (error) {
  console.warn(`! git remote 设置失败：${error?.message || error}`);
}

console.log(`\n共替换 ${touched} 处占位符。下一步：`);
console.log("  npm test && npm pack    # 验证并打包");
console.log("  git add -A && git commit -m \"feat: download progress plugin\"");
console.log("  git push -u origin main # 或用 gh repo create 建仓后推送");
