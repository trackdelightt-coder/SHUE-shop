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

// 流量統計（Firebase Analytics）：買家逛網站這些行為會被記錄下來，
// 資料會出現在 Firebase 主控台的「Analytics」頁面（包含「即時」報表，可以看到現在有幾個人在線上）。
// 這裡刻意用「動態載入」+ try/catch 包起來，是因為有些瀏覽器（開隱私模式、裝了廣告阻擋套件像
// uBlock/Brave 等）本來就會主動擋掉 Analytics 相關的網路請求——如果直接在檔案最上面用一般的
// import 寫法，只要有人的瀏覽器擋掉這個請求，會導致「整個 shop.js 都讀取失敗」，變成買家看到
// 一片空白、什麼功能都不能用。改成這樣寫，就算有人擋掉 Analytics，也只是少了流量統計而已，
// 不會影響網站其他功能（商品列表、購物車、送出訂單）正常運作。
(async () => {
  try {
    const { getAnalytics, isSupported } = await import(
      "https://www.gstatic.com/firebasejs/12.17.1/firebase-analytics.js"
    );
    if (await isSupported()) getAnalytics(app);
  } catch (err) {
    // 載入失敗（被擋、離線等）就安靜跳過，不影響網站其他功能
  }
})();

// 圖片網址失效時（例如連結被刪除、圖床擋住）顯示的替代圖片，避免出現「???」破圖示
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
      '<rect width="100%" height="100%" fill="#1b2540"/>' +
      '<text x="50%" y="50%" fill="#aab4d4" font-size="22" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">圖片無法載入</text>' +
      "</svg>"
  );

// 商品圖片大多放在 Google 雲端硬碟、Firebase Storage 等外部圖床，這些圖床通常不允許「跨網站讀取
// 圖片內容」，所以平常瀏覽網頁時圖片看起來正常，但「截圖並複製」用的 html2canvas 工具想把圖片畫進
// 截圖時會被擋下來，變成截圖裡那張圖是一片黑（但網頁上看起來還是正常的，因為單純「顯示」圖片不需要
// 跨網站授權，只有「把圖片內容讀出來畫進另一張圖」才需要）。
// 對 Google 雲端硬碟這類我們管不到的外部圖床，用一個公開的免費圖片代理服務（images.weserv.nl）
// 幫忙轉一手，讓截圖工具能正常讀到圖片。但這個免費服務不一定每次都穩定（處理大檔案容易逾時、
// 有時候回應也沒有正確加上授權標頭），實測發現拿它來處理 Firebase Storage 的照片會不穩定。
// Firebase Storage 是我們自己的服務、自己可以設定，所以改成「直接跳過代理、直接讀取原始網址」，
// 只要後台有照 SETUP 文件把 Storage 的 CORS 設定好（一次性設定），這樣最穩定、也不用依賴第三方
// 免費服務。瀏覽器那邊的 <img> 標籤也要配合加上 crossorigin="anonymous" 屬性（在 showOrderSummary
// 那裡加的），這是這類跨網站截圖需求的標準做法。另外，手機直接拍的照片檔案通常很大（好幾 MB、
// 上千萬畫素），所以後台上傳照片時（js/admin.js 的 normalizeImageFile）會先在瀏覽器裡把照片縮小到
// 適合網頁瀏覽的大小，這樣買家看商品頁面時圖片也會載入更快。
function corsProxyImage(url) {
  if (!url) return url;
  if (url.startsWith("data:")) return url; // 本來就是內建的替代圖，不用轉
  // Firebase Storage 的照片是我們自己的服務，只要設定好 CORS，直接讀取原始網址最穩定，
  // 不用再繞經容易不穩定的第三方免費代理服務。
  if (url.includes("firebasestorage.googleapis.com") || url.includes(".firebasestorage.app")) {
    return url;
  }
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
  if (isOnSale(item)) {
    return paymentMethod === "糖果" ? Number(item.salePriceCandy) : Number(item.salePriceCash);
  }
  return paymentMethod === "糖果" ? item.priceCandy : item.priceCash;
}

// 商品原本（沒特價時）的價格，特價卡片上要拿來劃掉顯示用的。
function originalPriceFor(item, paymentMethod) {
  return paymentMethod === "糖果" ? item.priceCandy : item.priceCash;
}

// 特價區：後台幫商品填「特價金額」＋「特價開始/結束時間」，不用另外開關——
// 只要現在的時間有落在區間內，就自動算是特價中；時間到了（還沒開始，或已經過期）
// 就自動變回原價、自動從特價區消失，不用手動去改或關掉。
function isOnSale(item) {
  if (item.salePriceCandy === undefined || item.salePriceCandy === null || item.salePriceCandy === "") return false;
  if (item.salePriceCash === undefined || item.salePriceCash === null || item.salePriceCash === "") return false;
  const candy = Number(item.salePriceCandy);
  const cash = Number(item.salePriceCash);
  if (!Number.isFinite(candy) || !Number.isFinite(cash)) return false;
  if (!item.saleStart || !item.saleEnd) return false;
  const start = new Date(item.saleStart);
  const end = new Date(item.saleEnd);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return false;
  const now = new Date();
  return now >= start && now <= end;
}

// ---------- 顏色款式（同一件商品有好幾種顏色，各自有自己的照片、庫存） ----------
// 購物車原本是用「商品ID」當 key，有顏色款式的商品改用「商品ID::顏色」當 key，
// 沒有顏色款式的商品完全不受影響（color 是 null/undefined 時，key 就是原本的商品ID，
// 跟舊資料、舊的購物車紀錄完全相容）。
function cartKey(id, color) {
  return color ? `${id}::${color}` : id;
}
function parseCartKey(key) {
  const idx = key.indexOf("::");
  return idx === -1 ? { id: key, color: null } : { id: key.slice(0, idx), color: key.slice(idx + 2) };
}
function getVariant(item, color) {
  if (!color || !Array.isArray(item.colorVariants)) return null;
  return item.colorVariants.find((v) => v.color === color) || null;
}
// 這個商品「這個顏色」的庫存數字；沒有顏色款式的商品就是原本的 item.stock。
function stockFor(item, color) {
  const variant = getVariant(item, color);
  return variant ? Number(variant.stock) || 0 : item.stock;
}
// 這個商品「這個顏色」該顯示的照片；沒選顏色、或沒有顏色款式，就用商品本來的封面照。
function imageFor(item, color) {
  const variant = getVariant(item, color);
  return (variant && variant.image) || item.image;
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
    const saleSectionOnSeries = document.getElementById("saleSection");
    if (saleSectionOnSeries) saleSectionOnSeries.style.display = "none";
    const auctionSectionOnSeries = document.getElementById("auctionSection");
    if (auctionSectionOnSeries) auctionSectionOnSeries.style.display = "none";
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
  renderSaleSection();
  renderAuctionSection();
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
  const saleSectionOnGiftView = document.getElementById("saleSection");
  if (saleSectionOnGiftView) saleSectionOnGiftView.style.display = "none";
  const auctionSectionOnGiftView = document.getElementById("auctionSection");
  if (auctionSectionOnGiftView) auctionSectionOnGiftView.style.display = "none";
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
  renderSaleSection();
}

// 是否開啟「僅限女角」模式（後台設定）：開啟後前台只能選女角，男角按鈕會隱藏。
let GENDER_FEMALE_ONLY = false;
// 公告彈跳視窗目前的訊息內容（後台設定）：只在內容跟上次看過的不一樣時才會跳出來。
let POPUP_MESSAGE = "";

// 首圖標題／副標題沒有在後台填寫時使用的預設文字，跟 index.html 裡原本寫死的內容一致，
// 這樣後台欄位留空時，畫面還是會顯示這組預設文案，不會開天窗。
const HERO_TITLE_DEFAULT = "把你的角色小屋\n佈置得更有質感";
const HERO_SUB_DEFAULT = "精選 MSTAR 遊戲家具，糖果／現金彈性付款，下單即時同步庫存，讓每一次佈置都安心又划算。";
const HERO_TRUST_DEFAULT = ["🍬 糖果／💵 現金皆可付款", "📦 庫存即時更新，不怕買到已售完", "💬 Discord 一對一聯繫"];

// 首圖下面那排重點列（庫存即時更新／付款方式／Discord 聯繫...）：
// 用 createElement + textContent 一個一個組出來（不是塞 innerHTML 字串），
// 這樣後台填的文字就算不小心貼到奇怪符號也不會被當成 HTML 語法解析，比較安全。
function renderHeroTrustRow(items) {
  const box = document.getElementById("heroTrustRow");
  if (!box) return;
  box.innerHTML = "";
  const list = items.length ? items : HERO_TRUST_DEFAULT;
  list.forEach((text, i) => {
    if (i > 0) {
      const divider = document.createElement("span");
      divider.className = "hero-trust-divider";
      box.appendChild(divider);
    }
    const item = document.createElement("span");
    item.textContent = text;
    box.appendChild(item);
  });
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

    // 首圖標題／副標題：後台有填就用後台的內容（用 textContent 塞值，配合 CSS 的
    // white-space: pre-line 讓換行照樣生效，不會有 innerHTML 注入風險），沒填就用預設文案。
    const heroTitleEl = document.getElementById("heroTitle");
    const heroSubEl = document.getElementById("heroSub");
    if (heroTitleEl) heroTitleEl.textContent = (data.heroTitle && data.heroTitle.trim()) || HERO_TITLE_DEFAULT;
    if (heroSubEl) heroSubEl.textContent = (data.heroSub && data.heroSub.trim()) || HERO_SUB_DEFAULT;

    const heroTrustLines = (data.heroTrust || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    renderHeroTrustRow(heroTrustLines);

    GIFT_SECTION_ENABLED = data.giftSectionEnabled === true;
    renderGiftSection();

    GENDER_FEMALE_ONLY = data.genderFemaleOnly === true;
    applyGenderRestriction();

    POPUP_MESSAGE = data.popupMessage || "";
    maybeShowPopupAnnouncement(data.popupEnabled === true, POPUP_MESSAGE);
  } catch (err) {
    // 公告／贈品區設定載入失敗不影響下單流程，靜默略過
  }
}

// 僅限女角模式：隱藏男角按鈕、女角按鈕文字改成「限女角」，並強制把目前選擇改成女角。
function applyGenderRestriction() {
  const maleBtn = document.querySelector('#genderToggle .pay-btn[data-gender="男角"]');
  const femaleBtn = document.querySelector('#genderToggle .pay-btn[data-gender="女角"]');
  if (!maleBtn || !femaleBtn) return;

  if (GENDER_FEMALE_ONLY) {
    maleBtn.style.display = "none";
    femaleBtn.textContent = "🙍‍♀️ 限女角";
    if (CHARACTER_GENDER !== "女角") {
      CHARACTER_GENDER = "女角";
      saveGender();
    }
  } else {
    maleBtn.style.display = "";
    femaleBtn.textContent = "🙍‍♀️ 女角";
  }
  updateGenderToggleUI();
}

// 公告彈跳視窗：同一個人看過某一版訊息後就不會重複跳出，除非後台把訊息內容改掉。
function maybeShowPopupAnnouncement(enabled, message) {
  const overlay = document.getElementById("popupAnnouncementOverlay");
  if (!overlay) return;

  if (!enabled || !message || !message.trim()) {
    overlay.style.display = "none";
    return;
  }
  const lastSeen = localStorage.getItem("mstar_popup_seen") || "";
  if (lastSeen === message) {
    overlay.style.display = "none";
    return;
  }
  document.getElementById("popupAnnouncementText").textContent = message;
  overlay.style.display = "flex";
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
// 有顏色款式的商品，要看「選到的那個顏色」庫存夠不夠，不是看商品整體的庫存加總。
function isOutOfStock(item, color) {
  const stock = stockFor(item, color);
  return stock !== undefined && stock <= 0;
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 商品卡片（全部家具的格子、贈品專區都共用這份）。
// isGift 為 true 時（贈品專區）：卡片上顯示「🎁 贈品」而不是價格，按鈕是「加入贈品」，
// 加進去的東西會放進 GIFT_CART（跟平常購買的 CART 分開），結帳時這筆不算錢。
// 有顏色款式的商品，卡片上會多一排顏色選項，買家點了哪個顏色，圖片、庫存、能不能加入購物車
// 都會跟著換成那個顏色的資料；預設先選第一個顏色，不用逼買家一定要先點一下才能買。
function buildProductCard(item, { extraClass, isGift } = {}) {
  const card = document.createElement("div");
  card.className = extraClass ? `card ${extraClass}` : "card";

  const hasVariants = Array.isArray(item.colorVariants) && item.colorVariants.length > 0;
  // 預設要選「還有庫存的」第一個顏色，不要讓買家一打開商品就看到已經賣完的顏色；
  // 如果每個顏色都賣完了，才退回選款式列表裡的第一個（反正怎麼選都是已售完）。
  const firstInStockVariant = hasVariants
    ? item.colorVariants.find((v) => (Number(v.stock) || 0) > 0)
    : null;
  let selectedColor = hasVariants ? (firstInStockVariant || item.colorVariants[0]).color : null;
  const outOfStock = isOutOfStock(item, selectedColor);
  // 贈品專區的商品本來就免費，不套用特價（特價/劃線價對贈品沒有意義）。
  const onSale = !isGift && isOnSale(item);

  card.innerHTML = `
    <div class="card-img-wrap">
      <img src="${imageFor(item, selectedColor)}" alt="${escapeHtml(item.name)}" class="${outOfStock ? "img-soldout" : ""}" />
      ${item.isNew ? '<div class="ribbon-new">NEW</div>' : ""}
      ${onSale ? '<div class="ribbon-sale">特價</div>' : ""}
      <div class="stamp-soldout" style="${outOfStock ? "" : "display:none;"}">已售完</div>
    </div>
    <div class="body">
      <div class="cat">${item.category}</div>
      ${Array.isArray(item.tags) && item.tags.length ? `<div class="item-tags">${item.tags.map(t=>`<span>${t}</span>`).join("")}</div>` : ""}
      <h3>${item.name}</h3>
      <div class="desc">${item.description || ""}</div>
      ${
        hasVariants
          ? `<div class="color-swatches">${item.colorVariants
              .map((v) => {
                const colorOut = (Number(v.stock) || 0) <= 0;
                return `<button type="button" class="color-swatch${v.color === selectedColor ? " active" : ""}${colorOut ? " out" : ""}" data-color="${escapeHtml(v.color)}">${escapeHtml(v.color)}${colorOut ? "（已售完）" : ""}</button>`;
              })
              .join("")}</div>`
          : ""
      }
      <div class="price-row">
        <span class="price${isGift ? " gift-price" : ""}">${
          isGift
            ? "🎁 贈品（免費）"
            : onSale
              ? `<span class="price-sale-wrap"><span class="price-original">${formatPrice(PAYMENT_METHOD, originalPriceFor(item, PAYMENT_METHOD))}</span><span class="price-sale">${formatPrice(PAYMENT_METHOD, priceFor(item, PAYMENT_METHOD))}</span></span>`
              : formatPrice(PAYMENT_METHOD, priceFor(item, PAYMENT_METHOD))
        }</span>
        <span class="stock">${outOfStock ? "已售完" : "庫存 " + stockFor(item, selectedColor)}</span>
      </div>
      <button class="add-btn" ${outOfStock ? "disabled" : ""}>${isGift ? "加入贈品" : "加入購物車"}</button>
    </div>
  `;

  const imgEl = card.querySelector("img");
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = PLACEHOLDER_IMG;
  };
  // 點圖片放大看：如果後台有另外填「放大圖網址」（例如列表縮圖放的是示意圖，
  // 放大想秀出商品本人的實際照片），就優先顯示那張；沒填的話就跟以前一樣，
  // 顯示當下畫面上實際顯示的那張圖（所以商品有分顏色款式、買家換了顏色，
  // 放大看到的也會是那個顏色當下顯示的圖片，不會對不上）。
  imgEl.onclick = () => openImageLightbox((item.zoomImage && item.zoomImage.trim()) || imgEl.src, item.name);

  const addBtn = card.querySelector(".add-btn");
  const stockEl = card.querySelector(".stock");
  const soldoutStamp = card.querySelector(".stamp-soldout");

  function refreshForColor() {
    const nowOut = isOutOfStock(item, selectedColor);
    imgEl.src = imageFor(item, selectedColor);
    imgEl.classList.toggle("img-soldout", nowOut);
    if (soldoutStamp) soldoutStamp.style.display = nowOut ? "" : "none";
    if (stockEl) stockEl.textContent = nowOut ? "已售完" : "庫存 " + stockFor(item, selectedColor);
    addBtn.disabled = nowOut;
    card.querySelectorAll(".color-swatch").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.color === selectedColor);
    });
  }

  if (hasVariants) {
    card.querySelectorAll(".color-swatch").forEach((btn) => {
      btn.onclick = () => {
        selectedColor = btn.dataset.color;
        refreshForColor();
      };
    });
  }

  addBtn.onclick = () => (isGift ? addGiftToCart(item.id, selectedColor) : addToCart(item.id, selectedColor));
  return card;
}

// ---------- 特價區 ----------
// 不是手動開關，是看每件商品自己的「特價時間區間」（後台設定）：現在時間有落在區間內的
// 商品，就會自動出現在這裡（原價劃掉、特價變大字）；時間到了（還沒開始，或已經結束）
// 就會自動消失、恢復原價，不用手動維護。
function renderSaleSection() {
  const section = document.getElementById("saleSection");
  const grid = document.getElementById("saleGrid");
  if (!section || !grid) return;

  // 正在看系列頁或贈品「查看更多」全部列表時，跟贈品專區一樣先不要蓋回去。
  if (ACTIVE_SERIES_ID || ACTIVE_GIFT_VIEW) {
    section.style.display = "none";
    return;
  }

  const saleItems = ITEMS.filter((i) => isOnSale(i));
  if (saleItems.length === 0) {
    section.style.display = "none";
    grid.innerHTML = "";
    return;
  }
  section.style.display = "block";
  grid.innerHTML = "";
  saleItems.forEach((item) => grid.appendChild(buildProductCard(item, { extraClass: "sale-card" })));
}

// ---------- 競標商品 ----------
// 後台設定起標價、加價金額、結標時間，買家直接在頁面上點「出價」，
// 每次出價 = 目前價格 + 加價金額，並記錄目前得標人，時間到了就不能再出價
// （得標後不會自動結帳，妳要自己私訊 Discord 跟得標人收款、安排出貨）。
let AUCTIONS = [];

// 把 Firestore 讀回來的 endTime 轉成 JS Date，同時兼容三種可能的資料型態：
// 1) 真的 Firestore Timestamp（正式環境，有 .toDate() 方法）
// 2) 純 JS Date 物件（測試用的模擬資料庫）
// 3) 字串（保險起見，避免哪天資料格式跑掉整頁報錯）
function toDateSafe(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function auctionCountdownText(endDate) {
  if (!endDate) return "";
  const diffMs = endDate.getTime() - Date.now();
  if (diffMs <= 0) return "已結標";
  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `剩 ${days} 天 ${hours} 小時`;
  if (hours > 0) return `剩 ${hours} 小時 ${mins} 分`;
  if (mins > 0) return `剩 ${mins} 分 ${secs} 秒`;
  return `剩 ${secs} 秒`;
}

async function loadAuctions() {
  try {
    const snap = await getDocs(collection(db, "auctions"));
    AUCTIONS = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  } catch (err) {
    console.error("[Firestore] 讀取競標商品失敗:", err);
    AUCTIONS = [];
  }
  renderAuctionSection();
}

// 出價：用 transaction 確保「同時有兩個人搶著出價」時不會算錯——
// 每次都是重新讀一次資料庫目前的價格，新價格＝當下價格＋加價金額，
// 如果有人比你早一步送出，transaction 會自動重新算一次，不會出現兩個人都用同一個舊價格出價的情況。
async function placeBid(auctionId, bidderName, bidderContact) {
  return await runTransaction(db, async (tx) => {
    const auctionRef = doc(db, "auctions", auctionId);
    const snap = await tx.get(auctionRef);
    if (!snap.exists() || snap.data().active === false) {
      throw new Error("此競標商品已下架");
    }
    const auction = snap.data();
    const endDate = toDateSafe(auction.endTime);
    if (endDate && Date.now() >= endDate.getTime()) {
      throw new Error("競標已結束，無法再出價");
    }
    const currentPrice = Number(auction.currentPrice ?? auction.startingPrice) || 0;
    const increment = Number(auction.bidIncrement) || 0;
    const newPrice = currentPrice + increment;
    const newBidCount = (Number(auction.bidCount) || 0) + 1;

    tx.update(auctionRef, {
      currentPrice: newPrice,
      currentBidderName: bidderName,
      currentBidderContact: bidderContact || "",
      bidCount: newBidCount,
    });

    const bidRef = doc(collection(db, "auctionBids"));
    tx.set(bidRef, {
      auctionId,
      bidderName,
      bidderContact: bidderContact || "",
      amount: newPrice,
      createdAt: serverTimestamp(),
    });

    return { newPrice, bidCount: newBidCount };
  });
}

function buildAuctionCard(auction) {
  const card = document.createElement("div");
  card.className = "card auction-card";

  const endDate = toDateSafe(auction.endTime);
  const timeUp = !endDate || Date.now() >= endDate.getTime();
  const ended = timeUp || auction.active === false;
  const hasBid = Number(auction.bidCount) > 0;
  const currentPrice = Number(auction.currentPrice ?? auction.startingPrice) || 0;
  const nextPrice = currentPrice + (Number(auction.bidIncrement) || 0);
  const soonMs = endDate ? endDate.getTime() - Date.now() : Infinity;

  card.innerHTML = `
    <div class="card-img-wrap">
      <img src="${auction.image || PLACEHOLDER_IMG}" alt="${escapeHtml(auction.name || "")}" />
      <div class="ribbon-auction">競標</div>
    </div>
    <div class="body">
      <h3>${escapeHtml(auction.name || "")}</h3>
      ${auction.description ? `<div class="desc">${escapeHtml(auction.description)}</div>` : ""}
      <div class="auction-price-row">
        <span class="auction-current-label">${hasBid ? "目前價格" : "起標價"}</span>
        <span class="auction-current-price">${formatPrice(auction.paymentMethod, currentPrice)}</span>
      </div>
      <div class="auction-meta-row">
        <span class="auction-bidder">${hasBid ? `目前得標：${escapeHtml(auction.currentBidderName || "")}` : "尚無出價"}</span>
        ${!ended ? `<span class="auction-countdown${soonMs < 3600 * 1000 ? " ending-soon" : ""}" data-end="${endDate.toISOString()}">${auctionCountdownText(endDate)}</span>` : ""}
      </div>
      ${
        ended
          ? `<div class="auction-ended-badge">${auction.active === false ? "已下架" : "競標已結束"}${hasBid ? `　得標者：${escapeHtml(auction.currentBidderName || "")}` : ""}</div>`
          : `
            <input type="text" class="auction-name-input" placeholder="您的暱稱 / 遊戲ID" value="${escapeHtml(localStorage.getItem("mstar_bidder_name") || "")}" />
            <input type="text" class="auction-contact-input" placeholder="您的 Discord ID（選填，備用）" value="${escapeHtml(localStorage.getItem("mstar_bidder_contact") || "")}" />
            <button type="button" class="auction-bid-btn">出價 ${formatPrice(auction.paymentMethod, nextPrice)}</button>
            <div class="auction-msg"></div>
          `
      }
    </div>
  `;

  const imgEl = card.querySelector("img");
  imgEl.onerror = () => { imgEl.onerror = null; imgEl.src = PLACEHOLDER_IMG; };
  imgEl.onclick = () => openImageLightbox(imgEl.src, auction.name);

  if (!ended) {
    const bidBtn = card.querySelector(".auction-bid-btn");
    const nameInput = card.querySelector(".auction-name-input");
    const contactInput = card.querySelector(".auction-contact-input");
    const msgEl = card.querySelector(".auction-msg");
    const bidBtnDefaultText = bidBtn.textContent;
    bidBtn.onclick = async () => {
      const bidderName = nameInput.value.trim();
      const bidderContact = contactInput.value.trim();
      if (!bidderName) {
        msgEl.textContent = "請先填寫您的暱稱 / 遊戲ID";
        msgEl.className = "auction-msg error";
        return;
      }
      bidBtn.disabled = true;
      bidBtn.textContent = "出價中...";
      try {
        await placeBid(auction.id, bidderName, bidderContact);
        localStorage.setItem("mstar_bidder_name", bidderName);
        localStorage.setItem("mstar_bidder_contact", bidderContact);
        msgEl.textContent = "🎉 出價成功！目前您是最高出價者";
        msgEl.className = "auction-msg success";
        await loadAuctions();
      } catch (err) {
        msgEl.textContent = "出價失敗：" + (err && err.message ? err.message : err);
        msgEl.className = "auction-msg error";
        bidBtn.disabled = false;
        bidBtn.textContent = bidBtnDefaultText;
      }
    };
  }

  return card;
}

// 只更新畫面上「剩 X 分 X 秒」的文字，不整個重畫卡片——
// 不然買家正在輸入暱稱/聯絡方式打到一半，每秒都被清空重畫就太干擾了。
function updateAuctionCountdowns() {
  let anyEnded = false;
  document.querySelectorAll("#auctionGrid .auction-countdown").forEach((el) => {
    const iso = el.dataset.end;
    if (!iso) return;
    const endDate = new Date(iso);
    if (Date.now() >= endDate.getTime()) {
      anyEnded = true;
      return;
    }
    el.textContent = auctionCountdownText(endDate);
    el.classList.toggle("ending-soon", endDate.getTime() - Date.now() < 3600 * 1000);
  });
  // 有競標剛好倒數到 0，重新讀一次資料庫，把卡片換成「已結標」狀態、關閉出價按鈕。
  if (anyEnded) loadAuctions();
}

function renderAuctionSection() {
  const section = document.getElementById("auctionSection");
  const grid = document.getElementById("auctionGrid");
  if (!section || !grid) return;

  // 跟特價區、贈品專區一樣：正在看系列頁或贈品「查看更多」全部列表時先不要蓋回去。
  if (ACTIVE_SERIES_ID || ACTIVE_GIFT_VIEW) {
    section.style.display = "none";
    return;
  }

  const visibleAuctions = AUCTIONS.filter((a) => a.active !== false);
  if (visibleAuctions.length === 0) {
    section.style.display = "none";
    grid.innerHTML = "";
    return;
  }
  section.style.display = "block";
  grid.innerHTML = "";
  visibleAuctions.forEach((auction) => grid.appendChild(buildAuctionCard(auction)));
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

// 同一件商品（同一個顏色）可能同時放在「一般購物車」跟「贈品購物車」，兩邊要合併看庫存，
// 不能各自加到滿，加起來卻超過庫存（結帳時就是這樣合併檢查的，這裡先在畫面上擋掉）。
// 有顏色款式時，是分開算每個顏色自己的庫存，不是看商品整體。
function combinedCartQty(id, color) {
  const key = cartKey(id, color);
  return (CART[key] || 0) + (GIFT_CART[key] || 0);
}

function showCartLimitMsg(item, color, stock) {
  const msgBox = document.getElementById("msgBox");
  if (msgBox) {
    msgBox.innerHTML = `<div class="msg error">「${item.name}${color ? `（${color}）` : ""}」庫存只剩 ${stock} 件，不能再加入更多囉</div>`;
  }
}

function atStockLimit(id, color) {
  const item = ITEMS.find((i) => i.id === id);
  if (!item) return false;
  const stock = stockFor(item, color);
  if (stock === undefined) return false;
  if (combinedCartQty(id, color) >= stock) {
    showCartLimitMsg(item, color, stock);
    return true;
  }
  return false;
}

function addToCart(id, color) {
  if (atStockLimit(id, color)) return;
  const key = cartKey(id, color);
  CART[key] = (CART[key] || 0) + 1;
  saveCart();
  renderCart();
}

function changeQty(id, delta, color) {
  const key = cartKey(id, color);
  if (!CART[key]) return;
  if (delta > 0 && atStockLimit(id, color)) return;
  CART[key] += delta;
  if (CART[key] <= 0) delete CART[key];
  saveCart();
  renderCart();
}

function addGiftToCart(id, color) {
  if (atStockLimit(id, color)) return;
  const key = cartKey(id, color);
  GIFT_CART[key] = (GIFT_CART[key] || 0) + 1;
  saveGiftCart();
  renderCart();
}

function changeGiftQty(id, delta, color) {
  const key = cartKey(id, color);
  if (!GIFT_CART[key]) return;
  if (delta > 0 && atStockLimit(id, color)) return;
  GIFT_CART[key] += delta;
  if (GIFT_CART[key] <= 0) delete GIFT_CART[key];
  saveGiftCart();
  renderCart();
}

function setPaymentMethod(method) {
  if (method === PAYMENT_METHOD) return;
  // 切換付款方式不清空購物車：商品維持原本的品項跟數量，
  // 價格會自動改用新付款方式對應的金額重新計算（priceFor 每次都是即時查price Candy/Cash，不需要額外處理）。
  PAYMENT_METHOD = method;
  savePayMethod();
  updatePayToggleUI();
  renderGrid();
  renderCart();
  renderSaleSection();
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
  ids.forEach((key) => {
    const { id, color } = parseCartKey(key);
    const item = ITEMS.find((i) => i.id === id);
    if (!item) return;

    const qty = CART[key];
    const unitPrice = priceFor(item, PAYMENT_METHOD);
    const lineTotal = unitPrice * qty;
    total += lineTotal;

    const row = document.createElement("div");
    row.className = "cart-line";
    row.innerHTML = `
      <img class="cart-thumb" src="${imageFor(item, color)}" alt="${escapeHtml(item.name)}" />
      <span class="name">${item.name}${color ? `<span class="cart-line-color">（${color}）</span>` : ""}</span>
      <div class="qty-ctrl">
        <button data-d="-1">−</button>
        <span>${qty}</span>
        <button data-d="1">＋</button>
      </div>
      <span>${PAYMENT_METHOD === "糖果" ? lineTotal : "NT$" + lineTotal}</span>
    `;
    const thumbEl = row.querySelector(".cart-thumb");
    thumbEl.onerror = () => { thumbEl.onerror = null; thumbEl.src = PLACEHOLDER_IMG; };
    row.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => changeQty(id, parseInt(btn.dataset.d, 10), color);
    });
    linesEl.appendChild(row);
  });

  // 贈品是免費的，不會加進 total，畫面上也用「贈品」字樣跟「免費」跟一般購買的商品分開顯示
  giftIds.forEach((key) => {
    const { id, color } = parseCartKey(key);
    const item = ITEMS.find((i) => i.id === id);
    if (!item) return;

    const qty = GIFT_CART[key];
    const row = document.createElement("div");
    row.className = "cart-line cart-line-gift";
    row.innerHTML = `
      <img class="cart-thumb" src="${imageFor(item, color)}" alt="${escapeHtml(item.name)}" />
      <span class="name">🎁 ${item.name}${color ? `<span class="cart-line-color">（${color}）</span>` : ""}<span class="gift-tag">贈品</span></span>
      <div class="qty-ctrl">
        <button data-d="-1">−</button>
        <span>${qty}</span>
        <button data-d="1">＋</button>
      </div>
      <span class="gift-free">免費</span>
    `;
    const thumbEl = row.querySelector(".cart-thumb");
    thumbEl.onerror = () => { thumbEl.onerror = null; thumbEl.src = PLACEHOLDER_IMG; };
    row.querySelectorAll("button").forEach((btn) => {
      btn.onclick = () => changeGiftQty(id, parseInt(btn.dataset.d, 10), color);
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

  const cartEntries = Object.entries(CART); // 正常購買 [ [cartKey, qty], ... ]　cartKey 可能是純 id，也可能是「id::顏色」
  const giftEntries = Object.entries(GIFT_CART); // 免費贈品 [ [cartKey, qty], ... ]
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
        ...cartEntries.map(([key, qty]) => ({ key, ...parseCartKey(key), qty, isGift: false })),
        ...giftEntries.map(([key, qty]) => ({ key, ...parseCartKey(key), qty, isGift: true })),
      ];

      // 同一件商品（不分顏色）有可能同時被正常購買、又被選成贈品，但只需要照 id 讀一次商品資料就好。
      const uniqueIds = [...new Set(allEntries.map((e) => e.id))];
      const uniqueSnaps = await Promise.all(uniqueIds.map((id) => tx.get(doc(db, "items", id))));
      const snapById = {};
      uniqueIds.forEach((id, i) => { snapById[id] = uniqueSnaps[i]; });

      const orderItems = [];
      // 庫存要用「商品＋顏色」合併算一次（用 cartKey 當 key），不能分開各扣各的：
      // 同一顏色如果同時出現在購物車跟贈品區，要合併檢查同一顏色的庫存上限。
      // 沒有顏色款式的商品，cartKey 就等於純 id，所以這一套邏輯跟原本沒有顏色款式的商品完全相容。
      const combinedQtyByKey = {};
      let total = 0;

      allEntries.forEach((entry) => {
        const snap = snapById[entry.id];
        if (!snap.exists() || snap.data().active === false) {
          throw new Error(`商品不存在或已下架`);
        }
        const item = snap.data();
        if (entry.color && !getVariant(item, entry.color)) {
          throw new Error(`「${item.name}」的顏色款式已異動，請重新整理頁面後再試一次`);
        }
        combinedQtyByKey[entry.key] = (combinedQtyByKey[entry.key] || 0) + entry.qty;
        const availableStock = stockFor(item, entry.color);
        if (availableStock !== undefined && combinedQtyByKey[entry.key] > availableStock) {
          throw new Error(`「${item.name}${entry.color ? `（${entry.color}）` : ""}」庫存不足`);
        }
        const unitPrice = entry.isGift ? 0 : PAYMENT_METHOD === "糖果" ? item.priceCandy : item.priceCash;
        const lineTotal = unitPrice * entry.qty;
        total += lineTotal;
        orderItems.push({
          id: entry.id,
          name: item.name,
          color: entry.color || null,
          price: unitPrice,
          qty: entry.qty,
          image: imageFor(item, entry.color),
          isGift: entry.isGift,
        });
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

      // 同一件商品可能同時扣好幾個顏色的庫存，但 Firestore transaction 對同一份文件多次 tx.update()
      // 只有最後一次會生效（不會自動合併），所以這裡把每個商品要扣的所有顏色都先合併算好，
      // 每個商品最後只呼叫一次 tx.update()。
      uniqueIds.forEach((id) => {
        const snap = snapById[id];
        const item = snap.data();
        if (Array.isArray(item.colorVariants) && item.colorVariants.length > 0) {
          const updatedVariants = item.colorVariants.map((v) => {
            const qtyBought = combinedQtyByKey[cartKey(id, v.color)] || 0;
            return { ...v, stock: Math.max(0, (Number(v.stock) || 0) - qtyBought) };
          });
          // 上面的「庫存」欄位永遠自動等於所有顏色庫存加總，維持跟舊資料/後台顯示一致。
          const newTotalStock = updatedVariants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
          tx.update(doc(db, "items", id), { colorVariants: updatedVariants, stock: newTotalStock });
        } else {
          const qtyBought = combinedQtyByKey[id] || 0;
          const newStock = Math.max(0, (item.stock || 0) - qtyBought);
          tx.update(doc(db, "items", id), { stock: newStock });
        }
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
          <img src="${thumbSrc}" data-original="${i.image || ""}" alt="${i.name}" class="order-summary-thumb" crossorigin="anonymous" />
          <span class="order-summary-item-name">${i.name}${i.color ? `（${i.color}）` : ""} x${i.qty}${i.isGift ? '<span class="gift-tag">贈品</span>' : ""}</span>
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
        if (!original) {
          img.onerror = null;
          img.src = PLACEHOLDER_IMG;
          return;
        }
        // 第一層失敗可能是代理服務掛了，也可能是 Firebase Storage 還沒設定好 CORS，
        // 瀏覽器直接拒絕載入帶 crossorigin 屬性的圖片請求（這種情況比代理失敗更嚴重，
        // 因為原本代理失敗至少畫面上看得到照片，這種是直接整張空白）。
        // 不管是哪一種，都先拿掉 crossorigin 屬性、強制重新載入原始網址一次，
        // 這樣畫面上至少一定看得到照片（只是拿掉 crossorigin 之後這張圖就沒辦法被
        // 「截圖並複製」讀取像素了，截圖時那張照片的位置可能還是會空白，
        // 要等 Firebase Storage 那邊設定好 CORS 之後兩個才會都正常）。
        if (img.hasAttribute("crossorigin")) {
          img.removeAttribute("crossorigin");
          img.onerror = () => {
            img.onerror = null;
            img.src = PLACEHOLDER_IMG;
          };
          // 強制重新載入：就算網址字串跟現在一樣，拿掉 crossorigin 屬性後也要真的
          // 重新發一次請求（不是瀏覽器誤判「網址沒變就不用重載」）。
          img.src = "";
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
  captureBtn.textContent = "處理中...";
  captureMsg.textContent = "";

  // 手機瀏覽器（尤其是 iPhone 的 Safari）對「自動複製圖片到剪貼簿」的支援很不穩定，
  // 常常會直接失敗，退回去下載檔案——買家還要自己去下載清單裡找那個檔案再傳出去，很麻煩，
  // 而且下載完之後剪貼簿裡根本沒有東西，難怪會貼不出來。
  // 所以這裡改成三個順位都試過一輪，盡量讓買家不用自己想辦法：
  // 1) 複製到剪貼簿（電腦版 Discord/LINE 桌面版可以直接 Ctrl+V，最快）
  // 2) 手機的原生分享清單（可以直接點 LINE 或 Discord 圖示把圖片傳出去，不用「貼上」這個動作）
  // 3) 都不支援的話，才退回下載圖片，請買家自己傳給賣家
  try {
    const canvas = await html2canvas(target, { backgroundColor: "#101a33", scale: 2, useCORS: true });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("轉檔失敗");

    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        captureMsg.textContent = "✅ 已複製到剪貼簿！到 Discord 訊息框按 Ctrl+V（Mac 是 Cmd+V）貼上就可以了。";
        return;
      } catch (clipboardErr) {
        // 複製失敗（手機瀏覽器常見），往下改試「原生分享」
      }
    }

    const file = new File([blob], "訂單截圖.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "訂單截圖" });
        captureMsg.textContent = "✅ 已開啟分享，選 LINE 或 Discord 傳給賣家就可以了。";
        return;
      } catch (shareErr) {
        if (shareErr && shareErr.name === "AbortError") {
          // 買家自己在分享清單裡按了取消，不是真的錯誤，不用顯示失敗訊息
          return;
        }
        // 分享也失敗的話，繼續往下改成下載圖片
      }
    }

    const dataUrl = canvas.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = "訂單截圖.png";
    link.click();
    captureMsg.textContent = "此瀏覽器不支援自動複製或分享，已改成直接下載圖片，下載完後在「檔案」App 或下載清單裡找到「訂單截圖.png」，再傳給賣家即可。";
  } catch (err) {
    captureMsg.textContent = "截圖失敗，請直接手動截圖這個畫面。";
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
document.getElementById("popupAnnouncementClose")?.addEventListener("click", () => {
  localStorage.setItem("mstar_popup_seen", POPUP_MESSAGE);
  const overlay = document.getElementById("popupAnnouncementOverlay");
  if (overlay) overlay.style.display = "none";
});

// 商品圖片點擊放大看的小燈箱：不管是全部家具的格子還是贈品專區，圖片都共用這一個放大視窗。
function openImageLightbox(src, alt) {
  const overlay = document.getElementById("imageLightboxOverlay");
  const img = document.getElementById("imageLightboxImg");
  if (!overlay || !img) return;
  img.src = src;
  img.alt = alt || "";
  overlay.style.display = "flex";
}
function closeImageLightbox() {
  const overlay = document.getElementById("imageLightboxOverlay");
  if (overlay) overlay.style.display = "none";
}
document.getElementById("imageLightboxClose")?.addEventListener("click", closeImageLightbox);
document.getElementById("imageLightboxOverlay")?.addEventListener("click", (e) => {
  // 點背景（不是點圖片本身）就關閉，方便買家隨手點一下退出
  if (e.target.id === "imageLightboxOverlay") closeImageLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeImageLightbox();
});
document.getElementById("backToTopBtn")?.addEventListener("click", () => window.scrollTo({top:0,behavior:"smooth"}));
Promise.all([loadItems(), loadSeries(), loadAuctions()]);
loadTaxonomy();
// 每 30 秒重新讀一次競標資料（讓「目前價格／得標人」跟其他人同步），
// 每秒重畫一次倒數計時文字（不用重新打資料庫，只是純粹更新畫面上的「剩 X 分 X 秒」文字）。
setInterval(loadAuctions, 30000);
setInterval(updateAuctionCountdowns, 1000);
// 先同步畫一次預設的首圖重點列，這樣就算等一下讀取後台設定失敗（例如網路問題），
// 畫面也不會開天窗變成空白一排，一定至少看得到預設內容。
renderHeroTrustRow([]);
loadAnnouncement();
