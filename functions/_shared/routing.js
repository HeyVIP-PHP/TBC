/**
 * routing.js  (SERVER-ONLY — anything under functions/_shared/ is never
 * routed by Cloudflare Pages, so this file is not reachable from the web)
 *
 * Fill in your real chat IDs, topic (message_thread_id) IDs and Google
 * Sheet webhook URLs here. Brand `id` keys must match public/assets/schemas.js.
 *
 * How to get a chat ID / topic ID:
 *   1. Add your bot to the group, enable "Topics" on the group if you want
 *      per-topic routing.
 *   2. Send any message in the group / topic, then open:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *   3. chat.id is the group's chatId (looks like -100xxxxxxxxxx).
 *      message_thread_id (present when a topic is used) is the topicId.
 *
 * Sheet logging uses a Google Cloud service account (see
 * functions/_shared/googleSheets.js) — no Apps Script needed. Per brand:
 *   1. Set `sheetId` below to the ID in the sheet's URL
 *      (https://docs.google.com/spreadsheets/d/<sheetId>/edit).
 *   2. Open that sheet → Share → add the service account's email
 *      (GOOGLE_SERVICE_ACCOUNT_EMAIL) as an Editor.
 * The service account credentials themselves are Cloudflare secrets, set
 * once for the whole project — see README.md.
 */

// PKR market — 9 platforms, brand new deployment (does NOT reuse the old
// INR chatId/topicId/sheetId values, which belong to a different
// production Cloudflare Pages project / Telegram bot / KV+R2 namespace).
// Every chatId/topicId/sheetId below is a placeholder ("") until the real
// PKR Telegram groups+topics and Google Sheets exist — see the file header
// comment above for how to obtain each one. Sheet logging simply no-ops
// (not an error) for any brand/module still left at sheetId: "".
export const BRANDS = {
  crickex: {
    name: "Crickex",
    sheetId: "1M0rAQeqkD50ytzwhD31HOQ-e8nEuckLhpMsq-ua_Kic",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  betjili: {
    name: "Betjili",
    sheetId: "1sZRJoFwzdASNjm75Lx9ppckLfsPQtzMapcWMqRnV7eE",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  mostplay: {
    name: "Mostplay",
    sheetId: "1d01hM568DnE9Hl8n362cT3dgGmhHrtWQTwjRZetL3lw",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  jeetwin: {
    name: "Jeetwin",
    sheetId: "1G2QiwogGIe5HeucHqWQk5OzLUkSpyKGNa0jjcJPsnk0",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  sbj66: {
    name: "Sbj66",
    sheetId: "1YWdTDmhHv9TCyJBNOWBOKGiZNybmMx7EDAPgmrYFMRw",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  heybaji: {
    name: "Heybaji",
    sheetId: "1xYvEMc7gycphUINVPUqTXpevlQkFZVsXTzeNN2K7ooI",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  superbaji: {
    name: "Superbaji",
    sheetId: "1wxXhwQ_Nyh5Al7yAbGHsqFhLc8FV2oTUQRhwGCSn268",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  kv8: {
    name: "KV8",
    sheetId: "1wyq16ABqlbkHI0R7YvEBRzQPUEgmStstaCyJkbH2yPY",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
  darazplay: {
    name: "Darazplay",
    sheetId: "1LZF08hAXDLwTQ1KYyXiQ8Zmu9TLO_N7ywpKEJBO8vjE",
    telegram: {
      default: { chatId: "", topicId: null },
      qa: { chatId: "", topicId: null },
      account_issue: { chatId: "", topicId: null },
      risk_issue: { chatId: "", topicId: null },
      promotion_request: { chatId: "", topicId: null },
      daily_report: { chatId: "", topicId: null },
      genie_issue: { chatId: "", topicId: null },
      withdraw_issue: { chatId: "", topicId: null },
    },
  },
};

// Only these modules get written to the brand's Google Sheet.
// Flip any of these to change what gets recorded, independent of Telegram routing.
export const RECORD_TO_SHEET = {
  qa: true,
  account_issue: true,
  risk_issue: true,
  promotion_request: true,
  daily_report: true,
  genie_issue: true,
  // Sheet structure confirmed (see SHEET_LAYOUT.withdraw_issue below) —
  // no more guessing needed, safe to turn on.
  withdraw_issue: true,
};

// Emoji + display name per module, used to build the Telegram message header.
export const MODULE_META = {
  qa: { emoji: "🔐", name: "QA", accent: "#60A5FA" },
  account_issue: { emoji: "🔑", name: "Account Issue", accent: "#FBBF24" },
  risk_issue: { emoji: "⚠️", name: "Risk Issue", accent: "#F87171" },
  promotion_request: { emoji: "🎟️", name: "Promotion Request", accent: "#F472B6" },
  daily_report: { emoji: "📊", name: "Daily Report", accent: "#34D399" },
  genie_issue: { emoji: "🤖", name: "Genie Issue", accent: "#A78BFA" },
  withdraw_issue: { emoji: "💸", name: "Withdraw Issue", accent: "#4ADE80" },
};

/**
 * Risk Issue only: certain selections auto-fill the Remark with fixed,
 * pre-approved wording instead of whatever the agent typed — keeps phrasing
 * to the Risk team consistent. Checked in this field order (issueType first,
 * then accountStatus, then cancelType); first match wins. A selection not
 * listed here just falls through to whatever the agent typed in Remark.
 */
export const RISK_ISSUE_AUTO_REMARKS = {
  issueType: {
    "Bonus Auto Force": "The player claimed the bonus, but it was automatically force-served.",
  },
  accountStatus: {
    "Suspended -- player wants to deposit":
      "𝗛𝗶 𝘁𝗲𝗮𝗺, Account showing 𝘀𝘂𝘀𝗽𝗲𝗻𝗱𝗲𝗱, Is it possible to Activate? The player want to make a 𝗱𝗲𝗽𝗼𝘀𝗶𝘁.",
    "Account Inactive": "𝗛𝗶 𝘁𝗲𝗮𝗺, 𝗔𝗰𝗰𝗼𝘂𝗻𝘁 𝘀𝗵𝗼𝘄𝗶𝗻𝗴 𝗶𝗻𝗮𝗰𝘁𝗶𝘃𝗲, 𝗜𝘀 𝗶𝘁 𝗽𝗼𝘀𝘀𝗶𝗯𝗹𝗲 𝘁𝗼 𝗮𝗰𝘁𝗶𝘃𝗮𝘁𝗲?",
    "Suspended -- Player has been warned":
      "𝗛𝗶 𝘁𝗲𝗮𝗺, We have warned the player. 𝗜𝘀 𝗶𝘁 𝗽𝗼𝘀𝘀𝗶𝗯𝗹𝗲 𝘁𝗼 𝗮𝗰𝘁𝗶𝘃𝗮𝘁𝗲 𝘁𝗵𝗶𝘀 𝗮𝗰𝗰𝗼𝘂𝗻𝘁?",
  },
  cancelType: {
    "Cancel with 10% Penalty":
      "𝗛𝗶 𝘁𝗲𝗮𝗺, Please help cancel this bonus with a 10% penalty as per the player's request, Thanks.",
    "Cancel without Penalty": "𝗛𝗶 𝘁𝗲𝗮𝗺,\nPlease help to cancel this bonus as per player request. Thanks.",
  },
};

/**
 * Risk Issue only: emoji shown next to each field when building the message
 * dynamically for an issue type that doesn't have its own row list in
 * MESSAGE_TEMPLATE.risk_issue.templates yet (everything except "Bonus Cancel
 * Related Issue" today). Add an entry here whenever a new field is added to
 * the risk_issue schema so it doesn't fall back to the generic 🔸.
 */
export const RISK_ISSUE_FIELD_EMOJI = {
  uid: "👤",
  bonusCode: "🎁",
  recycleAmount: "💰",
  turnoverRequirement: "🔄",
  turnoverCompleted: "✅",
  accountStatus: "📛",
  vipLevel: "👑",
  registeredNumber: "📱",
  kycEmail: "📧",
  updateRequest: "📝",
  fullName: "🧾",
  aadharPan: "🪪",
  cancelType: "📌",
  issueDescription: "📝",
};

/**
 * Account Issue only: same idea as RISK_ISSUE_FIELD_EMOJI above — emoji
 * (and, for a couple of fields, a shorter label than the web form uses)
 * shown for each field when the message is built dynamically (every
 * Account Issue type today, since none has its own static template yet).
 */
export const ACCOUNT_ISSUE_FIELD_STYLE = {
  registerNumber: { emoji: "📱" },
  registerWrongNumber: { emoji: "❌", label: "Wrong Number" },
  playerCorrectNumber: { emoji: "✅", label: "Correct Number" },
  addNumber: { emoji: "➕" },
  nid: { emoji: "🆔" }, // "CNIC Card Number" field (key kept as "nid" internally), used for Add Mobile Number Verify
  removeNumber: { emoji: "➖" },
  gmail: { emoji: "📧" },
  removeGmail: { emoji: "🗑" },
  previousGmail: { emoji: "📤" },
  updateNewGmail: { emoji: "📥" },
  messageType: { emoji: "📨" },
  updateRequest: { emoji: "✏️" },
  fullName: { emoji: "🧾" },
  aadharPan: { emoji: "🆔" },
  // -- Update Information (issueType = "Update Information") --
  updateInfoType: { emoji: "📋" },
  previousName: { emoji: "📤" },
  newName: { emoji: "📥" },
  previousBirthDate: { emoji: "📤" },
  newBirthDate: { emoji: "📥" },
  realName: { emoji: "🧾" },
  birthDate: { emoji: "🎂" },
};

/**
 * Emoji (and optional label override) per field, for the Telegram
 * message Withdraw Issue's submissions produce. See
 * buildWithdrawIssueDynamicMessage() (_shared/messageBuilders.js) for
 * how this gets used — "issueType"/"username"/"remark" are handled
 * separately by that function (they get their own fixed header/footer
 * lines) and deliberately don't need an entry here.
 */
export const WITHDRAW_ISSUE_FIELD_STYLE = {
  tid: { emoji: "🆔" },
  submittedAmount: { emoji: "💵" },
  receivedAmount: { emoji: "💰" },
};

/**
 * Promotion Request only: each (brand + promotion) combination has its OWN
 * spreadsheet (not the brand's main "Record Issue" sheet used elsewhere),
 * its own tab, and its own TID prefix/sequence. Keyed by
 * "<brandId>|<promotion value>". Add an entry here as each combination is
 * confirmed — combinations not listed here just show "not configured yet"
 * on the TID button and skip sheet logging (Telegram still sends fine).
 *
 * `columns` follow the same convention as SHEET_LAYOUT above; `tidColumn`
 * is which column the generate-next-TID button reads (usually same as
 * startColumn, since TID is column A on these sheets).
 */
// PKR market: 19 confirmed brand+promotion combinations, filled in this
// session from the business owner's reference sheet screenshot (column
// order: TID, Date, Username, Amount, Remarks, Platform, PIC — all
// starting at column A, all sheets one tab per promotion). "Remarks"
// holds the promotion name itself (the "promotion" field's value, e.g.
// "Birthday Bonus"), not a free-text note — that's what the reference
// sheet showed. "Platform" uses "brandCurrency" (not plain "brand") to
// get the confirmed "<Brand> PKR" format in that column, matching the
// screenshot exactly (see resolveColumnValues in submit.js for what that
// key does and how it differs from plain "brand").
export const PROMOTION_SHEET_CONFIG = {
  "crickex|Birthday Bonus": {
    sheetId: "1DyPqvlNWlSKBwNmw84hK8jNcSpFtyTSI421DSNc6r68",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili|Birthday Bonus": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili|Facebook Review Free Bonus": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Facebook Review Free Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "betjili|Rs 500 Free Cash On App Download-PKR": {
    sheetId: "1t72vFMdTYosUChQtmtz_MUkqNRqt20MBTDYqI5HSsuE",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay|Birthday Bonus": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay|Facebook Review Free Bonus": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Facebook Review Free Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "mostplay|Download & Claim": {
    sheetId: "11UkGw0n1k7WlPCxsI6F4edBNWgvSyUKEpEGVuGmVvck",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "jeetwin|Birthday Bonus": {
    sheetId: "1fIpfR2a8NtZVYujT9ub_s_J9A51cIf67votyBmm4j0c",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "jeetwin|Download JeetWin APP & Claim Cash": {
    sheetId: "1fIpfR2a8NtZVYujT9ub_s_J9A51cIf67votyBmm4j0c",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "heybaji|Birthday Bonus": {
    sheetId: "1pzodV-4NuvJuI4qrJ_xWXMlyAx18Q_ATZdpCMUI8wEU",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "heybaji|Download HeyBaji APP & Claim Cash": {
    sheetId: "1pzodV-4NuvJuI4qrJ_xWXMlyAx18Q_ATZdpCMUI8wEU",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "superbaji|Birthday Bonus": {
    sheetId: "1k_Nn-NPLHVogFZjDdMuAVCRJFDM6wsAplrpYfNfidEc",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "superbaji|Download SuberBaji APP & Claim Cash": {
    sheetId: "1k_Nn-NPLHVogFZjDdMuAVCRJFDM6wsAplrpYfNfidEc",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "sbj66|Birthday Bonus": {
    sheetId: "1sLHwgKubzY-DrbvrZWmAi6A8RHwClMD4Nn9C1sEzF_s",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "sbj66|Download SBJ66 APP & Claim Cash": {
    sheetId: "1sLHwgKubzY-DrbvrZWmAi6A8RHwClMD4Nn9C1sEzF_s",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "kv8|Birthday Bonus": {
    sheetId: "1Yiput5AMiRdubIt5h4qQBnPAR4XottEdRbqKZToGa9U",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "kv8|Download KV8 APP & Claim 199 Cash": {
    sheetId: "1Yiput5AMiRdubIt5h4qQBnPAR4XottEdRbqKZToGa9U",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "darazplay|Birthday Bonus": {
    sheetId: "1sAswzEwGsxI3MshvRnPreIaH5seJzwK_9mvOeyxd8EI",
    tab: "Birthday Bonus",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
  "darazplay|Rs.200 Download DarazPlay App": {
    sheetId: "1sAswzEwGsxI3MshvRnPreIaH5seJzwK_9mvOeyxd8EI",
    tab: "Download & Claim",
    startColumn: "A",
    tidColumn: "A",
    columns: ["tid", "date", "username", "amount", "promotion", "brandCurrency", "pic"],
  },
};

/**
 * Promotion Request only: the Telegram message rows, now the SAME for
 * every (brand + promotion) combination — business owner explicitly
 * wants one unified TG format across all brands (Google Sheet writes and
 * the web form itself are untouched, this only changes what the
 * Telegram message looks like). Casing/punctuation on every label below
 * must match exactly what was specified — do not "fix" or restyle it:
 *
 *   Particular information
 *   TID:
 *   Date:
 *   Username:
 *   Amount to be Added:
 *   Remarks:
 *   NID NO:
 *   Processed BY:
 *   Platform:
 *   To be added:
 *
 * Tier Level (BetVisa/Jeetway) and Number of Deposits (Betjili/Mostplay)
 * are still collected on the form and still auto-fill Amount as before —
 * they just no longer get their own row in the Telegram message.
 * `key` can be a field key, "brand", "pic", or { fixed: "..." } for a
 * literal value (e.g. "To be added" is always "Manually").
 */
const PROMOTION_ROWS_UNIFIED = [
  { label: "TID", key: "tid" },
  { label: "Date", key: "date" },
  { label: "Username", key: "username" },
  { label: "Amount to be Added", key: "amount" },
  { label: "Remarks", key: "promotion" },
  { label: "NID NO", key: "nid" },
  { label: "Processed BY", key: "pic" },
  { label: "Platform", key: "brand" },
  { label: "To be added", key: { fixed: "Manually" } },
];

// PKR market's own version of the row set above — same idea, minus the
// "NID NO" row. PKR's promotion_request form (schemas.js) doesn't collect
// an NID/CNIC field at all for promotions (confirmed against the business
// owner's reference Google Sheet screenshot, which has no NID column
// either — TID/Date/Username/Amount/Remarks/Platform/PIC, 7 columns) —
// unlike INR's Birthday Bonus flow, which does. Used by every PKR
// brand+promotion combo in PROMOTION_MESSAGE_TEMPLATE below.
const PROMOTION_ROWS_PKR = [
  { label: "TID", key: "tid" },
  { label: "Date", key: "date" },
  { label: "Username", key: "username" },
  { label: "Amount to be Added", key: "amount" },
  { label: "Remarks", key: "promotion" },
  { label: "Processed BY", key: "pic" },
  { label: "Platform", key: "brand" },
  { label: "To be added", key: { fixed: "Manually" } },
];

// PKR market: all 19 confirmed brand+promotion combinations use
// PROMOTION_ROWS_PKR (see its own comment above — same idea as
// PROMOTION_ROWS_UNIFIED, minus the NID row PKR doesn't collect).
export const PROMOTION_MESSAGE_TEMPLATE = {
  "crickex|Birthday Bonus": PROMOTION_ROWS_PKR,
  "betjili|Birthday Bonus": PROMOTION_ROWS_PKR,
  "betjili|Facebook Review Free Bonus": PROMOTION_ROWS_PKR,
  "betjili|Rs 500 Free Cash On App Download-PKR": PROMOTION_ROWS_PKR,
  "mostplay|Birthday Bonus": PROMOTION_ROWS_PKR,
  "mostplay|Facebook Review Free Bonus": PROMOTION_ROWS_PKR,
  "mostplay|Download & Claim": PROMOTION_ROWS_PKR,
  "jeetwin|Birthday Bonus": PROMOTION_ROWS_PKR,
  "jeetwin|Download JeetWin APP & Claim Cash": PROMOTION_ROWS_PKR,
  "heybaji|Birthday Bonus": PROMOTION_ROWS_PKR,
  "heybaji|Download HeyBaji APP & Claim Cash": PROMOTION_ROWS_PKR,
  "superbaji|Birthday Bonus": PROMOTION_ROWS_PKR,
  "superbaji|Download SuberBaji APP & Claim Cash": PROMOTION_ROWS_PKR,
  "sbj66|Birthday Bonus": PROMOTION_ROWS_PKR,
  "sbj66|Download SBJ66 APP & Claim Cash": PROMOTION_ROWS_PKR,
  "kv8|Birthday Bonus": PROMOTION_ROWS_PKR,
  "kv8|Download KV8 APP & Claim 199 Cash": PROMOTION_ROWS_PKR,
  "darazplay|Birthday Bonus": PROMOTION_ROWS_PKR,
  "darazplay|Rs.200 Download DarazPlay App": PROMOTION_ROWS_PKR,
};

/**
 * Optional per-module Telegram message template — just the field rows, no
 * "New X — Brand" header line. `key` works the same as in SHEET_LAYOUT
 * above — a field key, "brand"/"pic"/"screenshotLink", or a
 * { details: [fallbackKeys...] } object for first-non-empty-wins fields.
 *
 * A module's value here can be either:
 *   - a plain array → one fixed template for every submission
 *   - { selectorField, templates: { <value>: [...], default: [...] } } →
 *     picks a template based on that field's submitted value (falls back
 *     to `default` if no exact match), e.g. QA's Domain Issue motive uses
 *     a completely different set of rows than the other 5 motives.
 * Optionally set `header: { source: "brand" | "<fieldKey>" }` on a template
 * to prepend a "{moduleEmoji} {moduleName} — {value}" line — e.g. Risk
 * Issue's header shows the selected Issue Type instead of the brand name.
 * Add an entry here per module once you know the exact wording wanted.
 */
export const MESSAGE_TEMPLATE = {
  qa: {
    selectorField: "motive",
    templates: {
      "Domain Issue": [
        { emoji: "🎮", label: "Brand / Platform", key: "brand" },
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📝", label: "Issue Details", key: "issueDetails" },
        { emoji: "🌐", label: "Domain Link", key: "domainLink" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
      default: [
        { emoji: "🎮", label: "Brand / Platform", key: "brand" },
        { emoji: "📅", label: "Date", key: "date" },
        { emoji: "🆔", label: "UID", key: "uid" },
        { emoji: "📱", label: "Number", key: "number" },
        { emoji: "📧", label: "Email", key: "email" },
        { emoji: "🎯", label: "Motive", key: "motive" },
        { emoji: "📝", label: "Remark", key: "remark" },
        { emoji: "👤", label: "PIC", key: "pic" },
      ],
    },
  },
  risk_issue: {
    selectorField: "issueType",
    templates: {
      "Bonus Cancel Related Issue": {
        header: { source: "issueType" }, // "⚠️ Risk Issue — Bonus Cancel Related Issue"
        spacing: "loose",
        rows: [
          { emoji: "🎮", label: "Brand/Platform", key: "brand", tight: true },
          { emoji: "👤", label: "Username", key: "uid", tight: true },
          { emoji: "🎁", label: "Bonus Code", key: "bonusCode", tight: true },
          { emoji: "📌", label: "Cancel Type", key: "cancelType" },
          { emoji: "📝", label: "Remark", key: "remark", skipIfEmpty: true },
          { emoji: "💬", key: "autoRemark", raw: true },
          { emoji: "👷", label: "PIC", key: "pic" },
        ],
      },
      // No `default` yet — the other 10 Issue Types fall back to the
      // generic "every filled field, in form order" message until their
      // own formats are given.
    },
  },
  // "dateShift" is a computed value: "15/07/2026 ( Day Shift Report )☀️" /
  // "🌙" for Night Shift — built from the reportDate + shift fields, see
  // resolveFieldValue() in submit.js.
  daily_report: {
    spacing: "loose", // blank line between every row (except where `tight: true`)
    emptyPlaceholder: "Nil",
    rows: [
      { emoji: "🏷️", label: "Brand", key: "brand", tight: true },
      { emoji: "📅", label: "Date", key: "dateShift" },
      { emoji: "🔴", label: "Major Issues", key: "majorIssues" },
      { emoji: "💬", label: "CS Issues", key: "csIssues" },
      { emoji: "💳", label: "Payment Issues", key: "paymentIssues" },
      { emoji: "🐛", label: "Minor System Bugs", key: "minorSystemBugs" },
      { emoji: "🌐", label: "Domain Control", key: "domainControl" },
      { emoji: "⚙️", label: "Provider Issues", key: "providerIssues" },
      { emoji: "🎁", label: "Promotion Quests", key: "promotionQuests" },
      { emoji: "📌", label: "Others Issues", key: "othersIssues" },
      { emoji: "👤", label: "Reported by", key: "pic" },
    ],
  },
  genie_issue: {
    header: { source: "brand", noBlankAfter: true, hideValue: true },
    spacing: "loose",
    rows: [
      { emoji: "🏷️", label: "Platform", key: "brand" },
      { emoji: "📝", label: "Issue Details", key: "issueDetails" },
      { emoji: "🔗", label: "Chat Link(s)", key: "chatLinks" },
      { emoji: "🧑‍💼", key: "submittedBy", raw: true },
    ],
  },
};

/**
 * Maps a module to an EXISTING tab in the brand's sheet with its own fixed
 * column layout (used instead of the generic auto-create-headers path).
 * `startColumn` is the sheet's first data column (e.g. "B" when column A is
 * left blank/unused, matching the reference sheet).
 * `columns` lists, in left-to-right order, which value goes in each column —
 * each entry is either a field key (from that module's schema.js fields,
 * e.g. "date", "uid", "motive") or one of these special values:
 *   "brand"          → the brand's display name
 *   "pic"            → the reporter/agent name
 *   "screenshotLink" → clickable Telegram links to the uploaded attachments
 *   "details"        → falls back through a list of field keys, first non-empty wins
 *   null             → no field mapped yet — always writes "-" as a placeholder
 * Add an entry here per module once you know that module's tab name + columns.
 */
export const SHEET_LAYOUT = {
  qa: {
    tab: "QA OTP & Domain",
    startColumn: "B",
    columns: ["date", "uid", "number", "email", "brand", "motive", "domainLink", "screenshotLink", { details: ["remark", "issueDetails"] }, "pic"],
  },
  genie_issue: {
    tab: "Genie Issues",
    startColumn: "B",
    columns: ["brand", "issueDetails", "chatLinks", "pic"],
  },
  account_issue: {
    tab: "Account Issue",
    startColumn: "B",
    // "Update Information" issue type's fields (updateInfoType/previousName/
    // newName/previousBirthDate/newBirthDate/realName/birthDate) are
    // deliberately NOT listed below — the reference Sheet has no columns
    // for them, so they only show up in the Telegram message, never
    // written to the Sheet. Nothing to break if that changes later: just
    // add the relevant key(s) to this array once a column exists.
    columns: [
      "brand",
      "uid",
      { details: ["registerNumber", "registerWrongNumber"] },
      { details: ["gmail", "removeGmail", "previousGmail", "updateNewGmail"] },
      { details: ["nid", "aadharPan"] },
      "issueType",
      "screenshotLink",
      "remark",
      "pic",
    ],
  },
  risk_issue: {
    tab: "Risk Issue",
    startColumn: "B",
    // `null` = no field maps here yet (e.g. Cancel Type) — always writes "-".
    columns: [
      "brand",
      "uid",
      "issueType",
      "bonusCode",
      "aadharPan",
      "cancelType",
      "accountStatus",
      { details: ["remark", "issueDescription"] },
      "pic",
    ],
  },
  // Daily Report's sheet has two side-by-side blocks on the same tab — Day
  // Shift entries fill columns B–M, Night Shift entries fill columns O–Z
  // (column N is a blank spacer). Same date on both shifts should land on
  // the SAME row, so this uses pairByDate instead of a plain append —
  // see writeRowForDate() in googleSheets.js.
  daily_report: {
    pairByDate: true,
    selectorField: "shift",
    tab: "Daily Report",
    leftBlock: { startColumn: "B", width: 12, shiftValue: "Day Shift" },
    rightBlock: { startColumn: "O", width: 12, shiftValue: "Night Shift" },
    columns: dailyReportColumns(),
  },
  // Unlike every other module's sheet, this one's Date column is A (not
  // B) and there's deliberately NO Screenshot Link column at all —
  // matched against the real "Withdraw Issue" tab, confirmed column by
  // column, not guessed. submittedAmount/receivedAmount both write "-"
  // for any Issue Type except "Withdraw Amount Received Less" (the only
  // one that actually collects them) via the plain-string column
  // lookup's fieldMap[col]-is-empty fallback in resolveColumnValues().
  withdraw_issue: {
    tab: "Withdraw Issue",
    startColumn: "A",
    columns: ["autoDate", "brand", "username", "issueType", "tid", "submittedAmount", "receivedAmount", "remark", "pic"],
  },
};

function dailyReportColumns() {
  return [
    "dateFormatted",
    "brand",
    "shift",
    "majorIssues",
    "csIssues",
    "paymentIssues",
    "minorSystemBugs",
    "domainControl",
    "providerIssues",
    "promotionQuests",
    "othersIssues",
    "pic",
  ];
}

// Only these modules upload attachments to R2 / generate a screenshot link
// (for the sheet's Screenshot link column and anywhere else). Everything
// else just attaches the photo straight to the Telegram message and skips
// R2 entirely — cheaper, and some modules (e.g. Daily Report) don't want a
// separate link at all since the photo is already in the message.
export const SCREENSHOT_R2_ENABLED = {
  qa: true,
  account_issue: true,
};
