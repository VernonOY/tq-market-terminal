"""Tushare Pro HTTP 适配层 —— 纯标准库, 供 server.py 在独立线程里调用。

设计要点:
- **零第三方依赖**: 不装 tushare 包, 直接 urllib 发 HTTPS POST。只在自测 __main__ 里
  用到 certifi(本机 Python 信任库为空, 见下)。
- **必须缓存**: Tushare 单次往返实测 2~4.7s, 直接同步调用会把 WS 推送线程拖死。
  磁盘缓存放 market_wall/tscache/, 按 (接口 + 参数) 的稳定 hash 分文件, 每类接口
  一套 TTL 策略(见 _ttl_for)。命中磁盘后再进程内 LRU, 二次命中是微秒级。
- **限频**: Tushare 按分钟限次, 令牌桶(默认 200/min)超了就排队, 不是报错。
- **不抛异常**: 所有网络/权限/解析异常都收敛成 {"cols":[],"rows":[],"err":"..."},
  调用方(server.py 的 fund 请求处理)可以直接把 err 转成协议里的 {"type":"err"}。
- **返回列式**: 所有高层 API 统一返回 {"cols":[...], "rows":[[...],...]},
  正好对应 WS 协议的 fund 响应体, server.py 不用再做转换。

⚠️ 本机 Python 的 openssl cert.pem 不存在, 信任库为空, 不设 SSL_CERT_FILE 的话
   这里所有 HTTPS 全部 CERTIFICATE_VERIFY_FAILED。server.py 已在启动时注入,
   独立跑本模块时 __main__ 会自己注入。
"""
import inspect
import hashlib
import json
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict, deque
from datetime import date, datetime, timedelta
from pathlib import Path

API_URL = "https://api.tushare.pro"
BASE = Path(__file__).parent
CACHE_DIR = BASE / "tscache"
ENV_FILE = BASE / "tushare.env"

HTTP_TIMEOUT = 30.0          # 单次请求超时(实测正常 2~4.7s, 留足余量)
HTTP_RETRY = 2               # 网络类错误的重试次数(权限/参数错误不重试)
RATE_PER_MIN = 200           # 令牌桶容量: 每 60s 最多这么多次真实请求
MEM_CACHE_MAX = 256          # 进程内 LRU 条数

# ---------------------------------------------------------------- 接口分类
# 日频: 收盘后当天数据才定型 -> 当日有效; 但如果查询区间整段落在过去, 数据不再变, 长缓存
DAILY_APIS = {
    "daily", "weekly", "adj_factor", "daily_basic", "moneyflow", "top_list",
    "limit_list_d", "margin_detail", "cyq_perf", "stk_factor", "stk_limit",
    "index_daily", "moneyflow_hsgt", "block_trade",
}
# 季频: 历史财报永不变 -> 长缓存; 最近一期可能被修正/补录 -> 短 TTL
QUARTER_APIS = {
    "income", "balancesheet", "cashflow", "fina_indicator", "forecast",
    "top10_holders", "stk_holdernumber", "index_weight",
}
# 静态: 基础信息, 7 天
STATIC_APIS = {"stock_basic", "trade_cal", "namechange", "stock_company"}

TTL_STATIC = 7 * 86400
TTL_FROZEN = 30 * 86400      # 区间已完全落在过去 / 财报已是老期数
TTL_QUARTER_HOT = 6 * 3600   # 含最近一期的财报
TTL_DEFAULT = 3600
TTL_PROBE = 86400
# 早于这个天数的报告期认为已定型
QUARTER_FROZEN_DAYS = 120


class TushareError(Exception):
    """仅在模块内部流转; 对外一律转成 {"err": ...} 结构, 不外抛。"""


# ================================================================ token
def load_token():
    """读取 Tushare token: 优先环境变量 TUSHARE_TOKEN, 其次同目录 tushare.env。

    仿 tq_auth.load_auth 的写法。找不到时抛 TushareError(而不是 SystemExit,
    因为本模块跑在 server 的工作线程里, 不能把进程带走)。
    """
    token = os.environ.get("TUSHARE_TOKEN", "").strip()
    if not token and ENV_FILE.exists():
        kv = dict(
            line.split("=", 1)
            for line in ENV_FILE.read_text().splitlines()
            if "=" in line and not line.lstrip().startswith("#")
        )
        token = kv.get("TUSHARE_TOKEN", "").strip()
    if not token:
        raise TushareError(
            "未找到 Tushare token: 请把 TUSHARE_TOKEN=xxx 写进 "
            f"{ENV_FILE}, 或用 TUSHARE_TOKEN=... 环境变量运行"
        )
    return token


# ================================================================ 代码转换
_TQ2TS_EX = {"SSE": "SH", "SZSE": "SZ", "BSE": "BJ"}
_TS2TQ_EX = {"SH": "SSE", "SZ": "SZSE", "BJ": "BSE"}


def to_ts_code(symbol):
    """TqSdk 代码 -> Tushare 代码。SSE.600519 -> 600519.SH

    也接受已经是 Tushare 格式的(原样返回)和裸代码(按数字前缀猜交易所)。
    """
    if not symbol:
        return ""
    s = str(symbol).strip().upper()
    if "." in s:
        head, tail = s.split(".", 1)
        if head in _TQ2TS_EX:                 # SSE.600519
            return f"{tail}.{_TQ2TS_EX[head]}"
        if tail in _TS2TQ_EX:                 # 600519.SH 已经是目标格式
            return s
        return s
    # 裸代码: 6/9 开头沪市, 0/3 深市, 4/8 北交所
    if s[:1] in "69":
        return f"{s}.SH"
    if s[:1] in "03":
        return f"{s}.SZ"
    if s[:1] in "48":
        return f"{s}.BJ"
    return s


def to_tq_code(ts_code):
    """Tushare 代码 -> TqSdk 代码。600519.SH -> SSE.600519"""
    if not ts_code:
        return ""
    s = str(ts_code).strip().upper()
    if "." not in s:
        return to_tq_code(to_ts_code(s))
    head, tail = s.split(".", 1)
    if tail in _TS2TQ_EX:                     # 600519.SH
        return f"{_TS2TQ_EX[tail]}.{head}"
    if head in _TQ2TS_EX:                     # 已经是 TqSdk 格式
        return s
    return s


def norm_date(d, default=None):
    """把 '2024-01-01' / '20240101' / date / datetime 统一成 'YYYYMMDD'。"""
    if d is None or d == "":
        return default
    if isinstance(d, (date, datetime)):
        return d.strftime("%Y%m%d")
    s = str(d).strip().replace("-", "").replace("/", "")
    return s if len(s) == 8 and s.isdigit() else default


def _today():
    return datetime.now().strftime("%Y%m%d")


# ================================================================ 令牌桶
class _RateLimiter:
    """滑动窗口令牌桶: 最近 60s 内最多 n 次。超了就 sleep 排队, 不报错。"""

    def __init__(self, per_min):
        self.per_min = per_min
        self.hits = deque()
        self.lock = threading.Lock()
        self.waited = 0.0                     # 累计排队秒数, 便于观测

    def acquire(self):
        while True:
            with self.lock:
                now = time.time()
                while self.hits and now - self.hits[0] >= 60.0:
                    self.hits.popleft()
                if len(self.hits) < self.per_min:
                    self.hits.append(now)
                    return
                wait = 60.0 - (now - self.hits[0]) + 0.01
            self.waited += wait
            time.sleep(wait)                  # 注意: 在锁外 sleep, 不阻塞其他线程判断


_limiter = _RateLimiter(RATE_PER_MIN)


# ================================================================ 缓存
_mem = OrderedDict()
_mem_lock = threading.Lock()
_cache_lock = threading.Lock()

STATS = {"http": 0, "mem_hit": 0, "disk_hit": 0, "err": 0}


def _cache_key(api, params):
    blob = json.dumps([api, params], sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def _cache_path(api, key):
    safe = "".join(c if c.isalnum() or c == "_" else "_" for c in api)[:40]
    return CACHE_DIR / f"{safe}.{key}.json"


def _secs_to_midnight():
    now = datetime.now()
    nxt = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    return max(60.0, (nxt - now).total_seconds())


def _ttl_for(api, params):
    """按接口类别 + 参数决定 TTL(秒)。核心思路: 已经不会再变的数据就长缓存。"""
    if api in STATIC_APIS:
        return TTL_STATIC
    today = _today()

    if api in DAILY_APIS:
        # 查询区间的右端: end_date / trade_date。严格早于今天 -> 数据已定型
        end = params.get("end_date") or params.get("trade_date") or params.get("date")
        end = norm_date(end)
        if end and end < today:
            return TTL_FROZEN
        return _secs_to_midnight()            # 覆盖到今天 -> 当日有效

    if api in QUARTER_APIS:
        per = norm_date(params.get("period") or params.get("end_date"))
        cutoff = (datetime.now() - timedelta(days=QUARTER_FROZEN_DAYS)).strftime("%Y%m%d")
        if per and per < cutoff:
            return TTL_FROZEN                 # 老报告期, 不会再动
        return TTL_QUARTER_HOT                # 没指定期数或含最近一期 -> 短 TTL

    return TTL_DEFAULT


def _mem_get(key):
    with _mem_lock:
        item = _mem.get(key)
        if item is None:
            return None
        if item["exp"] < time.time():
            _mem.pop(key, None)
            return None
        _mem.move_to_end(key)
        return item


def _mem_put(key, item):
    with _mem_lock:
        _mem[key] = item
        _mem.move_to_end(key)
        while len(_mem) > MEM_CACHE_MAX:
            _mem.popitem(last=False)


def _disk_get(api, key):
    path = _cache_path(api, key)
    try:
        if not path.exists():
            return None
        item = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None                           # 缓存损坏当没有, 下次重写
    if not isinstance(item, dict) or item.get("exp", 0) < time.time():
        return None
    return item


def _disk_put(api, key, item):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(api, key)
        # 原子写: 先写临时文件再 rename, 避免多线程读到半截 json
        tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8")
        with _cache_lock:
            tmp.replace(path)
    except Exception:
        pass                                  # 缓存写不进去不影响功能


def clear_cache(api=None):
    """清缓存。api=None 全清, 否则只清该接口。返回删掉的文件数。"""
    with _mem_lock:
        _mem.clear()
    n = 0
    if not CACHE_DIR.exists():
        return 0
    for p in CACHE_DIR.glob("*.json"):
        if api and not p.name.startswith(f"{api}."):
            continue
        try:
            p.unlink()
            n += 1
        except Exception:
            pass
    return n


# ================================================================ 底层请求
_ssl_ctx = None


def _get_ssl_ctx():
    global _ssl_ctx
    if _ssl_ctx is None:
        # SSL_CERT_FILE 已由 server.py / __main__ 注入, create_default_context 会读它
        _ssl_ctx = ssl.create_default_context()
    return _ssl_ctx


def _http_post(api, params, fields=""):
    """真实发一次 HTTPS POST。返回 (cols, rows); 失败抛 TushareError。"""
    token = load_token()
    body = json.dumps(
        {"api_name": api, "token": token, "params": params, "fields": fields},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    last = None
    for attempt in range(HTTP_RETRY + 1):
        _limiter.acquire()
        STATS["http"] += 1
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT,
                                        context=_get_ssl_ctx()) as resp:
                raw = resp.read().decode("utf-8", "replace")
            obj = json.loads(raw)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {e.reason}"
        except urllib.error.URLError as e:
            last = f"网络错误: {e.reason}"
        except json.JSONDecodeError:
            last = "返回不是合法 JSON(可能被网关拦截)"
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
        else:
            code = obj.get("code")
            if code != 0:
                # 权限/参数类错误重试没意义, 直接抛
                raise TushareError(f"[{api}] code={code} {obj.get('msg') or '未知错误'}")
            data = obj.get("data") or {}
            return list(data.get("fields") or []), list(data.get("items") or [])
        if attempt < HTTP_RETRY:
            time.sleep(0.8 * (attempt + 1))   # 退避重试
    raise TushareError(f"[{api}] {last}")


def call(api, params=None, fields="", use_cache=True, ttl=None):
    """带缓存 + 限频的通用调用。返回 {"cols":[...],"rows":[[...]]} 或 {"err":...}。

    这是模块唯一的出网口, 上面所有高层 API 都走这里。
    """
    params = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    key = _cache_key(api, dict(params, __f=fields))

    if use_cache:
        item = _mem_get(key)
        if item is not None:
            STATS["mem_hit"] += 1
            return {"cols": item["cols"], "rows": item["rows"]}
        item = _disk_get(api, key)
        if item is not None:
            STATS["disk_hit"] += 1
            _mem_put(key, item)
            return {"cols": item["cols"], "rows": item["rows"]}

    try:
        cols, rows = _http_post(api, params, fields)
    except TushareError as e:
        STATS["err"] += 1
        return _err(str(e))
    except Exception as e:                    # 兜底, 绝不外抛
        STATS["err"] += 1
        return _err(f"[{api}] 未预期异常 {type(e).__name__}: {e}")

    item = {
        "cols": cols, "rows": rows, "api": api, "params": params,
        "ts": time.time(), "exp": time.time() + (ttl if ttl is not None else _ttl_for(api, params)),
    }
    _mem_put(key, item)
    _disk_put(api, key, item)
    return {"cols": cols, "rows": rows}


def _err(msg):
    return {"cols": [], "rows": [], "err": str(msg)}


def _is_err(res):
    return bool(res.get("err"))


# ================================================================ 列式表工具
def _idx(cols, *names):
    """按名字取列下标, 取不到返回 -1。"""
    out = [cols.index(n) if n in cols else -1 for n in names]
    return out[0] if len(out) == 1 else out


def _pick(res, names, rename=None):
    """从 {"cols","rows"} 里挑列并可改名, 缺的列填 None。"""
    if _is_err(res):
        return res
    cols, rows = res["cols"], res["rows"]
    ids = [cols.index(n) if n in cols else -1 for n in names]
    out_cols = [(rename or {}).get(n, n) for n in names]
    out_rows = [[(r[i] if 0 <= i < len(r) else None) for i in ids] for r in rows]
    return {"cols": out_cols, "rows": out_rows}


def _sort_by(res, col, reverse=False):
    if _is_err(res) or col not in res["cols"]:
        return res
    i = res["cols"].index(col)
    res["rows"] = sorted(res["rows"], key=lambda r: (r[i] is None, r[i]), reverse=reverse)
    return res


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ================================================================ 高层业务 API
def stock_list(exchange=None, list_status="L"):
    """全 A 股列表。cols: ts_code,tq_code,symbol,name,area,industry,market,list_date"""
    res = call("stock_basic", {"exchange": exchange, "list_status": list_status},
               fields="ts_code,symbol,name,area,industry,market,exchange,list_date")
    if _is_err(res):
        return res
    res = _pick(res, ["ts_code", "symbol", "name", "area", "industry",
                      "market", "exchange", "list_date"])
    # 顺手挂上 TqSdk 代码, 前端点一下就能切到行情终端的订阅
    res["cols"] = ["ts_code", "tq_code"] + res["cols"][1:]
    res["rows"] = [[r[0], to_tq_code(r[0])] + r[1:] for r in res["rows"]]
    return res


def trade_calendar(start, end, exchange="SSE"):
    """交易日历。cols: cal_date,is_open,pretrade_date"""
    res = call("trade_cal", {"exchange": exchange, "start_date": norm_date(start),
                             "end_date": norm_date(end)})
    return _sort_by(_pick(res, ["cal_date", "is_open", "pretrade_date"]), "cal_date")


def name_history(ts_code):
    """曾用名。cols: ts_code,name,start_date,end_date,change_reason"""
    res = call("namechange", {"ts_code": to_ts_code(ts_code)})
    return _sort_by(_pick(res, ["ts_code", "name", "start_date", "end_date",
                                "change_reason"]), "start_date", reverse=True)


def company(ts_code):
    """公司基本信息。cols 见 Tushare stock_company"""
    return call("stock_company", {"ts_code": to_ts_code(ts_code)})


# ---------------------------------------------------------------- K 线 + 复权
def _adj_factors(ts_code):
    """拿全历史复权因子 -> {trade_date: factor}, 以及 (最早因子, 最新因子)。

    必须取**全历史**而不是窗口内: 前复权要锚定到今天的因子, 后复权要锚定到上市首日,
    只取窗口会让同一只票在不同窗口下算出不同的复权价。
    """
    res = call("adj_factor", {"ts_code": to_ts_code(ts_code)},
               fields="trade_date,adj_factor")
    if _is_err(res):
        return None, None, None, res["err"]
    cols, rows = res["cols"], res["rows"]
    if not rows:
        return None, None, None, "无复权因子数据"
    di, fi = cols.index("trade_date"), cols.index("adj_factor")
    fmap = {}
    for r in rows:
        f = _num(r[fi])
        if f:
            fmap[str(r[di])] = f
    if not fmap:
        return None, None, None, "复权因子全为空"
    dates = sorted(fmap)
    return fmap, fmap[dates[0]], fmap[dates[-1]], None


def kline(ts_code, start=None, end=None, adj=None, freq="D"):
    """日/周线, 支持前后复权。

    adj: None 不复权 / "qfq" 前复权 / "hfq" 后复权
    前复权 = price * factor / factor[最新]   (锚定今天, 最新价 == 实际成交价)
    后复权 = price * factor / factor[最早]   (锚定上市首日, 历史价 == 实际成交价)
    成交量/成交额不复权。

    cols: trade_date,open,high,low,close,pre_close,pct_chg,vol,amount[,adj_factor]
    """
    code = to_ts_code(ts_code)
    api = {"D": "daily", "W": "weekly"}.get(str(freq).upper(), "daily")
    res = call(api, {"ts_code": code, "start_date": norm_date(start),
                     "end_date": norm_date(end)})
    if _is_err(res):
        return res
    want = ["trade_date", "open", "high", "low", "close", "pre_close",
            "pct_chg", "vol", "amount"]
    res = _sort_by(_pick(res, want), "trade_date")
    if not adj or not res["rows"]:
        return res

    adj = str(adj).lower()
    if adj not in ("qfq", "hfq"):
        return _err(f"adj 只能是 None/'qfq'/'hfq', 收到 {adj!r}")
    fmap, f_first, f_last, ferr = _adj_factors(code)
    if ferr:
        return _err(f"复权失败: {ferr}")
    base = f_last if adj == "qfq" else f_first

    di = res["cols"].index("trade_date")
    price_ids = [res["cols"].index(c) for c in ("open", "high", "low", "close", "pre_close")]
    out = []
    for r in res["rows"]:
        f = fmap.get(str(r[di]))
        if f is None:           # 该交易日没因子(极少见), 保留原始价并标 None 因子
            out.append(r + [None])
            continue
        k = f / base
        row = list(r)
        for i in price_ids:
            v = _num(row[i])
            row[i] = round(v * k, 4) if v is not None else None
        out.append(row + [round(f, 6)])
    res["cols"] = res["cols"] + ["adj_factor"]
    res["rows"] = out
    return res


def valuation(ts_code, start=None, end=None):
    """估值指标 daily_basic。
    cols: trade_date,close,turnover_rate,volume_ratio,pe,pe_ttm,pb,ps,ps_ttm,
          dv_ratio,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv
    """
    res = call("daily_basic", {"ts_code": to_ts_code(ts_code),
                               "start_date": norm_date(start), "end_date": norm_date(end)})
    want = ["trade_date", "close", "turnover_rate", "turnover_rate_f", "volume_ratio",
            "pe", "pe_ttm", "pb", "ps", "ps_ttm", "dv_ratio", "dv_ttm",
            "total_share", "float_share", "free_share", "total_mv", "circ_mv"]
    return _sort_by(_pick(res, want), "trade_date")


def limit_price(ts_code, start=None, end=None):
    """涨跌停价 stk_limit。cols: trade_date,up_limit,down_limit,pre_close"""
    res = call("stk_limit", {"ts_code": to_ts_code(ts_code),
                             "start_date": norm_date(start), "end_date": norm_date(end)})
    return _sort_by(_pick(res, ["trade_date", "pre_close", "up_limit", "down_limit"]),
                    "trade_date")


def index_kline(index_code, start=None, end=None):
    """指数日线 index_daily。cols 同 kline(不复权)"""
    res = call("index_daily", {"ts_code": to_ts_code(index_code),
                               "start_date": norm_date(start), "end_date": norm_date(end)})
    return _sort_by(_pick(res, ["trade_date", "open", "high", "low", "close",
                                "pre_close", "pct_chg", "vol", "amount"]), "trade_date")


# ---------------------------------------------------------------- 财务
_FIN_IND = ["end_date", "eps", "bps", "roe", "roe_dt", "roa", "grossprofit_margin",
            "netprofit_margin", "debt_to_assets", "current_ratio", "quick_ratio",
            "or_yoy", "netprofit_yoy", "dt_netprofit_yoy", "ocf_to_or", "assets_turn"]
_FIN_INC = ["total_revenue", "revenue", "operate_profit", "total_profit",
            "n_income", "n_income_attr_p"]
_FIN_BAL = ["total_assets", "total_liab", "total_hldr_eqy_exc_min_int",
            "money_cap", "accounts_receiv", "inventories"]
_FIN_CF = ["n_cashflow_act", "n_cashflow_inv_act", "n_cash_flows_fnc_act",
           "c_fr_sale_sg", "free_cashflow"]


def _report_map(api, ts_code, keys, periods):
    """拉一张报表, 按 end_date 去重(优先合并报表 report_type=1), 返回 {end_date: {字段: 值}}"""
    res = call(api, {"ts_code": ts_code}, fields=",".join(["end_date", "report_type"] + keys))
    if _is_err(res):
        return {}, res["err"]
    cols, rows = res["cols"], res["rows"]
    if "end_date" not in cols:
        return {}, None
    di = cols.index("end_date")
    ri = cols.index("report_type") if "report_type" in cols else -1
    best = {}
    for r in rows:
        d = str(r[di])
        rt = str(r[ri]) if ri >= 0 and r[ri] is not None else "1"
        # 同一期可能有多种 report_type(调整前/后), 合并报表(1)优先, 其次先到先得
        if d in best and not (rt == "1" and best[d][0] != "1"):
            continue
        best[d] = (rt, {k: (r[cols.index(k)] if k in cols else None) for k in keys})
    keep = sorted(best, reverse=True)[:periods]
    return {d: best[d][1] for d in keep}, None


def financials(ts_code, periods=8):
    """财务全景: fina_indicator + 三表关键行, 按报告期合并成一张宽表。

    cols: end_date + 指标列 + 利润表 + 资产负债表 + 现金流量表关键行
    rows: 最近 periods 期, 从新到旧
    """
    code = to_ts_code(ts_code)
    ind_keys = _FIN_IND[1:]
    ind, e1 = _report_map("fina_indicator", code, ind_keys, periods)
    inc, e2 = _report_map("income", code, _FIN_INC, periods)
    bal, e3 = _report_map("balancesheet", code, _FIN_BAL, periods)
    cf, e4 = _report_map("cashflow", code, _FIN_CF, periods)
    errs = [e for e in (e1, e2, e3, e4) if e]
    if errs and not (ind or inc or bal or cf):
        return _err("; ".join(errs))

    dates = sorted(set(ind) | set(inc) | set(bal) | set(cf), reverse=True)[:periods]
    cols = ["end_date"] + ind_keys + _FIN_INC + _FIN_BAL + _FIN_CF
    rows = []
    for d in dates:
        row = [d]
        for src, keys in ((ind, ind_keys), (inc, _FIN_INC), (bal, _FIN_BAL), (cf, _FIN_CF)):
            m = src.get(d) or {}
            row += [m.get(k) for k in keys]
        rows.append(row)
    out = {"cols": cols, "rows": rows}
    if errs:
        out["warn"] = "; ".join(errs)         # 部分表没权限时降级返回, 不整体失败
    return out


def forecast(ts_code, periods=8):
    """业绩预告。cols: ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,
    net_profit_max,last_parent_net,summary"""
    res = call("forecast", {"ts_code": to_ts_code(ts_code)})
    res = _pick(res, ["ann_date", "end_date", "type", "p_change_min", "p_change_max",
                      "net_profit_min", "net_profit_max", "last_parent_net", "summary"])
    if _is_err(res):
        return res
    res = _sort_by(res, "end_date", reverse=True)
    res["rows"] = res["rows"][:periods]
    return res


# ---------------------------------------------------------------- 资金
def moneyflow_series(ts_code, start=None, end=None):
    """个股资金流。cols: trade_date + 各档买卖量额 + net_mf_vol/net_mf_amount"""
    res = call("moneyflow", {"ts_code": to_ts_code(ts_code),
                             "start_date": norm_date(start), "end_date": norm_date(end)})
    want = ["trade_date", "buy_sm_amount", "sell_sm_amount", "buy_md_amount",
            "sell_md_amount", "buy_lg_amount", "sell_lg_amount", "buy_elg_amount",
            "sell_elg_amount", "net_mf_vol", "net_mf_amount"]
    return _sort_by(_pick(res, want), "trade_date")


def northbound(start=None, end=None):
    """沪深港通资金流 moneyflow_hsgt。
    cols: trade_date,ggt_ss,ggt_sz,hgt,sgt,north_money,south_money (单位: 百万元)
    注: 该接口必须给出起止日期(缺省会 50101 参数校验失败), 默认取最近 90 天。
    """
    end = norm_date(end) or _today()
    start = norm_date(start) or (datetime.now() - timedelta(days=90)).strftime("%Y%m%d")
    res = call("moneyflow_hsgt", {"start_date": start, "end_date": end})
    return _sort_by(_pick(res, ["trade_date", "ggt_ss", "ggt_sz", "hgt", "sgt",
                                "north_money", "south_money"]), "trade_date")


def _recent_trade_days(n=6):
    """最近 n 个交易日, 由近及远。跨春节要往回找足够多的自然日"""
    end = _today()
    start = (datetime.now() - timedelta(days=30)).strftime("%Y%m%d")
    cal = call("trade_cal", {"exchange": "SSE", "start_date": start, "end_date": end})
    if _is_err(cal):
        return [end]
    ci, oi = _idx(cal["cols"], "cal_date"), _idx(cal["cols"], "is_open")
    days = sorted((r[ci] for r in cal["rows"]
                   if str(r[oi]) in ("1", "1.0") and r[ci] <= end), reverse=True)
    return days[:n] or [end]


def _last_trade_date():
    return _recent_trade_days(1)[0]


def dragon_list(trade_date=None, ts_code=None):
    """龙虎榜每日明细 top_list。trade_date 缺省取最近一个交易日。
    cols: trade_date,ts_code,name,close,pct_change,turnover_rate,amount,
          l_buy,l_sell,l_amount,net_amount,net_rate,amount_rate,float_values,reason
    """
    want = ["trade_date", "ts_code", "name", "close", "pct_change", "turnover_rate",
            "amount", "l_buy", "l_sell", "l_amount", "net_amount", "net_rate",
            "amount_rate", "float_values", "reason"]
    code = to_ts_code(ts_code) if ts_code else None
    d = norm_date(trade_date)
    # 龙虎榜盘后才发布, 当日常常还是空的 -> 往回退最多 5 个交易日找到有数据的一天
    days = [d] if d else _recent_trade_days(6)
    for day in days:
        res = call("top_list", {"trade_date": day, "ts_code": code})
        out = _sort_by(_pick(res, want), "net_amount", reverse=True)
        if not _is_err(out) and out.get("rows"):
            return out
    return {"cols": want, "rows": []}


# ---------------------------------------------------------------- 股东 / 筹码
def holders(ts_code, periods=1):
    """前十大股东 top10_holders。cols: end_date,holder_name,hold_amount,hold_ratio"""
    res = call("top10_holders", {"ts_code": to_ts_code(ts_code)})
    res = _pick(res, ["ann_date", "end_date", "holder_name", "hold_amount",
                      "hold_ratio", "hold_change"])
    if _is_err(res) or not res["rows"]:
        return res
    di = res["cols"].index("end_date")
    keep = sorted({str(r[di]) for r in res["rows"]}, reverse=True)[:periods]
    res["rows"] = [r for r in res["rows"] if str(r[di]) in keep]
    ai = res["cols"].index("hold_amount")
    res["rows"].sort(key=lambda r: (r[di], _num(r[ai]) or 0), reverse=True)
    return res


def holder_number(ts_code):
    """股东户数 stk_holdernumber。cols: ann_date,end_date,holder_num"""
    res = call("stk_holdernumber", {"ts_code": to_ts_code(ts_code)})
    return _sort_by(_pick(res, ["ann_date", "end_date", "holder_num"]),
                    "end_date", reverse=True)


def chips(ts_code, start=None, end=None):
    """筹码分布指标 cyq_perf。
    cols: trade_date,his_low,his_high,cost_5pct,cost_15pct,cost_50pct,
          cost_85pct,cost_95pct,weight_avg,winner_rate
    """
    res = call("cyq_perf", {"ts_code": to_ts_code(ts_code),
                            "start_date": norm_date(start), "end_date": norm_date(end)})
    want = ["trade_date", "his_low", "his_high", "cost_5pct", "cost_15pct",
            "cost_50pct", "cost_85pct", "cost_95pct", "weight_avg", "winner_rate"]
    return _sort_by(_pick(res, want), "trade_date")


def factors(ts_code, start=None, end=None):
    """技术因子 stk_factor(含复权价 + MACD/KDJ/RSI/BOLL/CCI)。"""
    res = call("stk_factor", {"ts_code": to_ts_code(ts_code),
                              "start_date": norm_date(start), "end_date": norm_date(end)})
    want = ["trade_date", "close", "close_qfq", "close_hfq", "macd_dif", "macd_dea",
            "macd", "kdj_k", "kdj_d", "kdj_j", "rsi_6", "rsi_12", "rsi_24",
            "boll_upper", "boll_mid", "boll_lower", "cci"]
    return _sort_by(_pick(res, want), "trade_date")


# ---------------------------------------------------------------- 其他板块
def limit_stats(trade_date, limit_type=None):
    """涨跌停/炸板统计 limit_list_d。
    cols: trade_date,ts_code,name,close,pct_chg,amount,limit_amount,float_mv,
          total_mv,turnover_ratio,fd_amount,first_time,last_time,open_times,
          up_stat,limit_times,limit
    """
    res = call("limit_list_d", {"trade_date": norm_date(trade_date),
                                "limit_type": limit_type})
    want = ["trade_date", "ts_code", "name", "close", "pct_chg", "amount",
            "limit_amount", "float_mv", "total_mv", "turnover_ratio", "fd_amount",
            "first_time", "last_time", "open_times", "up_stat", "limit_times", "limit"]
    return _sort_by(_pick(res, want), "amount", reverse=True)


def margin(ts_code, start=None, end=None):
    """融资融券明细 margin_detail。
    cols: trade_date,rzye,rqye,rzmre,rqyl,rzche,rqchl,rqmcl,rzrqye
    """
    res = call("margin_detail", {"ts_code": to_ts_code(ts_code),
                                 "start_date": norm_date(start), "end_date": norm_date(end)})
    want = ["trade_date", "rzye", "rzmre", "rzche", "rqye", "rqyl", "rqmcl",
            "rqchl", "rzrqye"]
    return _sort_by(_pick(res, want), "trade_date")


def block(ts_code=None, start=None, end=None, trade_date=None):
    """大宗交易 block_trade。cols: trade_date,ts_code,price,vol,amount,buyer,seller"""
    res = call("block_trade", {"ts_code": to_ts_code(ts_code) if ts_code else None,
                               "trade_date": norm_date(trade_date),
                               "start_date": norm_date(start), "end_date": norm_date(end)})
    return _sort_by(_pick(res, ["trade_date", "ts_code", "price", "vol", "amount",
                                "buyer", "seller"]), "trade_date")


def index_members(index_code=None, date=None, ts_code=None):
    """index_code 缺省时看该股票(ts_code)在沪深300/中证500/上证50 里的权重"""
    if not index_code:
        target = to_ts_code(ts_code) if ts_code else None
        out = {"cols": ["index_code", "index_name", "con_code", "trade_date", "weight"], "rows": []}
        if not target:
            return out
        for idx, nm in (("000300.SH", "沪深300"), ("000905.SH", "中证500"), ("000016.SH", "上证50")):
            r = _index_members_one(idx, date)
            if _is_err(r):
                continue
            ci = _idx(r["cols"], "con_code")
            for row in r["rows"]:
                if row[ci] == target:
                    out["rows"].append([idx, nm, row[ci],
                                        row[_idx(r["cols"], "trade_date")],
                                        row[_idx(r["cols"], "weight")]])
        return out
    return _index_members_one(index_code, date)


def _index_members_one(index_code, date=None):
    """指数成分 + 权重 index_weight。cols: index_code,con_code,tq_code,trade_date,weight

    index_weight 只在月度调整日有数据, 传单日常常空。所以 date 会被展开成
    [date-45天, date] 的窗口, 再取窗口内最新的那一期。
    """
    end = norm_date(date, _today())
    start = (datetime.strptime(end, "%Y%m%d") - timedelta(days=45)).strftime("%Y%m%d")
    res = call("index_weight", {"index_code": to_ts_code(index_code),
                                "start_date": start, "end_date": end})
    res = _pick(res, ["index_code", "con_code", "trade_date", "weight"])
    if _is_err(res) or not res["rows"]:
        return res
    di = res["cols"].index("trade_date")
    latest = max(str(r[di]) for r in res["rows"])
    rows = [r for r in res["rows"] if str(r[di]) == latest]
    wi = res["cols"].index("weight")
    rows.sort(key=lambda r: _num(r[wi]) or 0, reverse=True)
    ci = res["cols"].index("con_code")
    return {"cols": ["index_code", "con_code", "tq_code", "trade_date", "weight"],
            "rows": [[r[0], r[ci], to_tq_code(r[ci]), r[di], r[wi]] for r in rows]}


# ================================================================ 能力探测
_PROBE_SPECS = [
    ("stock_basic", {"list_status": "L", "limit": 1}),
    ("trade_cal", {"start_date": "20250101", "end_date": "20250105"}),
    ("namechange", {"ts_code": "600519.SH"}),
    ("stock_company", {"ts_code": "600519.SH"}),
    ("daily", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("weekly", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250131"}),
    ("adj_factor", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("daily_basic", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("stk_limit", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("index_daily", {"ts_code": "000300.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("income", {"ts_code": "600519.SH", "period": "20241231"}),
    ("balancesheet", {"ts_code": "600519.SH", "period": "20241231"}),
    ("cashflow", {"ts_code": "600519.SH", "period": "20241231"}),
    ("fina_indicator", {"ts_code": "600519.SH", "period": "20241231"}),
    ("forecast", {"ts_code": "600519.SH"}),
    ("moneyflow", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("moneyflow_hsgt", {"start_date": "20250102", "end_date": "20250110"}),
    ("top_list", {"trade_date": "20250103"}),
    ("top10_holders", {"ts_code": "600519.SH", "period": "20241231"}),
    ("stk_holdernumber", {"ts_code": "600519.SH"}),
    ("cyq_perf", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("stk_factor", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("limit_list_d", {"trade_date": "20250103"}),
    ("margin_detail", {"ts_code": "600519.SH", "start_date": "20250102", "end_date": "20250110"}),
    ("block_trade", {"ts_code": "600519.SH", "start_date": "20240101", "end_date": "20250110"}),
    ("index_weight", {"index_code": "000300.SH", "start_date": "20241201", "end_date": "20241231"}),
    ("dc_index", {"trade_date": "20250103"}),
    ("fut_daily", {"trade_date": "20250103"}),
    ("fut_holding", {"trade_date": "20250103", "symbol": "CU"}),
]


def probe(force=False):
    """逐个试关键接口 -> {接口名: True/False}。结果缓存 1 天。

    失败的接口会把原因记进 probe_detail(), 便于前端提示"该功能需要积分"。
    """
    key = _cache_key("__probe__", {"v": 2})
    if not force:
        item = _mem_get(key) or _disk_get("__probe__", key)
        if item is not None:
            _mem_put(key, item)
            return dict(item["ok"])

    ok, detail = {}, {}
    for api, params in _PROBE_SPECS:
        res = call(api, params)               # 走正常缓存, 探测本身也几乎不费流量
        ok[api] = not _is_err(res)
        if not ok[api]:
            detail[api] = res["err"]
    item = {"ok": ok, "detail": detail, "cols": [], "rows": [],
            "ts": time.time(), "exp": time.time() + TTL_PROBE}
    _mem_put(key, item)
    _disk_put("__probe__", key, item)
    return dict(ok)


def probe_detail(force=False):
    """同 probe(), 但返回 {"ok":{...},"detail":{失败接口: 原因}}。"""
    probe(force=force)
    key = _cache_key("__probe__", {"v": 2})
    item = _mem_get(key) or _disk_get("__probe__", key) or {"ok": {}, "detail": {}}
    return {"ok": dict(item.get("ok") or {}), "detail": dict(item.get("detail") or {})}


# ================================================================ 板块 / 指数

# 主要指数(宽基 + 风格), 指数面板默认就看这些
MAJOR_INDEX = [
    ("000001.SH", "上证指数"), ("399001.SZ", "深证成指"), ("399006.SZ", "创业板指"),
    ("000688.SH", "科创50"), ("000300.SH", "沪深300"), ("000905.SH", "中证500"),
    ("000852.SH", "中证1000"), ("000016.SH", "上证50"), ("932000.CSI", "中证2000"),
    ("399005.SZ", "中小100"), ("000015.SH", "红利指数"), ("000922.CSI", "中证红利"),
]


def sectors(kind="dc", trade_date=None):
    """板块行情。kind: dc 东财概念/行业 | ths 同花顺 | sw 申万行业
    盘中当日数据还没发布, 往回退最多 5 个交易日找到有数据的一天。
    """
    if not norm_date(trade_date):
        for day in _recent_trade_days(6):
            r = sectors(kind, day)
            if not _is_err(r) and r.get("rows"):
                return r
        return {"cols": [], "rows": []}
    d = norm_date(trade_date)
    if kind == "sw":
        res = call("sw_daily", {"trade_date": d})
        if _is_err(res):
            return res
        out = _pick(res, ["ts_code", "name", "close", "pct_change", "vol", "amount",
                          "pe", "pb", "float_mv"])
        return _sort_by(out, "pct_change", reverse=True)
    if kind == "ths":
        idx = call("ths_index", {})
        names = {}
        if not _is_err(idx):
            ci, cn, cc = _idx(idx["cols"], "ts_code"), _idx(idx["cols"], "name"), _idx(idx["cols"], "count")
            for r in idx["rows"]:
                names[r[ci]] = (r[cn], r[cc] if cc is not None else None)
        res = call("ths_daily", {"trade_date": d})
        if _is_err(res):
            return res
        out = _pick(res, ["ts_code", "close", "pct_change", "vol", "turnover_rate", "pe"])
        cols = ["ts_code", "name", "close", "pct_change", "vol", "turnover_rate", "pe", "count"]
        ci = _idx(out["cols"], "ts_code")
        rows = []
        for r in out["rows"]:
            nm, cnt = names.get(r[ci], ("", None))
            rows.append([r[ci], nm, r[1], r[2], r[3], r[4], r[5], cnt])
        return _sort_by({"cols": cols, "rows": rows}, "pct_change", reverse=True)
    # 默认东财: dc_index 有领涨股, 再并上资金流
    res = call("dc_index", {"trade_date": d})
    if _is_err(res):
        return res
    out = _pick(res, ["ts_code", "name", "leading", "leading_code", "pct_change",
                      "leading_pct", "total_mv", "turnover_rate", "up_num", "down_num"])
    flow = call("moneyflow_ind_dc", {"trade_date": d})
    net = {}
    if not _is_err(flow):
        fi, fn = _idx(flow["cols"], "ts_code"), _idx(flow["cols"], "net_amount")
        if fi is not None and fn is not None:
            for r in flow["rows"]:
                net[r[fi]] = r[fn]
    ci = _idx(out["cols"], "ts_code")
    cols = out["cols"] + ["net_amount"]
    rows = [list(r) + [net.get(r[ci])] for r in out["rows"]]
    return _sort_by({"cols": cols, "rows": rows}, "pct_change", reverse=True)


def sector_members(ts_code, kind="dc", trade_date=None):
    """板块成分股。dc -> dc_member, ths -> ths_member, sw -> index_member(申万)"""
    d = norm_date(trade_date)
    if kind == "ths":
        res = call("ths_member", {"ts_code": ts_code})
        return _pick(res, ["con_code", "con_name", "weight"])
    if kind == "sw":
        res = call("index_member", {"index_code": ts_code})
        return _pick(res, ["con_code", "con_name", "in_date"])
    p = {"ts_code": ts_code}
    if d:
        p["trade_date"] = d
    res = call("dc_member", p)
    if not _is_err(res) and not res["rows"] and not d:
        res = call("dc_member", {"ts_code": ts_code, "trade_date": _last_trade_date()})
    return _pick(res, ["con_code", "name", "trade_date"])


def indices(trade_date=None):
    """主要指数行情 + 估值。一次按 trade_date 拉全市场再挑, 不要 12 次串行(要 32s)"""
    if not norm_date(trade_date):
        for day in _recent_trade_days(6):
            r = indices(day)
            if not _is_err(r) and any(x[2] is not None for x in r["rows"]):
                return r
        return indices(_last_trade_date())
    d = norm_date(trade_date)
    basic = call("index_dailybasic", {"trade_date": d})
    val = {}
    if not _is_err(basic):
        bi = _idx(basic["cols"], "ts_code")
        pe, pb, tv = (_idx(basic["cols"], k) for k in ("pe_ttm", "pb", "total_mv"))
        for r in basic["rows"]:
            val[r[bi]] = (r[pe] if pe is not None else None,
                          r[pb] if pb is not None else None,
                          r[tv] if tv is not None else None)
    cols = ["ts_code", "name", "close", "pct_chg", "change", "vol", "amount", "pe_ttm", "pb", "total_mv"]
    day = call("index_daily", {"trade_date": d})       # 一次拿当日全部指数
    byc = {}
    if not _is_err(day):
        c = day["cols"]
        ic = _idx(c, "ts_code")
        gi = {k: _idx(c, k) for k in ("close", "pct_chg", "change", "vol", "amount")}
        for r in day["rows"]:
            byc[r[ic]] = {k: (r[i] if i is not None else None) for k, i in gi.items()}
    rows = []
    for code, name in MAJOR_INDEX:
        q = byc.get(code, {})
        v = val.get(code, (None, None, None))
        rows.append([code, name, q.get("close"), q.get("pct_chg"), q.get("change"),
                     q.get("vol"), q.get("amount"), v[0], v[1], v[2]])
    return {"cols": cols, "rows": rows}


def hot_concepts(trade_date=None):
    """涨停最强板块(开盘啦口径), 盯盘找主线用"""
    if not norm_date(trade_date):
        for day in _recent_trade_days(6):
            r = hot_concepts(day)
            if not _is_err(r) and r.get("rows"):
                return r
        return {"cols": [], "rows": []}
    res = call("limit_cpt_list", {"trade_date": norm_date(trade_date)})
    return _pick(res, ["ts_code", "name", "days", "up_stat", "cons_nums", "up_nums",
                       "pct_chg", "rank"])


def stock_sectors(ts_code):
    """个股所属板块: 申万三级 + 同花顺概念"""
    code = to_ts_code(ts_code)
    out = {"cols": ["source", "code", "name"], "rows": []}
    sw = call("index_member_all", {"ts_code": code})
    if not _is_err(sw) and sw["rows"]:
        r, c = sw["rows"][0], sw["cols"]
        for lv, nm in (("l1", "申万一级"), ("l2", "申万二级"), ("l3", "申万三级")):
            ci, cn = _idx(c, lv + "_code"), _idx(c, lv + "_name")
            if ci is not None and r[ci]:
                out["rows"].append([nm, r[ci], r[cn] if cn is not None else ""])
    th = call("ths_member", {"con_code": code})
    if not _is_err(th):
        ci, cn = _idx(th["cols"], "ts_code"), _idx(th["cols"], "name")
        for r in th["rows"][:30]:
            out["rows"].append(["同花顺", r[ci], r[cn] if cn is not None else ""])
    return out


# ================================================================ 业务名分发
# server.py 收到 {"action":"fund","kind":K,"args":{...}} 后直接 dispatch(K, args),
# 拿到的就是可以塞进 {"type":"fund","cols":...,"rows":...} 的东西。
KINDS = {
    "stock_list": stock_list,
    "trade_calendar": trade_calendar,
    "name_history": name_history,
    "company": company,
    "kline": kline,
    "valuation": valuation,
    "limit_price": limit_price,
    "index_kline": index_kline,
    "financials": financials,
    "forecast": forecast,
    "moneyflow_series": moneyflow_series,
    "northbound": northbound,
    "dragon_list": dragon_list,
    "holders": holders,
    "holder_number": holder_number,
    "chips": chips,
    "factors": factors,
    "limit_stats": limit_stats,
    "margin": margin,
    "block": block,
    "index_members": index_members,
    "sectors": sectors,
    "sector_members": sector_members,
    "indices": indices,
    "hot_concepts": hot_concepts,
    "stock_sectors": stock_sectors,
}


# 前端可能用别的叫法, 统一映射到实际实现
KIND_ALIAS = {
    "stock_basic": "company", "basic": "company", "profile": "company",
    "quote_basic": "valuation", "daily_basic": "valuation",
    "fina": "financials", "fina_indicator": "financials",
    "moneyflow": "moneyflow_series", "hsgt": "northbound",
    "top_list": "dragon_list", "longhu": "dragon_list",
    "cyq": "chips", "stk_factor": "factors",
    "margin_detail": "margin", "block_trade": "block",
    "index_weight": "index_members", "daily": "kline",
}
# 参数别名: 前端传的名字 -> 函数真实参数名
ARG_ALIAS = {
    "start_date": "start", "end_date": "end", "code": "ts_code",
    "symbol": "ts_code", "date": "trade_date", "n": "periods", "count": "periods",
}


def dispatch(kind, args=None):
    """按业务名调用。宽容处理: kind 别名、参数别名、多余参数一律丢弃而不是报错 ——
    前后端并行开发时参数命名难免漂移, 在这里兜住比让每个面板挂掉强。"""
    kind = KIND_ALIAS.get(kind, kind)
    fn = KINDS.get(kind)
    if fn is None:
        return _err(f"未知 kind={kind!r}, 可用: {','.join(sorted(KINDS))}")
    args = dict(args or {})
    for src, dst in ARG_ALIAS.items():
        if src in args and dst not in args:
            args[dst] = args.pop(src)
    try:
        # limit 必须在丢弃未知参数之前取走。原来写在 dropped 之后且两条分支都
        # 赋 None, 截断永远不执行 —— 前端 10 个 kind 传的 limit 全被静默吞掉,
        # 个股研究每个面板都在拉上市至今的全历史(单次落盘接近 2MB)。
        limit = args.pop("limit", None)
        if limit is None:
            limit = args.pop("rows", None)
        else:
            args.pop("rows", None)
        try:
            limit = int(limit) if limit else None
        except (TypeError, ValueError):
            limit = None
        accepted = set(inspect.signature(fn).parameters)
        # 按报告期取数的函数(financials/holders)没有按日行, 截行截不出更多期数,
        # 要把 limit 翻译成 periods 才有效。
        if limit and "periods" in accepted and "periods" not in args:
            args["periods"] = limit
        for k in [k for k in args if k not in accepted]:
            args.pop(k)
        res = fn(**args)
        if limit and isinstance(res, dict) and isinstance(res.get("rows"), list):
            res = dict(res, rows=res["rows"][-limit:])
        return res
    except TypeError as e:
        return _err(f"[{kind}] 参数错误: {e}")
    except Exception as e:
        return _err(f"[{kind}] 内部异常 {type(e).__name__}: {e}")


# ================================================================ 自测
if __name__ == "__main__":
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())

    def timed(label, fn):
        t0 = time.perf_counter()
        r = fn()
        return r, (time.perf_counter() - t0) * 1000, label

    def show(res, n=3, label=""):
        if _is_err(res):
            print(f"    ERR: {res['err']}")
            return
        print(f"    cols({len(res['cols'])}) = {res['cols']}")
        print(f"    rows = {len(res['rows'])}")
        for r in res["rows"][:n]:
            print(f"      {r}")
        if res.get("warn"):
            print(f"    warn: {res['warn']}")

    print("=" * 78)
    print("0) 代码转换")
    for s in ["SSE.600519", "SZSE.000001", "BSE.430047", "600519.SH", "000001", "300750"]:
        print(f"    {s:14} -> ts {to_ts_code(s):12} -> tq {to_tq_code(to_ts_code(s))}")

    print("=" * 78)
    print("1) 能力探测 probe()")
    pd_, ms, _ = timed("probe", lambda: probe_detail(force=True))
    okmap = pd_["ok"]
    good = [k for k, v in okmap.items() if v]
    bad = [k for k, v in okmap.items() if not v]
    print(f"    耗时 {ms/1000:.1f}s   可用 {len(good)}/{len(okmap)}")
    print(f"    OK  : {', '.join(good)}")
    for k in bad:
        print(f"    FAIL: {k} -> {pd_['detail'].get(k)}")
    pd2, ms2, _ = timed("probe2", lambda: probe_detail())
    print(f"    二次(缓存) 耗时 {ms2:.2f}ms")

    CODE = "SSE.600519"
    S, E = "20240101", "20250630"

    print("=" * 78)
    print(f"2) 茅台 {CODE} 日线: 不复权 vs 前复权   {S}~{E}")
    raw, ms_raw, _ = timed("raw", lambda: kline(CODE, S, E))
    print(f"  [不复权] 首次 {ms_raw:.0f}ms")
    show(raw, 2)
    q, ms_q, _ = timed("qfq", lambda: kline(CODE, S, E, adj="qfq"))
    print(f"  [前复权] 首次 {ms_q:.0f}ms")
    show(q, 2)
    h, ms_h, _ = timed("hfq", lambda: kline(CODE, S, E, adj="hfq"))
    print(f"  [后复权] {ms_h:.0f}ms")
    show(h, 2)
    _, ms_raw2, _ = timed("raw2", lambda: kline(CODE, S, E))
    _, ms_q2, _ = timed("qfq2", lambda: kline(CODE, S, E, adj="qfq"))
    print(f"  缓存命中: 不复权 {ms_raw2:.2f}ms (首次 {ms_raw:.0f}ms) | "
          f"前复权 {ms_q2:.2f}ms (首次 {ms_q:.0f}ms)")

    print("-" * 78)
    print("  ★ 复权正确性: 除权日跳空是否被消除")
    print("    判据: Tushare 的 pct_chg 用的是除权后 pre_close, 是真实收益率。")
    print("    复权价算对的话  复权close[t]/复权close[t-1]-1  应当等于 pct_chg。")

    def ret_check(res, tag):
        c = res["cols"]
        di, ci, pi = c.index("trade_date"), c.index("close"), c.index("pct_chg")
        rows = res["rows"]
        worst = (0.0, None)
        diffs = []
        for i in range(1, len(rows)):
            p0, p1 = _num(rows[i-1][ci]), _num(rows[i][ci])
            pc = _num(rows[i][pi])
            if not p0 or p1 is None or pc is None:
                continue
            r = (p1 / p0 - 1) * 100
            d = abs(r - pc)
            diffs.append(d)
            if d > worst[0]:
                worst = (d, (rows[i][di], r, pc))
        print(f"    {tag}: 最大偏差 {worst[0]:.4f} 个百分点"
              + (f"  @{worst[1][0]} 实际涨跌 {worst[1][1]:+.3f}% vs pct_chg {worst[1][2]:+.3f}%"
                 if worst[1] else ""))
        return worst, diffs

    w_raw, _ = ret_check(raw, "不复权")
    w_q, _ = ret_check(q, "前复权")
    w_h, _ = ret_check(h, "后复权")
    exdate = w_raw[1][0] if w_raw[1] else None
    if exdate:
        print(f"\n    除权日 {exdate} 前后 2 天对照(close):")
        c = raw["cols"]
        di, ci = c.index("trade_date"), c.index("close")
        qi = q["cols"].index("close")
        hi = h["cols"].index("close")
        fi = q["cols"].index("adj_factor")
        idx = [i for i, r in enumerate(raw["rows"]) if r[di] == exdate][0]
        print(f"      {'日期':<10} {'不复权':>10} {'前复权':>10} {'后复权':>12} {'因子':>9}")
        for i in range(max(0, idx - 2), min(len(raw['rows']), idx + 3)):
            mark = " <== 除权日" if i == idx else ""
            print(f"      {raw['rows'][i][di]:<10} {raw['rows'][i][ci]:>10} "
                  f"{q['rows'][i][qi]:>10} {h['rows'][i][hi]:>12} "
                  f"{q['rows'][i][fi]:>9}{mark}")
    verdict = "PASS" if w_q[0] < 0.05 and w_h[0] < 0.05 and w_raw[0] > 0.5 else "CHECK"
    print(f"\n    ==> {verdict}: 不复权最大偏差 {w_raw[0]:.3f}pp(跳空存在), "
          f"前复权 {w_q[0]:.4f}pp / 后复权 {w_h[0]:.4f}pp(跳空已消除)")

    print("=" * 78)
    print("3) 财务指标 financials(periods=6)")
    f, ms, _ = timed("fin", lambda: financials(CODE, periods=6))
    print(f"    首次 {ms:.0f}ms")
    show(f, 2)
    _, ms2, _ = timed("fin2", lambda: financials(CODE, periods=6))
    print(f"    缓存 {ms2:.2f}ms")

    print("=" * 78)
    print("4) 资金流 moneyflow_series + northbound")
    mf, ms, _ = timed("mf", lambda: moneyflow_series(CODE, "20250601", "20250630"))
    print(f"    个股资金流 首次 {ms:.0f}ms")
    show(mf, 2)
    nb, ms, _ = timed("nb", lambda: northbound("20250601", "20250630"))
    print(f"    北向资金 首次 {ms:.0f}ms")
    show(nb, 2)

    print("=" * 78)
    print("5) 筹码 chips")
    ch, ms, _ = timed("chips", lambda: chips(CODE, "20250601", "20250630"))
    print(f"    首次 {ms:.0f}ms")
    show(ch, 2)

    print("=" * 78)
    print("6) 龙虎榜 dragon_list")
    dl, ms, _ = timed("dl", lambda: dragon_list("20250630"))
    print(f"    首次 {ms:.0f}ms")
    show(dl, 2)
    _, ms2, _ = timed("dl2", lambda: dragon_list("20250630"))
    print(f"    缓存 {ms2:.2f}ms")

    print("=" * 78)
    print("7) 其余高层 API 冒烟")
    for label, fn in [
        ("stock_list", lambda: stock_list()),
        ("valuation", lambda: valuation(CODE, "20250601", "20250630")),
        ("factors", lambda: factors(CODE, "20250601", "20250630")),
        ("holders", lambda: holders(CODE)),
        ("holder_number", lambda: holder_number(CODE)),
        ("limit_stats", lambda: limit_stats("20250630")),
        ("margin", lambda: margin(CODE, "20250601", "20250630")),
        ("block", lambda: block(CODE, "20240101", "20250630")),
        ("index_members", lambda: index_members("000300.SH", "20250630")),
        ("forecast", lambda: forecast(CODE)),
        ("limit_price", lambda: limit_price(CODE, "20250601", "20250630")),
        ("index_kline", lambda: index_kline("000300.SH", "20250601", "20250630")),
        ("trade_calendar", lambda: trade_calendar("20250601", "20250630")),
        ("name_history", lambda: name_history(CODE)),
    ]:
        r, ms, _ = timed(label, fn)
        tag = f"ERR {r['err'][:60]}" if _is_err(r) else f"{len(r['rows'])} 行 x {len(r['cols'])} 列"
        print(f"    {label:16} {ms:8.0f}ms  {tag}")

    print("=" * 78)
    print("8) dispatch 分发 + 错误处理")
    print(f"    dispatch('kline'): {len(dispatch('kline', {'ts_code': CODE, 'start': '20250601', 'end': '20250630', 'adj': 'qfq'})['rows'])} 行")
    print(f"    未知 kind    -> {dispatch('nope')['err'][:70]}")
    print(f"    参数错误      -> {dispatch('kline', {'bad_arg': 1})['err'][:70]}")
    print(f"    非法 adj     -> {kline(CODE, S, E, adj='xxx')['err'][:70]}")
    print(f"    不存在的股票  -> {kline('SSE.999999', S, E)}")

    print("=" * 78)
    nfile = len(list(CACHE_DIR.glob('*.json'))) if CACHE_DIR.exists() else 0
    size = sum(p.stat().st_size for p in CACHE_DIR.glob('*.json')) / 1024 if nfile else 0
    print(f"统计: HTTP {STATS['http']} 次 | 内存命中 {STATS['mem_hit']} | "
          f"磁盘命中 {STATS['disk_hit']} | 错误 {STATS['err']} | 限频排队 {_limiter.waited:.1f}s")
    print(f"缓存: {nfile} 个文件 {size:.0f} KB @ {CACHE_DIR}")
