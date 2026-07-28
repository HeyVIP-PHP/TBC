# PROJECT STATUS — Issue Submission Hub + TG Reply Threads (INR CS Team)

Paste this whole document as the first message in a new conversation, along
with the latest `telegram-issue-hub-updated.zip`. That gives the new chat
the complete current state of the project.

## 🐛 修复,2026-07-22 — Telegram 群里其他机器人的回复被静默吞掉

**现象**：`BNAssistant`(群里另一个真正注册过的 Telegram Bot,不是普通
账号)在群里回复的 "✅ DONE" 之类的消息,在 Telegram App 里看得到,但
网站这边的工单详情页完全没有记录,消息列表里凭空少了一条。

**根因**：`functions/api/telegram-webhook.js` 的 `handleUpdate()`
一进来就有 `if (!msg || msg.from?.is_bot) return;`——凡是发送者是"机器
人账号"(Telegram 的 `is_bot` 字段为 true)的消息,一律直接丢弃,不记录。
这行代码原本是想防止"我们自己的 Bot 把自己发出去的消息,又当成一条新
回复记录进来"造成死循环,但实际上 Telegram 的 webhook 机制根本不会把
Bot 自己 `sendMessage`/`sendPhoto` 发出去的内容,又作为一条"收到新消息"
推送回同一个 Bot——这个过滤条件从一开始就没在防它真正想防的问题,
副作用却是把群里**所有**其他机器人(不只是我们自己的)的回复全部
静默丢弃,包括 `BNAssistant` 这种真正有用的自动化机器人。

（这里有个容易搞混的地方：`PYT_BOT ACC` 虽然名字里带 "BOT"，但技术上
只是个普通 Telegram 账号，不是真正注册过的 Bot，所以之前一直能正常
记录，只有像 `BNAssistant` 这种**真正**注册过的 Bot 才会被这行代码
误伤。）

**修复**：改成只排除"我们自己这个 Bot"发的消息（Bot 的 Telegram 数字
ID，就是 `TELEGRAM_BOT_TOKEN` 里冒号前面那一串数字，不需要额外调用
API 去查），群里其他任何机器人的回复现在都会正常记录、正常显示。

## 🔁 移植自 PKR(master 合并版),2026-07-21 — 附件预览全部功能 + KV 写入配额修复

这次是把之前分几次发的附件预览小改动,汇总成一份完整版(`master_attachment_and_quota_fix_export.zip`)一次性合并进 INR。涉及 6 个代码文件 + Part B 提到的独立 cron worker(不在这个仓库里,需要手动去 Cloudflare 后台调整,见下)。

### Part A —— 附件预览,累计 7 项(A1-A7)

- **A1**(上次已合并):回复消息带的附件能预览
- **A2**(上次已合并):原始工单摘要卡片显示完整 `rootText` + 附件
- **A3**(上次已合并):预览支持视频播放
- **A4**(这次新增):**发送侧**图片误判成"文件"的修复——`submit.js` 和
  `threads/[id].js` 都加了 `looksLikeImage(type, name)`,MIME 类型判断
  不出来时退回看文件后缀名(`.jpg/.png/.gif/.webp/.bmp/.heic/.heif`),
  避免图片被当成文件发送(Telegram 里显示成 📎 图标,没有缩略图)
- **A5**(这次新增,INR 原本完全没有):**接收方向**——玩家/同事直接在
  Telegram 群里回复的附件,现在也能提取 `file_id` 了。之前
  `telegram-webhook.js` 遇到这种情况只会写死成文字 `"(attachment)"`,
  现在跟 A1 用同一套字段(`attachmentFileId`)存下来,前端不用额外改就
  自动能显示(消息气泡不区分是自己发的还是对方发的)
- **A6**(这次新增,UI 改动较大):**从"点击才显示"改成"打开就自动
  显示"**——`threads.html` 两处渲染附件的地方(摘要卡片、消息气泡)从
  `<button>` 改成空占位 `<div class="inline-attach-slot">`,新函数
  `loadInlineAttachments()` 在 `renderDetail()`(首次打开)和
  `updateThreadContent()`(每次轮询/回复后刷新)末尾自动扫描并填充。
  配了一个 `attachmentCache`(`Map<fileId, Promise>`,缓存 Promise 本身
  防止重复请求)防止 6 秒轮询反复重新请求同一张图。原来"点击查看全屏
  大图"的 lightbox 还在,变成锦上添花而不是唯一入口。
  **⚠️ 这是交互方式的改动,是 PKR 业务方明确反馈要的,不代表 INR 业务方
  也认可这个方向——如果 INR 这边还没人拍板过,部署前建议先跟业务方过一
  遍效果,确认要保留"自动加载"还是想改回"点击才加载"。**
- **A7**(这次新增,连历史老数据都受益):`attachment/[fileId].js` 判断
  文件类型不准的修复——接口现在接受 `?name=<原始文件名>` 查询参数
  (前端调用时把存下来的 `attachmentName` 带上),优先级改成:先信自己
  存的原始文件名 → 再信 Telegram 的 Content-Type(除非它就是笼统的
  `application/octet-stream`)→ 再猜 Telegram 内部路径 → 兜底

### Part B —— KV 写入配额修复(**cron worker 部分需要手动去 Cloudflare 后台调整,不在这个 zip 里**)

- 排查出**独立部署的 cron worker**(负责定时刷新侧边栏缓存,跟这个
  Pages 项目分开部署,不在这个代码仓库里)本身每次运行就要写 2 次 KV,
  原来设的是每 2 分钟一次 → 一天 720 次运行 × 2 = 1,440 次写入,**光这
  一个自动化脚本就超过免费版 1,000 次/天的上限**,还没算真实业务写入
- 第一步权宜之计:cron 频率从 2 分钟降到 10 分钟(`functions/_shared/
  threads.js` 的 `LIST_CACHE_TTL_MS` 已经同步改成 10 分钟,这个已经合并
  进 INR 了)——但业务方反馈"新工单要等最多 10 分钟才出现"不能接受
- **真正的修复(已合并进 INR)**:新增 `patchListCache(env, thread,
  {remove})`,新工单/新回复/切换已解决/删除这四个动作发生的瞬间,直接
  "打补丁"式更新现有缓存(1 次读 + 1 次写,不用整个重新扫描),已经挂在
  `createThread()`/`appendMessage()`/`setSolved()`/`softDeleteThread()`
  四处。10 分钟这个间隔现在只管低风险的后台全量体检,不再影响"新工单能
  不能被及时看到"

**⚠️ 需要你手动去 Cloudflare 后台做的事(不在这次的代码改动里)：**
如果 INR 这边也有同样的独立 cron worker,去它的 `wrangler.toml` 把
Cron Trigger 从 `*/2 * * * *` 改成 `*/10 * * * *`,重新部署那个
worker(注意:这是跟 Pages 项目分开部署的另一个 Cloudflare Worker,不
是这次的 `telegram-issue-hub-updated.zip`)。如果不确定 INR 有没有这个
cron worker、或者它现在实际设的频率是多少,需要你自己先去 Cloudflare
后台确认一下。

**部署时的一个操作提醒**：PKR 那边部署时踩过一次坑——用 GitHub 网页
"直接编辑某个文件"的方式改动量大的文件,导致新旧代码拼接、同一个函数
声明了两次,网站 500 崩溃。**改动量大的文件(这次是 `threads.html`、
`_shared/threads.js`)务必用"Add file → Upload files" 整份覆盖上传,
不要用网页在线编辑逐行改。**



同样从 PKR 那边逐文件 diff 后手动合并进 INR(涉及 7 个文件:
`functions/_shared/threads.js`、`functions/api/threads/[id].js`、
`functions/api/attachment/[fileId].js`【新文件】、`functions/api/submit.js`、
`public/index.html`、`public/threads.html`、`public/assets/style.css`)。

**核心原理:实时代理,不存储**——业务方明确要求过这个功能不能占用 R2
存储,所以做法是:发送时只记住 Telegram 自己的 `file_id`(一段引用字符
串,不是文件本身),点开预览的那一刻才实时向 Telegram 现取字节流转发给
浏览器(Bot Token 全程只在服务器内部用,不暴露给客户端)。

1. **回复消息带的图片/文件,能在网站里点开预览**——新增
   `functions/api/attachment/[fileId].js` 这个登录态代理接口;
   `threads.html` 侧边栏附件从纯文字标签变成可点击按钮,弹出全屏
   lightbox(点 ✕/点背景/按 ESC 都能关)。只对这次改动后的新回复生效,
   旧消息当时没存 `file_id`,还是显示旧样式。
2. **顺手修的独立小 bug:首页 "TG Reply Threads" 卡片未读徽章不显示**
   ——`loadThreadsSummary()` 用的是没带登录 token 的 `fetch()`,
   `/api/threads` 早就要求登录,一直被 401 拒绝。改成
   `window.AgentAuth.authFetch()`。
3. **工单详情顶部摘要卡片,改成显示完整 TG 消息原文**(`rootText`,带
   emoji,不再是抽取几个字段拼出来的简化列表)+ 原始工单自己的附件也能
   点开预览。旧工单的文字摘要会自动跟着变成新样式(`rootText` 一直都有
   存),只是没有附件预览按钮(没存 `attachmentFileIds`)。
4. **预览弹窗支持视频播放**——`viewAttachment()` 加了 `video/*` 分支,
   用 `<video controls autoplay playsinline>`,不再是触发下载。

**部署前无需新增任何东西**——复用现有的 `TELEGRAM_BOT_TOKEN`、
`THREADS_KV`,不占用 R2、不需要新的 Cloudflare 密钥/绑定。

**可选但没做的优化(供参考)**:视频现在发去 Telegram 走的是
`sendDocument`(文档方式),不是 Telegram 原生视频消息格式
(`sendVideo`)——不影响咱们网站这边的播放,只是 Telegram App 里显示成
可下载文件而不是内嵌播放器。如果想要 Telegram 里也是原生视频消息样式,
需要把发送逻辑按 `type.startsWith("video/")` 单独分支出来调用
`sendVideo`,这次没做。



从另一个币种(PKR)的对话里,把两个已经调好的功能合并进了 INR(逐文件
diff 后手动合并,不是整份覆盖——INR 这边 login.js 已经有 token 机制,
两边基础版本一致,合并很干净):

**功能 1 — TG Group / Channel 面板新增 "🔒 Security Alerts" 行**
- 登录安全警报(密码错误/IP 异常/没分配 Office/账号自动锁定)现在发到
  哪个 Telegram 群/Topic,可以直接在网页上改,立刻生效,不用再去
  Cloudflare 后台改 `SECURITY_ALERTS_CHAT_ID`/`SECURITY_ALERTS_TOPIC_ID`
  环境变量 + 重新部署(这两个环境变量变成"没在网页上配置过时的兜底默认
  值")
- 涉及:`functions/api/admin/routes.js`(整份替换)、
  `functions/api/auth/login.js`(整份替换,见下)、`public/index.html`
  (TG Routes 面板那一段整段替换)、`public/assets/style.css`(加了
  `.tgroute-security` 的样式)

**功能 2 — 登录失败警报 + 自动锁定逻辑重构**
- 三种登录失败(密码错误 / IP 异常 / 没分配 Office)现在**每种都会发
  Telegram 警报**(以前只有 IP 异常才发)
- 自动锁定门槛改成**一个合并计数器**:密码错误 + IP 异常,1 小时内不
  分种类、不分是不是同一个 IP,累计满 5 次就锁定(以前是两套独立门槛:
  连续 5 次密码错误 / 1 小时内 5 个不同 IP,而且不同 IP 反复失败不算数
  ——这次改成同一个 IP 反复失败也会真实累加)
- "没分配 Office" 只发警报、**不计入**锁定门槛(这是后台配置疏漏,不是
  真正的安全风险,不该跟密码猜测用同一套惩罚机制)
- 涉及:`functions/api/auth/login.js`(整份替换——KV key 从
  `pwfail:<user>`/`ipfail:<user>` 两套合并成 `loginfail:<user>` 一套)

**部署前无需新增任何东西**——复用的都是已经在用的
`SECURITY_ALERTS_CHAT_ID`/`SECURITY_ALERTS_TOPIC_ID`/`THREADS_KV`,没有
新的 Cloudflare 密钥/绑定要加。

 — plaintext password was sitting in the
browser's localStorage, readable via F12

**Found by a colleague (IT) via DevTools → Application → Local Storage in
under a minute.** The original login design (documented below under
"Account system") had no session/token: the browser stored the agent's
literal password in `localStorage.agentAuth.password` and re-sent it as
`X-Agent-Pass` on every single request (including the 6-second sidebar
poll), so the server could re-verify it every time without a session
store. That meant the password was sitting in the clear in the browser at
all times — completely independent of how strong the server-side PBKDF2
hash was. Anyone with DevTools access to an already-logged-in browser
(shared computer, unlocked laptop, malicious extension, etc.) could read
it directly; no cracking involved.

**Fixed — replaced with signed session tokens:**
- `POST /api/auth/login` now issues a signed token (HMAC-SHA256, see
  `issueToken()`/`verifyToken()` in `functions/_shared/accounts.js`)
  instead of the frontend keeping the password.
- The browser stores **only the token** (`localStorage.agentAuth.token`)
  and sends it as `X-Agent-Token` on every request — the password itself
  never leaves the login form after that.
- Every account record now has a `tokenVersion` counter, bumped on every
  password change AND every lock/unlock. `verifyRequest()` rejects any
  token whose version doesn't match the account's current one, so an
  old token stops working the instant the password changes or the
  account gets locked — same guarantee the old "re-send the password
  every time" design had, without ever exposing the password itself.
- Tokens expire after 12h regardless, on top of the existing 2h
  client-side idle timeout.
- Self-service password change (`/api/account/change-password`) now
  returns a fresh token in the same response so the browser doesn't get
  logged out immediately after successfully changing its own password.

**Requires a NEW Cloudflare secret before this deploy will work:**
`SESSION_TOKEN_SECRET` (any long random string — used only server-side to
sign/verify tokens, never sent to the browser; not the same as any
existing secret). Add it under Settings → Environment variables →
Production, same as the other secrets, then deploy.

**Deploy side-effect, expected and harmless:** every already-logged-in
browser gets logged out on first request after this deploy (their old
localStorage entry has no `token` field, only the old `password` field,
which the new frontend code no longer sends) — everyone just logs in
again normally, no data loss, no account changes needed.

**Still pending from this, not yet done:** rotating the actual credentials
(all agent account passwords, `TELEGRAM_BOT_TOKEN`,
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `TELEGRAM_WEBHOOK_SECRET`,
`BRAND_EDIT_PASSWORD`) — the token fix stops the password from leaking
via the browser going forward, but doesn't retroactively un-expose
whatever a colleague may have already seen. This rotation was flagged
mid-session but not yet confirmed done.

## Multi-currency reuse — paused, reverted back to full INR

The business owner briefly had all 13 Google Sheet IDs in
`functions/_shared/routing.js` cleared out (`sheetId: ""`) to prep this
codebase for a different currency market, then asked to **revert back to
the real INR values and pause that work** — something needs changing
first (not yet specified). All 13 values (5 main `BRANDS` entries + 8
`PROMOTION_SHEET_CONFIG` entries) are back to their original production
IDs; nothing about Sheet logging is disabled right now. If multi-currency
work resumes later: the same 13 `sheetId` fields are what need clearing/
replacing again, `functions/api/promo-search.js`'s sheet is shared across
currencies and should stay untouched, and Telegram `chatId`/`topicId`
reassignment is handled separately through the TG Group/Channel admin
panel (KV-backed overrides, independent of what's hardcoded here).

**This version was rewritten from scratch** (not incrementally appended)
to describe the system as it stands *right now* — it supersedes every
earlier version of this document, including the incremental session-by-
session notes that used to make up most of this file's length. If you
need the history of exactly how something got to its current state,
that's in the conversation transcript this doc came from, not here.

## What this is
A web form → Telegram bot + Google Sheets ticketing system for INR-market
CS teams (BetVisa, Betjili, Crickex, Jeetway, Mostplay), plus a full
two-way Telegram reply-tracking dashboard ("TG Reply Threads") with its
own per-agent account system (login, office-based IP allowlists, role
hierarchy), a Promo Code Search dashboard, and a live-editable Telegram
routing admin page ("TG Group / Channel"). Deployed on Cloudflare Pages.

- **GitHub repo:** `HeyVIP-csteam/inrtg_control`
- **Live URL:** `inrtg-control.pages.dev`
- **Deploy method:** GitHub web upload (drag the `public/` and `functions/`
  folders themselves into "Add file → Upload files", not their contents —
  wrong drag depth has repeatedly caused duplicate/misplaced files)
- **Deployment note:** the project has a `wrangler.toml` committed to the
  repo. Once that file exists, Cloudflare treats it as the source of truth
  for **Production** bindings — the dashboard's "+ Add" button for
  Production gets disabled (Preview still works via dashboard). To add/change
  a binding, edit `wrangler.toml` and re-upload; Cloudflare auto-applies it
  to Production on the next deploy.

## Architecture
- **Frontend:** static HTML/CSS/JS in `public/` — no build step
- **Backend:** Cloudflare Pages Functions in `functions/`
- **Google Sheets writes:** service account
  `reward-form-writer@fifth-trainer-500806-e7.iam.gserviceaccount.com`
  (must be shared as Editor on every new Sheet used)
- **File storage:** R2 bucket `inr-issuescreenshot`, bound as
  `SCREENSHOTS_BUCKET`, served back out via `/api/screenshot/<key>`
- **KV storage:** Cloudflare KV namespace `inr-ticket-threads`, bound as
  `THREADS_KV` — backs TG Reply Threads, the account system (accounts/
  offices), and the live TG Group/Channel routing overrides. All in one
  namespace, separated by key prefix (see each module's section below).
- **Secrets set in Cloudflare (Settings → Environment variables, Production):**
  `TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BRAND_EDIT_PASSWORD` (used ONLY
  for the `accounts-admin.html` one-time bootstrap flow now — see Account
  system below, it is NOT used for brand logo/link editing anymore),
  `TELEGRAM_WEBHOOK_SECRET` (self-chosen random string, verifies Telegram
  webhook calls — see "IMPORTANT: must be alphanumeric only, no
  spaces/symbols/non-ASCII" note under TG Reply Threads below),
  `SESSION_TOKEN_SECRET` (**NEW, required** — any long random string,
  signs/verifies the session tokens described in the "Security fix"
  section at the top of this doc; login and every protected endpoint
  will fail until this is set).
  **Not yet set, optional:** `SECURITY_ALERTS_CHAT_ID` and
  `SECURITY_ALERTS_TOPIC_ID` — see "Unrecognized-IP login alerts" under
  Account system below; the feature silently no-ops until these exist.

## Key files
| File | Purpose |
|---|---|
| `public/assets/schemas.js` | Brand list (order: Crickex, Betjili, Mostplay, BetVisa, Jeetway — see "Known issues" below for a mismatch with the server-side order) + every module's form fields |
| `public/assets/app.js` | Renders the submission form dynamically from schemas.js; every input/textarea has `autocomplete="off"` |
| `public/assets/style.css` | All styling — dark starfield / light glass theme, Space Grotesk display font, gold accent, TG Reply Threads chat panel, TG Group/Channel panel, modal close-button styling |
| `public/assets/theme.js` | Theme toggle (dark/light) + live clock |
| `public/assets/starfield.js` | Animated space-photo background — new this session, see "Animated background" below |
| `public/assets/img/bg-space.jpg` | The space photo the animated background is built on (user-supplied, compressed to ~250KB) |
| `public/index.html` | Hub page — topbar, brand pills, sidebar, Home cards, Account Management sidebar (Create Account / Whitelist IP / TG Group Channel / Reset Password / Agent Profile) |
| `public/form.html` | Generic form page, driven by `?module=<id>` |
| `public/threads.html` | TG Reply Threads dashboard — full chat-panel UI |
| `public/promo.html` | Promo Code Search page |
| `public/login.html` | Site-wide login page — the entry gate for the whole hub |
| `public/assets/authguard.js` | Shared client-side auth guard on every gated page; redirects to login, exposes `window.AgentAuth` |
| `public/accounts-admin.html` | Hidden admin page (not linked from nav) — create/edit/delete Offices and Accounts, has its own separate bootstrap login |
| `functions/api/submit.js` | Submission handler — sends Telegram message, writes Sheets, creates a TG Reply Threads record, requires login. Checks a live KV routing override before falling back to the hardcoded default. Wrapped in a top-level try/catch safety net. |
| `functions/_shared/routing.js` | Per-brand/module Telegram + Sheet config — the hardcoded DEFAULTS (brand key order: betvisa, betjili, crickex, jeetway, mostplay — see "Known issues") |
| `functions/_shared/routes.js` | KV-backed override layer for Telegram routing (chatId/topicId) — lets TG Group/Channel change routing live without a redeploy |
| `functions/api/admin/routes.js` | `GET`/`POST` for the TG Group/Channel admin page — SuperAdmin-only for both read and write |
| `functions/_shared/googleSheets.js` | Google Sheets API helpers |
| `functions/_shared/r2.js` | R2 upload helper (used for ticket attachments — no longer used for brand logos) |
| `functions/_shared/telegram.js` | Small shared `sendTelegramMessage()` helper — new this session, used by the unrecognized-IP login alert feature (see Account system below); `submit.js`/`threads/[id].js` still have their own separate, richer Telegram senders, not refactored onto this |
| `functions/_shared/threads.js` | TG Reply Threads KV storage layer — create/read/update threads, auto-cleanup, deletion log. This session: removed the shared `"index"` KV key (was a write-contention hot spot under concurrent agents) in favor of `THREADS_KV.list()` + per-key metadata — see "Reliability & performance" below. |
| `functions/_shared/accounts.js` | Office/Account KV storage, password hashing, per-request auth (`verifyRequest`), role ranks, and the shared `officeIpCheckPasses()` office/IP rule |
| `functions/api/auth/login.js` | `POST /api/auth/login` — uses the same `officeIpCheckPasses()` as every other endpoint |
| `functions/api/admin/offices.js`, `functions/api/admin/accounts.js` | Admin-only Office/Account CRUD; `accounts.js` also has SuperAdmin-only lock/unlock (see Account system below) |
| `functions/api/account/change-password.js` | Self-service password change |
| `functions/api/telegram-webhook.js` | Receives Telegram messages, matches replies to threads |
| `functions/api/threads.js` | `GET /api/threads` — list active/solved threads, search, login-gated, brand-filtered |
| `functions/api/threads/[id].js` | Single-thread actions — solve, delete, reply, editRoot, recallRoot, editReply, recallReply |
| `functions/api/deletion-log.js` | `GET /api/deletion-log` — deletion history, requires admin-or-above (rank-based check — see "Reliability" section, this had a bug) |
| `functions/api/promo-search.js` | Search against the shared Promo Code Google Sheet (11 team tabs) |
| `functions/api/brand-config.js` | Brand pill Link editor — login-gated now, no logo upload (see "Brand config" below) |
| `functions/api/next-tid.js` | TID generator for Promotion Request |
| `functions/api/screenshot/[[path]].js` | Serves R2 objects — still has NO login gate (pre-existing, flagged, not fixed — see "Known issues") |
| `wrangler.toml` | Includes the `THREADS_KV` binding (real namespace ID) |

## Modules
QA / Account Issue / Risk Issue / Promotion Request / Daily Report / Genie
Issue — 6 modules, same as always. Promotion Request uses a single
unified Telegram message format (`PROMOTION_ROWS_UNIFIED` in
`functions/_shared/routing.js`) across all 8 brand+promotion combinations.

### ✅ Fixed this session — brand-restricted agents could see (and even
submit for) every brand, not just the ones assigned to them

Two separate gaps, both fixed:
1. **Client-side visibility** — the Home page's brand pills
   (`index.html`) and every submission form's Brand/Platform dropdown
   (`form.html` via `app.js`) rendered ALL 5 brands unconditionally, even
   for an agent whose account is scoped to just one (`allowedBrands`).
   Added `window.AgentAuth.filterAllowedBrands()` in `authguard.js` (one
   shared helper, used by both places) — an agent scoped to Crickex only
   now only ever sees "Crickex" as an option, doesn't just get blocked
   after picking a different one. `allowedBrands === "all"` (or admin/
   superadmin ranks, per `canSeeBrand()`) still see everything, unchanged.
2. **Server-side enforcement (the real gap)** — `functions/api/submit.js`
   never actually checked `allowedBrands` at all; the dropdown hiding a
   brand was the ONLY thing stopping a restricted agent from submitting
   for it — calling the API directly (or editing the page) would have
   worked regardless of the account's brand scope. Added a real
   `canSeeBrand(account, brand.name)` check right after the brand is
   resolved, before anything gets sent to Telegram/Sheets — returns 403
   if the account isn't allowed to touch that brand. This is the fix that
   actually matters; the dropdown filtering above is just the UX half.

**Deliberately NOT touched:** `/promo.html` (Promo Code Search) — it
searches across the shared Promo Code Sheet's regional tabs (BDT/PKR/INR/
etc.), which don't map 1:1 to the 5 brands, so this brand-scoping model
doesn't apply there the same way; the business owner confirmed this is
intentionally different. `/threads.html` (TG Reply Threads) needed no
change — it already filters server-side via `canSeeBrand()` in
`functions/api/threads.js` (confirmed still correct, not part of this
session's fix, just verified while investigating this).

---

## TG Reply Threads

### ✅ Root-caused and fixed this session — Telegram replies weren't
syncing in at all ("must refresh, and even then some never show up")

This was chased for a long time under the assumption it was the same KV/
CPU issue above (it looked identical from the dashboard: things just
"don't show up"). It wasn't — this was a third, completely separate
problem, found by checking Telegram's own side via `getWebhookInfo`:
**the webhook was never actually registered (`"url":""`), with 277
updates queued up and undelivered.** Root cause: `TELEGRAM_WEBHOOK_SECRET`
contained characters Telegram's `secret_token` parameter doesn't allow
(letters/digits/`_`/`-` only) — every `setWebhook` call was failing with
`400 Bad Request: secret token contains unallowed characters`, so the
webhook silently never got (re-)registered. Likely made worse by
Telegram auto-clearing a webhook registration after enough consecutive
delivery failures during the CPU-limit 503 episode above, compounding
into "no webhook at all" rather than just "some updates dropped."

**Fixed:** replaced the secret with a compliant alphanumeric value, updated
`TELEGRAM_WEBHOOK_SECRET` in Cloudflare (Settings → Environment variables
→ Production), redeployed so it actually took effect, then re-ran
`setWebhook` — confirmed via `getWebhookInfo` showing the correct `url`
and `pending_update_count: 0`. **If this ever needs to be regenerated
again: keep it alphanumeric, no spaces/symbols/non-ASCII, and always wait
for the deploy to finish (green in Deployments) before calling
`setWebhook`** — calling it during the deploy window can 403 once
(transient, self-resolves, but confusing to see mid-verification).

### What it does
Every form submission creates a tracked "thread". Telegram replies to that
ticket sync into a chat-style dashboard (`/threads.html`) in near-real-time,
and agents can reply back into Telegram from the dashboard too (two-way).

### Matching rule
Only a **genuine, explicit Telegram reply** (long-press → Reply on a
specific message) gets matched and recorded — supports reply chains
(reply to root, reply to a reply, etc.), as long as every link explicitly
replies to a message already recorded. A plain message with no reply, or
Telegram's auto-attached "reply to the topic root," is intentionally
ignored. An explicit reply to an already-Solved ticket reopens it
(deliberate signal); nothing else can reopen a solved ticket.

### Auto-cleanup
```js
const SOLVED_RETENTION_DAYS = 30;
const STALE_RETENTION_DAYS = 90;
```
Runs opportunistically (piggy-backs on writes), now **sampled at ~5% of
writes** instead of every single write — see "Reliability & performance"
below for why.

### Recall Chat History (deletion log)
A normal collapsible sidebar section (not hidden anymore), admin-or-above
only, shown/hidden by rank comparison both client-side (`threads.html`)
and server-side (`GET /api/deletion-log`, uses the rank-based
`authenticateAdmin()`). **This had a real bug found and fixed this
session** — see "Reliability & performance."

### `/threads.html` dashboard features
Search across all ticket fields; Active/Solved/Recall sidebar sections;
reply-to-a-specific-message with quoted preview; attach screenshot/PDF to
a reply; edit/recall the root ticket message or your own replies; per-
browser unread badges; manual refresh; Twemoji rendering; poll every 6s +
on tab-refocus. Search box and reply input both have `autocomplete="off"`.

---

## Promo Code Search

`/promo.html` — search-only. Matches (contains, case-insensitive) against
the Promo Code column across 11 tabs of one shared Google Sheet
(`1VYKwdGyoa5qxCScHWyKrYPQYvQPl8igrBzK1mk2RT98`). Tab-name matching goes
through Unicode NFKC normalization so invisible character mismatches
(non-breaking spaces etc.) can't silently break one tab's results.

**Still open:** "Start On" column has no source data yet (always shows
"—"); the "all 11 tabs share the same A–N layout" assumption is unverified
beyond the one reference tab. Unchanged this session.

---

## Account system

### 🆕 Account locking — manual + two auto-lock triggers (built this
session)

A `locked` boolean (plus `lockedAt`, `lockedReason`) now lives on every
account record. A locked account is rejected everywhere — login
(`api/auth/login.js`) AND every already-open browser session on every
subsequent request (`verifyRequest()` in `_shared/accounts.js`, since
this system has no session/token — see the design note at the top of
that file — a browser that was logged in before the lock would otherwise
keep working via its cached credentials). The locked check runs BEFORE
the password hash in both places, which also saves real CPU time on
every request against a known-locked account (see the PBKDF2/CPU-limit
writeup above).

**Three ways an account gets locked:**
1. **Manual** — SuperAdmin only (no delegation to Admin/Senior, unlike
   most account actions), via a 🔒/🔓 button: Home sidebar → Account
   Management → Agent Profile, or the hidden `/accounts-admin.html`.
   `POST /api/admin/accounts { action: "lock"|"unlock", username }`.
2. **Auto — 5 consecutive wrong passwords.** Counter in KV
   (`pwfail:<username>`), reset to 0 the instant a correct password comes
   in — this is about a wrong-guess STREAK, not a lifetime total.
3. **Auto — 5 different unrecognized IPs within a rolling 1 hour.**
   Timestamped list in KV (`ipfail:<username>`), pruned to the last hour
   on every check. Retrying from the SAME bad IP repeatedly doesn't add
   up toward this — only genuinely different IPs do. **This trigger can
   never affect SuperAdmin accounts**, because SuperAdmin bypasses the
   office/IP check entirely (`officeIpCheckPasses()`) — the whole
   IP-related block in login.js is skipped for them, same as it always
   was.

Each auto-lock also fires its own distinct Telegram alert (🔒 Account
Auto-Locked), separate from the per-attempt ⚠️ IP-warning message — both
go to the same `SECURITY_ALERTS_CHAT_ID`/`SECURITY_ALERTS_TOPIC_ID` (see
below).

**⚠️ Known risk, flagged rather than solved (matches the existing
"account with no office = locked out, no in-app recovery" trade-off
documented elsewhere in this file):** the wrong-password auto-lock
trigger (#2 above) is NOT exempted for SuperAdmin. If someone (or a
brute-force attempt) enters 5 wrong passwords against the only existing
SuperAdmin account, THAT account locks too, and since unlocking requires
a SuperAdmin, this can dead-end with no in-app recovery — only a direct
Cloudflare KV edit (`account:<username>` → set `"locked": false`). Worth
deciding deliberately: exempt SuperAdmin from this specific trigger, or
accept the risk given how it's a much narrower window than the old
no-office trap (5 WRONG guesses in a row, not just "no office set"). Not
changed without being asked, per the pattern in the rest of this doc.

### 🆕 Unrecognized-IP login alerts + auto-lock notifications (built this
session, needs one config step before it's live)

When a real account (correct username + password) tries to log in from
an IP that's NOT on its office's approved list, a Telegram alert fires to
a security/alerts chat — user, IP, assigned office, browser/device (best
available — Cloudflare/browsers don't expose real device details, just
what the browser reports about itself), country/city/ISP (from
Cloudflare's own edge geo data on the request — `request.cf`, no extra
API call, no added latency), and both Colombo and Malaysia local time.
**Login is still blocked exactly as before — this only adds visibility.**
Notifies on EVERY such attempt, deliberately NOT de-duplicated — the
business owner wants a count of how many times an account has tried from
unapproved networks, not just a one-time flag. Switching between IPs that
are ALL already whitelisted never triggers this at all. Sent via
`context.waitUntil()` so it never adds latency to the (still instant)
rejection response, and a Telegram hiccup can't break login.

Message format (exact wording/emoji requested directly by the business
owner):
```
⚠️Login Warning (Abnormal IP Address)⚠️

👤 User: <username>
🌐 IP: <ip>
🏢 Assigned office: <office name or "none">
📱 Browser/device: <raw User-Agent string>
🗺️ Country: <spelled out via Intl.DisplayNames, e.g. "LK" -> "Sri Lanka">
🏙️ City: <from request.cf.city>
📡 ISP: <from request.cf.asOrganization>
🕒 Colombo Time: <YYYY-MM-DD HH:mm> (GMT+5:30)
🕗 Malaysia Time: <YYYY-MM-DD HH:mm> (GMT+8:00)

🚫 Login was blocked as usual — this is just a heads-up.
```

**Not fully wired up yet — one thing still needed:** set
`SECURITY_ALERTS_CHAT_ID` (and optionally `SECURITY_ALERTS_TOPIC_ID` if
it should go to a specific topic, not just the group's General) as
Cloudflare environment variables once a Telegram group/topic exists for
this. Until then, `sendTelegramMessage()` in `_shared/telegram.js` sees
no chat ID configured and silently no-ops — nothing breaks, alerts just
don't go anywhere yet.

### ✅ Root-caused and fixed this session — the mysterious, persistent 503s
across the whole site (submit, threads list, open a thread, send a reply,
even login itself)

This took a long back-and-forth to pin down because it looked like a
different bug every time it showed up (KV write contention, KV list()
eventual consistency, GitHub upload mistakes, request quotas — all real
things that were checked and ruled out or fixed along the way, but none
of them were THE cause). The actual root cause:

**Cloudflare Workers Free plan caps CPU time at 10ms per request.**
Password verification uses PBKDF2 (Web Crypto, correct primitive) at
**100,000 iterations** — and this system has no session/token (see below):
**every single request** re-verifies the password from scratch, including
every 6-second sidebar poll. Cloudflare's own docs say heavier
auth-handling workloads "typically use 10-20ms" of CPU on Free — this was
landing right at/over the ceiling on every authenticated call. Confirmed
by testing: an unauthenticated request to `/api/threads` (skips
`verifyPassword` entirely) came back clean and fast every time; anything
that went through the authenticated path failed intermittently. When a
request exceeds the CPU limit, Cloudflare kills the isolate at the
platform level — **not a catchable JS exception**, so none of this
session's try/catch safety nets (see "Reliability & performance") could
ever have caught it. It surfaces to the browser as a bare network-level
503 with no JSON body, exactly what showed up in testing.

**Fixed in `functions/_shared/accounts.js`:** lowered the iteration count
used for any NEWLY hashed password (new account, or a password reset)
from 100,000 to **10,000** — a 10x cut in the per-request CPU cost of
auth, which should comfortably clear the 10ms ceiling given Cloudflare's
own note that KV reads/writes and other I/O waiting do NOT count toward
CPU time (only actual compute does). This is a real security/CPU-budget
trade-off, done deliberately rather than silently — flagging it here for
the business owner: PBKDF2-SHA256 at 10,000 iterations is weaker
brute-force resistance than 100,000, mitigated somewhat by this being an
internal tool already gated by per-office IP allowlisting, not a public
signup surface. If ticket/traffic volume grows and 10ms still gets tight,
the more correct long-term fix is a lightweight signed session
token so most requests skip PBKDF2 entirely instead of tuning the
iteration count further — not built this session, flagging as a future
option.

**Fully backward compatible, no forced password resets:** every account
created before this fix has its password hash computed at the OLD 100,000
count, and would fail to verify against a lower count. So instead of one
global constant, each account record now stores the exact iteration count
IT was hashed with (`iterations` field). Existing accounts (which predate
this field) fall back to 100,000 automatically; new/reset passwords get
10,000. Every account, old or new, keeps working exactly as before —
nobody needs to reset anything because of this change.

### ✅ Root-caused and fixed — "KV list() limit exceeded for the day"
(a second, separate quota this session's earlier `list()`+metadata
redesign missed)

Same failure shape as the CPU/PBKDF2 saga above (sidebar randomly
500ing), different root cause entirely, found via the actual error text
this time: `Unexpected server error: KV list() limit exceeded for the
day.` — a real Cloudflare-thrown error, not one of our own.

**Root cause:** the `list()`+metadata redesign (see the top of this file
and `_shared/threads.js`'s own header) fixed KV's write-contention limit
by moving the sidebar off a single shared "index" key onto
`THREADS_KV.list({ prefix: "thread:" })` — but Cloudflare's free plan
caps `list()` calls at **1,000/day**, a completely separate and far
stricter budget than the 100,000 reads/day one, and this wasn't checked
at the time. The sidebar polls every 6 seconds; any single agent leaving
the dashboard open for roughly two hours was enough to exhaust the
entire day's list() budget on its own — this was never a "maybe," it was
only a matter of when someone would notice.

**Fixed in `functions/_shared/threads.js`:** a real `list()` scan now
only runs at most once every 2 minutes — the result is cached in a
single KV key (`thread-list-cache`, `LIST_CACHE_TTL_MS`) and every other
`listThreads()` call in that window just reads that cache (a cheap
`get()`, drawing from the much larger 100,000-reads/day budget instead).
Caps real `list()` calls at ~720/day worst case even under continuous
all-day polling — well under 1,000, and also keeps the cache-refresh
writes well under the SEPARATE 1,000 writes/day budget shared with every
ticket submit/reply/solve-toggle. If the real scan itself fails (e.g.
the daily quota is already blown when this runs), it now falls back to
whatever's cached — even hours-stale — rather than fail the request
outright; it only throws if there's truly no cache to fall back to.

**Trade-off, stated plainly:** a brand-new ticket, or a solved/reopened
status change, can now take up to ~3 minutes to appear in someone else's
sidebar. An already-open conversation is completely unaffected and stays
fully real-time (it reads its own `thread:<id>` key directly by ID, never
touches `list()` at all). Given the alternative was the whole sidebar
hard-failing once the daily quota ran out, this is the same kind of
trade already made earlier in this file (KV write-contention fix,
PBKDF2/CPU fix) — favoring "usable but slightly delayed" over "breaks
outright once a hidden limit is hit."

**Known minor side-effect, not fixed:** deleting a ticket doesn't
invalidate this cache, so a just-deleted ticket can still show in the
sidebar for up to ~3 minutes (clicking it correctly shows "not found"
rather than erroring). Not worth adding cache-invalidation-on-every-write

### 🆕 Optional add-on — `cron-worker/`, a truly independent scheduled
refresher (not deployed by default, see that folder's own README.md)

Everything above (2-minute cache + 800/day hard cap) is a request-
triggered fallback — some page request has to "notice" the cache is
stale and do the refresh, which leaves a small (not a real risk given
the daily cap, but not a mathematical zero) window where two agents'
requests could both notice staleness in the same instant. `cron-worker/`
is a genuine architectural fix for that: a completely separate Cloudflare
Workers project (own `wrangler.toml`, own deployment, NOT part of this
Pages project) bound to the same `THREADS_KV` namespace, with a real
Cron Trigger firing every 2 minutes — Cloudflare guarantees a Cron
Trigger run never overlaps with itself, so there is no possible race,
matching the guarantee the business owner saw in a comparable Google
Apps Script project (`ScriptApp.newTrigger(...).everyMinutes(1)`) and
asked to match. Available on Cloudflare's Free plan (Cron Triggers
aren't Paid-only — up to 3 per Worker on Free).

Deploying this is **optional** — the main app works completely fine
without it (falls back to the request-triggered mechanism above,
already safe on its own). If deployed, it becomes the primary refresher
in practice (keeps the cache fresh before any page request would ever
notice staleness); if it's ever undeployed or breaks, the main app
doesn't notice or depend on it in any way. See `cron-worker/README.md`
for click-through dashboard deployment steps (no CLI/local tooling
needed) — it's a genuinely different deployment flow from the main site
(a Worker created directly in the Cloudflare dashboard, not something
that goes through the GitHub-upload-to-Pages flow used for everything
else in this project), so don't try to drag this folder into the same
GitHub repo as the main site — it needs its own separate Worker.

**✅ Deployed and confirmed working** (this session) — the business
owner set this up end-to-end via the Cloudflare dashboard (click-through,
no CLI), confirmed via the Worker's own Logs tab showing
`Refreshed thread-list-cache: 54 threads.` firing automatically every 2
minutes with zero manual interaction. Interval was changed from the
initial 3 minutes to 2 minutes at the business owner's request, to more
closely match the cadence of the Google Apps Script project used for
comparison. **Note the tighter safety margin at 2 minutes:** this cron
job alone now uses ~720 of the shared 800/day hard cap, leaving only
~80/day of headroom for the main app's request-triggered fallback (see
above) — should be plenty in practice since that fallback should rarely
fire once this cron job is running consistently, but don't drop the
interval below 2 minutes without also raising DAILY_SCAN_LIMIT (currently
800, still safely under Cloudflare's real 1,000/day ceiling) — see that
constant in both `functions/_shared/threads.js` and `cron-worker/worker.js`
(must be changed in BOTH files together, since they share one counter).


for, since that would mean writing to the shared cache key far more
often — the exact pattern this whole fix exists to avoid.

**If more `list()` calls are ever added anywhere else in this codebase,
remember they all share this same 1,000/day account-wide budget** — this
was the whole miss the first time around.

### Model
- **Offices** — a name + a list of allowed IPs.
- **Accounts** — username + password (PBKDF2, 100k iterations), one of
  four roles, one `officeId`, and `allowedBrands` (array or `"all"`).
- **No session/token** — the browser saves username+password in
  `localStorage`, re-sends them as `X-Agent-User`/`X-Agent-Pass` headers
  on every request; every protected endpoint independently re-verifies
  (password hash + office/IP rule) on every call. 2-hour client-side idle
  auto-logout (not server-enforced).
- **Whole site requires login** — `/login.html` is the entry gate;
  `authguard.js` redirects any gated page there if not logged in. Server-
  side endpoints independently 401 without valid credentials too, not
  just the page redirect.

### Role hierarchy — Agent / Senior / Admin / SuperAdmin / Owner
**Updated 2026-07 — replaced with the Owner role.** Full design writeup
in `OWNER_ROLE_SETUP.md`. The old per-tier hand-written allow-list
(`MANAGE_SCOPE`) is gone; there's now ONE rule:

> **actor can only manage a target whose rank is STRICTLY LOWER than
> the actor's own.** Same rank can never manage same rank — a
> SuperAdmin can't touch another SuperAdmin; only Owner can.

```
Owner (4)      — highest, hidden, can't be created/assigned through the
                 site (only a direct KV write — see OWNER_ROLE_SETUP.md),
                 exempt from the Office+IP login requirement
SuperAdmin (3) — now ALSO requires Office + IP whitelist to log in
Admin (2)
Senior (1)
Agent (0)
```

| Capability | Agent | Senior | Admin | SuperAdmin | Owner |
|---|---|---|---|---|---|
| Reset own password | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reset a strictly-lower-ranked account's password | ❌ | ✅ (Agent) | ✅ (Agent/Senior) | ✅ (anyone below) | ✅ (anyone below) |
| Create an account with a strictly-lower role | ❌ | ✅ (Agent) | ✅ (Agent/Senior) | ✅ (Agent/Senior/Admin) | ✅ (anyone but Owner) |
| Delete a strictly-lower-ranked account | ❌ | ❌ | ✅ (Agent/Senior) | ✅ (anyone below) | ✅ (anyone below) |
| View Whitelist IP (Offices) | ❌ | ❌ | 👁️ view only | ✅ view + edit | ✅ view + edit |
| View / edit TG Group Channel routing | ❌ | ❌ | ❌ | ✅ only | ✅ |
| Lock / unlock an account | ❌ | ❌ | ❌ | ✅ (strictly-lower rank only — NOT another SuperAdmin) | ✅ (anyone below, incl. SuperAdmin) |
| View Agent Profile table | ❌ | ❌ | ✅ view | ✅ view | ✅ view (sees own row too) |
| Edit Agent Profile fullName/PID | ❌ | ❌ | ✅ own or lower-ranked | ✅ own or lower-ranked | ✅ |
| Edit Agent Profile Role/Office/Brands/Topic Access | ❌ | ❌ | ❌ | ✅ strictly-lower rank only | ✅ anyone below |
| Be assigned the "owner" role through the site | ❌ | ❌ | ❌ | ❌ | — (impossible for anyone, including Owner — see OWNER_ROLE_SETUP.md) |

`canManage(actorRank, targetRank)` in `functions/api/admin/accounts.js`
is the one function that replaced `MANAGE_SCOPE` — `return actorRank >
targetRank;`. SuperAdmin self-promotion bootstrap is unchanged: while
zero SuperAdmin accounts exist anywhere, any Admin-or-above account can
promote ONLY its own account to `superadmin` — the instant one exists,
this path closes for good. (Owner accounts don't count toward "does a
SuperAdmin exist" — see `anySuperAdminExists()`'s deliberately-hidden
`listAccounts()` call in `_shared/accounts.js`.)

**Owner accounts are hidden everywhere** — `GET /api/admin/accounts`,
the Agent Profile table, `anyAdminExists()`/`anySuperAdminExists()`, all
of it — except an Owner viewing the list sees their own single row. A
non-Owner trying to `save`/`delete`/`lock`/`unlock` a hidden Owner
account gets `404 Account not found`, not `403`, so there's no way to
even infer one exists at a given username from the error code alone.

### ✅ Office/IP rule — CHANGED again 2026-07: Owner (not SuperAdmin) is
now the ONLY role exempt from needing an office

**Previous behavior (this session, since superseded):** SuperAdmin was
the one role exempt from the Office+IP check.

**Current behavior:** `officeIpCheckPasses()` in `_shared/accounts.js`
now checks `account.role === "owner"`, not `"superadmin"`. **SuperAdmin
now requires an Office + IP whitelist to log in, same as Agent/Senior/
Admin.** Deploying this change with an existing SuperAdmin that has no
office bound will lock that account out immediately — always bind an
Office to every existing SuperAdmin BEFORE deploying, or create/upgrade
an Owner account first as a guaranteed way back in. `auth/login.js` has
its own separate, earlier "no office at all" pre-check (for a clearer
error message) that also had to be updated to match — see that file.

**Accepted trade-off, stated explicitly to the business owner:** if the
very first Admin-tier account (before any SuperAdmin exists) has no
office, that account is now locked out of everything, including its own
SuperAdmin self-promotion path — no in-app recovery, only a direct
Cloudflare KV edit. **Always assign an office to every non-Owner
account, including SuperAdmin — login will fail without one, not just
be unrestricted.**

### Bootstrap (first-time setup after a fresh deploy)
`accounts-admin.html` accepts the existing `BRAND_EDIT_PASSWORD` secret
as a one-time key (while zero admin-or-above accounts exist) to create
the first admin account. Steps: deploy → go to `/accounts-admin.html`
(bookmark it, not linked in nav) → "first-time setup" → enter
`BRAND_EDIT_PASSWORD` → create an Office with real IPs → create the first
admin account assigned to that office → promote it to SuperAdmin via Edit
Account (while zero SuperAdmins exist) → create real accounts for every
CS agent who uses ANY part of the hub (submitting tickets, promo search,
or TG Reply Threads — all of it requires login now).

### Account Management (Home sidebar)
Expandable sidebar entry with role-gated sub-items:
- **Everyone:** Reset Password (self-service, requires current password).
- **Senior+:** Create Account.
- **Admin (view) / SuperAdmin (edit):** Whitelist IP.
- **SuperAdmin only:** TG Group / Channel (see its own section below).
- **Admin+ (view), SuperAdmin (edit role):** Agent Profile.

**Agent Profile table — this session added:**
- **"Office" column** (name only, no IP list shown) — flags a
  non-SuperAdmin account with no office bound with a red
  "⚠️ No office — can't log in" warning, since that's now a real broken
  state instead of just "unrestricted."
- **Role filter dropdown** next to the modal title (All / Agent / Senior
  / Admin / SuperAdmin) — filters the table client-side, no extra fetch.

### Modal UX — this session: Cancel buttons removed everywhere, replaced
with an X close button
Both modals on the site (`editModalBackdrop` — brand link editor, and
`acctModalBackdrop` — the whole Account Management modal, reused for
Create Account / Whitelist IP / Reset Password / Agent Profile / TG
Group Channel) now close via a small **✕ button in the top-right corner**
instead of a "Cancel" button in the footer. Clicking outside the modal
(on the backdrop) still closes it too — unchanged. When a mode has no
Save button either (e.g. Agent Profile, TG Group/Channel, or a non-
SuperAdmin viewing read-only Whitelist IP), the entire footer actions row
is hidden rather than left as empty dead space.

---

## TG Group / Channel — live-editable Telegram routing (built this session)

### What it does
Lets a SuperAdmin change which Telegram chat/topic each brand+module
routes to, live from the browser — no code edit + redeploy needed. Before
this, every routing change required editing `functions/_shared/routing.js`
and redeploying.

### Architecture
- `functions/_shared/routes.js` — KV layer, keyed `route:<brandId>:<moduleId>`
  in `THREADS_KV`. `getRouteOverride()` — single read. `getAllRouteOverrides()`
  — batch reads all 30 brand×module combos for the admin grid.
- `functions/api/submit.js` checks `getRouteOverride()` FIRST, falls back
  to the hardcoded `brand.telegram[moduleId] || brand.telegram.default`
  from `routing.js` if nothing's stored — an empty KV changes nothing
  that already worked.
- `functions/api/admin/routes.js` — `GET` (merged grid: defaults +
  overrides, with `isOverride` per cell) and `POST { action:"save"|"reset",
  brandId, moduleId, chatId?, topicId? }`. **SuperAdmin-only for BOTH**
  read and write — stricter than Whitelist IP (which lets Admin view
  read-only), since routing controls where every ticket is actually
  delivered.

### UI
Home sidebar → Account Management → "TG Group / Channel" (SuperAdmin
only). Left column: the 5 brands. Right: the selected brand's 6 modules,
each row showing Chat ID + Topic ID + a "default"/"custom" tag, with
**Save and Reset buttons on the same line as the fields** (changed this
session from a separate button row below — Reset only appears on rows
that have been overridden). Panel height is `78vh` (was a fixed 440px)
so all 6 modules fit on one screen without scrolling on most displays;
modal width widened to 940px. Save/Reset are text buttons now (gold solid
Save, outlined Reset) instead of the original ✅/↩️ emoji icons. A divider
+ extra top spacing separates the module list from the explanatory
footnote at the bottom.

### ✅ Fixed this session — brand order mismatch
The brand list in this modal followed `functions/_shared/routing.js`'s
`BRANDS` object key order, which didn't match `public/assets/schemas.js`'s
reordered array used everywhere else in the UI (form dropdowns, Home page
brand pills). Reordered the `BRANDS` object literal in `routing.js` to
match: **crickex, betjili, mostplay, betvisa, jeetway**. Pure key-order
change — no routing values (chatId/topicId/sheetId) touched, verified with
`node --check`. These are still two entirely separate `BRANDS`
definitions (one client-side in `schemas.js`, one server-side in
`routing.js`) that just now happen to agree on order — not merged into
one source of truth, so if either list gets reordered again in the
future, remember the other one needs a matching edit by hand.

---

## Brand pill Link editor (`/api/brand-config`) — logo REBUILT this
session (static files, not an upload feature), password removed a
previous session

- **Logo images are back — via static files, not the old upload flow.**
  The old file-upload path never worked in production and was ripped out
  in an earlier session ("Logo 之后再想办法"). This session, the business
  owner supplied logo image files directly instead: checked into the repo
  at `public/assets/img/brands/<brandId>.png` (all 5 brands — Crickex,
  Betjili, Mostplay, BetVisa, Jeetway — 160×160, resized/optimized from
  the originals; Jeetway's is its live-chat bubble icon, confirmed by the
  business owner, upscaled from a small 60×60 source but looks fine at
  the 24px size it actually renders at). Simple —
  the images just deploy with the site like any other static asset, no
  R2 upload, no admin UI to rebuild.
  `functions/api/brand-config.js`'s `DEFAULT_LOGOS` map ties each brand
  ID to its file, and `readConfig()` fills in `logoUrl` from that map for
  any brand that doesn't already have one set in R2 — so the existing
  `{ [brandId]: { logoUrl, link } }` shape and the pill-rendering code in
  `index.html` (`buildBrandPill()`) needed ZERO changes; they already
  checked for `entry.logoUrl` and just silently had nothing to show
  before. **All 5 brands now have a logo — nothing pending here.**
  The "Edit brand" modal still only has a Link field — no logo UPLOAD
  control was rebuilt (deliberately; static files checked into the repo
  are simpler and were what actually got used), but logos now render
  correctly via the default-file mechanism above regardless.
- **`BRAND_EDIT_PASSWORD` gate removed from this endpoint.** Replaced
  with the same `verifyRequest()` login check every other endpoint uses
  — any logged-in agent (any role) can edit a brand's link now, same
  authorization level as submitting a ticket. This was a deliberate fix
  to an inconsistency: simply deleting the password with nothing in its
  place would have left this as the ONLY unauthenticated write endpoint
  in the whole hub. `BRAND_EDIT_PASSWORD` the secret itself is UNCHANGED
  and still required for `accounts-admin.html`'s bootstrap flow — those
  are unrelated uses of the same secret.
- Request shape changed from `multipart/form-data` to a plain JSON body
  `{ brand, link }`, sent via `window.AgentAuth.authFetch()`.
- The `{ [brandId]: { logoUrl, link } }` data shape in R2's
  `brand-config.json` is untouched — `logoUrl` just has nothing writing
  it anymore.

---

## Browser autocomplete — swept and disabled everywhere this session

Every text `<input>`/`<textarea>`/password field across the ENTIRE site
now has an explicit `autocomplete` attribute — either `"off"`, or (for
actual credential fields like login/password) the semantically correct
value (`"username"`, `"current-password"`, `"new-password"`). This fixes
the browser showing a dropdown of previously-typed values on focus — the
original complaint was the TG Reply Threads reply box visibly showing old
reply text as suggestions, but the same gap existed on every dynamically-
rendered form field (`app.js`, used by all 6 submission modules),
`form.html`'s agent-name field, the sidebar search box, and every text
field inside the Account Management / Whitelist IP / TG Group Channel /
Agent Profile / accounts-admin.html modals. Confirmed via repo-wide grep
that nothing was missed.

---

## Reliability & performance — full review this session

### ✅ Every API endpoint now has a top-level safety net
All 13 endpoint files (`submit.js`, `threads.js`, `threads/[id].js`,
`admin/routes.js`, `admin/accounts.js`, `admin/offices.js`,
`deletion-log.js`, `auth/login.js`, `account/change-password.js`,
`brand-config.js`, `promo-search.js`, `next-tid.js`,
`screenshot/[[path]].js`) now wrap their real logic in an inner handler
function called from a top-level `try/catch` in the exported
`onRequestGet`/`onRequestPost`. Any unanticipated exception now returns a
clean `{ ok:false, error }` JSON response instead of Cloudflare's raw
platform error page. Found in the process: `threads/[id].js`'s
`editRoot`/`recallRoot`/`editReply`/`recallReply` actions called the
Telegram API directly with no try/catch of their own (unlike the `reply`
action) — a network hiccup there would have thrown uncaught; now covered
by the new outer safety net.

### ✅ Fixed — the literal-"admin"-string bug existed in THREE places,
not the one a previous note claimed was "fixed"
- `threads.html`'s client-side visibility check for Recall Chat History
  — fixed in an earlier session, confirmed still correct.
- `functions/api/deletion-log.js`'s actual SERVER-SIDE gate — was still
  `account.role !== "admin"`, a literal string compare that rejects every
  SuperAdmin (whose role string is literally `"superadmin"`). Since
  `threads.html` silently swallows a 401 on this endpoint, the visible
  symptom was "Recall Chat History section renders but is permanently
  empty for SuperAdmin" — found and fixed this session, now uses the
  rank-based `authenticateAdmin()`.
- `public/accounts-admin.html`'s own login form had the identical bug —
  a real SuperAdmin account got rejected client-side with "This account
  isn't an admin." Found and fixed the same way (local rank comparison).
- Repo-wide grep swept afterward for the same pattern — nothing else
  found. A few `role === "superadmin"` comparisons in
  `admin/accounts.js` were individually checked and are legitimate
  (comparing against one specific target role for the self-promotion
  bootstrap, not a permission gate) — not the same bug class.

### ✅ Architecturally fixed this session — "replies come back slowly
under load" / KV write-contention ceiling

**Root cause (unchanged from the earlier diagnosis):** Workers KV allows
at most 1 write/sec to the SAME key. Every reply/submission/solve-toggle/
edit used to also rewrite one shared `"index"` KV key (the sidebar's data
source) — under real traffic, two of those landing in the same second was
normal, not rare, and since `telegram-webhook.js` deliberately swallows
errors, a rate-limited index write was silently dropped (the ticket/
message itself was never lost, just the sidebar entry going stale).

**What changed:** removed the shared `"index"` key entirely, in favor of
Cloudflare KV's built-in `list()` + per-key `metadata`. Every thread
already writes its own `thread:<id>` key on every update — now a
lightweight summary (title, submitter, brand, timestamps, solved state,
reply count, a capped extra-searchable-text blob) rides along as that
same key's KV *metadata* in the same `put()` call, instead of a second
write to a shared key. The sidebar (`listThreads()` in
`functions/_shared/threads.js`) now calls
`THREADS_KV.list({ prefix: "thread:" })`, which returns every thread's
metadata in one cheap call with no full-record fetch and no shared key.
Two agents touching two *different* tickets now write to two entirely
different keys and never contend with each other — the only remaining
contention surface is two edits to the exact same ticket in the same
second, which is a much smaller, much rarer case than before.

**Trade-off, stated plainly:** `list()` is eventually consistent across
Cloudflare's edge (fast in practice, but not the same instant/global
guarantee as reading one specific key), so a brand-new ticket may take a
little longer to show up in a colleague's sidebar than before. Given the
old failure mode was a write getting silently dropped/delayed under
contention, this is a straightforward trade in the sidebar's favor, not a
new class of problem.

**Migration, zero manual steps needed:** every `thread:<id>` key written
*before* this change has no metadata yet. `listThreads()` handles that
transparently — for any key missing metadata, it fetches that one thread's
full record once, builds the summary, and re-saves it with metadata
attached, so it only ever pays that cost once per pre-existing ticket, not
on every future load. The old `"index"` key itself is simply no longer
read or written — it's dead, harmless leftover data in KV, not cleaned up
automatically (fine to ignore, or delete by hand from the Cloudflare KV
dashboard if you want it gone).

**This closes the item that was previously flagged as "architectural
ceiling remains, not built."** Durable Objects / index-sharding are no
longer needed for this specific problem — they'd only come back into the
conversation for a different reason (e.g. wanting real-time push instead
of the current 6-second poll).

### ⚠️ Known gaps, NOT changed (flagging for awareness, not bugs)
- **`GET /api/screenshot/<key>`** — still no login gate at all. Security
  is purely "the key is an unguessable timestamp + random string," not
  real access control. Pre-existing, unchanged.
- **`GET /api/brand-config`** — still public/unauthenticated (reads only
  logo/link display data for the brand pills). Reasonable given the low
  sensitivity, but not covered by the "whole hub requires login" model.

---

## Still pending / needs input before it can be finished

1. **Promo Code Search** — "Start On" column has no source data (always
   "—"); "all 11 tabs share the same A–N layout" is unverified beyond one
   reference tab.
2. ~~**Brand logos**~~ — ✅ all 5 done this session (Crickex, Betjili,
   Mostplay, BetVisa, Jeetway — see "Brand pill Link editor" section
   below for how). Nothing pending here anymore.
3. **`GET /api/screenshot/<key>` and `GET /api/brand-config`** — no login
   gate, pre-existing, flagged for awareness only.
4. **Live-tested end-to-end this session, after a long real-production
   debugging round** — submit, Telegram reply sync (both directions),
   solve/reopen-on-reply, sidebar updates, and the account/login path all
   confirmed working against the real Cloudflare deployment (not just
   syntax-checked). See the three root-caused-and-fixed writeups above
   (KV index contention, PBKDF2 CPU limit, webhook secret format) for
   what was actually broken and how each was found — this is no longer a
   "reasoned through, not yet verified" item.

## Recurring non-code gotcha (still true)
GitHub web upload can cause duplicate files or misplaced content if the
wrong folder depth is dragged in. Always sanity-check file contents after
upload if something looks broken post-deploy, before assuming the code
itself is wrong.

## Animated background (built this session)

The site-wide background (both themes — see below) is now the business owner's
own space photo (`public/assets/img/bg-space.jpg`, compressed from a
~2.8MB original to ~250KB), brought to life with layered effects rather
than a static image:
- Very slow "breathing" zoom (scale 1 → 1.055 → 1 over 28s)
- Subtle mouse-parallax drift (the photo shifts slightly opposite the
  cursor)
- A twinkling star overlay (60 stars, independently randomized size/
  twinkle speed/position, regenerated fresh on every page load)
- A meteor shower overlay (22 streaking meteors, randomized start point/
  speed/delay — raised from an initial 6 after the business owner asked
  for it denser)
- A dark shading gradient so foreground cards stay readable regardless
  of which part of the photo sits behind them

**Architecture:** one shared script, `public/assets/starfield.js`,
included via `<script src="/assets/starfield.js" defer></script>` in all
6 pages' `<head>` (right after `theme.js`) — it injects the background
markup into `<body>` itself rather than duplicating it as HTML in every
page. It mounts once on load, active in both themes (see below) — it no
longer needs to watch `<html data-theme="...">` for changes, since which
theme is active only changes the CSS custom properties (`--sf-filter`,
`--sf-shade`) the same markup renders with, not whether the background
exists at all.

**Light theme:** initially left untouched (a space photo seemed like it
wouldn't suit the light theme's lavender/blue look) — but the business
owner asked for it in both themes, so it's now active everywhere.
Same photo, same effects, but two theme-scoped CSS variables change how
it looks: `--sf-filter` (light theme brightens the photo —
`brightness(1.4) saturate(0.85) contrast(0.95)`; dark theme leaves it
`none`) and `--sf-shade` (light theme overlays a light lavender-tinted
gradient matching this theme's own `--page-bg` palette; dark theme keeps
the original dark shading gradient). `starfield.js` itself doesn't know
or care which theme is active — it just mounts once on load; only the
CSS driven by `[data-theme]` changes the look between themes.

**`prefers-reduced-motion` respected:** if set, the photo still shows
(as a plain static background) but with zero animation — no zoom, no
parallax, no stars, no meteors.

**Explored and explicitly NOT built, so it doesn't get re-proposed
later:**
- *Pure-CSS drawn planets/nebula (no photo)* — built as an earlier
  preview iteration (glowing gradient "planets," nebula color washes,
  CSS-only). Superseded once the business owner supplied their own
  photo instead — a real photo reads far more "real" than CSS-drawn
  spheres, so this direction was dropped in favor of animating the
  supplied photo. Not present in the final code at all.
- *Planet-collision / explosion sequence* (Earth + Mars drifting
  together, impact flash, shockwave rings, debris) — built and shown as
  a preview, explicitly flagged as a real distraction risk for a
  work-focused CS dashboard (a recurring bright flash behind a ticketing
  tool that agents stare at all day), and NOT adopted. If this comes up
  again: the working preview code existed (Earth/Mars approach +
  collision animation), it just isn't in the shipped site — could be
  revived, but reconsider the distraction trade-off first, and consider
  making it a rare/toggleable event rather than a fixed loop if it is
  revived.
- *"6D" effects* — clarified with the business owner that this is a
  cinema/attraction marketing term (motion seats, wind, water, smell),
  not a real graphics capability; a browser background can only ever be
  visual. Interpreted as wanting stronger depth/parallax instead, which
  is what the mouse-parallax + shading layers already provide.


