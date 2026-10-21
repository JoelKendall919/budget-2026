"use strict";
/* =========================================================================
   Budget 2026 — a personal budgeting app.

   The document (transactions, income, budgets, bills, rules) is a single
   JSON object held in `DATA`. Where that object is stored is entirely the
   business of js/storage.js: signed in, it lives in Supabase Postgres and
   syncs to every device; otherwise it falls back to this browser.

   Everything below is view + domain logic. It never touches the network.
   ========================================================================= */

const LS_KEY = "jk_budget_2026";
/* ---------- theme: light / dark / auto (follow the OS) ---------- */
const THEME_KEY = "jk_budget_theme";
function applyTheme(t){
  if(t==="auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme",t);
  document.querySelectorAll("#themeBtns button").forEach(b=>b.classList.toggle("on",b.dataset.themeSet===t));
}
function setTheme(t){ localStorage.setItem(THEME_KEY,t); applyTheme(t); }
applyTheme(localStorage.getItem(THEME_KEY)||"auto");   // before first paint
document.addEventListener("DOMContentLoaded",()=>{
  document.querySelectorAll("#themeBtns button").forEach(b=>b.onclick=()=>setTheme(b.dataset.themeSet));
  applyTheme(localStorage.getItem(THEME_KEY)||"auto");
});
const GBP = new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP"});
const money = v => GBP.format(v||0);
const money0 = v => GBP.format(Math.round(v||0)).replace(/\.00$/,"");
const CAT_COLOR = {
  "Bills":"var(--c-Bills)","Groceries":"var(--c-Groceries)","Pub/Social":"var(--c-PubSocial)",
  "Takeaway/Restaurant":"var(--c-Takeaway)","Travel/Car":"var(--c-Travel)","Gifts":"var(--c-Gifts)",
  "Other":"var(--c-Other)","Savings":"var(--c-Savings)",
  "Pub & Social":"var(--c-PubSocial)","Eating out":"var(--c-Takeaway)","Transport":"var(--c-Travel)",
  "Shopping":"var(--c-Shopping)","Health & Personal":"var(--c-Health)","Home":"var(--c-Home)"
};
const catColor = c => CAT_COLOR[c] || "var(--c-Other)";

let DATA = null;                 // the whole document
let dirty = false;
let view = "dashboard";
// dashboard/transactions period state
let period = {grain:"month", month:null, week:null};
let txFilter = {cat:"All", card:"All", q:"", status:"All"};
let incFilter = {source:"All", q:"", status:"All"};
let ledgerFilter = {account:"All", type:"All", cat:"All", status:"All", q:"", sort:"new"};
let dashboardHideZeroBills=true;

/* ---------- date helpers ---------- */
const parseD = s => { const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); };
const monthKey = s => s.slice(0,7);                       // "2026-03"
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = k => { const [y,m]=k.split("-"); return MONTHS[+m-1]+" "+y; };
function isoWeek(date){
  const d=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));
  const day=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-day+3);
  const first=new Date(Date.UTC(d.getUTCFullYear(),0,4));
  const week=1+Math.round(((d-first)/86400000-3+((first.getUTCDay()+6)%7))/7);
  return {year:d.getUTCFullYear(),week};
}
const weekKey = s => { const {year,week}=isoWeek(parseD(s)); return year+"-W"+String(week).padStart(2,"0"); };
function weekRangeLabel(wk){
  // wk = "2026-W12" -> "Mon dd–dd Mon"
  const [y,w]=wk.split("-W").map(Number);
  const simple=new Date(Date.UTC(y,0,1+(w-1)*7));
  const dow=simple.getUTCDay(); const mon=new Date(simple);
  mon.setUTCDate(simple.getUTCDate()-((dow+6)%7));
  const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
  const f=d=>d.getUTCDate()+" "+MONTHS[d.getUTCMonth()];
  return f(mon)+" – "+f(sun);
}
const todayISO = () => new Date().toISOString().slice(0,10);
// Mon/Sun bounds of an ISO week key ("2026-W12"), as local dates
function weekBounds(wk){
  const [y,w]=wk.split("-W").map(Number);
  const simple=new Date(Date.UTC(y,0,1+(w-1)*7));
  const dow=simple.getUTCDay(); const mon=new Date(simple);
  mon.setUTCDate(simple.getUTCDate()-((dow+6)%7));
  const sun=new Date(mon); sun.setUTCDate(mon.getUTCDate()+6);
  return {start:new Date(mon.getUTCFullYear(),mon.getUTCMonth(),mon.getUTCDate()),
          end:new Date(sun.getUTCFullYear(),sun.getUTCMonth(),sun.getUTCDate())};
}

/* ---------- data helpers ---------- */
const expenseCats = () => DATA.categories.filter(c=>c!=="Savings");
// every month owns its own independent category-budget + bill-budget record —
// no default/override chain, so setting one month never silently affects another.
function categoryBudget(mk, cat){
  const r=DATA.monthlyBudgets[mk]; if(!r) return 0;
  // the Bills category budget is never entered directly - it's always the sum of
  // that month's monthly bills budget, so the two can never drift apart.
  if(cat==="Bills") return Object.values(r.bills||{}).reduce((s,v)=>s+(+v||0),0);
  return r.categories[cat]??0;
}
function billBudget(mk, name){ const r=DATA.monthlyBudgets[mk]; return r ? (r.bills[name]??0) : 0; }
function budgetFor(month, cat){ return categoryBudget(month, cat); }
function txInPeriod(t){
  if(period.grain==="all") return true;
  if(period.grain==="pp") return Model.rowPeriodKey(DATA, t)===ppPeriod().key;
  if(period.grain==="year") return t.date.slice(0,4)===String(period.year||2026);
  if(period.grain==="month") return monthKey(t.date)===period.month;
  if(period.grain==="week") return weekKey(t.date)===period.week;
  return true;
}
// txInPeriod for many rows (works the pay period out once)
function periodTest(){
  if(period.grain!=="pp") return txInPeriod;
  const key=ppPeriod().key;
  return t=>Model.rowPeriodKey(DATA, t)===key;
}
// [from, to] of the selected week / month / year / all, as ISO dates
function rangeOf(){
  if(period.grain==="week"){ const b=weekBounds(period.week); return [isoOf(b.start), isoOf(b.end)]; }
  if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); return [period.month+"-01", period.month+"-"+String(Periods.daysInMonth(y,mo)).padStart(2,"0")]; }
  if(period.grain==="year") return [period.year+"-01-01", period.year+"-12-31"];
  return [DATA.meta.startDate, lastDay()];
}
// today, or the latest row if that's later
function lastDay(){ return [...DATA.transactions,...DATA.income].reduce((a,r)=>r.date>a?r.date:a, Periods.localISO()); }
const nextMonthKey = k => { const [y,mo]=k.split("-").map(Number); return mo===12 ? (y+1)+"-01" : y+"-"+String(mo+1).padStart(2,"0"); };
// a transaction counts as spending only if its category is a real budget category
const isSpend = t => DATA.categories.includes(t.category);

// ---- category splits (transactions): one statement row, several budget categories ----
function catAllocations(t){
  if(t.categorySplits && t.categorySplits.length) return t.categorySplits.filter(s=>s.category);
  return (t.category!=null && t.category!=="") ? [{category:t.category, amount:t.amount}] : [];
}
function catAssigned(t){ return catAllocations(t).reduce((s,a)=>s+(+a.amount||0),0); }
function catUnassignedAmt(t){ return Math.round((t.amount - catAssigned(t))*100)/100; }
function catAmount(t, cat){ return catAllocations(t).filter(a=>a.category===cat).reduce((s,a)=>s+(+a.amount||0),0); }
// ---- source splits (income): one deposit, several income sources ----
function srcAllocations(t){
  if(t.sourceSplits && t.sourceSplits.length) return t.sourceSplits.filter(s=>s.source);
  return (t.source!=null && t.source!=="") ? [{source:t.source, amount:t.amount}] : [];
}
function srcAssigned(t){ return srcAllocations(t).reduce((s,a)=>s+(+a.amount||0),0); }
function srcUnassignedAmt(t){ return Math.round((t.amount - srcAssigned(t))*100)/100; }
function srcAmount(t, src){ return srcAllocations(t).filter(a=>a.source===src).reduce((s,a)=>s+(+a.amount||0),0); }
function periodLabel(){
  if(period.grain==="pp") return "Pay period "+Periods.label(ppPeriod());
  if(period.grain==="all") return "All time";
  if(period.grain==="year") return String(period.year||2026);
  if(period.grain==="month") return monthLabel(period.month);
  if(period.grain==="week") return weekRangeLabel(period.week);
}
// Restarted: every month / week / year from the restart to today (or the latest row).
function availableMonths(){
  if(Model.isRestarted(DATA)){
    const out=[], end=lastDay().slice(0,7);
    for(let k=DATA.meta.startDate.slice(0,7); k<=end; k=nextMonthKey(k)) out.push(k);
    return out;
  }
  const s=new Set(DATA.transactions.map(t=>monthKey(t.date)).concat(DATA.income.map(t=>monthKey(t.date))));
  return [...s].sort();
}
function availableWeeks(){
  if(Model.isRestarted(DATA)){
    const s=new Set(), last=lastDay();
    for(let d=DATA.meta.startDate; d<=last; d=Periods.addDays(d,7)) s.add(weekKey(d));
    s.add(weekKey(last));
    return [...s].sort();
  }
  const s=new Set(DATA.transactions.map(t=>weekKey(t.date)));
  return [...s].sort();
}
function availableYears(){
  const out=[]; for(let y=+DATA.meta.startDate.slice(0,4); y<=+lastDay().slice(0,4); y++) out.push(y);
  return out;
}

/* ---------- persistence ----------
   The app no longer owns *where* the data lives — BudgetStore does. Every
   mutation calls markDirty(), which hands the document to the store; the
   store mirrors it locally at once and pushes it to Supabase (debounced) so
   the same numbers show up on every device. */
const Store = window.BudgetStore;
function markDirty(){ dirty=true; refreshSaveIndicator(); scheduleSave(); }
let saveTimer=null;
function scheduleSave(){ clearTimeout(saveTimer); saveTimer=setTimeout(persist, 400); }
async function persist(){
  saveTimer=null;
  if(!DATA) return;
  Store.save(DATA);
  refreshSaveIndicator();
}
// Hand an edit still waiting out the debounce to the store straight away.
function flushAppSave(){ if(saveTimer){ clearTimeout(saveTimer); persist(); } }
function refreshSaveIndicator(){
  const dot=document.getElementById("saveDot"), t=document.getElementById("saveText");
  const fl=document.getElementById("fileLabel");
  if(!dot||!t) return;
  if(!DATA){ dot.className="dot"; t.textContent="no data"; return; }
  const s=Store.status();
  let cls="on", label, file;
  if(s.mode!=="cloud" || s.state==="signed-out"){
    cls = dirty ? "dirty" : "on";
    label = "this device only";
    file  = s.configured ? "not signed in" : "local mode";
  } else if(s.state==="offline"){
    cls="dirty"; label="offline — will sync"; file=s.email||"cloud";
  } else if(s.state==="error"){
    cls="dirty"; label="sync problem"; file=s.email||"cloud";
  } else if(s.pending){
    cls="dirty"; label="syncing…"; file=s.email||"cloud";
  } else {
    cls="on";
    label = s.lastSyncedAt ? "synced "+shortTime(s.lastSyncedAt) : "synced";
    file  = s.email||"cloud";
  }
  dot.className="dot "+cls;
  t.textContent=label;
  if(fl) fl.textContent=file;
}
function shortTime(iso){
  try{
    const d=new Date(iso), now=new Date();
    const sec=Math.max(0,Math.round((now-d)/1000));
    if(sec<60) return "just now";
    if(sec<3600) return Math.floor(sec/60)+"m ago";
    if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});
    return d.toLocaleDateString("en-GB",{day:"numeric",month:"short"});
  }catch(e){ return ""; }
}
// Keep the footer indicator honest as the store changes state in the background.
Store.on("status",()=>{ if(!Store.hasPendingWrite) dirty=false; refreshSaveIndicator(); if(view==="restart") refreshWiz(); });

/* ---------- load ---------- */
function migrate(d){
  d.categories = d.categories||[];
  // confirmed defaults to true for anything already in the file (historical, already
  // reviewed). Imports set confirmed:false explicitly, which the spread preserves.
  d.transactions = (d.transactions||[]).map((t,i)=>({confirmed:true,flagged:false,card:"Debit",...t,id:t.id||("t"+i)}));
  d.income = (d.income||[]).map((t,i)=>({confirmed:true,card:"Debit",...t,id:t.id||("i"+i)}));
  d.accounts = d.accounts||{openingFlex:0,savings:[]};
  // `creditPaid` and `creditCardBalance` used to be stored here. Both are
  // now derived from the ledger on every render (see renderAccounts), and
  // the stored copies went stale — they were snapshots that stopped being
  // updated, which made the Accounts tab disagree with reality. Drop them
  // so nothing can read the wrong number.
  delete d.accounts.creditPaid; delete d.accounts.creditCardBalance;
  if(d.accounts.openingCredit==null) d.accounts.openingCredit=0;
  d.accounts.cash = d.accounts.cash || {n50:0,n20:0,n10:0,n5:0,coins:0};   // notes counted; coins as one amount
  d.accounts.cash.coins = +d.accounts.cash.coins || 0;   // added later - backfill on existing data
  d.wealthSnapshots = d.wealthSnapshots || [];   // [{date,savings,cash}] - one per day, recorded on open/Accounts visit

  // A budget restarted from a payday (pay periods, Bills and Budget tabs):
  // fill in anything missing, and undo what an older copy of the app may
  // have done to it (see Model.tidyDoc). Repairs are saved once loaded.
  if(Model.isRestarted(d)){
    const {notes}=Model.tidyDoc(d);
    if(notes.length) setTimeout(()=>{ if(DATA===d){ toast(notes.join(" ")); markDirty(); } },0);
    return d;
  }
  d.rules = dedupeRules(d.rules||[]);

  // ---- one-time migration: budgetDefault/budgets/billOverrides + bills(amount,frequency)
  // -> DATA.monthlyBudgets (every month fully independent, no default/override chain)
  // + DATA.yearlyBills (a separate, non-monthly budget) + DATA.bills (monthly bill
  // TYPE identities only - name/notes, no amount). Requested: monthly category budgets
  // and monthly bill budgets set independently per month, with yearly bills separate.
  if(!d.monthlyBudgets){
    const oldBills=d.bills||[];
    const monthlyDefs=oldBills.filter(b=>(b.frequency||"Monthly")!=="Yearly");
    const yearlyDefs=oldBills.filter(b=>b.frequency==="Yearly");
    const oldDefault=d.budgetDefault||{}, oldBudgets=d.budgets||{}, oldOverrides=d.billOverrides||{};
    const months=new Set();
    (d.transactions||[]).forEach(t=>months.add((t.date||"").slice(0,7)));
    (d.income||[]).forEach(t=>months.add((t.date||"").slice(0,7)));
    Object.keys(oldBudgets).forEach(mk=>months.add(mk));
    Object.keys(oldOverrides).forEach(mk=>months.add(mk));
    months.delete("");
    d.monthlyBudgets={};
    [...months].sort().forEach(mk=>{
      const categories={}; d.categories.forEach(c=>{ categories[c]=(oldBudgets[mk]&&oldBudgets[mk][c]!=null)?oldBudgets[mk][c]:(oldDefault[c]??0); });
      const bills={}; monthlyDefs.forEach(b=>{ bills[b.name]=(oldOverrides[mk]&&oldOverrides[mk][b.name]!=null)?oldOverrides[mk][b.name]:(b.amount??0); });
      d.monthlyBudgets[mk]={categories,bills};
    });
    d.yearlyBills=yearlyDefs.map(b=>({name:b.name,amount:b.amount||0,notes:b.notes||""}));
    d.bills=monthlyDefs.map(b=>({name:b.name,notes:b.notes||""}));
    delete d.budgetDefault; delete d.budgets; delete d.billOverrides;
  }
  d.yearlyBills = d.yearlyBills||[];
  d.bills = d.bills||[];
  return d;
}
// Lower-case, no duplicates, longest match first; transfer rules keep their transfer.
function dedupeRules(rules){ return Model.normaliseRules(rules); }
async function boot(){
  await Store.init();
  const {doc} = await Store.load();
  if(doc){ DATA=migrate(doc); afterLoad(); }
  else { render(); }          // signed-out / empty -> renderFirstRun via render()

  // Another device saved: pull the change in without losing where the user is.
  Store.on("change", async (e)=>{
    if(e.reason==="auth"){
      const r=await Store.load();
      DATA = r.doc ? migrate(r.doc) : null;
      if(DATA) afterLoad(); else render();
      return;
    }
    if(e.reason==="remote" && e.doc){
      DATA=migrate(e.doc);
      dirty=false;
      render();
      toast("Updated from another device");
    }
  });

  Store.on("conflict", onSyncConflict);
}

/* Two devices edited the same budget while one was offline. Rather than
   silently picking a winner, ask — the losing side's edits are real money. */
function onSyncConflict(c){
  if(document.getElementById("conflictModal")) return;
  const bg=el(`<div class="modal-bg" id="conflictModal"><div class="modal">
    <h3 style="margin:0 0 6px">This budget changed on another device</h3>
    <p class="muted" style="font-size:13px;margin:0 0 16px">
      Another device saved changes at ${new Date(c.remoteUpdatedAt).toLocaleString("en-GB")} while this one had
      unsaved edits. Pick which version to keep — the other is discarded.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn pri" id="cf-remote">Use the other device's version</button>
      <button class="btn danger" id="cf-local">Keep what's on this device</button>
    </div>
    <p class="muted" style="font-size:12px;margin:14px 0 0">
      This device: ${(c.local.transactions||[]).length} spends / ${(c.local.income||[]).length} income.
      Other device: ${(c.remote.transactions||[]).length} spends / ${(c.remote.income||[]).length} income.</p>
  </div></div>`);
  document.body.appendChild(bg);
  bg.querySelector("#cf-remote").onclick=async()=>{
    const doc=await Store.takeRemote();
    if(doc){ DATA=migrate(doc); dirty=false; }
    bg.remove(); render();
  };
  bg.querySelector("#cf-local").onclick=async()=>{
    await Store.forceOverwrite(DATA);
    bg.remove(); render();
  };
}

/* Small, non-blocking status message. */
function toast(msg){
  let t=document.getElementById("toast");
  if(!t){ t=el(`<div id="toast" class="toast"></div>`); document.body.appendChild(t); }
  t.textContent=msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove("show"),2600);
}
function afterLoad(){
  if(Model.isRestarted(DATA)){
    const t=Periods.localISO();
    period.grain="pp"; period.month=t.slice(0,7); period.week=weekKey(t); period.year=+t.slice(0,4);
  } else {
    const months=availableMonths();
    period.month = months.includes("2026-"+String(new Date().getMonth()+1).padStart(2,"0"))
        ? "2026-"+String(new Date().getMonth()+1).padStart(2,"0")
        : months[months.length-1];
    period.week = availableWeeks().slice(-1)[0];
    period.year = 2026;
  }
  recordWealthSnapshot();
  render();
}
const NOTE_DENOMS=[[50,"n50"],[20,"n20"],[10,"n10"],[5,"n5"]];
// notes are counted, coins are a single amount (counting individual coins isn't worth it)
function cashTotalOf(cash){
  if(!cash) return 0;
  return NOTE_DENOMS.reduce((s,[v,k])=>s+v*(+cash[k]||0),0) + (+cash.coins||0);
}
// upsert today's savings+cash total. One point per day is enough for a trend; cheap
// and idempotent, so it's safe to call on every Accounts visit too.
function recordWealthSnapshot(){
  if(!DATA) return;
  const a=DATA.accounts;
  const savings=(a.savings||[]).reduce((s,sv)=>s+(+sv.balance||0),0);
  const cash=cashTotalOf(a.cash);
  const today=todayISO();
  const existing=DATA.wealthSnapshots.find(s=>s.date===today);
  if(existing){ if(existing.savings!==savings||existing.cash!==cash){ existing.savings=savings; existing.cash=cash; markDirty(); } }
  else { DATA.wealthSnapshots.push({date:today,savings,cash}); DATA.wealthSnapshots.sort((x,y)=>x.date.localeCompare(y.date)); markDirty(); }
}

/* ============================ RENDER ==================================== */
function render(){
  refreshSaveIndicator();
  const navView = view==="restart" ? "data" : view;
  document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===navView));
  const m=document.getElementById("main");
  if(!DATA){ renderFirstRun(); return; }
  if(period.grain==="pp" && !Model.isRestarted(DATA)) period.grain="month";
  updateBadges();
  ({dashboard:renderDashboard,ledger:renderLedger,transactions:renderLedger,income:renderLedger,
    bills:renderBills,budget:renderBudgetTab,budgets:renderBudgetTab,restart:renderRestart,
    import:renderImport,rules:renderRules,accounts:renderAccounts,data:renderData}[view]||renderDashboard)(m);
}
function updateBadges(){
  const e=document.getElementById("badge-ledger"); if(!e) return;
  const n = DATA ? DATA.transactions.filter(t=>!t.confirmed).length + DATA.income.filter(t=>!t.confirmed).length : 0;
  e.textContent = n>0 ? n : "";
}
document.querySelectorAll(".nav").forEach(b=>b.onclick=()=>{view=b.dataset.view;render()});

/* ---------- period selector (shared) ---------- */
function periodControls(onchange){
  const wrap=document.createElement("div"); wrap.className="flex wrap";
  const seg=document.createElement("div"); seg.className="seg";
  const restarted=Model.isRestarted(DATA);
  const grains=[["week","Week"],["month","Month"],["year","Year"],["all","All"]];
  if(restarted) grains.unshift(["pp","Pay period"]);
  grains.forEach(([g,lab])=>{
    const b=document.createElement("button"); b.textContent=lab; b.className=period.grain===g?"on":"";
    b.onclick=()=>{period.grain=g; onchange();}; seg.appendChild(b);
  });
  wrap.appendChild(seg);
  const select=(opts, cur, set)=>{
    const s=document.createElement("select");
    opts.forEach(([v,lab])=>{const o=document.createElement("option");o.value=v;o.textContent=lab;o.selected=v===cur;s.appendChild(o)});
    s.onchange=()=>{set(s.value);onchange()}; wrap.appendChild(s);
  };
  if(period.grain==="pp"){
    const cy=Model.cycleOf(DATA), p=ppPeriod(), now=Periods.periodFor(cy, Periods.localISO()), first=Periods.periodFor(cy, Model.startOf(DATA));
    const opts=[];
    for(let n=first.index; n<=Math.max(now.index,p.index); n++){ const q=Periods.periodAt(cy,n); opts.push([q.key, Periods.label(q)+(n===now.index?" (now)":"")]); }
    select(opts, p.key, v=>{ ppKey = v===now.key ? null : v; });
  } else if(period.grain==="month"){
    select(availableMonths().map(k=>[k,monthLabel(k)]), period.month, v=>{period.month=v;});
  } else if(period.grain==="week"){
    select(availableWeeks().map(k=>[k,k.replace("-W"," · wk ")+"  ("+weekRangeLabel(k)+")"]), period.week, v=>{period.week=v;});
  } else if(period.grain==="year" && restarted && availableYears().length>1){
    select(availableYears().map(y=>[String(y),String(y)]), String(period.year), v=>{period.year=+v;});
  }
  return wrap;
}

/* ---------- DASHBOARD ---------- */
function renderDashboard(m){
  if(Model.isRestarted(DATA)) return renderPPDashboard(m);
  const tx=DATA.transactions.filter(t=>txInPeriod(t)&&isSpend(t));
  const inc=DATA.income.filter(txInPeriod);
  const catFilter = txFilter.cat;
  // "actual spent" per category is NET of any income assigned to that same category
  // (a reimbursement, refund, etc.) - so a category effectively cost you less once
  // money comes back in against it. Gross figures are kept separately (spendByCatGross)
  // purely for the overall cash-flow "Net" KPI below, which already counts all income
  // via its own `income` term - netting spend there too would double-count it.
  const spendByCat={}, spendByCatGross={}; DATA.categories.forEach(c=>{spendByCat[c]=0;spendByCatGross[c]=0;});
  tx.forEach(t=>{ catAllocations(t).forEach(a=>{ if(spendByCat[a.category]!=null){ spendByCat[a.category]+=(+a.amount||0); spendByCatGross[a.category]+=(+a.amount||0); } }); });
  inc.forEach(t=>{ srcAllocations(t).forEach(a=>{ if(spendByCat[a.source]!=null) spendByCat[a.source]-=(+a.amount||0); }); });
  const monthsInScope = scopeMonths();
  const budForCat = c => monthsInScope.reduce((s,mk)=>s+budgetFor(mk,c)*monthCoverage(mk),0);
  const totalBudget = expenseCats().reduce((s,c)=>s+budForCat(c),0);
  const totalSpend = expenseCats().reduce((s,c)=>s+spendByCat[c],0);
  const totalSpendGross = expenseCats().reduce((s,c)=>s+spendByCatGross[c],0);
  const savingsSpend = spendByCat["Savings"]||0;
  const savingsSpendGross = spendByCatGross["Savings"]||0;
  const income = inc.reduce((s,t)=>s+t.amount,0);
  // Income is a mix of real earnings, your own money moving back from savings, and
  // reimbursements - lumping them into one "Income" figure makes it look like far more
  // new money than actually arrived. Split it so the KPI reads honestly.
  const incBySrc={}; inc.forEach(t=>{ srcAllocations(t).forEach(a=>{ incBySrc[a.source]=(incBySrc[a.source]||0)+(+a.amount||0); }); });
  const earned=incBySrc["Salary"]||0, transfersIn=incBySrc["Savings"]||0, otherIn=income-earned-transfersIn;
  const savingsRate = earned>0 ? (savingsSpend/earned*100) : null;

  m.innerHTML="";
  const head=el(`<div class="head"><h1>Dashboard</h1><span class="sub" id="plabel"></span><div class="spacer"></div></div>`);
  head.querySelector("#plabel").textContent="· "+periodLabel();
  const controls=periodControls(render); head.appendChild(controls);
  m.appendChild(head);

  // KPIs
  const remain=totalBudget-totalSpend;
  const kp=el(`<div class="grid kpis" style="margin-bottom:14px"></div>`);
  kp.appendChild(kpi("Spending", money0(totalSpend), expenseCats().length+" categories"));
  kp.appendChild(kpi("Budget", money0(totalBudget), period.grain==="week"?"pro-rated for 7 days":periodLabel()));
  kp.appendChild(kpi("Remaining", money0(Math.abs(remain)), remain>=0?"under budget":"over budget", remain>=0?"good":"bad", remain>=0?"":"−"));
  kp.appendChild(kpi("Earned", money0(earned), "salary"));
  kp.appendChild(kpi("Net", (income-totalSpendGross-savingsSpendGross>=0?"+":"−")+money0(Math.abs(income-totalSpendGross-savingsSpendGross)).replace("£","£"), "in − out", income-totalSpendGross-savingsSpendGross>=0?"good":"bad"));
  kp.appendChild(savingsSpend>=0
    ? kpi("To savings", money0(savingsSpend), "net of any withdrawn back")
    : kpi("From savings", money0(-savingsSpend), "withdrawn, net of deposits", "bad"));
  kp.appendChild(kpi("Savings rate", savingsRate==null?"—":Math.round(savingsRate)+"%", "of earned income",
    savingsRate==null?"":(savingsRate>=20?"good":savingsRate>=0?"warn":"bad")));
  m.appendChild(kp);
  m.appendChild(el(`<div class="muted" style="font-size:12px;margin:-6px 0 14px">
    Money in this period: <b>${money(income)}</b> — ${money(earned)} earned, ${money(transfersIn)} from savings, ${money(otherIn)} reimbursements &amp; other.</div>`));

  // main row: category table + right column
  const row=el(`<div class="row2"></div>`);
  // ---- category budget vs actual ----
  const left=el(`<div class="card pad"><h3 class="sec">Budget vs actual — click a category to filter</h3></div>`);
  const tbl=el(`<div class="tablewrap"><table><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Budget</th><th class="num">Left</th><th style="width:34%">Progress</th></tr></thead><tbody></tbody></table></div>`);
  const tb=tbl.querySelector("tbody");
  DATA.categories.slice().sort((a,b)=>(spendByCat[b])-(spendByCat[a])).forEach(c=>{
    const sp=spendByCat[c]||0, bu=budForCat(c), left=bu-sp, pct=bu>0?sp/bu:(sp>0?1.5:0);
    const st=pct>1?"bad":pct>0.85?"warn":"good";
    const col=catColor(c);
    const tr=el(`<tr style="cursor:pointer"></tr>`);
    tr.onclick=()=>{ledgerFilter.cat=c;ledgerFilter.status="All";view="ledger";render();};
    tr.innerHTML=`<td><span class="tag" style="background:${col}">${c}</span></td>
      <td class="num">${money(sp)}</td><td class="num muted">${money(bu)}</td>
      <td class="num" style="color:${left<0?'var(--bad)':'inherit'}">${money(left)}</td>
      <td><div class="bar"><i style="width:${Math.min(100,pct*100).toFixed(0)}%;background:var(--${st==='bad'?'bad':st==='warn'?'warn':'good'})"></i></div></td>`;
    tb.appendChild(tr);
  });
  const tfoot=el(`<tr style="font-weight:700"><td>Total (excl. Savings)</td><td class="num">${money(totalSpend)}</td><td class="num">${money(totalBudget)}</td><td class="num" style="color:${remain<0?'var(--bad)':'inherit'}">${money(remain)}</td><td></td></tr>`);
  tb.appendChild(tfoot);
  left.appendChild(tbl);
  row.appendChild(left);

  // ---- right column: pace + bills ----
  const right=el(`<div class="grid" style="align-content:start"></div>`);
  right.appendChild(paceCard(tx,totalBudget,totalSpend));
  right.appendChild(billsCard());
  row.appendChild(right);
  m.appendChild(row);

  // ---- trend chart ----
  m.appendChild(trendCard(spendByCat));
  m.appendChild(topMerchantsCard(tx));
  m.appendChild(cashflowCard());
  m.appendChild(netWorthCard());
}
// group by the matched rule (so "TESCO STORES 2228..." and "Tesco Stores 2889..." land
// together) falling back to the raw name when nothing matches - real merchant totals,
// not a list of near-duplicate statement descriptions.
function topMerchantsCard(tx){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Top merchants ${period.grain==='month'?'· '+monthLabel(period.month):'· '+periodLabel()}</h3></div>`);
  const by={};
  tx.forEach(t=>{
    if(t.category==="Savings") return;
    const r=ruleFor(t.name);
    const key = r ? r.match.replace(/\b\w/g,c=>c.toUpperCase()) : (t.name||"(unnamed)").slice(0,28);
    by[key]=by[key]||{amount:0,count:0,cat:t.category}; by[key].amount+=t.amount; by[key].count++;
  });
  const top=Object.entries(by).sort((a,b)=>b[1].amount-a[1].amount).slice(0,10);
  if(!top.length){ c.appendChild(el(`<div class="muted">No spending in this period.</div>`)); return c; }
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Merchant</th><th>Category</th><th class="num">Visits</th><th class="num">Total</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  top.forEach(([name,d])=>{
    tb.appendChild(el(`<tr><td>${escHTML(name)}</td><td><span class="tag" style="background:${catColor(d.cat)};font-size:10px">${escHTML(d.cat)}</span></td>
      <td class="num muted">${d.count}</td><td class="num">${money(d.amount)}</td></tr>`));
  });
  c.appendChild(w);
  return c;
}
function scopeMonths(){
  if(period.grain==="month") return [period.month];
  if(period.grain==="week"){
    // derive from the week's own dates, not from transactions - a week that straddles
    // two months must cover both even if one of them happens to have no spending yet.
    const {start,end}=weekBounds(period.week); const s=new Set();
    for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)) s.add(isoOf(d).slice(0,7));
    return [...s];
  }
  if(period.grain==="year"){ return availableMonths().filter(k=>k.startsWith(String(period.year))); }
  return availableMonths();
}
// what fraction of month `mk` the selected period actually covers (1 for whole months).
// Without this a 7-day week view would be compared against a whole month's budget.
function monthCoverage(mk){
  if(period.grain!=="week") return 1;
  const {start,end}=weekBounds(period.week);
  const [y,mo]=mk.split("-").map(Number);
  const mStart=new Date(y,mo-1,1), mEnd=new Date(y,mo,0);
  const lo=start>mStart?start:mStart, hi=end<mEnd?end:mEnd;
  if(hi<lo) return 0;
  return (Math.round((hi-lo)/86400000)+1)/mEnd.getDate();
}
// real calendar bounds of the selected period (shared by the Pace card & budget pro-rating)
function kpi(lab,val,sub,cls="",prefix=""){
  return el(`<div class="card kpi"><div class="lab">${lab}</div><div class="val ${cls}">${prefix}${val}</div><div class="sub">${sub||""}</div></div>`);
}
function paceCard(tx,budget,spend,bounds,title="Pace"){
  const c=el(`<div class="card pad"><h3 class="sec"></h3></div>`); c.querySelector("h3").textContent=title;
  const DAY=86400000;
  const today=new Date(); today.setHours(0,0,0,0);
  // real calendar bounds of whatever period is selected - every grain must be handled
  // here, or the card silently reports numbers for a period that isn't the one shown.
  let start,end;
  if(bounds){
    ({start,end}=bounds);
  } else if(period.grain==="month"){
    const [y,mo]=period.month.split("-").map(Number); start=new Date(y,mo-1,1); end=new Date(y,mo,0);
  } else if(period.grain==="week"){
    ({start,end}=weekBounds(period.week));
  } else if(period.grain==="year"){
    const y=+(period.year||2026); start=new Date(y,0,1); end=new Date(y,11,31);
  } else {                                   // "all" - span of the data itself
    const ds=[...DATA.transactions,...DATA.income].map(t=>t.date).sort();
    start = ds.length ? parseD(ds[0]) : today;
    end   = ds.length ? parseD(ds[ds.length-1]) : today;
    if(end>today) end=today;
  }
  const days=Math.max(1,Math.round((end-start)/DAY)+1);
  const elapsed=Math.max(1,Math.min(days,Math.round((Math.min(today,end)-start)/DAY)+1));
  const running = today < end;               // is this period still in progress?
  const perDay = spend/elapsed;
  const projected = perDay*days;

  const stats=[[`Spent / day`, money(perDay), ""]];
  if(running){
    stats.push([`Projected total`, money(projected), projected>budget&&budget>0?"var(--bad)":"var(--good)"]);
    stats.push([`Day`, `${elapsed}/${days}`, ""]);
  } else {
    // a finished period has no meaningful projection - show the shape of it instead
    if(days>45) stats.push([`Spent / month`, money(perDay*(365/12)), ""]);
    stats.push([`Period`, days>=365? (days/365).toFixed(1)+" yrs" : days>45? Math.round(days/(365/12))+" months" : days+" days", ""]);
  }
  c.appendChild(el(`<div class="flex wrap" style="gap:22px">${stats.map(([lab,val,col])=>
     `<div><div class="muted" style="font-size:12px">${lab}</div><div style="font-size:19px;font-weight:700${col?`;color:${col}`:''}">${val}</div></div>`).join("")}</div>`));
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:8px">${fmtDate(isoOf(start))} – ${fmtDate(isoOf(end))}${running?" · in progress":""}</div>`));
  if(budget>0){
    const pct=Math.min(100,spend/budget*100);
    const over = running ? projected>budget : spend>budget;
    c.appendChild(el(`<div style="margin-top:12px"><div class="bar" style="height:9px"><i style="width:${pct}%;background:${over?'var(--bad)':'var(--good)'}"></i></div>
      <div class="muted" style="font-size:12px;margin-top:5px">${(spend/budget*100).toFixed(0)}% of budget used</div></div>`));
  }
  return c;
}
const isoOf=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
function billsCard(){
  const months=scopeMonths();
  const c=el(`<div class="card pad"><h3 class="sec">Bills seen ${period.grain==='month'?'· '+monthLabel(period.month):''}</h3></div>`);
  const list=el(`<div style="display:flex;flex-direction:column;gap:6px"></div>`);
  const scopeTx=DATA.transactions.filter(t=>months.includes(monthKey(t.date))&&t.category==="Bills");
  const hidden=[];
  DATA.bills.forEach(b=>{
    const seen=scopeTx.some(t=>billAllocations(t).some(a=>a.bill===b.name));
    const amt = period.grain==='month' ? billBudget(period.month, b.name) : null;
    if(dashboardHideZeroBills && period.grain==='month' && !seen && amt===0){ hidden.push(b.name); return; }
    const r=el(`<div class="flex" style="justify-content:space-between">
       <span>${seen?'✅':'⬜'} ${b.name}</span><span class="muted">${amt!=null?money(amt):''}</span></div>`);
    list.appendChild(r);
  });
  if(!DATA.bills.length) list.appendChild(el(`<div class="muted">No bills set. Add them in Budget → Monthly.</div>`));
  c.appendChild(list);
  if(hidden.length){
    const btn=el(`<button class="btn sm" style="margin-top:10px">Show ${hidden.length} with no budget &amp; not seen (${hidden.join(", ")})</button>`);
    btn.onclick=()=>{ dashboardHideZeroBills=false; render(); }; c.appendChild(btn);
  } else if(!dashboardHideZeroBills && period.grain==='month'){
    const btn=el(`<button class="btn sm" style="margin-top:10px">Hide bills with no budget &amp; not seen</button>`);
    btn.onclick=()=>{ dashboardHideZeroBills=true; render(); }; c.appendChild(btn);
  }
  return c;
}
function trendCard(spendByCatIgnored){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Trend</h3></div>`);
  if(period.grain==="month"){
    // cumulative spend vs budget across the month
    const [y,mo]=period.month.split("-").map(Number);
    const days=new Date(y,mo,0).getDate();
    const daily=new Array(days+1).fill(0);
    DATA.transactions.filter(t=>monthKey(t.date)===period.month&&isSpend(t)&&t.category!=="Savings")
      .forEach(t=>{const d=parseD(t.date).getDate(); daily[d]+=t.amount;});
    // net off income assigned to the same (non-Savings) categories, on the day it lands
    DATA.income.filter(t=>monthKey(t.date)===period.month).forEach(t=>{
      srcAllocations(t).forEach(a=>{ if(a.source!=="Savings" && DATA.categories.includes(a.source)){ const d=parseD(t.date).getDate(); daily[d]-=a.amount; } });
    });
    let cum=0; const pts=[]; for(let d=1;d<=days;d++){cum+=daily[d];pts.push(cum);}
    const budget=expenseCats().reduce((s,cc)=>s+budgetFor(period.month,cc),0);
    c.appendChild(lineChart(pts,budget,days));
    c.appendChild(el(`<div class="legend" style="margin-top:8px"><span><i style="background:var(--brand)"></i>Cumulative spend</span><span><i style="background:var(--muted)"></i>Budget line (${money0(budget)})</span></div>`));
    // same day, last month: is this month running ahead or behind?
    const prior=priorMonthKey(period.month);
    if(prior && DATA.monthlyBudgets[prior]){
      const [py,pmo]=prior.split("-").map(Number); const pDays=new Date(py,pmo,0).getDate();
      const today=new Date(); const isCurrent=today.getFullYear()===y&&today.getMonth()+1===mo;
      const dayN=Math.min(isCurrent?today.getDate():days, pDays);
      const pDaily=new Array(pDays+1).fill(0);
      DATA.transactions.filter(t=>monthKey(t.date)===prior&&isSpend(t)&&t.category!=="Savings").forEach(t=>{pDaily[parseD(t.date).getDate()]+=t.amount;});
      DATA.income.filter(t=>monthKey(t.date)===prior).forEach(t=>{srcAllocations(t).forEach(a=>{if(a.source!=="Savings"&&DATA.categories.includes(a.source))pDaily[parseD(t.date).getDate()]-=a.amount;});});
      let pCum=0; for(let d=1;d<=dayN;d++) pCum+=pDaily[d];
      const thisCum=pts[Math.min(dayN,pts.length)-1]||0;
      const diff=thisCum-pCum;
      c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:8px">By day ${dayN}, you've spent <b style="color:${diff>0?'var(--bad)':'var(--good)'}">${money(Math.abs(diff))} ${diff>0?'more':'less'}</b> than by day ${dayN} of ${monthLabel(prior)} (${money0(thisCum)} vs ${money0(pCum)}).</div>`));
    }
  } else if(period.grain==="week"){
    c.appendChild(weekBars(period.week));
    c.appendChild(el(`<div class="legend" style="margin-top:10px">${expenseCats().map(cc=>`<span><i style="background:${catColor(cc)}"></i>${cc}</span>`).join("")}</div>`));
  } else {
    // spend per month bar chart across the year
    const cats=DATA.categories;
    const months = period.grain==="year"? availableMonths().filter(k=>k.startsWith(String(period.year))) : availableMonths();
    c.appendChild(monthBars(months));
    c.appendChild(el(`<div class="legend" style="margin-top:10px">${expenseCats().map(cc=>`<span><i style="background:${catColor(cc)}"></i>${cc}</span>`).join("")}<span><i style="background:var(--bad)"></i>Budget</span></div>`));
  }
  return c;
}
function priorMonthKey(mk){ const [y,mo]=mk.split("-").map(Number); const d=new Date(y,mo-2,1); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
function weekBars(wk){
  const W=820,H=220,pad=34,gap=10;
  const {start}=weekBounds(wk); const cats=expenseCats();
  const data=[]; for(let i=0;i<7;i++){ const d=new Date(start); d.setDate(start.getDate()+i);
    const dISO=isoOf(d); const o={}; let tot=0; cats.forEach(c=>o[c]=0);
    DATA.transactions.filter(t=>t.date===dISO).forEach(t=>{ catAllocations(t).forEach(a=>{ if(o[a.category]!=null) o[a.category]+=(+a.amount||0); }); });
    DATA.income.filter(t=>t.date===dISO).forEach(t=>{ srcAllocations(t).forEach(a=>{ if(o[a.source]!=null) o[a.source]-=(+a.amount||0); }); });
    cats.forEach(c=>tot+=o[c]);
    data.push({date:d,o,tot});
  }
  const max=Math.max(1,...data.map(d=>d.tot));
  const bw=(W-pad*2-gap*6)/7;
  let svg=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  svg+=`<line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="var(--line)"/>`;
  data.forEach((d,i)=>{
    const bx=pad+i*(bw+gap); let yy=H-pad;
    cats.forEach(c=>{ const h=(d.o[c]/max)*(H-pad*2); if(h>0){ svg+=`<rect x="${bx}" y="${(yy-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${catColor(c)}"/>`; yy-=h; } });
    svg+=`<text x="${bx+bw/2}" y="${H-pad+15}" fill="var(--muted)" font-size="11" text-anchor="middle">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"][i]}</text>`;
    if(d.tot>0) svg+=`<text x="${bx+bw/2}" y="${(H-pad-(d.tot/max)*(H-pad*2)-5).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="middle">${money0(d.tot)}</text>`;
  });
  svg+=`</svg>`;
  return el(svg);
}
// running balance of both accounts across the selected period (a cash-flow view:
// Flex current account + Credit card, day by day, carried in from all prior history)
function cashflowCard(){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Account cashflow — running balances</h3></div>`);
  const rows=ledgerAll();                       // chronological, with per-account running balances
  if(!rows.length){ c.appendChild(el(`<div class="muted">No data yet.</div>`)); return c; }
  const today=new Date(); today.setHours(0,0,0,0);
  let start,end;
  if(period.grain==="pp"){ const p=ppPeriod(); start=parseD(p.start); end=parseD(p.end); }
  else if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); start=new Date(y,mo-1,1); end=new Date(y,mo,0); }
  else if(period.grain==="week"){ const [y,w]=period.week.split("-W").map(Number);
    const simple=new Date(Date.UTC(y,0,1+(w-1)*7)); const mon=new Date(simple); mon.setUTCDate(simple.getUTCDate()-((simple.getUTCDay()+6)%7));
    start=new Date(mon.getUTCFullYear(),mon.getUTCMonth(),mon.getUTCDate()); end=new Date(start); end.setDate(start.getDate()+6); }
  else if(period.grain==="year"){ start=new Date(period.year,0,1); end=new Date(period.year,11,31); }
  else { start=parseD(rows[0].ref.date); end=parseD(rows[rows.length-1].ref.date); }
  if(Model.isRestarted(DATA)){ const s=parseD(DATA.meta.startDate); if(start<s) start=s; }
  if(end>today && period.grain!=="all") end=today;   // don't draw a flat guess into the future
  if(end<start){ c.appendChild(el(`<div class="muted">No activity in this period yet.</div>`)); return c; }

  // walk every row once; balances carry into the period from all history before it
  let f=DATA.accounts.openingFlex||0, cc=DATA.accounts.openingCredit||0, ri=0;
  const isoOf=dt=>dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");
  const days=[];
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const dayISO=isoOf(d);
    while(ri<rows.length && rows[ri].ref.date<=dayISO){
      if(rows[ri].affectsFlex) f=rows[ri].flexBal;
      if(rows[ri].affectsCredit) cc=rows[ri].creditBal;
      ri++;
    }
    days.push({flex:f, credit:cc});
  }
  const W=820,H=200,pad=34,padR=70;
  const all=[...days.map(d=>d.flex),...days.map(d=>d.credit),0];
  const lo=Math.min(...all), hi=Math.max(...all), span=(hi-lo)||1;
  const x=i=>pad+(days.length>1?(i/(days.length-1)):0)*(W-pad-padR);
  const y=v=>10+((hi-v)/span)*(H-pad-10);
  const path=key=>days.map((d,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(d[key]).toFixed(1)).join(" ");
  const zy=y(0);
  const endF=days[days.length-1].flex, endC=days[days.length-1].credit;
  c.appendChild(el(`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    <line x1="${pad}" y1="${zy.toFixed(1)}" x2="${W-padR}" y2="${zy.toFixed(1)}" stroke="var(--muted)" stroke-dasharray="4 4" opacity=".6"/>
    <text x="${pad}" y="${(zy-4).toFixed(1)}" fill="var(--muted)" font-size="10">£0</text>
    <path d="${path("flex")}" fill="none" stroke="var(--brand)" stroke-width="2.5"/>
    <path d="${path("credit")}" fill="none" stroke="var(--c-PubSocial)" stroke-width="2.5"/>
    <text x="${W-padR+6}" y="${y(endF).toFixed(1)}" fill="var(--brand)" font-size="11" dominant-baseline="middle">${money0(endF)}</text>
    <text x="${W-padR+6}" y="${(Math.abs(y(endC)-y(endF))<12 ? y(endC)+(y(endC)>=y(endF)?12:-12) : y(endC)).toFixed(1)}" fill="var(--c-PubSocial)" font-size="11" dominant-baseline="middle">${money0(endC)}</text>
    <text x="${pad}" y="${H-6}" fill="var(--muted)" font-size="11">${fmtDate(isoOf(start))}</text>
    <text x="${W-padR}" y="${H-6}" fill="var(--muted)" font-size="11" text-anchor="end">${fmtDate(isoOf(end))}</text>
  </svg>`));
  c.appendChild(el(`<div class="legend" style="margin-top:8px">
    <span><i style="background:var(--brand)"></i>FlexGraduate (debit)</span>
    <span><i style="background:var(--c-PubSocial)"></i>Credit card</span></div>`));
  return c;
}
// Flex + credit card portion is exact throughout (from the real ledger). Savings + cash
// only has real history from the day it was first recorded (recordWealthSnapshot, on
// every app open and Accounts visit) - held flat between recordings, since we don't have
// a way to know what it was on days nobody looked.
function netWorthCard(){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Net worth over time</h3></div>`);
  const snaps=(DATA.wealthSnapshots||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const rows=ledgerAll();
  if(!snaps.length || !rows.length){ c.appendChild(el(`<div class="muted" style="font-size:13px">Tracking starts today — each time you open the app or visit Accounts, today's savings + cash total is recorded, so a trend builds up over time.</div>`)); return c; }
  const today=new Date(); today.setHours(0,0,0,0);
  let start,end;
  if(period.grain==="pp"){ const p=ppPeriod(); start=parseD(p.start); end=parseD(p.end); }
  else if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); start=new Date(y,mo-1,1); end=new Date(y,mo,0); }
  else if(period.grain==="week"){ ({start,end}=weekBounds(period.week)); }
  else if(period.grain==="year"){ start=new Date(period.year,0,1); end=new Date(period.year,11,31); }
  else { start=parseD(rows[0].ref.date); end=today; }
  if(Model.isRestarted(DATA)){ const s=parseD(DATA.meta.startDate); if(start<s) start=s; }
  if(end>today) end=today;
  const firstSnap=parseD(snaps[0].date);
  if(start<firstSnap) start=firstSnap;
  if(end<=start){
    const msg = end<start
      ? `This period ended before wealth tracking began (${fmtDate(snaps[0].date)}) — pick a more recent period to see it.`
      : `Wealth tracking began ${fmtDate(snaps[0].date)}, so there is only one day so far. The line appears once there are two days of history.`;
    c.appendChild(el(`<div class="muted" style="font-size:13px">${msg}</div>`)); return c; }

  let f=DATA.accounts.openingFlex||0, cc=DATA.accounts.openingCredit||0, ri=0, si=0;
  let sv=snaps[0].savings, ca=snaps[0].cash;
  const startISO=isoOf(start);
  while(ri<rows.length && rows[ri].ref.date<startISO){ if(rows[ri].affectsFlex) f=rows[ri].flexBal; if(rows[ri].affectsCredit) cc=rows[ri].creditBal; ri++; }
  while(si<snaps.length-1 && snaps[si+1].date<=startISO){ si++; sv=snaps[si].savings; ca=snaps[si].cash; }
  const days=[];
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)){
    const dayISO=isoOf(d);
    while(ri<rows.length && rows[ri].ref.date<=dayISO){ if(rows[ri].affectsFlex) f=rows[ri].flexBal; if(rows[ri].affectsCredit) cc=rows[ri].creditBal; ri++; }
    while(si<snaps.length-1 && snaps[si+1].date<=dayISO){ si++; sv=snaps[si].savings; ca=snaps[si].cash; }
    days.push(f+cc+sv+ca);
  }
  const W=820,H=180,pad=30;
  const lo=Math.min(...days,0), hi=Math.max(...days,0), span=(hi-lo)||1;
  const x=i=>pad+(days.length>1?i/(days.length-1):0)*(W-pad*2);
  const y=v=>10+((hi-v)/span)*(H-pad-10);
  const path=days.map((v,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)).join(" ");
  const area=path+` L ${x(days.length-1).toFixed(1)} ${y(lo).toFixed(1)} L ${x(0).toFixed(1)} ${y(lo).toFixed(1)} Z`;
  c.appendChild(el(`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    <path d="${area}" fill="var(--good)" opacity=".08"/>
    <path d="${path}" fill="none" stroke="var(--good)" stroke-width="2.5"/>
    <text x="${pad}" y="${H-8}" fill="var(--muted)" font-size="11">${fmtDate(isoOf(start))}</text>
    <text x="${W-pad}" y="${H-8}" fill="var(--muted)" font-size="11" text-anchor="end">${fmtDate(isoOf(end))}</text>
  </svg>`));
  const delta=days[days.length-1]-days[0];
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:6px">${money0(days[0])} → <b style="color:var(--ink)">${money0(days[days.length-1])}</b>
    (${delta>=0?'+':'−'}${money0(Math.abs(delta))})${snaps.length<5?' · savings/cash is held flat between visits — only '+snaps.length+' snapshot'+(snaps.length===1?'':'s')+' recorded so far, the trend fills in as you keep using the app':''}</div>`));
  return c;
}
function lineChart(pts,budget,days,ends){
  const W=820,H=180,pad=30; const max=Math.max(budget,...pts,1);
  const x=i=>pad+(i/Math.max(1,days-1))*(W-pad*2), y=v=>H-pad-(v/max)*(H-pad*2);
  const path=pts.map((v,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)).join(" ");
  const area=path+` L ${x(pts.length-1)} ${H-pad} L ${x(0)} ${H-pad} Z`;
  const by=y(budget);
  const [l0,l1]=ends||["day 1","day "+days];
  return el(`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="var(--line)"/>
    <line x1="${pad}" y1="${by}" x2="${W-pad}" y2="${by}" stroke="var(--muted)" stroke-dasharray="5 4"/>
    <path d="${area}" fill="var(--brand)" opacity=".10"/>
    <path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2.5"/>
    <text x="${pad}" y="${H-8}" fill="var(--muted)" font-size="11">${l0}</text>
    <text x="${W-pad}" y="${H-8}" fill="var(--muted)" font-size="11" text-anchor="end">${l1}</text>
  </svg>`);
}
function monthBars(months){
  const W=820,H=220,pad=34,gap=14;
  const cats=expenseCats();
  const data=months.map(mk=>{const o={};let tot=0;cats.forEach(c=>{o[c]=0});
    DATA.transactions.filter(t=>monthKey(t.date)===mk).forEach(t=>{
      catAllocations(t).forEach(a=>{ if(o[a.category]!=null) o[a.category]+=(+a.amount||0); });
    });
    // net off any income assigned to the same category that month (reimbursements etc.)
    DATA.income.filter(t=>monthKey(t.date)===mk).forEach(t=>{
      srcAllocations(t).forEach(a=>{ if(o[a.source]!=null) o[a.source]-=(+a.amount||0); });
    });
    cats.forEach(c=>tot+=o[c]);
    const budget=cats.reduce((s,c)=>s+budgetFor(mk,c),0);
    return {mk,o,tot,budget};});
  const max=Math.max(1,...data.map(d=>Math.max(d.tot,d.budget)));
  const bw=(W-pad*2-gap*(months.length-1))/Math.max(1,months.length);
  let svg=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">`;
  svg+=`<line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="var(--line)"/>`;
  data.forEach((d,i)=>{
    const bx=pad+i*(bw+gap); let yy=H-pad;
    cats.forEach(c=>{ const h=(d.o[c]/max)*(H-pad*2); if(h>0){ svg+=`<rect x="${bx}" y="${(yy-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${catColor(c)}"/>`; yy-=h; } });
    if(d.budget>0){
      const by=(H-pad-(d.budget/max)*(H-pad*2)).toFixed(1);
      svg+=`<line x1="${bx}" y1="${by}" x2="${(bx+bw).toFixed(1)}" y2="${by}" stroke="var(--bad)" stroke-width="2" stroke-dasharray="3 2"/>`;
    }
    svg+=`<text x="${bx+bw/2}" y="${H-pad+15}" fill="var(--muted)" font-size="11" text-anchor="middle">${MONTHS[+d.mk.slice(5)-1]}</text>`;
    svg+=`<text x="${bx+bw/2}" y="${(H-pad-(d.tot/max)*(H-pad*2)-5).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="middle">${money0(d.tot)}</text>`;
  });
  svg+=`</svg>`;
  return el(svg);
}

/* (Transactions & Income are now the single editable Ledger — see renderLedger.) */
function catSelect(cur){
  const s=el(`<select class="sel-cat"></select>`);
  [...DATA.categories,"Credit"].forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=c;o.selected=c===cur;s.appendChild(o);});
  if(cur && ![...DATA.categories,"Credit"].includes(cur)){const o=document.createElement("option");o.value=cur;o.textContent=cur;o.selected=true;s.appendChild(o);}
  return s;
}
// like catSelect but without "Credit" — used inside the split modal, where splits are
// strictly among real budget categories (a card repayment is never split).
function catSelectPlain(cur){
  const s=el(`<select class="sel-cat"></select>`);
  DATA.categories.forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=c;o.selected=c===cur;s.appendChild(o);});
  if(cur && !DATA.categories.includes(cur)){const o=document.createElement("option");o.value=cur;o.textContent=cur;o.selected=true;s.appendChild(o);}
  return s;
}
function cardSelect(cur){
  const s=el(`<select class="sel-cat"></select>`);
  [["Debit","Debit (Flex)"],["Credit","Credit card"]].forEach(([v,lab])=>{const o=document.createElement("option");o.value=v;o.textContent=lab;o.selected=v===cur;s.appendChild(o);});
  return s;
}
function offerRule(name,cat){
  const key=name.trim().toLowerCase();
  if(!key||ruleFor(name)) return;
  if(confirm(`Always categorise "${name}" as ${cat}?\n\nAdds a rule so future imports auto-tag it.`)){
    DATA.rules.push({match:key,category:cat}); DATA.rules=dedupeRules(DATA.rules); markDirty();
  }
}

/* ---------- PAY PERIODS: restart wizard, payday dashboard ----------
   The budget restarts once, from a payday, into four-weekly pay periods
   (docs/plans/pay-period-budgeting.md 3.6). Until then the Bills and
   Budget tabs only point at the restart. */
const RESTART_START = Periods.DEFAULT_CYCLE.anchor;
let wiz = null;   // the restart wizard's choices while it's being filled in

function needsRestart(m, title){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>${title}</h1></div>`));
  const c=el(`<div class="card pad" style="max-width:640px"><h3 class="sec">Run the restart first</h3>
    <p style="margin:0 0 8px">Bills and Budget work in pay periods: from one payday to the day before the next, every four weeks, starting with your payday on <b>${Periods.fmtY(RESTART_START)}</b>.</p>
    <p class="muted" style="font-size:13px;margin:0 0 12px">The restart sets up your bills and a budget per pay period, keeps the rows from that payday on and archives everything earlier. Ledger, Import and Accounts work as normal until then.</p></div>`);
  const b=el(`<button class="btn pri">Open the restart</button>`); b.onclick=()=>{ view="restart"; render(); };
  c.appendChild(b); m.appendChild(c);
}
function renderBills(m){
  if(!Model.isRestarted(DATA)) return needsRestart(m,"Bills");
  const p=ppPeriod(), today=Periods.localISO();
  const pb=Model.periodBills(DATA, p, today);
  m.innerHTML="";
  const head=el(`<div class="head"><h1>Bills</h1><div class="spacer"></div></div>`);
  const add=el(`<button class="btn pri sm">+ Add bill</button>`); add.onclick=()=>openBillEditor(null, p);
  head.appendChild(add);
  m.appendChild(head);
  m.appendChild(ppNav(p));

  const c=el(`<div class="card" style="max-width:760px"></div>`);
  if(!pb.items.length && !pb.notDue.length){
    c.appendChild(el(`<div class="empty">No bills yet. Add your regular bills with <b>+ Add bill</b>.</div>`));
    m.appendChild(c); return;
  }
  const w=el(`<div class="tablewrap fit"><table class="bills"><thead><tr><th>Bill</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  pb.items.forEach(i=>{
    const st=billStatusText(i);
    const tr=el(`<tr class="tap${i.reminder?" reminder":""}"><td><div class="nm"></div><div class="sub"></div></td><td class="num"></td><td><div class="status ${st[0]}"></div><div class="sub"></div></td></tr>`);
    tr.querySelector(".nm").textContent=i.bill.name+(i.edited?" ✏️":"");
    const acct=(i.version||{}).account==="Card"?" · card":"";
    tr.querySelector("td .sub").textContent="due "+Periods.fmt(i.date)+(i.date!==i.scheduled?" (usually "+Periods.fmt(i.scheduled)+")":"")+acct;
    tr.children[1].textContent = i.reminder ? (i.expected?money(i.expected):"reminder") : money(i.expected);
    tr.children[2].firstChild.textContent=st[1];
    tr.children[2].lastChild.textContent=st[2];
    tr.onclick=()=>openBillSheet(i.bill.id, i.slot);
    tb.appendChild(tr);
  });
  pb.notDue.forEach(b=>{
    const v=Model.billVersion(b, p.key)||{};
    const tr=el(`<tr class="tap notdue"><td><div class="nm"></div><div class="sub"></div></td><td class="num"></td><td><div class="status">💤 not due this period</div></td></tr>`);
    tr.querySelector(".nm").textContent=b.name;
    tr.querySelector("td .sub").textContent=billScheduleText(v);
    tr.children[1].textContent=b.reminder?"reminder":money(+v.amount||0);
    tr.onclick=()=>openBillEditor(b.id, p);
    tb.appendChild(tr);
  });
  c.appendChild(w);
  const t=pb.totals;
  const foot=el(`<div class="billfoot"><div><span>Due this period</span><b>${money(t.due)}</b></div><div><span>Paid so far</span><b class="good">${money(t.paid)}</b></div><div><span>Still to pay</span><b${t.toPay>0?' class="warn"':""}>${money(t.toPay)}</b></div><div><span>Average per period</span><b class="muted">${money(t.smoothed)}</b></div></div>`);
  c.appendChild(foot);
  m.appendChild(c);
  m.appendChild(el(`<p class="muted" style="font-size:12px;max-width:760px;margin:10px 2px 0">Tap a bill to link a different payment, mark it paid, skip it or change it this time only. Payments are matched automatically when the statement text appears within ${Model.MATCH_DAYS} days of the due date. The card repayment is a reminder only and isn't in the totals. A monthly bill skips one pay period a year, because there are 13 paydays.</p>`));
}

/* ---------- shared by Bills and Budget: which pay period is showing ---------- */
let ppKey = null;   // the period's key; null = the one with today in it
function ppPeriod(){
  const cy=Model.cycleOf(DATA), p=ppKey && Periods.periodByKey(cy, ppKey);
  return p || Periods.periodFor(cy, Periods.localISO());
}
function ppNav(p){
  const cy=Model.cycleOf(DATA), first=Periods.periodFor(cy, Model.startOf(DATA)), cur=Periods.periodFor(cy, Periods.localISO());
  const wrap=el(`<div class="ppnav"></div>`);
  const prev=el(`<button class="btn" aria-label="Previous pay period">‹</button>`);
  const next=el(`<button class="btn" aria-label="Next pay period">›</button>`);
  prev.disabled=p.index<=first.index; next.disabled=p.index>=cur.index+13;
  prev.onclick=()=>{ ppKey=Periods.periodAt(cy,p.index-1).key; render(); };
  next.onclick=()=>{ ppKey=Periods.periodAt(cy,p.index+1).key; render(); };
  const n=p.index-cur.index;
  const lab=el(`<div class="pplab"><b></b><span class="muted"></span></div>`);
  lab.firstChild.textContent=Periods.label(p); lab.title=Periods.labelLong(p);
  lab.lastChild.textContent = n===0 ? "this pay period" : n===-1 ? "last pay period" : n===1 ? "next pay period" : n<0 ? (-n)+" periods ago" : "in "+n+" periods";
  wrap.append(prev, lab, next);
  if(n!==0){ const t=el(`<button class="btn sm">Back to now</button>`); t.onclick=()=>{ ppKey=null; render(); }; wrap.appendChild(t); }
  return wrap;
}
// [status class, headline, detail] for one bill occurrence
function billStatusText(i){
  const ed=i.edited?" ✏️":"";
  if(i.status==="paid"){
    let d=(i.how==="manual"?"marked paid ":"")+(i.paidDate?Periods.fmt(i.paidDate)+" · ":"")+money(i.paidAmount);
    if(i.diff) d+=" ("+money(Math.abs(i.diff))+(i.diff>0?" more":" less")+" than expected)";
    if(i.shared) d+=" · shared with another bill";
    return ["good","✅ paid"+ed, d];
  }
  if(i.status==="skipped") return ["","⏭ skipped"+ed,"not paying it this period"];
  if(i.status==="overdue") return ["bad","🔴 overdue"+ed, (-i.daysUntil)+" days ago · no payment found"];
  if(i.status==="due") return ["warn","⏳ due "+(i.daysUntil===0?"today":"yesterday")+ed, "may still be clearing"];
  return ["","⏳ due "+(i.daysUntil===1?"tomorrow":"in "+i.daysUntil+" days")+ed, ""];
}
const ordinal = n => n+(n%10===1&&n!==11?"st":n%10===2&&n!==12?"nd":n%10===3&&n!==13?"rd":"th");
function billScheduleText(v){
  if(!v || !v.freq) return "";
  const when = v.freq==="yearly" ? "yearly, "+(v.dueDate?Periods.fmt("2000-"+v.dueDate):"no date") : "monthly on the "+ordinal(+v.dueDay||0);
  return when+(v.account==="Card"?" · card":"");
}
const billById = id => (DATA.recurringBills||[]).find(b=>b.id===id);

// A modal that becomes a bottom sheet on a phone; Esc or a tap outside closes it.
function openSheet(title, onClose){
  const bg=el(`<div class="modal-bg"><div class="modal sheet"><div class="sheet-head"><h3></h3><button class="btn sm" aria-label="Close">✕</button></div><div class="sheet-body"></div></div></div>`);
  bg.querySelector("h3").textContent=title;
  const close=()=>{ if(!bg.isConnected) return; bg.remove(); document.removeEventListener("keydown", esc); if(onClose) onClose(); };
  const esc=e=>{ if(e.key==="Escape") close(); };
  bg.querySelector(".sheet-head button").onclick=close;
  bg.onclick=e=>{ if(e.target===bg) close(); };
  document.addEventListener("keydown", esc);
  document.body.appendChild(bg);
  return {bg, body:bg.querySelector(".sheet-body"), title:bg.querySelector("h3"), close};
}

/* One occurrence of a bill: its payments and the one-off changes. */
function openBillSheet(billId, slot){
  const s=openSheet("");
  const find=()=>{
    const today=Periods.localISO(), p=ppPeriod();
    const tl=Model.billTimeline(DATA, Periods.addDays(p.end>today?p.end:today, 120));
    const o=tl.find(x=>x.bill.id===billId && x.slot===slot);
    return o ? {i:Model.describeBill(o, today), tl} : null;
  };
  const change=ch=>{ const b=billById(billId); if(!b) return; Model.overrideBill(b, slot, ch); markDirty(); render(); fill(); };
  function fill(){
    const f=find();
    if(!f){ s.close(); return; }
    const {i, tl}=f, b=i.bill, ov=b.overrides&&b.overrides[slot]||{}, B=s.body;
    s.title.textContent=b.name+" · due "+Periods.fmt(i.date);
    B.innerHTML="";
    const st=billStatusText(i);
    const top=el(`<div class="sheet-sec"><div class="status ${st[0]}" style="font-size:14px"></div><div class="muted" style="font-size:13px;margin-top:2px"></div></div>`);
    top.firstChild.textContent=st[1]+(st[2]?" — "+st[2]:"");
    top.lastChild.textContent=(b.reminder?"Reminder":"Expected "+money(i.expected))+" · "+billScheduleText(i.version)+(i.date!==i.scheduled?" · moved from "+Periods.fmt(i.scheduled):"");
    B.appendChild(top);

    // payments
    const pay=el(`<div class="sheet-sec"><h4>Payment</h4></div>`);
    if(i.how==="manual") pay.appendChild(el(`<p>Marked as paid by hand on ${Periods.fmt(i.paidDate)}: ${money(i.paidAmount)}.</p>`));
    else if(i.status==="skipped") pay.appendChild(el(`<p class="muted">Skipped this period.</p>`));
    else if(!i.payments.length) pay.appendChild(el(`<p class="muted">${ov.links?"No payment — you unlinked the automatic match.":"No matching payment found yet."}</p>`));
    i.payments.forEach(r=>{
      const row=el(`<div class="payrow"><span class="muted"></span><span class="d"></span><b></b></div>`);
      row.children[0].textContent=Periods.fmt(r.date);
      row.children[1].textContent=(r.name||"")+(Model.accountOf(r)==="Card"?" · card":"");
      row.children[2].textContent=money(+r.amount||0);
      const un=el(`<button class="btn sm">Unlink</button>`);
      un.onclick=()=>change({links:i.payments.filter(x=>x.id!==r.id).map(x=>x.id), paid:null, skip:null});
      row.appendChild(un); pay.appendChild(row);
    });
    if(i.how==="auto") pay.appendChild(el(`<p class="hint">Matched automatically.</p>`));
    const acts=el(`<div class="flex wrap" style="margin-top:8px"></div>`);
    const link=el(`<button class="btn sm">${i.payments.length?"Link another payment…":"Link a payment…"}</button>`);
    link.onclick=()=>{ link.remove(); pay.appendChild(linkPicker(i, tl, id=>{
      const keep=i.how==="auto"||i.how==="linked" ? i.payments.map(x=>x.id) : [];
      change({links:[...new Set(keep.concat([id]))], paid:null, skip:null});
    })); };
    if(i.status!=="skipped") acts.appendChild(link);
    if(ov.links){ const a=el(`<button class="btn sm">Back to automatic matching</button>`); a.onclick=()=>change({links:null}); acts.appendChild(a); }
    pay.appendChild(acts);
    B.appendChild(pay);

    // paid by hand / skip
    const hand=el(`<div class="sheet-sec"><h4>Paid another way, or not paying</h4></div>`);
    if(i.how==="manual"){
      const u=el(`<button class="btn sm">Undo "paid by hand"</button>`); u.onclick=()=>change({paid:null}); hand.appendChild(u);
    } else if(i.status!=="skipped"){
      const fl=el(`<div class="fields"></div>`);
      const dt=el(`<input type="date">`); dt.value=i.date<=Periods.localISO()?i.date:Periods.localISO();
      const am=el(`<input type="number" step="0.01" min="0" inputmode="decimal">`); am.value=i.expected;
      fl.append(wizField("Paid on", dt), wizField("Amount (£)", am));
      const go=el(`<button class="btn sm">Mark as paid</button>`);
      go.onclick=()=>{
        const a=parseFloat(am.value);
        if(!dt.value || isNaN(a) || a<0){ toast("Enter the date and amount paid."); return; }
        change({paid:{date:dt.value, amount:Model.round2(a)}, skip:null, links:null});
      };
      hand.appendChild(el(`<p class="hint" style="margin:0 0 8px">For cash, another account, or a payment the app can't see.</p>`));
      hand.appendChild(fl); hand.appendChild(el(`<div style="margin-top:8px"></div>`)).appendChild(go);
    }
    const sk=el(`<button class="btn sm" style="margin-top:8px">${i.status==="skipped"?"Don't skip it":"Skip it this period"}</button>`);
    sk.onclick=()=>change(i.status==="skipped" ? {skip:null} : {skip:true, paid:null, links:null});
    hand.appendChild(el(`<div></div>`)).appendChild(sk);
    B.appendChild(hand);

    // this time only
    const once=el(`<div class="sheet-sec"><h4>This time only</h4></div>`);
    const fl=el(`<div class="fields"></div>`);
    const am=el(`<input type="number" step="0.01" min="0" inputmode="decimal">`); am.value=ov.amount??""; am.placeholder=String(+i.version.amount||0);
    const dt=el(`<input type="date">`); dt.value=ov.date||"";
    fl.appendChild(wizField(b.reminder?"Statement amount (£)":"Amount (usual "+money(+i.version.amount||0)+")", am));
    fl.appendChild(wizField("Due date (usual "+Periods.fmt(i.scheduled)+")", dt));
    once.appendChild(fl);
    const sv=el(`<button class="btn sm" style="margin-top:8px">Save for this time</button>`);
    sv.onclick=()=>{
      const ch={};
      const a=am.value.trim()==="" ? null : parseFloat(am.value);
      if(a!=null && (isNaN(a)||a<0)){ toast("The amount needs to be a number."); return; }
      ch.amount=a==null?null:Model.round2(a);
      const d=dt.value||null;
      if(d && Math.abs(Periods.diffDays(i.scheduled, d))>31){ toast("A due date can move by up to 31 days."); return; }
      ch.date = d===i.scheduled ? null : d;
      change(ch);
    };
    once.appendChild(sv);
    B.appendChild(once);

    const end=el(`<div class="flex wrap sheet-sec"></div>`);
    if(i.edited){ const r=el(`<button class="btn sm danger">Undo all changes to this one</button>`); r.onclick=()=>change({skip:null, amount:null, date:null, links:null, paid:null}); end.appendChild(r); }
    const eb=el(`<button class="btn sm">Edit the bill…</button>`); eb.onclick=()=>{ s.close(); openBillEditor(billId, ppPeriod()); };
    end.appendChild(eb);
    B.appendChild(end);
  }
  fill();
}
// Money-out rows near a bill's due date, best match first, to link by hand.
function linkPicker(i, tl, onPick){
  const box=el(`<div class="linkpick"></div>`);
  const q=el(`<input type="text" placeholder="Search descriptions">`);
  box.appendChild(q);
  const list=el(`<div class="list"></div>`); box.appendChild(list);
  const mine=new Set(i.payments.map(r=>r.id)), paying=new Map();
  tl.forEach(o=>o.payments.forEach(r=>{ if(o.bill.id!==i.bill.id||o.slot!==i.slot) paying.set(r.id, o.bill.name+" "+Periods.fmt(o.date)); }));
  const lo=Periods.addDays(i.date,-14), hi=Periods.addDays(i.date,14);
  const near=DATA.transactions.filter(r=>r.date>=lo && r.date<=hi && !mine.has(r.id))
    .sort((a,b)=>Math.abs((+a.amount||0)-i.expected)-Math.abs((+b.amount||0)-i.expected) || Math.abs(Periods.diffDays(i.date,a.date))-Math.abs(Periods.diffDays(i.date,b.date)));
  const draw=()=>{
    const t=q.value.trim().toLowerCase();
    const rows=near.filter(r=>!t||String(r.name||"").toLowerCase().includes(t)).slice(0,30);
    list.innerHTML="";
    if(!rows.length){ list.appendChild(el(`<p class="muted" style="font-size:13px">Nothing within 14 days of ${Periods.fmt(i.date)}.</p>`)); return; }
    rows.forEach(r=>{
      const b=el(`<button class="payrow pick"><span class="muted"></span><span class="d"></span><b></b></button>`);
      b.children[0].textContent=Periods.fmt(r.date);
      b.children[1].textContent=(r.name||"")+(Model.accountOf(r)==="Card"?" · card":"")+(paying.has(r.id)?" — paying "+paying.get(r.id):"");
      b.children[2].textContent=money(+r.amount||0);
      b.onclick=()=>onPick(r.id);
      list.appendChild(b);
    });
  };
  q.oninput=draw; draw();
  return box;
}

/* Add a bill, or change one: amount, how often, due day and account change
   from a chosen pay period on (earlier periods keep what they were); the
   name, statement text and notes apply everywhere. */
function openBillEditor(billId, p){
  const b=billId?billById(billId):null;
  if(billId && !b) return;
  const cy=Model.cycleOf(DATA), first=Periods.periodFor(cy, Model.startOf(DATA)), cur=Periods.periodFor(cy, Periods.localISO());
  const vs=b?(b.versions||[]).filter(v=>!v.off):[];
  const v=b?(Model.billVersion(b, p.key)||vs[vs.length-1]||{}):{freq:"monthly", account:"Flex"};
  const s=openSheet(b?"Edit "+b.name:"Add a bill");
  const f={name:b?b.name:"", amount:v.amount??"", freq:v.freq||"monthly", dueDay:v.dueDay??"", dueDate:v.dueDate||null,
    account:v.account||"Flex", match:b?b.match||"":"", notes:b?b.notes||"":"", ydDay:"", ydMonth:""};
  if(f.dueDate){ const [mm,dd]=f.dueDate.split("-"); f.ydMonth=String(+mm); f.ydDay=String(+dd); }
  let from=p.key;
  const draw=()=>{
    const B=s.body; B.innerHTML="";
    const fl=el(`<div class="fields"></div>`);
    const nm=el(`<input type="text">`); nm.value=f.name; nm.oninput=()=>{ f.name=nm.value; };
    fl.appendChild(wizField("Name", nm, "wide"));
    if(!(b&&b.reminder)){
      const am=el(`<input type="number" step="0.01" min="0" inputmode="decimal">`); am.value=f.amount; am.oninput=()=>{ f.amount=am.value; };
      fl.appendChild(wizField("Amount (£)", am));
      const fr=el(`<select><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>`); fr.value=f.freq;
      fr.onchange=()=>{ f.freq=fr.value; draw(); };
      fl.appendChild(wizField("How often", fr));
    }
    if(f.freq==="yearly"){
      const wrap=el(`<span class="flex" style="gap:6px"></span>`);
      const dd=el(`<input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="Day" aria-label="Day" style="width:5.5em">`); dd.value=f.ydDay;
      const mm=el(`<select aria-label="Month"><option value="">Month</option></select>`);
      Periods.MONTHS.forEach((mo,k)=>{ const o=document.createElement("option"); o.value=String(k+1); o.textContent=mo; mm.appendChild(o); });
      mm.value=f.ydMonth;
      const upd=()=>{ f.ydDay=dd.value; f.ydMonth=mm.value; f.dueDate=dd.value&&mm.value?mm.value.padStart(2,"0")+"-"+dd.value.padStart(2,"0"):null; };
      dd.oninput=upd; mm.onchange=upd;
      wrap.append(dd, mm);
      fl.appendChild(wizField("Due date", wrap));
    } else {
      const dd=el(`<input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="1–31">`); dd.value=f.dueDay;
      dd.oninput=()=>{ f.dueDay=dd.value; };
      fl.appendChild(wizField("Due day of the month", dd));
    }
    if(!(b&&b.reminder)){
      const ac=el(`<select><option value="Flex">Flex</option><option value="Card">Credit card</option></select>`); ac.value=f.account;
      ac.onchange=()=>{ f.account=ac.value; };
      fl.appendChild(wizField("Paid from", ac));
    }
    const mt=el(`<input type="text" placeholder="words from the statement line">`); mt.value=f.match; mt.oninput=()=>{ f.match=mt.value; };
    fl.appendChild(wizField("Statement text (blank: link payments by hand)", mt, "wide"));
    const nt=el(`<input type="text" placeholder="optional">`); nt.value=f.notes; nt.oninput=()=>{ f.notes=nt.value; };
    fl.appendChild(wizField("Notes", nt, "wide"));
    const fs=el(`<select></select>`);
    for(let n=first.index; n<=cur.index+13; n++){
      const q=Periods.periodAt(cy,n), o=document.createElement("option");
      o.value=q.key; o.textContent=Periods.label(q)+(n===cur.index?" (now)":""); fs.appendChild(o);
    }
    fs.value=from; fs.onchange=()=>{ from=fs.value; };
    fl.appendChild(wizField(b?"Amount, date and account change from":"Starts in the pay period", fs, "wide"));
    B.appendChild(fl);
    if(b) B.appendChild(el(`<p class="hint">Earlier pay periods keep what they were. The name, statement text and notes change everywhere.</p>`));
    const btns=el(`<div class="flex wrap" style="margin-top:14px"></div>`);
    const save=el(`<button class="btn pri">${b?"Save":"Add bill"}</button>`);
    save.onclick=()=>{
      const sch={amount:b&&b.reminder?(+v.amount||0):f.amount, freq:f.freq, dueDay:f.freq==="monthly"?f.dueDay:null,
        dueDate:f.freq==="yearly"?f.dueDate:null, account:b&&b.reminder?"Flex":f.account};
      const probs=Model.billProblems(Object.assign({name:f.name}, sch));
      if(probs.length){ toast(probs[0]); return; }
      const ch={amount:Model.round2(+sch.amount), freq:sch.freq, dueDay:sch.dueDay==null?null:+sch.dueDay, dueDate:sch.dueDate, account:sch.account};
      DATA.recurringBills=DATA.recurringBills||[];
      let bill=b?billById(billId):null;
      if(b && !bill){ s.close(); return; }
      if(!bill){
        bill={id:Model.newBillId(f.name, DATA.recurringBills), name:"", match:"", notes:"", reminder:false, versions:[], overrides:{}};
        DATA.recurringBills.push(bill);
      }
      bill.name=f.name.trim(); bill.match=f.match.trim(); bill.notes=f.notes;
      const at=Model.billVersion(bill, from);
      if(!at || ["amount","freq","dueDay","dueDate","account"].some(k=>(at[k]??null)!==(ch[k]??null))) Model.changeBillFrom(bill, from, ch);
      markDirty(); s.close(); render();
      toast(b?"Saved "+bill.name:"Added "+bill.name);
    };
    btns.appendChild(save);
    if(b){
      const stop=el(`<button class="btn">Stop it</button>`);
      stop.onclick=()=>{
        const q=Periods.periodByKey(cy, from);
        if(!confirm(`Stop ${b.name} from ${Periods.label(q)}? Earlier pay periods keep it.`)) return;
        const bill=billById(billId); if(bill) Model.endBillFrom(bill, from);
        markDirty(); s.close(); render();
      };
      const del=el(`<button class="btn danger">Delete</button>`);
      del.onclick=()=>{
        if(!confirm(`Delete ${b.name} from every pay period, including its history? To stop paying it from now on, use "Stop it" instead.`)) return;
        DATA.recurringBills=DATA.recurringBills.filter(x=>x.id!==billId);
        markDirty(); s.close(); render();
      };
      btns.append(stop, del);
    }
    B.appendChild(btns);
  };
  draw();
}

function renderBudgetTab(m){
  if(!Model.isRestarted(DATA)) return needsRestart(m,"Budget");
  const p=ppPeriod(), today=Periods.localISO(), cy=Model.cycleOf(DATA);
  const pb=Model.periodBudget(DATA, p, today);
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Budget</h1></div>`));
  m.appendChild(ppNav(p));

  // paydays
  const nextKey=Periods.periodAt(cy, p.index+1).key;
  const pd=el(`<div class="muted payline"></div>`);
  pd.appendChild(document.createTextNode("Payday "+dayName(p.start)+(p.start!==p.key?" ✏️":"")+" · next payday "+dayName(p.next)+(p.next!==nextKey?" ✏️":"")+" "));
  const chp=el(`<button class="btn sm">Change payday</button>`); chp.onclick=()=>openPaydaySheet(p);
  pd.appendChild(chp);
  m.appendChild(pd);

  // pay − bills − budgets − savings = left to allocate
  const S=pb.summary, pay=pb.pay;
  const paySub = pay.source==="typed" ? "typed in ✏️" : pay.source==="received" ? "received" : pay.source==="last" ? "same as last pay" : "no pay yet";
  const sum=el(`<div class="card sumline"></div>`);
  const part=(lab,val,sub,cls)=>{ const d=el(`<div><span class="lab"></span><b class="${cls||""}"></b><span class="sub"></span></div>`); d.children[0].textContent=lab; d.children[1].textContent=val; d.children[2].textContent=sub||""; sum.appendChild(d); return d; };
  const payBox=part("Pay", money(S.pay), paySub);
  const pe=el(`<button class="btn sm">Edit</button>`); pe.onclick=()=>openPaySheet(p, pb); payBox.appendChild(pe);
  part("− Bills due", money(S.billsDue), "from the Bills tab");
  part("− Budgets", money(S.budgets), "categories below");
  part("− Savings target", money(S.savings), "");
  part("= Left to allocate", money(S.unallocated), S.unallocated<0?"over-planned":"", S.unallocated<0?"bad":"good");
  m.appendChild(sum);

  // categories
  const c=el(`<div class="card" style="max-width:760px;margin-top:14px"></div>`);
  const w=el(`<div class="tablewrap fit"><table class="budget"><thead><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Left</th></tr></thead><tbody></tbody><tfoot></tfoot></table></div>`);
  const tb=w.querySelector("tbody");
  pb.rows.forEach(r=>{
    const pct=r.budget>0?Math.min(100, r.spent/r.budget*100):(r.spent>0?100:0);
    const over=r.left<0;
    const tr=el(`<tr><td><div class="nm"></div><div class="bar"><i style="width:${pct.toFixed(0)}%;background:${over?"var(--bad)":catColor(r.category)}"></i></div></td><td class="num"></td><td class="num"></td><td class="num${over?" neg":""}"></td></tr>`);
    tr.querySelector(".nm").textContent=r.category+(r.edited?" ✏️":"");
    if(r.fromBills){
      const a=el(`<button class="linkbtn" title="Open the Bills tab"></button>`); a.textContent=money(r.budget);
      a.onclick=()=>{ view="bills"; render(); };
      tr.children[1].appendChild(a);
      tr.children[1].appendChild(el(`<div class="sub">from Bills</div>`));
    } else {
      tr.children[1].appendChild(budgetInput(p, r.category, r.budget));
      if(r.edited){
        const rs=el(`<button class="linkbtn sub" title="Use the standard budget again"></button>`); rs.textContent="reset to "+money0(r.standard);
        rs.onclick=()=>{ Model.resetBudget(DATA, p.key, r.category); markDirty(); render(); };
        tr.children[1].appendChild(rs);
      }
    }
    tr.children[2].textContent=money(r.spent);
    tr.children[3].textContent=money(r.left);
    tb.appendChild(tr);
  });
  const T=pb.totals;
  w.querySelector("tfoot").appendChild(el(`<tr><td><b>Total</b></td><td class="num"><b>${money(T.budget)}</b></td><td class="num"><b>${money(T.spent)}</b></td><td class="num${T.left<0?" neg":""}"><b>${money(T.left)}</b></td></tr>`));
  c.appendChild(w);

  // savings target vs net saved
  const sv=pb.savings, sr=el(`<div class="savrow"><div><div class="nm">Savings target${sv.edited?" ✏️":""}</div><div class="sub">saved = transfers to savings − transfers back</div></div></div>`);
  const sin=budgetInput(p, null, sv.target); sr.appendChild(sin);
  const got=el(`<div class="num"><b></b><div class="sub">saved</div></div>`); got.firstChild.textContent=money(sv.saved);
  if(sv.target>0 && sv.saved>=sv.target) got.firstChild.className="good";
  sr.appendChild(got);
  if(sv.edited){
    const rs=el(`<button class="linkbtn sub"></button>`); rs.textContent="reset to "+money0(sv.standard);
    rs.onclick=()=>{ Model.resetBudget(DATA, p.key, null); markDirty(); render(); };
    sr.firstChild.appendChild(rs);
  }
  c.appendChild(sr);
  m.appendChild(c);

  const skipped=pb.bills.notDue.filter(b=>!b.reminder && (Model.billVersion(b,p.key)||{}).freq==="monthly").map(b=>b.name);
  if(skipped.length) m.appendChild(el(`<div class="banner info" style="max-width:760px;margin-top:14px">${escHTML(skipped.join(", "))} ${skipped.length===1?"isn't":"aren't"} due this pay period — monthly bills skip one period a year, as there are 13 paydays.</div>`));
  m.appendChild(el(`<p class="muted" style="font-size:12px;max-width:760px;margin:10px 2px 0">Spent = spending in the category minus refunds back into it. Transfers (card repayments, savings) never count. Change a budget and you'll be asked whether it's for this period only (✏️) or this and future periods.</p>`));
}
const dayName = iso => new Date(iso+"T12:00:00").toLocaleDateString("en-GB",{weekday:"short"})+" "+Periods.fmt(iso);
// A budget amount you can type over; asks whether the change is for this
// period only or this and future periods. category null = savings target.
function budgetInput(p, category, value){
  const inp=el(`<input class="inline-in num" type="number" step="1" min="0" inputmode="decimal">`);
  inp.value=Math.round(value*100)/100; inp.setAttribute("aria-label",(category||"Savings target")+" budget");
  inp.onkeydown=e=>{ if(e.key==="Enter") inp.blur(); };
  inp.onchange=()=>{
    const v=parseFloat(inp.value);
    if(isNaN(v)||v<0){ toast("Enter an amount (0 or more)."); render(); return; }
    if(Model.round2(v)===Model.round2(value)) return;
    let done=false;
    const s=openSheet((category||"Savings target")+": "+money(v), ()=>{ if(!done) render(); });
    s.body.appendChild(el(`<p style="margin:0 0 14px;font-size:14px">Change it for which pay periods?</p>`));
    const row=el(`<div class="flex wrap"></div>`);
    const one=el(`<button class="btn pri">This period only</button>`), fut=el(`<button class="btn">This and future periods</button>`);
    one.onclick=()=>{ done=true; Model.setBudget(DATA, p.key, category, v, "period"); markDirty(); s.close(); render(); };
    fut.onclick=()=>{ done=true; Model.setBudget(DATA, p.key, category, v, "future"); markDirty(); s.close(); render(); };
    row.append(one, fut); s.body.appendChild(row);
    s.body.appendChild(el(`<p class="hint">"This and future" changes the standard budget from ${Periods.label(p)} on. Earlier periods keep theirs.</p>`));
  };
  return inp;
}
function openPaySheet(p, pb){
  const s=openSheet("Pay · "+Periods.label(p)), pay=pb.pay;
  const inp=el(`<input type="number" step="0.01" min="0" inputmode="decimal">`); inp.value=pay.source==="typed"?pay.amount:"";
  inp.placeholder=String(pay.source==="typed"?"":pay.amount);
  s.body.appendChild(el(`<p style="font-size:13px;margin:0 0 10px">Normally this is the salary received in the period${pay.received?" ("+money(pay.received)+")":""}; for a period that hasn't been paid yet, your last pay. Type an amount to use instead.</p>`));
  s.body.appendChild(wizField("Pay for this period (£)", inp));
  const row=el(`<div class="flex wrap" style="margin-top:12px"></div>`);
  const ok=el(`<button class="btn pri">Save</button>`);
  ok.onclick=()=>{
    const v=parseFloat(inp.value);
    if(inp.value.trim()!=="" && (isNaN(v)||v<0)){ toast("Enter an amount."); return; }
    Model.setPay(DATA, p.key, inp.value.trim()===""?null:v); markDirty(); s.close(); render();
  };
  row.appendChild(ok);
  if(pay.source==="typed"){ const a=el(`<button class="btn">Back to automatic</button>`); a.onclick=()=>{ Model.setPay(DATA, p.key, null); markDirty(); s.close(); render(); }; row.appendChild(a); }
  s.body.appendChild(row);
}
// Paid early or late: move the payday that starts this period, or the next.
function openPaydaySheet(p){
  const cy=Model.cycleOf(DATA), nextKey=Periods.periodAt(cy, p.index+1).key, first=p.key===Model.startOf(DATA);
  const s=openSheet("Paydays");
  s.body.appendChild(el(`<p style="font-size:13px;margin:0 0 10px">If you're paid early or late (e.g. before a bank holiday), set the day the money arrived. Only that payday moves; the four-weekly rhythm carries on after it.</p>`));
  const fl=el(`<div class="fields"></div>`);
  const a=el(`<input type="date">`); a.value=p.start; a.disabled=first;
  const b=el(`<input type="date">`); b.value=p.next;
  fl.appendChild(wizField("This period's payday (usually "+dayName(p.key)+")", a));
  fl.appendChild(wizField("Next payday (usually "+dayName(nextKey)+")", b));
  s.body.appendChild(fl);
  if(first) s.body.appendChild(el(`<p class="hint">The first payday is where the budget starts, so it can't move.</p>`));
  const row=el(`<div class="flex wrap" style="margin-top:12px"></div>`);
  const ok=el(`<button class="btn pri">Save</button>`);
  ok.onclick=()=>{
    const okA = first || Model.setPayday(DATA, p.key, a.value||null);
    const okB = Model.setPayday(DATA, nextKey, b.value||null);
    if(!okA||!okB){ toast("A payday can move by less than two weeks."); }
    markDirty(); s.close(); render();
  };
  const reset=el(`<button class="btn">Usual dates</button>`);
  reset.onclick=()=>{ if(!first) Model.setPayday(DATA, p.key, null); Model.setPayday(DATA, nextKey, null); markDirty(); s.close(); render(); };
  row.append(ok, reset);
  s.body.appendChild(row);
}

/* Dashboard once restarted. Pay period: the Budget tab's figures, and for
   the current period what's safe to spend until payday. Week / month /
   year / all: by bank date, with each pay period's budget counted for its
   share of days in the range (Model.rangeReport). */
function renderPPDashboard(m){
  const today=Periods.localISO(), cy=Model.cycleOf(DATA), isPP=period.grain==="pp";
  let r, from, to;
  if(isPP){ r=Model.periodBudget(DATA, ppPeriod(), today); from=r.period.start; to=r.period.end; }
  else { const [a,b]=rangeOf(); r=Model.rangeReport(DATA, a, b, today); from=r.from; to=r.to; }
  const current = isPP && r.period.index===Periods.periodFor(cy, today).index;
  const T=r.totals, saved=r.savings.saved, target=r.savings.target;

  m.innerHTML="";
  const head=el(`<div class="head"><h1>Dashboard</h1><span class="sub"></span><div class="spacer"></div></div>`);
  head.querySelector(".sub").textContent="· "+periodLabel();
  head.appendChild(periodControls(render));
  m.appendChild(head);
  const last=[...DATA.transactions,...DATA.income].reduce((a,x)=>x.date>a?x.date:a,"");
  if(!last || Periods.diffDays(last,today)>7)
    m.appendChild(el(`<div class="banner" style="margin-bottom:14px">${last?`The ledger runs to ${Periods.fmt(last)}`:`Nothing in the ledger since ${Periods.fmt(DATA.meta.startDate)} yet`} — import your latest statements so these numbers are up to date.</div>`));

  const k=el(`<div class="grid kpis" style="margin-bottom:14px"></div>`);
  const leftKpi=lab=>kpi(lab, money0(Math.abs(T.left)), T.left>=0?"under budget":"over budget", T.left>=0?"good":"bad", T.left<0?"−":"");
  const savedKpi=()=>kpi("Saved", (saved<0?"−":"")+money0(Math.abs(saved)),
    target>0 ? (saved>=target?"target "+money0(target)+" ✓":money0(target-saved)+" to go") : "no target", target>0&&saved>=target?"good":"");
  if(current){
    const u=Model.untilPayday(DATA, today);
    k.appendChild(kpi("Safe to spend", money(u.safe), money(u.perDay)+" a day until payday", u.safe<0?"bad":"good"));
    k.appendChild(kpi("Payday", Periods.fmt(u.period.next), u.daysLeft===1?"tomorrow":"in "+u.daysLeft+" days"));
    k.appendChild(kpi("Budget left", money0(Math.abs(T.left)), T.left>=0?"of "+money0(T.budget)+" this period":"over budget", T.left>=0?"good":"bad", T.left<0?"−":""));
    k.appendChild(kpi("Flex balance", money(u.flex), "current account", u.flex<0?"bad":""));
    k.appendChild(kpi("Card owed", money(u.cardOwed), u.card>0?"in credit by "+money(u.card):"credit card"));
    k.appendChild(kpi("Bills still due", money(u.billsDue), u.bills.length===1?"1 bill before payday":u.bills.length+" bills before payday"));
  } else if(isPP){
    const ps=r.pay.source;
    k.appendChild(kpi("Spent", money0(T.spent), "bills and categories"));
    k.appendChild(kpi("Budget", money0(T.budget), "bills and categories"));
    k.appendChild(leftKpi("Left"));
    k.appendChild(kpi("Pay", money0(r.pay.amount), ps==="typed"?"typed in ✏️":ps==="received"?"received":ps==="last"?"same as last pay":"no pay yet"));
    k.appendChild(savedKpi());
  } else {
    const income=Object.values(r.flows.income).reduce((s,v)=>s+v,0), net=income-T.spent-saved;
    k.appendChild(kpi("Spending", money0(T.spent), "bills and categories"));
    k.appendChild(kpi("Budget", money0(T.budget), "share of each pay period's"));
    k.appendChild(leftKpi("Remaining"));
    k.appendChild(kpi("Income", money0(income), "salary "+money0(r.flows.income.Salary||0)));
    k.appendChild(savedKpi());
    k.appendChild(kpi("Net", (net<0?"−":"+")+money0(Math.abs(net)), "income − spending − saved", net<0?"bad":"good"));
  }
  m.appendChild(k);

  if(current) m.appendChild(el(`<p class="muted" style="font-size:12px;margin:-4px 2px 14px">Safe to spend = Flex balance − what you owe on the card − bills still to pay before payday.</p>`));

  // budget vs actual, laid out like the Budget tab
  const row=el(`<div class="row2"></div>`);
  const left=el(`<div class="card"><div class="pad" style="padding-bottom:0"><h3 class="sec">Budget vs actual</h3><div class="hint" style="margin:-4px 0 6px">Tap a category to see its rows.</div></div></div>`);
  const w=el(`<div class="tablewrap fit"><table class="budget dash"><thead><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Left</th></tr></thead><tbody></tbody><tfoot></tfoot></table></div>`);
  const tb=w.querySelector("tbody");
  r.rows.forEach(x=>{
    if(!x.fromBills && !x.budget && !x.spent) return;
    const pct=x.budget>0?Math.min(100, x.spent/x.budget*100):(x.spent>0?100:0), over=x.left<0;
    const tr=el(`<tr class="tap"><td><div class="nm"></div><div class="bar"><i style="width:${Math.max(0,pct).toFixed(0)}%;background:${over?"var(--bad)":catColor(x.category)}"></i></div></td><td class="num"></td><td class="num"></td><td class="num${over?" neg":""}"></td></tr>`);
    tr.querySelector(".nm").textContent=x.category;
    tr.children[1].textContent=money(x.budget); tr.children[2].textContent=money(x.spent); tr.children[3].textContent=money(x.left);
    if(x.fromBills){ tr.title="Open the Bills tab"; tr.onclick=()=>{ view="bills"; render(); }; }
    else { tr.title="Show these rows in the Ledger"; tr.onclick=()=>{ Object.assign(ledgerFilter,{cat:x.category,type:"All",status:"All"}); view="ledger"; render(); }; }
    tb.appendChild(tr);
  });
  w.querySelector("tfoot").appendChild(el(`<tr><td><b>Total</b></td><td class="num"><b>${money(T.budget)}</b></td><td class="num"><b>${money(T.spent)}</b></td><td class="num${T.left<0?" neg":""}"><b>${money(T.left)}</b></td></tr>`));
  left.appendChild(w);
  const sv=el(`<div class="savrow"><div><div class="nm">Saved</div><div class="sub">transfers to savings − transfers back</div></div><div class="num"><b></b><div class="sub"></div></div><div class="num"></div></div>`);
  sv.querySelector("b").textContent=money(saved);
  sv.querySelector(".num .sub").textContent = target>0 ? "target "+money(target) : "no target";
  sv.lastChild.textContent = target<=0 ? "" : saved>=target ? "✓" : money(target-saved)+" to go";
  left.appendChild(sv);
  row.appendChild(left);
  const right=el(`<div class="grid" style="align-content:start"></div>`);
  // bills come out on set days (rent early on), so pace is day-to-day spending only
  const dd=r.rows.filter(x=>x.category!=="Bills"), ddSum=k=>dd.reduce((s,x)=>s+(+x[k]||0),0);
  right.appendChild(paceCard(null, ddSum("budget"), ddSum("spent"), {start:parseD(from), end:parseD(to)}, "Pace · spending, not bills"));
  right.appendChild(dashBillsCard(r.bills.items, isPP, r.bills.totals, today));
  row.appendChild(right);
  m.appendChild(row);

  m.appendChild(ppTrendCard(r, from, to, today));
  m.appendChild(merchantsCard(Model.spendItems(DATA, isPP ? x=>Model.rowPeriodKey(DATA,x)===r.period.key : x=>x.date>=from&&x.date<=to, r.billIds)));
  m.appendChild(cashflowCard());
  m.appendChild(netWorthCard());
}
// The bills due in the period or range; tap one to open its pay period on the Bills tab.
function dashBillsCard(items, isPP, totals, today){
  const c=el(`<div class="card pad"><h3 class="sec"></h3></div>`);
  c.firstChild.textContent=isPP?"Bills this period":"Bills due";
  if(!items.length){ c.appendChild(el(`<div class="muted" style="font-size:13px">No bills due ${isPP?"this period":"in this range"}.</div>`)); return c; }
  const cy=Model.cycleOf(DATA), now=Periods.periodFor(cy, today);
  const w=el(`<div class="tablewrap fit"><table class="dbills"><thead><tr><th>Bill</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  const add=i=>{
    const st=billStatusText(i);
    const tr=el(`<tr class="tap"><td><div class="nm"></div><div class="sub"></div></td><td class="num"></td><td><div class="status"></div></td></tr>`);
    tr.querySelector(".nm").textContent=i.bill.name;
    tr.querySelector(".sub").textContent="due "+Periods.fmt(i.date)+((i.version||{}).account==="Card"?" · card":"");
    tr.children[1].textContent=i.reminder?(i.expected?money(i.expected):"reminder"):money(i.expected);
    if(i.reminder) tr.classList.add("reminder");
    const s=tr.querySelector(".status"); s.className="status "+st[0]; s.textContent=st[1];
    tr.title="Open on the Bills tab";
    tr.onclick=()=>{ const q=Periods.periodFor(cy, i.date); ppKey=q.index===now.index?null:q.key; view="bills"; render(); };
    tb.appendChild(tr);
  };
  const LIMIT=8;
  items.slice(0,LIMIT).forEach(add);
  c.appendChild(w);
  if(items.length>LIMIT){
    const more=el(`<button class="btn sm" style="margin-top:8px"></button>`); more.textContent="Show all "+items.length;
    more.onclick=()=>{ items.slice(LIMIT).forEach(add); more.remove(); };
    c.appendChild(more);
  }
  const t=totals||{};
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:8px">Due ${money(t.due)}${t.paid!=null?` · paid ${money(t.paid)} · ${money(t.toPay)} still to pay`:""}</div>`));
  return c;
}
const cumulative = a => { let s=0; return a.map(v=>s+=v); };
// Spending in a pay period by day (0 = payday), adding up to the Budget tab's
// "spent": rows counted in the period other than bill payments, plus what
// paid each of its bills on the day paid (kept inside the period, so a bill
// paid a day or two into the next period still counts in this one).
// noBills: day-to-day spending only (no bill payments, nothing in Bills).
function ppDaily(r, noBills){
  const p=r.period, daily=new Array(p.days).fill(0);
  const add=(iso,a)=>{ daily[Math.min(p.days-1, Math.max(0, Periods.diffDays(p.start, iso||p.start)))]+=a; };
  Model.spendItems(DATA, x=>!r.billIds.has(x.id) && Model.rowPeriodKey(DATA,x)===p.key).forEach(x=>{ if(!(noBills && x.category==="Bills")) add(x.date, x.amount); });
  if(noBills) return daily;
  const seen=new Set();
  r.bills.items.forEach(i=>{
    if(i.reminder || i.status!=="paid") return;
    if(i.how==="manual"){ add(i.paidDate, i.paidAmount); return; }
    i.payments.forEach(x=>{ if(!seen.has(x.id)){ seen.add(x.id); add(x.date, +x.amount||0); } });
  });
  return daily;
}
function catLegend(cats, budget){
  return el(`<div class="legend" style="margin-top:10px">${cats.map(c=>`<span><i style="background:${catColor(c)}"></i>${escHTML(c)}</span>`).join("")}${budget?`<span><i style="background:var(--bad)"></i>Budget</span>`:""}</div>`);
}
function ppTrendCard(r, from, to, today){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Trend</h3></div>`);
  const g=period.grain, cy=Model.cycleOf(DATA);
  const spentLegend=b=>el(`<div class="legend" style="margin-top:8px"><span><i style="background:var(--brand)"></i>Spent so far (incl. bills)</span><span><i style="background:var(--muted)"></i>Budget (${money0(b)})</span></div>`);
  if(g==="pp"){
    const p=r.period, n=today>=p.start&&today<=p.end ? Periods.diffDays(p.start,today)+1 : p.days;
    const pts=cumulative(ppDaily(r)).slice(0,n);
    c.appendChild(lineChart(pts, r.totals.budget, p.days, [Periods.fmt(p.start), Periods.fmt(p.end)]));
    c.appendChild(spentLegend(r.totals.budget));
    if(p.index>Periods.periodFor(cy, Model.startOf(DATA)).index){
      // day-to-day spending only: bills land on fixed dates, so they'd swamp the comparison
      const cur=cumulative(ppDaily(r,true));
      const prev=cumulative(ppDaily(Model.periodBudget(DATA, Periods.periodAt(cy,p.index-1), today),true));
      const day=Math.min(n, prev.length), a=cur[day-1]||0, b=prev[day-1]||0, diff=a-b;
      c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:8px">By day ${day} your day-to-day spending (not bills) is <b style="color:${diff>0?"var(--bad)":"var(--good)"}">${money(Math.abs(diff))} ${diff>0?"more":"less"}</b> than by day ${day} of the pay period before (${money0(a)} vs ${money0(b)}).</div>`));
    }
    return c;
  }
  const days=Periods.diffDays(from,to)+1;
  if(days<1){ c.appendChild(el(`<div class="muted">Nothing to show: the budget starts ${Periods.fmtY(DATA.meta.startDate)}.</div>`)); return c; }
  // spending by bank date: rows (a payment that paid a bill counts in Bills)
  // and bills marked paid by hand, on the day given
  const items=Model.spendItems(DATA, x=>x.date>=from&&x.date<=to, r.billIds);
  (r.bills.manual||[]).forEach(i=>items.push({date:i.paidDate, category:"Bills", amount:i.paidAmount}));
  if(g==="month"){
    const daily=new Array(days).fill(0);
    items.forEach(x=>{ const d=Periods.diffDays(from,x.date); if(d>=0&&d<days) daily[d]+=x.amount; });
    const n=today<from?1:today>to?days:Periods.diffDays(from,today)+1;
    c.appendChild(lineChart(cumulative(daily).slice(0,n), r.totals.budget, days, [Periods.fmt(from), Periods.fmt(to)]));
    c.appendChild(spentLegend(r.totals.budget));
    return c;
  }
  let groups;
  if(g==="week"){
    const mon=rangeOf()[0];
    groups=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((label,d)=>{
      const iso=Periods.addDays(mon,d), o={};
      items.forEach(x=>{ if(x.date===iso) o[x.category]=(o[x.category]||0)+x.amount; });
      return {label, o};
    });
  } else {
    // year / all: one bar per pay period (as on the Budget tab) starting in
    // the range, up to now
    const nowIdx=Periods.periodFor(cy, today).index;
    groups=Periods.periodsBetween(cy, from, to).filter(p=>p.start>=from && p.index<=nowIdx).map(p=>{
      const b=Model.periodBudget(DATA, p, today), o={};
      b.rows.forEach(x=>{ o[x.category]=x.spent; });
      return {label:Periods.fmt(p.start), o, budget:b.totals.budget};
    });
    c.firstChild.textContent="Spending per pay period";
  }
  const cats=[...new Set([...Model.spendCats(DATA), ...groups.flatMap(x=>Object.keys(x.o))])].filter(cat=>groups.some(x=>(x.o[cat]||0)>0.005));
  c.appendChild(stackedBars(groups, cats));
  c.appendChild(catLegend(cats, groups.some(x=>x.budget>0)));
  return c;
}
// Bars of spending by category, one per group {label, o: {category: amount},
// budget}; a dashed line marks a group's budget.
function stackedBars(groups, cats){
  const W=820,H=220,pad=34,gap=groups.length>10?6:12;
  const tot=g=>cats.reduce((s,c)=>s+Math.max(0,g.o[c]||0),0);
  const max=Math.max(1,...groups.map(g=>Math.max(tot(g), g.budget||0)));
  const bw=(W-pad*2-gap*Math.max(0,groups.length-1))/Math.max(1,groups.length), sc=(H-pad*2)/max;
  let svg=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto"><line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="var(--line)"/>`;
  groups.forEach((g,i)=>{
    const bx=pad+i*(bw+gap), mid=(bx+bw/2).toFixed(1); let yy=H-pad;
    cats.forEach(c=>{ const h=Math.max(0,g.o[c]||0)*sc; if(h>0){ svg+=`<rect x="${bx.toFixed(1)}" y="${(yy-h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${catColor(c)}"/>`; yy-=h; } });
    if(g.budget>0){ const by=(H-pad-g.budget*sc).toFixed(1); svg+=`<line x1="${bx.toFixed(1)}" y1="${by}" x2="${(bx+bw).toFixed(1)}" y2="${by}" stroke="var(--bad)" stroke-width="2" stroke-dasharray="3 2"/>`; }
    svg+=`<text x="${mid}" y="${H-pad+15}" fill="var(--muted)" font-size="11" text-anchor="middle">${escHTML(g.label)}</text>`;
    const t=tot(g); if(t>0) svg+=`<text x="${mid}" y="${(yy-5).toFixed(1)}" fill="var(--muted)" font-size="10" text-anchor="middle">${money0(t)}</text>`;
  });
  return el(svg+`</svg>`);
}
// Where the money went, grouped by the rule that matched (so "TESCO STORES
// 2228" and "Tesco Stores 2889" land together), else by the name.
function merchantsCard(items){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Top merchants</h3></div>`);
  const by={};
  items.forEach(x=>{
    const rule=Model.ruleFor(DATA.rules, x.row.name, "out");
    const key=rule ? rule.match.replace(/\b\w/g,ch=>ch.toUpperCase()) : (x.row.name||"(unnamed)").slice(0,28);
    const g=by[key]=by[key]||{amount:0, rows:new Set(), cats:{}};
    g.amount+=x.amount; g.rows.add(x.row); g.cats[x.category]=(g.cats[x.category]||0)+x.amount;
  });
  const top=Object.entries(by).filter(([,g])=>g.amount>0.005).sort((a,b)=>b[1].amount-a[1].amount).slice(0,10);
  if(!top.length){ c.appendChild(el(`<div class="muted">No spending in this period.</div>`)); return c; }
  const w=el(`<div class="tablewrap fit"><table><thead><tr><th>Merchant</th><th>Category</th><th class="num">Visits</th><th class="num">Total</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  top.forEach(([name,g])=>{
    const cat=Object.entries(g.cats).sort((a,b)=>b[1]-a[1])[0][0];
    const tr=el(`<tr><td></td><td><span class="tag" style="font-size:10px"></span></td><td class="num muted">${g.rows.size}</td><td class="num">${money(g.amount)}</td></tr>`);
    tr.children[0].textContent=name;
    const tag=tr.querySelector(".tag"); tag.textContent=cat; tag.style.background=catColor(cat);
    tb.appendChild(tr);
  });
  c.appendChild(w);
  return c;
}

// Data tab: the pay cycle, or the way into the restart.
function payPeriodsCard(){
  const c=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Pay periods</h3></div>`);
  if(Model.isRestarted(DATA)){
    const cy=Periods.normCycle(Model.cycleOf(DATA));
    c.appendChild(el(`<p style="margin:0;font-size:13px">Restarted from payday <b>${Periods.fmtY(DATA.meta.startDate)}</b>, paid every ${cy.days} days. Rows from before then are in the archive copy saved at the restart.</p>`));
  } else {
    c.appendChild(el(`<p style="margin:0 0 10px;font-size:13px">You're paid every four weeks. The restart moves the budget to pay periods from your payday on <b>${Periods.fmtY(RESTART_START)}</b> and archives everything before it.</p>`));
    const b=el(`<button class="btn pri">Restart from payday…</button>`); b.onclick=()=>{ view="restart"; render(); };
    c.appendChild(b);
  }
  return c;
}

/* The restart wizard. Its choices live in `wiz`, so a re-render (or a change
   arriving from another device) keeps what's been typed; nothing is saved
   until "Restart the budget". Typing updates `wiz` and the totals and checks
   in place, so inputs keep focus; ticking, adding or switching things
   re-renders. */
function renderRestart(m){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Restart from payday</h1><span class="sub">switch to four-weekly pay periods</span></div>`));
  if(Model.isRestarted(DATA)){
    wiz=null;
    const c=el(`<div class="card pad" style="max-width:640px"><h3 class="sec">Already restarted</h3>
      <p style="margin:0 0 12px">This budget restarted from payday ${Periods.fmtY(DATA.meta.startDate)}. That only happens once, so there's nothing to do here.</p></div>`);
    const b=el(`<button class="btn pri">Go to Bills</button>`); b.onclick=()=>{ view="bills"; render(); };
    c.appendChild(b); m.appendChild(c); return;
  }
  const pv=Model.restartPreview(DATA, RESTART_START, Periods.localISO());
  wizState(pv);
  const box=el(`<div class="wiz"></div>`);
  box.appendChild(el(`<p class="muted" style="margin:0">Work down the steps. Nothing changes until you press <b>Restart the budget</b> at the end.</p>`));
  [wizBackupCard, wizPeriodsCard, wizOpeningsCard, wizBillsCard, wizBudgetCard, wizReviewCard, wizRulesCard, wizConfirmCard]
    .forEach(f=>box.appendChild(f(pv)));
  m.appendChild(box);
  refreshWiz();
}
function rerenderWiz(){ const y=window.scrollY; render(); window.scrollTo(0,y); }
function wizState(pv){
  if(!wiz) wiz={
    backup:false, busy:false, error:"",
    openings:{flex:"", card:""},
    bills:pv.bills.map(b=>Object.assign({}, b, {dueDay:"", ydDay:"", ydMonth:""})),
    budget:{cats:Object.assign({}, pv.budget.cats), savings:pv.budget.savings},
    review:{},
  };
  // rows to sort can change if another device edits the ledger meanwhile
  const keys=new Set();
  pv.review.forEach(r=>{
    const k=r.dir+":"+r.id, s=r.suggestion; keys.add(k);
    if(!wiz.review[k]) wiz.review[k]=Object.assign({}, s && !(s.type==="Transfer" && s.other===Model.accountOf(r.row)) ? s : r.now);
  });
  Object.keys(wiz.review).forEach(k=>{ if(!keys.has(k)) delete wiz.review[k]; });
  return wiz;
}
const wizChoices = () => ({start:RESTART_START, openings:wiz.openings, bills:wiz.bills, budget:wiz.budget, review:wiz.review});
function wizProblems(){
  const out=[], s=Store.status();
  if(!wiz.backup) out.push("Download the backup (step 1).");
  if(s.configured && s.state==="signed-out") out.push("Sign in on the Data tab first, so the restart is saved to the cloud.");
  if(s.mode==="cloud" && s.state==="offline") out.push("You're offline — the restart needs a connection.");
  return [...new Set(out.concat(Model.restartProblems(wizChoices())))];
}
function refreshWiz(){
  if(!wiz) return;
  const bt=document.getElementById("wizBillTotals"); if(bt) bt.textContent=wizBillTotals();
  const bu=document.getElementById("wizBudgetTotal"); if(bu) bu.textContent=wizBudgetTotal();
  document.querySelectorAll(".bill-hint").forEach(e=>{ e.textContent=e._bill?wizOverlap(e._bill):""; });
  const ul=document.getElementById("wizProblems"), btn=document.getElementById("wizConfirm");
  if(!ul||!btn) return;
  const probs=wizProblems();
  ul.innerHTML="";
  probs.forEach(p=>{ const li=document.createElement("li"); li.textContent=p; ul.appendChild(li); });
  if(!probs.length){ const li=document.createElement("li"); li.className="ok"; li.textContent="✓ Everything's ready."; ul.appendChild(li); }
  btn.disabled = probs.length>0 || wiz.busy;
}
// a labelled field for the wizard's grids
function wizField(label, input, cls){
  const d=el(`<label class="fld${cls?" "+cls:""}"><span></span></label>`);
  d.firstChild.textContent=label; d.appendChild(input);
  return d;
}

function wizBackupCard(){
  const c=el(`<div class="card pad"><h3 class="sec">1 · Download a backup</h3>
    <p>Saves your whole budget as it is now to a file on this device. The restart also keeps an archive copy (in the cloud when you're signed in), but a file of your own is the safest fallback.</p></div>`);
  const row=el(`<div class="flex wrap" style="gap:10px"></div>`);
  const b=el(`<button class="btn${wiz.backup?"":" pri"}">${wiz.backup?"Download again":"Download backup"}</button>`);
  b.onclick=()=>{ download("budget-backup-"+Periods.localISO()+".json", JSON.stringify(DATA,null,1)); wiz.backup=true; rerenderWiz(); };
  row.appendChild(b);
  if(wiz.backup) row.appendChild(el(`<span class="ok-line">✓ Backup downloaded</span>`));
  c.appendChild(row);
  return c;
}
function wizPeriodsCard(pv){
  const cy=Periods.DEFAULT_CYCLE, first=[0,1,2].map(n=>Periods.label(Periods.periodAt(cy,n)));
  const wd=new Date(RESTART_START+"T12:00:00").toLocaleDateString("en-GB",{weekday:"long"});
  const k=pv.counts.kept, a=pv.counts.archived;
  const c=el(`<div class="card pad"><h3 class="sec">2 · Pay periods</h3>
    <p>Payday is <b>${wd} ${Periods.fmtY(RESTART_START)}</b>, then every ${cy.days} days. Each pay period runs from a payday to the day before the next: ${first.join(" · ")} …</p>
    <p class="muted" style="margin:0">Kept (on or after ${Periods.fmt(RESTART_START)}): <b>${k.out}</b> spends and <b>${k.in}</b> money in.
      Archived (before): <b>${a.out}</b> spends and <b>${a.in}</b> money in — safe in the archive copy, but no longer in the budget.</p></div>`);
  if(!k.out && !k.in) c.appendChild(el(`<p class="hint" style="margin:8px 0 0">Nothing is dated on or after ${Periods.fmt(RESTART_START)} yet. After the restart, import your statements from ${Periods.fmtY(RESTART_START)} onwards.</p>`));
  return c;
}
function wizOpeningsCard(pv){
  const c=el(`<div class="card pad"><h3 class="sec">3 · Opening balances</h3>
    <p>What each account held at the close of <b>${Periods.fmtY(pv.close)}</b>, the day before payday — take them from your statements. For the card, enter what you owed as a minus (owing £250 → −250).</p></div>`);
  const f=el(`<div class="fields"></div>`);
  [["flex","FlexGraduate"],["card","Member Credit Card"]].forEach(([key,label])=>{
    const ledger=pv.openings[key];
    const inp=el(`<input type="number" step="0.01" placeholder="from your statement">`); inp.value=wiz.openings[key];
    const fld=wizField(label, inp);
    const hint=el(`<div class="hint"></div>`);
    hint.appendChild(document.createTextNode("Ledger says "+money(ledger)+" "));
    const use=el(`<button type="button" class="btn sm">Use this</button>`);
    hint.appendChild(use);
    const diff=el(`<div class="hint warn"></div>`);
    const showDiff=()=>{
      const v=parseFloat(inp.value);
      diff.textContent = isNaN(v)||Math.abs(v-ledger)<0.005 ? "" : "Differs from the ledger by "+money(Model.round2(v-ledger))+". That's fine — the budget starts from your figure.";
    };
    inp.oninput=()=>{ wiz.openings[key]=inp.value; showDiff(); refreshWiz(); };
    use.onclick=e=>{ e.preventDefault(); inp.value=ledger.toFixed(2); inp.oninput(); };
    showDiff();
    const d=el(`<div></div>`); d.appendChild(fld); d.appendChild(hint); d.appendChild(diff);
    f.appendChild(d);
  });
  c.appendChild(f);
  return c;
}
function wizBillsCard(){
  const c=el(`<div class="card pad"><h3 class="sec">4 · Bills</h3>
    <p>Your regular bills at this month's budgeted amounts. Untick any you no longer pay, and set the day each one leaves your account. You can change all of this later on the Bills tab.</p></div>`);
  wiz.bills.forEach(b=>c.appendChild(wizBillBlock(b)));
  const add=el(`<button class="btn sm">+ Add bill</button>`);
  add.onclick=()=>{
    const nb={id:Model.newBillId("bill", wiz.bills), name:"", notes:"", match:"", freq:"monthly", amount:"", dueDay:"", dueDate:null,
      ydDay:"", ydMonth:"", account:"Flex", reminder:false, include:true, added:true};
    const ri=wiz.bills.findIndex(x=>x.reminder);
    wiz.bills.splice(ri<0?wiz.bills.length:ri, 0, nb);
    rerenderWiz();
  };
  c.appendChild(add);
  c.appendChild(el(`<div class="wiz-total" id="wizBillTotals"></div>`));
  return c;
}
function wizBillBlock(b){
  const blk=el(`<div class="wiz-bill${b.include?"":" off"}"></div>`);
  const top=el(`<div class="top"></div>`);
  const chk=el(`<input type="checkbox" aria-label="Include this bill">`); chk.checked=!!b.include;
  chk.onchange=()=>{ b.include=chk.checked; rerenderWiz(); };
  const name=el(`<input type="text" placeholder="Bill name" aria-label="Bill name">`); name.value=b.name||"";
  name.oninput=()=>{ b.name=name.value; if(b.added) b.id=Model.newBillId(b.name||"bill", wiz.bills.filter(x=>x!==b)); refreshWiz(); };
  top.appendChild(chk); top.appendChild(name);
  if(!b.include){
    const s=el(`<span class="muted" style="white-space:nowrap;font-size:13px"></span>`);
    s.textContent = b.reminder ? "reminder" : money(+b.amount||0)+(b.freq==="yearly"?" a year":" a month");
    top.appendChild(s);
  }
  if(b.added){ const x=el(`<button class="btn sm danger" title="Remove this bill">✕</button>`); x.onclick=()=>{ wiz.bills.splice(wiz.bills.indexOf(b),1); rerenderWiz(); }; top.appendChild(x); }
  blk.appendChild(top);
  if(!b.include) return blk;

  if(b.reminder) blk.appendChild(el(`<div class="hint" style="margin:0 0 10px">A reminder only: paying off the card moves your own money, so it's never counted in bills.</div>`));
  const f=el(`<div class="fields"></div>`);
  if(!b.reminder){
    const amt=el(`<input type="number" step="0.01" min="0" inputmode="decimal">`); amt.value=b.amount??"";
    amt.oninput=()=>{ b.amount=amt.value; refreshWiz(); };
    f.appendChild(wizField("Amount (£)", amt));
    const fr=el(`<select><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>`); fr.value=b.freq;
    fr.onchange=()=>{ b.freq=fr.value; rerenderWiz(); };
    f.appendChild(wizField("How often", fr));
  }
  if(b.freq==="yearly"){
    const wrap=el(`<span class="flex" style="gap:6px"></span>`);
    const dd=el(`<input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="Day" aria-label="Day" style="width:5.5em">`); dd.value=b.ydDay||"";
    const mm=el(`<select aria-label="Month"><option value="">Month</option></select>`);
    Periods.MONTHS.forEach((mo,i)=>{ const o=document.createElement("option"); o.value=String(i+1); o.textContent=mo; mm.appendChild(o); });
    mm.value=b.ydMonth||"";
    const upd=()=>{
      b.ydDay=dd.value; b.ydMonth=mm.value;
      b.dueDate = dd.value && mm.value ? mm.value.padStart(2,"0")+"-"+dd.value.padStart(2,"0") : null;
      refreshWiz();
    };
    dd.oninput=upd; mm.onchange=upd;
    wrap.appendChild(dd); wrap.appendChild(mm);
    f.appendChild(wizField("Due date", wrap));
  } else {
    const dd=el(`<input type="number" min="1" max="31" step="1" inputmode="numeric" placeholder="1–31">`); dd.value=b.dueDay??"";
    dd.oninput=()=>{ b.dueDay=dd.value; refreshWiz(); };
    f.appendChild(wizField("Due day of the month", dd));
  }
  if(!b.reminder){
    const ac=el(`<select><option value="Flex">Flex</option><option value="Card">Credit card</option></select>`); ac.value=b.account==="Card"?"Card":"Flex";
    ac.onchange=()=>{ b.account=ac.value; refreshWiz(); };
    f.appendChild(wizField("Paid from", ac));
  }
  const mt=el(`<input type="text" placeholder="words from the statement line">`); mt.value=b.match||"";
  mt.oninput=()=>{ b.match=mt.value; refreshWiz(); };
  f.appendChild(wizField("Statement text (blank: link payments by hand)", mt, "wide"));
  const nt=el(`<input type="text" placeholder="optional">`); nt.value=b.notes||"";
  nt.oninput=()=>{ b.notes=nt.value; };
  f.appendChild(wizField("Notes", nt, "wide"));
  blk.appendChild(f);
  const h=el(`<div class="hint warn bill-hint"></div>`); h._bill=b;
  blk.appendChild(h);
  return blk;
}
// Bills whose statement texts overlap: a payment holding both goes to the
// closer amount, then the closer date (Model.billTimeline).
function wizOverlap(b){
  if(!b.include) return "";
  const text=x=>String(x.match||"").trim().toLowerCase(), t=text(b), acc=x=>x.account==="Card"?"Card":"Flex";
  if(!t) return "";
  const names=wiz.bills.filter(x=>x!==b && x.include && acc(x)===acc(b) && text(x) && (text(x).includes(t)||t.includes(text(x))))
    .map(x=>x.name||"an unnamed bill");
  return names.length ? "Statement text overlaps with "+names.join(", ")+": a payment matching both goes to the closest amount, then the closest date." : "";
}
function wizBillTotals(){
  let mo=0, yr=0;
  wiz.bills.forEach(b=>{ if(!b.include||b.reminder) return; const a=+b.amount||0; if(b.freq==="yearly") yr+=a; else mo+=a; });
  const per=Periods.smoothedPerPeriod(mo,"monthly")+Periods.smoothedPerPeriod(yr,"yearly");
  return "Monthly bills "+money(mo)+" · yearly "+money(yr)+" · about "+money(per)+" per pay period on average";
}
function wizBudgetCard(){
  const c=el(`<div class="card pad"><h3 class="sec">5 · Budget per pay period</h3>
    <p>What you plan to spend in each pay period, outside bills. Started from September's budget × 12/13 (13 pay periods a year), rounded. You can set a different amount for any one period later.</p></div>`);
  const f=el(`<div class="fields"></div>`);
  Object.keys(wiz.budget.cats).forEach(cat=>{
    const inp=el(`<input type="number" step="1" min="0" inputmode="decimal">`); inp.value=wiz.budget.cats[cat];
    inp.oninput=()=>{ wiz.budget.cats[cat]=inp.value; refreshWiz(); };
    f.appendChild(wizField(cat, inp));
  });
  const sv=el(`<input type="number" step="1" min="0" inputmode="decimal">`); sv.value=wiz.budget.savings;
  sv.oninput=()=>{ wiz.budget.savings=sv.value; refreshWiz(); };
  f.appendChild(wizField("Savings target", sv));
  c.appendChild(f);
  c.appendChild(el(`<div class="wiz-total" id="wizBudgetTotal"></div>`));
  return c;
}
function wizBudgetTotal(){
  const spend=Object.keys(wiz.budget.cats).reduce((s,k)=>s+(+wiz.budget.cats[k]||0),0), sav=+wiz.budget.savings||0;
  return "Spending "+money(spend)+" + savings "+money(sav)+" = "+money(spend+sav)+" per pay period";
}
function wizReviewCard(pv){
  const c=el(`<div class="card pad"><h3 class="sec">6 · Rows to sort</h3></div>`);
  if(!pv.review.length){ c.appendChild(el(`<p class="muted" style="margin:0">Nothing to sort — every row being kept has a clear type.</p>`)); return c; }
  c.appendChild(el(`<p>These rows were in "Other", or are money in from an unclear source. Choose what each one really was; any you leave keep the choice shown.</p>`));
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th>What it was</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  pv.review.forEach(r=>{
    const k=r.dir+":"+r.id, own=Model.accountOf(r.row);
    const tr=el(`<tr><td class="muted" style="white-space:nowrap">${fmtDate(r.row.date)}</td><td></td><td class="num"></td><td></td></tr>`);
    tr.children[1].textContent=(r.row.name||"")+(own==="Card"?" · card":"");
    tr.children[2].textContent=(r.dir==="in"?"+":"−")+money(+r.row.amount||0);
    const sel=kindSelect(r.dir, wiz.review[k], own, {spend:Model.SPEND_CATS, income:Model.INCOME_CATS});
    sel.onchange=()=>{ wiz.review[k]=parseKind(sel.value); refreshWiz(); };
    tr.children[3].appendChild(sel);
    tb.appendChild(tr);
  });
  c.appendChild(w);
  return c;
}
function wizRulesCard(pv){
  const xfers=pv.rules.filter(r=>r.transfer), other=pv.rules.filter(r=>r.category==="Other").length;
  const c=el(`<div class="card pad"><h3 class="sec">7 · Rules</h3>
    <p>${pv.rules.length} rules carry over, renamed to the new categories. Rules for moving your own money become transfers:</p></div>`);
  const ul=el(`<ul class="wiz-list"></ul>`);
  xfers.forEach(r=>{ const li=document.createElement("li"); li.textContent=`"${r.match}" → ${r.transfer==="Card"?"card repayment":"transfer to or from "+(ACCOUNT_WORD[r.transfer]||r.transfer)}`; ul.appendChild(li); });
  c.appendChild(ul);
  if(other) c.appendChild(el(`<p class="muted" style="margin:8px 0 0">${other} rule${other===1?" points":"s point"} at Other — you may want to re-point ${other===1?"it":"them"} on the Rules tab afterwards.</p>`));
  return c;
}
function wizConfirmCard(){
  const c=el(`<div class="card pad"><h3 class="sec">8 · Restart</h3></div>`);
  c.appendChild(el(`<ul class="wiz-list problems" id="wizProblems"></ul>`));
  c.appendChild(el(`<p>This replaces the live budget with the new one and keeps the old one as an archive. <b>It can't be undone in the app.</b> If the budget is open on another device, reload it there first.</p>`));
  const b=el(`<button class="btn pri" id="wizConfirm">Restart the budget</button>`);
  b.onclick=confirmRestart;
  c.appendChild(b);
  if(wiz.error){ const e=el(`<div class="banner bad" style="margin-top:12px"></div>`); e.textContent=wiz.error; c.appendChild(e); }
  return c;
}
async function confirmRestart(){
  if(!wiz || wiz.busy || Model.isRestarted(DATA)) return;
  const pv=Model.restartPreview(DATA, RESTART_START, Periods.localISO());
  wizState(pv);
  if(wizProblems().length){ rerenderWiz(); return; }
  const arch=pv.counts.archived.out+pv.counts.archived.in;
  if(!confirm(`Restart the budget from payday ${Periods.fmtY(RESTART_START)}?\n\n${arch} earlier rows move to the archive. This can't be undone in the app.`)) return;
  wiz.busy=true; wiz.error=""; refreshWiz();
  const overlay=el(`<div class="modal-bg"><div class="modal"><h3 style="margin:0 0 6px">Restarting…</h3>
    <p class="muted" style="margin:0;font-size:13px">Saving the archive and the new budget. Keep this page open.</p></div></div>`);
  document.body.appendChild(overlay);
  try{
    flushAppSave();
    const next=Model.restartDoc(DATA, wizChoices());
    const res=await Store.restart(DATA, next);
    DATA=migrate(next); dirty=false; wiz=null; view="bills";
    afterLoad();
    toast("Restarted from payday "+Periods.fmt(RESTART_START)+". The old budget is kept as "+res.archiveKey+".");
  }catch(e){
    if(wiz){ wiz.busy=false; wiz.error=(e&&e.message)||String(e); }
    rerenderWiz();
  }finally{
    overlay.remove();
  }
}

/* ---------- bill helpers still used by the pre-restart dashboard + Accounts ---------- */
function guessBill(name){
  const n=(name||"").toLowerCase();
  for(const b of [...DATA.bills, ...DATA.yearlyBills]){
    const bn=(b.name||"").toLowerCase().trim(); if(!bn) continue;
    const key=bn.split(/[\/ ]/)[0];
    if(n.includes(bn) || (key.length>2 && n.includes(key))) return b.name;
  }
  return "";
}
function billOf(t){ return t.bill!=null && t.bill!=="" ? t.bill : guessBill(t.name); }
// the amount actually allocated to "Bills" — the category/source portion when the
// row itself is category/source-split, else the whole amount (unsplit, as before).
function billBaseAmount(t){
  if(t.categorySplits && t.categorySplits.length) return catAmount(t,"Bills");
  if(t.sourceSplits && t.sourceSplits.length) return srcAmount(t,"Bills");
  return t.amount;
}
// a payment resolves to one or more {bill, amount} allocations. Splits win; else a single bill.
function billAllocations(t){
  if(t.billSplits && t.billSplits.length) return t.billSplits.filter(s=>s.bill);
  const b=billOf(t); return b ? [{bill:b, amount:billBaseAmount(t)}] : [];
}
function inCell(obj,key,type){
  const td=el(`<td class="${type==='number'?'num':''}"></td>`);
  const inp=el(`<input type="${type}" class="inline-in" ${type==='number'?'step="0.01" style="text-align:right"':''}>`);
  // re-render on change so any total row that sums these cells updates immediately -
  // without this the displayed total keeps the value it had when the page was drawn.
  // (onchange fires on blur, so focus is already leaving the field.)
  inp.value=obj[key]??""; inp.onchange=()=>{obj[key]=type==='number'?(parseFloat(inp.value)||0):inp.value;markDirty();render();};
  td.appendChild(inp); return td;
}

/* ---------- IMPORT ---------- */
let importPreview=null;
function renderImport(m){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Import statement</h1><span class="sub">fold a downloaded bank CSV in — de-dupes, skips transfers, auto-categorises</span></div>`));
  const c=el(`<div class="card pad"></div>`);
  const opt=el(`<div class="flex wrap" style="gap:14px;margin-bottom:14px">
     <label class="flex" style="gap:6px">Card <select id="impCard"><option>Debit</option><option>Credit</option></select></label>
     <label class="flex" style="gap:6px">Settlement window <select id="impWin"><option>1</option><option>2</option><option selected>3</option><option>5</option></select> days</label>
     <label class="flex" style="gap:6px"><input type="checkbox" id="impAll"> ignore date cut-off (re-scan everything)</label>
   </div>`);
  c.appendChild(opt);
  const dz=el(`<div class="dropzone" id="dz">Drop a <b>Statement Download …csv</b> here, or <label style="color:var(--brand);cursor:pointer;text-decoration:underline">browse<input type="file" accept=".csv" hidden id="impFile"></label></div>`);
  c.appendChild(dz);
  m.appendChild(c);
  const out=el(`<div id="impOut"></div>`); m.appendChild(out);

  const fileInput=dz.querySelector("#impFile");
  fileInput.onchange=e=>e.target.files[0]&&handleStatement(e.target.files[0]);
  dz.ondragover=e=>{e.preventDefault();dz.classList.add("drag");};
  dz.ondragleave=()=>dz.classList.remove("drag");
  dz.ondrop=e=>{e.preventDefault();dz.classList.remove("drag");e.dataTransfer.files[0]&&handleStatement(e.dataTransfer.files[0]);};
}
function handleStatement(file){
  const rd=new FileReader();
  rd.onload=()=>{ try{ buildImportPreview(rd.result); }catch(e){ document.getElementById("impOut").innerHTML=`<div class="banner">Could not read that file: ${e.message}</div>`; } };
  rd.readAsText(file);
}
// minimal CSV line parser (handles quotes)
function parseCSVLine(line){
  const out=[]; let cur="",q=false;
  for(let i=0;i<line.length;i++){const ch=line[i];
    if(q){ if(ch=='"'){ if(line[i+1]=='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else { if(ch=='"')q=true; else if(ch==','){out.push(cur);cur="";} else cur+=ch; } }
  out.push(cur); return out;
}
function moneyNum(v){ if(v==null)return 0; const s=String(v).replace(/[^0-9.\-]/g,""); const n=parseFloat(s); return isNaN(n)?0:Math.round(n*100)/100; }
function parseStatementDate(s){
  s=(s||"").trim(); const M={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  let m=s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if(m) return new Date(+m[3],M[m[2].toLowerCase()],+m[1]);
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if(m) return new Date(+m[3],+m[2]-1,+m[1]);
  m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  return null;
}
const SKIP_RE=/transfer to|transfer from|to saver|from saver|returned direct debit|^payment received|^direct debit returned/i;
const SKIP_TYPE_RE=/transfer (to|from)|to saver|from saver|returned direct debit/i;   // this bank puts these in the "Transaction type" column
function buildImportPreview(text){
  const lines=text.split(/\r?\n/);
  let start=-1, stated=null;
  for(let i=0;i<lines.length;i++){
    if(stated==null && /account balance/i.test(lines[i])){ const mm=lines[i].match(/-?[\d,]+\.\d\d/); if(mm) stated=parseFloat(mm[0].replace(/,/g,"")); }
    if(/^\s*"?Date"?\s*,/i.test(lines[i])){ start=i; break; }
  }
  if(start<0){ document.getElementById("impOut").innerHTML=`<div class="banner">Couldn't find the header row (a line starting with "Date").</div>`; return; }
  const header=parseCSVLine(lines[start]).map(h=>h.trim().replace(/^"|"$/g,"").toLowerCase());
  const idx=n=>header.indexOf(n);
  const iDate=idx("date"),iDesc=idx("description")>=0?idx("description"):idx("transactions"),
        iOut=idx("paid out"),iIn=idx("paid in"),iType=idx("transaction type");
  const rows=[];
  for(let i=start+1;i<lines.length;i++){
    if(!lines[i].trim())continue;
    const c=parseCSVLine(lines[i]).map(x=>x.trim().replace(/^"|"$/g,""));
    const d=parseStatementDate(c[iDate]); if(!d)continue;
    rows.push({date:d,type:iType>=0?(c[iType]||""):"",desc:(c[iDesc]||"").replace(/\s+/g," ").trim(),
               out:moneyNum(iOut>=0?c[iOut]:0),in:moneyNum(iIn>=0?c[iIn]:0)});
  }
  const win=+document.getElementById("impWin").value;
  const card=document.getElementById("impCard").value;
  const all=document.getElementById("impAll").checked;
  // cut-off = latest existing entry FOR THIS CARD - window. Per-card matters: importing
  // a fresh debit statement must not push the cutoff past a credit statement's rows
  // (the two accounts are updated on different schedules).
  let cutoff=null;
  if(!all){
    const last=[...DATA.transactions,...DATA.income].filter(t=>(t.card||"Debit")===card).reduce((a,t)=>t.date>a?t.date:a,"");
    if(last){cutoff=parseD(last);cutoff.setDate(cutoff.getDate()-win);}
  }
  // existing multiset by date+amount
  const key=(iso,amt)=>iso+"|"+amt.toFixed(2);
  const txKeys={},incKeys={};
  DATA.transactions.forEach(t=>{const k=key(t.date,t.amount);txKeys[k]=(txKeys[k]||0)+1;});
  DATA.income.forEach(t=>{const k=key(t.date,t.amount);incKeys[k]=(incKeys[k]||0)+1;});
  function takeMatch(keys,d,amt){ let best=null;
    for(let off=-win;off<=win;off++){const dd=new Date(d);dd.setDate(d.getDate()+off);const k=key(iso(dd),amt);
      if((keys[k]||0)>0 && (best==null||Math.abs(off)<best.o))best={o:Math.abs(off),k};}
    if(best){keys[best.k]--;return true;} return false; }
  const iso=dt=>dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0");

  const newTx=[],newInc=[]; let dupes=0,skipped=0,beforeCut=0,beforeStart=0;
  // After the restart, rows before its payday belong to the archive: never add them,
  // even when re-scanning everything.
  const startIso = Model.isRestarted(DATA) ? DATA.meta.startDate : null;
  // Restarted: what each row is comes from the rules (a type and category, or a
  // transfer); a bank transfer on Flex is a savings transfer; anything else
  // with no rule is left red as Other / Other income.
  const typed=(desc, dir, amount, d, bankType)=>{
    const row={date:iso(d), amount, name:desc, card, flagged:false, confirmed:false};
    const k=Model.importKind(DATA, row, dir, bankType);
    row.flagged=k.flagged;
    return Model.setKind(row, dir, k.kind);
  };
  // Restarted, Flex: your own transfers (savings) come in too.
  const keepTransfers = !!startIso && card==="Debit";
  rows.forEach(r=>{
    if(startIso && iso(r.date)<startIso){beforeStart++;return;}
    if(cutoff && r.date<=cutoff){beforeCut++;return;}
    const own = keepTransfers && (Model.SAVER_RE.test(r.desc)||Model.SAVER_RE.test(r.type));
    if(!own && (SKIP_RE.test(r.desc)||SKIP_TYPE_RE.test(r.type))){skipped++;return;}
    if(r.out>0){ if(takeMatch(txKeys,r.date,r.out)){dupes++;return;}
      if(startIso){ newTx.push(typed(r.desc,"out",r.out,r.date,r.type)); return; }
      const cat=categorise(r.desc);
      newTx.push({date:iso(r.date),amount:r.out,name:r.desc,category:cat||"Other",card,flagged:!cat,confirmed:false}); }
    else if(r.in>0){ if(takeMatch(incKeys,r.date,r.in)){dupes++;return;}
      if(startIso){ newInc.push(typed(r.desc,"in",r.in,r.date,r.type)); return; }
      const src=categorise(r.desc);
      newInc.push({date:iso(r.date),amount:r.in,name:r.desc,source:src||"Other",card,flagged:!src,confirmed:false}); }
  });
  importPreview={newTx,newInc,dupes,skipped,beforeCut,beforeStart,startIso,stated,total:rows.length};
  renderImportPreview();
}
function renderImportPreview(){
  const {newTx,newInc,dupes,skipped,beforeCut,beforeStart,startIso,stated,total}=importPreview;
  const out=document.getElementById("impOut"); out.innerHTML="";
  const stats=el(`<div class="grid kpis" style="margin:14px 0">
    ${kpiHTML("Statement rows",total)}${kpiHTML(startIso?"New money out":"New spend",newTx.length)}${kpiHTML(startIso?"New money in":"New income",newInc.length)}
    ${kpiHTML("Already in",dupes)}${kpiHTML(startIso?"Skipped":"Transfers skipped",skipped)}${kpiHTML("Before cut-off",beforeCut)}
    ${startIso?kpiHTML("Before "+Periods.fmt(startIso),beforeStart):""}</div>`);
  out.appendChild(stats);
  if(startIso && beforeStart) out.appendChild(el(`<div class="muted" style="font-size:12px;margin:-4px 0 12px">${beforeStart} row${beforeStart===1?"":"s"} dated before ${Periods.fmtY(startIso)} ignored — the budget restarted from that payday, so earlier rows stay in the archive.</div>`));
  // restarted: one picker for what a row is; otherwise a category / source
  const cats={spend:Model.spendCats(DATA), income:Model.incomeCats(DATA)};
  const picker=(t, dir, tr)=>{
    if(!startIso){
      const s = dir==="out" ? catSelect(t.category) : sourceSelect(t.source);
      s.onchange=()=>{ if(dir==="out") t.category=s.value; else t.source=s.value; t.flagged=false; };
      return s;
    }
    const s=kindSelect(dir, Model.classify(t, dir, DATA.categories), Model.accountOf(t), cats);
    s.onchange=()=>{ Model.setKind(t, dir, parseKind(s.value)); t.flagged=false; tr.style.background=""; };
    return s;
  };
  const head=dir=>startIso ? "Type / category" : dir==="out" ? "Category" : "Source";
  const unknown=[...newTx,...newInc].filter(t=>t.flagged).length;
  const c=el(`<div class="card pad"></div>`);
  c.appendChild(el(`<div class="flex wrap" style="justify-content:space-between;margin-bottom:2px;gap:8px">
     <h3 class="sec" style="margin:0">Preview — auto-categorised with your rules; set categories, then confirm</h3>
     <span class="flex" style="gap:6px">${unknown?`<span class="chip" style="color:var(--bad)">${unknown} need a category</span>`:`<span class="chip" style="color:var(--good)">all matched ✓</span>`}</span></div>`));
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-bottom:10px">Every row is matched against your rules automatically. Red rows had no rule — pick a category here and they're done. Anything you sort out on this screen goes straight into the Ledger confirmed; only rows still left red arrive as "to review".</div>`));
  if(newTx.length){
    const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Out</th><th>${head("out")}</th></tr></thead><tbody></tbody></table></div>`);
    const tb=w.querySelector("tbody");
    newTx.forEach(t=>{const tr=el(`<tr></tr>`);if(t.flagged)tr.style.background="var(--bad-bg)";
      tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
      tr.appendChild(el(`<td>${escHTML(t.name)}</td>`));
      tr.appendChild(el(`<td class="num">${money(t.amount)}</td>`));
      const td=el(`<td></td>`);td.appendChild(picker(t,"out",tr));tr.appendChild(td);
      tb.appendChild(tr);});
    c.appendChild(w);
  } else c.appendChild(el(`<div class="muted">${startIso?"No new money out to add.":"No new spending to add."}</div>`));
  if(newInc.length){
    c.appendChild(el(`<h3 class="sec" style="margin-top:16px">${startIso?"New money in":"New income"} (${newInc.length})</h3>`));
    const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">In</th><th>${head("in")}</th></tr></thead><tbody></tbody></table></div>`);
    const tb=w.querySelector("tbody");
    newInc.forEach(t=>{const tr=el(`<tr></tr>`); if(t.flagged)tr.style.background="var(--bad-bg)";
      tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
      tr.appendChild(el(`<td>${escHTML(t.name)}</td>`));
      tr.appendChild(el(`<td class="num" style="color:var(--good)">${money(t.amount)}</td>`));
      const td=el(`<td></td>`);td.appendChild(picker(t,"in",tr));tr.appendChild(td);
      tb.appendChild(tr);});
    c.appendChild(w);
  }
  const foot=el(`<div class="flex" style="margin-top:16px;gap:10px"></div>`);
  const conf=el(`<button class="btn pri">Confirm — add ${newTx.length+newInc.length} rows</button>`);
  conf.disabled=!(newTx.length+newInc.length);
  conf.onclick=()=>confirmImport();
  foot.appendChild(conf);
  if(stated!=null) foot.appendChild(el(`<span class="muted">Statement balance <b>${money(stated)}</b> — check it against Accounts after import.</span>`));
  c.appendChild(foot);
  out.appendChild(c);
}
function confirmImport(){
  const {newTx,newInc}=importPreview;
  // The preview IS the review step: anything with a settled category (matched by a rule,
  // or set by hand here) arrives confirmed, so it isn't queued up to be checked twice.
  // Only rows still sitting on the unresolved "Other" fallback land as "to review".
  const rows=[...newTx,...newInc];
  const stillUnknown=rows.filter(t=>t.flagged).length;
  const confirmedCount=rows.length-stillUnknown;
  newTx.forEach((t,i)=>DATA.transactions.push({id:"t"+(Date.now())+"_"+i,...t,confirmed:!t.flagged}));
  newInc.forEach((t,i)=>DATA.income.push({id:"i"+(Date.now())+"_"+i,...t,confirmed:!t.flagged}));
  markDirty(); importPreview=null;
  alert(`Added ${newTx.length} transactions and ${newInc.length} income rows.\n`+
        `${confirmedCount} went in confirmed.`+
        (stillUnknown?`\n${stillUnknown} had no category set — they're waiting in the Ledger as "to review".`:` Nothing left to review.`));
  view="ledger"; ledgerFilter.status = stillUnknown ? "Needs review" : "All"; render();
}
function kpiHTML(l,v){return `<div class="card kpi"><div class="lab">${l}</div><div class="val">${v}</div></div>`;}

/* ---------- RULES ---------- */
function categorise(text){ const d=(text||"").toLowerCase(); for(const r of DATA.rules){ if(d.includes(r.match)) return r.category; } return null; }
function ruleFor(text){ const d=(text||"").toLowerCase(); return DATA.rules.find(r=>d.includes(r.match)); }
/* Restarted: a rule makes matching rows a spending or income category, or a
   transfer to / from one of your accounts. Value "cat|X" or "transfer|Account". */
function rulePicker(rule){
  const s=el(`<select class="sel-cat"></select>`);
  const group=(label, items)=>{
    const g=document.createElement("optgroup"); g.label=label;
    items.forEach(([v,t])=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; g.appendChild(o); });
    s.appendChild(g);
  };
  group("Spending", Model.spendCats(DATA).map(c=>["cat|"+c, c]));
  group("Income", Model.incomeCats(DATA).map(c=>["cat|"+c, c]));
  group("Transfer — your own money", Model.TRANSFER_ACCOUNTS.map(a=>["transfer|"+a, "Transfer: "+(ACCOUNT_WORD[a]||a)]));
  const cur = rule.transfer ? "transfer|"+rule.transfer : "cat|"+(rule.category||"Other");
  if(![...s.options].some(o=>o.value===cur)){
    const o=document.createElement("option"); o.value=cur; o.textContent=rule.transfer||rule.category||"Other"; s.insertBefore(o, s.firstChild);
  }
  s.value=cur;
  return s;
}
function applyRulePick(rule, v){
  const i=v.indexOf("|"), what=v.slice(0,i), val=v.slice(i+1);
  if(what==="transfer"){ rule.transfer=val; delete rule.category; }
  else { rule.category=val; delete rule.transfer; }
  return rule;
}
// What the rules make of a row, or null (no rule, or a transfer to its own account).
function ruleKind(t, dir){
  const k=Model.fromRule(Model.ruleFor(DATA.rules, t.name, dir), dir, DATA);
  return k && !(k.type==="Transfer" && k.other===Model.accountOf(t)) ? k : null;
}
function renderRules(m){
  const typed=Model.isRestarted(DATA);
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Rules</h1><span class="sub">${DATA.rules.length} rules · ${typed?"a description containing the text gets the category or transfer; income rules (e.g. Salary) only apply to money in":"a merchant name containing the text gets the category"}</span></div>`));
  // add form
  const add=el(`<div class="card pad flex wrap" style="gap:10px;margin-bottom:14px">
     <input type="text" id="rMatch" placeholder="merchant contains… e.g. tesco" style="flex:1;min-width:160px">
     <select id="rCat"></select><button class="btn pri" id="rAdd">Add rule</button></div>`);
  let rc=add.querySelector("#rCat");
  if(typed){ const p=rulePicker({category:"Other"}); p.id="rCat"; rc.replaceWith(p); rc=p; }
  else DATA.categories.forEach(c=>{const o=document.createElement("option");o.textContent=c;rc.appendChild(o);});
  add.querySelector("#rAdd").onclick=()=>{const v=add.querySelector("#rMatch").value.trim().toLowerCase();if(!v)return;
    DATA.rules.push(typed ? applyRulePick({match:v}, rc.value) : {match:v,category:rc.value});DATA.rules=dedupeRules(DATA.rules);markDirty();renderRules(m);};
  m.appendChild(add);
  // counts (restarted: by direction, so "sainsbury" for Salary and for Groceries count apart)
  const counts=new Map();
  const count=dir=>t=>{const r=typed?Model.ruleFor(DATA.rules,t.name,dir):ruleFor(t.name);if(r)counts.set(r,(counts.get(r)||0)+1);};
  DATA.transactions.forEach(count("out")); if(typed) (DATA.income||[]).forEach(count("in"));
  const c=el(`<div class="card"></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Merchant contains</th><th>${typed?"Category / transfer":"Category"}</th><th class="num">Matches</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  DATA.rules.forEach((r,i)=>{
    const tr=el(`<tr></tr>`);
    tr.appendChild(el(`<td><code>${escHTML(r.match)}</code></td>`));
    const td=el(`<td></td>`);
    if(typed){ const s=rulePicker(r); s.onchange=()=>{applyRulePick(r,s.value);markDirty();}; td.appendChild(s); tr.appendChild(td); }
    else if(r.transfer){ td.appendChild(el(`<span class="chip">Transfer · ${escHTML(kindText("out",{type:"Transfer",other:r.transfer}))}</span>`)); tr.appendChild(td); }
    else { const s=el(`<select class="sel-cat"></select>`);DATA.categories.forEach(c=>{const o=document.createElement("option");o.textContent=c;o.selected=c===r.category;s.appendChild(o);});
      s.onchange=()=>{r.category=s.value;markDirty();};td.appendChild(s);tr.appendChild(td); }
    tr.appendChild(el(`<td class="num muted">${counts.get(r)||0}</td>`));
    const td2=el(`<td class="right"></td>`);const del=el(`<button class="btn sm danger">✕</button>`);del.onclick=()=>{DATA.rules.splice(i,1);markDirty();renderRules(m);};td2.appendChild(del);tr.appendChild(td2);
    tb.appendChild(tr);
  });
  c.appendChild(w); m.appendChild(c);
  // re-apply
  const re=el(`<button class="btn" style="margin-top:14px">${typed?"Re-apply rules to un-reviewed rows":"Re-apply rules to un-reviewed transactions"}</button>`);
  if(typed) re.onclick=()=>{
    // only rows still flagged or on Other / Other income; split rows are left alone
    let n=0;
    const go=(list, dir)=>(list||[]).forEach(t=>{
      if(t.categorySplits||t.sourceSplits) return;
      const k=Model.classify(t, dir, DATA.categories);
      if(!(t.flagged || (k.type==="Spend"&&k.category==="Other") || (k.type==="Income"&&k.category==="Other income"))) return;
      const r=ruleKind(t, dir); if(!r) return;
      if(kindValue(r)!==kindValue(k)){ Model.setKind(t, dir, r); n++; }
      t.flagged=false;
    });
    go(DATA.transactions,"out"); go(DATA.income,"in");
    markDirty(); toast(`Rules re-applied: ${n} row${n===1?"":"s"} changed.`); renderRules(m);
  };
  else re.onclick=()=>{let n=0;DATA.transactions.forEach(t=>{if(t.flagged||t.category==="Other"){const c=categorise(t.name);if(c&&c!==t.category){t.category=c;t.flagged=false;n++;}}});markDirty();alert(`Re-categorised ${n} transactions.`);renderRules(m);};
  m.appendChild(re);
}

/* ---------- ACCOUNTS ---------- */
function renderAccounts(m){
  recordWealthSnapshot();
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Accounts</h1><span class="sub">balances & the weekly reconcile check</span></div>`));
  const a=DATA.accounts;
  // Amounts derived from the ledger (kept in sync automatically):
  const b=accountBuckets(), bal=Model.balances(DATA);
  const flex=bal.flex, credit=bal.card;
  const openLabel = Model.isRestarted(DATA)
    ? "Opening balance (close "+Periods.fmt(Periods.addDays(DATA.meta.startDate,-1))+")"
    : "Opening balance (1 Jan)";

  // ---- total wealth: everything you own minus what you owe ----
  a.savings = a.savings||[]; a.cash = a.cash||{n50:0,n20:0,n10:0,n5:0,coins:0};
  const savingsTotal = a.savings.reduce((x,sv)=>x+(+sv.balance||0),0);
  const cashTotal = cashTotalOf(a.cash);
  const wealth = flex + credit + savingsTotal + cashTotal;
  const wc=el(`<div class="card pad" style="max-width:560px;margin-bottom:14px"><h3 class="sec">Total wealth</h3></div>`);
  wc.appendChild(el(`<div style="font-size:30px;font-weight:700;letter-spacing:-.5px;color:${wealth<0?'var(--bad)':'var(--good)'}">${money(wealth)}</div>`));
  wc.appendChild(el(`<div class="muted" style="font-size:12px;margin:2px 0 12px">everything you hold, minus what you owe</div>`));
  [["Savings & investments",savingsTotal],["Cash",cashTotal],["FlexGraduate",flex],["Credit card",credit]].forEach(([lab,v])=>{
    wc.appendChild(el(`<div class="flex" style="justify-content:space-between;padding:5px 0"><span class="muted">${lab}</span><span style="color:${v<0?'var(--bad)':'inherit'}">${money(v)}</span></div>`));
  });
  m.appendChild(wc);

  // ---- FlexGraduate (current account) ----
  const c=el(`<div class="card pad" style="max-width:560px"><h3 class="sec">FlexGraduate — current account (Debit)</h3></div>`);
  c.appendChild(kvEdit(openLabel,a,"openingFlex"));
  c.appendChild(lineRO("− Spending",b.flex.spend));
  c.appendChild(lineRO("+ Money in",b.flex.moneyIn));
  c.appendChild(lineRO("− Credit-card repayments",b.flex.card));
  if(b.flex.toSavings) c.appendChild(lineRO("− To savings",b.flex.toSavings));
  if(b.flex.fromSavings) c.appendChild(lineRO("+ From savings",b.flex.fromSavings));
  if(b.flex.other) c.appendChild(lineRO("± Other transfers",b.flex.other));
  c.appendChild(totalLine("Computed balance",flex));
  c.appendChild(reconcileRow(flex,"-2294.96"));
  m.appendChild(c);

  // ---- Member Credit Card ----
  const cc=el(`<div class="card pad" style="max-width:560px;margin-top:14px"><h3 class="sec">Member Credit Card</h3></div>`);
  cc.appendChild(kvEdit(openLabel,a,"openingCredit"));
  cc.appendChild(lineRO("− Card charges",b.card.charges));
  cc.appendChild(lineRO("+ Repayments made",b.card.repaid));
  if(b.card.refunds) cc.appendChild(lineRO("+ Refunds to card",b.card.refunds));
  if(b.card.other) cc.appendChild(lineRO("± Other transfers",b.card.other));
  cc.appendChild(totalLine("Computed balance",credit));
  cc.appendChild(reconcileRow(credit,"-1154.95"));
  m.appendChild(cc);

  // ---- cash in hand: notes counted individually, coins as one amount ----
  const cash=a.cash;
  const cc2=el(`<div class="card pad" style="max-width:560px;margin-top:14px"><h3 class="sec">Cash in hand</h3></div>`);
  const cw=el(`<div class="tablewrap"><table><thead><tr><th>Denomination</th><th class="num">Count</th><th class="num">Value</th></tr></thead><tbody></tbody></table></div>`);
  const ctb=cw.querySelector("tbody");
  NOTE_DENOMS.forEach(([v,k])=>{
    const tr=el(`<tr></tr>`);
    tr.appendChild(el(`<td>£${v} notes</td>`));
    const td=el(`<td class="num"></td>`);
    const inp=el(`<input type="number" min="0" step="1" value="${+cash[k]||0}" style="width:90px;text-align:right">`);
    inp.onchange=()=>{ cash[k]=Math.max(0,parseInt(inp.value)||0); markDirty(); render(); };
    td.appendChild(inp); tr.appendChild(td);
    tr.appendChild(el(`<td class="num muted">${money(v*(+cash[k]||0))}</td>`));
    ctb.appendChild(tr);
  });
  // coins: an amount, not a count - so the middle column stays empty here
  const coinTr=el(`<tr><td>Coins</td></tr>`);
  const coinTd=el(`<td class="num"></td>`);
  const coinInp=el(`<input type="number" min="0" step="0.01" value="${(+cash.coins||0).toFixed(2)}" style="width:90px;text-align:right">`);
  coinInp.onchange=()=>{ cash.coins=Math.max(0,Math.round((parseFloat(coinInp.value)||0)*100)/100); markDirty(); render(); };
  coinTd.appendChild(coinInp); coinTr.appendChild(coinTd);
  coinTr.appendChild(el(`<td class="num muted">${money(+cash.coins||0)}</td>`));
  ctb.appendChild(coinTr);
  ctb.appendChild(el(`<tr style="font-weight:700"><td>Total cash</td><td class="num muted" style="font-weight:400">${NOTE_DENOMS.reduce((x,[,k])=>x+(+cash[k]||0),0)} notes</td><td class="num">${money(cashTotal)}</td></tr>`));
  cc2.appendChild(cw);
  const dupRow=a.savings.find(sv=>/^\s*cash\s*$/i.test(sv.name||""));
  if(dupRow && cashTotal>0){
    cc2.appendChild(el(`<div class="banner" style="margin-top:10px">⚠ You also have a savings row called "${escHTML(dupRow.name)}" (${money(+dupRow.balance||0)}), so cash is being counted twice in Total wealth. Delete that row with its ✕ if this section now replaces it.</div>`));
  }
  m.appendChild(cc2);

  // savings
  const s=el(`<div class="card pad" style="max-width:560px;margin-top:14px"><h3 class="sec">Savings & investments</h3></div>`);
  const w=el(`<div class="tablewrap"><table><tbody></tbody></table></div>`);const tb=w.querySelector("tbody");
  a.savings=a.savings||[];
  a.savings.forEach((sv,i)=>{const tr=el(`<tr></tr>`);tr.appendChild(inCell(sv,"name","text"));tr.appendChild(inCell(sv,"balance","number"));
    const td=el(`<td class="right"></td>`);const del=el(`<button class="btn sm danger">✕</button>`);del.onclick=()=>{a.savings.splice(i,1);markDirty();renderAccounts(m);};td.appendChild(del);tr.appendChild(td);tb.appendChild(tr);});
  const tot=savingsTotal;
  tb.appendChild(el(`<tr style="font-weight:700"><td>Total saved</td><td class="num">${money(tot)}</td><td></td></tr>`));
  s.appendChild(w);
  const add=el(`<button class="btn sm" style="margin-top:10px">+ Add account</button>`);add.onclick=()=>{a.savings.push({name:"New",balance:0});markDirty();renderAccounts(m);};s.appendChild(add);
  m.appendChild(s);

}
// What moved each account, from the ledger. Flex: {spend, moneyIn, card,
// toSavings, fromSavings, other}; card: {charges, repaid, refunds, other}.
// `card` / `repaid` are the net paid to the card; `other` is a signed net.
// The lines add up to Model.balances.
function accountBuckets(){
  const f={spend:0,moneyIn:0,card:0,toSavings:0,fromSavings:0,other:0}, c={charges:0,repaid:0,refunds:0,other:0};
  Model.ledger(DATA).forEach(r=>{
    const k=Model.classify(r.row, r.dir, DATA.categories), own=Model.accountOf(r.row), amt=+r.row.amount||0;
    const xfer = k.type==="Transfer" && k.other!==own;
    if(r.flex){
      if(own==="Flex" && r.dir==="out" && k.type==="Spend") f.spend+=amt;
      else if(own==="Flex" && r.dir==="in" && (k.type==="Income"||k.type==="Refund")) f.moneyIn+=amt;
      else if(own==="Flex" && xfer && k.other==="Savings"){ if(r.dir==="out") f.toSavings+=amt; else f.fromSavings+=amt; }
      else if(xfer && (k.other==="Card"||own==="Card")) f.card-=r.flex;
      else f.other+=r.flex;
    }
    if(r.card){
      if(own==="Card" && r.dir==="out" && k.type==="Spend") c.charges+=amt;
      else if(own==="Card" && r.dir==="in" && (k.type==="Income"||k.type==="Refund")) c.refunds+=amt;
      else if(xfer && (k.other==="Flex"||own==="Flex")) c.repaid+=r.card;
      else c.other+=r.card;
    }
  });
  [f,c].forEach(o=>Object.keys(o).forEach(x=>{ o[x]=Model.round2(o[x]); }));
  return {flex:f, card:c};
}
function kvEdit(label,obj,key){
  const d=el(`<div class="flex" style="justify-content:space-between;padding:6px 0"><span class="muted">${label}</span></div>`);
  const inp=el(`<input type="number" step="0.01" style="width:150px;text-align:right">`);inp.value=obj[key]??0;inp.onchange=()=>{obj[key]=parseFloat(inp.value)||0;markDirty();renderAccounts(document.getElementById("main"));};
  d.appendChild(inp);return d;
}
function lineRO(label,val){ return el(`<div class="flex" style="justify-content:space-between;padding:6px 0"><span class="muted">${label}</span><span>${money(val)}</span></div>`); }
function totalLine(label,val){ return el(`<div class="flex" style="justify-content:space-between;padding:12px 0;border-top:1px solid var(--line);margin-top:6px;font-weight:700"><span>${label}</span><span style="color:${val<0?'var(--bad)':'var(--good)'}">${money(val)}</span></div>`); }
function reconcileRow(computed,placeholder){
  const rec=el(`<div style="margin-top:10px"><label class="muted" style="font-size:12px">Statement balance (to check)</label>
     <div class="flex" style="gap:8px"><input type="number" step="0.01" placeholder="e.g. ${placeholder}" style="width:150px"><span class="muted"></span></div></div>`);
  const inp=rec.querySelector("input"), o=rec.querySelector("span");
  inp.oninput=()=>{const v=parseFloat(inp.value);if(isNaN(v)){o.textContent="";return;}const diff=Math.round((computed-v)*100)/100;
    o.innerHTML=Math.abs(diff)<0.01?'<span style="color:var(--good)">✓ reconciles exactly</span>':`<span style="color:var(--bad)">off by ${money(diff)}</span>`;};
  return rec;
}

/* ---------- DATA / SETTINGS ---------- */
function renderData(m){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Data</h1><span class="sub">where your budget is stored</span></div>`));
  m.appendChild(cloudCard());
  m.appendChild(payPeriodsCard());

  const c=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Backups &amp; transfer</h3></div>`);
  const btns=el(`<div class="flex wrap" style="gap:10px"></div>`);
  const imp=el(`<button class="btn">Import JSON…<input type="file" accept=".json" hidden></button>`);
  imp.querySelector("input").onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{DATA=migrate(JSON.parse(r.result));markDirty();afterLoad();alert("Loaded.");}catch(err){alert("Not valid JSON: "+err.message);} };r.readAsText(f);};
  imp.onclick=e=>{if(e.target.tagName!=="INPUT")imp.querySelector("input").click();};
  btns.appendChild(imp);
  const exp=el(`<button class="btn">Export budget-data.json</button>`);exp.onclick=()=>download("budget-data.json",JSON.stringify(DATA,null,1));btns.appendChild(exp);
  const csv=el(`<button class="btn">Export transactions.csv</button>`);csv.onclick=exportCSV;btns.appendChild(csv);
  c.appendChild(btns);
  m.appendChild(c);

  const stats=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Contents</h3></div>`);
  stats.appendChild(el(`<div class="grid kpis">
     ${kpiHTML("Transactions",DATA.transactions.length)}${kpiHTML("Income rows",DATA.income.length)}
     ${kpiHTML("Rules",DATA.rules.length)}${kpiHTML("Categories",DATA.categories.length)}</div>`));
  stats.appendChild(el(`<p class="muted" style="font-size:12px;margin-top:10px">Seeded once (${DATA.meta?.generated||"?"}) from your 2026 records. It now stands alone.</p>`));
  m.appendChild(stats);

  // ---- data source clarity ----
  const src=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Where transactions come from</h3></div>`);
  src.appendChild(el(`<p class="muted" style="font-size:13px;margin:0">New transactions come in one way only: bank <b>statement CSVs</b> you drop into the <b>Import</b> tab, which are auto-categorised with your rules. The Excel files are historical backups and are never read.</p>`));
  m.appendChild(src);

  // ---- review / lock controls ----
  const rev=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Review status</h3></div>`);
  const tu=DATA.transactions.filter(t=>!t.confirmed).length, iu=DATA.income.filter(t=>!t.confirmed).length;
  rev.appendChild(el(`<p class="muted" style="font-size:13px;margin:0 0 10px">${tu} transactions and ${iu} income rows are waiting to be reviewed. "Unlock all" sends everything back to review so you can check each category — it never changes the categories themselves.</p>`));
  const rb=el(`<div class="flex wrap" style="gap:10px"></div>`);
  const uT=el(`<button class="btn">Unlock all transactions</button>`); uT.onclick=()=>{ if(confirm("Unlock every transaction for review? Categories are unchanged.")){ DATA.transactions.forEach(t=>t.confirmed=false); markDirty(); view="ledger"; ledgerFilter.status="Needs review"; render(); } };
  const uI=el(`<button class="btn">Unlock all income</button>`); uI.onclick=()=>{ if(confirm("Unlock every income row for review?")){ DATA.income.forEach(t=>t.confirmed=false); markDirty(); view="ledger"; ledgerFilter.status="Needs review"; render(); } };
  const lk=el(`<button class="btn">Lock everything (mark all confirmed)</button>`); lk.onclick=()=>{ if(confirm("Mark all transactions and income as confirmed?")){ DATA.transactions.forEach(t=>t.confirmed=true); DATA.income.forEach(t=>t.confirmed=true); markDirty(); render(); } };
  rb.appendChild(uT); rb.appendChild(uI); rb.appendChild(lk); rev.appendChild(rb);
  m.appendChild(rev);

  const danger=el(`<div class="card pad" style="max-width:640px;margin-top:14px"><h3 class="sec">Reset</h3></div>`);
  const rst=el(`<button class="btn danger">Clear this device's cached copy</button>`);
  rst.onclick=()=>{if(confirm("Clear the cached copy on this device? If you're signed in, it will be downloaded again from the cloud.")){localStorage.removeItem(LS_KEY);location.reload();}};
  danger.appendChild(rst); m.appendChild(danger);
}

/* The account / sync panel. Shared by the Data tab and the first-run screen. */
function cloudCard(){
  const s=Store.status();
  const c=el(`<div class="card pad" style="max-width:640px"><h3 class="sec">Sync</h3></div>`);

  if(!s.configured){
    c.appendChild(el(`<p style="margin:0 0 6px"><b>Local mode</b> — this device only.</p>
      <p class="muted" style="font-size:13px;margin:0">Cloud sync isn't set up yet, so your budget is saved in this browser and won't appear on your phone.
      Add your Supabase URL and anon key to <code>public/js/config.js</code> (see <code>README.md</code>) to sync across devices.</p>`));
    return c;
  }

  if(s.state==="signed-out"){
    c.appendChild(el(`<p class="muted" style="font-size:13px;margin:0 0 12px">Sign in to load your budget and keep every device showing the same numbers.</p>`));
    c.appendChild(authForm());
    return c;
  }

  const bits={ready:["good","Synced"],offline:["warn","Offline — changes are queued"],error:["bad","Sync problem"],booting:["muted","Connecting…"]}[s.state]||["muted",s.state];
  c.appendChild(el(`<p style="margin:0 0 4px">Signed in as <b>${s.email}</b></p>`));
  c.appendChild(el(`<p class="muted" style="font-size:13px;margin:0 0 4px">
      Status: <b style="color:var(--${bits[0]})">${bits[1]}</b>${s.pending?" · unsaved changes pending":""}<br>
      ${s.lastSyncedAt?"Last synced "+new Date(s.lastSyncedAt).toLocaleString("en-GB"):"Not synced yet"} · revision ${s.revision}</p>`));
  if(s.error) c.appendChild(el(`<p class="muted" style="font-size:12px;color:var(--bad);margin:6px 0 0">${s.error}</p>`));

  const row=el(`<div class="flex wrap" style="gap:10px;margin-top:12px"></div>`);
  const sync=el(`<button class="btn">Sync now</button>`);
  sync.onclick=async()=>{ sync.disabled=true; sync.textContent="Syncing…"; await Store.flush(); const r=await Store.load(); if(r.doc){DATA=migrate(r.doc);} render(); toast("Synced"); };
  row.appendChild(sync);
  const out=el(`<button class="btn danger">Sign out</button>`);
  out.onclick=async()=>{ await Store.flush(); await Store.signOut(); DATA=null; render(); };
  row.appendChild(out);
  c.appendChild(row);
  return c;
}

/* Email + password sign-in. Kept deliberately plain: it's one person's budget,
   not a product. Magic-link is offered for phones where typing is a chore. */
function authForm(){
  const f=el(`<form novalidate>
    <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="au-pass">Password</label><input id="au-pass" type="password" autocomplete="current-password"></div>
    <div class="flex wrap" style="gap:10px">
      <button class="btn pri" type="submit">Sign in</button>
      <button class="btn" type="button" id="au-new">Create account</button>
      <button class="btn" type="button" id="au-link">Email me a link</button>
    </div>
    <p class="muted" id="au-msg" style="font-size:12px;margin:12px 0 0"></p>
  </form>`);
  const email=()=>f.querySelector("#au-email").value.trim();
  const pass =()=>f.querySelector("#au-pass").value;
  const msg=(t,bad)=>{const p=f.querySelector("#au-msg");p.textContent=t;p.style.color=bad?"var(--bad)":"var(--muted)";};

  const guard=async(fn)=>{ try{ msg("Working…"); await fn(); }catch(e){ msg(e.message||String(e),true); } };

  f.onsubmit=e=>{ e.preventDefault(); guard(async()=>{
    await Store.signInWithPassword(email(),pass());
    const r=await Store.load(); DATA=r.doc?migrate(r.doc):null;
    if(DATA) afterLoad(); else render();
  }); };
  f.querySelector("#au-new").onclick=()=>guard(async()=>{
    const res=await Store.signUp(email(),pass());
    if(res.session){ const r=await Store.load(); DATA=r.doc?migrate(r.doc):null; if(DATA) afterLoad(); else render(); }
    else msg("Check your email to confirm the account, then sign in.");
  });
  f.querySelector("#au-link").onclick=()=>guard(async()=>{
    await Store.sendMagicLink(email());
    msg("Link sent — open it on this device.");
  });
  return f;
}
function download(name,text){const b=new Blob([text],{type:"application/json"});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=name;a.click();URL.revokeObjectURL(u);}
function exportCSV(){
  const rows=[["Date","Week Number","Month","Transaction","Name","Budget","Card"]];
  DATA.transactions.slice().sort((a,b)=>a.date.localeCompare(b.date)).forEach(t=>{
    const d=parseD(t.date);rows.push([t.date,isoWeek(d).week,d.getMonth()+1,t.amount,t.name,t.category,t.card||"Debit"]);});
  download("transactions.csv",rows.map(r=>r.map(x=>/[",\n]/.test(String(x))?'"'+String(x).replace(/"/g,'""')+'"':x).join(",")).join("\n"));
}

/* ---------- first run ---------- */
function renderFirstRun(){
  const m=document.getElementById("main");
  m.innerHTML=`<div class="head"><h1>Budget 2026</h1></div>`;
  const s=Store.status();

  // A misconfigured project used to fail silently: no sign-in appeared and
  // the app just looked empty, with nothing saying why. Say why.
  const cfgErr = (window.BUDGET_CONFIG||{}).configError;
  if(cfgErr){
    m.appendChild(el(`<div class="card pad" style="max-width:600px;border-color:#c0392b">
      <h3 class="sec" style="margin-top:0">Cloud sync isn't set up correctly</h3>
      <p style="font-size:13px;margin:0 0 10px">${escHTML(cfgErr)}</p>
      <p class="muted" style="font-size:13px;margin:0">Fix <code>public/js/config.js</code> and reload.
      Until then your data stays on this device only.</p>
    </div>`));
  }

  if(s.configured && s.state==="signed-out"){
    const c=el(`<div class="card pad" style="max-width:520px"><h3 class="sec">Sign in</h3></div>`);
    c.appendChild(el(`<p class="muted" style="font-size:13px;margin:0 0 12px">Your budget lives in the cloud, so the numbers match on your phone and your PC.</p>`));
    c.appendChild(authForm());
    m.appendChild(c);
    return;
  }

  const c=el(`<div class="card pad" style="max-width:560px">
    <p>No budget data on this device yet. Load a <code>budget-data.json</code> export to get started.</p>
    <div class="flex wrap" style="gap:10px;margin-top:6px">
      <button class="btn pri" id="fr-imp">Choose file…<input type="file" accept=".json" hidden></button>
    </div></div>`);
  m.appendChild(c);
  const imp=c.querySelector("#fr-imp"); const fi=imp.querySelector("input");
  imp.onclick=e=>{if(e.target.tagName!=="INPUT")fi.click();};
  fi.onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{DATA=migrate(JSON.parse(r.result));markDirty();afterLoad();}catch(err){alert("Not valid JSON: "+err.message);} };r.readAsText(f);};
}

/* ---------- tiny helpers ---------- */
function el(html){const t=document.createElement("template");t.innerHTML=html.trim();return t.content.firstElementChild;}
function fmtDate(iso){const d=parseD(iso);return d.getDate()+" "+MONTHS[d.getMonth()];}
function escHTML(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
function escAttr(s){return String(s).replace(/"/g,"&quot;");}
function txModal(){
  if(Model.isRestarted(DATA)) return newRowSheet("out");
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Add transaction</h3></div></div>`);
  const md=bg.querySelector(".modal");
  md.appendChild(el(`<div class="field"><label>Date</label><input type="date" id="mDate" value="${todayISO()}"></div>`));
  md.appendChild(el(`<div class="field"><label>Amount (£)</label><input type="number" id="mAmt" step="0.01" placeholder="0.00"></div>`));
  md.appendChild(el(`<div class="field"><label>Name / description</label><input type="text" id="mName"></div>`));
  const cf=el(`<div class="field"><label>Category</label></div>`);const cs=catSelect("Groceries");cs.id="mCat";cf.appendChild(cs);md.appendChild(cf);
  md.appendChild(el(`<div class="field"><label>Card</label><select id="mCard"><option>Debit</option><option>Credit</option></select></div>`));
  const foot=el(`<div class="flex" style="justify-content:flex-end;gap:10px;margin-top:10px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`);cancel.onclick=()=>bg.remove();
  const ok=el(`<button class="btn pri">Add</button>`);ok.onclick=()=>{
    const amt=parseFloat(md.querySelector("#mAmt").value);if(!amt){alert("Enter an amount");return;}
    DATA.transactions.push({id:"t"+Date.now(),date:md.querySelector("#mDate").value,amount:Math.round(amt*100)/100,
      name:md.querySelector("#mName").value,category:md.querySelector("#mCat").value,card:md.querySelector("#mCard").value,flagged:false,confirmed:true});
    markDirty();bg.remove();render();};
  foot.appendChild(cancel);foot.appendChild(ok);md.appendChild(foot);
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
}

/* ---------- Income helpers (used by the Ledger) ---------- */
function incSources(){
  const s=new Set(DATA.income.map(i=>i.source).filter(Boolean));
  ["Salary","Savings","Reimbursement","Refund","Other"].concat(DATA.categories).forEach(x=>s.add(x));
  return [...s];
}
function sourceSelect(cur){
  const s=el(`<select class="sel-cat"></select>`);
  const opts=incSources(); if(cur && !opts.includes(cur)) opts.unshift(cur);
  opts.forEach(o=>{const op=document.createElement("option");op.value=o;op.textContent=o;op.selected=o===cur;s.appendChild(op);});
  return s;
}
function incModal(){
  if(Model.isRestarted(DATA)) return newRowSheet("in");
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Add income</h3></div></div>`);
  const md=bg.querySelector(".modal");
  md.appendChild(el(`<div class="field"><label>Date</label><input type="date" id="mDate" value="${todayISO()}"></div>`));
  md.appendChild(el(`<div class="field"><label>Amount (£)</label><input type="number" id="mAmt" step="0.01" placeholder="0.00"></div>`));
  md.appendChild(el(`<div class="field"><label>Name / description</label><input type="text" id="mName"></div>`));
  const cf=el(`<div class="field"><label>Source</label></div>`); const cs=sourceSelect("Salary"); cs.id="mSrc"; cf.appendChild(cs); md.appendChild(cf);
  md.appendChild(el(`<div class="field"><label>Into account</label><select id="mCard"><option value="Debit">Flex (current account)</option><option value="Credit">Credit card (refund)</option></select></div>`));
  const foot=el(`<div class="flex" style="justify-content:flex-end;gap:10px;margin-top:10px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`); cancel.onclick=()=>bg.remove();
  const ok=el(`<button class="btn pri">Add</button>`); ok.onclick=()=>{
    const amt=parseFloat(md.querySelector("#mAmt").value); if(!amt){alert("Enter an amount");return;}
    DATA.income.push({id:"i"+Date.now(),date:md.querySelector("#mDate").value,amount:Math.round(amt*100)/100,
      name:md.querySelector("#mName").value,source:md.querySelector("#mSrc").value,card:md.querySelector("#mCard").value,confirmed:true});
    markDirty();bg.remove();render();};
  foot.appendChild(cancel);foot.appendChild(ok);md.appendChild(foot);
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
}

/* ---------- LEDGER — the single register: all money in + out, editable ---------- */
function ledgerAll(){
  // one row per transaction/income, carrying a ref to the real object so edits persist,
  // with how it moves the Flex current account and the card, and the running balances
  // (Model.ledger: a card repayment is Flex out AND card in; a transfer to savings is
  // Flex out only; money in before money out on the same day).
  return Model.ledger(DATA).map(r=>({date:r.row.date, ref:r.row, kind:r.dir==="out"?"tx":"inc", card:r.row.card||"Debit",
    flexEffect:r.flex, creditEffect:r.card, affectsFlex:r.affectsFlex, affectsCredit:r.affectsCard,
    flexBal:r.flexBal, creditBal:r.cardBal}));
}
// what a row shows in the current account view: {out,in,bal}
function ledgerAmounts(r){
  const a=ledgerFilter.account;
  if(a==="Flex")   return {out:r.flexEffect<0?-r.flexEffect:0,   in:r.flexEffect>0?r.flexEffect:0,   bal:r.flexBal};
  if(a==="Credit") return {out:r.creditEffect<0?-r.creditEffect:0, in:r.creditEffect>0?r.creditEffect:0, bal:r.creditBal};
  return {out:r.kind==="tx"?r.ref.amount:0, in:r.kind==="inc"?r.ref.amount:0, bal:null};       // All: intrinsic, no balance
}
function ledgerFiltered(){
  const inP=periodTest();
  let rows=ledgerAll().filter(r=>inP(r.ref));
  if(ledgerFilter.account==="Flex") rows=rows.filter(r=>r.affectsFlex);
  else if(ledgerFilter.account==="Credit") rows=rows.filter(r=>r.affectsCredit);
  if(Model.isRestarted(DATA)){
    const ft=ledgerFilter.type, fc=ledgerFilter.cat;
    if(ft!=="All" || fc!=="All") rows=rows.filter(r=>{
      const k=Model.classify(r.ref, r.kind==="tx"?"out":"in", DATA.categories);
      if(ft!=="All" && k.type!==ft) return false;
      if(fc==="All") return true;
      if(k.type==="Income") return k.category===fc;
      if(k.type==="Spend" || k.type==="Refund") return rowCats(r.ref, k).has(fc);
      return false;
    });
  } else if(ledgerFilter.cat!=="All"){
    rows=rows.filter(r=>{
      if(ledgerFilter.cat==="Credit"){   // card repayments
        const k=Model.classify(r.ref, r.kind==="tx"?"out":"in", DATA.categories);
        return k.type==="Transfer" && k.other==="Card";
      }
      if(r.kind==="tx" || r.ref.type) return catAllocations(r.ref).some(a=>a.category===ledgerFilter.cat);
      return srcAllocations(r.ref).some(a=>a.source===ledgerFilter.cat);   // older income rows: matched by source
    });
  }
  if(ledgerFilter.status==="Needs review") rows=rows.filter(r=>!r.ref.confirmed);
  else if(ledgerFilter.status==="Confirmed") rows=rows.filter(r=>r.ref.confirmed);
  if(ledgerFilter.q){const s=ledgerFilter.q.toLowerCase(); rows=rows.filter(r=>((r.ref.name||"")+" "+(r.ref.category||r.ref.source||r.ref.to||r.ref.from||"")).toLowerCase().includes(s));}
  return rows;
}
// The categories a spend or refund row counts in: its split, plus its own
// category for any amount the split leaves out.
function rowCats(t, k){
  const splits=(t.categorySplits||[]).filter(s=>s.category), out=new Set(splits.map(s=>s.category));
  if(!splits.length || Math.abs(catUnassignedAmt(t))>0.005) out.add(k.category||"Other");
  return out;
}
function renderLedger(m){
  m.innerHTML="";
  const head=el(`<div class="head"><h1>Ledger</h1><div class="spacer"></div></div>`);
  const unlockBtn=el(`<button class="btn">Unlock all</button>`);
  unlockBtn.onclick=()=>{ if(confirm("Send ALL transactions back to 'to review'?\n\nYour categories aren't changed — this just unlocks them so you can check each one.")){ DATA.transactions.forEach(t=>t.confirmed=false); markDirty(); ledgerFilter.status="Needs review"; render(); } };
  const restarted=Model.isRestarted(DATA);
  const addS=el(`<button class="btn"></button>`); addS.textContent=restarted?"+ Money out":"+ Spending"; addS.onclick=()=>txModal();
  const addI=el(`<button class="btn pri"></button>`); addI.textContent=restarted?"+ Money in":"+ Income"; addI.onclick=()=>incModal();
  head.appendChild(unlockBtn); head.appendChild(addS); head.appendChild(addI); m.appendChild(head);

  const bar=el(`<div class="card pad flex wrap" style="margin-bottom:14px;gap:10px"></div>`);
  bar.appendChild(periodControls(render));
  const accSel=el(`<select><option value="All">All accounts</option><option value="Flex">Flex (current a/c)</option><option value="Credit">Credit card</option></select>`);
  accSel.value=ledgerFilter.account; accSel.onchange=()=>{ledgerFilter.account=accSel.value;render()}; bar.appendChild(accSel);
  const opt=(parent,v,lab)=>{const o=document.createElement("option");o.value=v;o.textContent=lab;parent.appendChild(o);};
  if(Model.isRestarted(DATA)){
    const kSel=el(`<select title="type"></select>`);
    [["All","All types"],["Spend","Spending"],["Refund","Refunds"],["Income","Income"],["Transfer","Transfers"]].forEach(([v,lab])=>opt(kSel,v,lab));
    if(![...kSel.options].some(o=>o.value===ledgerFilter.type)) ledgerFilter.type="All";
    kSel.value=ledgerFilter.type; kSel.onchange=()=>{ledgerFilter.type=kSel.value;render()}; bar.appendChild(kSel);
    const cSel=el(`<select title="category"></select>`);
    opt(cSel,"All","All categories");
    [["Spending",Model.spendCats(DATA)],["Income",Model.incomeCats(DATA)]].forEach(([lab,list])=>{
      const g=document.createElement("optgroup"); g.label=lab; list.forEach(c=>opt(g,c,c)); cSel.appendChild(g);
    });
    if(![...cSel.options].some(o=>o.value===ledgerFilter.cat)) ledgerFilter.cat="All";
    cSel.value=ledgerFilter.cat; cSel.onchange=()=>{ledgerFilter.cat=cSel.value;render()}; bar.appendChild(cSel);
  } else {
    const typeSel=el(`<select></select>`);
    ["All",...DATA.categories,"Credit"].forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=c==="All"?"All categories":c;o.selected=c===ledgerFilter.cat;typeSel.appendChild(o);});
    typeSel.onchange=()=>{ledgerFilter.cat=typeSel.value;render()}; bar.appendChild(typeSel);
  }
  const statusSel=el(`<select title="review status"><option>All</option><option>Needs review</option><option>Confirmed</option></select>`);
  statusSel.value=ledgerFilter.status; statusSel.onchange=()=>{ledgerFilter.status=statusSel.value;render()}; bar.appendChild(statusSel);
  const sortBtn=el(`<button class="btn sm">${ledgerFilter.sort==="new"?"Newest first ▾":"Oldest first ▴"}</button>`);
  sortBtn.onclick=()=>{ledgerFilter.sort=ledgerFilter.sort==="new"?"old":"new";render()}; bar.appendChild(sortBtn);
  const q=el(`<input type="text" placeholder="Search…" style="flex:1;min-width:120px">`);
  q.value=ledgerFilter.q; q.oninput=()=>{ledgerFilter.q=q.value;renderLedgerTable();}; bar.appendChild(q);
  m.appendChild(bar);

  const nUnc=DATA.transactions.filter(t=>!t.confirmed).length + DATA.income.filter(t=>!t.confirmed).length;
  if(nUnc){
    const bn=el(`<div class="banner flex wrap" style="justify-content:space-between;margin-bottom:14px;gap:10px"><span>⚠ ${nUnc} row${nUnc>1?'s':''} to review — check the category/source, then Confirm to lock it in.</span></div>`);
    const grp=el(`<span class="flex" style="gap:8px"></span>`);
    const rev=el(`<button class="btn sm">Show only these</button>`); rev.onclick=()=>{ledgerFilter.status="Needs review";render()};
    const call=el(`<button class="btn sm ok">Confirm all shown</button>`);
    call.onclick=()=>{ if(confirm("Confirm every row currently shown? This locks their categories.")){ ledgerFiltered().forEach(r=>{r.ref.confirmed=true;r.ref.flagged=false;}); markDirty(); render(); } };
    grp.appendChild(rev); grp.appendChild(call); bn.appendChild(grp);
    m.appendChild(bn);
  }
  const holder=el(`<div class="card"></div>`); holder.id="ledHolder"; m.appendChild(holder);
  renderLedgerTable();
}
function renderLedgerTable(){
  const holder=document.getElementById("ledHolder"); if(!holder) return;
  const rows=ledgerFiltered();
  let totOut=0, totIn=0; rows.forEach(r=>{const a=ledgerAmounts(r); totOut+=a.out; totIn+=a.in;});
  const unc=rows.filter(r=>!r.ref.confirmed).length;
  const disp=rows.slice().sort((a,b)=> ledgerFilter.sort==="new" ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date));
  const showBal = ledgerFilter.account!=="All";                       // running balance only makes sense per account
  const cols = showBal ? 8 : 7;
  const balLabel = ledgerFilter.account==="Credit" ? "Card balance" : "Flex balance";
  holder.innerHTML="";
  holder.appendChild(el(`<div class="pad flex wrap" style="border-bottom:1px solid var(--line-2);gap:16px"><span class="muted">${rows.length} entries</span><span class="muted">Out <b style="color:var(--bad)">${money(totOut)}</b></span><span class="muted">In <b style="color:var(--good)">${money(totIn)}</b></span><span class="muted">Net <b>${money(totIn-totOut)}</b></span>${unc?`<span class="muted">· <b style="color:var(--warn)">${unc} to review</b></span>`:''}</div>`));
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th>${Model.isRestarted(DATA)?"Type / category":"Category / source"}</th><th>Account</th><th class="num">Out</th><th class="num">In</th>${showBal?`<th class="num">${balLabel}</th>`:''}<th></th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  disp.slice(0,800).forEach(r=>tb.appendChild(ledgerRow(r,showBal)));
  if(disp.length>800) tb.appendChild(el(`<tr><td colspan="${cols}" class="muted" style="text-align:center">Showing first 800 of ${disp.length}. Narrow with the filters.</td></tr>`));
  if(!disp.length) tb.appendChild(el(`<tr><td colspan="${cols}" class="empty">No entries match.</td></tr>`));
  holder.appendChild(w);
  const note = ledgerFilter.account==="All"
    ? "Pick an account above (Flex or Credit card) to see a running balance for it."
    : ledgerFilter.account==="Credit"
      ? "Running Member Credit Card balance — charges add to what you owe, payments reduce it."
      : "Running FlexGraduate current-account balance.";
  holder.appendChild(el(`<div class="pad muted" style="font-size:12px;border-top:1px solid var(--line-2)">${note}</div>`));
}
function ledgerRow(r,showBal){
  const t=r.ref, isTx=r.kind==="tx"; const a=ledgerAmounts(r), restarted=Model.isRestarted(DATA);
  const tr=el(`<tr></tr>`); if(!t.confirmed) tr.className = t.flagged ? "needs-unknown" : "needs";
  const dc=el(`<td class="muted" style="white-space:nowrap"></td>`); dc.textContent=fmtDate(t.date);
  const ci=restarted && t.countIn && Periods.periodByKey(Model.cycleOf(DATA), t.countIn);
  if(ci && Model.rowPeriodKey(DATA, {date:t.date})!==ci.key){ dc.textContent+=" ✏️"; dc.title="Counts in pay period "+Periods.label(ci); }
  tr.appendChild(dc);
  // description (editable)
  const td2=el(`<td></td>`); const nameIn=el(`<input class="inline-in" value="${escAttr(t.name||"")}">`);
  nameIn.onchange=()=>{t.name=nameIn.value;markDirty();}; td2.appendChild(nameIn); tr.appendChild(td2);
  // category (spend) or source (income), editable, with lock/review state — or a split summary
  tr.appendChild(ledgerAssignCell(t, isTx));
  // account (Debit/Credit), editable
  const td4=el(`<td></td>`); const cs=cardSelect(t.card||"Debit"); cs.disabled=t.confirmed;
  cs.onchange=()=>{ t.card=cs.value; markDirty(); render(); }; td4.appendChild(cs); tr.appendChild(td4);
  tr.appendChild(el(`<td class="num" style="color:var(--bad)">${a.out?money(a.out):""}</td>`));
  tr.appendChild(el(`<td class="num" style="color:var(--good)">${a.in?money(a.in):""}</td>`));
  if(showBal) tr.appendChild(el(`<td class="num">${a.bal!=null?money(a.bal):""}</td>`));
  const td6=el(`<td class="right" style="white-space:nowrap"></td>`);
  if(t.confirmed){ const un=el(`<button class="btn sm" title="unlock to change">✎</button>`); un.onclick=()=>{t.confirmed=false;markDirty();render();}; td6.appendChild(un); }
  else { const ok=el(`<button class="btn sm ok" title="lock this in">Confirm</button>`); ok.onclick=()=>{t.confirmed=true;t.flagged=false;markDirty();render();}; td6.appendChild(ok); }
  const mv=el(`<button class="btn sm"></button>`);
  mv.textContent="📅"; mv.title=restarted?"count it in a different pay period":"reassign to a different month";
  mv.onclick=()=>restarted?countInSheet(t):moveMonthModal(t);
  td6.appendChild(mv);
  const del=el(`<button class="btn sm danger" style="margin-left:6px">✕</button>`);
  del.onclick=()=>{ if(confirm("Delete this entry?")){ if(isTx) DATA.transactions=DATA.transactions.filter(x=>x!==t); else DATA.income=DATA.income.filter(x=>x!==t); markDirty(); render(); } };
  td6.appendChild(del); tr.appendChild(td6);
  return tr;
}
// the category/source cell: a plain dropdown + split button, or (once split) a summary
// of the split with an edit link. Shared by the Ledger's spend and income rows.
function ledgerAssignCell(t, isTx){
  if(Model.isRestarted(DATA)) return ledgerKindCell(t, isTx);
  const td=el(`<td></td>`);
  const wrap=el(`<span class="flex" style="gap:6px;flex-wrap:wrap"></span>`);
  const hasSplit = isTx ? (t.categorySplits && t.categorySplits.length) : (t.sourceSplits && t.sourceSplits.length);
  if(hasSplit){
    const allocs = isTx ? t.categorySplits.filter(s=>s.category) : t.sourceSplits.filter(s=>s.source);
    const u = isTx ? catUnassignedAmt(t) : srcUnassignedAmt(t);
    const parts = allocs.map(a=>`${escHTML(isTx?a.category:a.source)} ${money(a.amount)}`).join(" · ");
    wrap.appendChild(el(`<span><b>Split:</b> ${parts}${u>0.005?` <span style="color:var(--warn)">· ${money(u)} unallocated</span>`:''}</span>`));
    const edit=el(`<button class="btn sm">edit split</button>`); edit.onclick=()=>(isTx?categorySplitModal(t):sourceSplitModal(t)); wrap.appendChild(edit);
  } else {
    const sel = isTx ? catSelect(t.category) : sourceSelect(t.source||"Other"); sel.disabled=t.confirmed;
    sel.onchange=()=>{ if(isTx){ t.category=sel.value; t.flagged=false; if(!ruleFor(t.name)&&t.name) offerRule(t.name,t.category); } else { t.source=sel.value; } markDirty(); renderLedgerTable(); };
    wrap.appendChild(sel);
    if(!isTx || t.category!=="Credit"){
      const sp=el(`<button class="btn sm" title="split across ${isTx?'categories':'sources'}">split</button>`);
      sp.onclick=()=>(isTx?categorySplitModal(t):sourceSplitModal(t)); wrap.appendChild(sp);
    }
  }
  td.appendChild(wrap);
  if(t.confirmed) td.appendChild(el(`<span class="lockic" title="confirmed & locked">🔒</span>`));
  else td.appendChild(el(`<span class="review-tag">review</span>`));
  return td;
}
// Restarted budgets: one picker for what the row is (type + category, or the
// account at the other end of a transfer), and a category split for spending
// and refunds. Any amount left out of a split counts in the row's category.
function ledgerKindCell(t, isTx){
  const dir=isTx?"out":"in", k=Model.classify(t, dir, DATA.categories);
  const td=el(`<td></td>`);
  const wrap=el(`<span class="flex" style="gap:6px;flex-wrap:wrap"></span>`);
  const splittable = k.type==="Spend" || k.type==="Refund";
  if(splittable && t.categorySplits && t.categorySplits.length){
    const u=catUnassignedAmt(t);
    const parts=t.categorySplits.filter(s=>s.category).map(a=>`${escHTML(a.category)} ${money(a.amount)}`).join(" · ");
    wrap.appendChild(el(`<span><b>${k.type==="Refund"?"Refund split":"Split"}:</b> ${parts}${Math.abs(u)>0.005?` <span class="muted">· ${money(u)} ${escHTML(k.category||"Other")}</span>`:''}</span>`));
    const edit=el(`<button class="btn sm">edit split</button>`); edit.onclick=()=>categorySplitModal(t); wrap.appendChild(edit);
  } else {
    const sel=kindSelect(dir, k, Model.accountOf(t), {spend:Model.spendCats(DATA), income:Model.incomeCats(DATA)});
    sel.disabled=t.confirmed;
    sel.onchange=()=>{
      const nk=parseKind(sel.value);
      Model.setKind(t, dir, nk); t.flagged=false;
      if(nk.type==="Spend" && t.name && !ruleFor(t.name)) offerRule(t.name, nk.category);
      markDirty(); renderLedgerTable();
    };
    wrap.appendChild(sel);
    if(splittable){
      const sp=el(`<button class="btn sm" title="split across categories">split</button>`);
      sp.onclick=()=>categorySplitModal(t); wrap.appendChild(sp);
    }
  }
  td.appendChild(wrap);
  if(t.confirmed) td.appendChild(el(`<span class="lockic" title="confirmed & locked">🔒</span>`));
  else td.appendChild(el(`<span class="review-tag">review</span>`));
  return td;
}

/* What a row is, as one <select>: value "Type|category" or "Transfer|account".
   Money out: spending categories, or a transfer to another of your accounts.
   Money in: income, a refund against a spending category, or a transfer in.
   `own` is the row's account; `cats` = {spend:[…], income:[…]}. */
const kindValue = k => k.type+"|"+(k.type==="Transfer" ? (k.other||"") : (k.category||""));
function parseKind(v){
  const i=String(v).indexOf("|"), type=String(v).slice(0,i), rest=String(v).slice(i+1);
  return type==="Transfer" ? {type, category:null, other:rest} : {type, category:rest, other:null};
}
const ACCOUNT_WORD = {Card:"credit card", Flex:"Flex", Savings:"savings"};
function kindText(dir, k){
  if(k.type==="Transfer"){
    if(dir==="out" && k.other==="Card") return "Card repayment";
    return (dir==="out"?"To ":"From ")+(ACCOUNT_WORD[k.other]||k.other||"?");
  }
  if(k.type==="Refund") return "Refund: "+(k.category||"?");
  if(k.type==="Spend"||k.type==="Income") return k.category||"?";
  return k.type+": "+(k.category||"?");
}
function kindSelect(dir, kind, own, cats){
  const s=el(`<select class="sel-cat"></select>`);
  const group=(label, kinds)=>{
    const g=document.createElement("optgroup"); g.label=label;
    kinds.forEach(k=>{ const o=document.createElement("option"); o.value=kindValue(k); o.textContent=kindText(dir,k); g.appendChild(o); });
    s.appendChild(g);
  };
  const transfers=Model.TRANSFER_ACCOUNTS.filter(a=>a!==own).map(a=>({type:"Transfer",category:null,other:a}));
  if(dir==="out"){
    group("Spending", cats.spend.map(c=>({type:"Spend",category:c,other:null})));
    group("Transfer — your own money", transfers);
  } else {
    group("Income", cats.income.map(c=>({type:"Income",category:c,other:null})));
    group("Refund — takes money off spending", cats.spend.map(c=>({type:"Refund",category:c,other:null})));
    group("Transfer — your own money", transfers);
  }
  const cur=kindValue(kind);
  if(![...s.options].some(o=>o.value===cur)){
    const o=document.createElement("option"); o.value=cur; o.textContent=kindText(dir,kind); s.insertBefore(o, s.firstChild);
  }
  s.value=cur;
  return s;
}
function categorySplitModal(t){
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Split across categories</h3></div></div>`);
  const md=bg.querySelector(".modal");
  md.appendChild(el(`<div class="muted" style="font-size:13px;margin-bottom:12px">${escHTML(t.name||"")} · <b>${money(t.amount)}</b> · ${fmtDate(t.date)}</div>`));
  let allocs = (t.categorySplits && t.categorySplits.length) ? t.categorySplits.map(s=>({category:s.category,amount:+s.amount||0}))
             : (t.category ? [{category:t.category,amount:t.amount}] : [{category:"",amount:t.amount}]);
  const list=el(`<div></div>`); md.appendChild(list);
  const rem=el(`<div style="font-size:13px;margin:8px 0"></div>`); md.appendChild(rem);
  function updateRem(){ const sum=allocs.reduce((s,a)=>s+(+a.amount||0),0); const r=Math.round((t.amount-sum)*100)/100;
    rem.innerHTML = Math.abs(r)<0.005 ? `<span style="color:var(--good)">✓ fully allocated</span>` : `Left to allocate: <b style="color:var(--warn)">${money(r)}</b>`; }
  function refresh(){
    list.innerHTML="";
    allocs.forEach((a,i)=>{
      const row=el(`<div class="flex" style="gap:8px;margin-bottom:8px"></div>`);
      const sel=catSelectPlain(a.category); sel.style.flex="1"; sel.onchange=()=>{a.category=sel.value;};
      const amt=el(`<input type="number" step="0.01" style="width:120px;text-align:right">`); amt.value=a.amount; amt.oninput=()=>{a.amount=parseFloat(amt.value)||0;updateRem();};
      const del=el(`<button class="btn sm danger">✕</button>`); del.onclick=()=>{allocs.splice(i,1);refresh();};
      row.appendChild(sel); row.appendChild(amt); row.appendChild(del); list.appendChild(row);
    });
    updateRem();
  }
  const addBtn=el(`<button class="btn sm">+ Add category</button>`); addBtn.onclick=()=>{allocs.push({category:"",amount:Math.max(0,Math.round((t.amount-allocs.reduce((s,a)=>s+(+a.amount||0),0))*100)/100)});refresh();}; md.appendChild(addBtn);
  const foot=el(`<div class="flex" style="justify-content:space-between;gap:10px;margin-top:16px"></div>`);
  const clr=el(`<button class="btn">Remove split</button>`); clr.onclick=()=>{ delete t.categorySplits; t.category=(allocs.find(a=>a.category)||{}).category||t.category; markDirty(); bg.remove(); render(); };
  const right=el(`<div class="flex" style="gap:10px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`); cancel.onclick=()=>bg.remove();
  const save=el(`<button class="btn pri">Save</button>`); save.onclick=()=>{
    const clean=allocs.filter(a=>a.category && (+a.amount)>0).map(a=>({category:a.category,amount:Math.round((+a.amount)*100)/100}));
    if(clean.length<=1){ t.category=clean[0]?clean[0].category:t.category; delete t.categorySplits; }
    else { t.categorySplits=clean; }
    t.flagged=false; markDirty(); bg.remove(); render();
  };
  right.appendChild(cancel); right.appendChild(save);
  foot.appendChild(clr); foot.appendChild(right); md.appendChild(foot);
  refresh();
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
}
function sourceSplitModal(t){
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Split across sources</h3></div></div>`);
  const md=bg.querySelector(".modal");
  md.appendChild(el(`<div class="muted" style="font-size:13px;margin-bottom:12px">${escHTML(t.name||"")} · <b>${money(t.amount)}</b> · ${fmtDate(t.date)}</div>`));
  let allocs = (t.sourceSplits && t.sourceSplits.length) ? t.sourceSplits.map(s=>({source:s.source,amount:+s.amount||0}))
             : (t.source ? [{source:t.source,amount:t.amount}] : [{source:"",amount:t.amount}]);
  const list=el(`<div></div>`); md.appendChild(list);
  const rem=el(`<div style="font-size:13px;margin:8px 0"></div>`); md.appendChild(rem);
  function updateRem(){ const sum=allocs.reduce((s,a)=>s+(+a.amount||0),0); const r=Math.round((t.amount-sum)*100)/100;
    rem.innerHTML = Math.abs(r)<0.005 ? `<span style="color:var(--good)">✓ fully allocated</span>` : `Left to allocate: <b style="color:var(--warn)">${money(r)}</b>`; }
  function refresh(){
    list.innerHTML="";
    allocs.forEach((a,i)=>{
      const row=el(`<div class="flex" style="gap:8px;margin-bottom:8px"></div>`);
      const sel=sourceSelect(a.source); sel.style.flex="1"; sel.onchange=()=>{a.source=sel.value;};
      const amt=el(`<input type="number" step="0.01" style="width:120px;text-align:right">`); amt.value=a.amount; amt.oninput=()=>{a.amount=parseFloat(amt.value)||0;updateRem();};
      const del=el(`<button class="btn sm danger">✕</button>`); del.onclick=()=>{allocs.splice(i,1);refresh();};
      row.appendChild(sel); row.appendChild(amt); row.appendChild(del); list.appendChild(row);
    });
    updateRem();
  }
  const addBtn=el(`<button class="btn sm">+ Add source</button>`); addBtn.onclick=()=>{allocs.push({source:"",amount:Math.max(0,Math.round((t.amount-allocs.reduce((s,a)=>s+(+a.amount||0),0))*100)/100)});refresh();}; md.appendChild(addBtn);
  const foot=el(`<div class="flex" style="justify-content:space-between;gap:10px;margin-top:16px"></div>`);
  const clr=el(`<button class="btn">Remove split</button>`); clr.onclick=()=>{ delete t.sourceSplits; t.source=(allocs.find(a=>a.source)||{}).source||t.source; markDirty(); bg.remove(); render(); };
  const right=el(`<div class="flex" style="gap:10px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`); cancel.onclick=()=>bg.remove();
  const save=el(`<button class="btn pri">Save</button>`); save.onclick=()=>{
    const clean=allocs.filter(a=>a.source && (+a.amount)>0).map(a=>({source:a.source,amount:Math.round((+a.amount)*100)/100}));
    if(clean.length<=1){ t.source=clean[0]?clean[0].source:t.source; delete t.sourceSplits; }
    else { t.sourceSplits=clean; }
    markDirty(); bg.remove(); render();
  };
  right.appendChild(cancel); right.appendChild(save);
  foot.appendChild(clr); foot.appendChild(right); md.appendChild(foot);
  refresh();
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
}
function daysInMonth(y,m){ return new Date(y,m,0).getDate(); }   // m is 1-12
// Count a row in a different pay period, e.g. a shop the day before payday
// that's really for the new period. The bank date doesn't change.
function countInSheet(t){
  const cy=Model.cycleOf(DATA), own=Periods.periodFor(cy, t.date), first=Periods.periodFor(cy, Model.startOf(DATA));
  const cur=Periods.periodByKey(cy, Model.rowPeriodKey(DATA, t)) || own;
  const s=openSheet("Count in a different pay period");
  const info=el(`<p style="font-size:13px;margin:0 0 10px"></p>`);
  info.textContent=(t.name||"(no description)")+" · "+money(t.amount)+" · "+Periods.fmtY(t.date);
  s.body.appendChild(info);
  const sel=el(`<select></select>`), list=[];
  for(let n=Math.max(first.index, own.index-3); n<=own.index+3; n++) list.push(Periods.periodAt(cy,n));
  if(!list.some(p=>p.key===cur.key)){ list.push(cur); list.sort((a,b)=>a.index-b.index); }
  list.forEach(p=>{ const o=document.createElement("option"); o.value=p.key; o.textContent=Periods.label(p)+(p.key===own.key?" (its own)":""); sel.appendChild(o); });
  sel.value=cur.key;
  const fl=el(`<div class="fields"></div>`); fl.appendChild(wizField("Counts in pay period", sel)); s.body.appendChild(fl);
  s.body.appendChild(el(`<p class="hint">The bank date stays ${Periods.fmt(t.date)} in the Ledger and on the Week, Month and Year views; only the pay period it counts in changes.</p>`));
  const row=el(`<div class="flex wrap" style="margin-top:12px"></div>`);
  const ok=el(`<button class="btn pri">Save</button>`);
  ok.onclick=()=>{ if(sel.value===own.key) delete t.countIn; else t.countIn=sel.value; markDirty(); s.close(); render(); };
  row.appendChild(ok);
  if(cur.key!==own.key){ const back=el(`<button class="btn">Back to its own period</button>`); back.onclick=()=>{ delete t.countIn; markDirty(); s.close(); render(); }; row.appendChild(back); }
  s.body.appendChild(row);
}
// Add a row by hand once restarted: date, amount, what it is and the account.
function newRowSheet(dir){
  const s=openSheet(dir==="out"?"Add money out":"Add money in");
  const dflt=()=>dir==="out" ? {type:"Spend",category:"Groceries",other:null} : {type:"Income",category:"Salary",other:null};
  const cats={spend:Model.spendCats(DATA), income:Model.incomeCats(DATA)};
  const date=el(`<input type="date">`); date.value=Periods.localISO();
  const amt=el(`<input type="number" step="0.01" min="0" inputmode="decimal" placeholder="0.00">`);
  const name=el(`<input type="text">`);
  const acc=el(`<select><option value="Debit">Flex (current account)</option><option value="Credit">Credit card</option></select>`);
  const holder=el(`<div></div>`);
  let kind=dflt();
  const build=()=>{
    const own=acc.value==="Credit"?"Card":"Flex";
    if(kind.type==="Transfer" && kind.other===own) kind=dflt();
    const sel=kindSelect(dir, kind, own, cats);
    sel.onchange=()=>{ kind=parseKind(sel.value); };
    holder.replaceChildren(sel);
  };
  acc.onchange=build; build();
  const fl=el(`<div class="fields"></div>`);
  fl.append(wizField("Date", date), wizField("Amount (£)", amt), wizField("Description", name), wizField("Account", acc), wizField("What it is", holder));
  s.body.appendChild(fl);
  const ok=el(`<button class="btn pri" style="margin-top:12px">Add</button>`);
  ok.onclick=()=>{
    const a=Math.round(parseFloat(amt.value)*100)/100;
    if(!(a>0)){ toast("Enter an amount"); return; }
    if(!date.value || date.value<DATA.meta.startDate){ toast("Pick a date from "+Periods.fmtY(DATA.meta.startDate)+" on"); return; }
    const row={id:(dir==="out"?"t":"i")+Date.now(), date:date.value, amount:a, name:name.value.trim(), card:acc.value, flagged:false, confirmed:true};
    Model.setKind(row, dir, kind);
    (dir==="out"?DATA.transactions:DATA.income).push(row);
    markDirty(); s.close(); render();
  };
  s.body.appendChild(ok);
}
function moveMonthModal(t){
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Reassign to a different month</h3></div></div>`);
  const md=bg.querySelector(".modal");
  const cur=parseD(t.date);
  md.appendChild(el(`<div class="muted" style="font-size:13px;margin-bottom:12px">${escHTML(t.name||"")} · ${money(t.amount)} · currently <b>${monthLabel(monthKey(t.date))}</b> (${fmtDate(t.date)})</div>`));
  const f1=el(`<div class="field"><label>Move to month</label></div>`);
  const msel=el(`<select></select>`);
  // offer a broad range: 12 months either side of the current one, so you can move into months with no data yet
  const base=new Date(cur.getFullYear(),cur.getMonth(),1);
  for(let off=-12; off<=12; off++){
    const dt=new Date(base.getFullYear(), base.getMonth()+off, 1);
    const mk=dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0");
    const o=document.createElement("option"); o.value=mk; o.textContent=monthLabel(mk); o.selected=mk===monthKey(t.date);
    msel.appendChild(o);
  }
  f1.appendChild(msel); md.appendChild(f1);
  const f2=el(`<div class="field"><label>Day of month</label><input type="number" min="1" max="31" style="width:100px"></div>`);
  const dayIn=f2.querySelector("input"); dayIn.value=cur.getDate(); md.appendChild(f2);
  const note=el(`<div class="muted" style="font-size:12px;margin:-6px 0 10px">Only the date changes — category, account and everything else stay as they are.</div>`);
  md.appendChild(note);
  const foot=el(`<div class="flex" style="justify-content:flex-end;gap:10px;margin-top:6px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`); cancel.onclick=()=>bg.remove();
  const ok=el(`<button class="btn pri">Move</button>`); ok.onclick=()=>{
    const [y,m]=msel.value.split("-").map(Number);
    const maxDay=daysInMonth(y,m);
    const day=Math.min(Math.max(1,parseInt(dayIn.value)||1), maxDay);
    t.date = y+"-"+String(m).padStart(2,"0")+"-"+String(day).padStart(2,"0");
    markDirty(); bg.remove(); render();
  };
  foot.appendChild(cancel); foot.appendChild(ok); md.appendChild(foot);
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
}

boot();
