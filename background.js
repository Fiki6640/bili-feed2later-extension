// background.js —— MV3 Service Worker：调度（alarms）+ 补跑 + 点击图标入口
// SW 无状态：所有状态读写走 chrome.storage（经 lib/store.js），顶层不使用任何 DOM API。

import { runPipeline } from './lib/pipeline.js';
import { getSettings, loadState } from './lib/store.js';

const ALARM_NAME = 'poll';

// 是否处于活跃时段（本地时间）。约定：[start, end) 半开区间（8-22 即 8:00–21:59）；
// start>end 视为跨夜时段；start==end 视为配置退化，按全天处理。
function inActiveHours(activeHours) {
  const start = Number(activeHours && activeHours.start);
  const end = Number(activeHours && activeHours.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return true; // 配置缺失兜底：不拦截
  const hour = new Date().getHours();
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 跨夜
}

// 确保轮询闹钟存在（periodInMinutes 跟随 settings.interval_hours）
async function ensureAlarm() {
  try {
    const s = await getSettings();
    chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: Math.max(1, (s.interval_hours || 2) * 60)
    });
    await maybeCatchup(s); // 补跑判断
  } catch (e) {
    console.error('[bilifeed2later] ensureAlarm 失败', e);
  }
}

// 补跑：浏览器关闭期间错过的轮次，启动后若距上次运行已超过间隔、且当前在活跃时段内 → 立即补一轮
async function maybeCatchup(settings) {
  const state = await loadState();
  const lastMs = state.kv.last_run_at ? Date.parse(state.kv.last_run_at) : 0;
  const overdue = !lastMs || (Date.now() - lastMs) > (settings.interval_hours || 2) * 3600 * 1000;
  if (overdue && inActiveHours(settings.active_hours)) {
    await runPipeline();
  }
}

// 安装 / 更新 / 浏览器启动时：重建闹钟并判断补跑
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });

// 定时触发：总开关关闭或不在活跃时段 → 跳过本轮
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  try {
    const s = await getSettings();
    if (!s.enabled) return;
    if (!inActiveHours(s.active_hours)) return;
    await runPipeline();
  } catch (e) {
    console.error('[bilifeed2later] onAlarm 执行失败', e);
  }
});

// popup“立即检查”：在 SW 内执行（弹窗中途关闭也不打断），与定时轮次共用同一防重入流水线
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'run-now') {
    runPipeline()
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true; // 异步 sendResponse：保持消息通道开启
  }
  return undefined;
});
