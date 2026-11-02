const { ipcRenderer } = require('electron');

// eth/btc 走现货公开镜像（绕过代理、直连，始终可用）
const SPOT_WS = 'wss://data-stream.binance.vision/stream?streams=';
const SPOT_REST = 'https://data-api.binance.vision/api/v3/ticker/price?symbols=';
// 第三交易对走合约（fstream/fapi），经本地代理（Clash）取数
const FUT_WS = 'wss://fstream.binance.com/ws/';
const FUT_REST = 'https://fapi.binance.com/fapi/v1/ticker/price?symbol=';

// 阈值（由 main 通过 'config' 事件下发，可在设置框里改）
let th = { eth: 2170, btc: 70000 };
let sym3 = '';      // 第三交易对（大写，空=不显示）
let sym3Ws = null;  // 第三交易对的合约 WS

const state = {
  eth: { price: null, armed: true, fired: false },
  btc: { price: null, armed: true, fired: false },
};

const ethEl = document.getElementById('ethPrice');
const btcEl = document.getElementById('btcPrice');
const sym3El = document.getElementById('sym3Price');
const sym3Row = document.getElementById('sym3Row');

ipcRenderer.on('config', (e, c) => {
  if (c && typeof c.eth === 'number' && typeof c.btc === 'number') th = { eth: c.eth, btc: c.btc };
  const ns = (c && c.symbol3) ? String(c.symbol3).toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (ns !== sym3) {
    sym3 = ns;
    sym3Row.style.display = sym3 ? 'block' : 'none';
    connectSym3(); // 第三交易对变化 -> 重建合约 WS 流
  }
});

function fmtEth(p) { return p.toFixed(2); }
function fmtBtc(p) { return p.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtAny(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  return p.toFixed(5);
}

function onPrice(sym, p) {
  const s = state[sym];
  s.price = p;
  const below = p < th[sym];
  if (below) {
    if (s.armed) { s.armed = false; s.fired = true; }   // 触发一次，价格回升到阈值上方前不再重复弹
  } else {
    s.armed = true; s.fired = false;                     // 回到上方 -> 重新武装
  }
  if (sym === 'eth') ethEl.textContent = fmtEth(p);
  else btcEl.textContent = fmtBtc(p);
  refreshAlert();
}

let alertRequested = false;
function refreshAlert() {
  const any = state.eth.fired || state.btc.fired;
  if (any && !alertRequested) { alertRequested = true; ipcRenderer.send('alert:on'); }
  else if (!any && alertRequested) { alertRequested = false; ipcRenderer.send('alert:off'); }
}

// ---------- 现货 WS（eth/btc）----------
let ws = null;
let lastMsg = 0;
function connectSpotWS() {
  try { ws = new WebSocket(SPOT_WS + 'ethusdt@ticker/btcusdt@ticker'); } catch (e) { scheduleReconnect(); return; }
  ws.onopen = () => { lastMsg = Date.now(); };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const d = m.data;
      if (!d) return;
      const p = parseFloat(d.c);
      if (d.s === 'ETHUSDT') onPrice('eth', p);
      else if (d.s === 'BTCUSDT') onPrice('btc', p);
      lastMsg = Date.now();
    } catch (e) {}
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function scheduleReconnect() { setTimeout(connectSpotWS, 3000); }

// ---------- 合约 WS（第三交易对）----------
function connectSym3() {
  if (sym3Ws) { try { sym3Ws.onclose = null; sym3Ws.close(); } catch (e) {} sym3Ws = null; }
  if (!sym3) return;
  try { sym3Ws = new WebSocket(FUT_WS + sym3.toLowerCase() + '@ticker'); } catch (e) { scheduleSym3(); return; }
  sym3Ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const p = parseFloat(m.c);
      if (m.s === sym3 && p) sym3El.textContent = fmtAny(p);
    } catch (e) {}
  };
  sym3Ws.onclose = () => scheduleSym3();
  sym3Ws.onerror = () => { try { sym3Ws.close(); } catch (e) {} };
}
function scheduleSym3() { setTimeout(connectSym3, 3000); }

// ---------- REST 兜底（现货 eth/btc + 合约 sym3）----------
setInterval(() => {
  if (!(ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg < 5000)) {
    fetch(SPOT_REST + encodeURIComponent(JSON.stringify(['ETHUSDT', 'BTCUSDT'])))
      .then((r) => r.json())
      .then((arr) => {
        if (!Array.isArray(arr)) return;
        for (const it of arr) {
          const p = parseFloat(it.price);
          if (it.symbol === 'ETHUSDT') onPrice('eth', p);
          else if (it.symbol === 'BTCUSDT') onPrice('btc', p);
        }
        lastMsg = Date.now();
      })
      .catch(() => {});
  }
  if (sym3) {
    fetch(FUT_REST + encodeURIComponent(sym3))
      .then((r) => r.json())
      .then((j) => { const p = parseFloat(j.price); if (p) sym3El.textContent = fmtAny(p); })
      .catch(() => {});
  }
}, 2000);

connectSpotWS();

// 代理变更后由 main 触发：重建所有 WS（用新代理重新连接合约流）
ipcRenderer.on('reload-ws', () => {
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
  connectSpotWS();
  connectSym3();
});

// ---------- 拖动 + 点击打开设置 ----------
let dragging = false, moved = false, lastX = 0, lastY = 0;
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;            // 只处理左键
  dragging = true; moved = false;
  lastX = e.screenX; lastY = e.screenY;
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX, dy = e.screenY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  ipcRenderer.send('win:move', { dx, dy });
  lastX = e.screenX; lastY = e.screenY;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0 && dragging && !moved) ipcRenderer.send('open-settings'); // 单击（未拖动）-> 打开设置
  dragging = false;
});
// 右键也打开设置（不再直接退出，避免误触把整个程序关掉）
window.addEventListener('contextmenu', (e) => { e.preventDefault(); ipcRenderer.send('open-settings'); });
