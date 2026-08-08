#!/usr/bin/env node
/**
 * update-asset-versions.js
 *
 * 这个项目是零构建部署（public/ 直接被 Cloudflare Pages 部署，见
 * README），所以没有 webpack/vite 那种打包工具帮你自动给文件名加哈希。
 * 这个脚本就是用来补上那一步的：
 *
 *   1. 扫描 public/assets/*.js 和 public/assets/*.css
 *   2. 对每个文件的内容算一个短哈希（sha1 前 8 位）
 *   3. 扫描 public/*.html，把里面所有 /assets/xxx.js 或 /assets/xxx.css
 *      的引用，统一替换/追加成 /assets/xxx.js?v=<该文件当前内容的哈希>
 *
 * 效果：文件内容没变 → 哈希不变 → URL 不变 → 命中 public/_headers 里
 * 给 /assets/* 配置的一年强缓存。文件内容一变 → 哈希跟着变 → HTML 里
 * 引用的 URL 也变了 → 浏览器认为是全新资源，立刻重新下载，不会出现
 * "改了 JS 但用户看到旧版本" 的问题。
 *
 * 用法：每次改完 public/assets/ 下的任何 .js / .css 文件，提交代码前
 * 在项目根目录跑一次：
 *
 *   node update-asset-versions.js
 *
 * 然后把脚本改动过的 public/*.html 一起 commit + push。
 * 不依赖任何第三方包，纯 Node 内置模块，Node 14+ 即可运行。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8);
}

// 收集 public/assets/ 下所有 .js / .css 文件的哈希（不递归进 assets/img
// 等子目录 —— 图片改动频率低，且部分是通过 CSS url() 间接引用的，暂不
// 纳入这套哈希机制，避免复杂度上升；如果以后需要，可以按同样思路扩展）。
function collectAssetHashes() {
  const hashes = {};
  const entries = fs.readdirSync(ASSETS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(js|css)$/i.test(entry.name)) continue;
    const filePath = path.join(ASSETS_DIR, entry.name);
    hashes[entry.name] = hashFile(filePath);
  }
  return hashes;
}

// 把某个 HTML 文件里所有对 /assets/<name> 的引用统一替换成
// /assets/<name>?v=<hash>（如果已经带了旧的 ?v=xxx，直接换成新的）。
function updateHtmlFile(filePath, hashes) {
  const original = fs.readFileSync(filePath, "utf8");
  let content = original;

  for (const [name, hash] of Object.entries(hashes)) {
    // 匹配 src="/assets/name.js" 或 href="/assets/name.css"，
    // 可能已经带了旧版本号 (?v=xxxxxxxx)，也可能还没有。
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `((?:src|href)=["'])/assets/${escapedName}(?:\\?v=[a-f0-9]+)?(["'])`,
      "g"
    );
    content = content.replace(pattern, `$1/assets/${name}?v=${hash}$2`);
  }

  // 只有真正发生变化（新文件加了版本号，或哈希和上次不一样）才写回磁盘
  // 和打印"已更新"——避免每次运行都误报所有文件都变了，看不出这次
  // 真正改动了哪些资源。
  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    return true;
  }
  return false;
}

function main() {
  if (!fs.existsSync(ASSETS_DIR)) {
    console.error(`找不到 ${ASSETS_DIR}，请在项目根目录运行这个脚本。`);
    process.exit(1);
  }

  const hashes = collectAssetHashes();
  const htmlFiles = fs
    .readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".html"))
    .map((e) => path.join(PUBLIC_DIR, e.name));

  let totalChangedFiles = 0;
  for (const htmlFile of htmlFiles) {
    const changed = updateHtmlFile(htmlFile, hashes);
    if (changed) {
      totalChangedFiles++;
      console.log(`已更新: ${path.relative(__dirname, htmlFile)}`);
    }
  }

  console.log("");
  console.log(`扫描到 ${Object.keys(hashes).length} 个 assets 文件，更新了 ${totalChangedFiles} 个 HTML 文件。`);
  console.log("记得把改动过的 public/*.html 一起提交。");
}

main();
