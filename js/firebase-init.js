// ⚠️ 這裡要貼上你自己在 Firebase 主控台複製的設定值
// 拿法：Firebase 主控台 → 專案設定（齒輪圖示）→ 一般 → 往下捲到「你的應用程式」→ 網頁應用程式 → 複製 firebaseConfig
// 這些值本來就是設計成可以公開的（不是密碼），真正的安全防護是靠 Firebase Authentication 登入
// 和 Firestore 安全規則（firestore.rules），不是靠隱藏這些值。
export const firebaseConfig = {
  apiKey: "AIzaSyDNBSVNBYuqLD-D-LlHTWYIF4meXOlN-nE",
  authDomain: "mstar-shop.firebaseapp.com",
  projectId: "mstar-shop",
  storageBucket: "mstar-shop.firebasestorage.app",
  messagingSenderId: "750178163759",
  appId: "1:750178163759:web:68ba6027dce0831b71bada",
};
