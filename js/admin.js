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

// 圖片網址失效時顯示的替代圖片，避免後台商品列表出現「???」破圖示
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="88">' +
      '<rect width="100%" height="100%" fill="#1b2540"/>' +
      '<text x="50%" y="50%" fill="#aab4d4" font-size="11" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">無圖片</text>' +
      "</svg>"
  );

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
  await Promise.all([loadItems(), loadSeries()]);
}

// ---------- Tabs ----------
document.getElementById("tabItems").onclick = () => {
  setActiveTab("tabItems");
  loadItems();
};

document.getElementById("tabSeries").onclick = () => {
  setActiveTab("tabSeries");
  loadSeries();
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
  ["tabItems", "tabSeries", "tabOrders", "tabSettings"].forEach((id) => {
    document.getElementById(id).classList.toggle("active", id === activeId);
  });
  document.getElementById("itemsPanel").style.display = activeId === "tabItems" ? "block" : "none";
  document.getElementById("seriesPanel").style.display = activeId === "tabSeries" ? "block" : "none";
  document.getElementById("ordersPanel").style.display = activeId === "tabOrders" ? "block" : "none";
  document.getElementById("settingsPanel").style.display = activeId === "tabSettings" ? "block" : "none";
}


// ---------- Lucky-box Series ----------
const DEFAULT_SERIES_NAMES = [
  "夢幻樂園幸運盒",
  "口袋夏日幸運盒",
  "黑暗霓虹派對幸運盒",
  "沙灘拍照區幸運箱",
  "宴會廳幸運箱",
  "熱帶夏季幸運盒",
  "夏日霓虹派對幸運盒",
  "古董道具店幸運盒",
  "治癒衝刺幸運盒",
  "🧸睡熊幸運盒",
  "秘世界幸運盒",
  "夏日天堂幸運盒",
  "時光之愛幸運盒",
  "MstarLand幸運盒",
  "沙灘裝飾套裝幸運盒",
];

let ALL_SERIES = [];

function sortSeries(items) {
  return items.slice().sort((a,b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
}

async function loadSeries() {
  const snap = await getDoc(doc(db, "settings", "series"));
  ALL_SERIES = sortSeries(snap.exists() && Array.isArray(snap.data().items) ? snap.data().items : []);
  renderSeriesAdmin();
  populateSeriesSelect();
}

async function persistSeries() {
  await setDoc(doc(db, "settings", "series"), { items: ALL_SERIES }, { merge: false });
}

function populateSeriesSelect(selectedValue) {
  const select = document.getElementById("fSeries");
  if (!select) return;
  const selected = selectedValue !== undefined ? selectedValue : select.value;
  select.innerHTML = '<option value="">無系列／一般家具</option>';
  ALL_SERIES.filter((s) => s.active !== false).forEach((series) => {
    const opt = document.createElement("option");
    opt.value = series.id;
    opt.textContent = series.name;
    select.appendChild(opt);
  });
  select.value = selected || "";
}

function renderSeriesAdmin() {
  const box = document.getElementById("seriesAdminList");
  if (!box) return;
  box.innerHTML = "";
  if (!ALL_SERIES.length) {
    box.innerHTML = '<div style="color:var(--muted);">還沒有系列。可以按上方「建立 15 個預設幸運盒系列」。</div>';
    return;
  }
  ALL_SERIES.forEach((series) => {
    const row = document.createElement("div");
    row.className = "admin-series-row";
    row.innerHTML = `
      <img src="${series.coverImage || PLACEHOLDER_IMG}" alt="${series.name}" />
      <div><strong>${series.name}</strong><div class="admin-series-meta">${series.active === false ? "已隱藏" : "顯示中"}</div></div>
      <div class="admin-series-url">${series.coverImage ? "已設定合輯圖" : "尚未設定合輯圖"}</div>
      <div class="admin-series-order">順序 ${series.sortOrder ?? "-"}</div>
      <div class="row-actions"><button class="move-up" title="往舊的方向移一格">▲</button><button class="move-down" title="往新的方向移一格">▼</button><button class="edit">編輯</button><button class="toggle">${series.active === false ? "顯示" : "隱藏"}</button><button class="del">刪除</button></div>`;
    const img = row.querySelector("img"); img.onerror = () => { img.onerror=null; img.src=PLACEHOLDER_IMG; };
    const seriesIndex = ALL_SERIES.findIndex((x) => x.id === series.id);
    const upBtn = row.querySelector(".move-up");
    const downBtn = row.querySelector(".move-down");
    upBtn.disabled = seriesIndex <= 0;
    downBtn.disabled = seriesIndex < 0 || seriesIndex >= ALL_SERIES.length - 1;
    upBtn.onclick = () => moveSeries(seriesIndex, -1);
    downBtn.onclick = () => moveSeries(seriesIndex, 1);
    row.querySelector(".edit").onclick = () => fillSeriesForm(series);
    row.querySelector(".toggle").onclick = async () => { series.active = series.active === false; await persistSeries(); loadSeries(); };
    row.querySelector(".del").onclick = async () => {
      if(confirm(`確定刪除「${series.name}」系列嗎？商品本身不會刪除。`)){
        ALL_SERIES = ALL_SERIES.filter((x) => x.id !== series.id);
        await persistSeries();
        loadSeries();
      }
    };
    box.appendChild(row);
  });
}

async function moveSeries(index, direction) {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ALL_SERIES.length) return;
  const items = sortSeries(ALL_SERIES);
  [items[index], items[target]] = [items[target], items[index]];
  items.forEach((item, idx) => { item.sortOrder = idx + 1; });
  ALL_SERIES = items;
  await persistSeries();
  await loadSeries();
}

function fillSeriesForm(series) {
  document.getElementById("seriesId").value = series.id;
  document.getElementById("sName").value = series.name || "";
  document.getElementById("sSortOrder").value = series.sortOrder ?? "";
  document.getElementById("sCoverImage").value = series.coverImage || "";
  document.getElementById("sDescription").value = series.description || "";
  window.scrollTo({top:0,behavior:"smooth"});
}

function clearSeriesForm() {
  document.getElementById("seriesId").value = "";
  document.getElementById("sName").value = "";
  document.getElementById("sSortOrder").value = "";
  document.getElementById("sCoverImage").value = "";
  document.getElementById("sDescription").value = "";
}

async function saveSeries() {
  const id = document.getElementById("seriesId").value;
  const name = document.getElementById("sName").value.trim();
  const sortOrder = Number(document.getElementById("sSortOrder").value);
  if (!name || !Number.isFinite(sortOrder)) { alert("請填寫系列名稱與時間排序。"); return; }
  const payload = {
    name,
    sortOrder,
    coverImage: document.getElementById("sCoverImage").value.trim(),
    description: document.getElementById("sDescription").value.trim(),
    active: true,
  };
  if (id) {
    const idx = ALL_SERIES.findIndex((x) => x.id === id);
    if (idx >= 0) ALL_SERIES[idx] = { ...ALL_SERIES[idx], ...payload };
  } else {
    ALL_SERIES.push({ id: `series_${Date.now()}`, ...payload });
  }
  ALL_SERIES = sortSeries(ALL_SERIES);
  await persistSeries();
  clearSeriesForm();
  await loadSeries();
}

async function seedDefaultSeries() {
  const existingNames = new Set(ALL_SERIES.map((s) => s.name));
  const missing = DEFAULT_SERIES_NAMES.map((name,idx) => ({name,sortOrder:idx+1})).filter((x) => !existingNames.has(x.name));
  if (!missing.length) { alert("15 個預設系列都已經存在了。"); return; }
  if (!confirm(`要建立 ${missing.length} 個尚未存在的預設系列嗎？`)) return;
  missing.forEach((x, idx) => ALL_SERIES.push({ id: `default_${DEFAULT_SERIES_NAMES.indexOf(x.name)+1}`, ...x, coverImage:"", description:"", active:true }));
  ALL_SERIES = sortSeries(ALL_SERIES);
  await persistSeries();
  await loadSeries();
  alert("預設幸運盒系列已建立。");
}

// ---------- Items ----------
// 商品排序：每筆商品有一個 sortOrder 數字，數字小的排前面。
// 還沒設定過排序的舊商品，暫時用讀取到的順序當預設值。
function sortItemsByOrder(items) {
  return items
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => {
      const orderA = a.item.sortOrder !== undefined ? a.item.sortOrder : a.idx;
      const orderB = b.item.sortOrder !== undefined ? b.item.sortOrder : b.idx;
      return orderA - orderB;
    })
    .map((x) => x.item);
}

// 固定的分類清單（如果之後想增加/修改分類，跟我說一聲，我幫妳改）
const CATEGORY_OPTIONS = ["New", "可互動", "熊", "樹", "花盆", "特殊"];

// ALL_ITEMS 存整份、已經照排序排好的商品清單（不受搜尋框影響），
// 搬移商品順序（▲▼）一律用這份完整清單的位置去計算，這樣即使搜尋框正在篩選畫面上只顯示部分商品，
// 順序調整還是會對到正確的商品，不會跑掉。
let ALL_ITEMS = [];

async function loadItems() {
  const snap = await getDocs(collection(db, "items"));
  ALL_ITEMS = sortItemsByOrder(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  renderItemsTable();
}

function renderItemsTable() {
  const keyword = (document.getElementById("itemSearchBox").value || "").trim().toLowerCase();
  const category = document.getElementById("categoryFilter").value;

  let visibleItems = ALL_ITEMS;
  if (category) {
    visibleItems = visibleItems.filter((i) => i.category === category);
  }
  if (keyword) {
    visibleItems = visibleItems.filter(
      (i) => i.name.toLowerCase().includes(keyword) || (i.category || "").toLowerCase().includes(keyword)
    );
  }

  const tbody = document.getElementById("itemsTbody");
  tbody.innerHTML = "";

  if (visibleItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--muted);">找不到符合的商品</td></tr>';
    return;
  }

  visibleItems.forEach((item) => {
    // 用「完整清單」裡的位置判斷是否已經到最上/最下面，跟搜尋篩選無關
    const idx = ALL_ITEMS.findIndex((i) => i.id === item.id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><img src="${item.image}" style="width:60px;height:44px;object-fit:cover;border-radius:6px;" /></td>
      <td>${item.name}</td>
      <td>${ALL_SERIES.find((x) => x.id === item.seriesId)?.name || item.seriesName || "—"}</td>
      <td>${item.category}</td>
      <td>🍬 ${item.priceCandy}</td>
      <td>💵 NT$ ${item.priceCash}</td>
      <td>${item.stock}</td>
      <td><span class="badge ${item.active ? "on" : "off"}">${item.active ? "上架中" : "已下架"}</span></td>
      <td class="row-actions">
        <button class="move-up" ${idx === 0 ? "disabled" : ""} title="往上移">▲</button>
        <button class="move-down" ${idx === ALL_ITEMS.length - 1 ? "disabled" : ""} title="往下移">▼</button>
        <button class="edit">編輯</button>
        <button class="edit toggle">${item.active ? "下架" : "上架"}</button>
        <button class="del">刪除</button>
      </td>
    `;
    const imgEl = tr.querySelector("img");
    imgEl.onerror = () => {
      imgEl.onerror = null;
      imgEl.src = PLACEHOLDER_IMG;
    };
    tr.querySelector(".move-up").onclick = () => moveItem(idx, -1);
    tr.querySelector(".move-down").onclick = () => moveItem(idx, 1);
    tr.querySelector(".edit").onclick = () => fillForm(item);
    tr.querySelector(".toggle").onclick = () => toggleActive(item);
    tr.querySelector(".del").onclick = () => deleteItem(item.id);
    tbody.appendChild(tr);
  });
}

document.getElementById("itemSearchBox").addEventListener("input", renderItemsTable);
document.getElementById("categoryFilter").addEventListener("change", renderItemsTable);

// 把完整清單（ALL_ITEMS）裡第 idx 筆和它上面（direction=-1）或下面（direction=1）
// 那筆互換順序，然後把「目前這份排序」整批寫回資料庫（幫每筆商品補上 sortOrder）。
async function moveItem(idx, direction) {
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= ALL_ITEMS.length) return;

  const items = ALL_ITEMS.slice();
  [items[idx], items[targetIdx]] = [items[targetIdx], items[idx]];

  await Promise.all(items.map((item, i) => updateDoc(doc(db, "items", item.id), { sortOrder: i })));
  loadItems();
}

function fillForm(item) {
  document.getElementById("itemId").value = item.id;
  document.getElementById("fName").value = item.name;
  populateSeriesSelect(item.seriesId || "");

  const categorySelect = document.getElementById("fCategory");
  categorySelect.querySelectorAll("option[data-legacy]").forEach((o) => o.remove());
  if (item.category && !CATEGORY_OPTIONS.includes(item.category)) {
    // 舊商品用的是以前的自訂分類文字，不在新的固定清單裡，
    // 先暫時加一個選項顯示原本的值，避免存檔時被誤蓋掉，建議之後手動改選新分類。
    const opt = document.createElement("option");
    opt.value = item.category;
    opt.textContent = `${item.category}（舊分類，建議改選新的）`;
    opt.dataset.legacy = "true";
    categorySelect.appendChild(opt);
  }
  categorySelect.value = item.category;

  document.getElementById("fPriceCandy").value = item.priceCandy;
  document.getElementById("fPriceCash").value = item.priceCash;
  document.getElementById("fStock").value = item.stock;
  document.getElementById("fImage").value = item.image;
  document.getElementById("fDesc").value = item.description;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Google 雲端硬碟圖片網址的固定格式，只有「你的檔案ID」那一段需要換成自己的
const IMAGE_URL_TEMPLATE = "https://drive.google.com/thumbnail?id=你的檔案ID&sz=w1000";

function clearForm() {
  ["itemId", "fName", "fPriceCandy", "fPriceCash", "fStock", "fDesc"].forEach(
    (id) => (document.getElementById(id).value = "")
  );
  document.getElementById("fImage").value = IMAGE_URL_TEMPLATE;
  populateSeriesSelect("");
  const categorySelect = document.getElementById("fCategory");
  categorySelect.querySelectorAll("option[data-legacy]").forEach((o) => o.remove());
  categorySelect.value = CATEGORY_OPTIONS[0];
}

async function saveItem() {
  const id = document.getElementById("itemId").value;
  const priceCandy = Number(document.getElementById("fPriceCandy").value);
  const priceCash = Number(document.getElementById("fPriceCash").value);
  const payload = {
    name: document.getElementById("fName").value.trim(),
    seriesId: document.getElementById("fSeries").value || "",
    seriesName: ALL_SERIES.find((x) => x.id === document.getElementById("fSeries").value)?.name || "",
    category: document.getElementById("fCategory").value,
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
    // 新商品預設排在最後面（用當下時間當排序值，一定比舊商品大）
    await addDoc(collection(db, "items"), { ...payload, active: true, sortOrder: Date.now() });
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
    const genderText = o.characterGender === "女角" ? "🙍‍♀️ 女角" : o.characterGender === "男角" ? "🙎‍♂️ 男角" : "-";
    tr.innerHTML = `
      <td>${o.id}</td>
      <td>${createdAtText}</td>
      <td>${o.buyerName}</td>
      <td>${o.contact}</td>
      <td>${genderText}</td>
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
      <td><button class="del">刪除</button></td>
    `;
    tr.querySelector("select").onchange = (e) => updateOrderStatus(o, e.target.value);
    tr.querySelector(".del").onclick = () => deleteOrder(o);
    tbody.appendChild(tr);
  });
}

// 幫訂單裡每一樣商品「加回」或「扣掉」庫存數量。
// 用讀取現在的庫存、再寫回新數字的方式（不是資料庫交易），
// 因為後台通常只有妳自己在操作，不太會同時有兩個人一起改庫存，用簡單的方式就夠了。
async function adjustStockForOrder(order, sign) {
  const items = order.items || [];
  await Promise.all(
    items.map(async (i) => {
      const itemRef = doc(db, "items", i.id);
      const snap = await getDoc(itemRef);
      if (!snap.exists()) return; // 商品可能已經被刪除了，跳過
      const currentStock = snap.data().stock || 0;
      const newStock = Math.max(0, currentStock + sign * i.qty);
      await updateDoc(itemRef, { stock: newStock });
    })
  );
}

// 訂單狀態改成「已取消」時自動把庫存加回去；如果從「已取消」改回其他狀態，
// 代表取消是誤按的，自動把庫存再扣回去，避免庫存跟實際訂單對不起來。
async function updateOrderStatus(order, newStatus) {
  const oldStatus = order.status;
  if (oldStatus === newStatus) return;

  if (newStatus === "已取消" && oldStatus !== "已取消") {
    await adjustStockForOrder(order, +1);
  } else if (oldStatus === "已取消" && newStatus !== "已取消") {
    await adjustStockForOrder(order, -1);
  }

  await updateDoc(doc(db, "orders", order.id), { status: newStatus });
  loadOrders();
}

async function deleteOrder(order) {
  const stockWarning =
    order.status !== "已取消"
      ? "\n\n⚠️ 這筆訂單還沒有取消，刪除不會自動退回庫存。如果商品其實沒有出貨，建議先把狀態改成「已取消」（庫存會自動加回去）再刪除。"
      : "";
  if (!confirm(`確定要刪除這筆訂單嗎？刪除後無法復原。${stockWarning}`)) return;
  await deleteDoc(doc(db, "orders", order.id));
  loadOrders();
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


document.getElementById("saveSeriesBtn").onclick = (e) => { e.preventDefault(); saveSeries(); };
document.getElementById("clearSeriesBtn").onclick = (e) => { e.preventDefault(); clearSeriesForm(); };
document.getElementById("seedSeriesBtn").onclick = (e) => { e.preventDefault(); seedDefaultSeries(); };
