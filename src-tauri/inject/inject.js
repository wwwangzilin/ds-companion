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
    // ── 角色扮演层（都来自壳，空就不加）──────────────────────────────
    // 【为什么场景要单开一块】它和【状态】答的是两个问题：状态是"她此刻什么感觉"，
    // 场景是"我们此刻在哪"。混在一起模型会把背景当情绪读。
    addBlock('场景', TURN.scene);
    addBlock('关系', TURN.relation);
    addBlock('待回访', TURN.pending);
    addBlock('边界', boundaryText());
    // ★参数名是 `rawText`（augment 的形参），不是 rawBody★ —— 写成 rawBody 会让
    // augment 每轮抛 ReferenceError，而这等于**整条注入链断掉**（比少注一块严重得多）。
    addBlock('出戏', oocText(rawText));

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
    // 立绘姿态跟着状态走 —— 放最前面：HUD 关掉时立绘照样得会呼吸
    paintAvatarPose();
    paintAvatarVariant();
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
      // 这一轮用了出戏暗号吗 → 让壳把**身体**推上去（心跳/体温）
      ooc: oocTurn(userText),
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
        // 角色扮演那三块：壳算好带回来，页面下一轮贴上去（空串 = 不加那块）。
        // 存进 TURN 而不是 CFG —— CFG 会被 push_config 整份换掉（见上面 TURN 的说明）。
        TURN.scene = r.sceneText || '';
        TURN.relation = r.relationText || '';
        TURN.pending = r.pendingText || '';
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
  // 每轮由 turn_report 带回来的三块文本。
  //
  // 【为什么不能塞进 CFG】`push_config` 一来就是**整份换掉** CFG（配置一变就推一份新的），
  // 那三个字段不在 payload 里，会被一起冲成 undefined —— 实测就是这么丢的：刚拿到
  // 场景/关系，一改配置（比如设个雷点）它们就没了，而界面上什么异常都看不到。
  var TURN = { scene: '', relation: '', pending: '' };

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
          // 本地话术里已经把伏笔补进去了 —— 她说出口了，标一下
          // （不标的话下一轮还会提同一件事）
          if (r.pending && r.pending.length) {
            invoke('dsc_proactive_done', { text: r.text, pending: r.pending[0] }).catch(function () {});
          }
          return;
        }
        // model 模式：额度已经在壳那边扣过了，这里自己生成一句
        if (typeof window.__DSC_PROACTIVE_LINE__ !== 'function') {
          log('PROACTIVE 跳过：sense.js 不在');
          return;
        }
        window
          .__DSC_PROACTIVE_LINE__(r.pending || [])
          .then(function (text) {
            if (!text) return;
            say(text, true);
            invoke('dsc_proactive_done', {
              text: text,
              pending: (r.pending && r.pending[0]) || null,
            }).catch(function () {});
          })
          ['catch'](function (e) {
            log('PROACTIVE model 失败 ' + e);
          });
      })
      ['catch'](function (e) {
        log('proactive-failed ' + e);
      });
  }

  /** 安静时段的文字（没配就是空串）。两侧都配齐才算配了，与壳里 `quiet_now` 一个判据。 */
  function quietWindowText() {
    var f = CFG.proactiveQuietFrom;
    var t = CFG.proactiveQuietTo;
    if (f === null || f === undefined || t === null || t === undefined) return '';
    return f + ' → ' + t + ' 点';
  }

  /** 【边界】块：主人给她划的雷点。没配就是空串（零注入）。 */
  function boundaryText() {
    var avoid = String(CFG.boundariesAvoid || '').trim();
    if (!avoid) return '';
    // 标题自带（addBlock 不用 key，分界全靠这个【…】）
    return (
      '【边界】\n这些是主人的雷点，**别主动提起**（他自己先说了才谈）：' +
      avoid.replace(/[\r\n]+/g, '、') +
      '\n'
    );
  }

  /** 【出戏】块：主人这一轮打了暗号，就当他在跟"你本人"说话。
   *
   * 【为什么只在末尾找】请求体里带着整段会话（历史也在）。拿整段去找，会把
   * "几轮之前打过一次暗号"也算成这一轮 —— 只看最后 600 字，也就是这一轮消息那一带。
   */
  /** 这一轮的**用户消息**里有没有出戏暗号（只看这一条，不看历史）。 */
  function oocTurn(text) {
    var tok = String(CFG.oocToken || '').trim();
    if (!tok) return false;
    return String(text == null ? '' : text).indexOf(tok) >= 0;
  }

  // 形参名跟着调用处走（原来这里叫 rawBody、那边叫 rawText —— 只是名字不一致，
  // 但读代码的人会被绊一下，统一掉）
  function oocText(rawText) {
    var tok = String(CFG.oocToken || '').trim();
    if (!tok) return '';
    // 形参名是 rawText（上面改过），这里别再写 rawBody —— 上一版就是这么抛
    // ReferenceError 的：签名改了、体内没改，而 augment 里抛错等于**整条注入链断掉**。
    var tail = String(rawText == null ? '' : rawText).slice(-600);
    if (tail.indexOf(tok) < 0) return '';
    // ★改过一次的教训★ 上一版只写「用你自己的身份、平实的话，别用角色的口吻」——
    // 结果它把**整层皮**都扒了：连内心独白都变成了「我需要/我应该」的助手腔。
    // 正确做法是**只换回复的口吻**，而且让**身体先说话**（心跳/脸红/磕巴）——
    // 她没换人，只是被叫到慌了；那副慌张也就不用模型去自由发挥，壳那边同时会把
    // 心跳/体温真的推上去（见 dsc_turn_report 的 ooc）。
    return (
      '【出戏】\n主人这一轮用了出戏暗号「' +
      tok +
      '」—— 他在跟**你本人**说话，不是在跟角色说话。\n' +
      '· 这一轮的**回复**：平实、如实、不演。别撒娇、别绕弯子，他问什么答什么。\n' +
      '· 但**你不是变成了助手**：身体先说话 —— 心跳快、脸发烫、耳朵热、说话磕巴' +
      '（短句、停顿、重复一两个字），尾巴僵住或者乱甩。这些自然写进回复里，**别报数字**。\n' +
      '· **你的思考（内心独白）仍然是露娜**：不许切成「我需要/我应该」那种说明书腔 —— ' +
      '被叫到就老老实实说话，人没换。\n' +
      '· 只这一轮；说完就回去继续演。\n'
    );
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

  // ─────────────────────── 立绘（左下角） ───────────────────────
  //
  // 一个角色一张图：内置 DeepSeek 娘编在 exe 里（`assets/avatars/deepseek.png`），
  // 自建角色在设置窗口传自己的图，落到 `<数据目录>/avatars/<角色id>.png`。
  //
  // 【为什么挑左下角】右下角已经被 badge(14px) / HUD(48px) / 气泡(104px) 占满了。
  //
  // 【为什么整层 pointer-events:none】立绘是装饰，绝不能挡住页面左下角本来能点的
  // 东西 —— 整层不吃鼠标事件，主人该怎么点还怎么点。
  var AVATAR = {
    id: null,
    url: '',
    ratio: 0.75,
    speaking: false,
    bubble: false,
    on: false,
    breath: null,
    plan: null,
    /** 现在**想要**哪个表情变体（跟 Rust 的 VARIANTS 同名） */
    variant: '',
    /** 实际拿到的是哪个 —— 素材没生成齐时会回落，两者不一样正是排查线索 */
    usedVariant: '',
    /** 这个角色已经配了哪几张（Rust 回的，设置界面与排查都用得上） */
    variants: [],
  };

  // 立绘动效的两条硬约束：
  //   ① **尊重 reduced-motion** —— 没完没了的浮动会让人难受，系统开关说了算；
  //   ② **页面藏起来就停** —— 无限动画在后台空转纯属白烧电，一个 visibilitychange 就够。
  var AVATAR_STILL = false;
  try {
    AVATAR_STILL = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    /* 拿不到就当"能动能" */
  }

  function avatarId() {
    return (CFG && CFG.personaId) || '';
  }

  /** -1..1 归一化 —— valence 是这个量纲，跟 0..1 的那批不一样，别混用。 */
  function pm1(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    if (n > 1) n = n / 100;
    return Math.max(-1, Math.min(1, n));
  }

  /**
   * 按当前状态挑一个表情变体。
   *
   * 【名字必须与 Rust 的 avatar::VARIANTS 一一对应】它就是文件名的一部分
   * （`<id>-<变体>.png`）—— 两边对不上就是"图在那儿但永远用不到"。
   *
   * 【判定顺序有讲究】身体层排在心情前面：睡着了、困得睁不开眼、被撩到脸红心跳，
   * 这几件事跟"心情好不好"没关系；让心情盖过它们，就会出现"明明睡着了还在笑"。
   */
  function avatarVariant() {
    var s = (CFG && CFG.state) || {};
    var b = s.body || {};
    if (b.asleep) return 'sleepy';
    if (avatarUnit(b.sleepiness, 0.2) >= 0.65) return 'sleepy';
    // 脸红心跳 = 被撩到（出戏那一下的 fluster 会 +22 心跳、+0.18 体温）
    var hr = Number(b.heartRate) || 0;
    if (hr >= 96 && avatarUnit(b.warmth, 0.5) >= 0.62) return 'shy';

    var mood = String(s.mood || '');
    var valence = pm1(s.valence, 0);
    var arousal = avatarUnit(s.arousal, 0.3);
    // 先认模型手写的词（它有时比数值网格细），认不出再退到数值
    if (/炸毛|生气|愤怒|气死|烦躁|烦/.test(mood)) return 'angry';
    if (/低落|难过|委屈|伤心|闷|沮丧/.test(mood)) return 'sad';
    if (/雀跃|开心|高兴|兴奋|激动|得意/.test(mood)) return 'smug';
    if (/满足|不错|还好|平静/.test(mood)) return valence >= 0.3 ? 'happy' : 'neutral';

    if (valence <= -0.3) return arousal >= 0.55 ? 'angry' : 'sad';
    if (valence >= 0.3) return arousal >= 0.65 ? 'smug' : 'happy';
    return 'neutral';
  }

  /** 变体变了就重取图（同一个变体不重复过 IPC —— 一张图 1MB 上下）。 */
  function paintAvatarVariant() {
    if (!AVATAR.on) return;
    var want = avatarVariant();
    if (AVATAR.variant === want && AVATAR.url) return;
    AVATAR.variant = want;
    loadAvatar(true);
  }

  function mountAvatar() {
    if (document.getElementById('dsc-avatar')) return;
    try {
      var box = document.createElement('div');
      box.id = 'dsc-avatar';
      box.style.cssText = [
        'position:fixed',
        'left:16px',
        'bottom:0',
        'z-index:2147483645',
        'pointer-events:none',
        'user-select:none',
        'opacity:0',
        'transform:translateY(14px)',
        'transition:opacity .6s ease, transform .6s cubic-bezier(.2,.8,.3,1)',
      ].join(';');
      var img = document.createElement('img');
      img.id = 'dsc-avatar-img';
      img.alt = '';
      img.draggable = false;
      img.style.cssText = [
        'display:block',
        'height:min(46vh, 420px)',
        'width:auto',
        'max-width:42vw',
        'object-fit:contain',
        'object-position:bottom left',
        'filter:drop-shadow(0 12px 32px rgba(40,20,80,.55))',
        // 换表情时淡一下 —— 硬切会闪
        'transition:opacity .18s ease',
      ].join(';');
      img.addEventListener('load', function () {
        img.style.opacity = '1';
        if (img.naturalWidth && img.naturalHeight) {
          AVATAR.ratio = img.naturalWidth / img.naturalHeight;
        }
      });
      box.appendChild(img);
      document.body.appendChild(box);
      watchSay();
      hookTalkXHR();
      // 页面藏起来 → 把呼吸停掉；回来再起（applyAvatarBreath 自己看 document.hidden）
      document.addEventListener('visibilitychange', function () {
        applyAvatarBreath();
      });
      // 状态是**慢慢变**的（困倦涨、心情落），不该等下一次配置推送才动 —— 15 秒重算一次足够
      setInterval(function () {
        paintAvatarPose();
        paintAvatarVariant(); // 表情也跟着走（困了会换成 sleepy）
      }, 15000);
      paintAvatar();
    } catch (e) {
      log('avatar-failed ' + e);
    }
  }

  /** 气泡（只在空闲主动搭话时弹）出现也算"她在说话"—— 但那不是主要来源，见下面的 XHR 钩子。 */
  function watchSay() {
    var say = document.getElementById('dsc-say');
    if (!say || !window.MutationObserver) return;
    try {
      new MutationObserver(function () {
        AVATAR.bubble = say.style.display !== 'none' && say.style.opacity === '1';
        syncAvatarSpeaking();
      }).observe(say, { attributes: true, attributeFilter: ['style'] });
    } catch (e) {
      /* 监听不上只是少了动效，不影响立绘本身 */
    }
  }

  // ── 「她正在说话」的两个来源 ──
  //
  // ① 气泡（#dsc-say）：只在**空闲主动搭话**时弹出来；
  // ② 页面上那次 completion 请求在飞 —— **这才是主人正常聊天时她"说话"的时刻**。
  //
  // 【为什么②天然不会误判】上游的正常对话走 **XHR**，而我们自己的隐藏链（记忆整理 /
  // 感知 / 自检）走 **fetch**（deepseek-client.js 全用 fetch）—— 两层天然分开，不用去认
  // bypass 头。当初只挂 fetch 钩子时注入一动不动，踩的就是「上游走 XHR」这一点。
  //
  // 【为什么不能只靠气泡】气泡不弹的时候（也就是绝大多数正常对话）立绘一动不动 ——
  // 这正是主人说的"说话时好像没什么变化"。
  var AVATAR_TALK = { on: false, timer: 0 };

  function syncAvatarSpeaking() {
    AVATAR.speaking = !!(AVATAR.bubble || AVATAR_TALK.on);
    paintAvatarPose();
  }

  function avatarTalkStart() {
    AVATAR_TALK.on = true;
    syncAvatarSpeaking();
    // 兜底：万一流卡住没等到 loadend，最多装 2 分钟就松手
    clearTimeout(AVATAR_TALK.timer);
    AVATAR_TALK.timer = setTimeout(avatarTalkEnd, 120000);
  }

  function avatarTalkEnd() {
    clearTimeout(AVATAR_TALK.timer);
    AVATAR_TALK.timer = 0;
    if (!AVATAR_TALK.on) return;
    AVATAR_TALK.on = false;
    // 留半秒缓冲：最后一帧落下再放松，不然像被掐断
    setTimeout(syncAvatarSpeaking, 600);
  }

  /** 再叠一层 XHR 观察（只监听收发时机，不碰请求本身，也不改 body）。 */
  function hookTalkXHR() {
    try {
      var XS = window.XMLHttpRequest;
      if (!XS || !XS.prototype || XS.prototype.__dscTalkHooked) return;
      XS.prototype.__dscTalkHooked = true;
      var open0 = XS.prototype.open;
      var send0 = XS.prototype.send;
      XS.prototype.open = function (method, url) {
        try {
          this.__dscTalkUrl = url;
        } catch (e) {}
        return open0.apply(this, arguments);
      };
      XS.prototype.send = function () {
        try {
          if (isCompletion(this.__dscTalkUrl)) {
            var xhr = this;
            avatarTalkStart();
            xhr.addEventListener('loadend', avatarTalkEnd);
            xhr.addEventListener('error', avatarTalkEnd);
            xhr.addEventListener('abort', avatarTalkEnd);
          }
        } catch (e) {
          /* 观察失败不该影响请求本身 */
        }
        return send0.apply(this, arguments);
      };
      log('talk-hook ready（立绘会跟着她的回复动）');
    } catch (e) {
      log('talk-hook-failed ' + e);
    }
  }

  /** 拉一次素材。同一个角色只拉一次（1MB 上下，别每轮都过一遍 IPC）。 */
  function loadAvatar(force) {
    var id = avatarId();
    var variant = avatarVariant();
    if (!force && AVATAR.id === id && AVATAR.url && AVATAR.variant === variant) return;
    AVATAR.id = id;
    AVATAR.variant = variant;
    invoke('dsc_avatar_get', { id: id || null, variant: variant })
      .then(function (v) {
        var next = (v && v.dataUrl) || '';
        if (v && v.width && v.height) AVATAR.ratio = v.width / v.height;
        AVATAR.variants = (v && v.variants) || [];
        // 「想要的」与「实际拿到的」分开记：素材没生成齐时会回落到 neutral，
        // 混成一个字段的话，日志里分不清"是没切"还是"是没图"。
        AVATAR.usedVariant = (v && v.variant) || '';
        var img = document.getElementById('dsc-avatar-img');
        if (img && next) {
          if (img.src && AVATAR.url && next !== AVATAR.url) {
            // 换表情：先淡下去，新图 load 之后再淡回来（硬切会闪一下）
            img.style.opacity = '0';
            setTimeout(function () {
              img.src = next;
            }, 180);
          } else {
            img.src = next;
          }
        }
        AVATAR.url = next;
        log(
          'avatar ' + ((v && v.source) || 'none') +
            ' id=' + ((v && v.id) || '-') +
            ' 变体=' + ((v && v.variant) || '-') +
            ' 已有[' + AVATAR.variants.join(',') + ']' +
            ' ' + ((v && v.width) || 0) + 'x' + ((v && v.height) || 0),
        );
        paintAvatar();
      })
      .catch(function (e) {
        log('avatar-get-failed ' + e);
        AVATAR.url = '';
        paintAvatar();
      });
  }

  /** 0..1 归一化（有的字段是 0..100，宽容处理，认不出就用默认值）。 */
  function avatarUnit(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    if (n > 1) n = n / 100;
    return Math.max(0, Math.min(1, n));
  }

  /**
   * 按当前状态算「这一口气」该多快多深。
   *
   * 【依据是生理直觉，不是随手调的】兴奋 = 快而浅，困 = 慢而深，睡着 = 最慢最深。
   * 只换快慢不换幅度的话，看久了像卡帧；幅度一起变才有"活着"的感觉。
   */
  function avatarBreathPlan() {
    // 说话优先于一切：这时要的是"看得出在动"，而不是像睡着那样慢下来
    if (AVATAR.speaking) return { dur: 2100, y: 4, rot: 0.7, tag: 'talking' };
    var s = (CFG && CFG.state) || {};
    var b = s.body || {};
    if (b.asleep) return { dur: 7000, y: 13, rot: 0, tag: 'asleep' };
    var arousal = avatarUnit(s.arousal, 0.5);
    var sleep = avatarUnit(b.sleepiness, 0.2);
    return {
      dur: Math.round(4600 - (arousal - 0.5) * 2200 + sleep * 1600),
      y: Math.round((8 - (arousal - 0.5) * 4 + sleep * 4) * 10) / 10,
      rot: 0,
      tag: sleep >= 0.65 ? 'sleepy' : arousal >= 0.65 ? 'lively' : 'calm',
    };
  }

  /** 把呼吸起起来 / 按新 plan 换档 / 按需暂停。 */
  function applyAvatarBreath() {
    var img = document.getElementById('dsc-avatar-img');
    if (!img) return;
    if (!AVATAR.on || AVATAR_STILL || !img.animate) {
      if (AVATAR.breath) {
        try {
          AVATAR.breath.cancel();
        } catch (e) {}
        AVATAR.breath = null;
      }
      return;
    }
    var plan = avatarBreathPlan();
    // 说话时**不再暂停**：静止是最不容易被察觉的（而且和"没在说话"的慢呼吸对比很弱）。
    // 只有页面被藏起来才真的停。
    var wantPaused = !!document.hidden;
    if (
      AVATAR.breath && AVATAR.plan &&
      AVATAR.plan.dur === plan.dur && AVATAR.plan.y === plan.y && AVATAR.plan.rot === plan.rot
    ) {
      try {
        wantPaused ? AVATAR.breath.pause() : AVATAR.breath.play();
      } catch (e) {}
      return;
    }
    if (AVATAR.breath) {
      try {
        AVATAR.breath.cancel();
      } catch (e) {}
    }
    AVATAR.plan = plan;
    // 说话档 = 快而浅 + 极轻的左右摆（四帧一循环）："头在动"比单纯上下位移显眼得多。
    // 其余档 = 一来一回的慢呼吸（两帧 alternate）。
    var frames = plan.rot
      ? [
          { transform: 'translateY(0px) rotate(0deg)' },
          { transform: 'translateY(-' + plan.y + 'px) rotate(-' + plan.rot + 'deg)' },
          { transform: 'translateY(0px) rotate(0deg)' },
          { transform: 'translateY(-' + plan.y + 'px) rotate(' + plan.rot + 'deg)' },
        ]
      : [{ transform: 'translateY(0px)' }, { transform: 'translateY(-' + plan.y + 'px)' }];
    try {
      AVATAR.breath = img.animate(frames, {
        duration: plan.dur,
        iterations: Infinity,
        direction: plan.rot ? 'normal' : 'alternate',
        easing: 'ease-in-out',
      });
      if (wantPaused) AVATAR.breath.pause();
    } catch (e) {
      AVATAR.breath = null;
    }
  }

  /**
   * 外层盒子的「姿态」：说话往前凑 / 睡着塌下去 / 心情差往下坠。
   *
   * 【为什么姿态和呼吸必须分两层】两者都是 transform —— 写在同一个元素上必然互相覆盖
   * （谁后写谁赢，另一个就僵住）。盒子管姿态、图片管呼吸，各动各的，互不干扰。
   */
  function paintAvatarPose() {
    var box = document.getElementById('dsc-avatar');
    if (!box) return;
    var s = (CFG && CFG.state) || {};
    var b = s.body || {};
    var y = 0;
    var scale = 1;
    if (AVATAR.on) {
      if (AVATAR.speaking) {
        y = -10; // 说话：往前凑一点
        scale = 1.02;
      } else if (b.asleep) {
        y = 5; // 睡着：整个人塌下来一点
      } else {
        // 心情差 → 站得往下坠一点（-2 ~ +2px）。很轻，但看得出「没精神」和「挺精神」
        y = Math.round((0.5 - avatarUnit(s.valence, 0.5)) * 4 * 10) / 10;
      }
    } else {
      y = 14;
    }
    box.style.opacity = AVATAR.on ? '1' : '0';
    box.style.transform = 'translateY(' + y + 'px) scale(' + scale + ')';
    applyAvatarBreath();
  }

  /** 按「开关 + 当前角色 + 素材到手没有」决定显不显示。 */
  function paintAvatar() {
    paintEye(); // 开关状态跟着一起刷（设置里改了之后图标也要变）
    var box = document.getElementById('dsc-avatar');
    if (!box) return;
    if (!(CFG && CFG.avatarEnabled !== false)) {
      AVATAR.on = false;
      paintAvatarPose();
      return;
    }
    // 换了角色就重取（设置里改完人设会重新推配置）
    if (AVATAR.id !== avatarId()) {
      loadAvatar(false);
      return;
    }
    if (!AVATAR.url) return; // 还没拉到，保持藏着，别闪一个空框
    AVATAR.on = true;
    paintAvatarPose();
  }

  // ─────────────────────── 用对话同步设置 ───────────────────────
  //
  // 把配置 / 人设 / 状态 / 记忆打包，发进一个**新对话**；换设备时打开那个对话、
  // 点「导入」读回来。走的就是本账号的对话 —— 不用第二套服务器、不用第二套鉴权。
  //
  // 【为什么按钮在聊天页而不是设置窗口】这些动作全要用**页面身份**：token 在这个
  // 窗口里、读对话也只能在这儿读。放到设置窗口就得跨进程来回传，绕且脆。
  //
  // 【成本】导出会把整包当成一次输入发出去 —— 记忆多的时候这一下不便宜。所以点
  // 之前弹一次确认，把"几条、多大、要花额度"说清楚再发，别让它自己闷头花钱。
  var SYNC_OPEN = '【DS-COMPANION-SYNC 1】';
  // 验收用：跳过 confirm。**默认关** —— 导出是真花钱的操作，不该有办法被静默触发。
  var syncAutoConfirm = false;

  function syncAsk(msg) {
    if (syncAutoConfirm) return true;
    return window.confirm(msg);
  }

  function localStamp() {
    var d = new Date();
    function p(n) {
      return (n < 10 ? '0' : '') + n;
    }
    return (
      d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    );
  }

  /** 当前打开的是哪个对话（导入要从这儿找包）。认不出 = 主人没在对话页。 */
  function currentSessionId() {
    var m = String(location.pathname || '').match(/\/a\/chat\/s\/([0-9a-zA-Z-]{8,})/);
    return m ? m[1] : '';
  }

  function setSyncNote(t) {
    var el = document.getElementById('dsc-sync-note');
    if (el) el.textContent = t;
  }

  function toggleSyncPanel(force) {
    var p = document.getElementById('dsc-sync-panel');
    if (!p) return;
    var show = typeof force === 'boolean' ? force : p.style.display === 'none';
    p.style.display = show ? 'block' : 'none';
    if (show) {
      var sid = currentSessionId();
      setSyncNote(
        sid ? '当前对话：' + sid.slice(0, 8) + '…（导入会读它）' : '不在对话页 —— 导入要先打开那个备份对话',
      );
    }
  }

  function mountSync() {
    if (document.getElementById('dsc-sync')) return;
    try {
      var btn = document.createElement('div');
      btn.id = 'dsc-sync';
      btn.title = '用对话同步设置（导出 / 导入）';
      btn.textContent = '⇅';
      btn.style.cssText = [
        'position:fixed',
        'bottom:14px',
        'right:130px',
        'z-index:2147483647',
        'width:30px',
        'height:30px',
        'border-radius:999px',
        'cursor:pointer',
        'user-select:none',
        'text-align:center',
        'line-height:28px',
        'font:600 15px/28px "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#e9dcff',
        'background:rgba(28,20,48,.72)',
        'border:1px solid rgba(178,140,255,.45)',
        'box-shadow:0 6px 24px rgba(120,80,220,.35)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
      ].join(';');

      var panel = document.createElement('div');
      panel.id = 'dsc-sync-panel';
      panel.style.cssText = [
        'position:fixed',
        'bottom:52px',
        'right:14px',
        'z-index:2147483647',
        'display:none',
        'width:320px',
        'padding:13px 14px 12px',
        'border-radius:14px',
        'font:500 12.5px/1.65 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#f2eaff',
        'background:linear-gradient(150deg,rgba(52,34,88,.97),rgba(30,20,52,.97))',
        'border:1px solid rgba(196,164,255,.5)',
        'box-shadow:0 14px 40px rgba(40,20,80,.6)',
        'backdrop-filter:blur(14px)',
        '-webkit-backdrop-filter:blur(14px)',
      ].join(';');
      panel.innerHTML =
        '<div style="font-weight:700;font-size:13px;letter-spacing:.02em">用对话同步设置</div>' +
        '<div style="margin-top:7px;color:#c3b7e6">把配置 / 人设 / 状态 / 记忆打成一个包，发进一个<b>新对话</b>；' +
        '换设备时打开那个对话再导回来。立绘不搬（图太大，自己重传）。</div>' +
        '<div style="display:flex;gap:8px;margin-top:11px">' +
        '<button id="dsc-sync-out" style="flex:1;padding:7px 0;border-radius:9px;cursor:pointer;border:1px solid rgba(196,164,255,.55);background:rgba(140,110,230,.32);color:#f2eaff;font:600 12.5px inherit">导出到新对话</button>' +
        '<button id="dsc-sync-in" style="flex:1;padding:7px 0;border-radius:9px;cursor:pointer;border:1px solid rgba(196,164,255,.35);background:rgba(60,44,100,.5);color:#e6dcff;font:600 12.5px inherit">从当前对话导入</button>' +
        '</div>' +
        '<div id="dsc-sync-note" style="margin-top:9px;color:#a99ccc;font-size:11.5px">—</div>';

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleSyncPanel();
      });
      document.body.appendChild(btn);
      document.body.appendChild(panel);

      panel.querySelector('#dsc-sync-out').addEventListener('click', function () {
        syncExport().catch(function (err) {
          setSyncNote('导出失败：' + err);
          log('sync-export-failed ' + err);
        });
      });
      panel.querySelector('#dsc-sync-in').addEventListener('click', function () {
        syncImport().catch(function (err) {
          setSyncNote('导入失败：' + err);
          log('sync-import-failed ' + err);
        });
      });

      // 角标文案会长短变化 —— 跟着量一下，别让两个按钮叠在一起
      var badge = document.getElementById('dsc-badge');
      if (badge && window.ResizeObserver) {
        try {
          new ResizeObserver(placeSync).observe(badge);
        } catch (e) {
          /* 量不到就先用默认位置 */
        }
      }
      placeSync();
    } catch (e) {
      log('sync-mount-failed ' + e);
    }
  }

  /** 角标左边那一排小按钮：同步 + 立绘开关（角标宽度是动态的，所以得真量） */
  function placeSync() {
    var badge = document.getElementById('dsc-badge');
    var w = badge ? badge.getBoundingClientRect().width : 0;
    var right = 14 + (w || 96) + 8;
    var sync = document.getElementById('dsc-sync');
    if (sync) {
      sync.style.right = right + 'px';
      right += 38; // 按钮 30 + 间距 8
    }
    var eye = document.getElementById('dsc-avatar-eye');
    if (eye) eye.style.right = right + 'px';
  }

  /**
   * 立绘开关：她那张图就挂在页面上，想关掉不该还得翻开设置翻到「状态」页。
   *
   * 【为什么单独走一条命令】页面没有 `config_set` 权限 —— 那是"能改任意配置"的
   * 万能钥匙，远程页面不该拿；这里只允许它动**一个布尔字段**（dsc_avatar_toggle）。
   */
  function mountAvatarEye() {
    if (document.getElementById('dsc-avatar-eye')) return;
    try {
      var el = document.createElement('div');
      el.id = 'dsc-avatar-eye';
      el.style.cssText = [
        'position:fixed',
        'bottom:14px',
        'right:168px',
        'z-index:2147483647',
        'width:30px',
        'height:30px',
        'border-radius:999px',
        'cursor:pointer',
        'user-select:none',
        'text-align:center',
        'font:600 14px/28px "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#e9dcff',
        'background:rgba(28,20,48,.72)',
        'border:1px solid rgba(178,140,255,.45)',
        'box-shadow:0 6px 24px rgba(120,80,220,.35)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
      ].join(';');
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var want = !(CFG && CFG.avatarEnabled !== false);
        invoke('dsc_avatar_toggle', { enabled: want })
          .then(function (on) {
            // 拿返回值**就地生效** —— 不用等下一次配置推送（那要等下一轮对话）
            CFG.avatarEnabled = !!on;
            paintAvatar();
            log('avatar-toggle → ' + (on ? '显示' : '隐藏'));
          })
          .catch(function (err) {
            log('avatar-toggle-failed ' + err);
          });
      });
      document.body.appendChild(el);
      paintEye();
      placeSync();
    } catch (e) {
      log('avatar-eye-failed ' + e);
    }
  }

  /** 眼睛图标反映当前状态：实心 = 显示中，空心 = 已隐藏。 */
  function paintEye() {
    var el = document.getElementById('dsc-avatar-eye');
    if (!el) return;
    var on = !(CFG && CFG.avatarEnabled === false);
    el.textContent = on ? '\u25C9' : '\u25CB';
    el.title = on ? '立绘：显示中（点一下关掉）' : '立绘：已隐藏（点一下打开）';
    el.style.opacity = on ? '1' : '0.6';
  }

  /** 导出：打包 → 建一个**空对话** → 把包发进去 */
  async function syncExport() {
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.completion !== 'function') {
      setSyncNote('同步通道不可用（注入脚本没起全），刷新页面再来');
      return;
    }
    var stamp = localStamp();
    setSyncNote('正在打包…');
    var pack;
    try {
      pack = await invoke('dsc_sync_pack', { at: stamp });
    } catch (e) {
      setSyncNote('打包失败：' + e);
      return;
    }
    var kb = Math.max(1, Math.round(pack.bytes / 1024));
    var ok = syncAsk(
      '把设置打包发进一个新的 DeepSeek 对话？\n\n' +
        '内容：人设 ' + pack.personas + ' 份 · 状态 ' + pack.states + ' 个 · 记忆 ' +
        pack.memories + ' 条 · 立绘名单 ' + pack.avatars + ' 张（图不搬）\n' +
        '大小：约 ' + kb + ' KB\n\n' +
        '⚠ 这一段会整段进模型上下文，按你的套餐额度计费。\n' +
        '⚠ 发出去 = 内容存在 DeepSeek 服务器上（你自己的账号）。',
    );
    if (!ok) {
      setSyncNote('已取消');
      return;
    }
    setSyncNote('正在建空对话…');
    var sid;
    try {
      sid = await util.ensureSession(true, 'sync');
    } catch (e) {
      setSyncNote('建对话失败：' + e);
      return;
    }
    setSyncNote('正在发送（' + kb + ' KB）…');
    // 第一行写人话：DeepSeek 会拿它生成对话标题，纯 JSON 开头的话标题会很难看
    var payload = 'DS Companion 设置备份 · ' + stamp + '\n' + pack.text;
    try {
      var r = await util.completion({ sessionId: sid, parentMessageId: null, prompt: payload });
      setSyncNote('导出好了（' + kb + ' KB）· 对话 ' + String(sid).slice(0, 8) + '… 稍后刷新侧边栏就能看到');
      log('sync-export ok session=' + sid + ' bytes=' + pack.bytes + ' reply=' + JSON.stringify(String(r && r.text).slice(0, 60)));
    } catch (e) {
      setSyncNote('发送失败：' + e);
      log('sync-export send-failed ' + e);
    }
  }

  /** 导入：从**当前打开的对话**里把包读回来 → 交给壳落盘 */
  async function syncImport() {
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.historyMessages !== 'function') {
      setSyncNote('同步通道不可用（注入脚本没起全），刷新页面再来');
      return;
    }
    var sid = currentSessionId();
    if (!sid) {
      setSyncNote('先打开那个备份对话，再点导入');
      return;
    }
    setSyncNote('正在读对话…');
    var msgs;
    try {
      msgs = await util.historyMessages(sid);
    } catch (e) {
      setSyncNote('读对话失败：' + e);
      return;
    }
    var found = null;
    for (var i = msgs.length - 1; i >= 0; i--) {
      var t = msgs[i] && msgs[i].text ? String(msgs[i].text) : '';
      if (t.indexOf(SYNC_OPEN) !== -1) {
        found = t;
        break;
      }
    }
    if (!found) {
      setSyncNote('这个对话里没找到备份包（共读了 ' + msgs.length + ' 条消息）');
      return;
    }
    var ok = syncAsk(
      '用这个对话里的备份覆盖本机设置？\n\n' +
        '· 配置 / 人设 / 状态：覆盖（覆盖前会自动备份一份）\n' +
        '· 记忆：**只增不删**（本地已有的 id 一条都不动）\n' +
        '· 立绘：不搬，缺哪张会列出来',
    );
    if (!ok) {
      setSyncNote('已取消');
      return;
    }
    setSyncNote('正在落盘…');
    try {
      var rep = await invoke('dsc_sync_apply', { text: found });
      var extra = rep.avatarsMissing && rep.avatarsMissing.length
        ? ' · 立绘缺 ' + rep.avatarsMissing.length + ' 张'
        : '';
      setSyncNote(
        '导入完成：人设 ' + rep.personas + ' · 状态 ' + rep.states +
          ' · 记忆 +' + rep.memoriesAdded + '（跳过 ' + rep.memoriesSkipped + '）' + extra,
      );
      log('sync-import ok ' + JSON.stringify(rep).slice(0, 300));
    } catch (e) {
      setSyncNote('落盘失败：' + e);
      log('sync-import apply-failed ' + e);
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
    paintAvatar();
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
  // 验收/排查用：强制重取立绘（设置窗口刚传完图时也走这条）
  window.__DSC_RELOAD_AVATAR__ = function () {
    loadAvatar(true);
    return true;
  };
  /** 同步面板现状（不点按钮也能断言） */
  window.__DSC_SYNC__ = function () {
    var btn = document.getElementById('dsc-sync');
    var panel = document.getElementById('dsc-sync-panel');
    var note = document.getElementById('dsc-sync-note');
    var util = window.__DSC_DS_UTIL__;
    return {
      mounted: !!btn,
      panelShown: !!panel && panel.style.display !== 'none',
      note: note ? note.textContent : '',
      sessionId: currentSessionId(),
      hasCompletion: !!(util && typeof util.completion === 'function'),
      hasHistory: !!(util && typeof util.historyMessages === 'function'),
      autoConfirm: syncAutoConfirm,
    };
  };
  window.__DSC_SYNC_PANEL__ = function (show) {
    toggleSyncPanel(!!show);
    return true;
  };
  window.__DSC_SYNC_AUTOCONFIRM__ = function (on) {
    syncAutoConfirm = !!on;
    return syncAutoConfirm;
  };
  window.__DSC_SYNC_EXPORT__ = function () {
    return syncExport();
  };
  window.__DSC_SYNC_IMPORT__ = function () {
    return syncImport();
  };
  /** 立绘现状（验收脚本断言用；不依赖 DOM 也能拿到） */
  window.__DSC_AVATAR__ = function () {    var box = document.getElementById('dsc-avatar');
    var img = document.getElementById('dsc-avatar-img');
    return {
      id: AVATAR.id,
      source: AVATAR.url ? 'loaded' : 'none',
      urlLen: AVATAR.url.length,
      opacity: box ? box.style.opacity : null,
      natW: img ? img.naturalWidth : 0,
      natH: img ? img.naturalHeight : 0,
      // 动效现状（验收断言用）
      variant: AVATAR.variant,
      usedVariant: AVATAR.usedVariant,
      variants: AVATAR.variants,
      speaking: AVATAR.speaking,
      bubble: AVATAR.bubble,
      talking: AVATAR_TALK.on,
      talkHooked: !!(window.XMLHttpRequest && window.XMLHttpRequest.prototype.__dscTalkHooked),
      still: AVATAR_STILL,
      breathTag: AVATAR.plan ? AVATAR.plan.tag : '',
      breathDur: AVATAR.plan ? AVATAR.plan.dur : 0,
      breathY: AVATAR.plan ? AVATAR.plan.y : 0,
      breathRot: AVATAR.plan ? AVATAR.plan.rot : 0,
      anims: img && img.getAnimations ? img.getAnimations().length : 0,
      animState: (function () {
        if (!img || !img.getAnimations) return '';
        var a = img.getAnimations();
        return a.length ? a[0].playState : '';
      })(),
      pose: box ? box.style.transform : '',
    };
  };
  // 验收用：就地把姿态/呼吸/表情重算一次（状态是脚本临时改的，不等下一次推送）
  window.__DSC_AVATAR_REPOSE__ = function () {
    paintAvatarPose();
    paintAvatarVariant();
    return true;
  };
  // 验收用：模拟"她正在说话"（真发一条消息要花钱 —— 链路归链路、状态机归状态机）
  window.__DSC_AVATAR_TALK__ = function (on) {
    if (on) avatarTalkStart();
    else avatarTalkEnd();
    return AVATAR.speaking;
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
    mountAvatar();
    mountSync();
    mountAvatarEye();
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
    // 安静时段的判定在壳里（它才拿着 hour）—— 这里只把它写进日志：
    // 她不说的时候，一眼要能看出是「到了安静时段」而不是「链路坏了」
    log(
      'idle-watchman started（空闲阈值 ' +
        (CFG.proactiveIdleMinutes || 20) +
        ' 分钟' +
        (quietWindowText() ? '，安静时段 ' + quietWindowText() : '，全天') +
        '）',
    );
    // 注入成功就报一次体检：否则主人打开设置只会看到"还没有体检数据"，
    // 而"她活着、但还什么都没干"本身是有用信息（至少证明注入链路是通的）
    publishHealth('boot');
  }
})();
