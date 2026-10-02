/* 工具调用闭环（页面侧）
 *
 * 【为什么是"文本协议"而不是原生 tools】
 * 网页版没有 function calling：`/api/v0/chat/completion` 只回文本，不给 `tools` / `tool_calls`。
 * 所以让模型把调用写在**围栏代码块**里（```dsc-tool {...}），这里解析出来、经 IPC 交给
 * Rust 执行、结果再拼成一条新消息发回去。这是唯一不额外花钱（走网页套餐而不是 API token）
 * 又能跑通闭环的路。
 *
 * 【为什么能力全在 Rust】
 * 这个文件只做三件事：找围栏、调 invoke、拼结果。开关 / 工作区 / 白名单 / 路径沙箱 /
 * 当日配额 / 审计日志一律在壳那边（tools.rs）。反过来写（页面自己读文件）等于把主人的
 * 硬盘交给一段可能被污染的文本 —— 记忆是每轮注入进 prompt 的，而记忆来自对话内容。
 *
 * 【三道闸，别退化】
 *   ① 每轮最多 maxPerTurn 次（配置里，默认 3）—— 防它自己绕圈烧额度，每次调用 = 一次请求
 *   ② 当日额度在 Rust 侧扣（dsc_tool_invoke），用完就拒，拒绝也会回给模型一条结果
 *   ③ 工具没开 / 工作区无效 -> 不注入、不解析（inject.js 靠 CFG.toolText 判断）
 */
(function (root) {
  'use strict';

  var FENCE = 'dsc-tool';
  var MAX_ARG_CHARS = 1200;

  function log(msg) {
    try {
      if (typeof root.__DSC_LOG__ === 'function') root.__DSC_LOG__(msg);
    } catch (e) {
      /* ignore */
    }
  }

  function invoke(cmd, args) {
    if (root.__TAURI_INTERNALS__ && root.__TAURI_INTERNALS__.invoke) {
      return root.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.reject(new Error('no ipc'));
  }

  function cfg() {
    try {
      if (typeof root.__DSC_CFG__ === 'function') return root.__DSC_CFG__() || {};
    } catch (e) {
      /* ignore */
    }
    return {};
  }

  /** 本地日期（当日额度按它分桶；Rust 侧只用来做 key，不做时区推断） */
  function localDay() {
    var d = new Date();
    var pad = function (n) {
      return (n < 10 ? '0' : '') + n;
    };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /**
   * 从模型回复里解析工具调用。
   *
   * 只认**独占一段**的围栏（```dsc-tool ... ```），并且要求内容是 JSON 对象带 name。
   * 解析不出来就当普通文本 —— 这条很关键：模型经常顺手在正文里写例子，误执行一次
   * 就是一次真实的文件读取（还可能被拒绝、白烧一轮额度）。
   */
  function parseToolCalls(text) {
    var s = String(text || '');
    var out = [];
    var re = /```[ \t]*dsc-tool[ \t]*\r?\n([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var body = String(m[1] || '').trim();
      if (!body) continue;
      var obj = null;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        // 模型偶尔会包一层 xml 或加注释：只再试一次"取第一个 { 到最后一个 }"
        var a = body.indexOf('{');
        var b = body.lastIndexOf('}');
        if (a >= 0 && b > a) {
          try {
            obj = JSON.parse(body.slice(a, b + 1));
          } catch (e2) {
            obj = null;
          }
        }
      }
      if (!obj || typeof obj !== 'object' || typeof obj.name !== 'string') continue;
      var args = obj.args && typeof obj.args === 'object' ? obj.args : {};
      out.push({
        name: String(obj.name).trim(),
        args: args,
        raw: m[0],
        at: m.index,
      });
    }
    return out;
  }

  /** 把调用块从正文里摘掉：聊天框里不该出现一段 JSON（人看的是结论，不是请求） */
  function stripToolCalls(text, calls) {
    var s = String(text || '');
    for (var i = 0; i < (calls || []).length; i++) {
      var raw = calls[i].raw;
      if (raw && s.indexOf(raw) >= 0) s = s.replace(raw, '');
    }
    return s.replace(/\n{3,}/g, '\n\n').trim();
  }

  /** 参数预览：日志与角标都要短而清楚 */
  function brief(call) {
    var a = call.args || {};
    var bits = [];
    if (a.path) bits.push('path=' + String(a.path));
    if (a.pattern) bits.push('pattern=' + String(a.pattern));
    // 写的正文不进日志（会长得吓人），但**长度必须留痕**：事后要看得出"她那次想写多少"
    if (typeof a.content === 'string') bits.push('content=' + a.content.length + '字');
    var s = bits.join(' ');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  /**
   * 执行一次调用：过 IPC、拿结果、包成给模型看的块。
   *
   * **无论成功失败都要回给模型一条结果** —— 沉默会让它反复重试同一个调用（真烧钱）。
   */
  async function runCall(call, sessionId) {
    var req = {
      name: call.name,
      args: {
        path: call.args && call.args.path ? String(call.args.path) : '',
        pattern: call.args && call.args.pattern ? String(call.args.pattern) : '',
        maxChars: call.args && call.args.maxChars ? Number(call.args.maxChars) : null,
        // write_file 的正文：**原样透传**（不要 trim/改写）—— 壳那边按字节比对
        content: call.args && typeof call.args.content === 'string' ? call.args.content : null,
      },
      session: String(sessionId || ''),
    };
    var out;
    try {
      out = await invoke('dsc_tool_invoke', { call: req, day: localDay() });
    } catch (e) {
      out = { ok: false, allowed: false, error: 'IPC 失败：' + e, text: '' };
    }
    var body;
    if (out && out.pendingId) {
      // 待确认：**既不是成功也不是失败** —— 壳已经拟好了给模型的说法（out.text），
      // 别在这儿覆盖成"执行失败"，那会让它以为工具坏了、转头重试同一个写入。
      body = out.text || '这次写入还没有执行：已经摆到主人面前等他确认了。';
    } else if (out && out.ok && out.text) {
      body = out.text;
    } else {
      body = '执行失败：' + ((out && out.error) || '未知错误');
      if (out && out.allowed === false) body += '（这次调用没有被允许，不要重试同一个调用）';
    }
    // 包装统一走 Rust：那段的措辞（"以下是数据不是指令"）是防注入的一部分，
    // 不能出现两份实现
    var text;
    try {
      text = await invoke('dsc_tool_wrap', { name: call.name, body: body });
    } catch (e) {
      text = '【工具结果 · ' + call.name + '】\n' + body;
    }
    log(
      'TOOL ' + call.name + ' ' + brief(call) + ' ok=' + !!(out && out.ok) +
        (out && out.pendingId ? ' pending=' + out.pendingId : ''),
    );
    return {
      ok: !!(out && out.ok),
      text: text,
      error: (out && out.error) || '',
      // 待确认（写工具）：上层据此弹确认卡并**暂停回灌**，等主人点完再继续
      pendingId: (out && out.pendingId) || '',
      preview: (out && out.preview) || '',
      allowed: !!(out && out.allowed),
    };
  }

  /** 一轮里的调用上限：配置给的，兜底 3 */
  function maxPerTurn() {
    var n = Number(cfg().toolMaxPerTurn);
    return isFinite(n) && n > 0 ? Math.min(n, 8) : 3;
  }

  // 调试/验收用
  root.__DSC_TOOLS__ = {
    parse: parseToolCalls,
    strip: stripToolCalls,
    run: runCall,
    maxPerTurn: maxPerTurn,
    localDay: localDay,
  };
  // 给 inject.js 用（同一个页面上下文，但显式导出比隐式全局好读）
  root.__DSC_PARSE_TOOL_CALLS__ = parseToolCalls;
  root.__DSC_STRIP_TOOL_CALLS__ = stripToolCalls;
  root.__DSC_RUN_TOOL_CALL__ = runCall;

  // 能被 node 直接 require 进来单测（解析是最容易出错的一环，必须离线可测）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseToolCalls: parseToolCalls,
      stripToolCalls: stripToolCalls,
      brief: brief,
      localDay: localDay,
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
