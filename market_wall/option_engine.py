"""
option_engine.py — 期权链 / 隐含波动率 / 希腊字母 计算引擎

供 server.py 调用, 本模块不碰任何全局共享状态, 也不启动线程。
所有需要 TqApi 的函数都接受 api 作为第一个参数, 必须在持有 TqApi 的那个线程里调用
(TqApi 非线程安全)。

对外 API
--------
    build_underlyings(api, force=False) -> list[dict]      全市场有未到期期权的标的目录(带磁盘缓存)
    underlyings_by_product(items)       -> dict            按品种分组, 供前端二级选择
    build_chain(api, underlying, ...)   -> dict            一条完整期权链 + IV + Greeks
    chain_stats(chain)                  -> dict            每个到期月的 ATM IV / PCR / 持仓 / 最大痛点
    seen_symbols()                      -> set             已经出现过的期权代码(server.py 订阅白名单用)
    register_symbols(codes)                                手工登记
    implied_vol(...) / greeks(...)                         裸算子, 可单独用

定价模型
--------
期货期权(标的 ins_class = FUTURE / CONT) 走 Black-76:
    C = e^{-rt} [ F N(d1) - K N(d2) ]   F = 标的期货价
    P = e^{-rt} [ K N(-d2) - F N(-d1) ]
    d1 = (ln(F/K) + v^2 t / 2) / (v sqrt(t)),  d2 = d1 - v sqrt(t)
ETF / 股指期权(标的 ins_class = FUND / INDEX / STOCK) 走标准 BS:
    C = S e^{-qt} N(d1) - K e^{-rt} N(d2),  d1 = (ln(S/K) + (r - q + v^2/2) t) / (v sqrt(t))
q = 0 时就是教科书里的无红利 BS。

两者其实是同一个公式的两种参数化: 令 F = S e^{(r-q)t} 代入, BS 的 d1/d2 和期权价与
Black-76 完全一致。所以本模块内部统一用 (远期价 F, 折现因子 e^{-rt}) 定价和反解 IV,
只在算 delta/gamma/theta 时按标的类型换回各自的口径。

⚠ q 不能拍脑袋当 0: 沪深300 的分红率让 2027-06 的远期比现货低 4.3%(4405 vs 4601),
按 q=0 算, 实值 CALL 的无套利下界 S - K e^{-rt} 会高于市场价, 整片实值档 IV 无解
(实测覆盖率只有 83.9%)。所以对现货标的**逐到期月用 put-call parity 反推远期**:
    F = K + (C - K) ... 即  F = K + (C - P) e^{rt}
取 |C-P| 最小的若干个行权价(那里两腿都最活跃)求中位数, 反推不出来才退回 q=0。

TqSdk 自带的 tafunc.get_impv 一律用股票现货 BS, 对期货期权的无套利下界判定是
S - K e^{-rt} 而不是 e^{-rt}(F - K), 实值档大面积无解 —— 所以这里自己实现。

量纲
----
    t     = 剩余自然秒 / (360 * 86400)     360 天年化
    delta 原值   gamma 原值
    vega  每 1 个波动率点 (解析值 / 100)
    theta 每日   (年化解析值 / 365)
"""

import json
import math
import threading
import time
from collections import defaultdict
from pathlib import Path

from scipy.optimize import brentq

HERE = Path(__file__).resolve().parent
OPTION_CACHE = HERE / "option_cache.json"

YEAR_SECONDS = 360.0 * 86400.0      # 360 天年化
DEFAULT_R = 0.025                   # 无风险利率
IV_LO, IV_HI = 1e-6, 10.0           # brentq 求解区间; 上界必须够宽,
                                    # 深虚值只值 1 个最小变动价位的合约用 5.0 会 bracket 失败
SYMBOL_BATCH = 1000                 # query_symbol_info 批大小

MODEL_B76 = "B76"
MODEL_BS = "BS"

# ---------------------------------------------------------------- 小工具

_SQRT2 = math.sqrt(2.0)
_INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)


def _N(x):
    """标准正态 CDF (math.erf 比 scipy.stats.norm 快一个数量级)"""
    return 0.5 * (1.0 + math.erf(x / _SQRT2))


def _pdf(x):
    return _INV_SQRT_2PI * math.exp(-0.5 * x * x)


def _fin(v):
    """有效数值: 非 None / 非 NaN / 非 Inf"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f)


def _pos(v):
    return _fin(v) and float(v) > 0.0


def _f(v):
    """安全转 float, 无效返回 None (直接可进 json)"""
    return float(v) if _fin(v) else None


def _pid_of(sym, ins_class="", product_id=""):
    """标的代码 -> 品种。SHFE.cu2609 -> cu; ETF/指数标的用代码本身 510050 / 000300"""
    code = sym.split(".", 1)[1] if "." in sym else sym
    if ins_class in ("FUTURE", "CONT"):
        if product_id:
            return str(product_id)
        i = len(code)
        while i > 0 and code[i - 1].isdigit():
            i -= 1
        return code[:i] or code
    return code


# ---------------------------------------------------------------- 定价 / 希腊字母

def _price(fwd, k, t, v, r, is_call):
    """
    统一的远期口径定价: price = e^{-rt} [ F N(d1) - K N(d2) ] (CALL)
    Black-76 传期货价; BS 传 F = S e^{(r-q)t} —— 两者结果完全一致。
    """
    st = v * math.sqrt(t)
    d1 = (math.log(fwd / k) + 0.5 * v * v * t) / st
    d2 = d1 - st
    df = math.exp(-r * t)
    if is_call:
        return df * (fwd * _N(d1) - k * _N(d2))
    return df * (k * _N(-d2) - fwd * _N(-d1))


def greeks(model, fwd, k, t, v, r, is_call, spot=None):
    """
    返回 (delta, gamma, vega_per_point, theta_per_day)。v 是年化波动率小数。

    model = MODEL_B76: fwd 是期货价, delta/gamma 对期货价求导(Black-76 口径)
    model = MODEL_BS : fwd 是由 parity 反推的远期, spot 是现货价; delta/gamma 对现货求导。
                       隐含红利率 q 由 F = S e^{(r-q)t} 反解, spot 缺省时退回 q=0。
    """
    if not (t > 0 and v > 0 and fwd > 0 and k > 0):
        return None, None, None, None
    sqt = math.sqrt(t)
    st = v * sqt
    d1 = (math.log(fwd / k) + 0.5 * v * v * t) / st
    d2 = d1 - st
    nd1 = _pdf(d1)
    df = math.exp(-r * t)

    if model == MODEL_BS and _pos(spot):
        s = float(spot)
        under = s                      # 求导对象是现货
        dfac = df * fwd / s            # = e^{-qt}
        carry = r - math.log(fwd / s) / t   # 隐含红利率 q
    else:
        under = fwd                    # 求导对象是期货价
        dfac = df                      # Black-76: e^{-rt}
        carry = r                      # 期货的持有成本口径, q == r

    delta = dfac * _N(d1) if is_call else -dfac * _N(-d1)
    gamma = dfac * nd1 / (under * v * sqt)
    vega = df * fwd * nd1 * sqt        # 两种口径下 vega 表达式相同
    theta = -df * fwd * nd1 * v / (2.0 * sqt)
    if is_call:
        theta += carry * df * fwd * _N(d1) - r * df * k * _N(d2)
    else:
        theta += -carry * df * fwd * _N(-d1) + r * df * k * _N(-d2)
    # 量纲: vega -> 每 1 个波动点, theta -> 每日
    return delta, gamma, vega / 100.0, theta / 365.0


def implied_vol(price, fwd, k, t, r, is_call, lo=IV_LO, hi=IV_HI):
    """
    brentq 反解隐含波动率(远期口径)。无解(期权价触及/跌破无套利下界, 或超过上界)返回 None。

    不预先写死解析下界: 直接看 f(lo) / f(hi) 是否异号 —— 顺带排掉了价格高于上界
    (e^{-rt}F / e^{-rt}K)的脏报价。
    """
    if not (_pos(price) and _pos(fwd) and _pos(k) and t > 0):
        return None
    try:
        f_lo = _price(fwd, k, t, lo, r, is_call) - price
        f_hi = _price(fwd, k, t, hi, r, is_call) - price
    except (ValueError, OverflowError):
        return None
    if not (math.isfinite(f_lo) and math.isfinite(f_hi)) or f_lo * f_hi > 0:
        return None
    if f_lo == 0.0:
        return None                      # 正好等于内在价值, IV 无意义
    try:
        return brentq(lambda v: _price(fwd, k, t, v, r, is_call) - price,
                      lo, hi, xtol=1e-6, rtol=1e-8, maxiter=100)
    except (ValueError, RuntimeError):
        return None


# ---------------------------------------------------------------- 价格源

def _mid(q):
    """(价格, 来源) —— 中间价 > 单边 > None"""
    b, a = q.bid_price1, q.ask_price1
    ob, oa = _pos(b) and _pos(q.bid_volume1), _pos(a) and _pos(q.ask_volume1)
    if not ob:
        ob = _pos(b)
    if not oa:
        oa = _pos(a)
    if ob and oa and float(a) >= float(b):
        return (float(a) + float(b)) / 2.0, "mid"
    if ob:
        return float(b), "bid"
    if oa:
        return float(a), "ask"
    return None, None


def _settle_of(q):
    """当日结算价, 没有就退到昨结算"""
    if _pos(q.settlement):
        return float(q.settlement), "settle"
    if _pos(q.pre_settlement):
        return float(q.pre_settlement), "pre_settle"
    return None, None


def _px_candidates(q, prefer_settle):
    """
    价格源分档降级 -> [(期权价, 来源标签), ...]
    调用方据标签选同源的标的价(盘中报价配盘中标的, 结算价配结算标的), 否则实值档
    会因为标的跳了一截而跌破内在价值下界, IV 直接无解。
    """
    live = []
    m, tag = _mid(q)
    if m is not None:
        live.append((m, tag))
    if _pos(q.last_price):
        live.append((float(q.last_price), "last"))
    s, stag = _settle_of(q)
    settle = [(s, stag)] if s is not None else []
    return (settle + live) if prefer_settle else (live + settle)


def _px_live(q):
    m, _ = _mid(q)
    if m is not None:
        return m
    return float(q.last_price) if _pos(q.last_price) else None


def _px_settle(q):
    return _settle_of(q)[0]


# ---------------------------------------------------------------- 期权代码白名单

_seen_lock = threading.Lock()
_SEEN = set()


def seen_symbols():
    """server.py 订阅白名单用: 返回目前为止本引擎见过的全部期权代码(副本)"""
    with _seen_lock:
        return set(_SEEN)


def register_symbols(codes):
    with _seen_lock:
        _SEEN.update(codes)


def is_known_option(sym):
    with _seen_lock:
        return sym in _SEEN


# ---------------------------------------------------------------- 标的目录

_cache_lock = threading.Lock()
_MEM = {"date": None, "items": None}


def _load_cache(today):
    with _cache_lock:
        if _MEM["date"] == today and _MEM["items"]:
            return _MEM["items"]
    if OPTION_CACHE.exists():
        try:
            data = json.loads(OPTION_CACHE.read_text())
            if data.get("date") == today and data.get("items"):
                items = data["items"]
                with _cache_lock:
                    _MEM["date"], _MEM["items"] = today, items
                return items
        except Exception:
            pass
    return None


def _save_cache(today, items):
    with _cache_lock:
        _MEM["date"], _MEM["items"] = today, items
    try:
        OPTION_CACHE.write_text(
            json.dumps({"date": today, "items": items}, ensure_ascii=False))
    except Exception as e:
        print(f"[opt] 缓存写入失败: {e}", flush=True)


def build_underlyings(api, force=False, verbose=True):
    """
    枚举全市场有未到期期权的标的。
    返回 [{"u","n","ex","oex","pid","cls","n_opt","months":[[y,m],...]}, ...]
      u    标的代码            n    标的名称
      ex   标的所在交易所      oex  期权所在交易所(股指期权 标的在 SSE / 期权在 CFFEX)
      pid  品种(cu / m / SR / 510050 ...)
      cls  标的 ins_class(FUTURE / FUND / INDEX ...) —— 决定用 B76 还是 BS
      n_opt 未到期期权个数     months 到期月列表

    全量 query_symbol_info 约 22s, 按交易日缓存到 option_cache.json。
    """
    today = time.strftime("%Y-%m-%d")
    if not force:
        cached = _load_cache(today)
        if cached:
            if verbose:
                print(f"[opt] 标的目录缓存命中 {len(cached)} 个标的", flush=True)
            return cached
    if api is None:
        return []

    t0 = time.time()
    codes = api.query_quotes(ins_class="OPTION", expired=False)
    if verbose:
        print(f"[opt] 未到期期权 {len(codes)} 个, 开始拉 symbol_info...", flush=True)

    now = time.time()
    agg = {}          # underlying -> {"n_opt":int, "months":set, "oex":set}
    got = 0
    for i in range(0, len(codes), SYMBOL_BATCH):
        chunk = codes[i:i + SYMBOL_BATCH]
        try:
            df = api.query_symbol_info(chunk)
        except Exception as e:
            print(f"[opt] symbol_info 批次 {i} 失败: {e}", flush=True)
            continue
        for r in df.itertuples(index=False):
            und = getattr(r, "underlying_symbol", "") or ""
            if not und:
                continue
            exp = getattr(r, "expire_datetime", None)
            if _fin(exp) and float(exp) <= now:
                continue
            y, m = getattr(r, "exercise_year", None), getattr(r, "exercise_month", None)
            a = agg.get(und)
            if a is None:
                a = agg[und] = {"n_opt": 0, "months": set(), "oex": set()}
            a["n_opt"] += 1
            if _fin(y) and _fin(m):
                a["months"].add((int(y), int(m)))
            ex = getattr(r, "exchange_id", "") or ""
            if ex:
                a["oex"].add(str(ex))
            got += 1
        if verbose and (i // SYMBOL_BATCH) % 10 == 0:
            print(f"[opt] 进度 {min(i + SYMBOL_BATCH, len(codes))}/{len(codes)}", flush=True)

    register_symbols(codes)
    t_info = time.time() - t0

    # 标的自身的名称 / ins_class / product_id
    unds = sorted(agg)
    meta = {}
    for i in range(0, len(unds), SYMBOL_BATCH):
        try:
            df = api.query_symbol_info(unds[i:i + SYMBOL_BATCH])
        except Exception as e:
            print(f"[opt] 标的 symbol_info 失败: {e}", flush=True)
            continue
        for r in df.itertuples(index=False):
            sym = getattr(r, "instrument_id", "") or ""
            if sym:
                meta[sym] = (str(getattr(r, "instrument_name", "") or ""),
                             str(getattr(r, "ins_class", "") or ""),
                             str(getattr(r, "product_id", "") or ""))

    items = []
    for u in unds:
        a = agg[u]
        name, cls_, pid_raw = meta.get(u, ("", "", ""))
        items.append({
            "u": u,
            "n": name or u.split(".")[-1],
            "ex": u.split(".")[0] if "." in u else "",
            "oex": sorted(a["oex"])[0] if a["oex"] else "",
            "pid": _pid_of(u, cls_, pid_raw),
            "cls": cls_,
            "n_opt": a["n_opt"],
            "months": [[y, m] for y, m in sorted(a["months"])],
        })
    items.sort(key=lambda it: (it["ex"], it["pid"], it["u"]))
    _save_cache(today, items)
    if verbose:
        print(f"[opt] 标的目录完成: {len(items)} 个标的 / {got} 个期权 / "
              f"{len(set(it['pid'] for it in items))} 个品种, "
              f"symbol_info {t_info:.1f}s 总 {time.time() - t0:.1f}s", flush=True)
    return items


def underlyings_by_product(items):
    """按品种分组, 供前端做 品种 -> 标的 的二级选择。返回 {pid: [item,...]} """
    g = defaultdict(list)
    for it in items:
        g[it["pid"]].append(it)
    for v in g.values():
        v.sort(key=lambda it: it["u"])
    return dict(g)


# ---------------------------------------------------------------- 期权链

def _model_of(ins_class):
    """期货/主连 -> Black-76(标的是期货价); ETF/指数/股票 -> 标准 BS(标的是现货)"""
    return MODEL_B76 if ins_class in ("FUTURE", "CONT") else MODEL_BS


def _u_prices(uq):
    """标的的 (盘中价, 结算/收盘价)"""
    live = None
    m, _ = _mid(uq)
    if m is not None:
        live = m
    elif _pos(uq.last_price):
        live = float(uq.last_price)
    settle = None
    for attr in ("settlement", "pre_settlement", "close", "pre_close"):
        v = getattr(uq, attr, None)
        if _pos(v):
            settle = float(v)
            break
    if live is None:
        live = settle
    if settle is None:
        settle = live
    return live, settle


def _parity_forward(rows_q, t, r, price_of, spot, n_use=5):
    """
    put-call parity 反推远期:  C - P = e^{-rt}(F - K)  =>  F = K + (C - P) e^{rt}

    取 |C-P| 最小的 n_use 个行权价(那附近两腿都最活跃, 报价最干净)求中位数。
    rows_q: {strike: {"CALL": quote, "PUT": quote}}
    price_of: quote -> 价格 或 None
    """
    ests = []
    for k, pair in rows_q.items():
        qc, qp = pair.get("CALL"), pair.get("PUT")
        if qc is None or qp is None:
            continue
        c, p = price_of(qc), price_of(qp)
        if c is None or p is None:
            continue
        ests.append((abs(c - p), k + (c - p) * math.exp(r * t)))
    if not ests:
        return None
    ests.sort()
    picked = sorted(f for _, f in ests[:n_use])
    n = len(picked)
    fwd = picked[n // 2] if n % 2 else 0.5 * (picked[n // 2 - 1] + picked[n // 2])
    if not _pos(fwd):
        return None
    # 合理性闸门: 反推值偏离现货一半以上, 说明报价太脏, 不采信
    if _pos(spot) and not (0.5 * spot < fwd < 2.0 * spot):
        return None
    return fwd


def _cell(q, model, fwd_live, fwd_settle, spot_live, spot_settle, r, prefer_settle, t):
    """一个期权合约 -> 协议里的 c / p 结构"""
    k = _f(q.strike_price)
    is_call = str(q.option_class).upper() == "CALL"

    settle_px, _ = _settle_of(q)
    cell = {
        "s": q.instrument_id,
        "last": _f(q.last_price),
        "bid": _f(q.bid_price1),
        "ask": _f(q.ask_price1),
        "vol": _f(q.volume),
        "oi": _f(q.open_interest),
        "settle": settle_px,
        "iv": None, "delta": None, "gamma": None, "vega": None, "theta": None,
        "src": None,
    }
    if k is None or t <= 0:
        return cell

    for px, tag in _px_candidates(q, prefer_settle):
        live = tag in ("mid", "bid", "ask", "last")
        fwd = fwd_live if live else fwd_settle
        spot = spot_live if live else spot_settle
        if not _pos(fwd):
            continue
        v = implied_vol(px, fwd, k, t, r, is_call)
        if v is None:
            continue
        d, g, vg, th = greeks(model, fwd, k, t, v, r, is_call, spot=spot)
        cell.update(iv=v, delta=d, gamma=g, vega=vg, theta=th, src=tag)
        break
    return cell


def build_chain(api, underlying, r=DEFAULT_R, use_settlement=None, quotes=None):
    """
    组一条完整期权链。返回:
      {"u": {标的行情...},
       "months":[{"y","m","f","t","days","q","rows":[{"k","c":{...},"p":{...}}...]}, ...],
       "model": "B76"|"BS", "r":..., "prefer_settle":bool, "timing":{...}}
    月里的 f 是该到期月定价用的远期价(期货期权=标的期货价; 现货标的=parity 反推),
    q 是反推出来的隐含红利率/基差率(现货标的才有)。

    use_settlement: True 强制优先结算价 / False 强制优先盘中报价 / None 自动
                    (链上多数合约已有当日结算价 -> 判定为盘后, 优先结算价)
    quotes:         已经订阅好的 quote 对象列表, 传了就不再 query_options / get_quote_list
    """
    t0 = time.time()
    uq = api.get_quote(underlying)
    if quotes is None:
        codes = api.query_options(underlying, expired=False)
        if not codes:
            raise ValueError(f"{underlying} 没有未到期期权")
        t1 = time.time()
        quotes = list(api.get_quote_list(codes))
    else:
        codes = [q.instrument_id for q in quotes]
        t1 = time.time()
    t_quote = time.time()
    register_symbols(codes)

    model = _model_of(str(uq.ins_class or ""))
    fwd_live, fwd_settle = _u_prices(uq)
    if use_settlement is None:
        ok = sum(1 for q in quotes if _pos(q.settlement))
        prefer_settle = bool(quotes) and ok * 2 >= len(quotes)
    else:
        prefer_settle = bool(use_settlement)

    now = time.time()
    # 1) 按到期月分桶, 同一行权价的 CALL/PUT 配对
    buckets = defaultdict(dict)          # (y,m) -> {strike: {"CALL":q,"PUT":q}}
    exp_of = {}                          # (y,m) -> expire_datetime
    for q in quotes:
        exp = q.expire_datetime
        if _fin(exp) and float(exp) <= now:
            continue
        k = _f(q.strike_price)
        if k is None:
            continue
        y = int(q.exercise_year) if _fin(q.exercise_year) else 0
        m = int(q.exercise_month) if _fin(q.exercise_month) else 0
        buckets[(y, m)].setdefault(k, {})[str(q.option_class).upper()] = q
        if _fin(exp):
            exp_of[(y, m)] = float(exp)

    # 2) 逐月定远期 -> 逐月算 IV/Greeks
    months = []
    for key in sorted(buckets):
        y, m = key
        pairs = buckets[key]
        t = ((exp_of.get(key, 0.0) - now) / YEAR_SECONDS) if key in exp_of else -1.0
        if model == MODEL_B76:
            # 期货期权: 远期就是标的期货价本身, 不需要反推
            f_live, f_settle = fwd_live, fwd_settle
            s_live = s_settle = None
        else:
            # 现货标的: parity 反推含红利的远期, 推不出来才退回 q=0 的 S e^{rt}
            s_live, s_settle = fwd_live, fwd_settle
            carry = math.exp(r * t) if t > 0 else 1.0
            f_live = (_parity_forward(pairs, t, r, _px_live, s_live) if t > 0 else None)
            f_settle = (_parity_forward(pairs, t, r, _px_settle, s_settle) if t > 0 else None)
            if f_live is None and _pos(s_live):
                f_live = s_live * carry
            if f_settle is None and _pos(s_settle):
                f_settle = s_settle * carry

        rows = []
        for k in sorted(pairs):
            pair = pairs[k]
            row = {"k": k, "c": None, "p": None}
            for cls_, side in (("CALL", "c"), ("PUT", "p")):
                q = pair.get(cls_)
                if q is not None:
                    row[side] = _cell(q, model, f_live, f_settle,
                                      s_live, s_settle, r, prefer_settle, t)
            rows.append(row)

        f_used = f_settle if prefer_settle else f_live
        s_used = s_settle if prefer_settle else s_live
        months.append({
            "y": y, "m": m, "rows": rows,
            "f": f_used,                                    # 该月定价用的远期
            "t": t if t > 0 else None,                      # 年化剩余期限(360天)
            "days": round(t * 360.0, 2) if t > 0 else None,
            # 隐含红利率/基差率: 现货标的才有意义
            "q": ((r - math.log(f_used / s_used) / t)
                  if (model == MODEL_BS and t > 0 and _pos(f_used) and _pos(s_used)) else None),
        })
    t_calc = time.time()

    u = {
        "s": underlying,
        "n": str(uq.instrument_name or ""),
        "cls": str(uq.ins_class or ""),
        "last": _f(uq.last_price),
        "open": _f(uq.open),
        "high": _f(uq.highest),
        "low": _f(uq.lowest),
        "pre_settle": _f(uq.pre_settlement),
        "pre_close": _f(uq.pre_close),
        "settle": _f(uq.settlement),
        "vol": _f(uq.volume),
        "oi": _f(uq.open_interest),
        "bid": _f(uq.bid_price1),
        "ask": _f(uq.ask_price1),
        "tick": _f(uq.price_tick),
        "fwd": fwd_settle if prefer_settle else fwd_live,
    }
    ref = u["pre_settle"] if _pos(u["pre_settle"]) else u["pre_close"]
    if _pos(u["last"]) and _pos(ref):
        u["chg"] = u["last"] - ref
        u["chg_pct"] = u["chg"] / ref * 100.0
    else:
        u["chg"] = u["chg_pct"] = None

    return {
        "u": u,
        "months": months,
        "model": model,
        "r": r,
        "prefer_settle": prefer_settle,
        "n_opt": len(quotes),
        "timing": {
            "query": round((t1 - t0) * 1000, 1),
            "quote": round((t_quote - t1) * 1000, 1),
            "calc": round((t_calc - t_quote) * 1000, 1),
            "total": round((time.time() - t0) * 1000, 1),
        },
    }


# ---------------------------------------------------------------- 衍生指标

def _max_pain(rows):
    """
    最大痛点: 让期权买方总内在价值最小(即卖方赔付最少)的行权价。
    对候选结算价 S: 赔付 = Σ OI_call * max(S-K,0) + Σ OI_put * max(K-S,0)
    """
    ks, cs, ps = [], [], []
    for row in rows:
        k = row["k"]
        c = row.get("c") or {}
        p = row.get("p") or {}
        ks.append(k)
        cs.append(c.get("oi") or 0.0)
        ps.append(p.get("oi") or 0.0)
    if not ks or (sum(cs) + sum(ps)) <= 0:
        return None, None
    best_k, best_v = None, None
    for s in ks:
        pain = 0.0
        for k, oc, op in zip(ks, cs, ps):
            if s > k:
                pain += oc * (s - k)
            elif k > s:
                pain += op * (k - s)
        if best_v is None or pain < best_v:
            best_k, best_v = s, pain
    return best_k, best_v


def chain_stats(chain):
    """
    每个到期月的: ATM 行权价 / ATM IV(call+put 平均) / PCR(持仓量口径 & 成交量口径) /
    总持仓 / 总成交 / 最大痛点 / IV 覆盖率。
    ATM 以**该月的远期价**为基准取最近行权价 —— 用现货取会把远期贴水的远月挑偏一档。
    返回 {"fwd":..., "months":[{...}], "total":{...}}
    """
    chain_fwd = chain["u"].get("fwd")
    out = []
    tot_coi = tot_poi = tot_cv = tot_pv = 0.0
    tot_iv_ok = tot_iv_n = 0
    for mo in chain["months"]:
        rows = mo["rows"]
        fwd = mo.get("f") or chain_fwd
        coi = sum((r.get("c") or {}).get("oi") or 0.0 for r in rows)
        poi = sum((r.get("p") or {}).get("oi") or 0.0 for r in rows)
        cv = sum((r.get("c") or {}).get("vol") or 0.0 for r in rows)
        pv = sum((r.get("p") or {}).get("vol") or 0.0 for r in rows)
        iv_n = iv_ok = 0
        for r in rows:
            for side in ("c", "p"):
                cell = r.get(side)
                if cell:
                    iv_n += 1
                    if cell.get("iv") is not None:
                        iv_ok += 1
        atm_k = atm_iv = c_iv = p_iv = None
        if _pos(fwd) and rows:
            atm_row = min(rows, key=lambda r: abs(r["k"] - fwd))
            atm_k = atm_row["k"]
            c_iv = (atm_row.get("c") or {}).get("iv")
            p_iv = (atm_row.get("p") or {}).get("iv")
            vs = [v for v in (c_iv, p_iv) if v is not None]
            atm_iv = sum(vs) / len(vs) if vs else None
        mp_k, mp_v = _max_pain(rows)
        out.append({
            "y": mo["y"], "m": mo["m"], "n_strike": len(rows),
            "f": fwd, "t": mo.get("t"), "days": mo.get("days"), "q": mo.get("q"),
            "atm_k": atm_k, "atm_iv": atm_iv, "atm_c_iv": c_iv, "atm_p_iv": p_iv,
            "call_oi": coi, "put_oi": poi, "call_vol": cv, "put_vol": pv,
            "pcr_oi": (poi / coi) if coi > 0 else None,
            "pcr_vol": (pv / cv) if cv > 0 else None,
            "total_oi": coi + poi, "total_vol": cv + pv,
            "max_pain": mp_k, "max_pain_value": mp_v,
            "iv_cov": (iv_ok / iv_n) if iv_n else None,
            "iv_ok": iv_ok, "iv_n": iv_n,
        })
        tot_coi += coi; tot_poi += poi; tot_cv += cv; tot_pv += pv
        tot_iv_ok += iv_ok; tot_iv_n += iv_n
    return {
        "fwd": chain_fwd,
        "months": out,
        "total": {
            "call_oi": tot_coi, "put_oi": tot_poi,
            "call_vol": tot_cv, "put_vol": tot_pv,
            "pcr_oi": (tot_poi / tot_coi) if tot_coi > 0 else None,
            "pcr_vol": (tot_pv / tot_cv) if tot_cv > 0 else None,
            "iv_cov": (tot_iv_ok / tot_iv_n) if tot_iv_n else None,
            "iv_ok": tot_iv_ok, "iv_n": tot_iv_n,
        },
    }


# ---------------------------------------------------------------- 自测

def _fmt(v, nd=4, w=9):
    return ("--".rjust(w)) if v is None else f"{v:{w}.{nd}f}"


def _selftest():
    import os
    import sys
    try:
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except Exception:
        pass
    sys.path.insert(0, str(HERE.parent))
    from tq_auth import load_auth
    from tqsdk import TqApi, TqAuth

    user, pwd = load_auth()
    api = TqApi(auth=TqAuth(user, pwd))
    try:
        print("\n" + "=" * 100)
        print("A. 标的目录 build_underlyings")
        print("=" * 100)
        t0 = time.time()
        items = build_underlyings(api, force=("--refresh" in sys.argv))
        print(f"  标的数 {len(items)}  耗时 {time.time() - t0:.2f}s")
        grp = underlyings_by_product(items)
        print(f"  品种数 {len(grp)}")
        print("  按期权数排前 10 的标的:")
        for it in sorted(items, key=lambda x: -x["n_opt"])[:10]:
            print(f"    {it['u']:<16} {it['n']:<14} pid={it['pid']:<8} cls={it['cls']:<7} "
                  f"opt={it['n_opt']:<4} 月份={it['months']}")
        big = sorted(grp.items(), key=lambda kv: -len(kv[1]))[:8]
        print("  标的数最多的品种: " + ", ".join(f"{k}({len(v)})" for k, v in big))

        targets = ["SHFE.cu2609", "DCE.m2609", "CZCE.SR701", "SSE.510050", "SSE.000300"]
        chains = {}
        print("\n" + "=" * 100)
        print("B. 期权链 + IV 覆盖率")
        print("=" * 100)
        print(f"  {'标的':<14}{'模型':<6}{'合约':>5}{'月份':>5}{'覆盖率':>9}"
              f"{'有效/总':>12}{'取价':>13}{'query':>8}{'quote':>9}{'calc':>9}")
        for und in targets:
            try:
                ch = build_chain(api, und)
            except Exception as e:
                print(f"  {und:<14} 失败: {e}")
                continue
            chains[und] = ch
            st = chain_stats(ch)
            src = defaultdict(int)
            for mo in ch["months"]:
                for row in mo["rows"]:
                    for s in ("c", "p"):
                        cell = row.get(s)
                        if cell:
                            src[cell.get("src") or "none"] += 1
            cov = st["total"]["iv_cov"] or 0.0
            tm = ch["timing"]
            srcs = ",".join(f"{k}:{v}" for k, v in sorted(src.items(), key=lambda x: -x[1])[:2])
            print(f"  {und:<14}{ch['model']:<6}{ch['n_opt']:>5}{len(ch['months']):>5}"
                  f"{cov * 100:>8.1f}%{st['total']['iv_ok']:>7}/{st['total']['iv_n']:<5}"
                  f"{srcs:>13}{tm['query']:>7.0f}ms{tm['quote']:>7.0f}ms{tm['calc']:>7.1f}ms")

        print("\n" + "=" * 100)
        print("C. 二次调用(缓存后)的纯计算耗时 —— 目标 单链 IV+Greeks < 50ms")
        print("=" * 100)
        for und, ch in chains.items():
            qs = list(api.get_quote_list(api.query_options(und, expired=False)))
            t = time.time()
            ch2 = build_chain(api, und, quotes=qs)
            print(f"  {und:<14} 合约 {ch2['n_opt']:>4}  calc {ch2['timing']['calc']:>7.1f}ms  "
                  f"(含组装 {(time.time() - t) * 1000:.1f}ms)")

        print("\n" + "=" * 100)
        print("D. T 型报价表(人工核对: ATM 处 C/P 的 IV 应接近; CALL delta 1->0, PUT delta 0->-1)")
        print("=" * 100)
        for und in ("SHFE.cu2609", "SSE.510050"):
            ch = chains.get(und)
            if not ch:
                continue
            mo = ch["months"][0]
            st = chain_stats(ch)
            ms = st["months"][0]
            print(f"\n  {und} {ch['u']['n']}  标的={ch['u']['last']} 昨结={ch['u']['pre_settle']} "
                  f"模型={ch['model']}  到期 {mo['y']}-{mo['m']:02d}({mo['days']}天) "
                  f"定价 F={mo['f']:.4f}"
                  + (f" 隐含红利率 q={mo['q'] * 100:.2f}%" if mo["q"] is not None else "")
                  + f"  取价档={'结算价优先' if ch['prefer_settle'] else '盘中优先'}")
            print(f"  {'--- CALL ---':^44}|{'行权价':^12}|{'--- PUT ---':^44}")
            print(f"  {'last':>10}{'iv':>10}{'delta':>10}{'gamma':>12} |"
                  f"{'K':^12}| {'last':>10}{'iv':>10}{'delta':>10}{'gamma':>12}")
            fwd = mo["f"]
            for row in mo["rows"]:
                c, p = row.get("c") or {}, row.get("p") or {}
                mark = " <ATM" if ms["atm_k"] == row["k"] else ""
                print(f"  {_fmt(c.get('last'), 2, 10)}{_fmt(c.get('iv'), 4, 10)}"
                      f"{_fmt(c.get('delta'), 4, 10)}{_fmt(c.get('gamma'), 8, 12)} |"
                      f"{row['k']:^12.4f}| {_fmt(p.get('last'), 2, 10)}{_fmt(p.get('iv'), 4, 10)}"
                      f"{_fmt(p.get('delta'), 4, 10)}{_fmt(p.get('gamma'), 8, 12)}{mark}")
            print(f"  ATM K={ms['atm_k']} (F={fwd:.4f})  ATM IV={_fmt(ms['atm_iv'])} "
                  f"[C={_fmt(ms['atm_c_iv'])} P={_fmt(ms['atm_p_iv'])}] "
                  f"C/P 的 IV 差 {abs((ms['atm_c_iv'] or 0) - (ms['atm_p_iv'] or 0)) * 100:.2f} 个波动点")

        print("\n" + "=" * 100)
        print("E. 波动率微笑(按 moneyness ln(K/F) 排序, 两端应翘起)")
        print("=" * 100)
        for und in ("SHFE.cu2609", "SSE.510050", "SSE.000300"):
            ch = chains.get(und)
            if not ch:
                continue
            mo = ch["months"][0]
            fwd = mo["f"]
            print(f"\n  {und} 到期 {mo['y']}-{mo['m']:02d}  F={fwd:.4f}")
            print(f"    {'K':>12}{'ln(K/F)':>10}{'虚值侧IV':>11}   微笑")
            pts = []
            for row in mo["rows"]:
                k = row["k"]
                cell = (row.get("p") if k < fwd else row.get("c")) or {}
                if cell.get("iv") is not None:
                    pts.append((k, math.log(k / fwd), cell["iv"]))
            if not pts:
                continue
            vmin = min(p[2] for p in pts)
            for k, mny, iv in pts:
                bar = "#" * int(min(60, (iv - vmin) * 400 + 1))
                print(f"    {k:>12.4f}{mny:>10.4f}{iv:>11.4f}   {bar}")
            edge = (pts[0][2] + pts[-1][2]) / 2.0
            mid_iv = min(pts, key=lambda x: abs(x[1]))[2]
            print(f"    两端均值 {edge:.4f}  ATM 附近 {mid_iv:.4f}  "
                  f"-> {'微笑成立(两端翘起)' if edge > mid_iv else '⚠ 两端未翘起'}")

        print("\n" + "=" * 100)
        print("F. 每月统计 chain_stats")
        print("=" * 100)
        for und, ch in chains.items():
            st = chain_stats(ch)
            print(f"\n  {und}  标的={st['fwd']}  模型={ch['model']}")
            print(f"    {'到期':>8}{'档':>4}{'天':>7}{'远期F':>12}{'q%':>7}{'ATM K':>12}{'ATM IV':>9}"
                  f"{'PCR(OI)':>10}{'PCR(VOL)':>10}{'总持仓':>12}{'最大痛点':>12}{'IV覆盖':>9}")
            for m in st["months"]:
                qs = "    --" if m["q"] is None else f"{m['q'] * 100:>6.2f}"
                print(f"    {m['y']}-{m['m']:02d}{m['n_strike']:>4}{(m['days'] or 0):>7.1f}"
                      f"{(m['f'] or 0):>12.2f}{qs}{(m['atm_k'] or 0):>12.4f}"
                      f"{_fmt(m['atm_iv'], 4, 9)}{_fmt(m['pcr_oi'], 3, 10)}{_fmt(m['pcr_vol'], 3, 10)}"
                      f"{m['total_oi']:>12.0f}{(m['max_pain'] or 0):>12.4f}"
                      f"{(m['iv_cov'] or 0) * 100:>8.1f}%")

        print(f"\n  seen_symbols() 白名单已登记 {len(seen_symbols())} 个期权代码")
        print("\n自测结束")
    finally:
        api.close()


if __name__ == "__main__":
    _selftest()
