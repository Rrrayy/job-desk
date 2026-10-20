/**
 * 页面抓取内容脚本（由 popup 通过 chrome.scripting.executeScript 注入）。
 *
 * 只做一件事：把「当前页面上已经渲染出来的投递卡片」变成一段纯文本。
 * 文本形态刻意和「Ctrl+A 全选复制」一致 —— 每张卡片一行一个字段，卡片之间空一行，
 * 这样手动复制和扩展抓取会走**同一条**解析路径（app/src/adapters 里的行启发式）。
 *
 * 不做的事（都是刻意的）：
 * - 不发任何网络请求（不 fetch、不上报、不请求任何域名）；
 * - 不自动翻页、不滚动、不点按钮（那会替用户做他没做的操作，也更容易被平台判定为异常）；
 * - 不读取登录态、cookie、localStorage。
 */

/* eslint-disable no-var */

var SELECTORS = {
  version: '2025-03-01',
  platforms: [
    {
      id: 'boss',
      hosts: ['zhipin.com'],
      urlHints: ['/web/chat', '/web/geek/job', '/web/geek/recommend', '/web/job'],
      cards: ['.chat-item', '.geek-chat-item', '.job-card-wrapper', '.job-card-body', 'li.job-card-box', '.card-item'],
    },
    {
      id: 'shixiseng',
      hosts: ['shixiseng.com'],
      urlHints: ['/interns', '/deliver', '/chat'],
      cards: ['.intern-wrap', '.deliver-list-item', '.chat-item', '.job-list-item', '.intern-item'],
    },
    {
      id: 'nowcoder',
      hosts: ['nowcoder.com'],
      urlHints: ['/job', '/myapply', '/applications'],
      cards: ['.job-item', '.apply-item', '.nc-job-card', 'li.job-list-item', '.job-list li'],
    },
  ],
  generic: {
    cards: [
      "[class*='job-card']",
      "[class*='card-item']",
      "[class*='list-item']",
      "[class*='apply-item']",
      'li',
    ],
  },
};

/** 认平台：先看 host，再看路径里的关键词 */
function detectPlatform(href) {
  var url;
  try {
    url = new URL(href);
  } catch (error) {
    return null;
  }
  for (var i = 0; i < SELECTORS.platforms.length; i += 1) {
    var platform = SELECTORS.platforms[i];
    var hostHit = platform.hosts.some(function (host) {
      return url.hostname === host || url.hostname.endsWith('.' + host);
    });
    if (!hostHit) continue;
    var pathHit = platform.urlHints.some(function (hint) {
      return url.pathname.indexOf(hint) === 0 || url.pathname.indexOf(hint) >= 0;
    });
    // host 命中就够了：同一个平台的不同页面选择器会自动落空，不用在这里做强判断
    return { platform: platform, pathHit: pathHit };
  }
  return null;
}

/** 把一段 DOM 文本压成「一行一个字段」 */
function normalizeBlock(raw) {
  return String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(function (line) {
      return line.replace(/[ \t]+/g, ' ').trim();
    })
    .filter(function (line) {
      return line.length > 0;
    })
    .join('\n');
}

/** 取可见文本：innerText 会保留换行，textContent 在部分节点上更全 */
function visibleTextOf(node) {
  if (!node) return '';
  var text = typeof node.innerText === 'string' ? node.innerText : '';
  if (!text.trim()) text = node.textContent || '';
  return normalizeBlock(text);
}

/** 按选择器切卡片；返回命中最多的那一组（避免不同版本选择器互相覆盖） */
function pickCards(list) {
  var best = { selector: '', nodes: [] };
  for (var i = 0; i < list.length; i += 1) {
    var selector = list[i];
    var nodes;
    try {
      nodes = Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (error) {
      continue;
    }
    var usable = nodes.filter(function (node) {
      var text = visibleTextOf(node);
      return text.length >= 8;
    });
    if (usable.length > best.nodes.length) {
      best = { selector: selector, nodes: usable };
    }
  }
  return best;
}

/**
 * 抓取入口。挂到 globalThis 上，popup 会再注入一次 func 把它取回来
 * （executeScript 对多语句脚本的返回值不可靠，所以用「先定义、再调用」两步）。
 */
globalThis.__jobdeskCapture = function __jobdeskCapture() {
  var href = location.href;
  var hit = detectPlatform(href);
  var cardSelectors = hit ? hit.platform.cards.concat(SELECTORS.generic.cards) : SELECTORS.generic.cards;
  var picked = pickCards(cardSelectors);

  var blocks = picked.nodes
    .map(function (node) {
      return visibleTextOf(node);
    })
    .filter(function (text) {
      return text.length >= 8;
    });

  var mode = 'cards';
  var text = blocks.join('\n\n');

  if (blocks.length === 0) {
    // 一条卡片都没切出来时退回整页可见文本：宁可多抓导航文字（适配器会当噪点丢掉），
    // 也不要让用户拿到一段空字符串。
    mode = 'page';
    text = normalizeBlock(document.body ? document.body.innerText || document.body.textContent : '');
  }

  return {
    text: text,
    url: href,
    title: document.title || '',
    capturedAt: new Date().toISOString(),
    platformGuess: hit ? hit.platform.id : 'custom',
    matchedSelector: picked.selector,
    cardCount: blocks.length,
    mode: mode,
    selectorVersion: SELECTORS.version,
  };
};

// 注入即执行一次，让「只注入、不调用」的调用方也能拿到返回值
globalThis.__jobdeskCapture();
