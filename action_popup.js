// action_popup.js —— 工具栏弹窗：快捷开关 / 立即检查 / 状态信息 / 打开设置。
// “立即检查”通过消息交给后台 SW 执行：弹窗中途关闭也不会打断检查；
// 与定时轮次共用同一流水线（防重入），手动触发不受活跃时段限制（与 options 页行为一致）。

import { loadState, getSettings, saveSettings, countByStatus } from './lib/store.js';
import { checkLogin } from './lib/api.js';

const $ = (id) => document.getElementById(id);

// ---------- 快捷开关（settings.enabled） ----------

async function initSwitch() {
  const s = await getSettings();
  $('q_enabled').checked = !!s.enabled;
}

$('q_enabled').addEventListener('change', async (e) => {
  const s = await getSettings();
  s.enabled = e.target.checked;
  await saveSettings(s);
  // badge：停用置灰 OFF（流水线在停用时不会写 badge，OFF 会一直留到重新启用）；启用则清空
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#6a737d' });
    await chrome.action.setBadgeText({ text: s.enabled ? '' : 'OFF' });
  } catch (_) { /* badge 失败不影响功能 */ }
  $('msg').textContent = s.enabled
    ? '已启用自动检查。'
    : '已停用自动检查（定时轮次与立即检查都会跳过）。';
});

async function refreshStatus() {
  const { kv, videos } = await loadState();
  $('last_run').textContent = kv.last_run_at
    ? new Date(kv.last_run_at).toLocaleString('zh-CN')
    : '从未运行';
  const r = kv.last_run_result;
  $('last_result').textContent = r
    ? `${r.ok ? '成功' : '失败'} · 新增 ${r.new_cnt || 0} · 加入 ${r.added_cnt || 0}${r.error ? ' · ' + r.error : ''}`
    : '—';
  const c = countByStatus(videos);
  $('counts').textContent =
    `已见 ${c.seen} · 已加入 ${c.added} · 移除 ${c.user_removed} · 删除 ${c.api_deleted} · 失败 ${c.add_failed}`;

  const el = $('login_state');
  try {
    const login = await checkLogin();
    el.textContent = login.ok ? `已登录（${login.uname || '未知'}）` : '未登录';
    el.className = login.ok ? 'ok' : 'err';
  } catch (e) {
    el.textContent = '检测失败';
    el.className = 'err';
  }
}

$('run_now').addEventListener('click', async () => {
  const btn = $('run_now');
  btn.disabled = true;
  $('msg').textContent = '正在检查…';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'run-now' });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || '后台无响应');
    const r = resp.result || {};
    if (r.skipped === 'disabled') {
      $('msg').textContent = '插件已停用，请在设置里勾选启用。';
    } else if (r.skipped === 'running') {
      $('msg').textContent = '后台一轮检查正在进行中，请稍后。';
    } else if (r.ok) {
      $('msg').textContent =
        `完成：新增 ${r.new_cnt || 0}，加入 ${r.added_cnt || 0}${r.baseline ? '（本轮已建立基线）' : ''}`;
    } else {
      $('msg').textContent = `失败：${r.error || '未知错误'}`;
    }
  } catch (e) {
    $('msg').textContent = `失败：${e.message}`;
  }
  btn.disabled = false;
  await refreshStatus();
});

$('open_options').addEventListener('click', () => chrome.runtime.openOptionsPage());

initSwitch();
refreshStatus();
