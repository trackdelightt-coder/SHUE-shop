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

// 圖片網址失效時（例如連結被刪除、圖床擋住）顯示的替代圖片，避免出現「???」破圖示
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="100%" height="100%" fill="#1b2540"/>' +
      '<text x="50%" y="50%" fill="#aab4d4" font-size="22" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">圖片無法載入</text>' +
      "</svg>"
  );

// 商品圖片大多放在 Google 雲端硬碟等外部圖床，這些圖床通常不允許「跨網站讀取圖片內容」，
// 所以平常瀏覽網頁時圖片看起來正常，但「截圖並複製」用的 html2canvas 工具想把圖片畫進截圖時會被擋下來，
// 變成截圖裡圖片是空白的（但網頁上看起來還是正常的）。
// 這裡用一個公開的免費圖片代理服務（images.weserv.nl）幫忙轉一手，讓截圖工具能正常讀到圖片。
function corsProxyImage(url) {
  if (!url) return url;
  if (url.startsWith("data:")) return url; // 本來就是內建的替代圖，不用轉
  const stripped = url.replace(/^https?:\/\//, "");
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}`;
}

let ITEMS = [];
let CATEGORY = "全部";
let SEARCH_KEYWORD = "";
// 同一筆訂單只能用一種付款方式（糖果 或 現金），所以用全域變數記錄目前選的付款方式
let PAYMENT_METHOD = localStorage.getItem("mstar_pay_method") || "糖果";
// 家具要放在哪個角色身上（男角／女角）
let CHARACTER_GENDER = localStorage.getItem("mstar_gender") || "男角";
// CART 是簡單的 { 商品ID: 數量 }
let CART = JSON.parse(localStorage.getItem("mstar_cart") || "{}");

function saveCart() {
  localStorage.setItem("mstar_cart", JSON.stringify(CART));
}

function saveGender() {
  localStorage.setItem("mstar_gender", CHARACTER_GENDER);
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

// 商品排序：跟後台一樣，用 sortOrder 數字排序（小的在前面），
// 還沒有 sortOrder 的舊商品就照原本讀到的順序排在後面。
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

async function loadItems() {
  try {
    const snap = await getDocs(collection(db, "items"));
    ITEMS = sortItemsByOrder(
      snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.active !== false)
    );
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
    btn.textContent = c === "全部" ? "家具(全)" : c;
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
  const keyword = SEARCH_KEYWORD.trim().toLowerCase();
  const list = ITEMS.filter((i) => {
    const matchCategory = CATEGORY === "全部" || i.category === CATEGORY;
    const matchKeyword = !keyword || i.name.toLowerCase().includes(keyword);
    return matchCategory && matchKeyword;
  });

  if (list.length === 0) {
    grid.innerHTML = '<div class="cart-empty">找不到符合的商品，換個關鍵字試試看？</div>';
    return;
  }

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

    const imgEl = card.querySelector("img");
    imgEl.onerror = () => {
      imgEl.onerror = null;
      imgEl.src = PLACEHOLDER_IMG;
    };

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

function setGender(gender) {
  CHARACTER_GENDER = gender;
  saveGender();
  updateGenderToggleUI();
}

function updateGenderToggleUI() {
  document.querySelectorAll("#genderToggle .pay-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.gender === CHARACTER_GENDER);
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
        orderItems.push({ id: snap.id, name: item.name, price: unitPrice, qty, image: item.image });
      });

      const orderRef = doc(collection(db, "orders"));
      tx.set(orderRef, {
        createdAt: serverTimestamp(),
        buyerName,
        contact,
        note,
        characterGender: CHARACTER_GENDER,
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

      return { id: orderRef.id, total, paymentMethod: PAYMENT_METHOD, items: orderItems };
    });

    CART = {};
    saveCart();
    renderCart();
    await loadItems();
    msgBox.innerHTML = "";
    showOrderSummary({ ...result, buyerName, contact, note, characterGender: CHARACTER_GENDER });
  } catch (err) {
    msgBox.innerHTML = `<div class="msg error">下單失敗：${err.message || "請稍後再試"}</div>`;
  } finally {
    document.getElementById("checkoutBtn").disabled = false;
    document.getElementById("checkoutBtn").textContent = "送出訂單";
  }
}

// 送出訂單後跳出一個「乾淨」的訂單畫面（不含商品列表、篩選按鈕等雜訊），
// 買家只要截這個畫面就好，不用截整個網頁。
function showOrderSummary({ id, total, paymentMethod, items, buyerName, contact, note, characterGender }) {
  const totalText = formatPrice(paymentMethod, total);
  const itemsHtml = items
    .map((i) => {
      const lineText = paymentMethod === "糖果" ? `${i.price * i.qty} 糖果` : `NT$ ${i.price * i.qty}`;
      const thumbSrc = i.image ? corsProxyImage(i.image) : PLACEHOLDER_IMG;
      return `
        <div class="order-summary-item">
          <img src="${thumbSrc}" data-original="${i.image || ""}" alt="${i.name}" class="order-summary-thumb" />
          <span class="order-summary-item-name">${i.name} x${i.qty}</span>
          <span class="order-summary-item-price">${lineText}</span>
        </div>`;
    })
    .join("");

  document.getElementById("orderSummaryBody").innerHTML = `
    <div class="order-summary-row"><span>訂單編號</span><span>${id}</span></div>
    <div class="order-summary-row"><span>買家</span><span>${buyerName}</span></div>
    <div class="order-summary-row"><span>Discord ID</span><span>${contact || "-"}</span></div>
    <div class="order-summary-row"><span>角色</span><span>${characterGender === "女角" ? "🙍‍♀️ 女角" : "🙎‍♂️ 男角"}</span></div>
    ${note ? `<div class="order-summary-row"><span>備註</span><span>${note}</span></div>` : ""}
    <div class="order-summary-row"><span>付款方式</span><span>${paymentMethod === "糖果" ? "🍬 糖果" : "💵 現金"}</span></div>
    <div class="order-summary-items">${itemsHtml}</div>
    <div class="order-summary-total"><span>總金額</span><span>${totalText}</span></div>
  `;
  document.getElementById("orderSummaryBody")
    .querySelectorAll(".order-summary-thumb")
    .forEach((img) => {
      img.onerror = () => {
        const original = img.dataset.original;
        // 代理服務失敗的話，先試試看原本的圖片網址（至少畫面上看得到，只是截圖時可能還是會空白）
        if (original && img.src !== original) {
          img.src = original;
        } else {
          img.onerror = null;
          img.src = PLACEHOLDER_IMG;
        }
      };
    });
  document.getElementById("captureMsg").innerHTML = "";
  document.getElementById("orderSummaryOverlay").style.display = "flex";
}

// 買家按「截圖並複製」：把訂單卡片畫成一張圖片，直接複製到剪貼簿，
// 買家可以直接在 Discord 貼上（Ctrl+V / Cmd+V），不用自己動手截圖。
async function captureAndCopyOrderSummary() {
  const captureMsg = document.getElementById("captureMsg");
  const captureBtn = document.getElementById("orderSummaryCaptureBtn");
  const target = document.getElementById("orderSummaryCapture");

  if (typeof html2canvas === "undefined") {
    captureMsg.textContent = "截圖功能載入中，請稍後再試一次，或直接手動截圖畫面。";
    return;
  }

  captureBtn.disabled = true;
  captureBtn.textContent = "截圖中...";
  try {
    const canvas = await html2canvas(target, { backgroundColor: "#101a33", scale: 2, useCORS: true });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("轉檔失敗");

    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      captureMsg.textContent = "✅ 已複製到剪貼簿！到 Discord 訊息框按 Ctrl+V（Mac 是 Cmd+V）貼上就可以了。";
    } else {
      throw new Error("此瀏覽器不支援自動複製");
    }
  } catch (err) {
    // 瀏覽器不支援自動複製剪貼簿時，改成直接下載圖片，買家把圖片傳給賣家即可
    try {
      const canvas = await html2canvas(target, { backgroundColor: "#101a33", scale: 2, useCORS: true });
      const dataUrl = canvas.toDataURL("image/png");
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = "訂單截圖.png";
      link.click();
      captureMsg.textContent = "此瀏覽器不支援自動複製，已改成直接下載圖片，把圖片傳給賣家即可。";
    } catch (err2) {
      captureMsg.textContent = "截圖失敗，請直接手動截圖這個畫面。";
    }
  } finally {
    captureBtn.disabled = false;
    captureBtn.textContent = "📸 截圖並複製";
  }
}

document.getElementById("orderSummaryCaptureBtn").addEventListener("click", captureAndCopyOrderSummary);

document.getElementById("orderSummaryClose").addEventListener("click", () => {
  document.getElementById("orderSummaryOverlay").style.display = "none";
});

document.querySelectorAll("#globalPayToggle .pay-btn").forEach((btn) => {
  btn.addEventListener("click", () => setPaymentMethod(btn.dataset.method));
});
updatePayToggleUI();

document.querySelectorAll("#genderToggle .pay-btn").forEach((btn) => {
  btn.addEventListener("click", () => setGender(btn.dataset.gender));
});
updateGenderToggleUI();

document.getElementById("searchBox").addEventListener("input", (e) => {
  SEARCH_KEYWORD = e.target.value;
  renderGrid();
});

document.getElementById("checkoutBtn").addEventListener("click", checkout);
loadItems();
loadAnnouncement();
