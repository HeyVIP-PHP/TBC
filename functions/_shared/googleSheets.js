/**
 * googleSheets.js  (SERVER-ONLY)
 *
 * Appends a row to a Google Sheet using a service account — no Apps Script
 * deployment needed. Requires two Cloudflare secrets:
 *
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL         e.g. my-bot@my-project.iam.gserviceaccount.com
 *   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY   the full PEM private key from the
 *                                        service account's JSON key file
 *
 * And one thing you must do manually per brand sheet: open the sheet →
 * Share → add the service account's email as an Editor. Without that
 * share, the API calls below will fail with a 403.
 */

// Reused across requests within the same Worker isolate so we don't
// re-mint an OAuth token on every single submission.
let cachedToken = null; // { token, expiresAt }

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 30) {
    return cachedToken.token;
  }

  const clientEmail = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyPem = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!clientEmail || !privateKeyPem) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64urlFromBuffer(signature)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  // Check res.ok BEFORE parsing as JSON — same pattern as every other
  // fetch in this file. A slow/failing hop to Google's OAuth endpoint
  // (gateway timeout, etc.) can come back as a plain-text error page
  // like "error code: 504" instead of JSON; calling res.json() on that
  // directly throws an opaque "Unexpected token ... is not valid JSON"
  // that then gets wrapped by submit.js's top-level catch into a
  // confusing "Unexpected server error: ..." toast for the agent.
  // Reading as text first and reporting the real status/body gives a
  // clear, actionable error instead.
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Google OAuth token request failed (${res.status}): ${bodyText}`);
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Google OAuth token response was not valid JSON.");
  }
  if (!data.access_token) {
    throw new Error(`Google auth failed: ${JSON.stringify(data)}`);
  }

  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

/**
 * Appends `values` (an ordered array, one per column) into an EXISTING tab
 * that already has its own header row and column layout — used when the
 * brand's sheet already has tabs like "QA OTP & Domain" with fixed columns.
 * `startColumn` is the sheet's letter column the first value belongs in
 * (e.g. "B" if column A is unused, like in the reference sheet).
 */
export async function appendRowByColumns(env, sheetId, tabName, startColumn, values) {
  const token = await getAccessToken(env);
  const endColumn = columnLetter(columnIndex(startColumn) + values.length - 1);
  const range = `${tabName}!${startColumn}:${endColumn}`;

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const res = await sheetsFetch(appendUrl, token, { values: [values] });
  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
  }
  // `updates.updatedRange` looks like "BJ!A192:I192" — pull the row number
  // out of it so callers (submit.js) can remember exactly which row this
  // submission landed on, for editDetails() in threads/[id].js to update
  // later. Best-effort: a row is still successfully written even if this
  // parse fails for some reason, so callers must treat a null row as
  // "can't do row-level edits later", not as the append itself failing.
  let row = null;
  try {
    const body = await res.json();
    const updatedRange = body?.updates?.updatedRange || "";
    const match = updatedRange.match(/![A-Z]+(\d+):/);
    if (match) row = parseInt(match[1], 10);
  } catch {
    // Non-fatal — see comment above.
  }
  return { row };
}

/**
 * Same as appendRowByColumns() above (fixed column order, letter-addressed
 * range) EXCEPT the target tab doesn't have to exist yet — if the first
 * append 400s (tab missing), this creates it with `headers` as row 1, then
 * retries once. Use this instead of the plain appendRowToSheet() auto-
 * create path when you want a SPECIFIC tab name (not tied to the module
 * id) and nice human-readable column headers in a chosen order, rather
 * than whatever `Object.keys(row)` happens to produce. First user:
 * SHEET_LAYOUT.deposit_request in routing.js (tab "Deposit Request").
 */
export async function appendRowByColumnsWithAutoCreate(env, sheetId, tabName, startColumn, headers, values) {
  const token = await getAccessToken(env);
  const endColumn = columnLetter(columnIndex(startColumn) + values.length - 1);
  const range = `${tabName}!${startColumn}:${endColumn}`;
  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  let res = await sheetsFetch(appendUrl, token, { values: [values] });
  if (res.status === 400) {
    // Tab probably doesn't exist yet — create it with the given header
    // row (starting at the same `startColumn`, so headers line up with
    // the data columns this call is about to write), then retry once.
    await ensureTabWithHeaders(token, sheetId, tabName, headers, startColumn);
    res = await sheetsFetch(appendUrl, token, { values: [values] });
  }
  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
  }
  let row = null;
  try {
    const body = await res.json();
    const updatedRange = body?.updates?.updatedRange || "";
    const match = updatedRange.match(/![A-Z]+(\d+):/);
    if (match) row = parseInt(match[1], 10);
  } catch {
    // Non-fatal — see the matching comment in appendRowByColumns above.
  }
  return { row };
}

/**
 * Overwrites an already-written row in place (as opposed to
 * appendRowByColumns, which always adds a new one) — used by
 * editDetails() in functions/api/threads/[id].js so an edit made on the
 * website can update the exact same Sheet row the original submission
 * wrote to, instead of creating a duplicate. `row` is the 1-indexed
 * Sheets row number returned by appendRowByColumns() at submit time.
 */
export async function updateRowByColumns(env, sheetId, tabName, startColumn, row, values) {
  const token = await getAccessToken(env);
  const endColumn = columnLetter(columnIndex(startColumn) + values.length - 1);
  const range = `${tabName}!${startColumn}${row}:${endColumn}${row}`;

  const updateUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}?valueInputOption=RAW`;

  const res = await sheetsFetch(updateUrl, token, { values: [values] }, "PUT");
  if (!res.ok) {
    throw new Error(`Sheets update failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * For sheets with two side-by-side blocks sharing rows by date (e.g. Daily
 * Report: Day Shift in columns B–M, Night Shift in O–Z, same date should
 * land on the same row on both sides). Scans the first column of each block
 * for a matching `dateValue`; reuses that row if found, otherwise uses the
 * first row where BOTH blocks are still empty, otherwise appends past the
 * last used row. Only writes into the active block's own columns — never
 * touches the other side.
 */
export async function writeRowForDate(env, sheetId, tab, { leftBlock, rightBlock, activeSide, dateValue, values }) {
  const token = await getAccessToken(env);

  const scanEndColumn = columnLetter(columnIndex(rightBlock.startColumn) + rightBlock.width - 1);
  const scanRange = `${tab}!${leftBlock.startColumn}2:${scanEndColumn}1000`;
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(scanRange)}`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!getRes.ok) throw new Error(`Sheets read failed (${getRes.status}): ${await getRes.text()}`);
  const data = await getRes.json();
  const rows = data.values || [];

  const rightDateOffset = columnIndex(rightBlock.startColumn) - columnIndex(leftBlock.startColumn);

  let targetRow = null;
  let firstBlankRow = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const leftDate = row[0] || "";
    const rightDate = row[rightDateOffset] || "";
    if (leftDate === dateValue || rightDate === dateValue) {
      targetRow = i + 2;
      break;
    }
    if (!leftDate && !rightDate && firstBlankRow === null) {
      firstBlankRow = i + 2;
    }
  }
  if (!targetRow) targetRow = firstBlankRow || rows.length + 2;

  const activeBlock = activeSide === "right" ? rightBlock : leftBlock;
  const endColumn = columnLetter(columnIndex(activeBlock.startColumn) + values.length - 1);
  const writeRange = `${tab}!${activeBlock.startColumn}${targetRow}:${endColumn}${targetRow}`;

  const putUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(writeRange)}?valueInputOption=RAW`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [values] }),
  });
  if (!putRes.ok) throw new Error(`Sheets update failed (${putRes.status}): ${await putRes.text()}`);
}

/**
 * Returns the real, current tab names of a spreadsheet (spreadsheets.get,
 * metadata only — no cell data). Used to defend against batchGetValues
 * failing its ENTIRE call over a single mistyped/renamed/deleted tab name
 * (Google's batchGet is all-or-nothing: one bad range 400s the whole
 * request) — callers can filter their configured tab list down to only
 * tabs that actually exist before calling batchGetValues.
 */
export async function getSheetTabTitles(env, sheetId) {
  const token = await getAccessToken(env);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets metadata read failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return (data.sheets || []).map((s) => s.properties.title);
}

/**
 * Reads multiple ranges (e.g. one per tab) in a single API call using
 * spreadsheets.values.batchGet. Returns Google's raw `valueRanges` array
 * (one entry per input range, in the same order, each with a `.values`
 * 2D array — missing/blank rows are simply absent from the array, so
 * always index defensively). Read-only — used by Promo Code Search.
 */
export async function batchGetValues(env, sheetId, ranges) {
  const token = await getAccessToken(env);
  const params = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchGet?${params}&valueRenderOption=FORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets batchGet failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.valueRanges || [];
}

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

/**
 * Reads the last non-empty value in a column (e.g. TID) and increments its
 * trailing number, keeping the same prefix and zero-padding width.
 * "BVXXXBB1019" -> "BVXXXBB1020". Used for the TID "generate next" button.
 */
/**
 * `desiredPrefix`, if given, overrides whatever prefix the matched row
 * happens to have — needed when several different prefixes share one
 * column (e.g. Betjili's 3 promotions all writing TIDs into the same "BJ"
 * tab: "BJLPHPB003" and "BJLPHPF002" and "BJLPHPA001" interleaved in
 * whatever order they were submitted). The NUMBER always comes from the
 * highest one found anywhere in the column regardless of its prefix —
 * only the returned prefix changes based on what's being generated for.
 * Without `desiredPrefix`, falls back to the old behavior (reuse
 * whichever prefix the highest-numbered row had) — still correct for a
 * tab that only ever has one prefix in it.
 */
export async function getNextSequenceValue(env, sheetId, tab, column, desiredPrefix) {
  const token = await getAccessToken(env);
  const range = `${tab}!${column}2:${column}100000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets read failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const rows = data.values || [];

  let lastValue = null;
  let lastRowNumber = 1; // header row
  let maxNum = null;
  let maxDigits = 0;
  let maxPrefix = "";
  rows.forEach((row, i) => {
    if (!row[0]) return;
    lastValue = row[0];
    lastRowNumber = i + 2; // range starts at row 2
    const match = String(row[0]).match(/^(.*?)(\d+)$/);
    if (!match) return;
    const [, prefix, numStr] = match;
    const n = parseInt(numStr, 10);
    // Ties keep the widest digit count seen, so zero-padding never shrinks.
    if (maxNum === null || n > maxNum || (n === maxNum && numStr.length > maxDigits)) {
      maxNum = n;
      maxDigits = numStr.length;
      maxPrefix = prefix;
    }
  });

  if (!lastValue) return { next: null, lastRowNumber, error: "No existing rows found to base the next value on." };
  if (maxNum === null) return { next: null, lastRowNumber, error: `Could not find a trailing number in "${lastValue}".` };

  const nextNum = (maxNum + 1).toString().padStart(maxDigits, "0");
  const prefix = desiredPrefix != null ? desiredPrefix : maxPrefix;
  return { next: `${prefix}${nextNum}`, lastRowNumber, previous: lastValue };
}

/**
 * Appends `row` (a flat object) to the given tab of a spreadsheet, creating
 * the tab with a header row on first use if it doesn't exist yet. Used for
 * modules that don't have a pre-made sheet layout yet.
 */
export async function appendRowToSheet(env, sheetId, tabName, row) {
  const token = await getAccessToken(env);
  const headers = Object.keys(row);
  const values = [headers.map((h) => row[h])];

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  let res = await sheetsFetch(appendUrl, token, { values });

  if (res.status === 400) {
    // Tab probably doesn't exist yet — create it with a header row, then retry once.
    await ensureTabWithHeaders(token, sheetId, tabName, headers);
    res = await sheetsFetch(appendUrl, token, { values });
  }

  if (!res.ok) {
    throw new Error(`Sheets append failed (${res.status}): ${await res.text()}`);
  }
}

async function ensureTabWithHeaders(token, sheetId, tabName, headers, startColumn = "A") {
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  }).catch(() => {}); // ignore — a parallel request may have already created it

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!${startColumn}1?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [headers] }),
    }
  );
}

function sheetsFetch(url, token, body, method = "POST") {
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "\n") // in case the secret was stored with literal \n escapes
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromBuffer(buf) {
  let binary = "";
  new Uint8Array(buf).forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
