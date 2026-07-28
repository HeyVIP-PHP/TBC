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
  { id: "crickex", name: "Crickex" },
  { id: "betjili", name: "Betjili" },
  { id: "mostplay", name: "Mostplay" },
  { id: "jeetwin", name: "Jeetwin" },
  { id: "sbj66", name: "Sbj66" },
  { id: "heybaji", name: "Heybaji" },
  { id: "superbaji", name: "Superbaji" },
  { id: "kv8", name: "KV8" },
  { id: "darazplay", name: "Darazplay" },
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
          "Update Information",
        ],
      },
      { key: "uid", label: "UID", type: "text", required: true, placeholder: "Player UID...",
        showIf: { field: "issueType", oneOf: [
          "Register Number Verification", "Add Mobile Number Verify", "Add Number Remove",
          "Registration Number Inputted Wrong", "Gmail Verification", "Gmail Remove",
          "Customer Email Change / Inactive / Lost", "Forgot Password (OTP Limit Exceeded)", "KYC Issues",
          "Update Information",
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
      { key: "nid", label: "CNIC Card Number", type: "text", required: false, placeholder: "CNIC card number...",
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
      { key: "aadharPan", label: "CNIC Card Number", type: "text", required: false,
        showIf: { field: "issueType", oneOf: ["Register Number Verification", "Add Number Remove", "KYC Issues"] },
      },
      {
        key: "updateInfoType", label: "Request", type: "select", required: true,
        options: ["Change Name", "Change Birth Date", "Update (Real Name & Birth of Date)"],
        showIf: { field: "issueType", oneOf: ["Update Information"] },
      },
      // -- Change Name --
      { key: "previousName", label: "Previous Name (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      { key: "newName", label: "New Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Name"] }],
      },
      // -- Change Birth Date --
      { key: "previousBirthDate", label: "Previous Birth Date (Remove)", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      { key: "newBirthDate", label: "New Birth Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Change Birth Date"] }],
      },
      // -- Update (combined) — both optional & independent, agent fills whichever apply --
      { key: "realName", label: "Real Name", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "birthDate", label: "Birth of Date", type: "text", required: false,
        showIf: [{ field: "issueType", oneOf: ["Update Information"] }, { field: "updateInfoType", oneOf: ["Update (Real Name & Birth of Date)"] }],
      },
      { key: "remark", label: "Issue & Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
    ],
  },
  {
    id: "withdraw_issue",
    name: "Withdraw Issue",
    icon: "💸",
    accent: "#4ADE80",
    description: "Select brand and issue type",
    attachments: DEFAULT_ATTACHMENTS,
    fields: [
      {
        key: "issueType", label: "Issue Type", type: "select", required: true, emphasize: true,
        options: [
          "Withdraw Want to Cancel",
          "Wrong Wallet — Want to Cancel",
          "Withdraw Disapproved",
          "Withdraw Approved but Not Received",
          "Withdraw Amount Received Less",
          "Withdraw Reversed Back to Agent",
          "Withdraw Follow Up",
        ],
      },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      { key: "tid", label: "TID", type: "text", required: true, placeholder: "Transaction ID..." },
      // -- Withdraw Amount Received Less -- (exclusive to this type)
      { key: "submittedAmount", label: "Submitted Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "receivedAmount", label: "Received Amount (Rs.)", type: "number", required: true, placeholder: "0.00",
        showIf: { field: "issueType", oneOf: ["Withdraw Amount Received Less"] },
      },
      { key: "remark", label: "Remark", type: "textarea", required: false, placeholder: "Additional remarks..." },
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
        key: "aadharPan", label: "CNIC Card Number", type: "text", required: false,
        placeholder: "Type the number, or upload a screenshot below instead",
        showIf: { field: "issueType", oneOf: ["KYC Issues"] },
      },
      {
        key: "remark", label: "Remark", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Bonus Auto Force", "Bonus Manual Force", "Return To Main", "Account Suspend / Inactive", "Bonus Cancel Related Issue"] },
      },
      {
        key: "issueDescription", label: "Issue Description", type: "textarea", required: false,
        showIf: { field: "issueType", oneOf: ["Others Bonus Related Issue", "VIP Level Update Issue", "KYC Issues", "Remove Bank Account", "Verify Bank Detail", "Others Issues"] },
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
    // Brand+Promotion combos with a single fixed amount (no Tier/Deposits/
    // Rank selector needed) — Amount auto-locks to this the moment both
    // Brand and Promotion are picked. Keyed by "<brandId>|<promotion value>".
    // Confirmed with the business owner this session (screenshot of the
    // real reference Google Sheet + a full brand-by-brand rules list) —
    // see PROMOTION_SHEET_CONFIG in functions/_shared/routing.js for the
    // matching per-combo Sheet/tab this writes into.
    //
    // Not every combo below is a flat number — 3 of them (Betjili/Mostplay
    // Birthday Bonus, Jeetwin Birthday Bonus, Darazplay Birthday Bonus)
    // are tiered instead, handled by the "deposits"/"tier"/"playerRank"
    // select fields further down (each has its own per-brand amount table
    // and auto-fills Amount the same way once picked).
    fixedAmounts: {
      "crickex|Birthday Bonus": 1000,
      "betjili|Facebook Review Free Bonus": 200,
      "betjili|Rs 500 Free Cash On App Download-PKR": 500,
      "mostplay|Facebook Review Free Bonus": 200,
      "mostplay|Download & Claim": 200,
      "jeetwin|Download JeetWin APP & Claim Cash": 300,
      "heybaji|Birthday Bonus": 1000,
      "heybaji|Download HeyBaji APP & Claim Cash": 299,
      "superbaji|Birthday Bonus": 2000,
      "superbaji|Download SuberBaji APP & Claim Cash": 200,
      "sbj66|Birthday Bonus": 2000,
      "sbj66|Download SBJ66 APP & Claim Cash": 199,
      "kv8|Birthday Bonus": 1500,
      "kv8|Download KV8 APP & Claim 199 Cash": 199,
      "darazplay|Rs.200 Download DarazPlay App": 200,
    },
    fields: [
      {
        key: "promotion", label: "Promotion", type: "select", required: true, emphasize: true,
        // Options depend on the selected Brand — see optionsByBrand below.
        // Brands/promotions not listed here yet just show no options until added.
        optionsByBrand: {
          crickex: ["Birthday Bonus"],
          betjili: ["Birthday Bonus", "Facebook Review Free Bonus", "Rs 500 Free Cash On App Download-PKR"],
          mostplay: ["Birthday Bonus", "Facebook Review Free Bonus", "Download & Claim"],
          jeetwin: ["Birthday Bonus", "Download JeetWin APP & Claim Cash"],
          heybaji: ["Birthday Bonus", "Download HeyBaji APP & Claim Cash"],
          superbaji: ["Birthday Bonus", "Download SuberBaji APP & Claim Cash"],
          sbj66: ["Birthday Bonus", "Download SBJ66 APP & Claim Cash"],
          kv8: ["Birthday Bonus", "Download KV8 APP & Claim 199 Cash"],
          darazplay: ["Birthday Bonus", "Rs.200 Download DarazPlay App"],
        },
      },
      { key: "date", label: "Date", type: "date", required: true, defaultToday: true },
      { key: "username", label: "Username", type: "text", required: true, placeholder: "Player username..." },
      {
        key: "tid", label: "TID", type: "text", required: true, placeholder: "e.g. CXPKRBD0029",
        generate: true, // shows a button that fetches the next TID from the sheet
      },
      {
        // Betjili's and Mostplay's Birthday Bonus both use a "Number of
        // Deposits" tier, but with two DIFFERENT amount tables — same
        // field, brand-specific options (optionsByBrand), same pattern
        // "promotion" itself uses above.
        key: "deposits", label: "Number of Deposits", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["betjili", "mostplay"] },
        ],
        autoFillsInto: "amount",
        optionsByBrand: {
          betjili: [
            { value: "10 Deposits", amount: 3000 },
            { value: "20 Deposits", amount: 6000 },
            { value: "30 Deposits", amount: 9000 },
            { value: "40 Deposits", amount: 12000 },
            { value: "50 Deposits", amount: 15000 },
          ],
          mostplay: [
            { value: "10 Deposits", amount: 1000 },
            { value: "20 Deposits", amount: 1500 },
            { value: "30 Deposits", amount: 2000 },
          ],
        },
      },
      {
        // Jeetwin-only tier selector for its Birthday Bonus.
        key: "tier", label: "Tier Level", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["jeetwin"] },
        ],
        autoFillsInto: "amount",
        options: [
          { value: "Bronze", amount: 1000 },
          { value: "Silver", amount: 1000 },
          { value: "Gold", amount: 2000 },
          { value: "Platinum", amount: 3000 },
          { value: "Diamond", amount: 4000 },
          { value: "Legend", amount: 5000 },
        ],
      },
      {
        // Darazplay-only rank selector for its Birthday Bonus — same
        // auto-fill mechanism as Tier Level/Number of Deposits above,
        // just a different field name matching what Darazplay actually
        // calls these tiers.
        key: "playerRank", label: "Player Rank", type: "select", required: false,
        showIf: [
          { field: "promotion", oneOf: ["Birthday Bonus"] },
          { field: "brand", oneOf: ["darazplay"] },
        ],
        autoFillsInto: "amount",
        options: [
          { value: "Beginner/Player", amount: 1000 },
          { value: "Pro-Player/Expert/Master", amount: 1500 },
          { value: "Above Grand master", amount: 2500 },
        ],
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
