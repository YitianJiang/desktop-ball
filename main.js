const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let ballWin = null;
let alertWin = null;
let settingsWin = null;
let emaAlertWin = null;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CFG = {
  eth: 2170,
  btc: 70000,
  autostart: true,
  symbol3: '', // 第三币：空=不显示；配置后球上加一行实时价（eth/btc 始终显示）
  ema: { enabled: false, symbol: 'HYPEUSDT', interval: '5m', emaPeriod: 7, proximityPct: 0.5, pollSec: 10 },
};

// 读取配置：缺失字段用默认值补齐，兼容旧版（没有 ema 字段）配置
function readConfig() {
  const cfg = {
    eth: DEFAULT_CFG.eth,
    btc: DEFAULT_CFG.btc,
    autostart: true,
    symbol3: '',
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
      const klUrl = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
      const klRes = await fetch(klUrl, { signal: AbortSignal.timeout(8000) });
      if (!klRes.ok) return;
      const klines = await klRes.json();
      if (!Array.isArray(klines) || klines.length < emaPeriod) return;
      const closes = klines.map((k) => parseFloat(k[4]));
      const ema = computeEMA(closes, emaPeriod);
      const prUrl = `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`;
      const prRes = await fetch(prUrl, { signal: AbortSignal.timeout(8000) });
      if (!prRes.ok) return;
      const pr = await prRes.json();
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
ipcMain.on('save-settings', (e, d) => {
  const ema = d.ema || {};
  cfg = {
    eth: d.eth,
    btc: d.btc,
    autostart: !!d.autostart,
    symbol3: (typeof d.symbol3 === 'string' && d.symbol3) ? String(d.symbol3).toUpperCase().replace(/[^A-Z0-9]/g, '') : '', // 第三交易对（第三个可配置交易对，仅显示不报警）
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
  startEmaMonitor();
  if (ballWin && ballWin.webContents) {
    ballWin.setSize(84, cfg.symbol3 ? 64 : 44); // 配置第三币时加高一行
    ballWin.webContents.send('config', cfg);
  }
  if (settingsWin) settingsWin.close();
});
ipcMain.on('win:move', (e, delta) => {
  if (ballWin) {
    const [x, y] = ballWin.getPosition();
    ballWin.setPosition(x + (delta.dx || 0), y + (delta.dy || 0));
  }
});

app.whenReady().then(() => {
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
