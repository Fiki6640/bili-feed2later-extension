// auto_sync.js —— 服务版自动同步（在后台 SW 中运行，设置页不直接调用）：
//   推：settings 变更（storage.onChanged → onSettingsChanged）去抖后自动推送到服务版；
//   拉：每 10 分钟闹钟（sync_check）检查服务版参数，有差异自动应用到本插件。
// 自动模式不弹确认框，结果记入 kv.auto_sync 供设置页展示。
// 防环设计：推送前先取服务版当前值 diff，无差异不写；自动拉取写盘期间置 syncing
// 标志抑制自身触发的 onChanged；两向映射互为逆运算（时段 ±1），收敛不震荡。

import { getSettings, saveSettings, loadState, saveKv } from './store.js';
import {
  fetchServiceForm, saveServiceForm, serviceFormToExtPatch,
  extToServiceOverlay, svcOnlyFromForm, diffExtPreview, diffServicePreview,
  applyExtPatch
} from './sync.js';

const PUSH_DEBOUNCE_MS = 5000;   // 设置连续变更合并为一次推送
const CHECK_PERIOD_MIN = 10;     // 服务版参数检查周期（分钟）
const ALARM = 'sync_check';

let pushTimer = null;
let syncing = false; // 自动拉取写盘期间抑制自动推送（onChanged 稍后触发，延时复位）

const connected = (s) => !!(s && s.sync && s.sync.server_url);

// 连接状态变化时管理检查闹钟；SW 启动（onInstalled/onStartup）也会调用兜底
export function ensureSyncAlarm(settings) {
  chrome.alarms.get(ALARM, (a) => {
    if (connected(settings) && !a)
      chrome.alarms.create(ALARM, { delayInMinutes: CHECK_PERIOD_MIN,
                                    periodInMinutes: CHECK_PERIOD_MIN });
    if (!connected(settings) && a) chrome.alarms.clear(ALARM);
  });
}

// storage.onChanged 入口：连接增删时管理闹钟；有连接则去抖自动推送
export function onSettingsChanged(oldValue, newValue) {
  if (connected(oldValue) !== connected(newValue)) ensureSyncAlarm(newValue);
  if (!connected(newValue) || syncing) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(autoPush, PUSH_DEBOUNCE_MS);
}

// 服务版参数检查（闹钟触发）：有差异自动应用到本插件
export async function autoSyncCheck() {
  const s = await getSettings();
  if (!connected(s)) return;
  try {
    const { form } = await fetchServiceForm(s.sync);
    const patch = serviceFormToExtPatch(form);
    const changes = diffExtPreview(s, patch);
    if (!changes.length) return record('pull', { ok: true, note: '无差异' });
    syncing = true;
    try {
      await saveSettings(applyExtPatch(s, patch));
    } finally {
      setTimeout(() => { syncing = false; }, 3000); // 覆盖 onChanged 的异步触发
    }
    await record('pull', { ok: true, count: changes.length, items: changes });
  } catch (e) {
    console.warn('[bilifeed2later] 服务版参数检查失败', e);
    await record('pull', { ok: false, error: e.message });
  }
}

// 自动推送：仅托管键 overlay（服务版专属字段从当前表单透传原样保留），无差异不写
async function autoPush() {
  pushTimer = null;
  const s = await getSettings();
  if (!connected(s)) return;
  try {
    const { form } = await fetchServiceForm(s.sync);
    const overlay = extToServiceOverlay(s, svcOnlyFromForm(form));
    if (overlay.error) throw new Error(overlay.error);
    const changes = diffServicePreview(form, overlay);
    if (!changes.length) return record('push', { ok: true, note: '无差异' });
    const r = await saveServiceForm(s.sync, overlay);
    await record('push', { ok: true, count: changes.length, message: r.message });
  } catch (e) {
    console.warn('[bilifeed2later] 自动推送失败', e);
    await record('push', { ok: false, error: e.message });
  }
}

// 同步结果记录（kv.auto_sync，仅展示用；写 kv 不触发 settings 的 onChanged）
async function record(dir, data) {
  try {
    const { kv } = await loadState();
    const next = Object.assign({}, kv, {
      auto_sync: Object.assign({}, kv.auto_sync,
        { [dir]: Object.assign({ at: new Date().toISOString() }, data) })
    });
    await saveKv(next);
  } catch (_) { /* 展示性记录，失败不阻塞 */ }
}
