// Builds the two pages into single self-contained HTML files.
//   index.html                          online companion (GitHub Pages root)
//   offline/xdc-offline-signer.html     offline signer (copy to the airgapped computer)
//   SHA256SUMS                          checksums of both
// Output is deterministic: the same sources and lockfile give byte-identical files.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const VERSION = pkg.version;
const css = readFileSync("src/style.css", "utf8");

async function bundle(entry, minify = false) {
  const r = await build({
    entryPoints: [entry], bundle: true, write: false, format: "iife", target: "es2020",
    minify, legalComments: "inline", charset: "utf8",
    define: { __VERSION__: JSON.stringify(VERSION) },
  });
  let js = r.outputFiles[0].text;
  // Never let the bundle close the <script> element early.
  js = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
  return js;
}

function fill(tpl, js) {
  let html = tpl.replaceAll("__VERSION__", VERSION).replace("/*__CSS__*/", () => css);
  const hash = "sha256-" + createHash("sha256").update(js, "utf8").digest("base64");
  html = html.replace("__SCRIPT_HASH__", hash).replace("/*__JS__*/", () => js);
  return html;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

const offline = fill(readFileSync("src/offline.html", "utf8"), await bundle("src/offline.js"));
const online = fill(readFileSync("src/online.html", "utf8").replace("__OFFLINE_SHA__", sha(offline)), await bundle("src/online.js", true));

mkdirSync("offline", { recursive: true });
writeFileSync("offline/xdc-offline-signer.html", offline);
writeFileSync("index.html", online);
writeFileSync("SHA256SUMS", `${sha(offline)}  offline/xdc-offline-signer.html\n${sha(online)}  index.html\n`);
writeFileSync("offline/VERSION", VERSION + "\n");
console.log(`v${VERSION}  offline ${(offline.length / 1024).toFixed(0)} KB  sha256 ${sha(offline)}`);
console.log(`v${VERSION}  online  ${(online.length / 1024).toFixed(0)} KB  sha256 ${sha(online)}`);
