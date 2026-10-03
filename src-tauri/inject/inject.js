/* DS Companion 注入脚本（主世界，document-start）
 *
 * 干三件事：
 *   1. 拦 chat.deepseek.com 的发送请求，把激活人设拼在 body.prompt 前面
 *   2. 右下角角标显示当前人设，点一下开设置窗口
 *   3. 把观测到的请求形状回报给壳（方便确认字段名没被上游改掉）
 *
 * 【踩过的坑，别退化】DeepSeek 网页端的发送请求走的是 **XMLHttpRequest**，不是 fetch。
 * 只挂 fetch 钩子的话 seen 会永远是 0、注入一动不动（实测 urls=[xhr:/api/v0/chat/completion]）。
 * 所以 XHR 是主路径，fetch 一并挂着当保险。
 *
 * 已验证的前提：本脚本在 document.scripts.length === 0 时就执行，
 * 远程页面 invoke 壳内命令可行。
 */
(function () {
  var CFG = window.__DSC_BOOT_CONFIG__ || { cadence: 'off', personaText: '' };
  var COMPLETION_PATH = '/api/v0/chat/completion';
  var MARK_HEAD = '【人设】';
  var MARK_TAIL = '【以上是人设。以下是主人本次的输入】';
  var stats = { seen: 0, injected: 0, skipped: 0, viaXhr: 0, viaFetch: 0, urls: [], errors: 0 };
  var BOOT_AT = Date.now();

  // ─────────────────────────── 健康度 ───────────────────────────
  //
  // 出了故障要能一眼看出"断在哪一环"，所以把只有页面侧才知道的事实攒成一条 JSON：
  // 解析出几段正文、空回复属于哪一种、工具调用走到哪一步断的。
  //
  // 为什么不用一条新命令传回壳：页面（chat.deepseek.com）和设置窗口（tauri.localhost）
  // 是**两个不同的源**，localStorage 不共享；而 dsc_log 已经是现成通道。
  // 于是这里定期打一行 `[health] {...}`，设置页的日志页把它解析成体检块 ——
  // 不新增命令、不新增权限、日志里也留了案底。
  //
  // 计数口径（verify-health.mjs 按这套断言，改口径要同步改脚本）：
  //   turns        认领的轮次（deliverTurn 走到就算，含空回复）
  //   replies      有正文的轮次
  //   emptyReplies 空正文且不是 think-only（会触发旁路兜底的那类）
  //   thinkOnly    只有思考没有正文（记为"光想不说"，不兜底、不烧额度）
  var health = {
    turns: 0,
    replies: 0,
    emptyReplies: 0,
    thinkOnly: 0,
    toolCalls: 0,
    toolRuns: 0,
    toolFailures: 0,
    toolSends: 0,
    toolFallbacks: 0,
    toolBlocked: 0,
    lastReplyLen: 0,
    lastTurnAt: 0,
    lastToolAt: 0,
    lastToolName: '',
    lastError: '',
    at: 0,
    // 从一开始就占位：任何时刻读到的 health 都该是**完整快照**，
    // 缺字段会让"字段齐全"这类自检变成薛定谔的（上报前缺、上报后齐）
    uptimeSec: 0,
    reason: '',
  };
  var HEALTH_EVERY_TURNS = 5;
  var HEALTH_EVERY_MS = 60000;
  var healthDirty = false;

  // tool-loop.js 在另一个 IIFE 里，拿不到这里的闭包 —— 只能挂到 window 上
  window.__DSC_HEALTH__ = health;
  window.__DSC_HEALTH_BUMP__ = healthBump;

  function healthBump(key, delta) {
    health[key] = (health[key] || 0) + (delta === undefined ? 1 : delta);
    healthDirty = true;
    // 攒够几轮就报一次，另外定时兜底（长时间没轮次时也能看见她还活着）
    if (key === 'turns' && health.turns % HEALTH_EVERY_TURNS === 0) publishHealth('turns');
  }

  function publishHealth(why) {
    try {
      health.at = Date.now();
      health.uptimeSec = Math.round((health.at - BOOT_AT) / 1000);
      health.seen = stats.seen;
      health.injected = stats.injected;
      health.errors = stats.errors;
      health.reason = why;
      log('[health] ' + JSON.stringify(health));
      healthDirty = false;
    } catch (e) {
      /* 体检本身绝不能影响主流程 */
    }
  }
  // 工具链路出故障时想立刻上报（不用等 5 轮/60 秒）
  window.__DSC_PUBLISH_HEALTH__ = publishHealth;

  setInterval(function () {
    if (healthDirty) publishHealth('timer');
  }, HEALTH_EVERY_MS);

  function invoke(cmd, args) {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.reject(new Error('no ipc'));
  }

  function log(msg) {
    try {
      invoke('dsc_log', { payload: msg });
    } catch (e) {
      /* 日志失败不能影响主流程 */
    }
  }

  // 给 deepseek-client 用（它得把自检结果写到同一个日志里）
  window.__DSC_LOG__ = log;

  /** 我们自己的请求带 bypass 头，必须放过 —— 否则提取请求会被再拼一次人设/记忆 */
  function hasBypass(init, input) {
    try {
      var h = (init && init.headers) || (input && input.headers);
      if (!h) return false;
      if (typeof h.get === 'function') return !!h.get('x-dsc-bypass');
      if (Array.isArray(h)) {
        return h.some(function (p) {
          return String(p[0]).toLowerCase() === 'x-dsc-bypass';
        });
      }
      return Object.keys(h).some(function (k) {
        return k.toLowerCase() === 'x-dsc-bypass';
      });
    } catch (e) {
      return false;
    }
  }

  function noteUrl(url) {
    if (stats.urls.length < 12 && stats.urls.indexOf(url) < 0) stats.urls.push(url);
  }

  // ─────────────────────── 人设拼装 ───────────────────────
  function personaBlock() {
    var t = (CFG && CFG.personaText) || '';
    t = String(t)
      .replace(/\{\{model\}\}/g, 'DeepSeek')
      .replace(/\{\{cwd\}\}/g, '(网页版无工作目录)');
    return t.trim();
  }

  function decide(body) {
    if (!body || typeof body !== 'object') return { ok: false, why: 'not-object' };
    if (typeof body.prompt !== 'string') {
      if (!stats.bodyKeys) stats.bodyKeys = Object.keys(body).join(',');
      return { ok: false, why: 'no-prompt-string(' + (stats.bodyKeys || '?') + ')' };
    }
    if (!CFG || CFG.cadence === 'off') return { ok: false, why: 'cadence-off' };
    var block = personaBlock();
    if (!block) return { ok: false, why: 'no-persona-text' };
    var isFirst = body.parent_message_id === null || body.parent_message_id === undefined;
    if (CFG.cadence === 'first' && !isFirst) return { ok: false, why: 'not-first-message' };
    if (body.prompt.indexOf(MARK_HEAD) === 0) return { ok: false, why: 'already-injected' };
    return { ok: true, block: block, first: isFirst };
  }

  // ─────────────────────── 记忆（检索在页面同步跑） ───────────────────────
  //
  // 为什么不让 Rust 选：注入是在 XHR 的 send() 里同步改 body 的，
  // 检索要用"用户这次打的那句话"，同步上下文等不了 IPC 往返。
  // 所以 Rust 把**可见记忆整库**灌进来，这里用 selector.js 同步挑。
  var MEM_HEAD = '【回忆】';
  var MEM_TAIL = '【以上是回忆，只在相关时自然使用，不要复述】';
  var injectedBySession = Object.create(null);
  var SESSION_LIMIT = 30;

  function sessionKey(body) {
    var sid = body && (body.chat_session_id || body.chatSessionId);
    return sid ? String(sid) : '(无会话 id)';
  }

  function sessionInjected(key) {
    return injectedBySession[key] ? Object.keys(injectedBySession[key]) : [];
  }

  function rememberInjected(key, ids) {
    var bucket = injectedBySession[key] || (injectedBySession[key] = Object.create(null));
    for (var i = 0; i < ids.length; i++) bucket[ids[i]] = 1;
    var keys = Object.keys(injectedBySession);
    if (keys.length > SESSION_LIMIT) delete injectedBySession[keys[0]];
  }

  function reportUsedMemory(ids) {
    try {
      invoke('memory_touch', { ids: ids }).catch(function () {});
    } catch (e) {
      /* 记账失败不影响注入 */
    }
  }

  /** 返回该拼的【回忆】块，或 '' */
  function memoryBlock(body) {
    if (!CFG.memoryEnabled) return '';
    if (!CFG.memories || !CFG.memories.length) return '';
    if (typeof window.__DSC_SELECT__ !== 'function') return '';
    var key = sessionKey(body);
    var r = window.__DSC_SELECT__(String(body.prompt || ''), CFG.memories, {
      budget: CFG.memoryBudget || 500,
      alreadyInjected: sessionInjected(key),
    });
    if (!r.picked.length) return '';
    // 记账：这些已经进上下文了，本会话后面不再重复烧额度
    rememberInjected(key, r.usedIds);
    reportUsedMemory(r.usedIds);
    stats.memoriesInjected = (stats.memoriesInjected || 0) + r.usedIds.length;
    log('MEMORY(x' + r.usedIds.length + ') ' + r.usedIds.join(','));
    return MEM_HEAD + '\n' + r.block + '\n' + MEM_TAIL;
  }

  // ─────────────── 注入回执（设置页看「这一轮到底注入了什么」）───────────────
  //
  // 【为什么需要它】"她好像没记住设定""状态怎么不更新"这类问题，根子都是**看不见**：
  // 注入是往请求体里塞文本，塞没塞、塞了多少，原来只有日志里一行 INJECTED 能看出端倪。
  // 这里把每一块的**名字与字数**都摆出来 ——
  // 「人设块压根没进去」和「进去了但只有 200 字」是两种完全不同的病，一眼可分。
  //
  // 走 dsc_log（和 [health] 同一条通道）：页面与设置窗口不同源、localStorage 不共享。
  var lastReceipt = null;
  function publishReceipt(ok, why, blocks, total, via, first) {
    try {
      lastReceipt = {
        at: Date.now(),
        ok: !!ok,
        why: why || '',
        via: via || '',
        first: !!first,
        blocks: blocks || [],
        total: total || 0,
      };
      log('[inject] ' + JSON.stringify(lastReceipt));
    } catch (e) {
      /* 回执本身绝不能影响注入 */
    }
  }

  /** 返回改好的 body 字符串，或 null（不改） */
  function augment(rawText, via) {
    // 工具回灌那一发是"页面自己发的"，内容里已经带了完整前缀（工具说明 + 原话 + 工具结果），
    // 再注一次就会把前缀塞两遍 —— 所以在飞行期间一律放过。
    //
    // 【这一发不记回执】它不是一次聊天请求；记了只会让回执被工具回灌刷屏，
    // 反而看不见"真正那一轮"注入了什么。
    if (pageSendInFlight) {
      log('skip(' + via + ') page-send-in-flight（回灌那一发不重复注入）');
      return null;
    }
    var body;
    try {
      body = JSON.parse(rawText);
    } catch (e) {
      return null; // 不是 JSON（可能是上传等），直接放过
    }
    stats.seen++;
    if (via === 'xhr') stats.viaXhr++;
    else stats.viaFetch++;

    // 【注入总开关】关着就当普通浏览器用：不改 body、不推进轮数、各块开关一律不动。
    //
    // 【为什么放在 bumpTurn 之前】静音期间那些对话**不该算"和她聊了几轮"** ——
    // 否则解除静音之后，cadence / 回锚 / 自我修订会按一个虚高的轮数触发。
    // 这是"总闸"与"各块的开关"的区别：后者只是这段不拼进去，轮数照走。
    if (CFG && CFG.injectEnabled === false) {
      stats.skipped++;
      log('skip(' + via + ') muted（注入总开关关着）');
      publishReceipt(false, 'muted', [], 0, via, false);
      return null;
    }

    var d = decide(body);
    var turnIndex = bumpTurn(body);
    var prefix = '';
    var blocks = [];
    function addBlock(k, text) {
      if (!text) return;
      prefix += text;
      blocks.push({ k: k, n: text.length });
    }
    // 【工作模式】放最前：它是"这一轮是什么场合"，比人设和状态更该先被读到。
    // 状态块在工作态下已经由壳压成一行了（见 render_state_block），这里只负责把它摆对位置。
    // 【为什么看 taskMode 而不是 taskText】taskText 现在**两个态都给**（见 Rust 侧注释）：
    // 模型二判可能把日常改判成工作，那时页面手里得已经有正文；用不用由 taskMode 决定。
    addBlock('工作模式', CFG.taskMode && CFG.taskText ? CFG.taskText + '\n' : '');
    if (d.ok) addBlock('人设', MARK_HEAD + '\n' + d.block + '\n' + MARK_TAIL + '\n');
    // 【可用工具】靠前：它是"这一轮能做什么"，比心情/好感更该先被读到
    addBlock('工具', CFG.toolText ? CFG.toolText + '\n' : '');
    // 【状态】每轮都带：几十个 token，换"她记得你俩聊到哪了"
    var st = stateBlock();
    addBlock('状态', st ? st + '\n' : '');
    // 【回锚】按会话轮数补，防漂移
    var anchor = anchorBlock(turnIndex);
    addBlock('回锚', anchor ? anchor + '\n' : '');
    var mem = memoryBlock(body);
    addBlock('回忆', mem ? mem + '\n' : '');

    if (!prefix) {
      stats.skipped++;
      log('skip(' + via + ') ' + d.why);
      // 失败也要留回执：why 就是"为什么没注入"的答案
      publishReceipt(false, d.why, [], 0, via, d.first);
      return null;
    }

    // 记下这一轮真正拼进去的前缀：工具结果回灌时要带"同一份工具说明"
    // （工具没开时为空，回灌就不会平白多出一段用不了的工具说明）
    lastPrefix = prefix;
    lastToolPrefix = CFG.toolText ? CFG.toolText + '\n' : '';
    // 【为什么成功时也要带 why】`decide()` 的 why 说的是**人设块**要不要进；
    // 而状态/工具/回锚各有各的开关，cadence=off 时它们照进不误。
    // 所以"改了请求体"与"人设进去了"是两件事：ok 表示前者，why 解释后者为什么没进。
    // （想完全静默目前得逐个关掉那几块 —— 没有单一总开关，这是已知缺口）
    publishReceipt(true, d.ok ? '' : d.why, blocks, prefix.length, via, d.first);

    var before = body.prompt.length;
    body.prompt = prefix + body.prompt;
    if (d.ok) stats.injected++;
    log(
      'INJECTED(' +
        via +
        ') persona=' +
        (d.ok ? CFG.personaName || '?' : '(未换)') +
        ' first=' +
        d.first +
        ' turn=' +
        turnIndex +
        ' anchor=' +
        (anchor ? 'yes' : 'no') +
        ' state=' +
        (st ? 'yes' : 'no') +
        ' prompt ' +
        before +
        ' -> ' +
        body.prompt.length +
        ' 字',
    );
    flashBadge('\u2713 已注入 · ' + (CFG.personaName || '人设'));
    return JSON.stringify(body);
  }

  // ─────────────────────── 状态块 / 回锚 ───────────────────────
  //
  // 状态由壳算（情绪打分、clamp、门控都在 Rust 侧，能单测），这里只负责拼进去。
  // 每轮之后壳会把新块推回来（dsc_turn_report），所以下一轮用的就是最新状态。
  var turnsBySession = Object.create(null);

  function bumpTurn(body) {
    var key = sessionKey(body);
    var n = turnsBySession[key] || 0;
    turnsBySession[key] = n + 1;
    var keys = Object.keys(turnsBySession);
    if (keys.length > SESSION_LIMIT) delete turnsBySession[keys[0]];
    return n; // 0 = 这个会话的第一条
  }

  function stateBlock() {
    if (!CFG.stateEnabled) return '';
    return CFG.stateText || '';
  }

  function anchorBlock(turnIndex) {
    if (!CFG.stateEnabled) return '';
    var every = Number(CFG.anchorEveryTurns || 0);
    if (!every) return '';
    if (!CFG.anchorText) return '';
    // cadence=every 时人设本来就每轮都在，再回锚是重复花钱
    if (CFG.cadence === 'every') return '';
    if (turnIndex <= 0) return '';
    if (turnIndex % every !== 0) return '';
    stats.anchored = (stats.anchored || 0) + 1;
    return CFG.anchorText;
  }

  // ─────────────────────── 状态 HUD（可视化） ───────────────────────
  //
  // 内心状态总得让主人看得见：角标上方一条小胶囊，心情 + 好感条。
  // 它会随每轮变化 —— 这是"连贯"唯一能被眼睛验证的地方。
  function hudText() {
    var s = CFG.state || {};
    var b = s.body || {};
    var u = CFG.userState || {};
    var parts = [];
    parts.push('—— 她 ——');
    parts.push('心情：' + (s.mood || '?'));
    parts.push('好感：' + (s.affinity || 0) + '/100　精力：' + Math.round((s.energy || 0) * 100) + '%');
    parts.push('倾向：' + Math.round(((s.valence || 0) + 1) * 50) + '% 正向 · ' + Math.round((s.arousal || 0) * 100) + '% 活跃');
    if (s.arc) parts.push('处境：' + s.arc);
    if (s.anchors && s.anchors.length) parts.push('锚点：' + s.anchors.length + ' 条');
    parts.push('已聊 ' + (s.turns || 0) + ' 轮');
    if (CFG.bodyEnabled !== false) {
      parts.push('');
      parts.push('—— 身体 ——');
      parts.push(
        '困倦 ' + Math.round((b.sleepiness || 0) * 100) + '%　体力 ' + Math.round((b.stamina || 0) * 100) +
          '%　饿 ' + Math.round((b.hunger || 0) * 100) + '%',
      );
      parts.push(
        '心跳 ' + (b.heartRate || 0) + '　呼吸 ' + Math.round((b.breath || 0) * 100) + '%' +
          (b.asleep ? '　（在睡）' : ''),
      );
      if (b.language) parts.push(b.language);
    }
    if (CFG.userStateEnabled !== false && u.turns) {
      parts.push('');
      parts.push('—— 主人 ——');
      parts.push(
        (u.mood || '?') + '　精力 ' + Math.round((u.energy || 0) * 100) + '%　投入 ' +
          Math.round((u.engagement || 0) * 100) + '%',
      );
      if (u.busy) parts.push('在忙');
      if (u.tired) parts.push('累/困');
      if (u.streak >= 3) parts.push('连着说了 ' + u.streak + ' 条');
    }
    return parts.join('\n');
  }

  function paintHud() {
    var el = document.getElementById('dsc-hud');
    if (!el) return;
    var s = CFG.state || {};
    var b = s.body || {};
    var on = CFG.hudEnabled && CFG.stateEnabled && s.turns;
    el.style.display = on ? 'block' : 'none';
    if (!on) return;
    var mood = el.querySelector('.dsc-hud-mood');
    var aff = el.querySelector('.dsc-hud-aff');
    var bar = el.querySelector('.dsc-hud-bar > i');
    if (mood) mood.textContent = s.mood || '—';
    if (aff) aff.textContent = '好感 ' + (s.affinity || 0);
    if (bar) bar.style.width = Math.max(3, Math.min(100, s.affinity || 0)) + '%';
    // 第二行：身体 + 对方（看开关）
    var bodyEl = el.querySelector('.dsc-hud-body');
    if (bodyEl) {
      if (CFG.bodyEnabled === false || !b.stamina) {
        bodyEl.style.display = 'none';
      } else {
        bodyEl.style.display = '';
        var bits = [];
        if (b.asleep) bits.push('在睡');
        else if (b.sleepiness >= 0.7) bits.push('困');
        if (b.hunger >= 0.65) bits.push('饿');
        if (b.stamina <= 0.35) bits.push('累');
        var hr = b.heartRate || 0;
        bits.push('♥' + hr);
        bodyEl.textContent = bits.join(' · ');
        bodyEl.style.color = b.asleep || b.sleepiness >= 0.7 ? '#c9b8ff' : '#9d92c9';
      }
    }
    var meEl = el.querySelector('.dsc-hud-me');
    if (meEl) {
      var u = CFG.userState || {};
      if (CFG.userStateEnabled === false || !u.turns) {
        meEl.style.display = 'none';
      } else {
        meEl.style.display = '';
        var label = u.mood || '?';
        if (u.busy) label = '在忙';
        else if (u.tired) label = '累';
        meEl.textContent = '主人：' + label + ' ' + Math.round((u.energy || 0) * 100) + '%';
        meEl.style.color = u.busy || u.tired || u.energy < 0.35 ? '#ffb3c7' : '#9d92c9';
      }
    }
    el.title = hudText() + '\n（点一下打开设置）';
  }

  function mountHud() {
    if (document.getElementById('dsc-hud')) return;
    try {
      var el = document.createElement('div');
      el.id = 'dsc-hud';
      el.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:48px',
        'z-index:2147483646',
        'width:132px',
        'padding:7px 10px 8px',
        'border-radius:12px',
        'cursor:pointer',
        'user-select:none',
        'font:500 11.5px/1.45 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#e6dcff',
        'background:rgba(24,17,42,.7)',
        'border:1px solid rgba(167,139,250,.34)',
        'box-shadow:0 6px 22px rgba(80,50,160,.32)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'display:none',
      ].join(';');
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px">' +
        '<span class="dsc-hud-mood" style="font-weight:600">—</span>' +
        '<span class="dsc-hud-aff" style="opacity:.72;font-size:10.5px">好感 0</span>' +
        '</div>' +
        '<div class="dsc-hud-bar" style="margin-top:6px;height:4px;border-radius:99px;background:rgba(255,255,255,.13);overflow:hidden">' +
        '<i style="display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#a78bfa,#f472b6);transition:width .5s ease"></i>' +
        '</div>' +
        '<div class="dsc-hud-body" style="margin-top:6px;font-size:10.5px;color:#9d92c9;letter-spacing:.01em"></div>' +
        '<div class="dsc-hud-me" style="margin-top:2px;font-size:10.5px;color:#9d92c9"></div>';
      el.addEventListener('click', function () {
        invoke('open_settings').catch(function (e) {
          log('open-settings-failed ' + e);
        });
      });
      document.body.appendChild(el);
      paintHud();
    } catch (e) {
      log('hud-failed ' + e);
    }
  }

  // ─────────────────────── 对话留档 ───────────────────────
  //
  // 内存里的 transcript 刷新即失；留档要做三件事：
  //   ① 记忆条目能溯源（"她为什么记得这个"翻得到原话）
  //   ② 刷新之后自动整理仍能跑（拿留档兜底）
  //   ③ 自我反思要有"最近的对话"可读
  function archiveTurn(sessionId, userText, assistantText) {
    if (!userText || !assistantText) return;
    try {
      var d = new Date();
      var pad = function (n) {
        return (n < 10 ? '0' : '') + n;
      };
      // 回灌那一条的 prompt 是"原始输入 + 【工具结果】+ 继续指令"，整段存进留档会把
      // 主人的话记两遍（实测：同一句在 chats 里出现两次），所以只留最后那条指令之前的部分。
      var stored = String(userText);
      var sentinel = stored.indexOf('【工具结果 · ');
      if (sentinel >= 0) {
        stored = stored.slice(0, sentinel).trim() || '(工具结果回灌)';
      }
      invoke('dsc_chat_append', {
        turn: {
          at: Date.now(),
          day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
          clock: pad(d.getHours()) + ':' + pad(d.getMinutes()),
          character: (CFG && CFG.personaName) || '',
          characterId: (CFG && CFG.personaId) || '',
          session: String(sessionId || ''),
          user: stored.slice(0, 4000),
          assistant: String(assistantText).slice(0, 8000),
        },
      }).catch(function (e) {
        log('archive-failed ' + e);
      });
      stats.turnsArchived = (stats.turnsArchived || 0) + 1;
    } catch (e) {
      log('archive-error ' + e);
    }
  }

  // ─────────────────────── 一轮说完 → 交给壳推进状态 ───────────────────────
  //
  // 三个层一起推：角色心理（心情/好感）、虚拟身体（困倦/体力/心跳）、
  // 以及**对方的**状态（累不累、忙不忙、投入度）—— 后两个都是壳从
  // "这句话 + 隔了多久 + 现在几点"推出来的，这里只把原料递过去。
  /** 请模型再判一次"这句是在派活还是在闲聊"。
   *
   * 【为什么要有这条】本地 `sense_task` 是关键词打分，它自己的注释就写着"宁可漏判、
   * 不可误判"——"帮我看看这个"和"今天好累"在词面上确实难分。模型判一次要花一次
   * 隐藏请求，所以门控放在 Rust：只有分数贴着门槛（2/3/4 分）才走这条。
   *
   * 失败一律**保持本地判断**：多撒一次娇，比把日常当加班安全。
   */
  function judgeTaskIntent(userText) {
    if (typeof window.__DSC_TASK_JUDGE__ !== 'function') return;
    var local = !!CFG.taskMode;
    var sig = CFG.taskSignal || {};
    Promise.resolve(window.__DSC_TASK_JUDGE__(userText, local, sig.score || 0, sig.hits || []))
      .then(function (r) {
        if (!r || typeof r.task !== 'boolean' || r.task === local) return;
        CFG.taskMode = r.task;
        flashBadge(r.task ? '\u2699 进入工作模式 · 模型判定' : '\u2661 回到日常 · 模型判定');
        log('TASK mode=' + (r.task ? 'work' : 'daily') + '（模型覆盖本地）');
      })
      .catch(function () {
        /* 失败保持本地判定 */
      });
  }

  /** 替她把某一天的日记写下来。
   *
   * 【为什么正文由页面写、落盘由壳做】正文必须是她自己写的（模型），而注入脚本跑在
   * 远程页面里、能力只有 capability 允许的那几条命令 —— 文件系统一律归壳。
   *
   * 【失败就什么都不做】日记缺一天不疼，一天问两次才烦人。所以失败**不**动
   * `lastDiaryDay`（那是壳写的），下一轮壳会再给一次机会。
   */
  function writeDiary(d) {
    if (!d || !d.day) return;
    if (typeof window.__DSC_DIARY__ !== 'function') return;
    Promise.resolve(window.__DSC_DIARY__(d))
      .then(function (text) {
        if (!text) return;
        return invoke('dsc_diary_save', { day: d.day, text: text });
      })
      .then(function (r) {
        if (typeof r !== 'string' || !r) return;
        log('DIARY saved ' + d.day + ' → ' + r);
        flashBadge('\u270E 写下 ' + d.day + ' 的日记');
      })
      .catch(function (e) {
        log('DIARY save failed: ' + String((e && e.message) || e));
      });
  }

  // 【为什么把它挂到页面】验收脚本要能**单独驱动这一段**：不然就只能靠"真聊一轮"
  // 来触发它，而那需要登录态 + 一次真实隐藏请求。页面里每条隐藏链都是这么暴露的
  // （__DSC_SENSE__ / __DSC_TASK_JUDGE__ / __DSC_DIARY__），这里保持一致。
  window.__DSC_WRITE_DIARY__ = writeDiary;

  function reportTurn(userText) {
    if (!CFG.stateEnabled) return;
    invoke('dsc_turn_report', {
      userText: String(userText || '').slice(0, 2000),
      hour: new Date().getHours(),
      // 本地日期一并报上去：Rust 只有 UTC，按天聚合的长期曲线要靠它（见 fold_daily）
      day: localDay(),
    })
      .then(function (r) {
        if (!r || !r.ok) return;
        CFG.state = r.state;
        CFG.userState = r.userState;
        CFG.stateText = r.stateText;
        CFG.anchorText = r.anchorText;
        CFG.anchorEveryTurns = r.anchorEveryTurns;
        CFG.taskMode = !!r.taskMode;
        CFG.taskText = r.taskText || '';
        CFG.taskSignal = r.taskSignal || null;
        // 本地判定贴着门槛 → 请模型再判一次，结果覆盖本地。只影响**下一轮**的注入
        //（本轮请求早发出去了，这也是任务模式本来的粒度）。
        if (r.wantTaskJudge) judgeTaskIntent(userText);
        // 她自己的日记：壳挑好日子才给（同一天只给一次，`last_diary_day` 挡着）。
        // 跟意图判断一样是**门控**的 —— 不是每轮都发一次隐藏请求。
        if (r.diary) writeDiary(r.diary);
        if (r.taskChanged) {
          // 让主人看得见模式切了 —— 否则"她怎么突然不撒娇了"会变成新的困惑
          flashBadge(r.taskMode ? '\u2699 进入工作模式' : '\u2661 回到日常');
          log('TASK mode=' + (r.taskMode ? 'work' : 'daily'));
        }
        stats.turnsReported = (stats.turnsReported || 0) + 1;
        // 通路自检：壳每轮算好带回来（"机制没坏、通路断了"那类告警）。
        // 存进体检对象，让它跟着 [health] 一起上报 —— 设置页就能看见，不用翻日志。
        health.vitals = Array.isArray(r.vitals) ? r.vitals : [];
        if (health.vitals.length) {
          healthDirty = true;
          log(
            'VITALS ' +
              health.vitals
                .map(function (x) {
                  return x.key + ':' + x.level + ' ' + x.text;
                })
                .join(' | '),
          );
          publishHealth('vitals');
        }
        paintHud();
        var b = r.state && r.state.body ? r.state.body : {};
        log(
          'STATE ' + (r.state && r.state.mood) +
            ' aff=' + (r.state && r.state.affinity) +
            ' | body 困=' + (b.sleepiness || 0).toFixed(2) +
            ' 体=' + (b.stamina || 0).toFixed(2) +
            ' hr=' + (b.heartRate || 0) +
            (r.bodyNote ? ' (' + r.bodyNote + ')' : '') +
            ' | 对方 ' + (r.userState && r.userState.mood) +
            ' 精力=' + (r.userState && r.userState.energy || 0).toFixed(2) +
            ' 投入=' + (r.userState && r.userState.engagement || 0).toFixed(2),
        );
        if (r.bodyNote) flashBadge('\u266A ' + r.bodyNote);
        if (r.newMilestones && r.newMilestones.length) {
          flashBadge('\u2605 ' + r.newMilestones.join('、'));
          stats.milestones = (stats.milestones || 0) + r.newMilestones.length;
        }
        // 门控在 Rust 侧算好了：它说值得才花额度
        if (r.wantModelSense && typeof window.__DSC_SENSE__ === 'function') {
          window.__DSC_SENSE__(r)['catch'](function (e) {
            log('sense-failed ' + e);
          });
        }
        // 自我反思：只有 auto 模式且攒够轮数才会自己跑（默认 manual = 主人点）
        if (
          String(CFG.selfReviewMode || 'manual') === 'auto' &&
          typeof window.__DSC_SELF_REVIEW__ === 'function'
        ) {
          var every = Number(CFG.selfReviewEveryTurns || 30) || 30;
          var since = (r.state && r.state.turns ? r.state.turns : 0) -
            (r.state && r.state.lastReviewTurn ? r.state.lastReviewTurn : 0);
          if (since >= every) {
            window.__DSC_SELF_REVIEW__()['catch'](function (e) {
              log('self-review-failed ' + e);
            });
          }
        }
      })
      ['catch'](function (e) {
        log('turn-report-failed ' + e);
      });
  }

  // ─────────────────────── 空闲主动 ───────────────────────
  //
  // 主人不说话的时候，她可以自己开口。默认关闭（可能花额度），
  // 开着时 Rust 那边还有当日额度闸；这里只负责"多久算空闲"和怎么显示。
  var lastActivityAt = Date.now();
  var proactiveFiredForIdle = false;
  var sayTimer = null;

  function markActivity() {
    lastActivityAt = Date.now();
    proactiveFiredForIdle = false;
  }

  function localDay() {
    var d = new Date();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function say(text, fromModel) {
    var el = document.getElementById('dsc-say');
    if (el) {
      el.textContent = String(text || '');
      el.style.display = 'block';
      el.style.opacity = '1';
      clearTimeout(sayTimer);
      sayTimer = setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () {
          el.style.display = 'none';
        }, 600);
      }, 30000);
    }
    stats.proactiveSaid = (stats.proactiveSaid || 0) + 1;
    log('PROACTIVE(' + (fromModel ? 'model' : 'local') + ') ' + String(text || '').slice(0, 80));
    flashBadge('\u266A ' + (CFG.personaName || '角色') + ' 主动说了句话');
    // 任务栏闪一下，别让主人错过
    invoke('dsc_attention').catch(function () {});
  }

  function runProactive(mode) {
    var day = localDay();
    invoke('dsc_proactive', {
      day: day,
      cap: Number(CFG.proactiveDailyCap || 6),
      hour: new Date().getHours(),
    })
      .then(function (r) {
        if (!r || !r.ok) {
          log('PROACTIVE skipped: ' + ((r && r.reason) || '?'));
          return;
        }
        if (r.source === 'local') {
          say(r.text, false);
          return;
        }
        // model 模式：额度已经在壳那边扣过了，这里自己生成一句
        if (typeof window.__DSC_PROACTIVE_LINE__ !== 'function') {
          log('PROACTIVE 跳过：sense.js 不在');
          return;
        }
        window
          .__DSC_PROACTIVE_LINE__()
          .then(function (text) {
            if (!text) return;
            say(text, true);
            invoke('dsc_proactive_done', { text: text }).catch(function () {});
          })
          ['catch'](function (e) {
            log('PROACTIVE model 失败 ' + e);
          });
      })
      ['catch'](function (e) {
        log('proactive-failed ' + e);
      });
  }

  function checkIdle() {
    var mode = CFG.proactiveMode;
    if (!mode || mode === 'off') return;
    if (proactiveFiredForIdle) return;
    if (!CFG.personaName) return; // 没角色就没有"谁"来主动
    // 工作模式：**连问都不问** Rust —— 问了就扣额度（dsc_proactive 里就记账），
    // 而"主人正在干活时她冒出来撒娇"本来就是要避免的事。
    if (CFG.taskMode) {
      log('PROACTIVE 跳过：工作模式中（不打扰）');
      return;
    }
    var mins = Number(CFG.proactiveIdleMinutes || 20);
    var idle = (Date.now() - lastActivityAt) / 60000;
    if (idle < mins) return;
    proactiveFiredForIdle = true;
    log('PROACTIVE 触发：空闲 ' + Math.round(idle) + ' 分钟（阈值 ' + mins + '）');
    runProactive(mode);
  }

  function mountSay() {
    if (document.getElementById('dsc-say')) return;
    try {
      var el = document.createElement('div');
      el.id = 'dsc-say';
      el.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:104px',
        'z-index:2147483647',
        'max-width:300px',
        'padding:10px 13px',
        'border-radius:14px 14px 4px 14px',
        'font:500 12.5px/1.6 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#f2eaff',
        'background:linear-gradient(150deg,rgba(52,34,88,.95),rgba(34,22,58,.95))',
        'border:1px solid rgba(196,164,255,.5)',
        'box-shadow:0 10px 34px rgba(70,40,140,.55)',
        'backdrop-filter:blur(12px)',
        '-webkit-backdrop-filter:blur(12px)',
        'display:none',
        'opacity:0',
        'transition:opacity .5s ease',
        'white-space:pre-wrap',
      ].join(';');
      document.body.appendChild(el);
    } catch (e) {
      log('say-failed ' + e);
    }
  }

  function isCompletion(url) {
    return typeof url === 'string' && url.indexOf(COMPLETION_PATH) !== -1;
  }

  // ─────────────────────── 对话留痕（供记忆提取用） ───────────────────────
  //
  // 提取要"最近聊了什么"。用户那句我们从请求体里拿（**注入前的原文**），
  // 助手那句从同一个 XHR 的响应流里拿 —— 钩子已经在这儿了，顺手记下即可。
  var transcripts = Object.create(null);
  var TRANSCRIPT_LIMIT = 12;
  /** 最近一次拼进 prompt 的前缀 / 只含工具说明的前缀（工具结果回灌用，见 tool-loop.js） */
  var lastPrefix = '';
  var lastToolPrefix = '';

  function rememberTurn(sessionId, userText, assistantText) {
    if (!sessionId || !assistantText) return;
    var t = transcripts[sessionId] || (transcripts[sessionId] = []);
    t.push({ user: String(userText || '').slice(0, 2000), assistant: String(assistantText).slice(0, 4000) });
    while (t.length > TRANSCRIPT_LIMIT) t.shift();
    stats.turnsRemembered = (stats.turnsRemembered || 0) + 1;
    // 攒轮数 + 看看该不该自动整理
    bumpPending();
    maybeAutoExtract(sessionId);
  }

  // ─────────────────────── 攒轮数 / 自动整理 ───────────────────────
  //
  // 自动整理会**自己花网页额度**，所以默认是关的（config.extractEveryTurns = 0）。
  // 关着的时候不花额度，只在角标上提示"攒了几轮没整理"，由主人决定点不点。
  // 计数落 localStorage：页面刷新不该把攒的轮数清零。
  var PENDING_KEY = 'dsc-turns-since-extract';
  var NUDGE_AT = 10;
  var pendingTurns = readPending();

  function readPending() {
    try {
      var n = parseInt(localStorage.getItem(PENDING_KEY) || '0', 10);
      return isFinite(n) && n > 0 ? n : 0;
    } catch (e) {
      return 0;
    }
  }

  function writePending(n) {
    pendingTurns = n > 0 ? n : 0;
    try {
      localStorage.setItem(PENDING_KEY, String(pendingTurns));
    } catch (e) {
      /* 存不进去也不影响本次会话 */
    }
  }

  function bumpPending() {
    writePending(pendingTurns + 1);
  }

  var autoRunning = false;

  function maybeAutoExtract(sessionId) {
    var every = Number((CFG && CFG.extractEveryTurns) || 0);
    if (!every || every <= 0 || pendingTurns < every) {
      paintBadge();
      return;
    }
    if (autoRunning) return;
    if (typeof window.__DSC_EXTRACT__ !== 'function') {
      log('AUTO-EXTRACT 跳过：extract.js 不在（攒了 ' + pendingTurns + ' 轮）');
      return;
    }
    autoRunning = true;
    log('AUTO-EXTRACT 触发：攒了 ' + pendingTurns + ' 轮，阈值 ' + every);
    flashBadge('\u21BB 正在自动整理记忆…');
    Promise.resolve(window.__DSC_EXTRACT__({ sessionId: sessionId }))
      .then(function (r) {
        autoRunning = false;
        if (r && r.ok) {
          flashBadge('\u2713 记忆已自动整理 +' + (r.added || 0) + ' ~' + (r.updated || 0));
        } else {
          flashBadge('自动整理失败（点开设置看原因）');
        }
        paintBadge();
      })
      ['catch'](function (e) {
        autoRunning = false;
        log('AUTO-EXTRACT error ' + e);
        paintBadge();
      });
  }

  // 整理成功后由 extract.js 调回来清零（失败不清，好让下次继续攒）
  window.__DSC_MARK_EXTRACTED__ = function () {
    writePending(0);
    paintBadge();
  };
  window.__DSC_PENDING_TURNS__ = function () {
    return pendingTurns;
  };

  /** 读请求体里"用户原本打的那句"（还没被我们拼人设/记忆） */
  function peekRequest(rawText) {
    try {
      var body = JSON.parse(rawText);
      if (!body || typeof body.prompt !== 'string' || !body.prompt) return null;
      var prompt = body.prompt;
      // 我们自己注入过的痕迹（同一请求重放/续传）就别当用户原话
      if (prompt.indexOf('【人设】') === 0 || prompt.indexOf('【回忆】') === 0) return null;
      return {
        sessionId: String(body.chat_session_id || body.chatSessionId || ''),
        prompt: prompt,
      };
    } catch (e) {
      return null;
    }
  }

  /** 上一条请求的"原始用户输入"：工具结果要接着它回灌（见 tool-loop.js） */
  var lastUserPrompt = '';
  /** 让自请求链路能显式声明"主人这一轮原话是什么"（回灌时用，免得把工具结果整段当原话） */
  window.__DSC_SET_LAST_PROMPT__ = function (text) {
    lastUserPrompt = String(text || '');
  };

  // ── 工具回灌的"明路"：用页面的输入框把消息发出去 ──────────────────────
  //
  // 【为什么需要它】原来的回灌走 `deepseek-client.completion()` —— 那是**我们自己的
  // fetch**，服务器确实收到了、也生成了回答，但**页面的 React 不知道有新消息**，
  // 于是聊天窗口里什么都不显示。主人的原话就是"她调用工具但是没看到东西"：
  // 屏幕上只剩她宣布"本小姐这就去列目录"，然后……没有然后。
  //
  // 现在改成"以主人的身份"把回灌内容填进输入框发出去：这样走的是**页面自己的发送
  // 流程**，回答会正常流式显示、正常持久化，主人全程看得见。
  //
  // 【三个必须处理的细节】
  //   ① 内容里已经带了完整前缀（工具说明 + 原话 + 工具结果），所以这一发**不能再被
  //      augment 注一次** —— 用一次性标志 pageSendInFlight 让钩子直接放过。
  //   ② 发出去的消息在聊天里会以主人的口吻显示（含工具结果），这是**刻意的**：
  //      比起让她凭空说"我看到有 42 项"，主人更该看得见她到底读到了什么。
  //   ③ 回答要在 captureAnswer 里认领 —— 那正是同一条 XHR 的响应，所以
  //      deliverTurn 会把它当正常一轮处理（留档、推进状态、继续处理工具调用）。
  var pageSendInFlight = false;
  var pendingPageSend = null;

  /**
   * 把一条消息以"主人"的身份发出去，并等这一轮的回复落地。
   * 返回 { ok, text, responseMessageId } 或抛错。
   */
  function sendAsUser(text, timeoutMs) {
    var content = String(text || '');
    if (!content.trim()) return Promise.reject(new Error('回灌内容为空'));
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        pendingPageSend = null;
        reject(new Error('页面发送超时（' + Math.round((timeoutMs || 60000) / 1000) + ' 秒）'));
      }, timeoutMs || 60000);
      pendingPageSend = function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingPageSend = null;
        resolve(result);
      };
      try {
        var ta = document.querySelector('textarea');
        if (!ta) throw new Error('找不到输入框（页面结构可能变了）');
        ta.focus();
        var setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        ).set;
        setter.call(ta, content);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        // 等 React 把状态更新完再按回车，否则发出去的是空消息
        setTimeout(function () {
          try {
            pageSendInFlight = true;
            ['keydown', 'keypress', 'keyup'].forEach(function (type) {
              ta.dispatchEvent(
                new KeyboardEvent(type, {
                  key: 'Enter',
                  code: 'Enter',
                  keyCode: 13,
                  which: 13,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            });
            log('PAGE-SEND 已用页面通道发出（' + content.length + ' 字）');
          } catch (e) {
            pageSendInFlight = false;
            if (!done) {
              done = true;
              clearTimeout(timer);
              pendingPageSend = null;
              reject(e);
            }
          }
        }, 120);
      } catch (e) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          pendingPageSend = null;
          reject(e);
        }
      }
    });
  }
  window.__DSC_PAGE_SEND__ = sendAsUser;

  /**
   * 把"一轮回复"走完整条管道：留痕 → 记录/留档 → 推进状态 → 看有没有新的工具调用。
   *
   * 【为什么必须抽出来】以前这套逻辑只写在 XHR 钩子里，于是**我们自己发的请求**
   * （工具回灌走 `deepseek-client.continueChat`）拿到的回复没人处理：她答了 182 个字，
   * 聊天里、留档里、状态里全是空的。凡是"以她身份发出、拿回一句话"的地方，都必须走这里。
   *
   * @returns {object} 这一轮的处置结果（便于日志/验收断言）
   */
  function deliverTurn(o) {
    var reply = String((o && o.reply) || '');
    var prompt = String((o && o.prompt) || '');
    var sid = String((o && o.sessionId) || '');
    var parentId = Number((o && o.parentMessageId) || 0);
    var via = String((o && o.via) || 'xhr');
    log(
      'REPLY[' + via + '] turn text=' + reply.length + ' 字 id=' + (parentId || '?') +
        (reply ? '' : '  ← 正文为空'),
    );
    // 体检记账：轮次、正文长度、时间 —— "她明明回了但你没看见"最先看的三个数
    healthBump('turns');
    health.lastReplyLen = reply.length;
    health.lastTurnAt = Date.now();
    if (!reply) {
      // 空正文有几种情况，处理方式不同 —— 别一律当故障：
      //   · think-only：模型光想没说（或这一轮只吐了思考）。这是它的选择，只记一笔，
      //     不触发旁路补答（补了也是白烧额度）。
      //   · 其它：可能是帧格式变了、也可能真的什么都没回 —— 交给 empty-reply 兜底。
      var emptyKind = (window.__DSC_LAST_EMPTY_KIND__ || '').trim();
      if (emptyKind === 'think-only') {
        log('REPLY[' + via + '] 只有思考没有正文（think-only），记为一次"光想不说"，不兜底');
        healthBump('thinkOnly');
        publishHealth('think-only');
        return { ok: false, reason: 'think-only' };
      }
      healthBump('emptyReplies');
      publishHealth('empty');
      try {
        if (CFG.toolText && typeof window.__DSC_ON_EMPTY_REPLY__ === 'function') {
          window.__DSC_ON_EMPTY_REPLY__({
            sessionId: sid,
            userPrompt: prompt,
            parentMessageId: parentId,
          });
        }
      } catch (e) {
        log('empty-reply-hook-failed ' + e);
      }
      return { ok: false, reason: 'empty' };
    }
    healthBump('replies');
    window.__DSC_TOOL_LAST__ = {
      sessionId: sid,
      userPrompt: prompt,
      parentId: parentId,
      reply: reply,
    };
    rememberTurn(sid, prompt, reply);
    archiveTurn(sid, prompt, reply);
    reportTurn(prompt);
    var handled = { ok: true, tool: false };
    try {
      if (CFG.toolText && typeof window.__DSC_HANDLE_TOOL_REPLY__ === 'function' && parentId) {
        handled.tool = true;
        window
          .__DSC_HANDLE_TOOL_REPLY__({
            reply: reply,
            userPrompt: prompt,
            sessionId: sid,
            parentMessageId: parentId,
          })
          ['catch'](function (e) {
            log('tool-loop-failed ' + (e && e.message ? e.message : e));
          });
      }
    } catch (e) {
      log('tool-loop-error ' + e);
    }
    return handled;
  }
  window.__DSC_DELIVER_TURN__ = deliverTurn;

  /** 给这次 XHR 挂一个响应捕获：流完了就把这一问一答记下 */
  function captureAnswer(xhr, info) {
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      try {
        var raw = xhr.responseText;
        var util = window.__DSC_DS_UTIL__;
        if (!raw || !util || typeof util.parseSseText !== 'function') return;
        var answer = util.parseSseText(raw);
        // 留下原始 SSE：她的正文和思考的分界只有原始帧里说得清（解析器的判断可能是错的）
        window.__DSC_LAST_RAW__ = raw;
        var meta = util.parseSseMeta ? util.parseSseMeta(raw) : null;
        var parentId = meta && meta.responseMessageId ? meta.responseMessageId : 0;
        if (!answer) {
          // 空正文是最难查的一类问题：模型回了、SSE 也到了、但解析不出内容
          // （实测遇到过只带 <ds_safety> 标记的回复）。原始尾巴必须留痕。
          log('REPLY[xhr] raw-tail=' + JSON.stringify(String(raw).slice(-400)));
        }
        deliverTurn({
          reply: answer,
          prompt: lastUserPrompt || info.prompt,
          sessionId: info.sessionId,
          parentMessageId: parentId,
          via: 'xhr',
        });
        // 如果有"页面通道发送"在等结果（工具回灌走的就是这条），把它认领掉
        if (pendingPageSend) {
          log('PAGE-SEND 收到回复（' + answer.length + ' 字 id=' + (parentId || '?') + '）');
          pendingPageSend({
            ok: true,
            text: answer,
            responseMessageId: parentId,
            sessionId: info.sessionId,
          });
        }
      } catch (e) {
        /* responseType 不是文本时 responseText 会抛，忽略即可 */
      }
    }
    try {
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState === 4) finish();
      });
      xhr.addEventListener('loadend', finish);
    } catch (e) {
      /* ignore */
    }
  }

  window.__DSC_TOOL_LAST__ = null;
  /** 回灌用的前缀（只有工具说明那一段；tool-loop.js 拿它拼下一条消息） */
  window.__DSC_TOOL_PREFIX__ = function () {
    return lastToolPrefix;
  };
  /** 供 tool-loop / 验收脚本闪一下角标 */
  window.__DSC_FLASH__ = function (text) {
    flashBadge(String(text || ''));
  };

  window.__DSC_TRANSCRIPT__ = function (sessionId) {
    if (sessionId) return transcripts[sessionId] || [];
    // 没指定就给最近有留痕的那个会话
    var keys = Object.keys(transcripts);
    return keys.length ? transcripts[keys[keys.length - 1]] : [];
  };
  window.__DSC_TRANSCRIPT_KEYS__ = function () {
    return Object.keys(transcripts);
  };
  window.__DSC_FORGET_TRANSCRIPT__ = function (sessionId) {
    if (sessionId) delete transcripts[sessionId];
    else transcripts = Object.create(null);
  };
  // 验收用：直接塞一轮对话进去，好在"不用真聊一句"的前提下测完整提取链路
  // （脚本会把 deepseek-client 的 completion 也换成假的，不花网页额度）
  window.__DSC_REMEMBER_TURN__ = function (sessionId, user, assistant) {
    rememberTurn(String(sessionId || 'probe-session'), user, assistant);
    return (transcripts[String(sessionId || 'probe-session')] || []).length;
  };

  // ─────────────────────── XHR（主路径） ───────────────────────
  try {
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__dsc = {
          method: String(method || 'GET').toUpperCase(),
          url: typeof url === 'string' ? url : url && url.toString ? url.toString() : '',
        };
      } catch (e) {
        /* ignore */
      }
      return XO.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        var meta = this.__dsc;
        if (meta && meta.method === 'POST' && isCompletion(meta.url)) {
          noteUrl('xhr:' + meta.url);
          if (typeof body === 'string') {
            var info = peekRequest(body);
            if (info) {
              // 记下"主人这一轮原本打的那句"：工具结果要接着它回灌（带同样的注入前缀）
              lastUserPrompt = info.prompt;
              captureAnswer(this, info);
            }
            var next = augment(body, 'xhr');
            if (next !== null) body = next;
          } else if (body && typeof body === 'object' && !(body instanceof FormData)) {
            // 少数情况 body 是 Blob/ArrayBuffer，先记下来别猜
            if (!stats.xhrBodyKind) {
              stats.xhrBodyKind = Object.prototype.toString.call(body);
              log('xhr-body-kind ' + stats.xhrBodyKind);
            }
          }
        }
      } catch (e) {
        stats.errors++;
        log('xhr-hook-error ' + e);
      }
      return XS.call(this, body);
    };
  } catch (e) {
    log('xhr-hook-failed ' + e);
  }

  // ─────────────────────── fetch（保险，目前上游没走这条） ───────────────────────
  try {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      if (hasBypass(init, input)) return origFetch.apply(this, arguments);
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' && isCompletion(url)) {
        noteUrl('fetch:' + url);
        var self = this;
        var args = arguments;
        return Promise.resolve().then(function () {
          try {
            if (typeof input === 'string' && init && typeof init.body === 'string') {
              var next = augment(init.body, 'fetch');
              if (next === null) return origFetch.call(self, input, init);
              return origFetch.call(self, input, Object.assign({}, init, { body: next }));
            }
            if (input && typeof input.text === 'function') {
              return input
                .clone()
                .text()
                .then(function (text) {
                  var n2 = augment(text, 'fetch');
                  if (n2 === null) return origFetch.call(self, input, init);
                  return origFetch.call(self, new Request(input, { body: n2 }));
                });
            }
            return origFetch.apply(self, args);
          } catch (e) {
            stats.errors++;
            log('fetch-hook-error ' + e);
            return origFetch.apply(self, args);
          }
        });
      }
      return origFetch.apply(this, arguments);
    };
  } catch (e) {
    log('fetch-hook-failed ' + e);
  }

  // ─────────────────────── 角标 ───────────────────────
  function badgeText() {
    if (CFG && CFG.cadence !== 'off' && CFG.personaName) return '\u25CF ' + CFG.personaName;
    return '\u25CB 人设未激活';
  }

  /** 角标要显示的完整文案：人设/开关状态 + 该不该提醒整理 */
  function badgeLabel() {
    var base = badgeText();
    var every = Number((CFG && CFG.extractEveryTurns) || 0);
    // 自动整理开着就不提示（它自己会跑）；关着且攒得够多了才提一嘴，不花额度
    if (!every && pendingTurns >= NUDGE_AT) base += ' · ' + pendingTurns + ' 轮待整理';
    return base;
  }

  function paintBadge() {
    var el = document.getElementById('dsc-badge');
    if (el) el.textContent = badgeLabel();
  }

  // 注入成功了就闪一下角标 —— 人设拼进的是**请求体**，聊天框里看不到原文，
  // 不给可见反馈的话主人只能靠猜（这坑踩过一次）。
  var flashTimer = null;
  function flashBadge(text) {
    var el = document.getElementById('dsc-badge');
    if (!el) return;
    el.textContent = text;
    el.style.borderColor = 'rgba(110,255,190,.8)';
    el.style.color = '#d6ffee';
    el.style.boxShadow = '0 6px 26px rgba(60,220,150,.5)';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      el.style.borderColor = 'rgba(178,140,255,.45)';
      el.style.color = '#e9dcff';
      el.style.boxShadow = '0 6px 24px rgba(120,80,220,.35)';
      paintBadge();
    }, 2800);
  }

  function mountBadge() {
    if (document.getElementById('dsc-badge')) return;
    try {
      var el = document.createElement('div');
      el.id = 'dsc-badge';
      el.title = '点击打开 DS Companion 设置';
      el.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'z-index:2147483647',
        'padding:6px 12px',
        'border-radius:999px',
        'cursor:pointer',
        'user-select:none',
        'font:500 12px/1.4 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#e9dcff',
        'background:rgba(28,20,48,.72)',
        'border:1px solid rgba(178,140,255,.45)',
        'box-shadow:0 6px 24px rgba(120,80,220,.35)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'letter-spacing:.02em',
      ].join(';');
      el.addEventListener('click', function () {
        invoke('open_settings').catch(function (e) {
          log('open-settings-failed ' + e);
        });
      });
      document.body.appendChild(el);
      paintBadge();
    } catch (e) {
      log('badge-failed ' + e);
    }
  }

  // ─────────────────────── 配置更新 ───────────────────────
  window.__DSC_SET_CONFIG__ = function (next) {
    CFG = next || { cadence: 'off', personaText: '' };
    // 配置推送里没有实时的任务模式（那是每轮算的），所以刷新配置时先当日常态；
    // 下一轮 reportTurn 会立刻把真实值带回来。不清掉的话，旧值会一直粘着。
    CFG.taskMode = false;
    CFG.taskText = '';
    paintBadge();
    paintHud();
    log('config-updated cadence=' + CFG.cadence + ' persona=' + (CFG.personaName || 'none'));
  };

  window.__DSC_STATE__ = stats;
  // 调试用：验收脚本要靠它确认"记忆库真的灌进页面了"
  window.__DSC_CFG__ = function () {
    return CFG;
  };
  /** 角标文案（验收脚本断言用；DOM 不在时也能拿到） */
  window.__DSC_BADGE_TEXT__ = function () {
    return badgeLabel();
  };
  /** HUD 文案（验收脚本断言用） */
  window.__DSC_HUD_TEXT__ = function () {
    return hudText();
  };
  /** 空闲主动：验收脚本可以直接戳这个（不用真等 20 分钟） */
  window.__DSC_IDLE_CHECK__ = function () {
    checkIdle();
  };
  window.__DSC_MARK_ACTIVITY__ = function () {
    markActivity();
  };
  window.__DSC_LOCAL_DAY__ = localDay;
  /** 验收用：手动跑一次自我反思（等价于设置页那个按钮） */
  window.__DSC_REVIEW_NOW__ = function () {
    if (typeof window.__DSC_SELF_REVIEW__ !== 'function') {
      return Promise.resolve({ ok: false, error: 'sense.js 不在' });
    }
    return window.__DSC_SELF_REVIEW__();
  };
  // 验收用：把"上次活动时间"往回拨，好在不真等 20 分钟的前提下测空闲链路
  window.__DSC_FAKE_IDLE__ = function (minutes) {
    lastActivityAt = Date.now() - Number(minutes || 0) * 60000;
    proactiveFiredForIdle = false;
    return true;
  };
  // 验收用：直接调拼装函数看它到底拼了什么（比从日志里猜可靠）
  window.__DSC_AUGMENT__ = function (rawBody, via) {
    return augment(rawBody, via || 'probe');
  };
  // 验收/排查用：最近一次注入回执（每块字数 + 为什么没注入）。
  // 返回的是**副本**：调用方不该能改到内部状态。
  window.__DSC_INJECT_RECEIPT__ = function () {
    return lastReceipt ? JSON.parse(JSON.stringify(lastReceipt)) : null;
  };
  // 验收用：模拟"一轮说完了"（真的完成一轮要能解析出助手回复，脚本没法轻易造）
  window.__DSC_REPORT_TURN__ = function (userText) {
    reportTurn(userText);
    return true;
  };

  log(
    'init cadence=' +
      (CFG && CFG.cadence) +
      ' persona=' +
      ((CFG && CFG.personaName) || 'none') +
      ' textLen=' +
      ((CFG && CFG.personaText) || '').length,
  );

  document.addEventListener('DOMContentLoaded', mountAll);
  if (document.readyState !== 'loading') mountAll();

  var mounted = false;
  function mountAll() {
    mountBadge();
    mountHud();
    mountSay();
    if (mounted) return;
    mounted = true;
    // 空闲判定：任何交互都算"主人在"
    ['mousedown', 'keydown', 'wheel', 'touchstart', 'pointerdown'].forEach(function (ev) {
      try {
        window.addEventListener(ev, markActivity, true);
      } catch (e) {
        /* ignore */
      }
    });
    window.addEventListener('focus', markActivity, true);
    setInterval(checkIdle, 30000);
    log('idle-watchman started（空闲阈值 ' + (CFG.proactiveIdleMinutes || 20) + ' 分钟）');
    // 注入成功就报一次体检：否则主人打开设置只会看到"还没有体检数据"，
    // 而"她活着、但还什么都没干"本身是有用信息（至少证明注入链路是通的）
    publishHealth('boot');
  }
})();
