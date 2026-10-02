/* 记忆整理（B 链路）—— 借页面自己的登录态，把最近对话抽成记忆条目
 *
 * 为什么走这条路：网页版没有 API key，但页面自己是登录态。以"页面身份"发一条
 * 隐藏请求让模型帮我们整理，质量比纯规则好得多；代价是多花一次网页额度。
 *
 * 链路：
 *   ① 挑会话     当前 URL 里的 > 留痕最多的（transcript 在 inject.js 里录）
 *   ② 拼 prompt  已有记忆一并给它（去重）、规则写死、只要 JSON
 *   ③ 发请求     deepseek-client 的 completion()，带 bypass 头（不会被自家钩子再注入一层）
 *   ④ 交给 Rust  memory_ingest 落盘（页面自己不写文件）；失败也回报一次，设置窗口好提示
 *
 * 【成本闸，别退化】
 *   - 输入封顶 EXTRACT_INPUT_BUDGET（只取最近几轮）
 *   - 复用同一个隐藏会话（id 缓存在 localStorage），不刷屏侧边栏
 *   - 会话**接着往下写**（parent = 上一条的 response_message_id）。以前每次都从根发，
 *     DeepSeek 把同根消息当成同一条消息的**版本**，侧边栏里就成了"一条消息被反复改写"
 *     （主人报的现象，已实测确认）。往下接的代价是每次请求都带上这段历史，所以有
 *     hiddenChainTurns 上限、攒够就换个新会话 —— 这套逻辑在 deepseek-client 的
 *     ask() 里，别绕开它直接 completion（绕开就等于回到"每次从根发"）。
 *   - 模型只许 add / update，不许 delete —— 删除留在设置界面由主人手点
 */
(function (root) {
  'use strict';

  var HEAD = '【DS Companion 记忆整理】';
  var MAX_ITEMS = 5;
  var EXTRACT_INPUT_BUDGET = 6000;
  var USER_CLIP = 800;
  var ASSIST_CLIP = 1200;
  var SESSION_KEY = 'dsc-memory-session';

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

  function transcript(sessionId) {
    try {
      if (typeof root.__DSC_TRANSCRIPT__ === 'function') return root.__DSC_TRANSCRIPT__(sessionId) || [];
    } catch (e) {
      /* ignore */
    }
    return [];
  }

  /** 从磁盘留档里取最近若干轮（页面刷新后仍能整理） */
  async function recentFromArchive(limit) {
    try {
      var rows = await invoke('chat_recent', { limit: limit });
      if (!Array.isArray(rows)) return [];
      return rows.map(function (r) {
        return {
          user: r.user || '',
          assistant: r.assistant || '',
          ref: (r.day || '') + ' ' + (r.clock || '') + ' · ' + (r.character || '角色'),
        };
      });
    } catch (e) {
      log('EXTRACT 读留档失败：' + e);
      return [];
    }
  }

  function clip(text, max) {
    var s = String(text == null ? '' : text).trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  // ── 挑要整理的会话 ────────────────────────────────────────────────
  function sessionFromUrl() {
    try {
      var path = String(location.pathname || '') + String(location.hash || '');
      var m = /\/a\/chat\/s\/([0-9a-zA-Z-]{8,})/.exec(path);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /** 当前打开的那个优先，其次留痕最多的；preferred = 调用方指定的那个（自动整理给的就是刚聊完的会话） */
  function pickSession(preferred) {
    var want = String(preferred || '');
    if (want && transcript(want).length) {
      return { id: want, turns: transcript(want), fromUrl: false };
    }
    var url = sessionFromUrl();
    var urlTurns = url ? transcript(url).length : 0;
    var keys = [];
    try {
      if (typeof root.__DSC_TRANSCRIPT_KEYS__ === 'function') keys = root.__DSC_TRANSCRIPT_KEYS__() || [];
    } catch (e) {
      /* ignore */
    }
    var best = '';
    var bestLen = urlTurns;
    if (url && urlTurns) best = url;
    for (var i = 0; i < keys.length; i++) {
      var n = transcript(keys[i]).length;
      if (n > bestLen) {
        bestLen = n;
        best = keys[i];
      }
    }
    if (!best) return null;
    return { id: best, turns: transcript(best), fromUrl: best === url && !!url };
  }

  // ── prompt 组装 ──────────────────────────────────────────────────
  /** 最近几轮拼成一段，总字数封顶（从最新往回取） */
  function buildDump(turns) {
    var parts = [];
    var used = 0;
    for (var i = turns.length - 1; i >= 0; i--) {
      var t = turns[i] || {};
      var chunk =
        '用户：' + clip(t.user, USER_CLIP) + '\n助手：' + clip(t.assistant, ASSIST_CLIP);
      if (used + chunk.length > EXTRACT_INPUT_BUDGET) break;
      parts.unshift(chunk);
      used += chunk.length;
    }
    return parts.join('\n\n');
  }

  function existingText(memories, limit) {
    var ms = memories || [];
    var max = limit || 30;
    var lines = [];
    for (var i = 0; i < ms.length && i < max; i++) {
      var m = ms[i] || {};
      lines.push('- id=' + m.id + ' | ' + clip(m.name, 40) + '：' + clip(m.content, 120));
    }
    return lines.join('\n');
  }

  var RULES = [
    '要求：',
    '1. 只记**稳定**的事：称呼、习惯、偏好、约定、正在做的项目、明确表过的立场。',
    '2. 不记一次性的琐事、寒暄、临时情绪，也不记助手自己的措辞和客套。',
    '3. 一条只讲一件事，写成陈述句，别写摘要、别分点、别加引号。',
    '4. importance 1-5：5=身份/长期约定，4=明确偏好，3=一般事实，1=可有可无。',
    '5. keys 给 1-4 个触发词（以后对话里出现这些词才可能用到这条记忆）。',
    '6. 最多 ' + MAX_ITEMS + ' 条；没有值得记的就给空数组。',
    '7. 与【已有记忆】重复的：信息有更新/更完整就写 op="update" 并带上它的 id；',
    '   完全相同就写 op="noop"，不要造重复条目。',
    '',
    '只输出 JSON，不要解释、不要 markdown 代码块。格式：',
    '{"items":[{"op":"add","name":"短标题","content":"一句话事实","keys":["词1","词2"],"importance":4}]}',
  ].join('\n');

  function buildPrompt(dump, existing, charName) {
    return [
      HEAD + '请阅读下面对话，抽出值得长期记住的事。',
      '',
      // 会话是往下接着长的，上面躺着以前几次整理的内容 —— 必须明说忽略。
      // 不说的话模型会把老对话反复重抽一遍（重复条目 + 白花额度）。
      '【重要】本会话里若还有更早的内容，那是以前整理留下的记录，与本次无关：',
      '请**完全忽略**它，只根据下面【本次要整理的对话】这一段来总结。',
      '',
      '【已有记忆】',
      existing || '（暂无）',
      '',
      '【对话双方】用户' + (charName ? ' 与角色「' + charName + '」' : ' 与助手'),
      '【本次要整理的对话】',
      dump,
      '',
      RULES,
    ].join('\n');
  }

  // ── 解析模型回复 ─────────────────────────────────────────────────
  /**
   * 重要度：模型说了才给。
   * 返回 undefined 表示"这次没提" —— JSON.stringify 会把这个键整个省掉，
   * Rust 侧据此保留旧值（给了 3 会把已有的 4 悄悄降级，这是踩过的坑）。
   */
  function clampImportance(v) {
    if (v === undefined || v === null || v === '') return undefined;
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return undefined;
    n = Math.round(n);
    return n < 1 ? 1 : n > 5 ? 5 : n;
  }

  function normalizeKeys(raw) {
    if (!Array.isArray(raw)) {
      if (typeof raw === 'string' && raw.trim()) raw = raw.split(/[,，、\s]+/);
      else return [];
    }
    var out = [];
    for (var i = 0; i < raw.length && out.length < 6; i++) {
      var k = String(raw[i] == null ? '' : raw[i]).trim();
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }

  /**
   * 从模型回复里抠出条目。宽容：容忍 markdown 围栏与前后废话（取第一个 { 到最后一个 }）。
   * 拒绝：不是 JSON / 条目缺名称或内容。
   */
  function parseItems(text, characterId) {
    var s = String(text == null ? '' : text);
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('模型没按 JSON 回：' + clip(s, 180));
    var obj;
    try {
      obj = JSON.parse(s.slice(a, b + 1));
    } catch (e) {
      throw new Error('JSON 解析失败：' + clip(s.slice(a, b + 1), 180));
    }
    var raw = obj && (obj.items || obj.memories || obj.data);
    if (!Array.isArray(raw)) throw new Error('没有 items 数组：' + clip(s.slice(a, b + 1), 180));

    var items = [];
    for (var i = 0; i < raw.length && items.length < MAX_ITEMS; i++) {
      var it = raw[i] || {};
      var op = String(it.op == null ? 'add' : it.op).trim().toLowerCase();
      if (op !== 'update' && op !== 'noop') op = 'add';
      var name = String(it.name == null ? '' : it.name).trim();
      var content = String(it.content == null ? '' : it.content).trim();
      var id = String(it.id == null ? '' : it.id).trim();
      if (op === 'noop') {
        // noop 没有正文，但带上 id/标题才有信息量（Rust 侧据此算"考虑过多少条"）
        if (!id && !name) continue;
      } else if (op === 'update') {
        // 更新只要"找得到旧条目"+"有新内容"即可：模型常常只回 id + content，
        // 标题留空是正常的（Rust 侧 pick() 会保留旧标题）
        if ((!id && !name) || !content) continue;
      } else if (!name || !content) {
        // add 缺名称或缺内容一律丢（模型偶尔会吐空壳）
        continue;
      }
      items.push({
        op: op,
        id: id,
        name: name,
        content: content,
        keys: normalizeKeys(it.keys),
        importance: clampImportance(it.importance),
        // 归属由我们定，不听模型的（它不知道角色 id）
        characterId: characterId || '',
        reason: clip(it.reason, 120),
      });
    }
    return items;
  }

  // ── 主入口（Rust 的 memory_extract 会 eval 它） ────────────────────
  var state = { last: null, running: false, runs: 0 };
  root.__DSC_EXTRACT_STATE__ = state;

  root.__DSC_EXTRACT__ = async function (opts) {
    var o = opts || {};
    if (state.running) {
      log('EXTRACT skip: 上一轮还在跑');
      return { ok: false, error: '上一轮整理还没结束' };
    }
    state.running = true;
    var util = root.__DSC_DS_UTIL__;
    try {
      if (!util || typeof util.completion !== 'function') {
        throw new Error('deepseek-client 没加载');
      }
      var session = pickSession(o.sessionId);
      var fromArchive = false;
      if (!session || !session.turns.length) {
        // 页面刚刷新过、内存里没留痕：用磁盘上的留档兜底
        // （不留档的话"刷新一下就不能整理了"，这是实测踩过的）
        var archived = await recentFromArchive(12);
        if (!archived.length) {
          throw new Error('没有可整理的对话 —— 先在 DeepSeek 窗口里正常聊几句再点');
        }
        session = { id: '(来自留档)', turns: archived, fromUrl: false };
        fromArchive = true;
        log('EXTRACT 内存里没有留痕，改用磁盘留档 ' + archived.length + ' 轮');
      }
      // 归属必须问 Rust：页面里的 CFG 只是推过来的副本，推送丢失/页面正在导航时
      // 会过期，过期就会把记忆挂到已经换掉的那个角色名下（实测踩过一次，
      // 界面显示「三千代」而抽出来的记忆带的是「露娜」）。
      var c = cfg();
      try {
        var fresh = await invoke('dsc_get_config');
        if (fresh && typeof fresh === 'object') c = Object.assign({}, c, fresh);
      } catch (e) {
        /* 拿不到就退回页面副本，别因为这一下整个整理失败 */
      }
      var dump = buildDump(session.turns);
      if (!dump.trim()) throw new Error('对话太短，没什么可整理');
      var prompt = buildPrompt(dump, existingText(c.memories), c.personaName || '');
      log(
        'EXTRACT start session=' + session.id + ' turns=' + session.turns.length +
          ' prompt=' + prompt.length + ' 字'
      );

      // 走 ask：按用途分会话 + 接着上一条往下写 + 攒够次数换新会话（失败重试也在里面）
      var r = await util.ask('memory', prompt);

      var items = parseItems(r.text, c.personaId || '');
      // 溯源：每条记忆记下"从哪段对话抽出来的"，主人问起来翻得到原话
      var last = session.turns[session.turns.length - 1] || {};
      var ref = last.ref || '';
      if (!ref) {
        var d = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        ref = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
          pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' · ' + (c.personaName || '角色') +
          (fromArchive ? '（留档）' : '');
      }
      for (var ii = 0; ii < items.length; ii++) items[ii].sourceRef = ref;
      log('EXTRACT 模型给了 ' + items.length + ' 条（' + r.latencyMs + 'ms）：' + JSON.stringify(items).slice(0, 400));
      var report = await invoke('memory_ingest', { items: items, error: null });
      var out = {
        ok: true,
        sessionId: session.id,
        memorySessionId: r.sessionId,
        messageId: r.messageId,
        parsed: items.length,
        added: (report && report.added) || 0,
        updated: (report && report.updated) || 0,
        skipped: (report && report.skipped) || 0,
        latencyMs: r.latencyMs,
      };
      state.last = out;
      state.runs++;
      // 攒的轮数清零（失败不清 —— 自动整理失败时下次接着攒，别把没整理的对话弄丢）
      try {
        if (typeof root.__DSC_MARK_EXTRACTED__ === 'function') root.__DSC_MARK_EXTRACTED__();
      } catch (e2) {
        /* ignore */
      }
      return out;
    } catch (e) {
      var msg = String((e && e.message) || e);
      state.last = { ok: false, error: msg };
      log('EXTRACT FAILED: ' + msg);
      // 失败也回报一次，设置窗口才知道是"挂了"而不是"还在跑"
      try {
        await invoke('memory_ingest', { items: [], error: msg });
      } catch (e2) {
        /* ignore */
      }
      return { ok: false, error: msg };
    } finally {
      state.running = false;
    }
  };

  root.__DSC_EXTRACT_UTIL__ = {
    recentFromArchive: recentFromArchive,
    buildDump: buildDump,
    buildPrompt: buildPrompt,
    existingText: existingText,
    parseItems: parseItems,
    pickSession: pickSession,
    sessionFromUrl: sessionFromUrl,
    clip: clip,
    HEAD: HEAD,
    MAX_ITEMS: MAX_ITEMS,
    SESSION_KEY: SESSION_KEY,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__DSC_EXTRACT_UTIL__;
  }
})(typeof window !== 'undefined' ? window : globalThis);
