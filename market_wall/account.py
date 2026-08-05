"""账户监控后端: 多账户资金/持仓/委托快照 + 净值曲线 + 绩效分析

设计约束(重要):
- **只读不下单**。本模块刻意不提供 insert_order / cancel_order / 目标仓位 等任何交易接口,
  也不 import TargetPosTask。理由: 盯盘面板和下单通道混在一条 WS 协议里, 一次前端 bug 或
  一条被重放的消息就可能变成真实报单; 交易入口必须单独走带二次确认的通路。
  未来若要加下单, 请另开模块, 不要在这里开口子。
- TqApi 不是线程安全的, 每个 TqApi 必须独占一个线程。本模块自带一个长驻线程 + 一个独立
  TqApi(用 TqMultiAccount 挂多个账户), 不复用 server.py 的采集线程 / heavy_worker。
  TqApi 冷启动实测 38.9s, 所以线程长驻, 绝不按请求建连。
- 所有对外查询方法(list_accounts/snapshot_json/nav/trades/orders)都从**本线程预先算好的缓存**
  里读, 绝不让事件循环线程去碰 TqApi 的对象树 —— 那等于跨线程读一个正在被改的字典。
- 密码只在构造 TqAccount 的那一行出现: 不进日志, 不进返回值, 不进异常字符串(_scrub 兜底),
  返回给前端的账号一律打码只留后 4 位。

数据文件(全部落在 data_dir 下, 不硬编码源码目录):
- accounts.json      账户配置, 不存在时用默认单账户 sim 并生成一份模板
- nav/<id>.jsonl     净值序列, 每行 [ts_sec, balance, available, margin, float_profit, risk_ratio]

对外接口:
    hub = AccountHub(auth_user, auth_pass, data_dir)
    hub.start() / hub.stop()
    hub.list_accounts()      -> [{id, kind, name, acct, ok, err, ...}]
    hub.snapshot_json()      -> str, 直接拼进 data 帧的 "acct" 字段
    hub.nav(id, days)        -> {"type":"acct_nav", id, points, stats}
    hub.trades(id, limit)    -> {"type":"acct_trades", id, cols, rows}
    hub.orders(id)           -> {"type":"acct_orders", id, cols, rows}

自测: python market_wall/account.py  (纯离线, 不连 TqSdk)
"""
import json
import math
import os
import statistics
import threading
import time
import traceback
from pathlib import Path

# tqsdk 只在真正启动线程时才需要。import 失败不能让整个模块不可用 ——
# nav_stats / NavStore 这些纯计算部分要能离线单测, server.py 也要能在缺 tqsdk 时降级。
try:
    from tqsdk import TqApi, TqAuth, TqSim, TqKq, TqKqStock, TqAccount, TqMultiAccount
    TQ_OK = True
    TQ_ERR = ""
except Exception as _e:                                    # noqa: BLE001
    TQ_OK = False
    TQ_ERR = str(_e)

# ---------------- 可调参数 ----------------

POLL_GAP = 0.3            # wait_update 的最长等待: 决定快照新鲜度与线程空转开销的平衡
TABLE_GAP = 1.0           # 成交/委托表重建间隔。委托状态会变而条数不变, 所以必须定时重建
SNAP_GAP = 0.25           # 快照重序列化下限间隔, 防止行情密集时空转打 CPU
RECONNECT_WAIT = 15.0     # 整条 TqApi 断了之后的重连间隔
QUOTE_PER_ROUND = 1       # 每轮最多新订阅 1 个持仓合约的行情(每条订阅会阻塞本线程 1~2s)

NAV_MIN_GAP = 30.0        # 净值最小采样间隔: 至少每 30s 一条
NAV_JUMP_REL = 5e-4       # 权益相对变化超过 5bp 立刻补一条, 否则大波动会被 30s 采样抹平
NAV_JUMP_GAP = 2.0        # 但补点之间也要留 2s, 免得剧烈波动时刷出上千行
NAV_MAX_ROWS = 60000      # 单账户净值文件行数上限, 超了触发压缩
NAV_THIN_AGE = 7 * 86400  # 超过 7 天的老数据允许稀释
NAV_THIN_GAP = 300.0      # 稀释到 5 分钟一条(保留每桶最后一条, 这样每日收盘那条一定还在)
NAV_MAX_POINTS = 4000     # 单次返回给前端的点数上限, 再多前端画不出差别只会卡

ANN_DAYS = 252            # 年化交易日数; 无风险利率取 0

DEFAULT_ACCOUNTS = [{"id": "sim", "kind": "sim", "init_balance": 1000000}]

# 期货账户 21 个字段, 顺序固定(前端按名取值, 顺序只影响可读性)
ACCT_FIELDS = (
    "balance", "available", "static_balance", "pre_balance", "float_profit",
    "position_profit", "close_profit", "margin", "frozen_margin", "commission",
    "frozen_commission", "premium", "frozen_premium", "risk_ratio", "market_value",
    "deposit", "withdraw", "ctp_balance", "ctp_available", "currency",
)

TRADE_COLS = ("trade_date_time", "symbol", "direction", "offset", "price",
              "volume", "trade_id", "order_id")
ORDER_COLS = ("insert_date_time", "symbol", "direction", "offset", "price_type",
              "limit_price", "volume_orign", "volume_left", "trade_price",
              "status", "last_msg", "order_id")


# ---------------- 小工具 ----------------

def _f(v):
    """取有限浮点, 否则 None。TqSdk 未就绪的字段全是 nan, 直接 json.dumps 会产出非法 JSON"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _r(v, nd=2):
    f = _f(v)
    return None if f is None else round(f, nd)


def _i(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def _ns2s(v):
    """TqSdk 的 trade_date_time / insert_date_time 是纳秒整数, 协议要求输出秒"""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return round(n / 1e9, 3) if n > 0 else None


def _mask(acc_id):
    """账号打码只留后 4 位。这个值会进 WS 帧, 所以必须在源头就打码"""
    s = str(acc_id or "")
    return ("*" * max(0, len(s) - 4)) + s[-4:] if len(s) > 4 else ("*" * len(s))


def _day_key(ts):
    """按自然日归并(不是交易日): 夜盘会被算进当天而非下一交易日, 对绩效统计影响可忽略"""
    lt = time.localtime(ts)
    return (lt.tm_year, lt.tm_mon, lt.tm_mday)


# ---------------- 绩效分析(纯函数, 可离线单测) ----------------

def nav_stats(points):
    """由净值序列算绩效指标。points: [[ts, balance, available, margin, float_profit, risk_ratio], ...]

    口径(与前端展示一一对应, 改这里要同步改前端说明):
    - ret      = 末 balance / 首 balance - 1(区间总收益, 不年化)
    - 日频归并: 每个自然日取当日最后一条 balance 作为该日收盘净值;
      第一天的收益以整段序列的第一条样本为基准(即第一天是个不完整日, 这是有意的),
      于是日收益条数 == 自然日天数, 各日收益连乘正好等于 1+ret。
    - vol_ann  = 日收益样本标准差(ddof=1) * sqrt(252)
    - sharpe   = 日收益均值 / 日收益样本标准差 * sqrt(252), 无风险利率 0
    - ret_ann  = (1+ret) ** (252/天数) - 1
    - mdd      = 用 balance 的历史峰值算最大回撤(正数, 0.25 表示回撤 25%),
      mdd_start/mdd_end 分别是造成该回撤的峰值时刻与谷底时刻
    - calmar   = ret_ann / mdd
    - cur_dd   = 1 - 末 balance / 全程峰值
    样本不足时相关字段返回 None 而不是 0: 前端显示 "—", 给 0 会被误读成"真的没波动"。
    需要 >= 2 个自然日才有的: vol_ann / sharpe / ret_ann / calmar。
    """
    out = {"days": 0, "ret": None, "ret_ann": None, "mdd": None, "mdd_start": None,
           "mdd_end": None, "sharpe": None, "calmar": None, "vol_ann": None,
           "win_days": None, "lose_days": None, "best_day": None, "worst_day": None,
           "cur_dd": None, "peak": None, "samples": 0}

    # 清洗: 时间和权益都必须是有限数, 且权益 > 0(权益 <= 0 的账户算收益率没有意义)
    rows = []
    for p in points or []:
        try:
            ts, bal = _f(p[0]), _f(p[1])
        except (TypeError, IndexError):
            continue
        if ts is None or bal is None or bal <= 0:
            continue
        rows.append((ts, bal))
    if not rows:
        return out
    rows.sort(key=lambda x: x[0])
    out["samples"] = len(rows)

    first, last = rows[0][1], rows[-1][1]
    out["ret"] = last / first - 1.0

    # ---- 最大回撤: 逐点跟踪历史峰值 ----
    peak, peak_ts = rows[0][1], rows[0][0]
    mdd, mdd_start, mdd_end = 0.0, None, None
    for ts, bal in rows:
        if bal > peak:
            peak, peak_ts = bal, ts
        dd = 1.0 - bal / peak
        if dd > mdd:
            mdd, mdd_start, mdd_end = dd, peak_ts, ts
    out["mdd"] = mdd
    out["mdd_start"] = mdd_start        # mdd==0(单调上涨)时保持 None, 前端不画区间
    out["mdd_end"] = mdd_end
    out["peak"] = peak
    out["cur_dd"] = 1.0 - last / peak

    # ---- 日频归并 ----
    closes = {}                          # dict 有序: 首次出现的顺序即时间顺序
    for ts, bal in rows:
        closes[_day_key(ts)] = bal
    daily = list(closes.values())
    out["days"] = len(daily)

    rets, prev = [], first
    for c in daily:
        if prev > 0:
            rets.append(c / prev - 1.0)
        prev = c
    if rets:
        out["win_days"] = sum(1 for r in rets if r > 0)
        out["lose_days"] = sum(1 for r in rets if r < 0)
        out["best_day"] = max(rets)
        out["worst_day"] = min(rets)

    if len(rets) < 2:                    # 不足 2 个自然日: 日频统计量无意义
        return out

    sd = statistics.stdev(rets)          # 样本标准差(ddof=1)
    mean = statistics.fmean(rets)
    out["vol_ann"] = sd * math.sqrt(ANN_DAYS)
    if sd > 0:
        out["sharpe"] = mean / sd * math.sqrt(ANN_DAYS)
    try:
        base = 1.0 + out["ret"]
        if base > 0:
            out["ret_ann"] = base ** (ANN_DAYS / out["days"]) - 1.0
    except (OverflowError, ValueError):  # 极短样本 + 大涨幅会把指数算爆
        out["ret_ann"] = None
    if out["ret_ann"] is not None and mdd > 0:
        out["calmar"] = out["ret_ann"] / mdd
    return out


# ---------------- 净值落盘 ----------------

class NavStore:
    """单账户净值序列: 内存 list + jsonl 追加落盘, 带上限压缩

    为什么用 jsonl 而不是一整个 json: 采样是每 30s 追加一行, 整文件重写会在几十万行时
    变成每半分钟一次的几百 ms 阻塞; jsonl 追加是 O(1) 且崩溃只会丢/坏最后一行。
    """

    def __init__(self, path):
        self.path = Path(path)
        self.rows = []          # [[ts, bal, avail, margin, fp, rr], ...] 时间升序
        self.bad_lines = 0
        self._lock = threading.Lock()
        self._last_ts = 0.0
        self._last_bal = None

    def load(self):
        """启动时读回历史。单行坏了只跳过那一行 —— 断电/磁盘满留下的半行不能让整个面板挂掉"""
        if not self.path.exists():
            return
        rows = []
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        v = json.loads(line)
                        ts, bal = float(v[0]), float(v[1])
                        if not (math.isfinite(ts) and math.isfinite(bal)):
                            raise ValueError("nan")
                    except Exception:       # noqa: BLE001  坏行/半行/非数组, 一律跳过
                        self.bad_lines += 1
                        continue
                    rows.append([ts, bal] + [_f(x) for x in list(v[2:6]) + [None] * 6][:4])
        except OSError as e:
            print(f"[acct] 读净值 {self.path.name} 失败: {e}", flush=True)
            return
        rows.sort(key=lambda r: r[0])
        if len(rows) > NAV_MAX_ROWS:        # 历史文件本来就超标, 先在内存里截断, 稍后压缩
            rows = rows[-NAV_MAX_ROWS:]
        with self._lock:
            self.rows = rows
        if rows:
            self._last_ts, self._last_bal = rows[-1][0], rows[-1][1]
        if self.bad_lines:
            print(f"[acct] 净值 {self.path.name} 跳过 {self.bad_lines} 条坏行", flush=True)

    def maybe_append(self, ts, bal, avail, margin, fp, rr):
        """按采样策略决定要不要落一条。返回是否真的写了"""
        bal = _f(bal)
        if bal is None or bal <= 0:         # 账户还没就绪(全是 nan), 不能污染序列
            return False
        gap = ts - self._last_ts
        if self._last_bal is None:
            pass                            # 第一条无条件写
        elif gap >= NAV_MIN_GAP:
            pass
        elif gap >= NAV_JUMP_GAP and abs(bal - self._last_bal) > abs(self._last_bal) * NAV_JUMP_REL:
            pass                            # 权益跳变: 补一条, 否则 30s 采样会把尖峰抹平
        else:
            return False

        row = [round(ts, 1), round(bal, 2), _r(avail), _r(margin), _r(fp), _r(rr, 6)]
        self._last_ts, self._last_bal = ts, bal
        with self._lock:
            self.rows.append(row)
            need_compact = len(self.rows) > NAV_MAX_ROWS
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row) + "\n")
        except OSError as e:
            print(f"[acct] 写净值 {self.path.name} 失败: {e}", flush=True)
        if need_compact:
            self.compact()
        return True

    def compact(self):
        """上限管理: 老数据稀释到 5 分钟一条, 还超就丢最老的。整文件原子重写"""
        now = time.time()
        with self._lock:
            rows = list(self.rows)
        cut = now - NAV_THIN_AGE
        thin, recent = {}, []
        for r in rows:
            if r[0] < cut:
                # 每个 5 分钟桶保留**最后**一条: 这样每天最后一条(当日收盘净值)一定被保留,
                # 日频归并的结果不会因为压缩而变形
                thin[int(r[0] // NAV_THIN_GAP)] = r
            else:
                recent.append(r)
        out = list(thin.values()) + recent
        if len(out) > NAV_MAX_ROWS:
            out = out[-NAV_MAX_ROWS:]
        tmp = self.path.with_suffix(".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                for r in out:
                    fh.write(json.dumps(r) + "\n")
            os.replace(tmp, self.path)      # 原子替换, 中途崩溃也不会留下半个文件
        except OSError as e:
            print(f"[acct] 压缩净值 {self.path.name} 失败: {e}", flush=True)
            return
        with self._lock:
            self.rows = out
        print(f"[acct] 净值 {self.path.name} 压缩 {len(rows)} -> {len(out)} 行", flush=True)

    def slice(self, days=None):
        with self._lock:
            rows = list(self.rows)
        if days and days > 0:
            cut = time.time() - days * 86400
            rows = [r for r in rows if r[0] >= cut]
        return rows


def _downsample(rows, stats, limit=NAV_MAX_POINTS):
    """点数超限时按步长抽稀, 但强制保留首/尾/回撤起止 —— 否则前端画出来的回撤区间对不上 stats"""
    if len(rows) <= limit:
        return rows
    keep_ts = {rows[0][0], rows[-1][0]}
    for k in ("mdd_start", "mdd_end"):
        if stats.get(k) is not None:
            keep_ts.add(stats[k])
    step = max(2, math.ceil(len(rows) / limit))
    return [r for i, r in enumerate(rows) if i % step == 0 or r[0] in keep_ts]


# ---------------- 账户配置 ----------------

class _AcctRec:
    """一个账户的配置 + 运行态。密码只存在 self._pwd, 任何序列化路径都不碰它"""

    def __init__(self, cfg, idx):
        self.id = str(cfg.get("id") or f"acc{idx}")
        self.kind = str(cfg.get("kind") or "sim").lower()
        self.name = str(cfg.get("name") or self.id)
        self.init_balance = _f(cfg.get("init_balance")) or 1000000.0
        self.broker_id = str(cfg.get("broker_id") or "")
        self.account_id = str(cfg.get("account_id") or "")
        self.number = cfg.get("number")
        self._pwd = str(cfg.get("password") or "")
        self.ok = False
        self.err = ""
        self.tq = None          # TqSim/TqKq/... 实例
        self.stock = self.kind in ("kqstock",)

    def info(self):
        return {"id": self.id, "kind": self.kind, "name": self.name,
                "acct": _mask(self.account_id) if self.account_id else "",
                "broker": self.broker_id, "ok": self.ok, "err": self.err,
                "init_balance": self.init_balance if self.kind == "sim" else None,
                "stock": self.stock}


def load_accounts(data_dir):
    """读 accounts.json; 不存在则用默认并写一份模板出去(方便用户照着改)"""
    path = Path(data_dir) / "accounts.json"
    cfgs = None
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            cfgs = raw.get("accounts") if isinstance(raw, dict) else raw
            if not isinstance(cfgs, list):
                raise ValueError("accounts.json 应为数组或 {\"accounts\":[...]}")
        except Exception as e:                              # noqa: BLE001
            print(f"[acct] accounts.json 解析失败, 回退默认: {e}", flush=True)
            cfgs = None
    if cfgs is None:
        cfgs = [dict(c) for c in DEFAULT_ACCOUNTS]
        if not path.exists():
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(cfgs, ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError:
                pass
    recs, seen = [], set()
    for i, c in enumerate(cfgs):
        if not isinstance(c, dict):
            continue
        r = _AcctRec(c, i)
        if r.id in seen:                    # id 是前端的主键, 重复会让两个账户互相覆盖
            r.err = "id 重复, 已忽略"
            print(f"[acct] 账户 id 重复: {r.id}", flush=True)
            continue
        seen.add(r.id)
        recs.append(r)
    return recs or [_AcctRec(dict(DEFAULT_ACCOUNTS[0]), 0)]


# ---------------- AccountHub ----------------

class AccountHub:
    """长驻线程 + 独立 TqApi, 用 TqMultiAccount 同时盯多个账户。只读, 不下单。"""

    def __init__(self, auth_user, auth_pass, data_dir=None):
        self.user = auth_user
        self._pwd = auth_pass
        base = data_dir or os.environ.get("MW_DATA") or Path(__file__).parent
        self.data_dir = Path(base)
        self.nav_dir = self.data_dir / "nav"
        self.recs = []                      # [_AcctRec]
        self.snap = {}                      # id -> {"sum":{}, "pos":[], "nord":n}
        self.navs = {}                      # id -> NavStore
        self._tables = {}                   # id -> {"trades":{cols,rows}, "orders":{...}}
        self._snap_json = "{}"
        self._lock = threading.Lock()       # 保护 snap / _snap_json / _tables / recs 的读侧
        self._stop = threading.Event()
        self._th = None
        self.conn_err = ""                  # 整条 TqApi 的连接错误(区别于单账户错误)

    # ---- 生命周期 ----

    def start(self):
        if self._th and self._th.is_alive():
            return
        self._stop.clear()
        self.nav_dir.mkdir(parents=True, exist_ok=True)
        self._th = threading.Thread(target=self._run, daemon=True, name="acct")
        self._th.start()

    def stop(self):
        self._stop.set()
        if self._th:
            self._th.join(timeout=10)       # TqApi.close() 在本线程内做, 这里只等它退出

    # ---- 对外查询(全部读缓存, 不碰 TqApi) ----

    def list_accounts(self):
        with self._lock:
            recs = list(self.recs)
        items = [r.info() for r in recs]
        if self.conn_err:
            for it in items:                # 整条连接断了: 每个账户都标不可用, 免得前端显示假的绿灯
                if not it["err"]:
                    it["err"] = self.conn_err
                it["ok"] = False
        return items

    def snapshot_json(self):
        """预序列化好的 {id:{sum,pos,nord}}; broadcaster 只做字符串拼接"""
        with self._lock:
            return self._snap_json

    def nav(self, acct_id, days=None):
        store = self.navs.get(acct_id)
        rows = store.slice(days) if store else []
        st = nav_stats(rows)                # 统计用全量点算, 保证 mdd 准确
        pts = _downsample(rows, st)         # 传输用抽稀点
        return {"type": "acct_nav", "id": acct_id, "points": pts, "stats": st}

    def trades(self, acct_id, limit=200):
        t = self._table(acct_id, "trades")
        rows = t["rows"][:max(1, int(limit or 200))]
        return {"type": "acct_trades", "id": acct_id, "cols": t["cols"], "rows": rows}

    def orders(self, acct_id):
        t = self._table(acct_id, "orders")
        return {"type": "acct_orders", "id": acct_id, "cols": t["cols"], "rows": t["rows"]}

    def _table(self, acct_id, key):
        with self._lock:
            t = (self._tables.get(acct_id) or {}).get(key)
        cols = list(TRADE_COLS if key == "trades" else ORDER_COLS)
        return t or {"cols": cols, "rows": []}

    # ---- 内部: 账户实例构造 ----

    def _scrub(self, text):
        """异常字符串里可能夹带账号密码(某些柜台会把登录包回显), 统一抹掉再往外走"""
        s = str(text)
        for pw in [self._pwd] + [r._pwd for r in self.recs]:
            if pw and len(pw) >= 3:
                s = s.replace(pw, "***")
        return s[:400]

    def _make(self, rec):
        """构造单个账户实例。失败只影响自己 —— 记 err 并跳过, 不能拖垮其他账户"""
        if rec.kind == "sim":
            return TqSim(init_balance=rec.init_balance, account_id=rec.account_id or rec.id)
        if rec.kind == "kq":
            return TqKq(number=rec.number) if rec.number else TqKq()
        if rec.kind == "kqstock":
            return TqKqStock(number=rec.number) if rec.number else TqKqStock()
        if rec.kind == "real":
            if not (rec.broker_id and rec.account_id and rec._pwd):
                raise ValueError("实盘账户需要 broker_id / account_id / password")
            return TqAccount(rec.broker_id, rec.account_id, rec._pwd)
        raise ValueError(f"未知账户类型 {rec.kind}")

    def _open_api(self, recs):
        """建 TqApi。整条连接是一体的: 某个实盘账户登录失败会让 TqApi 构造直接抛异常,
        此时按错误信息定位到具体账户(定位不到就丢最后一个远程账户), 摘掉它重试,
        这样一个坏账户不会导致所有账户都看不到。最多重试 len(recs) 次。
        """
        live = [r for r in recs if r.tq is not None]
        for _ in range(len(live) + 1):
            if not live:
                return None, []
            try:
                api = TqApi(TqMultiAccount([r.tq for r in live]),
                            auth=TqAuth(self.user, self._pwd))
                for r in live:
                    r.ok, r.err = True, ""
                return api, live
            except Exception as e:                          # noqa: BLE001
                msg = self._scrub(e)
                victim = None
                for r in live:                              # 错误里通常带账号或期货公司名
                    if r.account_id and r.account_id in str(e):
                        victim = r
                        break
                if victim is None:
                    remote = [r for r in live if r.kind != "sim"]
                    victim = remote[-1] if remote else live[-1]
                victim.ok, victim.err = False, msg
                victim.tq = None
                print(f"[acct] 账户 {victim.id} 接入失败, 已摘除: {msg}", flush=True)
                live = [r for r in live if r is not victim]
        return None, []

    # ---- 内部: 快照组装 ----

    def _sum_of(self, obj, stock):
        """账户资金字段。股票账户字段名与期货不同, 统一补出 balance/margin/risk_ratio 三个
        前端必用的键, 让前端不必区分账户类型"""
        d = {}
        for k in (obj.keys() if hasattr(obj, "keys") else ()):
            if k.startswith("_"):
                continue
            v = getattr(obj, k, None)
            d[k] = v if isinstance(v, str) else _f(v)
        if stock:
            d.setdefault("balance", _f(getattr(obj, "asset", None)))
            d.setdefault("float_profit", _f(getattr(obj, "float_profit_today", None)))
            d.setdefault("margin", 0.0)
            d.setdefault("risk_ratio", None)
        for f in ACCT_FIELDS:               # 缺的字段补 None, 前端就不用做 in 判断
            d.setdefault(f, None)
        return d

    def _pos_of(self, sym, p, stock, get_price):
        """挑盯盘真正要用的持仓字段, 并补最新价与浮盈比例(TqSdk 的 Position 不带最新价)"""
        if stock:
            vol = _i(getattr(p, "volume", 0))
            if vol == 0:
                return None
            cost = _f(getattr(p, "cost", None)) or 0.0
            last = _f(getattr(p, "last_price", None))
            fp = _f(getattr(p, "float_profit_today", None))
            return {
                "symbol": sym, "pos": vol, "pos_long": vol, "pos_short": 0,
                "pos_long_today": _i(getattr(p, "buy_volume_today", 0)), "pos_short_today": 0,
                "open_price_long": _r(cost / vol, 4) if vol else None, "open_price_short": None,
                "position_price_long": None, "position_price_short": None,
                "float_profit": _r(fp), "position_profit": _r(getattr(p, "real_profit_today", None)),
                "margin": 0.0, "market_value": _r(getattr(p, "market_value", None)),
                "last_price": last,
                "float_profit_r": _r(fp / cost, 6) if (fp is not None and cost > 0) else None,
            }
        pl, ps = _i(getattr(p, "pos_long", 0)), _i(getattr(p, "pos_short", 0))
        if pl == 0 and ps == 0:             # 服务器会保留当日已平仓的空持仓记录, 必须滤掉
            return None
        fp = _f(getattr(p, "float_profit", None))
        cost = abs(_f(getattr(p, "open_cost_long", None)) or 0.0) + \
            abs(_f(getattr(p, "open_cost_short", None)) or 0.0)
        return {
            "symbol": sym, "pos": _i(getattr(p, "pos", 0)), "pos_long": pl, "pos_short": ps,
            "pos_long_today": _i(getattr(p, "pos_long_today", 0)),
            "pos_short_today": _i(getattr(p, "pos_short_today", 0)),
            "open_price_long": _r(getattr(p, "open_price_long", None), 4),
            "open_price_short": _r(getattr(p, "open_price_short", None), 4),
            "position_price_long": _r(getattr(p, "position_price_long", None), 4),
            "position_price_short": _r(getattr(p, "position_price_short", None), 4),
            "float_profit": _r(fp), "position_profit": _r(getattr(p, "position_profit", None)),
            "margin": _r(getattr(p, "margin", None)),
            "market_value": _r(getattr(p, "market_value", None)),
            "last_price": get_price(sym),
            # 浮盈比例口径: 相对**开仓名义市值**(开仓价*手数*乘数), 不是相对保证金。
            # 保证金口径杠杆倍数差异太大, 跨品种没法横向比。
            "float_profit_r": _r(fp / cost, 6) if (fp is not None and cost > 0) else None,
        }

    # ---- 线程主体 ----

    def _run(self):
        if not TQ_OK:
            self.conn_err = f"tqsdk 不可用: {TQ_ERR}"
            print(f"[acct] {self.conn_err}", flush=True)
            return
        while not self._stop.is_set():
            api = None
            try:
                recs = load_accounts(self.data_dir)
                for r in recs:              # 逐个构造, 失败的记 err 跳过
                    try:
                        r.tq = self._make(r)
                    except Exception as e:                  # noqa: BLE001
                        r.tq, r.ok, r.err = None, False, self._scrub(e)
                        print(f"[acct] 账户 {r.id} 初始化失败: {r.err}", flush=True)
                for r in recs:
                    store = self.navs.get(r.id)
                    if store is None:
                        store = NavStore(self.nav_dir / f"{r.id}.jsonl")
                        store.load()
                        self.navs[r.id] = store
                with self._lock:
                    self.recs = recs
                api, live = self._open_api(recs)
                if api is None:
                    raise RuntimeError("所有账户均不可用, 见各账户 err")
                self.conn_err = ""
                print(f"[acct] 已连接, 账户 {[r.id for r in live]}", flush=True)
                self._loop(api, live)
            except Exception as e:                          # noqa: BLE001
                self.conn_err = self._scrub(e)
                print(f"[acct] 线程异常: {self.conn_err}", flush=True)
                traceback.print_exc()
            finally:
                if api is not None:
                    try:
                        api.close()
                    except Exception:                       # noqa: BLE001
                        pass
            if self._stop.is_set():
                break
            self._stop.wait(RECONNECT_WAIT)                 # 可被 stop() 立刻打断的 sleep

    def _loop(self, api, live):
        objs = {}
        for r in live:
            objs[r.id] = {
                "acc": api.get_account(account=r.tq),
                "pos": api.get_position(account=r.tq),
                "ord": api.get_order(account=r.tq),
                "trd": api.get_trade(account=r.tq),
                "rec": r,
            }
        quotes = {}                 # symbol -> quote 对象; 只为持仓合约取最新价
        pending = []                # 待订阅队列: 每轮只订一个, 订阅会阻塞本线程 1~2s
        t_snap = t_tab = 0.0

        while not self._stop.is_set():
            api.wait_update(deadline=time.time() + POLL_GAP)
            now = time.time()

            for _ in range(QUOTE_PER_ROUND):
                if not pending:
                    break
                sym = pending.pop(0)
                if sym in quotes:
                    continue
                try:
                    quotes[sym] = api.get_quote(sym)
                except Exception as e:                      # noqa: BLE001
                    quotes[sym] = None                      # 记 None 免得每轮重试同一个坏合约
                    print(f"[acct] 订阅持仓合约 {sym} 失败: {e}", flush=True)

            def price(sym):
                q = quotes.get(sym)
                if q is None:
                    if sym not in quotes and sym not in pending:
                        pending.append(sym)
                    return None
                return _r(getattr(q, "last_price", None), 4)

            if now - t_snap >= SNAP_GAP:
                t_snap = now
                self._build_snap(objs, price, now)
            if now - t_tab >= TABLE_GAP:
                t_tab = now
                self._build_tables(objs)

    def _build_snap(self, objs, price, now):
        snap = {}
        for aid, o in objs.items():
            rec = o["rec"]
            s = self._sum_of(o["acc"], rec.stock)
            pos = []
            try:
                items = list(o["pos"].items())
            except Exception:                               # noqa: BLE001
                items = []
            for sym, p in items:
                if str(sym).startswith("_"):
                    continue
                try:
                    d = self._pos_of(sym, p, rec.stock, price)
                except Exception:                           # noqa: BLE001
                    d = None
                if d:
                    pos.append(d)
            pos.sort(key=lambda d: -abs(_f(d.get("margin")) or _f(d.get("market_value")) or 0.0))
            nord = 0
            try:
                for oid, od in o["ord"].items():
                    if not str(oid).startswith("_") and getattr(od, "status", "") == "ALIVE":
                        nord += 1
            except Exception:                               # noqa: BLE001
                pass
            snap[aid] = {"sum": s, "pos": pos, "nord": nord}
            store = self.navs.get(aid)
            if store is not None:
                store.maybe_append(now, s.get("balance"), s.get("available"),
                                   s.get("margin"), s.get("float_profit"), s.get("risk_ratio"))
        js = json.dumps(snap, ensure_ascii=False)
        with self._lock:
            self.snap = snap
            self._snap_json = js

    def _build_tables(self, objs):
        """成交/委托表在本线程里就地拍平成 cols/rows, 事件循环线程只读结果。
        委托状态会在条数不变的情况下改变, 所以必须整表定时重建而不是靠条数判脏。"""
        tabs = {}
        for aid, o in objs.items():
            trows = []
            try:
                for tid, t in o["trd"].items():
                    if str(tid).startswith("_"):
                        continue
                    trows.append([
                        _ns2s(getattr(t, "trade_date_time", 0)),
                        f"{getattr(t, 'exchange_id', '')}.{getattr(t, 'instrument_id', '')}",
                        getattr(t, "direction", ""), getattr(t, "offset", ""),
                        _r(getattr(t, "price", None), 4), _i(getattr(t, "volume", 0)),
                        str(tid), str(getattr(t, "order_id", "")),
                    ])
            except Exception:                               # noqa: BLE001
                pass
            trows.sort(key=lambda r: r[0] or 0, reverse=True)   # 时间倒序: 最近的在最前
            orows = []
            try:
                for oid, od in o["ord"].items():
                    if str(oid).startswith("_"):
                        continue
                    orows.append([
                        _ns2s(getattr(od, "insert_date_time", 0)),
                        f"{getattr(od, 'exchange_id', '')}.{getattr(od, 'instrument_id', '')}",
                        getattr(od, "direction", ""), getattr(od, "offset", ""),
                        getattr(od, "price_type", ""), _r(getattr(od, "limit_price", None), 4),
                        _i(getattr(od, "volume_orign", 0)), _i(getattr(od, "volume_left", 0)),
                        _r(getattr(od, "trade_price", None), 4), getattr(od, "status", ""),
                        str(getattr(od, "last_msg", ""))[:120], str(oid),
                    ])
            except Exception:                               # noqa: BLE001
                pass
            orows.sort(key=lambda r: r[0] or 0, reverse=True)
            tabs[aid] = {"trades": {"cols": list(TRADE_COLS), "rows": trows},
                         "orders": {"cols": list(ORDER_COLS), "rows": orows}}
        with self._lock:
            self._tables = tabs


# ---------------- 离线自测(不连 TqSdk) ----------------

def _selftest():
    ok = True

    def chk(name, got, want, tol=1e-9):
        nonlocal ok
        good = (got is None and want is None) or (
            got is not None and want is not None and abs(got - want) <= tol)
        print(f"  {'PASS' if good else 'FAIL'} {name}: got={got!r} want={want!r}")
        ok = ok and good

    # --- 用例 1: 每天一条, 手算全部指标 ---
    # 净值 1000 -> 1200 -> 900 -> 1080
    # ret = 1080/1000-1 = 0.08
    # 峰值 1200, 谷底 900 -> mdd = 1-900/1200 = 0.25, cur_dd = 1-1080/1200 = 0.10
    # 日收益(第一天以首样本 1000 为基准) = [0, +0.2, -0.25, +0.2]
    base = time.mktime((2026, 1, 5, 15, 0, 0, 0, 0, -1))     # 周一 15:00 本地时间
    bals = [1000.0, 1200.0, 900.0, 1080.0]
    pts = [[base + i * 86400, b, b, 0.0, 0.0, 0.0] for i, b in enumerate(bals)]
    st = nav_stats(pts)
    print("[用例1] 每日一条 1000/1200/900/1080")
    chk("ret", st["ret"], 0.08, 1e-12)
    chk("mdd", st["mdd"], 0.25, 1e-12)
    chk("mdd_start", st["mdd_start"], base + 86400)
    chk("mdd_end", st["mdd_end"], base + 2 * 86400)
    chk("cur_dd", st["cur_dd"], 0.10, 1e-12)
    chk("peak", st["peak"], 1200.0)
    chk("days", st["days"], 4)
    chk("samples", st["samples"], 4)
    chk("win_days", st["win_days"], 2)
    chk("lose_days", st["lose_days"], 1)
    chk("best_day", st["best_day"], 0.2, 1e-12)
    chk("worst_day", st["worst_day"], -0.25, 1e-12)
    rets = [0.0, 0.2, -0.25, 0.2]
    sd = statistics.stdev(rets)                              # 手算 = sqrt(0.136875/3) = 0.2136001
    chk("stdev(手算核对)", sd, math.sqrt(0.136875 / 3), 1e-12)
    chk("vol_ann", st["vol_ann"], sd * math.sqrt(252), 1e-12)
    chk("sharpe", st["sharpe"], statistics.fmean(rets) / sd * math.sqrt(252), 1e-12)
    chk("ret_ann", st["ret_ann"], 1.08 ** (252 / 4) - 1, 1e-6)
    chk("calmar", st["calmar"], (1.08 ** (252 / 4) - 1) / 0.25, 1e-6)
    # 各日收益连乘必须等于 1+ret(口径自洽性)
    prod = 1.0
    for r in rets:
        prod *= (1 + r)
    chk("连乘==1+ret", prod, 1 + st["ret"], 1e-12)

    # --- 用例 2: 同一天内多条(日频样本不足) ---
    print("[用例2] 单日 5 条: 日频统计量必须是 None 而不是 0")
    intra = [[base + i * 600, b, b, 0, 0, 0]
             for i, b in enumerate([1000.0, 1050.0, 900.0, 950.0, 990.0])]
    st2 = nav_stats(intra)
    chk("days", st2["days"], 1)
    chk("ret", st2["ret"], -0.01, 1e-12)
    chk("mdd", st2["mdd"], 1 - 900 / 1050, 1e-12)            # 峰 1050 -> 谷 900
    chk("sharpe", st2["sharpe"], None)
    chk("vol_ann", st2["vol_ann"], None)
    chk("ret_ann", st2["ret_ann"], None)
    chk("calmar", st2["calmar"], None)

    # --- 用例 3: 空 / 全脏输入 ---
    print("[用例3] 空输入与脏数据")
    st3 = nav_stats([])
    chk("空.samples", st3["samples"], 0)
    chk("空.ret", st3["ret"], None)
    st4 = nav_stats([[base, float("nan"), 0, 0, 0, 0], [base + 60, 0.0, 0, 0, 0, 0],
                     [base + 120, 1000.0, 0, 0, 0, 0], [base + 180, 1100.0, 0, 0, 0, 0]])
    chk("脏数据后 samples", st4["samples"], 2)
    chk("脏数据后 ret", st4["ret"], 0.1, 1e-12)

    # --- 用例 4: 单调上涨 -> mdd=0, calmar 必须 None 而不是 inf ---
    print("[用例4] 单调上涨: mdd=0, calmar=None")
    up = [[base + i * 86400, 1000.0 * (1.01 ** i), 0, 0, 0, 0] for i in range(5)]
    st5 = nav_stats(up)
    chk("mdd", st5["mdd"], 0.0)
    chk("mdd_start", st5["mdd_start"], None)
    chk("calmar", st5["calmar"], None)
    chk("cur_dd", st5["cur_dd"], 0.0)

    # --- 用例 5: NavStore 坏行容错 + 采样 + 压缩 ---
    print("[用例5] NavStore 坏行/采样/压缩")
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "t.jsonl"
        p.write_text('[100.0, 1000.0, 900.0, 0.0, 0.0, 0.0]\n'
                     '这不是json\n'
                     '[200.0, 1010.0]\n'
                     '[bad\n'
                     '[300.0, "x"]\n'
                     '[400.0, 1020.0, 1.0, 2.0, 3.0, 4.0]\n', encoding="utf-8")
        s = NavStore(p)
        s.load()
        chk("好行数", float(len(s.rows)), 3.0)
        chk("坏行数", float(s.bad_lines), 3.0)
        chk("末行权益", s.rows[-1][1], 1020.0)
        t0 = time.time()
        chk("首条必写", float(s.maybe_append(t0, 1000, 1, 2, 3, 0.1)), 1.0)
        chk("1s 后小变化不写", float(s.maybe_append(t0 + 1, 1000.01, 1, 2, 3, 0.1)), 0.0)
        chk("3s 后大跳变补写", float(s.maybe_append(t0 + 3, 1100, 1, 2, 3, 0.1)), 1.0)
        chk("31s 后到点必写", float(s.maybe_append(t0 + 34, 1100, 1, 2, 3, 0.1)), 1.0)
        chk("落盘行数", float(len(p.read_text(encoding="utf-8").strip().splitlines())), 9.0)
        # 压缩: 造 10 天前的密集老数据, 稀释后每 5 分钟最多一条且保留每桶最后一条
        # 起点对齐到 300s 桶边界, 否则 1790s 的跨度会落在 6 或 7 个桶里, 断言会飘
        old = (time.time() - 10 * 86400) // NAV_THIN_GAP * NAV_THIN_GAP
        s.rows = [[old + i * 10.0, 1000.0 + i, 0, 0, 0, 0] for i in range(180)]  # 30 分钟, 10s 一条
        s.compact()
        left = [r for r in s.rows if r[0] < time.time() - NAV_THIN_AGE]
        chk("稀释后老数据条数", float(len(left)), 6.0)                     # 1800s/300s = 6 桶
        chk("保留桶内最后一条", left[0][1], 1000.0 + 29)                   # 第 0 桶最后是 i=29
        chk("压缩后文件行数", float(len(p.read_text(encoding="utf-8").strip().splitlines())),
            float(len(s.rows)))

    # --- 用例 6: 抽稀必须保留回撤起止点 ---
    print("[用例6] 抽稀保留 mdd 起止")
    # 峰/谷故意放在 503 / 907(不是抽稀步长 50 的整数倍), 否则测不出"强制保留"的逻辑
    many = [[base + i * 60.0, 1000.0 + (500 if i == 503 else 0) - (400 if i == 907 else 0), 0, 0, 0, 0]
            for i in range(5000)]
    stm = nav_stats(many)
    ds = _downsample(many, stm, limit=100)
    keep = {r[0] for r in ds}
    chk("点数达标", float(len(ds) <= 200), 1.0)
    chk("含 mdd_start", float(stm["mdd_start"] in keep), 1.0)
    chk("含 mdd_end", float(stm["mdd_end"] in keep), 1.0)
    chk("含首尾", float(many[0][0] in keep and many[-1][0] in keep), 1.0)

    # --- 用例 7: 打码 ---
    print("[用例7] 账号打码")
    print(f"  _mask('88001234') = {_mask('88001234')!r}")
    chk("打码只留后4位", float(_mask("88001234") == "****1234"), 1.0)
    chk("短账号全打码", float(_mask("123") == "***"), 1.0)

    print("\n全部通过" if ok else "\n有失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
