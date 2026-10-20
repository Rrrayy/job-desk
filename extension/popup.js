/**
 * popup：注入 content.js → 取回纯文本 → 包成「信封 JSON」→ 写进剪贴板。
 *
 * 信封格式与应用里的 `app/src/lib/sync/capture.ts` 对齐：
 *   { format: 'job-desk/capture@1', url, title, capturedAt, text }
 * 应用识别到 text 字段就当「扩展抓取的页面文本」，识别不到就整段当裸文本 —— 两条路都不会丢内容。
 *
 * 剪贴板：不申请 clipboardWrite 权限（权限越少越安全），
 * 先试 navigator.clipboard，失败后退回 textarea + execCommand('copy')。
 */

var ENVELOPE_FORMAT = 'job-desk/capture@1';

var statusEl = document.getElementById('status');
var captureBtn = document.getElementById('capture');
var visibleBtn = document.getElementById('copy-visible');

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function queryActiveTab() {
  return new Promise(function (resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!tabs || tabs.length === 0) {
        reject(new Error('没有找到当前标签页'));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

function inject(tabId, files) {
  return new Promise(function (resolve, reject) {
    chrome.scripting.executeScript({ target: { tabId: tabId }, files: files }, function () {
      var error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function invokeCapture(tabId) {
  return new Promise(function (resolve, reject) {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        func: function () {
          // 这段函数被序列化后注入到页面里，不能引用外部的任何变量
          return typeof globalThis.__jobdeskCapture === 'function' ? globalThis.__jobdeskCapture() : null;
        },
      },
      function (results) {
        var error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        var first = results && results[0];
        resolve(first ? first.result : null);
      },
    );
  });
}

function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () {
      return legacyCopy(text);
    });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', 'readonly');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  document.body.appendChild(area);
  area.select();
  var ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (error) {
    ok = false;
  }
  document.body.removeChild(area);
  if (!ok) throw new Error('写入剪贴板失败（可以手动全选下面的文本再复制）');
}

function summarize(result) {
  var where = result.mode === 'cards' ? '卡片' : '整页文本';
  var count = result.cardCount > 0 ? ' · ' + result.cardCount + ' 段' : '';
  return '已复制：' + where + count + '（' + (result.platformGuess || 'custom') + '）';
}

function friendlyError(error) {
  var message = error && error.message ? error.message : String(error);
  if (/Cannot access|chrome:\/\/|extension:\/\/|The extensions gallery/i.test(message)) {
    return '这个页面不允许扩展注入（浏览器内置页面 / 应用商店）。请打开招聘平台的列表页再点一次。';
  }
  if (/No tab with id|Invalid tab ID/i.test(message)) {
    return '标签页已经变了，请重新打开 popup 再试。';
  }
  return '抓取失败：' + message;
}

function handleCapture() {
  captureBtn.disabled = true;
  setStatus('正在读取页面…');

  queryActiveTab()
    .then(function (tab) {
      if (!tab.id) throw new Error('当前标签页没有 id');
      return inject(tab.id, ['content.js']).then(function () {
        return invokeCapture(tab.id);
      });
    })
    .then(function (result) {
      if (!result || !result.text || !result.text.trim()) {
        throw new Error('这个页面上没有可读的文本（也许是空白页或者加载中）');
      }
      var envelope = {
        format: ENVELOPE_FORMAT,
        url: result.url,
        title: result.title,
        capturedAt: result.capturedAt,
        text: result.text,
      };
      return writeClipboard(JSON.stringify(envelope)).then(function () {
        setStatus(summarize(result), 'ok');
      });
    })
    .catch(function (error) {
      setStatus(friendlyError(error), 'err');
    })
    .then(function () {
      captureBtn.disabled = false;
    });
}

function handleCopyVisible() {
  visibleBtn.disabled = true;
  setStatus('正在读取整页文本…');

  queryActiveTab()
    .then(function (tab) {
      if (!tab.id) throw new Error('当前标签页没有 id');
      return new Promise(function (resolve, reject) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            func: function () {
              var body = document.body;
              return body ? body.innerText || body.textContent || '' : '';
            },
          },
          function (results) {
            var error = chrome.runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            var first = results && results[0];
            resolve(first ? first.result : '');
          },
        );
      });
    })
    .then(function (text) {
      if (!text || !text.trim()) throw new Error('这个页面上没有可读的文本');
      return writeClipboard(text).then(function () {
        setStatus('已复制整页可见文本（不含信封格式，应用会当裸文本解析）', 'ok');
      });
    })
    .catch(function (error) {
      setStatus(friendlyError(error), 'err');
    })
    .then(function () {
      visibleBtn.disabled = false;
    });
}

captureBtn.addEventListener('click', handleCapture);
visibleBtn.addEventListener('click', handleCopyVisible);
