// 用 Edge headless + CDP 截 GitHub 上 README 的真实渲染效果
// 用途：验证横幅、徽章行、<details> 折叠、2x2 截图表格是否真的长对了
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL_ = process.argv[2] || 'https://github.com/Rrrayy/job-desk';
const OUT = resolve('shots-readme');
const PORT = 9444;
const PROFILE = join(OUT, `.profile-${Date.now()}`);

mkdirSync(OUT, { recursive: true });

const child = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' });

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('CDP 端口无响应');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: r, reject: j } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) j(new Error(JSON.stringify(msg.error)));
    else r(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false,
});

async function tryLoad(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    await sleep(300);
    try {
      const r = await send('Runtime.evaluate', {
        expression: 'document.readyState', returnByValue: true,
      });
      if (r.result.value === 'complete') break;
    } catch { /* 导航中 */ }
  }
  // 按「正文文本长度」等，而不是按渲染高度 —— 高度会因图片没加载而塌成 0
  for (let i = 0; i < 50; i++) {
    const len = await evaluate(`(document.querySelector('article.markdown-body, .markdown-body')?.textContent || '').length`);
    if (len > 2000) return true;
    await sleep(400);
  }
  // 没等到正文：打诊断信息（title 能看出是不是限流/验证页）
  const title = await evaluate('document.title');
  console.log(`  ⚠️ 正文未出现，title="${title}"`);
  return false;
}

async function goto(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await tryLoad(url)) return;
    console.log(`  第 ${attempt} 次加载失败，退避 ${attempt * 8}s 后重试...`);
    await sleep(attempt * 8000);
  }
  throw new Error('GitHub 页面连续 3 次未渲染出正文（可能被限流），请稍后重试');
}

async function shot(name, clip) {
  const params = { format: 'png', captureBeyondViewport: true };
  if (clip) params.clip = { ...clip, scale: 2 };
  const r = await send('Page.captureScreenshot', params);
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log(`  saved ${name}`);
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 80));
  return r.result.value;
}

// 等所有图片真正加载并解码完（camo 代理慢，大 PNG 可能要几十秒）
async function waitImagesDecoded(label, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evaluate(`(async () => {
      document.querySelectorAll('img').forEach(i => { i.loading = 'eager'; });
      const imgs = [...document.images];
      await Promise.all(imgs.map(i => i.decode().catch(() => {})));
      const broken = imgs.filter(i => i.complete && i.naturalWidth === 0)
        .map(i => (i.currentSrc || i.src || '').split('/').slice(-2).join('/'));
      const pending = imgs.filter(i => !i.complete).length;
      return { total: imgs.length, pending, broken };
    })()`);
    if (st.pending === 0 && st.broken.length === 0) {
      console.log(`  [${label}] all ${st.total} images decoded`);
      return;
    }
    console.log(`  [${label}] pending=${st.pending} broken=${st.broken.length} ... ${Math.round((Date.now() - t0) / 1000)}s`);
    await sleep(2000);
  }
  console.log(`  [${label}] ⚠️ 超时，仍有图片未解码`);
}

// 本网络对 raw.githubusercontent 大文件持续 502（GitHub status 全绿，远端 blob
// 哈希已用 api.github.com 核对与本地一致）。这里起一个本地 HTTP 服务，
// 在 bypassCSP 下把裂图重写到 127.0.0.1，等价模拟正常网络访客看到的渲染。
const LOCAL_PORT = 9445;
async function startLocalServer(repoRoot) {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const abs = resolve(repoRoot, p);
      if (!abs.startsWith(resolve(repoRoot))) { res.writeHead(403); res.end(); return; }
      const data = readFileSync(abs);
      res.writeHead(200, {
        'content-type': abs.endsWith('.svg') ? 'image/svg+xml'
          : abs.endsWith('.png') ? 'image/png' : 'application/octet-stream',
      });
      res.end(data);
    } catch { try { res.writeHead(404); res.end(); } catch { /* ignore */ } }
  });
  await new Promise((r) => srv.listen(LOCAL_PORT, '127.0.0.1', r));
  return srv;
}

async function injectLocalImages() {
  await send('Page.setBypassCSP', { enabled: true });
  for (let k = 0; k < 20; k++) {
    const rel = await evaluate(`(() => {
      try {
        const imgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0);
        const i = imgs[0];
        if (!i) return null;
        const s = String(i.currentSrc || i.src || '');
        const m = s.match(/Rrrayy\\/job-desk\\/(?:main|raw\\/main)\\/(.+)$/);
        return m ? m[1] : null;
      } catch (e) { return 'ERR:' + e.message; }
    })()`);
    if (!rel || rel.startsWith('ERR:')) {
      if (rel) console.log('  ⚠️ rel 提取失败: ' + rel);
      break;
    }
    await evaluate(`(() => {
      const imgs = [...document.images].filter(i => i.complete && i.naturalWidth === 0);
      const i = imgs[0];
      i.removeAttribute('loading');
      i.src = 'http://127.0.0.1:${LOCAL_PORT}/' + ${JSON.stringify(rel)};
      return 'ok';
    })()`);
    console.log(`  injected local server url -> ${rel}`);
  }
  await sleep(2500);
}

// ---- 1. 亮色：首屏（横幅 + 徽章 + hero 截图）----
console.log('[1] light / hero');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await goto(URL_);
await waitImagesDecoded('light', 30000);

// 滚一遍触发懒加载，再回顶部
await evaluate(`(async () => {
  const step = window.innerHeight * 0.8;
  const max = document.documentElement.scrollHeight;
  for (let y = 0; y < max; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  return 'ok';
})()`);
await sleep(1200);
await waitImagesDecoded('light-scroll', 20000);
await startLocalServer('../');
await injectLocalImages();

// 滚到顶部，把可能遮挡的横幅关掉
await evaluate(`
  document.querySelectorAll('[class*="dependabot"], [class*="HeaderApp"], .js-notice, [data-testid*="banner"]')
    .forEach(el => { if (el.offsetHeight < 200) el.style.display = 'none'; });
  window.scrollTo(0, 0);
  'ok'
`);

// 用整页高度切几张，避免超长图被判失败
const pageInfo = await evaluate(`(() => {
  const a = document.querySelector('article.markdown-body, .markdown-body');
  const r = a ? a.getBoundingClientRect() : null;
  return {
    scrollHeight: document.documentElement.scrollHeight,
    articleTop: r ? Math.round(r.top + window.scrollY) : 0,
    articleHeight: r ? Math.round(r.height) : 0,
  };
})()`);
console.log('  page:', JSON.stringify(pageInfo));

const shotH = 1400;
const total = Math.min(pageInfo.articleTop + pageInfo.articleHeight, pageInfo.scrollHeight);
for (let i = 0, top = pageInfo.articleTop; top < total && i < 8; i++, top += shotH) {
  const h = Math.min(shotH, total - top);
  if (h < 120) break;
  await shot(`light-${String(i + 1).padStart(2, '0')}.png`, { x: 0, y: top, width: 1400, height: h });
}

// ---- 2. 暗色：不重新导航，直接切 emulated media，验证 banner-dark.svg 切换 ----
console.log('[2] dark / hero');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await sleep(1500);
await shot('dark-01.png', { x: 0, y: pageInfo.articleTop, width: 1400, height: 1000 });

// ---- 3. 断言：横幅用的是哪张图 / 徽章数量 / 折叠块数量 ----
console.log('[3] assertions');
const facts = await evaluate(`(() => {
  const art = document.querySelector('article.markdown-body, .markdown-body');
  const imgs = [...(art?.querySelectorAll('img') || [])];

  // GitHub 会把外链图片走 camo 代理，src 里看不到 img.shields.io，
  // 只能靠「徽章所在那一行的 img 个数」来判断
  const badgeRow = [...(art?.querySelectorAll('p') || [])]
    .find(p => p.querySelectorAll('img').length >= 5);
  const badges = badgeRow ? [...badgeRow.querySelectorAll('img')] : [];

  const bannerImg = imgs.find(i => /banner-/.test(i.currentSrc || i.src || ''));
  const sources = [...(art?.querySelectorAll('picture source') || [])]
    .map(s => ({ media: s.getAttribute('media'), srcset: s.getAttribute('srcset') }));
  const details = [...(art?.querySelectorAll('details') || [])];
  const broken = imgs
    .filter(i => i.complete && i.naturalWidth === 0)
    .map(i => (i.currentSrc || i.src || '').split('/').slice(-2).join('/'));

  return {
    prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    bannerCurrentSrc: bannerImg ? (bannerImg.currentSrc || '').split('/').slice(-1)[0] : null,
    bannerNaturalWidth: bannerImg ? bannerImg.naturalWidth : 0,
    pictureSourceCount: sources.length,
    pictureSources: sources,
    imgCount: imgs.length,
    badgeCount: badges.length,
    badgeAlts: badges.map(b => b.alt),
    detailsCount: details.length,
    tableCount: art ? art.querySelectorAll('table').length : 0,
    brokenImages: broken,
    h1: art?.querySelector('h1')?.textContent?.trim() || null,
  };
})()`);
console.log(JSON.stringify(facts, null, 2));

ws.close();
child.kill();
await sleep(500);
