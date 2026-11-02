// End-to-end: local chain (chain ID 50) with the real XDCValidator code at 0x…88,
// the online page served over http, the offline signer opened from file://.
// Every request and signed transaction travels as a QR code image decoded with jsQR.
// Run: node test/e2e.cjs   (needs `python3 -m http.server 8080` serving the parent of this repo)
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const ganache = require("ganache");
const { ethers } = require("ethers");
const { PNG } = require("pngjs");
const jsQR = require("jsqr");
const { chromium } = require("playwright");

const REPO = path.resolve(__dirname, "..");
const ONLINE = "http://localhost:8080/XDC_Offline_Signer/";
const OFFLINE = "file://" + REPO + "/offline/xdc-offline-signer.html";
const VALIDATOR = "0x0000000000000000000000000000000000000088";
const X = (n) => ethers.parseEther(String(n));
const SHOTS = "/home/claude/shots";

function compile() { return JSON.parse(fs.readFileSync(path.join(__dirname, ".contracts.json"), "utf8")); }

async function decodeCanvasQR(page, sel) {
  const url = await page.$eval(sel, (c) => c.toDataURL("image/png"));
  const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
  const r = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(r, "QR at " + sel + " did not decode");
  return r.data;
}

(async () => {
  // ---------- chain ----------
  const T = ethers.Wallet.createRandom();          // the "offline" wallet
  const funder = ethers.Wallet.createRandom();
  const C1 = ethers.Wallet.createRandom().address, C2 = ethers.Wallet.createRandom().address;
  const R = ethers.Wallet.createRandom().address;  // recipient
  const server = ganache.server({
    chain: { chainId: 50 }, logging: { quiet: true },
    wallet: { accounts: [{ secretKey: T.privateKey, balance: X(1000) }, { secretKey: funder.privateKey, balance: X(100000) }] },
  });
  await server.listen(8545);
  const prov = new ethers.JsonRpcProvider("http://localhost:8545", 50, { staticNetwork: true, cacheTimeout: -1 });
  const F = new ethers.Wallet(funder.privateKey, prov);
  const { V, T: TK, B: BT } = compile();

  // Deploy the validator normally, then copy its code and storage to 0x…88.
  const v = await new ethers.ContractFactory(V.abi, V.bytecode, F).deploy([C1, C2], [X(100), X(100)], T.address, X(100), X(25), 108, 4, 2);
  await v.waitForDeployment();
  const vAddr = await v.getAddress();
  await (await F.sendTransaction({ to: funder.address, value: 0 })).wait(); // new block so storageRangeAt sees the deploy
  const blk = await prov.getBlock("latest");
  const range = await prov.send("debug_storageRangeAt", [blk.hash, 0, vAddr, "0x00", 1000]);
  await prov.send("evm_setAccountCode", [VALIDATOR, await prov.getCode(vAddr)]);
  for (const { key, value } of Object.values(range.storage)) await prov.send("evm_setAccountStorageAt", [VALIDATOR, key, value]);
  await prov.send("evm_setAccountBalance", [VALIDATOR, ethers.toBeHex(X(200))]);
  const val = new ethers.Contract(VALIDATOR, V.abi, prov);
  assert.equal(await val.minVoterCap(), X(25));
  assert.equal(await val.getCandidateOwner(C1), T.address);
  const tok = await new ethers.ContractFactory(TK.abi, TK.bytecode, F).deploy(T.address, 50_000_000n); // 50 TKN (6 dp)
  await tok.waitForDeployment();
  const tokAddr = await tok.getAddress();
  console.log("chain ready; validator at 0x88 with candidates owned by", T.address);

  // ---------- browser ----------
  const b = await chromium.launch();
  const errs = [];
  const on = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const off = await b.newPage({ viewport: { width: 1280, height: 900 } });
  for (const [n, p] of [["online", on], ["offline", off]]) {
    p.on("pageerror", (e) => errs.push(n + ": " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/404|ERR_FILE_NOT_FOUND/.test(m.text())) errs.push(n + " console: " + m.text()); });
  }
  await on.goto(ONLINE);
  await on.evaluate(() => { localStorage.setItem("xdc-offline-signer", JSON.stringify({ chainId: 50, rpc: { 50: "http://localhost:8545" } })); sessionStorage.clear(); });
  await on.reload();
  await off.goto(OFFLINE);

  // offline: load key
  await off.fill("#pkIn", T.privateKey);
  await off.click("#pkLoad");
  assert.match(await off.textContent("#keyAddr"), new RegExp(T.address.slice(2), "i"));
  assert.equal(await off.inputValue("#pkIn"), "", "key input should be cleared");
  // address QR from offline -> online
  await off.click("#addrQrBtn");
  const addrText = await decodeCanvasQR(off, "#addrQr canvas");
  await on.fill("#addr", addrText);
  await on.click("#load");
  await on.waitForSelector("#acct:not([hidden])");
  console.log("online loaded", addrText, await on.textContent("#sBal"));

  let shotN = 0;
  async function prepare(action, fill, opts = {}) {
    await on.click(`#picker button[data-a="${action}"]`);
    if (fill) await fill();
    if (opts.withdrawRow !== undefined) {
      await on.waitForSelector("#wdBox button[data-wd]");
      await on.click(`#wdBox button[data-wd="${opts.withdrawRow}"]`);
    } else await on.click("#prep");
    await on.waitForFunction(() => { const m = document.querySelector("#prepMsg"); return m && !m.hidden && !m.querySelector(".spinner"); });
    const tone = await on.$eval("#prepMsg", (m) => m.dataset.tone);
    const text = await on.textContent("#prepMsg");
    if (opts.expectError) { assert.equal(tone, "error", text); assert.match(text, new RegExp(opts.expectError.source, "i")); return null; }
    assert.notEqual(tone, "error", text);
    if (opts.shot) await (await on.$("#g3")).screenshot({ path: `${SHOTS}/online-request-${action}.png` });
    return decodeCanvasQR(on, "#reqQr canvas");
  }

  async function signOffline(reqText, expectTitle, opts = {}) {
    await off.click('#reqSeg button[data-tab="paste"]');
    await off.fill("#pasteIn", reqText);
    await off.click("#pasteUse");
    await off.waitForSelector("#review:not([hidden])");
    const title = await off.textContent("#review h3");
    assert.equal(title, expectTitle);
    if (opts.resign) { assert.ok(await off.isDisabled("#signBtn")); await off.check("#resignChk"); }
    if (opts.shot) await (await off.$("#g3")).screenshot({ path: `${SHOTS}/offline-review-${opts.shot}.png` });
    await off.click("#signBtn");
    await off.waitForSelector("#out:not([hidden])");
    const raw = (await off.textContent("#sigRaw")).trim();
    const qr = await decodeCanvasQR(off, "#sigQr canvas");
    assert.equal(qr, raw, "signed QR content matches the hex shown");
    if (opts.shot) await (await off.$("#g4")).screenshot({ path: `${SHOTS}/offline-signed-${opts.shot}.png` });
    await off.click("#another");
    return qr;
  }

  async function broadcast(raw, expectTitle, opts = {}) {
    await on.evaluate(() => { document.querySelectorAll("details.settings").forEach((d) => (d.open = true)); });
    await on.fill("#sigPaste", raw);
    await on.click("#sigUse");
    await on.waitForSelector("#review:not([hidden])");
    await on.waitForFunction(() => !document.querySelector("#bcActs").hidden);
    assert.equal(await on.textContent("#review h3"), expectTitle);
    const checks = await on.$$eval("#review ul.checks li", (l) => l.map((x) => x.className + ": " + x.textContent));
    if (opts.shot) await (await on.$("#g4")).screenshot({ path: `${SHOTS}/online-verify-${opts.shot}.png` });
    if (opts.expectBlocked) { assert.ok(await on.isDisabled("#bcBtn"), "should be blocked"); return checks; }
    assert.ok(!checks.some((c) => c.startsWith("bad")), checks.join("\n"));
    assert.ok(checks.some((c) => /Matches, field for field/.test(c)), checks.join("\n"));
    await on.click("#bcBtn");
    await on.waitForFunction(() => { const m = document.querySelector("#bcMsg"); return m && !m.hidden && !m.querySelector(".spinner"); }, null, { timeout: 120000 });
    const msg = await on.textContent("#bcMsg");
    assert.match(msg, /Done\./, msg);
    if (opts.shot) await (await on.$("#g4")).screenshot({ path: `${SHOTS}/online-done-${opts.shot}.png` });
    await on.click("#bcClear");
    return checks;
  }

  const bal = () => prov.getBalance(T.address);

  // 1. Vote 30 XDC on C1
  let q = await prepare("vote", async () => { await on.fill("#cand", "xdc" + C1.slice(2)); await on.fill("#candAmt", "30"); }, { shot: true });
  let raw = await signOffline(q, "Vote for a masternode candidate", { shot: "vote" });
  await broadcast(raw, "Vote for a masternode candidate", { shot: "vote" });
  assert.equal(await val.getVoterCap(C1, T.address), X(130));
  console.log("✓ vote");

  // vote below the minimum is refused before signing
  await prepare("vote", async () => { await on.fill("#cand", C1); await on.fill("#candAmt", "10"); }, { expectError: /minimum vote/ });
  // owner can't unvote below minCandidateCap
  await prepare("unvote", async () => { await on.fill("#cand", C1); await on.fill("#candAmt", "31"); }, { expectError: /as the owner/ });
  console.log("✓ pre-checks refuse invalid vote/unvote");

  // 2. Unvote max (30)
  q = await prepare("unvote", async () => { await on.fill("#cand", C1); await on.click("#candLook"); await on.waitForFunction(() => /your stake/.test(document.querySelector("#candInfo").textContent)); await on.click("#candMax"); await on.waitForFunction(() => document.querySelector("#candAmt").value === "30"); });
  raw = await signOffline(q, "Unvote from a masternode candidate");
  await broadcast(raw, "Unvote from a masternode candidate");
  assert.equal(await val.getVoterCap(C1, T.address), X(100));
  console.log("✓ unvote (Use maximum respected the owner minimum)");

  // 3. Withdraw: locked first, then after blocks
  await on.click('#picker button[data-a="withdraw"]');
  await on.waitForSelector("#wdBox table");
  assert.match(await on.textContent("#wdBox"), /Locked/);
  for (let i = 0; i < 3; i++) await prov.send("evm_mine", []);
  let before = await bal();
  q = await prepare("withdraw", null, { withdrawRow: 0, shot: true });
  raw = await signOffline(q, "Withdraw unlocked stake", { shot: "withdraw" });
  await broadcast(raw, "Withdraw unlocked stake");
  let after = await bal();
  assert.ok(after > before + X(29.9), "withdraw paid out");
  console.log("✓ withdraw +", ethers.formatEther(after - before));

  // 4. Resign C2 (with the find-my-candidates helper)
  await on.$eval("#cand", (i) => (i.value = ""));
  await on.click('#picker button[data-a="resign"]');
  await on.click("#findMine");
  await on.waitForFunction(() => !document.querySelector("#mineBox .spinner"), null, { timeout: 60000 });
  assert.equal((await on.$$("#mineBox [data-use]")).length, 2);
  await on.click(`#mineBox [data-use="${C2.toLowerCase()}"]`);
  await on.waitForFunction(() => /you own/.test(document.querySelector("#candInfo").textContent));
  await prepare("resign", null, { expectError: /tick the box/ });
  q = await prepare("resign", async () => { await on.check("#resignChk"); });
  raw = await signOffline(q, "Resign a masternode", { resign: true, shot: "resign" });
  await broadcast(raw, "Resign a masternode", { shot: "resign" });
  assert.equal(await val.isCandidate(C2), false);
  for (let i = 0; i < 5; i++) await prov.send("evm_mine", []);
  before = await bal();
  q = await prepare("withdraw", null, { withdrawRow: 0 });
  raw = await signOffline(q, "Withdraw unlocked stake");
  await broadcast(raw, "Withdraw unlocked stake");
  after = await bal();
  assert.ok(after > before + X(99.9), "resign stake withdrawn");
  console.log("✓ resign + withdraw +", ethers.formatEther(after - before));

  // 5. Tokens: 12.5 then all
  q = await prepare("token", async () => { await on.fill("#tokAddr", tokAddr); await on.click("#tokLoad"); await on.waitForFunction(() => /Your balance/.test(document.querySelector("#tokInfo").textContent)); await on.fill("#tokTo", R); await on.fill("#tokAmt", "12.5"); });
  raw = await signOffline(q, "Send XRC-20 tokens", { shot: "token" });
  await broadcast(raw, "Send XRC-20 tokens", { shot: "token" });
  assert.equal(await tok.balanceOf(R), 12_500_000n);
  q = await prepare("token", async () => { await on.check("#tokAll"); });
  raw = await signOffline(q, "Send XRC-20 tokens");
  await broadcast(raw, "Send XRC-20 tokens");
  assert.equal(await tok.balanceOf(T.address), 0n);
  assert.equal(await tok.balanceOf(R), 50_000_000n);
  console.log("✓ token transfer and token send-all");
  const bad = await new ethers.ContractFactory(BT.abi, BT.bytecode, F).deploy(T.address, X(5)); await bad.waitForDeployment();
  await prepare("token", async () => { await on.uncheck("#tokAll"); await on.fill("#tokAddr", await bad.getAddress()); await on.click("#tokLoad"); await on.waitForFunction(() => /Your balance/.test(document.querySelector("#tokInfo").textContent)); await on.fill("#tokTo", R); await on.fill("#tokAmt", "1"); }, { expectError: /returned false/ });
  console.log("✓ token whose transfer returns false is refused before signing");

  // 6a. A comma amount is refused, never read as thousands
  await prepare("send", async () => { await on.fill("#sendTo", R); await on.fill("#sendAmt", "1,5"); }, { expectError: /no commas/ });
  console.log("✓ amount with a comma is refused");

  // 6. Send 1.5 XDC
  before = await prov.getBalance(R);
  q = await prepare("send", async () => { await on.fill("#sendTo", R); await on.fill("#sendAmt", "1.5"); });
  raw = await signOffline(q, "Send XDC");
  await broadcast(raw, "Send XDC");
  assert.equal(await prov.getBalance(R) - before, X(1.5));
  console.log("✓ send");

  // 7. Replay of an already-used nonce is blocked
  const checks = await broadcast(raw, "Send XDC", { expectBlocked: true });
  assert.ok(checks.some((c) => /already been used/.test(c)));
  console.log("✓ re-broadcast of a used nonce is blocked");

  // 8a. Upload KYC
  q = await prepare("kyc", async () => { await on.fill("#kycIn", "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"); });
  raw = await signOffline(q, "Upload KYC", { shot: "kyc" });
  await broadcast(raw, "Upload KYC", { shot: "kyc" });
  assert.equal(await val.getLatestKYC(T.address), "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  console.log("✓ upload KYC");

  // 8b. Propose a new candidate (min stake is prefilled from the contract)
  const C3 = ethers.Wallet.createRandom().address;
  q = await prepare("propose", async () => {
    await on.waitForFunction(() => /Minimum/.test(document.querySelector("#propHint").textContent));
    assert.equal(await on.inputValue("#propAmt"), "100");
    await on.fill("#propCand", "xdc" + C3.slice(2));
  }, { shot: true });
  raw = await signOffline(q, "Propose a new masternode", { shot: "propose" });
  await broadcast(raw, "Propose a new masternode", { shot: "propose" });
  assert.equal(await val.isCandidate(C3), true);
  assert.equal(await val.getCandidateOwner(C3), T.address);
  console.log("✓ propose: new candidate registered with this wallet as owner");

  // 8c. A wallet with no KYC and no history is refused before signing
  const W = ethers.Wallet.createRandom();
  await (await F.sendTransaction({ to: W.address, value: X(500) })).wait();
  await on.fill("#addr", W.address); await on.click("#load"); await on.waitForFunction(() => !document.querySelector("#acctMsg .spinner"));
  await prepare("propose", async () => { await on.fill("#propCand", ethers.Wallet.createRandom().address); }, { expectError: /no KYC on file/ });
  await on.fill("#addr", T.address); await on.click("#load"); await on.waitForFunction(() => !document.querySelector("#acctMsg .spinner"));
  console.log("✓ propose refused for a wallet without KYC");

  // 8d. Cancel a genuinely stuck transaction
  await prov.send("miner_stop", []);
  const gpNet = BigInt(await prov.send("eth_gasPrice", []));
  const Tw = new ethers.Wallet(T.privateKey, prov);
  const stuckNonce = await prov.getTransactionCount(T.address, "latest");
  const rBefore = await prov.getBalance(R);
  const stuck = await Tw.sendTransaction({ to: R, value: X(1), nonce: stuckNonce, gasPrice: gpNet, gasLimit: 21000, type: 0, chainId: 50 });
  await on.click("#load"); await on.waitForFunction(() => /pending/.test(document.querySelector("#sNonce").textContent));
  await prepare("send", async () => { await on.check("#sendAll"); await on.fill("#sendTo", R); }, { expectError: /still waiting to be mined/ });
  await on.uncheck("#sendAll");
  console.log("✓ send-all refused while an earlier transaction is pending");
  q = await prepare("cancel", async () => {
    await on.waitForFunction(() => /waiting to be mined/.test(document.querySelector("#cancelInfo").textContent));
    assert.equal(await on.inputValue("#cnNonce"), String(stuckNonce));
  }, { shot: true });
  raw = await signOffline(q, "Cancel a pending transaction", { shot: "cancel" });
  await on.evaluate(() => { document.querySelectorAll("details.settings").forEach((d) => (d.open = true)); });
  await on.fill("#sigPaste", raw); await on.click("#sigUse");
  await on.waitForFunction(() => !document.querySelector("#bcActs").hidden);
  const cchecks = await on.$$eval("#review ul.checks li", (l) => l.map((x) => x.className + ": " + x.textContent));
  assert.ok(cchecks.some((c) => /Replaces the pending transaction/.test(c)), cchecks.join("\n"));
  assert.ok(!cchecks.some((c) => c.startsWith("bad")), cchecks.join("\n"));
  await (await on.$("#g4")).screenshot({ path: `${SHOTS}/online-verify-cancel.png` });
  await on.click("#bcBtn");
  await on.waitForFunction(() => /Waiting for it to be mined/.test(document.querySelector("#bcMsg").textContent));
  await prov.send("miner_start", []);
  await on.waitForFunction(() => /Done\./.test(document.querySelector("#bcMsg").textContent), null, { timeout: 60000 });
  assert.equal(await prov.getBalance(R), rBefore, "the stuck 1 XDC transfer must not have happened");
  assert.equal(await prov.getTransactionCount(T.address, "latest"), stuckNonce + 1);
  assert.equal(await prov.getTransactionReceipt(stuck.hash), null);
  await on.click("#bcClear");
  console.log("✓ cancel: stuck transfer replaced; recipient received nothing");

  // 8e. Nonce gap: a transaction queued behind a missing nonce; an ordinary send fills the gap
  const lat = await prov.getTransactionCount(T.address, "latest");
  const rB = await prov.getBalance(R);
  await prov.send("miner_stop", []);
  await prov.send("eth_sendRawTransaction", [await T.signTransaction({ to: R, value: X(2), nonce: lat + 1, gasPrice: gpNet, gasLimit: 21000, type: 0, chainId: 50 })]); // skips nonce `lat`
  await prov.send("miner_start", []);
  await on.click("#load"); await on.waitForFunction(() => /behind a gap/.test(document.querySelector("#sNonce").textContent));
  assert.match(await on.textContent("#sNonce"), new RegExp("^" + lat + " "));
  q = await prepare("send", async () => { await on.fill("#sendTo", R); await on.fill("#sendAmt", "0.5"); });
  assert.equal(JSON.parse(q).nonce, lat, "fills the gap rather than queueing behind it");
  raw = await signOffline(q, "Send XDC");
  await broadcast(raw, "Send XDC");
  for (let i = 0; i < 20 && (await prov.getTransactionCount(T.address, "latest")) < lat + 2; i++) await new Promise((r) => setTimeout(r, 300));
  assert.equal(await prov.getTransactionCount(T.address, "latest"), lat + 2);
  assert.equal(await prov.getBalance(R) - rB, X(2.5));
  console.log("✓ nonce gap: page uses the missing nonce, which releases the queued transaction");

  // 8. Send everything -> exactly zero
  q = await prepare("send", async () => { await on.check("#sendAll"); await on.fill("#sendTo", R); }, { shot: true });
  raw = await signOffline(q, "Send all XDC", { shot: "sendall" });
  await broadcast(raw, "Send all XDC", { shot: "sendall" });
  assert.equal(await bal(), 0n, "wallet should be exactly empty");
  console.log("✓ send all: wallet balance is exactly 0");

  // 8f. Loading a different key clears any QR signed by the previous one
  await off.click('#reqSeg button[data-tab="paste"]'); await off.fill("#pasteIn", q); await off.click("#pasteUse");
  await off.click("#signBtn"); await off.waitForSelector("#out:not([hidden])");
  await off.click("#forget"); await off.fill("#pkIn", ethers.Wallet.createRandom().privateKey); await off.click("#pkLoad");
  assert.ok(await off.isHidden("#out"), "old signed QR must be cleared");
  assert.equal((await off.textContent("#sigRaw")).trim(), "");
  await off.click("#forget"); await off.fill("#pkIn", T.privateKey); await off.click("#pkLoad");
  console.log("✓ switching keys clears the previous signed QR");

  // 9. Wrong key is refused offline
  await off.click("#forget");
  await off.fill("#pkIn", ethers.Wallet.createRandom().privateKey);
  await off.click("#pkLoad");
  await off.click('#reqSeg button[data-tab="paste"]');
  await off.fill("#pasteIn", q);
  await off.click("#pasteUse");
  await off.waitForSelector("#review:not([hidden])");
  assert.ok(await off.isDisabled("#signBtn"));
  assert.match(await off.textContent("#review .checks"), /loaded key belongs to/);
  console.log("✓ signer refuses a request for a different address");

  // 10. Mnemonic auto-discovery in the UI
  const mw = ethers.HDNodeWallet.fromPhrase(ethers.Wallet.createRandom().mnemonic.phrase, "", "m/44'/550'/0'/0/4");
  const req2 = JSON.parse(q); req2.from = mw.address.toLowerCase();
  await off.click("#forget");
  await off.click('#reqSeg button[data-tab="paste"]');
  await off.fill("#pasteIn", JSON.stringify(req2));
  await off.click("#pasteUse");
  await off.click('#keySeg button[data-tab="mn"]');
  await off.fill("#mnIn", mw.mnemonic.phrase);
  await off.click("#mnLoad");
  await off.waitForSelector("#keyOn:not([hidden])");
  assert.match(await off.textContent("#keyHow"), /m\/44'\/550'\/0'\/0\/4 \(XDC.*found automatically/);
  assert.ok(!(await off.isDisabled("#signBtn")));
  console.log("✓ recovery phrase: account found automatically at m/44'/550'/0'/0/4");

  // 11. Manual entry builds the identical transaction
  const m = JSON.parse(q);
  await off.click('#reqSeg button[data-tab="manual"]');
  await off.selectOption("#mAction", "sendAll");
  await off.fill("#mFrom", "xdc" + mw.address.slice(2).toLowerCase());
  await off.fill("#mNonce", String(m.nonce)); await off.fill("#mGas", String(m.gas));
  await off.fill("#mGp", ethers.formatUnits(m.gasPrice, 9));
  await off.fill("#mf_to", R); await off.fill("#mf_balance", ethers.formatEther(m.args.balance));
  await off.click("#mUse");
  await off.waitForSelector("#review:not([hidden])");
  await off.click("#signBtn");
  const manualRaw = (await off.textContent("#sigRaw")).trim();
  const pasted = (() => { const r = { ...req2 }; return r; })();
  const t1 = ethers.Transaction.from(manualRaw);
  assert.equal(t1.from, mw.address); assert.equal(t1.to, R); assert.equal(t1.value + t1.gasLimit * t1.gasPrice, BigInt(m.args.balance));
  console.log("✓ manual entry produces the same send-all transaction");

  // 12. Recovery phrase on an old-menu path (Ethereum Classic, index 2) is found automatically
  const phrase = ethers.Wallet.createRandom().mnemonic.phrase;
  const etc = ethers.HDNodeWallet.fromPhrase(phrase, "", "m/44'/61'/0'/0/2");
  const r3 = JSON.parse(q); r3.from = etc.address.toLowerCase();
  await off.click("#forget");
  await off.click('#reqSeg button[data-tab="paste"]'); await off.fill("#pasteIn", JSON.stringify(r3)); await off.click("#pasteUse");
  await off.click('#keySeg button[data-tab="mn"]'); await off.fill("#mnIn", phrase); await off.click("#mnLoad");
  await off.waitForSelector("#keyOn:not([hidden])");
  assert.match(await off.textContent("#keyHow"), /m\/44'\/61'\/0'\/0\/2 \(Ethereum Classic \(old XinFin wallet menu\)\)/);
  console.log("✓ recovery phrase: old-wallet Ethereum Classic path found automatically");

  // 13. Custom path with i placeholder (m/44'/60'/i'/0/0, index 3), found automatically
  const cw = ethers.HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/3'/0/0");
  r3.from = cw.address.toLowerCase();
  await off.click("#forget");
  await off.click('#reqSeg button[data-tab="paste"]'); await off.fill("#pasteIn", JSON.stringify(r3)); await off.click("#pasteUse");
  await off.click('#keySeg button[data-tab="mn"]'); await off.fill("#mnIn", phrase);
  await off.click("#kMn details summary");
  await off.selectOption("#mnPath", "custom"); await off.fill("#mnCustom", "m/44'/60'/i'/0/0");
  await off.click("#mnLoad");
  await off.waitForSelector("#keyOn:not([hidden])");
  assert.match(await off.textContent("#keyHow"), /m\/44'\/60'\/3'\/0\/0 \(Custom path\)/);
  console.log("✓ custom path with i placeholder found automatically");

  // 14. Address browser: no keys shown, match highlighted, Use loads it
  const xw = ethers.HDNodeWallet.fromPhrase(phrase, "", "m/44'/550'/0'/0/13");
  r3.from = xw.address.toLowerCase();
  await off.click("#forget");
  await off.click('#reqSeg button[data-tab="paste"]'); await off.fill("#pasteIn", JSON.stringify(r3)); await off.click("#pasteUse");
  await off.click('#keySeg button[data-tab="mn"]'); await off.fill("#mnIn", phrase);
  await off.selectOption("#mnPath", "xdc");
  await off.click("#mnBrowse"); await off.click("#brNext");
  const browseText = await off.textContent("#browse");
  assert.ok(browseText.includes(ethers.getAddress(xw.address).slice(2)), "address 13 listed");
  assert.ok(!/[0-9a-f]{64}/i.test(browseText), "no private keys in the browser");
  assert.match(browseText, /matches the request/);
  await (await off.$("#g1")).screenshot({ path: `${SHOTS}/offline-browser.png` });
  await off.click('#browseRows [data-idx="13"]');
  await off.waitForSelector("#keyOn:not([hidden])");
  assert.ok(!(await off.isDisabled("#signBtn")));
  console.log("✓ address browser lists addresses only and loads the chosen one");

  await on.screenshot({ path: `${SHOTS}/online-top.png` });
  console.log(errs.length ? "PAGE ERRORS:\n" + errs.join("\n") : "no page errors");
  await b.close(); await server.close();
  if (errs.length) process.exit(1);
  console.log("ALL E2E TESTS PASSED");
})().catch(async (e) => { console.error(e); process.exit(1); });
