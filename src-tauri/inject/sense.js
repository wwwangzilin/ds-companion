/* 让模型判断情绪 + 空闲时自己想说一句（B 链路，会花网页额度）
 *
 * 为什么要有这个：本地启发式（Rust 的 sense_text）只能看词，看不懂语境 ——
 * "你可真行" 是夸还是骂它就分不出。模型能。但模型要花额度，所以**门控在 Rust 侧**：
 *   ① 模式必须是 model（默认是 local，零成本）
 *   ② 距上次至少过 senseEveryTurns 轮
 *   ③ 本地感知觉得"有情绪"（intensity 够）或者攒到两倍间隔兜底
 *   ④ 当日额度还有剩（dsc_sense_reserve 先扣，扣不动就不发请求）
 *
 * 空闲主动同理：话术本地的在 Rust 那边生成（proactive_line），
 * 只有 mode=model 时才由这里发请求 —— 而且额度同样是先扣后发。
 */
(function (root) {
  'use strict';

  var HEAD = '【DS Companion 情绪感知】';
  var SENSE_BUDGET_KEY = 'dsc-sense-day';

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

  function localDay() {
    if (typeof root.__DSC_LOCAL_DAY__ === 'function') return root.__DSC_LOCAL_DAY__();
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function clip(text, max) {
    var s = String(text == null ? '' : text).trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  function transcript(sessionId) {
    try {
      if (typeof root.__DSC_TRANSCRIPT__ === 'function') return root.__DSC_TRANSCRIPT__(sessionId) || [];
    } catch (e) {
      /* ignore */
    }
    return [];
  }

  // ── 共享的调用骨架 ──────────────────────────────────────────────
  //
  // 交给 deepseek-client 的 ask()：由它负责「这条用途有自己的会话」+「接着上一条
  // 往下写」+「攒够次数换新会话」。以前这里自己 ensureSession 且 parentMessageId=null，
  // 每次都从会话的同一个根位置发 —— 侧边栏里就成了"一条消息被反复改写"（主人报的现象）。
  //
  // 三类判断（情绪感知 / 空闲主动 / 自我修订）共用 judge 这一条链：它们本质都是
  // "读一段对话、给一个判断"，混在一条链里可接受，且三个提示词都明确写了
  // "忽略上面的历史记录"。
  async function ask(prompt) {
    var util = root.__DSC_DS_UTIL__;
    if (!util || typeof util.ask !== 'function') throw new Error('deepseek-client 没加载');
    return util.ask('judge', prompt);
  }

  // ── 情绪感知 ────────────────────────────────────────────────────
  function recentTurns(limit) {
    var s = cfg();
    var st = s.state || {};
    // 优先用当前会话的留痕；没有就取留痕最多的那个
    var turns = transcript('');
    if (!turns.length) {
      var keys = [];
      try {
        if (typeof root.__DSC_TRANSCRIPT_KEYS__ === 'function') keys = root.__DSC_TRANSCRIPT_KEYS__() || [];
      } catch (e) {
        /* ignore */
      }
      for (var i = 0; i < keys.length; i++) {
        var t = transcript(keys[i]);
        if (t.length > turns.length) turns = t;
      }
    }
    return turns.slice(-(limit || 6));
  }

  function buildSensePrompt(report) {
    var s = cfg();
    var st = (report && report.state) || s.state || {};
    var sig = (report && report.signal) || {};
    var turns = recentTurns(6);
    var lines = [];
    for (var i = 0; i < turns.length; i++) {
      lines.push('用户：' + clip(turns[i].user, 300) + '\n角色：' + clip(turns[i].assistant, 400));
    }
    return [
      HEAD + '读下面这段对话，判断**角色**此刻的内心状态。',
      '',
      '（本会话里更早的内容是以前的判断记录，与本次无关，请忽略；只看下面这一段。）',
      '',
      '角色：' + (s.personaName || '（未命名）'),
      '现在的状态：心情 ' + (st.mood || '?') + '｜好感 ' + (st.affinity || 0) + '/100｜精力 ' +
        Math.round((st.energy || 0) * 100) + '%',
      st.arc ? '当前处境：' + st.arc : '',
      st.anchors && st.anchors.length ? '已知约定：' + st.anchors.join('；') : '',
      '本地关键词粗判：倾向 ' + (sig.valence || 0) + '，激动 ' + (sig.arousal || 0) +
        (sig.hits && sig.hits.length ? '（命中：' + sig.hits.join('/') + '）' : '（没命中词）'),
      '',
      '【对话记录】',
      lines.join('\n\n') || '（没有留痕）',
      '',
      '要求：',
      '1. valence（-1 到 1）她此刻的情绪倾向；arousal（0 到 1）激动程度。',
      '2. affinityDelta（-5 到 5）这轮对话让好感变化多少：被认真对待、被夸 +1~2，被冷落、被凶 -1~3，平常 0。',
      '3. mood 一个中文词（如 雀跃/满足/温和/平静/有点闷/烦躁/炸毛/低落）。',
      '4. arc 一句话说清"她眼里的当前处境"（不超过 30 字）；没新信息就留空字符串。',
      '5. anchors 最多 2 条新发现的、值得长期遵守的约定（如称呼、雷区）；没有就给空数组。',
      '6. confidence（0 到 1）你对这次判断有多有把握。',
      '只输出 JSON，不要解释、不要 markdown 代码块：',
      '{"valence":0.4,"arousal":0.6,"affinityDelta":1,"mood":"雀跃","arc":"主人在忙状态层","anchors":[],"confidence":0.7}',
    ]
      .filter(function (l) {
        return l !== '';
      })
      .join('\n');
  }

  function clamp(v, lo, hi, fallback) {
    var n = Number(v);
    if (!isFinite(n)) return fallback;
    return n < lo ? lo : n > hi ? hi : n;
  }

  /** 抠 JSON + 逐字段清洗；模型偶尔会少给字段，缺的就当"没说" */
  function parseSense(text) {
    var s = String(text == null ? '' : text);
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型没按 JSON 回：' + clip(s, 160));
    var obj;
    try {
      obj = JSON.parse(s.slice(a, b + 1));
    } catch (e) {
      throw new Error('JSON 解析失败：' + clip(s.slice(a, b + 1), 160));
    }
    var out = {};
    if (obj.valence !== undefined && obj.valence !== null && obj.valence !== '') {
      out.valence = clamp(obj.valence, -1, 1, 0);
    }
    if (obj.arousal !== undefined && obj.arousal !== null && obj.arousal !== '') {
      out.arousal = clamp(obj.arousal, 0, 1, 0.3);
    }
    if (obj.affinityDelta !== undefined && obj.affinityDelta !== null && obj.affinityDelta !== '') {
      out.affinityDelta = clamp(obj.affinityDelta, -5, 5, 0);
    }
    if (typeof obj.mood === 'string') out.mood = clip(obj.mood, 12);
    if (typeof obj.arc === 'string') out.arc = clip(obj.arc, 80);
    if (Array.isArray(obj.anchors)) {
      out.anchors = obj.anchors
        .map(function (x) {
          return clip(x, 80);
        })
        .filter(Boolean)
        .slice(0, 2);
    }
    if (obj.confidence !== undefined) out.confidence = clamp(obj.confidence, 0, 1, 0.6);
    if (
      out.valence === undefined &&
      out.arousal === undefined &&
      out.affinityDelta === undefined &&
      !out.mood &&
      !out.arc
    ) {
      throw new Error('模型回的 JSON 里没有任何可用字段');
    }
    return out;
  }

  async function sense(report) {
    var c = cfg();
    if (c.senseMode !== 'model') return { ok: false, error: '情绪感知不是 model 模式' };
    var day = localDay();
    var cap = Number(c.senseDailyCap || 30);
    // 先扣额度再发请求：宁可少花，也不能超支
    var allowed = await invoke('dsc_sense_reserve', { day: day, cap: cap });
    if (!allowed) {
      log('SENSE 跳过：当日额度用完（' + day + ' cap=' + cap + '）');
      return { ok: false, error: '当日额度用完' };
    }
    var prompt = buildSensePrompt(report);
    log('SENSE start prompt=' + prompt.length + ' 字');
    var r = await ask(prompt);
    var parsed = parseSense(r.text);
    var st = await invoke('dsc_sense_apply', { sense: parsed });
    log(
      'SENSE done（' + r.latencyMs + 'ms）' +
        JSON.stringify(parsed) +
        ' → aff=' + (st && st.affinity) + ' mood=' + (st && st.mood)
    );
    return { ok: true, sense: parsed, state: st };
  }

  // ── 空闲主动（mode=model 时才走这里） ───────────────────────────
  function buildProactivePrompt() {
    var s = cfg();
    var st = s.state || {};
    var turns = recentTurns(4);
    var last = turns.length ? turns[turns.length - 1] : null;
    return [
      HEAD + '主人已经有一阵子没说话了。请以角色的身份，主动说一句话打招呼。',
      '',
      '（本会话里更早的内容与本次无关，请忽略；只看下面这段。）',
      '',
      '角色：' + (s.personaName || '（未命名）'),
      '此刻状态：心情 ' + (st.mood || '?') + '｜好感 ' + (st.affinity || 0) + '/100｜精力 ' +
        Math.round((st.energy || 0) * 100) + '%',
      st.arc ? '你心里惦记的事：' + st.arc : '',
      last ? '上次聊到：用户说「' + clip(last.user, 150) + '」' : '（你们还刚开始聊）',
      '现在时间：' + new Date().getHours() + ' 点',
      '',
      '要求：',
      '1. 一到两句，像微信里突然发来的消息，不要客套开场白。',
      '2. 要像她本人（语气、称呼都要符合人设），可以带一点撒娇/关心/小抱怨，看状态定。',
      '3. 不要复述状态数字，不要说"根据状态显示"。',
      '4. 只输出这句话本身，不要引号、不要解释。',
    ]
      .filter(function (l) {
        return l !== '';
      })
      .join('\n');
  }

  async function proactiveLine() {
    var prompt = buildProactivePrompt();
    var r = await ask(prompt);
    var text = String(r.text || '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    // 模型偶尔会写上"角色："这种前缀，去掉
    text = text.replace(/^(角色|助手|她)[:：]\s*/, '');
    return clip(text, 160);
  }

  // ── 自我修订：让她读自己的对话，提一条改进提案 ──────────────────
  //
  // 【安全边界，别松】她只能**提案**，采纳永远由主人点。
  // 原始人设在这条链路上是只读的 —— 提案落进"自订设定"，随时可清空。
  function buildReviewPrompt() {
    var s = cfg();
    var st = s.state || {};
    var turns = recentTurns(10);
    var convo = [];
    for (var i = 0; i < turns.length; i++) {
      convo.push('主人：' + clip(turns[i].user, 300) + '\n' + (s.personaName || '她') + '：' + clip(turns[i].assistant, 500));
    }
    var anchorList = (st.anchors || []).map(function (a) { return '- ' + a; }).join('\n');
    var msList = (st.milestones || []).map(function (m) { return m.title; }).join('、');
    return [
      HEAD + '现在请以角色的身份**反省自己**，看看有没有该改进的地方。',
      '',
      '（本会话里更早的内容是以前的反省记录，与本次无关，请忽略；只看下面这一次。）',
      '',
      '你是：' + (s.personaName || '（未命名）'),
      '你此刻的状态：心情 ' + (st.mood || '?') + '｜好感 ' + (st.affinity || 0) + '/100｜第 ' +
        (st.milestones && st.milestones.length ? st.milestones.length : 0) + ' 条里程碑',
      '你已知的约定：',
      anchorList || '（还没记下什么）',
      msList ? '你俩的里程碑：' + msList : '',
      st.addendum ? '你之前给自己补过：\n' + st.addendum : '（你还没给自己补过设定）',
      st.arc ? '你眼里的近况：' + st.arc : '',
      '',
      '【最近的对话】',
      convo.join('\n\n') || '（还没有对话可反省）',
      '',
      '反省要求：',
      '1. 只看**你自己的表现**：说话方式、称呼、分寸、有没有跑偏或机械。不要去评价主人。',
      '2. personaAddendum：最多一句话的自我修正（"以后……"），要具体、可执行；没想改就给空字符串。',
      '3. anchors：这几轮里冒出来的、值得长期遵守的新约定（如称呼、雷区），最多 2 条；没有就给空数组。',
      '4. arc：一句话更新"你眼里的近况"；没变化就给空字符串。',
      '5. reason：为什么这么改（一句话，给主人审阅用）。',
      '只输出 JSON，不要解释、不要 markdown 代码块：',
      '{"personaAddendum":"","anchors":[],"arc":"","reason":""}',
    ]
      .filter(function (l) {
        return l !== '';
      })
      .join('\n');
  }

  function parseReview(text) {
    var s = String(text == null ? '' : text);
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型没按 JSON 回：' + clip(s, 160));
    var obj;
    try {
      obj = JSON.parse(s.slice(a, b + 1));
    } catch (e) {
      throw new Error('JSON 解析失败：' + clip(s.slice(a, b + 1), 160));
    }
    var out = {
      personaAddendum: clip(obj.personaAddendum || obj.addendum || '', 200),
      anchors: Array.isArray(obj.anchors)
        ? obj.anchors.map(function (x) { return clip(x, 80); }).filter(Boolean).slice(0, 2)
        : [],
      arc: clip(obj.arc || '', 80),
      reason: clip(obj.reason || '', 200),
    };
    if (!out.personaAddendum && !out.anchors.length && !out.arc) {
      throw new Error('她这次没提出任何改动');
    }
    return out;
  }

  async function selfReview() {
    var c = cfg();
    if (String(c.selfReviewMode || 'manual') === 'off') {
      return { ok: false, error: '自我修订是关的' };
    }
    var day = localDay();
    var cap = Number(c.selfReviewDailyCap || 10);
    // 先扣额度再发请求（和情绪感知一个规矩：宁可少花，不能超支）
    var allowed = await invoke('dsc_review_reserve', { day: day, cap: cap });
    if (!allowed) {
      log('REVIEW 跳过：今日额度用完（' + day + ' cap=' + cap + '）');
      return { ok: false, error: '今天反思的次数用完了' };
    }
    var prompt = buildReviewPrompt();
    log('REVIEW start prompt=' + prompt.length + ' 字');
    var r = await ask(prompt);
    var parsed = parseReview(r.text);
    var st = c.state || {};
    var saved = await invoke('dsc_review_submit', {
      proposal: {
        id: '',
        characterId: c.personaId || '',
        createdAt: 0,
        turn: st.turns || 0,
        personaAddendum: parsed.personaAddendum,
        anchors: parsed.anchors,
        arc: parsed.arc,
        reason: parsed.reason,
        status: '',
        appliedAt: 0,
      },
    });
    log(
      'REVIEW done（' + r.latencyMs + 'ms）提案 ' + (saved && saved.id) +
        ' 自订设定「' + parsed.personaAddendum + '」锚点 ' + parsed.anchors.length
    );
    if (typeof root.__DSC_NOTIFY_PROPOSAL__ === 'function') root.__DSC_NOTIFY_PROPOSAL__(saved);
    return { ok: true, proposal: saved, parsed: parsed };
  }

  root.__DSC_SELF_REVIEW__ = function () {
    return selfReview().catch(function (e) {
      var msg = String((e && e.message) || e);
      log('REVIEW FAILED: ' + msg);
      return { ok: false, error: msg };
    });
  };

  /** 隐藏链（情绪感知 / 主动开口 / 自我修订）失败时的统一上报。
   *
   * 【为什么值得单独一个函数】这三条链都跑在隐藏会话里、都由 catch 兜住，
   * 而 catch 里"只 log"就等于静默失败 —— 日志在 %TEMP%\ds-companion.log 里躺着，
   * 设置页看不到。体检对象（inject.js 里的 health）是主人唯一能看见的那一面，
   * 所以失败必须往那儿写一份。顺带记下 hidden / online：这两项能一眼区分
   * "页面在后台被节流"和"真的断网/没登录态"。
   */
  function reportChainFailure(what, msg) {
    try {
      var h = root.__DSC_HEALTH__;
      if (!h) return;
      var doc = root.document || {};
      var online = root.navigator ? root.navigator.onLine : '?';
      h.lastError = what + '失败：' + msg + '（hidden=' + !!doc.hidden + ' online=' + online + '）';
      if (typeof root.__DSC_PUBLISH_HEALTH__ === 'function') {
        root.__DSC_PUBLISH_HEALTH__('chain-failed');
      }
    } catch (e) {
      /* 上报本身绝不能影响主流程 */
    }
  }

  // ── 意图判断（任务模式的模型二判） ──────────────────────────────
  //
  // 【为什么要模型】本地 `sense_task` 是纯关键词打分，它自己的注释写着"宁可漏判、
  // 不可误判"—— 而"帮我看看这个"和"今天好累"在词面上确实难分。Rust 侧只把
  // **贴着门槛**的那几档放过来（`state::want_task_judge`），所以这不是每轮的常规开销。
  function buildTaskPrompt(userText, localTask, score, hits) {
    return [
      HEAD + '判断下面这句话：用户是在**派活 / 问技术问题**，还是在**闲聊 / 表达情绪**？',
      '',
      '（本会话里更早的内容是以前的判断记录，与本次无关，请忽略；只看下面这一句。）',
      '',
      '【用户这句话】',
      clip(userText, 500) || '（空）',
      '',
      '本地关键词粗判：' + (localTask ? '看着像干活' : '看着像闲聊') +
        '（分数 ' + score + (hits && hits.length ? '，命中：' + hits.join('/') : '') + '）',
      '',
      '要求：',
      '1. 只回答一行 JSON，不要任何别的文字：{"task": true} 或 {"task": false}',
      '2. task=true 的定义：用户在**要求角色动手做事**——改代码、查资料、排错、写文档、执行命令、安排任务。',
      '3. 只是提到技术名词、或者在抱怨工作、说自己累，一律算 task=false。',
      '4. 拿不准就判 false：把她当日常伴侣，比当工具安全。',
    ].join('\n');
  }

  function parseTask(text) {
    var m = String(text || '').match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try {
      var o = JSON.parse(m[0]);
      return typeof o.task === 'boolean' ? { task: o.task } : null;
    } catch (e) {
      return null;
    }
  }

  /** 页面侧入口：判一次"这轮是不是在派活"。失败返回 null（调用方保持本地判定）。 */
  root.__DSC_TASK_JUDGE__ = function (userText, localTask, score, hits) {
    return ask(buildTaskPrompt(userText, localTask, score, hits))
      .then(function (r) {
        var parsed = parseTask(r && r.text);
        if (!parsed) {
          log('TASK-JUDGE 解析失败：' + clip(String((r && r.text) || ''), 120));
          return null;
        }
        log('TASK-JUDGE model=' + parsed.task + ' local=' + localTask + ' score=' + score);
        return parsed;
      })
      .catch(function (e) {
        var msg = String((e && e.message) || e);
        log('TASK-JUDGE FAILED: ' + msg);
        reportChainFailure('意图判断', msg);
        return null;
      });
  };

  // ── 她的日记 ────────────────────────────────────────────────────
  //
  // 【为什么非模型不可】日记的全部价值在于"那是她写的"。用模板拼一句
  // 「今天和主人聊了 12 轮、好感 81」—— 那不是日记，是流水账，主人不会想看第二遍。
  //
  // 【素材一次给全】壳已经把"哪天、聊了几轮、当时好感、那天的对话节选"都递过来了，
  // 这里一次问完 —— 每次隐藏请求都是真额度，绝不回问第二次。
  function buildDiaryPrompt(want) {
    var w = want || {};
    var val = Number(w.valence);
    if (!isFinite(val)) val = 0;
    var feel = val > 0.15 ? '偏愉快' : val < -0.15 ? '有点低落' : '平平的';
    return [
      HEAD + '现在不是聊天，是**写日记**。',
      '',
      '（本会话里更早的内容是以前的判断记录，与本次无关，请忽略。）',
      '',
      '【写哪一天】' + (String(w.day || '') || '（不知道）'),
      '【那天的样子】聊了 ' + (Number(w.turns) || 0) + ' 轮｜当时好感 ' +
        (Number(w.affinity) || 0) + '/100｜情绪 ' + feel + '（' + val.toFixed(2) + '）',
      '',
      '【那天的对话节选】',
      clip(w.excerpt, 1400) || '（那天没留下什么话）',
      '',
      '要求：',
      '1. 用**你自己的口吻**写，第一人称，写给自己看 —— 不是汇报，是记给自己的一点心思。',
      '2. 60~160 字，一段就够。可以写那天印象最深的一句、当时没说出口的话、或者一点小心情。',
      '3. 只写上面真实出现过的内容，**不要编造**没有发生过的情节。',
      '4. 直接给正文：不要标题、不要日期、不要 Markdown 代码块，也不要解释你在做什么。',
    ].join('\n');
  }

  /** 把模型那段话收拾成能落盘的正文。
   *
   * 模型偶尔会带上"日记正文："这类抬头、日期、或者包一层 ```；文件名本身就是日期，
   * 抬头再来一遍只会让日记本看起来像个模板。超长也在这里截断 —— 一天一段，
   * 不该写成小作文。
   */
  function parseDiary(text) {
    var s = String(text == null ? '' : text).trim();
    if (!s) return '';
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
    s = s.replace(/^(?:日记)?(?:正文|正文如下|内容)?\s*[:：]\s*/, '');
    if (s.length > 1200) s = s.slice(0, 1200).trim();
    return s;
  }

  /** 页面侧入口：替她写一篇日记。失败返回 `''`（调用方什么都不做）。 */
  root.__DSC_DIARY__ = function (want) {
    return ask(buildDiaryPrompt(want))
      .then(function (r) {
        var text = parseDiary(r && r.text);
        if (!text) {
          log('DIARY 空回复，跳过');
          return '';
        }
        log('DIARY ' + ((want && want.day) || '?') + ' → ' + text.length + ' 字');
        return text;
      })
      .catch(function (e) {
        var msg = String((e && e.message) || e);
        log('DIARY FAILED: ' + msg);
        reportChainFailure('写日记', msg);
        return '';
      });
  };

  root.__DSC_SENSE_UTIL__ = {
    buildSensePrompt: buildSensePrompt,
    buildTaskPrompt: buildTaskPrompt,
    parseTask: parseTask,
    buildDiaryPrompt: buildDiaryPrompt,
    parseDiary: parseDiary,
    buildProactivePrompt: buildProactivePrompt,
    buildReviewPrompt: buildReviewPrompt,
    parseSense: parseSense,
    parseReview: parseReview,
    clip: clip,
    HEAD: HEAD,
  };

  root.__DSC_SENSE__ = function (report) {
    return sense(report).catch(function (e) {
      var msg = String((e && e.message) || e);
      log('SENSE FAILED: ' + msg);
      reportChainFailure('情绪感知', msg);
      return { ok: false, error: msg };
    });
  };
  root.__DSC_PROACTIVE_LINE__ = function () {
    return proactiveLine().catch(function (e) {
      var msg = String((e && e.message) || e);
      log('PROACTIVE-LINE FAILED: ' + msg);
      // 【不只是打日志】"她会自己开口"是这个产品最像活人的机制，而它以前**静默失败**：
      // 主人只能从"她怎么总不开口"倒推，翻日志才知道。这里按 tool-loop 那套把证据
      // 写进体检对象（设置页直接看得见），并记下当时的页面可见性 —— WebView 被最小化 /
      // 收进托盘时的节流，正是这类 Failed to fetch 的常见成因。
      reportChainFailure('主动开口', msg);
      return '';
    });
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__DSC_SENSE_UTIL__;
  }
})(typeof window !== 'undefined' ? window : globalThis);
