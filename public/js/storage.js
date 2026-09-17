"use strict";
/* =========================================================================
   Budget 2026 — storage layer.

   One job: own *where the data lives*, so the rest of the app never has to
   care. The app calls load()/save() and listens for events; this module
   decides whether that means Supabase Postgres, this browser, or both.

   Modes
     "cloud"  - signed in to Supabase. The document is a single JSONB row
                keyed by (user_id, doc_key). Every device reads and writes
                that one row, so your phone and your PC show the same
                numbers. A localStorage mirror is kept so the app still
                opens instantly and keeps working offline.
     "local"  - no Supabase configured, or signed out. Behaves like the
                original single-file app: localStorage only.

   Concurrency
     The row carries an integer `revision`. Saves are conditional on the
     revision we last read. If another device moved it on, the write is
     rejected rather than silently clobbering their edits, and a "conflict"
     event is emitted for the UI to resolve.
   ========================================================================= */

(function () {
  const CFG = window.BUDGET_CONFIG || {};
  const MIRROR_KEY = "jk_budget_2026";              // shared with the legacy app
  const PENDING_KEY = "jk_budget_pending_v1";       // offline write queue marker
  const REV_KEY = "jk_budget_rev_v1";

  const listeners = { change: [], status: [], conflict: [] };
  const emit = (name, payload) => listeners[name].forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });

  let sb = null;             // Supabase client
  let saveTimer = null;
  let pollTimer = null;
  let channel = null;
  let inFlight = null;       // promise of the current save, to serialise writes
  let queued = null;         // most recent document awaiting a save

  const Store = {
    mode: "local",
    state: "booting",        // booting | signed-out | ready | offline | error
    user: null,
    revision: 0,
    lastSyncedAt: null,
    lastError: null,

    on(evt, fn) { (listeners[evt] || (listeners[evt] = [])).push(fn); return () => Store.off(evt, fn); },
    off(evt, fn) { const a = listeners[evt] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },

    get configured() { return !!CFG.isConfigured; },
    get signedIn() { return !!Store.user; },
    get hasPendingWrite() { return !!(queued || inFlight) || localStorage.getItem(PENDING_KEY) === "1"; },
  };

  function setState(state, extra) {
    Store.state = state;
    if (extra && extra.error !== undefined) Store.lastError = extra.error;
    emit("status", Store.status());
  }

  Store.status = function () {
    return {
      mode: Store.mode,
      state: Store.state,
      email: Store.user ? Store.user.email : null,
      revision: Store.revision,
      lastSyncedAt: Store.lastSyncedAt,
      pending: Store.hasPendingWrite,
      error: Store.lastError,
      configured: Store.configured,
      online: navigator.onLine,
    };
  };

  /* ---------------- local mirror ---------------- */

  function readMirror() {
    try {
      const raw = localStorage.getItem(MIRROR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { console.warn("mirror read failed", e); return null; }
  }

  function writeMirror(doc) {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(doc)); }
    catch (e) { console.warn("mirror write failed (quota?)", e); }
  }

  /* ---------------- init ---------------- */

  Store.init = async function () {
    if (!Store.configured || typeof window.supabase === "undefined") {
      Store.mode = "local";
      setState("ready");
      return Store.status();
    }

    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    const { data: { session } } = await sb.auth.getSession();
    applySession(session);

    sb.auth.onAuthStateChange((_event, s) => {
      const was = Store.user && Store.user.id;
      applySession(s);
      if ((Store.user && Store.user.id) !== was) emit("change", { reason: "auth" });
    });

    window.addEventListener("online", () => { if (Store.mode === "cloud") { setState("ready"); flushPending(); } });
    window.addEventListener("offline", () => { if (Store.mode === "cloud") setState("offline"); });

    return Store.status();
  };

  function applySession(session) {
    Store.user = session ? session.user : null;
    if (Store.user) {
      Store.mode = "cloud";
      setState(navigator.onLine ? "ready" : "offline");
      startRealtime();
      startPolling();
    } else {
      Store.mode = "cloud";
      stopRealtime();
      stopPolling();
      setState("signed-out");
    }
  }

  /* ---------------- auth ---------------- */

  Store.signInWithPassword = async function (email, password) {
    requireClient();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    applySession(data.session);
    return data.user;
  };

  Store.signUp = async function (email, password) {
    requireClient();
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    if (data.session) applySession(data.session);
    return data;
  };

  Store.sendMagicLink = async function (email) {
    requireClient();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  };

  Store.signOut = async function () {
    if (!sb) return;
    await sb.auth.signOut();
    applySession(null);
  };

  function requireClient() {
    if (!sb) throw new Error("Cloud sync is not configured. Add your Supabase URL and anon key in js/config.js.");
  }

  /* ---------------- load ---------------- */

  /**
   * Resolve the document to open.
   * Returns {doc, source} where source is "cloud" | "local" | "seed" | null.
   */
  Store.load = async function () {
    const mirror = readMirror();

    if (Store.mode !== "cloud" || !Store.user) {
      if (mirror) return { doc: mirror, source: "local" };
      const seed = await fetchSeed();
      return seed ? { doc: seed, source: "seed" } : { doc: null, source: null };
    }

    try {
      const row = await fetchRow();
      if (row) {
        Store.revision = row.revision;
        Store.lastSyncedAt = row.updated_at;
        localStorage.setItem(REV_KEY, String(row.revision));
        writeMirror(row.doc);
        setState("ready");
        return { doc: row.doc, source: "cloud" };
      }

      // Signed in but nothing stored yet — seed the cloud from whatever we
      // have locally (mirror first, then a bundled budget-data.json).
      const seed = mirror || (await fetchSeed());
      if (seed) {
        await createRow(seed);
        return { doc: seed, source: "cloud-seeded" };
      }
      return { doc: null, source: null };
    } catch (e) {
      console.warn("cloud load failed, falling back to local mirror", e);
      setState(navigator.onLine ? "error" : "offline", { error: e.message });
      if (mirror) return { doc: mirror, source: "local" };
      return { doc: null, source: null };
    }
  };

  async function fetchSeed() {
    try {
      const r = await fetch("budget-data.json", { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (e) { /* not served, or absent — fine */ }
    return null;
  }

  async function fetchRow() {
    const { data, error } = await sb
      .from("budget_documents")
      .select("doc, revision, updated_at")
      .eq("user_id", Store.user.id)
      .eq("doc_key", CFG.docKey)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function createRow(doc) {
    const { data, error } = await sb
      .from("budget_documents")
      .insert({ user_id: Store.user.id, doc_key: CFG.docKey, doc, revision: 1 })
      .select("revision, updated_at")
      .single();
    if (error) throw error;
    Store.revision = data.revision;
    Store.lastSyncedAt = data.updated_at;
    writeMirror(doc);
    setState("ready");
  }

  /* ---------------- save ---------------- */

  /** Debounced save. Always writes the local mirror immediately. */
  Store.save = function (doc) {
    writeMirror(doc);
    if (Store.mode !== "cloud" || !Store.user) { Store.lastSyncedAt = new Date().toISOString(); emit("status", Store.status()); return; }
    queued = doc;
    localStorage.setItem(PENDING_KEY, "1");
    emit("status", Store.status());
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { pump(); }, CFG.saveDebounceMs || 900);
  };

  /** Force any queued write out now (used before sign-out / page hide). */
  Store.flush = async function () {
    clearTimeout(saveTimer);
    await pump();
    return Store.status();
  };

  function pump() {
    if (inFlight) return inFlight.then(() => { if (queued) return pump(); });
    if (!queued) return Promise.resolve();
    const doc = queued;
    queued = null;
    inFlight = pushDoc(doc).finally(() => { inFlight = null; });
    return inFlight.then(() => { if (queued) return pump(); });
  }

  async function pushDoc(doc) {
    if (!navigator.onLine) { queued = doc; setState("offline"); return; }
    try {
      const nextRev = (Store.revision || 0) + 1;
      const { data, error } = await sb
        .from("budget_documents")
        .update({ doc, revision: nextRev, updated_at: new Date().toISOString() })
        .eq("user_id", Store.user.id)
        .eq("doc_key", CFG.docKey)
        .eq("revision", Store.revision)
        .select("revision, updated_at");

      if (error) throw error;

      if (!data || data.length === 0) {
        // Somebody else moved the row on. Don't clobber them.
        const row = await fetchRow();
        if (!row) { await createRow(doc); localStorage.removeItem(PENDING_KEY); return; }
        emit("conflict", { local: doc, remote: row.doc, remoteRevision: row.revision, remoteUpdatedAt: row.updated_at });
        setState("ready");
        return;
      }

      Store.revision = data[0].revision;
      Store.lastSyncedAt = data[0].updated_at;
      localStorage.setItem(REV_KEY, String(Store.revision));
      localStorage.removeItem(PENDING_KEY);
      setState("ready");
    } catch (e) {
      console.warn("cloud save failed", e);
      queued = doc;                       // keep it for the next attempt
      setState(navigator.onLine ? "error" : "offline", { error: e.message });
    }
  }

  /** Resolve a conflict by deliberately overwriting whatever is in the cloud. */
  Store.forceOverwrite = async function (doc) {
    const row = await fetchRow();
    Store.revision = row ? row.revision : 0;
    if (!row) return createRow(doc);
    queued = doc;
    return pump();
  };

  /** Resolve a conflict by discarding local edits and taking the cloud copy. */
  Store.takeRemote = async function () {
    const row = await fetchRow();
    if (!row) return null;
    queued = null;
    Store.revision = row.revision;
    Store.lastSyncedAt = row.updated_at;
    writeMirror(row.doc);
    localStorage.removeItem(PENDING_KEY);
    setState("ready");
    return row.doc;
  };

  function flushPending() { if (queued) pump(); }

  /* ---------------- live updates from other devices ---------------- */

  function startRealtime() {
    if (!sb || channel) return;
    try {
      channel = sb
        .channel("budget-doc")
        .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "budget_documents", filter: `user_id=eq.${Store.user.id}` },
          (payload) => {
            const rev = payload.new && payload.new.revision;
            if (!rev || rev === Store.revision) return;   // our own write echoing back
            if (Store.hasPendingWrite) return;            // we're mid-edit; poll/conflict will sort it
            Store.revision = rev;
            Store.lastSyncedAt = payload.new.updated_at;
            writeMirror(payload.new.doc);
            emit("change", { reason: "remote", doc: payload.new.doc });
          })
        .subscribe();
    } catch (e) { console.warn("realtime unavailable", e); }
  }

  function stopRealtime() { if (channel && sb) { sb.removeChannel(channel); channel = null; } }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (Store.mode !== "cloud" || !Store.user || !navigator.onLine) return;
      if (Store.hasPendingWrite || document.hidden) return;
      try {
        const row = await fetchRow();
        if (row && row.revision !== Store.revision) {
          Store.revision = row.revision;
          Store.lastSyncedAt = row.updated_at;
          writeMirror(row.doc);
          emit("change", { reason: "remote", doc: row.doc });
        }
      } catch (e) { /* transient */ }
    }, CFG.pollIntervalMs || 30000);
  }

  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  // Best-effort final save when the tab goes away.
  window.addEventListener("pagehide", () => { if (queued) navigatorFlush(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && queued) pump(); });
  function navigatorFlush() { try { pump(); } catch (e) { /* nothing more we can do */ } }

  window.BudgetStore = Store;
})();
