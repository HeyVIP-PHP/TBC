// create-owner-account.js
//
// Run this LOCALLY on your own computer (never uploaded, never deployed)
// to generate the two `wrangler kv key put` commands that create a
// hidden Owner account. See OWNER_ROLE_SETUP.md §5 for the full writeup
// — this is "Method A: create a brand-new Owner account from scratch".
// If you'd rather upgrade an EXISTING account to Owner (keeping its
// current password), skip this script entirely and use Method B in that
// doc instead (edit the KV value's "role" field directly in the
// Cloudflare dashboard).
//
// Usage:
//   node create-owner-account.js <username> <password>
//
// The password never leaves your machine — this only hashes it locally
// and prints commands for YOU to run with your own `wrangler login`
// session.
const crypto = require("crypto");
const PBKDF2_ITERATIONS = 10000; // must match PBKDF2_ITERATIONS_CURRENT in functions/_shared/accounts.js

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256").toString("base64");
}

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error("Usage: node create-owner-account.js <username> <password>");
  process.exit(1);
}

const key = username.toLowerCase();
const salt = crypto.randomBytes(16);
const account = {
  username: key,
  salt: salt.toString("base64"),
  hash: hashPassword(password, salt),
  iterations: PBKDF2_ITERATIONS,
  tokenVersion: 0,
  role: "owner",
  officeId: null, // owner is exempt from the Office+IP check — see officeIpCheckPasses() in accounts.js
  allowedBrands: "all",
  allowedModules: "all",
  fullName: "",
  pid: "",
  lastActiveAt: null,
  lastPasswordChange: { at: new Date().toISOString(), by: key },
  locked: false,
  lockedAt: null,
  lockedReason: null,
};

console.log(`wrangler kv key put --binding=THREADS_KV "account:${key}" '${JSON.stringify(account)}' --remote`);
console.log(`\nThen add "${key}" to the accounts-index array (check the existing contents with a 'get' first, then paste them back in alongside the new username):`);
console.log(`wrangler kv key get --binding=THREADS_KV "accounts-index" --remote`);
console.log(`wrangler kv key put --binding=THREADS_KV "accounts-index" '["${key}", ...existing array contents...]' --remote`);
