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
  const RETRY_MS = 15000;                           // wait before retrying a failed save

  const listeners = { change: [], status: [], conflict: [] };
  const emit = (name, payload) => listeners[name].forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });

  let sb = null;             // Supabase client
  let saveTimer = null;
  let pollTimer = null;
  let channel = null;
  let inFlight = null;       // promise of the current save, to serialise writes
  let queued = null;         // most recent document awaiting a save
  let restarting = false;    // Store.restart is replacing the live document

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
    get hasPendingWrite() { return restarting || !!(queued || inFlight) || localStorage.getItem(PENDING_KEY) === "1"; },
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

    // The cloud copy replaces the mirror, so a "pending" marker left by an
    // earlier page is stale; left set, it would block live updates and the
    // restart for good.
    const clearStalePending = () => { if (!queued && !inFlight) localStorage.removeItem(PENDING_KEY); };
    try {
      const row = await fetchRow();
      if (row) {
        Store.revision = row.revision;
        Store.lastSyncedAt = row.updated_at;
        localStorage.setItem(REV_KEY, String(row.revision));
        writeMirror(row.doc);
        clearStalePending();
        setState("ready");
        return { doc: row.doc, source: "cloud" };
      }

      // Signed in but nothing stored yet — seed the cloud from whatever we
      // have locally (mirror first, then a bundled budget-data.json).
      const seed = mirror || (await fetchSeed());
      if (seed) {
        await createRow(seed);
        clearStalePending();
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
    if (restarting) return;               // it would be the document being replaced
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
    // A failed push puts its document back in the queue; carrying on at once
    // would spin (offline, it would hang the page). It's retried later instead.
    if (inFlight) return inFlight.then(ok => { if (ok && queued) return pump(); });
    if (!queued) return Promise.resolve();
    const doc = queued;
    queued = null;
    inFlight = pushDoc(doc).finally(() => { inFlight = null; });
    return inFlight.then(ok => { if (ok && queued) return pump(); });
  }

  // Resolves true once the document is dealt with, false if it went back in the queue.
  async function pushDoc(doc) {
    if (!navigator.onLine) { if (!queued) queued = doc; setState("offline"); return false; }  // "online" flushes it
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
        if (!row) { await createRow(doc); localStorage.removeItem(PENDING_KEY); return true; }
        emit("conflict", { local: doc, remote: row.doc, remoteRevision: row.revision, remoteUpdatedAt: row.updated_at });
        setState("ready");
        return true;
      }

      Store.revision = data[0].revision;
      Store.lastSyncedAt = data[0].updated_at;
      localStorage.setItem(REV_KEY, String(Store.revision));
      localStorage.removeItem(PENDING_KEY);
      setState("ready");
      return true;
    } catch (e) {
      console.warn("cloud save failed", e);
      if (!queued) queued = doc;          // keep it for the next attempt (unless a newer one is waiting)
      setState(navigator.onLine ? "error" : "offline", { error: e.message });
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { pump(); }, RETRY_MS);
      return false;
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

  /* ---------------- restart (one-off, docs/plans/pay-period-budgeting.md 3.6) ---------------- */

  const LOCAL_ARCHIVE_KEY = MIRROR_KEY + "_archive";

  /**
   * Keep `oldDoc` as an archive, then replace the live budget with `newDoc`.
   * Cloud: the archive is a new row, "<docKey>-archive" (or -2, -3… if that
   * exists, so an archive is never overwritten); the live row is then updated
   * only if no other device has saved since this one loaded it.
   * Local: the archive goes in this browser next to the budget.
   * Resolves to {archiveKey}. Throws an Error whose message says what
   * happened; the live budget is unchanged whenever it throws.
   */
  Store.restart = async function (oldDoc, newDoc) {
    if (restarting) throw new Error("A restart is already running.");
    if (Store.configured && !Store.user) {
      throw new Error("Sign in first, so the restart reaches every device. Nothing was changed.");
    }
    if (Store.mode !== "cloud" || !Store.user) {
      let key = LOCAL_ARCHIVE_KEY;
      for (let n = 2; localStorage.getItem(key) != null; n++) key = LOCAL_ARCHIVE_KEY + "_" + n;
      try {
        localStorage.setItem(key, JSON.stringify(oldDoc));
        localStorage.setItem(MIRROR_KEY, JSON.stringify(newDoc));
      } catch (e) {
        localStorage.removeItem(key);
        throw new Error("This browser's storage is full, so the old budget couldn't be archived. Nothing was changed.");
      }
      Store.lastSyncedAt = new Date().toISOString();
      emit("status", Store.status());
      return { archiveKey: key };
    }

    if (!navigator.onLine) throw new Error("You're offline. Connect to the internet and try again. Nothing was changed.");
    await Store.flush();
    if (Store.hasPendingWrite) {
      throw new Error("Your latest changes haven't reached the cloud yet" + (Store.lastError ? " (" + Store.lastError + ")" : "") +
        ". Nothing was changed. Wait for \"synced\" and try again.");
    }
    restarting = true;
    clearTimeout(saveTimer);
    try {
      const row = await fetchRow();
      if (!row) throw new Error("Couldn't find your budget in the cloud. Nothing was changed.");
      if (row.revision !== Store.revision) {
        throw new Error("This budget has changed on another device. Reload the page and run the restart again. Nothing was changed.");
      }
      const archiveKey = await insertArchive(oldDoc);
      let res;
      try {
        res = await sb
          .from("budget_documents")
          .update({ doc: newDoc, revision: row.revision + 1, updated_at: new Date().toISOString() })
          .eq("user_id", Store.user.id)
          .eq("doc_key", CFG.docKey)
          .eq("revision", row.revision)
          .select("revision, updated_at");
      } catch (e) { res = { error: e }; }
      if (res.error || !res.data || !res.data.length) {
        throw new Error("The old budget was archived (" + archiveKey + "), but the new one couldn't be saved" +
          (res.error ? " (" + res.error.message + ")" : ": the budget changed on another device") +
          ". Your live budget is unchanged. Reload the page and try again.");
      }
      queued = null;
      Store.revision = res.data[0].revision;
      Store.lastSyncedAt = res.data[0].updated_at;
      localStorage.setItem(REV_KEY, String(Store.revision));
      localStorage.removeItem(PENDING_KEY);
      writeMirror(newDoc);
      setState("ready", { error: null });
      return { archiveKey };
    } finally {
      restarting = false;
    }
  };

  async function insertArchive(doc) {
    for (let n = 1; n <= 50; n++) {
      const key = CFG.docKey + "-archive" + (n === 1 ? "" : "-" + n);
      const { error } = await sb
        .from("budget_documents")
        .insert({ user_id: Store.user.id, doc_key: key, doc, revision: 1 });
      if (!error) return key;
      if (error.code !== "23505") throw new Error("Couldn't save the archive (" + error.message + "). Nothing was changed.");
    }
    throw new Error("Couldn't find a free name for the archive. Nothing was changed.");
  }

  /* ---------------- live updates from other devices ---------------- */

  function startRealtime() {
    if (!sb || channel) return;
    try {
      channel = sb
        .channel("budget-doc")
        .on("postgres_changes",
          { event: "UPDATE", schema: "public", table: "budget_documents", filter: `user_id=eq.${Store.user.id}` },
          (payload) => {
            // The channel can only filter on one column, so archive documents
            // (other doc_keys) arrive here too — never let one replace the live budget.
            if (!payload.new || payload.new.doc_key !== CFG.docKey) return;
            const rev = payload.new.revision;
            if (!rev || rev <= Store.revision) return;    // our own write echoing back, or old news
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
        // Only take a newer revision, and only if nothing was saved while we
        // waited: a reply sent before a save can arrive after it.
        if (row && row.revision > Store.revision && !Store.hasPendingWrite) {
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
