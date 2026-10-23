// pipeline.js —— 核心流水线
// 1.登录校验 → 2.基线 → 3.翻页拉动态+黑名单分拣 → 4.取稍后再看列表
// → 5.逐条添加(0/90003/90001/其他) → 6.对账(user_removed) → 7.通知 → 8.写 kv + badge

import {
  checkLogin, fetchFeedPage, extractVideos, fetchToviewAids, addToView, getCsrf
} from './api.js';
import { loadState, saveVideos, saveKv } from './store.js';
import { sendSummary, sendError } from './notify.js';

// add_failed 最大重试轮数
const ADD_FAIL_RETRY_MAX = 3;

// 防重入标志：仅同一 SW 生命周期内生效（SW 本身无状态，跨生命周期的并发由浏览器调度规避）
let running = false;

export async function runPipeline() {
  if (running) return { ok: false, skipped: 'running', error: '上一轮尚未结束' };
  running = true;
  try {
    return await runPipelineInner();
  } finally {
    running = false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function setBadge(text) {
  // badge：异常/未登录显示 "!"，正常显示本轮新增数；红色底便于察觉
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#d9534f' });
    return chrome.action.setBadgeText({ text });
  } catch (_) {
    return Promise.resolve();
  }
}

function makeVideo(v, status, addedAt) {
  return {
    aid: v.aid,
    bvid: v.bvid || '',
    title: v.title || '',
    up_mid: v.up_mid || '',
    up_name: v.up_name || '',
    duration_text: v.duration_text || '',
    published_at: v.published_at || 0,
    dynamic_id: v.dynamic_id || '',
    first_seen_at: nowIso(),
    added_at: addedAt || '',
    status,
    fail_count: 0
  };
}

// 更新或插入：保留已有行的 first_seen_at / fail_count（重试不重置计数）
function upsertVideo(videos, v, status, addedAt) {
  const prev = videos[v.aid];
  if (prev) {
    Object.assign(prev, {
      bvid: v.bvid || prev.bvid,
      title: v.title || prev.title,
      up_mid: v.up_mid || prev.up_mid,
      up_name: v.up_name || prev.up_name,
      duration_text: v.duration_text || prev.duration_text,
      published_at: v.published_at || prev.published_at,
      dynamic_id: v.dynamic_id || prev.dynamic_id,
      status
    });
    if (addedAt) prev.added_at = addedAt;
    return prev;
  }
  const row = makeVideo(v, status, addedAt);
  videos[v.aid] = row;
  return row;
}

// 翻页拉动态并提取视频。终止条件：
//   (a) 页内出现库中已有的 dynamic_id 或 aid（该页仍完整处理，避免漏掉同页更新的视频）
//   (b) has_more=false
//   (c) 达到 settings.max_pages
async function collectFeedVideos(settings, videos) {
  const knownAids = new Set(Object.keys(videos));
  const knownDyn = new Set();
  for (const row of Object.values(videos)) {
    if (row && row.dynamic_id) knownDyn.add(String(row.dynamic_id));
  }
  const out = [];
  const seenAids = new Set();
  let offset = '';
  let hitKnown = false;
  const maxPages = Math.max(1, settings.max_pages || 3);
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchFeedPage(offset || undefined);
    if (!res || res.code !== 0) {
      throw new Error(`拉取关注动态失败 code=${res ? res.code : '?'} ${(res && res.message) || ''}`);
    }
    const items = (res.data && res.data.items) || [];
    for (const item of items) {
      for (const v of extractVideos(item, !!settings.include_forward)) {
        if (knownAids.has(v.aid) || knownDyn.has(String(v.dynamic_id))) hitKnown = true;
        if (!seenAids.has(v.aid)) {
          seenAids.add(v.aid);
          out.push(v);
        }
      }
    }
    if (hitKnown) break;
    if (!(res.data && res.data.has_more)) break;
    offset = (res.data && res.data.offset) || '';
    if (!offset) break;
  }
  return out;
}

// 收尾：写 kv.last_run_at / last_run_result，落盘 videos
async function finish(state, result) {
  state.kv.last_run_at = nowIso();
  state.kv.last_run_result = {
    ok: !!result.ok,
    added_cnt: result.added_cnt || 0,
    new_cnt: result.new_cnt || 0,
    error: result.error || '',
    at: state.kv.last_run_at
  };
  await saveVideos(state.videos);
  await saveKv(state.kv);
}

async function runPipelineInner() {
  const startedAt = new Date();
  const state = await loadState();
  const settings = state.settings;
  const result = { ok: true, new_cnt: 0, added_cnt: 0, error: '' };
  const errors = [];      // 告警内容聚合（列表满 / 添加失败等）
  const addedItems = [];  // 本轮成功加入的视频（汇总通知用）

  try {
    if (!settings.enabled) {
      result.skipped = 'disabled'; // 总开关关闭，静默跳过
      return result;
    }

    // ---- 1. 登录校验（nav，code==0 且 isLogin；-101=未登录）----
    const login = await checkLogin();
    if (!login.ok) {
      result.ok = false;
      result.error = `B站登录态失效（code=${login.code}），请在浏览器中登录B站后重试`;
      await setBadge('!');
      if (settings.notify_on_error) {
        await sendError(settings, 'bilifeed2later 登录失效', result.error + '\n请打开 bilibili.com 重新登录。');
      }
      await finish(state, result);
      return result;
    }

    // ---- 2. 基线（首次运行只建基线不回填；first_run_add=true 时跳过基线）----
    if (!state.kv.baseline_done && !settings.first_run_add) {
      const vids = await collectFeedVideos(settings, {}); // 空库 → 拉满 max_pages 页
      for (const v of vids) state.videos[v.aid] = makeVideo(v, 'seen');
      state.kv.baseline_done = true;
      result.new_cnt = vids.length;
      result.baseline = true;
      await setBadge('');
      await finish(state, result);
      return result;
    }

    // ---- 3. 翻页拉动态 + 黑名单分拣 ----
    const collected = await collectFeedVideos(settings, state.videos);
    let newCnt = 0;
    const candidates = [];
    const blacklist = new Set((settings.blacklist || []).map(String));
    for (const v of collected) {
      const judgeMid = (v.judge_mid != null && v.judge_mid !== '') ? v.judge_mid : v.up_mid;
      if (blacklist.has(String(judgeMid))) {
        // 命中黑名单：不添加、不通知，仅记 seen（不覆盖库中已有状态；按动态作者判断，转发源作者不判断）
        if (!state.videos[v.aid]) {
          state.videos[v.aid] = makeVideo(v, 'seen');
          newCnt++;
        }
        console.log(`[bilifeed2later] 跳过黑名单UP ${v.up_name}(${judgeMid})《${v.title}》`);
        continue;
      }
      candidates.push(v);
    }

    // ---- 4. 取稍后再看列表（aid 集合）----
    const wl = await fetchToviewAids();

    // ---- 5. 逐条处理候选视频 ----
    let listFull = false; // 90001 中断标志
    for (const v of candidates) {
      const existing = state.videos[v.aid];
      const isNew = !existing;
      // 库中已有：仅 add_failed 且未达重试上限的可再试；其余（seen/added/终态）永不重复添加
      const retryable = !!existing &&
        existing.status === 'add_failed' &&
        (existing.fail_count || 0) < ADD_FAIL_RETRY_MAX;
      if (existing && !retryable) continue;
      if (listFull) {
        // 90001 之后：剩余全部记 seen（含当前条），等用户清理列表后的下一轮再试
        if (!existing) upsertVideo(state.videos, v, 'seen');
        continue;
      }

      // 在稍后再看但不在库 → 视为手动加过，直接记 added（added_at=now）
      if (wl.has(v.aid)) {
        if (!existing) {
          upsertVideo(state.videos, v, 'added', nowIso());
          result.added_cnt++;
          newCnt++;
        }
        continue;
      }

      // dry-run：不调写接口，只打印将执行的动作
      if (settings.dry_run) {
        console.log(`[bilifeed2later][dry-run] 将添加稍后再看: aid=${v.aid}【${v.up_name}】${v.title}`);
        continue;
      }

      const csrf = await getCsrf();
      const res = await addToView(v.aid, csrf);
      if (res.code === 0) {
        upsertVideo(state.videos, v, 'added', nowIso());
        addedItems.push(v);
        result.added_cnt++;
        if (isNew) newCnt++;
      } else if (res.code === 90003) {
        upsertVideo(state.videos, v, 'api_deleted'); // 稿件已删除，终态
        if (isNew) newCnt++;
      } else if (res.code === 90001) {
        listFull = true;
        errors.push('稍后再看列表已满（上限100），请手动清理后再试');
        upsertVideo(state.videos, v, 'seen');
        if (isNew) newCnt++;
      } else {
        // 其他失败：add_failed 且 fail_count++；fail_count>=3 后不再重试
        const row = upsertVideo(state.videos, v, 'add_failed');
        row.fail_count = (row.fail_count || 0) + 1;
        errors.push(`添加失败 aid=${v.aid}《${v.title}》code=${res.code} ${res.message || ''}（第 ${row.fail_count} 次）`);
        if (isNew) newCnt++;
      }
    }
    result.new_cnt = newCnt;

    // ---- 6. 对账（关键：满足“用户移除后永不再加”）----
    // 只对“本轮开始前已加入”的行对账（added_at < 本轮开始时间），避免刚加的因列表同步延迟被误判。
    // dry-run 时对账只模拟打印、不落盘。
    const startMs = startedAt.getTime();
    for (const [aid, row] of Object.entries(state.videos)) {
      if (row.status !== 'added' || !row.added_at) continue;
      const addedMs = Date.parse(row.added_at);
      if (!(addedMs < startMs)) continue;
      if (!wl.has(aid)) {
        if (settings.dry_run) {
          console.log(`[bilifeed2later][dry-run] 对账：aid=${aid}《${row.title}》已不在稍后再看，将标记 user_removed`);
        } else {
          row.status = 'user_removed'; // 终态，永不再添加
          console.log(`[bilifeed2later] 对账：aid=${aid}《${row.title}》已被移除，标记 user_removed`);
        }
      }
    }

    // ---- 7. 通知 ----
    if (addedItems.length > 0) {
      await sendSummary(settings, addedItems, startedAt);
    }
    if (errors.length > 0 && settings.notify_on_error) {
      await sendError(settings, 'bilifeed2later 告警', errors.join('\n'));
    }

    // ---- 8. badge + 写 kv ----
    await setBadge(result.added_cnt > 0 ? String(result.added_cnt) : '');
    await finish(state, result);
    return result;
  } catch (e) {
    // 网络异常 / 接口风控重试耗尽 / 列表拉取失败等 → 告警并结束本轮
    result.ok = false;
    result.error = (e && e.message) ? e.message : String(e);
    console.error('[bilifeed2later] 本轮执行异常', e);
    try { await setBadge('!'); } catch (_) { /* ignore */ }
    try {
      if (settings.notify_on_error) await sendError(settings, 'bilifeed2later 执行异常', result.error);
      await finish(state, result);
    } catch (e2) {
      console.error('[bilifeed2later] 收尾失败', e2);
    }
    return result;
  }
}
