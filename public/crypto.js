// تشفير طرف-لطرف (E2E): الرسائل والصور وبيانات المكالمة تتشفر على الجهاز قبل ما تطلع.
// Firebase يشوف بس كلام مشفّر ما ينقرا. المفتاح ينشق من «كلمة سر التشفير» اللي تعرفونها أنتم الاثنين بس.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b) {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 600000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false, // المفتاح ما ينسحب من الجهاز
    ["encrypt", "decrypt"]
  );
}

export async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}
export async function decryptText(key, { iv, ct }) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
  return dec.decode(pt);
}

export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64(out);
}
export async function decryptBytes(key, b64) {
  const buf = fromB64(b64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, key, buf.subarray(12)));
}

// حفظ المفتاح على الجهاز (اختياري). المفتاح non-extractable: حتى لو أحد فتح الذاكرة ما يكدر ينسخه.
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("hams-keys", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export const KeyStore = {
  async save(id, key) {
    const d = await idb();
    await new Promise((res, rej) => {
      const tx = d.transaction("keys", "readwrite");
      tx.objectStore("keys").put(key, id);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async load(id) {
    try {
      const d = await idb();
      return await new Promise((res) => {
        const r = d.transaction("keys").objectStore("keys").get(id);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      });
    } catch { return null; }
  },
  async clear(id) {
    try {
      const d = await idb();
      await new Promise((res) => {
        const tx = d.transaction("keys", "readwrite");
        tx.objectStore("keys").delete(id);
        tx.oncomplete = res; tx.onerror = res;
      });
    } catch {}
  },
};
