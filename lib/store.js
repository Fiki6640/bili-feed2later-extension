// store.js —— chrome.storage.local 状态存储
// 结构：{ videos: {[aid]: video}, kv: {baseline_done,last_run_at,last_run_result}, settings: {...} }
// SW 无状态，全部读写走 chrome.storage.local（MV3 回调/返回值均支持 Promise 写法）。

// 默认设置（options 页与流水线均以此为准；deep merge 保证旧版本存量数据可平滑升级）
const DEFAULT_SETTINGS = {
  enabled: true,                        // 总开关
  active_hours: { start: 8, end: 22 },  // 活跃时段（本地时间，[start, end) 判定，默认白天 8-22 点）
  interval_hours: 2,                    // 轮询间隔（小时），默认每 2 小时一轮
  include_forward: false,               // 转发动态中的视频是否收录
  first_run_add: false,                 // 首次运行是否跳过基线直接回填添加
  dry_run: false,                       // 试运行：不调写接口，仅 console.log 将执行的动作
  max_pages: 3,                         // 每轮最多翻页数
  blacklist: [],                        // UP 黑名单
  notify_on_error: true,                // 出现异常时发告警
  notify: {
    feishu_webhook: '',                 // 飞书群机器人 webhook（完整 URL 或 hook token）
    feishu_secret: '',                  // 飞书签名校验 secret（可选）
    telegram_token: '',                 // Telegram Bot Token
    telegram_chat_id: '',               // Telegram chat_id
    bark_host: '',                      // Bark 服务器 host（留空用官方 api.day.app）
    bark_key: '',                       // Bark device key
    bark_sound: '',                     // 铃声（如 bell，留空用默认）
    bark_level: '',                     // 通知级别 active/timeSensitive/passive（留空默认）
    bark_group: 'bilifeed2later',       // 分组（Bark App 历史按此归组）
    bark_icon: '',                      // 自定义图标 URL
    bark_call: false,                   // 持续响铃（call=1，慎用）
    custom_webhook: ''                  // 自定义 webhook，POST JSON {title, body, items}
  }
};

// 深合并：以默认值为底，覆盖存量配置；未知字段保留（前向兼容）
function mergeSettings(stored) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored)) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
    ) {
      Object.assign(out[k], v); // 嵌套对象（active_hours / notify）逐字段合并
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 读取完整状态（videos / kv / settings），缺失字段给安全默认值
export async function loadState() {
  const raw = await chrome.storage.local.get(null);
  return {
    videos: raw.videos && typeof raw.videos === 'object' ? raw.videos : {},
    kv: raw.kv && typeof raw.kv === 'object' ? raw.kv : {},
    settings: mergeSettings(raw.settings)
  };
}

export async function getSettings() {
  const raw = await chrome.storage.local.get('settings');
  return mergeSettings(raw.settings);
}

// 全量覆盖保存 settings（options 页基于已存对象修改后整体写回）
export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

export async function saveVideos(videos) {
  await chrome.storage.local.set({ videos });
}

export async function saveKv(kv) {
  await chrome.storage.local.set({ kv });
}

// 重置基线：清空全部视频状态并清除 baseline_done 标记（保留 settings 与 last_run_at）
export async function resetVideosAndBaseline() {
  await chrome.storage.local.remove('videos');
  const raw = await chrome.storage.local.get('kv');
  const kv = (raw && raw.kv) || {};
  delete kv.baseline_done;
  await chrome.storage.local.set({ kv });
}

// 各状态视频计数（status ∈ seen/added/user_removed/api_deleted/add_failed）
export function countByStatus(videos) {
  const c = { seen: 0, added: 0, user_removed: 0, api_deleted: 0, add_failed: 0 };
  for (const row of Object.values(videos || {})) {
    if (row && row.status in c) c[row.status]++;
  }
  return c;
}
