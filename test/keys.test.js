import { decryptKeystore, seedFrom, derive, findAccount, addresses, PATHS } from "../src/keys.js";
import * as C from "../src/core.js";
import { Wallet, HDNodeWallet, Mnemonic, encryptKeystoreJson } from "ethers";
const enc = (w, pw, o) => encryptKeystoreJson({ address: w.address, privateKey: w.privateKey }, pw, o);
import assert from "node:assert/strict";
// keystore: ethers (scrypt), plus a light-scrypt one like old MEW writes (n=8192), plus pbkdf2
const w = Wallet.createRandom();
for (const N of [8192, 131072]) {
  const json = await enc(w, "p@ss wörd", { scrypt: { N } });
  const k = await decryptKeystore(json, "p@ss wörd");
  assert.equal(C.privToAddress(k), w.address.toLowerCase());
  await assert.rejects(decryptKeystore(json, "wrong"), /wrong password/);
}
// xdc-prefixed address field as written by the XDC web wallet
const j = JSON.parse(await enc(w, "x", { scrypt: { N: 1024 } })); j.address = "xdc" + w.address.slice(2).toLowerCase();
assert.equal(C.privToAddress(await decryptKeystore(JSON.stringify(j), "x")), w.address.toLowerCase());
console.log("keystore ok");
// mnemonic paths vs ethers
const m = Mnemonic.fromEntropy(Wallet.createRandom().privateKey.slice(0, 34));
assert.equal(PATHS.length, 32); assert.equal(new Set(PATHS.map((p) => p.base)).size, 32);
for (const p of PATHS) for (const i of [0, 3]) {
  const ours = C.privToAddress(derive(seedFrom(m.phrase), p.base, i));
  const theirs = HDNodeWallet.fromMnemonic(m, `${p.base}/${i}`).address.toLowerCase();
  assert.equal(ours, theirs, p.base);
}
const target = HDNodeWallet.fromMnemonic(m, "m/44'/550'/0'/0/7").address.toLowerCase();
let t0 = Date.now();
const hit = findAccount(seedFrom("  " + m.phrase.toUpperCase() + " "), target);
// worst case (not found) at each depth
const root = seedFrom(m.phrase);
for (const d of [20, 100]) { t0 = Date.now(); assert.equal(findAccount(root, "0x" + "1".repeat(40), { maxIndex: d }), null); console.log(`full search, ${d} per path: ${Date.now() - t0} ms`); }
// browser addresses match ethers, including a custom template path
const br = addresses(root, "m/44'/60'/i'/0/0", 5, 3);
br.forEach((r) => assert.equal(r.address, HDNodeWallet.fromMnemonic(m, r.path).address.toLowerCase()));
assert.equal(br[0].path, "m/44'/60'/5'/0/0");
const deep = HDNodeWallet.fromMnemonic(m, "m/44'/820'/0'/0/57").address.toLowerCase();
assert.equal(findAccount(root, deep), null); assert.equal(findAccount(root, deep, { maxIndex: 100 }).full, "m/44'/820'/0'/0/57");
assert.equal(hit.path.id, "xdc"); assert.equal(hit.index, 7);
// passphrase
const wp = HDNodeWallet.fromPhrase(m.phrase, "secret", "m/44'/60'/0'/0/0");
assert.equal(C.privToAddress(derive(seedFrom(m.phrase, "secret"), "m/44'/60'/0'/0", 0)), wp.address.toLowerCase());
assert.throws(() => seedFrom("abandon abandon abandon"), /12, 15/);
console.log("mnemonic ok");
