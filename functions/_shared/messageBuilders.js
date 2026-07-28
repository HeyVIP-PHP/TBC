/**
 * messageBuilders.js  (SERVER-ONLY, shared)
 *
 * Every "turn form fields into a Telegram message" / "turn form fields
 * into a row of Sheet column values" function used to live only inside
 * functions/api/submit.js. Pulled out here (2026-07) so that
 * functions/api/threads/[id].js's `editDetails` action — which lets an
 * agent fix a ticket's field values from the web UI and have BOTH the
 * Telegram message and the Google Sheet row it originally wrote update
 * to match — can call the exact same logic instead of a hand-copied
 * duplicate that could quietly drift out of sync with what submit.js
 * actually does at creation time.
 *
 * Nothing in this file talks to Telegram, Google Sheets, R2, or KV
 * directly — it's pure "given these fields, produce this string / this
 * array of column values" functions, no I/O. submit.js and
 * threads/[id].js are both responsible for the actual network calls.
 */
import { RISK_ISSUE_FIELD_EMOJI, ACCOUNT_ISSUE_FIELD_STYLE, BANK_ISSUE_FIELD_STYLE, WITHDRAW_ISSUE_FIELD_STYLE } from "./routing.js";

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Business owner wants every TG-message "Platform"/"Brand" labeled ROW to
// read "<Brand> <CURRENCY>" (e.g. "Betjili PHP") — NOT the Sheet columns,
// and NOT the "New X — Brand" title/header lines, both of which stay as
// the plain brand name. Used at the spots that render a labeled brand
// row: buildPromotionRequestMessage, resolveFieldValue (the
// MESSAGE_TEMPLATE row renderer used by QA/Risk Issue/Genie Issue/Daily
// Report), and the Account/Bank/Withdraw Issue dynamic message builders.
//
// ONE PLACE TO EDIT when reusing this project for a different currency
// market — change CURRENCY_LABEL below and every outgoing Telegram
// message updates automatically. Leave it as "" to drop the suffix
// entirely and show just the plain brand name.
const CURRENCY_LABEL = "PHP";
export function brandCurrencyLabel(name) {
  return name && CURRENCY_LABEL ? `${name} ${CURRENCY_LABEL}` : name;
}

export function resolveColumnValues(columns, { fieldMap, brand, reporter, screenshotLink, attachmentLinks }) {
  return columns.map((col) => {
    if (col === null) return "-";
    if (typeof col === "string") {
      if (col === "brand") return brand.name || "-";
      if (col === "pic") return reporter || "-";
      if (col === "screenshotLink") return (screenshotLink || (attachmentLinks || []).join(", ")) || "-";
      if (col === "dateFormatted") return formatDateDDMMYYYY(fieldMap.reportDate || fieldMap.date) || "-";
      // "02-june-2026" style — Promotion Sheet only, see formatDateDMonthYLower below.
      if (col === "dateLongLower") return formatDateDMonthYLower(fieldMap.reportDate || fieldMap.date) || "-";
      // Server-generated date, independent of any form field — used by
      // modules (like Bank Issue) that don't ask the agent for a date at
      // all, so the Sheet still gets one automatically at submit time.
      // NOTE: on an editDetails() re-write this recomputes to TODAY, not
      // the original submit date — acceptable since these modules never
      // asked for/stored a real date to begin with.
      if (col === "autoDate") return formatDateDDMMYYYY(new Date().toISOString().slice(0, 10));
      return fieldMap[col] || "-";
    }
    // { details: ["remark", "issueDetails"] } — first non-empty field wins
    const [, fallbackKeys] = Object.entries(col)[0];
    for (const key of fallbackKeys) {
      if (fieldMap[key]) return fieldMap[key];
    }
    return "-";
  });
}

export function resolveSheetLayout(entry, fieldMap) {
  if (!entry) return null;
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    return entry.layouts[selectorValue] || entry.layouts.default || null;
  }
  return entry;
}

export function resolveTemplate(entry, fieldMap) {
  if (!entry) return null;
  if (Array.isArray(entry)) return { rows: entry, spacing: "tight", emptyPlaceholder: "-" };
  if (entry.selectorField) {
    const selectorValue = fieldMap[entry.selectorField];
    const chosen = entry.templates[selectorValue] || entry.templates.default;
    return resolveTemplate(chosen, fieldMap);
  }
  return { rows: entry.rows, spacing: entry.spacing || "tight", emptyPlaceholder: entry.emptyPlaceholder ?? "-", header: entry.header || null };
}

function resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink }) {
  if (typeof item.key !== "string") {
    const [, fallbackKeys] = Object.entries(item.key)[0];
    return fallbackKeys.map((k) => fieldMap[k]).find((v) => v);
  }
  if (item.key === "brand") return brandCurrencyLabel(brandName);
  if (item.key === "screenshotLink") return screenshotLink;
  if (item.key === "pic") return reporter;
  if (item.key === "dateShift") return formatDateShift(fieldMap.reportDate, fieldMap.shift);
  if (item.key === "submittedBy") return reporter ? `Submitted by ${reporter}` : null;
  return fieldMap[item.key];
}

export function buildMessageFromTemplate({ template, meta, brandName, fieldMap, reporter, screenshotLink }) {
  const { rows, spacing, emptyPlaceholder, header } = template;
  const lines = [];
  if (header) {
    const headerValue = header.source === "brand" ? brandName : fieldMap[header.source];
    const titleLine = header.hideValue
      ? `${meta.emoji} <b>${escapeHtml(meta.name)}</b>`
      : `${meta.emoji} <b>${escapeHtml(meta.name)} — ${escapeHtml(headerValue || "-")}</b>`;
    lines.push(titleLine);
    if (!header.noBlankAfter) lines.push("");
  }
  rows.forEach((item, i) => {
    const value = resolveFieldValue(item, { brandName, fieldMap, reporter, screenshotLink });
    if (item.raw) {
      if (!value) return; // skip entirely — no placeholder line for optional raw notes
      lines.push(`${item.emoji} ${escapeHtml(value)}`);
    } else {
      lines.push(`${item.emoji} <b>${escapeHtml(item.label)}:</b> ${escapeHtml(value || emptyPlaceholder)}`);
    }
    if (spacing === "loose" && i < rows.length - 1 && !item.tight) lines.push("");
  });
  return lines.join("\n");
}

// "15/07/2026 ( Day Shift Report )☀️" — DD/MM/YYYY from the <input type=date>
// value (YYYY-MM-DD), plus the shift name and a sun/moon emoji.
function formatDateShift(isoDate, shift) {
  const formatted = formatDateDDMMYYYY(isoDate);
  if (!formatted) return "-";
  const emoji = shift === "Night Shift" ? "🌙" : "☀️";
  return `${formatted} ( ${shift || "Day Shift"} Report )${emoji}`;
}

export function formatDateDDMMYYYY(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

const MONTH_NAMES_LOWER = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
// "02-june-2026" — used only for the Promotion Sheet's Date column, to
// match the existing rows there. Everywhere else in the project keeps
// using formatDateDDMMYYYY above.
export function formatDateDMonthYLower(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  const monthName = MONTH_NAMES_LOWER[parseInt(m, 10) - 1];
  if (!y || !d || !monthName) return isoDate;
  return `${d}-${monthName}-${y}`;
}

// Used for any Risk Issue type that doesn't have its own row list in
// MESSAGE_TEMPLATE.risk_issue.templates — keeps the same visual style
// (emoji-labeled bold rows, header showing the Issue Type) without needing
// a hand-written template for all 11 issue types up front.
export function buildRiskIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`⚠️ <b>Risk Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.uid || "-")}`);

  const middleFields = fields.filter((f) => !["issueType", "uid", "remark"].includes(f.key) && f.value);
  if (middleFields.length) {
    lines.push("");
    middleFields.forEach((f) => {
      const emoji = RISK_ISSUE_FIELD_EMOJI[f.key] || "🔸";
      lines.push(`${emoji} <b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`);
    });
  }

  // Only show a Remark row if this issue type's form actually had a
  // Remark field with something typed into it — several issue types
  // (Others Bonus Related Issue, VIP Level Update Issue, KYC Issues,
  // Remove Bank Account, Others Issues, Verify Bank Detail) use "Issue
  // Description" instead of "Remark" and never collect fieldMap.remark
  // at all, so this used to unconditionally print an empty "Remark: -"
  // line even when the form never asked for one.
  if (fieldMap.remark) {
    lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark)}`);
  }

  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

// Account Issue: header shows Issue Type, Brand/Username/type-specific
// fields are all grouped together (no blank lines between them), then one
// blank line before Remark and another before PIC.
export function buildAccountIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`🔑 <b>Account Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.uid || "-")}`);

  fields
    .filter((f) => !["issueType", "uid", "remark"].includes(f.key) && f.value)
    .forEach((f) => {
      const style = ACCOUNT_ISSUE_FIELD_STYLE[f.key];
      const emoji = style ? style.emoji : "🔸";
      const label = style && style.label ? style.label : f.label;
      lines.push(`${emoji} <b>${escapeHtml(label)}:</b> ${escapeHtml(f.value)}`);
    });

  lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark || "-")}`);
  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

// Same structure as buildAccountIssueDynamicMessage above — kept as its
// own function (not a shared helper) since Bank Issue and Account Issue
// are independently maintained modules that happen to look alike today;
// don't assume they'll always stay in sync.
export function buildBankIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`🏦 <b>Bank Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.uid || "-")}`);

  fields
    .filter((f) => !["issueType", "uid", "remark"].includes(f.key) && f.value)
    .forEach((f) => {
      if (f.key === "accountNumber") lines.push(""); // blank line groups mobile-number fields apart from account-info fields
      const style = BANK_ISSUE_FIELD_STYLE[f.key];
      const emoji = style ? style.emoji : "🔸";
      const label = style && style.label ? style.label : f.label;
      lines.push(`${emoji} <b>${escapeHtml(label)}:</b> ${escapeHtml(f.value)}`);
    });

  lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark || "-")}`);
  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

// Same structure again, for Withdraw Issue — identifier field here is
// "username" (not "uid" like the other two dynamic-message modules).
export function buildWithdrawIssueDynamicMessage({ brandName, fields, fieldMap, reporter }) {
  const lines = [`💸 <b>Withdraw Issue — ${escapeHtml(fieldMap.issueType || "-")}</b>`, ""];
  lines.push(`🎮 <b>Brand/Platform:</b> ${escapeHtml(brandCurrencyLabel(brandName))}`);
  lines.push(`👤 <b>Username:</b> ${escapeHtml(fieldMap.username || "-")}`);

  fields
    .filter((f) => !["issueType", "username", "remark"].includes(f.key) && f.value)
    .forEach((f) => {
      const style = WITHDRAW_ISSUE_FIELD_STYLE[f.key];
      const emoji = style ? style.emoji : "🔸";
      const label = style && style.label ? style.label : f.label;
      lines.push(`${emoji} <b>${escapeHtml(label)}:</b> ${escapeHtml(f.value)}`);
    });

  lines.push("", `📝 <b>Remark:</b> ${escapeHtml(fieldMap.remark || "-")}`);
  lines.push("", `👷 <b>PIC:</b> ${escapeHtml(reporter)}`);
  return lines.join("\n");
}

export function buildMessage({ meta, brandName, reporter, fields }) {
  const lines = [
    `${meta.emoji} <b>New ${escapeHtml(meta.name)} — ${escapeHtml(brandName)}</b>`,
    "",
    ...fields
      .filter((f) => f.value)
      .map((f) => `<b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`),
    "",
    `🧑‍💼 Submitted by ${escapeHtml(reporter)}`,
  ];
  return lines.join("\n");
}

// Promotion Request: plain "Particular information" list (no emoji/header
// styling, matches the reference format exactly). `key` can be a field key,
// "brand", "pic", or { fixed: "..." } for an always-the-same value.
export function buildPromotionRequestMessage(rows, { brandName, fieldMap, reporter }) {
  const lines = ["<b>Particular information</b>"];
  rows.forEach((item) => {
    let value;
    if (typeof item.key === "object") value = item.key.fixed;
    else if (item.key === "brand") value = brandCurrencyLabel(brandName);
    else if (item.key === "pic") value = reporter;
    else value = fieldMap[item.key];
    lines.push(`<b>${escapeHtml(item.label)}:</b> ${escapeHtml(value || "-")}`);
  });
  return lines.join("\n");
}

/**
 * The "which builder do I use for this module" dispatch — this exact
 * chain of if/else lived only in submit.js before; now shared so
 * editDetails() in functions/api/threads/[id].js rebuilds a ticket's
 * message exactly the same way submit.js built it the first time.
 * `MESSAGE_TEMPLATE` / `PROMOTION_MESSAGE_TEMPLATE` are passed in rather
 * than imported here, since the caller already has them from routing.js
 * and it keeps this file from needing to import routing.js's entire
 * surface just for these two lookup tables.
 */
export function buildTicketMessage({ moduleId, brandId, meta, brand, fieldMap, fields, reporter, screenshotLink, messageTemplate, promotionMessageTemplate }) {
  const template = resolveTemplate(messageTemplate[moduleId], fieldMap);
  if (template) {
    return buildMessageFromTemplate({ template, meta, brandName: brand.name, fieldMap, reporter, screenshotLink });
  }
  if (moduleId === "risk_issue") return buildRiskIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  if (moduleId === "account_issue") return buildAccountIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  if (moduleId === "bank_issue") return buildBankIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  if (moduleId === "withdraw_issue") return buildWithdrawIssueDynamicMessage({ brandName: brand.name, fields, fieldMap, reporter });
  if (moduleId === "promotion_request" && promotionMessageTemplate[`${brandId}|${fieldMap.promotion}`]) {
    return buildPromotionRequestMessage(promotionMessageTemplate[`${brandId}|${fieldMap.promotion}`], { brandName: brand.name, fieldMap, reporter });
  }
  return buildMessage({ meta, brandName: brand.name, reporter, fields, moduleId, fieldMap });
}

// Same "title + short field preview" logic submit.js uses when creating a
// thread record — shared so editDetails() can recompute both after a
// field edit and keep the sidebar's title/preview text in sync with
// what actually got saved, instead of a stale copy from creation time.
export function buildTitleAndSummary({ meta, brand, fieldMap, fields }) {
  const title = fieldMap.issueType ? `${meta.name} — ${fieldMap.issueType}` : `${meta.name} — ${brand.name}`;
  const summary = fields
    .filter((f) => f.value && !["issueType"].includes(f.key))
    .slice(0, 6)
    .map((f) => ({ label: f.label, value: f.value }));
  return { title, summary };
}
