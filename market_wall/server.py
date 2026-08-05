"""行情终端后端: TqSdk 采集 + WebSocket 推送 + 全市场合约索引 + 主力合约看板

用法: .venv/bin/python market_wall/server.py   (可用 PORT=8891 换端口)
浏览器打开 http://127.0.0.1:8890

架构:
- TqSdk 主采集线程(TqApi 非线程安全, 单线程使用), 维护共享状态快照。
  主循环整体包 try/except, 异常时置 STATE["status"]={"ok":False,...} 并重建 TqApi 按注册表重订阅。
- 独立元数据线程用第二个 TqApi 构建 (a) 全市场合约索引 -> symbol_cache.json
  (b) 主力合约看板元数据 -> board_cache.json, 均按交易日缓存, 二次启动秒级就绪
- aiohttp 主线程提供静态页面 + /ws WebSocket, 每 0.5s **按连接裁剪**推送:
  quotes(自选 + 该连接 focus) + 仅 focus 那一条 K 线 + 仅 focus 那一条 tick + board(若开)
- 序列 JSON 在采集线程里预序列化并按 dirty 标记缓存, broadcaster 只做字符串拼接
"""
import asyncio
import json
import math
import os
import queue
import re
import sys
import threading
import time
import traceback
from collections import deque
from pathlib import Path

# 本机 Python 的 openssl cert.pem 不存在, 信任库为空。这会同时打挂两条链路:
# TqSdk 的 REST 接口(龙虎榜/结算价/宏观)和 Tushare 的全部 HTTPS 请求 ——
# 只有 WebSocket 行情链路因为 tqsdk 内部显式 load_verify_locations(certifi) 才幸免。
# 必须在任何网络库 import 之前注入。
if not os.environ.get("SSL_CERT_FILE"):
    try:
        import certifi
        os.environ["SSL_CERT_FILE"] = certifi.where()
        os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except ImportError:
        pass

import numpy as np
from aiohttp import web, WSMsgType

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from tq_auth import load_auth  # noqa: E402

from tqsdk import TqApi, TqAuth  # noqa: E402

try:
    import tushare_adapter as TS          # 个股基本面(Tushare HTTP)
except Exception as _e:                   # noqa: BLE001
    TS = None
    print(f"[ts] Tushare 适配层不可用: {_e}", flush=True)
try:
    import option_engine as OPT           # 期权链 + IV + Greeks
except Exception as _e:                   # noqa: BLE001
    OPT = None
    print(f"[opt] 期权引擎不可用: {_e}", flush=True)
try:
    import hf_native as HF                # 高频指标 / 波动率 (C++ 计算核心)
    print(f"[hf] 计算核心: {HF.state()}", flush=True)
except Exception as _e:                   # noqa: BLE001
    HF = None
    print(f"[hf] 高频计算不可用: {_e}", flush=True)

# 各时间尺度的实时波动率(秒)
VOL_HORIZONS = (30, 60, 300, 900, 1800, 3600)

PORT = int(os.environ.get("PORT", 8890))
BASE = Path(__file__).parent
STATIC_DIR = BASE / "static"
# 自选等用户数据默认写在源码目录旁边。测试实例必须设 MW_DATA 指到别处 ——
# 两个进程各自把内存全量落盘, 共用一份文件就会互相覆盖(自选被吃掉过一次)。
DATA_DIR = Path(os.environ.get("MW_DATA") or BASE)
DATA_DIR.mkdir(parents=True, exist_ok=True)
WATCHLIST_FILE = DATA_DIR / "watchlist.json"
SYMBOL_CACHE = BASE / "symbol_cache.json"     # 只读缓存, 可以共用
BOARD_CACHE = BASE / "board_cache.json"

DEFAULT_WATCHLIST = [
    "KQ.m@SHFE.cu", "KQ.m@SHFE.rb", "KQ.m@SHFE.au", "KQ.m@SHFE.ag",
    "KQ.m@INE.sc", "KQ.m@DCE.i", "KQ.m@DCE.m", "KQ.m@CZCE.TA", "KQ.m@CZCE.MA",
]

QUOTE_FIELDS = [
    "instrument_name", "last_price", "pre_settlement", "pre_close",
    "open", "highest", "lowest", "average", "volume", "amount",
    "open_interest", "pre_open_interest", "upper_limit", "lower_limit",
    "datetime", "underlying_symbol",
    "price_tick", "volume_multiple", "ins_class", "expire_datetime",
    "bid_price1", "bid_volume1", "ask_price1", "ask_volume1",
    "bid_price2", "bid_volume2", "ask_price2", "ask_volume2",
    "bid_price3", "bid_volume3", "ask_price3", "ask_volume3",
    "bid_price4", "bid_volume4", "ask_price4", "ask_volume4",
    "bid_price5", "bid_volume5", "ask_price5", "ask_volume5",
    # 注: trading_time 也会随每个 quote 下发, 但它是 TradingTime 对象不能直接 clean(),
    #     由 quote_json() 单独转成 {"day":[[..]],"night":[[..]]} 并按合约缓存
]

KLINE_LEN_DEFAULT = 300
KLINE_LEN_DAY = 2000      # 日线及以上: 够聚合 400 周 / 95 月
KLINE_LEN_MAX = 8000
TICK_LEN = 400            # 订阅窗口
TICK_KEEP = 300           # 保留已算好的成交行数
LRU_TTL = float(os.environ.get("MW_LRU_TTL", 600))   # 10 分钟无人 focus 就淘汰
RECONNECT_WAIT = 5.0
# 每条新订阅会阻塞采集线程约 1~1.8s(TqSdk 要等服务端回 300 根 K 线), 期间 tick 也停更。
# 限成每轮 1 条, 让 tick 能在两次订阅之间挤进来, 避免连续切合约时出现多秒卡顿。
MAX_CMDS_PER_ROUND = 1
FOCUS_MAX = 16            # 一条连接最多同时推几条 K 线(多图 9 宫格 + 叠加对比)
HOT_WINDOW = 2.0          # LAST_USED 在这个时间内的序列才需要序列化(即"当前有人在看")
COLLECT_GAP = 0.12        # 采集循环最长等待: 有数据立刻返回, 无数据时决定指令响应速度
MIN_PUSH_GAP = 0.06       # 推送下限间隔, 防止行情密集时打满 CPU

# 采集线程 -> 事件循环 的"快照已更新"信号(事件驱动推送, 消除固定周期叠加的延迟)
SNAP_EVENT = None         # asyncio.Event, 在 on_startup 里创建
MAIN_LOOP = None


def signal_snapshot():
    """采集线程调: 通知 broadcaster 有新快照。跨线程必须走 call_soon_threadsafe"""
    if MAIN_LOOP is not None and SNAP_EVENT is not None:
        try:
            MAIN_LOOP.call_soon_threadsafe(SNAP_EVENT.set)
        except RuntimeError:
            pass          # 事件循环已关闭

# ---- 共享状态: 采集线程写, broadcaster 读(浅拷贝后出锁) ----
state_lock = threading.Lock()
STATE = {
    "ts": 0.0,
    "status_json": '{"ok":false,"err":"starting"}',
    "quotes_json": {},   # symbol -> json 片段(单个 quote 对象)
    "kl_json": {},       # "symbol|duration" -> json 片段(数组)
    "tick_json": {},     # symbol -> json 片段(数组)
    "hf_json": {},       # symbol -> 高频指标+波动率 json
    "board_json": "{}",  # 整块 json
}

cmd_queue = queue.Queue()

# 订阅注册表(重连后据此恢复), 由 ws 线程写 / 采集线程读, 简单类型靠 GIL
REG_KLINES = {}   # (symbol, duration) -> data_length
REG_TICKS = set()
REG_QUOTES = set()
REG_BOARD = {"on": False}

# 账户监控与策略运行是可选能力: 模块缺失/账户连不上都不能影响行情主链路
ACCT = None       # AccountHub 实例
STRAT = None      # StrategyHub 实例
LAST_USED = {}    # ("k",sym,dur) / ("t",sym) -> monotonic 时间戳

index_lock = threading.Lock()
SYMBOL_INDEX = []
SYMBOL_SET = set()
OPTION_SEEN = set()   # 期权链登记过的期权代码(旁路白名单, 不进 7071 条主索引)
INDEX_READY = threading.Event()
BAD_SYMBOLS = set()   # 订阅失败过的合约, 不再重试(否则每次都要等 30s 超时, 会卡死采集循环)

BOARD_ITEMS = []          # [{"s","u","n","ex","cats","catNames","night"}]
BOARD_META_JSON = '{"type":"board_meta","items":[]}'
BOARD_READY = threading.Event()

watch_lock = threading.Lock()

STATUS_OK = '{"ok":true,"err":null}'


# 自选支持多分组(多页面看板)。存盘格式:
#   {"version":2, "groups":[{"id":"g1","name":"自选","symbols":[...]}, ...]}
# 旧的扁平 list 会自动迁移成单个"自选"分组。
GROUPS = []


def _new_gid():
    return "g%d" % int(time.time() * 1000 % 1_000_000_000)


def load_groups():
    if WATCHLIST_FILE.exists():
        try:
            data = json.loads(WATCHLIST_FILE.read_text())
            if isinstance(data, list) and data:                 # v1 扁平格式 -> 迁移
                return [{"id": "g1", "name": "自选", "symbols": list(data)}]
            gs = data.get("groups") if isinstance(data, dict) else None
            if gs:
                out = []
                for g in gs:
                    if isinstance(g, dict) and g.get("symbols") is not None:
                        out.append({"id": str(g.get("id") or _new_gid()),
                                    "name": str(g.get("name") or "自选"),
                                    "symbols": [str(s) for s in g["symbols"]]})
                if out:
                    return out
        except Exception:
            pass
    return [{"id": "g1", "name": "自选", "symbols": list(DEFAULT_WATCHLIST)}]


def save_groups():
    WATCHLIST_FILE.write_text(json.dumps(
        {"version": 2, "groups": GROUPS}, ensure_ascii=False, indent=1))


def all_symbols():
    """所有分组的并集 —— 订阅按这个来, 前端切分组不需要重新订阅"""
    seen, out = set(), []
    for g in GROUPS:
        for s in g["symbols"]:
            if s not in seen:
                seen.add(s)
                out.append(s)
    return out


def groups_json():
    return json.dumps({"type": "watchlist", "groups": GROUPS}, ensure_ascii=False)


GROUPS = load_groups()
WATCHLIST = all_symbols()


def known_symbol(sym):
    """索引就绪后拿它当白名单: 不存在的合约会让 get_quote 阻塞 30s 拖死采集循环"""
    if sym in BAD_SYMBOLS:
        return False
    if not INDEX_READY.is_set():
        return True
    if sym in OPTION_SEEN:
        return True          # 期权不进主索引(2.6万个), 由期权链按需登记
    with index_lock:
        # 索引为空(缓存损坏等)时不拦, 否则会把用户整个自选都挡掉
        return (not SYMBOL_SET) or sym in SYMBOL_SET


def trading_seconds(q):
    """该合约每个交易日的秒数 —— 波动率年化要用它, 不同品种差很多
    (股指 4 小时 / 商品带夜盘可到 9.5 小时)"""
    try:
        tt = q.trading_time
        total = 0.0
        for seg in list(tt.day or []) + list(tt.night or []):
            a, b = seg[0], seg[1]
            hm = lambda s: sum(float(x) * m for x, m in zip(s.split(":"), (3600, 60, 1)))  # noqa: E731
            total += max(0.0, hm(b) - hm(a))
        return total if total > 600 else 5.5 * 3600
    except Exception:
        return 5.5 * 3600


def json_key(s):
    """手工拼 JSON 时给 key 转义: 含 " 或 \\ 的合约代码会产出非法 JSON 打断整条连接"""
    return s.replace("\\", "\\\\").replace('"', '\\"') if ('"' in s or "\\" in s) else s


def clean(v):
    """NaN/Inf -> None (json 不支持); 其他非基本类型转字符串"""
    if v is None or isinstance(v, (int, str, bool)):
        return v
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    return str(v)


def fin(v):
    try:
        return v is not None and math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def nlist(arr):
    """numpy float 数组 -> python list, NaN/Inf 变 None"""
    out = np.asarray(arr, dtype=float).tolist()
    return [x if math.isfinite(x) else None for x in out]


def ns_array(serial, col):
    """datetime 列取成 int64 纳秒(避免转 float 丢精度)"""
    a = serial[col].to_numpy()
    if a.dtype.kind in "iu":
        return a.astype("int64")
    a = np.asarray(a, dtype="float64")
    return np.where(np.isfinite(a), a, 0.0).astype("int64")


# ---------------- 合约索引 ----------------

def build_index(api):
    today = time.strftime("%Y-%m-%d")
    if SYMBOL_CACHE.exists():
        try:
            data = json.loads(SYMBOL_CACHE.read_text())
            if data.get("date") == today and data.get("index"):
                with index_lock:
                    SYMBOL_INDEX[:] = data["index"]
                    SYMBOL_SET.clear()
                    SYMBOL_SET.update(it["s"] for it in SYMBOL_INDEX)
                INDEX_READY.set()
                print(f"[idx] 缓存加载 {len(SYMBOL_INDEX)} 个合约", flush=True)
                return True
        except Exception:
            pass
    if api is None:
        return False
    print("[idx] 开始构建全市场索引(首次约10~30s)...", flush=True)
    ordered, seen = [], set()
    # FUND 必须收: ETF 期权的标的(510050/510300/159919 等)全是 FUND, 不收就搜不到
    for cls_ in ("CONT", "FUTURE", "INDEX", "STOCK", "FUND"):
        try:
            if cls_ == "FUTURE":
                syms = api.query_quotes(ins_class="FUTURE", expired=False)
            else:
                syms = api.query_quotes(ins_class=cls_)
        except Exception as e:
            print(f"[idx] query_quotes {cls_} 失败: {e}", flush=True)
            syms = []
        for s in syms:
            if s not in seen:
                seen.add(s)
                ordered.append((s, cls_))
    index = []
    BATCH = 500
    for i in range(0, len(ordered), BATCH):
        chunk = ordered[i:i + BATCH]
        clsmap = dict(chunk)
        try:
            df = api.query_symbol_info([s for s, _ in chunk])
            for _, r in df.iterrows():
                sym = r.get("instrument_id")
                if not sym:
                    continue
                tk = r.get("price_tick")
                index.append({
                    "s": sym,
                    "n": str(r.get("instrument_name") or ""),
                    "e": str(r.get("exchange_id") or sym.split(".")[0]),
                    "c": clsmap.get(sym, str(r.get("ins_class") or "")),
                    "tk": float(tk) if tk is not None and math.isfinite(float(tk)) else None,
                })
        except Exception as e:
            print(f"[idx] symbol_info 批次 {i} 失败: {e}", flush=True)
        if i % 2000 == 0:
            print(f"[idx] 进度 {min(i + BATCH, len(ordered))}/{len(ordered)}", flush=True)
    with index_lock:
        SYMBOL_INDEX[:] = index
        SYMBOL_SET.clear()
        SYMBOL_SET.update(it["s"] for it in index)
    INDEX_READY.set()
    SYMBOL_CACHE.write_text(json.dumps({"date": today, "index": index}, ensure_ascii=False))
    print(f"[idx] 索引完成 {len(index)} 个合约, 已缓存", flush=True)
    return True


def _publish_board(items):
    global BOARD_META_JSON
    BOARD_ITEMS[:] = items
    BOARD_META_JSON = json.dumps({"type": "board_meta", "items": items}, ensure_ascii=False)
    BOARD_READY.set()


def build_board(api):
    """主力合约看板元数据: 88 个主连 {s,u,n,ex,cats,catNames,night}"""
    today = time.strftime("%Y-%m-%d")
    if BOARD_CACHE.exists():
        try:
            data = json.loads(BOARD_CACHE.read_text())
            if data.get("date") == today and data.get("items"):
                _publish_board(data["items"])
                print(f"[board] 缓存加载 {len(BOARD_ITEMS)} 个主连", flush=True)
                return True
        except Exception:
            pass
    if api is None:
        return False
    t0 = time.time()
    conts = list(api.query_quotes(ins_class="CONT"))
    unders = list(api.query_cont_quotes())
    try:
        night_set = set(api.query_cont_quotes(has_night=True))
    except Exception as e:
        print(f"[board] has_night 查询失败: {e}", flush=True)
        night_set = set()
    pos_map = dict(zip(conts, unders))
    api.get_quote_list(conts)
    # 主连 quote 的 exchange_id/product_id/categories 都是空的, 必须从标的合约取
    qc = {s: api.get_quote(s) for s in conts}
    real_unders = []
    for s in conts:
        u = getattr(qc[s], "underlying_symbol", None)
        if not u or "." not in str(u):
            u = pos_map.get(s, "")
        real_unders.append(str(u))
    valid_u = [u for u in real_unders if u]
    if valid_u:
        api.get_quote_list(valid_u)
    qu = {u: api.get_quote(u) for u in valid_u}
    items = []
    for s, u in zip(conts, real_unders):
        name = str(getattr(qc[s], "instrument_name", "") or "")
        n = name[:-2] if name.endswith("主连") else name
        cats, cat_names = [], []
        q_u = qu.get(u)
        for c in (getattr(q_u, "categories", None) or []):
            try:
                cats.append(str(c["id"]))
                cat_names.append(str(c["name"]))
            except Exception:
                pass
        items.append({
            "s": s,
            "u": u,
            "n": n,
            "ex": u.split(".")[0] if "." in u else "",
            "cats": cats,
            "catNames": cat_names,
            "night": u in night_set,
        })
    _publish_board(items)
    BOARD_CACHE.write_text(json.dumps({"date": today, "items": items}, ensure_ascii=False))
    print(f"[board] 元数据完成 {len(items)} 个主连, 耗时 {time.time() - t0:.2f}s, 已缓存", flush=True)
    return True


def meta_worker(user, password):
    """一个独立 TqApi 顺序构建索引 + 看板元数据, 完事就关掉"""
    need_api = not build_index(None) or not build_board(None)
    if not need_api:
        return
    api = None
    try:
        api = TqApi(auth=TqAuth(user, password))
        build_index(api)
        build_board(api)
    except Exception:
        traceback.print_exc()
    finally:
        if api is not None:
            try:
                api.close()
            except Exception:
                pass


# 搜索结果的类别优先级: 越常用越靠前
CLASS_ORDER = {"CONT": 0, "FUTURE": 1, "INDEX": 2, "STOCK": 3, "FUND": 4, "OPTION": 5}


def search_index(text, limit=30):
    t = text.strip().lower()
    if not t:
        return []
    starts, sub_code, sub_name = [], [], []
    with index_lock:
        for it in SYMBOL_INDEX:
            code = it["s"].lower()
            # 主连是 KQ.m@SHFE.au 这种形状, 品种码在最后一段。只看第一个点之后
            # 会得到 "m@shfe.au", 搜 au 就匹配不上前缀, 主连被挤到子串桶里,
            # 排在一堆月份合约后面 —— 而用户搜 au 想要的正是沪金主连。
            short = code.split(".", 1)[-1]
            tail = code.rsplit(".", 1)[-1]
            if code.startswith(t) or short.startswith(t) or tail.startswith(t):
                starts.append(it)
            elif t in code:
                sub_code.append(it)
            elif t in it["n"].lower():
                sub_name.append(it)
        # 这里不能在循环里 break: 前缀桶一满就退出的话, 中文名匹配一条都进不来
        # (输 "a" 会被 au2608 这类短码瞬间填满 30 条), 用户按名字根本搜不到东西。
    # 三个桶各自按类别排序: 主连要排在一堆月份合约前面(搜 au 想要的是沪金主连),
    # 股票/场内基金排最后, 否则 5549+2489 条会把期货淹掉
    rank = lambda it: CLASS_ORDER.get(it.get("c"), 9)   # noqa: E731
    for b in (starts, sub_code, sub_name):
        b.sort(key=rank)
    return (starts + sub_code + sub_name)[:limit]


# ---------------- tick 开平性质增量引擎 ----------------

TICK_COLS = ("id", "datetime", "last_price", "volume", "open_interest",
             "bid_price1", "ask_price1", "bid_volume1", "ask_volume1")


class TickEngine:
    """把 500ms 快照差分成"成交行", 推断主动方向和开平性质。

    国内期货交易所不发逐笔成交, 只发快照, 所有行情软件都是这么推断的。
    CZCE 的 datetime 只到秒, 同一秒可能两条 -> 唯一键必须用 id, 且保持原始顺序。
    """

    def __init__(self):
        self.last_id = None
        self.prev = None        # (price, volume, oi, b1, a1)
        self.last_side = None
        self.rows = deque(maxlen=TICK_KEEP)
        self.dirty = True
        self.cached = "[]"
        self.hf_dirty = True
        self.hf_cache = None

    def process(self, serial):
        try:
            ids_raw = serial["id"].to_numpy()
        except Exception:
            return False
        if len(ids_raw) == 0:
            return False
        idsf = np.asarray(ids_raw, dtype=float)
        mask = np.isfinite(idsf) & (idsf >= 0)
        idx = np.flatnonzero(mask)
        if idx.size == 0:
            return False
        ids = idsf[idx]
        if self.last_id is not None:
            pos = int(np.searchsorted(ids, self.last_id + 0.5))
            if pos >= ids.size:
                return False
            idx = idx[pos:]
            ids = ids[pos:]
        cols = {}
        for c in TICK_COLS:
            if c == "datetime":
                continue
            try:
                cols[c] = np.asarray(serial[c].to_numpy(), dtype=float)[idx].tolist()
            except Exception:
                cols[c] = [float("nan")] * idx.size
        n = idx.size
        dts = ns_array(serial, "datetime")[idx].tolist()
        px = cols["last_price"]
        vols = cols["volume"]
        ois = cols["open_interest"]
        b1s, a1s = cols["bid_price1"], cols["ask_price1"]
        bv1s, av1s = cols["bid_volume1"], cols["ask_volume1"]
        changed = False
        for i in range(n):
            tid = int(ids[i])
            self.last_id = tid
            p, vol, oi = px[i], vols[i], ois[i]
            b1, a1, bv1, av1 = b1s[i], a1s[i], bv1s[i], av1s[i]
            dt = dts[i]
            cur = (p, vol, oi, b1, a1)
            if dt <= 0 or not (vol == vol):
                continue
            prev = self.prev
            self.prev = cur
            if prev is None:
                continue
            dvol = vol - prev[1]
            if dvol < 0:            # 跨交易日重置
                self.last_side = None
                continue
            if dvol == 0:           # 无成交, 基准仍推进
                continue
            doi_raw = (oi - prev[2]) if (oi == oi and prev[2] == prev[2]) else 0.0
            doi = max(-dvol, min(dvol, doi_raw))
            side = self._side(p, prev)
            nat = self._nature(dvol, doi, side)
            self.rows.append({
                "id": tid,
                "t": int(dt // 1_000_000),
                "p": None if p != p else p,
                "v": None if vol != vol else vol,
                "dv": dvol,
                "doi": doi,
                "side": side,
                "nat": nat,
                "b1": None if b1 != b1 else b1,
                "a1": None if a1 != a1 else a1,
                "bv1": None if bv1 != bv1 else bv1,
                "av1": None if av1 != av1 else av1,
                "oi": None if oi != oi else oi,
            })
            changed = True
        if changed:
            self.dirty = True
            self.hf_dirty = True
        return changed

    def hf(self, daily_sec=None):
        """高频指标 + 多周期波动率(C++ 计算)。只在有新成交行时重算。"""
        if HF is None or len(self.rows) < 3:
            return None
        if not getattr(self, "hf_dirty", True) and self.hf_cache is not None:
            return self.hf_cache
        r = list(self.rows)
        cols = lambda k: [x.get(k) for x in r]          # noqa: E731
        ts = cols("t")
        px = cols("p")
        m = HF.metrics(ts, px, cols("v"), cols("oi"),
                       cols("b1"), cols("a1"), cols("bv1"), cols("av1"))
        rv = HF.realized_vol(ts, px, VOL_HORIZONS, daily_sec=daily_sec)
        self.hf_cache = {"m": m, "rv": rv}
        self.hf_dirty = False
        return self.hf_cache

    def _side(self, p, prev):
        """成交发生在两次快照之间, 撮合时挂的是**上一笔**的盘口"""
        pp, _, _, pb, pa = prev
        if p == p and pb == pb and pa == pa and pb > 0 and pa > 0 and pa >= pb:
            if p >= pa:
                self.last_side = "B"
                return "B"
            if p <= pb:
                self.last_side = "S"
                return "S"
            mid = (pa + pb) / 2.0
            if p > mid:
                self.last_side = "B"
                return "B"
            if p < mid:
                self.last_side = "S"
                return "S"
        # 盘口无效或恰在中价 -> 回退 tick rule
        if p == p and pp == pp:
            if p > pp:
                self.last_side = "B"
                return "B"
            if p < pp:
                self.last_side = "S"
                return "S"
            if self.last_side:
                return self.last_side
        return "N"

    @staticmethod
    def _nature(dvol, doi, side):
        if doi == dvol:
            return "双开"
        if doi == -dvol:
            return "双平"
        if doi == 0:
            return {"B": "多换", "S": "空换"}.get(side, "换手")
        if doi > 0:
            return {"B": "多开", "S": "空开"}.get(side, "双开")
        return {"B": "空平", "S": "多平"}.get(side, "双平")

    def json(self):
        return json.dumps(list(self.rows), ensure_ascii=False)


# ---------------- K 线向量化序列化 ----------------

def kline_sig(serial):
    """便宜的脏标记: 最后一根的 id/收/量/仓 + 长度"""
    try:
        return (
            len(serial),
            float(serial["id"].iloc[-1]),
            float(serial["datetime"].iloc[-1]),
            float(serial["close"].iloc[-1]),
            float(serial["volume"].iloc[-1]),
            float(serial["close_oi"].iloc[-1]),
        )
    except Exception:
        return None


def kline_json(serial):
    ids = np.asarray(serial["id"].to_numpy(), dtype=float)
    dtns = ns_array(serial, "datetime")
    mask = np.isfinite(ids) & (ids >= 0) & (dtns > 0)
    if not mask.any():
        return "[]"
    t = (dtns[mask] // 1_000_000_000).tolist()
    o = nlist(serial["open"].to_numpy()[mask])
    h = nlist(serial["high"].to_numpy()[mask])
    lo = nlist(serial["low"].to_numpy()[mask])
    c = nlist(serial["close"].to_numpy()[mask])
    v = nlist(serial["volume"].to_numpy()[mask])
    oi = nlist(serial["close_oi"].to_numpy()[mask])
    rows = [{"t": t_, "o": o_, "h": h_, "l": l_, "c": c_, "v": v_, "oi": oi_}
            for t_, o_, h_, l_, c_, v_, oi_ in zip(t, o, h, lo, c, v, oi)]
    return json.dumps(rows)


# ---------------- quote 序列化 ----------------

TT_CACHE = {}


def trading_time_of(sym, q):
    """quote.trading_time 是 TradingTime 对象, 要转成可 json 的 dict; 按合约缓存"""
    if sym in TT_CACHE:
        return TT_CACHE[sym]
    tt = getattr(q, "trading_time", None)
    if tt is None:
        return None
    try:
        day = [list(x) for x in (list(tt.day) or [])]
        night = [list(x) for x in (list(tt.night) or [])]
    except Exception:
        return None
    if not day and not night:
        return None
    val = {"day": day, "night": night}
    TT_CACHE[sym] = val
    return val


def quote_json(sym, q):
    d = {f: clean(getattr(q, f, None)) for f in QUOTE_FIELDS}
    d["trading_time"] = trading_time_of(sym, q)
    return json.dumps(d, ensure_ascii=False)


BOARD_FIELDS_DEFAULT = {"lp": None, "pre": None, "oi": None, "vol": None,
                        "b": None, "a": None, "u": ""}


def board_json(board_objs):
    out = {}
    for sym, q in board_objs.items():
        pre = getattr(q, "pre_settlement", None)
        if not fin(pre):
            pre = getattr(q, "pre_close", None)
        out[sym] = {
            "lp": clean(getattr(q, "last_price", None)),
            "pre": clean(pre),
            "oi": clean(getattr(q, "open_interest", None)),
            "vol": clean(getattr(q, "volume", None)),
            "b": clean(getattr(q, "bid_price1", None)),
            "a": clean(getattr(q, "ask_price1", None)),
            "u": str(getattr(q, "underlying_symbol", "") or ""),
        }
    return json.dumps(out, ensure_ascii=False)


# ---------------- TqSdk 采集线程 ----------------

def set_status(ok, err=None):
    js = STATUS_OK if ok else json.dumps({"ok": False, "err": str(err)[:400]}, ensure_ascii=False)
    with state_lock:
        STATE["status_json"] = js
        STATE["ts"] = time.time()


def default_len(dur):
    return KLINE_LEN_DAY if dur >= 86400 else KLINE_LEN_DEFAULT


def tq_worker():
    user, password = load_auth()
    threading.Thread(target=meta_worker, args=(user, password), daemon=True, name="meta").start()
    with watch_lock:
        for s in WATCHLIST:
            REG_QUOTES.add(s)
    while True:
        api = None
        try:
            api = TqApi(auth=TqAuth(user, password))
            quotes, klines, ticks, board_objs = {}, {}, {}, {}
            engines = {}
            kl_cache, kl_sigs = {}, {}
            # 按注册表恢复订阅(索引一般是当日缓存, 秒回; 用它挡掉不存在的合约)
            INDEX_READY.wait(10)
            for s in list(REG_QUOTES):
                if not known_symbol(s):
                    print(f"[tq] 跳过未知合约 {s}", flush=True)
                    REG_QUOTES.discard(s)
                    continue
                try:
                    quotes[s] = api.get_quote(s)
                except Exception as e:
                    print(f"[tq] 恢复行情 {s} 失败: {e}", flush=True)
                    REG_QUOTES.discard(s)
            for (s, d), ln in list(REG_KLINES.items()):
                try:
                    klines[(s, d)] = (api.get_kline_serial(s, d, data_length=ln), ln)
                except Exception as e:
                    print(f"[tq] 恢复K线 {s}|{d} 失败: {e}", flush=True)
                    REG_KLINES.pop((s, d), None)
            for s in list(REG_TICKS):
                try:
                    ticks[s] = api.get_tick_serial(s, data_length=TICK_LEN)
                    engines[s] = TickEngine()
                except Exception as e:
                    print(f"[tq] 恢复Tick {s} 失败: {e}", flush=True)
                    REG_TICKS.discard(s)
            print(f"[tq] 已连接, 行情{len(quotes)} K线{len(klines)} Tick{len(ticks)}", flush=True)
            set_status(True)

            while True:
                t_round = time.time()
                api.wait_update(deadline=t_round + COLLECT_GAP)

                # ---- 指令(限流: 保证每轮都能刷新 STATE.ts, 前端才不会误判线程卡死) ----
                for _ in range(MAX_CMDS_PER_ROUND):
                    if cmd_queue.empty():
                        break
                    c = cmd_queue.get()
                    sym0 = c.get("symbol", "")
                    if sym0 in BAD_SYMBOLS:
                        continue
                    try:
                        cmd = c["cmd"]
                        if cmd == "kline":
                            sym, dur = c["symbol"], c["duration"]
                            ln = c.get("length") or default_len(dur)
                            key = (sym, dur)
                            cur = klines.get(key)
                            if cur is None or ln > cur[1]:
                                klines[key] = (api.get_kline_serial(sym, dur, data_length=ln), ln)
                                REG_KLINES[key] = ln
                                kl_sigs.pop(f"{sym}|{dur}", None)
                                print(f"[tq] 订阅K线 {sym}|{dur} x{ln}", flush=True)
                        elif cmd == "tick":
                            sym = c["symbol"]
                            if sym not in ticks:
                                ticks[sym] = api.get_tick_serial(sym, data_length=TICK_LEN)
                                engines[sym] = TickEngine()
                                REG_TICKS.add(sym)
                                print(f"[tq] 订阅Tick {sym}", flush=True)
                        elif cmd == "quote":
                            sym = c["symbol"]
                            if sym not in quotes:
                                quotes[sym] = api.get_quote(sym)
                                REG_QUOTES.add(sym)
                                print(f"[tq] 订阅行情 {sym}", flush=True)
                        elif cmd == "unquote":
                            sym = c["symbol"]
                            REG_QUOTES.discard(sym)
                            with watch_lock:
                                wl = set(WATCHLIST)
                            if sym not in wl:
                                quotes.pop(sym, None)
                    except Exception as e:
                        # 拉黑: 不存在的合约每次都要等 30s 超时, 重试会拖死整个采集循环
                        if sym0:
                            BAD_SYMBOLS.add(sym0)
                            REG_QUOTES.discard(sym0)
                            REG_TICKS.discard(sym0)
                            REG_KLINES.pop((sym0, c.get("duration")), None)
                        print(f"[tq] 指令失败 {c}: {e} (已拉黑 {sym0})", flush=True)

                # ---- 看板订阅(元数据就绪后一次性挂上 88 个主连) ----
                if REG_BOARD["on"] and BOARD_READY.is_set() and not board_objs:
                    syms = [it["s"] for it in BOARD_ITEMS]
                    try:
                        api.get_quote_list(syms)
                        for s in syms:
                            board_objs[s] = api.get_quote(s)
                        print(f"[tq] 看板订阅 {len(board_objs)} 个主连", flush=True)
                    except Exception as e:
                        print(f"[tq] 看板订阅失败: {e}", flush=True)
                        board_objs.clear()

                now = time.monotonic()

                # ---- LRU 淘汰 ----
                for key, (serial, ln) in list(klines.items()):
                    lu = LAST_USED.get(("k", key[0], key[1]), 0.0)
                    if now - lu > LRU_TTL:
                        klines.pop(key, None)
                        REG_KLINES.pop(key, None)
                        k = f"{key[0]}|{key[1]}"
                        kl_cache.pop(k, None)
                        kl_sigs.pop(k, None)
                for sym in list(ticks):
                    if now - LAST_USED.get(("t", sym), 0.0) > LRU_TTL:
                        ticks.pop(sym, None)
                        engines.pop(sym, None)
                        REG_TICKS.discard(sym)

                # ---- 序列化 ----
                qj = {}
                for sym, q in quotes.items():
                    try:
                        qj[sym] = quote_json(sym, q)
                    except Exception:
                        qj[sym] = "null"

                # 只序列化"有人正在看"的序列(broadcaster 每 0.5s 给 focus 打时间戳),
                # 其余仍保持订阅但零开销 —— 这是浏览过几十个合约后不卡的关键
                for (sym, dur), (serial, ln) in klines.items():
                    if now - LAST_USED.get(("k", sym, dur), 0.0) > HOT_WINDOW:
                        continue
                    key = f"{sym}|{dur}"
                    sig = kline_sig(serial)
                    if sig is not None and kl_sigs.get(key) == sig:
                        continue  # 没变, 不重新序列化(收盘时段完全不重算)
                    try:
                        kl_cache[key] = kline_json(serial)
                        kl_sigs[key] = sig
                    except Exception as e:
                        print(f"[tq] K线序列化失败 {key}: {e}", flush=True)

                tj = {}
                hfj = {}
                for sym, serial in ticks.items():
                    eng = engines.get(sym)
                    if eng is None:
                        continue
                    try:
                        eng.process(serial)
                    except Exception as e:
                        print(f"[tq] tick 处理失败 {sym}: {e}", flush=True)
                    if now - LAST_USED.get(("t", sym), 0.0) > HOT_WINDOW:
                        continue  # 引擎照常增量推进, 但不做 300 行 json
                    if eng.dirty:
                        eng.cached = eng.json()
                        eng.dirty = False
                    tj[sym] = eng.cached
                    try:
                        dsec = trading_seconds(quotes.get(sym))
                        hf = eng.hf(daily_sec=dsec)
                        if hf:
                            # tick 窗口只有 300 笔(约5分钟), 只够算 30s/60s 尺度。
                            # 5 分钟以上的波动率改用 1 分钟 K 线序列来算。
                            _kv = klines.get((sym, 60))       # 存的是 (serial, length)
                            kser = _kv[0] if _kv else None
                            if kser is not None and HF is not None:
                                long_h = [h for h in VOL_HORIZONS if h >= 300]
                                if long_h:
                                    try:
                                        dt = ns_array(kser, "datetime") // 1_000_000
                                        cl = nlist(kser["close"].to_numpy())
                                        keep = [(int(dt[i]), cl[i]) for i in range(len(cl))
                                                if dt[i] > 0 and cl[i]]
                                        if len(keep) > 10:
                                            rv2 = HF.realized_vol(
                                                [x[0] for x in keep], [x[1] for x in keep],
                                                long_h, lookback_mult=60, daily_sec=dsec)
                                            # 不能用 dict(a, **b): rv 的 key 是 int, ** 只收字符串 key
                                            merged = dict(hf["rv"])
                                            merged.update(rv2)
                                            hf = {"m": hf["m"], "rv": merged}
                                        else:
                                            print(f"[hf] {sym} 分钟线可用点太少: {len(keep)}", flush=True)
                                    except Exception as e:      # noqa: BLE001
                                        print(f"[hf] {sym} 长周期波动率失败: {type(e).__name__}: {e}", flush=True)
                            hfj[sym] = json.dumps(hf, ensure_ascii=False)
                    except Exception as e:                       # noqa: BLE001
                        print(f"[hf] {sym} 计算失败: {e}", flush=True)

                bj = board_json(board_objs) if board_objs else "{}"

                with state_lock:
                    STATE["ts"] = time.time()
                    STATE["status_json"] = STATUS_OK
                    STATE["quotes_json"] = qj
                    STATE["kl_json"] = dict(kl_cache)
                    STATE["tick_json"] = tj
                    STATE["hf_json"] = hfj
                    STATE["board_json"] = bj
                signal_snapshot()      # 立刻叫醒 broadcaster, 不等它自己的定时器

                slow = time.time() - t_round
                if slow > 1.5:
                    print(f"[tq] 慢循环 {slow:.2f}s (行情{len(quotes)} K线{len(klines)} "
                          f"Tick{len(ticks)} 看板{len(board_objs)})", flush=True)
        except Exception as e:
            traceback.print_exc()
            set_status(False, e)
            print(f"[tq] 采集线程异常, {RECONNECT_WAIT}s 后重连: {e}", flush=True)
            if api is not None:
                try:
                    api.close()
                except Exception:
                    pass
            time.sleep(RECONNECT_WAIT)


# ---------------- WebSocket ----------------

async def broadcast(app, payload):
    text = json.dumps(payload, ensure_ascii=False)
    for ws in list(app["clients"]):
        try:
            await ws.send_str(text)
        except Exception:
            app["clients"].discard(ws)
            app["conns"].pop(ws, None)
            sync_board_reg(app)


def focus_keys(conn):
    """本连接当前需要推送的 (symbol, duration) 列表。主图永远排第一且不被淘汰。"""
    main = conn.get("main")
    ov = [k for k in (conn.get("overlay") or []) if k != main]
    return ([main] if main else []) + ov[-(FOCUS_MAX - 1):]


def sync_board_reg(app):
    REG_BOARD["on"] = any(c.get("board") for c in app["conns"].values())


def touch_focus(conn):
    now = time.monotonic()
    for f in focus_keys(conn):
        LAST_USED[("k", f[0], f[1])] = now
    t = conn.get("tick")
    if t:
        LAST_USED[("t", t)] = now


def sub_symbol(sym, dur, length=None):
    if not known_symbol(sym):
        print(f"[ws] 忽略未知合约 {sym}", flush=True)
        return
    if dur == 0:
        cmd_queue.put({"cmd": "tick", "symbol": sym})
        LAST_USED[("t", sym)] = time.monotonic()
    else:
        cmd_queue.put({"cmd": "kline", "symbol": sym, "duration": dur, "length": length})
        LAST_USED[("k", sym, dur)] = time.monotonic()
    cmd_queue.put({"cmd": "quote", "symbol": sym})


async def ws_handler(request):
    app = request.app
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    # focus 是列表: 主图一条 + 叠加对比的 N 条
    # 主图和叠加/多图分开存。原来共用一个 focus 列表, 溢出时从列表头淘汰,
    # 而主图恰好在索引 0 —— 自选看板开两个多图分区就能把主图挤掉, 之后
    # touch_focus 不再给它打时间戳, HOT_WINDOW 直接跳过序列化, 主图静止不动。
    conn = {"main": None, "overlay": [], "tick": None, "board": False,
            "acct": False, "strat": False}
    app["clients"].add(ws)
    app["conns"][ws] = conn
    with watch_lock:
        cfg = json.dumps({"type": "config", "groups": GROUPS,
                          "watchlist": all_symbols()}, ensure_ascii=False)
    await ws.send_str(cfg)
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            action = data.get("action")
            try:
                if action in ("subscribe", "focus"):
                    sym = str(data.get("symbol", "")).strip()
                    if not sym:
                        continue
                    dur = int(data.get("duration", 60))
                    ln = data.get("length")
                    ln = int(ln) if ln else None
                    if ln:
                        ln = max(50, min(KLINE_LEN_MAX, ln))
                    if dur == 0:
                        conn["tick"] = sym
                    elif data.get("overlay"):
                        # 叠加/多图/自选看板: 进 overlay 队列, 满了淘汰最旧的一条
                        key = (sym, dur)
                        if key not in conn["overlay"]:
                            conn["overlay"].append(key)
                            cap = FOCUS_MAX - 1
                            while len(conn["overlay"]) > cap:
                                gone = conn["overlay"].pop(0)
                                # 静默少推是最难查的故障, 明确告诉前端谁被挤掉了
                                await ws.send_str(json.dumps(
                                    {"type": "warn", "code": "focus_evicted",
                                     "symbol": gone[0], "duration": gone[1],
                                     "msg": f"同时订阅的K线超过 {FOCUS_MAX} 路, {gone[0]} 已停止推送"},
                                    ensure_ascii=False))
                    else:
                        conn["main"] = (sym, dur)          # 主图独占一格, 不参与淘汰
                    sub_symbol(sym, dur, ln)
                elif action == "unfocus":
                    sym = str(data.get("symbol", "")).strip()
                    conn["overlay"] = [k for k in conn["overlay"] if k[0] != sym]
                    if conn["main"] and conn["main"][0] == sym:
                        conn["main"] = None
                elif action == "rangestats":
                    # 框选区间统计 —— C++ 算, 数据量小直接同步返回
                    req = str(data.get("req", ""))
                    try:
                        b = data.get("bars") or []
                        col = lambda k: [x.get(k) for x in b]   # noqa: E731
                        res = HF.range_stats(col("o"), col("h"), col("l"), col("c"),
                                             col("v"), col("oi"),
                                             bar_sec=float(data.get("bar_sec") or 60),
                                             daily_sec=data.get("daily_sec")) if HF else None
                        await ws.send_json({"type": "rangestats", "req": req,
                                            "stats": res, "engine": HF.state() if HF else None})
                    except Exception as e:                        # noqa: BLE001
                        await ws.send_json({"type": "err", "req": req, "msg": str(e)})
                elif action in ("acct_list", "acct_nav", "acct_trades", "acct_orders",
                                "strat_list", "strat_start", "strat_stop",
                                "strat_log", "strat_files"):
                    req = str(data.get("req", ""))
                    if not req:
                        continue
                    # 这些调用只读内存态或小文件, 微秒级, 不必进重活队列
                    try:
                        res = do_trade_req(action, data)
                    except Exception as e:
                        res = {"type": "err", "msg": f"{type(e).__name__}: {e}"}
                    res["req"] = req
                    await ws.send_json(res)
                elif action in ("history", "optchain", "optunderlyings", "fund"):
                    # 请求-响应型: 丢给重活线程, 立刻返回不阻塞本连接的读循环
                    req = str(data.get("req", ""))
                    if not req:
                        continue
                    heavy_queue.put((action, ws, req, data))
                elif action == "acct_sub":
                    conn["acct"] = bool(data.get("on", True))
                elif action == "strat_sub":
                    conn["strat"] = bool(data.get("on", True))
                elif action == "board":
                    on = bool(data.get("on", True))
                    conn["board"] = on
                    # 引用计数: 只改自己那一份, 是否继续采集看还有没有别人在用。
                    # 否则 A 标签页离开会把 B 标签页的看板数据一起掐掉。
                    sync_board_reg(app)
                    if on:
                        if not BOARD_READY.is_set():
                            await asyncio.get_running_loop().run_in_executor(
                                None, BOARD_READY.wait, 60)
                        await ws.send_str(BOARD_META_JSON)
                elif action == "search":
                    q = data.get("text", "")
                    if not INDEX_READY.is_set():
                        await ws.send_json({"type": "search_result", "q": q,
                                            "building": True, "results": []})
                    else:
                        # 去掉 break 之后每次都是确定性的 9560 次全表遍历, 在协程里
                        # 同步跑会把所有客户端的行情推送一起卡住 —— 丢给线程池
                        # (search_index 内部持 index_lock, 线程安全)
                        hits = await asyncio.get_running_loop().run_in_executor(
                            None, search_index, q)
                        await ws.send_json({"type": "search_result", "q": q, "results": hits})
                elif action in ("watchlist_add", "watchlist_remove", "group_create",
                                "group_delete", "group_rename", "group_reorder"):
                    changed, adds, dels = apply_group_action(action, data)
                    for s in adds:
                        cmd_queue.put({"cmd": "quote", "symbol": s})
                    for s in dels:
                        cmd_queue.put({"cmd": "unquote", "symbol": s})
                    if changed:
                        await broadcast_raw(app, groups_json())
            except Exception as e:
                print(f"[ws] 处理 {action} 失败: {e}", flush=True)
    finally:
        app["clients"].discard(ws)
        app["conns"].pop(ws, None)
        sync_board_reg(app)
    return ws


# 静态资源加版本戳: aiohttp 的 add_static 不发 Cache-Control, 浏览器会按启发式规则
# 自行缓存 js/css 却每次重取 index.html。新 html + 旧 js 混搭会让 app.js 在找不到
# 的元素上抛异常直接整个挂掉(页面全空、WS 都连不上), 所以按 mtime 打戳强制对齐。
_ASSET_RE = re.compile(r'(src|href)="(/static/[^"?]+\.(?:js|css))"')


def _stamp(m):
    attr, path = m.group(1), m.group(2)
    try:
        v = int((STATIC_DIR / path[len("/static/"):]).stat().st_mtime)
    except OSError:
        return m.group(0)
    return '%s="%s?v=%d"' % (attr, path, v)


async def index_handler(request):
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return web.Response(text=_ASSET_RE.sub(_stamp, html), content_type="text/html",
                        headers={"Cache-Control": "no-store"})


def precompress_static():
    """启动时把 static 下的 js/css 预压成同名 .gz。
    aiohttp 的 FileResponse 在 Accept-Encoding 含 gzip 时会自动挑同名 .gz 走
    sendfile, 不需要压缩中间件(那样每次请求现压一遍还会绕开 sendfile)。
    按 mtime 判断重生成 —— 改了源文件却发旧 .gz 会非常难查。"""
    import gzip
    n = saved = 0
    for src in list(STATIC_DIR.glob("*.js")) + list(STATIC_DIR.glob("*.css")):
        gz = src.with_suffix(src.suffix + ".gz")
        try:
            if gz.exists() and gz.stat().st_mtime >= src.stat().st_mtime:
                continue
            raw = src.read_bytes()
            gz.write_bytes(gzip.compress(raw, 9))
            n += 1
            saved += len(raw) - gz.stat().st_size
        except OSError as e:
            print(f"[static] 压缩 {src.name} 失败: {e}", flush=True)
    if n:
        print(f"[static] 预压缩 {n} 个文件, 省 {saved / 1024:.0f}KB", flush=True)


@web.middleware
async def no_cache_static(request, handler):
    resp = await handler(request)
    if request.path.startswith("/static/"):
        # 带 ?v= 的请求可以放心长缓存; 不带的(旧页面留下的)必须每次回源校验
        resp.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if request.query.get("v") else "no-cache")
    return resp


def build_payload(snap, wl_chunk, wl_set, conn, board_cache):
    qj = snap["quotes_json"]
    parts = ['{"type":"data","ts":', repr(round(snap["ts"], 3)),
             ',"status":', snap["status_json"], ',"quotes":{', wl_chunk]
    extra = []
    keys = focus_keys(conn)
    for sym in {k[0] for k in keys} | {conn["tick"]}:
        if sym and sym not in wl_set and sym in qj:
            extra.append('"%s":%s' % (json_key(sym), qj[sym]))
    if extra:
        if wl_chunk:
            parts.append(",")
        parts.append(",".join(extra))
    parts.append('},"klines":{')
    kl_chunk = []
    for sym, dur in keys:
        key = f"{sym}|{dur}"
        body = snap["kl_json"].get(key)
        if body:
            kl_chunk.append('"%s":%s' % (json_key(key), body))
    parts.append(",".join(kl_chunk))
    parts.append('},"ticks":{')
    t = conn["tick"]
    if t:
        body = snap["tick_json"].get(t)
        if body:
            parts.append('"%s":%s' % (json_key(t), body))
    parts.append("}")
    if t:
        hf = snap["hf_json"].get(t)
        if hf:
            parts.append(',"hf":')
            parts.append(hf)
    if conn["board"]:
        parts.append(',"board":')
        parts.append(board_cache)
    if conn.get("acct") and ACCT is not None:
        js = ACCT.snapshot_json()
        if js:
            parts.append(',"acct":')
            parts.append(js)
    if conn.get("strat") and STRAT is not None:
        js = STRAT.snapshot_json()
        if js:
            parts.append(',"strat":')
            parts.append(js)
    parts.append("}")
    return "".join(parts)


# ---------------- 重活线程: 历史下载 / 期权链 / Tushare ----------------
# 这些调用会阻塞几秒到几十秒, 绝不能放在采集线程(会冻住整个终端)或事件循环里
# (TqSdk 明确禁止在协程中调用 get_kline_data_series)。
heavy_queue = queue.Queue()
HEAVY_INFLIGHT = {}       # 去重: cache_key -> [(ws, req), ...]
heavy_lock = threading.Lock()


def ws_reply(ws, obj):
    """从 worker 线程给某条 ws 直接回一帧(不走 0.5s 广播通道)"""
    if MAIN_LOOP is None:
        return
    payload = json.dumps(obj, ensure_ascii=False, default=str)
    try:
        asyncio.run_coroutine_threadsafe(_safe_send(ws, payload), MAIN_LOOP)
    except RuntimeError:
        pass


async def _safe_send(ws, payload):
    try:
        if not ws.closed:
            await ws.send_str(payload)
    except Exception:
        pass


def heavy_worker():
    """独立长驻 TqApi(不订阅任何行情, 避免登录 9~10s 的重复开销)"""
    api = None
    while True:
        try:
            job = heavy_queue.get()
            kind, ws, req, payload = job
            try:
                if kind == "history":
                    if api is None:
                        api = TqApi(auth=TqAuth(*load_auth()), _stock=True)
                        print("[hist] 历史下载 TqApi 就绪", flush=True)
                    res = do_history(api, payload)
                elif kind == "optchain":
                    if api is None:
                        api = TqApi(auth=TqAuth(*load_auth()), _stock=True)
                    res = do_optchain(api, payload)
                elif kind == "optunderlyings":
                    if api is None:
                        api = TqApi(auth=TqAuth(*load_auth()), _stock=True)
                    res = do_optunderlyings(api)
                elif kind == "fund":
                    res = do_fund(payload)
                else:
                    res = {"type": "err", "msg": f"未知任务 {kind}"}
            except Exception as e:                       # noqa: BLE001
                traceback.print_exc()
                res = {"type": "err", "msg": f"{type(e).__name__}: {e}"}
                if kind in ("history", "optchain", "optunderlyings") and api is not None:
                    try:
                        api.close()
                    except Exception:
                        pass
                    api = None                            # 下次重建
            res["req"] = req
            ws_reply(ws, res)
        except Exception:
            traceback.print_exc()
            time.sleep(1)


def do_history(api, p):
    from datetime import date as _date
    sym = str(p.get("symbol", ""))
    dur = int(p.get("duration", 86400))
    if not known_symbol(sym):
        return {"type": "err", "msg": f"未知合约 {sym}"}

    def parse(s, dflt):
        try:
            y, m, d = str(s).split("-")
            return _date(int(y), int(m), int(d))
        except Exception:
            return dflt
    today = _date.today()
    start = parse(p.get("start"), _date(today.year - 10, 1, 1))
    end = parse(p.get("end"), today)
    df = api.get_kline_data_series(symbol=sym, duration_seconds=dur, start_dt=start, end_dt=end)
    if df is None or not len(df):
        return {"type": "history", "symbol": sym, "duration": dur, "rows": []}
    cols = df.columns
    dt = ns_array(df, "datetime") // 1_000_000_000
    o, h, l_, c = (nlist(df[k].to_numpy()) for k in ("open", "high", "low", "close"))
    v = nlist(df["volume"].to_numpy()) if "volume" in cols else [None] * len(df)
    oi = nlist(df["close_oi"].to_numpy()) if "close_oi" in cols else [None] * len(df)
    rows = [{"t": int(dt[i]), "o": o[i], "h": h[i], "l": l_[i], "c": c[i], "v": v[i], "oi": oi[i]}
            for i in range(len(df)) if dt[i] > 0]
    return {"type": "history", "symbol": sym, "duration": dur, "rows": rows}


def do_optchain(api, p):
    if OPT is None:
        return {"type": "err", "msg": "期权引擎未加载"}
    u = str(p.get("underlying", ""))
    chain = OPT.build_chain(api, u)
    OPTION_SEEN.update(OPT.seen_symbols())      # 让这些期权能被订阅(白名单旁路)
    stats = OPT.chain_stats(chain)
    return {"type": "optchain", "underlying": u, "u": chain.get("u"),
            "months": chain.get("months"), "model": chain.get("model"), "stats": stats}


def do_optunderlyings(api):
    if OPT is None:
        return {"type": "err", "msg": "期权引擎未加载"}
    items = OPT.build_underlyings(api, verbose=False)
    return {"type": "optunderlyings", "items": items}


def do_trade_req(action, p):
    """账户/策略的请求-响应。都是读内存或小文件, 直接在事件循环里跑。"""
    if action.startswith("acct"):
        if ACCT is None:
            return {"type": "err", "msg": "账户监控未启用(检查 market_wall/account.py 与 accounts.json)"}
        if action == "acct_list":
            return {"type": "acct_list", "accounts": ACCT.list_accounts()}
        if action == "acct_nav":
            return ACCT.nav(str(p.get("id", "")), int(p.get("days") or 0))
        if action == "acct_trades":
            return ACCT.trades(str(p.get("id", "")), int(p.get("limit") or 200))
        if action == "acct_orders":
            return ACCT.orders(str(p.get("id", "")))
    if action.startswith("strat"):
        if STRAT is None:
            return {"type": "err", "msg": "策略运行器未启用"}
        if action == "strat_list":
            return {"type": "strat_list", "items": STRAT.list()}
        if action == "strat_files":
            return {"type": "strat_files", "files": STRAT.files()}
        if action == "strat_log":
            return {"type": "strat_log", "id": str(p.get("id", "")),
                    "lines": STRAT.log(str(p.get("id", "")), int(p.get("limit") or 300))}
        if action == "strat_start":
            return STRAT.start(str(p.get("file", "")), p.get("init_balance"))
        if action == "strat_stop":
            return STRAT.stop(str(p.get("id", "")))
    return {"type": "err", "msg": f"未知 action {action}"}


def do_fund(p):
    if TS is None:
        return {"type": "err", "msg": "Tushare 适配层未加载(检查 market_wall/tushare.env)"}
    kind = str(p.get("kind", ""))
    res = TS.dispatch(kind, p.get("args") or {})
    if isinstance(res, dict) and res.get("err"):
        return {"type": "err", "msg": res["err"]}
    return {"type": "fund", "kind": kind, "cols": res.get("cols", []), "rows": res.get("rows", [])}


def apply_group_action(action, data):
    """自选分组的增删改。返回 (是否有变化, 新增订阅, 取消订阅)"""
    global WATCHLIST
    sym = str(data.get("symbol", "")).strip()
    gid = str(data.get("group", "")).strip()
    with watch_lock:
        before = set(all_symbols())
        changed = False
        if action == "watchlist_add":
            if not sym or not known_symbol(sym):
                return False, (), ()
            g = next((x for x in GROUPS if x["id"] == gid), None) or (GROUPS[0] if GROUPS else None)
            if g is None:
                GROUPS.append({"id": _new_gid(), "name": "自选", "symbols": []})
                g = GROUPS[0]
            if sym not in g["symbols"]:
                g["symbols"].append(sym)
                changed = True
        elif action == "watchlist_remove":
            targets = [x for x in GROUPS if x["id"] == gid] if gid else GROUPS
            for g in targets:
                if sym in g["symbols"]:
                    g["symbols"].remove(sym)
                    changed = True
        elif action == "group_create":
            name = str(data.get("name", "")).strip() or "新分组"
            GROUPS.append({"id": _new_gid(), "name": name[:16], "symbols": []})
            changed = True
        elif action == "group_delete":
            if len(GROUPS) > 1:
                n = len(GROUPS)
                GROUPS[:] = [x for x in GROUPS if x["id"] != gid]
                changed = len(GROUPS) != n
        elif action == "group_rename":
            g = next((x for x in GROUPS if x["id"] == gid), None)
            name = str(data.get("name", "")).strip()
            if g and name:
                g["name"] = name[:16]
                changed = True
        elif action == "group_reorder":
            order = [str(x) for x in (data.get("order") or [])]
            if order:
                idx = {g["id"]: g for g in GROUPS}
                new = [idx[i] for i in order if i in idx]
                if len(new) == len(GROUPS):
                    GROUPS[:] = new
                    changed = True
        if not changed:
            return False, (), ()
        save_groups()
        after = set(all_symbols())
        WATCHLIST = all_symbols()
        return True, tuple(after - before), tuple(before - after)


async def broadcast_raw(app, payload):
    for ws in list(app["clients"]):
        try:
            if not ws.closed:
                await ws.send_str(payload)
        except Exception:
            app["clients"].discard(ws)


async def broadcaster(app):
    """事件驱动: 采集线程一更新快照就推, 不再用独立定时器。
    以前采集(0.5s)和推送(0.5s)是两个不同步的周期, 叠加起来最坏有 1 秒延迟。"""
    last_push = 0.0
    while True:
        try:
            await asyncio.wait_for(SNAP_EVENT.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            pass          # 静默期(收盘)也定期推一次, 让前端的 ts 心跳不中断
        SNAP_EVENT.clear()
        # 下限节流: 行情密集时不至于把 CPU 打满, 但 60ms 远小于人眼可感知的延迟
        gap = time.monotonic() - last_push
        if gap < MIN_PUSH_GAP:
            await asyncio.sleep(MIN_PUSH_GAP - gap)
        last_push = time.monotonic()
        clients = list(app["clients"])
        if not clients:
            continue
        with state_lock:
            snap = {
                "ts": STATE["ts"],
                "status_json": STATE["status_json"],
                "quotes_json": STATE["quotes_json"],
                "kl_json": STATE["kl_json"],
                "tick_json": STATE["tick_json"],
                "hf_json": STATE["hf_json"],
                "board_json": STATE["board_json"],
            }
        with watch_lock:
            wl = list(WATCHLIST)
        qj = snap["quotes_json"]
        wl_present = [s for s in wl if s in qj]
        wl_chunk = ",".join('"%s":%s' % (json_key(s), qj[s]) for s in wl_present)
        wl_set = set(wl_present)
        board_cache = snap["board_json"]
        for ws in clients:
            conn = app["conns"].get(ws)
            if conn is None:
                continue
            touch_focus(conn)
            try:
                await ws.send_str(build_payload(snap, wl_chunk, wl_set, conn, board_cache))
            except Exception:
                app["clients"].discard(ws)
                app["conns"].pop(ws, None)
                sync_board_reg(app)


def start_trade_hubs():
    """账户监控 + 策略运行器。任何一个起不来都只记日志, 不影响行情。"""
    global ACCT, STRAT
    try:
        import account as _acct
        ACCT = _acct.AccountHub(*load_auth(), data_dir=DATA_DIR)
        ACCT.start()
        print("[acct] 账户监控已启动", flush=True)
    except Exception as e:
        ACCT = None
        print(f"[acct] 账户监控未启用: {type(e).__name__}: {e}", flush=True)
    try:
        import strategy_runner as _sr
        STRAT = _sr.StrategyHub(data_dir=DATA_DIR)
        print("[strat] 策略运行器就绪", flush=True)
    except Exception as e:
        STRAT = None
        print(f"[strat] 策略运行器未启用: {type(e).__name__}: {e}", flush=True)


async def on_startup(app):
    precompress_static()
    global SNAP_EVENT, MAIN_LOOP
    app["clients"] = set()
    app["conns"] = {}
    SNAP_EVENT = asyncio.Event()
    MAIN_LOOP = asyncio.get_running_loop()
    app["loop"] = MAIN_LOOP
    threading.Thread(target=tq_worker, daemon=True, name="tq-worker").start()
    threading.Thread(target=heavy_worker, daemon=True, name="heavy-worker").start()
    start_trade_hubs()
    app["bg"] = asyncio.create_task(broadcaster(app))


def main():
    app = web.Application(middlewares=[no_cache_static])
    app.on_startup.append(on_startup)
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static", STATIC_DIR)
    print(f"行情终端: http://127.0.0.1:{PORT}", flush=True)
    try:
        web.run_app(app, host="127.0.0.1", port=PORT, print=None)
    except OSError as e:
        if e.errno == 48:
            raise SystemExit(
                f"端口 {PORT} 已被占用: 可能已有一个行情终端在运行, 直接打开 "
                f"http://127.0.0.1:{PORT} 即可; 或先执行 pkill -f market_wall 再启动"
            )
        raise


if __name__ == "__main__":
    main()
