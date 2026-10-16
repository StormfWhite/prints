/*
 * Print Finder on a phone. Searches can't run here (the AI planner/ranker needs the laptop's keys,
 * several sites refuse browser calls), so a search is a request file dropped into the shared
 * Dropbox folder (/printfinder/inbox) that the laptop's relay (~/Documents/printfind/relay.py)
 * runs with the real pipeline, writing live progress and results to /printfinder/jobs/<req>.json.
 * The Saved list, search history and learned rules are the laptop app's own files in that folder,
 * read directly — so they're here even when the laptop is off. Hearts, thumbs and deletions go back
 * as requests too, and show immediately (optimistic) until the laptop's files catch up.
 */
"use strict";

const APP_KEY = "qsmbpc4l1v4uini";
const ROOT = "/printfinder";
const LS = "prints.v1";
const SITES = { printables: "Printables", thingiverse: "Thingiverse", cults3d: "Cults3D", makerworld: "MakerWorld", thangs: "Thangs" };
const PAGE = 20;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = (() => {
  const d = { refresh: "", access: "", exp: 0, cursor: "", current: "", sentAt: 0, favorites: [], history: [], memory: { rules: [] }, jobs: {}, verdicts: {} };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(LS) || "{}")); } catch { return d; }
})();
if (!S.refresh) {   // same site as Shared Notes / Meals: reuse a Dropbox connection this browser already has
  for (const k of ["sharednotes.v1", "meals.v1"]) { try { const o = JSON.parse(localStorage.getItem(k) || "{}"); if (o.refresh) { S.refresh = o.refresh; break; } } catch {} }
}
let saveT = 0;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} }, 200); };
const pendingFav = {};   // listing id → wanted saved state, until favorites.json agrees

// ---- Dropbox ------------------------------------------------------------------------------------
const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
async function token() {
  if (S.access && Date.now() < S.exp) return S.access;
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: S.refresh, client_id: APP_KEY }) });
  if (!r.ok) { if (r.status === 400 || r.status === 401) { S.refresh = ""; save(); show(); } throw new Error("Dropbox sign-in " + r.status); }
  const o = await r.json();
  S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000; save();
  return S.access;
}
async function rpc(path, arg) {
  for (let a = 0; ; a++) {
    const r = await fetch("https://api.dropboxapi.com/2/" + path, { method: "POST",
      headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" }, body: JSON.stringify(arg) });
    if (r.status === 401 && a === 0) { S.exp = 0; continue; }
    if (r.status === 429 && a < 3) { await sleep(3000); continue; }
    const t = await r.text();
    if (!r.ok) { const e = new Error(path + " " + r.status); e.status = r.status; e.body = t; throw e; }
    return JSON.parse(t);
  }
}
async function download(path) {
  const r = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST",
    headers: { Authorization: "Bearer " + (await token()), "Dropbox-API-Arg": asciiJson({ path }) } });
  if (r.status === 409) return null;
  if (!r.ok) throw new Error("download " + r.status);
  return r.json();
}
async function upload(path, obj) {
  const r = await fetch("https://content.dropboxapi.com/2/files/upload", { method: "POST",
    headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": asciiJson({ path, mode: "overwrite", mute: true }) }, body: new TextEncoder().encode(JSON.stringify(obj)) });
  if (!r.ok) throw new Error("upload " + r.status);
}

/** Ask the laptop to do something. */
let opN = 0;
async function send(op) {
  const name = `${S.current || "x"}-${Date.now().toString(36)}-${opN++}.json`;
  try { await upload(`${ROOT}/inbox/${name}`, op); }
  catch (e) { toast("Couldn't reach Dropbox — " + e.message); throw e; }
}

// ---- data ---------------------------------------------------------------------------------------
async function loadFile(name) {
  const d = await download(`${ROOT}/${name}`);
  if (d === null) return;
  if (name === "favorites.json") {
    S.favorites = d;
    for (const id of Object.keys(pendingFav)) if (isSavedRaw(id) === pendingFav[id]) delete pendingFav[id];
  } else if (name === "history.json") S.history = d;
  else if (name === "memory.json") S.memory = d;
  else if (name.startsWith("jobs/")) {
    const req = name.slice(5, -5);
    S.jobs = { [req]: d, ...(S.current === req ? {} : { [S.current]: S.jobs[S.current] }) };   // keep just the one on screen
  }
  save();
}

async function firstLoad() {
  let page = await rpc("files/list_folder", { path: ROOT, recursive: true });
  while (page.has_more) page = await rpc("files/list_folder/continue", { cursor: page.cursor });
  S.cursor = page.cursor;
  await Promise.all(["favorites.json", "history.json", "memory.json"].map(loadFile));
  if (S.current) await loadFile(`jobs/${S.current}.json`);
  save();
  render();
}

async function catchUp() {
  if (!S.cursor) return firstLoad();
  let page;
  try { page = await rpc("files/list_folder/continue", { cursor: S.cursor }); }
  catch (e) { if (e.status === 409) { S.cursor = ""; return firstLoad(); } throw e; }
  const changed = new Set();
  for (;;) {
    for (const e of page.entries) {
      if (e[".tag"] !== "file") continue;
      const rel = e.path_lower.slice(ROOT.length + 1);
      if (["favorites.json", "history.json", "memory.json"].includes(rel) || rel === `jobs/${(S.current || "").toLowerCase()}.json`) changed.add(rel);
    }
    S.cursor = page.cursor;
    if (!page.has_more) break;
    page = await rpc("files/list_folder/continue", { cursor: page.cursor });
  }
  for (const rel of changed) await loadFile(rel === `jobs/${(S.current || "").toLowerCase()}.json` ? `jobs/${S.current}.json` : rel);
  save();
  if (changed.size) render();
}

let polling = false;
async function longpoll() {
  if (polling) return;
  polling = true;
  try {
    while (document.visibilityState === "visible" && S.cursor) {
      try {
        const r = await fetch("https://notify.dropboxapi.com/2/files/list_folder/longpoll", { method: "POST",
          headers: { "Content-Type": "text/plain; charset=dropbox-cors-hack" }, body: JSON.stringify({ cursor: S.cursor, timeout: 30 }) });
        const o = await r.json();
        if (o.changes) await catchUp();
        if (o.backoff) await sleep(o.backoff * 1000);
      } catch { await sleep(6000); }
      renderState();   // the "is the laptop on?" hint ages even when nothing arrives
    }
  } finally { polling = false; }
}

// ---- searching ----------------------------------------------------------------------------------
async function search(text) {
  text = text.trim();
  if (!text) return;
  S.current = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  S.sentAt = Date.now();
  S.jobs = { [S.current]: { req: S.current, description: text, status: "sent", site_status: {}, plan: {}, results: [] } };
  shown = PAGE;
  save();
  render();
  scrollTo({ top: 0 });
  $("#q").blur();
  await send({ op: "search", req: S.current, description: text });
  S.history = [{ description: text, at: Date.now() / 1000 }, ...S.history.filter((h) => h.description !== text)];
  longpoll();
}

const job = () => S.jobs[S.current];
const isSavedRaw = (id) => S.favorites.some((f) => f.id === id);
const isSaved = (id) => (id in pendingFav ? pendingFav[id] : isSavedRaw(id));

async function toggleSave(item) {
  const want = !isSaved(item.id);
  pendingFav[item.id] = want;
  syncHearts();
  const listing = { ...item }; delete listing.score; delete listing.reason;
  listing.id = item.id.slice(item.id.indexOf(":") + 1);
  await send(want ? { op: "favorite", req: S.current, listing_id: item.id, listing } : { op: "fav_remove", listing_id: item.id });
  toast(want ? "Saved" : "Removed from Saved");
}

async function verdict(item, relevant) {
  S.verdicts[item.id] = relevant; save();
  syncDetail(item);
  await send({ op: "feedback", req: S.current, listing_id: item.id, relevant });
  toast(relevant ? "Thanks — more like this" : "Got it — fewer like this");
}

// ---- rendering ----------------------------------------------------------------------------------
let shown = PAGE;

function show() {
  const ok = !!S.refresh;
  $("#connect").classList.toggle("hidden", ok);
  $("#app").classList.toggle("hidden", !ok);
  if (ok) render();
}

function render() { renderState(); renderResults(); syncHearts(); }

function renderState() {
  const j = job(), el = $("#state");
  if (!j) { el.innerHTML = ""; return; }
  const sites = Object.keys(SITES).map((k) => {
    const s = (j.site_status || {})[k] || { status: j.status === "sent" ? "pending" : "pending", count: 0 };
    const cls = s.error ? "error" : s.status === "done" ? "done" : j.status === "done" ? "done" : "running";
    return `<span class="chip ${cls}"><span class="dot"></span>${SITES[k]}${s.status === "done" || s.count ? ` <b>${s.count}</b>` : ""}</span>`;
  }).join("");
  let msg = "";
  if (j.status === "sent") {
    const waited = (Date.now() - S.sentAt) / 1000;
    msg = waited > 25
      ? `<div class="msg warn"><svg class="i"><use href="#i-laptop"/></svg>Waiting for the laptop — it runs the search. Is it on and awake?</div>`
      : `<div class="msg"><span class="spin"></span>Sent to the laptop…</div>`;
  } else if (j.status === "running") msg = `<div class="msg"><span class="spin"></span>Searching ${Object.keys(SITES).length} sites on the laptop…</div>`;
  else if (j.status === "error") msg = `<div class="msg warn">The search failed: ${esc(j.error || "unknown error")}</div>`;
  const p = j.plan || {};
  const plan = p.subject ? `<div class="plan">Looking for <b>${esc(p.subject)}</b>${(p.must_have || []).length ? " · must have " + (p.must_have || []).map(esc).join(", ") : ""}</div>` : "";
  const refine = j.status === "done" ? `<form class="refine" id="rf"><input id="rq" placeholder="Refine: “smaller”, “no supports”…" autocomplete="off"><button>Refine</button></form>` : "";
  el.innerHTML = `<div class="sites">${sites}</div>${msg}${plan}${refine}`;
  const rf = $("#rf");
  if (rf) rf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = $("#rq").value.trim();
    if (!note) return;
    j.status = "sent"; S.sentAt = Date.now(); save(); renderState();
    await send({ op: "refine", req: S.current, note });
    longpoll();
  });
}

function priceHtml(it) {
  if (it.is_free) return `<span class="price free">Free</span>`;
  if (it.price) return `<span class="price paid">${esc(typeof it.price === "number" ? "$" + it.price.toFixed(2) : it.price)}</span>`;
  return "";
}

function cardHtml(it, i) {
  const img = (it.images || [])[0];
  const sc = Math.round(it.score ?? -1);
  return `<button class="card" data-i="${i}">
    <div class="img" ${img ? `style="background-image:url('${esc(img).replace(/'/g, "%27")}')"` : ""}></div>
    <div class="t">${esc(it.title)}</div>
    <div class="m">${esc(SITES[it.site] || it.site)} ${priceHtml(it)}${sc >= 0 ? `<span class="score ${sc >= 75 ? "hi" : ""}">${sc}</span>` : ""}</div>
    <span class="heart" data-fav="${esc(it.id)}" role="button" aria-label="Save"><svg class="i"><use href="#i-heart"/></svg></span>
  </button>`;
}

let listed = [];
function renderResults() {
  const el = $("#results"), j = job();
  if (!j) {
    el.innerHTML = `<div class="empty">Describe a model in plain words — “wall mount for a small router”, “cable clip that fits a desk edge”. Your laptop searches Printables, Thingiverse, Cults3D, MakerWorld and Thangs, and ranks what it finds.</div>`;
    return;
  }
  listed = [...(j.results || [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (!listed.length) { el.innerHTML = j.status === "done" ? `<div class="empty">Nothing matched. Try different words.</div>` : ""; return; }
  el.innerHTML = `<div class="grid">${listed.slice(0, shown).map(cardHtml).join("")}</div>` +
    (listed.length > shown ? `<button class="more" id="more">Show more (${listed.length - shown})</button>` : "");
  const m = $("#more");
  if (m) m.addEventListener("click", () => { shown += PAGE; renderResults(); syncHearts(); });
}

function syncHearts() {
  for (const h of document.querySelectorAll("[data-fav]")) h.classList.toggle("on", isSaved(h.dataset.fav));
  const n = S.favorites.length + Object.entries(pendingFav).filter(([id, v]) => v && !isSavedRaw(id)).length
    - Object.entries(pendingFav).filter(([id, v]) => !v && isSavedRaw(id)).length;
  $("#n-saved").textContent = n; $("#n-saved").classList.toggle("hidden", !n);
}

document.addEventListener("click", (e) => {
  const h = e.target.closest("[data-fav]");
  if (h) {
    e.stopPropagation();
    const id = h.dataset.fav;
    const it = listed.find((x) => x.id === id) || savedItems().find((x) => x.id === id);
    if (it) toggleSave(it);
    return;
  }
  const c = e.target.closest(".card");
  if (c && c.closest("#results")) openDetail(listed[Number(c.dataset.i)], true);
  else if (c && c.closest(".sheet")) openDetail(savedItems()[Number(c.dataset.i)], false);
});

// ---- sheets -------------------------------------------------------------------------------------
function sheet(html, onOpen) {
  const sc = document.createElement("div"); sc.className = "scrim";
  const sh = document.createElement("div"); sh.className = "sheet";
  sh.innerHTML = `<div class="grab"></div>` + html;
  const close = () => { sh.classList.remove("on"); sc.classList.remove("on"); setTimeout(() => { sh.remove(); sc.remove(); }, 300); };
  sc.addEventListener("click", close);
  document.body.append(sc, sh);
  requestAnimationFrame(() => { sc.classList.add("on"); sh.classList.add("on"); });
  let y0 = null;   // swipe down from the top to dismiss
  sh.addEventListener("touchstart", (e) => { y0 = sh.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  sh.addEventListener("touchend", (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 90) close(); y0 = null; });
  for (const x of sh.querySelectorAll("[data-close]")) x.addEventListener("click", close);
  if (onOpen) onOpen(sh, close);
  return close;
}

const plainText = (html) => {
  const d = new DOMParser().parseFromString(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n"), "text/html");
  return (d.body.textContent || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
};

function embed(u) {
  const y = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{6,})/.exec(u);
  if (y) return `https://www.youtube.com/embed/${y[1]}`;
  const v = /vimeo\.com\/(\d+)/.exec(u);
  if (v) return `https://player.vimeo.com/video/${v[1]}`;
  return null;
}

function openDetail(it, live) {
  if (!it) return;
  if (live) send({ op: "engagement", req: S.current, listing_id: it.id, kind: "open" }).catch(() => {});
  const media = [...(it.images || []).map((u) => `<img src="${esc(u)}" loading="lazy" referrerpolicy="no-referrer" alt="">`),
    ...(it.videos || []).map((u) => /\.(mp4|webm|mov)(\?|$)/i.test(u) ? `<video src="${esc(u)}" controls playsinline preload="none"></video>`
      : embed(u) ? `<iframe src="${esc(embed(u))}" allow="fullscreen" loading="lazy"></iframe>` : "")].filter(Boolean);
  const desc = plainText(it.description);
  const v = S.verdicts[it.id];
  sheet(`
    <div class="gal">${media.join("") || `<div style="aspect-ratio:1;width:100%"></div>`}</div>
    ${media.length > 1 ? `<div class="dots">${media.map((_, k) => `<i class="${k ? "" : "on"}"></i>`).join("")}</div>` : ""}
    <div class="d-body">
      <h3>${esc(it.title)}</h3>
      <div class="meta">${esc(SITES[it.site] || it.site)} ${priceHtml(it)} ${it.license ? `<span>${esc(it.license)}</span>` : ""}
        ${it.score != null ? `<span class="score ${it.score >= 75 ? "hi" : ""}">${Math.round(it.score)} match</span>` : ""}</div>
      ${it.reason ? `<div class="why"><b>Why:</b> ${esc(it.reason)}</div>` : ""}
      <div class="acts">
        <a class="open" href="${esc(it.url)}" target="_blank" rel="noopener" id="d-open"><svg class="i"><use href="#i-ext"/></svg>Open on ${esc(SITES[it.site] || "site")}</a>
        <button class="sq ${isSaved(it.id) ? "on" : ""}" data-fav="${esc(it.id)}" aria-label="Save"><svg class="i"><use href="#i-heart"/></svg></button>
        ${live ? `<button class="sq up ${v === true ? "on" : ""}" id="d-up" aria-label="Good match"><svg class="i"><use href="#i-up"/></svg></button>
        <button class="sq down ${v === false ? "on" : ""}" id="d-down" aria-label="Bad match"><svg class="i"><use href="#i-down"/></svg></button>` : ""}
      </div>
      ${(it.tags || []).length ? `<div class="tags">${it.tags.slice(0, 24).map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
      ${desc ? `<div class="desc" id="d-desc">${esc(desc)}</div><button class="desc-more hidden" id="d-more">More</button>` : ""}
    </div>`, (sh) => {
    detailEl = sh; detailItem = it;
    const g = sh.querySelector(".gal"), dots = sh.querySelectorAll(".dots i");
    g.addEventListener("scroll", () => { const k = Math.round(g.scrollLeft / g.clientWidth); dots.forEach((d, n) => d.classList.toggle("on", n === k)); }, { passive: true });
    const d = sh.querySelector("#d-desc"), m = sh.querySelector("#d-more");
    if (d && d.scrollHeight > d.clientHeight + 4) { m.classList.remove("hidden"); m.addEventListener("click", () => { d.classList.add("open"); m.remove(); }); }
    sh.querySelector("#d-open").addEventListener("click", () => { if (live) send({ op: "engagement", req: S.current, listing_id: it.id, kind: "visit" }).catch(() => {}); });
    if (live) {
      sh.querySelector("#d-up").addEventListener("click", () => verdict(it, true));
      sh.querySelector("#d-down").addEventListener("click", () => verdict(it, false));
    }
    syncHearts();
  });
}
let detailEl = null, detailItem = null;
function syncDetail(it) {
  if (!detailEl || detailItem !== it) return;
  const v = S.verdicts[it.id];
  detailEl.querySelector("#d-up")?.classList.toggle("on", v === true);
  detailEl.querySelector("#d-down")?.classList.toggle("on", v === false);
}

function savedItems() {
  return S.favorites.filter((f) => f.listing).map((f) => ({ ...f.listing, id: f.id, saved_at: f.saved_at || 0 }))
    .sort((a, b) => b.saved_at - a.saved_at);
}

$("#b-saved").addEventListener("click", () => {
  const items = savedItems();
  sheet(`<h2><svg class="i" style="color:var(--heart)"><use href="#i-heart"/></svg>Saved <span style="color:var(--dim);font-weight:500">${items.length}</span>
    <button class="ib x" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></h2>
    ${items.length ? `<div class="grid">${items.map((it, i) => cardHtml({ ...it, score: undefined }, i)).join("")}</div>` : `<div class="empty">Tap the heart on a model to keep it here.</div>`}`,
  () => syncHearts());
});

const ago = (sec) => {
  const d = (Date.now() / 1000 - sec) / 86400;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)} days ago` : new Date(sec * 1000).toLocaleDateString();
};

$("#b-hist").addEventListener("click", () => {
  sheet(`<h2>Recent searches<button class="ib x" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></h2>
    ${S.history.length ? `<div class="list">${S.history.map((h, i) => `<div class="li"><button class="tx" data-run="${i}" style="text-align:left">${esc(h.description)}<small>${ago(h.at)}</small></button>
      <button class="del" data-rm="${i}" aria-label="Remove"><svg class="i"><use href="#i-x"/></svg></button></div>`).join("")}</div>` : `<div class="empty">Nothing yet.</div>`}`,
  (sh, close) => {
    sh.addEventListener("click", (e) => {
      const r = e.target.closest("[data-run]"), d = e.target.closest("[data-rm]");
      if (r) { const t = S.history[Number(r.dataset.run)].description; close(); $("#q").value = t; grow(); search(t); }
      if (d) { const h = S.history[Number(d.dataset.rm)]; S.history = S.history.filter((x) => x !== h); save(); d.closest(".li").remove(); send({ op: "history_remove", description: h.description }); }
    });
  });
});

$("#b-learn").addEventListener("click", () => {
  const rules = (S.memory.rules || []).slice().sort((a, b) => (b.status === "active") - (a.status === "active") || (b.confidence || 0) - (a.confidence || 0));
  sheet(`<h2>What it's learned<button class="ib x" data-close aria-label="Close"><svg class="i"><use href="#i-x"/></svg></button></h2>
    <p style="margin:-4px 16px 10px;color:var(--dim);font-size:13px">From your hearts, thumbs and clicks. Remove anything that's wrong.</p>
    ${rules.length ? `<div class="list">${rules.map((r) => `<div class="li"><div class="tx">${esc(r.insight)}<small><span class="pill ${r.status === "active" ? "active" : ""}">${esc(r.status)}</span>
      ${Math.round((r.confidence || 0) * 100)}% · ${esc((r.scope_keywords || []).join(", "))}</small></div>
      <button class="del" data-forget="${esc(r.id)}" aria-label="Forget"><svg class="i"><use href="#i-x"/></svg></button></div>`).join("")}</div>` : `<div class="empty">Nothing learned yet.</div>`}`,
  (sh) => sh.addEventListener("click", (e) => {
    const f = e.target.closest("[data-forget]");
    if (!f) return;
    S.memory.rules = (S.memory.rules || []).filter((r) => r.id !== f.dataset.forget); save();
    f.closest(".li").remove();
    send({ op: "forget", rule_id: f.dataset.forget });
  }));
});

// ---- search box ---------------------------------------------------------------------------------
const grow = () => { const q = $("#q"); q.style.height = "auto"; q.style.height = Math.min(120, q.scrollHeight) + "px"; };
$("#q").addEventListener("input", grow);
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); search($("#q").value); } });
$("#qf").addEventListener("submit", (e) => { e.preventDefault(); search($("#q").value); });

let toastT = 0;
function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("on"), 1800); }

// ---- connect ------------------------------------------------------------------------------------
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
$("#go-auth").addEventListener("click", async () => {
  const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(LS + ".pkce", v);
  const ch = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  window.open("https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({ client_id: APP_KEY, response_type: "code",
    token_access_type: "offline", code_challenge_method: "S256", code_challenge: ch }), "_blank");
  $("#code-step").classList.remove("hidden");
});
$("#finish-auth").addEventListener("click", async () => {
  const code = $("#code").value.trim();
  if (!code) return;
  try {
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: APP_KEY, code_verifier: localStorage.getItem(LS + ".pkce") || "" }) });
    const o = await r.json();
    if (!r.ok) throw new Error(o.error_description || o.error || r.status);
    S.refresh = o.refresh_token; S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000; save();
    show(); firstLoad().then(longpoll);
  } catch (e) { $("#auth-err").textContent = "That didn't work (" + e.message + "). Tap Connect Dropbox for a fresh code."; }
});

// ---- start --------------------------------------------------------------------------------------
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.refresh) catchUp().then(longpoll).catch(() => {}); });
show();
if (S.refresh) (S.cursor ? catchUp() : firstLoad()).then(longpoll).catch((e) => { console.warn(e); render(); });
window.__prints = { S, search, catchUp };
