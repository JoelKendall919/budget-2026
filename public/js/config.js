"use strict";
/* =========================================================================
   Budget 2026 — runtime configuration.

   These two values are PUBLIC by design. The Supabase "anon" key is a
   client-side publishable key; it grants no access on its own. All real
   protection comes from Row Level Security in supabase/schema.sql, which
   restricts every row to its owning authenticated user.

   NEVER put the `service_role` key in this file.

   To point the app at your own Supabase project, replace the two values
   below (or override them at deploy time — see .github/workflows/deploy.yml,
   which substitutes them from repository secrets).
   ========================================================================= */

window.BUDGET_CONFIG = {
  // e.g. "https://abcdefghijklm.supabase.co"
  supabaseUrl: "__SUPABASE_URL__",

  // The project's publishable key. Supabase now issues these as
  // "sb_publishable_..."; older projects have a JWT-style "anon" key
  // beginning "eyJ...". Either works.
  supabaseAnonKey: "__SUPABASE_ANON_KEY__",

  // Logical name of the document row. Lets you keep e.g. a "2026" and a
  // "2027" budget in the same account without them colliding.
  docKey: "budget-2026",

  // Milliseconds of inactivity before an edit is pushed to the cloud.
  saveDebounceMs: 900,

  // Poll interval for picking up edits made on another device, in ms.
  // Realtime is used when available; this is the safety net.
  pollIntervalMs: 30000,
};

/* Treat the placeholders as "not configured" so the app falls back to local
   mode instead of trying to talk to a bogus endpoint.

   Two key formats are accepted: the current "sb_publishable_..." keys, and
   the legacy JWT "anon" keys that start "eyJ". Matching on shape rather
   than length matters — a publishable key is only ~45 characters, so a
   naive length test sits uncomfortably close to rejecting a valid one. */
(function () {
  const c = window.BUDGET_CONFIG;
  const key = String(c.supabaseAnonKey || "");

  const urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(c.supabaseUrl);
  const keyOk = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key) ||
                /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);

  c.isConfigured = urlOk && keyOk;

  // A secret key in a browser would hand anyone full read/write access to
  // every row, bypassing RLS entirely. Refuse to start rather than do that.
  if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
    c.isConfigured = false;
    console.error(
      "[budget] That is a SECRET Supabase key. Never put it in a web page — " +
      "it bypasses row-level security. Use the publishable key instead."
    );
  } else if (key && !key.startsWith("__") && !keyOk) {
    console.warn("[budget] Supabase key is not a recognised format; staying in local mode.");
  }
})();