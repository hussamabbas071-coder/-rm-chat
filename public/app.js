import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, collection, doc, addDoc, setDoc, getDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, limitToLast, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, ALLOWED_UIDS, NAMES, ICE_SERVERS, KEY_SALT } from "./config.js";
import * as E2E from "./crypto.js";
import { CallManager } from "./call.js";

const fb = initializeApp(firebaseConfig);
// بدون popup/redirect: ما يحمّل أي سكربت أو iframe خارجي
const auth = initializeAuth(fb, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
// كاش محلي: الرسائل (المشفّرة) تطلع فوراً من تفتح، وتشتغل حتى بدون نت
let db;
try { db = initializeFirestore(fb, { localCache: persistentLocalCache() }); }
catch { db = initializeFirestore(fb, {}); }

const $ = (id) => document.getElementById(id);
const msgCol = () => collection(db, "rooms", "main", "messages");
const verifierRef = () => doc(db, "rooms", "main", "meta", "verifier");
const VERIFY = "rm-ok";

let me = null, partner = null, key = null, call = null;
let unsubs = [];
let partnerOnline = false;
const startedAt = Date.now();
const pendingRead = [];

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

function show(id) { document.querySelectorAll(".screen").forEach((s) => (s.hidden = s.id !== id)); }
function toast(t, ms = 2600) {
  const el = $("toast"); el.textContent = t; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms);
}
const nameOf = (uid) => NAMES[uid] || "";
const initial = (uid) => (nameOf(uid) || "؟").trim().charAt(0);

// ---------- آيفون: الكيبورد ما يغطي خانة الكتابة ----------
const vv = window.visualViewport;
function fitViewport() {
  const h = vv ? vv.height : window.innerHeight;
  const root = document.documentElement;
  root.style.setProperty("--app-h", h + "px");
  root.style.setProperty("--app-top", (vv ? vv.offsetTop : 0) + "px");
  root.classList.toggle("kb", window.innerHeight - h > 120);
}
vv?.addEventListener("resize", fitViewport);
vv?.addEventListener("scroll", fitViewport);
fitViewport();

// ---------- الرنين (آيفون يحتاج لمسة أولى حتى يشتغل الصوت) ----------
const ring = {
  ctx: null, t: null,
  unlock() { try { this.ctx ??= new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state !== "running") this.ctx.resume(); } catch {} },
  tone(freqs, gain, len) {
    const c = this.ctx; if (!c) return;
    const now = c.currentTime;
    freqs.forEach(([f, d]) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + d);
      g.gain.exponentialRampToValueAtTime(gain, now + d + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, now + d + len);
      o.connect(g).connect(c.destination); o.start(now + d); o.stop(now + d + len + 0.02);
    });
  },
  start(mode = "in") {
    this.stop(); this.unlock();
    const beat = mode === "in"
      ? () => { this.tone([[660, 0], [880, 0.35]], 0.18, 0.3); navigator.vibrate?.([300, 200, 300]); }
      : () => this.tone([[425, 0]], 0.06, 1.0);
    beat(); this.t = setInterval(beat, mode === "in" ? 2000 : 3000);
  },
  stop() { clearInterval(this.t); this.t = null; },
};
document.addEventListener("pointerdown", () => ring.unlock());

// ---------- إبقاء الشاشة شغالة وقت المكالمة ----------
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock) wakeLock = await navigator.wakeLock?.request("screen");
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}

// ---------- الدخول ----------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; $("login-error").textContent = "";
  try { await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value); }
  catch (err) {
    $("login-error").textContent =
      err.code === "auth/too-many-requests" ? "محاولات كثيرة. انتظر شوية وجرّب." :
      err.code === "auth/network-request-failed" ? "ماكو نت" :
      "الإيميل أو كلمة السر غلط";
  } finally { btn.disabled = false; $("password").value = ""; }
});

onAuthStateChanged(auth, async (user) => {
  teardown();
  if (!user) { show("login"); return; }
  if (!ALLOWED_UIDS.includes(user.uid)) {
    await signOut(auth);
    $("login-error").textContent = "هذا الحساب غير مسموح له";
    return;
  }
  me = user.uid;
  partner = ALLOWED_UIDS.find((u) => u !== me);
  try {
    const saved = await E2E.KeyStore.load(me);
    if (saved) {
      const ok = await verifyKey(saved, true);
      if (ok) { key = saved; startChat(); return; }
      await E2E.KeyStore.clear(me);
    }
    await prepareUnlock();
    show("unlock");
  } catch (err) {
    await signOut(auth);
    $("login-error").textContent = err?.code === "permission-denied"
      ? "السيرفر رفض الحساب — تأكد إن الـ UID مكتوب صح بقواعد Firestore"
      : "صار خطأ، جرّب مرة ثانية";
  }
});

// ---------- مفتاح التشفير ----------
async function readVerifier() {
  const snap = await getDoc(verifierRef());
  return snap.exists() ? snap.data() : null;
}
async function keyMatches(k, v) {
  try { return (await E2E.decryptText(k, v)) === VERIFY; } catch { return false; }
}
// offlineOk: إذا ماكو نت والمفتاح محفوظ، نفتح من الكاش
async function verifyKey(k, offlineOk = false) {
  let v;
  try { v = await readVerifier(); }
  catch (err) { if (err?.code === "permission-denied") throw err; return offlineOk; }
  if (!v) return false;
  return keyMatches(k, v);
}

let setupMode = false;
async function prepareUnlock() {
  try { setupMode = !(await readVerifier()); } catch (err) { if (err?.code === "permission-denied") throw err; setupMode = false; }
  $("confirm-wrap").hidden = !setupMode;
  $("passphrase2").required = setupMode;
  $("unlock-sub").textContent = setupMode
    ? "أول مرة: اختار جملة طويلة (12 حرف أو أكثر) وقولها للطرف الثاني بمكالمة أو وجهاً لوجه، مو بالكتابة."
    : "اكتب نفس الكلمة اللي اتفقتوا عليها. ما تنحفظ بأي سيرفر، وبدونها الرسائل ما تنقرا.";
}

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter, label = btn.textContent;
  const err = (t) => ($("unlock-error").textContent = t);
  err("");
  const pass = $("passphrase").value;
  if (setupMode) {
    if (pass.length < 12) return err("خليها 12 حرف أو أكثر");
    if (pass !== $("passphrase2").value) return err("الكلمتين مو متطابقة");
  }
  btn.disabled = true; btn.textContent = "جاري الفتح…";
  try {
    const k = await E2E.deriveKey(pass, KEY_SALT);
    const v = await readVerifier();
    if (!v) await setDoc(verifierRef(), await E2E.encryptText(k, VERIFY));
    else if (!(await keyMatches(k, v))) return err("الكلمة غلط — لازم تكون نفس كلمة الطرف الثاني");
    key = k;
    if ($("remember").checked) await E2E.KeyStore.save(me, k);
    $("passphrase").value = $("passphrase2").value = "";
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch {}
    startChat();
  } catch (e2) {
    err(e2?.code === "unavailable" ? "ماكو نت، جرّب بعدين" : "صار خطأ، جرّب مرة ثانية");
  } finally { btn.disabled = false; btn.textContent = label; }
});

const doLogout = async () => { $("settings").hidden = true; await E2E.KeyStore.clear(me); signOut(auth); };
$("btn-logout").onclick = doLogout;
$("btn-logout-2").onclick = () => { if (confirm("تسجل خروج من هذا الجهاز؟")) doLogout(); };
$("btn-lock").onclick = async () => {
  if (call?.active) return;
  $("settings").hidden = true;
  await E2E.KeyStore.clear(me); teardown(); key = null;
  await prepareUnlock().catch(() => {}); show("unlock");
};

function teardown() {
  unsubs.forEach((u) => u()); unsubs = [];
  call?.stop(); call = null;
  if (rec) cancelRec();
  $("messages").replaceChildren();
  lastDay = "";
  $("settings").hidden = true;
  Object.keys(photos).forEach((k) => { if (photos[k]) URL.revokeObjectURL(photos[k]); delete photos[k]; delete photoSig[k]; });
  objectURLs.forEach((u) => URL.revokeObjectURL(u)); objectURLs.length = 0;
}

// ---------- الدردشة ----------
function startChat() {
  show("chat");
  $("partner-name").textContent = nameOf(partner);
  paintAvatars();
  $("my-name").textContent = nameOf(me);
  applyWallpaper();
  $("incoming-name").textContent = $("call-name").textContent = nameOf(partner);
  setComposer();

  const q = query(msgCol(), orderBy("createdAt"), limitToLast(300));
  unsubs.push(onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type === "added") renderMessage(ch.doc);
      else if (ch.type === "modified") updateMeta(ch.doc);
      else if (ch.type === "removed") document.querySelector(`[data-id="${ch.doc.id}"]`)?.remove();
    });
  }));

  // الحضور + «يكتب…»
  const myPresence = doc(db, "rooms", "main", "presence", me);
  const beat = () => { if (!document.hidden) setDoc(myPresence, { lastSeen: serverTimestamp() }, { merge: true }).catch(() => {}); };
  beat();
  const iv = setInterval(beat, 25000); unsubs.push(() => clearInterval(iv));
  const onVis = () => { if (!document.hidden) { beat(); pendingRead.splice(0).forEach(markRead); } };
  document.addEventListener("visibilitychange", onVis); unsubs.push(() => document.removeEventListener("visibilitychange", onVis));
  typingRef = myPresence;

  let lastSeen = null, typingAt = null;
  const paint = () => {
    const now = Date.now();
    partnerOnline = !!lastSeen && now - lastSeen < 60000;
    const typing = partnerOnline && typingAt && now - typingAt < 5000;
    const st = $("partner-status");
    st.textContent = typing ? "يكتب…" : partnerOnline ? "متصل الآن" : lastSeen ? "آخر ظهور " + fmtAgo(lastSeen) : "";
    st.classList.toggle("on", partnerOnline && !typing);
    st.classList.toggle("typing", !!typing);
    $("partner-avatar").classList.toggle("online", partnerOnline);
  };
  unsubs.push(onSnapshot(doc(db, "rooms", "main", "presence", partner), (s) => {
    const d = s.data({ serverTimestamps: "estimate" });
    lastSeen = d?.lastSeen?.toMillis() ?? null;
    typingAt = d?.typing?.toMillis?.() ?? null;
    paint();
  }));
  const pv = setInterval(paint, 2500); unsubs.push(() => clearInterval(pv));

  // الصور الشخصية (مشفّرة) — بمستند منفصل حتى ما تنسحب مع كل تحديث للحضور
  [me, partner].forEach((uid) => unsubs.push(onSnapshot(doc(db, "rooms", "main", "profiles", uid), async (s) => {
    const p = s.data();
    const sig = p?.photo ? p.photo.slice(0, 64) + p.photo.length : "";
    if (photoSig[uid] === sig) return;
    photoSig[uid] = sig;
    if (photos[uid]) URL.revokeObjectURL(photos[uid]);
    photos[uid] = null;
    if (p?.photo) { try { photos[uid] = URL.createObjectURL(new Blob([await E2E.decryptBytes(key, p.photo)], { type: "image/jpeg" })); } catch {} }
    paintAvatars();
  }, () => {})));

  call = new CallManager({ db, me, partner, key, ice: ICE_SERVERS, ui: callUI });
  call.listen();
}

let typingRef = null, lastTypingPing = 0;
function pingTyping(clear = false) {
  if (!typingRef) return;
  if (!clear && Date.now() - lastTypingPing < 2500) return;
  lastTypingPing = clear ? 0 : Date.now();
  setDoc(typingRef, { typing: clear ? null : serverTimestamp(), lastSeen: serverTimestamp() }, { merge: true }).catch(() => {});
}

function fmtTime(d) { return d.toLocaleTimeString("ar-IQ", { hour: "numeric", minute: "2-digit" }); }
function fmtAgo(ms) {
  const m = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `قبل ${m} دقيقة`;
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString() ? fmtTime(d) : d.toLocaleDateString("ar-IQ", { day: "numeric", month: "short" }) + " " + fmtTime(d);
}
const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

let lastDay = "";
const objectURLs = [];
function blobURL(bytes, type) { const u = URL.createObjectURL(new Blob([bytes], { type })); objectURLs.push(u); return u; }

function tickState(d, m) {
  if (d.metadata.hasPendingWrites) return ["🕓", "tick pending"];
  return m.readAt ? ["✓✓", "tick read"] : ["✓", "tick"];
}

async function renderMessage(d) {
  const m = d.data({ serverTimestamps: "estimate" });
  const list = $("messages");
  const when = m.createdAt?.toDate() ?? new Date();
  const day = when.toDateString();
  if (day !== lastDay) {
    lastDay = day;
    const sep = document.createElement("div"); sep.className = "day";
    sep.textContent = day === new Date().toDateString() ? "اليوم" : when.toLocaleDateString("ar-IQ", { weekday: "long", day: "numeric", month: "long" });
    list.append(sep);
  }
  const mine = m.from === me;
  const el = document.createElement("div");
  el.className = "msg " + (mine ? "out" : "in"); el.dataset.id = d.id;
  const bubble = document.createElement("div"); bubble.className = "bubble";
  const meta = document.createElement("div"); meta.className = "meta";
  const time = document.createElement("span"); time.textContent = fmtTime(when);
  meta.append(time);
  if (mine) {
    const tick = document.createElement("span");
    [tick.textContent, tick.className] = tickState(d, m);
    meta.append(tick);
  }
  el.append(bubble, meta);
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
  list.append(el);
  const stick = () => { if (nearBottom || mine) list.scrollTop = list.scrollHeight; };
  stick();

  try {
    if (m.type === "image") {
      bubble.classList.add("photo");
      const img = document.createElement("img"); img.alt = "صورة"; bubble.append(img);
      img.src = blobURL(await E2E.decryptBytes(key, m.data), "image/jpeg");
      img.onload = stick;
      img.onclick = () => { $("viewer").querySelector("img").src = img.src; $("viewer").hidden = false; };
    } else if (m.type === "audio") {
      voiceBubble(bubble, blobURL(await E2E.decryptBytes(key, m.data), m.mime || "audio/mp4"), m.dur);
    } else {
      bubble.dir = "auto";
      bubble.textContent = await E2E.decryptText(key, m);
    }
  } catch { bubble.textContent = "🔒 تعذّر فك التشفير"; bubble.classList.add("err"); }
  stick();

  if (mine) {
    // ضغطة طويلة = حذف عند الطرفين
    let lp = null;
    const cancel = () => clearTimeout(lp);
    bubble.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".vplay, .vbar")) return;
      lp = setTimeout(() => { navigator.vibrate?.(20); if (confirm("تحذف هذي الرسالة عند الطرفين؟")) deleteDoc(d.ref).catch(() => toast("ما انحذفت")); }, 600);
    });
    ["pointerup", "pointerleave", "pointercancel", "pointermove"].forEach((ev) => bubble.addEventListener(ev, cancel));
    bubble.addEventListener("contextmenu", (e) => e.preventDefault());
  } else {
    if (!m.readAt) { if (document.hidden) pendingRead.push(d.ref); else markRead(d.ref); }
    if (when.getTime() > startedAt && document.hidden) notify(m.type === "image" ? "📷 صورة" : m.type === "audio" ? "🎤 رسالة صوتية" : "رسالة جديدة");
  }
}
function updateMeta(d) {
  const tick = document.querySelector(`[data-id="${d.id}"] .tick`);
  if (tick) [tick.textContent, tick.className] = tickState(d, d.data());
}
function markRead(ref) { updateDoc(ref, { readAt: serverTimestamp() }).catch(() => {}); }
function notify(body) {
  try { if ("Notification" in window && Notification.permission === "granted") new Notification("RM", { body, icon: "icon-192.png", tag: "rm" }); } catch {}
}
$("viewer").onclick = () => ($("viewer").hidden = true);
$("viewer-close").onclick = (e) => { e.stopPropagation(); $("viewer").hidden = true; };

// مشغّل الرسائل الصوتية
let playing = null;
const ICON = (n) => `<svg><use href="#i-${n}"/></svg>`;
function voiceBubble(bubble, url, dur) {
  bubble.classList.add("voice");
  const a = new Audio(); a.preload = "metadata"; a.src = url;
  const btn = document.createElement("button"); btn.type = "button"; btn.className = "vplay"; btn.innerHTML = ICON("play");
  const bar = document.createElement("div"); bar.className = "vbar"; const fill = document.createElement("i"); bar.append(fill);
  const t = document.createElement("span"); t.className = "vtime"; t.textContent = fmtDur(dur);
  const total = () => (isFinite(a.duration) && a.duration > 0 ? a.duration : dur || 1);
  btn.onclick = () => {
    if (a.paused) { if (playing && playing !== a) playing.pause(); playing = a; a.play().catch(() => {}); }
    else a.pause();
  };
  a.onplay = () => (btn.innerHTML = ICON("pause"));
  a.onpause = () => (btn.innerHTML = ICON("play"));
  a.onended = () => { btn.innerHTML = ICON("play"); fill.style.width = "0%"; t.textContent = fmtDur(dur); };
  a.ontimeupdate = () => { fill.style.width = Math.min(100, (a.currentTime / total()) * 100) + "%"; t.textContent = fmtDur(a.currentTime); };
  bar.onclick = (e) => { const r = bar.getBoundingClientRect(); a.currentTime = ((e.clientX - r.left) / r.width) * total(); };
  bubble.append(btn, bar, t);
}

// ---------- الكتابة والإرسال ----------
const ta = $("text");
function setComposer() {
  const recording = !!rec, hasText = ta.value.trim().length > 0;
  $("rec").hidden = !recording; ta.hidden = recording; $("attach").hidden = recording;
  $("btn-send").hidden = !(recording || hasText);
  $("btn-mic").hidden = recording || hasText;
}
ta.addEventListener("input", () => {
  ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  setComposer();
  if (ta.value) pingTyping();
});
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !/iPhone|iPad|Android/i.test(navigator.userAgent)) { e.preventDefault(); $("composer").requestSubmit(); }
});
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (rec) return finishRec();
  const t = ta.value.trim(); if (!t || !key) return;
  ta.value = ""; ta.style.height = "auto"; setComposer(); ta.focus();
  pingTyping(true);
  try {
    const payload = await E2E.encryptText(key, t);
    addDoc(msgCol(), { from: me, type: "text", ...payload, createdAt: serverTimestamp() }).catch(() => toast("ما انرسلت"));
  } catch { toast("ما انرسلت"); ta.value = t; setComposer(); }
});

// صورة: تتصغّر (توفير نت) وتنمسح بياناتها المخفية مثل الموقع، وبعدين تتشفر
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !key) return;
  toast("جاري تجهيز الصورة…", 1500);
  try {
    const data = await E2E.encryptBytes(key, await compressImage(f));
    if (data.length > 1_000_000) { toast("الصورة كبيرة"); return; }
    addDoc(msgCol(), { from: me, type: "image", data, createdAt: serverTimestamp() }).catch(() => toast("ما انرسلت الصورة"));
  } catch { toast("ما گدرت أفتح هذي الصورة"); }
});
async function loadImage(file) {
  try { return await createImageBitmap(file); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
async function compressImage(file) {
  const src = await loadImage(file);
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  let max = 1280, q = 0.72, blob;
  for (let i = 0; i < 7; i++) {
    const s = Math.min(1, max / Math.max(W, H));
    const c = document.createElement("canvas");
    c.width = Math.round(W * s); c.height = Math.round(H * s);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
    if (blob && blob.size < 600_000) break;
    max = Math.round(max * 0.8); q = Math.max(0.5, q - 0.07);
  }
  src.close?.();
  return new Uint8Array(await blob.arrayBuffer());
}

// رسائل صوتية (لحد دقيقتين، bitrate واطي لتوفير النت)
let rec = null;
const REC_MAX = 120;
$("btn-mic").onclick = startRec;
$("rec-cancel").onclick = () => cancelRec();
async function startRec() {
  if (rec || !key) return;
  if (!window.MediaRecorder) return toast("جهازك ما يدعم التسجيل");
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch { return toast("لازم تسمح بالمايك من الإعدادات"); }
  const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t)) || "";
  let mr;
  try { mr = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: 32000 }); }
  catch { mr = new MediaRecorder(stream); }
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec = { mr, stream, chunks, t0: Date.now(), mime: mr.mimeType || mime || "audio/mp4" };
  mr.start(1000);
  $("rec-time").textContent = "0:00";
  rec.timer = setInterval(() => {
    const s = (Date.now() - rec.t0) / 1000;
    $("rec-time").textContent = fmtDur(s);
    if (s >= REC_MAX) finishRec();
  }, 250);
  navigator.vibrate?.(15);
  setComposer();
}
async function stopRec() {
  const r = rec; rec = null; clearInterval(r.timer);
  if (r.mr.state !== "inactive") { const done = new Promise((res) => (r.mr.onstop = res)); r.mr.stop(); await done; }
  r.stream.getTracks().forEach((t) => t.stop());
  setComposer();
  return r;
}
async function cancelRec() { if (rec) await stopRec(); }
async function finishRec() {
  if (!rec) return;
  const r = await stopRec();
  const dur = Math.round((Date.now() - r.t0) / 1000);
  if (dur < 1) return toast("التسجيل قصير");
  try {
    const bytes = new Uint8Array(await new Blob(r.chunks, { type: r.mime }).arrayBuffer());
    const data = await E2E.encryptBytes(key, bytes);
    if (data.length > 1_000_000) return toast("التسجيل طويل، سجّل أقصر");
    addDoc(msgCol(), { from: me, type: "audio", data, mime: r.mime.split(";")[0], dur, createdAt: serverTimestamp() })
      .catch(() => toast("ما انرسل التسجيل"));
  } catch { toast("ما انرسل التسجيل"); }
}

// ---------- المكالمات ----------
let timer = null, override = null;
const callUI = {
  incoming(video, onAccept, onDecline) {
    $("incoming-type").textContent = video ? "مكالمة فيديو واردة…" : "مكالمة صوتية واردة…";
    $("incoming").hidden = false;
    $("btn-accept").onclick = onAccept; $("btn-decline").onclick = onDecline;
    ring.start("in");
    if (document.hidden) notify(video ? "📹 مكالمة فيديو" : "📞 مكالمة صوتية");
  },
  closeIncoming() { $("incoming").hidden = true; ring.stop(); },
  open(video, status) {
    const c = $("call"); c.hidden = false;
    c.classList.toggle("audio-only", !video); c.classList.add("waiting");
    override = null;
    $("call-status").textContent = status; $("call-usage").textContent = "";
    $("quality-label").textContent = call.qualityLabel;
    ["btn-mute", "btn-cam"].forEach((id) => $(id).classList.remove("off"));
    keepAwake(true);
  },
  status(t) { $("call-status").textContent = t; },
  ringback(on) { on ? ring.start("back") : ring.stop(); },
  localStream(s, video, front) {
    const v = $("local-video"); v.srcObject = video ? s : null; v.classList.toggle("back", !front);
  },
  remoteStream(s) { const v = $("remote-video"); if (v.srcObject !== s) v.srcObject = s; v.play().catch(() => {}); },
  connected() {
    ring.stop();
    $("call").classList.remove("waiting");
    const t0 = Date.now();
    clearInterval(timer);
    const tick = () => { if (!override) $("call-status").textContent = fmtDur((Date.now() - t0) / 1000); };
    tick(); timer = setInterval(tick, 1000);
  },
  reconnecting() { override = "جاري إعادة الاتصال…"; $("call-status").textContent = override; },
  reconnected() { override = null; },
  usage(bytes) { $("call-usage").textContent = `استهلاك ${(bytes / 1048576).toFixed(1)} MB`; },
  ended(msg) {
    clearInterval(timer); ring.stop(); keepAwake(false); override = null;
    $("call").hidden = true; $("incoming").hidden = true;
    $("remote-video").srcObject = null; $("local-video").srcObject = null;
    if (msg) toast(msg);
  },
};
function startCall(video) {
  if (!call || call.active) return;
  if (!partnerOnline) toast("الطرف الثاني مو فاتح التطبيق هسه — يمكن ما يسمع الرنة", 3500);
  call.start(video);
}
$("btn-voice").onclick = () => startCall(false);
$("btn-video").onclick = () => startCall(true);
$("btn-hangup").onclick = () => call?.hangup();
$("btn-mute").onclick = () => $("btn-mute").classList.toggle("off", call.toggleMute());
$("btn-cam").onclick = () => $("btn-cam").classList.toggle("off", call.toggleCamera());
$("btn-flip").onclick = () => call.flipCamera().catch(() => toast("ما گدرت أقلب الكاميرا"));
$("btn-quality").onclick = () => { const l = call.cycleQuality(); $("quality-label").textContent = l; toast("الجودة: " + l, 1400); };
window.addEventListener("pagehide", () => { if (call?.active) call.hangup(null); });


// ---------- الإعدادات: الصورة الشخصية + الخلفية ----------
const photos = {}, photoSig = {};
function setAvatar(el, url, letter) {
  el.classList.toggle("has-photo", !!url);
  el.style.backgroundImage = url ? `url("${url}")` : "";
  const cam = el.querySelector(".cam"), input = el.querySelector("input");
  el.textContent = url ? "" : letter;
  if (input) el.prepend(input);
  if (cam) el.append(cam);
}
function paintAvatars() {
  ["partner-avatar", "incoming-avatar", "call-avatar"].forEach((id) => setAvatar($(id), photos[partner], initial(partner)));
  setAvatar($("my-avatar"), photos[me], initial(me));
  $("my-photo-remove").hidden = !photos[me];
}

$("btn-settings").onclick = () => { if (!call?.active) { $("settings").hidden = false; renderSwatches(); } };
$("settings-back").onclick = () => ($("settings").hidden = true);

async function squareJPEG(file, size, q) {
  const src = await loadImage(file);
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height, m = Math.min(W, H);
  const c = document.createElement("canvas"); c.width = c.height = size;
  c.getContext("2d").drawImage(src, (W - m) / 2, (H - m) / 2, m, m, 0, 0, size, size);
  src.close?.();
  const b = await new Promise((r) => c.toBlob(r, "image/jpeg", q));
  return new Uint8Array(await b.arrayBuffer());
}
$("my-photo-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !key) return;
  toast("جاري رفع الصورة…", 1500);
  try {
    const data = await E2E.encryptBytes(key, await squareJPEG(f, 320, 0.82));
    await setDoc(doc(db, "rooms", "main", "profiles", me), { photo: data, updatedAt: serverTimestamp() });
    toast("تم ✓");
  } catch (err) {
    toast(err?.code === "permission-denied" ? "لازم تحدّث قواعد Firestore أولاً" : "ما گدرت أرفع الصورة");
  }
});
$("my-photo-remove").onclick = async () => {
  if (!confirm("تشيل صورتك؟")) return;
  try { await setDoc(doc(db, "rooms", "main", "profiles", me), { photo: null, updatedAt: serverTimestamp() }); } catch { toast("ما گدرت"); }
};

// الخلفية تنحفظ على الجهاز بس (ما تصرف نت)
const PRESETS = [
  "radial-gradient(120% 80% at 50% 0%, rgba(201,169,110,.22), transparent 60%), #0b0d12",
  "linear-gradient(160deg, #1b1426 0%, #0b0d12 70%)",
  "linear-gradient(160deg, #0f1f1c 0%, #0b0d12 75%)",
  "linear-gradient(160deg, #241612 0%, #0b0d12 75%)",
  "radial-gradient(circle at 20% 20%, rgba(227,201,147,.10) 0 2px, transparent 3px) 0 0/22px 22px, #0e1016",
  "linear-gradient(180deg, #131a2b 0%, #0b0d12 100%)",
];
function prefsDB() {
  return new Promise((res, rej) => { const r = indexedDB.open("rm-prefs", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function prefGet(k) { try { const d = await prefsDB(); return await new Promise((res) => { const r = d.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); }); } catch { return null; } }
async function prefSet(k, v) { try { const d = await prefsDB(); await new Promise((res) => { const tx = d.transaction("kv", "readwrite"); v == null ? tx.objectStore("kv").delete(k) : tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = res; }); } catch {} }

let wallURL = null;
async function applyWallpaper() {
  const w = await prefGet("wall");
  if (wallURL) { URL.revokeObjectURL(wallURL); wallURL = null; }
  let bg = "";
  if (w?.type === "image" && w.blob) { wallURL = URL.createObjectURL(w.blob); bg = `linear-gradient(rgba(11,13,18,.45), rgba(11,13,18,.45)), url("${wallURL}") center/cover no-repeat`; }
  else if (w?.type === "preset") bg = PRESETS[w.i] || "";
  for (const el of [$("messages"), $("wall-preview")]) { el.style.background = bg; el.classList.toggle("has-wall", !!bg); }
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("on", w?.type === "preset" && +s.dataset.i === w.i));
}
function renderSwatches() {
  const box = $("swatches");
  if (!box.childElementCount) PRESETS.forEach((p, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "swatch"; b.dataset.i = i; b.style.background = p;
    b.onclick = async () => { await prefSet("wall", { type: "preset", i }); applyWallpaper(); };
    box.append(b);
  });
  applyWallpaper();
}
$("wall-file").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const bytes = await compressImage(f);
    await prefSet("wall", { type: "image", blob: new Blob([bytes], { type: "image/jpeg" }) });
    applyWallpaper(); toast("تم تغيير الخلفية ✓");
  } catch { toast("ما گدرت أفتح الصورة"); }
});
$("wall-remove").onclick = async () => { await prefSet("wall", null); applyWallpaper(); };
