"use strict";
// Run with: node --test tests/
// storage.js is browser code, so it runs here in a sandbox with a fake
// browser (localStorage, navigator, timers) and a fake Supabase client over
// an in-memory table. Nothing here talks to a real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "js", "storage.js"), "utf8");
const KEY = "budget-2026", USER = { id: "u1", email: "me@example.com" };
const MIRROR = "jk_budget_2026", PENDING = "jk_budget_pending_v1", ARCHIVE = "jk_budget_2026_archive";
// values from the sandbox belong to another realm; compare them as plain JSON
const plain = x => (x == null ? x : JSON.parse(JSON.stringify(x)));
const doc = name => ({ meta: { name }, transactions: [], income: [] });

// The budget_documents table: one row per (user_id, doc_key), as the real
// unique constraint enforces. `hook(q)` runs before each query and may
// return a result to use instead, or a promise (to hold the query in flight).
function fakeTable() {
  const rows = new Map(), log = [];
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)).toISOString();
  const keyOf = q => (q.payload && q.payload.doc_key) || (q.filters.find(f => f[0] === "doc_key") || [])[1];
  const t = { log, hook: null };
  t.put = (docKey, d, revision) => rows.set(docKey, { user_id: USER.id, doc_key: docKey, doc: plain(d), revision, updated_at: stamp() });
  t.get = docKey => rows.get(docKey) || null;
  t.exec = async q => {
    log.push(q.op + ":" + keyOf(q));
    if (t.hook) { const r = await t.hook(q); if (r) return r; }
    const match = r => q.filters.every(([c, v]) => r[c] === v);
    if (q.op === "select") {
      const r = [...rows.values()].find(match);
      return { data: r ? { doc: plain(r.doc), revision: r.revision, updated_at: r.updated_at } : null, error: null };
    }
    if (q.op === "insert") {
      const p = q.payload;
      if (rows.has(p.doc_key)) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      t.put(p.doc_key, p.doc, p.revision);
      const r = rows.get(p.doc_key);
      return { data: q.mode === "single" ? { revision: r.revision, updated_at: r.updated_at } : null, error: null };
    }
    if (q.op === "update") {
      const hit = [...rows.values()].filter(match);
      hit.forEach(r => { r.doc = plain(q.payload.doc); r.revision = q.payload.revision; r.updated_at = stamp(); });
      return { data: hit.map(r => ({ revision: r.revision, updated_at: r.updated_at })), error: null };
    }
    throw new Error("unexpected query " + q.op);
  };
  return t;
}

function fakeSupabase(table, session) {
  const realtime = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    channel() { const ch = { on(_type, _filter, cb) { realtime.push(cb); return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {},
    from() {
      const q = { op: null, payload: null, filters: [], mode: null };
      const run = () => table.exec(q);
      const b = {
        select() { if (!q.op) q.op = "select"; return b; },
        insert(p) { q.op = "insert"; q.payload = p; return b; },
        update(p) { q.op = "update"; q.payload = p; return b; },
        eq(c, v) { q.filters.push([c, v]); return b; },
        maybeSingle() { q.mode = "maybeSingle"; return run(); },
        single() { q.mode = "single"; return run(); },
        then(ok, bad) { return run().then(ok, bad); },
      };
      return b;
    },
  };
  return { createClient: () => client, realtime };
}

// A page with storage.js loaded. Timers are recorded, never run by themselves.
function page({ configured = true, signedIn = true, local = {} } = {}) {
  const table = fakeTable(), ls = new Map(Object.entries(local)), timers = new Map(), on = {};
  let nextTimer = 1;
  const addTimer = (fn, ms, repeat) => { timers.set(nextTimer, { fn, ms, repeat }); return nextTimer++; };
  const sb = fakeSupabase(table, signedIn ? { user: USER } : null);
  const localStorage = {
    getItem: k => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); },
    removeItem: k => { ls.delete(k); },
  };
  const navigator = { onLine: true };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    localStorage, navigator,
    document: { hidden: false, addEventListener() {} },
    location: { origin: "https://example.test", pathname: "/" },
    fetch: async () => ({ ok: false }),
    setTimeout: (fn, ms) => addTimer(fn, ms, false),
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms) => addTimer(fn, ms, true),
    clearInterval: id => { timers.delete(id); },
    addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); },
    BUDGET_CONFIG: { isConfigured: configured, supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "k", docKey: KEY },
    supabase: configured ? sb : undefined,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "storage.js" });
  const Store = ctx.BudgetStore, changes = [];
  Store.on("change", e => changes.push(e));
  return {
    Store, table, ls, localStorage, navigator, timers, changes, realtime: sb.realtime,
    fire: type => (on[type] || []).forEach(fn => fn()),
    poll: () => [...timers.values()].find(t => t.repeat).fn(),
    mirror: () => JSON.parse(ls.get(MIRROR)),
  };
}
// Signed in, with the live budget already in the cloud, and loaded.
async function cloudPage({ live = doc("old"), rev = 1, local } = {}) {
  const p = page({ local });
  p.table.put(KEY, live, rev);
  await p.Store.init();
  p.loaded = await p.Store.load();
  return p;
}
const writes = p => p.table.log.filter(x => !x.startsWith("select"));

/* ---------------- restart, signed in ---------------- */
test("restart: the old budget is saved as a new archive row, then the live one is replaced", async () => {
  const p = await cloudPage({ rev: 4 });
  const res = await p.Store.restart(doc("old"), doc("new"));
  assert.equal(res.archiveKey, KEY + "-archive");
  assert.deepEqual(writes(p), ["insert:" + KEY + "-archive", "update:" + KEY], "archive first");
  assert.deepEqual(plain(p.table.get(KEY + "-archive").doc), doc("old"));
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("new"));
  assert.equal(p.table.get(KEY).revision, 5);
  assert.equal(p.Store.revision, 5);
  assert.deepEqual(p.mirror(), doc("new"));
  assert.equal(p.Store.hasPendingWrite, false);
  // and saving carries on from the new revision
  p.Store.save(doc("new, edited"));
  await p.Store.flush();
  assert.equal(p.table.get(KEY).revision, 6);
});

test("restart: an earlier archive is never overwritten", async () => {
  const p = await cloudPage();
  p.table.put(KEY + "-archive", doc("first archive"), 1);
  const res = await p.Store.restart(doc("old"), doc("new"));
  assert.equal(res.archiveKey, KEY + "-archive-2");
  assert.deepEqual(plain(p.table.get(KEY + "-archive").doc), doc("first archive"));
  assert.deepEqual(plain(p.table.get(KEY + "-archive-2").doc), doc("old"));
});

test("restart: an edit still waiting to save goes to the cloud first", async () => {
  const p = await cloudPage();
  p.Store.save(doc("old, edited"));
  assert.equal(p.table.get(KEY).revision, 1, "still waiting out the debounce");
  await p.Store.restart(doc("old, edited"), doc("new"));
  assert.deepEqual(writes(p), ["update:" + KEY, "insert:" + KEY + "-archive", "update:" + KEY]);
  assert.equal(p.table.get(KEY).revision, 3);
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("new"));
});

test("restart: refuses, changing nothing, while an edit can't reach the cloud", async () => {
  const p = await cloudPage();
  p.table.hook = q => (q.op === "update" ? { data: null, error: { message: "network down" } } : null);
  p.Store.save(doc("old, edited"));
  await assert.rejects(p.Store.restart(doc("old, edited"), doc("new")), { message: /haven't reached the cloud yet \(network down\)/ });
  assert.equal(p.table.get(KEY + "-archive"), null);
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("old"));
});

test("restart: refuses, changing nothing, when another device has saved since this one loaded", async () => {
  const p = await cloudPage();
  p.table.put(KEY, doc("from the phone"), 2);
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /changed on another device/ });
  assert.equal(p.table.get(KEY + "-archive"), null);
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("from the phone"));
  assert.equal(p.Store.hasPendingWrite, false, "not left stuck mid-restart");
});

test("restart: a save from another device landing mid-restart is not overwritten", async () => {
  const p = await cloudPage();
  p.table.hook = q => { if (q.op === "insert") p.table.put(KEY, doc("from the phone"), 2); return null; };
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /archived \(budget-2026-archive\).*changed on another device.*unchanged/ });
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("from the phone"));
});

test("restart: if the new budget can't be saved, the archive stays and the live budget is unchanged", async () => {
  const p = await cloudPage();
  p.table.hook = q => (q.op === "update" ? { data: null, error: { message: "timeout" } } : null);
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /archived \(budget-2026-archive\).*\(timeout\).*unchanged/ });
  assert.deepEqual(plain(p.table.get(KEY + "-archive").doc), doc("old"));
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("old"));
  assert.equal(p.Store.revision, 1);
  assert.deepEqual(p.mirror(), doc("old"));
  p.table.hook = null;
  p.Store.save(doc("old, edited"));
  await p.Store.flush();
  assert.equal(p.table.get(KEY).revision, 2, "saving still works");
});

test("restart: saves made while it runs are dropped (they're edits to the budget being replaced)", async () => {
  const p = await cloudPage();
  p.table.hook = q => { if (q.op === "insert") p.Store.save(doc("late edit")); return null; };
  await p.Store.restart(doc("old"), doc("new"));
  p.table.hook = null;
  await p.Store.flush();
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("new"));
  assert.deepEqual(p.mirror(), doc("new"));
  assert.equal(p.Store.hasPendingWrite, false);
});

test("restart: refuses when offline", async () => {
  const p = await cloudPage();
  p.navigator.onLine = false;
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /offline/ });
  assert.deepEqual(writes(p), []);
});

test("restart: refuses when cloud sync is set up but you're signed out", async () => {
  const p = page({ signedIn: false, local: { [MIRROR]: JSON.stringify(doc("old")) } });
  await p.Store.init();
  assert.equal(p.Store.state, "signed-out");
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /Sign in first/ });
  assert.equal(p.ls.get(ARCHIVE), undefined);
  assert.deepEqual(p.mirror(), doc("old"));
  assert.deepEqual(p.table.log, []);
});

/* ---------------- restart, no cloud ---------------- */
test("restart, local mode: the archive is kept in this browser, never overwritten", async () => {
  const p = page({ configured: false, local: { [MIRROR]: JSON.stringify(doc("old")) } });
  await p.Store.init();
  assert.equal(p.Store.mode, "local");
  assert.equal((await p.Store.restart(doc("old"), doc("new"))).archiveKey, ARCHIVE);
  assert.deepEqual(JSON.parse(p.ls.get(ARCHIVE)), doc("old"));
  assert.deepEqual(p.mirror(), doc("new"));
  assert.equal((await p.Store.restart(doc("new"), doc("newer"))).archiveKey, ARCHIVE + "_2");
  assert.deepEqual(JSON.parse(p.ls.get(ARCHIVE)), doc("old"));
});

test("restart, local mode: if storage is full nothing changes", async () => {
  const p = page({ configured: false, local: { [MIRROR]: JSON.stringify(doc("old")) } });
  await p.Store.init();
  const set = p.localStorage.setItem;
  p.localStorage.setItem = (k, v) => { if (k === MIRROR) throw new Error("QuotaExceededError"); set(k, v); };
  await assert.rejects(p.Store.restart(doc("old"), doc("new")), { message: /storage is full/ });
  assert.equal(p.ls.get(ARCHIVE), undefined);
  assert.deepEqual(p.mirror(), doc("old"));
});

/* ---------------- saving ---------------- */
test("save: offline, the edit waits (flush doesn't hang) and goes once back online", async () => {
  const p = await cloudPage();
  p.navigator.onLine = false;
  p.Store.save(doc("edited offline"));
  await p.Store.flush();
  assert.equal(p.Store.state, "offline");
  assert.equal(p.Store.hasPendingWrite, true);
  assert.equal(p.table.get(KEY).revision, 1);
  p.navigator.onLine = true;
  p.fire("online");
  await p.Store.flush();
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("edited offline"));
  assert.equal(p.Store.hasPendingWrite, false);
});

test("save: a failed save is kept and retried later, without hanging flush", async () => {
  const p = await cloudPage();
  p.table.hook = q => (q.op === "update" ? { data: null, error: { message: "503" } } : null);
  p.Store.save(doc("edited"));
  await p.Store.flush();
  assert.equal(p.Store.state, "error");
  assert.equal(p.Store.hasPendingWrite, true);
  const retry = [...p.timers.values()].find(t => !t.repeat && t.ms === 15000);
  assert.ok(retry, "a retry is scheduled");
  p.table.hook = null;
  retry.fn();
  await p.Store.flush();
  assert.deepEqual(plain(p.table.get(KEY).doc), doc("edited"));
  assert.equal(p.Store.state, "ready");
  assert.equal(p.Store.hasPendingWrite, false);
});

/* ---------------- loading and other devices ---------------- */
test("load: a 'pending' marker left by an earlier page is cleared once the cloud copy is in", async () => {
  const p = await cloudPage({ local: { [PENDING]: "1", [MIRROR]: JSON.stringify(doc("stale")) } });
  assert.deepEqual(plain(p.loaded.doc), doc("old"));
  assert.equal(p.ls.get(PENDING), undefined);
  assert.equal(p.Store.hasPendingWrite, false);
  p.table.put(KEY, doc("from the phone"), 2);
  await p.poll();
  assert.equal(p.changes.length, 1, "changes from other devices come through again");
});

test("polling: takes a newer revision from another device", async () => {
  const p = await cloudPage();
  p.table.put(KEY, doc("from the phone"), 2);
  await p.poll();
  assert.equal(p.changes.length, 1);
  assert.deepEqual(plain(p.changes[0].doc), doc("from the phone"));
  assert.equal(p.Store.revision, 2);
  assert.deepEqual(p.mirror(), doc("from the phone"));
});

test("polling: a reply overtaken by an edit on this device is ignored", async () => {
  const p = await cloudPage();
  let release;
  p.table.hook = q => (q.op === "select" ? new Promise(res => { release = () => res(null); }) : null);
  const polled = p.poll();
  p.table.put(KEY, doc("from the phone"), 2);
  p.Store.save(doc("typed meanwhile"));
  release();
  await polled;
  assert.equal(p.changes.length, 0);
  assert.equal(p.Store.revision, 1);
  assert.deepEqual(p.mirror(), doc("typed meanwhile"));
});

test("realtime: an archive row changing never replaces the live budget", async () => {
  const p = await cloudPage();
  const send = row => p.realtime.forEach(cb => cb({ new: row }));
  send({ doc_key: KEY + "-archive", revision: 9, doc: doc("archive"), updated_at: "x" });
  assert.equal(p.changes.length, 0);
  assert.equal(p.Store.revision, 1);
  send({ doc_key: KEY, revision: 2, doc: doc("from the phone"), updated_at: "x" });
  assert.equal(p.changes.length, 1);
  assert.deepEqual(plain(p.changes[0].doc), doc("from the phone"));
});
