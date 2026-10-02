/* 记忆检索器（纯函数，页面侧同步跑）
 *
 * 为什么在页面而不在 Rust：注入钩子是在 XHR 的 send() 里**同步**改 body 的，
 * 检索要用"用户这次打的那句话"，同步上下文等不了 IPC 往返。
 * 所以 Rust 存、页面选 —— 这个文件就是唯一那份选择逻辑。
 *
 * 打分是三个来源的合并：
 *   1. gal 扩展的选择器（tag×20 / name×15 / content×5 + 衰减 + pin）
 *   2. Generative Agents 的 importance（1-5）—— 让"重要但不常提"的事也能浮上来
 *   3. 世界书式的条件注入 —— 触发词没命中的低重要度条目直接不参与
 *
 * 用 module.exports 收尾是为了能用 node 直接单测（tools/test-selector.cjs）。
 */
(function (root) {
  'use strict';

  var STOP_WORDS = new Set([
    '的', '了', '是', '在', '和', '就', '都', '而', '及', '与', '着', '或', '一个', '没有',
    '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '不是', 'the', 'a', 'an',
    'is', 'are', 'was', 'were', 'of', 'to', 'in', 'on', 'and', 'or', 'for', 'with', 'that',
  ]);

  var segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' });
    }
  } catch (e) {
    segmenter = null;
  }

  var SEGMENT_CACHE_LIMIT = 1000;
  var segmentCache = new Map();

  function segmentText(text) {
    var key = String(text || '');
    var cached = segmentCache.get(key);
    if (cached) return cached;

    var words;
    if (segmenter) {
      words = [];
      var it = segmenter.segment(key);
      for (var s of it) {
        if (!s.isWordLike) continue;
        var w = s.segment.toLowerCase();
        if (w.length > 1 && !STOP_WORDS.has(w)) words.push(w);
      }
    } else {
      words = key
        .toLowerCase()
        .split(/[\s,，。！？；：、\-_/]+/)
        .filter(function (w) {
          return w.length > 1 && !STOP_WORDS.has(w);
        });
    }

    if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
      var first = segmentCache.keys().next().value;
      if (first !== undefined) segmentCache.delete(first);
    }
    segmentCache.set(key, words);
    return words;
  }

  /** 粗估 token：中文一字约 0.6，其余 4 字符 1 个（量级感够用） */
  function estimateTokens(text) {
    var s = String(text || '');
    var cjk = (s.match(/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g) || []).length;
    return Math.round(cjk * 0.6 + (s.length - cjk) / 4);
  }

  function keywordScore(promptWords, m) {
    var promptSet = new Set(promptWords);
    var tagHits = 0;
    var keys = m.keys || [];
    for (var i = 0; i < keys.length; i++) {
      var tagLower = String(keys[i]).toLowerCase();
      if (tagLower.length > 1 && promptSet.has(tagLower)) tagHits++;
      for (var j = 0; j < promptWords.length; j++) {
        var pw = promptWords[j];
        if (pw.length > 2 && tagLower.indexOf(pw) >= 0 && tagLower !== pw) tagHits += 0.5;
      }
    }
    var nameHits = 0;
    var nameWords = segmentText(m.name);
    for (var a = 0; a < nameWords.length; a++) {
      if (promptSet.has(nameWords[a])) nameHits++;
    }
    var contentHits = 0;
    var contentWords = segmentText(m.content);
    for (var b = 0; b < contentWords.length; b++) {
      if (promptSet.has(contentWords[b])) contentHits++;
    }
    return tagHits * 20 + nameHits * 15 + contentHits * 5;
  }

  function decayScore(m, now) {
    var days = (now - (m.lastAccessedAt || 0)) / 86400000;
    var freshness = Math.max(0, 10 - days * 0.1);
    return Math.min(m.accessCount || 0, 20) + freshness;
  }

  /** 触发词是否在这次的输入里出现 */
  function keysHit(promptWords, m) {
    var promptSet = new Set(promptWords);
    for (var i = 0; i < (m.keys || []).length; i++) {
      var k = String(m.keys[i]).toLowerCase();
      if (k.length > 1 && promptSet.has(k)) return true;
    }
    return false;
  }

  function formatLine(m) {
    return '- [' + (m.characterId ? '角色' : '全局') + '] ' + m.name + ': ' + String(m.content).replace(/｜DSML｜/g, '|DSML|');
  }

  function formatBlock(list) {
    return list.map(formatLine).join('\n');
  }

  /**
   * @param {string} prompt        用户这次的输入
   * @param {Array}  memories      当前可见的记忆（调用方已按角色过滤）
   * @param {object} opts          { budget, alreadyInjected:Set|Array, now }
   * @returns {{picked:Array, usedIds:Array, block:string}}
   */
  function selectMemories(prompt, memories, opts) {
    var o = opts || {};
    var budget = o.budget || 500;
    var now = o.now || Date.now();
    var skip = new Set(o.alreadyInjected || []);
    if (!memories || !memories.length) return { picked: [], usedIds: [], block: '' };

    var promptWords = segmentText(prompt);

    var scored = [];
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      // 这一轮之前已经注入过的（还在上下文里）就别重复烧额度了
      if (skip.has(m.id)) continue;
      var hit = keysHit(promptWords, m);
      // 世界书式条件注入：触发词没命中、又不是"重要/钉住"的，直接不参与
      if (!hit && !m.pinned && (m.importance || 3) < 4) continue;
      var score =
        (m.pinned ? 1000 : 0) +
        (m.characterId ? 40 : 0) +
        (m.importance || 3) * 30 +
        keywordScore(promptWords, m) +
        decayScore(m, now) +
        (now - (m.lastAccessedAt || 0) < 3600000 ? 5 : 0);
      scored.push({ m: m, score: score });
    }

    scored.sort(function (a, b) {
      return b.score - a.score;
    });

    var picked = [];
    var remaining = budget;
    for (var k = 0; k < scored.length; k++) {
      var cost = estimateTokens(formatLine(scored[k].m));
      if (remaining - cost < 0 && picked.length > 0) break;
      picked.push(scored[k].m);
      remaining -= cost;
    }

    return {
      picked: picked,
      usedIds: picked.map(function (m) {
        return m.id;
      }),
      block: formatBlock(picked),
    };
  }

  root.__DSC_SELECT__ = selectMemories;
  root.__DSC_MEMORY_UTIL__ = {
    selectMemories: selectMemories,
    formatBlock: formatBlock,
    estimateTokens: estimateTokens,
    segmentText: segmentText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.__DSC_MEMORY_UTIL__;
  }
})(typeof window !== 'undefined' ? window : globalThis);
