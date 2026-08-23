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
let SERIES = [];
let SERIES_ORDER = "newest";
let ACTIVE_SERIES_ID = "";
// 首頁贈品專區只先預覽幾件（大約兩排），其餘要按「查看更多」才會在下面商品清單完整顯示
const GIFT_PREVIEW_COUNT = 8;
let ACTIVE_GIFT_VIEW = false;
let CATEGORY = "全部";
let SEARCH_KEYWORD = "";
let ACTIVE_TAG = "全部";
let CURRENT_PAGE = 1;
const PAGE_SIZE = 60;
// 同一筆訂單只能用一種付款方式（糖果 或 現金），所以用全域變數記錄目前選的付款方式
let PAYMENT_METHOD = localStorage.getItem("mstar_pay_method") || "糖果";
// 家具要放在哪個角色身上（男角／女角）
let CHARACTER_GENDER = localStorage.getItem("mstar_gender") || "男角";
// CART 是簡單的 { 商品ID: 數量 }
let CART = JSON.parse(localStorage.getItem("mstar_cart") || "{}");
// GIFT_CART 存的是從「贈品專區」加進來的商品，格式跟 CART 一樣，但結帳時免費、不算進總金額
let GIFT_CART = JSON.parse(localStorage.getItem("mstar_gift_cart") || "{}");

function saveGiftCart() {
  localStorage.setItem("mstar_gift_cart", JSON.stringify(GIFT_CART));
}

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


const DEFAULT_SERIES = [
  // 1 = 最新，數字越大越舊
  "沙灘裝飾套裝幸運盒",
  "MstarLand幸運盒",
  "時光之愛幸運盒",
  "夏日天堂幸運盒",
  "秘世界幸運盒",
  "🧸睡熊幸運盒",
  "治癒衝刺幸運盒",
  "古董道具店幸運盒",
  "夏日霓虹派對幸運盒",
  "熱帶夏季幸運盒",
  "宴會廳幸運箱",
  "沙灘拍照區幸運箱",
  "黑暗霓虹派對幸運盒",
  "口袋夏日幸運盒",
  "夢幻樂園幸運盒",
];

function fallbackSeries() {
  return DEFAULT_SERIES.map((name, idx) => ({
    id: `default-${idx + 1}`,
    name,
    coverImage: "",
    description: "",
    sortOrder: idx + 1,
    active: true,
    fallback: true,
  }));
}

async function loadSeries() {
  try {
    const snap = await getDoc(doc(db, "settings", "series"));
    const data = snap.exists() ? snap.data() : {};
    SERIES = Array.isArray(data.items) ? data.items.filter((x) => x.active !== false) : [];

    // 若買家頁先於後台被打開，舊資料仍以「1=最舊」存在；先在記憶體轉成新版順序，避免畫面顛倒。
    if (SERIES.length && data.orderMode !== "one-is-newest") {
      SERIES = SERIES
        .slice()
        .sort((a, b) => Number(b.sortOrder || 0) - Number(a.sortOrder || 0))
        .map((item, idx) => ({ ...item, sortOrder: idx + 1 }));
    }

    if (SERIES.length === 0) SERIES = fallbackSeries();
  } catch (err) {
    console.warn("[Firestore] 系列資料尚未建立，先使用預設系列名稱。", err);
    SERIES = fallbackSeries();
  }
  renderSeries();
}

function seriesItemCount(series) {
  return ITEMS.filter((item) => item.seriesId === series.id || (!item.seriesId && item.seriesName === series.name)).length;
}

function sortedSeries() {
  const list = SERIES.slice().sort((a,b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  return SERIES_ORDER === "newest" ? list : list.reverse();
}

function seriesCover(series) {
  if (series.coverImage) return series.coverImage;
  const firstItem = ITEMS.find((item) => item.seriesId === series.id || (!item.seriesId && item.seriesName === series.name));
  return firstItem?.image || PLACEHOLDER_IMG;
}

// 這個系列裡只要有一件商品被標記「新品」，系列首圖就會出現 NEW 斜緞帶
function seriesHasNew(series) {
  return ITEMS.some(
    (item) => (item.seriesId === series.id || (!item.seriesId && item.seriesName === series.name)) && item.isNew
  );
}

function renderSeries() {
  const grid = document.getElementById("seriesGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const list = sortedSeries();
  if (!list.length) {
    grid.innerHTML = '<div class="series-empty">目前還沒有系列資料。</div>';
    return;
  }
  list.forEach((series) => {
    const card = document.createElement("article");
    card.className = "series-card";
    card.innerHTML = `
      <img src="${seriesCover(series)}" alt="${series.name}" />
      ${seriesHasNew(series) ? '<div class="ribbon-new">NEW</div>' : ""}
      <div class="series-card-body">
        <div class="series-card-title">${series.name}</div>
        <div class="series-card-count">${seriesItemCount(series)} 件家具</div>
      </div>`;
    const img = card.querySelector("img");
    img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER_IMG; };
    card.onclick = () => openSeries(series.id);
    grid.appendChild(card);
  });
}

function openSeries(seriesId) {
  ACTIVE_SERIES_ID = seriesId;
  ACTIVE_GIFT_VIEW = false;
  CATEGORY = "全部";
  SEARCH_KEYWORD = "";
  document.getElementById("searchBox").value = "";
  const series = SERIES.find((x) => x.id === seriesId);
  const hero = document.getElementById("seriesHero");
  const title = document.getElementById("productSectionTitle");
  const backBtn = document.getElementById("backToAllBtn");
  const section = document.getElementById("seriesSection");
  const giftSection = document.getElementById("giftSection");
  if (series) {
    hero.innerHTML = `
      <img src="${seriesCover(series)}" alt="${series.name}" />
      ${seriesHasNew(series) ? '<div class="ribbon-new">NEW</div>' : ""}
      <div class="series-hero-body">
        <h2 class="series-hero-title">${series.name}</h2>
        ${series.description ? `<p class="series-hero-desc">${series.description}</p>` : ""}
      </div>`;
    const img = hero.querySelector("img");
    img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER_IMG; };
    hero.style.display = "block";
    title.textContent = `🎁 ${series.name} 商品`;
    backBtn.style.display = "inline-block";
    const bottomBack = document.getElementById("seriesBottomBackBtn");
    bottomBack.textContent = "← 返回幸運盒列表";
    bottomBack.style.display = "block";
    section.style.display = "none";
    if (giftSection) giftSection.style.display = "none";
  }
  renderFilters();
  renderGrid();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// 從「幸運盒系列」或「贈品專區看更多」進到的專屬瀏覽畫面，都是按同一個返回鍵回到首頁正常瀏覽狀態。
function closeSpecialView() {
  ACTIVE_SERIES_ID = "";
  ACTIVE_GIFT_VIEW = false;
  CATEGORY = "全部";
  document.getElementById("seriesHero").style.display = "none";
  document.getElementById("seriesHero").innerHTML = "";
  document.getElementById("productSectionTitle").textContent = "📦 全部家具";
  document.getElementById("backToAllBtn").style.display = "none";
  document.getElementById("seriesBottomBackBtn").style.display = "none";
  document.getElementById("seriesSection").style.display = "block";
  renderFilters();
  renderGrid();
  renderGiftSection();
}

// 贈品專區按「查看更多」：把下面商品清單切成只顯示贈品商品，並顯示返回鍵。
function openGiftView() {
  ACTIVE_GIFT_VIEW = true;
  ACTIVE_SERIES_ID = "";
  CATEGORY = "全部";
  SEARCH_KEYWORD = "";
  document.getElementById("searchBox").value = "";
  document.getElementById("seriesHero").style.display = "none";
  document.getElementById("seriesHero").innerHTML = "";
  document.getElementById("productSectionTitle").textContent = "🎁 贈品專區";
  document.getElementById("backToAllBtn").style.display = "inline-block";
  const bottomBack = document.getElementById("seriesBottomBackBtn");
  bottomBack.textContent = "← 返回贈品專區預覽";
  bottomBack.style.display = "block";
  document.getElementById("seriesSection").style.display = "none";
  document.getElementById("giftSection").style.display = "none";
  renderFilters();
  renderGrid();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setSeriesOrder(order) {
  SERIES_ORDER = order;
  document.getElementById("seriesNewestBtn")?.classList.toggle("active", order === "newest");
  document.getElementById("seriesOldestBtn")?.classList.toggle("active", order === "oldest");
  renderSeries();
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
  renderTagFilters();
  renderGrid();
  renderSeries();
  renderCart();
  renderGiftSection();
}

async function loadAnnouncement() {
  try {
    const snap = await getDoc(doc(db, "settings", "main"));
    const box = document.getElementById("announcementBox");
    const data = snap.exists() ? snap.data() : {};
    const announcement = data.announcement;
    if (announcement && announcement.trim()) {
      box.textContent = announcement;
      box.style.display = "block";
    } else {
      box.style.display = "none";
    }
    GIFT_SECTION_ENABLED = data.giftSectionEnabled === true;
    renderGiftSection();
  } catch (err) {
    // 公告／贈品區設定載入失敗不影響下單流程，靜默略過
  }
}

// 分類清單改成在後台「分類與標籤管理」維護，存在 Firestore（settings/taxonomy）。
// 這裡的清單只在後台還沒建立過設定值時，先暫時顯示用（避免商店還沒設定好分類就整頁空白）。
const DEFAULT_CATEGORY_OPTIONS = ["拍照區", "家具", "裝飾", "植物", "燈飾", "熊", "花盆", "雕像", "傳送門", "特殊"];
let CATEGORY_LIST = DEFAULT_CATEGORY_OPTIONS.slice();

async function loadTaxonomy() {
  try {
    const snap = await getDoc(doc(db, "settings", "taxonomy"));
    if (snap.exists() && Array.isArray(snap.data().categories) && snap.data().categories.length) {
      CATEGORY_LIST = snap.data().categories;
    }
  } catch (err) {
    // 讀取失敗就先用預設分類清單，不影響買家瀏覽
  }
  renderFilters();
}

function renderFilters() {
  const el = document.getElementById("filters");
  el.innerHTML = "";

  // 系列頁、贈品專區「查看更多」頁商品通常不多：不再顯示分類按鈕。
  if (ACTIVE_SERIES_ID || ACTIVE_GIFT_VIEW) {
    el.style.display = "none";
    document.getElementById("tagFilters").style.display = "none";
    CATEGORY = "全部"; ACTIVE_TAG = "全部"; CURRENT_PAGE = 1;
    return;
  }
  document.getElementById("tagFilters").style.display = "flex";

  // 只有「全部家具」頁才顯示分類，順序照後台「分類與標籤管理」目前的清單。
  el.style.display = "flex";
  ["全部", ...CATEGORY_LIST].forEach((c) => {
    const btn = document.createElement("button");
    btn.textContent = c;
    if (c === CATEGORY) btn.classList.add("active");
    btn.onclick = () => {
      CATEGORY = c;
      CURRENT_PAGE = 1;
      renderFilters();
      renderGrid();
    };
    el.appendChild(btn);
  });
}

function renderTagFilters() {
  const el = document.getElementById("tagFilters");
  if (!el) return;
  if (ACTIVE_SERIES_ID) { el.style.display = "none"; el.innerHTML = ""; return; }
  const tags = [...new Set(ITEMS.flatMap(i => Array.isArray(i.tags) ? i.tags : []))].filter(Boolean).sort((a,b)=>a.localeCompare(b,"zh-Hant"));
  el.innerHTML = "";
  if (!tags.length) { el.style.display = "none"; return; }
  el.style.display = "flex";
  ["全部", ...tags].forEach(tag => {
    const btn=document.createElement("button"); btn.textContent = tag === "全部" ? "🏷️ 全部標籤" : `🏷️ ${tag}`;
    if (tag===ACTIVE_TAG) btn.classList.add("active");
    btn.onclick=()=>{ ACTIVE_TAG=tag; CURRENT_PAGE=1; renderTagFilters(); renderGrid(); };
    el.appendChild(btn);
  });
}

function renderPagination(totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (CURRENT_PAGE > totalPages) CURRENT_PAGE = totalPages;
  ["paginationTop","paginationBottom"].forEach(id => {
    const el=document.getElementById(id); if(!el) return;
    if (ACTIVE_SERIES_ID || totalPages <= 1) { el.innerHTML=""; el.style.display="none"; return; }
    el.style.display="flex"; el.innerHTML = `
      <button class="page-nav prev" ${CURRENT_PAGE===1?"disabled":""}>← 上一頁</button>
      <span>第 ${CURRENT_PAGE} / ${totalPages} 頁 · 共 ${totalItems} 件</span>
      <button class="page-nav next" ${CURRENT_PAGE===totalPages?"disabled":""}>下一頁 →</button>`;
    el.querySelector(".prev").onclick=()=>{ if(CURRENT_PAGE>1){CURRENT_PAGE--; renderGrid(); window.scrollTo({top:document.getElementById("productSectionTitle").offsetTop-20,behavior:"smooth"});} };
    el.querySelector(".next").onclick=()=>{ if(CURRENT_PAGE<totalPages){CURRENT_PAGE++; renderGrid(); window.scrollTo({top:document.getElementById("productSectionTitle").offsetTop-20,behavior:"smooth"});} };
  });
}

// 已售完是庫存歸零時自動判斷，不用後台手動標記。
function isOutOfStock(item) {
  return item.stock !== undefined && item.stock <= 0;
}

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  const keyword = SEARCH_KEYWORD.trim().toLowerCase();
  const activeSeries = SERIES.find((x) => x.id === ACTIVE_SERIES_ID);
  const list = ITEMS.filter((i) => {
    const matchSeries = !ACTIVE_SERIES_ID || i.seriesId === ACTIVE_SERIES_ID || (activeSeries && !i.seriesId && i.seriesName === activeSeries.name);
    const matchGift = !ACTIVE_GIFT_VIEW || i.giftEligible === true;
    const matchCategory = CATEGORY === "全部" || i.category === CATEGORY;
    const matchKeyword = !keyword || i.name.toLowerCase().includes(keyword);
    const matchTag = ACTIVE_TAG === "全部" || (Array.isArray(i.tags) && i.tags.includes(ACTIVE_TAG));
    return matchSeries && matchGift && matchCategory && matchKeyword && matchTag;
  });

  renderTagFilters();
  renderPagination(list.length);
  const pageList = ACTIVE_SERIES_ID ? list : list.slice((CURRENT_PAGE - 1) * PAGE_SIZE, CURRENT_PAGE * PAGE_SIZE);

  if (list.length === 0) {
    grid.innerHTML = '<div class="cart-empty">找不到符合的商品，換個關鍵字試試看？</div>';
    return;
  }

  pageList.forEach((item) => grid.appendChild(buildProductCard(item)));
}

// 商品卡片（全部家具的格子、贈品專區都共用這份）。
// isGift 為 true 時（贈品專區）：卡片上顯示「🎁 贈品」而不是價格，按鈕是「加入贈品」，
// 加進去的東西會放進 GIFT_CART（跟平常購買的 CART 分開），結帳時這筆不算錢。
function buildProductCard(item, { extraClass, isGift } = {}) {
  const card = document.createElement("div");
  card.className = extraClass ? `card ${extraClass}` : "card";
  const outOfStock = isOutOfStock(item);

  card.innerHTML = `
    <div class="card-img-wrap">
      <img src="${item.image}" alt="${item.name}" class="${outOfStock ? "img-soldout" : ""}" />
      ${item.isNew ? '<div class="ribbon-new">NEW</div>' : ""}
      ${outOfStock ? '<div class="stamp-soldout">已售完</div>' : ""}
    </div>
    <div class="body">
      <div class="cat">${item.category}</div>
      ${Array.isArray(item.tags) && item.tags.length ? `<div class="item-tags">${item.tags.map(t=>`<span>${t}</span>`).join("")}</div>` : ""}
      <h3>${item.name}</h3>
      <div class="desc">${item.description || ""}</div>
      <div class="price-row">
        <span class="price${isGift ? " gift-price" : ""}">${isGift ? "🎁 贈品（免費）" : formatPrice(PAYMENT_METHOD, priceFor(item, PAYMENT_METHOD))}</span>
        <span class="stock">${outOfStock ? "已售完" : "庫存 " + item.stock}</span>
      </div>
      <button class="add-btn" ${outOfStock ? "disabled" : ""}>${isGift ? "加入贈品" : "加入購物車"}</button>
    </div>
  `;

  const imgEl = card.querySelector("img");
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = PLACEHOLDER_IMG;
  };

  card.querySelector(".add-btn").onclick = () => (isGift ? addGiftToCart(item.id) : addToCart(item.id));
  return card;
}

// ---------- 贈品專區 ----------
// 後台可以隨時開關；有開、而且至少有一件商品被標記「可作為贈品」時才會顯示。
// 贈品區的商品卡片可以直接加，但加進去的是免費贈品，不是正常購買。
let GIFT_SECTION_ENABLED = false;

function renderGiftSection() {
  const section = document.getElementById("giftSection");
  const grid = document.getElementById("giftGrid");
  const moreBtn = document.getElementById("giftMoreBtn");
  if (!section || !grid) return;

  // 正在看系列頁或贈品「查看更多」全部列表時，首頁預覽區塊本來就故意被藏起來，這裡不要蓋回去。
  if (ACTIVE_SERIES_ID || ACTIVE_GIFT_VIEW) return;

  const giftItems = ITEMS.filter((i) => i.giftEligible === true);
  if (!GIFT_SECTION_ENABLED || giftItems.length === 0) {
    section.style.display = "none";
    grid.innerHTML = "";
    if (moreBtn) moreBtn.style.display = "none";
    return;
  }

  section.style.display = "block";
  grid.innerHTML = "";
  // 首頁只先預覽大約兩排，其餘要按「查看更多」才會在下面完整商品清單顯示。
  giftItems
    .slice(0, GIFT_PREVIEW_COUNT)
    .forEach((item) => grid.appendChild(buildProductCard(item, { extraClass: "gift-card", isGift: true })));
  if (moreBtn) moreBtn.style.display = giftItems.length > GIFT_PREVIEW_COUNT ? "block" : "none";
}

// 同一件商品可能同時放在「一般購物車」跟「贈品購物車」，兩邊要合併看庫存，
// 不能各自加到滿，加起來卻超過庫存（結帳時就是這樣合併檢查的，這裡先在畫面上擋掉）。
function combinedCartQty(id) {
  return (CART[id] || 0) + (GIFT_CART[id] || 0);
}

function showCartLimitMsg(item) {
  const msgBox = document.getElementById("msgBox");
  if (msgBox) {
    msgBox.innerHTML = `<div class="msg error">「${item.name}」庫存只剩 ${item.stock} 件，不能再加入更多囉</div>`;
  }
}

function atStockLimit(id) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item || item.stock === undefined) return false;
  if (combinedCartQty(id) >= item.stock) {
    showCartLimitMsg(item);
    return true;
  }
  return false;
}

function addToCart(id) {
  if (atStockLimit(id)) return;
  CART[id] = (CART[id] || 0) + 1;
  saveCart();
  renderCart();
}

function changeQty(id, delta) {
  if (!CART[id]) return;
  if (delta > 0 && atStockLimit(id)) return;
  CART[id] += delta;
  if (CART[id] <= 0) delete CART[id];
  saveCart();
  renderCart();
}

function addGiftToCart(id) {
  if (atStockLimit(id)) return;
  GIFT_CART[id] = (GIFT_CART[id] || 0) + 1;
  saveGiftCart();
  renderCart();
}

function changeGiftQty(id, delta) {
  if (!GIFT_CART[id]) return;
  if (delta > 0 && atStockLimit(id)) return;
  GIFT_CART[id] += delta;
  if (GIFT_CART[id] <= 0) delete GIFT_CART[id];
  saveGiftCart();
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
  const giftIds = Object.keys(GIFT_CART);

  if (ids.length === 0 && giftIds.length === 0) {
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

  // 贈品是免費的，不會加進 total，畫面上也用「贈品」字樣跟「免費」跟一般購買的商品分開顯示
  giftIds.forEach((id) => {
    const item = ITEMS.find((i) => i.id === id);
    if (!item) return;

    const qty = GIFT_CART[id];
    const row = document.createElement("div");
    row.className = "cart-line cart-line-gift";
    row.innerHTML = `
      <span class="name">🎁 ${item.name}<span class="gift-tag">贈品</span></span>
      <div class="qty-ctrl">
        <button data-d="-1">−</button>
        <span>${qty}</span>
        <button data-d="1">＋</button>
      </div>
      <span class="gift-free">免費</span>
    `;
    row.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => changeGiftQty(id, parseInt(btn.dataset.d, 10));
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

  const cartEntries = Object.entries(CART); // 正常購買 [ [id, qty], ... ]
  const giftEntries = Object.entries(GIFT_CART); // 免費贈品 [ [id, qty], ... ]
  if (cartEntries.length === 0 && giftEntries.length === 0) return;
  if (cartEntries.length === 0 && giftEntries.length > 0) {
    msgBox.innerHTML = '<div class="msg error">贈品要搭配購買商品才能兌換，請先加入至少一件商品</div>';
    return;
  }

  document.getElementById("checkoutBtn").disabled = true;
  document.getElementById("checkoutBtn").textContent = "送出中...";

  try {
    const result = await runTransaction(db, async (tx) => {
      const allEntries = [
        ...cartEntries.map(([id, qty]) => ({ id, qty, isGift: false })),
        ...giftEntries.map(([id, qty]) => ({ id, qty, isGift: true })),
      ];

      // 同一件商品有可能同時被正常購買、又被選成贈品：庫存要合併算一次，不能分開各扣各的。
      const uniqueIds = [...new Set(allEntries.map((e) => e.id))];
      const uniqueSnaps = await Promise.all(uniqueIds.map((id) => tx.get(doc(db, "items", id))));
      const snapById = {};
      uniqueIds.forEach((id, i) => { snapById[id] = uniqueSnaps[i]; });

      const orderItems = [];
      const combinedQtyById = {};
      let total = 0;

      allEntries.forEach((entry) => {
        const snap = snapById[entry.id];
        if (!snap.exists() || snap.data().active === false) {
          throw new Error(`商品不存在或已下架`);
        }
        const item = snap.data();
        combinedQtyById[entry.id] = (combinedQtyById[entry.id] || 0) + entry.qty;
        if (item.stock !== undefined && combinedQtyById[entry.id] > item.stock) {
          throw new Error(`「${item.name}」庫存不足`);
        }
        const unitPrice = entry.isGift ? 0 : PAYMENT_METHOD === "糖果" ? item.priceCandy : item.priceCash;
        const lineTotal = unitPrice * entry.qty;
        total += lineTotal;
        orderItems.push({ id: entry.id, name: item.name, price: unitPrice, qty: entry.qty, image: item.image, isGift: entry.isGift });
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

      uniqueIds.forEach((id) => {
        const snap = snapById[id];
        const newStock = Math.max(0, (snap.data().stock || 0) - (combinedQtyById[id] || 0));
        tx.update(doc(db, "items", id), { stock: newStock });
      });

      return { id: orderRef.id, total, paymentMethod: PAYMENT_METHOD, items: orderItems };
    });

    CART = {};
    GIFT_CART = {};
    saveCart();
    saveGiftCart();
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
      const lineText = i.isGift ? "🎁 贈品" : paymentMethod === "糖果" ? `${i.price * i.qty} 糖果` : `NT$ ${i.price * i.qty}`;
      const thumbSrc = i.image ? corsProxyImage(i.image) : PLACEHOLDER_IMG;
      return `
        <div class="order-summary-item${i.isGift ? " order-summary-item-gift" : ""}">
          <img src="${thumbSrc}" data-original="${i.image || ""}" alt="${i.name}" class="order-summary-thumb" />
          <span class="order-summary-item-name">${i.name} x${i.qty}${i.isGift ? '<span class="gift-tag">贈品</span>' : ""}</span>
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
  CURRENT_PAGE = 1;
  renderGrid();
});

document.getElementById("checkoutBtn").addEventListener("click", checkout);
document.getElementById("seriesNewestBtn")?.addEventListener("click", () => setSeriesOrder("newest"));
document.getElementById("seriesOldestBtn")?.addEventListener("click", () => setSeriesOrder("oldest"));
document.getElementById("backToAllBtn")?.addEventListener("click", closeSpecialView);
document.getElementById("seriesBottomBackBtn")?.addEventListener("click", closeSpecialView);
document.getElementById("giftMoreBtn")?.addEventListener("click", openGiftView);
document.getElementById("backToTopBtn")?.addEventListener("click", () => window.scrollTo({top:0,behavior:"smooth"}));
Promise.all([loadItems(), loadSeries()]);
loadTaxonomy();
loadAnnouncement();
