// 開機檢查（GM 2026-11-08：iPhone 白屏時什麼都看不到）。
// 在主程式之前載入、刻意不經打包：主程式沒下載、解析失敗或一直沒畫出來時，主程式自己的錯誤處理
// 根本沒機會跑，只有這支能把原因顯示出來。主程式畫好後在 <html> 標 data-ab-booted="1"（App.tsx）。
// 規則：BOOT_WAIT_MS 內沒有標記就顯示說明與攔到的錯誤；之後才標記（只是慢）就自己收掉。
(function () {
  // 測試可在頁面腳本執行前設 window.__abBootWaitMs 縮短等待（e2e/flows-boot.spec.ts）。
  var BOOT_WAIT_MS = window.__abBootWaitMs || 8000;
  var zh = /^zh/i.test(navigator.language || '');
  var text = zh
    ? {
        title: '畫面沒有載入成功',
        body: '程式沒有跑起來。可能是網路中斷、hub 連不上，或瀏覽器留著舊版的檔案。先按「重新載入」；還是不行就按「略過快取重新載入」。',
        errors: '攔到的錯誤',
        none: '沒有攔到錯誤（程式可能還在下載，或卡在連線）。',
        reload: '重新載入',
        bypass: '略過快取重新載入',
        copy: '複製細節',
        copied: '已複製',
      }
    : {
        title: 'The page did not load',
        body: 'The app did not start. The network may be down, the hub unreachable, or the browser may be holding old files. Press Reload first; if that fails, press Reload without cache.',
        errors: 'Errors caught',
        none: 'No errors caught (the app may still be downloading, or stuck on the connection).',
        reload: 'Reload',
        bypass: 'Reload without cache',
        copy: 'Copy details',
        copied: 'Copied',
      };
  var caught = [];
  var root = document.documentElement;
  var overlay = null;

  function note(message) {
    if (caught.length < 20) caught.push(message);
  }

  window.addEventListener(
    'error',
    function (event) {
      var target = event.target;
      if (target && target !== window && (target.src || target.href)) {
        note((zh ? '檔案載入失敗：' : 'Failed to load: ') + (target.src || target.href));
        return;
      }
      var stack =
        event.error && event.error.stack ? '\n' + String(event.error.stack).slice(0, 800) : '';
      note(
        event.message +
          ' (' +
          event.filename +
          ':' +
          event.lineno +
          ':' +
          event.colno +
          ')' +
          stack,
      );
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    note(reason && reason.stack ? String(reason.stack).slice(0, 800) : String(reason));
  });
  document.addEventListener('securitypolicyviolation', function (event) {
    note('CSP: ' + event.violatedDirective + ' ' + event.blockedURI);
  });

  function booted() {
    return root.getAttribute('data-ab-booted') === '1';
  }

  function details() {
    return [location.href, navigator.userAgent, new Date().toISOString()].concat(caught).join('\n');
  }

  function button(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText =
      'min-height:44px;padding:0 16px;border-radius:8px;border:1px solid #333c49;background:#232b36;color:#fff;font:inherit;font-weight:600;cursor:pointer';
    b.addEventListener('click', onClick);
    return b;
  }

  function show() {
    if (overlay || booted()) return;
    overlay = document.createElement('div');
    overlay.setAttribute('role', 'alert');
    overlay.setAttribute('data-testid', 'boot-check');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#0a0c10;color:#e9eef5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang TC","Noto Sans TC",sans-serif;padding:max(24px,env(safe-area-inset-top)) 16px 24px';
    var box = document.createElement('div');
    box.style.cssText = 'max-width:640px;margin:0 auto';
    var h = document.createElement('h1');
    h.textContent = text.title;
    h.style.cssText = 'font-size:20px;margin:0 0 8px;color:#fff';
    var p = document.createElement('p');
    p.textContent = text.body;
    p.style.cssText = 'margin:0 0 16px';
    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px';
    actions.appendChild(
      button(text.reload, function () {
        location.reload();
      }),
    );
    actions.appendChild(
      button(text.bypass, function () {
        location.replace(location.pathname + '?r=' + Date.now() + location.hash);
      }),
    );
    var copy = button(text.copy, function () {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(details()).then(function () {
          copy.textContent = text.copied;
        });
      }
    });
    actions.appendChild(copy);
    var h2 = document.createElement('h2');
    h2.textContent = text.errors;
    h2.style.cssText = 'font-size:15px;margin:0 0 4px;color:#fff';
    var pre = document.createElement('pre');
    pre.setAttribute('data-testid', 'boot-check-errors');
    pre.textContent = caught.length ? caught.join('\n\n') : text.none;
    pre.style.cssText =
      'white-space:pre-wrap;word-break:break-word;margin:0;padding:12px;border-radius:8px;background:#14181f;font:12px/1.5 ui-monospace,Menlo,monospace;color:#ffb4ae';
    var ua = document.createElement('p');
    ua.textContent = navigator.userAgent;
    ua.style.cssText = 'margin:12px 0 0;font-size:12px;color:#8b949e;word-break:break-word';
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(actions);
    box.appendChild(h2);
    box.appendChild(pre);
    box.appendChild(ua);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // 晚到的標記：程式只是慢，畫好了就把說明收掉。
  new MutationObserver(function () {
    if (booted() && overlay) {
      overlay.remove();
      overlay = null;
    }
  }).observe(root, { attributes: true, attributeFilter: ['data-ab-booted'] });

  setTimeout(show, BOOT_WAIT_MS);
})();
