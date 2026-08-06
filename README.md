# TqSdk 行情终端

基于 [TqSdk（天勤量化）](https://doc.shinnytech.com/tqsdk/latest/) 自建的期货 / 期权 / A股盯盘终端。
浏览器界面，后端 Python，前端零依赖（只 vendor 了 lightweight-charts）。

天勤官方的 VSCode 插件已下线，想要一个能自己改的可视化行情面板就只能自己搭 —— 这就是这个项目的由来。

---

## 它能做什么

**行情**
- 多合约监控墙、K线（1m/3m/5m/15m/30m/1h/日/周/月）、分时图
- 主图叠加：MA（最多 6 条，周期可自定义）/ BOLL / 肯特纳通道 / 波动率通道
- 双副图，各自可选：MACD / KDJ / RSI / CCI / 持仓量 / 波动率（绝对值、历史分位、扩张收缩三种视角）
- 全部指标参数可改并持久化
- 画线：趋势线、水平线、垂直线、矩形、文字标注；蜡烛吸附（Alt 临时关闭）；可画到最新价右侧的未来区域
- 框选区间统计 16 项（涨跌幅/振幅/VWAP/持仓变化/年化波动/最大回撤/偏度峰度…），本地计算，微秒级
- 盘口五档 + 深度图 + 逐笔成交（含开平性质推断：双开/双平/多开/空开/多平/空平/多换/空换）
- 条件预警

**高频微观结构**（C++ 计算核心，首次运行自动编译，无第三方依赖）
- 22 项指标：订单流失衡 OFI（Cont-Kukanov）、Kyle λ、盘口委比、主动买占比、大单占比、开仓占比、现价-VWAP 偏离…
- 6 个时间尺度的已实现波动率（30s / 1m / 5m / 15m / 30m / 1h）

**期权**
- T 型报价：Δ / Γ / Vega / Θ / IV 全出
- 定价引擎按合约类型自动选：期货期权 Black-76，ETF / 股指期权 BS
- 逐月用 put-call parity 反推远期（带合理性闸门），IV 价格源分档降级（中间价 → 单边 → last → 结算价）
- 波动率微笑 / 持仓量分布 / 波动率曲面

**A股**
- 个股研究：估值、财务三表、资金流、龙虎榜、筹码分布、股东、融资融券、大宗交易（Tushare）
- 板块（东财概念 / 申万行业 / 同花顺 / 涨停主线）、指数看板

**看板**
- 首页市场总览、自选分区看板（卡片 / 列表 / 迷你多图 / 热力 / 个股研究摘要 五种形态可切）
- 主力合约看板、分区热力看板、多图 1/2/4/6/9 宫格

**交易监控**（只读）
- 账户：权益 / 风险度 / 持仓（多空分行）/ 委托 / 成交
- 净值分析：权益曲线 + 回撤曲线 + 日盈亏，11 项绩效指标（年化、最大回撤及其发生区间、夏普、卡玛…）
- 策略监控：读独立子进程策略的状态与日志

---

## 一个重要的设计约束

**盯盘服务本身不下单。** `market_wall/` 主服务没有 `insert_order` / `cancel_order` /
`TargetPosTask` 的任何调用，WebSocket 协议上不存在下单通道。理由写在 `account.py`
的文件头里：盯盘面板和下单通道混在同一条协议上，一次前端 bug 就可能变成一笔真实交易。

两点例外必须知道：

1. `examples/demo_backtest.py` 是**回测示例**，跑在 `TqBacktest` + `TqSim` 上，
   使用 `TargetPosTask`，不接触真实资金。
2. 策略面板的「启动」会以**子进程**方式拉起你自己放在 `Trade/` 下的策略脚本。
   那些脚本能不能下单、下到哪个账户，**完全取决于你自己写了什么** ——
   本终端只负责拉起和监控，不对其行为负责。

另外 `account.py` 支持在 `accounts.json` 里配置**实盘账户**（`TqAccount`），
配置后终端会用明文密码登录该账户读取持仓与权益。它只读，但密码是明文存盘的，
请自行评估风险。

---

## 安装

```bash
git clone https://github.com/VernonOY/tq-market-terminal.git
cd tq-market-terminal
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example tq_auth.env            # 填快期账号密码
cp market_wall/tushare.env.example market_wall/tushare.env   # A股基本面, 可选

.venv/bin/python market_wall/server.py
```

打开 <http://127.0.0.1:8890>。

换端口：`PORT=8891 .venv/bin/python market_wall/server.py`
换数据目录（自选、净值等落盘位置）：`MW_DATA=/path/to/data`

### 账户监控（可选）

默认起一个本地模拟盘（TqSim，不需要任何凭证）。要接快期模拟或实盘：

```bash
cp market_wall/accounts.example.json market_wall/accounts.json
```

按需删掉不用的条目。**这个文件含明文交易密码，已在 `.gitignore` 里，别改动。**

### 环境要求

- Python 3.10+（开发用 3.12）
- macOS / Linux。C++ 计算核心需要 `clang++` 或 `g++`，首次导入时自动编译；编译不成功会自动退回纯 Python 实现，功能不受影响，只是慢一些。

---

## 架构

```
server.py            aiohttp + WebSocket。三个长驻线程各持一个 TqApi:
                       采集线程   订阅行情, 事件驱动推送
                       heavy      历史下载 / 期权链 / Tushare (会阻塞几秒到几十秒)
                       account    账户快照与净值采样
option_engine.py     Black-76 / BS 定价、IV 求解、希腊字母、期权链统计
hfcalc.cpp           C++ 高频指标与波动率 (ctypes 调用, 4000 tick < 1ms)
tushare_adapter.py   Tushare HTTP 封装, 三级 TTL 磁盘缓存 + 限频
account.py           账户监控与绩效分析 (只读)
strategy_runner.py   策略子进程管理

static/app.js        主控: 视图注册表 / 主图 / 指标 / 画线 / 自选 / 搜索 / 布局
static/*.js          各视图自包含模块 (IIFE + 注入样式 + 单一 window 导出)
```

**为什么 TqApi 要分三个线程**：TqApi 不是线程安全的，而且 `get_kline_data_series`
不能在协程里调用 —— 在采集线程里内联调一次，实测会把整个终端冻住 27.94 秒。

---

## 已知边界

| 项 | 说明 |
|---|---|
| 历史深度 | 期货主连日线自 2016-01-05（2570 根），股票 / ETF 自 2018-01-01。**已交割合约拿不到** |
| 盘口档位 | 期货五档；A股是 L1 快照（3 秒一档，五档）。真正的 L2（十档 + 逐笔委托 + 队列）需要付费源，TqSdk 不提供 |
| 开平性质 | 交易所只发 500ms 快照，开平是靠 成交量 / 持仓量 / 买卖价 差分**推断**的，不是逐笔真值 |
| 同时推送的 K 线路数 | 单连接上限 16 路（`FOCUS_MAX`）。超了会淘汰最旧的 overlay 并给出提示，主图独占一格不参与淘汰 |
| 主连换月 | `KQ.m@` 已是价差复权（实测 18 个换月日平均跳空 0.169%，比普通日的 0.228% 还小），不需要自己复权 |
| A股复权 | 主图走 TqSdk 实时推送，**不复权**。跨除权日会看到跳空 |
| 天勤版本 | 免费版够用基础行情；历史下载（`tq_dl`）、股票行情、龙虎榜需要专业版 |

---

## 踩过的坑（写下来省得你再踩）

- **本机 Python 信任库可能是空的**，导致 TqSdk 的龙虎榜/结算价接口和 Tushare 的全部 HTTPS 请求一起挂掉。`server.py` 启动最开头注入了 `SSL_CERT_FILE=certifi.where()`。
- **flexbox 陷阱**：flex 子项默认 `min-height:auto`，会让内部的 `overflow:auto` 永远不触发，表现是"页面拖不动"。所有视图容器都显式写了 `min-height:0`。
- **lightweight-charts 的时间轴同步要用星型拓扑**，不能两两互联 —— 空的副图会回灌一个巨大的负数区间给主图，把 K 线挤成一条竖线。
- **`toLine` 必须给 null 值填 whitespace 占位**（只有 `time` 没有 `value`），否则各序列长度不一致，副图和主图会错位。
- **`coordinateToTime` 在最后一根之后返回 null**，所以画线要往未来延伸必须改用 logical 坐标外推。
- **aiohttp 的 `add_static` 不发 `Cache-Control`**，浏览器会按启发式规则缓存 JS 却每次重取 HTML，新旧混搭会让前端整个挂掉。这里按文件 mtime 打了版本戳。

---

## 第三方组件

| 组件 | 版本 | 来源 | 许可证 |
|---|---|---|---|
| TradingView Lightweight Charts™ | 4.2.3 | <https://github.com/tradingview/lightweight-charts> | Apache-2.0 |

`market_wall/static/lightweight-charts.js` 是上游未经修改的产物。
许可证正文见 [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt)，归属声明见 [NOTICE](NOTICE)。

## License

本仓库**自有代码**采用 [AGPL-3.0](LICENSE)。

如果你基于它改造并对外提供服务（包括 SaaS），需要同样开源你的修改。自己用、内部用不受影响。

第三方组件按其各自的许可证授权，不受本声明约束 —— 见上方「第三方组件」与 [NOTICE](NOTICE)。

---

## 免责声明

本项目是行情分析与监控工具，**不构成任何投资建议**。所有指标、定价模型、统计口径都可能有错误，
使用前请自行验证。因使用本软件造成的任何交易损失，作者不承担责任。

期货和期权交易有高杠杆风险，**可能损失超过本金**。

**无担保**：本软件按「现状」提供，不附带任何明示或默示的担保，包括但不限于适销性、
特定用途适用性。作者不对软件的正确性、可用性、及时性作任何保证。
（对应 AGPL-3.0 第 15、16 条。）

**非官方关联**：本项目是独立的第三方工具，与上海信易信息科技（TqSdk / 天勤量化 /
快期）、挖地兔（Tushare）、TradingView 均**无任何关联、赞助或背书关系**。
相关名称与商标归各自权利人所有，此处仅作指代性使用。

**合规责任**：使用者需自行确保其使用方式符合所在地法律法规及各数据源的服务条款
（包括数据的使用范围与转发限制）。
