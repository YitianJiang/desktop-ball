# ETH / BTC 价格悬浮球监控（desktop-ball）

一个极简的桌面悬浮球：实时从币安获取 **ETH/USDT 与 BTC/USDT** 价格（可选第三币），显示在同一枚**圆角半透明毛玻璃胶囊**里（两行纯数字，上 ETH、下 BTC；**可选第三币加一行**，**不带币种标签**）；当 ETH 或 BTC 价格**跌破你设定的阈值**时，屏幕中央弹出一个红色感叹号报警框。

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
- **打开设置**：在胶囊上**单击（不拖动）** 或 **右键** → 弹出设置框，填写 ETH、BTC「低于多少（USDT）触发报警」，还可输入/选择**第三交易对**（默认不显示，填了之后球上多出一行实时价），并勾选「开机自动启动」。保存后**实时生效并写入 `config.json`**，重启后仍保留。
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
| `symbol3`    | 第三交易对（合约，如 `HYPEUSDT`），空字符串 `""` = 不显示 | `""`（空） |
| `proxy`      | 本地代理（Clash 等 HTTP 端口，如 `127.0.0.1:7897`）；空 = 不走代理，合约行情（第三交易对 / EMA）取不到 | `""`（空） |

> `config.json` 首次保存后生成；缺失时按上方默认值运行。该文件已被 `.gitignore` 忽略，不进版本库。

## 均线接近告警（EMA 接近监听）

在设置框的「均线接近告警」区可监听**任意交易对**：后台定时拉取该交易对的 K 线，计算指定周期 **EMA**，当**现价与 EMA 的偏离 ≤ 设定幅度**时，弹出带文字详情的桌面告警窗（区别于 ETH/BTC 的纯红色「!」）。

- **交易对**：输入或选择（自动补全优先列出 **U 本位合约 USDT 交易对**，含 `HYPEUSDT` 等；不区分大小写、自动转大写）。
- **K线周期 / 均线周期**：两个文本框（不再用下拉，避免展开遮挡提示），如 `5m` / `7`，支持 `1m 3m 5m 15m 30m 1h 4h 1d 1w` 与 EMA 7/10/15/20/30/40/50/72/120/162/200。
- **接近幅度（%）**：偏离 ≤ 该百分比即触发（默认 0.5%）。例：`HYPEUSDT` / `5m` / EMA `7` / `0.5%` → 现价距 EMA7 不到 0.5% 就弹窗。
- **检查间隔（秒）**：轮询频率，默认 10 秒（最小 3 秒）。

告警窗展示：交易对、K线周期、均线名、当前价格、EMA 值、偏离幅度（含上/下方）。**点击弹窗任意处关闭**。为避免贴着均线反复弹，采用滞后重置：偏离回到 3 倍幅度以上才重新武装、下次接近再弹。

`config.json` 中对应结构（也可手动编辑后重命名 `config.example.json`）：

```json
{
  "eth": 2170,
  "btc": 70000,
  "autostart": true,
  "proxy": "127.0.0.1:7897",
  "symbol3": "HYPEUSDT",
  "ema": {
    "enabled": true,
    "symbol": "HYPEUSDT",
    "interval": "5m",
    "emaPeriod": 7,
    "proximityPct": 0.5,
    "pollSec": 10
  }
}
```

数据源：**ETH/BTC 走币安现货公开镜像（`data-api.binance.vision`），绕过代理、始终可用**；**第三交易对与 EMA 监控走币安 U 本位合约（`fapi.binance.com` / `fstream.binance.com`），需经本地代理**（见下「代理与合约行情」）。EMA 计算在前 `emaPeriod` 根用 SMA 种子后递推，K 线取 `max(emaPeriod*2+100, 400)` 根（封顶 1000）以保证精度。

## 代理与合约行情（重要）

合约端点 `fapi.binance.com` / `fstream.binance.com` 在国内被墙，**必须经本地代理**（Clash / v2ray 等）才能取数；而现货镜像 `data-api.binance.vision` 不受封锁、直连即可。

- 设置框新增「**本地代理**」字段：填你 Clash 的 HTTP 代理端口（通常是 `127.0.0.1:7897` 或 `127.0.0.1:7890`）。保存后程序会把**除现货镜像外的所有请求**路由到该代理，现货镜像（`data-api.binance.vision` / `data-stream.binance.vision`）始终**绕过代理直连**，保证 ETH/BTC 不受代理开关影响。
- 第三交易对与 EMA 的自动补全列表：优先拉取**合约** `exchangeInfo`（只列 USDT 永续，排除季度交割），拉不到时退回现货列表。
- **若未填代理或代理不通**：ETH/BTC 照常显示；第三交易对显示 `--` 且 EMA 不触发（不会崩溃）。

## 数据源

- ETH/BTC 现货行情（WebSocket 合并流）：`wss://data-stream.binance.vision/stream?streams=ethusdt@ticker/btcusdt@ticker`。
- ETH/BTC 现货兜底（REST）：`https://data-api.binance.vision/api/v3/ticker/price?symbols=["ETHUSDT","BTCUSDT"]`。
- 第三交易对合约行情（WebSocket）：`wss://fstream.binance.com/ws/<SYMBOL>@ticker`（走代理）。
- 第三交易对 / EMA 合约数据（REST）：`https://fapi.binance.com/fapi/v1/ticker/price`、`/fapi/v1/klines`（走代理）。

WebSocket 为主、REST 每 2 秒兜底（WS 断线或 5 秒内无推送时自动补价），断网会自动重连（约 3 秒一次）。

## 开机自动启动

- 开关位置：设置框里的「开机自动启动」勾选框。
- 实现：Electron 未打包（`electron .`）形态下，`app.setLoginItemSettings` 在 Windows 上会静默跳过，因此代码显式传入绝对 `path` + `args` 写入系统登录项；保存设置时即时生效。
- 注册表位置：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，值名 `eth-floating-monitor`。
- 注意：未打包形态依赖 `node_modules/electron/dist/electron.exe`，移动项目目录或重装依赖后登录项会失效。要长期稳定分发，请用 `electron-builder` 打包成正式 exe（见下）。

## 任务栏行为

所有窗口（`ballWin` / `alertWin` / `settingsWin`）均 `skipTaskbar`，并在 `ready-to-show`（显示前最后一刻）再设一次，确保**不出现在任务栏**。开机后只有纯浮球，无多余图标框。

## 外观说明

- 形状：圆角矩形胶囊 `84 × 44`（配置第三币时自动加高为 `84 × 64`），`border-radius: 16px`。
- 质感：`rgba(18,20,28,0.82)` 深色半透明（Windows 透明窗口上 `backdrop-filter: blur` 不跟随 `border-radius` 裁切、会露出方角，故未使用毛玻璃滤镜）。
- 内容：两行（或三行）纯数字，上 ETH（9px）、中 BTC（8px）、第三交易对（8px），无币种名。

## 打包为正式 exe（可选）

当前为 `electron .` 开发形态。要一劳永逸地分发并让开机自启动指向打包后的 exe：

```bash
npm install --save-dev electron-builder
# 在 package.json 增加 build 配置与脚本后执行：
npx electron-builder --win
```

打包后安装/解压出的 exe 自带独立运行环境，登录项会自动指向它，不再依赖项目目录。

## 文件结构

- `main.js` —— Electron 主进程：创建悬浮球 / 报警 / 设置 / 均线告警窗口，处理 IPC，读写 `config.json`，注册开机自启动，后台轮询计算 EMA 并比对现价。
- `index.html` / `renderer.js` —— 悬浮球页面与行情逻辑（双币+可选第三交易对、拖动、阈值报警、置顶、跳过任务栏，第三交易对动态订阅行情）。
- `alert.html` —— ETH/BTC 报警弹框（仅一个红色「!」）。
- `ema_alert.html` —— 均线接近告警弹窗（带文字详情）。
- `settings.html` —— 告警阈值、开机自启动、均线接近监控设置框。
- `config.json` —— 运行时报警阈值配置（首次保存后生成，**已被忽略，不进版本库**）。
- `config.example.json` —— 配置模板。

## 已知限制

- 未打包形态依赖本地 `node_modules/electron`，移动项目目录需重新配置开机自启动。
- 报警弹框本身为预期功能（跌破阈值才弹），但已确保它不在任务栏留图标。
- 若希望"开机后价格早已低于阈值时不立刻弹报警"，需额外加"启动静音首报"逻辑，当前未实现。
