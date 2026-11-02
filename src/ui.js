// Small DOM helpers shared by both pages.
import { escapeHtml as esc } from "./core.js";

export const $ = (id) => document.getElementById(id);
export { esc };

export function notice(el, tone, html) {
  if (!html) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.dataset.tone = tone || "";
  el.innerHTML = html;
}
export const errMsg = (e) => esc((e && (e.shortMessage || e.message)) || String(e));

export function kvRows(rows) {
  return rows.map(([k, v, sub, mono]) =>
    `<tr><th scope="row">${esc(k)}</th><td${mono ? ' class="mono"' : ""}>${esc(v)}${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</td></tr>`
  ).join("");
}

// desc from core.describeTx; checks: [{tone:'ok'|'bad'|'warn', text}]
export function renderReview(el, desc, { kicker = "What this transaction does", checks = [] } = {}) {
  el.className = "review kind-" + desc.kind;
  el.innerHTML = `
    <p class="kicker">${esc(kicker)}</p>
    <h3>${esc(desc.title)}</h3>
    <p class="summary">${esc(desc.summary)}</p>
    ${desc.warnings.length ? `<ul class="warn">${desc.warnings.map((w) => `<li><strong>Warning:</strong> ${esc(w)}</li>`).join("")}</ul>` : ""}
    <table class="kv"><tbody>${kvRows(desc.rows)}</tbody></table>
    ${desc.notes.length ? `<ul class="note">${desc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    ${checks.length ? `<ul class="checks">${checks.map((c) => `<li class="${c.tone}">${c.html || esc(c.text)}</li>`).join("")}</ul>` : ""}`;
  el.hidden = false;
}

export function setTabs(segEl, onChange) {
  const btns = [...segEl.querySelectorAll("button[data-tab]")];
  const select = (name) => {
    for (const b of btns) {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", on);
      const panel = document.getElementById(b.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    onChange && onChange(name);
  };
  btns.forEach((b) => b.addEventListener("click", () => select(b.dataset.tab)));
  return select;
}

export async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1400); }
  } catch {
    if (btn) { const t = btn.textContent; btn.textContent = "Copy failed"; setTimeout(() => (btn.textContent = t), 1400); }
  }
}
