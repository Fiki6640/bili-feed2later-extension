// options.js —— 设置页逻辑（原生 DOM，无框架；MiniMax 风格界面）。
// 所有设置改动即时写入 chrome.storage.local，后台 SW 下一轮生效。
// 保存通知渠道时，按需 chrome.permissions.request 申请 optional_host_permissions 中对应的域。

import { getSettings, saveSettings, loadState, resetVideosAndBaseline, countByStatus } from './lib/store.js';
import { checkLogin, fetchToviewItems, aggregateUps, fetchUpName, resolveUserMid } from './lib/api.js';
import { sendTest } from './lib/notify.js';
import { runPipeline } from './lib/pipeline.js';

const $ = (id) => document.getElementById(id);
let storedSettings = null; // 当前已存 settings；collectSettings 在其上修改后整体写回，避免丢字段
let wlUpsData = null;      // 稍后再看 UP 列表；null=尚未加载，[]=加载过但列表为空
let blItems = [];          // 黑名单条目（纯数字 mid 字符串或昵称，与流水线语义一致）
let blNames = {};          // mid→昵称 本地记忆（仅展示用，存 chrome.storage.bl_names）

init();

async function init() {
  storedSettings = await getSettings();
  fillForm(storedSettings);
  // change 事件在勾选/失焦时触发：避免文本输入过程中频繁写盘或申请权限
  document.querySelectorAll('#sec-run input, #sec-notify input, #sec-notify select')
    .forEach((el) => el.addEventListener('change', () => { persist(); }));
  document.querySelectorAll('button[data-test]')
    .forEach((btn) => btn.addEventListener('click', () => { testChannel(btn.dataset.test); }));
  $('run_now').addEventListener('click', runNow);
  $('reset_baseline').addEventListener('click', resetBaseline);
  $('btnWlUps').addEventListener('click', loadWlUps);
  blInit();
  // mid→昵称记忆（chrome.storage，跨会话）：黑名单 chips 富化为 昵称（uid）
  try {
    const r = await chrome.storage.local.get('bl_names');
    blNames = (r && r.bl_names) || {};
  } catch (_) { blNames = {}; }
  renderBl();
  migrateBlacklist();  // 一次性：存量裸 mid 补昵称升级为 昵称（mid）
  refreshStatus();
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

// 黑名单条目规范化：space.bilibili.com/{mid} 链接或纯数字 → mid 字符串；其余按昵称原样保留
function normalizeBlItem(s) {
  const link = s.match(/space\.bilibili\.com\/(\d+)/i);
  return link ? link[1] : s;
}

function updateBlacklistHint() {
  const mids = blItems.filter(x => blItemMid(x));
  const names = blItems.filter(x => !blItemMid(x));
  const parts = [];
  if (mids.length) parts.push(`mid×${mids.length}（${mids.join(', ')}）`);
  if (names.length) parts.push(`昵称×${names.length}（${names.join('、')}）`);
  $('blacklist_hint').textContent = parts.length
    ? `已识别 ${parts.join('；')}；昵称需与 UP 当前昵称完全一致（改名后需更新）`
    : '黑名单为空：所有关注 UP 的新视频都会收录';
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
    return p.mid.length < 5 ? { k: 'warn', m: 'mid 通常不少于 5 位，请确认是否输错' }
                            : { k: 'ok' };
  return s.length > 20 ? { k: 'warn', m: '昵称超过 20 字，请确认是否正确' } : { k: 'ok' };
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
  s.min_duration = clampInt($('min_duration').value, 0, 86400, 300);
  s.blacklist = blItems.slice();
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
  toast(`已将「${u.name || u.mid}」加入黑名单，下一轮起生效`, 'info');
}

function renderWlUps() {
  const box = $('wlUps');
  if (!wlUpsData) return;
  if (!wlUpsData.length) {
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
  const resEl = $('last_result');
  resEl.textContent = r
    ? `${r.ok ? '成功' : '失败'} · 新增 ${r.new_cnt || 0} · 加入 ${r.added_cnt || 0}${r.error ? ' · ' + r.error : ''}`
    : '—';
  resEl.className = 'v' + (r ? (r.ok ? ' ok' : ' err') : '');
  const c = countByStatus(videos);
  $('counts').textContent =
    `${c.seen} / ${c.added} / ${c.user_removed} / ${c.api_deleted} / ${c.add_failed}`;

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
    const r = await runPipeline();
    if (r.skipped === 'disabled') {
      $('action_msg').textContent = '插件已停用，请先在“运行”区勾选启用。';
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
  } catch (e) {
    $('action_msg').textContent = `失败：${e.message}`;
    toast(`检查失败：${e.message}`, 'bad');
  }
  btn.disabled = false;
  await refreshStatus();
}

async function resetBaseline() {
  if (!confirm('确定重置基线？将清空全部视频状态（保留设置），下一轮会把当前动态全部记为“已见”。')) return;
  await resetVideosAndBaseline();
  $('action_msg').textContent = '基线已重置。';
  toast('基线已重置', 'info');
  await refreshStatus();
}
