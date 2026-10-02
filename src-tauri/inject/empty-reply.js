/* 空正文兜底：这一轮"她什么都没说"时，至少补一句可读的回答
 *
 * 【为什么需要这一层】
 * 实测（2026-10-01）：工具调用成功、结果也回灌了，但**她的回复正文是空的**
 * —— SSE 到了、`<ds_safety>` 之类的标记也在，`parseSseText` 却解不出正文。
 * 而下游全是 `if (answer)` 判断，于是整轮"看似什么都没发生"：聊天里只剩一个工具块，
 * 主人只会得出"这东西不太行"的结论，而日志里连一行线索都没有。
 *
 * 现在：inject.js 在正文为空时会调这里。这里做两件事：
 *   ① 把"空正文 + 当时用的输入"记进日志（这是判定"模型没回"还是"我们没解出来"的唯一线索）
 *   ② 如果这一轮本来是**在等工具结果**（哨兵在 prompt 里），就走隐藏会话补一次问答，
 *      把答案写进日志 —— 不进聊天窗口，但总比彻底没有强。
 *
 * 【成本】兜底只在"正文为空"时触发（正常轮次一次都不花），且受当日额度约束。
 */
(function (root) {
  'use strict';

  var SENTINEL = '【工具结果 · ';
  /** 同一会话短时间内不重复兜底：空正文常常连着来好几轮，别把额度烧在这上面 */
  var lastFallbackAt = Object.create(null);
  var MIN_GAP_MS = 20_000;

  function log(msg) {
    try {
      if (typeof root.__DSC_LOG__ === 'function') root.__DSC_LOG__(msg);
    } catch (e) {
      /* ignore */
    }
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  async function onEmptyReply(p) {
    var o = p || {};
    var sid = String(o.sessionId || '(无会话)');
    log(
      'EMPTY-REPLY session=' + sid.slice(0, 8) +
        ' userPrompt=' + JSON.stringify(clip(o.userPrompt, 80)),
    );

    var wasToolTurn = String(o.userPrompt || '').indexOf(SENTINEL) >= 0;
    if (!wasToolTurn) {
      // 普通轮次空正文：只记一笔（可能是模型真的什么都没说，也可能是帧格式变了）
      log('EMPTY-REPLY 非工具轮次，只记不补');
      return { ok: false, reason: 'not-tool-turn' };
    }

    var now = Date.now();
    if (lastFallbackAt[sid] && now - lastFallbackAt[sid] < MIN_GAP_MS) {
      log('EMPTY-REPLY 距上次兜底不到 ' + Math.round(MIN_GAP_MS / 1000) + ' 秒，跳过（防烧额度）');
      return { ok: false, reason: 'too-soon' };
    }
    lastFallbackAt[sid] = now;

    var util = root.__DSC_DS_UTIL__;
    if (!util || typeof util.ask !== 'function') {
      log('EMPTY-REPLY 没有可用的旁路通道（deepseek-client.ask 不在）');
      return { ok: false, reason: 'no-client' };
    }

    var ask =
      '（这是一次工具结果的兜底问答。上面那条消息里带了工具结果，但你的回复是空的。' +
      '请**直接用两三句话回答主人的问题**，不要再输出任何 dsc-tool 块。）\n\n' +
      clip(o.userPrompt, 8000);
    try {
      var r = await util.ask('judge', ask);
      var text = r && r.text ? String(r.text).trim() : '';
      if (text) {
        log('EMPTY-REPLY 兜底成功：' + clip(text, 500));
        return { ok: true, text: text };
      }
      log('EMPTY-REPLY 兜底也拿到空回复（旁路通道同样没内容 → 更像是上游/网络问题）');
      return { ok: false, reason: 'fallback-empty' };
    } catch (e) {
      log('EMPTY-REPLY 兜底失败：' + (e && e.message ? e.message : e));
      return { ok: false, reason: 'fallback-error' };
    }
  }

  root.__DSC_ON_EMPTY_REPLY__ = onEmptyReply;
  root.__DSC_EMPTY_REPLY_STATE__ = {
    lastAt: lastFallbackAt,
    minGapMs: MIN_GAP_MS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
