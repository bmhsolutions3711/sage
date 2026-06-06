/* Sage PWA shell — book player + 🚩 flag. Talks to the tailnet backend (:8520).
   Token/API come from the scan-to-connect URL (?api=&token=) or the ⚙ dialog. */
"use strict";

// --- hard reset (pwa-standard #reset nuke) ---
if (location.hash === "#reset") {
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
  if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
  localStorage.clear();
  location.hash = "";
  location.reload();
}

const $ = s => document.querySelector(s);
const params = new URLSearchParams(location.search);
let API = (params.get("api") || localStorage.getItem("sage_api") || "http://127.0.0.1:8520").replace(/\/$/, "");
let TOKEN = params.get("token") || localStorage.getItem("sage_token") || "";
if (params.get("api")) localStorage.setItem("sage_api", API);
if (params.get("token")) localStorage.setItem("sage_token", TOKEN);
// scrub api/token from the visible URL so credentials don't linger in history
if (params.get("api") || params.get("token")) {
  try { history.replaceState({}, "", location.pathname); } catch (e) {}
}

const audio = $("#audio");
let book = null, segs = [], cur = 0;
let speed = parseFloat(localStorage.getItem("sage_speed") || "1");

const api = (path, opts = {}) => {
  const u = new URL(API + path);
  if (TOKEN) u.searchParams.set("token", TOKEN);
  return fetch(u.toString(), opts);
};
const audioURL = i => `${API}/api/audio/${book.book.id}/${i}?token=${encodeURIComponent(TOKEN)}`;

function showView(v) {
  $("#library").hidden = v !== "library";
  $("#player").hidden = v !== "player";
  $("#playerBar").hidden = v !== "player";
  $("#backBtn").hidden = v === "library";
  if (v === "library") $("#title").textContent = "Sage";
}

async function loadLibrary() {
  try {
    const r = await api("/api/books");
    if (r.status === 401) return openConn();
    const books = await r.json();
    const list = $("#bookList"); list.innerHTML = "";
    $("#libEmpty").hidden = books.length > 0;
    books.forEach(b => {
      const el = document.createElement("button");
      el.className = "card";
      el.innerHTML = `<div class="bt"></div><div class="muted"></div>`;
      el.querySelector(".bt").textContent = b.title;
      el.querySelector(".muted").textContent = `${b.author || ""} · ${b.source_type} · ${b.total_segments} segs`;
      el.onclick = () => openBook(b.id);
      list.appendChild(el);
    });
  } catch (e) { openConn(); }
}

async function openBook(id) {
  const r = await api(`/api/book/${id}`);
  book = await r.json();
  segs = book.segments || [];
  $("#title").textContent = book.book.title;
  showView("player");
  renderReader();
  setupMediaSession();
  const pos = book.position || { segment_idx: 0, audio_ms: 0 };
  cur = Math.min(pos.segment_idx || 0, Math.max(0, segs.length - 1));
  loadSeg(cur, (pos.audio_ms || 0) / 1000, false);
}

function renderReader() {
  const rd = $("#reader"); rd.innerHTML = "";
  segs.forEach((s, i) => {
    const p = document.createElement("p");
    p.className = "seg"; p.id = "seg" + i;
    p.textContent = s.text;
    p.onclick = () => loadSeg(i, 0, true);
    rd.appendChild(p);
  });
}

function highlight() {
  document.querySelectorAll(".seg.active").forEach(e => e.classList.remove("active"));
  const el = $("#seg" + cur);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  const ch = (book.chapters || []).find(c => segs[cur] && segs[cur].chapter_id === c.id);
  $("#nowChapter").textContent = ch ? ch.title : "";
}

function loadSeg(i, atSec = 0, autoplay = true) {
  if (i < 0 || i >= segs.length) return;
  cur = i;
  highlight();
  if (!segs[i].has_audio) {           // no audio yet (e.g., chapter not synthesized) — skip ahead
    if (autoplay && i < segs.length - 1) return loadSeg(i + 1, 0, true);
    return;
  }
  audio.src = audioURL(segs[i].idx);
  audio.playbackRate = speed;
  audio.oncanplay = () => {
    if (atSec) { try { audio.currentTime = atSec; } catch (e) {} }
    if (autoplay) audio.play().catch(() => {});
    audio.oncanplay = null;
  };
  savePos();
}

audio.onended = () => { if (cur < segs.length - 1) loadSeg(cur + 1, 0, true); else setPlay(false); };
audio.onerror = () => { if (cur < segs.length - 1) loadSeg(cur + 1, 0, true); };
audio.onplay = () => setPlay(true);
audio.onpause = () => { setPlay(false); savePos(); };

function setPlay(p) { $("#playBtn").textContent = p ? "⏸" : "▶︎"; }
function seek(d) {
  const t = audio.currentTime + d;
  if (t < 0) { if (cur > 0) loadSeg(cur - 1, 1e9, true); else audio.currentTime = 0; return; }
  if (t > audio.duration) { if (cur < segs.length - 1) loadSeg(cur + 1, 0, true); return; }
  audio.currentTime = t;
}

$("#playBtn").onclick = () => { audio.paused ? audio.play().catch(() => {}) : audio.pause(); };
$("#back15").onclick = () => seek(-15);
$("#fwd15").onclick = () => seek(15);
$("#prevSeg").onclick = () => loadSeg(cur - 1, 0, true);
$("#nextSeg").onclick = () => loadSeg(cur + 1, 0, true);
$("#speedBtn").onclick = () => {
  const sp = [1, 1.25, 1.5, 1.75, 2, 0.85];
  speed = sp[(sp.indexOf(speed) + 1) % sp.length];
  audio.playbackRate = speed;
  localStorage.setItem("sage_speed", String(speed));
  $("#speedBtn").textContent = speed + "×";
};

$("#flagBtn").onclick = async () => {
  if (!book || !segs[cur]) return;
  if (navigator.vibrate) navigator.vibrate(40);
  try {
    const r = await api("/api/flag", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        book_id: book.book.id, segment_idx: segs[cur].idx,
        ms_into_segment: Math.floor((audio.currentTime || 0) * 1000)
      })
    });
    const j = await r.json();
    toast(`🚩 Captured ${j.segments || 0} segments → review later`);
  } catch (e) { toast("⚠️ flag failed — check connection"); }
};

let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800);
}

let posT = 0;
function savePos() {
  if (!book || !segs[cur]) return;
  const now = Date.now(); if (now - posT < 1500) return; posT = now;
  api(`/api/position/${book.book.id}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      segment_id: segs[cur].id, segment_idx: segs[cur].idx,
      audio_ms: Math.floor((audio.currentTime || 0) * 1000), speed
    })
  }).catch(() => {});
}
setInterval(savePos, 5000);

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: book.book.title, artist: book.book.author || "Sage", album: "Sage"
  });
  const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch (e) {} };
  set("play", () => audio.play()); set("pause", () => audio.pause());
  set("seekbackward", () => seek(-15)); set("seekforward", () => seek(15));
  set("previoustrack", () => loadSeg(cur - 1, 0, true));
  set("nexttrack", () => loadSeg(cur + 1, 0, true));
}

$("#backBtn").onclick = () => { audio.pause(); showView("library"); loadLibrary(); };
$("#connBtn").onclick = () => openConn();
function openConn() { $("#apiIn").value = API; $("#tokIn").value = TOKEN; $("#connDlg").showModal(); }
$("#connDlg").addEventListener("close", () => {
  if ($("#connDlg").returnValue === "save") {
    API = ($("#apiIn").value.trim() || API).replace(/\/$/, "");
    TOKEN = $("#tokIn").value.trim();
    localStorage.setItem("sage_api", API);
    localStorage.setItem("sage_token", TOKEN);
    loadLibrary();
  }
});

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {});

$("#speedBtn").textContent = speed + "×";
loadLibrary();
