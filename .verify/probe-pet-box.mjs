/* 只读探针：量桌宠**真正画出来的那块框**（她要紧的是"她的头在哪、她多宽"）。
 *
 * 【为什么需要它】`#stage` 是个 200×300 的盒子，而 640×360 的透明 webm 四面都是留白
 * （实测她本人只占 214×269）。盒子的几何**不等于**她的几何 —— 气泡要贴着她的头顶、
 * 尺寸要跟着她走，就得先知道她本人落在屏幕上的矩形。
 *
 * 口径与换算全在 `_pet-box.mjs`（和 verify-pet-anim.mjs 共用同一份，免得两边说法不一）。
 * 用法：node .verify/probe-pet-box.mjs
 */
import { BASE, findTarget, measurePetBox } from './_pet-box.mjs';

console.log(`[cdp] ${BASE}`);
const pet = await findTarget('pet.html');
console.log(JSON.stringify(await measurePetBox(pet), null, 2));
