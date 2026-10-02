/* Android WebView 注入时机 PoC 探针
 *
 * 【它要回答的唯一问题】我们的初始化脚本，能不能**抢在页面自己的脚本之前**挂钩 XHR/fetch？
 *
 * 桌面端靠 `WebviewWindowBuilder::initialization_script` + document-start + 主世界，稳稳抢在前面；
 * Android WebView 的等价能力（`onPageStarted` / `evaluateJavascript`）时机偏晚 ——
 * 如果页面脚本已经先跑过，钩子就挂不上（或首个请求漏掉），那 B 路线整体不成立。
 *
 * 【怎么判定】注入那一刻 `XMLHttpRequest.prototype.open` 是不是**原生实现**：
 *   `xhrOpenWasNative: true`  → 抢到了，后面才可能改 body
 *   `xhrOpenWasNative: false` → 晚了（已经有别人的实现盖在上面）→ 换时机或放弃
 * 以及首个请求有没有被看到、body 里有没有 `"prompt"`。
 *
 * 【结果去哪儿看】
 *   ① `console.log('[dsc-poc] ...')` —— Android 里 WebChromeClient.onConsoleMessage / logcat 能收到；
 *   ② `window.__DSC_POC__` —— Rust 侧用 evaluateJavascript("JSON.stringify(window.__DSC_POC__)") 读回来；
 *   ③ 如果你的壳提供了 `window.__DSC_POC_LOG__(line)`，会顺带调一次（写你自己的日志文件）。
 */
(function () {
  'use strict';

  var t0 = Date.now();
  var POC = {
    injectedAt: new Date().toISOString(),
    url: location.href,
    readyState: document.readyState,
    hasDocumentElement: !!document.documentElement,
    bodyExists: !!document.body,
    // document-start 注入时 <html> 里几乎还是空的，htmlLen 会是个很小的数（甚至 0/-1）
    htmlLen: document.documentElement ? document.documentElement.innerHTML.length : -1,
    // 注入方式若是 WebViewCompat.addDocumentStartJavaScript，则不是 <script> 标签触发的
    hasCurrentScript: !!document.currentScript,
    xhrOpenWasNative: null,
    xhrSendWasNative: null,
    fetchWasNative: null,
    firstXhr: null,
    firstFetch: null,
    notes: [],
  };
  window.__DSC_POC__ = POC;

  function isNative(fn) {
    try {
      return /\[native code\]/.test(Function.prototype.toString.call(fn));
    } catch (e) {
      return false;
    }
  }

  function mark(tag, extra) {
    var line = '[dsc-poc] ' + tag + ' ' + JSON.stringify(extra || {});
    try {
      console.log(line);
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof window.__DSC_POC_LOG__ === 'function') window.__DSC_POC_LOG__(line);
    } catch (e) {
      /* ignore */
    }
  }

  // ① 关键判据：此刻页面上的 XHR/fetch 还是不是原生的
  try {
    POC.xhrOpenWasNative = isNative(XMLHttpRequest.prototype.open);
    POC.xhrSendWasNative = isNative(XMLHttpRequest.prototype.send);
  } catch (e) {
    POC.notes.push('xhr probe failed: ' + e);
  }
  try {
    POC.fetchWasNative = typeof window.fetch === 'function' && isNative(window.fetch);
  } catch (e) {
    POC.notes.push('fetch probe failed: ' + e);
  }
  mark('inject', {
    readyState: POC.readyState,
    hasDoc: POC.hasDocumentElement,
    hasBody: POC.bodyExists,
    htmlLen: POC.htmlLen,
    xhrNative: POC.xhrOpenWasNative,
    fetchNative: POC.fetchWasNative,
  });

  // ② 挂钩子：只记**第一个**请求（够判断时机了，也不干扰页面）
  try {
    var oOpen = XMLHttpRequest.prototype.open;
    var oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__dscPoc = { m: String(m), u: String(u) };
      return oOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (!POC.firstXhr && this.__dscPoc) {
        POC.firstXhr = {
          msAfterInject: Date.now() - t0,
          method: this.__dscPoc.m,
          url: this.__dscPoc.u,
          bodyLen: String(body || '').length,
          bodyHasPrompt: /"prompt"\s*:/.test(String(body || '')),
        };
        mark('first-xhr', POC.firstXhr);
      }
      return oSend.apply(this, arguments);
    };
  } catch (e) {
    POC.notes.push('xhr hook failed: ' + e);
  }

  try {
    if (typeof window.fetch === 'function') {
      var oFetch = window.fetch;
      window.fetch = function (input, init) {
        if (!POC.firstFetch) {
          var body = (init && init.body) || '';
          POC.firstFetch = {
            msAfterInject: Date.now() - t0,
            url: String((input && input.url) || input),
            bodyLen: String(body).length,
            bodyHasPrompt: /"prompt"\s*:/.test(String(body)),
          };
          mark('first-fetch', POC.firstFetch);
        }
        return oFetch.apply(this, arguments);
      };
    }
  } catch (e) {
    POC.notes.push('fetch hook failed: ' + e);
  }

  // ③ 几个时间点上打总账（DOMContentLoaded / load / t+30s）——
  //    只看 inject 那一刻不够：真正要证明的是"页面发首个请求时我们的钩子已经在了"
  function summary(tag) {
    mark(tag, { xhr: POC.firstXhr, fetch: POC.firstFetch, notes: POC.notes });
  }
  try {
    window.addEventListener('DOMContentLoaded', function () {
      summary('dom-ready');
    });
    window.addEventListener('load', function () {
      summary('load');
    });
  } catch (e) {
    /* ignore */
  }
  setTimeout(function () {
    summary('t+30s');
  }, 30000);
})();
