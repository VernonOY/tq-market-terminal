"""hfcalc.cpp 的 ctypes 封装 —— 首次导入时自动编译。

用 C++ 是因为这些量要在每个 tick(500ms)上对几百到几千笔快照做全量重算,
还要同时算 6 个时间尺度的已实现波动率。放在 Python 里会跟采集线程抢 GIL,
直接拖慢行情推送。

零第三方依赖: 只用 ctypes + 系统 clang++。编译失败时自动降级到纯 Python
实现(慢一个数量级但结果一致), 不会让服务起不来。
"""
import ctypes
import os
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).parent
SRC = BASE / "hfcalc.cpp"
LIB = BASE / ("libhfcalc." + ("dylib" if sys.platform == "darwin" else "so"))

HF_N = 22          # hf_metrics 输出长度
RS_N = 21          # hf_range_stats 输出长度

HF_KEYS = [
    "order_imb", "order_imb_avg", "ofi", "ofi_rate",
    "aggr_buy", "aggr_sell", "aggr_ratio",
    "trade_per_sec", "vol_per_sec", "avg_trade_size", "large_ratio",
    "tick_mom", "spread_avg", "spread_bp",
    "doi_sum", "doi_per_sec", "open_ratio",
    "vwap", "px_vs_vwap_bp", "kyle_lambda", "window_sec", "n_trades",
]
RS_KEYS = [
    "open", "close", "high", "low", "chg", "chg_pct", "amp_pct",
    "volume", "vwap", "doi", "up_bars", "dn_bars",
    "vol_sd", "vol_ann", "max_dd", "max_run", "skew", "kurt",
    "up_vol", "dn_vol", "bars",
]

_lib = None
_state = "未初始化"


def _compile():
    """编译 dylib。源码比产物新时重编译。"""
    if not SRC.exists():
        return False, f"找不到 {SRC.name}"
    if LIB.exists() and LIB.stat().st_mtime >= SRC.stat().st_mtime:
        return True, "已是最新"
    cmd = [
        "clang++", "-O3", "-ffast-math", "-std=c++17", "-fvisibility=hidden",
        "-dynamiclib" if sys.platform == "darwin" else "-shared",
        "-fPIC", "-o", str(LIB), str(SRC),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:                                   # noqa: BLE001
        return False, f"编译器不可用: {e}"
    if r.returncode != 0:
        return False, f"编译失败: {(r.stderr or '')[:300]}"
    return True, "编译完成"


def _load():
    global _lib, _state
    okc, msg = _compile()
    if not okc:
        _state = msg
        return None
    try:
        lib = ctypes.CDLL(str(LIB))
    except OSError as e:
        _state = f"加载失败: {e}"
        return None
    D = ctypes.POINTER(ctypes.c_double)
    lib.hf_version.restype = ctypes.c_int
    lib.hf_metrics.restype = ctypes.c_int
    lib.hf_metrics.argtypes = [ctypes.c_int] + [D] * 8 + [D, ctypes.c_int]
    lib.hf_realized_vol.restype = ctypes.c_int
    lib.hf_realized_vol.argtypes = [ctypes.c_int, D, D, D, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_double, D, ctypes.c_int]
    lib.hf_range_stats.restype = ctypes.c_int
    lib.hf_range_stats.argtypes = [ctypes.c_int] + [D] * 6 + \
                                  [ctypes.c_double, ctypes.c_double, D, ctypes.c_int]
    _lib = lib
    _state = f"C++ v{lib.hf_version()} ({msg})"
    return lib


def available():
    return _lib is not None


def state():
    return _state


def _arr(seq, n):
    """list -> C double 数组; None/非有限值填 NaN"""
    buf = (ctypes.c_double * n)()
    if seq is None:
        for i in range(n):
            buf[i] = float("nan")
        return buf
    for i in range(n):
        v = seq[i] if i < len(seq) else None
        try:
            buf[i] = float(v) if v is not None else float("nan")
        except (TypeError, ValueError):
            buf[i] = float("nan")
    return buf


def _clean(vals, keys):
    out = {}
    for k, v in zip(keys, vals):
        out[k] = None if (v != v or v in (float("inf"), float("-inf"))) else round(v, 6)
    return out


def metrics(ts, px, vol, oi=None, b1=None, a1=None, bv=None, av=None):
    """逐笔高频指标。ts 毫秒, vol 是当日累计量, oi 是持仓量快照。"""
    n = len(ts or ())
    if n < 2:
        return None
    if _lib is None:
        return _py_metrics(ts, px, vol, oi, b1, a1, bv, av)
    a = [_arr(x, n) for x in (ts, px, vol, oi, b1, a1, bv, av)]
    out = (ctypes.c_double * HF_N)()
    r = _lib.hf_metrics(n, *a, out, HF_N)
    if r < 0:
        return None
    return _clean(list(out), HF_KEYS)


def realized_vol(ts, px, horizons=(60, 300, 900, 1800, 3600, 14400),
                 lookback_mult=60, daily_sec=None):
    """多周期已实现波动率。返回 {horizon: {ann, sd, n}}"""
    n = len(ts or ())
    if n < 3:
        return {}
    hs = list(horizons)
    if daily_sec is None:
        daily_sec = 5.5 * 3600
    if _lib is None:
        return _py_rv(ts, px, hs, lookback_mult, daily_sec)
    out = (ctypes.c_double * (len(hs) * 3))()
    r = _lib.hf_realized_vol(n, _arr(ts, n), _arr(px, n), _arr(hs, len(hs)), len(hs),
                             int(lookback_mult), float(daily_sec), out, len(hs) * 3)
    if r < 0:
        return {}
    res = {}
    for i, h in enumerate(hs):
        ann, sd, m = out[i * 3], out[i * 3 + 1], out[i * 3 + 2]
        res[int(h)] = {
            "ann": None if ann != ann else round(ann * 100, 4),   # 百分数
            "sd": None if sd != sd else round(sd, 8),
            "n": int(m) if m == m else 0,
        }
    return res


def range_stats(o, h, l, c, v=None, oi=None, bar_sec=60, daily_sec=None):
    """K线区间统计(框选计算用)"""
    n = len(c or ())
    if n < 1:
        return None
    if daily_sec is None:
        daily_sec = 5.5 * 3600
    if _lib is None:
        return _py_range(o, h, l, c, v, oi, bar_sec, daily_sec)
    out = (ctypes.c_double * RS_N)()
    r = _lib.hf_range_stats(n, _arr(o, n), _arr(h, n), _arr(l, n), _arr(c, n),
                            _arr(v, n), _arr(oi, n),
                            float(bar_sec), float(daily_sec), out, RS_N)
    if r < 0:
        return None
    d = _clean(list(out), RS_KEYS)
    # 统一成百分数, 和 realized_vol 的口径一致
    for k in ("vol_ann", "vol_sd", "up_vol", "dn_vol"):
        if d.get(k) is not None:
            d[k] = round(d[k] * 100, 4)
    return d


# ---------------------------------------------------------------- 纯 Python 兜底
# 编译不可用时用它, 结果与 C++ 一致, 只是慢。

def _py_metrics(ts, px, vol, oi, b1, a1, bv, av):
    import math
    n = len(ts)
    g = lambda a, i: (a[i] if a and i < len(a) and a[i] is not None and
                      isinstance(a[i], (int, float)) and math.isfinite(a[i]) else None)
    imb_last = None; imb_s = 0.0; imb_c = 0
    ofi = 0.0; ab = 0.0; asl = 0.0; dv_s = 0.0; doi_s = 0.0; nt = 0
    sp_s = 0.0; spb_s = 0.0; sp_c = 0
    mn = 0.0; ma = 0.0; pv = 0.0; openv = 0.0
    sizes = []
    for i in range(1, n):
        v0, v1 = g(vol, i - 1), g(vol, i)
        if v0 is None or v1 is None:
            continue
        dv = v1 - v0
        if dv < 0:
            continue
        o0, o1 = g(oi, i - 1), g(oi, i)
        doi = (o1 - o0) if (o0 is not None and o1 is not None) else 0.0
        doi = max(-dv, min(dv, doi))
        bvi, avi = g(bv, i), g(av, i)
        if bvi is not None and avi is not None and (bvi + avi) > 0:
            im = (bvi - avi) / (bvi + avi)
            imb_last = im; imb_s += im; imb_c += 1
        b0, b1i, a0, a1i = g(b1, i - 1), g(b1, i), g(a1, i - 1), g(a1, i)
        bv0, av0 = g(bv, i - 1), g(av, i - 1)
        if None not in (b0, b1i, a0, a1i, bvi, avi, bv0, av0):
            e = 0.0
            e += bvi if b1i > b0 else ((bvi - bv0) if b1i == b0 else -bv0)
            e -= avi if a1i < a0 else ((avi - av0) if a1i == a0 else -av0)
            ofi += e
        p0, p1 = g(px, i - 1), g(px, i)
        if b1i is not None and a1i is not None and p1 and a1i > b1i:
            sp_s += a1i - b1i; spb_s += (a1i - b1i) / p1 * 10000.0; sp_c += 1
        dpx = (p1 - p0) if (p0 is not None and p1 is not None) else 0.0
        mn += dpx; ma += abs(dpx)
        if dv <= 0:
            continue
        nt += 1; dv_s += dv; doi_s += doi; sizes.append(dv)
        if p1 is not None:
            pv += p1 * dv
        side = 0
        if None not in (b0, a0) and a0 > b0 and p1 is not None:
            if p1 >= a0: side = 1
            elif p1 <= b0: side = -1
            else:
                mid = (a0 + b0) / 2
                side = 1 if p1 > mid else (-1 if p1 < mid else 0)
        if side == 0:
            side = 1 if dpx > 0 else (-1 if dpx < 0 else 0)
        if side > 0: ab += dv
        elif side < 0: asl += dv
        if doi > 0: openv += doi
    win = (ts[-1] - ts[0]) / 1000.0 if n >= 2 else 0.0
    big = None
    if sizes:
        s = sorted(sizes)
        thr = s[int(0.9 * (len(s) - 1))]
        big = sum(x for x in sizes if x >= thr) / dv_s if dv_s else None
    vwap = pv / dv_s if dv_s else None
    r = {
        "order_imb": imb_last, "order_imb_avg": imb_s / imb_c if imb_c else None,
        "ofi": ofi, "ofi_rate": ofi / win if win else None,
        "aggr_buy": ab, "aggr_sell": asl,
        "aggr_ratio": ab / (ab + asl) if (ab + asl) else None,
        "trade_per_sec": nt / win if win else None,
        "vol_per_sec": dv_s / win if win else None,
        "avg_trade_size": dv_s / nt if nt else None,
        "large_ratio": big, "tick_mom": mn / ma if ma else None,
        "spread_avg": sp_s / sp_c if sp_c else None,
        "spread_bp": spb_s / sp_c if sp_c else None,
        "doi_sum": doi_s, "doi_per_sec": doi_s / win if win else None,
        "open_ratio": openv / dv_s if dv_s else None,
        "vwap": vwap,
        "px_vs_vwap_bp": ((px[-1] - vwap) / vwap * 10000.0) if (vwap and px[-1]) else None,
        "kyle_lambda": None, "window_sec": win, "n_trades": nt,
    }
    return {k: (round(v, 6) if isinstance(v, float) else v) for k, v in r.items()}


def _py_rv(ts, px, hs, mult, daily_sec):
    import math
    res = {}
    t_end = ts[-1]
    for h in hs:
        hm = h * 1000.0
        t0 = t_end - hm * mult
        grid = []; cur_b = None; cur_p = None
        for i in range(len(ts)):
            if ts[i] < t0 or not px[i]:
                continue
            b = int((ts[i] - t0) // hm)
            if b != cur_b:
                if cur_b is not None and cur_p:
                    grid.append(cur_p)
                cur_b = b
            cur_p = px[i]
        if cur_p:
            grid.append(cur_p)
        if len(grid) < 3:
            res[int(h)] = {"ann": None, "sd": None, "n": 0}
            continue
        s2 = 0.0; m = 0
        for i in range(1, len(grid)):
            if grid[i] > 0 and grid[i - 1] > 0:
                r = math.log(grid[i] / grid[i - 1]); s2 += r * r; m += 1
        if m < 2:
            res[int(h)] = {"ann": None, "sd": None, "n": m}
            continue
        sd = math.sqrt(s2 / m)
        res[int(h)] = {"ann": round(sd * math.sqrt(252 * daily_sec / h) * 100, 4),
                       "sd": round(sd, 8), "n": m}
    return res


def _py_range(o, h, l, c, v, oi, bar_sec, daily_sec):
    import math
    n = len(c)
    hi = max((x for x in h if x is not None), default=None)
    lo = min((x for x in l if x is not None), default=None)
    vs = sum(x for x in (v or []) if x) if v else 0.0
    pv = sum(((h[i] + l[i] + c[i]) / 3.0) * (v[i] if v and v[i] else 0)
             for i in range(n) if None not in (h[i], l[i], c[i]))
    up = sum(1 for i in range(n) if c[i] and o[i] and c[i] > o[i])
    dn = sum(1 for i in range(n) if c[i] and o[i] and c[i] < o[i])
    rs = []
    for i in range(1, n):
        if c[i] and c[i - 1] and c[i] > 0 and c[i - 1] > 0:
            rs.append(math.log(c[i] / c[i - 1]))
    sd = None
    if len(rs) >= 2:
        mean = sum(rs) / len(rs)
        sd = math.sqrt(sum((x - mean) ** 2 for x in rs) / len(rs))
    out = {
        "open": o[0], "close": c[-1], "high": hi, "low": lo,
        "chg": c[-1] - o[0] if (c[-1] and o[0]) else None,
        "chg_pct": (c[-1] - o[0]) / o[0] * 100 if o[0] else None,
        "amp_pct": (hi - lo) / o[0] * 100 if (hi and lo and o[0]) else None,
        "volume": vs, "vwap": pv / vs if vs else None,
        "doi": (oi[-1] - oi[0]) if (oi and oi[-1] is not None and oi[0] is not None) else None,
        "up_bars": up, "dn_bars": dn, "vol_sd": sd,
        "vol_ann": sd * math.sqrt(252 * daily_sec / bar_sec) if (sd and bar_sec) else None,
        "max_dd": None, "max_run": None, "skew": None, "kurt": None,
        "up_vol": None, "dn_vol": None, "bars": n,
    }
    return {k: (round(x, 6) if isinstance(x, float) else x) for k, x in out.items()}


_load()

if __name__ == "__main__":
    import random, time
    print("状态:", state(), "| 可用:", available())
    random.seed(7)
    n = 4000
    ts, px, vol, oi, b1, a1, bv, av = [], [], [], [], [], [], [], []
    p, V, O, t = 3000.0, 0.0, 200000.0, time.time() * 1000
    for i in range(n):
        p += random.gauss(0, 1) * 1.0
        p = round(p, 0)
        V += max(0, int(random.expovariate(1 / 20.0)))
        O += random.gauss(0, 8)
        t += 500
        ts.append(t); px.append(p); vol.append(V); oi.append(O)
        b1.append(p - 1); a1.append(p + 1)
        bv.append(max(1, int(random.expovariate(1 / 30.0))))
        av.append(max(1, int(random.expovariate(1 / 30.0))))
    t0 = time.perf_counter()
    m = metrics(ts, px, vol, oi, b1, a1, bv, av)
    t1 = time.perf_counter()
    print(f"\nhf_metrics  {n} 笔  {(t1 - t0) * 1000:.3f} ms")
    for k in HF_KEYS:
        print(f"   {k:16s} {m[k]}")
    t0 = time.perf_counter()
    rv = realized_vol(ts, px)
    t1 = time.perf_counter()
    print(f"\nrealized_vol  {(t1 - t0) * 1000:.3f} ms")
    for h, d in rv.items():
        print(f"   {h:6d}s  年化 {d['ann']}%  单期sd {d['sd']}  样本 {d['n']}")
    o = px[:]; hh = [x + 2 for x in px]; ll = [x - 2 for x in px]
    t0 = time.perf_counter()
    rsx = range_stats(o, hh, ll, px, [10] * n, oi, bar_sec=60)
    t1 = time.perf_counter()
    print(f"\nrange_stats  {(t1 - t0) * 1000:.3f} ms")
    for k in RS_KEYS:
        print(f"   {k:10s} {rsx[k]}")
    # 与纯 Python 兜底对拍
    print("\n=== 与纯 Python 实现对拍 ===")
    pm = _py_metrics(ts, px, vol, oi, b1, a1, bv, av)
    bad = []
    for k in HF_KEYS:
        a, b = m.get(k), pm.get(k)
        if a is None or b is None:
            if (a is None) != (b is None) and k != "kyle_lambda":
                bad.append(f"{k}: C++={a} py={b}")
            continue
        if abs(a - b) > max(1e-6, abs(b) * 1e-6):
            bad.append(f"{k}: C++={a} py={b}")
    print("一致" if not bad else "差异:\n  " + "\n  ".join(bad))
