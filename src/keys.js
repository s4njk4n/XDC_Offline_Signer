// Offline signer only: turn a keystore file or recovery phrase into a private key.
import { scryptAsync } from "@noble/hashes/scrypt";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { ctr } from "@noble/ciphers/aes";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { keccak, hexToBytes, utf8ToBytes, concatBytes, bytesToHex, privToAddress, strip0x } from "./core.js";

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Web3 Secret Storage (keystore v3), as written by MyEtherWallet, the old XDC web wallet, geth, MetaMask exports.
export async function decryptKeystore(text, password, onProgress = () => {}) {
  let k;
  try { k = JSON.parse(text); } catch { throw new Error("this file is not a keystore (not JSON)"); }
  const c = k.crypto || k.Crypto;
  if (!c || Number(k.version) !== 3) throw new Error("only version 3 keystore files are supported");
  if (c.cipher !== "aes-128-ctr") throw new Error("unsupported keystore cipher " + c.cipher);
  const p = c.kdfparams || {};
  const salt = hexToBytes(p.salt);
  const pw = utf8ToBytes(String(password).normalize("NFKC"));
  let dk;
  if (c.kdf === "scrypt") {
    dk = await scryptAsync(pw, salt, { N: Number(p.n), r: Number(p.r), p: Number(p.p), dkLen: Number(p.dklen), onProgress, maxmem: 2 ** 31 });
  } else if (c.kdf === "pbkdf2") {
    if (p.prf !== "hmac-sha256") throw new Error("unsupported keystore PRF " + p.prf);
    dk = await pbkdf2Async(sha256, pw, salt, { c: Number(p.c), dkLen: Number(p.dklen) });
    onProgress(1);
  } else throw new Error("unsupported keystore KDF " + c.kdf);
  const ct = hexToBytes(c.ciphertext);
  const mac = keccak(concatBytes(dk.slice(16, 32), ct));
  if (!eq(mac, hexToBytes(c.mac))) throw new Error("wrong password for this keystore file");
  const priv = ctr(dk.slice(0, 16), hexToBytes(c.cipherparams.iv)).decrypt(ct);
  if (priv.length !== 32) throw new Error("keystore holds an unexpected key length");
  const addr = privToAddress(priv);
  if (k.address) {
    const stated = strip0x(String(k.address).replace(/^xdc/i, "")).toLowerCase();
    if (stated && stated !== addr.slice(2)) throw new Error("the key in this keystore does not match the address written in the file");
  }
  return priv;
}

// Every recovery-phrase path the XinFin web wallet (github.com/XinFinOrg/Wallet) has offered.
// Since Dec 2020 (v1.0.5714): XDC m/44'/550'/0'/0 (default) and Ethereum m/44'/60'/0'/0.
// 2019 to Dec 2020 (v1.0, MyEtherWallet fork): Ethereum m/44'/60'/0'/0 by default, plus the menu below.
// Addresses are base/i, as that wallet derived them. "i" inside a path marks where the index goes.
export const PATHS = [
  { id: "xdc",  base: "m/44'/550'/0'/0", label: "XDC: XinFin wallet default since Dec 2020" },
  { id: "eth",  base: "m/44'/60'/0'/0",  label: "Ethereum: XinFin wallet default 2019 to 2020, MetaMask" },
  { id: "ledger", base: "m/44'/60'/0'",  label: "Ledger legacy / old MEW / Lightstreams" },
  { id: "xdcl", base: "m/44'/550'/0'",   label: "XDC legacy" },
  ...[
    ["etc", "m/44'/61'/0'/0", "Ethereum Classic"], ["ropsten", "m/44'/1'/0'/0", "Ethereum Testnet (Ropsten)"],
    ["sdtv", "m/0'/0'/0'", "SingularDTV"], ["exp", "m/44'/40'/0'/0", "Expanse"], ["ubq", "m/44'/108'/0'/0", "Ubiq"],
    ["ella", "m/44'/163'/0'/0", "Ellaism"], ["egem", "m/44'/1987'/0'/0", "EtherGem"], ["clo", "m/44'/820'/0'/0", "Callisto"],
    ["etsc", "m/44'/1128'/0'/0", "Ethereum Social"], ["music", "m/44'/184'/0'/0", "Musicoin"], ["go", "m/44'/6060'/0'/0", "GoChain"],
    ["eosc", "m/44'/2018'/0'/0", "EOS Classic"], ["aka", "m/44'/200625'/0'/0", "Akroma"], ["esn", "m/44'/31102'/0'/0", "EtherSocial Network"],
    ["pirl", "m/44'/164'/0'/0", "PIRL"], ["etho", "m/44'/1313114'/0'/0", "Ether-1"], ["ath", "m/44'/1620'/0'/0", "Atheios"],
    ["tomo", "m/44'/889'/0'/0", "TomoChain"], ["mix", "m/44'/76'/0'/0", "Mix Blockchain"], ["ilt", "m/44'/1171337'/0'/0", "Iolite"],
    ["rsk", "m/44'/137'/0'/0", "RSK Mainnet"], ["rskt", "m/44'/37310'/0'/0", "RSK Testnet"], ["tt", "m/44'/1001'/0'/0", "ThunderCore"],
    ["slm", "m/44'/997'/0'/0", "Solidum"], ["meta", "m/44'/916'/0'/0", "Metadium"], ["dxn", "m/44'/237'/0'/0", "DEXON Network"],
    ["mintme", "m/44'/227'/0'/0", "MintMe.com Coin"], ["ere", "m/44'/466'/0'/0", "EtherCore"],
  ].map(([id, base, l]) => ({ id, base, label: `${l} (old XinFin wallet menu)` })),
];

// "m/44'/60'/0'/0" -> addresses at .../i ; "m/44'/60'/i'/0/0" -> index substituted.
export function checkPath(p) {
  const s = String(p || "").trim().replace(/\s+/g, "");
  if (!/^m(\/(\d+|i)'?)+$/.test(s)) throw new Error("a path looks like m/44'/550'/0'/0 (put i where the account number goes, if not at the end)");
  if ((s.match(/i/g) || []).length > 1) throw new Error("use i at most once in a path");
  return s;
}
const pathAt = (base, i) => base.includes("i") ? base.replace("i", String(i)) : `${base}/${i}`;
export function normaliseMnemonic(m) {
  return String(m || "").trim().toLowerCase().split(/\s+/).join(" ");
}
export function checkMnemonic(m) {
  const words = normaliseMnemonic(m);
  const n = words.split(" ").length;
  if (![12, 15, 18, 21, 24].includes(n)) throw new Error(`a recovery phrase has 12, 15, 18, 21 or 24 words; this has ${n}`);
  if (!validateMnemonic(words, wordlist)) throw new Error("this recovery phrase is not valid (a word is misspelt or out of order)");
  return words;
}
export function seedFrom(m, passphrase = "") { return HDKey.fromMasterSeed(mnemonicToSeedSync(checkMnemonic(m), passphrase)); }
export function derive(root, base, index) {
  const k = root.derive(pathAt(base, index)).privateKey;
  if (!k) throw new Error("could not derive a key on this path");
  return k;
}

// Addresses (only) for a range of indexes on one path.
export function addresses(root, base, from, count) {
  const out = [];
  const node = base.includes("i") ? null : root.derive(base);
  for (let i = from; i < from + count; i++) {
    const k = node ? node.deriveChild(i).privateKey : root.derive(pathAt(base, i)).privateKey;
    out.push({ index: i, path: pathAt(base, i), address: privToAddress(k) });
    k.fill(0);
  }
  return out;
}

// Find which path/index gives `target` (lowercase 0x address). Returns {priv, path, index} or null.
export function findAccount(root, target, { maxIndex = 20, extra = [] } = {}) {
  const list = [...extra.map((base) => ({ id: "custom", base, label: "Custom path" })), ...PATHS];
  const seen = new Set();
  for (const p of list) {
    if (seen.has(p.base)) continue;
    seen.add(p.base);
    const node = p.base.includes("i") ? null : root.derive(p.base);
    for (let i = 0; i < maxIndex; i++) {
      const k = node ? node.deriveChild(i).privateKey : root.derive(pathAt(p.base, i)).privateKey;
      if (privToAddress(k) === target) return { priv: k, path: p, index: i, full: pathAt(p.base, i) };
      k.fill(0);
    }
  }
  return null;
}

export function wipe(b) { if (b && b.fill) b.fill(0); }
export { bytesToHex };
