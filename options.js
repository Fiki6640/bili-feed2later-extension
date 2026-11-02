// options.js —— 设置页逻辑（原生 DOM，无框架；MiniMax 风格界面）。
// 所有设置改动即时写入 chrome.storage.local，后台 SW 下一轮生效。
// 保存通知渠道时，按需 chrome.permissions.request 申请 optional_host_permissions 中对应的域。

import { getSettings, saveSettings, loadState, resetVideosAndBaseline, countByStatus } from './lib/store.js';
import { checkLogin, fetchToviewItems, aggregateUps, fetchUpName, resolveUserMid } from './lib/api.js';
import { sendTest } from './lib/notify.js';
import { runPipeline } from './lib/pipeline.js';
import {
  serverOriginPattern, testConnection, fetchServiceForm, saveServiceForm,
  runServiceNow, serviceFormToExtPatch, extToServiceOverlay,
  diffExtPreview, diffServicePreview, applyExtPatch
} from './lib/sync.js';

const $ = (id) => document.getElementById(id);
let storedSettings = null; // 当前已存 settings；collectSettings 在其上修改后整体写回，避免丢字段
let wlUpsData = null;      // 稍后再看 UP 列表；null=尚未加载，[]=加载过但列表为空
let blItems = [];          // 黑名单条目（纯数字 mid 字符串或昵称，与流水线语义一致）
let tbItems = [];          // 标题关键词（与 UP 黑名单相互独立：按标题子串匹配，不区分大小写）
let blNames = {};          // mid→昵称 本地记忆（仅展示用，存 chrome.storage.bl_names）
let svcConnected = false;  // 服务版当前页内是否已连通（连通后展示同步/接管区）

init();

async function init() {
  storedSettings = await getSettings();
  fillForm(storedSettings);
  // change 事件在勾选/失焦时触发：避免文本输入过程中频繁写盘或申请权限
  document.querySelectorAll('#sec-run input, #sec-notify input, #sec-notify select, #svc_url, #svc_token')
    .forEach((el) => el.addEventListener('change', () => { persist(); }));
  document.querySelectorAll('button[data-test]')
    .forEach((btn) => btn.addEventListener('click', () => { testChannel(btn.dataset.test); }));
  $('run_now').addEventListener('click', runNow);
  $('reset_baseline').addEventListener('click', resetBaseline);
  $('btnWlUps').addEventListener('click', loadWlUps);
  $('svc_test').addEventListener('click', () => svcTest(false));
  $('svc_pull').addEventListener('click', svcPull);
  $('svc_push').addEventListener('click', svcPush);
  $('svc_run').addEventListener('click', svcRunNow);
  // 地址变更后旧连接状态失效，需重新测试
  $('svc_url').addEventListener('change', () => {
    svcConnected = false;
    $('svc_body').hidden = true;
    $('svc_status').textContent = '';
    svcStateTag('未连接');
  });
  blInit();
  tbInit();
  // mid→昵称记忆（chrome.storage，跨会话）：黑名单 chips 富化为 昵称（uid）
  try {
    const r = await chrome.storage.local.get('bl_names');
    blNames = (r && r.bl_names) || {};
  } catch (_) { blNames = {}; }
  renderBl();
  migrateBlacklist();  // 一次性：存量裸 mid 补昵称升级为 昵称（mid）
  refreshStatus();
  // 已配置服务版地址：静默测试连接并展示状态（不自动拉取参数）
  if (storedSettings.sync && storedSettings.sync.server_url) svcTest(true);
  renderAutoSyncNote();
  svcInitCollapse();
  // 后台自动拉取会直接写 chrome.storage：切回本页时回刷表单，避免看到过期值
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const fresh = await getSettings();
    if (JSON.stringify(fresh) !== JSON.stringify(storedSettings)) {
      storedSettings = fresh;
      fillForm(storedSettings);
    }
    renderAutoSyncNote();
  });
}

// ---------- toast ----------

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'bad' ? ' bad' : kind === 'info' ? ' info' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, 3600);
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
  $('min_duration').value = s.min_duration;
  blItems = (s.blacklist || []).map(String);
  renderBl();
  tbItems = (s.title_blacklist || []).map(String);
  renderTb();
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
  const y = s.sync || {};
  $('svc_url').value = y.server_url || '';
  $('svc_token').value = y.token || '';
  updateBlacklistHint();
}

function clampInt(val, min, max, dflt) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// 黑名单条目规范化：space.bilibili.com/{mid} 链接或纯数字 → mid 字符串；其余按昵称原样保留
function normalizeBlItem(s) {
  const link = s.match(/space\.bilibili\.com\/(\d+)/i);
  return link ? link[1] : s;
}

function updateBlacklistHint() {
  const mids = blItems.filter(x => blItemMid(x));
  $('blacklist_hint').textContent = blItems.length
    ? `已识别 mid：${mids.length}/${blItems.length}`
    : '黑名单为空';
}

// ---------- 黑名单标签输入（与服务端配置页同构：纯数字按 mid，其余按昵称） ----------

function blNamesSave() {
  try { chrome.storage.local.set({ bl_names: blNames }); } catch (_) { /* 展示用，失败不阻塞 */ }
}
function midRemember(u) {
  if (u && u.mid != null && u.name) {
    blNames[String(u.mid)] = String(u.name);
    blNamesSave();
  }
}
function blDisplay(it) {  // 已知昵称的 mid 显示为 昵称（uid）
  const p = blParts(it);
  return p.mid && p.name ? p.name + '（' + p.mid + '）' : it;
}
function blParts(it) {  // 条目解析：{name,mid} / 仅 mid（查本地昵称记忆）/ 仅昵称
  const m = String(it).match(/^(.+)[（(](\d+)[）)]$/);
  if (m) return { name: m[1], mid: m[2] };
  if (/^\d+$/.test(it)) return { mid: String(it), name: blNames[String(it)] || null };
  return { name: String(it), mid: null };
}
function blItemMid(it) {
  return blParts(it).mid;
}
// 一次性迁移：存量条目升级为 昵称（mid）——裸 mid 经 card 补昵称，昵称经搜索/关注列表解析 mid
async function migrateBlacklist() {
  let changed = false;
  for (let i = 0; i < blItems.length; i++) {
    const it = blItems[i];
    const p = blParts(it);
    if (p.mid && p.name) continue;  // 已是复合格式
    let pair = null;
    if (p.mid && !p.name) {         // 存量裸 mid：补昵称
      let name = blNames[it] || null;
      if (!name) {
        try { name = await fetchUpName(it); } catch (_) { name = null; }
        if (name) midRemember({ mid: it, name });
      }
      if (name) pair = `${name}（${it}）`;
    } else {                         // 存量昵称：解析 mid
      let mid = null;
      try { mid = await resolveUserMid(it); } catch (_) { mid = null; }
      if (mid) { midRemember({ mid, name: it }); pair = `${it}（${mid}）`; }
    }
    if (pair) {
      blItems[i] = pair;
      changed = true;
    } else {
      console.warn('[bilifeed2later] 黑名单条目升级失败，保留原样（仍按原语义匹配）：', it);
    }
  }
  if (changed) {
    persist();
    renderBl();
  }
}
// 手动添加的昵称自动解析为 昵称（mid）
const blResolving = new Set();
function blResolvePending() {
  for (let i = 0; i < blItems.length; i++) {
    const it = blItems[i];
    if (blItemMid(it) || blResolving.has(it)) continue;
    blResolving.add(it);
    resolveUserMid(it).then(mid => {
      const j = blItems.indexOf(it);
      if (j < 0) return;
      if (mid) {
        blItems[j] = `${it}（${mid}）`;
        midRemember({ mid, name: it });
        persist();
        renderBl();
        toast(`已解析「${it}」→ ${mid}`, 'info');
      } else {  // 自动解析失败：跳B站搜索页让用户自行确认后输入 mid
        try {
          chrome.tabs.create({
            url: 'https://search.bilibili.com/upuser?keyword=' + encodeURIComponent(it)
          });
        } catch (_) { /* 打不开也不阻塞 */ }
        toast(`「${it}」未解析到同名 UP，已打开B站搜索页；确认后回车输入其数字 mid`, 'info');
      }
    }).catch(() => {}).finally(() => blResolving.delete(it));
  }
}
function blCheckOne(s) {
  if (!s) return { k: 'bad', m: '内容为空' };
  if (blItems.includes(s)) return { k: 'bad', m: '“' + s + '”已在黑名单中' };
  const p = blParts(s);
  if (p.mid)  // 纯 mid 与 昵称（mid） 复合条目：只校验 mid 位数
    return p.mid.length < 5 ? { k: 'warn', m: 'mid 位数偏少，请确认' } : { k: 'ok' };
  return s.length > 20 ? { k: 'warn', m: '昵称超过 20 字，请确认' } : { k: 'ok' };
}
function renderBl() {
  const box = $('blChips');
  box.innerHTML = '';
  for (const it of blItems) {
    const chip = document.createElement('span');
    const p = blParts(it);
    chip.className = 'chip';
    if (p.mid && p.name) {  // 昵称（uid），uid 用等宽字体
      chip.append(document.createTextNode(p.name + '（'));
      const uid = document.createElement('span');
      uid.className = 'uid';
      uid.textContent = p.mid;
      chip.appendChild(uid);
      chip.append(document.createTextNode('）'));
    } else {
      chip.append(document.createTextNode(it));
    }
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.setAttribute('aria-label', '移除 ' + blDisplay(it));
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener('click', () => blRemove(it));
    chip.appendChild(x);
    box.appendChild(chip);
  }
  updateBlacklistHint();
}
function blAdd(raw) {
  const parts = (raw || '').split(/[\r\n,，、]+/).map(s => normalizeBlItem(s.trim())).filter(Boolean);
  let added = 0, last = null;
  for (const p of parts) {
    const v = blCheckOne(p);
    if (v.k === 'bad') { last = v; continue; }
    if (v.k === 'warn') last = v;
    if (!blItems.includes(p)) { blItems.push(p); added++; }
  }
  renderBl();
  if (added) persist();
  if (last) toast(last.m, last.k === 'bad' ? 'bad' : 'info');
  if (added) blResolvePending();
  return added > 0;
}
function blRemove(it) {
  blItems = blItems.filter(x => x !== it);
  renderBl();
  persist();
}
function blInit() {
  const input = $('blInput');
  $('blBox').addEventListener('click', () => input.focus());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (blAdd(input.value)) input.value = '';
    } else if (e.key === 'Backspace' && !input.value && blItems.length) {
      blRemove(blItems[blItems.length - 1]);  // 空输入退格删最后一个标签
    }
  });
  input.addEventListener('paste', e => {  // 整段粘贴自动拆分为标签
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    if (/[\r\n,，、]/.test(text.trim())) {
      e.preventDefault();
      blAdd(text);
    }
  });
}

// ---------- 标题关键词黑名单（与 UP 黑名单相互独立：按标题字面子串匹配，不区分大小写，无 mid/昵称解析） ----------

function updateTitleBlacklistHint() {
  $('title_blacklist_hint').textContent = tbItems.length
    ? `已配置 ${tbItems.length} 个关键词`
    : '关键词为空';
}
function tbCheckOne(s) {
  if (!s) return { k: 'bad', m: '内容为空' };
  if (tbItems.includes(s)) return { k: 'bad', m: `“${s}”已在关键词中` };
  return s.length > 30 ? { k: 'warn', m: '超过 30 字，请确认' } : { k: 'ok' };
}
function renderTb() {
  const box = $('tbChips');
  box.innerHTML = '';
  for (const it of tbItems) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(document.createTextNode(it));
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.setAttribute('aria-label', '移除 ' + it);
    x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener('click', () => tbRemove(it));
    chip.appendChild(x);
    box.appendChild(chip);
  }
  updateTitleBlacklistHint();
}
function tbAdd(raw) {
  const parts = (raw || '').split(/[\r\n,，、]+/).map(s => s.trim()).filter(Boolean);
  let added = 0, last = null;
  for (const p of parts) {
    const v = tbCheckOne(p);
    if (v.k === 'bad') { last = v; continue; }
    if (v.k === 'warn') last = v;
    if (!tbItems.includes(p)) { tbItems.push(p); added++; }
  }
  renderTb();
  if (added) persist();
  if (last) toast(last.m, last.k === 'bad' ? 'bad' : 'info');
  return added > 0;
}
function tbRemove(it) {
  tbItems = tbItems.filter(x => x !== it);
  renderTb();
  persist();
}
function tbInit() {
  const input = $('tbInput');
  $('tbBox').addEventListener('click', () => input.focus());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (tbAdd(input.value)) input.value = '';
    } else if (e.key === 'Backspace' && !input.value && tbItems.length) {
      tbRemove(tbItems[tbItems.length - 1]);  // 空输入退格删最后一个标签
    }
  });
  input.addEventListener('paste', e => {  // 整段粘贴自动拆分为标签
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    if (/[\r\n,，、]/.test(text.trim())) {
      e.preventDefault();
      tbAdd(text);
    }
  });
}

function collectSettings(current) {
  const s = current;
  s.enabled = $('enabled').checked;
  s.active_hours = {
    start: clampInt($('ah_start').value, 0, 23, 8),
    end: clampInt($('ah_end').value, 0, 24, 22)
  };
  s.interval_hours = clampInt($('interval_hours').value, 1, 24, 2);
  s.include_forward = $('include_forward').checked;
  s.first_run_add = $('first_run_add').checked;
  s.dry_run = $('dry_run').checked;
  s.max_pages = clampInt($('max_pages').value, 1, 10, 3);
  s.min_duration = clampInt($('min_duration').value, 0, 86400, 300);
  s.blacklist = blItems.slice();
  s.title_blacklist = tbItems.slice();
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
  s.sync = Object.assign({}, s.sync, {
    server_url: $('svc_url').value.trim(),
    token: $('svc_token').value
  });
  return s;
}

async function persist() {
  collectSettings(storedSettings);
  storedSettings = await saveSettings(storedSettings);
  updateBlacklistHint();
  if (wlUpsData) renderWlUps();  // 黑名单变化同步刷新行内“拉黑/已在黑名单”状态
  // 间隔变更 → 同步重建轮询闹钟
  chrome.alarms.create('poll', {
    periodInMinutes: Math.max(1, (storedSettings.interval_hours || 2) * 60)
  });
  // 保存时按需申请所选渠道的域名权限（失败不阻塞保存，点“测试”会再次尝试）
  ensureNotifyPermissions(storedSettings);
}

// ---------- 稍后再看 UP 列表（快速拉黑） ----------

async function loadWlUps() {
  const btn = $('btnWlUps'), box = $('wlUps');
  btn.disabled = true;
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    wlUpsData = aggregateUps(await fetchToviewItems());
    wlUpsData.ups.forEach(midRemember);  // 学习 mid→昵称，chips 即时富化为 昵称（uid）
    renderBl();
    $('wlUpsHint').textContent = `共 ${wlUpsData.total} 条视频 · ${wlUpsData.ups.length} 位UP`;
    renderWlUps();
  } catch (e) {
    box.innerHTML = '';
    toast('加载失败：' + e.message, 'bad');
  }
  btn.disabled = false;
}

function wlUpBanned(u) {
  const mid = String(u.mid);
  return blItems.some(it => blItemMid(it) === mid || it === u.name);
}

// 加入黑名单：写 昵称（mid） 复合条目（按 mid 匹配且自描述），随 persist() 即时写盘
function wlUpBan(u) {
  midRemember(u);
  const pair = `${u.name || 'UP'}（${u.mid}）`;
  if (!wlUpBanned(u)) blItems.push(pair);
  persist();
  renderBl();
  toast(`已加入黑名单：${u.name || u.mid}`, 'info');
}

function renderWlUps() {
  const box = $('wlUps');
  if (!wlUpsData) return;
  if (!wlUpsData.ups.length) {
    box.innerHTML = '<div class="empty">稍后再看列表为空</div>';
    return;
  }
  box.innerHTML = '';
  for (const u of wlUpsData.ups) {
    const row = document.createElement('div');
    row.className = 'wlup';
    const act = document.createElement('span');
    act.className = 'act';
    if (wlUpBanned(u)) {
      const t = document.createElement('span');
      t.className = 'banned';
      t.textContent = '已在黑名单';
      act.appendChild(t);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = '拉黑';
      btn.addEventListener('click', () => wlUpBan(u));
      act.appendChild(btn);
    }
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = u.name || ('mid:' + u.mid);
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = u.mid;
    const c = document.createElement('span');
    c.className = 'grow';
    c.textContent = u.count + ' 条视频';
    row.append(act, n, m, c);
    box.appendChild(row);
  }
}

// ---------- 可选域名权限 ----------

// 计算当前配置的渠道需要申请的 origin 模式（与 manifest.optional_host_permissions 对应；
// 自定义域名/带端口的 Bark 服务器由 https://*/*、http://*/* 兜底覆盖，端口在模式中需剥掉——
// Chrome match pattern 不支持端口，授权后对该 host 任意端口生效；服务版地址同理）
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
  const svc = serverOriginPattern(s && s.sync && s.sync.server_url);
  if (svc) out.push(svc);
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
  const resEl = $('last_result');
  resEl.textContent = r
    ? `${r.ok ? '成功' : '失败'} · 新增 ${r.new_cnt || 0} · 加入 ${r.added_cnt || 0}${r.error ? ' · ' + r.error : ''}`
    : '—';
  resEl.className = 'v' + (r ? (r.ok ? ' ok' : ' err') : '');
  const c = countByStatus(videos);
  // 服务版接管：本地检查已停，本地视频统计不再更新，仅提示接管状态
  const svcMode = !!(storedSettings && storedSettings.sync &&
                     String(storedSettings.sync.server_url || '').trim());
  $('counts').textContent = svcMode ? '服务版接管中'
    : `${c.seen} / ${c.added} / ${c.user_removed} / ${c.api_deleted} / ${c.add_failed}`;

  // 凭据来源恒为“浏览器登录态”，这里检测当前登录态并给出颜色提示
  const el = $('login_state');
  el.textContent = '检测中…';
  el.className = 'v';
  try {
    const login = await checkLogin();
    if (login.ok) {
      el.textContent = `已登录（${login.uname || '未知昵称'}）`;
      el.className = 'v ok';
    } else {
      el.textContent = '未登录，请先在浏览器登录B站';
      el.className = 'v err';
    }
  } catch (e) {
    el.textContent = `检测失败：${e.message}`;
    el.className = 'v err';
  }
}

async function runNow() {
  const btn = $('run_now');
  btn.disabled = true;
  $('action_msg').textContent = '正在检查…';
  try {
    if (storedSettings.sync && String(storedSettings.sync.server_url || '').trim()) {
      // 服务版接管：触发服务版立即运行（检查与添加都在服务版执行）
      const r = await runServiceNow(storedSettings.sync);
      $('action_msg').textContent = r.message || '已触发服务版立即运行';
    } else {
      const r = await runPipeline();
      if (r.skipped === 'disabled') {
        $('action_msg').textContent = '插件已停用，请先在“运行”区勾选启用。';
      } else if (r.skipped === 'server') {
        $('action_msg').textContent = '检查由服务版执行。';
      } else if (r.skipped === 'running') {
        $('action_msg').textContent = '后台一轮检查正在进行中，请稍后。';
      } else if (r.ok) {
        $('action_msg').textContent =
          `完成：新增 ${r.new_cnt || 0}，加入 ${r.added_cnt || 0}${r.baseline ? '（本轮已建立基线）' : ''}`;
        toast(`检查完成：新增 ${r.new_cnt || 0}，加入 ${r.added_cnt || 0}`);
      } else {
        $('action_msg').textContent = `失败：${r.error || '未知错误'}`;
        toast(`检查失败：${r.error || '未知错误'}`, 'bad');
      }
    }
  } catch (e) {
    $('action_msg').textContent = `失败：${e.message}`;
    toast(`检查失败：${e.message}`, 'bad');
  }
  btn.disabled = false;
  await refreshStatus();
}

async function resetBaseline() {
  if (!confirm('重置基线？将清空全部视频状态（保留设置）。')) return;
  await resetVideosAndBaseline();
  $('action_msg').textContent = '基线已重置。';
  toast('基线已重置', 'info');
  await refreshStatus();
}

// ---------- 服务版连接（设置同步 + 远程接管） ----------

const svcSleep = (ms) => new Promise(r => setTimeout(r, ms));

const SVC_OPEN_KEY = 'svc_section_open';  // 服务版区展开状态（chrome.storage 记忆）

// 折叠头：默认收起，点击/回车切换并记忆；标题栏角标常显连接状态
function svcStateTag(text, kind = '') {
  const el = $('svc_state_tag');
  el.textContent = text;
  el.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

function svcSetOpen(open, persist = true) {
  $('svc_sec_body').hidden = !open;
  const head = $('svc_head');
  head.classList.toggle('open', open);
  head.setAttribute('aria-expanded', String(open));
  if (persist) { try { chrome.storage.local.set({ [SVC_OPEN_KEY]: open }); } catch (_) {} }
}

function svcInitCollapse() {
  const head = $('svc_head');
  const toggle = () => svcSetOpen($('svc_sec_body').hidden);
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  (async () => {
    let open = false;
    try {
      const r = await chrome.storage.local.get(SVC_OPEN_KEY);
      open = !!(r && r[SVC_OPEN_KEY]);
    } catch (_) { /* 默认收起 */ }
    svcSetOpen(open, false);
  })();
}

function svcMsg(text, kind = '') {
  const el = $('svc_sync_msg');
  el.textContent = text || '';
  el.className = 'hint' + (kind === 'ok' ? ' test-result ok' : kind === 'err' ? ' test-result err' : '');
}

function renderSvcStatus(st) {
  const el = $('svc_status');
  const parts = [];
  parts.push(st.has_credentials ? '凭据正常' : '凭据缺失（需在服务版 b2l login）');
  if (st.round && st.round.running) parts.push('一轮运行中…');
  if (st.next_run) parts.push('下一轮 ' + new Date(st.next_run).toLocaleString('zh-CN', { hour12: false }));
  const last = (st.recent_runs || [])[0];
  if (last) parts.push(last.error ? `上轮失败：${last.error}` : `上轮 新增 ${last.new_cnt || 0} / 加入 ${last.added_cnt || 0}`);
  el.textContent = parts.join(' · ');
  el.className = 'test-result' + (st.has_credentials ? ' ok' : ' err');
}

// 测试连接：silent=true 时由 init 静默调用（无用户手势，不申请权限，仅展示状态）
async function svcTest(silent) {
  const btn = $('svc_test'), el = $('svc_status');
  if (!silent) {
    collectSettings(storedSettings);
    storedSettings = await saveSettings(storedSettings);
  }
  if (!storedSettings.sync || !storedSettings.sync.server_url) {
    svcConnected = false;
    $('svc_body').hidden = true;
    el.textContent = silent ? '' : '未配置地址';
    el.className = 'test-result' + (silent ? '' : ' err');
    svcStateTag('未连接');
    return;
  }
  btn.disabled = true;
  if (!silent) { el.textContent = '连接中…'; el.className = 'test-result'; svcStateTag('连接中…'); }
  try {
    if (!silent) {
      // 点击属于明确用户手势，可申请该主机权限（同通知渠道约定，失败给出提示）
      const ok = await ensureNotifyPermissions(storedSettings);
      if (!ok) {
        el.textContent = '未获得该主机的访问权限，请重试一次';
        el.className = 'test-result err';
        svcStateTag('无权限', 'err');
        return;
      }
    }
    const st = await testConnection(storedSettings.sync);
    svcConnected = true;
    $('svc_body').hidden = false;
    renderSvcStatus(st);
    svcStateTag('已连接', 'ok');
    if (!silent) toast('服务版连接成功', 'info');
    const data = await fetchServiceForm(storedSettings.sync);  // 接管区填充（不在本插件保存）
    fillServiceOnly(data.form);
  } catch (e) {
    svcConnected = false;
    if (!silent) $('svc_body').hidden = true;
    el.textContent = `连接失败：${e.message}`;
    el.className = 'test-result err';
    svcStateTag('连接失败', 'err');
  } finally {
    btn.disabled = false;
  }
}

// 服务版专属设置（只随推送写回服务版，不在本插件保存）
function fillServiceOnly(f) {
  $('svc_timezone').value = f.timezone || '';
  $('svc_add_fail_retry').value = f.add_fail_retry != null ? f.add_fail_retry : 3;
  $('svc_cc_enabled').checked = !!f.cookiecloud_enabled;
  $('svc_cc_server').value = f.cookiecloud_server || '';
  $('svc_cc_uuid').value = f.cookiecloud_uuid || '';
  $('svc_cc_password').value = f.cookiecloud_password || '';
  $('svc_apprise_text').value = f.apprise_text || '';
  $('svc_feishu_webhook').value = f.feishu_webhook || '';
  $('svc_feishu_secret').value = f.feishu_secret || '';
  $('svc_feishu_app_id').value = f.feishu_app_id || '';
  $('svc_feishu_app_secret').value = f.feishu_app_secret || '';
  $('svc_feishu_chat_id').value = f.feishu_chat_id || '';
}

function collectServiceOnly() {
  return {
    timezone: $('svc_timezone').value.trim() || 'Asia/Shanghai',
    add_fail_retry: clampInt($('svc_add_fail_retry').value, 0, 99, 3),
    cookiecloud_enabled: $('svc_cc_enabled').checked,
    cookiecloud_server: $('svc_cc_server').value.trim(),
    cookiecloud_uuid: $('svc_cc_uuid').value.trim(),
    cookiecloud_password: $('svc_cc_password').value,
    apprise_text: $('svc_apprise_text').value,
    feishu_webhook: $('svc_feishu_webhook').value.trim(),
    feishu_secret: $('svc_feishu_secret').value.trim(),
    feishu_app_id: $('svc_feishu_app_id').value.trim(),
    feishu_app_secret: $('svc_feishu_app_secret').value.trim(),
    feishu_chat_id: $('svc_feishu_chat_id').value.trim()
  };
}

// 自动同步状态行（后台 auto_sync 写入 kv.auto_sync）
async function renderAutoSyncNote() {
  let a;
  try {
    ({ kv: { auto_sync: a } = {} } = await loadState());
  } catch (_) { return; }
  const el = $('svc_autosync');
  if (!el) return;
  const fmt = (r) => {
    if (!r) return '';
    const t = new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false });
    if (!r.ok) return `${t} 失败：${r.error || '未知错误'}`;
    return r.count ? `${t}（${r.count} 项）` : `${t}（无差异）`;
  };
  const parts = [];
  if (a && a.push) parts.push('插件→服务版 ' + fmt(a.push));
  if (a && a.pull) parts.push('服务版→插件 ' + fmt(a.pull));
  el.textContent = parts.length
    ? '自动同步 · ' + parts.join('；')
    : '自动同步：改动自动推送，每 10 分钟拉取差异';
}

async function svcPull() {
  svcMsg('');
  const btn = $('svc_pull');
  btn.disabled = true;
  try {
    const data = await fetchServiceForm(storedSettings.sync);
    const patch = serviceFormToExtPatch(data.form);
    const changes = diffExtPreview(storedSettings, patch);
    if (!changes.length) {
      svcMsg('设置一致，无需拉取。', 'ok');
      return;
    }
    if (!confirm('应用服务版设置到本插件？\n\n' + changes.map(c => '· ' + c).join('\n'))) return;
    storedSettings = applyExtPatch(storedSettings, patch);
    fillForm(storedSettings);
    await persist();  // persist 内部重建 poll 闹钟：间隔等变更下一轮即生效
    svcMsg(`已应用 ${changes.length} 项变更，下一轮自动生效。`, 'ok');
    toast(`已从服务版应用 ${changes.length} 项变更`, 'info');
  } catch (e) {
    svcMsg(`拉取失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function svcPush() {
  svcMsg('');
  const btn = $('svc_push');
  btn.disabled = true;
  try {
    collectSettings(storedSettings);
    storedSettings = await saveSettings(storedSettings);
    const data = await fetchServiceForm(storedSettings.sync);  // 以服务版当前值为基准，仅覆盖托管键
    const overlay = extToServiceOverlay(storedSettings, collectServiceOnly());
    if (overlay.error) {
      svcMsg(overlay.error, 'err');
      return;
    }
    const changes = diffServicePreview(data.form, overlay);
    if (!changes.length) {
      svcMsg('已是最新，无需推送。', 'ok');
      return;
    }
    if (!confirm('将以下变更写入服务版 config.toml？\n\n' + changes.map(c => '· ' + c).join('\n'))) return;
    const r = await saveServiceForm(storedSettings.sync, overlay);
    svcMsg(`已推送：${r.message}`, 'ok');
    toast('已推送到服务版', 'info');
  } catch (e) {
    svcMsg(`推送失败：${e.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

async function svcRunNow() {
  const btn = $('svc_run');
  btn.disabled = true;
  svcMsg('已请求服务版立即运行…');
  try {
    const r = await runServiceNow(storedSettings.sync);
    svcMsg(r.message || '已触发立即运行');
    // 轮询状态直到本轮结束（与服务版配置页一致），10 分钟兜底超时
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await svcSleep(2000);
      const st = await testConnection(storedSettings.sync);
      renderSvcStatus(st);
      if (!(st.round && st.round.running)) {
        const last = (st.recent_runs || [])[0];
        svcMsg('服务版本轮已结束' + (last
          ? (last.error ? `，失败：${last.error}` : `：新增 ${last.new_cnt || 0} / 加入 ${last.added_cnt || 0}`)
          : ''), last && !last.error ? 'ok' : 'err');
        break;
      }
    }
  } catch (e) {
    svcMsg(`立即运行失败：${e.message}`, 'err');
  }
  btn.disabled = false;
}
