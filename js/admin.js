import { firebaseConfig } from "./firebase-init.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------- 登入 ----------
document.getElementById("loginBtn").onclick = async () => {
  const email = document.getElementById("emailInput").value.trim();
  const pwd = document.getElementById("pwdInput").value;
  document.getElementById("loginMsg").textContent = "登入中...";
  try {
    await signInWithEmailAndPassword(auth, email, pwd);
  } catch (err) {
    document.getElementById("loginMsg").textContent = "登入失敗，請確認帳號密碼是否正確";
  }
};

document.getElementById("logoutBtn").onclick = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  if (user) {
    showAdmin();
  } else {
    document.getElementById("adminView").style.display = "none";
    document.getElementById("loginView").style.display = "block";
    document.getElementById("loginMsg").textContent = "";
  }
});

async function showAdmin() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("adminView").style.display = "block";
  await loadItems();
}

// ---------- Tabs ----------
document.getElementById("tabItems").onclick = () => {
  setActiveTab("tabItems");
  loadItems();
};

document.getElementById("tabOrders").onclick = () => {
  setActiveTab("tabOrders");
  document.getElementById("ordersPanel").style.display = "block";
  loadOrders();
};

document.getElementById("tabSettings").onclick = () => {
  setActiveTab("tabSettings");
  document.getElementById("settingsPanel").style.display = "block";
  loadSettings();
};

function setActiveTab(activeId) {
  ["tabItems", "tabOrders", "tabSettings"].forEach((id) => {
    document.getElementById(id).classList.toggle("active", id === activeId);
  });
  document.getElementById("itemsPanel").style.display = activeId === "tabItems" ? "block" : "none";
  document.getElementById("ordersPanel").style.display = activeId === "tabOrders" ? "block" : "none";
  document.getElementById("settingsPanel").style.display = activeId === "tabSettings" ? "block" : "none";
}

// ---------- Items ----------
async function loadItems() {
  const snap = await getDocs(collection(db, "items"));
  const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const tbody = document.getElementById("itemsTbody");
  tbody.innerHTML = "";
  items.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><img src="${item.image}" style="width:60px;height:44px;object-fit:cover;border-radius:6px;" /></td>
      <td>${item.name}</td>
      <td>${item.category}</td>
      <td>🍬 ${item.priceCandy}</td>
      <td>💵 NT$ ${item.priceCash}</td>
      <td>${item.stock}</td>
      <td><span class="badge ${item.active ? "on" : "off"}">${item.active ? "上架中" : "已下架"}</span></td>
      <td class="row-actions">
        <button class="edit">編輯</button>
        <button class="edit toggle">${item.active ? "下架" : "上架"}</button>
        <button class="del">刪除</button>
      </td>
    `;
    tr.querySelector(".edit").onclick = () => fillForm(item);
    tr.querySelector(".toggle").onclick = () => toggleActive(item);
    tr.querySelector(".del").onclick = () => deleteItem(item.id);
    tbody.appendChild(tr);
  });
}

function fillForm(item) {
  document.getElementById("itemId").value = item.id;
  document.getElementById("fName").value = item.name;
  document.getElementById("fCategory").value = item.category;
  document.getElementById("fPriceCandy").value = item.priceCandy;
  document.getElementById("fPriceCash").value = item.priceCash;
  document.getElementById("fStock").value = item.stock;
  document.getElementById("fImage").value = item.image;
  document.getElementById("fDesc").value = item.description;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearForm() {
  ["itemId", "fName", "fCategory", "fPriceCandy", "fPriceCash", "fStock", "fImage", "fDesc"].forEach(
    (id) => (document.getElementById(id).value = "")
  );
}

async function saveItem() {
  const id = document.getElementById("itemId").value;
  const priceCandy = Number(document.getElementById("fPriceCandy").value);
  const priceCash = Number(document.getElementById("fPriceCash").value);
  const payload = {
    name: document.getElementById("fName").value.trim(),
    category: document.getElementById("fCategory").value.trim() || "未分類",
    priceCandy,
    priceCash,
    stock: Number(document.getElementById("fStock").value) || 0,
    image: document.getElementById("fImage").value.trim(),
    description: document.getElementById("fDesc").value.trim(),
  };
  if (!payload.name || !Number.isFinite(priceCandy) || !Number.isFinite(priceCash)) {
    alert("請填寫商品名稱，並正確填寫「糖果價」與「現金價」");
    return;
  }

  if (id) {
    await updateDoc(doc(db, "items", id), payload);
  } else {
    await addDoc(collection(db, "items"), { ...payload, active: true });
  }
  clearForm();
  loadItems();
}

async function toggleActive(item) {
  await updateDoc(doc(db, "items", item.id), { active: !item.active });
  loadItems();
}

async function deleteItem(id) {
  if (!confirm("確定要刪除這個商品嗎？")) return;
  await deleteDoc(doc(db, "items", id));
  loadItems();
}

// ---------- 匯入範例商品（只需要在第一次使用、資料庫是空的時候按一次） ----------
const SAMPLE_ITEMS = [
  { id: "itm_001", name: "北歐風雙人沙發", category: "🛋️ 客廳", priceCandy: 300, priceCash: 350, stock: 20, active: true, image: "https://placehold.co/500x350?text=%E9%9B%99%E4%BA%BA%E6%B2%99%E7%99%BC", description: "簡約北歐風格雙人沙發，適合放在客廳角落，MSTAR 家具人氣款。" },
  { id: "itm_002", name: "實木餐桌組（含4椅）", category: "🍽️ 餐廳", priceCandy: 600, priceCash: 650, stock: 15, active: true, image: "https://placehold.co/500x350?text=%E9%A4%90%E6%A1%8C%E7%B5%84", description: "六人份實木餐桌，附贈四張同款餐椅，質感滿分。" },
  { id: "itm_003", name: "夢幻公主床", category: "🛏️ 臥室", priceCandy: 450, priceCash: 500, stock: 10, active: true, image: "https://placehold.co/500x350?text=%E5%85%AC%E4%B8%BB%E5%BA%8A", description: "粉色系公主床，附紗幔裝飾，臥室必備夢幻單品。" },
  { id: "itm_004", name: "工業風書桌", category: "📚 書房", priceCandy: 250, priceCash: 280, stock: 30, active: true, image: "https://placehold.co/500x350?text=%E5%B7%A5%E6%A5%AD%E9%A2%A8%E6%9B%B8%E6%A1%8C", description: "鐵件搭配木紋桌板，簡約耐看，適合打造個人書房。" },
  { id: "itm_005", name: "花園造景組", category: "🌳 戶外", priceCandy: 800, priceCash: 850, stock: 8, active: true, image: "https://placehold.co/500x350?text=%E8%8A%B1%E5%9C%92%E9%80%A0%E6%99%AF", description: "含花架、長椅、盆栽裝飾，打造專屬花園場景。" },
  { id: "itm_006", name: "電競風單人躺椅", category: "🛏️ 臥室", priceCandy: 350, priceCash: 400, stock: 12, active: true, image: "https://placehold.co/500x350?text=%E9%9B%BB%E7%AB%B6%E6%A4%85", description: "炫彩燈效電競躺椅造型家具，年輕玩家最愛。" },
];

const DEFAULT_ANNOUNCEMENT =
  "📢 營業時間：每天 20:00 - 24:00（其餘時間下單會延後處理）\n💰 交易方式：可用遊戲幣或代幣購買，比值1:1\n📸 下單送出後，請截圖購物車畫面，私訊 Discord 給我們確認訂單\n📦 確認後請耐心等待，出貨時間約 24 小時內\n💬 有任何問題歡迎透過 Discord 聯繫我們";

document.getElementById("seedBtn").onclick = async () => {
  if (!confirm("要匯入 6 筆範例商品和預設公告嗎？如果資料庫裡已經有同樣 ID 的商品，內容會被覆蓋。")) return;
  for (const item of SAMPLE_ITEMS) {
    const { id, ...rest } = item;
    await setDoc(doc(db, "items", id), rest);
  }
  const settingsSnap = await getDoc(doc(db, "settings", "main"));
  if (!settingsSnap.exists()) {
    await setDoc(doc(db, "settings", "main"), { announcement: DEFAULT_ANNOUNCEMENT });
  }
  alert("範例商品已匯入！");
  loadItems();
};

// ---------- Orders ----------
async function loadOrders() {
  const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
  const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const tbody = document.getElementById("ordersTbody");
  tbody.innerHTML = "";
  orders.forEach((o) => {
    const detail = (o.items || []).map((i) => `${i.name} x${i.qty}`).join("、");
    const icon = o.paymentMethod === "糖果" ? "🍬" : "💵";
    const totalText = o.paymentMethod === "糖果" ? `🍬 ${o.total}` : `💵 NT$ ${o.total}`;
    const createdAtText = o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toLocaleString("zh-TW") : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${createdAtText}</td>
      <td>${o.buyerName}</td>
      <td>${o.contact}</td>
      <td>${icon} ${o.paymentMethod}</td>
      <td>${detail}</td>
      <td>${totalText}</td>
      <td>
        <select data-id="${o.id}">
          ${["待確認", "備貨中", "已出貨", "已完成", "已取消"]
            .map((s) => `<option value="${s}" ${s === o.status ? "selected" : ""}>${s}</option>`)
            .join("")}
        </select>
      </td>
    `;
    tr.querySelector("select").onchange = (e) => updateOrderStatus(o.id, e.target.value);
    tbody.appendChild(tr);
  });
}

async function updateOrderStatus(id, status) {
  await updateDoc(doc(db, "orders", id), { status });
}

// ---------- Settings (公告) ----------
async function loadSettings() {
  const snap = await getDoc(doc(db, "settings", "main"));
  const settings = snap.exists() ? snap.data() : {};
  document.getElementById("fAnnouncement").value = settings.announcement || "";
}

async function saveSettings() {
  const announcement = document.getElementById("fAnnouncement").value;
  await setDoc(doc(db, "settings", "main"), { announcement }, { merge: true });
  alert("公告已儲存！");
}

document.getElementById("saveSettingsBtn").onclick = (e) => {
  e.preventDefault();
  saveSettings();
};

document.getElementById("saveItemBtn").onclick = (e) => {
  e.preventDefault();
  saveItem();
};
