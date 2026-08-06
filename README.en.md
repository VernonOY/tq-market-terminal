# TqSdk Market Terminal

[中文](README.md) · **English**

A self-built futures / options / A-share trading terminal on top of
[TqSdk (Shinny Technology)](https://doc.shinnytech.com/tqsdk/latest/).
Python backend, zero-dependency frontend (only lightweight-charts is vendored), runs in a browser.

Shinny discontinued their official VSCode plugin. If you want a market panel you can
**actually modify**, you have to build it yourself — that's where this came from.

> The Chinese README is the primary document; this is a translation. Where they disagree,
> [README.md](README.md) is authoritative.

---

## The three things this project actually cares about

### 1. High-frequency microstructure metrics computed in C++

The order book and the tick tape contain things a daily chart will never show you.
These are all O(n) rolling-window computations — running them per-tick in Python would
stall the whole collector thread, so the compute core is written in C++.

**Measured (4000 ticks, MacBook)**

| Call | Time | Output |
|---|---|---|
| `hf_metrics` | **1.48 ms** | 22 microstructure metrics |
| `hf_realized_vol` | **0.44 ms** | realized volatility at 6 time scales |
| `hf_range_stats` | **1.19 ms** | 21 statistics over a selected range |

The 13 shown live in the UI:

```
Book imbalance          Order-flow imbalance/s (OFI)   Aggressor buy ratio
Micro momentum          Trades/s                       Volume/s
Avg trade size          Large-order ratio              Position-opening ratio
OI change/s             Avg spread (bp)                Price vs VWAP (bp)
Kyle's lambda (impact coefficient)
```

A few worth calling out:

- **Order-flow imbalance (OFI)** — the Cont & Kukanov formulation, inferring true buy/sell
  pressure from changes in best bid/ask and their sizes. Much cleaner than just looking at
  trade direction.
- **Kyle's lambda** — how far one unit of volume moves the price. A large λ means a thin book:
  the same order size will walk through more levels. This is your slippage, directly.
- **Position-opening ratio** — the share of volume that *opened* positions rather than closing
  them, inferred by differencing volume against open interest. Mostly-opening means new money
  is entering; mostly-closing looks more like profit-taking.
- **Realized volatility** — 30s / 1m / 5m / 15m / 30m / 1h computed simultaneously. When the
  short scales spike while the long ones haven't moved, volatility is expanding.

**The engineering tradeoff**: `hfcalc.cpp` is 345 lines with zero third-party dependencies —
just `ctypes` plus the system compiler. It auto-compiles with `clang++ -O3` into a shared
library on first import, and **falls back to a pure-Python implementation if compilation
fails** — nothing is missing, it's just slower. So a fresh clone runs immediately with no
build step.

Three volatility estimators are available: Garman-Klass / Parkinson / close-to-close.
The first two use intraday highs and lows and are far more efficient on the same sample.

### 2. Configurability

**Everything is adjustable, and it remembers.** 20 settings persist to localStorage:

- **Indicator parameters**: up to 6 MAs and 3 volume MAs with arbitrary periods; BOLL / MACD /
  KDJ / RSI / CCI / Keltner parameters are all editable
- **Two independently configured sub-charts**: each picks from MACD / KDJ / RSI / CCI /
  open interest / volatility (percentile · expansion-contraction · absolute — three lenses).
  The gear sits in the sub-chart's bottom-right corner so it costs no vertical space.
- **Watchlist section board**: each section renders as cards / table / mini-charts / heatmap /
  stock-research summary; cards drag between sections
- **Layout**: left and right panels are draggable and double-click to collapse; the right
  panel's six sections each fold independently
- **Drawing**: trendline / horizontal / vertical / rectangle / text, with candle snapping
  (hold Alt to suspend) — and you **can draw into the empty space to the right of the last bar**

**Comparison overlay**: adding a second instrument switches the whole chart to percentage
scale, with both normalized against **the first bar of the current visible range** — the basis
recomputes as you zoom or pan. Gold at 929 and silver at 15000 differ by 16×; without
normalization there is nothing to compare. Overlays render as line or candles, and actual
prices are read from the legend.

### 3. Programmatic trading and paper accounts

**The account is the container**: pick an account first, then look at its strategies, equity
curve, and positions. You can run multiple paper accounts in parallel, and multiple strategies
under one account.

- **Account monitor**: equity / available / margin / risk ratio / floating P&L / closed P&L,
  with long and short shown on separate rows (merging them gets the net direction wrong)
- **Equity analysis**: equity curve + drawdown curve + floating P&L + daily P&L, plus 11
  performance metrics (annualized return, max drawdown and when it happened, Sharpe, Calmar,
  win/lose days…). **Insufficient sample shows "—", not 0** — rendering "can't compute yet"
  as 0% misleads.
- **Strategy monitor**: strategies run as **separate subprocesses**; the terminal reads their
  state and logs. If a strategy dies while still holding positions, its account card gets a red
  flag — a dead strategy will not close its own positions, which is the most dangerous state.
- **Trade review**: reconstructs per-trade P&L from the entry/exit prices a strategy reports,
  expressed in **basis points rather than currency** — no contract multiplier needed, and it's
  comparable across instruments (one tick of soybeans and one tick of copper differ by tens of
  times). Includes win rate, average win, average loss, profit factor, and a cumulative curve.
  Strategies that have already finished can still be reviewed.

Supports `TqSim` (local paper, no credentials), `TqKq` (Shinny paper), and `TqAccount`
(live account, read-only monitoring).

---

## One important design constraint

**The monitoring service itself does not place orders.** The `market_wall/` main service
contains no calls to `insert_order` / `cancel_order` / `TargetPosTask`, and the WebSocket
protocol has no order-entry channel. The reasoning is in the header of `account.py`: putting
a monitoring panel and an order channel on the same protocol means one frontend bug can
become a real trade.

Two exceptions you must know about:

1. `examples/demo_backtest.py` is a **backtest example** running on `TqBacktest` + `TqSim`.
   It uses `TargetPosTask` and never touches real money.
2. "Start" in the strategy panel launches, **as a subprocess**, a strategy script you placed in
   `Trade/` yourself. Whether those scripts place orders — and into which account — **depends
   entirely on what you wrote**. This terminal only launches and monitors them; it is not
   responsible for their behaviour.

Also, `account.py` supports configuring a **live account** (`TqAccount`) in `accounts.json`.
Once configured, the terminal logs into that account with a plaintext password to read
positions and equity. It is read-only, but the password sits in plaintext on disk — assess
that risk yourself.

---

## Everything else

**Market data**: multi-instrument monitor wall; candles (1m/3m/5m/15m/30m/1h/day/week/month);
intraday price & VWAP line chart; 5-level order book + depth chart; tick tape with inferred
open/close nature (open-both / close-both / long-open / short-open / long-close / short-close /
long-switch / short-switch); conditional alerts. Selecting a range produces 21 statistics
(change, amplitude, VWAP, OI change, annualized vol, max drawdown, skew, kurtosis…), computed
locally in milliseconds.

**Options**: option chain with Δ/Γ/Vega/Θ/IV; Black-76 for futures options and BS for ETF and
index options, chosen automatically by contract type; forward inferred per expiry via put-call
parity (with a sanity gate); IV price source degrades in tiers (mid → one-sided → last →
settlement); volatility smile / open-interest distribution / volatility surface.

**A-shares**: per-stock valuation, three financial statements, money flow, dragon-tiger list,
chip distribution, shareholders, margin trading, block trades (via Tushare); sector boards
(EastMoney concepts / SW industries / THS / limit-up themes) and index board.

**Boards**: market overview, dominant-contract board, sector heatmap, multi-chart 1/2/4/6/9 grid.

---

## Install

```bash
git clone https://github.com/VernonOY/tq-market-terminal.git
cd tq-market-terminal
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example tq_auth.env            # your Shinny account
cp market_wall/tushare.env.example market_wall/tushare.env   # A-share fundamentals, optional

.venv/bin/python market_wall/server.py
```

Open <http://127.0.0.1:8890>.

Change port: `PORT=8891 .venv/bin/python market_wall/server.py`
Change data directory (watchlist, equity series, etc.): `MW_DATA=/path/to/data`

`examples/` has three minimal scripts (fetch a quote, subscribe to candles, run a backtest):

```bash
.venv/bin/python examples/demo_quote.py
```

### Account monitoring (optional)

By default a local paper account starts (TqSim, no credentials needed). To connect Shinny
paper trading or a live account:

```bash
cp market_wall/accounts.example.json market_wall/accounts.json
```

Delete the entries you don't need. **This file holds a plaintext trading password. It is
already in `.gitignore` — leave that alone.**

### Requirements

- Python 3.10+ (developed on 3.12)
- macOS / Linux. The C++ core needs `clang++` and compiles on first import; if compilation
  fails it falls back to pure Python with no loss of functionality.

---

## Architecture

```
server.py            aiohttp + WebSocket. Three long-lived threads, each owning one TqApi:
                       collector   subscribes to market data, event-driven push
                       heavy       history download / option chains / Tushare (blocks for seconds)
                       account     account snapshots and equity sampling
option_engine.py     Black-76 / BS pricing, IV solving, Greeks, chain statistics
hfcalc.cpp           C++ HF metrics and volatility (via ctypes, 345 lines, zero deps)
tushare_adapter.py   Tushare HTTP wrapper, three-tier TTL disk cache + rate limiting
account.py           account monitoring and performance analysis (read-only)
strategy_runner.py   strategy subprocess management

static/app.js        controller: view registry / main chart / indicators / drawing / watchlist
static/*.js          self-contained view modules (IIFE + injected styles + one window export)
```

**Why three TqApi threads**: TqApi is not thread-safe, and `get_kline_data_series` cannot be
called from a coroutine — calling it inline in the collector thread was measured to freeze the
entire terminal for 27.94 seconds.

---

## Known limits

| Item | Detail |
|---|---|
| History depth | Continuous futures daily bars from 2016-01-05 (2570 bars); stocks / ETFs from 2018-01-01. **Expired contracts are unavailable** |
| Book depth | 5 levels for futures; A-shares are L1 snapshots (one every 3s, 5 levels). True L2 (10 levels + order-by-order + queue) requires a paid feed TqSdk does not provide |
| Open/close nature | Exchanges only publish 500ms snapshots — open/close is **inferred** by differencing volume / open interest / bid-ask, not ground truth |
| Concurrent candle streams | 16 per connection (`FOCUS_MAX`). Overflow evicts the oldest overlay with a notice; the main chart holds a reserved slot and is never evicted |
| Continuous contract rollover | `KQ.m@` is already spread-adjusted (18 rollover days averaged 0.169% gap versus 0.228% on ordinary days), so no adjustment is needed |
| A-share adjustment | The main chart uses TqSdk's live feed and is **not** adjusted for corporate actions — expect gaps across ex-dividend dates |
| TqSdk tier | The free tier covers basic market data; history download (`tq_dl`), stock quotes, and the dragon-tiger list require the pro tier |
| Paper fills | `TqSim` does not model queue position — a limit order fills as soon as price touches it. **Live passive fill rates will be materially lower than in simulation** |

---

## Traps already stepped on (so you don't have to)

- **Your local Python trust store may be empty**, which takes down both TqSdk's ranking /
  settlement endpoints and every Tushare HTTPS request. `server.py` injects
  `SSL_CERT_FILE=certifi.where()` before anything else.
- **The flexbox trap**: flex children default to `min-height:auto`, which prevents any inner
  `overflow:auto` from ever activating — it looks like "the page won't scroll". Every view
  container sets `min-height:0` explicitly.
- **Time-scale syncing between charts must be a star topology**, never pairwise — an empty
  sub-chart feeds back an enormous negative range and squashes the main candles into a line.
- **Unused series in a sub-chart must be `setData([])`, not merely `visible:false`** — hidden
  series still participate in time-scale computation, and stale data in them misaligns the
  sub-chart against the main chart.
- **Overlaying another instrument merges its timestamps into the main time scale** (very
  visible with instruments that have different night sessions). Forward-fill onto the main
  instrument's time grid first, or the same logical index points at different bars in the main
  and sub charts.
- **A comparison overlay must share one price scale with the main series.** With separate
  scales, even setting both to percentage mode normalizes each independently with its own
  margins — the pixel positions still aren't comparable.
- **`coordinateToTime` returns null past the last bar**, so drawing into the future requires
  extrapolating via logical coordinates instead.
- **aiohttp's `add_static` sends no `Cache-Control`**, so browsers heuristically cache JS while
  re-fetching HTML every time; the resulting new-HTML-plus-old-JS mix takes the whole frontend
  down. Assets are stamped with the file mtime here.
- **aiohttp's `FileResponse` auto-serves a sibling `.gz` without comparing mtimes** — if you
  only precompress at startup, any file edited while the server runs is served stale forever.
  And browsers always send `Accept-Encoding: gzip` while curl does not by default, so
  "I verified with curl that the new code is being served" will fool you.

---

## Third-party components

| Component | Version | Source | License |
|---|---|---|---|
| TradingView Lightweight Charts™ | 4.2.3 | <https://github.com/tradingview/lightweight-charts> | Apache-2.0 |

`market_wall/static/lightweight-charts.js` is the unmodified upstream artifact.
License text in [licenses/Apache-2.0.txt](licenses/Apache-2.0.txt); attribution in [NOTICE](NOTICE).

## License

The **original code** in this repository is licensed under [AGPL-3.0](LICENSE).

If you modify it and offer a service based on it (including SaaS), you must open-source your
modifications. Personal and internal use is unaffected.

Third-party components are licensed under their own terms and are not covered by this
statement — see "Third-party components" above and [NOTICE](NOTICE).

---

## Disclaimer

This project is a market analysis and monitoring tool and **does not constitute investment
advice**. Every indicator, pricing model, and statistical convention may contain errors —
verify before relying on any of them. The author accepts no responsibility for trading losses
arising from use of this software.

Futures and options are highly leveraged and **can lose more than your principal**.

**No warranty**: this software is provided "as is", without warranty of any kind, express or
implied, including but not limited to merchantability and fitness for a particular purpose.
The author makes no guarantee as to correctness, availability, or timeliness.
(Corresponding to AGPL-3.0 sections 15 and 16.)

**No affiliation**: this is an independent third-party tool with **no affiliation, sponsorship,
or endorsement** from Shanghai Shinny Information Technology (TqSdk / 天勤量化 / 快期),
Tushare, or TradingView. All names and trademarks belong to their respective owners and are
used here for identification only.

**Compliance**: users are responsible for ensuring their usage complies with local laws and
regulations and with the terms of service of each data provider (including restrictions on
data use and redistribution).
