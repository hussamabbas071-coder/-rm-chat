// ===== إعدادات «RM» — عدّل هذا الملف بس =====

// 1) انسخ هذي القيم من Firebase Console > Project settings > Your apps > Web app
export const firebaseConfig = {
  apiKey: "AIzaSyD45Jisdn8PoMxVeHoKyO9zYAUaoKMKofM",
  authDomain: "rm-chat-df4e7.firebaseapp.com",
  projectId: "rm-chat-df4e7",
  storageBucket: "rm-chat-df4e7.firebasestorage.app",
  messagingSenderId: "269879787584",
  appId: "1:269879787584:web:2ecb68967396d546735fa5",
};

// 2) الـ UID مال الحسابين (من Firebase Console > Authentication > Users)
//    لازم تكون نفس القيم اللي بملف firestore.rules
export const ALLOWED_UIDS = ["xExlZQ8Jaef8FDA4T2zAkYtBHpI3", "JHzRvLcgTmXo24mR1l2AAgGATaM2"];

// 3) الأسماء اللي تنعرض
export const NAMES = {
  xExlZQ8Jaef8FDA4T2zAkYtBHpI3: "Abu Sanad",
  JHzRvLcgTmXo24mR1l2AAgGATaM2: "Umm Sanad",
};

// 4) سيرفرات الاتصال. STUN مجاني. TURN ضروري أحياناً لشبكات الموبايل (شوف README)
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // مثال TURN — شيل // وحط بياناتك:
  // { urls: ["turn:YOUR_TURN_HOST:3478", "turns:YOUR_TURN_HOST:443?transport=tcp"], username: "USER", credential: "PASS" },
];

// لا تغيّره بعد ما تبدون تستخدمون التطبيق
export const KEY_SALT = "hams-room-main-v1";
