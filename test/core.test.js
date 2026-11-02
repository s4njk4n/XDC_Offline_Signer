import * as C from "../src/core.js";
import { Transaction, Wallet, Interface, getAddress } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";
import assert from "node:assert/strict";

// 1. selectors match the ones the Stake Desk already uses on mainnet
assert.equal(C.FUNCS.vote.selector, "0x6dd7d8ea");
assert.equal(C.FUNCS.unvote.selector, "0x02aa9be2");
assert.equal(C.FUNCS.withdraw.selector, "0x441a3e70");
assert.equal(C.FUNCS.transfer.selector, "0xa9059cbb");
assert.equal(C.VIEWS.getWithdrawBlockNumbers, "0x2f9c4bba");
assert.equal(C.VIEWS.minVoterCap, "0xf8ac9dd5");
const iface = new Interface(["function resign(address)","function vote(address)","function unvote(address,uint256)","function withdraw(uint256,uint256)","function transfer(address,uint256)","function propose(address)","function uploadKYC(string)"]);
assert.equal(C.FUNCS.resign.selector, iface.getFunction("resign").selector);
console.log("resign selector", C.FUNCS.resign.selector);

// 2. units / addresses
assert.equal(C.parseUnits("1234.5"), 1234500000000000000000n);
for (const s of ["12,5", "1,500", "0,25"]) assert.throws(() => C.parseUnits(s), /no commas/);
assert.equal(C.parseUnits("1 500.5"), 1500500000000000000000n);
assert.equal(C.formatUnits(1234500000000000000000n), "1,234.5");
assert.equal(C.formatUnits(1n), "0.000000000000000001");
assert.throws(() => C.parseUnits("1.0000000000000000001"));
const addr = Wallet.createRandom().address;
assert.equal(C.checksum(addr), getAddress(addr));
assert.equal(C.normAddr("xdc" + addr.slice(2)), addr.toLowerCase());
const bad = addr.slice(0,-1) + (addr.at(-1) === "a" ? "b" : "a");
if (bad.slice(2) !== bad.slice(2).toLowerCase()) assert.throws(() => C.normAddr("xdc"+getAddress(addr).slice(2,-1)+(getAddress(addr).at(-1)==="A"?"B":"A")));

// 3. every action: build -> sign -> parse with ethers
let n = 0;
for (let i = 0; i < 40; i++) {
  const w = Wallet.createRandom();
  const priv = C.parsePrivateKey(w.privateKey);
  assert.equal(C.privToAddress(priv), w.address.toLowerCase());
  const other = Wallet.createRandom().address;
  const base = { chainId: i % 2 ? 51 : 50, from: w.address, nonce: i * 37, gasPrice: 12500000000n + BigInt(i), gasLimit: 21000 + i * 1000 };
  const cases = [
    ["send", { to: other, amount: 10n ** 18n * BigInt(i + 1) + 7n }],
    ["sendAll", { to: "xdc" + other.slice(2), balance: 5n * 10n ** 18n + BigInt(i) }],
    ["token", { token: other, to: w.address, amount: 123456789n, decimals: 6, symbol: "USDT<script>" }],
    ["vote", { candidate: other, amount: 25000n * 10n ** 18n }],
    ["unvote", { candidate: other, amount: 25000n * 10n ** 18n }],
    ["resign", { candidate: other }],
    ["withdraw", { blockNumber: 89000000n + BigInt(i), index: i }],
    ["cancel", {}],
  ];
  for (const [action, args] of cases) {
    const req = C.makeRequest({ ...base, ...(action === "cancel" ? { gasLimit: 21000 } : {}), action, args });
    const req2 = C.parseRequest(JSON.stringify(req));
    const { tx, from } = C.buildFromRequest(req2);
    assert.equal(from, w.address.toLowerCase());
    const { raw, hash } = C.signTx(tx, priv);
    const et = Transaction.from(raw);
    assert.equal(et.from, w.address); assert.equal(et.hash, hash);
    assert.equal(et.chainId, BigInt(base.chainId)); assert.equal(et.type, 0);
    assert.equal(et.nonce, Number(tx.nonce)); assert.equal(et.gasPrice, tx.gasPrice); assert.equal(et.gasLimit, tx.gasLimit);
    assert.equal(et.value, tx.value); assert.equal(et.data, tx.data); assert.equal(et.to.toLowerCase(), tx.to);
    // unsigned form matches ethers' EIP-155 unsigned serialization
    const u = Transaction.from({ type: 0, chainId: base.chainId, nonce: Number(tx.nonce), gasPrice: tx.gasPrice, gasLimit: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data });
    assert.equal(C.unsignedRaw(tx), u.unsignedSerialized);
    // our own decoder agrees
    const d = C.decodeRawTx(raw);
    assert.ok(d.signed); assert.equal(d.from, w.address.toLowerCase()); assert.equal(d.hash, hash);
    for (const k of ["nonce","gasPrice","gasLimit","value","chainId"]) assert.equal(d.tx[k], tx[k]);
    assert.equal(d.tx.data, tx.data); assert.equal(d.tx.to, tx.to);
    const du = C.decodeRawTx(C.unsignedRaw(tx)); assert.ok(!du.signed); assert.equal(du.tx.chainId, tx.chainId);
    // calldata decodes the same as ethers
    if (tx.data !== "0x") {
      const ours = C.decodeCall(tx.data), theirs = iface.parseTransaction({ data: tx.data });
      assert.equal(ours.sig, theirs.signature);
      theirs.args.forEach((v, j) => assert.equal(String(Object.values(ours.args)[j]).toLowerCase(), String(v).toLowerCase()));
    }
    if (action === "cancel") { assert.equal(tx.to, from); assert.equal(tx.value, 0n); }
    if (action === "sendAll") assert.equal(tx.value + tx.gasLimit * tx.gasPrice, args.balance);
    const desc = C.describeTx(tx, { from, meta: C.buildFromRequest(req2).meta, token: C.buildFromRequest(req2).meta.token });
    assert.equal(desc.kind, action); assert.equal(desc.warnings.length, action === "resign" ? 1 : 0, action + " " + desc.warnings);
    n++;
  }
}
console.log("cross-checked", n, "signed transactions against ethers");

// 4. rejects tampered / odd input
assert.throws(() => C.decodeRawTx("0x02f8"), /type-2/);
assert.throws(() => C.buildFromRequest({ xdcsign:1, chain: 1, from: addr, nonce:0, gasPrice:"1", gas:21000, action:"send", args:{to:addr, amount:"1"} }), /unknown network/);
assert.throws(() => C.buildFromRequest({ xdcsign:1, chain: 50, from: addr, nonce:0, gasPrice:"1", gas:21000, action:"evil", args:{} }), /unknown action/);
const w = Wallet.createRandom();
const legacy = await w.signTransaction({ type: 0, nonce: 0, gasPrice: 1, gasLimit: 21000, to: addr, value: 1 }); // no chainId -> pre-155
assert.throws(() => C.decodeRawTx(legacy), /without a chain ID/);
// Propose and KYC are no longer built, but are still recognised and flagged
for (const action of ["propose", "kyc"]) assert.throws(() => C.buildFromRequest({ xdcsign:1, chain:50, from: addr, nonce:0, gasPrice:"1", gas:300000, action, args:{ candidate: addr, amount: "1", hash: "Qm" } }), /doesn't create/);
for (const [fn, a, value] of [["propose", [addr], 10n ** 25n], ["uploadKYC", ["QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"], 0n]]) {
  const d = C.describeTx({ chainId: 50n, nonce: 0n, gasPrice: 1n, gasLimit: 300000n, to: C.VALIDATOR, value, data: C.encodeCall(fn, a) }, { from: addr });
  assert.equal(d.kind, fn === "propose" ? "propose" : "kyc");
  assert.ok(d.warnings.some((w) => /doesn't create/.test(w)));
  const ifc = iface.parseTransaction({ data: C.encodeCall(fn, a) }); assert.equal(ifc.name, fn);
}
assert.throws(() => C.buildFromRequest({ xdcsign:1, chain:50, from: addr, nonce:0, gasPrice:"1", gas:30000, action:"cancel", args:{} }), /21,000/);
// a malformed display-only info value can't break the review
const wtx = C.buildFromRequest(C.makeRequest({ chainId: 50, from: addr, nonce: 1, gasPrice: 1n, gasLimit: 300000, action: "withdraw", args: { blockNumber: 5n, index: 0 } })).tx;
assert.equal(C.describeTx(wtx, { info: { amount: "not a number" } }).kind, "withdraw");
// tampered string padding is rejected by the decoder
const kd = C.encodeCall("uploadKYC", ["abc"]); assert.ok(C.decodeCall(kd).args);
assert.ok(C.decodeCall(kd.slice(0, -2) + "01").error);
console.log("all core tests passed");
