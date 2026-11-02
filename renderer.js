const { ipcRenderer } = require('electron');

// 币安公开数据镜像（不受地域封锁，无需代理）
const WS_BASE = 'wss://data-stream.binance.vision/stream?streams=';
const REST_BASE = 'https://data-api.binance.vision/api/v3/ticker/price?symbols=';

// 阈值（由 main 通过 'config' 事件下发，可在设置框里改）
let th = { eth: 2170, btc: 70000 };
let sym3 = ''; // 第三币符号（大写，空=不显示）

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
    // 第三币变化 -> 重建 WS 流（流地址里要带上第三币）
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    connectWS();
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
  if (sym === 'sym3') { sym3El.textContent = fmtAny(p); return; } // 第三币只显示，不报警
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

// ---------- 取数：WebSocket 主通道 + REST 兜底（均随第三币动态变化）----------
function wsUrl() {
  const streams = ['ethusdt@ticker', 'btcusdt@ticker'];
  if (sym3) streams.push(sym3.toLowerCase() + '@ticker');
  return WS_BASE + streams.join('/');
}
function restUrl() {
  const syms = ['ETHUSDT', 'BTCUSDT'];
  if (sym3) syms.push(sym3);
  return REST_BASE + encodeURIComponent(JSON.stringify(syms));
}

let ws = null;
let lastMsg = 0;

function connectWS() {
  try { ws = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
  ws.onopen = () => { lastMsg = Date.now(); };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      const d = m.data;
      if (!d) return;
      const p = parseFloat(d.c);
      if (d.s === 'ETHUSDT') onPrice('eth', p);
      else if (d.s === 'BTCUSDT') onPrice('btc', p);
      else if (sym3 && d.s === sym3) onPrice('sym3', p);
      lastMsg = Date.now();
    } catch (e) {}
  };
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleReconnect() { setTimeout(connectWS, 3000); }

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg < 5000) return;
  fetch(restUrl())
    .then((r) => r.json())
    .then((arr) => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        const p = parseFloat(it.price);
        if (it.symbol === 'ETHUSDT') onPrice('eth', p);
        else if (it.symbol === 'BTCUSDT') onPrice('btc', p);
        else if (sym3 && it.symbol === sym3) onPrice('sym3', p);
      }
      lastMsg = Date.now();
    })
    .catch(() => {});
}, 2000);

connectWS();

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
