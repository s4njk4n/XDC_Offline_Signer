// XDC Offline Signer: the offline half. Runs from a single local HTML file.
import * as C from "./core.js";
import { decryptKeystore, PATHS, seedFrom, derive, findAccount, addresses, checkPath, wipe } from "./keys.js";
import { showQR, Scanner } from "./qr.js";
import { $, esc, notice, errMsg, enableQrZoom, renderReview, setTabs } from "./ui.js";
enableQrZoom();

const S = {
  priv: null,        // Uint8Array, in memory only
  addr: null,        // lowercase 0x
  root: null,        // HDKey when loaded from a phrase (to find other accounts)
  how: "",
  req: null,         // parsed request
  built: null,       // { tx, from, meta }
};

/* ---------------- Network status ---------------- */
function netStatus() {
  const on = navigator.onLine;
  $("netPill").classList.toggle("bad", on);
  $("netText").textContent = on ? "Network detected" : "No network";
  $("onlineWarn").hidden = !on;
}
addEventListener("online", netStatus); addEventListener("offline", netStatus); netStatus();

/* ---------------- Key loading ---------------- */
setTabs($("keySeg"));
for (const p of PATHS) $("mnPath").add(new Option(`${p.label}   ${p.base}${p.base.includes("i") ? "" : "/i"}`, p.id));
$("mnPath").add(new Option("Custom path…", "custom"));
$("mnPath").addEventListener("change", () => { $("mnCustomF").hidden = $("mnPath").value !== "custom"; $("browse").hidden = true; });

// The chosen base path (or a custom one) from the form.
function chosenBase() {
  if ($("mnPath").value === "custom") return checkPath($("mnCustom").value);
  return PATHS.find((x) => x.id === $("mnPath").value).base;
}
const customExtra = () => ($("mnPath").value === "custom" && $("mnCustom").value.trim() ? [checkPath($("mnCustom").value)] : []);
const depth = () => Number($("mnDepth").value) || 20;
const shown = (base, i) => (base.includes("i") ? base.replace("i", i) : `${base}/${i}`);

$("pkShow").addEventListener("click", () => {
  const i = $("pkIn"); const show = i.type === "password";
  i.type = show ? "text" : "password"; $("pkShow").textContent = show ? "Hide" : "Show";
});
$("mnShow").addEventListener("click", () => {
  const m = $("mnIn").classList.toggle("mask");
  $("mnShow").textContent = m ? "Show words" : "Hide words";
});

function setKey(priv, how, root = null) {
  const changed = !S.priv || C.privToAddress(priv) !== S.addr;
  forgetKey(true, root);
  if (changed) clearOutput(); // never leave a QR signed by a different key on screen
  S.priv = priv; S.addr = C.privToAddress(priv); S.how = how; S.root = root;
  $("keyAddr").textContent = C.toXdc(S.addr);
  $("keyHow").textContent = how;
  $("keyForms").hidden = true; $("keyOn").hidden = false;
  $("addrQrBox").hidden = true; $("addrQrBtn").textContent = "Show address QR";
  $("g1").classList.add("done");
  notice($("keyMsg"));
  // Clear inputs so the secret isn't left sitting in the DOM.
  $("pkIn").value = ""; $("ksPw").value = ""; $("mnIn").value = ""; $("mnPass").value = ""; $("ksFile").value = "";
  if (!$("mFrom").value) $("mFrom").value = C.toXdc(S.addr);
  refresh();
}

function forgetKey(silent, keepRoot = null) {
  wipe(S.priv);
  if (S.root && S.root !== keepRoot && S.root.wipePrivateData) S.root.wipePrivateData();
  S.priv = null; S.addr = null; S.root = null; S.how = "";
  $("keyForms").hidden = false; $("keyOn").hidden = true; $("addrQr").replaceChildren();
  $("g1").classList.remove("done");
  if (!silent) { notice($("keyMsg"), "ok", "Key removed from memory."); clearOutput(); refresh(); }
}
$("forget").addEventListener("click", () => forgetKey(false));
addEventListener("pagehide", () => wipe(S.priv));

$("addrQrBtn").addEventListener("click", () => {
  const box = $("addrQrBox"); box.hidden = !box.hidden;
  $("addrQrBtn").textContent = box.hidden ? "Show address QR" : "Hide address QR";
  if (!box.hidden) showQR($("addrQr"), C.toXdc(S.addr), { px: 8 });
});

$("pkLoad").addEventListener("click", () => {
  try { setKey(C.parsePrivateKey($("pkIn").value), "Loaded from a private key."); }
  catch (e) { notice($("keyMsg"), "error", errMsg(e)); }
});

$("ksLoad").addEventListener("click", async () => {
  const f = $("ksFile").files[0];
  if (!f) return notice($("keyMsg"), "error", "Choose your keystore file first.");
  const btn = $("ksLoad"); btn.disabled = true;
  try {
    const text = await f.text();
    notice($("keyMsg"), "", `<span class="progress"><span class="spinner"></span><span id="ksProg">Unlocking… this can take a few seconds</span></span>`);
    let last = 0;
    const priv = await decryptKeystore(text, $("ksPw").value, (p) => {
      const pct = Math.floor(p * 100);
      if (pct !== last && $("ksProg")) { last = pct; $("ksProg").textContent = `Unlocking… ${pct}%`; }
    });
    setKey(priv, `Unlocked from keystore file ${f.name}.`);
  } catch (e) { notice($("keyMsg"), "error", errMsg(e)); }
  finally { btn.disabled = false; }
});

$("mnLoad").addEventListener("click", () => {
  const btn = $("mnLoad"); btn.disabled = true;
  notice($("keyMsg"), "", `<span class="progress"><span class="spinner"></span>Deriving…</span>`);
  // Let the spinner paint before the (synchronous) derivation work.
  setTimeout(() => {
    try {
      const root = seedFrom($("mnIn").value, $("mnPass").value);
      if (S.req) {
        const target = C.normAddr(S.req.from);
        const hit = findAccount(root, target, { maxIndex: depth(), extra: customExtra() });
        if (!hit) throw new Error(`none of the first ${depth()} accounts on any of the ${PATHS.length} known paths${customExtra().length ? " or your custom path" : ""} gives the request's address ${C.toXdc(target)}. Check the phrase and the passphrase (extra word), search deeper, or use “Browse addresses”.`);
        return setKey(hit.priv, `Derived from your recovery phrase at ${hit.full} (${hit.path.label}), found automatically.`, root);
      }
      const base = chosenBase();
      const idx = Number($("mnIdx").value);
      if (!Number.isInteger(idx) || idx < 0) throw new Error("account index must be 0 or more");
      setKey(derive(root, base, idx), `Derived from your recovery phrase at ${shown(base, idx)}.`, root);
    } catch (e) { notice($("keyMsg"), "error", errMsg(e)); }
    finally { btn.disabled = false; }
  }, 30);
});

// Address browser: addresses only, never keys.
let br = null; // { root, base, from }
function drawBrowse() {
  const rows = addresses(br.root, br.base, br.from, 10);
  const want = S.req ? C.normAddr(S.req.from) : null;
  $("browseRows").innerHTML = rows.map((r) => `<tr><td>${r.index}</td><td class="mono">${esc(C.toXdc(r.address))}${want === r.address ? ' <span class="kind kind-ok">matches the request</span>' : ""}</td><td><button type="button" class="btn btn-ghost btn-small" data-idx="${r.index}">Use this one</button></td></tr>`).join("");
  $("brPath").textContent = `${shown(br.base, br.from)} to ${shown(br.base, br.from + 9)}`;
  $("brPrev").disabled = br.from === 0;
  $("browse").hidden = false;
  $("browseRows").querySelectorAll("[data-idx]").forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.idx);
    setKey(derive(br.root, br.base, i), `Derived from your recovery phrase at ${shown(br.base, i)} (chosen in the address browser).`, br.root);
    $("browse").hidden = true; br = null;
  }));
}
$("mnBrowse").addEventListener("click", () => {
  try { br = { root: seedFrom($("mnIn").value, $("mnPass").value), base: chosenBase(), from: 0 }; drawBrowse(); notice($("keyMsg")); }
  catch (e) { notice($("keyMsg"), "error", errMsg(e)); }
});
$("brNext").addEventListener("click", () => { br.from += 10; drawBrowse(); });
$("brPrev").addEventListener("click", () => { br.from = Math.max(0, br.from - 10); drawBrowse(); });

/* ---------------- Request loading ---------------- */
const reqTab = setTabs($("reqSeg"), (t) => { if (t !== "scan") scanner.stop(); });

const scanner = new Scanner($("video"), {
  onResult(text) {
    try { loadRequest(text); return true; }
    catch (e) {
      $("camState").textContent = "Not a signing request: " + (e.message || e);
      return false;
    }
  },
  onError(e) { notice($("reqMsg"), "error", errMsg(e)); $("cam").hidden = true; },
  onState(on) {
    $("cam").hidden = !on; $("camStop").hidden = !on; $("camStart").hidden = on;
    if (on) { $("camState").textContent = "Looking for a QR code…"; listCams(); }
  },
});
async function listCams() {
  const cams = await scanner.cameras();
  const sel = $("camSel");
  if (cams.length < 2) { sel.hidden = true; return; }
  sel.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId)));
  if (scanner.deviceId) sel.value = scanner.deviceId;
  sel.hidden = false;
}
$("camSel").addEventListener("change", (e) => scanner.start(e.target.value));
$("camStart").addEventListener("click", () => { notice($("reqMsg")); scanner.start($("camSel").value || undefined); });
$("camStop").addEventListener("click", () => scanner.stop());

$("pasteUse").addEventListener("click", () => {
  try { loadRequest($("pasteIn").value.trim()); } catch (e) { notice($("reqMsg"), "error", errMsg(e)); }
});

function loadRequest(text) {
  const req = C.parseRequest(text);
  const built = C.buildFromRequest(req); // throws on anything invalid
  S.req = req; S.built = built;
  clearOutput();
  // If the key came from a phrase and the request is for another account on it, switch to that account.
  if (S.root && S.addr !== built.from) {
    let extra = [];
    try { extra = customExtra(); } catch {}
    const hit = findAccount(S.root, built.from, { maxIndex: depth(), extra });
    if (hit) setKey(hit.priv, `Derived from your recovery phrase at ${hit.full} (${hit.path.label}), found automatically.`, S.root);
  }
  const when = req.ts ? new Date(req.ts * 1000).toLocaleString() : "unknown time";
  notice($("reqMsg"), "ok", `<strong>Request loaded:</strong> ${esc(C.ACTIONS[req.action])} on ${esc(C.NETS[req.chain].name)}, prepared ${esc(when)}.`);
  $("g2").classList.add("done");
  refresh();
  $("g3").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("discard").addEventListener("click", () => {
  S.req = null; S.built = null; clearOutput();
  $("g2").classList.remove("done"); notice($("reqMsg")); refresh();
});

/* ---------------- Manual entry ---------------- */
const FIELDS = {
  send:     [["to", "Recipient address", "addr"], ["amount", "Amount", "xdc"]],
  sendAll:  [["to", "Recipient address", "addr"], ["balance", "Exact current balance", "xdc", "The full balance shown on the online page, to the last decimal. The signer sends this minus the network fee."]],
  token:    [["token", "Token contract address", "addr"], ["to", "Recipient address", "addr"], ["amount", "Amount", "tok"], ["decimals", "Token decimals", "int"], ["symbol", "Token symbol", "text"]],
  vote:     [["candidate", "Candidate (masternode) address", "addr"], ["amount", "Stake to vote", "xdc"]],
  unvote:   [["candidate", "Candidate (masternode) address", "addr"], ["amount", "Amount to unvote", "xdc"]],
  resign:   [["candidate", "Candidate (masternode) address", "addr"]],
  withdraw: [["blockNumber", "Unlock block number", "int"], ["index", "Queue index", "int"]],
  propose:  [["candidate", "Candidate (node) address", "addr"], ["amount", "Stake", "xdc"]],
  kyc:      [["hash", "KYC reference (IPFS hash)", "str"]],
  cancel:   [],
};
const DEFAULT_GAS = { send: 21000, sendAll: 21000, token: 120000, vote: 500000, unvote: 500000, resign: 500000, withdraw: 500000, propose: 600000, kyc: 400000, cancel: 21000 };
for (const [k, v] of Object.entries(C.ACTIONS)) $("mAction").add(new Option(v, k));

function drawManual() {
  const a = $("mAction").value;
  $("mFields").innerHTML = (a === "cancel" ? `<p class="hint">Sends 0 XDC from the address above to itself. Use the stuck transaction's nonce and a gas price at least 10% higher than it had.</p>` : "") + FIELDS[a].map(([k, label, kind, hint]) => {
    const id = "mf_" + k;
    const input = kind === "xdc" || kind === "tok"
      ? `<div class="amount"><input id="${id}" type="text" inputmode="decimal" autocomplete="off"><span class="suffix">${kind === "xdc" ? "XDC" : "tokens"}</span></div>`
      : `<input id="${id}" type="text" ${kind === "addr" ? 'class="mono" placeholder="xdc…" spellcheck="false"' : ""} ${kind === "int" ? 'inputmode="numeric"' : ""} autocomplete="off">`;
    return `<div class="field"><label for="${id}">${esc(label)}</label>${input}${hint ? `<p class="hint">${esc(hint)}</p>` : ""}</div>`;
  }).join("");
  const g = $("mGas");
  if (!g.value || Object.values(DEFAULT_GAS).includes(Number(g.value))) g.value = DEFAULT_GAS[a];
}
$("mAction").addEventListener("change", drawManual);
drawManual();

$("mUse").addEventListener("click", () => {
  try {
    const a = $("mAction").value;
    const args = {};
    const dec = a === "token" ? Number($("mf_decimals").value) : 18;
    if (a === "token" && (!Number.isInteger(dec) || dec < 0 || dec > 36)) throw new Error("token decimals must be a whole number such as 18 or 6");
    for (const [k, label, kind] of FIELDS[a]) {
      const v = $("mf_" + k).value.trim();
      if (!v && kind !== "text") throw new Error(label + " is empty");
      if (kind === "str") { args[k] = v; continue; }
      if (kind === "addr") args[k] = C.normAddr(v, label.toLowerCase());
      else if (kind === "xdc") args[k] = C.parseUnits(v, 18).toString();
      else if (kind === "tok") args[k] = C.parseUnits(v, dec).toString();
      else if (kind === "int") args[k] = k === "decimals" ? dec : C.toBig(v, label.toLowerCase()).toString();
      else args[k] = v;
    }
    const req = C.makeRequest({
      chainId: Number($("mNet").value), from: C.normAddr($("mFrom").value, "from address"),
      nonce: Number(C.toBig($("mNonce").value, "nonce")), gasPrice: C.parseUnits($("mGp").value || "0", 9),
      gasLimit: Number(C.toBig($("mGas").value, "gas limit")), action: a, args,
    });
    loadRequest(JSON.stringify(req));
  } catch (e) { notice($("reqMsg"), "error", errMsg(e)); }
});

/* ---------------- Review + sign ---------------- */
function refresh() {
  const b = S.built;
  const ready = !!(b && S.priv);
  $("reviewEmpty").hidden = !!b;
  $("reviewEmpty").textContent = "Load your key and a signing request first.";
  $("signActs").hidden = !b;
  if (!b) { $("review").hidden = true; $("resignAck").hidden = true; notice($("signMsg")); return; }

  const checks = [];
  let ok = true;
  if (!S.priv) { checks.push({ tone: "warn", text: "Load the key for this address in step 1 to sign." }); ok = false; }
  else if (S.addr !== b.from) {
    checks.push({ tone: "bad", text: `The request is for ${C.toXdc(b.from)}, but the loaded key belongs to ${C.toXdc(S.addr)}. Load the right key, or prepare a new request for this address.` });
    ok = false;
  } else checks.push({ tone: "ok", text: "The loaded key matches the request's address." });
  checks.push({ tone: "ok", text: `Chain ID ${b.tx.chainId} is ${C.NETS[Number(b.tx.chainId)].name}; the signature is valid only there.` });

  const desc = C.describeTx(b.tx, { from: b.from, meta: b.meta, token: b.meta.token, info: S.req.info });
  renderReview($("review"), desc, { kicker: "You are about to sign", checks });
  const resign = desc.kind === "resign";
  $("resignAck").hidden = !resign;
  if (!resign) $("resignChk").checked = false;
  $("signBtn").disabled = !ready || !ok || (resign && !$("resignChk").checked);
  if (desc.kind === "resign") $("signBtn").className = "btn btn-danger"; else $("signBtn").className = "btn btn-primary";
}
$("resignChk").addEventListener("change", refresh);

$("signBtn").addEventListener("click", () => {
  try {
    const b = S.built;
    if (!S.priv || S.addr !== b.from) throw new Error("the loaded key does not match the request");
    const { raw, hash } = C.signTx(b.tx, S.priv);
    // Verify our own output before showing it.
    const d = C.decodeRawTx(raw);
    const same = ["nonce", "gasPrice", "gasLimit", "value", "chainId"].every((k) => d.tx[k] === b.tx[k]);
    if (d.from !== b.from || !same || d.tx.to !== b.tx.to || d.tx.data !== b.tx.data)
      throw new Error("self-check failed after signing; nothing was output");
    const uns = C.unsignedRaw(b.tx);
    showQR($("sigQr"), raw, { px: 8 });
    showQR($("unsQr"), uns, { px: 8 });
    $("sigRaw").textContent = raw; $("unsRaw").textContent = uns; $("sigHash").textContent = hash;
    $("out").hidden = false; $("outEmpty").hidden = true;
    outTab("signed");
    $("g3").classList.add("done"); $("g4").classList.add("done");
    notice($("signMsg"), "ok", "Signed. Scan the code in step 4 with the online page.");
    $("g4").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { notice($("signMsg"), "error", errMsg(e)); }
});

const outTab = setTabs($("outSeg"));
function clearOutput() {
  $("out").hidden = true; $("outEmpty").hidden = false;
  $("sigQr").replaceChildren(); $("unsQr").replaceChildren(); $("sigRaw").textContent = ""; $("unsRaw").textContent = "";
  $("g3").classList.remove("done"); $("g4").classList.remove("done");
  notice($("signMsg"));
}
$("another").addEventListener("click", () => {
  S.req = null; S.built = null; clearOutput(); $("g2").classList.remove("done"); notice($("reqMsg")); refresh();
  reqTab("scan"); $("g2").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("doneForget").addEventListener("click", () => {
  S.req = null; S.built = null; $("g2").classList.remove("done"); notice($("reqMsg"));
  forgetKey(false); scrollTo({ top: 0, behavior: "smooth" });
});

refresh();
