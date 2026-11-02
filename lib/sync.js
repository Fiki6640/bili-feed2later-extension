// sync.js —— 服务版连接：HTTP 客户端 + 双向参数映射 + 变更预览（纯函数为主，便于测试）。
// 服务版 API：GET/POST /api/config（表单字段格式）、GET /api/status、POST /api/run-now，
// 鉴权为 X-B2L-Token 头（[web].token 非空时必填）。仅设置页调用，后台流水线零感知。

const TIMEOUT_MS = 10000;

// 地址规范化：补 http:// 前缀、去尾部斜杠；空串返回 ''
export function normalizeServerUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

// 服务版地址 → 权限申请用 origin 模式。Chrome match pattern 不支持端口，
// 剥掉端口后对该 host 任意端口生效（与通知渠道 Bark 域名同一约定）。
export function serverOriginPattern(raw) {
  const u = normalizeServerUrl(raw);
  if (!u) return null;
  try {
    const { protocol, hostname } = new URL(u);
    if ((protocol !== 'http:' && protocol !== 'https:') || !hostname) return null;
    return `${protocol}//${hostname}/*`;
  } catch (_) {
    return null;
  }
}

// ---- HTTP 客户端 ----

async function svcFetch(sync, path, { method = 'GET', body } = {}) {
  const base = normalizeServerUrl(sync && sync.server_url);
  if (!base) throw new Error('未配置服务版地址');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (sync && sync.token) headers['X-B2L-Token'] = sync.token;
    res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal
    });
  } catch (e) {
    throw new Error(ctl.signal.aborted
      ? `连接超时（${TIMEOUT_MS / 1000}s），请确认地址与服务版是否在运行`
      : `网络失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON 响应（代理错误页等） */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error('访问令牌无效或缺失，请与服务版 [web].token 核对');
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

// 连接测试/状态刷新：GET /api/status（不调 B站接口）
export const testConnection = (sync) => svcFetch(sync, '/api/status');
// 读取服务版配置（表单字段格式）
export const fetchServiceForm = (sync) => svcFetch(sync, '/api/config');
// 写回服务版配置（服务版侧校验通过才落盘，返回提示信息）
export const saveServiceForm = (sync, values) =>
  svcFetch(sync, '/api/config', { method: 'POST', body: { values } });
// 远程立即运行（忽略活跃时段；与调度互斥）
export const runServiceNow = (sync) =>
  svcFetch(sync, '/api/run-now', { method: 'POST', body: {} });

// ---- 双向参数映射 ----
// 活跃时段边界语义不同：服务版 "8-22" 为闭区间（含 22 点），插件为 [start, end) 半开区间，
// 因此恒有 服务版 end ≡ 插件 end + 1。

function clamp(v, min, max, dflt) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? dflt : Math.min(max, Math.max(min, n));
}

// 服务版表单 → 插件 settings 补丁。仅含共有参数；插件特有字段（dry_run、TG/Bark 等）
// 与嵌套 merge（notify 逐字段）由调用方处理。
// 注意：总开关 enabled 不参与同步——它是各版独立的启停开关（服务版 [web] 侧
// 的"总暂停"与插件弹窗的"随手启停"都不应传导到对方）。
export function serviceFormToExtPatch(form) {
  return {
    active_hours: {
      start: clamp(form.active_hours_start, 0, 23, 8),
      end: clamp(form.active_hours_end, 0, 23, 22) + 1
    },
    interval_hours: clamp(form.interval_hours, 1, 24, 2),
    include_forward: !!form.include_forward,
    first_run_add: !!form.first_run_add,
    max_pages: clamp(form.max_pages, 1, 10, 3),
    min_duration: clamp(form.min_duration, 0, 86400, 300),
    blacklist: String(form.blacklist_text || '')
      .split('\n').map(s => s.trim()).filter(Boolean),
    title_blacklist: String(form.title_blacklist_text || '')
      .split('\n').map(s => s.trim()).filter(Boolean),
    notify_on_error: !!form.notify_on_error
  };
}

// 插件 settings + 服务版专属字段 → 服务版表单 overlay（仅托管键，服务版其余键保持原文）。
// 返回 {error} 表示插件当前时段配置无法映射（跨夜）。
export function extToServiceOverlay(settings, svcOnly) {
  const ah = (settings && settings.active_hours) || {};
  const start = clamp(ah.start, 0, 23, 8), end = clamp(ah.end, 0, 24, 22);
  let sStart, sEnd;
  if (start === end) { sStart = 0; sEnd = 23; }          // 插件全天 → 服务版 0-23（同为全天）
  else if (start < end) { sStart = start; sEnd = end - 1; } // 半开区间 → 闭区间
  else {
    return { error: `插件活跃时段为跨夜配置（${start}-${end} 点），服务版不支持跨夜，请调整后再推送` };
  }
  return Object.assign({
    active_hours_start: sStart,
    active_hours_end: sEnd,
    interval_hours: clamp(settings.interval_hours, 1, 24, 2),
    include_forward: !!settings.include_forward,
    first_run_add: !!settings.first_run_add,
    max_pages: clamp(settings.max_pages, 1, 10, 3),
    min_duration: clamp(settings.min_duration, 0, 86400, 300),
    blacklist_text: (settings.blacklist || []).map(String).join('\n'),
    title_blacklist_text: (settings.title_blacklist || []).map(String).join('\n'),
    notify_on_error: settings.notify_on_error !== false
  }, svcOnly || {});
}

// 应用服务版补丁到插件 settings：notify 嵌套逐字段合并，避免覆盖 TG/Bark 等插件特有渠道。
// 纯函数（返回合并后的新对象），设置页与后台自动同步共用。
export function applyExtPatch(settings, patch) {
  const merged = Object.assign({}, settings);
  const { notify, ...rest } = patch;
  Object.assign(merged, rest);
  merged.notify = Object.assign({}, settings.notify, notify);
  return merged;
}

// 服务版表单 → 服务版专属字段透传（自动推送用：这些字段原样保留、不参与同步）。
// 直接传 {} 会让 overlay 缺失这些键，服务版 apply_edit 会按默认值重写——
// 已配置的 CookieCloud 等将被静默清空，务必经此函数回填。
// ⚠ 服务版新增 apply_edit 托管键时：要么改为托管同步（patch/overlay/diff 四处 + 移出本列表），
// 要么补到这里透传，二者必居其一，否则自动推送会静默清空服务版该字段。
// （title_blacklist_text 已改为托管同步，见 serviceFormToExtPatch / extToServiceOverlay。）
export function svcOnlyFromForm(form) {
  return {
    timezone: form.timezone,
    add_fail_retry: form.add_fail_retry,
    cookiecloud_enabled: form.cookiecloud_enabled,
    cookiecloud_server: form.cookiecloud_server,
    cookiecloud_uuid: form.cookiecloud_uuid,
    cookiecloud_password: form.cookiecloud_password,
    apprise_text: form.apprise_text,
    feishu_webhook: form.feishu_webhook,
    feishu_secret: form.feishu_secret,
    feishu_app_id: form.feishu_app_id,
    feishu_app_secret: form.feishu_app_secret,
    feishu_chat_id: form.feishu_chat_id
  };
}

// ---- 变更预览 ----

const boolCn = (v) => (v ? '开' : '关');
const secretCn = (v) => (String(v || '') ? '已设置' : '（空）');
const lineCnt = (s) => String(s || '').split('\n').filter(x => x.trim()).length;

function changedWebhook(a, b) {
  const sa = String(a || ''), sb = String(b || '');
  if (sa === sb) return null;
  if (!sa && sb) return '新增';
  if (sa && !sb) return '清空';
  return '更新';
}

// 拉取预览：插件当前 settings vs 服务版补丁，产出「标签：a → b」清单（总开关不参与同步）
export function diffExtPreview(cur, patch) {
  const out = [];
  const c = cur || {};
  const ca = c.active_hours || {}, ta = patch.active_hours || {};
  if (ca.start !== ta.start || ca.end !== ta.end)
    out.push(`活跃时段（插件侧半开区间）：${ca.start}-${ca.end} → ${ta.start}-${ta.end}`);
  if ((c.interval_hours | 0) !== (patch.interval_hours | 0))
    out.push(`检查间隔：${c.interval_hours} → ${patch.interval_hours} 小时`);
  if (!!c.include_forward !== !!patch.include_forward)
    out.push(`收录转发动态：${boolCn(c.include_forward)} → ${boolCn(patch.include_forward)}`);
  if (!!c.first_run_add !== !!patch.first_run_add)
    out.push(`首次运行回填添加：${boolCn(c.first_run_add)} → ${boolCn(patch.first_run_add)}`);
  if ((c.max_pages | 0) !== (patch.max_pages | 0))
    out.push(`每轮翻页数：${c.max_pages} → ${patch.max_pages}`);
  if ((c.min_duration | 0) !== (patch.min_duration | 0))
    out.push(`短视频阈值：${c.min_duration} → ${patch.min_duration} 秒`);
  const cb = (c.blacklist || []).map(String), tb = patch.blacklist || [];
  if (cb.join('\n') !== tb.join('\n'))
    out.push(`UP 黑名单：${cb.length} 项 → ${tb.length} 项`);
  const ck = (c.title_blacklist || []).map(String), tk = patch.title_blacklist || [];
  if (ck.join('\n') !== tk.join('\n'))
    out.push(`标题关键词黑名单：${ck.length} 项 → ${tk.length} 项`);
  if (!!c.notify_on_error !== !!patch.notify_on_error)
    out.push(`异常告警：${boolCn(c.notify_on_error)} → ${boolCn(patch.notify_on_error)}`);
  return out;
}

// 推送预览：服务版当前表单 vs 将写入的 overlay，产出变更清单（总开关不参与同步）
export function diffServicePreview(form, overlay) {
  const out = [];
  const f = form || {};
  const fa = `${f.active_hours_start}-${f.active_hours_end}`;
  const fb = `${overlay.active_hours_start}-${overlay.active_hours_end}`;
  if (fa !== fb)
    out.push(`活跃时段（服务版闭区间）：${fa} → ${fb}`);
  if ((f.interval_hours | 0) !== (overlay.interval_hours | 0))
    out.push(`检查间隔：${f.interval_hours} → ${overlay.interval_hours} 小时`);
  if (!!f.include_forward !== !!overlay.include_forward)
    out.push(`收录转发动态：${boolCn(f.include_forward)} → ${boolCn(overlay.include_forward)}`);
  if (!!f.first_run_add !== !!overlay.first_run_add)
    out.push(`首次运行回填添加：${boolCn(f.first_run_add)} → ${boolCn(overlay.first_run_add)}`);
  if ((f.max_pages | 0) !== (overlay.max_pages | 0))
    out.push(`每轮翻页数：${f.max_pages} → ${overlay.max_pages}`);
  if ((f.min_duration | 0) !== (overlay.min_duration | 0))
    out.push(`短视频阈值：${f.min_duration} → ${overlay.min_duration} 秒`);
  if ((f.add_fail_retry | 0) !== (overlay.add_fail_retry | 0))
    out.push(`加入失败重试：${f.add_fail_retry} → ${overlay.add_fail_retry} 轮`);
  const fa2 = lineCnt(f.blacklist_text), fb2 = lineCnt(overlay.blacklist_text);
  if (String(f.blacklist_text || '') !== String(overlay.blacklist_text || ''))
    out.push(`UP 黑名单：${fa2} 项 → ${fb2} 项`);
  const fc2 = lineCnt(f.title_blacklist_text), fd2 = lineCnt(overlay.title_blacklist_text);
  if (String(f.title_blacklist_text || '') !== String(overlay.title_blacklist_text || ''))
    out.push(`标题关键词黑名单：${fc2} 项 → ${fd2} 项`);
  if (!!f.notify_on_error !== !!overlay.notify_on_error)
    out.push(`异常告警：${boolCn(f.notify_on_error)} → ${boolCn(overlay.notify_on_error)}`);
  const pairs = [
    ['timezone', '时区', (a, b) => (String(a || '') !== String(b || '') ? `${a || '（空）'} → ${b}` : null)],
    ['cookiecloud_server', 'CookieCloud 服务器', (a, b) => (String(a || '') !== String(b || '') ? `${a || '（空）'} → ${b}` : null)],
    ['cookiecloud_uuid', 'CookieCloud UUID', (a, b) => (String(a || '') !== String(b || '') ? `${a || '（空）'} → ${b}` : null)],
    ['cookiecloud_password', 'CookieCloud 密码', (a, b) => (String(a || '') !== String(b || '') ? `${secretCn(a)} → ${secretCn(b)}` : null)],
    ['apprise_text', 'Apprise 通知', (a, b) => (String(a || '') !== String(b || '') ? `${lineCnt(a)} 行 → ${lineCnt(b)} 行` : null)],
    ['feishu_webhook', '飞书 webhook', changedWebhook],
    ['feishu_secret', '飞书签名 secret', changedWebhook],
    ['feishu_app_id', '飞书应用 App ID', (a, b) => (String(a || '') !== String(b || '') ? `${a || '（空）'} → ${b || '（空）'}` : null)],
    ['feishu_app_secret', '飞书应用 App Secret', (a, b) => (String(a || '') !== String(b || '') ? `${secretCn(a)} → ${secretCn(b)}` : null)],
    ['feishu_chat_id', '飞书会话 chat_id', (a, b) => (String(a || '') !== String(b || '') ? `${a || '（空）'} → ${b || '（空）'}` : null)]
  ];
  for (const [key, label, fmt] of pairs) {
    const note = fmt(f[key], overlay[key]);
    if (note) out.push(`${label}：${note}`);
  }
  if (!!f.cookiecloud_enabled !== !!overlay.cookiecloud_enabled)
    out.push(`CookieCloud：${boolCn(f.cookiecloud_enabled)} → ${boolCn(overlay.cookiecloud_enabled)}`);
  return out;
}
