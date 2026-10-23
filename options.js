// options.js —— 设置页逻辑（原生 DOM，无框架）
// 所有设置改动即时写入 chrome.storage.local，后台 SW 下一轮生效。
// 保存通知渠道时，按需 chrome.permissions.request 申请 optional_host_permissions 中对应的域。

import { getSettings, saveSettings, loadState, resetVideosAndBaseline, countByStatus } from './lib/store.js';
import { checkLogin } from './lib/api.js';
import { sendTest } from './lib/notify.js';
import { runPipeline } from './lib/pipeline.js';

const $ = (id) => document.getElementById(id);
let storedSettings = null; // 当前已存 settings；collectSettings 在其上修改后整体写回，避免丢字段

init();

async function init() {
  storedSettings = await getSettings();
  fillForm(storedSettings);
  // change 事件在勾选/失焦时触发：避免文本输入过程中频繁写盘或申请权限
  document.querySelectorAll('#sec-run input, #sec-notify input, #blacklist')
    .forEach((el) => el.addEventListener('change', () => { persist(); }));
  document.querySelectorAll('button[data-test]')
    .forEach((btn) => btn.addEventListener('click', () => { testChannel(btn.dataset.test); }));
  $('run_now').addEventListener('click', runNow);
  $('reset_baseline').addEventListener('click', resetBaseline);
  refreshStatus();
}

// ---------- 表单 <-> settings ----------

function fillForm(s) {
  $('enabled').checked = !!s.enabled;
  $('ah_start').value = s.active_hours.start;
  $('ah_end').value = s.active_hours.end;
  $('interval_hours').value = s.interval_hours;
  $('include_forward').checked = !!s.include_forward;
  $('first_run_add').checked = !!s.first_run_add;
  $('dry_run').checked = !!s.dry_run;
  $('max_pages').value = s.max_pages;
  $('blacklist').value = (s.blacklist || []).join('\n');
  $('notify_on_error').checked = !!s.notify_on_error;
  const n = s.notify || {};
  $('feishu_webhook').value = n.feishu_webhook || '';
  $('feishu_secret').value = n.feishu_secret || '';
  $('telegram_token').value = n.telegram_token || '';
  $('telegram_chat_id').value = n.telegram_chat_id || '';
  $('bark_host').value = n.bark_host || '';
  $('bark_key').value = n.bark_key || '';
  $('bark_sound').value = n.bark_sound || '';
  $('bark_level').value = n.bark_level || '';
  $('bark_group').value = n.bark_group || '';
  $('bark_icon').value = n.bark_icon || '';
  $('bark_call').checked = !!n.bark_call;
  $('custom_webhook').value = n.custom_webhook || '';
  updateBlacklistHint();
}

function clampInt(val, min, max, dflt) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 从一行文本提取数字 mid：优先 space.bilibili.com/{mid} 链接，其次行首纯数字，兜底第一个长数字串
function extractMid(line) {
  const s = (line || '').trim();
  if (!s) return '';
  const link = s.match(/space\.bilibili\.com\/(\d+)/i);
  if (link) return link[1];
  const head = s.match(/^(\d+)\b/);
  if (head) return head[1];
  const any = s.match(/\d{5,}/); // 兜底：短数字串可能是误输入，仅认 ≥5 位
  return any ? any[0] : '';
}

function parseBlacklist(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const mid = extractMid(line);
    if (mid && !out.includes(mid)) out.push(mid);
  }
  return out;
}

function updateBlacklistHint() {
  const mids = parseBlacklist($('blacklist').value);
  $('blacklist_hint').textContent = mids.length
    ? `已识别 ${mids.length} 个 mid：${mids.join(', ')}`
    : '黑名单为空：所有关注 UP 的新视频都会收录';
}

function collectSettings(current) {
  const s = current;
  s.enabled = $('enabled').checked;
  s.active_hours = {
    start: clampInt($('ah_start').value, 0, 23, 8),
    end: clampInt($('ah_end').value, 0, 23, 22)
  };
  s.interval_hours = clampInt($('interval_hours').value, 1, 24, 2);
  s.include_forward = $('include_forward').checked;
  s.first_run_add = $('first_run_add').checked;
  s.dry_run = $('dry_run').checked;
  s.max_pages = clampInt($('max_pages').value, 1, 10, 3);
  s.blacklist = parseBlacklist($('blacklist').value);
  s.notify_on_error = $('notify_on_error').checked;
  s.notify = Object.assign({}, s.notify, {
    feishu_webhook: $('feishu_webhook').value.trim(),
    feishu_secret: $('feishu_secret').value.trim(),
    telegram_token: $('telegram_token').value.trim(),
    telegram_chat_id: $('telegram_chat_id').value.trim(),
    bark_host: $('bark_host').value.trim(),
    bark_key: $('bark_key').value.trim(),
    bark_sound: $('bark_sound').value.trim(),
    bark_level: $('bark_level').value,
    bark_group: $('bark_group').value.trim(),
    bark_icon: $('bark_icon').value.trim(),
    bark_call: $('bark_call').checked,
    custom_webhook: $('custom_webhook').value.trim()
  });
  return s;
}

async function persist() {
  collectSettings(storedSettings);
  storedSettings = await saveSettings(storedSettings);
  updateBlacklistHint();
  // 间隔变更 → 同步重建轮询闹钟
  chrome.alarms.create('poll', {
    periodInMinutes: Math.max(1, (storedSettings.interval_hours || 2) * 60)
  });
  // 保存时按需申请所选渠道的域名权限（失败不阻塞保存，点“测试”会再次尝试）
  ensureNotifyPermissions(storedSettings);
}

// ---------- 可选域名权限 ----------

// 计算当前配置的渠道需要申请的 origin 模式（与 manifest.optional_host_permissions 对应；
// 自定义域名/带端口的 Bark 服务器由 https://*/*、http://*/* 兜底覆盖，端口在模式中需剥掉——
// Chrome match pattern 不支持端口，授权后对该 host 任意端口生效）
function neededOrigins(s) {
  const n = (s && s.notify) || {};
  const out = [];
  if (n.feishu_webhook) out.push('https://open.feishu.cn/*');
  if (n.telegram_token && n.telegram_chat_id) out.push('https://api.telegram.org/*');
  if (n.bark_key) {
    const host = (n.bark_host || 'api.day.app')
      .trim().replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    if (host) out.push(`https://${host}/*`);
  }
  if (n.custom_webhook) {
    try { out.push(new URL(n.custom_webhook).origin + '/*'); } catch (_) { /* 非法 URL 忽略 */ }
  }
  return [...new Set(out)];
}

async function ensureNotifyPermissions(s) {
  const origins = neededOrigins(s);
  const missing = [];
  for (const o of origins) {
    let has = false;
    try { has = await chrome.permissions.contains({ origins: [o] }); } catch (_) { /* ignore */ }
    if (!has) missing.push(o);
  }
  if (!missing.length) return true;
  try {
    return await chrome.permissions.request({ origins: missing });
  } catch (e) {
    // 可能是当前无用户手势；点“测试”按钮时会再次尝试申请
    console.warn('[bilifeed2later] 申请通知域名权限失败（可点渠道“测试”按钮重试）', e);
    return false;
  }
}

// ---------- 通知渠道测试 ----------

async function testChannel(ch) {
  const resEl = $('tr-' + ch);
  collectSettings(storedSettings);
  storedSettings = await saveSettings(storedSettings);
  const ok = await ensureNotifyPermissions(storedSettings); // 测试点击属于明确用户手势，可申请权限
  if (!ok) {
    resEl.textContent = '未获得对应域名的访问权限，无法发送';
    resEl.className = 'test-result err';
    return;
  }
  resEl.textContent = '发送中…';
  resEl.className = 'test-result';
  try {
    await sendTest(storedSettings, ch);
    resEl.textContent = '已发送，请查收';
    resEl.className = 'test-result ok';
  } catch (e) {
    resEl.textContent = `失败：${e.message}`;
    resEl.className = 'test-result err';
  }
}

// ---------- 状态区 ----------

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
    `已见 ${c.seen} · 已加入 ${c.added} · 手动移除 ${c.user_removed} · 稿件已删 ${c.api_deleted} · 添加失败 ${c.add_failed}`;

  // 凭据来源恒为“浏览器登录态”，这里检测当前登录态并给出颜色提示
  const el = $('login_state');
  el.textContent = '检测中…';
  el.className = '';
  try {
    const login = await checkLogin();
    if (login.ok) {
      el.textContent = `已登录（${login.uname || '未知昵称'}）`;
      el.className = 'ok';
    } else {
      el.textContent = '未登录，请先在浏览器登录B站';
      el.className = 'err';
    }
  } catch (e) {
    el.textContent = `检测失败：${e.message}`;
    el.className = 'err';
  }
}

async function runNow() {
  const btn = $('run_now');
  btn.disabled = true;
  $('action_msg').textContent = '正在检查…';
  try {
    const r = await runPipeline();
    if (r.skipped === 'disabled') {
      $('action_msg').textContent = '插件已停用，请先在“运行”区勾选启用。';
    } else if (r.skipped === 'running') {
      $('action_msg').textContent = '后台一轮检查正在进行中，请稍后。';
    } else if (r.ok) {
      $('action_msg').textContent =
        `完成：新增 ${r.new_cnt || 0}，加入 ${r.added_cnt || 0}${r.baseline ? '（本轮已建立基线）' : ''}`;
    } else {
      $('action_msg').textContent = `失败：${r.error || '未知错误'}`;
    }
  } catch (e) {
    $('action_msg').textContent = `失败：${e.message}`;
  }
  btn.disabled = false;
  await refreshStatus();
}

async function resetBaseline() {
  if (!confirm('确定重置基线？将清空全部视频状态（保留设置），下一轮会把当前动态全部记为“已见”。')) return;
  await resetVideosAndBaseline();
  $('action_msg').textContent = '基线已重置。';
  await refreshStatus();
}
