# Android 端（路线 B）可行性 PoC

本目录只做一件事：**在写一周代码之前，先证明 Android 上能拿到和桌面端等价的注入时机。**

结论：**能，而且已经在真机上验证通过了**（2026-10-03，Galaxy S24 Ultra / Android 16 / WebView 142，实测数据在第 6 节）。下面是源码实证与实测记录，不是推测。

---

## 1. 为什么这个 PoC 决定生死

桌面端的全部能力建立在一个前提上：初始化脚本**抢在页面自己的脚本之前**跑，从而钩住 `XMLHttpRequest.prototype.open/send` 和 `fetch`，把 `body.prompt` 换成带人设/记忆的版本。

Android 的 WebView 没有桌面 WebView2 那种 `AddScriptToExecuteOnDocumentCreated`。所以第一反应是「手机上多半抢不到钩子位」——这个判断**是错的**，见下。

---

## 2. 源码实证（以 ds-companion 实际依赖为准）

本项目的锁文件是 `wry 0.55.1`（`src-tauri/Cargo.lock`），Tauri 走 `tauri-runtime-wry`。源码就在本地 cargo registry 里，可以直接读：

**证据 A —— Android 上确实用了 document-start 注入**（`wry-0.55.1/src/android/kotlin/RustWebView.kt:28-35`）：

```kotlin
if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    isDocumentStartScriptEnabled = true
    for (script in initScripts) {
        WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"));
    }
} else {
    isDocumentStartScriptEnabled = false
}
```

`WebViewCompat.addDocumentStartJavaScript` 是 AndroidX WebKit 提供的**真正的 document-start 注入**，脚本在页面任何脚本之前执行，且落在**主世界**（没有 isolated world 参数）。`setOf("*")` 表示对所有 origin 生效——**包含 chat.deepseek.com 这类远程 URL**。

**证据 B —— 只在 feature 不支持时才退化为 onPageStarted**（`RustWebViewClient.kt:62-71`）：

```kotlin
override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
    currentUrl = url
    if (interceptedState[url] == false) {          // 远程 URL 才走这里
        val webView = view as RustWebView
        for (script in webView.initScripts) {
            view.evaluateJavascript(script, null)
        }
    }
    ...
}
```

`interceptedState[url] == false` 意味着「这个请求没被 Rust 的 custom protocol handler 拦下」——即远程地址。所以 onPageStarted 是**降级路径**，不是主路径。

**证据 C —— 降级时的 HTML 注入只覆盖本地页面**（`wry-0.55.1/src/android/mod.rs:254-258`）：`inject_scripts_into_html` 挂在 custom protocol handler 的 responder 上，远程 URL 不经过它。

> ⚠️ **上游注释是过时的**：`wry/src/lib.rs:616`、`tauri-2.x/src/webview/mod.rs:908` 仍在 `initialization_script` 的文档里写 *"For remote URLs, we use onPageStarted which is not guaranteed to run before other scripts."* 这句与上面的实现不符——实现优先用 DOCUMENT_START_SCRIPT。**以源码为准，别被注释吓退。**

---

## 3. 判定方法

### 3.1 一行 Kotlin（最快，30 秒出结论）

Tauri 生成的 `MainActivity` 继承 `WryActivity`，后者留了一个开放回调，WebView 实例也是公开可读的：

```kotlin
// gen/android/app/src/main/java/<pkg>/MainActivity.kt
override fun onWebViewCreate(webView: android.webkit.WebView) {
    super.onWebViewCreate(webView)
    val rw = webView as RustWebView          // 同包，可访问
    android.util.Log.i("dsc-poc", "documentStart=" + rw.isDocumentStartScriptEnabled)
}
```

`Log.i` 里是 `true` → 走 document-start，与桌面端等价，**PoC 基本不用继续做了**。
是 `false` → 该设备 WebView 太老，走第 4 节的预案。

### 3.2 探针脚本（用来交叉验证 + 留证据）

`poc-probe.js` 作为初始化脚本注入（`WebviewWindowBuilder::initialization_script`，和桌面端同一处），它会：

1. 检查注入那一刻 `XMLHttpRequest.prototype.open/send`、`window.fetch` **是否还是原生实现**（`[native code]`）；
2. 挂钩子，记录**第一个** XHR/fetch 请求的 URL、body 长度、body 里有没有 `"prompt"`；
3. 在 `DOMContentLoaded` / `load` / `t+30s` 各打一次总账；
4. 结果同时写进 `window.__DSC_POC__`（Rust 侧 `evaluateJavascript` 可读回）。

```rust
// on_page_load 里读回结果
let _ = webview.eval("console.log(JSON.stringify(window.__DSC_POC__))");
```

### 3.3 通过标准

| 判据 | 期望 | 含义 |
|---|---|---|
| `inject` 行 `xhrNative` | `true` | 抢在了页面脚本之前（**决定性**） |
| `inject` 行 `readyState` | `loading` | 确实在文档早期 |
| `inject` 行 `hasBody` | `false` | 还没到 body，属正常 |
| `firstXhr.bodyHasPrompt` | `true` | 请求体可读、可改写（注入的最终目的） |

只要第一条成立，B 路线就成立。

---

## 4. 不通过怎么办（降级阶梯）

**第一级：换设备/更新 WebView。** `DOCUMENT_START_SCRIPT` 需要 WebView ≥ 105（2022-08 起）。国产 ROM 若把 WebView 换成旧版，让用户去商店更新「Android System WebView」或 Chrome 即可。目标是**声明最低支持版本**，不是覆盖全部老机器。

**第二级：接受 onPageStarted 晚注入。** 即使退化，对**对话类站点**通常仍然可用——钩子的本质是替换 `XMLHttpRequest.prototype` 上的方法，页面代码在 `new XMLHttpRequest().open(...)` 时走原型链**动态查找**，所以只要钩子早于「第一个真实请求」就行。而 chat.deepseek.com 的 completion 请求必须等用户发出消息，中间隔着资源加载 + 框架挂载 + 用户输入，通常有几百毫秒到数秒余量。探针的 `firstXhr.msAfterInject` 就是量这个余量的。

**第三级：在 MainActivity 里自己加 document-start 脚本。** `onWebViewCreate` 拿到实例后手动调用：

```kotlin
androidx.webkit.WebViewCompat.addDocumentStartJavaScript(
    webView, myScript, setOf("https://chat.deepseek.com")
)
```

前提是 `WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)`——若为 false，这条也走不通。

**第四级：放弃注入，改半自动。** 不做钩子，改为用户在手机上操作后把对话内容交给 App 处理。功能缩水，但零风险。

---

## 5. 如果 PoC 通过，迁移清单

| 桌面端 | Android 端 |
|---|---|
| 注入脚本 9 个文件 | 原样复用（都是纯 JS，无平台 API），但**必须先改成幂等**（见第 6 节的实测发现） |
| `run_command` 工具 | **去掉**（手机上无意义），保留 `list_dir`/`read_file`/`find`/`write_file`/`edit_file` |
| 托盘菜单 + 角标 | 通知栏常驻通知 + 快捷操作 |
| 进程常驻（窗口关掉还在） | **前台服务**（`FOREGROUND_SERVICE` + 通知），并引导用户关闭电池优化 |
| 数据目录 `%APPDATA%` | 走 `app_root()`，Android 下自动映射到应用私有目录 |
| PoW wasm | 原样复用（base64 内联，不依赖文件系统） |
| 单实例锁 / 看门狗 | 换成 Android 生命周期 |

工作量估计：**PoC 通过后约一周**（不含应用商店上架）。

---

## 6. 实测记录

### 2026-10-03 · Samsung SM-S9480（Galaxy S24 Ultra 国行）· Android 16 / API 36 · WebView 142.0.7444.171

**结论：通过，B 路线成立。**

| 判据 | 实测值 | 期望 | 结果 |
|---|---|---|---|
| `inject` 行 `xhrNative` | `true` | `true` | ✅ |
| `inject` 行 `fetchNative` | `true` | `true` | ✅ |
| `inject` 行 `readyState` | `loading` | `loading` | ✅ |
| `inject` 行 `htmlLen` | `0` | 越小越好 | ✅ 文档还是空的 |
| `inject` 行 `hasBody` | `false` | `false` | ✅ |
| `firstXhr.msAfterInject` | `1376` ms | 越大越安全 | ✅ 余量充足 |
| 首个请求 | `GET /api/v0/client/settings` | 应早于 completion | ✅ |

原始 logcat（`adb logcat | Select-String dsc-poc`）：

```
[dsc-poc] inject {"readyState":"loading","hasDoc":true,"hasBody":false,"htmlLen":0,"xhrNative":true,"fetchNative":true}
[dsc-poc] inject {"readyState":"loading","hasDoc":true,"hasBody":false,"htmlLen":8390,"xhrNative":false,"fetchNative":false}
[dsc-poc] first-xhr {"msAfterInject":1376,"method":"GET","url":"/api/v0/client/settings?...","bodyLen":0,"bodyHasPrompt":false}
```

### ⚠️ 实测发现：Android 上注入会跑**两次**

第一行 `htmlLen: 0` / `xhrNative: true` 是 document-start；第二行 `htmlLen: 8390` / `xhrNative: false` 是**几百毫秒后的第二次注入**——那个 `false` 是第一次注入自己挂的钩子造成的，不是页面脚本。

这与源码的读法不符：`RustWebView.kt:28-35`（`addDocumentStartJavaScript`）与 `RustWebViewClient.kt:62-71`（`onPageStarted` + `evaluateJavascript`）看起来是 if/else 二选一，**实际两个机制都会被触发**。

**迁移硬要求：注入脚本必须幂等。** 每次执行都要能安全重入——不能重复包装 `XMLHttpRequest.prototype`、不能重置已有状态。否则同一个 `body.prompt` 会被改写两次（第一次注入加人设、第二次再加一遍），这是真会出事的 bug。

### 未覆盖的部分

手机 WebView 没有 DeepSeek 登录态（页面跳到 `/sign_in`），所以本轮**没有观测到 completion 请求**，也没有验证「改写 `body.prompt` 后服务端真的收到」。时机判据已满足，这一步等有登录态时补。

---

## 7. 边界声明

- 本 PoC 会**注入并观察**请求，但**不修改**任何请求内容，也不接触账号凭据；探针只读取 URL / body 长度 / 是否含 `prompt` 键，不落盘正文。
- 与桌面端一致：本项目是非官方工具，注入第三方站点存在账号风险与 ToS 风险，自用为主，见仓库根 README 的「先读这段」。
