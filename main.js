const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let ballWin = null;
let alertWin = null;
let settingsWin = null;

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CFG = { eth: 2170, btc: 70000, autostart: true };

function readConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (typeof j.eth === 'number' && typeof j.btc === 'number') {
      // 旧配置没有 autostart 字段时默认开启（除非显式 false）
      return { eth: j.eth, btc: j.btc, autostart: j.autostart === false ? false : true };
    }
  } catch (e) {}
  return { ...DEFAULT_CFG };
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
    width: 300,
    height: 232,
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

// 渲染进程事件
ipcMain.on('alert:on', () => showAlert());
ipcMain.on('alert:off', () => hideAlert());
ipcMain.on('alert:dismiss', () => hideAlert());
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('open-settings', () => openSettings());
ipcMain.on('settings:close', () => { if (settingsWin) settingsWin.close(); });
ipcMain.on('save-settings', (e, d) => {
  cfg = { eth: d.eth, btc: d.btc, autostart: !!d.autostart };
  writeConfig(cfg);
  applyAutostart(cfg.autostart);
  if (ballWin && ballWin.webContents) ballWin.webContents.send('config', cfg);
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createBall();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
