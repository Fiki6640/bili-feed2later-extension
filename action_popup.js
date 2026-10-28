// action_popup.js —— 工具栏弹窗：快捷开关 / 立即检查 / 状态信息 / 打开设置。
// “立即检查”通过消息交给后台 SW 执行：弹窗中途关闭也不会打断检查；
// 与定时轮次共用同一流水线（防重入），手动触发不受活跃时段限制（与 options 页行为一致）。

import { loadState, getSettings, saveSettings, countByStatus } from './lib/store.js';
import { checkLogin, fetchVideoOwner } from './lib/api.js';

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
    `已见 ${c.seen} · 已加入 ${c.added}\n移除 ${c.user_removed} · 删除 ${c.api_deleted} · 失败 ${c.add_failed}`;

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

// ---------- 快速拉黑当前播放页 UP ----------
// 仅 B站播放页展示：从 tab.url 提取 bvid → view 接口拿 owner{mid,name} → 写入黑名单。
// 支持两种页面形态：普通播放页 /video/BVxxx，稍后再看等列表播放页 /list/watchlater/?bvid=BVxxx。
// host_permissions 含 *.bilibili.com，bilibili 页面的 tab.url 无需 "tabs" 权限即可读到。
async function initCurUp() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    return;
  }
  const url = String((tab && tab.url) || '');
  const m = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i)
         || url.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
  if (!m) return;  // 非播放页：整块保持隐藏
  const sec = $('curSec');
  const nameEl = $('cur_up_name');
  const btn = $('ban_cur');
  const msg = $('cur_msg');
  sec.hidden = false;

  let owner = null;
  try {
    owner = await fetchVideoOwner(m[1]);
  } catch (_) { /* 网络异常按识别失败处理 */ }
  if (!owner) {
    nameEl.textContent = '未能识别（稿件不可见或接口异常）';
    return;
  }
  nameEl.textContent = `${owner.name}（${owner.mid}）`;

  const isBanned = async () => {
    const s = await getSettings();
    return (s.blacklist || []).map(String).includes(owner.mid);
  };
  const render = async () => {
    if (await isBanned()) {
      btn.hidden = true;
      msg.innerHTML = '<span class="banned-tag">已在黑名单，新动态不再收录</span>';
    } else {
      btn.hidden = false;
      msg.textContent = '拉黑后该 UP 的新视频不再加入稍后再看';
    }
  };
  await render();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const s = await getSettings();
      const bl = (s.blacklist || []).map(String);
      // 写 昵称（mid） 复合条目：按 mid 匹配且自描述；已含该 mid（裸 mid 或复合）则不重复
      const pair = `${owner.name || 'UP'}（${owner.mid}）`;
      const hasMid = bl.some(x => x === owner.mid ||
        new RegExp(`^[\\s\\S]*[（(]${owner.mid}[）)]$`).test(x));
      if (!hasMid && !bl.includes(owner.name)) bl.push(pair);
      s.blacklist = bl;
      await saveSettings(s);
      // 记忆 mid→昵称，设置页黑名单 chips 才能显示为 昵称（uid）
      try {
        const st = await chrome.storage.local.get('bl_names');
        const names = (st && st.bl_names) || {};
        if (owner.name) names[owner.mid] = owner.name;
        await chrome.storage.local.set({ bl_names: names });
      } catch (_) { /* 展示用，失败不阻塞 */ }
      await render();
      $('msg').textContent = `已拉黑 ${owner.name}（${owner.mid}），下一轮起生效。`;
    } catch (e) {
      $('msg').textContent = `拉黑失败：${e.message}`;
    }
    btn.disabled = false;
  });
}

initSwitch();
refreshStatus();
initCurUp();
