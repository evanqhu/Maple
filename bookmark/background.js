import { findOpenCopy, closeDuplicateTabs, hasTabsPermission } from "./utils/tab-dedupe.js";

// 合并重复标签页：设置里开启后才有 tabs 权限，关闭时权限一并撤销，所以有权限就是开着
// 新开的标签页打开了已经开着的网页，就关掉新的，正在看它时切到原来那个；其余重复的等页面加载完统一关掉，正在看的那个保留
// 浏览器启动时恢复上次的标签页也会触发新建，这段时间里不当成新开的
const STARTUP_GRACE_MS = 10000;
const SWEEP_DELAY_MS = 500;
const FRESH_TABS_KEY = "MAPLE_FRESH_TABS";
// 跳转页加载完后通常立刻跳走，这段时间里仍算新开的
const REDIRECT_GRACE_MS = 2000;
let quietUntil = 0;
let sweepTimer = null;
// 新开的标签页到第一个网页加载完之前都算新开的，中间经过跳转页也认得出；后台被回收后从 storage.session 找回
// 值是第一个网页加载完的时间，还没加载完是 0
const freshTabs = new Map();
const freshTabsReady = (chrome.storage.session?.get(FRESH_TABS_KEY) ?? Promise.resolve())
  .then((stored) => (stored?.[FRESH_TABS_KEY] || []).forEach(([id, loadedAt]) => freshTabs.set(id, loadedAt)))
  .catch(() => {});

function saveFreshTabs() {
  chrome.storage.session?.set({ [FRESH_TABS_KEY]: [...freshTabs] }).catch(() => {});
}

function isFresh(tabId) {
  if (!freshTabs.has(tabId)) return false;
  const loadedAt = freshTabs.get(tabId);
  if (!loadedAt || Date.now() - loadedAt < REDIRECT_GRACE_MS) return true;
  freshTabs.delete(tabId);
  saveFreshTabs();
  return false;
}

// 切换和清理都排进同一个队列，否则同时开出几个相同网页时，各自都会把对方当成原来那个，全部被关掉
let dedupeQueue = Promise.resolve();
function enqueue(job) {
  dedupeQueue = dedupeQueue.then(job).catch((e) => console.warn("Failed to merge duplicate tabs:", e));
}

chrome.runtime.onStartup.addListener(() => {
  quietUntil = Date.now() + STARTUP_GRACE_MS;
});

async function sweepDuplicates() {
  if (await hasTabsPermission()) await closeDuplicateTabs();
}

function scheduleSweep() {
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => enqueue(sweepDuplicates), SWEEP_DELAY_MS);
}

async function switchToOpenCopy(tabId) {
  if (Date.now() < quietUntil || !(await hasTabsPermission())) return;
  // 现读一次，分组、固定和是否正在看都按此刻的状态判断
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return; // 已经关了，或者在 PWA、弹出窗口里
  // 窗口里只有它时关掉会连窗口一起关，按 ⌘N 打开的主页就是这样，留着
  if (!tabs.some((t) => t.windowId === tab.windowId && t.id !== tab.id)) return;
  const copy = findOpenCopy(tabs, tab);
  if (!copy) return;
  // 先切过去再关，浏览器就不会在中间切到旁边的标签页
  if (tab.active) {
    await chrome.tabs.update(copy.id, { active: true });
    if (copy.windowId !== tab.windowId) await chrome.windows.update(copy.windowId, { focused: true });
  }
  await chrome.tabs.remove(tab.id);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (Date.now() < quietUntil) return;
  freshTabs.set(tab.id, 0);
  saveFreshTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (freshTabs.delete(tabId)) saveFreshTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const isPage = /^https?:/.test(changeInfo.url || tab.url || "");
  if (changeInfo.url && isPage) {
    enqueue(async () => {
      await freshTabsReady;
      if (isFresh(tabId)) await switchToOpenCopy(tabId);
    });
  }
  if (changeInfo.status === "complete") {
    if (isPage) {
      enqueue(async () => {
        await freshTabsReady;
        if (freshTabs.get(tabId) === 0) {
          freshTabs.set(tabId, Date.now());
          saveFreshTabs();
        }
      });
    }
    scheduleSweep();
  }
});

chrome.permissions.onAdded.addListener(scheduleSweep);
