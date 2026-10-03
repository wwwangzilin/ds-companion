# PoC 壳（可复现用）

一个**最小 Tauri 2 Android 工程**，只做三件事：加载 `chat.deepseek.com`、把上一级的 `poc-probe.js` 当初始化脚本注入、把结果打到 logcat。目的是复现 [上一节](../README.md#6-实测记录) 那份实测记录。

它不依赖 ds-companion 的任何代码，可以单独复制出去构建。

## 目录结构

```
shell/
├── Cargo.toml              # tauri 2.11.3（与 ds-companion 同 minor，wry 0.55.x）
├── build.rs
├── tauri.conf.json         # identifier: com.dsc.androidpoc
├── capabilities/default.json
├── gradle-init.gradle      # 关键：强制所有 Gradle 仓库走阿里云镜像
└── src/
    ├── lib.rs              # mobile_entry_point + WebviewUrl::External + initialization_script
    └── main.rs
```

`poc-probe.js` 在上一级目录（由 `lib.rs` 的 `include_str!("../../poc-probe.js")` 引用）。除此之外还需要两样 ds-companion 里现成的东西：`icons/`（从 `src-tauri/icons` 复制）和 `dist/index.html`（占位，Tauri 要求 `frontendDist` 存在，实际显示的是远程站点）。

## 环境要求

- Rust + 4 个 Android target：
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- JDK 17
- Android SDK：`platform-tools`、`platforms;android-36`（`build-tools` 让 Gradle 自己装）
- NDK ≥ 26
- `cargo install tauri-cli --version "^2"` 和 `cargo install cargo-ndk`

## 构建（Windows 实测流程）

```powershell
# 1. 环境变量（按自己的路径改）
$env:JAVA_HOME        = 'D:\android-tools\jdk-17'
$env:ANDROID_HOME     = 'D:\android-tools\sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NDK_HOME         = 'D:\android-tools\sdk\ndk\27.2.12479018'

# 2. 生成 Android 工程
cargo tauri android init

# 3. 改 gen/android/app/build.gradle.kts：把 compileSdk 从模板的 37 改成 36
#    （37 在 SDK 里叫 platforms;android-37.0，从 Google 下载会挂；
#      而 tauri-android 这个 AAR 自己要求 compileSdk >= 36）

# 4. Rust 交叉编译，产出 .so
cargo tauri android build --target aarch64
#    ↑ 这步会在最后"把 .so 软链进 jniLibs"时失败（本机没开 Windows 开发者模式），
#      但 .so 已经编好了，手动复制过去即可：
Copy-Item target\aarch64-linux-android\release\libdsc_android_poc_lib.so `
          gen\android\app\src\main\jniLibs\arm64-v8a\

# 5. 直接走 Gradle 打包（不经 tauri CLI）
cd gen\android
.\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug `
    --init-script ..\..\gradle-init.gradle
```

产物：`gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk`

## 装到手机并读结果

```powershell
adb install -r gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk
adb logcat -c
adb shell am start -n com.dsc.androidpoc/.MainActivity
Start-Sleep -Seconds 15
adb logcat -d | Select-String -Pattern 'dsc-poc'
```

## 五个已踩过的坑

1. **`.so` 软链被拒**：Tauri CLI 最后要把 `.so` 软链进 `jniLibs/`，Windows 没开开发者模式会报 `Creation symbolic link is not allowed for this system`。→ 手动复制，然后直接跑 `gradlew`（Rust 编译其实已经成功了）。
2. **`compileSdk = 37` 根本不存在**：模板默认 37，但 SDK 里最高是 36。→ 改 36。
3. **别写 `buildToolsVersion`**：AGP 9.3.1 要求 build-tools ≥36，写低了会被忽略并报警告；不写它自己会装 36.0.0。
4. **国外仓库会静默挂死**：`google()` / `plugins.gradle.org` 直连可能让 Gradle daemon 卡 25 分钟——CPU 不涨、日志停在 `Calculating task graph`，看着像死机。→ 用 `gradle-init.gradle` 把所有仓库换成阿里云镜像，命令带 `--init-script`。**只改项目文件不够**：`tauri.settings.gradle` 会把 tauri 源码里的 `mobile/android` 子项目 include 进来，那个子项目自带 `google()` 声明。
5. **`rustBuild*` 任务必然失败**：它们要求 `cargo tauri android build` 在后台运行（要读 `gen/android/.tauri/cli-options-server.json`）。直接跑 gradlew 时用 `-x rustBuildArm64Debug` 排除即可。

另外 Gradle wrapper 的 `distributionUrl` 建议换成 `https://mirrors.cloud.tencent.com/gradle/gradle-9.6.1-bin.zip`——官方源是 307 重定向，很慢。
