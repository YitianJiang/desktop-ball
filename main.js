const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const path = require('path');
const fs = require('fs');

// 用 Electron 的 net.request 发 HTTP/HTTPS：它会走 session 配置的代理（包括 fapi 走本地 Clash），
// 而 Node 全局 fetch 不认 session 代理、永远直连（国内直连 fapi 被墙）。所有合约(fapi)请求都走这里。
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request(url);
    } catch (e) { return reject(e); }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; try { req.abort(); } catch (e) {} reject(new Error('timeout')); }
    }, timeoutMs);
    req.on('response', (res) => {
      let data = '';
      res.on('data', (c) => { data += c.toString(); });
      res.on('end', () => {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}
async function httpJson(url, timeoutMs = 10000) {
  const r = await httpGet(url, timeoutMs);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.body);
}

let ballWin = null;
let alertWin = null;
let settingsWin = null;
let emaAlertWin = null;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CFG = {
  eth: 2170,
  btc: 70000,
  autostart: true,
  symbol3: '', // 第三交易对：空=不显示；配置后球上加一行实时价（eth/btc 始终显示）
  proxy: '127.0.0.1:7897',   // 本地代理（Clash HTTP 端口）；合约(fapi)行情走它；eth/btc 现货绕过直连。如你的 Clash 端口不同，请在设置里改
  ema: { enabled: false, symbol: 'HYPEUSDT', interval: '5m', emaPeriod: 7, proximityPct: 0.5, pollSec: 10 },
};

// 读取配置：缺失字段用默认值补齐，兼容旧版（没有 ema 字段）配置
function readConfig() {
  const cfg = {
    eth: DEFAULT_CFG.eth,
    btc: DEFAULT_CFG.btc,
    autostart: true,
    symbol3: '',
    proxy: DEFAULT_CFG.proxy,
    ema: { ...DEFAULT_CFG.ema },
  };
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (typeof j.eth === 'number') cfg.eth = j.eth;
    if (typeof j.btc === 'number') cfg.btc = j.btc;
    cfg.autostart = j.autostart === false ? false : true;
    if (typeof j.symbol3 === 'string' && j.symbol3) {
      cfg.symbol3 = j.symbol3.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
    if (typeof j.proxy === 'string') cfg.proxy = j.proxy.trim();
    if (j.ema && typeof j.ema === 'object') {
      const e = j.ema;
      cfg.ema = {
        enabled: !!e.enabled,
        symbol: String(e.symbol || 'HYPEUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HYPEUSDT',
        interval: typeof e.interval === 'string' ? e.interval : '5m',
        emaPeriod: Number(e.emaPeriod) || 7,
        proximityPct: Number(e.proximityPct) > 0 ? Number(e.proximityPct) : 0.5,
        pollSec: Number(e.pollSec) >= 3 ? Number(e.pollSec) : 10,
      };
    }
  } catch (e) {}
  return cfg;
}
function writeConfig(cfg) {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (e) {}
}
// 注册/取消开机自启动。
// 关键：未打包（electron . 开发形态）必须显式传绝对 path + args，
// 否则 Electron 在 Windows 上会静默跳过、登录项根本不写入。
function applyAutostart(on) {
  const opts = { openAtLogin: !!on };
  if (!app.isPackaged) {
    opts.path = process.execPath;
    opts.args = [app.getAppPath()];
  }
  try { app.setLoginItemSettings(opts); } catch (e) {}
}
// 配置本地代理（Clash 等）。合约(fapi/fstream)行情走代理；现货镜像(data-api/data-stream)绕过代理直连，
// 保证 eth/btc 始终可用，不受代理开关影响。
async function applyProxy(proxy) {
  try {
    if (proxy) {
      await session.defaultSession.setProxy({
        proxyRules: `http=${proxy};https=${proxy}`,
        proxyBypassList: 'data-api.binance.vision;data-stream.binance.vision',
      });
    } else {
      await session.defaultSession.setProxy({ proxyRules: 'direct://' });
    }
  } catch (e) {}
}

// 币安 U 本位合约(USDT 永续)交易对列表：仅作设置页自动补全用。
// 优先走 fapi（合约，经本地代理）；失败（常见 451 地区限制 / 代理未通）则兜底用现货镜像列表（直连、无需代理），
// 保证自动补全不空（主流对如 BNBUSDT 现货也有）。FUTURES_SOURCE 标记来源：'futures' | 'spot-fallback' | null。
let FUTURES_SYMBOLS = null; // null=未加载；[]=加载失败且无兜底
let FUTURES_SOURCE = null;
let FUTURES_ERROR = null;
let futuresLoadPromise = null;

// 从某个 exchangeInfo 响应里筛出「TRADING + 以 USDT 结尾 + 非季度(_)」的交易对
function pickUsdtPerpetual(symbols) {
  const set = new Set();
  if (!Array.isArray(symbols)) return set;
  for (const s of symbols) {
    if (s.status === 'TRADING' && typeof s.symbol === 'string' &&
        s.symbol.endsWith('USDT') && !s.symbol.includes('_')) {
      set.add(s.symbol);
    }
  }
  return set;
}

async function loadFuturesSymbols() {
  const MAX = 3;
  FUTURES_SYMBOLS = null;
  FUTURES_SOURCE = null;
  FUTURES_ERROR = null;
  // 1) 优先拉币安 U 本位合约(USDT 永续)官方列表（经本地代理）。失败常见：代理节点地区被 Binance 451 限制 / 代理未通。
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const j = await httpJson('https://fapi.binance.com/fapi/v1/exchangeInfo', 12000);
      const set = pickUsdtPerpetual(j && j.symbols);
      if (set.size === 0) throw new Error('列表为空');
      FUTURES_SYMBOLS = [...set].sort();
      FUTURES_SOURCE = 'futures';
      FUTURES_ERROR = null;
      return;
    } catch (e) {
      FUTURES_ERROR = (e && e.message) ? e.message : String(e);
      if (attempt < MAX) { await new Promise((r) => setTimeout(r, 2500 * attempt)); }
    }
  }
  // 2) 合约列表失败 → 兜底用现货镜像列表（直连、无需代理），保证自动补全不空；并提示这是现货兜底。
  try {
    const j = await httpJson('https://data-api.binance.vision/api/v3/exchangeInfo', 10000);
    const set = pickUsdtPerpetual(j && j.symbols);
    if (set.size > 0) {
      FUTURES_SYMBOLS = [...set].sort();
      FUTURES_SOURCE = 'spot-fallback';
      return;
    }
  } catch (e2) {
    if (!FUTURES_ERROR) FUTURES_ERROR = (e2 && e2.message) ? e2.message : String(e2);
  }
  FUTURES_SYMBOLS = []; // 全部失败
}

// 确保列表已加载（并发去重）：已在加载中则复用同一 Promise，已加载则直接 resolve。
function ensureFuturesLoaded() {
  if (FUTURES_SYMBOLS !== null) return Promise.resolve();
  if (!futuresLoadPromise) {
    futuresLoadPromise = loadFuturesSymbols().finally(() => { futuresLoadPromise = null; });
  }
  return futuresLoadPromise;
}
let cfg = readConfig();

// 悬浮球：无边框、透明、永远置顶、可拖动、显示 ETH+BTC
function createBall() {
  ballWin = new BrowserWindow({
    width: 84,
    height: 44,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false, // 先不显示：Windows 上首个窗口的 skipTaskbar 构造参数常被忽略，必须在显示前再设一次
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  ballWin.setSkipTaskbar(true); // 加固 1：构造后立即设
  ballWin.loadFile(path.join(__dirname, 'index.html'));
  ballWin.once('ready-to-show', () => {
    ballWin.setSize(84, cfg.symbol3 ? 64 : 44); // 配置第三币时加高一行
    ballWin.setSkipTaskbar(true); // 加固 2：显示前最后一刻再设，规避 Windows 首个窗口 skipTaskbar 失效
    ballWin.show();
    ballWin.setAlwaysOnTop(true, 'screen-saver');
  });
  ballWin.webContents.on('did-finish-load', () => {
    if (ballWin && ballWin.webContents) ballWin.webContents.send('config', cfg);
  });
  ballWin.on('closed', () => { ballWin = null; });
}

// 报警弹框：居中、置顶、一个红色感叹号
function showAlert() {
  if (alertWin) return;
  alertWin = new BrowserWindow({
    width: 240,
    height: 240,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  alertWin.loadFile(path.join(__dirname, 'alert.html'));
  alertWin.once('ready-to-show', () => {
    alertWin.setSkipTaskbar(true);
    alertWin.show();
    alertWin.setAlwaysOnTop(true, 'screen-saver');
    alertWin.center();
  });
  alertWin.on('closed', () => { alertWin = null; });
}

function hideAlert() {
  if (alertWin) {
    try { alertWin.close(); } catch (e) {}
    alertWin = null;
  }
}

// 设置窗口：分别配置 ETH / BTC 告警阈值
function openSettings() {
  if (settingsWin) { try { settingsWin.focus(); } catch (e) {} return; }
  settingsWin = new BrowserWindow({
    width: 320,
    height: 580,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    transparent: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => {
    settingsWin.setSkipTaskbar(true);
    settingsWin.show();
    settingsWin.setAlwaysOnTop(true, 'screen-saver');
  });
  settingsWin.webContents.on('did-finish-load', () => {
    if (settingsWin && settingsWin.webContents) settingsWin.webContents.send('config', cfg);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// 均线接近告警：监听某交易对现价与指定周期 EMA 的距离，接近即弹窗
// 计算 EMA：前 period 根用 SMA 种子，之后递推
function computeEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

let emaTimer = null;
let emaArmed = true;

function startEmaMonitor() {
  stopEmaMonitor();
  const e = cfg.ema;
  if (!e || !e.enabled) return;
  emaArmed = true;
  const sym = e.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HYPEUSDT';
  const interval = e.interval;
  const emaPeriod = e.emaPeriod;
  const prox = e.proximityPct;
  const pollMs = Math.max(3000, e.pollSec * 1000);
  // klines 数量：覆盖 EMA 周期并留足预热，封顶 1000
  const limit = Math.min(1000, Math.max(emaPeriod * 2 + 100, 400));
  const tick = async () => {
    try {
      const klUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
      const klines = await httpJson(klUrl, 8000);
      if (!Array.isArray(klines) || klines.length < emaPeriod) return;
      const closes = klines.map((k) => parseFloat(k[4]));
      const ema = computeEMA(closes, emaPeriod);
      const prUrl = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(sym)}`;
      const pr = await httpJson(prUrl, 8000);
      const price = parseFloat(pr.price);
      if (!ema || !price) return;
      const distPct = (Math.abs(price - ema) / ema) * 100;
      if (distPct <= prox) {
        // 触发：仅在 armed 时弹一次，关闭/远离后重新武装
        if (emaArmed) {
          emaArmed = false;
          showEmaAlert({ symbol: sym, interval, emaPeriod, price, ema, distPct });
        }
      } else if (distPct > prox * 3) {
        emaArmed = true; // 滞后重置，避免贴着均线反复弹
      }
    } catch (err) {
      // 网络异常忽略，下一轮重试
    }
  };
  emaTimer = setInterval(tick, pollMs);
  tick();
}

function stopEmaMonitor() {
  if (emaTimer) {
    clearInterval(emaTimer);
    emaTimer = null;
  }
}

// 均线接近告警弹窗：带文字详情（区别于 ETH/BTC 的纯红色"!"）
function showEmaAlert(data) {
  if (emaAlertWin) {
    try { emaAlertWin.webContents.send('ema-alert:data', data); } catch (e) {}
    return;
  }
  emaAlertWin = new BrowserWindow({
    width: 300,
    height: 260,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  emaAlertWin.loadFile(path.join(__dirname, 'ema_alert.html'));
  emaAlertWin.once('ready-to-show', () => {
    emaAlertWin.setSkipTaskbar(true);
    emaAlertWin.show();
    emaAlertWin.setAlwaysOnTop(true, 'screen-saver');
    emaAlertWin.center();
  });
  emaAlertWin.webContents.on('did-finish-load', () => {
    if (emaAlertWin && emaAlertWin.webContents) emaAlertWin.webContents.send('ema-alert:data', data);
  });
  emaAlertWin.on('closed', () => { emaAlertWin = null; });
}

// 渲染进程事件
ipcMain.on('alert:on', () => showAlert());
ipcMain.on('alert:off', () => hideAlert());
ipcMain.on('alert:dismiss', () => hideAlert());
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });
ipcMain.on('ema-alert:dismiss', () => { if (emaAlertWin) { try { emaAlertWin.close(); } catch (e) {} emaAlertWin = null; } });
// 设置页请求币安交易对列表（仅作自动补全）。优先合约(fapi,经代理)，失败兜底现货镜像(直连)。
// 返回 { symbols, source, error }：source='futures'|'spot-fallback'|null；error 为失败原因（如 451 地区限制）。
ipcMain.on('get-usdt-pairs', (e) => {
  ensureFuturesLoaded().then(() => {
    if (e.sender && !e.sender.isDestroyed()) {
      e.sender.send('usdt-pairs', {
        symbols: FUTURES_SYMBOLS || [],
        source: FUTURES_SOURCE,
        error: FUTURES_ERROR,
      });
    }
  });
});
// 手动重试加载（设置页「重试加载」按钮）：清缓存后重新拉取，并把结果发回设置页。
ipcMain.on('reload-usdt-pairs', () => {
  futuresLoadPromise = null;
  FUTURES_SYMBOLS = null;
  ensureFuturesLoaded().then(() => {
    if (settingsWin && settingsWin.webContents && !settingsWin.webContents.isDestroyed()) {
      settingsWin.webContents.send('usdt-pairs', {
        symbols: FUTURES_SYMBOLS || [],
        source: FUTURES_SOURCE,
        error: FUTURES_ERROR,
      });
    }
  });
});
ipcMain.on('save-settings', async (e, d) => {
  const ema = d.ema || {};
  cfg = {
    eth: d.eth,
    btc: d.btc,
    autostart: !!d.autostart,
    symbol3: (typeof d.symbol3 === 'string' && d.symbol3) ? String(d.symbol3).toUpperCase().replace(/[^A-Z0-9]/g, '') : '', // 第三交易对（第三个可配置交易对，仅显示不报警）
    proxy: (typeof d.proxy === 'string') ? d.proxy.trim() : '',
    ema: {
      enabled: !!ema.enabled,
      symbol: String(ema.symbol || 'HYPEUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HYPEUSDT',
      interval: typeof ema.interval === 'string' ? ema.interval : '5m',
      emaPeriod: Number(ema.emaPeriod) || 7,
      proximityPct: Number(ema.proximityPct) > 0 ? Number(ema.proximityPct) : 0.5,
      pollSec: Number(ema.pollSec) >= 3 ? Number(ema.pollSec) : 10,
    },
  };
  writeConfig(cfg);
  applyAutostart(cfg.autostart);
  await applyProxy(cfg.proxy); // 切换代理后，重建 WS / 重启 EMA 才能生效
  startEmaMonitor();
  if (ballWin && ballWin.webContents) {
    ballWin.setSize(84, cfg.symbol3 ? 64 : 44); // 配置第三币时加高一行
    ballWin.webContents.send('config', cfg);
    ballWin.webContents.send('reload-ws'); // 用新代理重建行情 WS
  }
  if (settingsWin) settingsWin.close();
});
ipcMain.on('win:move', (e, delta) => {
  if (ballWin) {
    const [x, y] = ballWin.getPosition();
    ballWin.setPosition(x + (delta.dx || 0), y + (delta.dy || 0));
  }
});

app.whenReady().then(async () => {
  await applyProxy(cfg.proxy); // 先设代理路由（eth/btc 现货绕过、合约走代理），再加载页面
  ensureFuturesLoaded(); // 预拉交易对列表（优先合约经代理，失败兜底现货镜像），供设置页自动补全
  createBall();
  // 开机自启动：按配置决定（默认开启），写入系统登录项
  applyAutostart(cfg.autostart !== false);
  // 均线接近告警监控：若配置启用则启动后台轮询
  startEmaMonitor();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBall();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
