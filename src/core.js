// XDC Offline Signer: shared core.
// Used by both the online companion page and the offline signer, so that a
// transaction is built, decoded and described by exactly the same code on
// both devices. No network access happens in this file.

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes as _hexToBytes, utf8ToBytes, concatBytes } from "@noble/hashes/utils";

/* ============================ Constants ============================ */

export const VALIDATOR = "0x0000000000000000000000000000000000000088";

export const NETS = {
  50: { name: "XDC Mainnet", symbol: "XDC", explorer: "https://xdcscan.com" },
  51: { name: "XDC Apothem Testnet", symbol: "TXDC", explorer: "https://testnet.xdcscan.com" },
};

export const REQUEST_TAG = "xdcsign"; // key + version marker inside every request
export const REQUEST_VERSION = 1;

export const ACTIONS = {
  send:     "Send XDC",
  sendAll:  "Send all XDC",
  token:    "Send XRC-20 tokens",
  vote:     "Vote for a masternode candidate",
  unvote:   "Unvote from a masternode candidate",
  resign:   "Resign a masternode",
  withdraw: "Withdraw unlocked stake",
  propose:  "Propose a new masternode",
  kyc:      "Upload KYC",
  cancel:   "Cancel a pending transaction",
};

/* ============================ Bytes / hex ============================ */

export const keccak = (b) => keccak_256(b);
export const toHex = (b) => "0x" + bytesToHex(b);
export function strip0x(h) { return /^0x/i.test(h) ? h.slice(2) : h; }
export function hexToBytes(h) {
  h = strip0x(String(h).trim());
  if (h.length % 2) throw new Error("hex string has an odd number of characters");
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error("not a hex string");
  return _hexToBytes(h);
}
export { utf8ToBytes, concatBytes, bytesToHex };

/* ============================ Integers ============================ */

const MAX_U256 = (1n << 256n) - 1n;

// Strict unsigned integer parser: decimal strings, 0x-hex strings, safe numbers, bigint.
export function toBig(x, what = "value") {
  if (typeof x === "bigint") { if (x < 0n) throw new Error(`${what} is negative`); return x; }
  if (typeof x === "number") {
    if (!Number.isSafeInteger(x) || x < 0) throw new Error(`${what} is not a whole number`);
    return BigInt(x);
  }
  if (typeof x === "string") {
    const s = x.trim();
    if (/^0x[0-9a-f]+$/i.test(s)) return BigInt(s);
    if (/^[0-9]+$/.test(s)) return BigInt(s);
  }
  throw new Error(`${what} is not a whole number`);
}

export function intToBytes(n) {
  n = toBig(n);
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return _hexToBytes(h);
}

function bytesToInt(b, what) {
  if (b.length && b[0] === 0) throw new Error(`${what} has a leading zero (non-canonical encoding)`);
  return b.length ? BigInt("0x" + bytesToHex(b)) : 0n;
}

// Amount in base units -> exact decimal string, e.g. 1234500000000000000000n,18 -> "1,234.5"
export function formatUnits(v, decimals = 18, group = true) {
  v = toBig(v);
  const d = BigInt(decimals);
  const base = 10n ** d;
  let whole = (v / base).toString();
  let frac = decimals ? (v % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${whole}.${frac}` : whole;
}

// "1234.5" -> base units. Rejects more decimals than the token has.
// Commas are refused outright: "12,5" means 12.5 in many countries but 125 in others.
export function parseUnits(str, decimals = 18) {
  const raw = String(str).trim();
  if (raw.includes(",")) throw new Error("use a dot for decimals and no commas, for example 1500.25");
  const s = raw.replace(/[_\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) throw new Error("enter a number like 1500 or 0.25");
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/* ============================ Addresses ============================ */

export function checksum(addr) {
  const a = strip0x(addr).toLowerCase();
  const h = bytesToHex(keccak(utf8ToBytes(a)));
  let out = "";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return "0x" + out;
}

// Accepts xdc… or 0x… (any case). Mixed-case input must carry a valid checksum,
// which catches most single-character typos. Returns lowercase 0x… form.
export function normAddr(input, what = "address") {
  const s = String(input || "").trim();
  const m = /^(?:xdc|0x)([0-9a-fA-F]{40})$/i.exec(s);
  if (!m) throw new Error(`${what} must be xdc… or 0x… followed by 40 hex characters`);
  const hex = m[1];
  const mixed = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixed && checksum(hex).slice(2) !== hex)
    throw new Error(`${what} has an invalid checksum (a character may be mistyped). If you are sure it is right, enter it all in lowercase.`);
  return "0x" + hex.toLowerCase();
}

export function isAddr(s) { try { normAddr(s); return true; } catch { return false; } }
export const toXdc = (addr) => "xdc" + checksum(addr).slice(2);
export const sameAddr = (a, b) => normAddr(a) === normAddr(b);

export function privToAddress(priv) {
  const pub = secp256k1.getPublicKey(priv, false);
  return toHex(keccak(pub.slice(1)).slice(12));
}

export function parsePrivateKey(input) {
  const h = strip0x(String(input || "").trim());
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("a private key is 64 hex characters (optionally starting with 0x)");
  const k = _hexToBytes(h);
  if (!secp256k1.utils.isValidPrivateKey(k)) throw new Error("this is not a valid private key");
  return k;
}

/* ============================ RLP ============================ */

function lenPrefix(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = intToBytes(len);
  return concatBytes(Uint8Array.of(offset + 55 + lb.length), lb);
}

export function rlpEncode(x) {
  if (Array.isArray(x)) {
    const body = concatBytes(...x.map(rlpEncode));
    return concatBytes(lenPrefix(body.length, 0xc0), body);
  }
  if (x.length === 1 && x[0] < 0x80) return x;
  return concatBytes(lenPrefix(x.length, 0x80), x);
}

function readLen(b, p, n) {
  if (n > 4) throw new Error("RLP length too large");
  if (p + n > b.length) throw new Error("RLP data is cut short");
  if (b[p] === 0) throw new Error("RLP length has a leading zero");
  let l = 0;
  for (let i = 0; i < n; i++) l = l * 256 + b[p + i];
  if (l < 56) throw new Error("RLP long form used for a short item");
  return l;
}

function rlpItem(b, p) {
  if (p >= b.length) throw new Error("RLP data is cut short");
  const f = b[p];
  if (f < 0x80) return [b.subarray(p, p + 1), p + 1];
  if (f < 0xb8) {
    const l = f - 0x80, end = p + 1 + l;
    if (end > b.length) throw new Error("RLP data is cut short");
    if (l === 1 && b[p + 1] < 0x80) throw new Error("non-canonical RLP");
    return [b.subarray(p + 1, end), end];
  }
  if (f < 0xc0) {
    const ll = f - 0xb7, l = readLen(b, p + 1, ll), s = p + 1 + ll, end = s + l;
    if (end > b.length) throw new Error("RLP data is cut short");
    return [b.subarray(s, end), end];
  }
  let s, end;
  if (f < 0xf8) { s = p + 1; end = s + (f - 0xc0); }
  else { const ll = f - 0xf7; s = p + 1 + ll; end = s + readLen(b, p + 1, ll); }
  if (end > b.length) throw new Error("RLP data is cut short");
  const out = [];
  let q = s;
  while (q < end) { const [it, n] = rlpItem(b, q); out.push(it); q = n; }
  if (q !== end) throw new Error("malformed RLP list");
  return [out, end];
}

export function rlpDecode(bytes) {
  const [item, end] = rlpItem(bytes, 0);
  if (end !== bytes.length) throw new Error("extra bytes after the transaction");
  return item;
}

/* ============================ ABI ============================ */

export const selector = (sig) => toHex(keccak(utf8ToBytes(sig)).slice(0, 4));

function word(n) { return toBig(n).toString(16).padStart(64, "0"); }
// The only dynamic argument used is a single string (uploadKYC), which is the whole tail.
function encString(v) {
  const b = utf8ToBytes(String(v));
  const hexs = bytesToHex(b);
  return word(32) + word(b.length) + hexs.padEnd(Math.ceil(b.length / 32) * 64, "0");
}
function encArg(type, v) {
  if (type === "address") return normAddr(v).slice(2).padStart(64, "0");
  if (type === "uint256") { const n = toBig(v); if (n > MAX_U256) throw new Error("number too large"); return word(n); }
  throw new Error("unsupported ABI type " + type);
}

// Write calls this tool knows how to build and recognise.
export const FUNCS = {
  vote:     { sig: "vote(address)",               types: ["address"],            names: ["candidate"] },
  unvote:   { sig: "unvote(address,uint256)",     types: ["address", "uint256"], names: ["candidate", "amount"] },
  resign:   { sig: "resign(address)",             types: ["address"],            names: ["candidate"] },
  withdraw: { sig: "withdraw(uint256,uint256)",   types: ["uint256", "uint256"], names: ["blockNumber", "index"] },
  transfer: { sig: "transfer(address,uint256)",   types: ["address", "uint256"], names: ["to", "amount"] },
  propose:  { sig: "propose(address)",            types: ["address"],            names: ["candidate"] },
  uploadKYC:{ sig: "uploadKYC(string)",           types: ["string"],             names: ["hash"] },
};
for (const f of Object.values(FUNCS)) f.selector = selector(f.sig);

export function encodeCall(name, args) {
  const f = FUNCS[name];
  if (f.types[0] === "string") return f.selector + encString(args[0]);
  return f.selector + f.types.map((t, i) => encArg(t, args[i])).join("");
}

// Read-only calls used by the online page.
export const VIEWS = {
  getCandidates: selector("getCandidates()"),
  getCandidateCap: selector("getCandidateCap(address)"),
  getCandidateOwner: selector("getCandidateOwner(address)"),
  getVoterCap: selector("getVoterCap(address,address)"),
  isCandidate: selector("isCandidate(address)"),
  getWithdrawBlockNumbers: selector("getWithdrawBlockNumbers()"),
  getWithdrawCap: selector("getWithdrawCap(uint256)"),
  getHashCount: selector("getHashCount(address)"),
  getLatestKYC: selector("getLatestKYC(address)"),
  ownerToCandidate: selector("ownerToCandidate(address,uint256)"),
  minVoterCap: selector("minVoterCap()"),
  minCandidateCap: selector("minCandidateCap()"),
  voterWithdrawDelay: selector("voterWithdrawDelay()"),
  candidateWithdrawDelay: selector("candidateWithdrawDelay()"),
  name: selector("name()"),
  symbol: selector("symbol()"),
  decimals: selector("decimals()"),
  balanceOf: selector("balanceOf(address)"),
};
export function encodeView(sel, types = [], args = []) {
  return sel + types.map((t, i) => encArg(t, args[i])).join("");
}

// Decoders for view results
export function decUint(hex) { const h = strip0x(hex); if (!h) throw new Error("empty result (is this a contract?)"); return BigInt("0x" + h.slice(0, 64)); }
export function decAddr(hex) { return "0x" + strip0x(hex).slice(24, 64).toLowerCase(); }
export function decBool(hex) { return decUint(hex) !== 0n; }
export function decArray(hex, kind) {
  const h = strip0x(hex);
  const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
  const n = Number(BigInt("0x" + h.slice(off, off + 64)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = h.slice(off + 64 + i * 64, off + 128 + i * 64);
    out.push(kind === "address" ? "0x" + w.slice(24).toLowerCase() : BigInt("0x" + w));
  }
  return out;
}
// ABI string, with a fallback for old tokens that return bytes32.
export function decString(hex) {
  const h = strip0x(hex);
  if (!h) return "";
  try {
    if (h.length >= 128) {
      const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
      const n = Number(BigInt("0x" + h.slice(off, off + 64)));
      if (off === 64 && n <= 256) return new TextDecoder().decode(_hexToBytes(h.slice(off + 64, off + 64 + n * 2)));
    }
  } catch { /* fall through */ }
  return new TextDecoder().decode(_hexToBytes(h.slice(0, 64))).replace(/\0+$/, "");
}

// Decode calldata against FUNCS. Returns null if it is not one we recognise.
export function decodeCall(data) {
  const d = strip0x(data || "").toLowerCase();
  if (d.length < 8) return null;
  const sel = "0x" + d.slice(0, 8);
  for (const [name, f] of Object.entries(FUNCS)) {
    if (f.selector !== sel) continue;
    if (f.types[0] === "string") {
      const body = d.slice(8);
      if (body.length < 128 || BigInt("0x" + body.slice(0, 64)) !== 32n) return { name, error: "malformed string argument" };
      const n = Number(BigInt("0x" + body.slice(64, 128)));
      if (n > 1024 || body.length !== 128 + Math.ceil(n / 32) * 64) return { name, error: "string argument has the wrong length" };
      if (!/^0*$/.test(body.slice(128 + n * 2))) return { name, error: "string argument has non-zero padding" };
      let str;
      try { str = new TextDecoder("utf-8", { fatal: true }).decode(_hexToBytes(body.slice(128, 128 + n * 2))); }
      catch { return { name, error: "string argument is not valid text" }; }
      return { name, sig: f.sig, args: { [f.names[0]]: str } };
    }
    if (d.length !== 8 + 64 * f.types.length) return { name, error: "calldata has the wrong length for " + f.sig };
    const args = {};
    for (let i = 0; i < f.types.length; i++) {
      const w = d.slice(8 + 64 * i, 72 + 64 * i);
      if (f.types[i] === "address") {
        if (!/^0{24}/.test(w)) return { name, error: "malformed address argument" };
        args[f.names[i]] = "0x" + w.slice(24);
      } else args[f.names[i]] = BigInt("0x" + w);
    }
    return { name, sig: f.sig, args };
  }
  return null;
}

/* ============================ Transactions (legacy, EIP-155) ============================ */
// tx = { chainId, nonce, gasPrice, gasLimit, to, value, data }  (bigints / hex strings)

function fieldList(tx) {
  return [
    intToBytes(tx.nonce), intToBytes(tx.gasPrice), intToBytes(tx.gasLimit),
    tx.to ? hexToBytes(tx.to) : new Uint8Array(0),
    intToBytes(tx.value), hexToBytes(tx.data || "0x"),
  ];
}

export function unsignedRaw(tx) {
  return toHex(rlpEncode([...fieldList(tx), intToBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)]));
}
export const signingHash = (tx) => keccak(hexToBytes(unsignedRaw(tx)));

export function signTx(tx, priv) {
  const h = signingHash(tx);
  const sig = secp256k1.sign(h, priv, { lowS: true }); // RFC 6979 deterministic nonce
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(sig.recovery);
  const raw = rlpEncode([...fieldList(tx), intToBytes(v), intToBytes(sig.r), intToBytes(sig.s)]);
  return { raw: toHex(raw), hash: toHex(keccak(raw)) };
}

const HALF_N = secp256k1.CURVE.n / 2n;

// Decode a legacy raw transaction, signed or unsigned (EIP-155 form).
export function decodeRawTx(input) {
  const hex = String(input || "").trim().replace(/\s+/g, "");
  const bytes = hexToBytes(hex);
  if (!bytes.length) throw new Error("empty transaction");
  if (bytes[0] < 0xc0) {
    const t = bytes[0];
    throw new Error(t <= 0x7f ? `this is a type-${t} (EIP-2718) transaction; this tool handles legacy transactions only` : "not a transaction");
  }
  const it = rlpDecode(bytes);
  if (!Array.isArray(it) || it.length !== 9 || it.some(Array.isArray)) throw new Error("not a legacy transaction (expected 9 fields)");
  const [n, gp, gl, to, val, data, v, r, s] = it;
  if (to.length !== 0 && to.length !== 20) throw new Error("recipient is not 20 bytes");
  const tx = {
    nonce: bytesToInt(n, "nonce"), gasPrice: bytesToInt(gp, "gas price"), gasLimit: bytesToInt(gl, "gas limit"),
    to: to.length ? toHex(to) : null, value: bytesToInt(val, "value"), data: toHex(data),
  };
  const V = bytesToInt(v, "v"), R = bytesToInt(r, "r"), S = bytesToInt(s, "s");
  const out = { tx, raw: toHex(bytes), signed: false };
  if (R === 0n && S === 0n) {
    tx.chainId = V;
    return out; // unsigned, EIP-155 signing form
  }
  if (V === 27n || V === 28n) throw new Error("this transaction is signed without a chain ID (pre-EIP-155) and could be replayed on other chains; it will not be accepted here");
  if (V < 35n) throw new Error("invalid signature v value");
  tx.chainId = (V - 35n) / 2n;
  const rec = Number((V - 35n) % 2n);
  if (S > HALF_N) throw new Error("signature uses a high s value, which XDC nodes reject");
  const sig = new secp256k1.Signature(R, S).addRecoveryBit(rec);
  const pub = sig.recoverPublicKey(signingHash(tx)).toRawBytes(false);
  out.signed = true;
  out.from = toHex(keccak(pub.slice(1)).slice(12));
  out.hash = toHex(keccak(bytes));
  return out;
}

/* ============================ Requests (online -> offline) ============================ */
// A request carries the facts only the online side can know (nonce, gas price, balances)
// and the user's chosen action + arguments. The offline side builds the calldata itself.
//
// { xdcsign:1, chain:50, from:"0x…", nonce:12, gasPrice:"…wei", gas:21000,
//   action:"send", args:{…}, info:{…}, ts:1730000000 }

export function makeRequest({ chainId, from, nonce, gasPrice, gasLimit, action, args, info }) {
  const r = {
    [REQUEST_TAG]: REQUEST_VERSION, chain: Number(chainId), from: normAddr(from),
    nonce: Number(nonce), gasPrice: toBig(gasPrice).toString(), gas: Number(gasLimit),
    action, args: {}, ts: Math.floor(Date.now() / 1000),
  };
  for (const [k, v] of Object.entries(args)) r.args[k] = typeof v === "bigint" ? v.toString() : v;
  if (info && Object.keys(info).length) {
    r.info = {};
    for (const [k, v] of Object.entries(info)) r.info[k] = typeof v === "bigint" ? v.toString() : v;
  }
  buildFromRequest(r); // throws if anything is invalid
  return r;
}

export function parseRequest(text) {
  let r;
  try { r = typeof text === "string" ? JSON.parse(text) : text; } catch { throw new Error("this QR code is not a signing request from the XDC Offline Signer companion page"); }
  if (!r || r[REQUEST_TAG] === undefined) throw new Error("this QR code is not a signing request from the XDC Offline Signer companion page");
  if (r[REQUEST_TAG] !== REQUEST_VERSION) throw new Error(`request format version ${r[REQUEST_TAG]} is not supported by this signer (supports ${REQUEST_VERSION}); get the matching signer version`);
  return r;
}

export const KYC_RE = /^[\x21-\x7e]{1,200}$/;
const cleanLabel = (s) => String(s ?? "").replace(/[^\w .\-+$()]/g, "").slice(0, 24);

// Turn a request into the exact transaction to sign. Strict: anything odd throws.
export function buildFromRequest(r) {
  const chainId = Number(r.chain);
  if (!NETS[chainId]) throw new Error("unknown network (chain ID " + r.chain + "); only XDC Mainnet (50) and Apothem (51) are supported");
  const from = normAddr(r.from, "from address");
  const nonce = toBig(r.nonce, "nonce");
  const gasPrice = toBig(r.gasPrice, "gas price");
  const gasLimit = toBig(r.gas, "gas limit");
  if (gasPrice === 0n) throw new Error("gas price is zero");
  if (gasLimit < 21000n || gasLimit > 10_000_000n) throw new Error("gas limit must be between 21,000 and 10,000,000");
  const a = r.args || {};
  const maxFee = gasLimit * gasPrice;
  let to, value = 0n, data = "0x";
  const meta = { action: r.action };

  switch (r.action) {
    case "send":
      to = normAddr(a.to, "recipient");
      value = toBig(a.amount, "amount");
      if (value === 0n) throw new Error("amount is zero");
      break;
    case "sendAll": {
      to = normAddr(a.to, "recipient");
      const bal = toBig(a.balance, "balance");
      if (bal <= maxFee) throw new Error("balance does not cover the network fee");
      value = bal - maxFee;
      meta.balance = bal;
      break;
    }
    case "token": {
      to = normAddr(a.token, "token contract");
      const rcpt = normAddr(a.to, "recipient");
      const amt = toBig(a.amount, "amount");
      if (amt === 0n) throw new Error("amount is zero");
      const dec = Number(a.decimals);
      if (!Number.isInteger(dec) || dec < 0 || dec > 36) throw new Error("token decimals missing or invalid");
      data = encodeCall("transfer", [rcpt, amt]);
      meta.token = { decimals: dec, symbol: cleanLabel(a.symbol) || "tokens", all: !!a.all };
      break;
    }
    case "vote":
      to = VALIDATOR;
      value = toBig(a.amount, "amount");
      if (value === 0n) throw new Error("amount is zero");
      data = encodeCall("vote", [normAddr(a.candidate, "candidate")]);
      break;
    case "unvote": {
      to = VALIDATOR;
      const amt = toBig(a.amount, "amount");
      if (amt === 0n) throw new Error("amount is zero");
      data = encodeCall("unvote", [normAddr(a.candidate, "candidate"), amt]);
      break;
    }
    case "resign":
      to = VALIDATOR;
      data = encodeCall("resign", [normAddr(a.candidate, "candidate")]);
      break;
    case "withdraw": {
      to = VALIDATOR;
      const bn = toBig(a.blockNumber, "withdrawal block number");
      if (bn === 0n) throw new Error("withdrawal block number is zero");
      data = encodeCall("withdraw", [bn, toBig(a.index, "withdrawal index")]);
      break;
    }
    case "propose":
      to = VALIDATOR;
      value = toBig(a.amount, "stake");
      if (value === 0n) throw new Error("stake is zero");
      data = encodeCall("propose", [normAddr(a.candidate, "candidate (node) address")]);
      break;
    case "kyc": {
      to = VALIDATOR;
      const h = String(a.hash ?? "").trim();
      if (!KYC_RE.test(h)) throw new Error("KYC reference must be 1 to 200 printable characters with no spaces (for example an IPFS hash)");
      data = encodeCall("uploadKYC", [h]);
      break;
    }
    case "cancel":
      // 0 XDC to yourself with the stuck nonce: if mined first, it takes that nonce's place.
      to = from;
      if (gasLimit !== 21000n) throw new Error("a cancel transaction uses exactly 21,000 gas");
      break;
    default:
      throw new Error("unknown action: " + r.action);
  }
  return { tx: { chainId: BigInt(chainId), nonce, gasPrice, gasLimit, to, value, data }, from, meta };
}

/* ============================ Clear-sign description ============================ */
// Describes a transaction purely from its fields and calldata. Both devices use this.
// ctx: { from, token:{symbol,decimals}, tokenVerified, info:{...}, balance }

export function describeTx(tx, ctx = {}) {
  const net = NETS[Number(tx.chainId)];
  const sym = net ? net.symbol : "XDC";
  const X = (v) => `${formatUnits(v)} ${sym}`;
  const A = (a) => toXdc(a);
  const rows = [];   // [label, value, sub?, mono?]
  const warnings = [];
  const notes = [];
  let title, kind, summary;
  const maxFee = tx.gasLimit * tx.gasPrice;

  const call = tx.data && tx.data !== "0x" ? decodeCall(tx.data) : null;
  const toValidator = tx.to && tx.to.toLowerCase() === VALIDATOR;

  if (!tx.to) {
    kind = "unknown"; title = "Contract deployment";
    summary = "Deploys a new contract. This tool never creates these.";
    warnings.push("This is a contract deployment, which this tool never builds. Do not sign or broadcast it unless you created it yourself.");
  } else if (!call && strip0x(tx.data || "").length === 0 && ctx.from && tx.value === 0n && tx.to.toLowerCase() === ctx.from.toLowerCase()) {
    kind = "cancel"; title = "Cancel a pending transaction";
    summary = `Sends 0 ${sym} from your wallet to itself using nonce ${tx.nonce}. Whichever transaction with this nonce is mined first wins, so this replaces a stuck one if its gas price is higher.`;
    rows.push(["Amount", `0 ${sym}`, "to your own address"]);
    notes.push("Nodes accept a replacement only if its gas price is at least about 10% higher than the pending transaction's. If the original is mined first, this one is simply rejected and costs nothing.");
  } else if (!call && strip0x(tx.data || "").length === 0) {
    const all = ctx.meta && ctx.meta.action === "sendAll";
    kind = all ? "sendAll" : "send";
    title = all ? "Send all XDC" : "Send XDC";
    summary = `Sends ${X(tx.value)} to ${A(tx.to)}.`;
    rows.push(["Amount", X(tx.value), `${tx.value} wei`]);
    rows.push(["To", A(tx.to), null, true]);
    if (all) notes.push(`Empties the wallet: the stated balance of ${X(ctx.meta.balance)} minus the maximum network fee. If masternode rewards or other funds arrive before this is mined, that extra stays in the wallet.`);
    if (toValidator) warnings.push("This sends XDC to the validator contract without calling a function. That is almost certainly a mistake.");
  } else if (call && call.error) {
    kind = "unknown"; title = "Malformed contract call";
    summary = call.error;
    warnings.push("The call data is malformed: " + call.error + ". Do not sign or broadcast this.");
  } else if (call && toValidator && call.name !== "transfer") {
    const c = call.args.candidate;
    switch (call.name) {
      case "vote":
        kind = "vote"; title = "Vote for a masternode candidate";
        summary = `Stakes ${X(tx.value)} on candidate ${A(c)} through the XDC validator contract.`;
        rows.push(["Stake", X(tx.value), `${tx.value} wei`]);
        rows.push(["Candidate", A(c), null, true]);
        notes.push("The staked XDC stays locked in the validator contract until you unvote it, then waits out the unlock delay before you can withdraw it.");
        break;
      case "unvote":
        kind = "unvote"; title = "Unvote from a masternode candidate";
        summary = `Removes ${X(call.args.amount)} of your stake from candidate ${A(c)}.`;
        rows.push(["Unvote amount", X(call.args.amount), `${call.args.amount} wei`]);
        rows.push(["Candidate", A(c), null, true]);
        notes.push("Nothing is paid out by this transaction. The amount moves to your withdrawal queue and can be withdrawn with a separate Withdraw transaction once the unlock delay has passed.");
        if (tx.value) warnings.push("Unvote should not carry any XDC, but this one sends " + X(tx.value) + ".");
        break;
      case "resign":
        kind = "resign"; title = "Resign a masternode";
        summary = `Resigns masternode candidate ${A(c)}. Your own stake on it moves to the withdrawal queue.`;
        rows.push(["Candidate", A(c), null, true]);
        warnings.push("Resigning cannot be undone. The node stops being a masternode candidate and stops earning rewards. Becoming a candidate again needs a fresh 10,000,000 XDC proposal. Your stake can be withdrawn only after the candidate unlock delay.");
        if (tx.value) warnings.push("Resign should not carry any XDC, but this one sends " + X(tx.value) + ".");
        break;
      case "propose":
        kind = "propose"; title = "Propose a new masternode";
        summary = `Stakes ${X(tx.value)} to register ${A(c)} as a masternode candidate, with your wallet as its owner.`;
        rows.push(["Stake", X(tx.value), `${tx.value} wei`]);
        rows.push(["Candidate (node) address", A(c), "the address of the masternode server, not your wallet", true]);
        notes.push("The candidate address must be the coinbase address of a masternode server you have set up. The stake stays locked until you resign the candidate and wait out the candidate unlock delay.");
        break;
      case "withdraw":
        kind = "withdraw"; title = "Withdraw unlocked stake";
        summary = `Withdraws the unlocked stake recorded at block ${call.args.blockNumber} (entry #${call.args.index}) back to your wallet.`;
        rows.push(["Unlock block", call.args.blockNumber.toString()]);
        rows.push(["Queue index", call.args.index.toString()]);
        if (ctx.info && ctx.info.amount) {
          let amt = null;
          try { amt = toBig(ctx.info.amount); } catch {}
          if (amt !== null) rows.push(["Expected payout", X(amt), ctx.infoVerified ? "read from the chain" : "as stated by the online page, not verified offline"]);
        }
        if (tx.value) warnings.push("Withdraw should not carry any XDC, but this one sends " + X(tx.value) + ".");
        break;
      case "uploadKYC":
        kind = "kyc"; title = "Upload KYC";
        summary = `Records the KYC document reference "${call.args.hash}" against your wallet in the validator contract.`;
        rows.push(["KYC reference", call.args.hash, `${call.args.hash.length} characters`, true]);
        notes.push("Only this reference (normally the IPFS hash of your KYC document) is stored, and it is public on the chain. The document itself is not part of this transaction.");
        if (!KYC_RE.test(call.args.hash)) warnings.push("The KYC reference contains spaces or unusual characters.");
        if (tx.value) warnings.push("Upload KYC should not carry any XDC, but this one sends " + X(tx.value) + ".");
        break;
    }
  } else if (call && call.name === "transfer") {
    kind = "token"; title = "Send XRC-20 tokens";
    const t = ctx.token || {};
    const dec = Number.isInteger(t.decimals) ? t.decimals : null;
    const amt = dec === null ? `${call.args.amount} base units` : `${formatUnits(call.args.amount, dec)} ${t.symbol || "tokens"}`;
    summary = `Transfers ${amt} to ${A(call.args.to)}.`;
    rows.push(["Amount", amt, `${call.args.amount} base units${dec === null ? "" : `, ${dec} decimals`}`]);
    rows.push(["Recipient", A(call.args.to), null, true]);
    rows.push(["Token contract", A(tx.to), ctx.tokenVerified ? `symbol and decimals read from the chain` : `symbol and decimals as stated by the online page, not verified offline`, true]);
    if (t.all) notes.push("This is your full token balance as read by the online page.");
    if (toValidator) warnings.push("A token transfer addressed to the validator contract is a mistake.");
    if (tx.value) warnings.push("This token transfer also sends " + X(tx.value) + ". Token transfers normally carry no XDC.");
  } else {
    kind = "unknown"; title = "Unrecognised contract call";
    summary = "Calls a function this tool does not recognise.";
    rows.push(["Contract", A(tx.to), null, true]);
    rows.push(["Data", tx.data, null, true]);
    warnings.push("This tool did not build this call and cannot explain what it does. Do not broadcast it unless you know exactly what it is.");
  }

  if (ctx.from) rows.push(["From", A(ctx.from), "your wallet", true]);
  rows.push(["Network", net ? `${net.name} (chain ID ${tx.chainId})` : `Unknown chain ID ${tx.chainId}`]);
  rows.push(["Nonce", tx.nonce.toString(), "transaction number for this wallet"]);
  rows.push(["Max network fee", X(maxFee), `${tx.gasLimit} gas × ${formatUnits(tx.gasPrice, 9)} gwei`]);
  if (tx.value && !["send", "sendAll", "vote", "propose"].includes(kind)) rows.push(["XDC sent", X(tx.value)]);
  rows.push(["Total cost, at most", X(tx.value + maxFee)]);

  if (!net) warnings.push("Not an XDC network. Do not broadcast.");
  if (maxFee > 10n ** 19n) warnings.push(`The maximum network fee is ${X(maxFee)}, which is very high for XDC. Check the gas price.`);

  return { kind, title, summary, rows, warnings, notes, maxFee };
}

/* ============================ Misc ============================ */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
