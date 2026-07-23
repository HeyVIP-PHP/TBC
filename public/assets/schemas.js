/**
 * schemas.js
 * Single source of truth for brands + form fields, used by the hub page
 * and the generic form renderer. This file is PUBLIC (served as a static
 * asset) so it must never contain secrets, chat IDs, or sheet URLs —
 * that routing lives server-side in functions/_shared/routing.js.
 */

// Rename / add your real brands here. The `id` must match the brand key
// used in functions/_shared/routing.js on the server.
const BRANDS = [
  { id: "betjili", name: "Betjili" },
  { id: "betvisa", name: "BetVisa" },
];

// Every module gets the same attachment slot (screenshots/PDFs, shown as a
// drag-and-drop + paste dropzone under its fields). Change `max` per module
// if one of them shouldn't allow attachments.
const DEFAULT_ATTACHMENTS = { max: 3, accept: "image/png,image/jpeg,application/pdf", maxSizeMB: 20 };

// A field can declare `showIf: { field: "<otherFieldKey>", oneOf: [...values] }`
// to only appear when that other field currently holds one of those values —
// e.g. "Add Number" only shows up when Issue Type is "Add Mobile Number Verify".
// It stays in the DOM (kept in field order) but is hidden + not required
// until its condition is met, so add each issue type's extra fields inline
// at the position they should appear.

// Each module = one card on the hub + one generic form page (form.html?module=<id>)
// `emphasize: true` on a field draws the highlighted box style (used for the
// main "what kind of issue is this" selector, matching the reference design).
const MODULES = [
  {
    id: "qa",
    name: "QA",
    icon: "🔐",
    formTitle: "QA Check",
    accent: "#60A5FA",
    description: "OTP & Domain issue etc.",
    reporterLabel: "PIC",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "motive", label: "Motive", type: "select", required: true, emphasize: true,
        options: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number", "Domain Issue"],
      },
      { key: "date", label: "Date", type: "date", required: true },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "number", label: "Number", type: "text", required: false, placeholder: "Phone number...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "email", label: "Email", type: "text", required: false, placeholder: "Email address...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "domainLink", label: "Domain Link", type: "text", required: true, placeholder: "https://...",
        showIf: { field: "motive", oneOf: ["Domain Issue"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: true, placeholder: "Additional remarks...",
        showIf: { field: "motive", oneOf: ["Email Verify", "Number Verify", "Forget Password SMS", "Forget Password Email", "Add Secondary Number"] },
      },
      {
        key: "issueDetails", label: "Issue Details", type: "textarea", required: true, placeholder: "Describe the domain issue...",
        showIf: { field: "motive", oneOf: ["Domain Issue"] },
      },
    ],
  },
  {
    id: "account_issue",
    name: "Account Issue",
    icon: "🔑",
    accent: "#FBBF24",
    description: "Account verify & otp etc.",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Register Number Verification",
          "Add Mobile Number Verify",
          "Add Number Remove",
          "Registration Number Inputted Wrong",
          "Gmail Verification",
          "Gmail Remove",
          "Customer Email Change / Inactive / Lost",
          "Forgot Password (OTP Limit Exceeded)",
          "Forget Username & Gmail",
          "KYC Issues",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Registration Number Inputted Wrong", "Gmail Verification", "Gmail Remove",
          "Customer Email Change / Inactive / Lost", "Forgot Password (OTP Limit Exceeded)", "KYC Issues",
        ] },
      },
      { key: "registerNumber", label: "Register Number", type: "text", required: false, placeholder: "Register number...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Gmail Verification", "Gmail Remove", "Customer Email Change / Inactive / Lost",
          "Forgot Password (OTP Limit Exceeded)", "Forget Username & Gmail", "KYC Issues",
        ] },
      },
      { key: "registerWrongNumber", label: "Register Wrong Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      {
        key: "addNumber", label: "Add Number", type: "text", required: false, placeholder: "Number to add...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "nid", label: "Aadhar-Pan Card Number", type: "text", required: false, placeholder: "Aadhar or Pan card number...",
        showIf: { field: "issueType", oneOf: ["Add Mobile Number Verify"] },
      },
      { key: "removeNumber", label: "Remove Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Add Number Remove"] },
      },
      { key: "playerCorrectNumber", label: "Player Correct Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Registration Number Inputted Wrong"] },
      },
      { key: "gmail", label: "Gmail", type: "text", required: false, placeholder: "Gmail address...",
        showIf: { field: "issueType", oneOf: ["Gmail Verification", "Forgot Password (OTP Limit Exceeded)", "KYC Issues"] },
      },
      { key: "removeGmail", label: "Remove Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Gmail Remove"] },
      },
      { key: "previousGmail", label: "Previous Gmail (Remove)", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      { key: "updateNewGmail", label: "Update New Gmail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Customer Email Change / Inactive / Lost"] },
      },
      {
        key: "messageType", label: "Message Type", type: "select", required: false,
        options: ["OTP Limit Exceeded", "Number & Email Not Verified"],
        showIf: { field: "issueType", oneOf: ["Forgot Password (OTP Limit Exceeded)"] },
      },
      { key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      { key: "aadharPan", label: "Aadhar / Pan Card Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Register Number Verification", "Add Number Remove", "KYC Issues"] },
      },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    ],
  },
  {
    id: "risk_issue",
    name: "Risk Issue",
    icon: "⚠️",
    formTitle: "Risk Issue Report",
    accent: "#F87171",
    description: "KYC, bonus cancel & Acc suspend etc.",
    reporterLabel: "PIC",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Bonus Auto Force",
          "Bonus Manual Force",
          "Return To Main",
          "Others Bonus Related Issue",
          "Account Suspend / Inactive",
          "Bonus Cancel Related Issue",
          "VIP Level Update Issue",
          "KYC Issues",
          "Remove Bank Account",
          "Verify Bank Detail",
          "Others Issues",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID..." },
      {
        key: "bonusCode", label: "Bonus Code", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Others Bonus Related Issue", "Bonus Cancel Related Issue"] },
      },
      {
        key: "cancelType", label: "Cancel Type", type: "select", required: false,
        options: ["Cancel with 10% Penalty", "Cancel without Penalty"],
        showIf: { field: "issueType", oneOf: ["Bonus Cancel Related Issue"] },
      },
      {
        key: "recycleAmount", label: "Recycle Amount (Rs.)", type: "number", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Return To Main"] },
      },
      {
        key: "turnoverRequirement", label: "Turnover Requirement", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "turnoverCompleted", label: "Turnover Completed", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force"] },
      },
      {
        key: "accountStatus", label: "Account Status", type: "select", required: false,
        options: ["Suspended -- player wants to deposit", "Account Inactive", "Suspended -- Player has been warned"],
        showIf: { field: "issueType", oneOf: ["Account Suspend / Inactive"] },
      },
      {
        key: "vipLevel", label: "VIP Level", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["VIP Level Update Issue"] },
      },
      {
        key: "registeredNumber", label: "Registered Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "kycEmail", label: "E-mail", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "updateRequest", label: "Update Request", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "fullName", label: "Full Name", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "aadharPan", label: "Aadhar / Pan Card Number", type: "text", required: false,
        placeholder: "Type the number, or upload a screenshot below instead",
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Account Suspend / Inactive", "Bonus Cancel Related Issue"] },
      },
      {
        key: "issueDescription", label: "Issue Description", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Others Bonus Related Issue", "VIP Level Update Issue", "KYC Issues", "Remove Bank Account", "Others Issues"] },
      },
      {
        key: "bankAccountNo", label: "Account NO", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankAccountHolderName", label: "Account Holder Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankIfscCode", label: "IFSC Code", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankBranch", label: "Branch", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "bankName", label: "Bank Name", type: "text", required: true,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Verify Bank Detail"] },
      },
    ],
  },
  {
    id: "promotion_request",
    name: "Promotion Request",
    icon: "🎟️",
    formTitle: "Promotion Request",
    accent: "#F472B6",
    description: "Bonus request",
    reporterLabel: "Processed by",
    attachments: DEFAULT_ATTACHMENTS,
    // Brand+Promotion combos with a single fixed amount (no Tier/Deposits
    // selector needed) — Amount auto-locks to this the moment both are
    // picked. Keyed by "<brandId>|<promotion value>".
    fixedAmounts: {
      "betjili|Review Bonus": 150,
    },
    fields: [
      {
        key: "promotion", label: "Promotion", type: "select", required: true, emphasize: true,
        // Options depend on the selected Brand — see optionsByBrand below.
        // Brands/promotions not listed here yet just show no options until added.
        optionsByBrand: {
          betjili: ["Birthday Bonus", "Review Bonus"],
          betvisa: ["Birthday Bonus"],
        },
      },
      { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      {
        key: "tid", label: "TID", type: "text", required: true, placeholder: "e.g. BVXXXBB1020",
        generate: true, // shows a button that fetches the next TID from the sheet
      },
      {
        key: "nid", label: "NID No", type: "text", required: false,
        showIf: { field: "promotion", oneOf: ["Birthday Bonus"] },
      },
      {
        key: "tier", label: "Tier Level", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betvisa"] },
        ],
        // Selecting a tier auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betvisa: [
            { value: "Bronze", amount: 300 },
            { value: "Silver", amount: 1000 },
            { value: "Gold", amount: 2000 },
            { value: "Platinum", amount: 3000 },
            { value: "Diamond", amount: 4000 },
            { value: "Legend", amount: 5000 },
          ],
        },
      },
      {
        key: "deposits", label: "Number of Deposits", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betjili"] },
        ],
        // Selecting a deposit count auto-fills + locks the Amount field below.
        autoFillsInto: "amount",
        optionsByBrand: {
          betjili: [
            { value: "10 Deposits", amount: 1000 },
            { value: "20 Deposits", amount: 2000 },
            { value: "30 Deposits", amount: 3000 },
            { value: "40 Deposits", amount: 4000 },
            { value: "50 Deposits", amount: 5000 },
          ],
        },
      },
      { key: "amount", label: "Amount", type: "number", required: true, placeholder: "e.g. 200.00" },
    ],
  },
  {
    id: "daily_report",
    name: "Daily Report",
    icon: "📊",
    formTitle: "Daily Report",
    accent: "#34D399",
    description: "Daily issue report",
    reporterLabel: "Reported by",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      { key: "shift", label: "Shift", type: "select", required: true, emphasize: true, options: ["Day Shift", "Night Shift"] },
      { key: "reportDate", label: "Date", type: "date", required: true },
      { key: "majorIssues", label: "Major Issues", type: "textarea", required: false },
      { key: "csIssues", label: "CS Issues", type: "textarea", required: false },
      { key: "paymentIssues", label: "Payment Issues", type: "textarea", required: false },
      { key: "minorSystemBugs", label: "Minor System Bugs", type: "textarea", required: false },
      { key: "domainControl", label: "Domain Control", type: "textarea", required: false },
      { key: "providerIssues", label: "Provider Issues", type: "textarea", required: false },
      { key: "promotionQuests", label: "Promotion Quests", type: "textarea", required: false },
      { key: "othersIssues", label: "Others Issues", type: "textarea", required: false },
    ],
  },
  {
    id: "genie_issue",
    name: "Genie Issue",
    icon: "🤖",
    formTitle: "Genie Issues",
    accent: "#A78BFA",
    description: "Genie chat issues",
    reporterLabel: "PIC",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      { key: "issueDetails", label: "Issue Details", type: "textarea", required: true, placeholder: "Describe the Genie issue..." },
      { key: "chatLinks", label: "Chat Link(s)", type: "textarea", required: true, placeholder: "Chat links (multiple allowed, one per line)..." },
    ],
  },
];

// Shared across pages via <script src="/assets/schemas.js"></script> (no modules, keep it simple + cache-friendly)
window.BRANDS = BRANDS;
window.MODULES = MODULES;
