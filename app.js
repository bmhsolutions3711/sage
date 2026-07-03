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

// scan-to-connect: BIK Connect hub deep-link (#cfg={api,token}) OR ?api=&token= query
let cfgApi = "", cfgTok = "";
if (location.hash.startsWith("#cfg=")) {
  try {
    const c = JSON.parse(decodeURIComponent(location.hash.slice(5)));
    cfgApi = c.api || ""; cfgTok = c.token || "";
  } catch (e) {}
}
const params = new URLSearchParams(location.search);
let API = (cfgApi || params.get("api") || localStorage.getItem("sage_api") || "http://127.0.0.1:8520").replace(/\/$/, "");
let TOKEN = cfgTok || params.get("token") || localStorage.getItem("sage_token") || "";
if (cfgApi || params.get("api")) localStorage.setItem("sage_api", API);
if (cfgTok || params.get("token")) localStorage.setItem("sage_token", TOKEN);
// scrub creds from the URL so they don't linger in history
if (cfgApi || cfgTok || params.get("api") || params.get("token")) {
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
  $("#review").hidden = v !== "review";
  $("#backBtn").hidden = v === "library";
  if (v === "library") $("#title").textContent = "Sage";
  if (v === "review") $("#title").textContent = "🚩 Review";
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
      const sub = el.querySelector(".muted");
      if (b.status === "processing") {
        el.classList.add("pending");
        sub.textContent = "⏳ Processing… tap to refresh";
        el.onclick = () => loadLibrary();  // let the user pull an update
      } else if (b.status === "error") {
        el.classList.add("failed");
        sub.textContent = "⚠️ " + (b.error || "couldn't read this file");
        el.onclick = () => toast(b.error || "This file couldn't be read");
      } else {
        sub.textContent = `${b.author || ""} · ${b.source_type} · ${b.total_segments} segs`;
        el.onclick = () => openBook(b.id);
      }
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
  // Audio is synthesized on demand by the backend (Piper) the first time a segment is requested,
  // so we always point at /api/audio. audio.onerror (below) advances past any segment that truly
  // can't be produced (e.g. empty text), so a freshly-uploaded book reads aloud start to finish.
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

$("#backBtn").onclick = () => { audio.pause(); showView("library"); loadLibrary(); loadReviewCount(); };
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

// ── Review loop: fold flagged captures into Atlas ──
async function loadReviewCount() {
  try {
    const r = await api("/api/captures?status=raw");
    if (!r.ok) return;
    const caps = await r.json();
    $("#revCount").textContent = caps.length;
    $("#reviewBtn").hidden = caps.length === 0;
  } catch (e) {}
}
async function openReview() {
  showView("review");
  const r = await api("/api/captures?status=raw");
  const caps = r.ok ? await r.json() : [];
  const list = $("#reviewList"); list.innerHTML = "";
  $("#revEmpty").hidden = caps.length > 0;
  caps.forEach(c => {
    const card = document.createElement("div");
    card.className = "rcard";
    card.innerHTML = `
      <div class="rsrc"></div>
      <textarea class="rtext" rows="5"></textarea>
      <input class="rnote" placeholder="Why this matters (becomes Atlas's prompt)…">
      <div class="ractions">
        <button class="discard">Discard</button>
        <button class="promote">🧠 Fold into Atlas</button>
      </div>`;
    card.querySelector(".rsrc").textContent = c.book_title + (c.chapter_title ? " · " + c.chapter_title : "");
    card.querySelector(".rtext").value = (c.polished_text || c.text_raw || "").trim();
    card.querySelector(".rnote").value = c.note || "";
    card.querySelector(".promote").onclick = () => promote(c.id, card);
    card.querySelector(".discard").onclick = () => discard(c.id, card);
    list.appendChild(card);
  });
}
async function promote(id, card) {
  const text = card.querySelector(".rtext").value.trim();
  const note = card.querySelector(".rnote").value.trim();
  if (!text) return toast("Add some text first");
  card.querySelector(".promote").disabled = true;
  await api(`/api/capture/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ polished_text: text, note }) });
  const r = await api(`/api/capture/${id}/promote`, { method: "POST", headers: { "Content-Type": "application/json" } });
  if (r.ok) { card.remove(); toast("🧠 Folded into Atlas"); loadReviewCount(); }
  else { toast("⚠️ promote failed"); card.querySelector(".promote").disabled = false; }
}
async function discard(id, card) {
  await api(`/api/capture/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "discarded" }) });
  card.remove(); loadReviewCount();
}
$("#reviewBtn").onclick = openReview;

// ── In-app book upload (EPUB/PDF) ──
$("#addBookBtn").onclick = () => $("#fileIn").click();
$("#fileIn").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";  // reset so same file can be re-selected
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["pdf", "epub"].includes(ext)) {
    toast("Only PDF and EPUB files are supported");
    return;
  }
  // Show progress UI
  $("#uploadName").textContent = file.name;
  $("#uploadProgress").hidden = false;
  $("#uploadStatus").textContent = "Uploading…";
  $("#pbarFill").style.width = "0%";
  $("#addBookBtn").disabled = true;

  const form = new FormData();
  form.append("file", file);

  try {
    // Use XMLHttpRequest for upload progress
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const u = new URL(API + "/api/upload");
      if (TOKEN) u.searchParams.set("token", TOKEN);
      xhr.open("POST", u.toString());
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100);
          $("#pbarFill").style.width = pct + "%";
          if (pct >= 100) $("#uploadStatus").textContent = "Processing…";
        }
      };
      xhr.onload = () => {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("bad response")); }
      };
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(form);
    });

    if (result.ok && result.book_id) {
      // Upload landed; ingest now runs server-side (30-60s+ for a real book).
      // Poll status so we never block the request on it (that was the old
      // "upload error" bug — the phone connection timed out mid-ingest).
      $("#uploadStatus").textContent = "Processing… (this can take a minute)";
      $("#pbarFill").style.width = "100%";
      await pollIngest(result.book_id);
    } else {
      $("#uploadStatus").textContent = result.error || "Upload failed";
      toast("Upload failed: " + (result.error || "unknown error"));
      setTimeout(() => { $("#uploadProgress").hidden = true; }, 3000);
    }
  } catch (err) {
    $("#uploadStatus").textContent = "Error: " + err.message;
    toast("Upload error — check connection");
    setTimeout(() => { $("#uploadProgress").hidden = true; }, 3000);
  }
  $("#addBookBtn").disabled = false;
};

// Poll ingest status after an async upload. Resolves the progress UI to
// Done (→ open library) or a surfaced error. ~3 min ceiling for a big book.
async function pollIngest(bookId) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    await new Promise(r => setTimeout(r, 2000));
    let st;
    try {
      const r = await api(`/api/book/${bookId}/status`);
      if (!r.ok) continue;
      st = await r.json();
    } catch (e) { continue; }  // transient network blip — keep polling
    if (st.status === "ready") {
      $("#uploadStatus").textContent = "Done!";
      toast("Book added — loading library…");
      setTimeout(() => { $("#uploadProgress").hidden = true; loadLibrary(); }, 1000);
      return;
    }
    if (st.status === "error") {
      $("#uploadStatus").textContent = st.error || "Ingest failed";
      toast("Couldn't read that file: " + (st.error || "unknown error"));
      setTimeout(() => { $("#uploadProgress").hidden = true; loadLibrary(); }, 5000);
      return;
    }
  }
  // Timed out waiting — the book may still finish; refresh the library so it
  // shows up when it does.
  $("#uploadStatus").textContent = "Still processing — check the library shortly";
  setTimeout(() => { $("#uploadProgress").hidden = true; loadLibrary(); }, 3000);
}

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {});

$("#speedBtn").textContent = speed + "×";
loadLibrary();
loadReviewCount();
