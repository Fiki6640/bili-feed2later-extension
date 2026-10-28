// notify.js —— 通知渠道：飞书(含 HMAC-SHA256 签名) / Telegram / Bark / 自定义 webhook
// 消息格式与 PLAN §8 一致（纯文本）。任何渠道失败只 console.warn，绝不影响主流程。

function twoPad(n) {
  return String(n).padStart(2, '0');
}

// 汇总消息（纯文本，适配 TG/Bark/飞书）：
// 🎬 bilifeed2later · 10-23 14:00
// 新增 3 条稍后再看：
// 1.【UP名】视频标题（12:34）
//    https://www.bilibili.com/video/BVxxxx
export function formatSummaryText(items, runAt) {
  const d = runAt ? new Date(runAt) : new Date();
  const lines = [
    `🎬 bilifeed2later · ${twoPad(d.getMonth() + 1)}-${twoPad(d.getDate())} ${twoPad(d.getHours())}:${twoPad(d.getMinutes())}`,
    `新增 ${items.length} 条稍后再看：`
  ];
  items.forEach((v, i) => {
    const dur = v.duration_text ? `（${v.duration_text}）` : '';
    lines.push(`${i + 1}.【${v.up_name}】${v.title}${dur}`);
    lines.push(`   https://www.bilibili.com/video/${v.bvid || 'av' + v.aid}`);
  });
  return lines.join('\n');
}

// 当前配置了哪些渠道
export function configuredChannels(settings) {
  const n = (settings && settings.notify) || {};
  const ch = [];
  if (n.feishu_webhook) ch.push('feishu');
  if (n.telegram_token && n.telegram_chat_id) ch.push('telegram');
  if (n.bark_key) ch.push('bark');
  if (n.custom_webhook) ch.push('custom');
  return ch;
}

// 飞书签名：stringToSign = `${timestamp}\n${secret}`，以其为 HMAC-SHA256 密钥、空串为消息，结果 base64
async function feishuSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(stringToSign),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
  let bin = '';
  for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 飞书：允许填完整 webhook URL 或仅 hook token
function buildFeishuUrl(webhook) {
  if (/^https?:\/\//i.test(webhook)) return webhook;
  return `https://open.feishu.cn/open-apis/bot/v2/hook/${webhook}`;
}

async function sendFeishu(n, text) {
  const body = { msg_type: 'text', content: { text } };
  if (n.feishu_secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = String(timestamp); // 飞书要求字符串秒
    body.sign = await feishuSign(n.feishu_secret, timestamp);
  }
  const res = await fetch(buildFeishuUrl(n.feishu_webhook), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`feishu HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (data && typeof data.code === 'number' && data.code !== 0) {
    throw new Error(`feishu code=${data.code} ${data.msg || ''}`);
  }
}

async function sendTelegram(n, text) {
  const res = await fetch(`https://api.telegram.org/bot${n.telegram_token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: n.telegram_chat_id, text })
  });
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  if (data && data.ok === false) throw new Error(`telegram: ${data.description || '发送失败'}`);
}

async function sendBark(n, title, bodyText) {
  let host = (n.bark_host || 'api.day.app').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const url = new URL(
    `https://${host}/${n.bark_key.trim()}/${encodeURIComponent(title)}/${encodeURIComponent(bodyText)}`
  );
  // bark-server 标准扩展参数：有值才携带（options 页可配）
  const optional = {
    sound: n.bark_sound,
    level: n.bark_level,
    group: n.bark_group,
    icon: n.bark_icon
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v && String(v).trim()) url.searchParams.set(k, String(v).trim());
  }
  if (n.bark_call) url.searchParams.set('call', '1');
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`bark HTTP ${res.status}`);
}

async function sendCustom(n, title, bodyText, items) {
  const res = await fetch(n.custom_webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body: bodyText, items })
  });
  if (!res.ok) throw new Error(`custom HTTP ${res.status}`);
}

// 通知失败只记 warn 的包装
const warn = (ch) => (e) => console.warn(`[bilifeed2later] 通知渠道 ${ch} 发送失败:`, e);

async function sendToAll(settings, title, text, items) {
  const n = (settings && settings.notify) || {};
  const jobs = [];
  if (n.feishu_webhook) jobs.push(sendFeishu(n, text).catch(warn('feishu')));
  if (n.telegram_token && n.telegram_chat_id) jobs.push(sendTelegram(n, text).catch(warn('telegram')));
  if (n.bark_key) jobs.push(sendBark(n, title, text).catch(warn('bark')));
  if (n.custom_webhook) jobs.push(sendCustom(n, title, text, items).catch(warn('custom')));
  await Promise.all(jobs);
}

// 每轮汇总通知（added_cnt>0 时调用）
export async function sendSummary(settings, items, runAt) {
  const text = formatSummaryText(items, runAt);
  await sendToAll(settings, 'bilifeed2later', text, items);
}

// 异常告警
export async function sendError(settings, title, detail) {
  await sendToAll(settings, title, `${title}\n${detail}`, []);
}

// options 页“测试”按钮用：向指定渠道发一条测试消息
export async function sendTest(settings, channel) {
  const n = (settings && settings.notify) || {};
  const text = 'bilifeed2later 测试通知：该渠道配置成功。';
  switch (channel) {
    case 'feishu':
      return sendFeishu(n, text);
    case 'telegram':
      return sendTelegram(n, text);
    case 'bark':
      return sendBark(n, 'bilifeed2later', text);
    case 'custom':
      return sendCustom(n, 'bilifeed2later', text, []);
    default:
      throw new Error(`未知渠道：${channel}`);
  }
}
