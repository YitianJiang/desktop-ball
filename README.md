# ETH / BTC 价格悬浮球监控（desktop-ball）

一个极简的桌面悬浮球：实时从币安获取 **ETH/USDT 与 BTC/USDT** 价格，显示在同一枚**圆角半透明毛玻璃胶囊**里（两行纯数字，上 ETH、下 BTC，**不带币种标签**）；当任一币种价格**跌破你设定的阈值**时，屏幕中央弹出一个红色感叹号报警框。

- 永远置顶（屏幕保护级 `screen-saver`），不挡操作
- **不出现在任务栏**（开机/平时都只有浮球，无多余图标）
- 可选**开机自动启动**（设置框里勾选，写入系统登录项）
- 国内直连币安公开数据镜像，**无需代理**

## 运行

需要 Node.js（已自带），然后：

```bash
cd eth-floating-monitor
npm install      # 首次会下载 Electron
npm start
```

> 国内若 `npm install` 卡在下载 Electron 二进制，先设镜像再装：
> `npm config set electron_mirror https://npmmirror.com/mirrors/electron/`

启动后桌面上出现一枚圆角半透明胶囊，可拖动到任意位置。

## 交互

- **拖动胶囊**：直接按住拖动（无边框窗口，整体可拖）。
- **打开设置**：在胶囊上**单击（不拖动）** 或 **右键** → 弹出设置框，分别填写 ETH、BTC「低于多少（USDT）触发报警」，并可勾选「开机自动启动」。保存后**实时生效并写入 `config.json`**，重启后仍保留。
- **退出**：打开设置框 → 点其中的「退出程序」按钮（已取消"右键直接退出"，防止误触把程序关掉）。
- **报警弹框**：当 ETH 或 BTC 任一下破各自阈值时，自动弹出居中的红色「!」；**点击弹框任意处关闭**。关闭后若价格仍低于阈值不会重复弹，待价格回到阈值上方后自动重新武装，下次跌破再弹。

## 配置

报警阈值与开机自启动推荐在悬浮球上**单击打开设置框**修改（最方便，且持久化）。

也可手动复制 `config.example.json` 为 `config.json`（与 `main.js` 同目录）后编辑：

```json
{
  "eth": 2170,
  "btc": 70000,
  "autostart": true
}
```

| 字段         | 含义                                   | 默认值 |
| ------------ | -------------------------------------- | ------ |
| `eth`        | ETH/USDT 低于此值触发报警（USDT）       | 2170   |
| `btc`        | BTC/USDT 低于此值触发报警（USDT）       | 70000  |
| `autostart`  | 是否开机自动启动（仅 `false` 才关闭）   | true   |

> `config.json` 首次保存后生成；缺失时按上方默认值运行。该文件已被 `.gitignore` 忽略，不进版本库。

## 数据源

默认使用币安**公开数据镜像**，不受地域封锁、无需代理：

- 实时行情（WebSocket 合并流）：`wss://data-stream.binance.vision/stream?streams=ethusdt@ticker/btcusdt@ticker`
- 兜底轮询（REST）：`https://data-api.binance.vision/api/v3/ticker/price?symbols=["ETHUSDT","BTCUSDT"]`

WebSocket 为主、REST 每 2 秒兜底（WS 断线或 5 秒内无推送时自动补价），断网会自动重连（约 3 秒一次）。

> 若你更想用币安主站端点（需本机已配代理/科学上网才能连通），把上面两个 URL 换成
> `wss://stream.binance.com:9443/stream?streams=ethusdt@ticker/btcusdt@ticker` 与
> `https://api.binance.com/api/v3/ticker/price?symbols=["ETHUSDT","BTCUSDT"]` 即可。

## 开机自动启动

- 开关位置：设置框里的「开机自动启动」勾选框。
- 实现：Electron 未打包（`electron .`）形态下，`app.setLoginItemSettings` 在 Windows 上会静默跳过，因此代码显式传入绝对 `path` + `args` 写入系统登录项；保存设置时即时生效。
- 注册表位置：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `eth-floating-monitor`。
- 注意：未打包形态依赖 `node_modules/electron/dist/electron.exe`，移动项目目录或重装依赖后登录项会失效。要长期稳定分发，请用 `electron-builder` 打包成正式 exe（见下）。

## 任务栏行为

所有窗口（`ballWin` / `alertWin` / `settingsWin`）均 `skipTaskbar`，并在 `ready-to-show`（显示前最后一刻）再设一次，确保**不出现在任务栏**。开机后只有纯浮球，无多余图标框。

## 外观说明

- 形状：圆角矩形胶囊 `84 × 44`，`border-radius: 16px`。
- 质感：`rgba(18,20,28,0.82)` 深色半透明（Windows 透明窗口上 `backdrop-filter: blur` 不跟随 `border-radius` 裁切、会露出方角，故未使用毛玻璃滤镜）。
- 内容：两行纯数字，上 ETH（9px）、下 BTC（8px），无币种名。

## 打包为正式 exe（可选）

当前为 `electron .` 开发形态。要一劳永逸地分发并让开机自启动指向打包后的 exe：

```bash
npm install --save-dev electron-builder
# 在 package.json 增加 build 配置与脚本后执行：
npx electron-builder --win
```

打包后安装/解压出的 exe 自带独立运行环境，登录项会自动指向它，不再依赖项目目录。

## 文件结构

- `main.js` —— Electron 主进程：创建悬浮球 / 报警 / 设置窗口，处理 IPC，读写 `config.json`，注册开机自启动。
- `index.html` / `renderer.js` —— 悬浮球页面与行情逻辑（双币、拖动、阈值报警、置顶、跳过任务栏）。
- `alert.html` —— 报警弹框（仅一个红色「!」）。
- `settings.html` —— 告警阈值与开机自启动设置框。
- `config.json` —— 运行时报警阈值配置（首次保存后生成，**已被忽略，不进版本库**）。
- `config.example.json` —— 配置模板。

## 已知限制

- 未打包形态依赖本地 `node_modules/electron`，移动项目目录需重新配置开机自启动。
- 报警弹框本身为预期功能（跌破阈值才弹），但已确保它不在任务栏留图标。
- 若希望"开机后价格早已低于阈值时不立刻弹报警"，需额外加"启动静音首报"逻辑，当前未实现。
