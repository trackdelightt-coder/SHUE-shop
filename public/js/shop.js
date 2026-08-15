import { firebaseConfig } from "./firebase-init.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let ITEMS = [];
let CATEGORY = "全部";
// 同一筆訂單只能用一種付款方式（糖果 或 現金），所以用全域變數記錄目前選的付款方式
let PAYMENT_METHOD = localStorage.getItem("mstar_pay_method") || "糖果";
// CART 是簡單的 { 商品ID: 數量 }
let CART = JSON.parse(localStorage.getItem("mstar_cart") || "{}");

function saveCart() {
  localStorage.setItem("mstar_cart", JSON.stringify(CART));
}

function savePayMethod() {
  localStorage.setItem("mstar_pay_method", PAYMENT_METHOD);
}

function priceFor(item, paymentMethod) {
  return paymentMethod === "糖果" ? item.priceCandy : item.priceCash;
}

function formatPrice(paymentMethod, amount) {
  return paymentMethod === "糖果" ? `🍬 ${amount} 糖果` : `💵 NT$ ${amount}`;
}

async function loadItems() {
  try {
    const snap = await getDocs(collection(db, "items"));
    ITEMS = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((i) => i.active !== false);
  } catch (err) {
    console.error("[Firestore] 讀取商品失敗:", err);
    ITEMS = [];
    const grid = document.getElementById("grid");
    grid.innerHTML =
      '<div class="cart-empty">商品讀取失敗，請確認 firebase-init.js 是否已經填好設定值。</div>';
  }
  renderFilters();
  renderGrid();
  renderCart();
}

async function loadAnnouncement() {
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    const box = document.getElementById("announcementBox");
    const announcement = snap.exists() ? snap.data().announcement : "";
    if (announcement && announcement.trim()) {
      box.textContent = announcement;
      box.style.display = "block";
    } else {
      box.style.display = "none";
    }
  } catch (err) {
    // 公告載入失敗不影響下單流程，靜默略過
  }
}

function renderFilters() {
  const cats = ["全部", ...new Set(ITEMS.map((i) => i.category))];
  const el = document.getElementById("filters");
  el.innerHTML = "";
  cats.forEach((c) => {
    const btn = document.createElement("button");
    btn.textContent = c;
    if (c === CATEGORY) btn.classList.add("active");
    btn.onclick = () => {
      CATEGORY = c;
      renderFilters();
      renderGrid();
    };
    el.appendChild(btn);
  });
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  const list = ITEMS.filter((i) => CATEGORY === "全部" || i.category === CATEGORY);
  list.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    const outOfStock = item.stock !== undefined && item.stock <= 0;

    card.innerHTML = `
      <img src="${item.image}" alt="${item.name}" />
      <div class="body">
        <div class="cat">${item.category}</div>
        <h3>${item.name}</h3>
        <div class="desc">${item.description || ""}</div>
        <div class="price-row">
          <span class="price">${formatPrice(PAYMENT_METHOD, priceFor(item, PAYMENT_METHOD))}</span>
          <span class="stock">${outOfStock ? "已售完" : "庫存 " + item.stock}</span>
        </div>
        <button class="add-btn" ${outOfStock ? "disabled" : ""}>加入購物車</button>
      </div>
    `;

    card.querySelector(".add-btn").onclick = () => addToCart(item.id);
    grid.appendChild(card);
  });
}

function addToCart(id) {
  CART[id] = (CART[id] || 0) + 1;
  saveCart();
  renderCart();
}

function changeQty(id, delta) {
  if (!CART[id]) return;
  CART[id] += delta;
  if (CART[id] <= 0) delete CART[id];
  saveCart();
  renderCart();
}

function setPaymentMethod(method) {
  if (method === PAYMENT_METHOD) return;
  const hasItems = Object.keys(CART).length > 0;
  if (hasItems) {
    const ok = confirm(
      "切換付款方式（糖果／現金）會清空目前購物車，因為同一筆訂單只能用同一種付款方式。確定要切換嗎？"
    );
    if (!ok) {
      updatePayToggleUI();
      return;
    }
    CART = {};
    saveCart();
  }
  PAYMENT_METHOD = method;
  savePayMethod();
  updatePayToggleUI();
  renderGrid();
  renderCart();
}

function updatePayToggleUI() {
  document.querySelectorAll("#globalPayToggle .pay-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.method === PAYMENT_METHOD);
  });
}

function renderCart() {
  const linesEl = document.getElementById("cartLines");
  const ids = Object.keys(CART);
  if (ids.length === 0) {
    linesEl.innerHTML = '<div class="cart-empty">購物車是空的，快去挑選家具吧！</div>';
    document.getElementById("totalAmount").innerHTML = "0";
    document.getElementById("checkoutBtn").disabled = true;
    return;
  }

  let total = 0;
  linesEl.innerHTML = "";
  ids.forEach((id) => {
    const item = ITEMS.find((i) => i.id === id);
    if (!item) return;

    const qty = CART[id];
    const unitPrice = priceFor(item, PAYMENT_METHOD);
    const lineTotal = unitPrice * qty;
    total += lineTotal;

    const row = document.createElement("div");
    row.className = "cart-line";
    row.innerHTML = `
      <span class="name">${item.name}</span>
      <div class="qty-ctrl">
        <button data-d="-1">−</button>
        <span>${qty}</span>
        <button data-d="1">＋</button>
      </div>
      <span>${PAYMENT_METHOD === "糖果" ? lineTotal : "NT$" + lineTotal}</span>
    `;
    row.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => changeQty(id, parseInt(btn.dataset.d, 10));
    });
    linesEl.appendChild(row);
  });

  document.getElementById("totalAmount").textContent = formatPrice(PAYMENT_METHOD, total);
  document.getElementById("checkoutBtn").disabled = false;
}

// 下單：用 Firestore 交易（transaction）在買家自己的瀏覽器裡送出，
// 送出當下會重新讀一次商品的庫存與價格，同一時間只會有一個人搶到最後的庫存。
// 注意：因為這個版本沒有後端伺服器，價格是在瀏覽器端計算的，
// 技術能力較高的人理論上有辦法竄改送出的金額，這點跟原本「伺服器重新計算金額」的版本不同，
// 適合小型、熟人交易的商店；如果之後量變大、想要更嚴謹的金額把關，可以再跟我說。
async function checkout() {
  const buyerName = document.getElementById("buyerName").value.trim();
  const contact = document.getElementById("contact").value.trim();
  const note = document.getElementById("note").value.trim();
  const msgBox = document.getElementById("msgBox");
  msgBox.innerHTML = "";

  if (!buyerName) {
    msgBox.innerHTML = '<div class="msg error">請填寫您的暱稱 / 遊戲ID</div>';
    return;
  }

  const cartEntries = Object.entries(CART); // [ [id, qty], ... ]
  if (cartEntries.length === 0) return;

  document.getElementById("checkoutBtn").disabled = true;
  document.getElementById("checkoutBtn").textContent = "送出中...";

  try {
    const result = await runTransaction(db, async (tx) => {
      const itemRefs = cartEntries.map(([id]) => doc(db, "items", id));
      const itemSnaps = await Promise.all(itemRefs.map((ref) => tx.get(ref)));

      const orderItems = [];
      let total = 0;

      itemSnaps.forEach((snap, idx) => {
        const [, qty] = cartEntries[idx];
        if (!snap.exists() || snap.data().active === false) {
          throw new Error(`商品不存在或已下架`);
        }
        const item = snap.data();
        if (item.stock !== undefined && qty > item.stock) {
          throw new Error(`「${item.name}」庫存不足`);
        }
        const unitPrice = PAYMENT_METHOD === "糖果" ? item.priceCandy : item.priceCash;
        const lineTotal = unitPrice * qty;
        total += lineTotal;
        orderItems.push({ id: snap.id, name: item.name, price: unitPrice, qty });
      });

      const orderRef = doc(collection(db, "orders"));
      tx.set(orderRef, {
        createdAt: serverTimestamp(),
        buyerName,
        contact,
        note,
        items: orderItems,
        paymentMethod: PAYMENT_METHOD,
        total,
        status: "待確認",
      });

      itemSnaps.forEach((snap, idx) => {
        const [, qty] = cartEntries[idx];
        const newStock = Math.max(0, (snap.data().stock || 0) - qty);
        tx.update(itemRefs[idx], { stock: newStock });
      });

      return { id: orderRef.id, total, paymentMethod: PAYMENT_METHOD };
    });

    CART = {};
    saveCart();
    renderCart();
    await loadItems();
    const totalText = formatPrice(result.paymentMethod, result.total);
    msgBox.innerHTML = `<div class="msg success">✅ 訂單已送出！訂單編號：${result.id}，應付：${totalText}<br/>📸 請截圖這個畫面，私訊 Discord 給賣家確認訂單～</div>`;
  } catch (err) {
    msgBox.innerHTML = `<div class="msg error">下單失敗：${err.message || "請稍後再試"}</div>`;
  } finally {
    document.getElementById("checkoutBtn").disabled = false;
    document.getElementById("checkoutBtn").textContent = "送出訂單";
  }
}

document.querySelectorAll("#globalPayToggle .pay-btn").forEach((btn) => {
  btn.addEventListener("click", () => setPaymentMethod(btn.dataset.method));
});
updatePayToggleUI();

document.getElementById("checkoutBtn").addEventListener("click", checkout);
loadItems();
loadAnnouncement();
