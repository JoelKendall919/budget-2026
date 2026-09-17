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
  supabaseUrl: "https://klppkmahfpgkfpquwgmq.supabase.co",

  // The project's publishable key. Supabase now issues these as
  // "sb_publishable_..."; older projects have a JWT-style "anon" key
  // beginning "eyJ...". Either works.
  supabaseAnonKey: "sb_publishable_PVsEosuCca3rD1eEroXI5w_7b6Ca3_h",

  // Logical name of the document row. Lets you keep e.g. a "2026" and a
  // "2027" budget in the same account without them colliding.
  docKey: "budget-2026",

  // Milliseconds of inactivity before an edit is pushed to the cloud.
  saveDebounceMs: 900,

  // Poll interval for picking up edits made on another device, in ms.
  // Realtime is used when available; this is the safety net.
  pollIntervalMs: 30000,
};

/* Decide whether we have usable credentials. If not, the app falls back to
   local mode rather than talking to a bogus endpoint.

   Two key formats are accepted: the current "sb_publishable_..." keys, and
   the legacy JWT "anon" keys that start "eyJ". Matching on shape rather
   than length matters — a publishable key is only ~45 characters, so a
   naive length test sits uncomfortably close to rejecting a valid one.

   `configError` explains any rejection, so the UI can say what is wrong
   instead of quietly showing an empty app. */
(function () {
  const c = window.BUDGET_CONFIG;
  const key = String(c.supabaseAnonKey || "").trim();
  let url = String(c.supabaseUrl || "").trim();

  c.configError = null;

  // The dashboard displays the REST endpoint (".../rest/v1") more
  // prominently than the bare project URL, so pasting the longer one is an
  // easy mistake. supabase-js wants the origin, so just take it.
  const m = url.match(/^https:\/\/[A-Za-z0-9-]+\.supabase\.(?:co|in)/i);
  if (m) url = m[0].toLowerCase();
  c.supabaseUrl = url;

  const placeholder = url.startsWith("__") || key.startsWith("__");
  const urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(url);
  const keyOk = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key) ||
                /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);

  // A secret key in a browser would hand anyone full read/write access to
  // every row, bypassing RLS entirely. Refuse to start rather than do that.
  const isSecret = /^sb_secret_/.test(key) || /^service_role$/.test(key);

  if (isSecret) {
    c.configError = "That is a SECRET Supabase key. Never put it in a web page — " +
                    "it bypasses row-level security. Use the publishable key " +
                    "(sb_publishable_…) instead.";
  } else if (placeholder || (!url && !key)) {
    c.configError = null;                       // untouched repo; not an error
  } else if (!urlOk) {
    c.configError = "supabaseUrl should look like https://yourproject.supabase.co " +
                    "— got \"" + (c.supabaseUrl || "(empty)") + "\".";
  } else if (!keyOk) {
    c.configError = "supabaseAnonKey should be the publishable key " +
                    "(sb_publishable_…) or a legacy anon JWT (eyJ…).";
  }

  c.isConfigured = urlOk && keyOk && !isSecret;

  if (c.configError) console.error("[budget] " + c.configError);
})();