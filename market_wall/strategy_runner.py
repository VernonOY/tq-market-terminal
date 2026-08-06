"""策略运行器：把 `Trade/` 下的程序化策略接进行情终端。

`server.py` 在启动时 `import strategy_runner` 并构造 `StrategyHub(data_dir=...)`，
之后通过这几个方法与之交互（接口由 server.py 既有代码定义，本模块只是补上实现）：

    snapshot_json()          → 推送给前端的快照(JSON 字符串)，每次广播都调
    list()                   → 策略列表
    files()                  → Trade/ 下可启动的策略文件
    log(id, limit)           → 某策略的日志尾部
    start(file, init_balance)→ 拉起一个策略进程
    stop(id)                 → 停掉

设计：策略与平台**完全解耦**
----------------------------
策略进程只做一件事 —— 把自己的状态原子写到 `Trade/state/<id>.json`。
本模块只读那个文件。于是：

- 平台挂了不影响交易（策略是独立进程）
- 策略挂了平台照常显示最后状态 + 「已断线」标记
- 平台不需要知道任何策略内部实现

`snapshot_json` 会被高频调用（每次行情广播），所以按文件 mtime 做缓存，
没变就不重新读盘、不重新序列化。
"""
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

try:
    from account import NavStore, nav_stats
except Exception:                 # account.py 缺失或 tqsdk 未装, 策略监控仍应可用
    NavStore = nav_stats = None

BASE = Path(__file__).resolve().parent.parent
TRADE_DIR = BASE / "Trade"
STATE_DIR = TRADE_DIR / "state"
LOG_DIR = TRADE_DIR / "logs"
NAV_DIR = Path(os.environ.get("MW_DATA") or Path(__file__).resolve().parent) / "nav"
PYTHON = str(BASE / ".venv" / "bin" / "python")

STALE_SEC = 90        # 状态文件超过这么久没更新 → 标记为已断线


class StrategyHub:
    def __init__(self, data_dir=None):
        self._nav = {}
        self.data_dir = Path(data_dir) if data_dir else BASE
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        self.procs = {}                # id -> Popen
        self._cache = (None, 0.0, "")  # (mtimes签名, 生成时刻, json串)

    # ---------------- 读状态 ----------------

    # 策略上报的 account 是中文键(各策略自己定的), 归一化成和 account.py 一致的英文键,
    # 净值分析页才能和终端账户用同一套口径
    ACC_MAP = {
        "权益": "balance", "浮动盈亏": "float_profit", "浮盈": "float_profit",
        "平仓盈亏": "close_profit", "手续费": "commission", "保证金": "margin",
        "可用": "available", "可用资金": "available", "静态权益": "static_balance",
        "持仓盈亏": "position_profit", "风险度": "risk_ratio",
    }

    @classmethod
    def norm_account(cls, acc):
        if not isinstance(acc, dict):
            return {}
        out = {}
        for k, v in acc.items():
            out[cls.ACC_MAP.get(k, k)] = v
        # 策略一般只报权益和浮盈, 可用资金推算: 权益 - 保证金
        if "available" not in out and out.get("balance") is not None:
            try:
                out["available"] = float(out["balance"]) - float(out.get("margin") or 0)
            except (TypeError, ValueError):
                pass
        return out

    def _sample_nav(self, sid, d):
        """把策略自己账户的权益采进净值序列。
        终端自带的 sim 账户和策略账户是两个完全独立的 TqSim —— 只采终端那个的话,
        净值曲线永远是一条直线(用户第一次打开就是这个现象)。"""
        if NavStore is None:
            return
        acc = self.norm_account(d.get("account"))
        bal = acc.get("balance")
        if bal is None:
            return
        st = self._nav.get(sid)
        if st is None:
            NAV_DIR.mkdir(parents=True, exist_ok=True)
            st = NavStore(NAV_DIR / f"strat_{sid}.jsonl")
            st.load()
            self._nav[sid] = st
        f = lambda k: float(acc.get(k) or 0)      # noqa: E731
        try:
            st.maybe_append(time.time(), float(bal), f("available"), f("margin"),
                            f("float_profit"), f("risk_ratio"))
        except Exception:
            pass                                  # 采样失败不能影响策略监控本身

    def nav(self, sid, days=None):
        st = self._nav.get(sid)
        if st is None or NavStore is None:
            return {"type": "acct_nav", "id": sid, "points": [], "stats": {}}
        pts = st.slice(days)
        return {"type": "acct_nav", "id": sid, "points": pts,
                "stats": nav_stats(pts) if nav_stats else {}}

    def _read_all(self):
        out = {}
        for p in sorted(STATE_DIR.glob("*.json")):
            try:
                d = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue                       # 正在写一半（不该发生，写入是原子的）
            sid = d.get("id") or p.stem
            age = time.time() - p.stat().st_mtime
            d["stale_sec"] = round(age, 1)
            # 进程还在不在：优先看我们自己拉起的，其次看状态文件新鲜度
            # 存活判定优先看 PID（策略可能是命令行手动起的，不在 self.procs 里），
            # 其次才看状态文件新鲜度 —— 只看新鲜度会把「正在做耗时初始化」误判成断线
            proc = self.procs.get(sid)
            pid = d.get("pid")
            if proc is not None and proc.poll() is None:
                d["alive"] = True
            elif pid:
                try:
                    os.kill(int(pid), 0)
                    d["alive"] = True
                except (OSError, ValueError):
                    d["alive"] = False
            else:
                d["alive"] = age < STALE_SEC
            if not d["alive"] and d.get("status") == "running":
                d["status"] = "disconnected"
                d["phase"] = f"已断线（{int(age)}s 无更新）"
            out[sid] = d
            self._sample_nav(sid, d)
        return out

    def snapshot_json(self):
        """给 server.py 广播用。按 mtime 缓存，避免每次广播都读盘+序列化。"""
        try:
            sig = tuple(sorted((p.name, p.stat().st_mtime)
                               for p in STATE_DIR.glob("*.json")))
        except OSError:
            return ""
        if not sig:
            return ""
        # 断线判定依赖时间流逝，所以缓存最多留 5 秒
        if sig == self._cache[0] and time.time() - self._cache[1] < 5:
            return self._cache[2]
        js = json.dumps(self._read_all(), ensure_ascii=False, default=str)
        self._cache = (sig, time.time(), js)
        return js

    def list(self):
        return list(self._read_all().values())

    # ---- 「持仓成交」页：策略账户的逐仓/成交明细 ----
    # 终端的 AccountHub 只认识 accounts.json 里的账户，不认识策略的进程内账户，
    # 所以这两个接口由策略上报的状态直接供数。
    _POS_COLS = ("code", "symbol", "direction", "volume", "open_price",
                 "last_price", "float_bp", "hold_min", "open_time")
    _TRD_COLS = ("code", "side", "z", "entry_time", "entry_price", "entry_passive",
                 "exit_time", "exit_price", "exit_passive")

    def _one(self, acct_id):
        sid = str(acct_id).split(":", 1)[-1]
        return self._read_all().get(sid)

    def positions(self, acct_id):
        d = self._one(acct_id) or {}
        rows = [[p.get(c) for c in self._POS_COLS] for p in (d.get("positions") or [])]
        return {"type": "acct_positions", "id": acct_id,
                "cols": list(self._POS_COLS), "rows": rows}

    def trades(self, acct_id, limit=200):
        d = self._one(acct_id) or {}
        sig = [s for s in (d.get("signals") or []) if s.get("exit_price") is not None]
        rows = [[s.get(c) for c in self._TRD_COLS] for s in sig[-limit:]]
        return {"type": "acct_trades", "id": acct_id,
                "cols": list(self._TRD_COLS), "rows": rows}

    def orders(self, acct_id):
        """进行中的仓位即未了结的委托 —— 策略不单独维护委托簿。"""
        d = self._one(acct_id) or {}
        sig = [s for s in (d.get("signals") or []) if s.get("exit_price") is None]
        rows = [[s.get(c) for c in self._TRD_COLS] for s in sig]
        return {"type": "acct_orders", "id": acct_id,
                "cols": list(self._TRD_COLS), "rows": rows}

    def files(self):
        """可启动的策略文件。协议要求 [{name,size,mtime}], 不是裸文件名列表。"""
        out = []
        for p in sorted(TRADE_DIR.glob("*.py")):
            if p.name.startswith("_"):
                continue
            try:
                st = p.stat()
                out.append({"name": p.name, "size": st.st_size, "mtime": st.st_mtime})
            except OSError:
                continue
        return out

    def log(self, sid, limit=300):
        if not sid:
            return []
        cands = sorted(LOG_DIR.glob(f"*{sid}*.log")) + sorted(LOG_DIR.glob("run_*.log"))
        if not cands:
            return ["(无日志文件)"]
        try:
            lines = cands[-1].read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            return [f"(读日志失败: {e})"]
        drop = ("免责", "disclaimer", "TqSdk trial")
        lines = [x for x in lines if not any(k in x for k in drop)]
        return lines[-limit:]

    # ---------------- 起停 ----------------

    def start(self, file, init_balance=None):
        f = (TRADE_DIR / file).resolve()
        if TRADE_DIR not in f.parents or not f.exists():
            return {"type": "err", "msg": f"策略文件不存在: {file}"}
        sid = f.stem
        proc = self.procs.get(sid)
        if proc is not None and proc.poll() is None:
            return {"type": "err", "msg": f"{sid} 已在运行(pid {proc.pid})"}
        stamp = time.strftime("%Y%m%d_%H%M%S")
        logf = LOG_DIR / f"{sid}_{stamp}.log"
        try:
            fh = open(logf, "w", encoding="utf-8")
            self.procs[sid] = subprocess.Popen(
                [PYTHON, "-u", str(f)], cwd=str(BASE),
                stdout=fh, stderr=subprocess.STDOUT, start_new_session=True)
        except Exception as e:
            return {"type": "err", "msg": f"启动失败: {type(e).__name__}: {e}"}
        return {"type": "strat_started", "id": sid,
                "pid": self.procs[sid].pid, "log": logf.name}

    def stop(self, sid):
        proc = self.procs.get(sid)
        if proc is None or proc.poll() is not None:
            return {"type": "err", "msg": f"{sid} 未在运行(或不是本终端拉起的)"}
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            proc.terminate()
        return {"type": "strat_stopped", "id": sid}
