// مكالمات صوت وفيديو WebRTC مباشرة بين الجهازين.
// الصوت والصورة مشفّرة دائماً (DTLS-SRTP)، وبيانات الإشارة (offer/answer/ICE) مشفّرة إضافياً بمفتاحكم.
import {
  doc, collection, setDoc, updateDoc, onSnapshot, addDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as E2E from "./crypto.js";

export const QUALITY = {
  saver:  { label: "توفير", w: 320,  h: 240, fps: 12, vbr: 150_000,   abr: 16_000 },
  normal: { label: "عادي",  w: 640,  h: 480, fps: 15, vbr: 350_000,   abr: 24_000 },
  high:   { label: "عالي",  w: 1280, h: 720, fps: 24, vbr: 1_000_000, abr: 32_000 },
};
const ORDER = ["saver", "normal", "high"];

// يقلل bitrate الصوت ويفعّل DTX (ما يرسل شي وقت السكوت) وFEC (يتحمّل ضياع البيانات)
function tuneOpus(sdp, abr) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000[^\r\n]*/i);
  if (!m) return sdp;
  const pt = m[1];
  const extra = `;usedtx=1;useinbandfec=1;stereo=0;maxaveragebitrate=${abr}`;
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) return sdp.replace(re, (_l, p) => `a=fmtp:${pt} ${p.replace(/;?(usedtx|useinbandfec|stereo|maxaveragebitrate)=\d+/g, "")}${extra}`);
  return sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} minptime=10${extra}`);
}

export class CallManager {
  constructor({ db, me, partner, key, ice, ui }) {
    Object.assign(this, { db, me, partner, key, ice, ui });
    this.quality = localStorage.getItem("rm-quality") || "saver";
    this.facing = "user";
    this.reset();
  }
  reset() {
    this.pc = null; this.local = null; this.callId = null; this.role = null;
    this.video = false; this.connected = false; this.pending = [];
    this.starting = false; this.offerSent = false;
    this.v = 0; this.appliedV = 0; this.restarts = 0;
    clearTimeout(this.ringTimeout); clearTimeout(this.dropTimer); clearTimeout(this.restartTimer);
    clearInterval(this.statsTimer); this.usageBase = 0; this.lastTotal = 0;
    this.unsubCand?.(); this.unsubCand = null;
  }
  get active() { return !!(this.pc || this.starting); }
  get sigRef() { return doc(this.db, "rooms", "main", "meta", "call"); }
  candCol(id) { return collection(this.db, "rooms", "main", "calls", id, "candidates"); }

  listen() {
    this.unsub = onSnapshot(this.sigRef, (snap) => {
      this.queue = (this.queue || Promise.resolve())
        .then(() => this.onSignal(snap.data({ serverTimestamps: "estimate" })))
        .catch(console.error);
    });
  }
  stop() { this.unsub?.(); if (this.active) this.hangup(null); }

  async onSignal(s) {
    if (!s) return;
    const fresh = s.createdAt ? Date.now() - s.createdAt.toMillis() < 45000 : true;

    if (s.status === "ringing" && s.from !== this.me) {
      // اتصلتوا بنفس اللحظة: المكالمة الأحدث بالسيرفر تفوز، والثاني يتنازل ويشوفها واردة
      if (this.active && this.role === "caller" && !this.connected && s.callId !== this.callId) {
        if (!this.offerSent) return; // كتابتي راح تغطي عليها
        this.cleanup(null);
      }
      if (!this.active && fresh && this.incomingId !== s.callId) {
        this.incomingId = s.callId;
        this.ui.incoming(s.video, () => this.accept(s), () => this.decline(s.callId));
      }
      return;
    }
    if (this.incomingId === s.callId && !this.active) { this.ui.closeIncoming(); this.incomingId = null; }
    if (!this.pc || s.callId !== this.callId) return;

    if (s.status === "declined") return this.cleanup("ما رد على المكالمة");
    if (s.status === "ended") return this.cleanup("انتهت المكالمة");

    if (this.role === "caller" && s.answer && s.av === this.v && this.appliedV !== this.v) {
      this.appliedV = this.v;
      await this.pc.setRemoteDescription(JSON.parse(await E2E.decryptText(this.key, s.answer)));
      this.flush();
      if (!this.connected) { this.ui.ringback(false); this.ui.status("جاري الاتصال…"); }
    }
    // الطرف الثاني بدّل شبكته (واي فاي ↔ بيانات): نعيد ربط المكالمة بدون ما تنقطع
    if (this.role === "callee" && s.offer && s.v > this.v) {
      this.v = s.v;
      await this.pc.setRemoteDescription(JSON.parse(await E2E.decryptText(this.key, s.offer)));
      this.flush();
      await this.setLocal(await this.pc.createAnswer());
      await updateDoc(this.sigRef, { answer: await this.encDesc(), av: this.v });
    }
  }

  async setLocal(desc) {
    try { await this.pc.setLocalDescription({ type: desc.type, sdp: tuneOpus(desc.sdp, QUALITY[this.quality].abr) }); }
    catch { await this.pc.setLocalDescription(desc); }
  }
  encDesc() { return E2E.encryptText(this.key, JSON.stringify(this.pc.localDescription.toJSON())); }

  videoConstraints() {
    const q = QUALITY[this.quality];
    return { facingMode: this.facing, width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } };
  }

  async setupPeer(video) {
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: video ? this.videoConstraints() : false,
    });
    this.pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    this.local.getTracks().forEach((t) => this.pc.addTrack(t, this.local));
    const remote = new MediaStream();
    this.pc.ontrack = (e) => { remote.addTrack(e.track); this.ui.remoteStream(remote); };
    const id = this.callId;
    this.pc.onicecandidate = async (e) => {
      if (!e.candidate || !e.candidate.candidate) return;
      const payload = await E2E.encryptText(this.key, JSON.stringify(e.candidate.toJSON()));
      addDoc(this.candCol(id), { from: this.me, ...payload, createdAt: serverTimestamp() }).catch(() => {});
    };
    this.pc.onconnectionstatechange = () => this.onState();
    this.unsubCand = onSnapshot(this.candCol(id), (snap) => {
      snap.docChanges().forEach(async (ch) => {
        if (ch.type !== "added") return;
        const c = ch.doc.data();
        if (c.from === this.me) return;
        try {
          const cand = JSON.parse(await E2E.decryptText(this.key, c));
          if (this.pc?.remoteDescription) this.pc.addIceCandidate(cand).catch(() => {});
          else this.pending.push(cand);
        } catch {}
      });
    });
    this.ui.localStream(this.local, video, true);
  }
  flush() { const p = this.pending; this.pending = []; p.forEach((c) => this.pc.addIceCandidate(c).catch(() => {})); }

  onState() {
    const st = this.pc?.connectionState;
    if (st === "connected") {
      clearTimeout(this.dropTimer); clearTimeout(this.restartTimer); this.restarts = 0;
      if (!this.connected) {
        this.connected = true; clearTimeout(this.ringTimeout);
        this.ui.connected(); this.watchStats();
      } else this.ui.reconnected();
      this.applyQuality();
    } else if (st === "disconnected" || st === "failed") {
      if (!this.connected) { if (st === "failed") this.hangup("تعذر الاتصال — غالباً تحتاجون سيرفر TURN"); return; }
      this.ui.reconnecting();
      if (this.role === "caller") {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.restartIce().catch(() => {}), st === "failed" ? 0 : 2500);
      }
      if (!this.dropTimer) this.dropTimer = setTimeout(() => {
        this.dropTimer = null;
        if (this.pc && this.pc.connectionState !== "connected") this.hangup("انقطع الاتصال");
      }, 30000);
    }
  }
  async restartIce() {
    if (!this.pc || this.pc.connectionState === "connected" || this.restarts >= 4) return;
    this.restarts++; this.v++;
    await this.setLocal(await this.pc.createOffer({ iceRestart: true }));
    await updateDoc(this.sigRef, { offer: await this.encDesc(), v: this.v });
  }

  async start(video) {
    if (this.active) return;
    this.starting = true;
    this.callId = crypto.randomUUID(); this.role = "caller"; this.video = video; this.v = 1;
    this.ui.open(video, "جاري الطلب…");
    try { await this.setupPeer(video); }
    catch { this.cleanup("لازم تسمح بالمايك" + (video ? " والكاميرا" : "") + " من الإعدادات"); return; }
    try {
      await this.setLocal(await this.pc.createOffer());
      this.offerSent = true;
      await setDoc(this.sigRef, {
        callId: this.callId, from: this.me, video, status: "ringing", v: 1,
        offer: await this.encDesc(), createdAt: serverTimestamp(),
      });
    } catch { this.cleanup("ما گدرت أتصل، تأكد من النت"); return; }
    this.starting = false;
    this.ui.status("يرن…"); this.ui.ringback(true);
    this.ringTimeout = setTimeout(() => { if (!this.connected) this.hangup("ما رد"); }, 45000);
  }

  async accept(s) {
    this.ui.closeIncoming(); this.incomingId = null;
    if (this.active) return;
    this.starting = true;
    this.callId = s.callId; this.role = "callee"; this.video = s.video; this.v = s.v || 1;
    this.ui.open(s.video, "جاري الاتصال…");
    try { await this.setupPeer(s.video); }
    catch { this.decline(s.callId); this.cleanup("لازم تسمح بالمايك" + (s.video ? " والكاميرا" : "") + " من الإعدادات"); return; }
    try {
      await this.pc.setRemoteDescription(JSON.parse(await E2E.decryptText(this.key, s.offer)));
      this.flush();
      await this.setLocal(await this.pc.createAnswer());
      await updateDoc(this.sigRef, { status: "active", answer: await this.encDesc(), av: this.v });
    } catch { this.hangup("ما گدرت أرد، تأكد من النت"); return; }
    this.starting = false;
  }

  decline(callId) {
    this.ui.closeIncoming(); this.incomingId = null;
    updateDoc(this.sigRef, { status: "declined", callId }).catch(() => {});
  }

  hangup(msg = "انتهت المكالمة") {
    if (this.callId) updateDoc(this.sigRef, { status: "ended", callId: this.callId }).catch(() => {});
    this.cleanup(msg);
  }

  cleanup(msg) {
    this.local?.getTracks().forEach((t) => t.stop());
    try { this.pc?.close(); } catch {}
    this.reset();
    this.ui.ended(msg);
  }

  async applyQuality(name = this.quality) {
    this.quality = name; localStorage.setItem("rm-quality", name);
    const q = QUALITY[name];
    if (!this.pc) return;
    for (const sender of this.pc.getSenders()) {
      const t = sender.track; if (!t) continue;
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = t.kind === "video" ? q.vbr : q.abr;
        if (t.kind === "video") p.encodings[0].maxFramerate = q.fps;
        await sender.setParameters(p);
      } catch {}
      if (t.kind === "video") t.applyConstraints(this.videoConstraints()).catch(() => {});
    }
  }
  cycleQuality() {
    const next = ORDER[(ORDER.indexOf(this.quality) + 1) % ORDER.length];
    this.applyQuality(next);
    return QUALITY[next].label;
  }
  get qualityLabel() { return QUALITY[this.quality].label; }

  toggleMute() {
    const t = this.local?.getAudioTracks()[0]; if (!t) return false;
    t.enabled = !t.enabled; return !t.enabled;
  }
  toggleCamera() {
    const t = this.local?.getVideoTracks()[0]; if (!t) return false;
    t.enabled = !t.enabled; return !t.enabled;
  }
  async flipCamera() {
    const old = this.local?.getVideoTracks()[0]; if (!old || !this.pc) return;
    const wasEnabled = old.enabled;
    const sender = this.pc.getSenders().find((x) => x.track === old);
    this.facing = this.facing === "user" ? "environment" : "user";
    old.stop(); // آيفون ما يسمح بكاميرتين سوة
    const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
    const nt = s.getVideoTracks()[0];
    nt.enabled = wasEnabled;
    await sender?.replaceTrack(nt);
    this.local.removeTrack(old); this.local.addTrack(nt);
    this.ui.localStream(this.local, true, this.facing === "user");
    this.applyQuality();
  }

  // يعرض كم ميغا صرفت المكالمة
  watchStats() {
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      try {
        const stats = await this.pc.getStats();
        let total = 0;
        stats.forEach((r) => {
          if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) total = Math.max(total, (r.bytesSent || 0) + (r.bytesReceived || 0));
        });
        if (total < (this.lastTotal || 0)) this.usageBase = (this.usageBase || 0) + this.lastTotal; // بعد إعادة الربط العداد يبدي من صفر
        this.lastTotal = total;
        this.ui.usage((this.usageBase || 0) + total);
      } catch {}
    }, 2000);
  }
}
