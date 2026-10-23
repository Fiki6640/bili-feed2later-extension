// api.js —— B站 Web API 薄客户端（复用浏览器登录态）
// 所有 fetch 一律 credentials: 'include'，由 host_permissions（https://*.bilibili.com/*）
// 保证 SW 发起的请求自动携带浏览器内真实 Cookie；统一带 Referer（SW fetch 可设置）。

const REFERER = 'https://www.bilibili.com/';
const FEED_ALL_URL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const TOVIEW_WEB_URL = 'https://api.bilibili.com/x/v2/history/toview/web';   // 新端点
const TOVIEW_LEGACY_URL = 'https://api.bilibili.com/x/v2/history/toview';    // 旧端点（降级用）
const ADD_WEB_URL = 'https://api.bilibili.com/x/v2/history/toview/web/add';  // 新端点
const ADD_LEGACY_URL = 'https://api.bilibili.com/x/v2/history/toview/add';   // 旧端点（降级用）

// 统一 JSON 请求：自动注入 credentials 与 Referer
async function biliFetchJson(url, init = {}) {
  const headers = Object.assign({ 'Referer': REFERER }, init.headers || {});
  const res = await fetch(url, Object.assign({}, init, { credentials: 'include', headers }));
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(`响应非 JSON（HTTP ${res.status}）：${url}`);
  }
  return data;
}

// 取 csrf（bili_jct cookie），未登录时返回空串
export async function getCsrf() {
  try {
    const c = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'bili_jct' });
    return c ? c.value : '';
  } catch (_) {
    return '';
  }
}

// 登录态校验：code==0 且 data.isLogin 即已登录；-101 = 未登录
export async function checkLogin() {
  const data = await biliFetchJson(NAV_URL);
  if (data && data.code === 0 && data.data && data.data.isLogin) {
    return { ok: true, uname: (data.data.uname || ''), mid: String(data.data.mid || '') };
  }
  return { ok: false, code: data ? data.code : -1, message: (data && data.message) || '' };
}

// 生成 n 个随机小写字母（-352 重试时用的哑参数，每次重新随机）
function randomLetters(n) {
  const az = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < n; i++) s += az[Math.floor(Math.random() * az.length)];
  return s;
}

// 拉一页关注动态。
// 首次不带风控哑参数；
// 遇 code==-352 时追加哑参数重试（dm_img_list / dm_img_str / dm_cover_img_str / dm_img_inter），
// 每次重试重新随机，最多重试 3 次，仍失败则把 -352 响应原样返回给调用方处理。
export async function fetchFeedPage(offset) {
  let retried = 0;
  for (;;) {
    const params = new URLSearchParams({
      timezone_offset: '-480',
      platform: 'web',
      features: 'itemOpusStyle',
      web_location: '333.1365'
    });
    if (offset) params.set('offset', String(offset));
    if (retried > 0) {
      params.append('dm_img_list', '[]');
      params.append('dm_img_str', randomLetters(2));
      params.append('dm_cover_img_str', randomLetters(2));
      params.append('dm_img_inter', JSON.stringify({ ds: [], wh: [0, 0, 0], of: [0, 0, 0] }));
    }
    const res = await biliFetchJson(`${FEED_ALL_URL}?${params.toString()}`);
    if (res && res.code === -352 && retried < 3) {
      retried++;
      continue;
    }
    return res;
  }
}

// 从一条动态（含转发递归）提取视频投稿。
// 视频判据：items[].type == "DYNAMIC_TYPE_AV"，数据在 modules.module_dynamic.major.archive，
// 作者在 modules.module_author（mid/name/pub_ts）。
// include_forward=true 时另收 DYNAMIC_TYPE_FORWARD 且 orig 为 AV 的转发源；
// 黑名单按动态作者判断（judge_mid：转发取转发者，普通投稿取本人），源作者不判断——与 Python 侧 judge_mid 同构。
export function extractVideos(item, includeForward, judgeMid) {
  const out = [];
  if (!item || typeof item !== 'object') return out;
  if (item.type === 'DYNAMIC_TYPE_AV') {
    const archive = item?.modules?.module_dynamic?.major?.archive;
    const author = item?.modules?.module_author || {};
    if (archive && archive.aid != null) {
      out.push({
        aid: String(archive.aid),
        bvid: archive.bvid || '',
        title: archive.title || '',
        duration_text: archive.duration_text || '',
        up_mid: String(author.mid || ''),
        up_name: author.name || '',
        published_at: author.pub_ts || 0,
        dynamic_id: String(item.id_str || ''),
        judge_mid: String(judgeMid != null && judgeMid !== '' ? judgeMid : (author.mid || ''))
      });
    }
  } else if (item.type === 'DYNAMIC_TYPE_FORWARD' && includeForward && item.orig) {
    // 转发：黑名单判断对象换成外层动态作者（转发者）
    const outerMid = item?.modules?.module_author?.mid;
    out.push(...extractVideos(item.orig, true,
      (outerMid != null && outerMid !== '') ? outerMid : judgeMid));
  }
  return out;
}

// 从 toview 响应 data 中提取 aid 集合（新端点 data.list[].aid；旧端点 data 直接是数组）
function aidsFromToview(data) {
  const list = Array.isArray(data) ? data : ((data && data.list) || []);
  const set = new Set();
  for (const it of list) {
    if (it && it.aid != null) set.add(String(it.aid));
  }
  return set;
}

// 取稍后再看列表 → aid 字符串集合。新端点优先，失败（网络异常/非0）降级旧端点；
// 两个端点都失败时抛错中断本轮（绝不能返回空集合，否则对账会把全部 added 误判为 user_removed）。
export async function fetchToviewAids() {
  let primary = null;
  let primaryErr = null;
  try {
    primary = await biliFetchJson(TOVIEW_WEB_URL);
    if (primary && primary.code === 0) return aidsFromToview(primary.data);
  } catch (e) {
    primaryErr = e;
  }
  try {
    const legacy = await biliFetchJson(TOVIEW_LEGACY_URL);
    if (legacy && legacy.code === 0) return aidsFromToview(legacy.data);
  } catch (_) {
    /* 旧端点也失败 */
  }
  const detail = primary
    ? `code=${primary.code} ${primary.message || ''}`
    : ((primaryErr && primaryErr.message) || '无响应');
  throw new Error(`获取稍后再看列表失败（新旧端点均异常）：${detail}`);
}

// 加入稍后再看。POST form: aid + csrf(bili_jct)。
// code 0=成功；90001=列表满(上限100)；90003=稿件已删除；
// 其余应答视为端点异常 → 降级旧端点再试一次，两个都无业务应答时返回最后一次结果。
export async function addToView(aid, csrf) {
  const body = new URLSearchParams({ aid: String(aid), csrf: csrf || '' }).toString();
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  };
  const BUSINESS_CODES = new Set([0, 90001, 90003]);
  let primary = null;
  let primaryErr = null;
  try {
    primary = await biliFetchJson(ADD_WEB_URL, init);
    if (primary && BUSINESS_CODES.has(primary.code)) return primary;
  } catch (e) {
    primaryErr = e;
  }
  try {
    const legacy = await biliFetchJson(ADD_LEGACY_URL, init);
    if (legacy && BUSINESS_CODES.has(legacy.code)) return legacy;
    return legacy || primary || { code: -1, message: (primaryErr && primaryErr.message) || 'add 无响应' };
  } catch (e) {
    return primary || { code: -1, message: (primaryErr && primaryErr.message) || e.message };
  }
}
