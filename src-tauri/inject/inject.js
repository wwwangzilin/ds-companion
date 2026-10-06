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
  // 【这句话得跟着拼法一起改】注入块原先拼在主人输入**前面**，所以那时它写的是
  // "以下是主人本次的输入"；现在顺序反过来（见 applyInject），这句也得指对方向 ——
  // 顺便告诉模型"最上面那句才是他说的"，免得它把背景当问题。
  var MARK_TAIL = '【以上是人设。主人这次说的话在最上面】';

  // 注入块的**头一个字符**：零宽空格。
  ///
  /// 【为什么要它】注入是改 `body.prompt`，服务器存的就是带块的那一份 —— F5 读回来时，
  /// "哪一段是注入块"在文本里**没有任何标记**（`MARK_TAIL` 在注入段中间，它后面还有
  /// 工具/状态/回忆…一串块）。要在显示层只藏注入块，就得有个确定无疑的刀口。
  /// 零宽字符：屏幕上看不见、不占宽度、模型那边几乎不花 token，但 `indexOf` 一找就中。
  ///
  /// 【旧消息怎么办】那时还没这个字符。改用壳的聊天留档（`chat_recent`）里他打的原文
  /// 去定位 —— 见下面 `veilMessages()`。
  var VEIL_SEP = '\u200b';
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
    // 【为什么是"包含"不是"开头"】注入块现在拼在主人那句话**后面**（见 applyInject
    // 里那段说明）—— 再用 `=== 0` 判去重就永远判不出来，会重复注入。
    if (body.prompt.indexOf(MARK_HEAD) >= 0) return { ok: false, why: 'already-injected' };
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
    // 这两块是**背景**不是任务：Rust 那边已经把「可以提也可以不提」写进块尾了
    addBlock('他手上的东西', TURN.recent);
    addBlock('同住', TURN.peer);
    // 【他此刻】**她自己看到的**（前台窗口，要 watch_app 开着）—— 和上面两块一样是背景。
    // 块尾那句"可以顺口带一句，但别每次都报"由 Rust 侧写死在正文里（addBlock 不管 k）。
    addBlock('他此刻', TURN.front);
    // 【他屏幕上】—— 屏幕上的字（要 screen_watch 开着）。和上面几块一样是**背景**：
    // 「别复述、别逐条报」那句写在 Rust 侧的块尾里。
    addBlock('他屏幕上', TURN.screen);
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

    // ★刀口★：把零宽字符顶到最前面 —— 显示层靠它认出"注入块从这儿开始"（见 veilMessages）。
    // 放在这个位置（`if (!prefix)` 判完之后）才不会把"没有块可注入"误判成"有"。
    prefix = VEIL_SEP + prefix;

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
    // 【为什么注入块拼在主人那句话**后面**（原来是在前面）】
    //
    // 上游对长的用户消息有个折叠：`div.ds-collapsible-text { max-height: 192px }` ——
    // 只露第一屏。注入块排在前面时，**折叠露出来的全是【人设】【状态】那些块**，
    // 主人自己打的那句话被压在 1000 多字之后（F5 之后看到的就是这个，原话
    // "刷新之后对话的内容就展开带系统提示词的了"）。挪到后面之后，折叠态显示的就是
    // **他真正说的那句话** —— 这才是他要的"只显示发的东西"。
    //
    // 【代价】对模型来说变成"问题在前、背景在后"。实测验收（verify-inject-order.mjs）
    // 盯的就是她的人设还跟不跟得住。
    //
    // 【为什么不能靠改 DOM 藏起来】实测整条消息的正文是**一个 span 的纯文本**
    // （`pCount:0`、`brCount:0`，注入块和主人的话之间没有元素边界）—— 要在显示层
    // 只藏注入块，就只能改写文本，那会污染复制和"重新编辑发送"。所以从源头改顺序。
    body.prompt = body.prompt + '\n\n' + prefix;
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
    // 活动标签放哪儿取决于"立绘在不在、HUD 开没开"，所以每次 HUD 重绘都让它重新落位
    paintActivity();
    // 干活时「我在，但不烦你」：HUD 变淡、立绘收着、活动那行隐去
    applyQuietMode();
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

  // ─────────────────── 她自己正在做的事（活动） ───────────────────
  //
  // 【为什么挑选用页面做】判定要跟着**本地小时**走（`[夜]`/`[早]` 这类标签），而壳的
  // `std` 只有 UTC —— 这项目的老规矩是"本地时间一律问页面"。挑好之后两件事：
  //   ① 立刻显示（有立绘就贴立绘右边，没有就塞进 HUD）
  //   ② 顺手回传给 `dsc_turn_report`，壳存进 state 再注入回【状态】块 ——
  //      这样她聊着聊着能自然引用（"本小姐刚在翻你冰箱"），而不是每轮从零装失忆。
  //
  // 【5 分钟一换】用**确定性伪随机**：种子 = 时间块 + 角色 id + 候选集指纹。
  // 所以同一段时间里反复算都是同一条 —— 不用存盘、刷新也不漂移；而状态一变
  // （睡着了、饿了）候选集就变，选出来的自己也跟着换，看着像她真在过日子。
  var ACTIVITY_BLOCK_MS = 5 * 60 * 1000;
  /** 此刻她正在做的事（空 = 人设里没配活动池） */
  var activity = '';

  /** 字符串 → 32 位无符号整数（只用来打散，不需要密码学强度） */
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // ★必须用 Math.imul★ 普通 `h * 16777619` 的结果会超过 2^53，低位被浮点吃掉 ——
      // 那正是"哈希看着在跑、分布却是烂的"的来源
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * 32 位雪崩混淆（murmur3 收尾那几手）。
   *
   * 【为什么需要它】光用 FNV 的结果直接 `% 候选数`，低位分布很差 —— 实测连续喂
   * 300 个时间块，4 条候选里有一条**一次都没被选中**，另两条的比例是 239 : 57。
   * 她要"过日子"，不能一年到头只做那两件事。
   */
  function mix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * 一条活动的条件标签跟此刻对不对得上。
   *
   * 【多个标签是「与」】`[困][夜]` = 又困又是夜里。
   * 【不认识的标签一律放行】写错一个字（把 `[困]` 写成 `[睏]`）不该让那条活动
   * **永远不再出现** —— 那是最难发现的一种坏：没有报错，只是它再也没露过面。
   */
  function activityFits(tags) {
    var b = (CFG.state && CFG.state.body) || {};
    var h = new Date().getHours();
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (t === '睡') {
        if (!b.asleep) return false;
      } else if (t === '困') {
        if (!b.asleep && !((b.sleepiness || 0) >= 0.6)) return false;
      } else if (t === '饿') {
        if ((b.hunger || 0) < 0.6) return false;
      } else if (t === '累') {
        if ((b.stamina === undefined ? 1 : b.stamina) > 0.4) return false;
      } else if (t === '夜') {
        if (!(h >= 23 || h < 5)) return false;
      } else if (t === '早') {
        if (!(h >= 5 && h < 11)) return false;
      } else if (t === '午') {
        if (!(h >= 11 && h < 14)) return false;
      } else if (t === '晚') {
        if (!(h >= 18 && h < 23)) return false;
      }
    }
    return true;
  }

  /** 拆出开头的 `[标签]`（可以连着好几个），返回 `[纯文本, 标签数组]`。 */
  function splitActivityTags(raw) {
    var tags = [];
    var text = raw;
    for (;;) {
      var m = /^\[([^\]\s]{1,6})\]\s*/.exec(text);
      if (!m) break;
      tags.push(m[1]);
      text = text.slice(m[0].length);
    }
    return [text.trim(), tags];
  }

  /**
   * 在**指定的时间块**上挑一条（挑不出来给空串）。
   *
   * 【为什么把 block 拆成参数】验收要验"换个时间块就换一条"，总不能真等 5 分钟 ——
   * 拆出来之后脚本能直接喂一百个块，看它是不是真的在池子里散开、又是不是稳定可复现。
   */
  function pickActivityAt(block) {
    var pool = CFG.activities || '';
    if (!pool.trim()) return '';
    var lines = pool.split('\n');
    var cands = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      // `#` 开头是注释行 —— 活动池会长，总得让人能分段、能临时屏蔽几条
      if (!raw || raw.charAt(0) === '#') continue;
      var parts = splitActivityTags(raw);
      if (!parts[0]) continue;
      if (activityFits(parts[1])) cands.push(parts[0]);
    }
    if (!cands.length) return '';
    // 种子里带**候选集本体的指纹**：状态一变候选就变，选出来的一般也跟着变 ——
    // 这就是"她真的在过日子"的来源；而同样的状态里它仍然稳定，不会每 15 秒跳一次。
    // 末尾必须过一遍 mix32：直接拿 FNV 的低位取模会严重偏斜（见 mix32 的注释）。
    var seed = mix32((block | 0) ^ hashStr((CFG.personaId || '') + '|' + cands.join('|')));
    return cands[seed % cands.length];
  }

  /** 此刻该显示哪条。 */
  function pickActivity() {
    return pickActivityAt(Math.floor(Date.now() / ACTIVITY_BLOCK_MS));
  }

  function mountActivity() {
    if (document.getElementById('dsc-activity')) return;
    try {
      var el = document.createElement('div');
      el.id = 'dsc-activity';
      el.style.display = 'none';
      document.body.appendChild(el);
      paintActivity();
    } catch (e) {
      log('activity-failed ' + e);
    }
  }

  /**
   * 放到哪：**有立绘就贴立绘右边，没有就塞进 HUD**（主人定的）。
   *
   * 【为什么要分流】"她正在干嘛"这件事更该挨着她本人 —— 立绘在左下角；而立绘关掉、
   * 或者那个角色还没传图时，HUD（右下角）就是唯一的落脚点。返回用的是不是立绘位。
   */
  function placeActivity(el) {
    var hud = document.getElementById('dsc-hud');
    var av = document.getElementById('dsc-avatar');
    var avOn = !!(av && CFG.avatarEnabled !== false && av.offsetWidth > 0);
    if (avOn) {
      if (el.parentNode !== document.body) document.body.appendChild(el);
      var r = av.getBoundingClientRect();
      el.style.cssText = [
        'position:fixed',
        'left:' + Math.round(r.right + 10) + 'px',
        'bottom:' + Math.round(Math.max(12, innerHeight - r.bottom + 16)) + 'px',
        'z-index:2147483644',
        // ★跟立绘同一个道理：它绝不能吃掉主人的点击★
        'pointer-events:none',
        'max-width:min(46vw, 210px)',
        'padding:6px 10px',
        'border-radius:11px',
        'font:500 11.5px/1.5 "HarmonyOS Sans SC","Microsoft YaHei",sans-serif',
        'color:#ded2ff',
        'background:rgba(24,17,42,.72)',
        'border:1px solid rgba(167,139,250,.3)',
        'box-shadow:0 6px 20px rgba(60,36,120,.3)',
        'backdrop-filter:blur(10px)',
        '-webkit-backdrop-filter:blur(10px)',
        'transition:opacity .4s ease',
        'white-space:pre-wrap',
      ].join(';');
    } else if (hud) {
      if (el.parentNode !== hud) hud.appendChild(el);
      // 塞进 HUD 当一行：位置交给 HUD 自己排，别再 fixed
      el.style.cssText = [
        'position:static',
        'margin-top:2px',
        'font-size:10.5px',
        'color:#9d92c9',
        'letter-spacing:.01em',
      ].join(';');
    }
    return avOn;
  }

  function paintActivity() {
    var el = document.getElementById('dsc-activity');
    if (!el) return;
    // 状态层关着就别显示：她连"是谁"都还没确定的时候，不该有一句"她正在干嘛"。
    // （立绘开不开不影响这一条 —— 立绘只是"放哪儿"的一个分支）
    if (!activity || CFG.stateEnabled === false) {
      el.style.display = 'none';
      return;
    }
    if (el.textContent !== activity) {
      el.textContent = activity;
      // 她可能刚从"出去"变成"回来"（或反过来）—— 立绘的半透明得跟着动，
      // 不然要等到下一次呼吸/姿态重绘才纠正
      paintAvatarPose();
    }
    // 顺手报一次"她还在场"（自带去重，重复调是安全的）
    pushRoster();
    // ★placeActivity 会整体重写 cssText（把 display 一并冲掉），所以 display 必须
    //   在它之后设★ —— 顺序反了就会"算出来有活动、屏幕上却什么都没有"。
    var avOn = placeActivity(el);
    var hudOn = !!(CFG.hudEnabled && CFG.state && CFG.state.turns);
    el.style.display = avOn || hudOn ? 'block' : 'none';
  }

  // ── 让模型来写这条活动（activity_mode = auto 时走这条路） ──────────
  //
  // 【为什么走隐藏链，而不是让她在主对话里顺手报一句】她在主对话里输出的任何标记
  // 都会被上游**流式渲染进聊天框**，而这个注入脚本从头到尾不碰上游聊天 DOM
  // （改了也会被 React 重渲染盖掉）。所以"对主人不可见的结构化往返"只有隐藏链
  // 承载得了 —— 这就是为什么这里宁可多开一条链，也不在主对话里塞标记。
  //
  // 【本地池不删】它降级成**底线**：没聊过、请求失败、模型没回 —— 都用它那条。
  /** 最近一轮问答（隐藏链组 prompt 用） */
  var lastTurnInfo = null;
  /** 上一次请模型写活动是在哪个时间块（5 分钟块内只问一次） */
  var activityAskBlock = -1;
  /** 正问着（防同块内重复发） */
  var activityAsking = false;

  function buildActivityPrompt() {
    var s = CFG.state || {};
    var b = s.body || {};
    var bits = [];
    if (b.asleep) bits.push('睡着');
    else if (b.sleepiness >= 0.7) bits.push('很困');
    if (b.hunger >= 0.65) bits.push('饿');
    if (b.stamina <= 0.35) bits.push('累');
    var lines = [
      '（后台小任务，不是对话。你正在扮演「' + (CFG.personaName || '她') + '」，保持你的身份与说话习惯。）',
      '',
      '【刚刚发生的事】',
      '主人：' + lastTurnInfo.user,
      '你：' + lastTurnInfo.assistant,
      '',
      '【你此刻】',
      '心情：' + (s.mood || '平静') + '｜好感：' + (s.affinity || 0) + '/100｜精力：' +
        Math.round((s.energy === undefined ? 0.8 : s.energy) * 100) + '%' +
        (bits.length ? '｜身体：' + bits.join('、') : ''),
    ];
    // 活动池是**可选**的：没写池子的角色照样能自己想一条 —— 拼一个空的
    // 「你平时会做的事」只会让她犯迷糊
    var pool = String(CFG.activities || '').trim();
    if (pool) {
      lines.push('', '【你平时会做的事】（只是风格参考，可以用也可以自己想）', pool);
    }
    lines.push(
      '',
      '【任务】用**一行、15 字以内**写下你现在手上正在做的事。',
      '要求：接得上上面刚聊的事；第一人称、具体、有画面感；',
      '不要引号、不要解释、不要任何前缀或标记，只输出这一行。',
    );
    return lines.join('\n');
  }

  /** 把模型那一行收拾干净：只留第一行、去引号与前缀、截到 40 字（跟壳侧一个口径） */
  function cleanActivity(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    s = s.split('\n')[0].trim();
    // 常见的自作主张：包引号、写「我正在：」「活动：」这种前缀
    s = s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '');
    s = s.replace(/^(我正在|我在|正在做|活动|在做)\s*[:：]?\s*/, '');
    s = s.trim();
    if (!s) return '';
    return s.length > 40 ? s.slice(0, 40) : s;
  }

  /**
   * 她"不在这个房间"时，立绘收成半透明 —— 比如活动是「去翻厨房」。
   *
   * 【为什么是半透明而不是隐藏】完全消失会让人以为立绘坏了（这个项目已经因为
   * "东西在那儿但看不见"挨过好几次报障）。半透明读作"她出去了一下"，一眼就懂；
   * 而且"她不在了"这件事本身就是信息。
   *
   * 【为什么用关键词、不让她多报一个字段】"在不在这个房间"是**活动本身**的性质；
   * 让模型多报一个字段就得再动一次协议，而且它一定会漏报。这几个词够用了。
   */
  var AWAY_WORDS = [
    '厨房', '冰箱', '出门', '出去', '在外面', '阳台', '楼下', '灶台',
    '浴室', '洗手间', '跑去', '溜出去',
  ];

  function activityAway() {
    if (!activity) return false;
    for (var i = 0; i < AWAY_WORDS.length; i++) {
      if (activity.indexOf(AWAY_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  /** 报一次"她还在场" —— 别的角色登场时能看到她在干嘛。活动没变就不重复发。 */
  var rosterSent = '';
  function pushRoster() {
    if (!CFG.personaId) return;
    var sig = CFG.personaId + '|' + activity;
    if (sig === rosterSent) return;
    rosterSent = sig;
    try {
      invoke('dsc_roster_touch', {
        id: CFG.personaId,
        name: CFG.personaName || '',
        activity: activity,
        mood: (CFG.state && CFG.state.mood) || '',
      })['catch'](function (e) {
        log('roster-failed ' + e);
      });
    } catch (e) {
      log('roster-error ' + e);
    }
  }

  function askActivity() {
    if (activityAsking) return;
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.ask !== 'function') return;
    if (!lastTurnInfo || !lastTurnInfo.user) return;
    activityAsking = true;
    var t0 = Date.now();
    util
      .ask('act', buildActivityPrompt())
      .then(function (r) {
        var text = cleanActivity(r && r.text);
        if (!text) {
          log('ACT 空回复 —— 保留本地那条');
          return;
        }
        if (text === activity) return;
        activity = text;
        log('ACT 模型给了「' + text + '」（' + (Date.now() - t0) + 'ms）');
        paintActivity();
      })
      ['catch'](function (e) {
        // 失败**什么都不换**：本地池那条继续用，界面上不该有任何变化
        log('ACT 失败（保留本地那条）：' + (e && e.message ? e.message : e));
      })
      ['then'](function () {
        activityAsking = false;
      });
  }

  /**
   * 该不该请模型写一条。三道闸：
   *   ① `activity_mode` 得是 auto（local = 纯本地池，一个请求都不发）
   *   ② 一个 5 分钟块内只问一次
   *   ③ **最近聊过**才问 —— 她一个人待着时没什么"场景"可言，本地池就够了，
   *      没必要为此专门开一条请求
   */
  function maybeAskActivity() {
    if (String(CFG.activityMode || 'auto') !== 'auto') return;
    // 【刻意不看活动池】池子只是"本地兜底 + 风格参考" —— 没写池子的角色照样能自己
    // 想一条（露娜就还没写池子）。把"有没有池子"当闸门的话，主人不填池子 = 这功能
    // 整个不工作，而这两件事本来就不该绑在一起。
    if (!CFG.state || !CFG.state.turns) return;
    var block = Math.floor(Date.now() / ACTIVITY_BLOCK_MS);
    if (block === activityAskBlock) return;
    if (!lastTurnInfo || Date.now() - lastTurnInfo.at > 30 * 60 * 1000) return;
    activityAskBlock = block;
    askActivity();
  }

  /**
   * 15 秒看一眼。
   *
   * 【★ 换没换都要重绘 ★】标签的位置取决于"立绘在不在、HUD 开没开"，而这两样都是
   * **异步**变的（立绘的图是后加载的、开关随时会被拨）。原来这里写的是"活动没变就
   * 直接 return"，于是位置永远停在第一次算出来的那一版 —— 验收实测到的就是
   * "立绘明明开着，活动却挂在 HUD 位、而且看不见"。
   */
  function tickActivity() {
    var next = pickActivity();
    if (next !== activity) {
      var had = !!activity;
      activity = next;
      if (activity && !had) log('activity 有了：' + activity);
      else if (activity) log('activity → ' + activity);
      else if (had) log('activity 清空了（活动池没配，或者这一档没有可用的）');
    }
    paintActivity();
    // 顺便看看该不该请模型写一条 —— 它自带三道闸，15 秒调一次是安全的
    maybeAskActivity();
  }

  // ─────────────── 干活时的「我在，但不烦你」 ───────────────
  //
  // 【为什么要有它】`taskMode`（工作模式）原来只压**注入文本** —— 界面上她还是满格
  // 存在：HUD 亮着、立绘站着、活动那行挂着。而干活的人需要的是"她还在，但不占地方"。
  //
  // 【为什么立绘走类名 + !important】它那层的 inline `opacity` 被"淡入"（paintAvatar）
  // 共用，直接在 quiet 时改 inline，下一帧就被盖回去了 —— 只能从 CSS 那侧压。
  function mountQuietStyle() {
    if (document.getElementById('dsc-quiet-style')) return;
    try {
      var st = document.createElement('style');
      st.id = 'dsc-quiet-style';
      st.textContent =
        'body.dsc-quiet #dsc-avatar{opacity:.45!important;filter:saturate(.7);' +
        'transition:opacity .45s ease, filter .45s ease}' +
        'body.dsc-quiet #dsc-activity{opacity:0!important;transition:opacity .45s ease}';
      document.head.appendChild(st);
    } catch (e) {
      log('quiet-style-failed ' + e);
    }
  }

  /** 每轮由 paintHud 调一次：进出工作模式时界面就跟着变（不用等下一次配置推送） */
  function applyQuietMode() {
    var quiet = !!CFG.taskMode;
    var hud = document.getElementById('dsc-hud');
    if (hud) {
      hud.style.transition = 'opacity .45s ease';
      hud.style.opacity = quiet ? '0.34' : '1';
    }
    try {
      document.body.classList.toggle('dsc-quiet', quiet);
    } catch (e) {
      /* ignore */
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

  /**
   * 把壳截好的那张图**亲眼**看一遍，然后把她看到的说给壳听。
   *
   * 【提示词是实测定下来的，别随手改】第一版问的是"这张图上写着什么？用一句话原样说出来" ——
   * 她的回答永远是 5 个字，就是屏幕上最大的那个标题（主人原话：「只说个头，不去关注重点」）。
   * 同一张图、同一个尺寸，换成下面这个问法，回答从 5 个字变成 63 个字，而且把 17px 的
   * 警告框一字不差抄了出来。**问题从来不在模型，也不在分辨率**（实测缩到 512 宽连 13px
   * 的页脚都还认得出）。
   *
   * 【为什么"照抄"这两个字不能省】不要求她抄原话，她就会概括成"一个关于 Rust 的文档" ——
   * 抄出来才能看出她到底看清了没有，也只有原话能让我们判断她说得对不对。
   *
   * 【为什么必须告诉她圈是什么】Windows 的截图**不带鼠标指针**（BitBlt 不含光标），
   * 所以她自己看不出主人在看哪一块、只能瞎猜。壳在图上画了洋红色的圈 —— 不点明这一句，
   * 她可能把那圈当成屏幕内容的一部分。
   */
  /** seq → 上传后的 file_id。滑动窗口和上一轮重叠的那几张凭它复用，不必重传。 */
  var shotFileIds = {};

  /** base64 → Blob（壳给的不带 data: 前缀，但容错一下） */
  function b64ToBlob(b64) {
    var s = String(b64 || '');
    var comma = s.indexOf(',');
    if (comma >= 0) s = s.slice(comma + 1);
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  /**
   * 主对话最近几条 —— 给她做意图推测的**上下文**。
   *
   * 【为什么要它】看图那条隐藏链是**独立会话**，看不到主对话。没有这个，她只能从三张图里
   * 猜"他在干嘛"；有了它才知道"他刚才问的就是这个"，推测才落得到实处。
   *
   * 【为什么问壳而不是读页面】壳手里本来就有留档（页面每轮 `dsc_chat_append` 追加过），
   * 而页面自己的 transcript 在刷新之后是空的。一次 IPC，零 token。
   *
   * 【读不到就返回空】少一段背景，总比把整条链拖失败强。
   */
  function recentTalk(limit) {
    return invoke('chat_recent', { limit: limit || 4 }).then(
      function (list) {
        var out = [];
        (list || []).forEach(function (t) {
          var u = String((t && t.user) || '').replace(/\s+/g, ' ').trim();
          var a = String((t && t.assistant) || '').replace(/\s+/g, ' ').trim();
          if (u) out.push('他：' + u.slice(0, 100));
          if (a) out.push('你：' + a.slice(0, 100));
        });
        // 只留最后几行 —— 给的是"刚才在聊什么"，不是聊天记录
        return out.slice(-4).join('\n');
      },
      function () {
        return '';
      },
    );
  }

  /**
   * 提示词 —— **实测定下来的，别随手改**。
   *
   * 【第一版为什么不行】它问的是"这张图上写着什么？用一句话原样说出来" —— 她的回答永远是
   * 5 个字，就是屏幕上最大的那个标题（主人原话：「只说个头，不去关注重点」）。
   * 同一张图、同一个尺寸，换成下面这个问法，回答从 5 个字变成 63 个字，而且把 17px 的
   * 警告框一字不差抄了出来。**问题从来不在模型，也不在分辨率**（实测缩到 512 宽连 13px
   * 的页脚都还认得出）。
   *
   * 【为什么"照抄"两个字不能省】不要求她抄原话，她就会概括成"一个关于 Rust 的文档" ——
   * 抄出来才能看出她到底看清了没有。
   *
   * 【为什么要告诉她圈是什么】Windows 的截图**不带鼠标指针**，她自己看不出主人在看哪一块。
   * 壳在图上画了洋红色的圈，不点明的话她可能把那圈当成屏幕内容的一部分。
   *
   * 【为什么要给"上一次"】那是主人点名要的"根据之前的分析判断他在干嘛"：有了上一轮的结论，
   * 她才能说"刚才那页警告，你现在是去改配置了？"，而不是每轮都从零开始描述。
   *
   * 【为什么要给"他刚说了什么"】上面那个"上一次"是她自己看见的；这个是**主对话**里
   * 主人刚说的话 —— 看图那条链看不到主对话，不给就永远只能猜。这是主人 2026-10-06 要的。
   */
  function buildSeePrompt(n, cursor, prevSee, talk) {
    var lines = [];
    lines.push(
      n === 1
        ? '这是主人电脑屏幕的截图。'
        : '这是主人电脑屏幕的 ' + n + ' 张截图，按时间先后排列（第一张最早，最后一张是刚刚）。',
    );
    lines.push(
      cursor
        ? '最后那张图里那个洋红色的圈是他鼠标停的地方，重点优先看那里。'
        : '（最后那张图里没有圈 —— 截图那一刻他的鼠标不在这个窗口里。）',
    );
    if (prevSee) lines.push('上一次你看的时候，他是在：' + prevSee);
    if (talk) {
      lines.push('【背景】他刚跟你说过这些（只用来帮你判断他在干嘛，别在回答里复述）：');
      lines.push(talk);
    }
    lines.push('回答下面几件事，每件占一行，不要客套、不要复述我这句话：');
    lines.push('第一行「在做什么」：他正在看什么、干什么，一句话。');
    lines.push('第二行「重点」：最近这张里最该注意的那一处，把那上面写的字照抄出来。');
    if (n > 1) {
      lines.push('第三行「变化」：这几张之间他换过什么（看不出来就写"没什么变化"）。');
    }
    // 【为什么要单独一行写意图】主人要的就是这个"分析意图"。上一版它只是「变化」那行的
    // 副产物（"像是在反复核对…"），容易被她写成纯描述。提出来单独问，她才会给一句人话。
    // 【"别编"三个字不能省】推测必须有前面几行撑腰，否则她会看图讲故事。
    lines.push(
      '第四行「他大概在干嘛」：一句人话的推测 —— 他在做这件事是为了什么' +
        '（比如"在校对两版代码""在查这个报错的来源""在挑要买的东西"）。' +
        '这一行必须能被前面几行支撑；看不出来就写"看不出目的"，别编。',
    );
    lines.push('看不清就直说看不清，别猜。');
    return lines.join('\n');
  }

  /**
   * 把壳截好的**最近几张**图一起交给她看，然后把她看到的说给壳听。
   *
   * 【为什么是"最近几张"而不是"攒够才发"】主人 2026-10-06 明确纠正过：不是攒着不发，
   * 而是**每轮都带最近 3 张** —— 每次请求里都有一小段过程（最新那张 + 前两张），
   * 她因此能说出"他换过什么"。代价是 token（3 张 = 600，单张 200），**不是时间**：
   * 重叠的那两张凭 seq 复用 file_id，只有新那张要真上传。
   */
  function seeShots(shots, prevSee) {
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.seeImages !== 'function') {
      return Promise.reject(new Error('deepseek-client 没加载（或版本太旧）'));
    }
    var list = (shots || []).filter(function (s) {
      return s && s.b64;
    });
    if (!list.length) return Promise.reject(new Error('没有图'));

    var items = list.map(function (s) {
      var known = shotFileIds[s.seq];
      return known ? { fileId: known, shot: s } : { blob: b64ToBlob(s.b64), shot: s };
    });
    var reuse = items.length - items.filter(function (x) { return !x.fileId; }).length;

    var last = list[list.length - 1];
    var size = (last.w || 0) + 'x' + (last.h || 0);
    // 验收要看的就是这几项（几张、复用了几个、有没有圈、她回了什么）。**不存图本身**
    window.__DSC_LAST_SHOT__ = {
      count: list.length,
      reused: reuse,
      size: size,
      cursor: !!last.cursor,
      screen: last.size || '',
      at: Date.now(),
      text: '',
      fileIds: [],
      talk: '',
      err: '',
    };
    log(
      'SEE 收 ' + list.length + ' 张（复用 ' + reuse + ' · 新传 ' + (list.length - reuse) + '）' +
        '最近一张 ' + size + (last.cursor ? ' 有圈' : ' 无圈'),
    );
    // 【先取主对话最近几句再提问】她因此知道"他刚才问的是什么"，意图推测才不是瞎猜
    return recentTalk(4).then(function (talk) {
      window.__DSC_LAST_SHOT__.talk = talk;
      log('SEE 背景对话 ' + (talk ? talk.split('\n').length + ' 行' : '（没拿到）'));
      var prompt = buildSeePrompt(list.length, last.cursor, prevSee, talk);
      return util
        .seeImages(items, prompt, { namePrefix: 'dsc-screen-' })
        .then(function (r) {
          // 记下 seq → file_id：下一轮重叠的那几张就不必重传了。只留最近十几条，别让它无限长。
          (r.fileIds || []).forEach(function (id, i) {
            var seq = items[i] && items[i].shot ? items[i].shot.seq : null;
            if (seq !== null && seq !== undefined) shotFileIds[seq] = id;
          });
          Object.keys(shotFileIds)
            .map(Number)
            .sort(function (a, b) {
              return b - a;
            })
            .slice(12)
            .forEach(function (k) {
              delete shotFileIds[k];
            });
          var text = (r && r.text) || '';
          window.__DSC_LAST_SHOT__.text = text;
          window.__DSC_LAST_SHOT__.fileIds = r.fileIds || [];
          log('SEE ok ' + text.slice(0, 90).replace(/\n/g, ' / '));
          return invoke('dsc_screen_see', { text: text, size: size });
        });
    });
  }

  function reportTurn(userText) {
    if (!CFG.stateEnabled) return;
    invoke('dsc_turn_report', {
      userText: String(userText || '').slice(0, 2000),
      hour: new Date().getHours(),
      // 这一轮用了出戏暗号吗 → 让壳把**身体**推上去（心跳/体温）
      ooc: oocTurn(userText),
      // 本地日期一并报上去：Rust 只有 UTC，按天聚合的长期曲线要靠它（见 fold_daily）
      day: localDay(),
      // 她此刻正在做的事（页面按本地时间挑的）→ 壳存进 state、再注入回【状态】块。
      // 空串**不会**清掉壳里那条（见 dsc_turn_report 里的说明）
      activity: activity,
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
        TURN.recent = r.recentText || '';
        TURN.peer = r.peerText || '';
        // 「他此刻」：只报进程名（Rust 侧已经把敏感进程打码、且从不读窗口标题）
        TURN.front = r.frontText || '';
        // 「他屏幕上」：只在她开着屏幕感知、而且这一段和上一轮不同时才有
        TURN.screen = r.screenText || '';
        // 【她亲眼看】壳手上有一张新截图就丢过来 —— 上传和提问只能用页面的登录态
        // （PoW + cookie），壳里做不了，所以这段路必须走页面。看到的那段用
        // `dsc_screen_see` 送回去，下一轮就拼进【他屏幕上】。
        // 【为什么不 await】它要上传 + 等解析 + 提问，好几秒 —— 挡住了会把这一轮拖死。
        // 【她亲眼看】壳手上攒着新图就丢过来（**最近 N 张**）—— 上传和提问只能用页面的
        // 登录态（PoW + cookie），壳里做不了，所以这段路必须走页面。看到的那段用
        // `dsc_screen_see` 送回去，下一轮就拼进【他屏幕上】。
        // 【为什么不 await】它要上传 + 等解析 + 提问，好几秒 —— 挡住了会把这一轮拖死。
        if (r.screenShots && r.screenShots.length) {
          seeShots(r.screenShots, r.screenSeePrev || '')['catch'](function (e) {
            log('SEE failed ' + e);
          });
        }
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
  var TURN = { scene: '', relation: '', pending: '', recent: '', peer: '', front: '', screen: '' };

  // 【为什么把它挂到页面】这几块文本平时只在"主人真发了一条"之后才被填上，而它们是注入
  // 内容的一半 —— 靠真聊一轮来验，就要登录态 + 真的花一次额度。所以给验收脚本一个只读看板，
  // 驱动入口用现成的 __DSC_REPORT_TURN__（见下面），路子与 __DSC_WRITE_DIARY__ 一致。
  window.__DSC_TURN__ = TURN;

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
    // 只留**最近一条**：隐藏链组 prompt 只要"刚刚聊了什么"，攒历史没意义（还越背越重）
    lastTurnInfo = {
      user: String(userText || '').slice(0, 600),
      assistant: String(assistantText).slice(0, 800),
      at: Date.now(),
    };
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
        // ★立绘是异步出来的，它出来了活动标签才挪得过去★
        // 不在这儿重排的话，标签会一直停在"挂载那一刻"算出的位置（那时立绘还是 0 宽），
        // 非得等到下一个 15 秒节拍才纠正 —— 用户看到的就是"标签在 HUD 那边杵着，
        // 十几秒后突然跳到立绘旁边"。
        paintActivity();
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
    // 她"出去了"就收成半透明（见 activityAway）—— 不是隐藏，是"人不在这儿"
    box.style.opacity = AVATAR.on && activityAway() ? '0.18' : AVATAR.on ? '1' : '0';
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
            // 立绘一收，活动标签就得搬回 HUD（或反过来）—— 立刻重排，别等下一个 15 秒
            paintActivity();
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
    // 活动池大概率整个换了（切角色）—— 先清空再重算，等于强制刷新；
    // 不清的话会把上一个角色的活动安到新角色头上，一眼就串味。
    // 末尾再补一次 paintActivity：新结果也是空串时 tickActivity 会直接 return，
    // 那就需要这一下把旧的显示收掉。
    activity = '';
    tickActivity();
    paintActivity();
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
  // ── 把一张图交给模型看（多模态那条路的端到端入口）────────────────────
  //
  // 【为什么要有这个探针】"能传图"这件事没法靠读代码确认：PoW 上传、id 字段名、
  // ref_file_ids 到底认不认 —— 只有真跑一次、让模型把图上的字念出来才算数。
  // 不给图的画它就现画一张带字的测试图（别拿真截图去试，那会往账号里塞东西）。
  //
  // ⚠ 每调一次，账号里就多一张图（上游没有删除接口）。
  function probeCanvas() {
    var c = document.createElement('canvas');
    c.width = 360;
    c.height = 140;
    var g = c.getContext('2d');
    g.fillStyle = '#101018';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#eae6ff';
    g.font = '30px sans-serif';
    g.fillText('主人正在看 Tauri 文档', 16, 60);
    g.fillStyle = '#a78bfa';
    g.font = '22px sans-serif';
    g.fillText('vision probe 2026', 16, 108);
    return new Promise(function (resolve) {
      c.toBlob(function (b) {
        resolve(b);
      }, 'image/png');
    });
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(',');
    var bin = atob(parts[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var m = parts[0].match(/:(.*?);/);
    return new Blob([bytes], { type: (m && m[1]) || 'image/png' });
  }

  window.__DSC_VISION_TRY__ = function (dataUrl, prompt) {
    // 【别写 root】这个文件里**没有** root 这个变量（那是 deepseek-client / sense 的写法，
    // 它们外面包了 `(function (root) {…})(window)`）。第一版抄过来，运行时报
    // "deepseek-client 没加载" —— 其实是被 ReferenceError 兜住了，白查一轮。
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.seeImage !== 'function') {
      return Promise.reject(new Error('deepseek-client 没加载（或版本太旧）'));
    }
    var blobP = dataUrl ? Promise.resolve(dataUrlToBlob(dataUrl)) : probeCanvas();
    return blobP.then(function (blob) {
      log('VISION try: ' + Math.round(blob.size / 1024) + 'KB');
      return util.seeImage(
        blob,
        prompt ||
          '这张图上写着什么？用一句话原样说出来（不要解释、不要客套）。如果没看到图，就回"没看到图"。',
        { filename: 'dsc-vision-probe.png' },
      );
    });
  };

  /* ── 多模态验收台 ──────────────────────────────────────────────────────
   *
   * 【为什么要另画一张"假屏幕"】上面那个 __DSC_VISION_TRY__ 画的是 360×140、
   * 只有两行大字的图 —— 它只能证明"通道通了"，证明不了"她读得懂屏幕"。
   * 主人看了一眼就说：「只说个头，不去关注重点」。而那张图里**本来就只有个头**。
   *
   * 这一张是仿的文档页，三档字号故意拉开：
   *   40px 大标题 / 17px 警告框 / 15px 正文 / 13px 页脚
   * 缩到不同宽度后小字先糊、大标题最后糊 —— 正好用来量**分辨率阈值**：
   * 她"只说个头"到底是图糊了，还是没被要求说重点。
   *
   * 【为什么整条链都在页面里跑】CDP 的 Runtime.evaluate 要把返回值 JSON 化搬出去，
   * 一张 1600×1000 的 PNG 转 base64 是几百 KB，来回搬又慢又容易撞上限。
   * 所以画图 → toBlob → 上传 → 提问全在页面里，只把结果搬出来。
   */
  function boardCanvas() {
    var W = 1600, H = 1000;
    var c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext('2d');
    function put(s, x, y, font, color) {
      g.font = font;
      g.fillStyle = color;
      g.fillText(s, x, y);
    }
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#f3f4f6';
    g.fillRect(0, 0, W, 56);
    put('https://docs.example.com/guide/install', 24, 36, '18px sans-serif', '#6b7280');
    g.fillStyle = '#fafafa';
    g.fillRect(0, 56, 300, H - 56);
    var nav = ['快速开始', '安装与配置', '目录结构', '构建与打包', '常见问题'];
    for (var i = 0; i < nav.length; i++) put(nav[i], 28, 124 + i * 44, '17px sans-serif', '#374151');
    put('安装与配置', 360, 150, 'bold 40px sans-serif', '#111827');
    var body = [
      '工具链需要 Rust 1.77 以上，MSVC 生成工具必须勾选。',
      '编译前先停掉正在运行的实例，否则链接会失败。',
      '默认数据目录在 %APPDATA%，可以用环境变量换一个位置。',
      '打包体积大约 5MB，首次构建需要三到五分钟。',
    ];
    for (var j = 0; j < body.length; j++) put(body[j], 360, 226 + j * 52, '15px sans-serif', '#374151');
    // 人造"重点"：整屏唯一一块有色底的东西
    g.fillStyle = '#fef3c7';
    g.fillRect(360, 490, 980, 110);
    g.strokeStyle = '#f59e0b';
    g.lineWidth = 2;
    g.strokeRect(360, 490, 980, 110);
    put('注意：有四个依赖包只在本机缓存里存在，清空缓存后会编译失败。', 384, 534, '17px sans-serif', '#92400e');
    put('先备份 target 目录，或者换一台机器重新拉依赖。', 384, 572, '17px sans-serif', '#92400e');
    g.fillStyle = '#7c3aed';
    g.fillRect(1160, 860, 200, 58);
    put('下一步：部署', 1196, 898, '20px sans-serif', '#ffffff');
    put('最后更新：2026-10-06', 360, 940, '13px sans-serif', '#9ca3af');
    return c;
  }

  function scaleCanvas(src, width) {
    var w = Math.max(1, Math.round(width));
    var h = Math.max(1, Math.round((src.height / src.width) * w));
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    return c;
  }

  function canvasBlob(c) {
    return new Promise(function (resolve) {
      c.toBlob(function (b) {
        resolve(b);
      }, 'image/png');
    });
  }

  /**
   * 探针：画板 → （可选缩放）→ 上传 → 等解析 → 读 token_usage →（可选）提问。
   *
   * opts = { width, prompt, fileId, mode: 'upload' | 'ask' }
   *   · 给了 fileId 就**不再上传**：同一张图问不同的问题，少留垃圾（上游没有删除接口）
   *   · mode='upload' 只上传 + 只读 token_usage，**不提问** —— 量成本曲线不花对话额度
   */
  window.__DSC_BOARD__ = async function (opts) {
    var o = opts || {};
    var util = window.__DSC_DS_UTIL__;
    if (!util || typeof util.seeImage !== 'function') return { ok: false, err: 'deepseek-client 没加载' };
    var t0 = Date.now();
    var out = { ok: true, mode: o.mode || 'ask', width: o.width || 1600 };
    try {
      var fileId = o.fileId;
      if (!fileId) {
        var c = o.width && o.width !== 1600 ? scaleCanvas(boardCanvas(), o.width) : boardCanvas();
        out.width = c.width;
        out.height = c.height;
        var blob = await canvasBlob(c);
        out.bytes = blob.size;
        var up = await util.uploadFile(blob, 'dsc-board-' + c.width + '.png');
        fileId = up.id;
      }
      out.fileId = fileId;
      for (var k = 0; k < 40; k++) {
        var r = await util.fetchFiles([fileId]);
        var f = ((r && r.files) || []).filter(function (x) {
          return x && x.id === fileId;
        })[0];
        if (f) {
          out.status = f.status;
          out.tokenUsage = f.token_usage;
          if (f.width) {
            out.width = f.width;
            out.height = f.height;
          }
          if (f.status === 'SUCCESS' || f.status === 'FAILED') break;
        }
        await new Promise(function (res) {
          setTimeout(res, 500);
        });
      }
      if (out.mode === 'ask') {
        var a = await util.ask(o.kind || 'see', o.prompt || '这张图上写着什么？', {
          refFileIds: [fileId],
          modelType: o.modelType || 'default',
        });
        out.text = (a && a.text) || '';
      }
      out.ms = Date.now() - t0;
      return out;
    } catch (e) {
      out.ok = false;
      out.err = String((e && e.message) || e);
      out.ms = Date.now() - t0;
      return out;
    }
  };

  // ═══════════════════ 侧栏：把"我们自己开的"会话折叠掉 ═══════════════════
  //
  // 记忆整理 / 看图 / 意图判断 / 活动 / 设置同步 各自开了一条**隐藏会话**
  // （见 deepseek-client.js 的 KINDS）。它们会出现在侧栏里，而且标题是上游拿第一句
  // prompt 自动起的 —— 看着完全像正常对话，实测是这样的：
  //     cdec2223…（看图）→ "屏幕验证目标查看"
  //     bf013857…（活动）→ "空闲时写活动"
  //     dde7944e…（记忆）→ "露娜早晨问候"
  //     1891992a…（判断）→ "情绪感知判断"
  //     d34344a4…（同步）→ "DS备份解析"
  // 又刷屏又认不出来，所以主人要"折叠起来"。
  //
  // 【怎么认出它们】会话 id 就存在 localStorage 的 `dsc-*-session` 里，而侧栏项是
  // `a[href*="/a/chat/s/"]`、href 里带着 id。**按 id 比对是确定的** —— 靠标题匹配的
  // 话，改一次 prompt 就失效（那些标题正是 prompt 的第一句）。
  //
  // 【为什么只能隐藏、不能搬走】侧栏是 React 渲染的：动它的**节点结构**会被重渲染
  // 打回去。加一个 class + 一条 CSS 是"最小改动"，重渲染后由观察器补上即可。
  // 开关行是我们自己插的元素（React 不认它），点一下记进 localStorage。
  var SYS_FOLD_KEY = 'dsc-fold-sys-sessions';

  /**
   * 从 localStorage 里抠出所有我们自己开的会话 id。
   *
   * 【为什么扫全部 `dsc-*` 而不是只扫 `-session`】会话 id 有两个落点，而且**不一定一致**：
   *   dsc-see-session = "cdec2223-…"                       ← 裸 id
   *   dsc-chain-see   = {"sessionId":"cdec2223-…", …}      ← 记账（正在用的那条）
   * 实测侧栏最前面那几条恰恰是 `dsc-chain-*` 里记的（记忆链 dde7944e、判断链 813d2bdd
   * 都不在任何 `-session` 值里），只扫 `-session` 会漏掉它们，表现就是"认出了 6 个却只藏了 4 条"。
   * 所以规则改成：**只要是 `dsc-` 开头的键，值里出现 uuid 就收**（`dsc-fold-sys-sessions`
   * 的值是 '0'/'1'，自然不会被收进来）。
   */
  function sysSessionIds() {
    var ids = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('dsc-') !== 0) continue;
        var v = String(localStorage.getItem(k) || '');
        var m = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (m && ids.indexOf(m[0]) < 0) ids.push(m[0]);
      }
    } catch (e) {
      /* 读不到就算了 —— 折叠是锦上添花，不能因为它把页面搞坏 */
    }
    return ids;
  }

  function sysFoldOn() {
    try {
      return localStorage.getItem(SYS_FOLD_KEY) !== '0'; // 默认折叠
    } catch (e) {
      return true;
    }
  }

  function ensureSysStyle() {
    if (document.getElementById('dsc-sys-style')) return;
    // 【head 可能还不存在】本脚本是 initialization_script，在 `document_start` 就跑，
    // 那一刻 head / documentElement 都可能还是 null —— 直接 appendChild 会抛。
    var host = document.head || document.documentElement;
    if (!host) return; // 下次再补，别抛
    var st = document.createElement('style');
    st.id = 'dsc-sys-style';
    st.textContent =
      'a.dsc-sys-session{display:none !important}' +
      '#dsc-sys-bar{display:flex;align-items:center;gap:6px;margin:6px 10px;padding:4px 8px;' +
      'border-radius:8px;font-size:12px;cursor:pointer;user-select:none;' +
      'color:#8a8f98;background:rgba(127,127,127,.12);width:fit-content}' +
      '#dsc-sys-bar:hover{background:rgba(127,127,127,.2);color:#c9cdd4}';
    host.appendChild(st);
  }

  /**
   * 折叠侧栏里的系统会话。返回这次折叠了几条（给验收断言用）。
   * 纯显示层：一条都不删、不改位置，只是加 class。
   */
  function foldSysSessions() {
    var ids = sysSessionIds();
    if (!ids.length) return 0;
    var on = sysFoldOn();
    var n = 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('a[href*="/a/chat/s/"]'),
      function (a) {
        var href = a.getAttribute('href') || '';
        for (var i = 0; i < ids.length; i++) {
          if (href.indexOf(ids[i]) >= 0) {
            if (on) {
              a.classList.add('dsc-sys-session');
            } else {
              a.classList.remove('dsc-sys-session');
            }
            n++;
            return;
          }
        }
      },
    );
    ensureSysStyle();
    // 开关行：插在第一条系统会话前面（找不到就插在侧栏顶部）。React 不认它，所以
    // 重渲染不会带走它 —— 但也别指望它会自己更新文案，所以每次都重设一遍文本。
    var bar = document.getElementById('dsc-sys-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'dsc-sys-bar';
      bar.addEventListener('click', function () {
        try {
          localStorage.setItem(SYS_FOLD_KEY, sysFoldOn() ? '0' : '1');
        } catch (e) {}
        foldSysSessions();
      });
      var anchor = document.querySelector('a[href*="/a/chat/s/"]');
      var host = anchor ? anchor.parentElement : null;
      if (host) host.insertBefore(bar, anchor);
      else return n;
    }
    bar.textContent = on
      ? '本小姐的杂事 · ' + n + ' 条（点开）'
      : '收起本小姐的杂事（' + n + ' 条）';
    return n;
  }

  // ═══════════════ 把注入块从消息正文里**真的藏掉** ═══════════════
  //
  // 【为什么必须动 DOM，而不是改拼法就够了】改拼法（见 applyInject）只解决"折叠露出来的是
  // 谁"—— 你要是只打「继续」两个字，折叠的那 192px 里「继续」之后**还剩一大片**，
  // 提示词照样露出来（主人的原话："那个消息刷新还是会露出完整提示词"）。
  // 而且拼法只管以后发的：**服务器存着的历史消息改不动**，那些消息的注入块就在最前面。
  //
  // 【为什么能切】实测整条消息的正文是**一个纯文本节点**（`pCount:0` / `brCount:0`），
  // 注入块和主人的话之间没有元素边界 —— 所以只能把这个文本节点切开。
  //
  // 【边界怎么找】两种落点都要覆盖：
  //     换序之前：`注入块 + 他的话`   → 他的话在**后面**
  //     换序之后：`他的话 + 注入块`   → 他的话在**前面**
  //   · 新消息：注入块的头是 `VEIL_SEP`（零宽字符），边界是**确定的**。
  //   · 旧消息：那时还没这个字符，`MARK_TAIL` 又在注入段中间 —— 只能拿"他当时到底打了什么"
  //     来反推。而那份原文壳里**有**（聊天留档，`chat_recent`），拿它一定位就精确了。
  //     定位不出来就**一个字都不动**（宁可露着，也绝不能把他的话切掉）。
  //
  // 【为什么不整体换掉那个文本节点】React 记着那个节点实例、随时会 `node.nodeValue = …`。
  // 所以**只改它的值**（留下他的话），把注入那截塞进紧随其后的 `display:none` span：
  // React 不认那个 span，而万一它把值改回全文，观察器下一轮会重新切一遍 —— 自愈。
  //
  // 【display:none 顺便解决三件事】看不见；`Ctrl+C` 复制时浏览器会跳过它（正好）；不占高度，
  // 上游那个 192px 折叠也就用不着了。
  var VEIL_KEY = 'dsc-hide-injected';
  var talkCache = { at: 0, key: '', all: [] };

  function veilOn() {
    try {
      return localStorage.getItem(VEIL_KEY) !== '0'; // 默认藏
    } catch (e) {
      return true;
    }
  }

  /** 当前会话 id（从地址栏拿）。首页 / 新对话时是空串 */
  function currentSession() {
    var m = String(location.pathname || '').match(/\/a\/chat\/s\/([0-9a-f-]{8,})/i);
    return m ? m[1] : '';
  }

  /**
   * 拉一次壳的聊天留档，缓存成"他说过的话"的清单（旧消息的边界只能从这儿拿）。
   *
   * 【为什么要按会话分组】不同会话里他可能打过一模一样的话（"继续"、"1"），
   * 同会话内的顺序对得上才敢拿来定位。
   */
  function loadTalk() {
    var now = Date.now();
    var sid = currentSession();
    if (talkCache.at && talkCache.key === sid && now - talkCache.at < 60000) return;
    talkCache.at = now;
    talkCache.key = sid;
    try {
      invoke('chat_recent', { limit: 60 })
        .then(function (rows) {
          var mine = [];
          var all = [];
          (rows || []).forEach(function (r) {
            var u = String((r && r.user) || '').trim();
            if (!u) return;
            var s = String((r && r.session) || '');
            // 会话 id 可能只存了前 8 位（留档文件里就是 `d519b459-7a4…` 这样）
            if (sid && s && (s.indexOf(sid) === 0 || sid.indexOf(s) === 0)) mine.push(u);
            all.push(u);
          });
          talkCache.all = mine.length ? mine.concat(all) : all;
          // 拿到了就立刻重切一遍（第一遍可能跑在它回来之前）
          veilMessages();
        })
        .catch(function () {});
    } catch (e) {}
  }

  /** 这条消息里"他自己打的"那一段是哪一段；切不出来就 null（那就一个字都别动） */
  function hisSpan(text) {
    // ① 加刀口之后发的新消息：零宽字符就是确定边界（他的话在前）
    var s = text.indexOf(VEIL_SEP);
    if (s >= 0) return { from: 0, to: s };

    // ②③ 没有刀口的两批，只能拿留档里他打的原文去反推。**两种落点都要试**：
    //     换序之后：`他的话 + 注入块`  → 在**开头**
    //     换序之前：`注入块 + 他的话`  → 在**末尾**
    //   短句（「1」「、」）在别处也能撞上，所以只认首尾这两头，绝不认中间。
    //   多个候选都命中时取**最长的那个** —— 「1」太短，优先信更具体的那条。
    var lead = text.length - text.replace(/^\s+/, '').length;
    var head = text.replace(/\s+$/, '');
    var best = null;
    for (var i = 0; i < talkCache.all.length; i++) {
      var u = talkCache.all[i];
      if (!u) continue;
      if (text.substr(lead, u.length) === u) {
        if (!best || u.length > (best.to - best.from)) best = { from: lead, to: lead + u.length };
      } else if (u.length <= head.length && head.slice(head.length - u.length) === u) {
        if (!best || u.length > (best.to - best.from)) {
          best = { from: head.length - u.length, to: head.length };
        }
      }
    }
    return best;
  }

  function ensureVeilStyle() {
    if (document.getElementById('dsc-veil-style')) return;
    var host = document.head || document.documentElement;
    if (!host) return;
    var st = document.createElement('style');
    st.id = 'dsc-veil-style';
    st.textContent = '.dsc-veil{display:none !important}';
    host.appendChild(st);
  }

  /** 切一条消息。返回 true = 这条确实处理过 */
  function veilCell(cell) {
    var nodes = [];
    var w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
    for (var n = w.nextNode(); n; n = w.nextNode()) {
      // 【必须排掉 veil 自己那个文本节点】切完之后这一格里有**两个**文本节点
      // （留下的话 + 藏起来的那截）。不排掉的话下面那个 `nodes.length !== 1` 永远成立，
      // 于是"重算 / 自愈"这条路整个走不通 —— 第一次切完就再也不动它了。
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      if (n.parentNode && n.parentNode.className === 'dsc-veil') continue;
      nodes.push(n);
    }
    // 【结构变了就别乱切】上游改版把正文拆成多个文本节点时，按"只有一个"的老前提动手很危险。
    if (nodes.length !== 1) return false;
    var node = nodes[0];
    var parent = node.parentNode;
    if (!parent) return false;

    var full = node.nodeValue;
    // 上一轮是我们写进去的那份值 → 拿记下来的全文重算；否则说明 React 换了内容，以它为准
    if (node.__dscShown !== undefined && full === node.__dscShown) full = node.__dscFull;
    if (full.indexOf(MARK_HEAD) < 0 && full.indexOf(VEIL_SEP) < 0) return false; // 没注入块

    var span = hisSpan(full);
    if (!span) {
      // 定位不出来：把可能的残留清掉、原文还回去，**一个字都不藏**
      if (node.__dscFull) {
        node.nodeValue = full;
        node.__dscShown = full;
        node.__dscFull = full;
      }
      Array.prototype.forEach.call(cell.querySelectorAll('.dsc-veil'), function (v) {
        if (v.parentNode) v.parentNode.removeChild(v);
      });
      return false;
    }

    var visible = full.slice(span.from, span.to).replace(/^\s+|\s+$/g, '');
    var hidden = (full.slice(0, span.from) + full.slice(span.to)).replace(/^\s+|\s+$/g, '');

    // 【内容没变就一根手指都不动】否则我们自己插的 span 会喂给观察器，转成死循环
    var prev = parent.querySelector(':scope > .dsc-veil');
    if (node.__dscShown === visible && (!hidden || (prev && prev.textContent === hidden))) return true;

    Array.prototype.forEach.call(cell.querySelectorAll('.dsc-veil'), function (v) {
      if (v.parentNode) v.parentNode.removeChild(v);
    });
    node.__dscFull = full;
    node.__dscShown = visible;
    node.nodeValue = visible;
    if (hidden) {
      var veil = document.createElement('span');
      veil.className = 'dsc-veil';
      veil.textContent = hidden;
      parent.insertBefore(veil, node.nextSibling);
    }
    return true;
  }

  /** 走一遍页面上所有消息。返回切了几条 */
  function veilMessages() {
    var n = 0;
    var on = veilOn();
    if (!on) {
      Array.prototype.forEach.call(document.querySelectorAll('.dsc-veil'), function (v) {
        if (v.parentNode) v.parentNode.removeChild(v);
      });
      return 0;
    }
    ensureVeilStyle();
    Array.prototype.forEach.call(document.querySelectorAll('.ds-collapsible-text'), function (cell) {
      try {
        if (veilCell(cell)) n++;
      } catch (e) {}
    });
    return n;
  }

  // 验收用：现在藏住了几条、每条剩下的可见文字是什么
  window.__DSC_VEIL__ = function () {
    var rows = [];
    Array.prototype.forEach.call(document.querySelectorAll('.ds-collapsible-text'), function (cell) {
      var veil = cell.querySelector('.dsc-veil');
      if (!veil) return;
      var node = null;
      var w = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, null);
      for (var n = w.nextNode(); n; n = w.nextNode()) {
        // 【别拿到 veil 自己那个文本节点】它就藏在 .dsc-veil 里面，
        // 拿错了会报出"藏了 1168 字、可见也 1168 字"这种自相矛盾的数
        if (n.nodeValue && n.nodeValue.trim() && !(n.parentNode && n.parentNode.className === 'dsc-veil')) {
          node = n;
        }
      }
      rows.push({
        visible: (cell.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        hiddenLen: veil.textContent.length,
        // ★这三个一起构成"一个字都没被吃掉"的证据★
        // 留下的 + 藏起来 = 原文（两边都 trim 过，所以会差几个空白）
        shownLen: node ? node.nodeValue.length : -1,
        fullLen: node && node.__dscFull ? node.__dscFull.length : -1,
      });
    });
    return { on: veilOn(), veiled: rows.length, rows: rows };
  };

  // 验收用：点一下"藏 / 不藏"（设置页没有这个开关，先给脚本用）
  window.__DSC_VEIL_SET__ = function (on) {
    try {
      localStorage.setItem(VEIL_KEY, on ? '1' : '0');
    } catch (e) {}
    return veilMessages();
  };

  // 侧栏 / 消息区都是 React 渲染的：它每次重画都可能把我们的 class、切好的文本冲掉，所以盯着补
  function watchSidebar() {
    // 【整段包 try】这些是**锦上添花**：崩了绝不能让主链跟着崩。这一条是被实测教出来的。
    try {
      foldSysSessions();
    } catch (e) {
      try {
        log('fold-sys 第一遍没成（不影响别处）：' + e);
      } catch (e2) {}
    }
    // 消息里的注入块：先拿留档、再切一遍（留档回来之后 loadTalk 里还会再切一次）
    try {
      loadTalk();
      veilMessages();
    } catch (e) {
      try {
        log('veil 第一遍没成（不影响别处）：' + e);
      } catch (e2) {}
    }
    try {
      if (!window.MutationObserver) return;
      var pending = false;
      new MutationObserver(function () {
        // 【为什么要 debounce】侧栏重渲染会连爆几十个 mutation，每次都全量扫一遍太浪费
        if (pending) return;
        pending = true;
        setTimeout(function () {
          pending = false;
          try {
            foldSysSessions();
          } catch (e) {}
          try {
            veilMessages();
          } catch (e) {}
        }, 300);
      })
        // 【这里千万别写 document.body】`document_start` 阶段 body 还是 null，
        // `.observe(null, …)` 抛 TypeError。而这个模块排在 **deepseek-client 之前**、
        // 又在同一个注入块里顺序执行 —— 它一崩，后面整条链全不执行：实测
        // `__DSC_REPORT_TURN__` / `__DSC_DS_UTIL__` 全变 undefined，屏幕感知也跟着废。
        // 兜到 document 本身（它一定在），子树的增删照样能观察到。
        .observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {
      try {
        log('fold-sys 观察器起不来（不影响别处）：' + e);
      } catch (e2) {}
    }
  }

  // 【为什么要等 DOM 就绪】本脚本在 `document_start` 执行，此时页面还是空的：没有 head、
  // 没有 body、侧栏一条链接都没有。实测在这一刻跑一整遍的后果是 —— 样式表插不进去（抛错），
  // 于是观察器那半段也被跳过，从此再没有人补，折叠**永远不会生效**（探针里
  // `sel:100` 但 `style:false bar:false` 就是这个现场）。所以引导必须推迟到 DOM 就绪。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchSidebar, { once: true });
  } else {
    watchSidebar();
  }

  // 验收用：数一下现在折叠了几条（0 = 没认出来）
  // `miss` = 认出了 id 但侧栏里根本没有这条链接（多半是更早的会话、侧栏没渲染到），
  // 所以**不能**断言 hidden === ids —— 能断言的是 hidden === ids - miss.length。
  window.__DSC_FOLD_SYS__ = function () {
    var ids = sysSessionIds();
    var links = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('a[href*="/a/chat/s/"]'),
      function (a) {
        links.push(String(a.getAttribute('href') || ''));
      },
    );
    var miss = [];
    for (var i = 0; i < ids.length; i++) {
      var hit = false;
      for (var j = 0; j < links.length; j++) {
        if (links[j].indexOf(ids[i]) >= 0) {
          hit = true;
          break;
        }
      }
      if (!hit) miss.push(ids[i].slice(0, 8));
    }
    return {
      ids: ids.length,
      links: links.length,
      hidden: document.querySelectorAll('a.dsc-sys-session').length,
      miss: miss,
      folded: sysFoldOn(),
      bar: !!document.getElementById('dsc-sys-bar'),
    };
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

  /** 她正在做的事的现状（验收断言用）。 */
  window.__DSC_ACTIVITY__ = function () {
    var el = document.getElementById('dsc-activity');
    var hud = document.getElementById('dsc-hud');
    var av = document.getElementById('dsc-avatar');
    var r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var ar = av ? av.getBoundingClientRect() : null;
    return {
      text: activity,
      /** 落在哪儿：avatar = 贴立绘右边 / hud = 塞进 HUD / none = 还没落位 */
      where: !el || !el.parentNode
        ? 'none'
        : el.parentNode === hud
          ? 'hud'
          : el.parentNode === document.body
            ? 'avatar'
            : 'other',
      /** 真看得见才算数（DOM 里挂着个 div ≠ 画出来了） */
      shown: !!(el && el.offsetWidth > 0),
      display: el ? el.style.display : '',
      block: Math.floor(Date.now() / ACTIVITY_BLOCK_MS),
      /** 活动池里非空、非注释的行数 */
      pool: (CFG.activities || '')
        .split('\n')
        .filter(function (l) {
          var t = l.trim();
          return t && t.charAt(0) !== '#';
        }).length,
      left: Math.round(r.left),
      top: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      avatarRight: ar ? Math.round(ar.right) : 0,
      avatarOn: !!(av && CFG.avatarEnabled !== false && av.offsetWidth > 0),
      pointerEvents: el ? getComputedStyle(el).pointerEvents : '',
      /** 壳里存着的那条（回传落到 CFG.state 了没） */
      stateActivity: (CFG.state && CFG.state.activity) || '',
    };
  };
  /** 验收用：喂一个时间块，看那个块会挑出哪条（**不改变**当前显示）。 */
  window.__DSC_ACTIVITY_AT__ = function (block) {
    return pickActivityAt(Number(block) || 0);
  };
  /** 验收用：立刻按现在重算一次（不用干等 15 秒的节拍）。 */
  window.__DSC_ACTIVITY_TICK__ = function () {
    tickActivity();
    return activity;
  };
  /** 验收用：强制重绘一次 —— 用来验"立绘开关一拨，活动标签就换地方"。 */
  window.__DSC_ACTIVITY_REPAINT__ = function () {
    paintActivity();
    return true;
  };
  /** 验收用：模型那条路的**三道闸**现状（只看闸，不发请求 —— 验收不烧额度）。 */
  window.__DSC_ACTIVITY_ASK_STATE__ = function () {
    var s = CFG.state || {};
    var block = Math.floor(Date.now() / ACTIVITY_BLOCK_MS);
    var idleMs = lastTurnInfo ? Date.now() - lastTurnInfo.at : -1;
    var mode = String(CFG.activityMode || 'auto');
    var hasPool = !!(CFG.activities && String(CFG.activities).trim());
    return {
      mode: mode,
      block: block,
      askedBlock: activityAskBlock,
      asking: activityAsking,
      hasPool: hasPool,
      turns: s.turns || 0,
      hasLastTurn: !!lastTurnInfo,
      idleMs: idleMs,
      /** 此刻调 maybeAskActivity 会不会真去问（把三道闸摊开，断言才好写） */
      wouldAsk:
        mode === 'auto' &&
        !!s.turns &&
        block !== activityAskBlock &&
        !!lastTurnInfo &&
        idleMs >= 0 &&
        idleMs <= 30 * 60 * 1000,
    };
  };
  /** 验收用：把一段「模型回复」喂给清洗函数，看它变成什么（不碰状态）。 */
  window.__DSC_ACTIVITY_CLEAN__ = function (raw) {
    return cleanActivity(raw);
  };
  /** 验收用：组好的那段隐藏链 prompt（验它带没带上下文、状态与活动池）。 */
  window.__DSC_ACTIVITY_PROMPT__ = function () {
    return lastTurnInfo ? buildActivityPrompt() : '';
  };
  /** 调试用：造一轮「刚聊过」—— 跑真链路时省得先真发一条消息。 */
  window.__DSC_ACTIVITY_SEED__ = function (user, assistant) {
    lastTurnInfo = {
      user: String(user || '').slice(0, 600),
      assistant: String(assistant || '').slice(0, 800),
      at: Date.now(),
    };
    return true;
  };
  /** 调试用：**真去问一次模型**（花一次额度，只在手动验证时用）。 */
  window.__DSC_ACTIVITY_ASK_NOW__ = function () {
    activityAskBlock = -1;
    activityAsking = false;
    askActivity();
    return true;
  };
  /** 验收用：把"这一块已经问过了"标上 —— 用来验同一个块内不会问第二次。 */
  window.__DSC_ACTIVITY_MARK_ASKED__ = function () {
    activityAskBlock = Math.floor(Date.now() / ACTIVITY_BLOCK_MS);
    return activityAskBlock;
  };
  /**
   * 验收用：把"这一块问过了"的标记**清掉**。
   *
   * 【为什么必须有它】`activityAskBlock` 是**页面状态**：上一轮脚本在末尾标过一笔，
   * 而 exe 不重启它就一直在 —— 下一轮跑到"该不该问"时全成了 false，假红。
   * 验收脚本开头一律先复位（这个坑这个项目已经踩过好几次了）。
   */
  window.__DSC_ACTIVITY_RESET_ASKED__ = function () {
    activityAskBlock = -1;
    return true;
  };
  /** 调试/验收用：直接指定当前活动（验"她跑出去时立绘变淡"这类跟活动挂钩的表现）。 */
  window.__DSC_ACTIVITY_SET__ = function (text) {
    activity = String(text || '').slice(0, 40);
    paintActivity();
    return activity;
  };
  /** 调试/验收用：这条活动算不算"她不在这个房间"。 */
  window.__DSC_ACTIVITY_AWAY__ = function () {
    return activityAway();
  };
  /**
   * 调试/验收用：直接切"安静模式"。
   *
   * 【为什么不能靠推配置】`__DSC_SET_CONFIG__` 里有一行 `CFG.taskMode = false`
   * （配置推送里没有实时的任务模式，那是每轮算出来的）—— 推配置永远进不了安静模式，
   * 只能从这儿切。
   */
  window.__DSC_QUIET__ = function (on) {
    CFG.taskMode = !!on;
    applyQuietMode();
    return !!CFG.taskMode;
  };
  /** 验收用：几个标签在此刻成不成立（验条件标签用）。 */
  window.__DSC_ACTIVITY_FITS__ = function (tags) {
    return activityFits(
      String(tags || '')
        .split(',')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean),
    );
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
    mountActivity();
    mountQuietStyle();
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
    // 她自己正在做的事：5 分钟才换一条，但**检查要勤一些** —— 状态一变（睡着了、
    // 饿了）候选集就变了，不能等她睡醒了还在显示"在打游戏"
    setInterval(tickActivity, 15000);
    tickActivity();
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
