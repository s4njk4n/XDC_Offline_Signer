# XDC Offline Signer

Move XDC, XRC-20 tokens and masternode stake with a private key that never touches the internet.

The system has two halves that talk to each other only through QR codes:

| | Runs on | Does |
|---|---|---|
| **Online companion** (`index.html`) | Your phone, from `https://xdcoutpost.xyz/XDC_Offline_Signer/` | Reads your nonce, balances and the gas price, checks the transaction with the network, shows a request QR, scans the signed transaction back, checks it again and broadcasts it. It never sees a key. |
| **Offline signer** (`offline/xdc-offline-signer.html`) | An airgapped laptop with a webcam | Loads your key, scans the request with the webcam, builds the transaction itself, shows exactly what it does, signs it and shows the signed transaction as a QR code. It can't make network connections. |

## What it can do

- **Send XDC**: any amount, or **send everything**. A plain transfer to a wallet always costs exactly 21,000 gas, so the signer sends `balance − 21,000 × gas price` and the wallet ends at exactly zero.
- **Send XRC-20 tokens**: any amount or the full token balance.
- **Vote** for a masternode candidate (stake XDC through the validator contract at `xdc0000000000000000000000000000000000000088`).
- **Unvote** from a candidate. This respects the owner rule: an owner must leave at least the minimum candidate stake.
- **Resign** a masternode you own.
- **Withdraw** stake from the withdrawal queue once its unlock block has passed (one transaction per queue entry).
- **Cancel a stuck transaction**: 0 XDC to yourself with the stuck nonce and a higher gas price. The page finds pending transactions and their gas price from the node's transaction pool when the RPC allows it. A **nonce override** under Gas settings replaces a stuck transaction with any other action instead.

The online page also has a **Find candidates I have stake on / I own** helper. It scans the candidate list so you don't need to type masternode addresses.

**Deliberately not included:** proposing a new masternode and uploading KYC. These are one-off steps for first-time owners, they involve the largest sums and off-chain paperwork, and XinFin's official masternode app handles them. Both devices still *recognise* these transactions if one is scanned or pasted, and warn that this tool didn't build it.

## How a transaction travels

1. **Phone.** Enter (or scan) your wallet address. Pick an action and fill it in. The page reads fresh chain state, runs `eth_estimateGas` (so a transaction that would fail is caught *before* you sign), and shows a request QR.
2. **Laptop.** The offline signer scans the request with its webcam. It does **not** trust any calldata from the phone. The request carries only facts the offline side can't know (chain ID, nonce, gas price, gas limit, the balance for send-all, token decimals) plus your chosen action and its arguments. The signer builds the transaction bytes itself.
3. **Laptop.** The signer decodes the transaction it is about to sign and shows what it does: what, to whom, how much, maximum fee and total cost, with warnings for anything unusual (resigning is irreversible, unrecognised calls, very high fees). It refuses to sign if the loaded key doesn't match the request's address.
4. **Laptop → phone.** The signed transaction is shown as a QR code. The unsigned EIP-155 form is also available as a QR, for cross-checking with other tools.
5. **Phone.** The online page decodes the signed transaction from scratch and recovers the sender from the signature. It compares every field with the request it prepared, checks the nonce and balance, does a dry run (`eth_call`), and shows the same plain-language description. **Broadcast** is disabled if any check fails.

Both sides describe transactions with the same code (`src/core.js`, `describeTx`), working from the transaction bytes rather than from labels.

## Hosting the online half (GitHub Pages)

The built files are committed at the repo root, so GitHub Pages serves the repo as is:

1. Push this repo to `github.com/s4njk4n/XDC_Offline_Signer`.
2. Settings → Pages → Deploy from branch → `main` / root.
3. The page appears at `https://xdcoutpost.xyz/XDC_Offline_Signer/`, alongside your other tools.

The page uses the site-wide `/assets/fonts/…`, `/assets/favicon.svg` and `/assets/analytics.js` like the Stake Desk, and falls back to system fonts if they're missing. The camera needs HTTPS, which GitHub Pages provides.

Default RPCs: Plugin (`rpc.plugin.global/xdcmainnet`) with `rpc.xinfin.network` and `erpc.xinfin.network` as automatic fallbacks; Apothem uses `rpc.apothem.network` and `erpc.apothem.network`. Users can set their own under *Network settings*.

## Setting up the offline computer

1. Use a spare laptop with a webcam. Physically remove or disable its Wi-Fi and Bluetooth, and never plug in a network cable.
2. Ideally boot a fresh Linux live USB (Ubuntu, Tails, etc.) instead of an everyday OS.
3. Download `xdc-offline-signer.html` on another computer, **check its SHA-256** against the release notes (`sha256sum xdc-offline-signer.html`, or `certutil -hashfile xdc-offline-signer.html SHA256` on Windows), and copy it across on a USB stick.
4. Open it in Chrome, Chromium, Firefox, Edge or Brave. Allow the camera when asked.
5. When finished, click **Done: forget key** and close the tab. The key is held only in that tab's memory and is never written anywhere.

### Key formats

- **Private key**: 64 hex characters, with or without `0x`.
- **Keystore file**: Web3 v3 `UTC--…` JSON files from MyEtherWallet, the old XDC web wallet, geth or MetaMask exports. Supports scrypt and PBKDF2, and `xdc`-prefixed address fields.
- **Recovery phrase**: 12–24 BIP-39 words, with an optional passphrase (MEW's "extra word"). See below for derivation paths.

### Recovery phrases and derivation paths

These paths were checked against the full history of the XinFin web wallet ([XinFinOrg/Wallet](https://github.com/XinFinOrg/Wallet)):

- **Since 16 December 2020** (v1.0.5714 onward), the wallet offers `m/44'/550'/0'/0` (XDC, the default) and `m/44'/60'/0'/0` (Ethereum).
- **From September 2019 to December 2020** (v1.0, essentially MyEtherWallet), the default was the **Ethereum path `m/44'/60'/0'/0`**. The menu also offered about 30 other networks' paths (Ethereum Classic, Ropsten, SingularDTV, Ledger legacy `m/44'/60'/0'`, Expanse, TomoChain, RSK, …).

The signer knows all 32 distinct paths. With a signing request loaded, it searches the first 20 addresses on every one of them for the request's address; the depth can be raised to 100 or 500. You can also give a **custom path**, using `i` where the account number goes if it isn't at the end (for example `m/44'/60'/i'/0/0`). An **address browser** lists the addresses on any path, ten at a time, and never shows keys.

A wrong path can never sign for the wrong account. The signer refuses unless the derived key's address equals the request's address, and the online page checks the signer's address again from the signature before broadcasting.

### No webcam?

Use **Enter by hand** on the signer. The online page lists every value under *Details for typing*. Mixed-case (checksummed) addresses are validated, so most typos are caught.

### Camera access

Chrome and Firefox allow the camera for a file opened directly (`file://…`) after a permission prompt. If your browser refuses, serve the file from localhost (also a secure context), still fully offline:

```sh
cd folder-containing-the-file
python3 -m http.server 8000 --bind 127.0.0.1
# then open http://127.0.0.1:8000/xdc-offline-signer.html
```

## Security model

- **Strict Content-Security-Policy on the signer.** `connect-src 'none'`, `default-src 'none'`, and a single script permitted by its SHA-256 hash. Even on a connected computer, the page can't send anything anywhere, and no other script can run.
- **No dependencies loaded at runtime.** Every library is bundled into the one file. The offline bundle is **not minified**, so it can be read and audited.
- **Libraries.** Signing and hashing use the audited [noble](https://paulmillr.com/noble/) / [scure](https://github.com/paulmillr/scure-bip39) libraries (`@noble/curves`, `@noble/hashes`, `@noble/ciphers`, `@scure/bip32`, `@scure/bip39`). QR codes use `qrcode-generator` and `jsqr`.
- **Signatures.** Deterministic RFC 6979 nonces with low-s signatures. The signer re-decodes its own output and checks it before showing it.
- **Transaction format.** Legacy transactions with EIP-155 replay protection: a Mainnet (50) signature can't be used on Apothem (51) or any other chain. Unprotected (pre-EIP-155) transactions are rejected by the online page.
- **The online page can't make the signer sign something different from what it displays.** The signer derives the calldata and the description from the same transaction object. A compromised online page could still lie about facts the signer can't check: the nonce, the token's decimals and symbol (the raw base-unit amount is always shown too), and the balance used for send-all. The signer shows the exact resulting amount, and the result is checked again against the chain before broadcast.

## Reproducible build

```sh
npm ci
npm run build     # writes index.html, offline/xdc-offline-signer.html, SHA256SUMS
```

The build is deterministic: the same sources and `package-lock.json` produce byte-identical files, so anyone can rebuild and compare against `SHA256SUMS`.

## Tests

```sh
npm test          # core: 400 transactions cross-checked against ethers.js; keystore + all 32 paths vs ethers.js
npm run test:e2e  # full browser run against a local chain (chain ID 50) with the real XDCValidator at 0x…88
```

The end-to-end test compiles the XDPoSChain `XDCValidator.sol`, installs it at `0x…88`, and drives both pages in Chromium. Every request and signed transaction is passed as a rendered QR image and decoded with jsQR. It runs these steps: vote → unvote (max) → withdraw → find-my-candidates → resign → withdraw; token transfer and token send-all; send; replayed-nonce blocking; cancelling a genuinely stuck transaction (mining paused); send-all leaving exactly 0; wrong-key refusal; recovery-phrase auto-discovery on the XDC path, an old-wallet path and a custom path; the address browser; manual entry. It needs `python3 -m http.server 8080` serving the parent folder of this repo.

## Request format (v1)

The QR code shown by the online page is compact JSON:

```json
{"xdcsign":1,"chain":50,"from":"0x…","nonce":12,"gasPrice":"12500000000","gas":21000,
 "action":"sendAll","args":{"to":"0x…","balance":"1234500000000000000000"},"ts":1767000000}
```

| `action` | `args` |
|---|---|
| `send` | `to`, `amount` (wei) |
| `sendAll` | `to`, `balance` (wei). Value = balance − gas × gasPrice |
| `token` | `token`, `to`, `amount` (base units), `decimals`, `symbol`, optional `all` |
| `vote` | `candidate`, `amount` (wei, sent as value) |
| `unvote` | `candidate`, `amount` (wei) |
| `resign` | `candidate` |
| `withdraw` | `blockNumber`, `index` (position in `getWithdrawBlockNumbers()`) |
| `cancel` | none; 0 XDC to `from`, gas exactly 21,000, using the stuck nonce |

Optional `info` holds display-only context (for example, the expected withdraw amount). It never affects the signed bytes.

The signed QR code is plain `0x…` raw transaction hex, so it also works with other broadcast tools. Signed transactions from the old MEW-based XDC offline wallet can be pasted or scanned into the online page.

## Licence

MIT
