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
  "Other":"var(--c-Other)","Savings":"var(--c-Savings)"
};
const catColor = c => CAT_COLOR[c] || "var(--c-Other)";

let DATA = null;                 // the whole document
let dirty = false;
let view = "dashboard";
// dashboard/transactions period state
let period = {grain:"month", month:null, week:null};
let txFilter = {cat:"All", card:"All", q:"", status:"All"};
let incFilter = {source:"All", q:"", status:"All"};
let ledgerFilter = {account:"All", cat:"All", status:"All", q:"", sort:"new"};
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
function monthBudgetKeys(){ return Object.keys(DATA.monthlyBudgets).sort(); }
function nearestPriorBudgetMonth(mk){ const ks=monthBudgetKeys().filter(k=>k<mk); return ks.length?ks[ks.length-1]:null; }
function ensureMonthBudget(mk, copyFromMk){
  if(DATA.monthlyBudgets[mk]) return DATA.monthlyBudgets[mk];
  const seed = copyFromMk && DATA.monthlyBudgets[copyFromMk];
  const categories={}; DATA.categories.forEach(c=>categories[c]=seed?(seed.categories[c]??0):0);
  const bills={}; DATA.bills.forEach(b=>bills[b.name]=seed?(seed.bills[b.name]??0):0);
  DATA.monthlyBudgets[mk]={categories,bills};
  markDirty();
  return DATA.monthlyBudgets[mk];
}
// month choices for the Budget tab: months with real data, months that already have a
// budget, plus the next 6 calendar months so you can plan ahead.
function budgetMonthOptions(){
  const s=new Set([...availableMonths(), ...monthBudgetKeys()]);
  const last=[...s].sort().slice(-1)[0] || todayISO().slice(0,7);
  let [y,mo]=last.split("-").map(Number);
  for(let i=1;i<=6;i++){ mo++; if(mo>12){mo=1;y++;} s.add(y+"-"+String(mo).padStart(2,"0")); }
  return [...s].sort();
}
function txInPeriod(t){
  if(period.grain==="all") return true;
  if(period.grain==="year") return t.date.slice(0,4)===String(period.year||2026);
  if(period.grain==="month") return monthKey(t.date)===period.month;
  if(period.grain==="week") return weekKey(t.date)===period.week;
  return true;
}
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
  if(period.grain==="all") return "All time";
  if(period.grain==="year") return String(period.year||2026);
  if(period.grain==="month") return monthLabel(period.month);
  if(period.grain==="week") return weekRangeLabel(period.week);
}
function availableMonths(){
  const s=new Set(DATA.transactions.map(t=>monthKey(t.date)).concat(DATA.income.map(t=>monthKey(t.date))));
  return [...s].sort();
}
function availableWeeks(){
  const s=new Set(DATA.transactions.map(t=>weekKey(t.date)));
  return [...s].sort();
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
  if(!DATA) return;
  Store.save(DATA);
  refreshSaveIndicator();
}
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
Store.on("status",()=>{ if(!Store.hasPendingWrite) dirty=false; refreshSaveIndicator(); });

/* ---------- load ---------- */
function migrate(d){
  d.categories = d.categories||[];
  d.rules = dedupeRules(d.rules||[]);
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
function dedupeRules(rules){
  const seen=new Set(); const out=[];
  for(const r of rules){ const k=(r.match||"").toLowerCase(); if(!k||seen.has(k))continue; seen.add(k); out.push({match:k,category:r.category}); }
  out.sort((a,b)=>b.match.length-a.match.length);
  return out;
}
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
  const months=availableMonths();
  period.month = months.includes("2026-"+String(new Date().getMonth()+1).padStart(2,"0"))
      ? "2026-"+String(new Date().getMonth()+1).padStart(2,"0")
      : months[months.length-1];
  period.week = availableWeeks().slice(-1)[0];
  period.year = 2026;
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
  document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  const m=document.getElementById("main");
  if(!DATA){ renderFirstRun(); return; }
  updateBadges();
  ({dashboard:renderDashboard,ledger:renderLedger,transactions:renderLedger,income:renderLedger,budget:renderBudget,
    budgets:renderBudget,bills:renderBudget,import:renderImport,rules:renderRules,accounts:renderAccounts,data:renderData}[view]||renderDashboard)(m);
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
  [["week","Week"],["month","Month"],["year","Year"],["all","All"]].forEach(([g,lab])=>{
    const b=document.createElement("button"); b.textContent=lab; b.className=period.grain===g?"on":"";
    b.onclick=()=>{period.grain=g; onchange();}; seg.appendChild(b);
  });
  wrap.appendChild(seg);
  if(period.grain==="month"){
    const s=document.createElement("select");
    availableMonths().forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=monthLabel(k);o.selected=k===period.month;s.appendChild(o)});
    s.onchange=()=>{period.month=s.value;onchange()}; wrap.appendChild(s);
  } else if(period.grain==="week"){
    const s=document.createElement("select");
    availableWeeks().forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=k.replace("-W"," · wk ")+"  ("+weekRangeLabel(k)+")";o.selected=k===period.week;s.appendChild(o)});
    s.onchange=()=>{period.week=s.value;onchange()}; wrap.appendChild(s);
  }
  return wrap;
}

/* ---------- DASHBOARD ---------- */
function renderDashboard(m){
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
function periodBounds(){
  const today=new Date(); today.setHours(0,0,0,0);
  if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); return {start:new Date(y,mo-1,1), end:new Date(y,mo,0)}; }
  if(period.grain==="week") return weekBounds(period.week);
  if(period.grain==="year"){ const y=+(period.year||2026); return {start:new Date(y,0,1), end:new Date(y,11,31)}; }
  const ds=[...DATA.transactions,...DATA.income].map(t=>t.date).sort();
  const start=ds.length?parseD(ds[0]):today; let end=ds.length?parseD(ds[ds.length-1]):today;
  if(end>today) end=today;
  return {start,end};
}
// budget for a category over the SELECTED RANGE: each month's own budget, pro-rated by
// how many of that month's days fall inside the range. A week gets ~7/31 of the month's
// budget instead of the whole month; a year includes every budgeted month (even ones
// with no data yet); month view is the full month, unchanged.
function budgetForRange(cat){
  const {start,end}=periodBounds();
  let sum=0;
  const cur=new Date(start.getFullYear(), start.getMonth(), 1);
  while(cur<=end){
    const mk=cur.getFullYear()+"-"+String(cur.getMonth()+1).padStart(2,"0");
    const dim=new Date(cur.getFullYear(), cur.getMonth()+1, 0).getDate();
    const mStart=new Date(cur), mEnd=new Date(cur.getFullYear(), cur.getMonth(), dim);
    const oStart=start>mStart?start:mStart, oEnd=end<mEnd?end:mEnd;
    const overlap=Math.max(0, Math.round((oEnd-oStart)/86400000)+1);
    sum += budgetFor(mk,cat) * overlap/dim;
    cur.setMonth(cur.getMonth()+1);
  }
  return sum;
}
function kpi(lab,val,sub,cls="",prefix=""){
  return el(`<div class="card kpi"><div class="lab">${lab}</div><div class="val ${cls}">${prefix}${val}</div><div class="sub">${sub||""}</div></div>`);
}
function paceCard(tx,budget,spend){
  const c=el(`<div class="card pad"><h3 class="sec">Pace</h3></div>`);
  const DAY=86400000;
  const today=new Date(); today.setHours(0,0,0,0);
  // real calendar bounds of whatever period is selected - every grain must be handled
  // here, or the card silently reports numbers for a period that isn't the one shown.
  let start,end;
  if(period.grain==="month"){
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
  if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); start=new Date(y,mo-1,1); end=new Date(y,mo,0); }
  else if(period.grain==="week"){ const [y,w]=period.week.split("-W").map(Number);
    const simple=new Date(Date.UTC(y,0,1+(w-1)*7)); const mon=new Date(simple); mon.setUTCDate(simple.getUTCDate()-((simple.getUTCDay()+6)%7));
    start=new Date(mon.getUTCFullYear(),mon.getUTCMonth(),mon.getUTCDate()); end=new Date(start); end.setDate(start.getDate()+6); }
  else if(period.grain==="year"){ start=new Date(period.year,0,1); end=new Date(period.year,11,31); }
  else { start=parseD(rows[0].ref.date); end=parseD(rows[rows.length-1].ref.date); }
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
  if(period.grain==="month"){ const [y,mo]=period.month.split("-").map(Number); start=new Date(y,mo-1,1); end=new Date(y,mo,0); }
  else if(period.grain==="week"){ ({start,end}=weekBounds(period.week)); }
  else if(period.grain==="year"){ start=new Date(period.year,0,1); end=new Date(period.year,11,31); }
  else { start=parseD(rows[0].ref.date); end=today; }
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
function lineChart(pts,budget,days){
  const W=820,H=180,pad=30; const max=Math.max(budget,...pts,1);
  const x=i=>pad+(i/(days-1))*(W-pad*2), y=v=>H-pad-(v/max)*(H-pad*2);
  const path=pts.map((v,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)).join(" ");
  const area=path+` L ${x(pts.length-1)} ${H-pad} L ${x(0)} ${H-pad} Z`;
  const by=y(budget);
  return el(`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" stroke="var(--line)"/>
    <line x1="${pad}" y1="${by}" x2="${W-pad}" y2="${by}" stroke="var(--muted)" stroke-dasharray="5 4"/>
    <path d="${area}" fill="var(--brand)" opacity=".10"/>
    <path d="${path}" fill="none" stroke="var(--brand)" stroke-width="2.5"/>
    <text x="${pad}" y="${H-8}" fill="var(--muted)" font-size="11">day 1</text>
    <text x="${W-pad}" y="${H-8}" fill="var(--muted)" font-size="11" text-anchor="end">day ${days}</text>
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

/* ---------- BUDGET (Monthly | Yearly bills | Reconcile) ---------- */
let budgetMonth=null;
let budgetSubtab="monthly";
let showZeroBills=false;
let reconcileHideZeroMonthly=true;
let reconcileHideZeroYearly=true;
function renderBudget(m){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Budget</h1><span class="sub">every month independent · bills reconciled against it · yearly bills separate</span></div>`));
  const seg=el(`<div class="seg" style="margin-bottom:16px"></div>`);
  [["monthly","Monthly"],["yearly","Yearly bills"],["bills","Reconcile"]].forEach(([k,lab])=>{
    const b=el(`<button>${lab}</button>`); b.className=budgetSubtab===k?"on":""; b.onclick=()=>{budgetSubtab=k;render();}; seg.appendChild(b);
  });
  m.appendChild(seg);
  if(budgetSubtab==="yearly") renderBudgetYearly(m);
  else if(budgetSubtab==="bills") renderBudgetReconcile(m);
  else renderBudgetMonthly(m);
}
function renderBudgetMonthly(m){
  if(!budgetMonth) budgetMonth = availableMonths().slice(-1)[0] || budgetMonthOptions()[0];
  const bar=el(`<div class="card pad flex wrap" style="margin-bottom:14px;gap:12px;align-items:center"></div>`);
  bar.appendChild(el(`<span class="muted">Month:</span>`));
  const sel=el(`<select></select>`);
  budgetMonthOptions().forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=monthLabel(k);o.selected=k===budgetMonth;sel.appendChild(o);});
  sel.onchange=()=>{budgetMonth=sel.value;render();}; bar.appendChild(sel);
  const rec=DATA.monthlyBudgets[budgetMonth];
  if(rec){
    const rst=el(`<button class="btn sm danger">Clear this month's budget</button>`);
    rst.onclick=()=>{ if(confirm("Clear "+monthLabel(budgetMonth)+"'s budget? Only this month is affected — every other month keeps its own numbers.")){ delete DATA.monthlyBudgets[budgetMonth]; markDirty(); render(); } };
    bar.appendChild(rst);
  }
  m.appendChild(bar);

  if(!rec){
    const prior=nearestPriorBudgetMonth(budgetMonth);
    const c=el(`<div class="card pad"><h3 class="sec">No budget set for ${monthLabel(budgetMonth)} yet</h3>
      <p class="muted" style="font-size:13px;margin:6px 0 14px">Every month's budget is completely independent — nothing here affects any other month. Start fresh, or copy an existing month's numbers as a starting point (you can still change them).</p></div>`);
    const btns=el(`<div class="flex wrap" style="gap:10px"></div>`);
    if(prior){ const cp=el(`<button class="btn pri">Copy from ${monthLabel(prior)}</button>`); cp.onclick=()=>{ensureMonthBudget(budgetMonth,prior);render();}; btns.appendChild(cp); }
    const zero=el(`<button class="btn">Start from zero</button>`); zero.onclick=()=>{ensureMonthBudget(budgetMonth,null);render();}; btns.appendChild(zero);
    c.appendChild(btns); m.appendChild(c);
    return;
  }

  // ---- category budgets: independent numbers for THIS month only ----
  const c=el(`<div class="card pad"><h3 class="sec">Category budgets · ${monthLabel(budgetMonth)}</h3></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Category</th><th class="num">Budget</th><th class="num">This month actual</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  let total=0, totalActual=0;
  DATA.categories.forEach(cat=>{
    const val=categoryBudget(budgetMonth,cat); total+=val;
    const cur=actualForMonth(budgetMonth,cat); totalActual+=cur;
    const tr=el(`<tr><td><span class="tag" style="background:${catColor(cat)}">${cat}</span></td></tr>`);
    const td=el(`<td class="num"></td>`);
    if(cat==="Bills"){
      td.innerHTML=`<span class="muted" title="Always the total of this month's monthly bills budget, below">${money(val)}</span>`;
    } else {
      const inp=el(`<input type="number" step="5" value="${val}" style="width:110px;text-align:right">`);
      inp.onchange=()=>{ rec.categories[cat]=parseFloat(inp.value)||0; markDirty(); render(); };
      td.appendChild(inp);
    }
    tr.appendChild(td);
    tr.appendChild(el(`<td class="num">${money(cur)}</td>`));
    tb.appendChild(tr);
  });
  tb.appendChild(el(`<tr style="font-weight:700"><td>Total</td><td class="num">${money(total)}</td><td class="num">${money(totalActual)}</td></tr>`));
  c.appendChild(w);
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:10px">Bills' budget is set automatically from the monthly bills budget below.</div>`));
  m.appendChild(c);

  // ---- monthly bills budget: a separate, independent table for THIS month ----
  const c2=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Monthly bills budget · ${monthLabel(budgetMonth)}</h3></div>`);
  const w2=el(`<div class="tablewrap"><table><thead><tr><th>Bill</th><th class="num">Budget</th><th class="num">Paid this month</th></tr></thead><tbody></tbody></table></div>`);
  const tb2=w2.querySelector("tbody");
  let total2=0;
  const monthBillTx=billPayments().filter(t=>monthKey(t.date)===budgetMonth && hasMonthlyPart(t));
  const monthBillInc=billIncome().filter(t=>monthKey(t.date)===budgetMonth && hasMonthlyPart(t));
  const zeroBills=[];
  DATA.bills.forEach(b=>{
    const val=rec.bills[b.name]??0; total2+=val;
    if(val===0 && !showZeroBills){ zeroBills.push(b); return; }
    const net=billPaidFor(b.name,monthBillTx)-billPaidFor(b.name,monthBillInc);
    const tr=el(`<tr></tr>`);
    tr.appendChild(el(`<td>${escHTML(b.name)}</td>`));
    const td=el(`<td class="num"></td>`); const inp=el(`<input type="number" step="1" value="${val}" style="width:110px;text-align:right">`);
    inp.onchange=()=>{ rec.bills[b.name]=parseFloat(inp.value)||0; markDirty(); render(); };
    td.appendChild(inp); tr.appendChild(td);
    tr.appendChild(el(`<td class="num muted">${money(net)}</td>`));
    tb2.appendChild(tr);
  });
  tb2.appendChild(el(`<tr style="font-weight:700"><td>Total</td><td class="num">${money(total2)}</td><td></td></tr>`));
  c2.appendChild(w2);
  if(!DATA.bills.length) c2.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:10px">No monthly bill types yet — add one below.</div>`));
  if(zeroBills.length){
    const link=el(`<button class="btn sm" style="margin-top:10px">Show ${zeroBills.length} bill${zeroBills.length>1?'s':''} with no budget set (${zeroBills.map(b=>b.name).join(", ")})</button>`);
    link.onclick=()=>{ showZeroBills=true; render(); };
    c2.appendChild(link);
  } else if(showZeroBills){
    const link=el(`<button class="btn sm" style="margin-top:10px">Hide bills with no budget set</button>`);
    link.onclick=()=>{ showZeroBills=false; render(); };
    c2.appendChild(link);
  }
  c2.appendChild(el(`<div class="muted" style="font-size:12px;margin-top:10px">Reconciled in detail (payments assigned to each bill, refunds netted) on the <b>Reconcile</b> tab.</div>`));
  m.appendChild(c2);

  m.appendChild(monthlyBillTypesEditor());

  // ---- copy this month's numbers elsewhere ----
  const others=budgetMonthOptions().filter(k=>k!==budgetMonth);
  if(others.length){
    const c3=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Copy ${monthLabel(budgetMonth)}'s numbers to another month</h3></div>`);
    const row=el(`<div class="flex wrap" style="gap:10px"></div>`);
    const tsel=el(`<select></select>`);
    others.forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=monthLabel(k);tsel.appendChild(o);});
    const cpBtn=el(`<button class="btn">Copy</button>`);
    cpBtn.onclick=()=>{ const target=tsel.value; DATA.monthlyBudgets[target]={categories:{...rec.categories},bills:{...rec.bills}}; markDirty(); alert("Copied to "+monthLabel(target)+"."); };
    row.appendChild(tsel); row.appendChild(cpBtn); c3.appendChild(row); m.appendChild(c3);
  }
}
function monthlyBillTypesEditor(){
  const c=el(`<div class="card pad" style="margin-top:14px"><h3 class="sec">Monthly bill types</h3><div class="muted" style="font-size:12px;margin-bottom:8px">The list is shared across months — renaming or removing one here applies everywhere. Each month's <b>amount</b> stays independent (set above).</div></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Bill</th><th>Notes</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  DATA.bills.forEach((b,i)=>{
    const tr=el(`<tr></tr>`);
    const nameTd=el(`<td></td>`); const nameIn=el(`<input type="text" class="inline-in">`); nameIn.value=b.name;
    nameIn.onchange=()=>{
      const newName=nameIn.value.trim(); if(!newName || newName===b.name){ nameIn.value=b.name; return; }
      const oldName=b.name; b.name=newName;
      Object.values(DATA.monthlyBudgets).forEach(r=>{ if(r.bills[oldName]!=null){ r.bills[newName]=r.bills[oldName]; delete r.bills[oldName]; } });
      markDirty(); render();
    };
    nameTd.appendChild(nameIn); tr.appendChild(nameTd);
    tr.appendChild(inCell(b,"notes","text"));
    const td=el(`<td class="right"></td>`); const del=el(`<button class="btn sm danger">✕</button>`);
    del.onclick=()=>{ DATA.bills.splice(i,1); Object.values(DATA.monthlyBudgets).forEach(r=>{ delete r.bills[b.name]; }); markDirty(); render(); };
    td.appendChild(del); tr.appendChild(td);
    tb.appendChild(tr);
  });
  c.appendChild(w);
  const add=el(`<button class="btn sm" style="margin-top:10px">+ Add monthly bill type</button>`);
  add.onclick=()=>{ const nm="New bill"; DATA.bills.push({name:nm,notes:""}); Object.values(DATA.monthlyBudgets).forEach(r=>{ r.bills[nm]=r.bills[nm]??0; }); markDirty(); render(); };
  c.appendChild(add);
  return c;
}
function renderBudgetYearly(m){
  const c=el(`<div class="card pad"><h3 class="sec">Yearly bills budget</h3><div class="muted" style="font-size:12px;margin-bottom:10px">A separate, non-monthly budget — one figure per bill for the whole year, reconciled against the whole year's payments on the Reconcile tab.</div></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Bill</th><th class="num">Budget /yr</th><th>Notes</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  let total=0;
  DATA.yearlyBills.forEach((b,i)=>{
    total+=(+b.amount||0);
    const tr=el(`<tr></tr>`);
    tr.appendChild(inCell(b,"name","text"));
    tr.appendChild(inCell(b,"amount","number"));
    tr.appendChild(inCell(b,"notes","text"));
    const td=el(`<td class="right"></td>`); const del=el(`<button class="btn sm danger">✕</button>`);
    del.onclick=()=>{ DATA.yearlyBills.splice(i,1); markDirty(); render(); };
    td.appendChild(del); tr.appendChild(td);
    tb.appendChild(tr);
  });
  tb.appendChild(el(`<tr style="font-weight:700"><td>Yearly total</td><td class="num">${money(total)} <span class="muted" style="font-weight:400">(${money(total/12)}/mo)</span></td><td colspan="2"></td></tr>`));
  c.appendChild(w);
  const add=el(`<button class="btn sm" style="margin-top:10px">+ Add yearly bill</button>`);
  add.onclick=()=>{ DATA.yearlyBills.push({name:"New bill",amount:0,notes:""}); markDirty(); render(); };
  c.appendChild(add);
  m.appendChild(c);
}
// net of any income assigned to the same category that month (a reimbursement, refund...)
function actualForMonth(mk,cat){
  const spend=DATA.transactions.filter(t=>monthKey(t.date)===mk).reduce((s,t)=>s+catAmount(t,cat),0);
  const inc=DATA.income.filter(t=>monthKey(t.date)===mk).reduce((s,t)=>s+srcAmount(t,cat),0);
  return spend-inc;
}
/* ---------- BILLS tab ---------- */
function billNames(){ return [...DATA.bills, ...DATA.yearlyBills].map(b=>b.name).filter(Boolean); }
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
function billAssigned(t){ return billAllocations(t).reduce((s,a)=>s+(+a.amount||0),0); }
function billUnassigned(t){ return Math.round((t.amount - billAssigned(t))*100)/100; }
function billSelect(cur){
  const s=el(`<select class="sel-cat"></select>`);
  const o0=document.createElement("option"); o0.value=""; o0.textContent="— unassigned"; s.appendChild(o0);
  billNames().forEach(n=>{const o=document.createElement("option");o.value=n;o.textContent=n;o.selected=n===cur;s.appendChild(o);});
  if(cur && !billNames().includes(cur)){const o=document.createElement("option");o.value=cur;o.textContent=cur;o.selected=true;s.appendChild(o);}
  return s;
}
function billStatus(expected, actual){
  if(Math.abs(actual)<0.005) return {icon:"⬜", cls:"muted", label:"not seen"};
  const diff=Math.round(Math.abs(actual-expected)*100)/100;
  if(diff <= Math.max(2, expected*0.1)) return {icon:"✓", cls:"good", label:"matches"};
  return {icon:"⚠", cls:"warn", label:(actual>expected?"over by ":"under by ")+money(diff)};
}
let billMonth=null;
function billPayments(){ return DATA.transactions.filter(t=>catAmount(t,"Bills")>0.005); }
function billIncome(){ return DATA.income.filter(t=>srcAmount(t,"Bills")>0.005); }
function availBillMonths(){
  const s=new Set([...billPayments(),...billIncome()].map(t=>monthKey(t.date)));
  const arr=[...s].sort(); return arr.length?arr:availableMonths();
}
function billPaidFor(name, rows){ return rows.reduce((s,t)=> s + billAllocations(t).filter(a=>a.bill===name).reduce((x,a)=>x+(+a.amount||0),0), 0); }
function isYearlyBill(name){ return DATA.yearlyBills.some(b=>b.name===name); }
function isYearlyAssigned(t){ return billAllocations(t).some(a=>isYearlyBill(a.bill)); }
// A single payment can be split across BOTH a yearly bill and monthly ones (e.g. one
// transfer covering Water(yearly) + Council Tax + Broadband). Classify by what a row
// CONTAINS, not all-or-nothing, so each section still sees its own portions.
function hasYearlyPart(t){ return billAllocations(t).some(a=>a.bill && isYearlyBill(a.bill)); }
function hasMonthlyPart(t){
  const al=billAllocations(t);
  if(!al.length) return true;                       // unassigned - needs sorting in the monthly view
  return al.some(a=>a.bill && !isYearlyBill(a.bill)) || billUnassigned(t)>0.005;
}
// the portion of a row belonging to monthly bills / to yearly bills
function monthlyPartAmount(t){ return billAllocations(t).filter(a=>a.bill&&!isYearlyBill(a.bill)).reduce((s,a)=>s+(+a.amount||0),0) || (billAllocations(t).length?0:billBaseAmount(t)); }
function yearlyPartAmount(t){ return billAllocations(t).filter(a=>a.bill&&isYearlyBill(a.bill)).reduce((s,a)=>s+(+a.amount||0),0); }
// the split-or-dropdown cell, reused by both ledgers
function billAssignCell(t){
  const td=el(`<td></td>`);
  if(t.billSplits && t.billSplits.length){
    const parts=t.billSplits.filter(s=>s.bill).map(s=>`${escHTML(s.bill)} ${money(s.amount)}`).join(" · ");
    const u=billUnassigned(t);
    const box=el(`<span class="flex" style="gap:8px;flex-wrap:wrap"><span><b>Split:</b> ${parts}${u>0.005?` <span style="color:var(--warn)">· ${money(u)} unallocated</span>`:''}</span></span>`);
    const edit=el(`<button class="btn sm">edit split</button>`); edit.onclick=()=>splitModal(t); box.appendChild(edit); td.appendChild(box);
  } else {
    const wrap=el(`<span class="flex" style="gap:6px"></span>`);
    const sel=billSelect(billOf(t)); sel.onchange=()=>{ t.bill=sel.value; markDirty(); render(); }; wrap.appendChild(sel);
    const sp=el(`<button class="btn sm" title="split across bills">split</button>`); sp.onclick=()=>splitModal(t); wrap.appendChild(sp);
    td.appendChild(wrap);
  }
  return td;
}
function billReconcileCard(title, bills, txs, incs, expectedFn, hideZero, toggleHideZero){
  const c=el(`<div class="card pad" style="margin-bottom:14px"><h3 class="sec">${escHTML(title)}</h3></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Bill</th><th class="num">Expected</th><th class="num">Paid</th><th class="num">In</th><th class="num">Net</th><th>Status</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  let tE=0,tP=0,tI=0,tN=0; const hidden=[];
  bills.forEach(b=>{
    const expected=(expectedFn?expectedFn(b):b.amount), paid=billPaidFor(b.name,txs), inc=billPaidFor(b.name,incs), net=Math.round((paid-inc)*100)/100;
    tE+=expected;tP+=paid;tI+=inc;tN+=net;
    if(hideZero && expected===0 && paid===0 && inc===0){ hidden.push(b.name); return; }
    const st=billStatus(expected, net);
    const tr=el(`<tr></tr>`);
    tr.innerHTML=`<td>${escHTML(b.name)}</td><td class="num muted">${money(expected)}</td>
      <td class="num">${money(paid)}</td><td class="num" style="color:${inc?'var(--good)':'var(--muted)'}">${inc?money(inc):'–'}</td>
      <td class="num"><b>${money(net)}</b></td><td style="color:var(--${st.cls})">${st.icon} ${st.label}</td>`;
    tb.appendChild(tr);
  });
  // anything paid/received against a bill not in this frequency group, or unassigned
  let uT=0,uN=0; [...txs,...incs].forEach(t=>{ const u=billUnassigned(t); if(u>0.005){uT+=u;uN++;} });
  if(uN) tb.appendChild(el(`<tr style="color:var(--warn)"><td>⚠ Unassigned</td><td></td><td></td><td></td><td class="num">${money(uT)}</td><td>${uN} row${uN>1?'s':''} — assign below</td></tr>`));
  tb.appendChild(el(`<tr style="font-weight:700"><td>Total</td><td class="num">${money(tE)}</td><td class="num">${money(tP)}</td><td class="num">${money(tI)}</td><td class="num">${money(tN)}</td><td></td></tr>`));
  c.appendChild(w);
  if(toggleHideZero){
    if(hidden.length){
      const btn=el(`<button class="btn sm" style="margin-top:10px">Show ${hidden.length} bill${hidden.length>1?'s':''} with nothing this period (${hidden.join(", ")})</button>`);
      btn.onclick=toggleHideZero; c.appendChild(btn);
    } else if(!hideZero){
      const btn=el(`<button class="btn sm" style="margin-top:10px">Hide bills with nothing this period</button>`);
      btn.onclick=toggleHideZero; c.appendChild(btn);
    }
  }
  return c;
}
function billLedgerCard(title, rows, portionFn){
  const c=el(`<div class="card pad" style="margin-bottom:14px"><h3 class="sec">${escHTML(title)}</h3></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Out</th><th class="num">In</th><th>Bill type</th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  rows.slice().sort((a,b)=>b.t.date.localeCompare(a.t.date)).forEach(({t,isInc})=>{
    const tr=el(`<tr></tr>`); if(billUnassigned(t)>0.005) tr.className="needs";
    tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
    tr.appendChild(el(`<td>${escHTML(t.name||"")}</td>`));
    // when a payment straddles monthly+yearly bills, show only this section's share
    const full=billBaseAmount(t), part=portionFn?portionFn(t):full;
    const billAmt = (Math.abs(part-full)>0.005 && part>0) ? part : full;
    tr.appendChild(el(`<td class="num" style="color:var(--bad)">${isInc?'':money(billAmt)}</td>`));
    tr.appendChild(el(`<td class="num" style="color:var(--good)">${isInc?money(billAmt):''}</td>`));
    tr.appendChild(billAssignCell(t));
    tb.appendChild(tr);
  });
  if(!rows.length) tb.appendChild(el(`<tr><td colspan="5" class="empty">Nothing here yet.</td></tr>`));
  c.appendChild(w); return c;
}
function renderBudgetReconcile(m){
  if(!billMonth || !availBillMonths().includes(billMonth)) billMonth=availBillMonths().slice(-1)[0];
  const bar=el(`<div class="card pad flex wrap" style="margin-bottom:14px;gap:10px;align-items:center"></div>`);
  bar.appendChild(el(`<span class="muted">Reconcile month:</span>`));
  const msel=el(`<select></select>`);
  availBillMonths().forEach(k=>{const o=document.createElement("option");o.value=k;o.textContent=monthLabel(k);o.selected=k===billMonth;msel.appendChild(o);});
  msel.onchange=()=>{billMonth=msel.value;render();}; bar.appendChild(msel);
  const auto=el(`<button class="btn sm">Auto-assign by name</button>`);
  auto.onclick=()=>{ let n=0; [...billPayments(),...billIncome()].forEach(t=>{ if(!t.bill && !(t.billSplits&&t.billSplits.length)){ const g=guessBill(t.name); if(g){t.bill=g;n++;} } }); markDirty(); render(); };
  bar.appendChild(auto); m.appendChild(bar);

  // ---- monthly reconcile: Expected comes from THAT month's own independent bill budget ----
  const mTx = billPayments().filter(t=>monthKey(t.date)===billMonth && hasMonthlyPart(t));
  const mInc = billIncome().filter(t=>monthKey(t.date)===billMonth && hasMonthlyPart(t));
  m.appendChild(billReconcileCard("Monthly bills · "+monthLabel(billMonth), DATA.bills, mTx, mInc, b=>billBudget(billMonth,b.name),
    reconcileHideZeroMonthly, ()=>{ reconcileHideZeroMonthly=!reconcileHideZeroMonthly; render(); }));
  m.appendChild(billLedgerCard(monthLabel(billMonth)+" — assign each payment to a bill",
    [...mTx.map(t=>({t,isInc:false})),...mInc.map(t=>({t,isInc:true}))], monthlyPartAmount));

  // ---- yearly reconcile: Expected comes from the separate yearly bills budget ----
  if(DATA.yearlyBills.length){
    const year=billMonth.slice(0,4);
    const yTx = billPayments().filter(t=>t.date.slice(0,4)===year && hasYearlyPart(t));
    const yInc = billIncome().filter(t=>t.date.slice(0,4)===year && hasYearlyPart(t));
    m.appendChild(el(`<div style="height:6px"></div>`));
    m.appendChild(billReconcileCard("Yearly bills · "+year, DATA.yearlyBills, yTx, yInc, b=>b.amount,
      reconcileHideZeroYearly, ()=>{ reconcileHideZeroYearly=!reconcileHideZeroYearly; render(); }));
    m.appendChild(billLedgerCard("Yearly bill payments in "+year+" — assign a payment to a yearly bill",
      [...yTx.map(t=>({t,isInc:false})),...yInc.map(t=>({t,isInc:true}))], yearlyPartAmount));
  }
}
function splitModal(t){
  const bg=el(`<div class="modal-bg"><div class="modal"><h3 style="margin-top:0">Split payment across bills</h3></div></div>`);
  const md=bg.querySelector(".modal");
  md.appendChild(el(`<div class="muted" style="font-size:13px;margin-bottom:12px">${escHTML(t.name||"")} · <b>${money(t.amount)}</b> · ${fmtDate(t.date)}</div>`));
  let allocs = (t.billSplits && t.billSplits.length) ? t.billSplits.map(s=>({bill:s.bill,amount:+s.amount||0}))
             : (billOf(t) ? [{bill:billOf(t),amount:t.amount}] : [{bill:"",amount:t.amount}]);
  const list=el(`<div></div>`); md.appendChild(list);
  const rem=el(`<div style="font-size:13px;margin:8px 0"></div>`); md.appendChild(rem);
  function updateRem(){ const sum=allocs.reduce((s,a)=>s+(+a.amount||0),0); const r=Math.round((t.amount-sum)*100)/100;
    rem.innerHTML = Math.abs(r)<0.005 ? `<span style="color:var(--good)">✓ fully allocated</span>` : `Left to allocate: <b style="color:var(--warn)">${money(r)}</b>`; }
  function refresh(){
    list.innerHTML="";
    allocs.forEach((a,i)=>{
      const row=el(`<div class="flex" style="gap:8px;margin-bottom:8px"></div>`);
      const sel=billSelect(a.bill); sel.style.flex="1"; sel.onchange=()=>{a.bill=sel.value;};
      const amt=el(`<input type="number" step="0.01" style="width:120px;text-align:right">`); amt.value=a.amount; amt.oninput=()=>{a.amount=parseFloat(amt.value)||0;updateRem();};
      const del=el(`<button class="btn sm danger">✕</button>`); del.onclick=()=>{allocs.splice(i,1);refresh();};
      row.appendChild(sel); row.appendChild(amt); row.appendChild(del); list.appendChild(row);
    });
    updateRem();
  }
  const addBtn=el(`<button class="btn sm">+ Add bill</button>`); addBtn.onclick=()=>{allocs.push({bill:"",amount:Math.max(0,Math.round((t.amount-allocs.reduce((s,a)=>s+(+a.amount||0),0))*100)/100)});refresh();}; md.appendChild(addBtn);
  const foot=el(`<div class="flex" style="justify-content:space-between;gap:10px;margin-top:16px"></div>`);
  const clr=el(`<button class="btn">Remove split</button>`); clr.onclick=()=>{ delete t.billSplits; t.bill=(allocs.find(a=>a.bill)||{}).bill||""; markDirty(); bg.remove(); render(); };
  const right=el(`<div class="flex" style="gap:10px"></div>`);
  const cancel=el(`<button class="btn">Cancel</button>`); cancel.onclick=()=>bg.remove();
  const save=el(`<button class="btn pri">Save</button>`); save.onclick=()=>{
    const clean=allocs.filter(a=>a.bill && (+a.amount)>0).map(a=>({bill:a.bill,amount:Math.round((+a.amount)*100)/100}));
    if(clean.length<=1){ t.bill=clean[0]?clean[0].bill:""; delete t.billSplits; }
    else { t.billSplits=clean; t.bill=""; }
    markDirty(); bg.remove(); render();
  };
  right.appendChild(cancel); right.appendChild(save);
  foot.appendChild(clr); foot.appendChild(right); md.appendChild(foot);
  refresh();
  bg.onclick=e=>{if(e.target===bg)bg.remove();};
  document.body.appendChild(bg);
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

  const newTx=[],newInc=[]; let dupes=0,skipped=0,beforeCut=0;
  rows.forEach(r=>{
    if(cutoff && r.date<=cutoff){beforeCut++;return;}
    if(SKIP_RE.test(r.desc)||SKIP_TYPE_RE.test(r.type)){skipped++;return;}
    if(r.out>0){ if(takeMatch(txKeys,r.date,r.out)){dupes++;return;}
      const cat=categorise(r.desc);
      newTx.push({date:iso(r.date),amount:r.out,name:r.desc,category:cat||"Other",card,flagged:!cat,confirmed:false}); }
    else if(r.in>0){ if(takeMatch(incKeys,r.date,r.in)){dupes++;return;}
      const src=categorise(r.desc);
      newInc.push({date:iso(r.date),amount:r.in,name:r.desc,source:src||"Other",card,flagged:!src,confirmed:false}); }
  });
  importPreview={newTx,newInc,dupes,skipped,beforeCut,stated,total:rows.length};
  renderImportPreview();
}
function renderImportPreview(){
  const {newTx,newInc,dupes,skipped,beforeCut,stated,total}=importPreview;
  const out=document.getElementById("impOut"); out.innerHTML="";
  const stats=el(`<div class="grid kpis" style="margin:14px 0">
    ${kpiHTML("Statement rows",total)}${kpiHTML("New spend",newTx.length)}${kpiHTML("New income",newInc.length)}
    ${kpiHTML("Already in",dupes)}${kpiHTML("Transfers skipped",skipped)}${kpiHTML("Before cut-off",beforeCut)}</div>`);
  out.appendChild(stats);
  const unknown=[...newTx,...newInc].filter(t=>t.flagged).length;
  const c=el(`<div class="card pad"></div>`);
  c.appendChild(el(`<div class="flex wrap" style="justify-content:space-between;margin-bottom:2px;gap:8px">
     <h3 class="sec" style="margin:0">Preview — auto-categorised with your rules; set categories, then confirm</h3>
     <span class="flex" style="gap:6px">${unknown?`<span class="chip" style="color:var(--bad)">${unknown} need a category</span>`:`<span class="chip" style="color:var(--good)">all matched ✓</span>`}</span></div>`));
  c.appendChild(el(`<div class="muted" style="font-size:12px;margin-bottom:10px">Every row is matched against your rules automatically. Red rows had no rule — pick a category here and they're done. Anything you sort out on this screen goes straight into the Ledger confirmed; only rows still left red arrive as "to review".</div>`));
  if(newTx.length){
    const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">Out</th><th>Category</th></tr></thead><tbody></tbody></table></div>`);
    const tb=w.querySelector("tbody");
    newTx.forEach(t=>{const tr=el(`<tr></tr>`);if(t.flagged)tr.style.background="var(--bad-bg)";
      tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
      tr.appendChild(el(`<td>${escHTML(t.name)}</td>`));
      tr.appendChild(el(`<td class="num">${money(t.amount)}</td>`));
      const td=el(`<td></td>`);const s=catSelect(t.category);s.onchange=()=>{t.category=s.value;t.flagged=false;};td.appendChild(s);tr.appendChild(td);
      tb.appendChild(tr);});
    c.appendChild(w);
  } else c.appendChild(el(`<div class="muted">No new spending to add.</div>`));
  if(newInc.length){
    c.appendChild(el(`<h3 class="sec" style="margin-top:16px">New income (${newInc.length})</h3>`));
    const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th class="num">In</th><th>Source</th></tr></thead><tbody></tbody></table></div>`);
    const tb=w.querySelector("tbody");
    newInc.forEach(t=>{const tr=el(`<tr></tr>`); if(t.flagged)tr.style.background="var(--bad-bg)";
      tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
      tr.appendChild(el(`<td>${escHTML(t.name)}</td>`));
      tr.appendChild(el(`<td class="num" style="color:var(--good)">${money(t.amount)}</td>`));
      const td=el(`<td></td>`);const s=sourceSelect(t.source);s.onchange=()=>{t.source=s.value;t.flagged=false;};td.appendChild(s);tr.appendChild(td);
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
function renderRules(m){
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Rules</h1><span class="sub">${DATA.rules.length} rules · a merchant name containing the text gets the category</span></div>`));
  // add form
  const add=el(`<div class="card pad flex wrap" style="gap:10px;margin-bottom:14px">
     <input type="text" id="rMatch" placeholder="merchant contains… e.g. tesco" style="flex:1;min-width:160px">
     <select id="rCat"></select><button class="btn pri" id="rAdd">Add rule</button></div>`);
  const rc=add.querySelector("#rCat"); DATA.categories.forEach(c=>{const o=document.createElement("option");o.textContent=c;rc.appendChild(o);});
  add.querySelector("#rAdd").onclick=()=>{const v=add.querySelector("#rMatch").value.trim().toLowerCase();if(!v)return;
    DATA.rules.push({match:v,category:rc.value});DATA.rules=dedupeRules(DATA.rules);markDirty();renderRules(m);};
  m.appendChild(add);
  // counts
  const counts={}; DATA.rules.forEach(r=>counts[r.match]=0);
  DATA.transactions.forEach(t=>{const r=ruleFor(t.name);if(r)counts[r.match]=(counts[r.match]||0)+1;});
  const c=el(`<div class="card"></div>`);
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Merchant contains</th><th>Category</th><th class="num">Matches</th><th></th></tr></thead><tbody></tbody></table></div>`);
  const tb=w.querySelector("tbody");
  DATA.rules.forEach((r,i)=>{
    const tr=el(`<tr></tr>`);
    tr.appendChild(el(`<td><code>${escHTML(r.match)}</code></td>`));
    const td=el(`<td></td>`);const s=el(`<select class="sel-cat"></select>`);DATA.categories.forEach(c=>{const o=document.createElement("option");o.textContent=c;o.selected=c===r.category;s.appendChild(o);});
    s.onchange=()=>{r.category=s.value;markDirty();};td.appendChild(s);tr.appendChild(td);
    tr.appendChild(el(`<td class="num muted">${counts[r.match]||0}</td>`));
    const td2=el(`<td class="right"></td>`);const del=el(`<button class="btn sm danger">✕</button>`);del.onclick=()=>{DATA.rules.splice(i,1);markDirty();renderRules(m);};td2.appendChild(del);tr.appendChild(td2);
    tb.appendChild(tr);
  });
  c.appendChild(w); m.appendChild(c);
  // re-apply
  const re=el(`<button class="btn" style="margin-top:14px">Re-apply rules to un-reviewed transactions</button>`);
  re.onclick=()=>{let n=0;DATA.transactions.forEach(t=>{if(t.flagged||t.category==="Other"){const c=categorise(t.name);if(c&&c!==t.category){t.category=c;t.flagged=false;n++;}}});markDirty();alert(`Re-categorised ${n} transactions.`);renderRules(m);};
  m.appendChild(re);
}

/* ---------- ACCOUNTS ---------- */
function renderAccounts(m){
  recordWealthSnapshot();
  m.innerHTML="";
  m.appendChild(el(`<div class="head"><h1>Accounts</h1><span class="sub">balances & the weekly reconcile check</span></div>`));
  const a=DATA.accounts, cats=DATA.categories;
  // Amounts derived from the ledger (kept in sync automatically):
  const debitSpend   =DATA.transactions.filter(t=>(t.card||"Debit")==="Debit" && cats.includes(t.category)).reduce((s,t)=>s+t.amount,0);
  const creditPaid   =DATA.transactions.filter(t=>(t.card||"Debit")==="Debit" && !cats.includes(t.category)).reduce((s,t)=>s+t.amount,0); // "Credit"-tagged debit rows = card repayments
  const creditCharges=DATA.transactions.filter(t=>(t.card||"Debit")==="Credit").reduce((s,t)=>s+t.amount,0);
  const flexIncome   =DATA.income.filter(t=>(t.card||"Debit")!=="Credit").reduce((s,t)=>s+t.amount,0);
  const creditRefunds=DATA.income.filter(t=>(t.card||"Debit")==="Credit").reduce((s,t)=>s+t.amount,0);
  const flex   = a.openingFlex   - debitSpend + flexIncome - creditPaid;
  const credit = a.openingCredit - creditCharges + creditPaid + creditRefunds;

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
  c.appendChild(kvEdit("Opening balance (1 Jan)",a,"openingFlex"));
  c.appendChild(lineRO("− Debit spending",debitSpend));
  c.appendChild(lineRO("+ Income",flexIncome));
  c.appendChild(lineRO("− Credit-card repayments",creditPaid));
  c.appendChild(totalLine("Computed balance",flex));
  c.appendChild(reconcileRow(flex,"-2294.96"));
  m.appendChild(c);

  // ---- Member Credit Card ----
  const cc=el(`<div class="card pad" style="max-width:560px;margin-top:14px"><h3 class="sec">Member Credit Card</h3></div>`);
  cc.appendChild(kvEdit("Opening balance (1 Jan)",a,"openingCredit"));
  cc.appendChild(lineRO("− Card charges",creditCharges));
  cc.appendChild(lineRO("+ Repayments made",creditPaid));
  if(creditRefunds) cc.appendChild(lineRO("+ Refunds to card",creditRefunds));
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
  // one row per transaction/income, carrying a ref to the real object so edits persist.
  // Each row is classified by how it moves each account (Flex current a/c and the card):
  //  - debit spend  -> Flex out
  //  - card charge  -> Credit out (increases debt)
  //  - card repayment (a debit tx tagged "Credit") -> Flex out AND Credit in (pays it down)
  //  - income       -> Flex in (or Credit in if it's a refund tagged to the card)
  const rows=[];
  DATA.transactions.forEach(t=>rows.push({date:t.date,ref:t,kind:"tx",card:(t.card||"Debit")}));
  DATA.income.forEach(t=>rows.push({date:t.date,ref:t,kind:"inc",card:(t.card||"Debit")}));
  rows.sort((a,b)=>a.date.localeCompare(b.date)||(a.kind==="inc"?-1:1));   // income before spend same day
  rows.forEach(r=>{
    const t=r.ref, amt=t.amount;
    r.flexEffect=0; r.creditEffect=0; r.affectsFlex=false; r.affectsCredit=false;
    if(r.kind==="tx"){
      if(r.card==="Debit"){
        r.affectsFlex=true; r.flexEffect=-amt;
        if(!DATA.categories.includes(t.category)){ r.affectsCredit=true; r.creditEffect=+amt; } // "Credit" = card repayment
      } else { r.affectsCredit=true; r.creditEffect=-amt; }                                      // a card charge
    } else {
      if(r.card==="Credit"){ r.affectsCredit=true; r.creditEffect=+amt; }                        // refund to the card
      else { r.affectsFlex=true; r.flexEffect=+amt; }
    }
  });
  let fbal=(DATA.accounts&&DATA.accounts.openingFlex)||0;
  let cbal=(DATA.accounts&&DATA.accounts.openingCredit)||0;
  rows.forEach(r=>{ if(r.affectsFlex){ fbal+=r.flexEffect; r.flexBal=fbal; } if(r.affectsCredit){ cbal+=r.creditEffect; r.creditBal=cbal; } });
  return rows;
}
// what a row shows in the current account view: {out,in,bal}
function ledgerAmounts(r){
  const a=ledgerFilter.account;
  if(a==="Flex")   return {out:r.flexEffect<0?-r.flexEffect:0,   in:r.flexEffect>0?r.flexEffect:0,   bal:r.flexBal};
  if(a==="Credit") return {out:r.creditEffect<0?-r.creditEffect:0, in:r.creditEffect>0?r.creditEffect:0, bal:r.creditBal};
  return {out:r.kind==="tx"?r.ref.amount:0, in:r.kind==="inc"?r.ref.amount:0, bal:null};       // All: intrinsic, no balance
}
function ledgerFiltered(){
  let rows=ledgerAll().filter(r=>txInPeriod(r.ref));
  if(ledgerFilter.account==="Flex") rows=rows.filter(r=>r.affectsFlex);
  else if(ledgerFilter.account==="Credit") rows=rows.filter(r=>r.affectsCredit);
  if(ledgerFilter.cat!=="All"){
    rows=rows.filter(r=>{
      if(ledgerFilter.cat==="Credit") return r.kind==="tx" && !DATA.categories.includes(r.ref.category);
      if(r.kind==="tx") return catAllocations(r.ref).some(a=>a.category===ledgerFilter.cat);
      return srcAllocations(r.ref).some(a=>a.source===ledgerFilter.cat);   // income matched by source
    });
  }
  if(ledgerFilter.status==="Needs review") rows=rows.filter(r=>!r.ref.confirmed);
  else if(ledgerFilter.status==="Confirmed") rows=rows.filter(r=>r.ref.confirmed);
  if(ledgerFilter.q){const s=ledgerFilter.q.toLowerCase(); rows=rows.filter(r=>((r.ref.name||"")+" "+(r.ref.category||r.ref.source||"")).toLowerCase().includes(s));}
  return rows;
}
function renderLedger(m){
  m.innerHTML="";
  const head=el(`<div class="head"><h1>Ledger</h1><div class="spacer"></div></div>`);
  const unlockBtn=el(`<button class="btn">Unlock all</button>`);
  unlockBtn.onclick=()=>{ if(confirm("Send ALL transactions back to 'to review'?\n\nYour categories aren't changed — this just unlocks them so you can check each one.")){ DATA.transactions.forEach(t=>t.confirmed=false); markDirty(); ledgerFilter.status="Needs review"; render(); } };
  const addS=el(`<button class="btn">+ Spending</button>`); addS.onclick=()=>txModal();
  const addI=el(`<button class="btn pri">+ Income</button>`); addI.onclick=()=>incModal();
  head.appendChild(unlockBtn); head.appendChild(addS); head.appendChild(addI); m.appendChild(head);

  const bar=el(`<div class="card pad flex wrap" style="margin-bottom:14px;gap:10px"></div>`);
  bar.appendChild(periodControls(render));
  const accSel=el(`<select><option value="All">All accounts</option><option value="Flex">Flex (current a/c)</option><option value="Credit">Credit card</option></select>`);
  accSel.value=ledgerFilter.account; accSel.onchange=()=>{ledgerFilter.account=accSel.value;render()}; bar.appendChild(accSel);
  const typeSel=el(`<select></select>`);
  ["All",...DATA.categories,"Credit"].forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=c==="All"?"All categories":c;o.selected=c===ledgerFilter.cat;typeSel.appendChild(o);});
  typeSel.onchange=()=>{ledgerFilter.cat=typeSel.value;render()}; bar.appendChild(typeSel);
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
  const w=el(`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category / source</th><th>Account</th><th class="num">Out</th><th class="num">In</th>${showBal?`<th class="num">${balLabel}</th>`:''}<th></th></tr></thead><tbody></tbody></table></div>`);
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
  const t=r.ref, isTx=r.kind==="tx"; const a=ledgerAmounts(r);
  const tr=el(`<tr></tr>`); if(!t.confirmed) tr.className = t.flagged ? "needs-unknown" : "needs";
  tr.appendChild(el(`<td class="muted" style="white-space:nowrap">${fmtDate(t.date)}</td>`));
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
  const mv=el(`<button class="btn sm" title="reassign to a different month">📅</button>`);
  mv.onclick=()=>moveMonthModal(t);
  td6.appendChild(mv);
  const del=el(`<button class="btn sm danger" style="margin-left:6px">✕</button>`);
  del.onclick=()=>{ if(confirm("Delete this entry?")){ if(isTx) DATA.transactions=DATA.transactions.filter(x=>x!==t); else DATA.income=DATA.income.filter(x=>x!==t); markDirty(); render(); } };
  td6.appendChild(del); tr.appendChild(td6);
  return tr;
}
// the category/source cell: a plain dropdown + split button, or (once split) a summary
// of the split with an edit link. Shared by the Ledger's spend and income rows.
function ledgerAssignCell(t, isTx){
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
