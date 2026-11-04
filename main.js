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
  ema: { enabled: false, symbols: [{ symbol: 'HYPEUSDT', interval: '5m', emaPeriod: 7, proximityPct: 0.5 }], pollSec: 10, showDetail: true },
};

// 归一化均线告警交易对列表：兼容旧版（单 symbol 字符串 / 字符串数组，参数共享）
// 与新版（对象数组 [{symbol, interval, emaPeriod, proximityPct}]，每对独立参数）。
// 旧版缺少的参数用传入 e.interval / e.emaPeriod / e.proximityPct 兜底；新版缺则给默认。
function normalizeEmaSymbols(e) {
  let arr;
  if (Array.isArray(e.symbols) && e.symbols.length) arr = e.symbols;
  else if (typeof e.symbol === 'string' && e.symbol) {
    arr = e.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').split(/(?:,|\s)+/).filter(Boolean).map((s) => ({ symbol: s }));
  } else arr = [{ symbol: 'HYPEUSDT' }];
  const defInterval = typeof e.interval === 'string' ? e.interval : '5m';
  const defPeriod = Number(e.emaPeriod) || 7;
  const defProx = Number(e.proximityPct) > 0 ? Number(e.proximityPct) : 0.5;
  const out = [];
  for (const it of arr) {
    let symbol, interval, emaPeriod, prox;
    if (typeof it === 'string') { symbol = it.toUpperCase().replace(/[^A-Z0-9]/g, ''); interval = defInterval; emaPeriod = defPeriod; prox = defProx; }
    else if (it && typeof it.symbol === 'string') {
      symbol = String(it.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
      interval = (typeof it.interval === 'string' && it.interval) ? it.interval : defInterval;
      emaPeriod = Number(it.emaPeriod) || defPeriod;
      prox = Number(it.proximityPct) > 0 ? Number(it.proximityPct) : defProx;
    }
    if (symbol) out.push({ symbol, interval, emaPeriod, proximityPct: prox });
  }
  return out.length ? out : [{ symbol: 'HYPEUSDT', interval: defInterval, emaPeriod: defPeriod, proximityPct: defProx }];
}

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
      const m = (e.mock && typeof e.mock === 'object') ? e.mock : {};
      cfg.ema = {
        enabled: !!e.enabled,
        symbols: normalizeEmaSymbols(e), // 每对独立参数；兼容旧版字符串数组/单 symbol
        pollSec: Number(e.pollSec) >= 3 ? Number(e.pollSec) : 10,
        showDetail: e.showDetail !== false, // 告警面板是否显示明细（当前价/EMA/偏离幅度）
        useMock: !!e.useMock,
        mock: {
          mode: 'history', // 仅历史回放（已移除内置演示）
          startTime: m.startTime ? Number(m.startTime) : null,
          endTime: m.endTime ? Number(m.endTime) : null,
          speedMs: Number(m.speedMs) || 200,
          loop: m.loop !== false,
        },
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
    height: 640,
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

// ===== 模拟数据源（用于驱动均线告警：回放指定时间段的历史 K 线） =====
// 把一段历史 K 线收盘价序列按 speedMs 逐根回放：每回放一根用最新窗口算 EMA + 当前价，
// 偏离 ≤ proximityPct 即触发均线告警（与真实源共用 showEmaAlert / armed 机制）。
// history：从币安现货镜像（直连、无需代理）按指定时间段拉历史 K 线回放。
class MockEmaEngine {
  constructor(opts) {
    this.symbol = opts.symbol;
    this.interval = opts.interval;
    this.period = opts.period;
    this.prox = opts.prox;
    this.speedMs = opts.speedMs;
    this.loop = opts.loop;
    this.startTime = opts.startTime || null;
    this.endTime = opts.endTime || null;
    this.allCloses = [];
    this.cursor = 0;
    this.timer = null;
    this.armed = true;
    this.firedCount = 0;
    this.running = false;
  }
  async load() {
    // history：从币安现货镜像（直连、无需代理）拉指定时间段的 K 线回放。
    // 时间段未完整填时兜底：结束=现在，起始=结束前 7 天，保证永远有数据可回放。
    let start = this.startTime, end = this.endTime;
    if (!end) end = Date.now();
    if (!start) start = end - 7 * 24 * 3600 * 1000;
    if (start >= end) start = end - 7 * 24 * 3600 * 1000;
    try {
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(this.symbol)}&interval=${this.interval}&startTime=${start}&endTime=${end}&limit=1000`;
      const klines = await httpJson(url, 12000);
      if (!Array.isArray(klines) || klines.length < this.period) {
        return { ok: false, error: '该时间段历史数据不足（K 线根数 < EMA 周期），请换更长/更早的时间段' };
      }
      this.allCloses = klines.map((k) => parseFloat(k[4]));
      this.cursor = 0;
      return { ok: true, total: this.allCloses.length, mode: 'history', range: (this.startTime && this.endTime) ? 'range' : 'auto' };
    } catch (e) {
      return { ok: false, error: '拉取历史 K 线失败：' + ((e && e.message) ? e.message : String(e)) + '（现货镜像直连，请检查网络）' };
    }
  }
  start() {
    if (this.running || this.allCloses.length < this.period) return;
    this.running = true;
    this.armed = true;
    const step = () => {
      if (!this.running) return;
      const closes = this.allCloses.slice(0, this.cursor + 1);
      const ema = computeEMA(closes, this.period);
      const price = this.allCloses[this.cursor];
      if (ema && price) {
        const distPct = (Math.abs(price - ema) / ema) * 100;
        if (distPct <= this.prox) {
          if (this.armed) {
            this.armed = false;
            this.firedCount++;
            showEmaAlert({ symbol: this.symbol, interval: this.interval, emaPeriod: this.period, price, ema, distPct, mock: true });
          }
        } else if (distPct > this.prox * 3) {
          this.armed = true;
        }
        this.pushProgress(price, ema, distPct, false);
      }
      this.cursor++;
      if (this.cursor >= this.allCloses.length) {
        if (this.loop) { this.cursor = 0; this.armed = true; }
        else { this.stop(); return; }
      }
    };
    this.timer = setInterval(step, this.speedMs);
    step();
  }
  pushProgress(price, ema, distPct, finished) {
    const payload = {
      symbol: this.symbol,
      running: this.running,
      cursor: this.cursor,
      total: this.allCloses.length,
      price, ema, distPct,
      firedCount: this.firedCount,
      finished: !!finished,
    };
    if (settingsWin && settingsWin.webContents && !settingsWin.webContents.isDestroyed()) {
      settingsWin.webContents.send('mock-progress', payload);
    }
  }
  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.pushProgress(null, null, null, true);
  }
}

let emaTimers = [];       // 真实源轮询定时器（每个交易对一个）
let mockEngines = [];     // 模拟数据源引擎（每个交易对一个）

// 真实行情源：定时从币安合约(fapi)拉 K 线 + 实时价，算 EMA 偏离触发告警（单个交易对）
function runRealEmaForSymbol(sym, interval, emaPeriod, prox, pollMs, limit) {
  let armed = true;
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
        if (armed) { armed = false; showEmaAlert({ symbol: sym, interval, emaPeriod, price, ema, distPct, mock: false }); }
      } else if (distPct > prox * 3) {
        armed = true;
      }
    } catch (err) { /* 网络异常忽略，下一轮重试 */ }
  };
  emaTimers.push(setInterval(tick, pollMs));
  tick();
}

// 模拟源：按 opts 构造多个引擎（每个交易对一个）并 load+start（结果回传设置页）；opts 缺省时回退到 cfg.ema
function startMockEma(opts) {
  stopEmaMonitor();
  const e = cfg.ema;
  const symbols = (opts && Array.isArray(opts.symbols) && opts.symbols.length)
    ? opts.symbols
    : (Array.isArray(e.symbols) && e.symbols.length ? e.symbols : [{ symbol: 'HYPEUSDT', interval: '5m', emaPeriod: 7, proximityPct: 0.5 }]);
  const speedMs = Math.max(20, Number((opts && opts.speedMs)) || (e.mock && e.mock.speedMs) || 200);
  const loop = (opts && typeof opts.loop === 'boolean') ? opts.loop : (e.mock ? e.mock.loop !== false : true);
  const startTime = (opts && opts.startTime) || (e.mock && e.mock.startTime) || null;
  const endTime = (opts && opts.endTime) || (e.mock && e.mock.endTime) || null;
  mockEngines = [];
  for (const it of symbols) {
    const sym = (it.symbol || 'HYPEUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HYPEUSDT';
    const interval = it.interval || '5m';
    const period = Number(it.emaPeriod) || 7;
    const prox = Number(it.proximityPct) > 0 ? Number(it.proximityPct) : 0.5;
    const eng = new MockEmaEngine({ symbol: sym, interval, period, prox, speedMs, loop, startTime, endTime });
    eng.load().then((res) => {
      if (settingsWin && settingsWin.webContents && !settingsWin.webContents.isDestroyed()) {
        settingsWin.webContents.send('mock-load-result', Object.assign({ symbol: sym }, res));
      }
      if (res.ok) eng.start();
    });
    mockEngines.push(eng);
  }
}

// 真实源：对每个监控交易对各起一个轮询（每对独立参数）
function startRealEma() {
  const e = cfg.ema;
  const pollMs = Math.max(3000, e.pollSec * 1000);
  emaTimers = [];
  const symbols = (e.symbols && e.symbols.length) ? e.symbols : [{ symbol: 'HYPEUSDT', interval: '5m', emaPeriod: 7, proximityPct: 0.5 }];
  for (const it of symbols) {
    const sym = (it.symbol || 'HYPEUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HYPEUSDT';
    const interval = it.interval || '5m';
    const emaPeriod = Number(it.emaPeriod) || 7;
    const prox = Number(it.proximityPct) > 0 ? Number(it.proximityPct) : 0.5;
    const limit = Math.min(1000, Math.max(emaPeriod * 2 + 100, 400));
    runRealEmaForSymbol(sym, interval, emaPeriod, prox, pollMs, limit);
  }
}

// EMA 监控统一入口：按 useMock 分流真实源 / 模拟源
function startEmaMonitor() {
  stopEmaMonitor();
  const e = cfg.ema;
  if (!e || !e.enabled) return;
  if (e.useMock) startMockEma();
  else startRealEma();
}

function stopEmaMonitor() {
  if (emaTimers.length) { emaTimers.forEach((t) => clearInterval(t)); emaTimers = []; }
  if (mockEngines.length) { mockEngines.forEach((eng) => { try { eng.stop(); } catch (e2) {} }); mockEngines = []; }
}

// 均线接近告警弹窗：带文字详情（区别于 ETH/BTC 的纯红色"!"）
function showEmaAlert(data) {
  // 是否展示明细行（当前价/EMA/偏离幅度）由配置 showDetail 控制
  const d = Object.assign({ showDetail: !!(cfg.ema && cfg.ema.showDetail !== false) }, data || {});
  if (emaAlertWin) {
    try { emaAlertWin.webContents.send('ema-alert:data', d); } catch (e) {}
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
    if (emaAlertWin && emaAlertWin.webContents) emaAlertWin.webContents.send('ema-alert:data', d);
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
        symbols: normalizeEmaSymbols(ema), // 每对独立参数对象数组（兼容旧字符串数组）
        pollSec: Number(ema.pollSec) >= 3 ? Number(ema.pollSec) : 10,
        showDetail: ema.showDetail !== false,
        useMock: !!ema.useMock,
        mock: {
          mode: 'history',
          startTime: (ema.mock && ema.mock.startTime) ? Number(ema.mock.startTime) : null,
          endTime: (ema.mock && ema.mock.endTime) ? Number(ema.mock.endTime) : null,
          speedMs: (ema.mock && Number(ema.mock.speedMs)) || 200,
          loop: !!(ema.mock && ema.mock.loop !== false),
        },
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
// 模拟数据源：设置页「加载并启动回放」——用当前表单的 mock 参数构造临时引擎 load+start（不依赖保存）
ipcMain.on('mock:preview-start', (e, opts) => {
  stopEmaMonitor();
  startMockEma(opts || {});
});
// 模拟数据源：停止回放
ipcMain.on('mock:stop', () => { stopEmaMonitor(); });
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
