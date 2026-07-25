# Optional: TG Reply Threads cache-warming cron worker

**You do not need this for the site to work.** Ticket submission, the
Telegram webhook, and an already-open conversation are all fully
real-time regardless. The only thing this affects is: how quickly a
*new* ticket (or a solved/reopened toggle) submitted by someone else
shows up in *your* sidebar, when nobody's actively been polling recently
enough to have already triggered a fresh scan on their own.

Without this deployed: worst case, up to ~10 minutes.
With this deployed: the cache refreshes every 10 minutes on its own
schedule, so in practice it's usually much less than that, even during
quiet periods with no one online.

## What it is

A **separate** Cloudflare Worker — not part of the main Pages project,
not built or deployed by the same `git push` that deploys the site. It
shares one file (`functions/_shared/threads.js`) with the main site via
a relative import, so there's no duplicated logic to keep in sync by
hand.

## Deploy via the Cloudflare dashboard (no command line)

This is the easier route if you don't want to install Node.js/Wrangler
— everything happens by clicking around in the browser.

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers**
   → **Create Worker**.
2. Give it a name, e.g. `telegram-issue-hub-cron` (doesn't have to match
   exactly, just something you'll recognize) → **Deploy** (it deploys a
   placeholder "Hello World" first — that's fine, next step replaces it).
3. Click **Edit code** (opens the online editor).
4. Select **all** the placeholder code in the editor and delete it.
5. Open **`dashboard-paste.js`** in this folder, copy its **entire**
   contents, and paste it into the editor.
6. Click **Deploy** (top right of the editor).
7. Bind the KV namespace — back on the Worker's overview page:
   **Settings** → **Variables and Bindings** (or **Bindings**, wording
   varies) → **Add binding** → type **KV Namespace**.
   - Variable name: `THREADS_KV` (must be exactly this, all caps)
   - KV namespace: pick **`php-ticket-threads`** — the exact same one
     the main site uses (check the main Pages project's Bindings page if
     you're not sure which one that is)
   - Save
8. Add the Cron Trigger — same Worker → **Settings** → **Triggers** →
   **Cron Triggers** → **Add Cron Trigger**.
   - Enter `*/10 * * * *` (every 10 minutes)
   - Save

Done. To confirm it's actually working: this Worker's overview page
shows its own `*.workers.dev` URL — open that directly in a browser, it
should respond with JSON like `{"refreshed":true,"count":12}`. If it
instead shows an error mentioning `THREADS_KV`, the binding in step 7
didn't save correctly — go back and check it.

## Deploy via command line (Wrangler)

Prefer this if you're already comfortable with a terminal, or want this
worker's deploys to go through the same `wrangler` flow as everything
else — this version imports `functions/_shared/threads.js` directly
(via `src/index.js`) instead of the copy-pasted `dashboard-paste.js`
above, so it can never drift out of sync with the main site's logic.

You'll need [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
installed (`npm install -g wrangler`) and logged in (`wrangler login`) —
same tool, same Cloudflare account as everything else in this repo.

1. From this `cron-worker/` folder (not the repo root):
   ```
   cd cron-worker
   wrangler deploy
   ```
2. That's it — `wrangler.toml` in this folder already has the KV
   binding and the `*/10 * * * *` (every 10 minutes) Cron Trigger
   configured. Wrangler reads both from this file automatically.

## Verifying it's actually running

- Cloudflare Dashboard → **Workers & Pages** → you should see a new,
  separate Worker called **`telegram-issue-hub-cron`** (distinct from
  the main `telegram-issue-hub` Pages project).
- Click into it → **Triggers** tab → confirm the Cron Trigger shows
  `*/10 * * * *` and is enabled.
- To test it immediately without waiting for the schedule: open that
  Worker's own `*.workers.dev` URL directly in a browser (shown on its
  overview page) — it responds to a plain GET with a JSON result showing
  whether the refresh succeeded, e.g. `{"refreshed":true,"count":12}`.
- **Logs**: same Worker's **Logs** tab (or `wrangler tail` from this
  folder) — every scheduled run logs a line starting with
  `[cron-worker]`.

## If you ever change the KV namespace

If the main site's `THREADS_KV` binding ever points at a different KV
namespace ID (e.g. switching currencies/markets, like this PHP copy
already did once), **update the `id` in this folder's `wrangler.toml`
to match** — the two must always point at the exact same namespace, or
this worker will silently be refreshing a cache nobody reads.

## If you ever change LIST_CACHE_TTL_MS

The `*/10 * * * *` schedule here is tuned to match
`LIST_CACHE_TTL_MS` in `functions/_shared/threads.js` (currently 10
minutes). If you change one, change the other to match — see that
constant's comment for the KV-quota math behind why 10 minutes was
chosen (shorter intervals blow through Cloudflare's separate, stricter
`list()` calls/day budget faster than you'd expect).
