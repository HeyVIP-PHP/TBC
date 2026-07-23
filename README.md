# Issue Submission Hub → Telegram

A small static site + Cloudflare Pages Function that takes form submissions
(QA, Account Issue, Promotion Request, Daily Report, Genie Issue) and posts
a formatted message to the right Telegram group/topic for the brand.
Selected modules also get logged to that brand's Google Sheet.

```
public/                  ← static site (deployed as-is, no build step)
  index.html              hub page (the card grid)
  form.html                generic form, driven by ?module=<id>
  assets/schemas.js        brands + field definitions (PUBLIC, no secrets)
  assets/app.js             renders the form + calls /api/submit
  assets/style.css
functions/
  api/submit.js            the API route: Telegram + optional Sheet log
  _shared/routing.js        SERVER-ONLY: chat IDs, topic IDs, sheet URLs
google-apps-script/
  sheet-logger.gs           paste into Apps Script for sheet logging
wrangler.toml
```

## 1. Drop this into your existing repo

Copy `public/`, `functions/`, `google-apps-script/`, and `wrangler.toml`
into your repo (merge folders if you already have a `functions/` dir).
Commit and push — if the repo is already connected to Cloudflare Pages,
this alone triggers a deploy.

## 2. Set the bot token as a secret

In the Cloudflare dashboard: **Pages → your project → Settings →
Environment variables** → add `TELEGRAM_BOT_TOKEN` (your existing bot's
token) for both **Production** and **Preview**, marked as a secret.
Nothing else needs an env var — chat/topic routing lives in code (step 3).

For local dev only, `wrangler pages dev public --binding TELEGRAM_BOT_TOKEN=<token>`
or add it to a `.dev.vars` file (already gitignored).

## 3. Fill in real routing

Open `functions/_shared/routing.js`. For each brand, replace the
`-100XXXXXXXXXX` placeholders with real values:

- **chatId** — the group's chat ID (same for every topic in that group).
- **topicId** — the topic's `message_thread_id`, or `null` to post to the
  group's General thread.

To find these: add the bot to the group, turn on **Topics** if you're
using them, send one message in the target topic, then open
`https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser — the JSON
response has `chat.id` and `message_thread_id`.

Since one brand can span several groups/topics, you can point each module
(`qa`, `account_issue`, `promotion_request`, `daily_report`, `genie_issue`)
at a different `{ chatId, topicId }` independently — they don't have to
share a group.

## 4. Rename brands

Brand keys must match in two places:
- `public/assets/schemas.js` → `BRANDS` (shown in the dropdown)
- `functions/_shared/routing.js` → `BRANDS` (routing + sheet URL)

Rename `brand2`…`brand5` to your real 5 INR brands (keep `betvisa` or
rename it too) — just make sure both files agree on the key.

## 5. Turn on Google Sheet logging

Which modules get logged is controlled by `RECORD_TO_SHEET` in
`routing.js` — change it any time, independent of Telegram routing.

Logging goes straight to the Sheets API via a Google Cloud **service
account** (no Apps Script deployment, no per-brand webhook).

**One-time setup (shared by all brands):**
1. In Google Cloud Console, create (or reuse) a service account and
   download its JSON key.
2. In Cloudflare Pages → **Settings → Environment variables**, add two
   secrets for Production and Preview:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the `client_email` field from the JSON key
   - `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` — the full `private_key` field
     from the JSON key, including the `-----BEGIN PRIVATE KEY-----` /
     `-----END PRIVATE KEY-----` lines

**Per brand:**
1. Set that brand's `sheetId` in `routing.js` — the long ID in the
   sheet's URL: `https://docs.google.com/spreadsheets/d/<sheetId>/edit`.
2. Open that sheet → **Share** → add the service account's email
   (the same one as `GOOGLE_SERVICE_ACCOUNT_EMAIL`) as an **Editor**.
   Without this share step, writes fail with a 403.

Each module writes to its own tab, created automatically (with a header
row) the first time a submission for that module comes in — Account
Issue / Promotion Request / Daily Report / QA / Genie Issue rows never
mix.

`google-apps-script/sheet-logger.gs` is kept in the repo as a fallback —
only needed if you ever want a brand's sheet to work without sharing it
to the service account.

## 6. Test it

1. `wrangler pages dev public` (or just push and use the Cloudflare
   preview URL).
2. Open the hub, submit a test Account Issue.
3. Confirm the message lands in the right Telegram topic, and (if
   enabled for that module) a row appears in the sheet.

## Adding a 6th module later

Add an entry to `MODULES` in `schemas.js` (icon, description, fields),
add a matching key to `MODULE_META` and `RECORD_TO_SHEET` in
`routing.js`, and add a `telegram` route per brand. No other code
changes needed — the hub card and form page are both generated from
that config.

## Not built yet (future scope)

The reference screenshots also show **TG Reply Threads** (tracking
replies back from Telegram into the form) and **multi-search / backup
sheet search** tools. Those need a Telegram webhook endpoint
(`setWebhook`) and a read path back into your sheets — happy to build
those next if useful, just flag it.
