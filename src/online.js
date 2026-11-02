// XDC Offline Signer: the online companion. Reads chain state, prepares signing
// requests, verifies signed transactions and broadcasts them. Never sees a key.
import * as C from "./core.js";
import { showQR, Scanner, scanImageFile } from "./qr.js";
import { $, esc, notice, errMsg, enableQrZoom, renderReview, kvRows, copyText } from "./ui.js";
enableQrZoom();

$("year").textContent = new Date().getFullYear();

/* ================= Config ================= */
const RPCS = {
  50: { def: "https://rpc.plugin.global/xdcmainnet", fallbacks: ["https://rpc.xinfin.network", "https://erpc.xinfin.network"], note: "Default: the free public Plugin RPC, with XinFin's public RPCs as fallbacks." },
  51: { def: "https://rpc.apothem.network", fallbacks: ["https://erpc.apothem.network"], note: "Default: the public Apothem RPC." },
};
const STORE = "xdc-offline-signer";
const BLOCK_SECONDS = 2;
let settings = {};
try { settings = JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { settings = {}; }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

const S = {
  chainId: Number(settings.chainId) || 50,
  addr: null, balance: null, nonce: null, gasPrice: null, block: null,
  action: null, token: null, cand: null, mine: null, withdrawals: null, params: {},
  prepared: null, // { req, built }
  checked: null,  // decoded signed tx ready to broadcast
};
const sym = () => C.NETS[S.chainId].symbol;
const X = (v) => `${C.formatUnits(v)} ${sym()}`;
const short = (a) => { const x = C.toXdc(a); return x.slice(0, 9) + "…" + x.slice(-6); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + BigInt(n).toString(16);

function dur(blocks) {
  const s = Number(blocks) * BLOCK_SECONDS;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1).replace(/\.0$/, "")} hours`;
  return `${(s / 86400).toFixed(1).replace(/\.0$/, "")} days`;
}

/* ================= RPC ================= */
let rpcId = 1;
const rpcUrl = () => (settings.rpc && settings.rpc[S.chainId]) || RPCS[S.chainId].def;
const rpcList = () => [rpcUrl(), ...RPCS[S.chainId].fallbacks.filter((u) => u !== rpcUrl())];

async function post(url, body) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
      err = new Error(r.status === 429 ? "the RPC is rate-limiting requests (HTTP 429)" : "RPC returned HTTP " + r.status);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { err = e; }
    await sleep(400 * 2 ** i);
  }
  throw err;
}

class RpcError extends Error {}
async function rpc(method, params = []) {
  let last;
  for (const url of rpcList()) {
    let j;
    try { j = await post(url, { jsonrpc: "2.0", id: rpcId++, method, params }); }
    catch (e) { last = e; continue; } // unreachable: try the next endpoint
    if (j.error) { const e = new RpcError(j.error.message || "RPC error"); e.data = j.error.data; throw e; }
    return j.result;
  }
  throw new Error(`couldn't reach the XDC network (${last && last.message}). Check your connection, or set another RPC under Network settings.`);
}
const call = (to, data, from) => rpc("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);
const vcall = (data, from) => call(C.VALIDATOR, data, from);

// Many eth_calls: JSON-RPC batches where the endpoint allows it, otherwise a few at a time.
async function callMany(items, onProgress) {
  const out = new Array(items.length);
  let done = 0, batchOK = true;
  for (let s = 0; s < items.length; s += 25) {
    const slice = items.slice(s, s + 25);
    if (batchOK) {
      try {
        const res = await post(rpcUrl(), slice.map((it, i) => ({ jsonrpc: "2.0", id: s + i + 1, method: "eth_call", params: [{ to: it.to, data: it.data }, "latest"] })));
        if (!Array.isArray(res)) throw new Error("no batch");
        const byId = new Map(res.map((r) => [r.id, r]));
        slice.forEach((_, i) => { const r = byId.get(s + i + 1); if (r && !r.error) out[s + i] = r.result; });
      } catch { batchOK = false; }
    }
    for (let i = 0; i < slice.length; i += 4) {
      await Promise.all(slice.slice(i, i + 4).map(async (it, k) => {
        const idx = s + i + k;
        if (out[idx] === undefined) out[idx] = await call(it.to, it.data).catch(() => null);
      }));
    }
    done += slice.length; onProgress && onProgress(done, items.length);
  }
  return out;
}

// Validator contract parameters (cached per chain)
const paramCache = {};
async function params() {
  if (paramCache[S.chainId]) return paramCache[S.chainId];
  const [mv, mc, vd, cd] = await Promise.all([C.VIEWS.minVoterCap, C.VIEWS.minCandidateCap, C.VIEWS.voterWithdrawDelay, C.VIEWS.candidateWithdrawDelay].map((s) => vcall(s)));
  return (paramCache[S.chainId] = { minVoterCap: C.decUint(mv), minCandidateCap: C.decUint(mc), voterDelay: C.decUint(vd), candDelay: C.decUint(cd) });
}

/* ================= Network settings ================= */
function renderNet() {
  $("net").value = String(S.chainId);
  $("rpcIn").value = rpcUrl();
  $("rpcHint").textContent = settings.rpc && settings.rpc[S.chainId] ? "Your own RPC, saved in this browser. Clear the field and press Use to go back to the default." : RPCS[S.chainId].note;
  document.querySelectorAll(".sym").forEach((e) => (e.textContent = sym()));
}
$("net").addEventListener("change", () => {
  S.chainId = Number($("net").value); settings.chainId = S.chainId; save();
  renderNet(); resetAccount();
  if (S.addr) loadAccount();
});
$("rpcBtn").addEventListener("click", async () => {
  const v = $("rpcIn").value.trim();
  settings.rpc = settings.rpc || {};
  if (!v) delete settings.rpc[S.chainId];
  else {
    if (!/^https:\/\//i.test(v) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(v)) return notice($("acctMsg"), "error", "Use an https:// RPC address.");
    settings.rpc[S.chainId] = v;
  }
  save(); renderNet();
  if (S.addr) loadAccount();
});

/* ================= Scanning ================= */
const lay = $("scanLay");
let scanCb = null;
const scanner = new Scanner($("video"), {
  onResult(text) {
    try { if (scanCb(text) === false) return false; closeScan(); return true; }
    catch (e) { $("camState").textContent = e.message || String(e); return false; }
  },
  onError(e) { closeScan(); alertMsg(errMsg(e)); },
  async onState(on) {
    if (!on) return;
    const cams = await scanner.cameras();
    const sel = $("camSel");
    if (cams.length > 1) {
      sel.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
      if (scanner.deviceId) sel.value = scanner.deviceId;
      sel.hidden = false;
    }
  },
});
let alertTarget = $("acctMsg");
const alertMsg = (html) => notice(alertTarget, "error", html);
function openScan(title, cb, target) {
  scanCb = cb; alertTarget = target || $("acctMsg");
  $("scanTitle").textContent = title; $("camState").textContent = "Looking for a QR code…";
  lay.hidden = false; document.body.style.overflow = "hidden";
  scanner.start($("camSel").value || undefined);
}
function closeScan() { scanner.stop(); lay.hidden = true; document.body.style.overflow = ""; }
$("scanCancel").addEventListener("click", closeScan);
$("camSel").addEventListener("change", (e) => scanner.start(e.target.value));
addEventListener("keydown", (e) => { if (e.key === "Escape" && !lay.hidden) closeScan(); });

function addrFromQR(text) {
  const m = /(xdc|0x)[0-9a-fA-F]{40}/i.exec(text);
  if (!m) throw new Error("that QR code doesn't contain an address");
  return C.toXdc(C.normAddr(m[0].toLowerCase()));
}
$("addrScan").addEventListener("click", () => openScan("Scan your wallet address", (t) => { $("addr").value = addrFromQR(t); loadAccount(); }));
document.querySelectorAll("[data-scan-into]").forEach((b) => b.addEventListener("click", () => {
  const id = b.dataset.scanInto;
  openScan("Scan the recipient address", (t) => { $(id).value = addrFromQR(t); }, $("prepMsg"));
}));

/* ================= 1. Account ================= */
function resetAccount() {
  S.balance = S.nonce = S.gasPrice = null; S.withdrawals = null; S.mine = null; S.token = null; S.cand = null;
  $("acct").hidden = true; $("g1").classList.remove("done");
  $("pickHint").hidden = false; $("pickHint").textContent = "Load your wallet first.";
  clearPrepared();
}

async function refreshAccount() {
  const [cid, bal, nonce, gp, bn, latest] = await Promise.all([
    rpc("eth_chainId"), rpc("eth_getBalance", [S.addr, "latest"]), rpc("eth_getTransactionCount", [S.addr, "pending"]),
    rpc("eth_gasPrice"), rpc("eth_blockNumber"), rpc("eth_getTransactionCount", [S.addr, "latest"]),
  ]);
  S.latestNonce = BigInt(latest);
  S.pool = await poolFor(S.addr);
  const pendingNonce = nextNonce(BigInt(nonce), S.latestNonce, S.pool);
  S.gapAfter = [...S.pool.keys()].filter((n) => n > pendingNonce).sort((a, b) => (a < b ? -1 : 1));
  if (Number(cid) !== S.chainId) throw new Error(`the RPC ${esc(rpcUrl())} is for chain ID ${Number(cid)}, not ${S.chainId}. Fix it under Network settings.`);
  S.balance = BigInt(bal); S.nonce = pendingNonce; S.gasPrice = BigInt(gp); S.block = BigInt(bn);
  $("sBal").textContent = X(S.balance);
  const waiting = S.nonce - S.latestNonce;
  $("sNonce").textContent = S.nonce.toString() + (waiting > 0n ? ` (${waiting} pending)` : "") + (S.gapAfter && S.gapAfter.length ? ` · ${S.gapAfter.length} waiting behind a gap` : "");
  $("sGas").textContent = `${C.formatUnits(S.gasPrice, 9)} gwei`;
  $("acct").hidden = false;
}

async function loadAccount() {
  let a;
  try { a = C.normAddr($("addr").value, "wallet address"); }
  catch (e) { $("addr").setAttribute("aria-invalid", "true"); return notice($("acctMsg"), "error", errMsg(e)); }
  $("addr").removeAttribute("aria-invalid");
  if (S.addr !== a) resetAccount();
  S.addr = a; $("addr").value = C.toXdc(a);
  settings.addr = settings.addr || {}; settings.addr[S.chainId] = C.toXdc(a); save();
  notice($("acctMsg"), "", `<span class="progress"><span class="spinner"></span>Reading ${esc(C.NETS[S.chainId].name)}…</span>`);
  $("load").disabled = true;
  try {
    await refreshAccount();
    notice($("acctMsg"));
    $("g1").classList.add("done");
    $("pickHint").hidden = !!S.action;
    $("pickHint").textContent = "Pick one to continue.";
    if (S.action) pick(S.action);
    if (!S.scrolledOnce) { S.scrolledOnce = true; $("g2").scrollIntoView({ behavior: "smooth", block: "start" }); }
  } catch (e) { notice($("acctMsg"), "error", errMsg(e)); }
  finally { $("load").disabled = false; }
}
$("load").addEventListener("click", loadAccount);
$("addr").addEventListener("keydown", (e) => { if (e.key === "Enter") loadAccount(); });

/* ================= 2. Choose ================= */
const PANEL = { send: "f-send", token: "f-token", vote: "f-cand", unvote: "f-cand", resign: "f-cand", withdraw: "f-withdraw", propose: "f-propose", kyc: "f-kyc", cancel: "f-cancel" };
document.querySelectorAll("#picker button").forEach((b) => b.addEventListener("click", () => pick(b.dataset.a)));

function pick(a) {
  S.action = a;
  document.querySelectorAll("#picker button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.a === a));
  notice($("prepMsg"));
  if (!S.addr || S.balance === null) { $("pickHint").hidden = false; $("pickHint").textContent = "Load your wallet in step 1 first."; return; }
  $("pickHint").hidden = true;
  for (const id of new Set(Object.values(PANEL))) $(id).hidden = id !== PANEL[a];
  $("adv").hidden = a === "cancel"; $("prepActs").hidden = a === "withdraw";
  $("prep").className = a === "resign" ? "btn btn-danger" : "btn btn-primary";
  if (PANEL[a] === "f-cand") setupCand();
  if (a === "withdraw") loadWithdrawals();
  if (a === "propose") setupPropose();
  if (a === "kyc") setupKyc();
  if (a === "cancel") setupCancel();
}

// ---- Propose / KYC
async function kycStatus() {
  const [cnt, owned] = await Promise.all([
    vcall(C.encodeView(C.VIEWS.getHashCount, ["address"], [S.addr])).then(C.decUint),
    vcall(C.encodeView(C.VIEWS.ownerToCandidate, ["address", "uint256"], [S.addr, 0n])).then(() => true, (e) => { if (e instanceof RpcError) return false; throw e; }),
  ]);
  let latest = "";
  if (cnt > 0n) latest = await vcall(C.encodeView(C.VIEWS.getLatestKYC, ["address"], [S.addr])).then(C.decString).catch(() => "");
  return { count: cnt, owned, latest };
}
function setupPropose() {
  $("propHint").textContent = "";
  Promise.all([params(), kycStatus()]).then(([p, k]) => {
    if (!$("propAmt").value) $("propAmt").value = C.formatUnits(p.minCandidateCap, 18, false);
    $("propHint").innerHTML = `Minimum: ${esc(X(p.minCandidateCap))}. ` + (k.owned ? "This wallet has owned a masternode before, so no new KYC is needed."
      : k.count > 0n ? "KYC is on file for this wallet." : `<b>No KYC on file for this wallet.</b> Use Upload KYC first.`);
  }).catch((e) => ($("propHint").textContent = "Couldn't read the contract: " + e.message));
}
function setupKyc() {
  $("kycInfo").textContent = "";
  kycStatus().then((k) => {
    $("kycInfo").innerHTML = k.count > 0n ? `This wallet has uploaded KYC ${k.count} time(s). Latest: <b class="mono">${esc(k.latest)}</b>`
      : k.owned ? "This wallet has owned a masternode before, so it can propose without uploading KYC." : "No KYC on file for this wallet yet.";
  }).catch(() => {});
}

// XDC RPCs can return addresses with an "xdc" prefix in JSON fields; compare in 0x form.
const hexAddr = (a) => String(a || "").toLowerCase().replace(/^xdc/, "0x");

// ---- Pending transactions. Sources, best first: the node's transaction pool (txpool_contentFrom /
// txpool_content, often disabled on public RPCs), the pending block, then the "pending" nonce count.
async function poolFor(addr) {
  const out = new Map();
  const take = (byNonce) => { for (const t of Object.values(byNonce || {})) if (t && t.nonce != null) out.set(BigInt(t.nonce), { gasPrice: BigInt(t.gasPrice || 0), hash: t.hash }); };
  try {
    const r = await rpc("txpool_contentFrom", [addr]);
    take(r && r.pending); take(r && r.queued);
    if (out.size) return out;
  } catch {}
  try {
    const r = await rpc("txpool_content", []);
    for (const part of [r && r.pending, r && r.queued]) for (const [a, byNonce] of Object.entries(part || {})) if (hexAddr(a) === addr) take(byNonce);
  } catch {}
  return out;
}
// Next usable nonce: the unbroken run of pool transactions after the last mined one. Transactions
// queued behind a gap don't count; the next transaction must fill the gap.
function nextNonce(rpcPending, latest, pool) {
  let n = latest;
  while (pool.has(n)) n++;
  return n > rpcPending ? n : rpcPending;
}
async function findPending(nonce, addr = S.addr) {
  const pool = await poolFor(addr);
  if (pool.has(nonce)) return pool.get(nonce);
  try {
    const b = await rpc("eth_getBlockByNumber", ["pending", true]);
    const t = b && (b.transactions || []).find((x) => x.from && hexAddr(x.from) === addr && BigInt(x.nonce) === nonce);
    if (t) return { gasPrice: BigInt(t.gasPrice), hash: t.hash };
  } catch {}
  return null;
}
async function setupCancel() {
  const waiting = S.nonce - S.latestNonce;
  $("cnNonce").value = S.latestNonce.toString();
  $("cnGp").value = C.formatUnits(S.gasPrice * 2n, 9, false);
  if (S.gapAfter && S.gapAfter.length) {
    $("cnNonce").value = S.nonce.toString();
    $("cancelInfo").innerHTML = `There is a <b>gap</b>: transaction(s) with nonce ${S.gapAfter.join(", ")} are waiting for nonce <b>${S.nonce}</b>, which was never sent. Sending anything with nonce ${S.nonce}, including this cancel or any normal transaction, fills the gap and lets them through. Only cancel them if you don't want them to happen.`;
    return;
  }
  if (waiting <= 0n) { $("cancelInfo").innerHTML = "This RPC sees <b>no pending transactions</b> from this wallet, so there's nothing to cancel. If you broadcast through a different RPC, it may not have reached this one."; return; }
  $("cancelInfo").innerHTML = `<b>${waiting} transaction(s)</b> from this wallet are waiting to be mined (nonce ${S.latestNonce}${waiting > 1n ? ` to ${S.nonce - 1n}` : ""}). The first one blocks the rest.`;
  const f = await findPending(S.latestNonce);
  if (f) {
    const bump = (f.gasPrice * 13n) / 10n;
    $("cnGp").value = C.formatUnits(bump > S.gasPrice ? bump : S.gasPrice, 9, false);
    $("cancelInfo").innerHTML += ` It was sent at ${esc(C.formatUnits(f.gasPrice, 9))} gwei; the new gas price below is 30% higher.`;
  } else $("cancelInfo").innerHTML += " This RPC doesn't show its gas price, so the suggestion below is double the current network price.";
}

$("sendAll").addEventListener("change", () => { $("sendAmtF").hidden = $("sendAll").checked; });
$("tokAll").addEventListener("change", () => { $("tokAmtF").hidden = $("tokAll").checked; });

// ---- Token lookup
async function lookupToken() {
  const a = C.normAddr($("tokAddr").value, "token contract");
  $("tokInfo").innerHTML = `<span class="progress"><span class="spinner"></span>Reading token…</span>`;
  const code = await rpc("eth_getCode", [a, "latest"]);
  if (!code || code === "0x") throw new Error("there is no contract at that address on " + C.NETS[S.chainId].name);
  const [sy, dc, nm, bal] = await Promise.all([
    call(a, C.VIEWS.symbol).catch(() => "0x"), call(a, C.VIEWS.decimals), call(a, C.VIEWS.name).catch(() => "0x"),
    call(a, C.encodeView(C.VIEWS.balanceOf, ["address"], [S.addr])),
  ]);
  const decimals = Number(C.decUint(dc));
  if (!Number.isInteger(decimals) || decimals > 36) throw new Error("this contract reports invalid decimals; it may not be an XRC-20 token");
  S.token = { addr: a, symbol: C.decString(sy).replace(/[^\w .\-+$()]/g, "").slice(0, 24) || "tokens", name: C.decString(nm).slice(0, 60), decimals, balance: C.decUint(bal) };
  $("tokAddr").value = C.toXdc(a);
  $("tokSym").textContent = S.token.symbol;
  $("tokInfo").innerHTML = `<b>${esc(S.token.name || S.token.symbol)}</b> (${esc(S.token.symbol)}, ${decimals} decimals). Your balance: <b>${esc(C.formatUnits(S.token.balance, decimals))} ${esc(S.token.symbol)}</b>`;
  return S.token;
}
$("tokLoad").addEventListener("click", () => lookupToken().catch((e) => { $("tokInfo").innerHTML = `<span style="color:var(--flare)">${errMsg(e)}</span>`; S.token = null; }));
$("tokAddr").addEventListener("change", () => { S.token = null; $("tokInfo").textContent = ""; });

// ---- Candidate (vote / unvote / resign)
function setupCand() {
  const a = S.action;
  $("candAmtF").hidden = a === "resign";
  $("candAmtL").textContent = a === "vote" ? "Stake to vote" : "Amount to unvote";
  $("candMax").hidden = a !== "unvote";
  $("resignChkL").hidden = a !== "resign";
  $("resignChk").checked = false;
  $("findMine").textContent = a === "resign" ? "Find candidates I own" : "Find candidates I have stake on";
  params().then((p) => {
    $("candAmtHint").textContent = a === "vote" ? `Minimum vote: ${X(p.minVoterCap)}. Unvoted stake unlocks ${p.voterDelay} blocks (about ${dur(p.voterDelay)}) after you unvote.`
      : `Unvoted stake can be withdrawn after ${p.voterDelay} blocks (about ${dur(p.voterDelay)}). If you own this candidate, at least ${X(p.minCandidateCap)} must stay staked.`;
  }).catch(() => {});
  if ($("cand").value.trim()) lookupCand().catch((e) => ($("candInfo").innerHTML = `<span style="color:var(--flare)">${errMsg(e)}</span>`));
}

async function lookupCand() {
  const c = C.normAddr($("cand").value, "candidate");
  $("candInfo").innerHTML = `<span class="progress"><span class="spinner"></span>Reading candidate…</span>`;
  const [isC, cap, owner, mine, p] = await Promise.all([
    vcall(C.encodeView(C.VIEWS.isCandidate, ["address"], [c])), vcall(C.encodeView(C.VIEWS.getCandidateCap, ["address"], [c])),
    vcall(C.encodeView(C.VIEWS.getCandidateOwner, ["address"], [c])), vcall(C.encodeView(C.VIEWS.getVoterCap, ["address", "address"], [c, S.addr])),
    params(),
  ]);
  S.cand = { addr: c, isCandidate: C.decBool(isC), cap: C.decUint(cap), owner: C.decAddr(owner), mine: C.decUint(mine) };
  S.cand.isOwner = S.cand.owner === S.addr;
  $("cand").value = C.toXdc(c);
  const k = S.cand;
  const parts = [];
  parts.push(k.isCandidate ? `<b>Active candidate</b>, total stake ${esc(X(k.cap))}` : `<b>Not an active candidate</b>${k.owner !== "0x" + "0".repeat(40) ? " (resigned)" : ""}`);
  parts.push(`your stake on it: <b>${esc(X(k.mine))}</b>`);
  if (k.isOwner) parts.push("<b>you own this candidate</b>");
  $("candInfo").innerHTML = parts.join(" · ");
  return k;
}
$("candLook").addEventListener("click", () => lookupCand().catch((e) => ($("candInfo").innerHTML = `<span style="color:var(--flare)">${errMsg(e)}</span>`)));
$("cand").addEventListener("change", () => { S.cand = null; $("candInfo").textContent = ""; });
$("candMax").addEventListener("click", async () => {
  try {
    const k = S.cand && S.cand.addr === C.normAddr($("cand").value) ? S.cand : await lookupCand();
    const p = await params();
    let max = k.mine;
    if (k.isOwner) max = k.mine > p.minCandidateCap ? k.mine - p.minCandidateCap : 0n;
    $("candAmt").value = C.formatUnits(max, 18, false);
  } catch (e) { notice($("prepMsg"), "error", errMsg(e)); }
});

$("findMine").addEventListener("click", async () => {
  const box = $("mineBox"); box.hidden = false;
  box.innerHTML = `<p class="notice"><span class="progress"><span class="spinner"></span><span id="mineProg">Reading the candidate list…</span></span></p>`;
  try {
    const list = C.decArray(await vcall(C.VIEWS.getCandidates), "address").filter((a) => !/^0x0{40}$/.test(a));
    const caps = await callMany(list.map((c) => ({ to: C.VALIDATOR, data: C.encodeView(C.VIEWS.getVoterCap, ["address", "address"], [c, S.addr]) })),
      (d, n) => { const el = $("mineProg"); if (el) el.textContent = `Checking candidates ${d} of ${n}…`; });
    let rows = list.map((c, i) => ({ c, mine: caps[i] ? C.decUint(caps[i]) : 0n })).filter((r) => r.mine > 0n);
    const owners = await callMany(rows.map((r) => ({ to: C.VALIDATOR, data: C.encodeView(C.VIEWS.getCandidateOwner, ["address"], [r.c]) })));
    rows.forEach((r, i) => (r.own = owners[i] && C.decAddr(owners[i]) === S.addr));
    if (S.action === "resign") rows = rows.filter((r) => r.own);
    const resignedNote = S.action === "resign" ? "" : " Candidates that have resigned are no longer listed by the contract; if you still have stake on one, enter its address above to unvote it.";
    if (!rows.length) { box.innerHTML = `<p class="notice">${S.action === "resign" ? "This wallet doesn't own any active candidate." : "This wallet has no stake on any active candidate."}${resignedNote}</p>`; return; }
    box.innerHTML = `<table class="list"><thead><tr><th>Candidate</th><th>Your stake</th><th></th></tr></thead><tbody>${rows.map((r) =>
      `<tr><td class="mono">${esc(C.toXdc(r.c))}${r.own ? ' <span class="kind kind-ok">owner</span>' : ""}</td><td>${esc(X(r.mine))}</td><td><button type="button" class="btn btn-ghost btn-small" data-use="${r.c}">Use</button></td></tr>`).join("")}</tbody></table>${resignedNote ? `<p class="hint">${resignedNote.trim()}</p>` : ""}`;
    box.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => {
      $("cand").value = C.toXdc(b.dataset.use); box.hidden = true;
      lookupCand().catch((e) => ($("candInfo").innerHTML = `<span style="color:var(--flare)">${errMsg(e)}</span>`));
    }));
  } catch (e) { box.innerHTML = `<p class="notice" data-tone="error">${errMsg(e)}</p>`; }
});

// ---- Withdrawals
async function loadWithdrawals() {
  const box = $("wdBox");
  box.innerHTML = `<p class="notice"><span class="progress"><span class="spinner"></span>Reading your withdrawal queue…</span></p>`;
  try {
    const [nums, bn, p] = await Promise.all([vcall(C.VIEWS.getWithdrawBlockNumbers, S.addr), rpc("eth_blockNumber"), params()]);
    S.block = BigInt(bn);
    const blocks = C.decArray(nums, "uint");
    const seen = new Set(), entries = [];
    blocks.forEach((b, index) => { if (b > 0n && !seen.has(b)) { seen.add(b); entries.push({ blockNumber: b, index }); } });
    const caps = await Promise.all(entries.map((e) => vcall(C.encodeView(C.VIEWS.getWithdrawCap, ["uint256"], [e.blockNumber]), S.addr)));
    entries.forEach((e, i) => (e.cap = C.decUint(caps[i])));
    S.withdrawals = entries.filter((e) => e.cap > 0n);
    if (!S.withdrawals.length) {
      box.innerHTML = `<p class="notice">Nothing in the withdrawal queue for this wallet. Unvoting or resigning puts stake here; it unlocks after ${p.voterDelay} blocks (about ${dur(p.voterDelay)}) for unvotes, or ${p.candDelay} blocks (about ${dur(p.candDelay)}) after resigning.</p>`;
      return;
    }
    box.innerHTML = `<table class="list"><thead><tr><th>Amount</th><th>Unlocks at block</th><th></th></tr></thead><tbody>${S.withdrawals.map((e, i) => {
      const ready = S.block >= e.blockNumber;
      const left = ready ? "Ready" : `in ${e.blockNumber - S.block} blocks, about ${dur(e.blockNumber - S.block)}`;
      return `<tr><td><b>${esc(X(e.cap))}</b></td><td>${e.blockNumber}<span class="sub muted" style="display:block;font-size:0.8rem">${esc(left)}</span></td><td><button type="button" class="btn ${ready ? "btn-primary" : "btn-ghost"} btn-small" data-wd="${i}" ${ready ? "" : "disabled"}>${ready ? "Withdraw this" : "Locked"}</button></td></tr>`;
    }).join("")}</tbody></table><p class="hint">Each entry is a separate Withdraw transaction. Broadcast one before preparing the next, so each gets its own nonce.</p>`;
    box.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", () => prepare({ withdraw: S.withdrawals[Number(b.dataset.wd)] })));
  } catch (e) { box.innerHTML = `<p class="notice" data-tone="error">${errMsg(e)}</p>`; }
}

/* ================= Prepare ================= */
function bump(est) { const g = (BigInt(est) * 125n) / 100n; return ((g + 999n) / 1000n) * 1000n; }

async function estimate(to, value, data) {
  try {
    return bump(await rpc("eth_estimateGas", [{ from: S.addr, to, value: hex(value), data }]));
  } catch (e) {
    if (e instanceof RpcError) throw new Error("the network says this transaction would fail: " + e.message + ". Nothing has been prepared.");
    throw e;
  }
}

function gasOverrides() {
  const gp = $("gpIn").value.trim(), gl = $("glIn").value.trim();
  const nn = $("nonceIn").value.trim();
  return { gp: gp ? C.parseUnits(gp, 9) : null, gl: gl ? C.toBig(gl, "gas limit") : null, nonce: nn ? C.toBig(nn, "nonce") : null };
}

async function prepare(extra = {}) {
  const msg = $("prepMsg");
  notice(msg, "", `<span class="progress"><span class="spinner"></span>Checking with the network…</span>`);
  $("prep").disabled = true;
  try {
    await refreshAccount(); // fresh nonce, balance and gas price
    const o = gasOverrides();
    const gasPrice = o.gp || S.gasPrice;
    let action = S.action, args = {}, info = {}, gasLimit, to, value = 0n, data = "0x", warn = [];

    if (action === "send") {
      to = C.normAddr($("sendTo").value, "recipient");
      if (to === S.addr) throw new Error("the recipient is this same wallet");
      const code = await rpc("eth_getCode", [to, "latest"]);
      const isContract = code && code !== "0x";
      if ($("sendAll").checked) {
        action = "sendAll";
        if (S.nonce > S.latestNonce && o.nonce === null) throw new Error(`this wallet has ${S.nonce - S.latestNonce} transaction(s) still waiting to be mined. They will change the balance, so a send-everything prepared now would fail. Wait until they are mined (or cancel them), then prepare again.`);
        gasLimit = o.gl || (isContract ? await estimate(to, 1n, "0x") : 21000n);
        const fee = gasLimit * gasPrice;
        if (S.balance <= fee) throw new Error(`the balance (${X(S.balance)}) doesn't cover the network fee (${X(fee)})`);
        args = { to, balance: S.balance };
        if (isContract) warn.push("The recipient is a contract, so the gas it uses can't be known exactly. Unused gas is refunded to this wallet, leaving a tiny remainder.");
        if (to === C.VALIDATOR) throw new Error("don't send XDC straight to the validator contract; use Vote instead");
      } else {
        value = C.parseUnits($("sendAmt").value, 18);
        if (value === 0n) throw new Error("enter an amount");
        gasLimit = o.gl || (isContract ? await estimate(to, value, "0x") : 21000n);
        if (value + gasLimit * gasPrice > S.balance) throw new Error(`not enough XDC: sending ${X(value)} plus up to ${X(gasLimit * gasPrice)} in fees, but the balance is ${X(S.balance)}`);
        args = { to, amount: value };
        if (to === C.VALIDATOR) throw new Error("don't send XDC straight to the validator contract; use Vote instead");
      }
      if (isContract) warn.push("The recipient is a contract, not a wallet. Make sure it is meant to receive XDC.");
    }

    else if (action === "token") {
      const t = await lookupToken(); // always re-read, so the balance is current
      const rcpt = C.normAddr($("tokTo").value, "recipient");
      const amt = $("tokAll").checked ? S.token.balance : C.parseUnits($("tokAmt").value, t.decimals);
      if (amt === 0n) throw new Error($("tokAll").checked ? "this wallet holds none of this token" : "enter an amount");
      if (amt > S.token.balance) throw new Error(`not enough ${t.symbol}: the balance is ${C.formatUnits(S.token.balance, t.decimals)}`);
      to = t.addr; data = C.encodeCall("transfer", [rcpt, amt]);
      gasLimit = o.gl || await estimate(to, 0n, data);
      const ret = await rpc("eth_call", [{ from: S.addr, to, data }, "latest"]).catch(() => "0x");
      if (ret && ret.length >= 66 && C.decUint(ret) === 0n) throw new Error("the token contract says this transfer would not go through (transfer returned false)");
      if (gasLimit * gasPrice > S.balance) throw new Error(`the wallet needs about ${X(gasLimit * gasPrice)} for the network fee but holds ${X(S.balance)}`);
      args = { token: t.addr, to: rcpt, amount: amt, decimals: t.decimals, symbol: t.symbol, ...($("tokAll").checked ? { all: true } : {}) };
    }

    else if (action === "vote" || action === "unvote" || action === "resign") {
      const k = await lookupCand();
      const p = await params();
      to = C.VALIDATOR;
      if (action === "vote") {
        if (!k.isCandidate) throw new Error("that address is not an active masternode candidate");
        value = C.parseUnits($("candAmt").value, 18);
        if (value < p.minVoterCap) throw new Error(`the minimum vote is ${X(p.minVoterCap)}`);
        data = C.encodeCall("vote", [k.addr]);
        gasLimit = o.gl || await estimate(to, value, data);
        if (value + gasLimit * gasPrice > S.balance) throw new Error(`not enough XDC for the vote plus fees (balance ${X(S.balance)})`);
        args = { candidate: k.addr, amount: value };
      } else if (action === "unvote") {
        const amt = C.parseUnits($("candAmt").value, 18);
        if (amt === 0n) throw new Error("enter an amount");
        if (amt > k.mine) throw new Error(`you have only ${X(k.mine)} staked on this candidate`);
        if (k.isOwner && k.mine - amt < p.minCandidateCap) throw new Error(`as the owner you must keep at least ${X(p.minCandidateCap)} staked; to take it all out, resign the masternode instead`);
        data = C.encodeCall("unvote", [k.addr, amt]);
        gasLimit = o.gl || await estimate(to, 0n, data);
        args = { candidate: k.addr, amount: amt };
        info = { unlock: `${p.voterDelay} blocks` };
      } else {
        if (!k.isOwner) throw new Error(`only the owner (${C.toXdc(k.owner)}) can resign this candidate`);
        if (!k.isCandidate) throw new Error("this candidate has already resigned");
        if (!$("resignChk").checked) throw new Error("tick the box to confirm you understand resigning is permanent");
        data = C.encodeCall("resign", [k.addr]);
        gasLimit = o.gl || await estimate(to, 0n, data);
        args = { candidate: k.addr };
        info = { amount: k.mine, unlock: `${p.candDelay} blocks` };
      }
    }

    else if (action === "propose") {
      const cand = C.normAddr($("propCand").value, "candidate (node) address");
      const [p, k, isC] = await Promise.all([params(), kycStatus(), vcall(C.encodeView(C.VIEWS.isCandidate, ["address"], [cand])).then(C.decBool)]);
      if (isC) throw new Error("that address is already an active masternode candidate");
      if (!k.owned && k.count === 0n) throw new Error("this wallet has no KYC on file and has never owned a masternode, so the contract will refuse the proposal. Use Upload KYC first.");
      value = C.parseUnits($("propAmt").value, 18);
      if (value < p.minCandidateCap) throw new Error(`the minimum stake to propose is ${X(p.minCandidateCap)}`);
      to = C.VALIDATOR; data = C.encodeCall("propose", [cand]);
      gasLimit = o.gl || await estimate(to, value, data);
      if (value + gasLimit * gasPrice > S.balance) throw new Error(`not enough XDC: the stake plus fees is up to ${X(value + gasLimit * gasPrice)}, but the balance is ${X(S.balance)}`);
      args = { candidate: cand, amount: value };
      if (cand === S.addr) warn.push("The candidate address is this owner wallet. Normally it is your masternode server's own coinbase address. Check this is what you intend.");
    }

    else if (action === "kyc") {
      const h = $("kycIn").value.trim();
      if (!C.KYC_RE.test(h)) throw new Error("enter the KYC reference: 1 to 200 printable characters, no spaces");
      to = C.VALIDATOR; data = C.encodeCall("uploadKYC", [h]);
      gasLimit = o.gl || await estimate(to, 0n, data);
      args = { hash: h };
    }

    else if (action === "cancel") {
      const n = C.toBig($("cnNonce").value, "nonce");
      if (n < S.latestNonce) throw new Error(`nonce ${n} is already used (mined); the oldest pending nonce is ${S.latestNonce}`);
      if (n >= S.nonce && S.gapAfter && S.gapAfter.length && n === S.nonce) warn.push(`Nonce ${n} is the missing one, so this fills the gap: the transactions waiting behind it (nonce ${S.gapAfter.join(", ")}) will then go through. To stop those as well, cancel each of them afterwards.`);
      else if (n >= S.nonce) warn.push(`No pending transaction with nonce ${n} is visible on this RPC, so this will simply be a 0 XDC transfer to yourself.`);
      const gp = C.parseUnits($("cnGp").value, 9);
      if (gp === 0n) throw new Error("enter a gas price");
      gasLimit = 21000n; to = S.addr;
      if (gasLimit * gp > S.balance) throw new Error("the wallet can't cover the fee");
      const req = C.makeRequest({ chainId: S.chainId, from: S.addr, nonce: n, gasPrice: gp, gasLimit, action: "cancel", args: {} });
      return finishPrepare(req, warn);
    }

    else if (action === "withdraw") {
      const e = extra.withdraw;
      if (!e) throw new Error("choose an entry from the withdrawal queue");
      if (S.block < e.blockNumber) throw new Error("that entry is still locked");
      to = C.VALIDATOR; data = C.encodeCall("withdraw", [e.blockNumber, e.index]);
      gasLimit = o.gl || await estimate(to, 0n, data);
      args = { blockNumber: e.blockNumber, index: e.index };
      info = { amount: e.cap };
    }

    if (gasLimit * gasPrice > S.balance && action !== "sendAll") throw new Error(`the wallet can't cover the network fee of up to ${X(gasLimit * gasPrice)}`);
    let nonce = S.nonce;
    if (S.nonce > S.latestNonce && o.nonce === null) warn.push(`This wallet has ${S.nonce - S.latestNonce} transaction(s) still waiting to be mined, so this one (nonce ${S.nonce}) will go through only after them.`);
    if (o.nonce !== null) {
      if (o.nonce < S.latestNonce) throw new Error(`nonce ${o.nonce} is already used; the next unused one is ${S.latestNonce}`);
      if (o.nonce < S.nonce) warn.push(`Nonce ${o.nonce} belongs to a pending transaction. This replaces it only if the gas price is at least 10% higher than the pending one's.`);
      if (o.nonce > S.nonce) warn.push(`Nonce ${o.nonce} leaves a gap after ${S.nonce - 1n}; it won't be mined until the gap is filled.`);
      nonce = o.nonce;
    }
    const req = C.makeRequest({ chainId: S.chainId, from: S.addr, nonce, gasPrice, gasLimit, action, args, info });
    return finishPrepare(req, warn);
  } catch (e) { notice(msg, "error", errMsg(e)); }
  finally { $("prep").disabled = false; }
}

function finishPrepare(req, warn) {
  const msg = $("prepMsg");
  {
    const built = C.buildFromRequest(req);
    S.prepared = { req, built };
    try { sessionStorage.setItem(STORE + "-prepared", JSON.stringify(req)); } catch {}
    showRequest(req, built);
    notice(msg, warn.length ? "warn" : "ok", warn.length ? warn.map(esc).join("<br>") : "Ready. Scan the QR code in step 3 with the offline signer.");
    $("g2").classList.add("done");
    $("g3").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
$("prep").addEventListener("click", () => prepare());

function clearPrepared() {
  S.prepared = null;
  try { sessionStorage.removeItem(STORE + "-prepared"); } catch {}
  $("reqOut").hidden = true; $("reqEmpty").hidden = false; $("reqQr").replaceChildren();
  $("g2").classList.remove("done"); $("g3").classList.remove("done");
}

/* ================= 3. Request QR ================= */
const LABELS = {
  to: "Recipient address", amount: "Amount", balance: "Exact current balance", token: "Token contract address",
  decimals: "Token decimals", symbol: "Token symbol", candidate: "Candidate (masternode) address",
  blockNumber: "Unlock block number", index: "Queue index", hash: "KYC reference (IPFS hash)",
};
function showRequest(req, built) {
  const text = JSON.stringify(req);
  showQR($("reqQr"), text, { ecc: "L", px: 8 });
  const desc = C.describeTx(built.tx, { from: built.from, meta: built.meta, token: built.meta.token });
  $("reqCap").textContent = `${desc.title}: ${desc.summary}`;
  const rows = [
    ["Network", `${C.NETS[req.chain].name} (${req.chain})`], ["Transaction", C.ACTIONS[req.action]],
    ["From address", C.toXdc(req.from), null, true], ["Nonce", String(req.nonce)], ["Gas limit", String(req.gas)],
    ["Gas price", `${C.formatUnits(req.gasPrice, 9, false)} gwei`],
  ];
  for (const [k, v] of Object.entries(req.args)) {
    if (k === "all") continue;
    let val = String(v), mono = false;
    if (["to", "token", "candidate"].includes(k)) { val = C.toXdc(v); mono = true; }
    else if (k === "amount" && req.action === "token") val = `${C.formatUnits(v, req.args.decimals, false)} ${req.args.symbol}`;
    else if (k === "amount" || k === "balance") val = `${C.formatUnits(v, 18, false)} ${sym()}`;
    rows.push([LABELS[k] || k, val, null, mono]);
  }
  $("reqKv").innerHTML = kvRows(rows);
  $("reqNonce").textContent = String(req.nonce);
  $("reqOut").hidden = false; $("reqEmpty").hidden = true;
  $("g3").classList.add("done");
  $("reqCopy").onclick = () => copyText(text, $("reqCopy"));
}

/* ================= 4. Verify + broadcast ================= */
$("sigScan").addEventListener("click", () => openScan("Scan the signed transaction", (t) => {
  if (/^\s*\{/.test(t)) throw new Error("That's a signing request. Scan the signed transaction shown by the offline signer.");
  if (!/^\s*(0x)?[0-9a-f]+\s*$/i.test(t)) throw new Error("That QR code isn't a transaction.");
  checkSigned(t);
}, $("sigMsg")));
$("sigImg").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { checkSigned(await scanImageFile(f)); } catch (err) { notice($("sigMsg"), "error", errMsg(err)); }
});
$("sigUse").addEventListener("click", () => checkSigned($("sigPaste").value));
$("bcClear").addEventListener("click", clearChecked);
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "again") { clearChecked(); $("g2").scrollIntoView({ behavior: "smooth", block: "start" }); }
});

function clearChecked() {
  S.checked = null; $("review").hidden = true; $("bcActs").hidden = true; notice($("bcMsg")); notice($("sigMsg"));
  $("g4").classList.remove("done");
}

function tryPrepared() {
  if (S.prepared) return S.prepared;
  try {
    const r = sessionStorage.getItem(STORE + "-prepared");
    if (r) { const req = JSON.parse(r); return { req, built: C.buildFromRequest(req) }; }
  } catch {}
  return null;
}

async function checkSigned(text) {
  clearChecked();
  let d;
  try { d = C.decodeRawTx(String(text).trim().replace(/^(?!0x)/i, "0x")); }
  catch (e) { return notice($("sigMsg"), "error", "This can't be broadcast: " + errMsg(e)); }
  const tx = d.tx, cid = Number(tx.chainId);
  if (!C.NETS[cid]) return notice($("sigMsg"), "error", `This transaction is for chain ID ${cid}, which is not an XDC network.`);
  if (cid !== S.chainId) { S.chainId = cid; settings.chainId = cid; save(); renderNet(); }
  notice($("sigMsg"), "", `<span class="progress"><span class="spinner"></span>Checking against ${esc(C.NETS[cid].name)}…</span>`);

  try {
    const checks = [];
    if (!d.signed) {
      const desc = C.describeTx(tx, {});
      renderReview($("review"), desc, { kicker: "Unsigned transaction", checks: [{ tone: "bad", text: "This is the unsigned version. Scan the “Signed (to broadcast)” code on the offline signer instead." }] });
      notice($("sigMsg"));
      return;
    }
    const from = d.from;
    checks.push({ tone: "ok", text: `Signature is valid. Signed by ${C.toXdc(from)}.` });

    const [bal, pend0, latest, code] = await Promise.all([
      rpc("eth_getBalance", [from, "latest"]).then(BigInt), rpc("eth_getTransactionCount", [from, "pending"]).then(BigInt),
      rpc("eth_getTransactionCount", [from, "latest"]).then(BigInt), tx.to ? rpc("eth_getCode", [tx.to, "latest"]) : "0x",
    ]);
    const pend = nextNonce(pend0, latest, await poolFor(from));

    // Compare with what this browser prepared
    const prep = tryPrepared();
    let meta = null, info = null;
    if (prep) {
      const p = prep.built, diffs = [];
      if (p.from !== from) diffs.push("sender");
      for (const k of ["chainId", "nonce", "gasPrice", "gasLimit", "value"]) if (p.tx[k] !== tx[k]) diffs.push(k);
      if ((p.tx.to || "") !== (tx.to || "")) diffs.push("recipient/contract");
      if (p.tx.data.toLowerCase() !== tx.data.toLowerCase()) diffs.push("call data");
      if (!diffs.length) { checks.push({ tone: "ok", text: "Matches, field for field, the request you prepared on this page." }); meta = p.meta; info = prep.req.info; }
      else checks.push({ tone: "warn", text: `Differs from the request you prepared on this page (${diffs.join(", ")}). That's expected only if you signed something else.` });
    } else checks.push({ tone: "warn", text: "No request was prepared in this browser, so there's nothing to compare against. Check the details carefully." });

    // Nonce
    if (tx.nonce < latest) checks.push({ tone: "bad", text: `Nonce ${tx.nonce} has already been used by this wallet (next is ${pend}). The network will reject it. Prepare and sign a new one.` });
    else if (tx.nonce < pend) {
      const old = tx.nonce === latest ? await findPending(tx.nonce, from).catch(() => null) : null;
      if (old && tx.gasPrice * 10n < old.gasPrice * 11n) checks.push({ tone: "bad", text: `The pending transaction with nonce ${tx.nonce} pays ${C.formatUnits(old.gasPrice, 9)} gwei; a replacement needs at least 10% more, but this pays ${C.formatUnits(tx.gasPrice, 9)} gwei.` });
      else if (old) checks.push({ tone: "ok", text: `Replaces the pending transaction with nonce ${tx.nonce}: it pays ${C.formatUnits(tx.gasPrice, 9)} gwei against that one's ${C.formatUnits(old.gasPrice, 9)} gwei.` });
      else checks.push({ tone: "warn", text: `Replaces the pending transaction with nonce ${tx.nonce}, provided its gas price is at least 10% higher than that one's. This RPC doesn't show the pending transaction's gas price.` });
    }
    else if (tx.nonce > pend) checks.push({ tone: "warn", text: `Nonce ${tx.nonce} is ahead of the wallet's next nonce (${pend}). It will wait until the earlier ones are mined.` });
    else checks.push({ tone: "ok", text: `Nonce ${tx.nonce} is the wallet's next transaction.` });

    // Funds
    const maxFee = tx.gasLimit * tx.gasPrice;
    if (bal < tx.value + maxFee) checks.push({ tone: "bad", text: `The wallet holds ${X(bal)} but this needs up to ${X(tx.value + maxFee)}. The network will reject it.` });
    else checks.push({ tone: "ok", text: `The wallet holds enough XDC (${X(bal)}).` });
    if (!meta && !tx.data.slice(2) && tx.value + maxFee === bal) meta = { action: "sendAll", balance: bal };
    if (meta && meta.action === "sendAll") {
      if (bal > tx.value + maxFee) checks.push({ tone: "warn", text: `The balance has grown to ${X(bal)} since you prepared this, so ${X(bal - tx.value - maxFee)} will stay in the wallet. Prepare again to send everything.` });
    }

    // Context read from the chain
    const call_ = C.decodeCall(tx.data);
    let token = null, tokenVerified = false, infoVerified = false;
    if (call_ && call_.name === "transfer" && tx.to !== C.VALIDATOR) {
      try {
        const [sy, dc, tb] = await Promise.all([call(tx.to, C.VIEWS.symbol).catch(() => "0x"), call(tx.to, C.VIEWS.decimals), call(tx.to, C.encodeView(C.VIEWS.balanceOf, ["address"], [from]))]);
        token = { symbol: C.decString(sy).replace(/[^\w .\-+$()]/g, "").slice(0, 24) || "tokens", decimals: Number(C.decUint(dc)), all: meta && meta.token && meta.token.all };
        tokenVerified = true;
        const tbal = C.decUint(tb);
        if (tbal < call_.args.amount) checks.push({ tone: "bad", text: `The wallet holds only ${C.formatUnits(tbal, token.decimals)} ${token.symbol}.` });
      } catch { checks.push({ tone: "warn", text: "Couldn't read the token's symbol and decimals from the chain, so the amount is shown in base units." }); }
    }
    if (call_ && call_.name === "withdraw" && tx.to === C.VALIDATOR) {
      try { info = { amount: C.decUint(await vcall(C.encodeView(C.VIEWS.getWithdrawCap, ["uint256"], [call_.args.blockNumber]), from)) }; infoVerified = true; } catch {}
    }
    if (tx.to && code === "0x" && tx.data !== "0x") checks.push({ tone: "bad", text: "This calls a contract function, but there is no contract at the destination address." });

    // Simulate
    if (tx.to && (code !== "0x" || tx.data !== "0x")) {
      try {
        const ret = await rpc("eth_call", [{ from, to: tx.to, value: hex(tx.value), data: tx.data, gas: hex(tx.gasLimit) }, "latest"]);
        if (call_ && call_.name === "transfer" && ret && ret.length >= 66 && C.decUint(ret) === 0n)
          checks.push({ tone: "bad", text: "The network's dry run shows the token contract would refuse this transfer (it returns false), so no tokens would move." });
        else checks.push({ tone: "ok", text: "The network ran a dry run of this transaction and it succeeds." });
      } catch (e) {
        if (e instanceof RpcError) checks.push({ tone: "bad", text: `The network's dry run says this transaction would fail (${e.message}). Broadcasting would still cost the fee.` });
        else checks.push({ tone: "warn", text: "Couldn't run a dry run of this transaction." });
      }
    }

    const desc = C.describeTx(tx, { from, meta, token, tokenVerified, info, infoVerified });
    if (desc.kind === "unknown") checks.push({ tone: "bad", text: "This tool didn't build this transaction and can't explain it." });
    renderReview($("review"), desc, { kicker: "You are about to broadcast", checks });
    notice($("sigMsg"));
    const blocked = checks.some((c) => c.tone === "bad");
    S.checked = { d, desc, blocked };
    $("bcActs").hidden = false;
    $("bcBtn").disabled = blocked;
    $("bcBtn").className = desc.kind === "resign" ? "btn btn-danger" : "btn btn-primary";
    $("bcBtn").textContent = blocked ? "Can't broadcast: see the checks above" : desc.kind === "resign" ? "Broadcast: resign masternode" : "Broadcast transaction";
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { notice($("sigMsg"), "error", errMsg(e)); }
}

$("bcBtn").addEventListener("click", async () => {
  const c = S.checked;
  if (!c || c.blocked) return;
  const net = C.NETS[Number(c.d.tx.chainId)];
  $("bcBtn").disabled = true;
  notice($("bcMsg"), "", `<span class="progress"><span class="spinner"></span>Broadcasting…</span>`);
  let hash = c.d.hash;
  try {
    try { hash = await rpc("eth_sendRawTransaction", [c.d.raw]); }
    catch (e) { if (!/already known|known transaction/i.test(e.message)) throw e; }
    const link = `<a class="hash" href="${net.explorer}/tx/${hash}" target="_blank" rel="noopener">${hash}</a>`;
    notice($("bcMsg"), "", `<span class="progress"><span class="spinner"></span><span>Broadcast. Waiting for it to be mined… ${link}</span></span>`);
    $("g4").classList.add("done");
    clearPrepared();
    $("nonceIn").value = ""; $("gpIn").value = ""; $("glIn").value = "";
    let receipt = null;
    for (let i = 0; i < 45 && !receipt; i++) { await sleep(2000); receipt = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null); }
    if (!receipt) notice($("bcMsg"), "warn", `Broadcast, not mined yet. Follow it on the explorer: ${link}`);
    else if (Number(receipt.status) === 1) notice($("bcMsg"), "ok", `<strong>Done.</strong> ${esc(c.desc.title)} confirmed in block ${Number(receipt.blockNumber)}. ${link}<br><button type="button" class="btn btn-ghost btn-small" id="again" style="margin-top:0.6rem">Start another transaction</button>`);
    else notice($("bcMsg"), "error", `<strong>The transaction was mined but failed</strong> (reverted). The fee was spent. ${link}`);
    if (S.addr && S.addr === c.d.from) refreshAccount().then(() => { if (S.action === "withdraw") loadWithdrawals(); }).catch(() => {});
  } catch (e) {
    notice($("bcMsg"), "error", "The network refused it: " + errMsg(e));
    $("bcBtn").disabled = false;
  }
});

/* ================= Start ================= */
renderNet();
if (settings.addr && settings.addr[S.chainId]) $("addr").value = settings.addr[S.chainId];
const prev = tryPrepared();
if (prev && Date.now() / 1000 - prev.req.ts < 3600) { S.prepared = prev; showRequest(prev.req, prev.built); }
