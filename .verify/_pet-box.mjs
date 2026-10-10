/* 桌宠验收脚本共用的 CDP 小工具 + 「量她本人有多大」的那段探针。
 *
 * 【为什么单独一份】这段 alpha 扫描要同时被两个地方用：`probe-pet-box.mjs`（人工看一眼）
 * 和 `verify-pet-anim.mjs`（回归门禁）。复制两份的话，哪天改了扫描口径就会出现
 * "探针说对一个样、门禁说另一个样"——项目里"同一个交互只能有一份实现"这条规矩同样
 * 适用于验收工具。
 *
 * 【为什么必须扫 alpha，而不是读 DOM 的 rect】`#stage` 是 200×300 的盒子，而 640×360 的
 * 素材四面都是透明留白（实测她本人只占 214×269）。DOM 的 rect 只能告诉你"视频元素多大"，
 * 告诉不了"画面里哪儿是她"。气泡贴不贴得住，只有扫像素才知道。
 */
export const BASE = process.env.DSC_CDP_BASE || 'http://127.0.0.1:9223';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function send(target, method, params = {}, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时 ' + method));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== 1) return;
      clearTimeout(timer);
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
      }, 50);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP 连接失败'));
    };
  });
}

export async function evalIn(target, expression, timeoutMs = 90000) {
  const r = await send(
    target,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r && r.result ? r.result.value : undefined;
}

export async function findTarget(match, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await (await fetch(`${BASE}/json/list`)).json().catch(() => []);
    const t = (list || []).find((x) => x.url && x.url.includes(match));
    if (t) return t;
    if (Date.now() > deadline) throw new Error('等不到 ' + match);
    await sleep(300);
  }
}

/**
 * 量桌宠窗口：几何 + **她本人**在屏幕上的外接矩形（把当前帧画进离屏 canvas 扫 alpha）。
 * 返回的 `screenBox` 才是她的真实位置（contain + 底部对齐 + 自适应摆正之后换算出来的）。
 */
export const PET_BOX_EXPR = `(() => {
  const r = (el) => { const b = el.getBoundingClientRect();
    return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
  const stage = document.getElementById('stage');
  const a = document.getElementById('anim-a'), b = document.getElementById('anim-b');
  const on = a.classList.contains('on') ? a : b;
  const out = {
    window: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    stage: r(stage),
    fitted: stage.classList.contains('fitted') && document.body.classList.contains('fitted'),
    videoRect: r(on),
    videoOn: on === a ? 'a' : 'b',
    videoNatural: { w: on.videoWidth, h: on.videoHeight },
    readyState: on.readyState,
    say: r(document.getElementById('say')),
    saySpan: r(document.querySelector('#say span')),
    bubble: r(document.getElementById('bubble')),
    bubbleSpan: r(document.querySelector('#bubble span')),
    sayMaxW: getComputedStyle(document.querySelector('#say span')).maxWidth,
    bubbleMaxW: getComputedStyle(document.querySelector('#bubble span')).maxWidth,
    petHeadVar: getComputedStyle(document.documentElement).getPropertyValue('--pet-head').trim(),
    petWVar: getComputedStyle(document.documentElement).getPropertyValue('--pet-w').trim(),
    sayOn: document.getElementById('say').classList.contains('on'),
    bubbleOff: document.getElementById('bubble').classList.contains('off'),
    mode: (window.__DSC_PET_VIEW__ || {}).mode,
    // 注意：\`__DSC_PET_ANIM__\` 是个函数（实时探针），不是快照对象
    clip: (typeof window.__DSC_PET_ANIM__ === 'function' ? window.__DSC_PET_ANIM__() : {}).playing,
  };
  try {
    const w = on.videoWidth, h = on.videoHeight;
    if (!w || !h) { out.alpha = { error: '视频还没有尺寸' }; return JSON.stringify(out); }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(on, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1, hit = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          hit++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    out.alpha = hit ? { minX, minY, maxX, maxY, hit, frame: { w, h } }
                    : { error: '整帧全透明（这一帧没有画面）' };
    if (hit) {
      const vr = out.videoRect;
      // 【为什么用 min 而不是各算各的】画面在元素里怎么放是 CSS 决定的：
      //   摆正之后（object-fit: fill + 元素与帧同比例）→ 两轴同倍，偏移为 0；
      //   退回 contain 时（元素 200×300 对 16:9 的帧）→ 上下有信箱边，两轴倍率不同。
      // min + 居中偏移这一套**两种情形都对**（前者的偏移正好算成 0），所以只留这一套口径。
      const scale = Math.min(vr.w / w, vr.h / h);
      const drawW = w * scale, drawH = h * scale;
      const ox = vr.x + (vr.w - drawW) / 2;
      const oy = vr.y + (vr.h - drawH) / 2;
      out.screenBox = {
        left: +(ox + minX * scale).toFixed(1),
        top: +(oy + minY * scale).toFixed(1),
        right: +(ox + (maxX + 1) * scale).toFixed(1),
        bottom: +(oy + (maxY + 1) * scale).toFixed(1),
        w: +((maxX - minX + 1) * scale).toFixed(1),
        h: +((maxY - minY + 1) * scale).toFixed(1),
        scale: +scale.toFixed(3),
      };
    }
  } catch (e) {
    out.alpha = { error: String(e).slice(0, 200) };
  }
  return JSON.stringify(out);
})()`;

export async function measurePetBox(target) {
  return JSON.parse(String(await evalIn(target, PET_BOX_EXPR)));
}
