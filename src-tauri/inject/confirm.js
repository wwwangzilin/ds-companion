/* 写工具的确认卡：她请求改主人的文件时，把"要写什么"摆出来让主人点一下。
 *
 * 【为什么单独一个文件】它跟"解析 / 执行"没关系 —— 它管的是人机交界：
 * 卡片长什么样、点了之后怎么把结果送回 tool-loop。
 *
 * 【为什么不做成"设置里开个开关就随便写"】文件被改就可能不可逆，而调用请求的来源是
 * 模型在网页里吐的一段文本。人点的那一下，是这条链路上唯一兜得住的东西。
 *
 * 【为什么点了才回灌】主人可能几分钟后才回来，卡在 await 上会让那一轮永远悬着。
 * 所以 tool-loop 把上下文（会话 / 原始问题 / 轮次）交给这里，点完再走同一条回灌。
 * 也就是说：**卡片丢了不影响提案**（提案在壳里，设置页的工具页能看到和处理）。
 */
(function (root) {
  'use strict';

  var CARD_ID = 'dsc-confirm';
  /** 当前这张卡对应的提案（点完就清掉，防重复提交） */
  var current = null;
  var busy = false;

  function log(msg) {
    try {
      if (typeof root.__DSC_LOG__ === 'function') root.__DSC_LOG__(msg);
    } catch (e) {
      /* ignore */
    }
  }

  function flash(text) {
    try {
      if (typeof root.__DSC_FLASH__ === 'function') root.__DSC_FLASH__(text);
    } catch (e) {
      /* ignore */
    }
  }

  function invoke(cmd, args) {
    return root.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  /** 预览里可能有 `<` 之类的字符（源码！），一律当文本，别让它变成标签 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function close() {
    var el = document.getElementById(CARD_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    current = null;
    busy = false;
  }

  function mount(p) {
    close();
    current = p;
    // 三个工具的卡片只差文案，交互/安全流程完全一样。措辞要跟得上：
    // 主人看到"允许写入"却其实是要跑一条命令，那一下就点得很不踏实。
    var name = p.name || '';
    var isCmd = name === 'run_command';
    var isEdit = name === 'edit_file';
    var title = isCmd ? '她想跑一条命令' : isEdit ? '她想改一个文件' : '她想写一个文件';
    var allowLabel = isCmd ? '允许执行' : isEdit ? '允许修改' : '允许写入';
    var foot = isCmd
      ? '命令在你的工作区里跑，有超时；输出会原样交给她。'
      : '改写已有文件前会把原内容备份到 tool-trash。';
    try {
      var el = document.createElement('div');
      el.id = CARD_ID;
      el.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:152px',
        'z-index:2147483647',
        'width:330px',
        'max-width:calc(100vw - 28px)',
        'padding:12px 13px 11px',
        'border-radius:13px',
        'font:500 12px/1.5 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#efe9ff',
        'background:rgba(22,15,38,.95)',
        'border:1px solid rgba(244,114,182,.45)',
        'box-shadow:0 10px 30px rgba(60,30,120,.45)',
        'backdrop-filter:blur(12px)',
        '-webkit-backdrop-filter:blur(12px)',
      ].join(';');
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px">' +
        '<span style="color:#f472b6">✎</span>' +
        '<b style="font-size:12.5px">' + title + '</b>' +
        '<span style="margin-left:auto;opacity:.55;font-size:10.5px">需要你点头</span>' +
        '</div>' +
        '<pre style="margin:0;max-height:168px;overflow:auto;white-space:pre-wrap;word-break:break-all;' +
        'background:rgba(255,255,255,.055);border-radius:8px;padding:8px 9px;' +
        'font:400 11px/1.5 ui-monospace,Consolas,monospace;color:#ded6f5">' +
        esc(p.preview || '(没有预览)') +
        '</pre>' +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button data-dsc-act="allow" style="flex:1 1 0;padding:7px 0;border:0;border-radius:9px;' +
        'cursor:pointer;font:600 12px inherit;color:#1b1030;' +
        'background:linear-gradient(118deg,#a78bfa,#f472b6)">' + allowLabel + '</button>' +
        '<button data-dsc-act="deny" style="flex:1 1 0;padding:7px 0;border-radius:9px;cursor:pointer;' +
        'font:600 12px inherit;color:#cfc6ea;background:transparent;border:1px solid rgba(255,255,255,.22)">拒绝</button>' +
        '</div>' +
        '<div style="margin-top:7px;font-size:10.5px;opacity:.5">' + foot + '</div>';
      el.addEventListener('click', function (ev) {
        var act = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-dsc-act') : '';
        if (!act) return;
        ev.preventDefault();
        ev.stopPropagation();
        decide(act === 'allow');
      });
      // 别让点击穿透到页面（底下是聊天窗口）
      el.addEventListener('mousedown', function (ev) {
        ev.stopPropagation();
      });
      document.body.appendChild(el);
      log('CONFIRM 弹卡片 id=' + (p.id || '?'));
    } catch (e) {
      log('CONFIRM 渲染失败：' + (e && e.message ? e.message : e));
    }
  }

  /** 主人点了。把决定送进壳，再把结果**原路**交回 tool-loop 去回灌。 */
  async function decide(allow) {
    var p = current;
    if (!p || busy) return;
    busy = true;
    log('CONFIRM 主人' + (allow ? '允许' : '拒绝') + ' id=' + (p.id || '?'));

    var out = null;
    try {
      out = await invoke('dsc_tool_proposal_decide', { id: p.id, allow: allow });
    } catch (e) {
      // 壳拒绝执行（工作区没了 / 提案已被处理过 / 工具被关了）—— 如实告诉她
      out = { ok: false, error: '这次决定没能生效：' + (e && e.message ? e.message : e) };
    }
    var name = p.name || 'write_file';
    var failWord = name === 'run_command' ? '命令没有执行：' : '写入没有执行：';
    var body = out && out.ok ? out.text : failWord + ((out && out.error) || '未知原因');
    flash(
      out && out.ok
        ? name === 'run_command'
          ? '跑完了，正在告诉她'
          : name === 'edit_file'
            ? '已改好，正在告诉她'
            : '已写入，正在告诉她'
        : '这次没动',
    );
    close();

    var wrapped;
    try {
      wrapped = await invoke('dsc_tool_wrap', { name: name, body: body });
    } catch (e) {
      wrapped = '【工具结果 · ' + name + '】\n' + body;
    }
    if (typeof root.__DSC_SEND_BACK__ !== 'function') {
      log('CONFIRM 没有回灌通道（sendBack 不在）—— 写入结果没能交给她');
      return;
    }
    try {
      await root.__DSC_SEND_BACK__(p.ctx || {}, name, wrapped);
    } catch (e) {
      log('CONFIRM 回灌失败：' + (e && e.message ? e.message : e));
    }
  }

  /** tool-loop 调它：把一张待确认的写入摆出来 */
  root.__DSC_ASK_CONFIRM__ = function (p) {
    var o = p || {};
    if (!o.id) {
      log('CONFIRM 没有提案 id，弹不出来');
      return false;
    }
    mount(o);
    return true;
  };

  /** 验收用：卡片现在长什么样 / 点了会怎样 */
  root.__DSC_CONFIRM__ = {
    current: function () {
      return current;
    },
    decide: decide,
    close: close,
  };
})(window);
