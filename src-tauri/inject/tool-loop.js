/* 工具调用闭环的编排（页面侧）
 *
 * 分工：
 *   tools.js    —— 解析围栏 / 调 IPC / 拼结果（"怎么调"）
 *   本文件      —— 什么时候调、调几次、结果怎么回灌（"什么时候调"）
 *
 * 【本次重写的教训（2026-10-01 实测）】
 * 第一版的回灌失败是**静默**的：日志停在 "TOOL-LOOP 回灌 read_file（第 1/3 次）"，
 * 既没有成功那行、也没有失败那行，聊天里只剩一个孤零零的工具块 —— 主人看到的是
 * "她好像不太行"。事后用 CDP 手工调 continueChat 是成功的，也就是说偶发失败被吞掉了。
 *
 * 所以这一版把三件事当成硬约束：
 *   1. **每一步都留痕**：工具执行结果、回灌开始/结束、耗时、失败原因全部写日志。
 *      远端页面出问题时，日志是唯一能看见的地方（GUI 子系统没有 stderr）。
 *   2. **永不静默失败**：任何失败都要 ①写日志 ②闪角标告诉主人（她那边看不到我们的
 *      console，角标是唯一能当场看见的反馈）。
 *   3. **超时兜底**：回灌请求最多等 N 秒。超时不代表失败（可能只是慢），但必须记一笔
 *      并让主人知道"结果已经拿到、正在等她的下一句话"，而不是永远卡在那里。
 *
 * 另外三个必须守住的不变量：
 *   · 结果里带哨兵（`【工具结果 · <名字>】`）：下一轮看到它就不再解析工具调用 ——
 *     否则模型把结果原样回给我、我回给它，无限循环烧额度。
 *   · 一轮只认第一个调用：模型偶尔一次吐两个块，顺序执行会打乱它的推理。
 *   · 回灌只带"工具说明"前缀（不带状态/记忆）：那些注入一次就够，重复拼只会越滚越长。
 */
(function (root) {
  'use strict';

  var SENTINEL = '【工具结果 · ';
  /** 回灌请求的最长等待：超了不代表失败（可能只是慢），但必须在日志里说清楚 */
  var CONTINUE_TIMEOUT_MS = 90_000;

  /** sessionId -> 本轮已经回灌了几次 */
  var turnCount = Object.create(null);
  /** 正在回灌中：防止同一会话并发回灌（会让模型收到两条交叉的上下文） */
  var inflight = Object.create(null);

  function log(msg) {
    try {
      if (typeof root.__DSC_LOG__ === 'function') root.__DSC_LOG__(msg);
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * 健康度记账。真正的对象和上报函数都在 inject.js 那边（它才有 stats / log），
   * 这里只做转发 —— 拿不到就静默跳过，体检绝不能反过来把主流程搞挂。
   */
  function hb(key, delta) {
    try {
      if (typeof root.__DSC_HEALTH_BUMP__ === 'function') root.__DSC_HEALTH_BUMP__(key, delta);
    } catch (e) {
      /* ignore */
    }
  }

  function hset(key, value) {
    try {
      if (root.__DSC_HEALTH__) root.__DSC_HEALTH__[key] = value;
    } catch (e) {
      /* ignore */
    }
  }

  /** 出故障时立刻上报（不必等 5 轮 / 60 秒的节拍） */
  function healthNow(why) {
    try {
      if (typeof root.__DSC_PUBLISH_HEALTH__ === 'function') root.__DSC_PUBLISH_HEALTH__(why);
    } catch (e) {
      /* ignore */
    }
  }

  function cfg() {
    try {
      if (typeof root.__DSC_CFG__ === 'function') return root.__DSC_CFG__() || {};
    } catch (e) {
      /* ignore */
    }
    return {};
  }

  function flash(text) {
    try {
      if (typeof root.__DSC_FLASH__ === 'function') root.__DSC_FLASH__(text);
    } catch (e) {
      /* ignore */
    }
  }

  function clip(text, max) {
    var s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function now() {
    return Date.now();
  }

  /** 这个 prompt 是不是"工具结果回灌"（哨兵出现即算） */
  function isToolResultMessage(prompt) {
    return String(prompt || '').indexOf(SENTINEL) >= 0;
  }

  function bumpTurn(sessionId) {
    var k = String(sessionId || '(无会话)');
    turnCount[k] = (turnCount[k] || 0) + 1;
    var keys = Object.keys(turnCount);
    if (keys.length > 30) delete turnCount[keys[0]];
    return turnCount[k];
  }

  function resetTurn(sessionId) {
    delete turnCount[String(sessionId || '(无会话)')];
  }

  /** 回灌时要带的前缀：只带工具说明，不重复带状态/记忆 */
  function toolPrefix() {
    try {
      var f = root.__DSC_TOOL_PREFIX__;
      return typeof f === 'function' ? String(f() || '') : '';
    } catch (e) {
      return '';
    }
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + ' 秒）'));
      }, ms);
      promise.then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /** 额度检查：没额度就别发起回灌（每次回灌都是一次请求 = 一份额度） */
  async function budgetLeft() {
    try {
      var day = root.__DSC_TOOLS__.localDay();
      var brief = await root.__TAURI_INTERNALS__.invoke('dsc_tools_brief', { day: day });
      return brief && typeof brief.leftToday === 'number' ? brief.leftToday : 99;
    } catch (e) {
      log('TOOL-LOOP 读额度失败（当作有额度继续）：' + (e && e.message ? e.message : e));
      return 99;
    }
  }

  /**
   * 主入口：captureAnswer 解析出助手回复后调它。
   *
   * @param {object} p { reply, userPrompt, sessionId, parentMessageId }
   */
  async function handleReply(p) {
    var o = p || {};
    var cfgNow = cfg();
    var tag = String(o.sessionId || '?').slice(0, 8);
    if (!cfgNow.toolText) return { ok: false, reason: '工具没开/没工作区' };
    if (!o.sessionId) return { ok: false, reason: '没有会话 id' };
    if (!o.parentMessageId) return { ok: false, reason: '没有上一条回复的 id' };

    var text = String(o.reply || '');
    if (isToolResultMessage(text)) {
      log('TOOL-LOOP 检测到回灌回声，停止（' + tag + '）');
      return { ok: false, reason: 'echo' };
    }

    var calls = root.__DSC_PARSE_TOOL_CALLS__(text);
    if (!calls.length) return { ok: false, reason: '没有调用' };

    // 体检：模型**真的吐了工具块**才算一次调用请求（能被解析出来才说明协议没写崩）
    hb('toolCalls', calls.length);
    hset('lastToolAt', now());

    var n = bumpTurn(o.sessionId);
    var maxTurn = root.__DSC_TOOLS__.maxPerTurn();
    if (n > maxTurn) {
      log('TOOL-LOOP 本轮已达上限（第 ' + n + ' 次 / 上限 ' + maxTurn + '，' + tag + '），不再执行');
      flash('工具调用已达本轮上限（' + maxTurn + '）');
      resetTurn(o.sessionId);
      hb('toolBlocked');
      healthNow('over-limit');
      return { ok: false, reason: 'over-limit' };
    }
    if (inflight[o.sessionId]) {
      log('TOOL-LOOP 上一次回灌还没结束，跳过这次（' + tag + '）');
      return { ok: false, reason: 'inflight' };
    }
    if (calls.length > 1) {
      log('TOOL-LOOP 模型一次给了 ' + calls.length + ' 个调用，只跑第一个：' + calls.map(function (c) { return c.name; }).join(','));
    }
    var call = calls[0];

    // ① 执行工具 —— 无论成败都要留痕（execute 内部已带 IPC 失败兜底）
    var t0 = now();
    flash('正在用工具：' + call.name);
    var res;
    try {
      res = await root.__DSC_RUN_TOOL_CALL__(call, o.sessionId);
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      log('TOOL-LOOP 执行异常（' + call.name + '）：' + msg);
      flash('工具执行异常（看日志）');
      return { ok: false, reason: 'run-failed', error: msg };
    }
    log(
      'TOOL-LOOP 执行完毕 ' + call.name + ' ok=' + res.ok + ' 用时 ' + (now() - t0) + 'ms' +
        (res.ok ? '' : ' err=' + clip(res.error, 120)),
    );
    hb('toolRuns');
    hset('lastToolName', String(call.name || '?'));
    if (!res.ok) {
      hb('toolFailures');
      hset('lastError', call.name + ' 执行失败：' + clip(res.error, 160));
      healthNow('tool-failed');
    }

    // ② 写工具：先把"她打算写什么"摆到主人面前，**这一轮到此为止**
    //
    // 为什么不在这儿 await 主人点击：主人可能几分钟后才回来，而回灌窗口、额度、
    // 会话上下文都是有寿命的 —— 卡在 await 上会让这一轮永远悬着。所以把上下文交给
    // 确认卡，由它点击之后走同一条 `sendBack`。
    if (res.pendingId) {
      log('TOOL-LOOP 这次改动要主人点头（' + res.pendingId + '），先不回灌');
      flash('她在等你确认改动…');
      try {
        if (typeof root.__DSC_ASK_CONFIRM__ === 'function') {
          root.__DSC_ASK_CONFIRM__({
            id: res.pendingId,
            preview: res.preview,
            name: call.name,
            ctx: {
              sessionId: o.sessionId,
              userPrompt: o.userPrompt,
              parentMessageId: o.parentMessageId,
              n: n,
              maxTurn: maxTurn,
            },
          });
        } else {
          log('TOOL-LOOP 没有确认卡组件 —— 没人能确认，这次改动搁置（提案还在，主人可以自己决定）');
          flash('确认卡不可用（看日志）');
        }
      } catch (e) {
        log('TOOL-LOOP 弹确认卡失败：' + (e && e.message ? e.message : e));
      }
      return { ok: true, reason: 'awaiting-confirm', pendingId: res.pendingId };
    }

    // ③ 只读工具：直接回灌
    return await sendBack(
      {
        sessionId: o.sessionId,
        userPrompt: o.userPrompt,
        parentMessageId: o.parentMessageId,
        n: n,
        maxTurn: maxTurn,
      },
      call.name,
      res.text,
    );
  }

  /**
   * 把一条工具结果交回给模型 —— **全项目唯一的一份回灌实现**。
   *
   * 为什么必须抽出来：只读工具是"执行完立刻回灌"，写工具是"主人点完确认才回灌"，
   * 两条路要的是同一套东西（拼词、通道选择、额度、超时、兜底）。抄一份出来就等于
   * 埋一个"以后只改一边"的坑。
   *
   * @param {object} ctx { sessionId, userPrompt, parentMessageId, n, maxTurn }
   * @param {string} name 工具名（日志与兜底问答用）
   * @param {string} wrappedText 已经包好的【工具结果】块
   */
  async function sendBack(ctx, name, wrappedText) {
    var tag = String(ctx.sessionId || '?').slice(0, 8);
    var userPrompt = String(ctx.userPrompt || '').trim();
    if (!userPrompt) {
      log('TOOL-LOOP 拿不到原始输入（lastUserPrompt 为空），这次调用白跑了');
      flash('拿不到你说的那句话，没法把结果交回去');
      return { ok: false, reason: 'no-user-prompt' };
    }
    var next =
      toolPrefix() + userPrompt + '\n\n' + wrappedText +
      '\n\n（继续：**直接用两三句话给出结论**，不要再输出任何 dsc-tool 块 —— 上面就是你要的信息。' +
      '只有当确实还缺**关键**信息时才允许再调一次。）';
    if (next.length > 12000) next = next.slice(0, 12000) + '\n…（工具结果已截断）';

    var util = root.__DSC_DS_UTIL__;
    var pageSend = root.__DSC_PAGE_SEND__;
    if ((!util || typeof util.continueChat !== 'function') && typeof pageSend !== 'function') {
      log('TOOL-LOOP 没有任何可用的回灌通道（continueChat 与 page-send 都不在）');
      flash('回灌通道不可用（看日志）');
      return { ok: false, reason: 'no-client' };
    }

    // 额度：用完就明确告诉她（别让主人以为坏了）
    var left = await budgetLeft();
    if (left <= 0) {
      log('TOOL-LOOP 今日工具额度已用完，不再回灌（' + tag + '）');
      flash('今日工具额度用完了');
      hb('toolBlocked');
      healthNow('quota');
      return { ok: false, reason: 'quota' };
    }

    // 回灌（带超时）
    //
    // 【走明路】优先用 `__DSC_PAGE_SEND__`（把内容以主人身份填进输入框发出去）：
    // 这样走的是**页面自己的发送流程**，她的回答会正常流式显示在聊天窗口里 ——
    // 这正是"她调用工具但是没看到东西"那个问题的解药。
    // 暗路（continueChat）只在明路不可用时兜底：它能拿到回答，但**页面上不显示**。
    inflight[ctx.sessionId] = true;
    var t1 = now();
    var viaPage = typeof pageSend === 'function';
    log(
      'TOOL-LOOP 回灌 ' + name + '（第 ' + ctx.n + '/' + ctx.maxTurn + ' 次，' + tag +
        '，剩 ' + left + ' 次额度，通道=' + (viaPage ? '页面' : 'API') + '）',
    );
    try {
      var r = await withTimeout(
        viaPage
          ? pageSend(next, CONTINUE_TIMEOUT_MS)
          : util.continueChat({
              sessionId: ctx.sessionId,
              parentMessageId: ctx.parentMessageId,
              prompt: next,
              userPrompt: userPrompt,
            }),
        CONTINUE_TIMEOUT_MS,
        '回灌 ' + name,
      );
      var latency = r && r.latencyMs ? r.latencyMs : now() - t1;
      log(
        'TOOL-LOOP 回灌已送达 ' + name + '（' + latency + 'ms，' + tag +
          '，她回了 ' + String((r && r.text) || '').length + ' 字' +
          (viaPage ? '，走页面通道（聊天里能看见）' : '，走 API 通道（页面上不显示）') + '）',
      );
      // 明路那一发的回复**已经是**一轮正常对话了（captureAnswer → deliverTurn 已经处理过：
      // 留档、推进状态、继续处理工具调用）。再交付一次会重复记账，所以只在暗路时交付。
      var delivered = null;
      if (!viaPage) {
        try {
          if (typeof root.__DSC_DELIVER_TURN__ === 'function') {
            delivered = root.__DSC_DELIVER_TURN__({
              reply: (r && r.text) || '',
              prompt: userPrompt,
              sessionId: ctx.sessionId,
              parentMessageId: (r && r.responseMessageId) || 0,
              via: 'tool-loop',
            });
          }
        } catch (e) {
          log('TOOL-LOOP 交付这一轮失败：' + (e && e.message ? e.message : e));
        }
      }
      flash(viaPage ? '结果已发出去，等她答' : '等她把结果说完…');
      hb('toolSends');
      healthNow('tool-sent');
      return { ok: true, called: name, delivered: delivered, via: viaPage ? 'page' : 'api' };
    } catch (e) {
      var err = e && e.message ? e.message : String(e);
      log('TOOL-LOOP 回灌失败 ' + name + '（' + (now() - t1) + 'ms）：' + err);
      // 兜底：走隐藏会话再问一次（不进当前对话，但至少给主人一个答案；
      // 隐藏会话是现成的链路，失败率低，代价是多花一次额度）
      var fallback = await fallbackAnswer(name, userPrompt, wrappedText, err);
      if (fallback) {
        flash('回灌失败，改用旁路问答（结果见日志）');
        hb('toolFallbacks');
        hset('lastError', name + ' 回灌失败（已走旁路问答）：' + clip(err, 160));
        healthNow('fallback');
        return { ok: false, reason: 'continue-failed-fallback', error: err, fallback: fallback };
      }
      flash('工具结果没能交回去（看日志）');
      hset('lastError', name + ' 回灌失败且兜底也失败：' + clip(err, 160));
      healthNow('continue-failed');
      return { ok: false, reason: 'continue-failed', error: err };
    } finally {
      delete inflight[ctx.sessionId];
    }
  }

  /**
   * 兜底：把"用户的话 + 工具结果"丢给隐藏会话问一次，把答案写进日志。
   *
   * 为什么不硬塞进当前对话：当前会话的 continueChat 刚刚就失败了，再塞一次大概率还失败；
   * 而隐藏会话（记忆整理/感知用的那条链）是独立、现成、稳定的通道。代价是那条答案不在
   * 聊天窗口里 —— 但**总比什么都没有强**，而且日志里能翻到，主人也能据此判断是偶发还是长挂。
   */
  async function fallbackAnswer(name, userPrompt, body, why) {
    try {
      var util = root.__DSC_DS_UTIL__;
      if (!util || typeof util.ask !== 'function') return '';
      var ask =
        '（这是一次工具调用的兜底问答。工具 ' + name + ' 的执行结果如下，' +
        '请基于它用两三句话回答主人的问题。）\n\n' +
        '主人的问题：' + clip(userPrompt, 500) + '\n\n' +
        clip(body, 6000) + '\n\n' +
        '（直接给结论，不要再输出任何工具调用块。）';
      var r = await withTimeout(util.ask('judge', ask), CONTINUE_TIMEOUT_MS, '兜底问答');
      var text = r && r.text ? String(r.text).trim() : '';
      if (text) {
        log('TOOL-LOOP 兜底问答成功（回灌失败原因：' + why + '）：' + clip(text, 400));
      } else {
        log('TOOL-LOOP 兜底问答拿到空回复');
      }
      return text;
    } catch (e) {
      log('TOOL-LOOP 兜底问答也失败：' + (e && e.message ? e.message : e));
      return '';
    }
  }

  // 确认卡点了"允许 / 拒绝"之后，用它把结果走同一条回灌（sendBack 是唯一实现）
  root.__DSC_SEND_BACK__ = sendBack;

  root.__DSC_TOOL_LOOP__ = {
    handleReply: handleReply,
    isToolResultMessage: isToolResultMessage,
    turnCount: function (sid) {
      return turnCount[String(sid || '(无会话)')] || 0;
    },
    isInflight: function (sid) {
      return !!inflight[String(sid || '')];
    },
    reset: resetTurn,
    toolPrefix: toolPrefix,
  };
  root.__DSC_HANDLE_TOOL_REPLY__ = handleReply;
})(typeof window !== 'undefined' ? window : globalThis);
