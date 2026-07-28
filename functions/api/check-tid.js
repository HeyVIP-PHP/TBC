/**
 * GET /api/check-tid?brand=<brandId>&tid=<tid>
 *
 * Withdraw Issue duplicate-TID guard — looks up whether this TID has
 * already been submitted for this brand, by reading directly from that
 * brand's "Withdraw Issue" Google Sheet tab. Deliberately reads the
 * SHEET, not our own KV thread records — thread records get cleaned up
 * / purged over time (see the Recall Chat History / auto-clean settings
 * elsewhere in threads.html), so they wouldn't reliably cover a TID
 * submitted a while ago. The Sheet is the durable, permanent record.
 *
 * Called from public/assets/app.js at two points: when the agent leaves
 * the TID field (onBlur — early warning before they fill out the rest
 * of the form), and again right before actually submitting (final
 * guard, in case the field was never blurred, or was changed back to a
 * once-already-flagged value without a fresh blur in between).
 *
 * Scoped to ONE brand only (whatever the form currently has selected) —
 * not a search across all 9 brands' sheets. TIDs are brand-specific
 * transaction identifiers; a match in a different brand's sheet
 * wouldn't mean anything here.
 *
 * Response shapes:
 *   { ok: true, found: false }
 *   { ok: true, found: true, date: "27/07/2026", pic: "Awais" }
 *   { ok: false, error: "..." }
 */
import { BRANDS, SHEET_LAYOUT } from "../_shared/routing.js";
import { batchGetValues } from "../_shared/googleSheets.js";
import { verifyRequest, canSeeBrand } from "../_shared/accounts.js";

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String((e && e.message) || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  const url = new URL(request.url);
  const brandId = url.searchParams.get("brand");
  const tid = (url.searchParams.get("tid") || "").trim();
  if (!brandId || !tid) return json({ ok: false, error: "Missing brand or tid." }, 400);

  const brand = BRANDS[brandId];
  if (!brand) return json({ ok: false, error: `Unknown brand "${brandId}".` }, 400);
  if (!canSeeBrand(account, brand.name)) return json({ ok: false, error: `You don't have access to ${brand.name}.` }, 403);

  // No Sheet bound for this brand, or Withdraw Issue's layout isn't set
  // up (SHEET_LAYOUT.withdraw_issue missing/misconfigured) — nothing to
  // check against. Reported as "not found" rather than an error so the
  // form's blur/submit checks don't show a scary red error for something
  // that isn't the agent's problem; this is effectively "duplicate
  // checking isn't available right now."
  const layout = SHEET_LAYOUT.withdraw_issue;
  if (!brand.sheetId || !layout || !layout.columns.includes("tid")) {
    return json({ ok: true, found: false });
  }

  const startCol = columnIndex(layout.startColumn);
  const tidCol = columnLetter(startCol + layout.columns.indexOf("tid"));
  const dateColIdx = layout.columns.indexOf("autoDate");
  const picColIdx = layout.columns.indexOf("pic");
  const dateCol = dateColIdx >= 0 ? columnLetter(startCol + dateColIdx) : null;
  const picCol = picColIdx >= 0 ? columnLetter(startCol + picColIdx) : null;

  // Row 2 onward (row 1 is headers) — one batchGet call fetches all the
  // columns we need in one round trip instead of three.
  const ranges = [`${layout.tab}!${tidCol}2:${tidCol}`];
  if (dateCol) ranges.push(`${layout.tab}!${dateCol}2:${dateCol}`);
  if (picCol) ranges.push(`${layout.tab}!${picCol}2:${picCol}`);

  const valueRanges = await batchGetValues(env, brand.sheetId, ranges);
  const tidValues = (valueRanges[0]?.values || []).map((r) => (r[0] || "").trim());
  let i = 1;
  const dateValues = dateCol ? (valueRanges[i++]?.values || []).map((r) => r[0] || "") : [];
  const picValues = picCol ? (valueRanges[i++]?.values || []).map((r) => r[0] || "") : [];

  const target = tid.toLowerCase();
  const matchRow = tidValues.findIndex((v) => v.toLowerCase() === target);
  if (matchRow === -1) return json({ ok: true, found: false });

  return json({ ok: true, found: true, date: dateValues[matchRow] || "", pic: picValues[matchRow] || "" });
}

// Same tiny letter<->index helpers _shared/googleSheets.js already has
// internally (not exported from there) — duplicated locally rather than
// exported+shared, matching this codebase's existing pattern of keeping
// each API route file's small helpers self-contained.
function columnIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function columnLetter(index) {
  let s = "";
  while (index > 0) {
    const rem = (index - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    index = Math.floor((index - 1) / 26);
  }
  return s;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
