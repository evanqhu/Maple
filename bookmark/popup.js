import Fuse from "./lib/fuse.js";
import { debounce } from "./utils/debounce.js";
import { keyText, BestMatchTitle, BestMatch, EmptyBookmarkMessage } from "./utils/i18n.js";
import { Notification } from "./utils/notification.js";
import { createElement } from "./utils/element.js";
import { getFavicon, markDarkFavicon } from "./utils/favicon.js";
import { parseShortcut, matchesShortcut } from "./utils/shortcut.js";
import {
  DEDUPE_SETTING_KEY,
  isDedupeEnabled,
  hasTabsPermission,
  requestTabsPermission,
  removeTabsPermission,
} from "./utils/tab-dedupe.js";

// 设置相关常量
const SETTINGS_KEYS = {
  SEARCH_ENABLED: "MAPLE_SEARCH_ENABLED",
  TIPS_ENABLED: "MAPLE_TIPS_ENABLED",
  OPEN_IN_NEW_TAB: "MAPLE_OPEN_IN_NEW_TAB",
  KEEP_PANEL_OPEN: "MAPLE_KEEP_PANEL_OPEN",
};

const HAS_SEEN_SETTINGS_HINT_KEY = "MAPLE_SETTINGS_HINT_SEEN";
const TOP_LEVEL_ORDER_KEY = "MAPLE_TOP_LEVEL_ORDER";

// 获取搜索功能开启状态
function isSearchEnabled() {
  return localStorage.getItem(SETTINGS_KEYS.SEARCH_ENABLED) !== "false";
}

// 获取 tips 功能开启状态
function isTipsEnabled() {
  return localStorage.getItem(SETTINGS_KEYS.TIPS_ENABLED) === "true";
}

// 获取是否在新标签页打开
function isOpenInNewTabEnabled() {
  return localStorage.getItem(SETTINGS_KEYS.OPEN_IN_NEW_TAB) !== "false";
}

// 获取点击书签后是否保持面板打开
function isKeepPanelOpenEnabled() {
  return localStorage.getItem(SETTINGS_KEYS.KEEP_PANEL_OPEN) === "true";
}

function createTab(url, active = true) {
  if (typeof browser !== "undefined") {
    browser.tabs.create({ url, active });
  } else {
    chrome.tabs.create({ url, active });
  }
}

function updateCurrentTab(url) {
  if (typeof browser !== "undefined") {
    browser.tabs.update({ url });
  } else {
    chrome.tabs.update({ url });
  }
}

const CLASS_NAMES = {
  bookmark: "bookmark",
  favicon: "favicon",
  folder: "folder",
  childContainer: "childContainer",
  Notification: "Notification",
  folderTitle: "folderTitle",
};

let searchInput = document.getElementById("searchInput");
let settingsBtn = document.getElementById("settingsBtn");
let settingsWrapper = document.querySelector(".settings-wrapper");
let collapseAllBtn = document.getElementById("collapseAllBtn");
let expandAllBtn = document.getElementById("expandAllBtn");

let activeBestMatchIndex = 0;
let hideTimeout = null;

let bestMatches = [];
localStorage.removeItem("persistedHeader");

const isZhUI = navigator.language.startsWith("zh");

function setAllFoldersExpanded(expanded) {
  document.querySelectorAll("#bookmarks .folderTitle.collapsible-folder").forEach((folderTitle) => {
    const childContainer = folderTitle.parentElement?.querySelector(":scope > .childContainer");
    if (!childContainer) return;

    childContainer.style.display = expanded ? "block" : "none";
    folderTitle.classList.toggle("expanded", expanded);
    folderTitle.classList.toggle("collapsed", !expanded);
    folderTitle.setAttribute("aria-expanded", expanded.toString());

    const folderStateKey = folderTitle.dataset.folderStateKey;
    if (folderStateKey) {
      localStorage.setItem(folderStateKey, expanded ? "expanded" : "collapsed");
    }
  });
}

if (collapseAllBtn) {
  const label = isZhUI ? "折叠所有目录" : "Collapse all folders";
  collapseAllBtn.title = label;
  collapseAllBtn.setAttribute("aria-label", label);
  collapseAllBtn.addEventListener("click", () => setAllFoldersExpanded(false));
}

if (expandAllBtn) {
  const label = isZhUI ? "展开所有目录" : "Expand all folders";
  expandAllBtn.title = label;
  expandAllBtn.setAttribute("aria-label", label);
  expandAllBtn.addEventListener("click", () => setAllFoldersExpanded(true));
}

// Settings overlay: popup içinde ayarlar paneli
const SETTINGS_OVERLAY = {
  el: null,
  init() {
    this.el = document.getElementById("settings-overlay");
    if (!this.el) return;

    // i18n metinler
    const i18n = isZhUI
      ? {
          title: "设置",
          back: "返回",
          "search-title": "搜索",
          "search-desc": "显示搜索框以快速查找书签。",
          "tips-title": "悬停提示",
          "tips-desc": "鼠标悬停时显示完整书签标题。",
          "newtab-title": "新标签页打开",
          "newtab-desc": "在新标签页打开书签，关闭则在当前标签页。",
          "keep-title": "保持面板",
          "keep-desc": "在后台标签页打开，让面板保持可见。",
          "dedupe-title": "合并重复标签页",
          "dedupe-desc": "打开已经开着的网页时直接切过去，已有的重复标签页也会自动关掉，只认网址完全相同的，固定和分组里的不动，开启时需授权读取标签页。",
        }
      : {
          title: "Settings",
          back: "Back",
          "search-title": "Search",
          "search-desc": "Show search box to quickly find bookmarks.",
          "tips-title": "Hover Tooltips",
          "tips-desc": "Show full bookmark titles on hover.",
          "newtab-title": "Open in New Tab",
          "newtab-desc": "Open bookmarks in a new tab vs the current one.",
          "keep-title": "Keep Panel Open",
          "keep-desc": "Open in background tabs to keep the panel visible.",
          "dedupe-title": "Merge Duplicate Tabs",
          "dedupe-desc":
            "Opening a page that is already open switches to that tab instead of adding another, and existing duplicates close automatically. Only exact URL matches count, and pinned or grouped tabs are left alone. Asks to read your tabs when turned on.",
        };
    const titleEl = document.getElementById("settingsOverlayTitle");
    if (titleEl) titleEl.textContent = i18n.title;
    const backEl = document.getElementById("settingsOverlayBack");
    if (backEl) backEl.textContent = i18n.back;
    this.el.querySelectorAll("[data-setting-key]").forEach((node) => {
      const key = node.getAttribute("data-setting-key");
      if (i18n[key]) node.textContent = i18n[key];
    });

    if (backEl) backEl.addEventListener("click", () => this.close());

    const search = document.getElementById("overlaySearchEnabled");
    const tips = document.getElementById("overlayTipsEnabled");
    const newtab = document.getElementById("overlayOpenInNewTab");
    const keep = document.getElementById("overlayKeepPanelOpen");
    const dedupe = document.getElementById("overlayDedupeTabs");

    if (search) {
      search.addEventListener("change", () => {
        localStorage.setItem(SETTINGS_KEYS.SEARCH_ENABLED, search.checked.toString());
        location.reload();
      });
    }
    if (tips) {
      tips.addEventListener("change", () => {
        localStorage.setItem(SETTINGS_KEYS.TIPS_ENABLED, tips.checked.toString());
      });
    }
    if (newtab) {
      newtab.addEventListener("change", () => {
        localStorage.setItem(SETTINGS_KEYS.OPEN_IN_NEW_TAB, newtab.checked.toString());
      });
    }
    if (keep) {
      keep.addEventListener("change", () => {
        localStorage.setItem(SETTINGS_KEYS.KEEP_PANEL_OPEN, keep.checked.toString());
      });
    }

    if (dedupe) {
      dedupe.addEventListener("change", () => {
        if (dedupe.checked) {
          // 先记下意图再请求授权：授权框可能让弹窗关闭，下次打开时以实际授权为准
          localStorage.setItem(DEDUPE_SETTING_KEY, "true");
          requestTabsPermission().then((granted) => {
            dedupe.checked = granted;
            localStorage.setItem(DEDUPE_SETTING_KEY, granted.toString());
          });
        } else {
          localStorage.setItem(DEDUPE_SETTING_KEY, "false");
          removeTabsPermission();
        }
      });
    }

    // 按 Escape 关闭设置
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.el && !this.el.hidden && this.el.classList.contains("open")) {
        e.preventDefault();
        this.close();
      }
    });
  },
  open() {
    if (!this.el) return;
    // Mevcut değerleri yükle
    const search = document.getElementById("overlaySearchEnabled");
    const tips = document.getElementById("overlayTipsEnabled");
    const newtab = document.getElementById("overlayOpenInNewTab");
    const keep = document.getElementById("overlayKeepPanelOpen");
    const dedupe = document.getElementById("overlayDedupeTabs");

    if (dedupe) {
      dedupe.checked = false;
      if (isDedupeEnabled()) {
        hasTabsPermission().then((granted) => {
          dedupe.checked = granted;
        });
      }
    }
    if (search) search.checked = localStorage.getItem(SETTINGS_KEYS.SEARCH_ENABLED) !== "false";
    if (tips) tips.checked = localStorage.getItem(SETTINGS_KEYS.TIPS_ENABLED) === "true";
    if (newtab) newtab.checked = localStorage.getItem(SETTINGS_KEYS.OPEN_IN_NEW_TAB) !== "false";
    if (keep) keep.checked = localStorage.getItem(SETTINGS_KEYS.KEEP_PANEL_OPEN) === "true";

    this.el.hidden = false;
    requestAnimationFrame(() => {
      if (this.el) this.el.classList.add("open");
    });
  },
  close() {
    if (!this.el) return;
    this.el.classList.remove("open");
    setTimeout(() => {
      if (this.el && !this.el.classList.contains("open")) this.el.hidden = true;
    }, 280);
  },
};
SETTINGS_OVERLAY.init();

// Settings butonu artık ayrı bir sayfa açmıyor — overlay'i açıyor
if (settingsBtn) {
  settingsBtn.title = isZhUI ? "设置" : "Settings";
  settingsBtn.setAttribute("aria-label", settingsBtn.title);

  settingsBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    SETTINGS_OVERLAY.open();
  });
} else {
  console.error("Settings button not found");
}

if (settingsWrapper && localStorage.getItem(HAS_SEEN_SETTINGS_HINT_KEY) !== "true") {
  // 首次打开时标出设置入口
  settingsWrapper.classList.add("show-once");
  localStorage.setItem(HAS_SEEN_SETTINGS_HINT_KEY, "true");
  setTimeout(() => {
    settingsWrapper.classList.remove("show-once");
  }, 1800);
}

function showLoadingState() {
  const bookmarksContainer = document.getElementById("bookmarks");
  if (!bookmarksContainer) {
    return;
  }
  if (bookmarksContainer.children.length > 0) {
    return;
  }
  const loadingState = createElement("div", "loading-state", "");
  loadingState.dataset.loading = "true";
  loadingState.setAttribute("aria-label", navigator.language.startsWith("zh") ? "书签加载中" : "Loading bookmarks");

  const loadingTitle = createElement("div", "loading-title", "");
  const loadingGrid = createElement("div", "loading-grid", "");

  for (let i = 0; i < 9; i++) {
    loadingGrid.appendChild(createElement("div", "loading-card", ""));
  }

  loadingState.appendChild(loadingTitle);
  loadingState.appendChild(loadingGrid);
  bookmarksContainer.appendChild(loadingState);
}

// Bookmark / Fuse cache: search input'unun her keystroke'unda yeniden inşa etmemek için
const FUSE_OPTIONS = {
  keys: ["title", "url"],
  ignoreLocation: false,
  includeScore: true,
  threshold: 0.5,
  shouldSort: true,
};
let _bookmarkCache = null;
let _fuseInstance = null;

function invalidateBookmarkCache() {
  _bookmarkCache = null;
  _fuseInstance = null;
}

function getBookmarkCache() {
  if (_bookmarkCache) return _bookmarkCache;
  // Sadece #bookmarks ağacını cache'le; #best-match (search sonuçları) hariç
  const root = document.getElementById("bookmarks");
  if (!root) {
    _bookmarkCache = { folders: [], items: [] };
    return _bookmarkCache;
  }
  const folderEls = Array.from(root.getElementsByClassName(CLASS_NAMES.folder));
  const items = [];
  for (const el of root.getElementsByClassName(CLASS_NAMES.bookmark)) {
    // Ata folder zincirini önceden hesapla (closest-first)
    const ancestors = [];
    let p = el.parentElement;
    while (p && p !== root) {
      if (p.classList?.contains(CLASS_NAMES.folder)) ancestors.push(p);
      p = p.parentElement;
    }
    const title = el.textContent;
    const url = el.href;
    items.push({
      el,
      ancestors,
      title,
      titleLower: title.toLowerCase(),
      url,
      urlLower: url.toLowerCase(),
      favicon: el.querySelector(".favicon")?.src,
    });
  }
  _bookmarkCache = { folders: folderEls, items };
  return _bookmarkCache;
}

function getFuseInstance() {
  if (_fuseInstance) return _fuseInstance;
  const { items } = getBookmarkCache();
  _fuseInstance = new Fuse(items, FUSE_OPTIONS);
  return _fuseInstance;
}

/**
 * @description 快速切换默认选中的最佳结果
 * @param index {number} 要选中的索引
 */
function updateActiveBestMatch(index) {
  const bestMatch = Array.from(document.querySelectorAll("#best-match .bookmark"));
  if (bestMatch.length === 0) {
    return;
  }
  bestMatch.forEach((item) => item.classList.remove("active"));
  // 循环切换
  activeBestMatchIndex = index % bestMatch.length < 0 ? bestMatch.length - 1 : index % bestMatch.length;
  bestMatch[activeBestMatchIndex].classList.add("active");
}

/**
 * 获取当前选中的最佳匹配项
 * @returns {HTMLElement} 当前选中的最佳匹配项
 */
function getActiveBestMatch() {
  const bestMatch = Array.from(document.querySelectorAll("#best-match .bookmark"));
  return bestMatch[activeBestMatchIndex];
}

function showBestMatchTips() {
  if (!isTipsEnabled()) {
    return;
  }
  const curBestMathEle = getActiveBestMatch();
  if (!curBestMathEle || !bestMatches[activeBestMatchIndex]) {
    return;
  }
  const tipsCon = curBestMathEle.querySelector("p");
  if (tipsCon && checkOverflow(tipsCon)) {
    Notification.show(bestMatches[activeBestMatchIndex].title, 1500);
  }
}

/**
 * @description 更新 header 的内容，如果匹配失败则不更新
 * @param headerFuzeMatch {{ title: string, url: string, favicon: string }[]|null} 匹配到的 对象数组 或 null
 * @param init {boolean} 是否是初始化
 */
function updateHeader(headerFuzeMatch) {
  const matchedBookmark = document.querySelector("#best-match .folder");
  if (matchedBookmark) {
    matchedBookmark.parentElement.removeChild(matchedBookmark);
  }
  const bestMatchFolder = createElement("div", CLASS_NAMES.folder);
  const childContainer = createElement("div", CLASS_NAMES.childContainer);

  // Header row: title + clear button
  const headerRow = createElement("div", "best-match-header");
  const title = createElement("h2", "", BestMatch);
  title.title = BestMatchTitle;
  headerRow.appendChild(title);

  const clearBtn = createElement("button", "best-match-clear", "×");
  clearBtn.type = "button";
  clearBtn.setAttribute("aria-label", isZhUI ? "清除匹配" : "Clear matches");
  clearBtn.title = isZhUI ? "清除匹配" : "Clear matches";
  clearBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    clearBestMatches();
  });
  headerRow.appendChild(clearBtn);

  headerFuzeMatch.forEach((matchedBookmark) => {
    createBookmarkItem(matchedBookmark, childContainer);
  });
  bestMatchFolder.appendChild(headerRow);
  bestMatchFolder.appendChild(childContainer);
  bestMatches = headerFuzeMatch;

  document.querySelector("#best-match").appendChild(bestMatchFolder);
  updateActiveBestMatch(0);
}

function clearBestMatches() {
  const bestMatchContainer = document.querySelector("#best-match");
  if (bestMatchContainer) bestMatchContainer.innerHTML = "";
  bestMatches = [];
  activeBestMatchIndex = 0;
}

/**
 * 检测文本是否溢出
 * @param {HTMLElement} el 检测溢出的元素
 * @returns
 */
function checkOverflow(el) {
  const curOverflow = el.style.overflow;

  if (!curOverflow || curOverflow === "visible") el.style.overflow = "hidden";

  const isOverflowing = el.clientWidth < el.scrollWidth || el.clientHeight < el.scrollHeight;

  el.style.overflow = curOverflow;

  return isOverflowing;
}

function resetSearchResults({ folders, items }) {
  for (const item of items) item.el.style.display = "flex";
  for (const folder of folders) folder.style.display = "block";
  clearBestMatches();
}

// 每次输入只进行一次 Fuse 检索，并复用同一份 DOM 缓存。
function filterBookmarks() {
  const searchTerm = searchInput.value.toLowerCase().trim();
  const { folders, items } = getBookmarkCache();

  // 清空搜索时恢复书签树。
  if (!searchTerm) {
    resetSearchResults({ folders, items });
    return;
  }

  // 同一网址只进入一次最佳匹配。
  const fuse = getFuseInstance();
  const results = fuse.search(searchTerm);
  const matchedUrls = new Set();
  const orderedMatches = [];
  for (const r of results) {
    if (!matchedUrls.has(r.item.url)) {
      matchedUrls.add(r.item.url);
      orderedMatches.push(r.item);
    }
  }

  // 保留匹配书签的各级父目录。
  const visibleFolders = new Set();
  for (const it of items) {
    const visible =
      it.titleLower.includes(searchTerm) || it.urlLower.includes(searchTerm) || matchedUrls.has(it.url);
    it.el.style.display = visible ? "flex" : "none";
    if (visible) {
      for (const f of it.ancestors) visibleFolders.add(f);
    }
  }
  for (const folder of folders) {
    folder.style.display = visibleFolders.has(folder) ? "block" : "none";
  }

  // 搜索框下方最多显示三项最佳匹配。
  if (orderedMatches.length) updateHeader(orderedMatches.slice(0, 3));
  else clearBestMatches();
}

// 再按一次打开面板的快捷键时收起面板，读的是用户当前设置的快捷键
let actionShortcut = null;
chrome.commands
  ?.getAll?.()
  .then((commands) => {
    const command = commands.find((c) => c.name === "_execute_action" || c.name === "_execute_browser_action");
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    actionShortcut = parseShortcut(command?.shortcut, /mac/i.test(platform));
  })
  .catch(() => {});

window.addEventListener("keydown", function (event) {
  if (matchesShortcut(actionShortcut, event)) {
    event.preventDefault();
    window.close();
    return;
  }
  if (event.defaultPrevented || event.isComposing || !SETTINGS_OVERLAY.el?.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    // 只在搜索功能开启时才处理清空搜索
    if (isSearchEnabled()) {
      searchInput.value = "";
      resetSearchResults(getBookmarkCache());
    }
  }

  if (event.key === "ArrowLeft") {
    if (!isSearchEnabled()) return;
    updateActiveBestMatch(activeBestMatchIndex - 1);
    showBestMatchTips();
  }

  if (event.key === "ArrowRight") {
    if (!isSearchEnabled()) return;
    updateActiveBestMatch(activeBestMatchIndex + 1);
    showBestMatchTips();
  }

  if (event.key === "Enter" && event.target === searchInput && bestMatches.length !== 0) {
    event.preventDefault();
    const url = bestMatches[activeBestMatchIndex].url;
    const openInNewTab = isOpenInNewTabEnabled();
    const keepPanelOpen = isKeepPanelOpenEnabled();

    if (keepPanelOpen) {
      createTab(url, false);
    } else if (openInNewTab) {
      createTab(url);
    } else {
      updateCurrentTab(url);
    }
  }

  if (event.ctrlKey && event.key === "s") {
    event.preventDefault();
    // Ctrl+S 将焦点移回搜索框。
    if (isSearchEnabled()) {
      searchInput?.focus();
    }
  }
});

function renderBookmarkTree(bookmarkTreeNodes) {
  if (!bookmarkTreeNodes?.length) return;
  createBookmarks(prepareVisibleBookmarkTree(bookmarkTreeNodes));
}

function prepareVisibleBookmarkTree(bookmarkTreeNodes) {
  if (!bookmarkTreeNodes?.length) return bookmarkTreeNodes;

  const root = bookmarkTreeNodes[0];
  const mobileFolderNames = new Set(["Mobile bookmarks", "Mobile Bookmarks", "移动设备书签", "移动书签"]);
  const bookmarksBarNames = new Set(["Bookmarks Bar", "Bookmarks bar", "收藏夹栏", "书签栏"]);
  const visibleChildren = [];

  for (const node of root.children || []) {
    // 内置文件夹优先按浏览器提供的类型识别，兼容旧版 Chrome 和 Firefox 的固定 ID。
    const isMobileFolder = node.folderType
      ? node.folderType === "mobile"
      : node.id === "3" || node.id === "mobile______" || mobileFolderNames.has(node.title);
    if (isMobileFolder) continue;

    const isBookmarksBar = node.folderType
      ? node.folderType === "bookmarks-bar"
      : node.id === "1" || node.id === "toolbar_____" || bookmarksBarNames.has(node.title);
    if (isBookmarksBar) {
      visibleChildren.push(...(node.children || []));
    } else {
      visibleChildren.push(node);
    }
  }

  return [{ ...root, children: visibleChildren }];
}

async function fetchBookmarkTree() {
  if (typeof browser !== "undefined") {
    return await browser.bookmarks.getTree();
  }
  return await chrome.bookmarks.getTree();
}

async function initializePopup() {
  const searchEnabled = isSearchEnabled();
  document.getElementById("search-wrapper").hidden = !searchEnabled;
  if (searchEnabled) {
    // 先聚焦，再加载书签，快捷键打开后无需等待就能开始输入。
    searchInput.focus({ preventScroll: true });
  }
  showLoadingState();

  try {
    const bookmarkTreeNodes = await fetchBookmarkTree();
    renderBookmarkTree(bookmarkTreeNodes);
    if (searchEnabled) {
      // 加载期间输入的内容也要用完整书签树检索。
      if (searchInput.value) filterBookmarks();
      searchInput.addEventListener("input", debounce(filterBookmarks, 80));
    }
  } catch (error) {
    console.error("Failed to load bookmark tree:", error);
  } finally {
    document.body.classList.remove("popup-loading");
  }
}

document.addEventListener("DOMContentLoaded", initializePopup);

function createBookmarks(bookmarkTreeNodes) {
  const bookmarksContainer = document.getElementById("bookmarks");
  bookmarksContainer.innerHTML = "";

  if (!hasBookmarkNodes(bookmarkTreeNodes)) {
    showEmptyBookmarkMessage();
  } else {
    // DocumentFragment ile DOM'a tek seferde ekle (reflow azaltır)
    const fragment = document.createDocumentFragment();
    showBookmarks(bookmarkTreeNodes, fragment);
    bookmarksContainer.appendChild(fragment);
    initializeTopLevelSorting();
  }
  // Bookmark DOM'u değişti; arama cache'ini geçersiz kıl
  invalidateBookmarkCache();
}

function hasBookmarkNodes(bookmarkNodes) {
  return (bookmarkNodes || []).some(
    (node) => Boolean(node.url) || (node.children?.length > 0 && hasBookmarkNodes(node.children))
  );
}

function showEmptyBookmarkMessage() {
  const bookmarksContainer = document.getElementById("bookmarks");
  const messageElement = createElement("p", "message", EmptyBookmarkMessage);

  bookmarksContainer.appendChild(messageElement);
}

function getBookmarkOrderKey(bookmarkNode) {
  if (bookmarkNode.id) return `id:${bookmarkNode.id}`;
  if (bookmarkNode.url) return `url:${bookmarkNode.url}`;
  return `folder:${bookmarkNode.title || "untitled"}`;
}

function getStoredTopLevelOrder() {
  try {
    const storedOrder = JSON.parse(localStorage.getItem(TOP_LEVEL_ORDER_KEY) || "[]");
    return Array.isArray(storedOrder) ? storedOrder : [];
  } catch {
    return [];
  }
}

function sortTopLevelBookmarks(bookmarkNodes) {
  const storedOrder = getStoredTopLevelOrder();
  if (!storedOrder.length) return bookmarkNodes;

  const orderIndex = new Map(storedOrder.map((key, index) => [key, index]));
  return bookmarkNodes
    .map((node, index) => ({ node, index, storedIndex: orderIndex.get(getBookmarkOrderKey(node)) }))
    .sort((left, right) => {
      const leftIndex = left.storedIndex ?? storedOrder.length + left.index;
      const rightIndex = right.storedIndex ?? storedOrder.length + right.index;
      return leftIndex - rightIndex;
    })
    .map(({ node }) => node);
}

function showBookmarks(bookmarkNodes, parent, parentTitle = [], useTopLevelOrder = false) {
  if (!bookmarkNodes || !bookmarkNodes.length) {
    return;
  }

  // 保存的顶层顺序只在同类项目内生效，各级始终先显示文件夹。
  const orderedNodes = useTopLevelOrder ? sortTopLevelBookmarks(bookmarkNodes) : bookmarkNodes;
  const folders = orderedNodes.filter((node) => node.children?.length > 0);
  const links = orderedNodes.filter((node) => node.url);
  folders.forEach((node) => createFolderForBookmarks(node, parent, parentTitle));
  links.forEach((node) => createBookmarkItem(node, parent));
}

function createBookmarkItem(bookmarkNode, parent) {
  let favicon = createElement("img", CLASS_NAMES.favicon);
  favicon.src = getFavicon(bookmarkNode.url);
  markDarkFavicon(favicon);

  let bookItem = createElement("a", CLASS_NAMES.bookmark);
  bookItem.href = bookmarkNode.url;
  bookItem.dataset.orderKey = getBookmarkOrderKey(bookmarkNode);

  // 设置打开方式
  if (isOpenInNewTabEnabled()) {
    bookItem.target = "_blank";
  }

  bookItem.appendChild(favicon);

  bookItem.addEventListener("click", function (event) {
    const isSpecialProtocol =
      bookmarkNode.url.startsWith("chrome://") ||
      bookmarkNode.url.startsWith("edge://") ||
      bookmarkNode.url.startsWith("file://");

    const openInNewTab = isOpenInNewTabEnabled();
    const keepPanelOpen = isKeepPanelOpenEnabled();
    const isCtrlOrMeta = event.ctrlKey || event.metaKey;

    if (keepPanelOpen) {
      event.preventDefault();
      createTab(bookmarkNode.url, false);
      return;
    }

    if (isSpecialProtocol) {
      event.preventDefault();
      if (openInNewTab || isCtrlOrMeta) {
        createTab(bookmarkNode.url);
      } else {
        updateCurrentTab(bookmarkNode.url);
      }
    } else {
      // 普通链接
      if (!openInNewTab) {
        // 如果设置为在当前标签页打开
        event.preventDefault();
        if (isCtrlOrMeta) {
          // 如果按下了 Ctrl/Meta 键，强制新标签页打开
          createTab(bookmarkNode.url);
        } else {
          // 否则在当前标签页打开
          updateCurrentTab(bookmarkNode.url);
        }
      }
      // 如果设置为新标签页打开，也就是默认情况，且 target="_blank"，交给浏览器处理
    }
  });

  let linkTitle = createElement("p", "", bookmarkNode.title ? bookmarkNode.title : getTitleFromUrl(bookmarkNode.url));
  bookItem.appendChild(linkTitle);

  let mouseleaveHandler = function () {
    if (!isTipsEnabled()) {
      return;
    }
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    // 在mouseleave事件中，设置一个延时，然后隐藏Notification
    hideTimeout = setTimeout(() => {
      Notification.hide();
    }, 500);
  };

  bookItem.addEventListener("mouseover", function () {
    // 只有在文本溢出且 tips 功能开启的时候才做处理
    if (isTipsEnabled() && checkOverflow(linkTitle)) {
      // 如果已经计划了隐藏通知的操作，取消它
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      Notification.show(bookmarkNode.title);
    }
  });

  bookItem.addEventListener("mouseleave", mouseleaveHandler);

  parent.appendChild(bookItem);
}

function createFolderForBookmarks(bookmarkNode, parent, parentTitle = []) {
  let folder = createElement("div", CLASS_NAMES.folder);
  folder.dataset.orderKey = getBookmarkOrderKey(bookmarkNode);
  let childContainer = createElement("div", CLASS_NAMES.childContainer);
  const isRoot = parentTitle.length === 0;
  if (isRoot) {
    folder.classList.add("folder-root");
  }
  // 递归传递父级的 title
  const title = [...parentTitle];
  title.push(bookmarkNode.title);
  // 每一级目录都保留独立节点，让 DOM 与浏览器书签层级一致。
  if (bookmarkNode.title) {
    let folderTitle = createElement("h2", CLASS_NAMES.folderTitle, "");
    const folderLabel = document.createElement("span");
    folderLabel.className = "folder-label";
    folderLabel.textContent = bookmarkNode.title;

    const isCollapsible = bookmarkNode.children?.length > 0;

    if (isCollapsible) {
      const folderStateKey = getFolderStateKey(bookmarkNode, title);
      const legacyFolderState = localStorage.getItem(bookmarkNode.title);
      const folderState = localStorage.getItem(folderStateKey) || legacyFolderState;
      if (!localStorage.getItem(folderStateKey) && legacyFolderState) {
        localStorage.setItem(folderStateKey, legacyFolderState);
      }

      folderTitle.classList.add("collapsible-folder");
      folderTitle.dataset.folderStateKey = folderStateKey;
      folderTitle.appendChild(folderLabel);
      const arrow = document.createElement("span");
      arrow.className = "folder-arrow";
      folderTitle.appendChild(arrow);
      folderTitle.title = keyText;
      folderTitle.style.cursor = "pointer";
      folderTitle.setAttribute("role", "button");
      folderTitle.setAttribute("tabindex", "0");

      // 判断是否在之前被收起来了
      if (folderState === "collapsed") {
        childContainer.style.display = "none";
        folderTitle.classList.add("collapsed");
        folderTitle.setAttribute("aria-expanded", "false");
      } else {
        folderTitle.classList.add("expanded");
        folderTitle.setAttribute("aria-expanded", "true");
      }

      const toggleFolder = function (event) {
        // 如果按住 ctrl 或 meta 键（Mac上的command键）则批量打开书签
        if (event.ctrlKey || event.metaKey) {
          const keepPanelOpen = isKeepPanelOpenEnabled();
          for (let childNode of bookmarkNode.children) {
            if (childNode.url) {
              createTab(childNode.url, !keepPanelOpen);
            }
          }
          event.preventDefault();
          return;
        }

        // 为展开/收起添加事件
        if (childContainer.style.display === "none") {
          childContainer.style.display = "block";
          localStorage.setItem(folderStateKey, "expanded");
          folderTitle.classList.remove("collapsed");
          folderTitle.classList.add("expanded");
          folderTitle.setAttribute("aria-expanded", "true");
        } else {
          childContainer.style.display = "none";
          localStorage.setItem(folderStateKey, "collapsed");
          folderTitle.classList.add("collapsed");
          folderTitle.classList.remove("expanded");
          folderTitle.setAttribute("aria-expanded", "false");
        }
      };

      folderTitle.addEventListener("click", toggleFolder);
      folderTitle.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleFolder(event);
        }
      });
    } else {
      folderTitle.appendChild(folderLabel);
    }

    folder.appendChild(folderTitle);
  }

  showBookmarks(bookmarkNode.children, childContainer, title, isRoot);

  folder.appendChild(childContainer);
  parent.appendChild(folder);
}

function initializeTopLevelSorting() {
  const container = document.querySelector("#bookmarks .folder-root > .childContainer");
  if (!container) return;

  const sortableItems = Array.from(container.children).filter(
    (item) => item.classList.contains(CLASS_NAMES.bookmark) || item.classList.contains(CLASS_NAMES.folder)
  );
  const sortHint = isZhUI ? "同类项目可拖动排序，或按 Alt + ↑/↓" : "Drag or press Alt + ↑/↓ to reorder within the group";
  let draggedItem = null;
  let dropTarget = null;
  let dropAfter = false;

  const isLink = (item) => item.classList.contains(CLASS_NAMES.bookmark);
  const getRow = (item) => (isLink(item) ? item : item.querySelector(":scope > .folderTitle"));

  const saveOrder = () => {
    const order = Array.from(container.children)
      .map((item) => item.dataset.orderKey)
      .filter(Boolean);
    localStorage.setItem(TOP_LEVEL_ORDER_KEY, JSON.stringify(order));
    invalidateBookmarkCache();
  };

  const clearDropState = () => {
    container.querySelectorAll(".drag-before, .drag-after").forEach((item) => {
      item.classList.remove("drag-before", "drag-after");
    });
    dropTarget = null;
    dropAfter = false;
  };

  const getDirectItem = (target) => {
    const item = target.closest(".top-level-sortable");
    return item?.parentElement === container ? item : null;
  };

  const showDropTarget = (item, after) => {
    clearDropState();
    dropTarget = item;
    dropAfter = after;
    item.classList.add(after ? "drag-after" : "drag-before");
  };

  sortableItems.forEach((item) => {
    const row = getRow(item);
    if (!row || !item.dataset.orderKey) return;

    item.classList.add("top-level-sortable");
    row.draggable = true;
    row.title = [row.title, sortHint].filter(Boolean).join("\n");
  });

  container.addEventListener("dragstart", (event) => {
    const item = getDirectItem(event.target);
    const row = item ? getRow(item) : null;
    if (!item || !row?.contains(event.target)) {
      event.preventDefault();
      return;
    }

    draggedItem = item;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.dataset.orderKey);
    requestAnimationFrame(() => item.classList.add("dragging"));
  });

  container.addEventListener("dragover", (event) => {
    if (!draggedItem) return;
    const item = getDirectItem(event.target);
    if (item) {
      if (item === draggedItem || isLink(item) !== isLink(draggedItem)) {
        clearDropState();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const currentItems = Array.from(container.children);
      const draggedIndex = currentItems.indexOf(draggedItem);
      const targetIndex = currentItems.indexOf(item);
      showDropTarget(item, targetIndex > draggedIndex);
      return;
    }

    // 空白区域只能把项目放到同类组的开头或末尾。
    const remainingItems = Array.from(container.children).filter((candidate) =>
      candidate !== draggedItem && candidate.classList.contains("top-level-sortable") && isLink(candidate) === isLink(draggedItem)
    );
    if (!remainingItems.length) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const firstItem = remainingItems[0];
    const lastItem = remainingItems[remainingItems.length - 1];
    const firstRow = getRow(firstItem);
    const lastRow = getRow(lastItem);
    const distanceToFirst = Math.abs(event.clientY - firstRow.getBoundingClientRect().top);
    const distanceToLast = Math.abs(event.clientY - lastRow.getBoundingClientRect().bottom);
    showDropTarget(distanceToFirst <= distanceToLast ? firstItem : lastItem, distanceToFirst > distanceToLast);
  });

  container.addEventListener("drop", (event) => {
    if (!draggedItem || !dropTarget) return;
    event.preventDefault();
    container.insertBefore(draggedItem, dropAfter ? dropTarget.nextSibling : dropTarget);
    saveOrder();
    clearDropState();
  });

  container.addEventListener("dragend", () => {
    draggedItem?.classList.remove("dragging");
    draggedItem = null;
    clearDropState();
  });

  container.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const item = getDirectItem(event.target);
    if (!item || !getRow(item)?.contains(event.target)) return;

    const sibling = event.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
    if (!sibling || isLink(sibling) !== isLink(item)) return;

    event.preventDefault();
    if (event.key === "ArrowUp") {
      container.insertBefore(item, sibling);
    } else {
      container.insertBefore(sibling, item);
    }
    saveOrder();
    getRow(item)?.focus();
    Notification.show(isZhUI ? "已调整插件内排序" : "Extension order updated", 1200);
  });
}

function getFolderStateKey(bookmarkNode, titlePath) {
  if (bookmarkNode.id) {
    return `MAPLE_FOLDER_STATE_${bookmarkNode.id}`;
  }
  const normalizedPath = (titlePath || []).filter(Boolean).join("/");
  return `MAPLE_FOLDER_STATE_${normalizedPath}`;
}

function getTitleFromUrl(url) {
  if (url.startsWith("about:")) {
    const aboutPage = url.slice("about:".length).split(/[/?#]/)[0] || "about";
    return aboutPage.charAt(0).toUpperCase() + aboutPage.slice(1);
  }

  if (url.startsWith("chrome://") || url.startsWith("edge://")) {
    const internalPage = url.split("://")[1]?.split("/")[0];
    if (internalPage) {
      return internalPage.charAt(0).toUpperCase() + internalPage.slice(1);
    }
  }

  try {
    let host = new URL(url).host;
    let parts = host.startsWith("www.") ? host.split(".")[1] : host.split(".")[0];

    return parts.charAt(0).toUpperCase() + parts.slice(1);
  } catch {
    return url;
  }
}
