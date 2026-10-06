/* DeepSeek 网页端自己的请求通道（记忆提取用）
 *
 * 为什么要有这个：网页版没有 API key，但页面自己是登录态。我们以"页面身份"
 * 发一条隐藏请求，就能让模型帮我们整理记忆 —— 质量最好，代价是多花一次网页额度。
 *
 * 三件事都是 gal 扩展已经跑通、这里照搬的：
 *   ① token            = localStorage.userToken（同源直接读，不用截请求头）
 *   ② PoW              = POST /api/v0/chat/create_pow_challenge + 本地 26KB wasm 解，
 *                        结果塞进 X-DS-PoW-Response（base64 的 UTF-8 JSON，含 target_path）
 *   ③ 答复解析         = 读 SSE，按 fragment 类型区分正文与思考（THINK 的不算）
 *
 * 【关键】我们自己的请求也要带 bypass 头，否则会被自家注入钩子再拼一次人设/记忆。
 */
(function (root) {
  'use strict';

  var ROUTES = {
    completion: '/api/v0/chat/completion',
    powChallenge: '/api/v0/chat/create_pow_challenge',
    createSession: '/api/v0/chat_session/create',
    historyMessages: '/api/v0/chat/history_messages',
  };
  var BYPASS_HEADER = 'x-dsc-bypass';
  var SESSION_KEY = 'dsc-memory-session';
  var PLATFORM = 'web';
  var APP_VERSION = '2.0.0';

  // 隐藏会话分家。
  //
  // 以前四条链路（记忆整理 / 情绪感知 / 自我修订 / 主动搭话）全挤在同一个会话里，
  // 每次都以 parent_message_id=null 从根发 —— DeepSeek 把同根消息当成**同一条消息的
  // 不同版本**，所以在侧边栏里看着就是"一条消息被反复改写"。
  // （主人报的现象已用 /api/v0/chat/history_messages 实测确认：活跃分支永远只有
  //  1 问 1 答，旧的全被折叠成版本号，看不见。）
  //
  // 现在按用途分成三条会话，各自**往下接**：拿上一条的 response_message_id 当
  // parent_message_id，于是一段段往下排成一条能回看的记录。
  // 代价是每次请求会带上该会话之前的历史，所以有上限（hiddenChainTurns），到点换新的。
  var KINDS = {
    memory: { session: 'dsc-memory-session', chain: 'dsc-chain-memory' },
    judge: { session: 'dsc-judge-session', chain: 'dsc-chain-judge' },
    ping: { session: 'dsc-ping-session', chain: 'dsc-chain-ping' },
    // 设置同步：每次导出都**另开一个空对话**（force），不复用 —— 复用会让每条新包
    // 把之前所有包都当上下文带上，成本一次比一次高。攒下来的备份对话主人自己删。
    sync: { session: 'dsc-sync-session', chain: 'dsc-chain-sync' },
    // 「她手上正在做的事」：让**模型**按当前场景写一条（本地活动池只是兜底）。
    //
    // 【为什么必须走隐藏链，不能搭主对话的车】她在主对话里输出的任何标记都会被上游
    // **流式渲染进聊天框** —— 而这项目的注入脚本从来不碰上游聊天 DOM（改了也会被
    // React 重渲染盖掉）。所以"对主人不可见的结构化往返"只有隐藏链承载得了。
    act: { session: 'dsc-act-session', chain: 'dsc-chain-act' },
  };
  var DEFAULT_CHAIN_TURNS = 20;

  var DS = {
    lastError: null,
    lastReply: null,
    lastLatencyMs: null,
    sessionId: null,
    wasmLoaded: false,
    /** 上一次请求从 SSE 里抠出来的消息 id（{requestMessageId, responseMessageId}） */
    lastMeta: null,
    /** 每条链各自的会话（kind → 会话 id），别再互相踩 */
    sessions: Object.create(null),
  };
  root.__DSC_DS__ = DS;

  function log(msg) {
    try {
      if (typeof root.__DSC_LOG__ === 'function') root.__DSC_LOG__(msg);
    } catch (e) {
      /* ignore */
    }
  }

  /** 页面侧的配置副本（壳推过来的）。读不到就当空 —— 各项都有代码兜底默认值 */
  function cfg() {
    try {
      if (typeof root.__DSC_CFG__ === 'function') return root.__DSC_CFG__() || {};
    } catch (e) {
      /* ignore */
    }
    return {};
  }

  function kindOf(kind) {
    return KINDS[kind] ? kind : 'memory';
  }

  /** 链状态：{sessionId, lastMessageId, turns}。落 localStorage，重启页面也接得上 */
  function readChain(kind) {
    try {
      var raw = localStorage.getItem(KINDS[kindOf(kind)].chain);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (e) {
      return null;
    }
  }

  function writeChain(kind, st) {
    try {
      localStorage.setItem(KINDS[kindOf(kind)].chain, JSON.stringify(st));
    } catch (e) {
      /* ignore */
    }
  }

  /** 链的上限：0 = 一直往下接不轮换；配错/没配就退回默认 */
  function chainLimit(override) {
    var n = Number(override);
    if (!isFinite(n) || n < 0) n = Number(cfg().hiddenChainTurns);
    if (!isFinite(n) || n < 0) n = DEFAULT_CHAIN_TURNS;
    return n;
  }

  // ── token 与客户端头 ─────────────────────────────────────────────
  function tryParseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function readToken() {
    try {
      var raw = localStorage.getItem('userToken');
      if (!raw) return null;
      var parsed = tryParseJson(raw);
      if (typeof parsed === 'string') return parsed.trim() || null;
      if (parsed && typeof parsed === 'object') {
        return firstString(parsed.token, parsed.value, parsed.accessToken);
      }
      if (raw.trim() === 'null') return null;
      return raw.trim() || null;
    } catch (e) {
      return null;
    }
  }

  function clientHeaders() {
    var token = readToken();
    if (!token) throw new Error('没读到登录 token（localStorage.userToken 为空），请先在页面里登录');
    return {
      Authorization: 'Bearer ' + token,
      'X-App-Version': APP_VERSION,
      'x-client-platform': PLATFORM,
      'x-client-version': APP_VERSION,
      'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      [BYPASS_HEADER]: '1',
    };
  }

  function base64FromBytes(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64Utf8(text) {
    return base64FromBytes(new TextEncoder().encode(text));
  }

  function bytesFromBase64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function postJson(url, body, headers) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
      body: JSON.stringify(body || {}),
    });
  }

  // ── PoW ──────────────────────────────────────────────────────────
  async function loadWasm() {
    if (DS.wasm) return DS.wasm;
    var b64 = root.__DSC_POW_WASM_B64__;
    if (!b64) throw new Error('没有内联 PoW wasm');
    var bytes = bytesFromBase64(b64);
    if (!(bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) {
      throw new Error('PoW wasm 头不对（期望 \\0asm）');
    }
    var mod = await WebAssembly.instantiate(bytes, {});
    DS.wasm = mod.instance.exports;
    DS.wasmLoaded = true;
    return DS.wasm;
  }

  function writeWasmString(wasm, value) {
    var bytes = new TextEncoder().encode(value);
    var ptr = wasm.__wbindgen_export_0(bytes.length, 1);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return { ptr: ptr, len: bytes.length };
  }

  function solveWithWasm(wasm, target, prefix, difficulty) {
    var retPtr = wasm.__wbindgen_add_to_stack_pointer(-16);
    var c = writeWasmString(wasm, target);
    var p = writeWasmString(wasm, prefix);
    try {
      wasm.wasm_solve(retPtr, c.ptr, c.len, p.ptr, p.len, difficulty);
      var view = new DataView(wasm.memory.buffer);
      var status = view.getInt32(retPtr, true);
      var answer = view.getFloat64(retPtr + 8, true);
      if (status !== 1 || !Number.isSafeInteger(answer) || answer < 0) {
        throw new Error('PoW 在难度 ' + difficulty + ' 下无解');
      }
      return answer;
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  async function powHeader(targetPath) {
    var headers = clientHeaders();
    var res = await postJson(ROUTES.powChallenge, { target_path: targetPath }, headers);
    var json = await res.json();
    var challenge = json && json.data && json.data.biz_data && json.data.biz_data.challenge;
    if (!challenge) {
      throw new Error('没拿到 PoW challenge：' + JSON.stringify(json).slice(0, 200));
    }
    // ⚠ API 用的是 snake_case（expire_at），gal 那句 `challenge.expire_at ?? challenge.expireAt`
    // 就是为此 —— 只认 expireAt 会拼出 "salt_undefined_"，PoW 永远无解（踩过一次）。
    var expireAt = Number(challenge.expire_at !== undefined ? challenge.expire_at : challenge.expireAt);
    var difficulty = Number(challenge.difficulty);
    if (!Number.isFinite(expireAt) || expireAt <= 0 || !Number.isFinite(difficulty) || difficulty <= 0) {
      throw new Error(
        'PoW challenge 字段不认识：' + JSON.stringify(challenge).slice(0, 300),
      );
    }
    var prefix = challenge.salt + '_' + expireAt + '_';
    var wasm = await loadWasm();
    var answer;
    try {
      answer = solveWithWasm(wasm, String(challenge.challenge).toLowerCase(), prefix, difficulty);
    } catch (e) {
      // 失败时把原始 challenge 打出来，下次字段改名一眼可见
      log('DS pow-raw=' + JSON.stringify(challenge).slice(0, 300));
      throw e;
    }
    var payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: answer,
      signature: challenge.signature,
      target_path: targetPath,
    };
    return { 'X-DS-PoW-Response': base64Utf8(JSON.stringify(payload)) };
  }

  // ── 会话 ────────────────────────────────────────────────────────
  async function createSession() {
    var res = await postJson(ROUTES.createSession, {}, clientHeaders());
    var json = await res.json();
    var id = json && json.data && json.data.biz_data && json.data.biz_data.chat_session && json.data.biz_data.chat_session.id;
    if (!id) throw new Error('建会话失败：' + JSON.stringify(json).slice(0, 200));
    return id;
  }

  async function ensureSession(force, kind) {
    var k = kindOf(kind);
    var key = KINDS[k].session;
    if (!force && DS.sessions[k]) return DS.sessions[k];
    if (!force) {
      try {
        var cached = localStorage.getItem(key);
        if (cached) {
          DS.sessions[k] = cached;
          DS.sessionId = cached;
          return cached;
        }
      } catch (e) {
        /* ignore */
      }
    }
    var id = await createSession();
    DS.sessions[k] = id;
    DS.sessionId = id;
    try {
      localStorage.setItem(key, id);
    } catch (e) {
      /* ignore */
    }
    return id;
  }

  /**
   * 读某会话**当前活跃分支**的尾巴 —— 只读，零额度。
   *
   * 两个用途：① 老版本留下的会话没有链状态，第一次接的时候把尾巴认下来，
   * 免得又开一条兄弟分支（那正是主人抱怨的"一直修改一条消息"）；
   * ② SSE 里万一没带消息 id（上游改帧格式），拿它兜底。
   */
  async function historyTail(sessionId) {
    var url =
      ROUTES.historyMessages +
      '?chat_session_id=' +
      encodeURIComponent(String(sessionId)) +
      '&count=50';
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: clientHeaders(),
    });
    if (!res.ok) throw new Error('history HTTP ' + res.status);
    var json = await res.json();
    var biz = json && json.data && json.data.biz_data;
    var msgs = (biz && biz.chat_messages) || [];
    var ids = [];
    var lastAssistant = 0;
    for (var i = 0; i < msgs.length; i++) {
      var mid = Number(msgs[i] && msgs[i].message_id);
      if (mid) ids.push(mid);
      if (msgs[i] && msgs[i].role === 'ASSISTANT' && mid) lastAssistant = mid;
    }
    return {
      count: msgs.length,
      ids: ids,
      /** 分支上最后一条消息的 id（一般是助手的回复）—— 下一次就以它为 parent */
      lastId: ids.length ? ids[ids.length - 1] : 0,
      lastAssistantId: lastAssistant,
      currentMessageId: Number((biz && biz.chat_session && biz.chat_session.current_message_id) || 0),
    };
  }

  /**
   * 把一条历史消息里的**正文**抠出来。
   *
   * 【为什么不能直接读 m.content】各版本的形状不一样：有的是纯字符串，有的是
   * `{"content":"…"}` 这样的 JSON 字符串，还有的把正文放进 fragments。注入脚本
   * 面对的是**别人家的接口**，形状随时会变 —— 认不出就返回空串，让调用方去报
   * "没找到包"，而不是抛一个看不懂的异常。
   */
  function contentText(value, depth) {
    var d = depth || 0;
    if (d > 3) return '';
    if (typeof value === 'string') {
      var s = value.trim();
      if (s.charAt(0) === '{' || s.charAt(0) === '[') {
        try {
          var inner = contentText(JSON.parse(s), d + 1);
          if (inner) return inner;
        } catch (e) {
          /* 不是 JSON，就当纯文本 */
        }
      }
      return value;
    }
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var t = contentText(value[i], d + 1);
        if (t) parts.push(t);
      }
      return parts.join('');
    }
    if (value && typeof value === 'object') {
      var keys = ['content', 'text', 'value'];
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        if (typeof value[k] === 'string' && value[k]) return contentText(value[k], d + 1);
      }
      var fkeys = ['fragments', 'parts'];
      for (var fi = 0; fi < fkeys.length; fi++) {
        var fk = fkeys[fi];
        if (Array.isArray(value[fk])) {
          var frags = value[fk];
          var out = [];
          for (var j = 0; j < frags.length; j++) {
            var f = frags[j];
            var ty = String((f && f.type) || '').toUpperCase();
            // THINK 是思考，不算正文（跟 SSE 解析那边一个口径）
            if (ty === 'THINK' || ty === 'THINKING') continue;
            var ft = contentText(f && (f.content !== undefined ? f.content : f), d + 1);
            if (ft) out.push(ft);
          }
          if (out.length) return out.join('');
        }
      }
    }
    return '';
  }

  /**
   * 读某会话的**完整消息**（含正文）—— 设置同步要把自己发进去的包读回来。
   *
   * 和 historyTail 的区别：那个只抠 id（给会话链当 parent 用），这个要正文。两条
   * 各留各的：会话链是每轮都要跑的，让它顺带搬一堆正文纯属浪费。
   */
  async function historyMessages(sessionId) {
    var url =
      ROUTES.historyMessages +
      '?chat_session_id=' +
      encodeURIComponent(String(sessionId)) +
      '&count=200';
    var res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: clientHeaders(),
    });
    if (!res.ok) throw new Error('history HTTP ' + res.status);
    var json = await res.json();
    var biz = json && json.data && json.data.biz_data;
    var msgs = (biz && biz.chat_messages) || [];
    var out = [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i] || {};
      out.push({
        messageId: Number(m.message_id) || 0,
        role: String(m.role || ''),
        text: contentText(m.content !== undefined ? m.content : m),
      });
    }
    return out;
  }

  // ── SSE 解析（按 fragment 归并，正文与思考分开） ──────────────────
  //
  // 实测：DeepSeek 的答复**可能整段随"完整快照"到达**
  //   data: {"v":{"response":{…,"fragments":[{"type":"RESPONSE","content":"OK"}]}}}
  // 而不是逐个增量。所以不能只累加增量（那样会解析出空字符串，踩过一次），
  // 得维护一份 fragment 表：快照 → 整体替换；增量 → 追加。
  // 类型为 THINK 的是思考，不算正文。
    /**
   * 【一次性诊断】把最近一轮 SSE 的帧结构摊平（路径 / 类型 / 样本）。
   * 思考与正文的分界只有原始帧说得清，这份 dump 是排查"内心独白漏出来"的唯一依据。
   */
  function collectDiag(raw) {
    var paths = {};
    var types = {};
    var samples = [];
    var lines = String(raw).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var p = line.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      if (samples.length < 6) samples.push(p.slice(0, 260));
      var j;
      try {
        j = JSON.parse(p);
      } catch (e) {
        continue;
      }
      var frames = j && j.o === 'BATCH' && Array.isArray(j.v) ? j.v : [j];
      for (var k = 0; k < frames.length; k++) {
        var f = frames[k];
        if (!f || typeof f !== 'object') continue;
        if (typeof f.p === 'string') paths[f.p] = (paths[f.p] || 0) + 1;
        var snap = f.v && typeof f.v === 'object' && !Array.isArray(f.v) ? f.v.response : null;
        if (snap && Array.isArray(snap.fragments)) {
          snap.fragments.forEach(function (fr) {
            var key = (fr && fr.type) || '(none)';
            types[key] = (types[key] || 0) + 1;
          });
        }
      }
    }
    return { rawLen: String(raw).length, types: types, paths: paths, samples: samples };
  }

  /**
   * 解析 SSE → 正文文本（**排除思考**）。
   *
   * 【为什么整个重写】原来是一遍扫描 + 一边维护 `frags`/`kinds` 两个数组，实测栽在一个
   * 很具体的坑上：快照到达时**可能只带开头那一个 THINK 片段**，而正文增量的路径是
   * `response/fragments/-1/content` —— `-1` 的真实语义是"**当前正在输出的那个片段**"，
   * 但旧代码把它当成"最后一个已声明的片段"，于是正文被写进那个 THINK 片段、再被整段
   * 丢掉；而思考结束后的 RESPONSE 片段从头到尾没被声明过。
   * 表现就是：**她的内心独白被当正文播给主人看**（"用户要求我查看 src 目录…"）。
   *
   * 现在的做法分三段，各司其职：
   *   ① 先扫一遍快照，记下 `fragments[i].type`（思考/正文的类型清单）
   *   ② 再按帧路径把内容**按 fragment 索引**归位：`<i>` 是真数字就用它；
   *      `-1` 按语义归到"当前片段"（有快照就用它的长度-1，否则用类型清单的长度-1）
   *   ③ 最后只拼 text 类片段，think 类一律不要
   */
  function parseSseText(raw) {
    var text = String(raw == null ? '' : raw);
    var types = {}; // 索引 -> 'THINK' | 'RESPONSE' | ...
    var parts = {}; // 索引 -> 内容

    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      var parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      var frames = parsed && parsed.o === 'BATCH' && Array.isArray(parsed.v) ? parsed.v : [parsed];
      for (var k = 0; k < frames.length; k++) noteFrame(frames[k], types, parts);
    }

    var out = '';
    var thinkOnly = '';
    var hasResponseFrag = false;
    var indexes = Object.keys(parts).map(Number).sort(function (a, b) {
      return a - b;
    });
    for (var n = 0; n < indexes.length; n++) {
      var idx = indexes[n];
      var kind = String(types[idx] || '').toUpperCase();
      if (kind === 'THINK') {
        thinkOnly += parts[idx];
        continue;
      }
      hasResponseFrag = true;
      out += parts[idx];
    }
    root.__DSC_SSE_DIAG__ = collectDiag(text);

    // 【判据换成"帧里有没有 RESPONSE 片段"】—— 把之前那套"猜措辞"的兜底整个删掉。
    //
    // 实测的帧结构（这一轮）：`fragments` 里**只有 1 个 THINK**，所有内容增量都走
    // `response/fragments/-1/content`，从头到尾没有 RESPONSE 片段 —— 而 DeepSeek 的
    // **页面上照样把它当正文显示**。也就是说：这一轮"思考/正文的边界"根本不存在，
    // 模型只在思考里说话。
    //
    // 所以正确的规则是：
    //   · 帧里有 RESPONSE 片段 → out 就是正文，思考已被精确切掉（正常情况）
    //   · 一个 RESPONSE 都没有、只有 THINK → 和**页面口径保持一致**，把思考当正文用。
    //     否则主人在页面上看得见字、我们这边却是空回复 —— 那比"内心戏漏出来"更糟，
    //     而且会连带把回灌链路整个吞掉（之前就是这么把 132 字的回答吃掉的）。
    var onlyThink = !hasResponseFrag && !!thinkOnly;
    if (onlyThink) {
      root.__DSC_LAST_THINK__ = thinkOnly;
      root.__DSC_LAST_EMPTY_KIND__ = '';
      log('DS 这轮只有 THINK 片段、没有 RESPONSE，按页面口径当正文用（' + thinkOnly.length + ' 字）');
      return thinkOnly;
    }
    root.__DSC_LAST_EMPTY_KIND__ = '';
    return out;
  }

  /** 把一个帧里的内容归位到对应 fragment 索引 */
  function noteFrame(f, types, parts) {
    if (!f || typeof f !== 'object') return;
    // 快照：更新类型清单（**不清空内容** —— 快照是增量的补充说明，不是唯一真相；
    // 而且快照可能只带开头那个 THINK 片段，后面的正文得靠增量补）
    if (f.v && typeof f.v === 'object' && !Array.isArray(f.v) && f.v.response) {
      var snap = f.v.response;
      if (Array.isArray(snap.fragments)) {
        for (var i = 0; i < snap.fragments.length; i++) {
          var fr = snap.fragments[i] || {};
          types[i] = fr.type || types[i] || 'RESPONSE';
          if (
            typeof fr.content === 'string' &&
            (parts[i] === undefined || parts[i].length < fr.content.length)
          ) {
            parts[i] = fr.content;
          }
        }
      }
      return;
    }
    // 片段创建/追加：**声明片段的存在与类型**（内容随后才来）。
    //
    // 【这里必须记类型，不能直接 return】`currentIndex()` 是靠 types 找"当前片段"的，
    // 而裸增量帧（`{"v":"你"}`，没有 p 字段）只能靠它定位 —— types 空时它返回 -1，
    // 紧接着的 `if (idx < 0) return` 会把整段正文**静默丢掉**：主人看到空回复，
    // 而日志里一个错都没有（这正是 `empty-reply.js` 那类问题的成因之一）。
    // 旧的 `return` 就是这个 bug 的来源。
    if (f.p === 'response/fragments' && f.o === 'APPEND' && Array.isArray(f.v)) {
      var base = nextFreeIndex(types);
      for (var a = 0; a < f.v.length; a++) {
        var frag = f.v[a] || {};
        var at = base + a;
        types[at] = frag.type || types[at] || 'RESPONSE';
        // 有的 APPEND 帧会把内容一起给（空串只算声明，不算内容）
        if (typeof frag.content === 'string' && frag.content) {
          parts[at] = (parts[at] || '') + frag.content;
        }
      }
      return;
    }
    if (typeof f.v !== 'string') return;
    if (
      typeof f.p === 'string' &&
      (f.p.indexOf('thinking_content') >= 0 || f.p.indexOf('reasoning_content') >= 0)
    ) {
      return; // 明写 thinking 的路径：直接丢
    }
    var idx = null;
    if (typeof f.p === 'string') {
      var m = f.p.match(/^response\/fragments\/(-?\d+)\/content$/);
      if (m) {
        var n = parseInt(m[1], 10);
        idx = n < 0 ? currentIndex(types) : n;
      } else if (f.p === 'response/content') {
        idx = currentIndex(types);
      } else {
        return;
      }
    } else {
      idx = currentIndex(types);
    }
    // 【idx < 0 时兜底到片段 0，不能直接丢】types 为空只可能是"声明帧"没被认出来
    // （这一段只给了裸增量、没给快照）；而裸增量帧没有 p 字段，没有别的办法定位。
    // 丢掉的代价是**整段回复消失**，那比"偶尔写进一个不存在的片段 0"严重得多。
    if (idx === null || idx < 0) idx = 0;
    // 【别自作聪明】曾经在这里写过"当前片段是 THINK 就声明一个新的 RESPONSE 接住正文" ——
    // 那是个方向性错误：实测有些轮次**整轮只有 THINK 片段**（模型只在思考里说话，
    // 而页面照样显示），硬造一个 RESPONSE 会把思考当正文、还会把真正的回答搅乱。
    // 现在 `-1` 就老老实实指向"当前片段"，是不是正文交给 parseSseText 按
    // "帧里有没有 RESPONSE 片段"统一裁决。
    parts[idx] = (parts[idx] || '') + f.v;
  }

  /** -1 指向"当前正在输出的那个"：有类型清单时就是最后一个已知索引 */
  function currentIndex(types) {
    var keys = Object.keys(types);
    if (!keys.length) return -1;
    var max = -1;
    for (var i = 0; i < keys.length; i++) {
      var n = Number(keys[i]);
      if (n > max) max = n;
    }
    return max;
  }

  /** 下一个没被占用的片段索引（用于"思考之后接正文"） */
  function nextFreeIndex(types) {
    return currentIndex(types) + 1;
  }

    /**
   * 从原始 SSE 里抠出这条消息的 id（**整数**，不是 uuid —— 实测帧形状）：
   *   {"request_message_id":1,"response_message_id":2,"model_type":"default"}
   *   {"v":{"response":{"message_id":2,"parent_id":1,...}}}
   * 拿 response_message_id 当下一次的 parent_message_id，会话就往下接了。
   */
  function parseSseMeta(raw) {
    var meta = { requestMessageId: 0, responseMessageId: 0, model: '' };
    var lines = String(raw == null ? '' : raw).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') !== 0) continue;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      var parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      var frames = parsed && parsed.o === 'BATCH' && Array.isArray(parsed.v) ? parsed.v : [parsed];
      for (var k = 0; k < frames.length; k++) {
        var f = frames[k];
        if (!f || typeof f !== 'object') continue;
        if (!meta.requestMessageId && f.request_message_id) {
          meta.requestMessageId = Number(f.request_message_id) || 0;
        }
        if (!meta.responseMessageId && f.response_message_id) {
          meta.responseMessageId = Number(f.response_message_id) || 0;
        }
        if (typeof f.model_type === 'string' && f.model_type) meta.model = f.model_type;
        // 完整快照那条也带着同样的 id（帧顺序不保证，两边都认）
        var snap = f.v && typeof f.v === 'object' && !Array.isArray(f.v) ? f.v.response : null;
        if (snap && typeof snap === 'object') {
          if (!meta.responseMessageId && snap.message_id) {
            meta.responseMessageId = Number(snap.message_id) || 0;
          }
          if (!meta.requestMessageId && snap.parent_id) {
            meta.requestMessageId = Number(snap.parent_id) || 0;
          }
        }
      }
    }
    return meta;
  }

  // ── 发一条请求拿答复（流式读，边读边解析） ────────────────────────
  async function completion(opts) {
    var sessionId = opts.sessionId;
    var prompt = opts.prompt;
    var target = ROUTES.completion;
    var pow = await powHeader(target);
    // content-type 必须显式给：少了它服务端直接 415
    // （Expected request with `Content-Type: application/json`）
    var headers = Object.assign({ 'content-type': 'application/json' }, clientHeaders(), pow);

    var body = {
      chat_session_id: sessionId,
      // 给了就接着那条往下写；没给才是"从根新开一条"（会变成兄弟版本，看着像被改写）
      parent_message_id:
        opts.parentMessageId === undefined || opts.parentMessageId === null || opts.parentMessageId === ''
          ? null
          : opts.parentMessageId,
      prompt: prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
    };

    var started = Date.now();
    var res = await fetch(target, {
      method: 'POST',
      credentials: 'include',
      headers: headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var errText = '';
      try {
        errText = (await res.text()).slice(0, 300);
      } catch (e) {
        /* ignore */
      }
      throw new Error('completion HTTP ' + res.status + ' ' + errText);
    }

    var raw = '';
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        raw += decoder.decode(step.value, { stream: true });
      }
    } else {
      raw = await res.text();
    }
    DS.lastLatencyMs = Date.now() - started;
    var text = parseSseText(raw);
    var meta = parseSseMeta(raw);
    DS.lastReply = text;
    DS.lastRaw = raw;
    DS.lastMeta = meta;
    // 每次自请求都记长度：这是排查"她没回答"时最有用的一行 ——
    // raw 有内容但 text 为空 = 我们没解析出来；raw 也空 = 上游这轮真的没回内容。
    log(
      'DS reply(' + DS.lastLatencyMs + 'ms) raw=' + raw.length + ' 字 text=' + text.length + ' 字 id=' +
        (meta.responseMessageId || '?'),
    );
    // 把最近一次原始 SSE 挂到 window 上 —— 帧格式一变，这是唯一能看清真相的东西
    // （别的都是我们的解析器的推测）。定期覆盖，不留历史、不占内存。
    root.__DSC_LAST_RAW__ = raw;
    if (!text) {
      // 解析出空文本时把原始响应打出来 —— 上游改了帧格式的话一眼可见
      log('DS raw(len=' + raw.length + ')=' + JSON.stringify(raw.slice(0, 700)));
    }
    if (!meta.responseMessageId) {
      // 帧里没 id 会悄悄退化成"又开一条兄弟分支" —— 记一笔，调用方会回读兜底
      log('DS 没从 SSE 读到消息 id（帧格式可能变了）：' + JSON.stringify(raw.slice(0, 240)));
    }
    return {
      text: text,
      raw: raw,
      latencyMs: DS.lastLatencyMs,
      requestMessageId: meta.requestMessageId,
      responseMessageId: meta.responseMessageId,
    };
  }

  // ── 往下接：发一条请求，并维护该用途自己的会话链 ──────────────────
  /**
   * 为什么要有这一层：直接 completion 每次都是 parent_message_id=null，
   * 落到同一个会话的**同一个根位置**上，UI 里就成了"一条消息被改来改去"。
   * 这里负责：① 按用途分会话；② 拿上一条的 id 接着往下写；③ 攒够次数换新会话。
   *
   * @param kind   memory（记忆整理）/ judge（情绪感知·自我修订·主动搭话）/ ping（自检）
   * @param prompt 提示词
   * @param opts   {chainTurns?: number, fresh?: boolean}
   * @returns {text, latencyMs, sessionId, messageId, parentMessageId, turns, rotated, adopted}
   */
  /**
   * 取"可替换的那一份"实现。
   *
   * 验收脚本会把 `__DSC_DS_UTIL__` 整个换成假货（假回复、假会话 —— 不花网页额度、
   * 也不往侧边栏里建会话）。会碰网络的三件事（建会话 / 回读分支 / 发请求）都从这里取，
   * 而不是直接调本文件的同名函数：直接调的话替换 util 就拦不住，离线回归会真发请求
   * （踩过一次：ask 里直接调 completion，脚本换掉 util.completion 完全无效）。
   */
  function seam(name, fallback) {
    var u = root.__DSC_DS_UTIL__;
    return u && typeof u[name] === 'function' ? u[name] : fallback;
  }

  /** `ask` 两次都失败时的上报（第一次换会话重试也挂了 = 隐藏链整条不可用）。
   *
   * 【为什么必须留证】记忆整理 / 情绪感知 / 自我修订 / 主动开口全走这条链。
   * 它整条挂掉时，主人看到的只是"她最近怎么不自己开口了"——那是猜不出来的；
   * 而 catch 里原来只 log，设置页的体检块（health.lastError）永远是空的。
   */
  function reportAskFailure(kind, first, second) {
    try {
      var msg = String((second && second.message) || second);
      var firstMsg = String((first && first.message) || first);
      var doc = root.document || {};
      var online = root.navigator ? root.navigator.onLine : '?';
      var h = root.__DSC_HEALTH__;
      log('ASK[' + kind + '] 两次都失败：' + msg);
      if (!h) return;
      h.lastError =
        'ASK[' + kind + '] 两次都失败：' + msg +
        '（首次：' + firstMsg + ' hidden=' + !!doc.hidden + ' online=' + online + '）';
      if (typeof root.__DSC_PUBLISH_HEALTH__ === 'function') {
        root.__DSC_PUBLISH_HEALTH__('ask-failed');
      }
    } catch (e) {
      /* 上报本身绝不能影响主流程 */
    }
  }

  async function ask(kind, prompt, opts) {
    var o = opts || {};
    var k = kindOf(kind);
    var limit = chainLimit(o.chainTurns);
    var createSessionFn = function (force) {
      return seam('ensureSession', ensureSession)(force, k);
    };
    var tailFn = function (id) {
      return seam('historyTail', historyTail)(id);
    };
    var st = readChain(k) || {};
    var sid = st.sessionId || (await createSessionFn(false));
    var turns = Number(st.turns) || 0;
    var rotated = false;

    if (o.fresh) {
      sid = await createSessionFn(true);
      st = {};
      turns = 0;
      rotated = true;
    } else if (limit > 0 && turns >= limit) {
      // 到点了换个新会话：接着往下写会让每次请求都背上这段历史，这是成本闸
      sid = await createSessionFn(true);
      st = {};
      turns = 0;
      rotated = true;
    }

    var parent = Number(st.lastMessageId) || 0;
    var adopted = false;
    if (!parent) {
      // 没有链状态（老会话 / 刚轮换）：认下活跃分支的尾巴，接着它往下写，
      // 而不是再开一条兄弟分支 —— 那正是"一条消息被反复改写"的成因
      try {
        var tail = await tailFn(sid);
        if (tail.lastId) {
          parent = tail.lastId;
          adopted = tail.count > 0;
        }
      } catch (e) {
        log('ASK 认分支尾巴失败（不影响发请求）：' + (e && e.message ? e.message : e));
      }
    }

    var r;
    try {
      r = await seam('completion', completion)({
        sessionId: sid,
        parentMessageId: parent || null,
        prompt: prompt,
      });
    } catch (e) {
      // 会话可能已经被删/换号：换一个新的重试一次，不无限重试
      log('ASK[' + k + '] 第一次失败，换会话重试：' + (e && e.message ? e.message : e));
      sid = await createSessionFn(true);
      parent = 0;
      turns = 0;
      rotated = true;
      try {
        r = await seam('completion', completion)({
          sessionId: sid,
          parentMessageId: null,
          prompt: prompt,
        });
      } catch (e2) {
        reportAskFailure(k, e, e2);
        throw e2;
      }
    }

    var newId = Number(r.responseMessageId) || 0;
    if (!newId) {
      // 帧里没带 id 就回读一次活跃分支（只读、零额度）
      try {
        var t2 = await tailFn(sid);
        newId = t2.lastId;
      } catch (e2) {
        /* ignore */
      }
    }
    writeChain(k, {
      sessionId: sid,
      lastMessageId: newId || 0,
      turns: turns + 1,
      at: Date.now(),
    });
    log(
      'ASK[' + k + '] session=' + sid + ' 第 ' + (turns + 1) + ' 次（上限 ' + (limit || '∞') + '）' +
        ' parent=' + (parent || 'root') + ' → 新 id=' + (newId || '?') +
        (rotated ? ' · 换了新会话' : '') + (adopted ? ' · 接上旧分支尾巴' : '')
    );
    return {
      text: r.text,
      raw: r.raw,
      latencyMs: r.latencyMs,
      sessionId: sid,
      messageId: newId,
      parentMessageId: parent || 0,
      turns: turns + 1,
      rotated: rotated,
      adopted: adopted,
    };
  }

  // ── 连通性自检（验收用；会真的发一条请求） ────────────────────────
  //
  // 走 ping 这条**自己的**会话：以前它和记忆整理挤在一起，自检留下的
  // "请只回复两个字符：OK" 就混进了整理记录里（主人看到的那条会话就是它）。
  root.__DSC_PING__ = async function (opts) {
    var o = opts || {};
    DS.lastError = null;
    DS.lastReply = null;
    try {
      if (!readToken()) throw new Error('没有登录 token —— 先在这个窗口里登录 chat.deepseek.com');
      var r = await ask('ping', o.prompt || '请只回复两个字符：OK', { fresh: !!o.freshSession });
      log('DS reply(' + r.latencyMs + 'ms)=' + JSON.stringify(String(r.text).slice(0, 200)));
      return {
        ok: true,
        sessionId: r.sessionId,
        text: r.text,
        latencyMs: r.latencyMs,
        messageId: r.messageId,
        parentMessageId: r.parentMessageId,
        turns: r.turns,
        rotated: r.rotated,
        adopted: r.adopted,
      };
    } catch (e) {
      DS.lastError = String(e && e.message ? e.message : e);
      log('DS FAILED: ' + DS.lastError);
      return { ok: false, error: DS.lastError };
    }
  };

  /**
   * 在**当前会话**里往下写一条（工具结果回灌用）。
   *
   * 和 ask() 的区别：ask 走"隐藏会话 + 会话链"，是给记忆整理/感知那些后台链路用的；
   * 这个是**在主对话里接着往下说** —— 工具结果必须在同一条对话里，模型才看得到
   * 自己刚才那次调用与结果。所以 parent 用刚才那条回复的 message_id。
   *
   * 不重试、不轮换会话：主对话的场景下换会话等于把上下文丢掉，宁可失败让调用方
   * 记一笔日志（工具调用失败不该静默重试，那会重复产生副作用——虽然 v1 全是只读，
   * 但 v2 会有写入，契约先立好）。
   */
  async function continueChat(opts) {
    var o = opts || {};
    if (!o.sessionId) throw new Error('continueChat 需要 sessionId');
    // 告诉注入脚本"下一轮的主人原话仍然是这句" —— 我们这条请求带 bypass 头，
    // peekRequest 认不出它（它只排除【人设】/【回忆】开头的），所以不显式更新的话
    // 下一轮会把"原始输入+工具结果"整段当成主人说的话（留档里会重复一遍）。
    try {
      if (typeof root.__DSC_SET_LAST_PROMPT__ === 'function') {
        root.__DSC_SET_LAST_PROMPT__(o.userPrompt || '');
      }
    } catch (e) {
      /* 纯属锦上添花，失败不影响回灌 */
    }
    var r = await completion({
      sessionId: o.sessionId,
      parentMessageId: o.parentMessageId || null,
      prompt: o.prompt,
    });
    return r;
  }

  // extract.js / sense.js 都从这里拿：ask 是带会话链的正路，completion 是裸通道
  root.__DSC_DS_UTIL__ = {
    parseSseText: parseSseText,
    parseSseMeta: parseSseMeta,
    ROUTES: ROUTES,
    BYPASS_HEADER: BYPASS_HEADER,
    KINDS: KINDS,
    readToken: readToken,
    clientHeaders: clientHeaders,
    ensureSession: ensureSession,
    historyTail: historyTail,
    historyMessages: historyMessages,
    contentText: contentText,
    readChain: readChain,
    completion: completion,
    ask: ask,
    continueChat: continueChat,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__DSC_DS_UTIL__;
  }
})(typeof window !== 'undefined' ? window : globalThis);
