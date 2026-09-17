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

  // the project's anon / publishable key
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

// Treat the placeholders as "not configured" so the app falls back to local
// mode instead of trying to talk to a bogus endpoint.
window.BUDGET_CONFIG.isConfigured =
  /^https:\/\/.+\.supabase\.co/.test(window.BUDGET_CONFIG.supabaseUrl) &&
  window.BUDGET_CONFIG.supabaseAnonKey.length > 40;
