# PROJECT STATUS — Issue Submission Hub + TG Reply Threads (PKR CS Team fork)

Paste this whole document as the first message in a new conversation, along
with the latest project zip (`pkr-issue-hub.zip`). That gives the new chat
the complete current state of the project.

## PKR is live and has been heavily tested — read this before doing
anything else

This project is a **separate, independent deployment** for the PKR market —
it does NOT share a GitHub repo, Cloudflare Pages project, KV namespace, R2
bucket, or Telegram bot with the original INR production system (one
deliberate, confirmed exception: Crickex's Telegram group is intentionally
shared with INR, split by Topic — see "TG Group / Channel" section further
down for why that's fine and not a mistake). It started as a fork of the
INR codebase (same architecture, same modules, same feature set) with all
INR-specific brand/routing/sheet data replaced with real PKR data.

**Where things stand right now:**
- **Live and deployed**: `https://pkrcsteam-tbc.pages.dev` (GitHub:
  `HeyVIP-PKR/TBC`, Cloudflare Pages project `pkrcsteam-tbc`). Deploys are
  green. R2 bucket `pkr-issuescreenshot` and KV namespace
  `pkr-ticket-threads` (id `c8ca68f7781a4f1b88d0997af023aec7`) are both
  live and wired into `wrangler.toml`. All Cloudflare secrets are set
  (`TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`,
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `BRAND_EDIT_PASSWORD`,
  `TELEGRAM_WEBHOOK_SECRET`, `SESSION_TOKEN_SECRET`). Telegram webhook is
  set and confirmed receiving replies. A standalone Cloudflare Worker
  (`pkr-ticket-threads-refresher`, NOT part of this Pages
  project/repo/zip — deployed separately via the Cloudflare dashboard's
  own code editor, see its own README for how) refreshes the sidebar
  cache every 10 minutes as a background health-check (see "Reliability &
  performance" further down for why 10 minutes is fine and doesn't
  affect how fast agents actually see new tickets).
- **All 9 brands fully configured**: Crickex, Betjili, Mostplay, Jeetwin,
  Sbj66, Heybaji, Superbaji, KV8, Darazplay — each has a real
  `sheetId` in `routing.js`, real Telegram `chatId`/`topicId` for every
  module (set through the TG Group/Channel admin panel, not hardcoded —
  see that section), and a real logo. Google Sheets are shared with the
  service account (`pkr-tbc@tonal-unity-503006-u6.iam.gserviceaccount.com`).
- **Promotion Request fully configured**: 19 real brand+promotion
  combinations across all 9 brands (see "Promotion Request module"
  section further down for the full breakdown).
- **Account system, security, and TG Reply Threads have all been through
  multiple rounds of real fixes this session** — session-token auth
  (replacing plaintext-password-in-localStorage), reworked auto-lock
  logic (per direct business-owner feedback, twice), a Security Alerts
  routing row, and a whole attachment/photo/video-viewing feature (with
  its own dedicated incident write-up — a real Cloudflare KV quota
  outage was hit, root-caused, and fixed). All of this is detailed in
  the sections below — this top summary intentionally doesn't repeat
  every detail, just orients a new conversation to "this is live,
  working, and has real history," not "starting from scratch."
- **Known open items** — see "Still pending" near the end of this
  document for the current, accurate list. The single most urgent one:
  the business owner subscribed to **R2 Paid** by mistake (doesn't help)
  instead of **Workers Paid** (the subscription that actually removes
  the Workers KV daily quota caps that have interrupted testing multiple
  times) — not yet corrected as of this writing.

**This version was rewritten from scratch** (not incrementally appended)
to describe the system as it stands *right now* — it supersedes every
earlier version of this document. If you need the history of exactly how
something got to its current state, that's in the conversation
transcript this doc came from (and in several dedicated `CHANGES.md`
write-ups exported during this session — e.g.
`master_attachment_and_quota_fix_export.zip` for the full attachment-
viewing + KV-quota-incident story), not here.

## What this is
A web form → Telegram bot + Google Sheets ticketing system for PKR-market
CS teams (Crickex, Betjili, Mostplay, Jeetwin, Sbj66, Heybaji, Superbaji,
KV8, Darazplay), plus a full two-way Telegram reply-tracking dashboard
("TG Reply Threads") with its own per-agent account system (login,
office-based IP allowlists, role hierarchy), a Promo Code Search
dashboard, and a live-editable Telegram routing admin page ("TG Group /
Channel"). Deployed on Cloudflare Pages.

- **GitHub repo:** `HeyVIP-PKR/TBC` — code uploaded, live
- **Live URL:** `pkrcsteam-tbc.pages.dev`
- **Deploy method:** GitHub web upload (drag the `public/` and `functions/`
  folders themselves into "Add file → Upload files", not their contents —
  wrong drag depth repeatedly caused duplicate/misplaced files early on,
  and separately, editing a large file via GitHub's inline line-editor
  instead of a full overwrite once caused old/new code to get
  concatenated together and broke the site — see the KV-quota-incident
  write-up further down. Always do a full-file overwrite for anything
  beyond a one-line tweak.)
- **Deployment note:** the project has a `wrangler.toml` committed to the
  repo. Once that file exists, Cloudflare treats it as the source of truth
  for **Production** bindings — the dashboard's "+ Add" button for
  Production gets disabled (Preview still works via dashboard). To add/change
  a binding, edit `wrangler.toml` and re-upload; Cloudflare auto-applies it
  to Production on the next deploy. `wrangler.toml`'s `bucket_name` and KV
  `id` are filled in with the real PKR R2 bucket (`pkr-issuescreenshot`) /
  KV namespace (`pkr-ticket-threads`, id
  `c8ca68f7781a4f1b88d0997af023aec7`) — created under the `HeyVIP-PKR`
  Cloudflare account, fully separate from the INR build's.


## Architecture
- **Frontend:** static HTML/CSS/JS in `public/` — no build step
- **Backend:** Cloudflare Pages Functions in `functions/`
- **Google Sheets writes:** service account
  `pkr-tbc@tonal-unity-503006-u6.iam.gserviceaccount.com`
  (must be shared as Editor on every new Sheet used)
- **File storage:** R2 bucket `pkr-issuescreenshot`, bound as
  `SCREENSHOTS_BUCKET`, served back out via `/api/screenshot/<key>`
- **KV storage:** Cloudflare KV namespace `pkr-ticket-threads`, bound as
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
  `SESSION_TOKEN_SECRET` (signs/verifies login session tokens — see
  "Account system" below for the security fix this belongs to; login
  fails outright without this secret set).
  **Not yet set, optional:** `SECURITY_ALERTS_CHAT_ID` and
  `SECURITY_ALERTS_TOPIC_ID` — see "Unrecognized-IP login alerts" under
  Account system below; the feature silently no-ops until these exist.

## Key files
| File | Purpose |
|---|---|
| `public/assets/schemas.js` | Brand list (PKR — order: Crickex, Betjili, Mostplay, Jeetwin, Sbj66, Heybaji, Superbaji, KV8, Darazplay) + every module's form fields — note Promotion Request's brand-specific amounts/options still reference old INR brand ids, see top section |
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
| `functions/_shared/routing.js` | Per-brand/module Telegram + Sheet config — brand key order now matches schemas.js (crickex, betjili, mostplay, jeetwin, sbj66, heybaji, superbaji, kv8, darazplay); all `sheetId`/`chatId`/`topicId` currently placeholder, see top section |
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

### 🆕 Incoming Telegram replies with a photo/file are ALSO now
viewable (fixed this session, PKR — found while testing the outgoing
fixes above)
Everything above (this section and the next) only fixed attachments
going OUT — sent by an agent from our own website (the reply box or the
original ticket form). There's a completely separate, third path:
someone replying **inside the Telegram group itself** with a photo/file.
`functions/api/telegram-webhook.js`'s `handleUpdate()` used to just
hardcode the literal text `"(attachment)"` for these — no `file_id`
captured, no way to ever view it, regardless of any of the fixes above.
Fixed the same way as the other two directions: now extracts the
`file_id` from whichever of `msg.photo`/`msg.document`/`msg.video`/
`msg.voice`/`msg.sticker` is present, stores it as `attachmentFileId` on
the message record (same field name/shape the dashboard already knows
how to render — `public/threads.html`'s message-bubble template doesn't
care which direction a message came from, so **no frontend change was
needed at all**, just this one backend file). Also swapped the fallback
caption text from the literal `"(attachment)"` string to `"📎 <filename>"`
when there's no caption, matching the wording used elsewhere.

### 🆕 Attachments now load automatically, inline — no click needed
(changed this session, PKR, after initial feedback on the click-to-view
version below)
The click-to-view button design (described in the next section) worked,
but the business owner wanted photos/videos to just appear the moment a
ticket is opened, not require clicking a button first. Changed
`public/threads.html` so every attachment slot (ticket summary card +
each reply bubble) auto-loads on render instead of waiting for a click —
`loadInlineAttachments()`, called at the end of both `renderDetail()` and
`updateThreadContent()`, scans for `.inline-attach-slot` placeholders and
fills each with a real `<img>`/`<video>`/download-link element.

The one thing this needed extra care for: the thread view re-renders
from scratch every ~6s (polling), so a naive "fetch on every render"
would spam Telegram's `getFile` API every poll for every visible
attachment — added a page-level `attachmentCache` (`Map<fileId,
Promise<{url,type}>>`) so a given fileId is only ever actually fetched
once per page session; every subsequent render (or a lightbox click on
the same image, for a fullscreen look) reuses the cached object URL
instantly. `viewAttachment()` (the fullscreen lightbox — still there,
now reachable by clicking an inline thumbnail) was updated to pull from
this same cache instead of doing its own separate fetch.

### 🆕 Reply attachments are now viewable from the dashboard (fixed
this session, PKR — went through two design iterations, see below)
An agent replying with a photo/file in the Threads panel used to only
ever send it to Telegram — nothing about it was saved on our own side,
so the sidebar just showed a permanent, unclickable "📎 attachment" label
with no way to see it again without going and finding it in the Telegram
group itself.

**First attempt (superseded, not what shipped):** upload a copy to the
same R2 bucket the original ticket-submission screenshots use. Discussed
with the business owner, who preferred not to use any extra storage for
this — so this approach was reverted before deploying.

**What actually shipped:** zero storage, fully live/on-demand instead.
`functions/api/threads/[id].js`'s `sendTelegramAttachment()` now also
captures Telegram's own `file_id` from the `sendPhoto`/`sendDocument`
response (previously discarded) and saves it as a new `attachmentFileId`
field on the message record — nothing else. A new endpoint,
`functions/api/attachment/[fileId].js`, resolves that file_id back into
real bytes ONLY at the moment someone actually clicks to view it (via
Telegram's `getFile` + file-download API, proxied through so
`TELEGRAM_BOT_TOKEN` never reaches the browser — same reasoning as why
R2 files go through `/api/screenshot/<key>` instead of a raw bucket URL).
`public/threads.html` renders the attachment tag as a button that opens
a lightbox modal (`viewAttachment()`), fetches the image live via
`authFetch`, and displays it — non-image files (PDFs etc.) just trigger
a normal download instead of a preview. Deliberately login-gated but
NOT brand-scoped (any logged-in agent can view any attachment if they
have its file_id — acceptable since file_ids are long opaque
Telegram-issued strings, not guessable/enumerable, and only ever surface
via thread data an agent could already see).

Trade-offs of this approach, worth knowing:
- Slightly slower to open than a stored copy would be (proxies through
  Telegram live — typically well under a second, but not instant).
- Relies on Telegram itself still being able to resolve the file_id —
  generally reliable for as long as the source message/file exists on
  Telegram's servers, but that's Telegram's behavior, not something this
  code guarantees; a resolution failure surfaces as a clean error in the
  lightbox rather than a broken image.
- **Old messages sent before this fix still show the old, non-clickable
  label** (now with a tooltip explaining why) — they never captured a
  file_id in the first place, so there's nothing to look up. Only
  replies sent after this fix have a working preview.
- Uses zero R2/storage budget — the trade-off is a live Telegram round
  trip on each view instead, which was the explicit point of choosing
  this design.

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

### 🔒 Security fix — plaintext password in localStorage replaced with
signed session tokens (2026-07-20)

**Incident:** a coworker (IT) found the login password in plaintext via
browser DevTools (F12 → Application → Local Storage) within about a
minute of looking. Root cause: the original design (see the account
locking section below, and the old DESIGN NOTE this replaced) stored the
agent's actual password in `localStorage` and re-sent it on every
request via `X-Agent-User`/`X-Agent-Pass` headers — this was independent
of server-side hash strength; the password itself sat in the clear in
the browser, readable by anyone with access to an already-logged-in
device.

**Fix — signed session tokens, ported from a same-day INR fix:**
- Login now issues a signed token (HMAC-SHA256 over
  `{username, tokenVersion, iat, exp}`, signed with a new Cloudflare
  secret `SESSION_TOKEN_SECRET`) instead of the account handing back
  anything password-shaped — see `issueToken()`/`verifyToken()` in
  `functions/_shared/accounts.js`.
- The browser stores ONLY this token (`localStorage`'s `agentAuth.token`,
  never `.password` again) and sends it as `X-Agent-Token` on every
  request instead of `X-Agent-User`/`X-Agent-Pass`.
- Every account record gained a `tokenVersion` field, bumped by
  `saveAccount()` on password change and by `setAccountLocked()` on both
  lock AND unlock — `verifyRequest()` rejects any token whose embedded
  version doesn't match the account's current one, so an old token
  becomes worthless the instant a password changes or the account gets
  locked/unlocked, same guarantee the old plaintext-resend design had.
- Tokens hard-expire after 12h regardless (`TOKEN_TTL_MS`), independent
  of the client-side 2h idle timeout already in `authguard.js`.
- Self-service password change (`account/change-password.js`) issues a
  fresh token in the same response, so changing your own password
  doesn't immediately log you out (the change itself just bumped
  `tokenVersion`, which would otherwise invalidate the very token the
  request came in on).

**Files touched** (ported file-for-file from an INR-side fix, diffed
line-by-line against this PKR fork before merging — no PKR-specific
divergence was lost): `functions/_shared/accounts.js`,
`functions/api/auth/login.js`, `functions/api/account/change-password.js`,
`public/assets/authguard.js`, `public/login.html`,
`public/accounts-admin.html`, `public/index.html`, plus doc-comment-only
touches (no logic change) in `functions/api/threads.js` and
`functions/api/threads/[id].js`.

**Before deploying this: add the new secret.** Cloudflare project →
Settings → Environment variables → Production → add
`SESSION_TOKEN_SECRET` (any long random string, type Secret). Without
this, `issueToken()`/`verifyToken()` throw/fail closed rather than
silently signing with a guessable key — meaning login will outright fail
until this secret exists, not silently misbehave.

**After deploying:** every already-logged-in browser gets logged out
once (old `agentAuth.password` in localStorage doesn't map to anything
this version reads) — expected, not a bug, no account data is affected,
just log back in once.

**What this fix does NOT cover** (still needs separate handling, a token
fix can't substitute for it): the actual password the coworker already
saw needs changing (same as any other exposed credential), and it's
worth treating every other secret that could plausibly have been visible
on that same device/session as exposed too and rotating it —
`TELEGRAM_BOT_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`,
`TELEGRAM_WEBHOOK_SECRET`, `BRAND_EDIT_PASSWORD`. None of those were
touched by this fix; it only closes the specific plaintext-in-localStorage
hole.

### 🆕 Account locking — manual + two auto-lock triggers (built this
session)

A `locked` boolean (plus `lockedAt`, `lockedReason`) now lives on every
account record. A locked account is rejected everywhere — login
(`api/auth/login.js`) AND every already-open browser session on every
subsequent request (`verifyRequest()` in `_shared/accounts.js` — since
locking bumps `tokenVersion`, see the session-token security fix above,
a browser holding a token issued before the lock stops working on its
very next request even though the token itself hasn't expired). The
locked check runs BEFORE the tokenVersion/signature checks in
`verifyRequest()`, which also saves real CPU time on every request
against a known-locked account (see the PBKDF2/CPU-limit writeup above,
which is about login's own hash check, a separate cost from this).

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

### Role hierarchy — Owner / SuperAdmin / Admin / Senior / Agent
(2026-07 redesign — added Owner above SuperAdmin.)

Every tier's authority is now ONE rule, not a hand-maintained allow-list:
**an actor may act on a target only if the actor's rank is STRICTLY
GREATER than the target's rank.** Same rank can never manage same rank —
this is what makes "SuperAdmin can't touch another SuperAdmin, only
Owner can" fall out for free.

| Capability | Agent | Senior | Admin | SuperAdmin | Owner |
|---|---|---|---|---|---|
| Reset own password | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reset an Agent's password (assisted) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Reset a Senior's password (assisted) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Reset an Admin's password (assisted) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Reset a SuperAdmin's password (assisted) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Create an Agent account | ❌ | ✅ | ✅ | ✅ | ✅ |
| Create a Senior account | ❌ | ❌ | ✅ | ✅ | ✅ |
| Create an Admin account | ❌ | ❌ | ❌ | ✅ | ✅ |
| Create a SuperAdmin account | ❌ | ❌ | ❌ | ❌ | ✅ |
| Create an Owner account | ❌ | ❌ | ❌ | ❌ | ❌ (nobody — see below) |
| Delete an Agent/Senior account | ❌ | ❌ | ✅ | ✅ | ✅ |
| Delete an Admin account | ❌ | ❌ | ❌ | ✅ | ✅ |
| Delete a SuperAdmin account | ❌ | ❌ | ❌ | ❌ | ✅ |
| Lock / unlock an Agent/Senior/Admin account | ❌ | ❌ | ❌ | ✅ | ✅ |
| Lock / unlock a SuperAdmin account | ❌ | ❌ | ❌ | ❌ | ✅ |
| Edit role / office / brands / Topic Access of an Agent/Senior/Admin | ❌ | ❌ | ❌ | ✅ | ✅ |
| Edit role / office / brands / Topic Access of a SuperAdmin | ❌ | ❌ | ❌ | ❌ | ✅ |
| Log in from any IP (no office/whitelist needed) | ❌ | ❌ | ❌ | ❌ (changed — used to be ✅) | ✅ |
| View Agent Profile table | ❌ | ❌ | ✅ view | ✅ view | ✅ view |
| See that an Owner account exists at all | ❌ | ❌ | ❌ | ❌ | (n/a — only sees itself) |

**Owner is not a role anyone can be promoted to, ever, through the app.**
`saveAccount()` in `_shared/accounts.js` hard-refuses `role: "owner"` in
any create/edit request regardless of the caller's rank
(`ASSIGNABLE_ROLES` excludes it), and `functions/api/admin/accounts.js`
rejects it explicitly too, before anything else runs. The only way an
owner account exists is a **direct Cloudflare KV write**, outside the
app entirely (`wrangler kv key put --namespace-id=<THREADS_KV id>
"account:<username>" '<json>'` — ask Claude for the exact command +
password-hash generation when setting this up).

**Owner accounts never appear in ANY account listing** —
`listAccounts()` filters them out at the source, so `GET
/api/admin/accounts` never returns one, for any caller including
SuperAdmin. A `save`/`delete`/`lock`/`unlock` request that names an
*existing* owner account as its target (by username) gets back the
exact same `404 "Account not found"` a nonexistent username would —
never a `403` — so there's no way to distinguish "doesn't exist" from
"exists but you can't touch it."

SuperAdmin self-promotion bootstrap (unrelated to and unaffected by the
Owner tier): while zero SuperAdmin accounts exist anywhere, any
Admin-or-above account can promote ONLY its own account to `superadmin`
(via `accounts-admin.html` or index.html's Account Management → Agent
Profile) — the instant one SuperAdmin exists, this path closes for good.


### ✅ Office/IP rule — CHANGED this session: SuperAdmin is now the ONLY
role exempt from needing an office

**Old behavior:** an account with no `officeId` had no IP restriction at
all — could log in from anywhere, for any role. Easy to forget and
accidentally leave an account wide open.

**New behavior**, requested directly by the business owner after
confirming they understood the trade-off: `officeIpCheckPasses()` in
`_shared/accounts.js` — **SuperAdmin can still log in from anywhere,
office or not** (deliberate, so there's always at least one way to reach
admin tools remotely). **Every other role (Agent/Senior/Admin) with no
office now fails to log in outright.** This is shared by both
`verifyRequest()` (every protected endpoint) and `auth/login.js` (the
login form itself) via one function, so the two can't drift out of sync.

**Accepted trade-off, stated explicitly to the business owner:** if the
very first Admin-tier account (before any SuperAdmin exists) has no
office, that account is now locked out of everything, including its own
SuperAdmin self-promotion path — no in-app recovery, only a direct
Cloudflare KV edit. **Always assign an office to every non-SuperAdmin
account — login will fail without one, not just be unrestricted.**

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

### Confirmed — Crickex intentionally shares its Telegram group with INR
Crickex's chatId (`-1004488354399`) is the same group used by the INR
production deployment — confirmed with the business owner this is
deliberate, not an accidental copy-paste: INR and PKR share one
Telegram group for this brand, split apart by Topic ID (INR's topics are
3/10/17/30/22/24 per module; PKR's Crickex topics are 3/10/17/22/24/26 —
different topic numbers within the same group). Not a data-mixing risk
the way the KV namespace / R2 bucket sharing would have been (see the
top-of-file warning) — Telegram topics fully separate the message
threads visually, it's a shared mailbox, not shared storage. No action
needed; noted here so a future reader doesn't mistake this for the same
kind of environment-mixing mistake that was avoided elsewhere (KV/R2/
GitHub repo/Cloudflare project are all still fully separate from INR, per
the top-of-file warning — only this one brand's Telegram group is
intentionally shared).

### 🆕 Security Alerts row (built this session, PKR)
Below the 9-brand list (visually separated by a dashed divider) there's
now a 10th, non-brand entry: **🔒 Security Alerts**. Clicking it shows a
single chatId/topicId row (not 6 module rows) controlling where
`functions/api/auth/login.js`'s two Telegram warnings go — unrecognized-
IP login attempts (correct password, IP not on the account's office
whitelist) and account auto-lock notices. Same Save/Reset UI, same KV
layer underneath (reuses `_shared/routes.js` unchanged, via the reserved
pseudo id pair `brandId: "_security"`, `moduleId: "alerts"` — not a real
brand, can't collide with one). `resolveSecurityAlertsRoute()` in
`login.js` checks this KV override first, falls back to the
`SECURITY_ALERTS_CHAT_ID`/`SECURITY_ALERTS_TOPIC_ID` Cloudflare secrets
(still unset for PKR — see "Still pending" below) if nothing's been saved
through this panel yet. Point of this: changing where security alerts go
no longer needs a Cloudflare secret edit + redeploy, same live-editable
convenience as brand routing already had.


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

## Still pending / needs input before it can be finished (PKR)

1. **⚠️ Subscribe to Workers Paid — top priority, not yet done.** The
   business owner subscribed to **R2 Paid** by mistake, thinking it would
   fix the KV quota errors — it doesn't; R2 Paid only affects R2 storage,
   completely separate from Workers KV's own daily limits. **Workers
   Paid** ($5/month, a different subscription) is what actually removes
   the `list()`/write/etc. daily caps on Workers KV. Testing has now been
   interrupted multiple times by hitting these free-tier limits
   (`KV put() limit exceeded for the day` — see the write-up above for
   the full incident). Strongly recommended to just subscribe rather than
   keep working around free-tier caps.
2. **Rotate exposed credentials** — a coworker saw the login password in
   plaintext before the session-token fix went in (that fix is deployed
   and working now, per the auto-lock/login rework described above, but
   it doesn't undo exposure that already happened). Still needs actual
   rotation: the password itself, and out of caution
   `TELEGRAM_BOT_TOKEN`/`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`/
   `TELEGRAM_WEBHOOK_SECRET`/`BRAND_EDIT_PASSWORD` too, since they could
   plausibly have been visible on the same device/session.
3. **Not yet fully tested end-to-end across all 9 brands.** Individual
   pieces have been tested successfully (submissions, Telegram delivery,
   Sheet writes, TG Reply Threads sync, attachment viewing, Promotion
   Request) but mostly on Crickex/Sbj66/a couple others — worth a
   deliberate pass confirming every brand's chatId/topicId/sheetId
   actually works, not just the ones tested so far.
4. **Promo Code Search** — same unresolved items as the INR build this was
   forked from, never revisited: "Start On" column has no source data
   (always "—"); "all 11 tabs share the same A–N layout" is unverified
   beyond one reference tab; also worth confirming the existing
   `"Retention Team (PKR)"` tab is the one this dashboard should search.
5. **`GET /api/screenshot/<key>` and `GET /api/brand-config`** — no login
   gate, pre-existing from the INR build, flagged for awareness only,
   never addressed.
6. **Optional, not requested yet**: videos currently send to Telegram via
   `sendDocument` (shows as a downloadable file in Telegram's own UI, not
   a native inline video player) — works fine for viewing in OUR OWN
   dashboard (fixed this session), just not "native-looking" on the
   Telegram side. Would need a `type.startsWith("video/")` branch calling
   `sendVideo` instead, in both `submit.js` and `threads/[id].js`, if
   ever wanted.

**Done so far** (moved here from the old checklist so this section stays
an accurate snapshot, not a stale plan): GitHub repo created and code
uploaded (`HeyVIP-PKR/TBC`); Cloudflare Pages project deployed and live
(`pkrcsteam-tbc.pages.dev`, deploys green); R2 bucket
(`pkr-issuescreenshot`) and KV namespace (`pkr-ticket-threads`, id
`c8ca68f7781a4f1b88d0997af023aec7`) created and wired into
`wrangler.toml`; Cloudflare secrets set (`TELEGRAM_BOT_TOKEN`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`,
`BRAND_EDIT_PASSWORD`, `TELEGRAM_WEBHOOK_SECRET`); Google Cloud service
account created (`pkr-tbc@tonal-unity-503006-u6.iam.gserviceaccount.com`);
first superadmin account bootstrapped and login confirmed working;
Telegram webhook set (`setWebhook` returned `ok:true`); TG Group/Channel
admin panel confirmed showing all 9 PKR brands correctly. Various
INR→PKR content swaps done: topbar/title wordmarks, `CURRENCY_LABEL`
(→"PKR" suffix on brand names in Telegram messages), QA module's
`default` template gained a Brand/Platform row, Aadhar/Pan Card fields
relabeled to CNIC Card Number. KV `list()` daily-quota fix ported
(2-minute server cache + 800/day hard cap in `threads.js`, sidebar
polling split to 6s/30s in `threads.html`).

**Also done since the paragraph above** (this project has had a LOT of
follow-up work — summarizing chronologically so nothing gets lost):
9 brands' real `chatId`/`topicId` filled into the TG Group/Channel panel
and real `sheetId`s filled into `routing.js` for all 9 brands (Google
Sheets shared with the service account); Promotion Request fully
configured — 19 confirmed brand+promotion combinations across all 9
brands with real fixed/tiered amounts, `PROMOTION_ROWS_PKR` Telegram
template, cross-checked by script for consistency (see "Promotion
Request module" section further down); Risk Issue's `Remark` row and
Account Issue's `Username` row each got a `skipIfEmpty`-style fix so they
stop printing placeholder junk when unused; a "🔒 Security Alerts" row
was added to the TG Group/Channel panel (KV-override based, same pattern
as brand routing, falls back to `SECURITY_ALERTS_CHAT_ID`/
`SECURITY_ALERTS_TOPIC_ID` env vars); login's auto-lock logic was
reworked twice per direct business-owner feedback — "no office assigned"
no longer shares the same lock-counter as genuine security events (but
still alerts), and wrong-password + unrecognized-IP failures were merged
into ONE combined 5-in-an-hour counter (previously two separate,
inconsistent triggers); the home page's unread-ticket badge was fixed
(was silently failing on an unauthenticated `fetch()` call, a leftover
from the session-token migration); all 9 brand logos were added.

**Attachment/photo/video viewing — a whole feature built this session,
in stages, fully documented with its own exported changelog** (see
`master_attachment_and_quota_fix_export.zip` in this conversation's
outputs for the complete blow-by-blow — worth reading in full if picking
this back up, it went through several design iterations): agents can now
see photos/videos/files directly in the TG Reply Threads dashboard —
both what THEY send (from the reply box, or attached to the original
ticket form) and what comes back the OTHER direction (someone replying
with a photo directly inside the Telegram group itself). Deliberately
built with ZERO extra storage (business owner's explicit call, after an
R2-based first draft was tried and reverted) — Telegram's own `file_id`
is captured at send time, and a new endpoint
(`functions/api/attachment/[fileId].js`) resolves it back into real
bytes live, on demand, proxied through so the bot token never reaches
the browser. Went from "click a button to view" to "loads automatically
the instant a ticket opens" per business-owner feedback, with a
page-level cache (`attachmentCache` in `threads.html`) so the 6-second
poll doesn't re-fetch the same image over and over. Two real bugs were
found and fixed along the way: (1) the "is this an image?" check only
looked at browser-reported MIME type, which is sometimes wrong/empty for
re-uploaded files — fixed with a filename-extension fallback
(`looksLikeImage()`), applied on both the send side and, separately, on
the `/api/attachment/[fileId].js` retrieval side (which needed the
ORIGINAL filename passed as `?name=` to guess correctly, since
Telegram's own internal file path for "document"-type uploads often
doesn't carry a usable extension).

**A real Cloudflare KV quota incident, root-caused and fixed this
session** — worth understanding fully before touching this area again.
Testing hit `"KV put() limit exceeded for the day"` (a genuinely
different, independent quota from the `list()`-call quota fixed
earlier). Root cause: the standalone `cron-worker` (the one that
refreshes the sidebar cache on a schedule, deployed separately from this
Pages project) writes to KV twice on every single run regardless of
whether anything changed — at its original 2-minute interval, that's
720 × 2 = 1,440 writes/day from the cron job ALONE, already over the
free tier's 1,000/day cap, before counting a single real ticket
submission/reply/solve-toggle. This was a genuine miscalculation when
the cron job was first built — only the `list()`-call budget was checked
at the time, not the separate write budget. Fixed in two parts: (1) the
cron interval was raised to 10 minutes (`cron-worker/wrangler.toml`,
`LIST_CACHE_TTL_MS` in `threads.js` — both must stay in sync) as an
immediate stopgap, cutting the cron's own writes to ~288/day; (2) the
REAL fix — a new `patchListCache()` function in `_shared/threads.js`
that surgically updates the cached sidebar list the INSTANT a ticket is
created/replied-to/solved/deleted, completely decoupling "how fast does
MY OWN action show up" from "how often does the background cache do a
full re-scan." This was necessary because the business owner correctly
pushed back hard on "a new ticket can take up to 10 minutes to appear"
being genuinely unacceptable for a live CS team — lowering the cron
interval alone was the wrong fix for that complaint; instant-patching on
every real action was the right one, and it scales with actual usage
instead of a fixed background cost.

**A deployment-process lesson learned the hard way, not a code bug**: at
one point, editing a large file directly in GitHub's web line-editor
(instead of a full-file "Add file → Upload files" overwrite) resulted in
old and new code getting concatenated together — e.g. a duplicate
`const contentType =` declaration — which is a hard JavaScript syntax
error, and broke every endpoint importing that file (500 errors
site-wide) until caught and fixed. Lesson: for any file with substantial
structural changes (not a one-line tweak), always do a full-file
overwrite via upload, never GitHub's inline editor.

**Billing mix-up, not yet resolved**: the business owner subscribed to
**R2 Paid** (thinking it was the fix for the KV quota errors) — R2 Paid
only affects R2 storage quotas and has NO effect on Workers KV's
separate daily limits. **Workers Paid** (a different subscription,
$5/month) is what actually removes the KV `list()`/write/etc. daily caps
— this has NOT been subscribed to yet as of this writing. Given how many
times testing has now been interrupted by hitting these free-tier caps,
subscribing to Workers Paid is a strong recommendation, not just a
nice-to-have — see "Still pending" below.

1. **Deploy the standalone `cron-worker`** — a separate Cloudflare Workers
   project (not part of this Pages project/zip), ported from the INR
   build's `list()`-quota fix. Refreshes the TG Reply Threads sidebar
   cache every 2 minutes on its own schedule instead of relying on a page
   request to notice the cache is stale. `wrangler.toml` inside it is
   already pointed at PKR's real KV namespace
   (`c8ca68f7781a4f1b88d0997af023aec7`) — see its own `README.md` for the
   one-time web-UI deploy steps (new Worker, paste in `worker.js`, bind
   `THREADS_KV`, add a `*/2 * * * *` Cron Trigger). Not deploying this
   isn't a functional blocker — `threads.js`'s own request-triggered
   fallback (2-minute throttle + 800/day hard cap) keeps the sidebar
   working either way — but leaving it undeployed means the sidebar
   relies on that fallback alone rather than the cleaner, gap-free
   dedicated schedule.
2. **For each of the 9 brands, get real Telegram chatId/topicId and fill
   them into the TG Group/Channel admin panel** (`index.html` → Account
   Management → TG Group Channel — changes apply immediately, no redeploy
   needed, so `routing.js`'s own DEFAULT values can stay blank). None of
   the 9 brands have real values set yet — one attempted chatId turned
   out to belong to the INR production group by mistake and was correctly
   NOT used. Get chatId via the bot's `getUpdates` API after posting in
   each group/topic (see `routing.js` file header for the exact method).
3. **For each brand that needs sheet logging, create/duplicate a Google
   Sheet, share it with the service account email
   (`pkr-tbc@tonal-unity-503006-u6.iam.gserviceaccount.com`, Editor
   access), and fill its `sheetId` into `routing.js`.** All 9 brands now
   have a real `sheetId` filled into `routing.js` (done this session).
   **Not yet confirmed:** whether all 9 sheets have actually been shared
   with the service account email yet, and whether each sheet's tab names
   exactly match what the code expects (`QA OTP & Domain`, `Account
   Issue`, `Risk Issue`, `Genie Issues`, `Daily Report` — see
   `SHEET_LAYOUT` in `routing.js`) — worth a real end-to-end test
   submission on at least one brand (e.g. Crickex) before assuming the
   rest are correct too.
4. ~~**Promotion Request module**~~ — ✅ fully configured this session, 19
   brand+promotion combinations, all confirmed with real business data
   (see top section for details). Not yet live-tested against a real
   submission though — worth including in the end-to-end test pass
   mentioned in item 3 above once at least one brand's Telegram routing
   is also live.
5. ~~**Brand logos**~~ — ✅ done this session, all 9 brands have real
   logo files now (see top section). Nothing pending here anymore.
6. **Promo Code Search** — same unresolved items as the INR build this was
   forked from: "Start On" column has no source data (always "—"); "all 11
   tabs share the same A–N layout" is unverified beyond one reference tab;
   also worth confirming with the business owner that the existing
   `"Retention Team (PKR)"` tab is the one this dashboard should search.
7. **`GET /api/screenshot/<key>` and `GET /api/brand-config`** — no login
   gate, pre-existing from the INR build, flagged for awareness only.
8. **Not yet live-tested end-to-end** — login works, but submit → Telegram
   → sheet logging → reply sync hasn't been tested against real data yet
   since no brand has real chatId/sheetId filled in. Worth a full pass
   once at least one brand (e.g. Crickex) has real values, before rolling
   out to agents.

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


