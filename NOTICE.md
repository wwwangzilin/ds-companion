本项目用到的第三方素材
======================

## dsh-pet —— 桌宠动作素材

- 来源：https://github.com/PC2005-cloud/dsh-pet
- 作者：PC2005-cloud
- 许可：**MIT License**（Copyright (c) 2026 PC2005-cloud）

### 用在哪

`ds-companion` 的桌宠窗口（`dist/pet.html` / `dist/pet.js`）除了画静态立绘，还能播
**透明 webm 动作素材**（待机呼吸、点击回应…）。这些素材来自 dsh-pet 的
`dsh-pet/assets/webm/`。壳那边对应的代码是 `src-tauri/src/pet.rs` 的「动作素材」一节，
取素材的命令是 `dsc_pet_clip`。

### 为什么素材不在这个仓库里

两个理由，都很实在：

1. 那 106 个 webm 一共 **51.8 MB**，全塞进来会把仓库撑成一座山；
2. 它们是**作者画的**。它该待在自己的仓库里，我们只在本地按池下载。

### 怎么装

```sh
node tools/fetch-pet-assets.mjs          # 第一批：待机 + 点击回应，6 段 ≈ 2.7 MB
node tools/fetch-pet-assets.mjs --all     # 全部 106 段 ≈ 52 MB
```

素材落到 `<数据目录>/pets/dsh-pet/`（缺省 `%APPDATA%\ds-companion`，可用 `--dir` 或
`DSC_DATA_DIR` 改）。**没下也能跑** —— 桌宠会自动回落到立绘那条路。

本机（GitHub 被 S302 劫持）要先挂本地代理：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:18086'
$env:NODE_USE_ENV_PROXY='1'
```

### MIT 的要求

MIT 允许使用、修改、再分发，**条件是把版权声明和许可全文带上**。所以：

- 这份 NOTICE 就是那个声明，别删；
- 如果你从 dsh-pet 那里拿了别的素材（贴图、字体、表情包），一并在上面补一行；
- dsh-pet 仓库里的 `LICENSE` 是许可全文，需要时去那儿取。

### 我们改了它什么

素材本身**一个字节都没改**（`fetch-pet-assets.mjs` 只做下载 + webm 魔数校验）。

改的是**用它的方式**：dsh-pet 那套是给 DeepSeek Harness 的 Web 界面写的插件（读 DSH 的
会话事件、自己一套设置面板）。我们只摘了「动作池 + 播放」这一层，接到 `ds-companion`
自己的状态源上（心情/好感/身体/活动/桌宠 ping），代码是照着自己的窗体重写的 ——
没有搬它的 TypeScript 源码，也没有引入它的构建链（桌宠页是零构建的原生 JS）。
