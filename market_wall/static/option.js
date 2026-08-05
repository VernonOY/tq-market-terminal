/* ============================================================================
   option.js — 期权模式 (T 型报价终端)  独立自包含模块
   ----------------------------------------------------------------------------
   对外只暴露:
     window.OptionView = { mount(rootEl, opts), destroy(), isMounted() }
       opts = {
         request(action, payload) -> Promise<resp>   // 由集成方注入, 负责 req id + WS 往返
         fmtVol(n)                                   // 可选, 数量格式化
         onPickSymbol(sym)                           // 可选, 点击某腿 -> 切 K 线图
       }

   用到的协议(集成方保证):
     request("optunderlyings", {})
       -> {type:"optunderlyings", items:[{u,n,ex,pid,n_opt,months:[[y,m],...]}]}
     request("optchain", {underlying:U})
       -> {type:"optchain", underlying:U, u:{标的行情},
           months:[{y,m,rows:[{k, c:{s,last,bid,ask,vol,oi,settle,iv,delta,gamma,vega,theta},
                                  p:{同上}}, ...]}]}
     任何 {type:"err", msg} 或 Promise reject 都会渲染成错误态

   纯原生 JS / 无依赖 / 样式动态注入 (style#opt-style) / 类名统一 opt- 前缀
   ========================================================================== */
"use strict";

window.OptionView = (function () {

  /* ======================= 常量 ======================= */

  const STYLE_ID = "opt-style";
  const DASH = "--";

  /* 品种分组 chips。pids 为该组覆盖的 product_id(小写) */
  const GROUPS = [
    { id: "ALL", label: "全部", pids: [] },
    {
      id: "PRECIOUS", label: "贵金属",
      pids: ["au", "ag"],
    },
    {
      id: "NONFERROUS", label: "有色",
      pids: ["cu", "al", "zn", "pb", "ni", "sn", "ss", "ao", "bc", "si", "lc", "ps", "ad"],
    },
    {
      id: "BLACK", label: "黑色",
      pids: ["rb", "hc", "i", "j", "jm", "sm", "sf", "wr", "sh0"],
    },
    {
      id: "CHEM", label: "能化",
      pids: ["sc", "lu", "fu", "bu", "ru", "nr", "br", "l", "v", "pp", "eb", "eg", "pg",
        "ta", "ma", "sa", "fg", "ur", "pf", "px", "sh", "pr", "ec"],
    },
    {
      id: "AGRI", label: "农产品",
      pids: ["a", "b", "m", "y", "p", "c", "cs", "jd", "lh", "rm", "oi", "cf", "cy",
        "sr", "ap", "cj", "pk", "lg", "rs", "ri", "pm", "wh", "jr", "lr", "ph"],
    },
    { id: "FIN", label: "金融", pids: ["if", "ih", "ic", "im", "t", "tf", "ts", "tl"] },
    { id: "OTHER", label: "其他", pids: [] },
  ];
  const PID2GROUP = (() => {
    const m = {};
    for (const g of GROUPS) for (const p of g.pids) m[p] = g.id;
    return m;
  })();

  /* T 型表列定义。side: c=CALL 侧, p=PUT 侧 */
  const CALL_COLS = [
    { k: "theta", label: "Θ" },
    { k: "vega", label: "Vega" },
    { k: "gamma", label: "Γ" },
    { k: "delta", label: "Δ" },
    { k: "iv", label: "IV" },
    { k: "oi", label: "持仓" },
    { k: "vol", label: "量" },
    { k: "bid", label: "买" },
    { k: "ask", label: "卖" },
    { k: "last", label: "最新" },
  ];
  const PUT_COLS = [
    { k: "last", label: "最新" },
    { k: "bid", label: "买" },
    { k: "ask", label: "卖" },
    { k: "vol", label: "量" },
    { k: "oi", label: "持仓" },
    { k: "iv", label: "IV" },
    { k: "delta", label: "Δ" },
    { k: "gamma", label: "Γ" },
    { k: "vega", label: "Vega" },
    { k: "theta", label: "Θ" },
  ];

  const CHART_TABS = [
    { id: "smile", label: "波动率微笑" },
    { id: "oi", label: "持仓量分布" },
    { id: "surface", label: "波动率曲面" },
  ];

  const FONT = '11px system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif';
  const FONT_SM = '10px system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif';
  const FONT_B = '600 11px system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif';

  /* ======================= 模块状态 ======================= */

  let root = null;              // 挂载根
  let opts = {};
  let els = null;               // DOM 句柄集合
  let unders = [];              // 归一化后的标的列表
  let curGroup = "ALL";
  let curU = null;              // 当前标的代码
  let chain = null;             // {underlying, uq:{...}, months:[...], ivMul, digits}
  let curMonthKey = null;
  let chartTab = "smile";
  let reqSeq = 0;               // 防串台: 只认最后一次请求
  let ro = null;
  let cvW = 0, cvH = 0, cvDpr = 0;
  let C = null;                 // 颜色缓存

  /* ======================= 工具 ======================= */

  const $c = (t) => document.createElement(t);
  const isNum = (v) => v !== null && v !== undefined && v !== "" && isFinite(v);
  const pad2 = (n) => String(n).padStart(2, "0");

  function num(v) { return isNum(v) ? Number(v) : null; }

  /* 从对象里按候选键名取第一个数字 */
  function pickNum(o, keys) {
    if (!o) return null;
    for (const k of keys) if (isNum(o[k])) return Number(o[k]);
    return null;
  }
  function pickStr(o, keys) {
    if (!o) return "";
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return String(o[k]);
    return "";
  }

  function fmtVol(n) {
    if (typeof opts.fmtVol === "function") {
      try { const s = opts.fmtVol(n); if (s !== undefined && s !== null) return String(s); } catch (e) { }
    }
    if (!isNum(n)) return DASH;
    n = Number(n);
    return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿"
      : n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(n);
  }

  function decOf(v) {
    if (!isNum(v)) return 0;
    const s = String(Number(Number(v).toPrecision(12)));
    if (s.indexOf("e") >= 0 || s.indexOf("E") >= 0) return 4;
    return s.indexOf(".") >= 0 ? Math.min(4, s.split(".")[1].length) : 0;
  }
  function fmtPx(v, d) { return isNum(v) ? Number(v).toFixed(d) : DASH; }
  function fmtStrike(v, d) { return isNum(v) ? Number(v).toFixed(d) : DASH; }
  function fmtIV(v, mul) { return isNum(v) ? (Number(v) * mul).toFixed(2) + "%" : DASH; }
  function fmtDelta(v) { return isNum(v) ? Number(v).toFixed(3) : DASH; }
  /* 标的价显示位数: 至少和行权价一样细, 有更细的报价就跟报价 */
  function sDigits() {
    if (!chain) return 2;
    return Math.min(4, Math.max(chain.kDigits, decOf(chain.uq.last)));
  }
  function sgnCls(v) { return !isNum(v) || v === 0 ? "opt-flat" : v > 0 ? "opt-up" : "opt-down"; }

  function cssVar(n, fb) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      return v || fb;
    } catch (e) { return fb; }
  }
  function colors() {
    if (C) return C;
    C = {
      page: cssVar("--page", "#0d0d0d"),
      surface: cssVar("--surface", "#1a1a19"),
      surface2: cssVar("--surface-2", "#222221"),
      ink: cssVar("--ink", "#ffffff"),
      ink2: cssVar("--ink-2", "#c3c2b7"),
      muted: cssVar("--muted", "#898781"),
      grid: cssVar("--grid", "#2c2c2a"),
      up: cssVar("--up", "#e66767"),
      down: cssVar("--down", "#199e70"),
      ma5: cssVar("--ma5", "#3987e5"),
      ma10: cssVar("--ma10", "#d95926"),
      ma20: cssVar("--ma20", "#9085e9"),
      ma60: cssVar("--ma60", "#d55181"),
    };
    return C;
  }
  function rgba(hex, a) {
    let h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length < 6) return "rgba(255,255,255," + a + ")";
    const r = parseInt(h.slice(0, 2), 16) || 0,
      g = parseInt(h.slice(2, 4), 16) || 0,
      b = parseInt(h.slice(4, 6), 16) || 0;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function monthPalette(i) {
    const c = colors();
    const arr = [c.ma5, c.ma10, c.ma20, c.ma60, c.up, c.down, "#4bbfa2", "#c9a227"];
    return arr[i % arr.length];
  }

  /* ======================= 样式 ======================= */

  const CSS = `
#opt-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif;
  -webkit-user-select:none;user-select:none;}
#opt-root *{box-sizing:border-box;}

/* ---------- 顶部标的选择器 ---------- */
.opt-picker{flex:0 0 auto;background:var(--surface,#1a1a19);
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.opt-groups{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 12px 6px;}
.opt-chip{background:var(--surface-2,#222221);color:var(--muted,#898781);
  border:1px solid var(--border,rgba(255,255,255,.10));border-radius:12px;
  padding:3px 12px;font:12px/1.4 inherit;cursor:pointer;white-space:nowrap;}
.opt-chip:hover{color:var(--ink-2,#c3c2b7);border-color:var(--muted,#898781);}
.opt-chip.on{color:var(--ink,#fff);background:var(--ma5,#3987e5);border-color:var(--ma5,#3987e5);}
.opt-ucount{margin-left:auto;font-size:11px;color:var(--muted,#898781);
  font-variant-numeric:tabular-nums;white-space:nowrap;}
.opt-unders{display:flex;gap:6px;padding:0 12px 9px;overflow-x:auto;overflow-y:hidden;}
.opt-unders::-webkit-scrollbar{height:7px;}
.opt-unders::-webkit-scrollbar-thumb{background:var(--grid,#2c2c2a);border-radius:4px;}
.opt-u{flex:0 0 auto;min-width:98px;padding:4px 10px 5px;border-radius:4px;cursor:pointer;
  background:var(--surface-2,#222221);border:1px solid var(--border,rgba(255,255,255,.10));}
.opt-u:hover{border-color:var(--muted,#898781);}
.opt-u.on{border-color:var(--ma5,#3987e5);background:rgba(57,135,229,.16);}
.opt-u-n{color:var(--ink,#fff);font-weight:600;font-size:12.5px;white-space:nowrap;}
.opt-u-s{display:flex;gap:7px;align-items:baseline;margin-top:1px;
  font-size:10.5px;color:var(--muted,#898781);white-space:nowrap;
  font-variant-numeric:tabular-nums;}
.opt-u.on .opt-u-s{color:var(--ink-2,#c3c2b7);}
.opt-u-empty{padding:6px 2px;font-size:12px;color:var(--muted,#898781);}

/* ---------- 概览条 ---------- */
.opt-ov{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:6px 20px;
  padding:7px 14px;background:var(--surface-2,#222221);
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.opt-ov-main{display:flex;align-items:baseline;gap:9px;min-width:210px;}
.opt-ov-name{color:var(--ink,#fff);font-weight:600;font-size:14px;white-space:nowrap;}
.opt-ov-code{color:var(--muted,#898781);font-size:11px;}
.opt-ov-px{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1;}
.opt-ov-chg{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap;}
.opt-kv{display:flex;flex-direction:column;gap:1px;min-width:56px;}
.opt-k{font-size:10px;color:var(--muted,#898781);letter-spacing:.05em;white-space:nowrap;}
.opt-v{font-size:13px;color:var(--ink,#fff);font-variant-numeric:tabular-nums;white-space:nowrap;}
.opt-v.small{font-size:12px;}
.opt-sel{background:var(--surface,#1a1a19);color:var(--ink,#fff);font:12px/1.4 inherit;
  border:1px solid var(--border,rgba(255,255,255,.10));border-radius:3px;
  padding:2px 6px;cursor:pointer;font-variant-numeric:tabular-nums;}
.opt-sel:focus{outline:1px solid var(--ma5,#3987e5);}

/* ---------- T 型表 ---------- */
.opt-body{flex:1 1 auto;min-height:0;overflow:auto;position:relative;}
.opt-body::-webkit-scrollbar{width:9px;height:9px;}
.opt-body::-webkit-scrollbar-thumb{background:var(--grid,#2c2c2a);border-radius:4px;}
.opt-table{width:100%;min-width:1020px;table-layout:fixed;border-collapse:separate;
  border-spacing:0;font-variant-numeric:tabular-nums;}
.opt-table th{position:sticky;z-index:3;background:var(--surface,#1a1a19);
  color:var(--muted,#898781);font-weight:400;font-size:11px;letter-spacing:.04em;
  padding:4px 8px;white-space:nowrap;
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.opt-table tr.opt-h1 th{top:0;height:25px;font-size:11.5px;text-align:center;
  letter-spacing:.12em;}
.opt-table tr.opt-h2 th{top:25px;height:24px;}
.opt-h1 .opt-hc{color:var(--up,#e66767);font-weight:600;}
.opt-h1 .opt-hp{color:var(--down,#199e70);font-weight:600;}
.opt-h1 .opt-hk{color:var(--ink,#fff);font-weight:600;letter-spacing:.06em;
  background:var(--surface,#1a1a19);}
.opt-table th.opt-tc{text-align:right;}
.opt-table th.opt-tp{text-align:left;}
.opt-table th.opt-tk{text-align:center;color:var(--ink-2,#c3c2b7);}

.opt-row td{padding:3px 8px;white-space:nowrap;font-size:12px;
  border-bottom:1px solid var(--grid,#2c2c2a);background-repeat:no-repeat;cursor:pointer;}
.opt-row td.opt-tc{text-align:right;}
.opt-row td.opt-tp{text-align:left;}
.opt-row:hover td{box-shadow:inset 0 -1px 0 var(--border,rgba(255,255,255,.10));}
.opt-row:hover td.opt-c-side,.opt-row:hover td.opt-p-side{background-color:var(--surface-2,#222221);}
.opt-itm{background-color:rgba(255,255,255,.065);}
.opt-row:hover td.opt-itm{background-color:rgba(255,255,255,.10);}
td.opt-kcell{text-align:center;font-weight:700;font-size:12.5px;color:var(--ink,#fff);
  background:var(--surface,#1a1a19);cursor:default;
  border-left:1px solid var(--border,rgba(255,255,255,.10));
  border-right:1px solid var(--border,rgba(255,255,255,.10));}
.opt-row.opt-atm td{border-top:1px solid rgba(57,135,229,.55);
  border-bottom:1px solid rgba(57,135,229,.55);}
.opt-row.opt-atm td.opt-kcell{background:rgba(57,135,229,.24);color:#fff;}
.opt-atm-tag{display:inline-block;margin-left:5px;font-size:9px;font-weight:400;
  padding:0 3px;border-radius:2px;color:var(--ma5,#3987e5);
  border:1px solid rgba(57,135,229,.5);vertical-align:1px;}
.opt-mp-tag{display:inline-block;margin-left:5px;font-size:9px;font-weight:400;
  padding:0 3px;border-radius:2px;color:var(--ma10,#d95926);
  border:1px solid rgba(217,89,38,.5);vertical-align:1px;}
.opt-up{color:var(--up,#e66767);}
.opt-down{color:var(--down,#199e70);}
.opt-flat{color:var(--ink-2,#c3c2b7);}
.opt-dim{color:var(--muted,#898781);}
.opt-iv{color:var(--ma20,#9085e9);}
.opt-last{font-weight:600;}

/* ---------- 底部图表 ---------- */
.opt-charts{flex:0 0 auto;background:var(--surface,#1a1a19);
  border-top:1px solid var(--border,rgba(255,255,255,.10));}
.opt-ctabs{display:flex;align-items:center;gap:2px;padding:0 10px;
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.opt-ctab{background:none;border:none;font:inherit;font-size:12px;cursor:pointer;
  color:var(--muted,#898781);padding:7px 12px 6px;border-bottom:2px solid transparent;}
.opt-ctab:hover{color:var(--ink-2,#c3c2b7);}
.opt-ctab.on{color:var(--ink,#fff);font-weight:600;border-bottom-color:var(--ma5,#3987e5);}
.opt-cnote{margin-left:auto;font-size:11px;color:var(--muted,#898781);
  font-variant-numeric:tabular-nums;padding-right:4px;}
.opt-cwrap{position:relative;height:236px;}
.opt-cwrap canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}

/* ---------- 骨架屏 / 空态 / 错误态 ---------- */
.opt-skel{padding:12px 14px;}
.opt-skel-bar{height:20px;border-radius:3px;margin-bottom:7px;
  background:linear-gradient(90deg,#1a1a19 25%,#2c2c2a 37%,#1a1a19 63%);
  background-size:400% 100%;animation:opt-sh 1.25s ease-in-out infinite;}
.opt-skel-head{height:26px;margin-bottom:11px;}
@keyframes opt-sh{0%{background-position:100% 0;}100%{background-position:0 0;}}
.opt-skel-tip{text-align:center;color:var(--muted,#898781);font-size:12px;padding:10px 0 2px;}
.opt-msg{padding:34px 20px;text-align:center;color:var(--muted,#898781);font-size:12.5px;
  line-height:1.9;}
.opt-msg b{display:block;color:var(--ink-2,#c3c2b7);font-size:13px;font-weight:600;}
.opt-retry{margin-top:10px;background:var(--surface-2,#222221);color:var(--ink-2,#c3c2b7);
  border:1px solid var(--border,rgba(255,255,255,.10));border-radius:3px;
  padding:4px 14px;font:12px/1.4 inherit;cursor:pointer;}
.opt-retry:hover{color:var(--ink,#fff);border-color:var(--muted,#898781);}
.opt-hide{display:none !important;}
`;

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = $c("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ======================= DOM 骨架 ======================= */

  function build() {
    root.id = "opt-root";
    root.innerHTML = "";

    /* --- 选择器 --- */
    const picker = $c("div"); picker.className = "opt-picker";
    const groups = $c("div"); groups.className = "opt-groups";
    for (const g of GROUPS) {
      const b = $c("button");
      b.className = "opt-chip" + (g.id === curGroup ? " on" : "");
      b.dataset.id = g.id;
      b.textContent = g.label;
      b.addEventListener("click", () => { curGroup = g.id; renderUnders(); });
      groups.appendChild(b);
    }
    const ucount = $c("span"); ucount.className = "opt-ucount";
    groups.appendChild(ucount);
    const ulist = $c("div"); ulist.className = "opt-unders";
    picker.append(groups, ulist);

    /* --- 概览条 --- */
    const ov = $c("div"); ov.className = "opt-ov";

    /* --- 主体 --- */
    const body = $c("div"); body.className = "opt-body";

    /* --- 图表 --- */
    const charts = $c("div"); charts.className = "opt-charts";
    const ctabs = $c("div"); ctabs.className = "opt-ctabs";
    for (const t of CHART_TABS) {
      const b = $c("button");
      b.className = "opt-ctab" + (t.id === chartTab ? " on" : "");
      b.dataset.id = t.id;
      b.textContent = t.label;
      b.addEventListener("click", () => {
        chartTab = t.id;
        for (const x of ctabs.querySelectorAll(".opt-ctab")) x.classList.toggle("on", x.dataset.id === t.id);
        drawChart();
      });
      ctabs.appendChild(b);
    }
    const cnote = $c("span"); cnote.className = "opt-cnote";
    ctabs.appendChild(cnote);
    const spacer = $c("span"); spacer.style.flex = "1 1 auto";
    const rbtn = $c("button"); rbtn.className = "opt-ctab"; rbtn.textContent = "↻ 刷新";
    rbtn.addEventListener("click", () => { if (curU) selectUnderlying(curU); });
    const rtoggle = $c("button"); rtoggle.className = "opt-ctab on"; rtoggle.textContent = "自动";
    rtoggle.addEventListener("click", () => {
      refOn = !refOn;
      rtoggle.classList.toggle("on", refOn);
      if (refOn) scheduleRefresh(); else clearTimeout(refTimer);
      setRefreshTag();
    });
    const rtag = $c("span"); rtag.className = "opt-cnote";
    ctabs.append(spacer, rtag, rbtn, rtoggle);
    const cwrap = $c("div"); cwrap.className = "opt-cwrap";
    const cv = $c("canvas");
    cwrap.appendChild(cv);
    charts.append(ctabs, cwrap);

    root.append(picker, ov, body, charts);
    els = { picker, groups, ucount, ulist, ov, body, charts, ctabs, cnote, cwrap, cv, rtag };

    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { if (resizeCanvas()) drawChart(); });
      try { ro.observe(cwrap); } catch (e) { }
    }
    window.addEventListener("resize", onWinResize);
  }

  function onWinResize() { if (resizeCanvas()) drawChart(); }

  /* ======================= 标的列表 ======================= */

  function groupOf(it) {
    const pid = String(it.pid || "").toLowerCase();
    if (pid && PID2GROUP[pid]) return PID2GROUP[pid];
    /* pid 缺失时的兜底: 交易所 + 代码猜测 */
    const ex = String(it.ex || "").toUpperCase();
    if (ex === "CFFEX" || ex === "SSE" || ex === "SZSE") return "FIN";
    const tail = String(it.u || "").split(".").pop().toLowerCase();
    const m = tail.match(/^([a-z]{1,3})\d/);
    if (m && PID2GROUP[m[1]]) return PID2GROUP[m[1]];
    return "OTHER";
  }

  function normUnders(items) {
    return (items || []).map((it) => {
      const u = String(it.u || it.symbol || "");
      const o = {
        u,
        n: String(it.n || it.name || u),
        ex: String(it.ex || (u.indexOf(".") > 0 ? u.split(".")[0] : "")),
        pid: it.pid || "",
        n_opt: isNum(it.n_opt) ? Number(it.n_opt) : null,
        months: Array.isArray(it.months) ? it.months : [],
      };
      o.g = groupOf(o);
      return o;
    }).filter((o) => o.u);
  }

  function renderUnders() {
    if (!els) return;
    for (const c of els.groups.querySelectorAll(".opt-chip")) c.classList.toggle("on", c.dataset.id === curGroup);
    const list = unders.filter((o) => curGroup === "ALL" || o.g === curGroup);
    els.ucount.textContent = list.length + " / " + unders.length + " 个标的";
    els.ulist.innerHTML = "";
    if (!list.length) {
      const e = $c("div"); e.className = "opt-u-empty";
      e.textContent = unders.length ? "该分组下没有可交易期权的标的" : "暂无标的";
      els.ulist.appendChild(e);
      return;
    }
    for (const o of list) {
      const d = $c("div");
      d.className = "opt-u" + (o.u === curU ? " on" : "");
      d.dataset.u = o.u;
      const n = $c("div"); n.className = "opt-u-n"; n.textContent = o.n || o.u;
      const s = $c("div"); s.className = "opt-u-s";
      const s1 = $c("span"); s1.textContent = o.u;
      const s2 = $c("span");
      s2.textContent = (o.n_opt !== null ? o.n_opt : (o.months.length ? o.months.length + "月" : ""));
      s.append(s1, s2);
      d.append(n, s);
      d.addEventListener("click", () => selectUnderlying(o.u));
      els.ulist.appendChild(d);
    }
  }

  /* ======================= 加载流程 ======================= */

  function callRequest(action, payload) {
    if (!opts || typeof opts.request !== "function") {
      return Promise.reject(new Error("未注入 request()"));
    }
    let p;
    try { p = opts.request(action, payload || {}); } catch (e) { return Promise.reject(e); }
    return Promise.resolve(p).then((resp) => {
      if (resp && resp.type === "err") throw new Error(resp.msg || "服务端错误");
      if (!resp) throw new Error("空响应");
      return resp;
    });
  }

  function loadUnderlyings() {
    showMessage("加载标的列表…", null);
    const my = ++reqSeq;
    callRequest("optunderlyings", {}).then((resp) => {
      if (my !== reqSeq || !els) return;
      unders = normUnders(resp.items);
      renderUnders();
      if (unders.length) {
        // 默认不要按字典序取第一个(会落到苹果/红枣这类冷门期权, 满屏是"--"),
        // 优先挑主流活跃标的; 上次看过的记住
        const pool = unders.filter((o) => curGroup === "ALL" || o.g === curGroup);
        let pick = null;
        try {
          const last = localStorage.getItem("mw:optU");
          if (last) pick = pool.find((o) => o.u === last) || unders.find((o) => o.u === last);
        } catch (e) { /* 隐私模式 */ }
        if (!pick) {
          const PREF = ["SHFE.cu", "SHFE.au", "SHFE.ag", "DCE.m", "DCE.i",
                        "CZCE.TA", "SSE.510050", "SSE.510300", "SSE.000300"];
          for (const p of PREF) {
            pick = pool.find((o) => o.u.startsWith(p)) || unders.find((o) => o.u.startsWith(p));
            if (pick) break;
          }
        }
        // 兜底: 挑期权数量最多的(通常就是最活跃的)
        if (!pick) pick = (pool.length ? pool : unders)
          .slice().sort((a, b) => (b.n_opt || 0) - (a.n_opt || 0))[0];
        selectUnderlying(pick.u);
      } else {
        showMessage("没有可交易期权的标的", null);
      }
    }).catch((err) => {
      if (my !== reqSeq || !els) return;
      showMessage("标的列表加载失败", String((err && err.message) || err), loadUnderlyings);
    });
  }

  function rememberU(u) { try { localStorage.setItem("mw:optU", u); } catch (e) { /* 忽略 */ } }
  /* 期权链原本只在切标的时拉一次 —— 盘中打开 T 表, 买卖价/持仓从此冻住。
     加一个静默重拉: 不清表、不闪骨架, 只换数据, 保持当前到期月和滚动位置。 */
  let refTimer = 0, refOn = true;
  const REFRESH_MS = 6000;
  function scheduleRefresh() {
    clearTimeout(refTimer);
    if (!refOn || !curU || !els) return;
    refTimer = setTimeout(() => {
      if (document.hidden || !els || isHidden()) { scheduleRefresh(); return; }
      const u = curU, my = ++reqSeq;
      const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      callRequest("optchain", { underlying: u }).then((resp) => {
        if (my !== reqSeq || !els || curU !== u) return;
        // setChain 自己会保留仍然存在的 curMonthKey; 这里只需保住滚动位置,
        // 否则每 6 秒表格重建一次会把用户拉回顶部
        const sc = els.body ? els.body.scrollTop : 0;
        const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
        setChain(resp, Math.round(t1 - t0));
        if (els.body) els.body.scrollTop = sc;
        setRefreshTag();
      }).catch(() => { /* 单次失败不打断, 下一轮再来 */ })
        .then(() => scheduleRefresh());
    }, REFRESH_MS);
  }
  function isHidden() {
    const w = document.getElementById("option-wrap");
    return w && w.classList.contains("hidden");
  }
  function setRefreshTag() {
    if (!els || !els.rtag) return;
    const d = new Date();
    els.rtag.textContent = refOn
      ? `自动刷新 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
      : "已暂停";
  }

  function selectUnderlying(u) {
    rememberU(u);
    if (!u || !els) return;
    curU = u;
    curMonthKey = null;
    chain = null;
    for (const d of els.ulist.querySelectorAll(".opt-u")) d.classList.toggle("on", d.dataset.u === u);
    renderOverview();
    showSkeleton();
    clearChart("加载中…");
    const my = ++reqSeq;
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    callRequest("optchain", { underlying: u }).then((resp) => {
      if (my !== reqSeq || !els) return;
      const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      setChain(resp, Math.round(t1 - t0));
      setRefreshTag();
      scheduleRefresh();
    }).catch((err) => {
      if (my !== reqSeq || !els) return;
      chain = null;
      renderOverview();
      showMessage("期权链加载失败 " + u, String((err && err.message) || err),
        () => selectUnderlying(u));
      clearChart("无数据");
    });
  }

  /* ======================= 期权链归一化 ======================= */

  function legOf(o) {
    if (!o || typeof o !== "object") return null;
    return {
      s: pickStr(o, ["s", "symbol", "code"]),
      last: pickNum(o, ["last", "last_price", "lp", "c"]),
      bid: pickNum(o, ["bid", "bid_price1", "b"]),
      ask: pickNum(o, ["ask", "ask_price1", "a"]),
      vol: pickNum(o, ["vol", "volume", "v"]),
      oi: pickNum(o, ["oi", "open_interest"]),
      settle: pickNum(o, ["settle", "settlement", "pre_settlement"]),
      iv: pickNum(o, ["iv", "impv", "sigma"]),
      delta: pickNum(o, ["delta"]),
      gamma: pickNum(o, ["gamma"]),
      vega: pickNum(o, ["vega"]),
      theta: pickNum(o, ["theta"]),
    };
  }

  function monthDays(m) {
    const v = pickNum(m, ["days", "dte", "rest_days", "expire_rest_days", "d"]);
    if (v !== null) return Math.round(v);
    const ts = pickNum(m, ["expire", "expire_datetime", "exp"]);
    if (ts !== null && ts > 0) {
      const sec = ts > 1e12 ? ts / 1000 : ts;   // 兼容毫秒
      return Math.max(0, Math.round((sec * 1000 - Date.now()) / 86400000));
    }
    return null;
  }

  function setChain(resp, ms) {
    const rawMonths = Array.isArray(resp.months) ? resp.months : [];
    const months = rawMonths.map((m) => {
      const rows = (Array.isArray(m.rows) ? m.rows : []).map((r) => ({
        k: num(r.k !== undefined ? r.k : r.strike),
        c: legOf(r.c), p: legOf(r.p),
      })).filter((r) => r.k !== null).sort((a, b) => a.k - b.k);
      const y = isNum(m.y) ? Number(m.y) : null;
      const mm = isNum(m.m) ? Number(m.m) : null;
      return {
        y, m: mm, rows,
        key: (y !== null ? y : "?") + "-" + (mm !== null ? pad2(mm) : "??"),
        label: (y !== null ? y : "?") + "-" + (mm !== null ? pad2(mm) : "??"),
        days: monthDays(m),
      };
    }).filter((m) => m.rows.length);

    /* IV 量纲自适应: 小数(0.23) 还是百分数(23.0) */
    let mx = 0;
    for (const m of months) for (const r of m.rows) {
      for (const leg of [r.c, r.p]) if (leg && isNum(leg.iv)) mx = Math.max(mx, Math.abs(leg.iv));
    }
    const ivMul = mx > 3 ? 1 : 100;

    /* 价格小数位: 取行权价 + 各腿价格里最大的小数位 */
    let kd = 0, pd = 0;
    for (const m of months) for (const r of m.rows) {
      kd = Math.max(kd, decOf(r.k));
      for (const leg of [r.c, r.p]) if (leg) {
        for (const f of ["last", "bid", "ask", "settle"]) if (isNum(leg[f]) && leg[f] !== 0) pd = Math.max(pd, decOf(leg[f]));
      }
    }

    const uq = resp.u || {};
    chain = {
      underlying: resp.underlying || curU,
      uq: {
        s: pickStr(uq, ["s", "symbol", "code"]) || (resp.underlying || curU || ""),
        n: pickStr(uq, ["n", "name", "instrument_name"]),
        last: pickNum(uq, ["last", "last_price", "lp", "c", "close"]),
        pre: pickNum(uq, ["pre", "pre_settlement", "pre_close", "pre_settle", "presettlement", "prev"]),
        vol: pickNum(uq, ["vol", "volume", "v"]),
        oi: pickNum(uq, ["oi", "open_interest"]),
      },
      months, ivMul, kDigits: Math.min(kd, 4), pDigits: Math.min(Math.max(pd, 1), 4),
      ms: ms,
    };
    if (!months.length) {
      renderOverview();
      showMessage("该标的没有返回期权链", curU);
      clearChart("无数据");
      return;
    }
    const want = months.find((m) => m.key === curMonthKey);
    curMonthKey = want ? want.key : months[0].key;
    renderOverview();
    renderTable();
    resizeCanvas();
    drawChart();
  }

  function curMonth() {
    if (!chain || !chain.months.length) return null;
    return chain.months.find((m) => m.key === curMonthKey) || chain.months[0];
  }

  /* ======================= 统计 ======================= */

  function stats(m) {
    const out = { atmK: null, atmIV: null, pcr: null, maxPain: null, callOI: 0, putOI: 0 };
    if (!m || !m.rows.length) return out;
    const S = chain && isNum(chain.uq.last) ? chain.uq.last : null;

    let co = 0, po = 0;
    for (const r of m.rows) {
      if (r.c && isNum(r.c.oi)) co += r.c.oi;
      if (r.p && isNum(r.p.oi)) po += r.p.oi;
    }
    out.callOI = co; out.putOI = po;
    out.pcr = co > 0 ? po / co : null;

    /* ATM: 离标的价最近的行权价; 没标的价则取中位 */
    let idx = -1;
    if (S !== null) {
      let best = Infinity;
      m.rows.forEach((r, i) => { const d = Math.abs(r.k - S); if (d < best) { best = d; idx = i; } });
    } else {
      idx = m.rows.length >> 1;
    }
    if (idx >= 0) {
      out.atmK = m.rows[idx].k;
      out.atmIdx = idx;
      /* ATM IV: 从 ATM 向外找最近的可用 IV, 取 call/put 均值 */
      for (let off = 0; off < Math.min(4, m.rows.length); off++) {
        const cand = [];
        for (const j of (off === 0 ? [idx] : [idx - off, idx + off])) {
          const r = m.rows[j];
          if (!r) continue;
          if (r.c && isNum(r.c.iv)) cand.push(r.c.iv);
          if (r.p && isNum(r.p.iv)) cand.push(r.p.iv);
        }
        if (cand.length) { out.atmIV = cand.reduce((a, b) => a + b, 0) / cand.length; break; }
      }
    }

    /* 最大痛点: 令所有期权总内在价值最小的行权价 */
    let bestPain = Infinity, bestK = null;
    for (const t of m.rows) {
      const K = t.k;
      let pain = 0;
      for (const r of m.rows) {
        if (r.c && isNum(r.c.oi) && K > r.k) pain += r.c.oi * (K - r.k);
        if (r.p && isNum(r.p.oi) && K < r.k) pain += r.p.oi * (r.k - K);
      }
      if (pain < bestPain) { bestPain = pain; bestK = K; }
    }
    if (co + po > 0) out.maxPain = bestK;
    return out;
  }

  /* ======================= 概览条 ======================= */

  function kv(label, value, cls) {
    const d = $c("div"); d.className = "opt-kv";
    const k = $c("div"); k.className = "opt-k"; k.textContent = label;
    const v = $c("div"); v.className = "opt-v" + (cls ? " " + cls : ""); v.textContent = value;
    d.append(k, v);
    return d;
  }

  function renderOverview() {
    if (!els) return;
    const ov = els.ov;
    ov.innerHTML = "";
    if (!chain) {
      const main = $c("div"); main.className = "opt-ov-main";
      const nm = $c("span"); nm.className = "opt-ov-name";
      nm.textContent = curU || "选择标的";
      const px = $c("span"); px.className = "opt-ov-px opt-flat"; px.textContent = DASH;
      main.append(nm, px);
      ov.appendChild(main);
      ov.appendChild(kv("到期月", DASH));
      ov.appendChild(kv("剩余天数", DASH));
      ov.appendChild(kv("ATM IV", DASH));
      ov.appendChild(kv("PCR(持仓)", DASH));
      ov.appendChild(kv("最大痛点", DASH));
      return;
    }
    const m = curMonth();
    const st = stats(m);
    const uq = chain.uq;
    const d = decOf(uq.last) >= 2 ? Math.max(2, decOf(uq.last)) : Math.max(chain.kDigits, decOf(uq.last));
    const chg = isNum(uq.last) && isNum(uq.pre) && uq.pre !== 0 ? uq.last - uq.pre : null;
    const pct = chg !== null ? (chg / uq.pre) * 100 : null;
    const cls = sgnCls(chg);

    const main = $c("div"); main.className = "opt-ov-main";
    const nm = $c("span"); nm.className = "opt-ov-name";
    nm.textContent = uq.n || chain.underlying;
    const cd = $c("span"); cd.className = "opt-ov-code"; cd.textContent = chain.underlying;
    const px = $c("span"); px.className = "opt-ov-px " + cls;
    px.textContent = isNum(uq.last) ? Number(uq.last).toFixed(d) : DASH;
    const ch = $c("span"); ch.className = "opt-ov-chg " + cls;
    ch.textContent = chg === null ? DASH
      : (chg > 0 ? "+" : "") + chg.toFixed(d) + "  " + (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
    main.append(nm, cd, px, ch);
    ov.appendChild(main);

    /* 到期月下拉 */
    const selWrap = $c("div"); selWrap.className = "opt-kv";
    const sk = $c("div"); sk.className = "opt-k"; sk.textContent = "到期月";
    const sel = $c("select"); sel.className = "opt-sel";
    for (const mm of chain.months) {
      const o = $c("option");
      o.value = mm.key;
      o.textContent = mm.label + (mm.days !== null ? "  (" + mm.days + "天)" : "");
      if (mm.key === curMonthKey) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      curMonthKey = sel.value;
      renderOverview();
      renderTable();
      drawChart();
    });
    selWrap.append(sk, sel);
    ov.appendChild(selWrap);

    ov.appendChild(kv("剩余天数", m && m.days !== null ? m.days + " 天" : DASH));
    ov.appendChild(kv("ATM IV", st.atmIV !== null ? (st.atmIV * chain.ivMul).toFixed(2) + "%" : DASH));
    ov.appendChild(kv("ATM 行权价", st.atmK !== null ? fmtStrike(st.atmK, chain.kDigits) : DASH));
    ov.appendChild(kv("PCR(持仓)", st.pcr !== null ? st.pcr.toFixed(3) : DASH,
      st.pcr === null ? "" : (st.pcr > 1 ? "opt-down" : "opt-up")));
    ov.appendChild(kv("最大痛点", st.maxPain !== null ? fmtStrike(st.maxPain, chain.kDigits) : DASH));
    ov.appendChild(kv("CALL/PUT 持仓",
      (st.callOI ? fmtVol(st.callOI) : DASH) + " / " + (st.putOI ? fmtVol(st.putOI) : DASH), "small"));
    ov.appendChild(kv("行权价档数", m ? String(m.rows.length) : DASH, "small"));
  }

  /* ======================= T 型表 ======================= */

  function showSkeleton() {
    if (!els) return;
    const b = els.body;
    b.innerHTML = "";
    const w = $c("div"); w.className = "opt-skel";
    const h = $c("div"); h.className = "opt-skel-bar opt-skel-head";
    w.appendChild(h);
    for (let i = 0; i < 16; i++) {
      const r = $c("div");
      r.className = "opt-skel-bar";
      r.style.opacity = String(Math.max(0.25, 1 - i * 0.045));
      w.appendChild(r);
    }
    const tip = $c("div"); tip.className = "opt-skel-tip";
    tip.textContent = "正在拉取期权链 " + (curU || "") + " …";
    w.appendChild(tip);
    b.appendChild(w);
  }

  function showMessage(title, sub, retry) {
    if (!els) return;
    const b = els.body;
    b.innerHTML = "";
    const d = $c("div"); d.className = "opt-msg";
    const t = $c("b"); t.textContent = title;
    d.appendChild(t);
    if (sub) { const s = $c("div"); s.textContent = sub; d.appendChild(s); }
    if (typeof retry === "function") {
      const btn = $c("button"); btn.className = "opt-retry"; btn.textContent = "重试";
      btn.addEventListener("click", retry);
      d.appendChild(btn);
    }
    b.appendChild(d);
  }

  function mkTh(text, cls, attrs) {
    const th = $c("th");
    th.className = cls || "";
    th.textContent = text;
    if (attrs) for (const k in attrs) th.setAttribute(k, attrs[k]);
    return th;
  }

  function renderTable() {
    if (!els) return;
    const m = curMonth();
    if (!chain || !m) { showMessage("无数据", null); return; }
    const st = stats(m);
    const S = isNum(chain.uq.last) ? chain.uq.last : null;
    const kd = chain.kDigits, pd = chain.pDigits, mul = chain.ivMul;

    let maxOI = 0;
    for (const r of m.rows) {
      if (r.c && isNum(r.c.oi)) maxOI = Math.max(maxOI, r.c.oi);
      if (r.p && isNum(r.p.oi)) maxOI = Math.max(maxOI, r.p.oi);
    }

    const table = $c("table"); table.className = "opt-table";
    const cg = $c("colgroup");
    for (let i = 0; i < 15; i++) {
      const col = $c("col");
      col.style.width = (i === 7 ? "7.8" : "6.6") + "%";
      cg.appendChild(col);
    }
    table.appendChild(cg);

    const thead = $c("thead");
    const h1 = $c("tr"); h1.className = "opt-h1";
    h1.appendChild(mkTh("看涨 CALL", "opt-hc", { colspan: "7" }));
    h1.appendChild(mkTh("行权价", "opt-hk", { rowspan: "2" }));
    h1.appendChild(mkTh("看跌 PUT", "opt-hp", { colspan: "7" }));
    const h2 = $c("tr"); h2.className = "opt-h2";
    for (const c of CALL_COLS) h2.appendChild(mkTh(c.label, "opt-tc"));
    for (const c of PUT_COLS) h2.appendChild(mkTh(c.label, "opt-tp"));
    thead.append(h1, h2);
    table.appendChild(thead);

    const tbody = $c("tbody");
    for (let i = 0; i < m.rows.length; i++) {
      const r = m.rows[i];
      const tr = $c("tr");
      tr.className = "opt-row" + (st.atmIdx === i ? " opt-atm" : "");
      if (r.c && r.c.s) tr.dataset.cs = r.c.s;
      if (r.p && r.p.s) tr.dataset.ps = r.p.s;

      const cItm = S !== null && r.k < S;    // CALL 实值
      const pItm = S !== null && r.k > S;    // PUT 实值

      for (const col of CALL_COLS) {
        tr.appendChild(cell(r.c, col.k, "c", cItm, pd, kd, mul, maxOI));
      }

      const tk = $c("td");
      tk.className = "opt-kcell";
      tk.textContent = fmtStrike(r.k, kd);
      if (st.atmIdx === i) {
        const tag = $c("span"); tag.className = "opt-atm-tag"; tag.textContent = "ATM";
        tk.appendChild(tag);
      } else if (st.maxPain !== null && r.k === st.maxPain) {
        const tag = $c("span"); tag.className = "opt-mp-tag"; tag.textContent = "MP";
        tk.appendChild(tag);
      }
      tr.appendChild(tk);

      for (const col of PUT_COLS) {
        tr.appendChild(cell(r.p, col.k, "p", pItm, pd, kd, mul, maxOI));
      }
      tbody.appendChild(tr);
    }
    tbody.addEventListener("click", onRowClick);
    table.appendChild(tbody);

    els.body.innerHTML = "";
    els.body.appendChild(table);
  }

  function cell(leg, key, side, itm, pd, kd, mul, maxOI) {
    const td = $c("td");
    const sideCls = side === "c" ? "opt-c-side opt-tc" : "opt-p-side opt-tp";
    let cls = sideCls + (itm ? " opt-itm" : "");
    let text = DASH;
    const v = leg ? leg[key] : null;

    switch (key) {
      case "delta":
        text = fmtDelta(v); cls += " opt-dim"; break;
      // 引擎已把量纲转成可读值: theta 是每日、vega 是每 1 个波动率点
      case "gamma":
        text = isNum(v) ? (Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(4)) : DASH;
        cls += " opt-dim"; break;
      case "vega":
        text = isNum(v) ? v.toFixed(2) : DASH;
        cls += " opt-dim"; break;
      case "theta":
        text = isNum(v) ? v.toFixed(2) : DASH;
        cls += " opt-dim " + (isNum(v) ? sgnCls(v) : ""); break;
      case "iv":
        text = fmtIV(v, mul); cls += " opt-iv"; break;
      case "oi":
        text = fmtVol(v); cls += " opt-dim";
        if (isNum(v) && maxOI > 0) {
          const p = Math.max(0, Math.min(100, (v / maxOI) * 100));
          const col = side === "c" ? rgba(colors().up, .26) : rgba(colors().down, .26);
          td.style.backgroundImage = "linear-gradient(to " + (side === "c" ? "left" : "right") +
            "," + col + " " + p.toFixed(1) + "%, transparent " + p.toFixed(1) + "%)";
        }
        break;
      case "vol":
        text = fmtVol(v); cls += " opt-dim"; break;
      case "bid":
      case "ask":
        text = fmtPx(v, pd);
        cls += " " + (leg && isNum(v) && isNum(leg.settle) ? sgnCls(v - leg.settle) : "opt-flat");
        break;
      case "last":
        text = fmtPx(v, pd);
        cls += " opt-last " + (leg && isNum(v) && isNum(leg.settle) ? sgnCls(v - leg.settle) : "opt-flat");
        break;
      default:
        text = DASH;
    }
    td.className = cls;
    td.textContent = text;
    td.dataset.side = side;
    return td;
  }

  function onRowClick(e) {
    const td = e.target.closest ? e.target.closest("td") : null;
    if (!td) return;
    const tr = td.parentNode;
    if (!tr || !tr.dataset) return;
    const side = td.dataset.side;
    if (!side) return;                       // 行权价列不触发
    const sym = side === "c" ? tr.dataset.cs : tr.dataset.ps;
    if (sym && typeof opts.onPickSymbol === "function") {
      try { opts.onPickSymbol(sym); } catch (err) { console.error("[OptionView] onPickSymbol", err); }
    }
  }

  /* ======================= 图表 ======================= */

  function resizeCanvas() {
    if (!els) return false;
    const w = els.cwrap.clientWidth, h = els.cwrap.clientHeight;
    const d = window.devicePixelRatio || 1;
    if (w === cvW && h === cvH && d === cvDpr) return false;
    cvW = w; cvH = h; cvDpr = d;
    els.cv.width = Math.max(1, Math.round(w * d));
    els.cv.height = Math.max(1, Math.round(h * d));
    return true;
  }

  function ctx2d() {
    if (!els) return null;
    const c = els.cv.getContext("2d");
    if (!c) return null;
    c.setTransform(cvDpr || 1, 0, 0, cvDpr || 1, 0, 0);
    c.clearRect(0, 0, cvW, cvH);
    return c;
  }

  function clearChart(note) {
    if (!els) return;
    resizeCanvas();
    const c = ctx2d();
    if (!c) return;
    els.cnote.textContent = "";
    const col = colors();
    c.fillStyle = col.muted;
    c.font = FONT;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(note || "无数据", cvW / 2, cvH / 2);
  }

  function drawChart() {
    if (!els) return;
    resizeCanvas();
    if (!chain || !curMonth()) { clearChart("无数据"); return; }
    try {
      if (chartTab === "smile") drawSmile();
      else if (chartTab === "oi") drawOI();
      else drawSurface();
    } catch (err) {
      console.error("[OptionView] chart failed", err);
      clearChart("绘制失败");
    }
  }

  /* --- 通用坐标轴 --- */
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) return [lo];
    const raw = (hi - lo) / Math.max(1, n);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
    return out.length ? out : [lo, hi];
  }

  /* x 轴刻度文字: 贴边时改成靠边对齐, 避免被画布裁掉 */
  function xTickLabel(c, text, x, y, L, W) {
    const w = c.measureText(text).width;
    if (x - w / 2 < L - 8) { c.textAlign = "left"; c.fillText(text, Math.max(1, L - 8), y); }
    else if (x + w / 2 > L + W + 8) { c.textAlign = "right"; c.fillText(text, L + W + 8, y); }
    else { c.textAlign = "center"; c.fillText(text, x, y); }
    c.textAlign = "center";
  }

  function drawLegend(c, items, x, y) {
    c.font = FONT;
    c.textAlign = "left";
    c.textBaseline = "middle";
    let cx = x;
    for (const it of items) {
      c.strokeStyle = it.color;
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(cx, y); c.lineTo(cx + 14, y); c.stroke();
      c.fillStyle = colors().ink2;
      c.fillText(it.label, cx + 19, y + .5);
      cx += 19 + c.measureText(it.label).width + 16;
    }
  }

  /* --- 波动率微笑 --- */
  function drawSmile() {
    const m = curMonth();
    const col = colors();
    const c = ctx2d();
    if (!c) return;
    const mul = chain.ivMul;
    const pts = { c: [], p: [] };
    for (const r of m.rows) {
      if (r.c && isNum(r.c.iv)) pts.c.push([r.k, r.c.iv * mul]);
      if (r.p && isNum(r.p.iv)) pts.p.push([r.k, r.p.iv * mul]);
    }
    const all = pts.c.concat(pts.p);
    if (all.length < 2) { clearChart("该月份没有足够的 IV 数据"); return; }

    const L = 46, R = 14, T = 26, B = 24;
    const W = cvW - L - R, H = cvH - T - B;
    let kmin = Infinity, kmax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const [k, v] of all) {
      kmin = Math.min(kmin, k); kmax = Math.max(kmax, k);
      vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
    }
    if (kmax === kmin) { kmax = kmin + 1; }
    const padv = Math.max((vmax - vmin) * 0.18, 0.4);
    vmin = Math.max(0, vmin - padv); vmax = vmax + padv;
    const X = (k) => L + ((k - kmin) / (kmax - kmin)) * W;
    const Y = (v) => T + H - ((v - vmin) / (vmax - vmin)) * H;

    /* 网格 + y 轴 */
    c.font = FONT;
    c.textBaseline = "middle";
    for (const v of niceTicks(vmin, vmax, 4)) {
      const y = Math.round(Y(v)) + .5;
      c.strokeStyle = col.grid; c.lineWidth = 1;
      c.beginPath(); c.moveTo(L, y); c.lineTo(L + W, y); c.stroke();
      c.fillStyle = col.muted; c.textAlign = "right";
      c.fillText(v.toFixed(1) + "%", L - 6, y);
    }
    /* x 轴 */
    c.textBaseline = "top";
    c.textAlign = "center";
    for (const k of niceTicks(kmin, kmax, 6)) {
      const x = Math.round(X(k)) + .5;
      if (x < L - 1 || x > L + W + 1) continue;
      c.strokeStyle = rgba(col.grid, .7);
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + H); c.stroke();
      c.fillStyle = col.muted;
      xTickLabel(c, fmtStrike(k, chain.kDigits), x, T + H + 5, L, W);
    }

    /* 标的价 / ATM 竖线 */
    const st = stats(m);
    const S = isNum(chain.uq.last) ? chain.uq.last : null;
    if (S !== null && S >= kmin && S <= kmax) {
      const x = Math.round(X(S)) + .5;
      c.save();
      c.setLineDash([4, 3]);
      c.strokeStyle = rgba(col.ink, .5); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + H); c.stroke();
      c.restore();
      c.fillStyle = col.ink2; c.font = FONT_B;
      c.textAlign = x > L + W - 60 ? "right" : "left";
      c.textBaseline = "top";
      c.fillText("S=" + fmtStrike(S, sDigits()), x + (x > L + W - 60 ? -4 : 4), T + 2);
    }
    if (st.atmK !== null && st.atmK >= kmin && st.atmK <= kmax) {
      const x = X(st.atmK);
      c.fillStyle = rgba(col.ma5, .95);
      c.beginPath(); c.moveTo(x, T + H); c.lineTo(x - 5, T + H + 7); c.lineTo(x + 5, T + H + 7); c.fill();
    }

    /* 曲线 */
    const draw = (arr, color) => {
      if (arr.length < 1) return;
      c.strokeStyle = color; c.lineWidth = 1.6;
      c.beginPath();
      arr.forEach(([k, v], i) => { const x = X(k), y = Y(v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
      c.fillStyle = color;
      for (const [k, v] of arr) {
        c.beginPath(); c.arc(X(k), Y(v), 2.2, 0, Math.PI * 2); c.fill();
      }
    };
    draw(pts.c, col.up);
    draw(pts.p, col.down);

    drawLegend(c, [
      { label: "CALL IV", color: col.up },
      { label: "PUT IV", color: col.down },
    ], L + 2, T - 12);

    els.cnote.textContent = m.label + " · ATM IV " +
      (st.atmIV !== null ? (st.atmIV * mul).toFixed(2) + "%" : DASH) +
      " · 有效点 " + all.length + "/" + (m.rows.length * 2);
  }

  /* --- 持仓量分布 --- */
  function drawOI() {
    const m = curMonth();
    const col = colors();
    const c = ctx2d();
    if (!c) return;
    const rows = m.rows;
    let mx = 0;
    for (const r of rows) {
      if (r.c && isNum(r.c.oi)) mx = Math.max(mx, r.c.oi);
      if (r.p && isNum(r.p.oi)) mx = Math.max(mx, r.p.oi);
    }
    if (!(mx > 0)) { clearChart("该月份没有持仓量数据"); return; }

    const KW = 66;                      // 中间行权价列宽
    const T = 22, B = 21, PAD = 10;
    const H = cvH - T - B;
    const cxm = cvW / 2;
    const half = cxm - KW / 2 - PAD;
    const n = rows.length;
    const rowH = H / n;
    const barH = Math.max(2, Math.min(13, rowH - 1.6));

    const st = stats(m);
    c.font = FONT;
    c.textBaseline = "middle";

    /* 表头 */
    c.fillStyle = col.up; c.textAlign = "right";
    c.font = FONT_B;
    c.fillText("CALL 持仓", cxm - KW / 2 - 4, T - 11);
    c.fillStyle = col.down; c.textAlign = "left";
    c.fillText("PUT 持仓", cxm + KW / 2 + 4, T - 11);
    c.fillStyle = col.muted; c.textAlign = "center"; c.font = FONT;
    c.fillText("行权价", cxm, T - 11);

    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const y = T + rowH * (i + .5);
      const isAtm = st.atmIdx === i;
      const isMp = st.maxPain !== null && r.k === st.maxPain;

      if (isAtm) {
        c.fillStyle = rgba(col.ma5, .16);
        c.fillRect(0, y - rowH / 2, cvW, rowH);
      }
      /* CALL 向左 */
      if (r.c && isNum(r.c.oi) && r.c.oi > 0) {
        const w = (r.c.oi / mx) * half;
        c.fillStyle = rgba(col.up, isAtm ? .95 : .78);
        c.fillRect(cxm - KW / 2 - w, y - barH / 2, w, barH);
      }
      /* PUT 向右 */
      if (r.p && isNum(r.p.oi) && r.p.oi > 0) {
        const w = (r.p.oi / mx) * half;
        c.fillStyle = rgba(col.down, isAtm ? .95 : .78);
        c.fillRect(cxm + KW / 2, y - barH / 2, w, barH);
      }
      /* 行权价标签 (行距太密时隔行显示) */
      const showLabel = rowH >= 9 || i % 2 === 0;
      if (showLabel) {
        c.textAlign = "center";
        c.font = isAtm || isMp ? FONT_B : FONT_SM;
        c.fillStyle = isAtm ? col.ink : isMp ? col.ma10 : col.ink2;
        c.fillText(fmtStrike(r.k, chain.kDigits), cxm, y);
      }
    }

    /* 中轴 */
    c.strokeStyle = rgba(col.ink, .12); c.lineWidth = 1;
    c.beginPath();
    c.moveTo(Math.round(cxm - KW / 2) + .5, T); c.lineTo(Math.round(cxm - KW / 2) + .5, T + H);
    c.moveTo(Math.round(cxm + KW / 2) + .5, T); c.lineTo(Math.round(cxm + KW / 2) + .5, T + H);
    c.stroke();

    /* 底部刻度 */
    c.font = FONT; c.textBaseline = "top"; c.fillStyle = col.muted;
    c.textAlign = "left"; c.fillText("最大 " + fmtVol(mx), 4, T + H + 3);
    c.textAlign = "right";
    c.fillText("CALL " + fmtVol(st.callOI) + " · PUT " + fmtVol(st.putOI) +
      " · PCR " + (st.pcr !== null ? st.pcr.toFixed(3) : DASH), cvW - 4, T + H + 3);

    els.cnote.textContent = m.label + " · 最大痛点 " +
      (st.maxPain !== null ? fmtStrike(st.maxPain, chain.kDigits) : DASH) +
      " · ATM " + (st.atmK !== null ? fmtStrike(st.atmK, chain.kDigits) : DASH);
  }

  /* --- 波动率曲面(多到期月 IV 曲线) --- */
  function drawSurface() {
    const col = colors();
    const c = ctx2d();
    if (!c) return;
    const mul = chain.ivMul;
    const series = [];
    chain.months.forEach((m, i) => {
      const arr = [];
      for (const r of m.rows) {
        const vs = [];
        if (r.c && isNum(r.c.iv)) vs.push(r.c.iv);
        if (r.p && isNum(r.p.iv)) vs.push(r.p.iv);
        if (vs.length) arr.push([r.k, (vs.reduce((a, b) => a + b, 0) / vs.length) * mul]);
      }
      if (arr.length) series.push({ label: m.label + (m.days !== null ? "(" + m.days + "d)" : ""), pts: arr, color: monthPalette(i), key: m.key });
    });
    if (!series.length) { clearChart("没有可用 IV 数据"); return; }

    const L = 46, R = 14, T = 30, B = 24;
    const W = cvW - L - R, H = cvH - T - B;
    let kmin = Infinity, kmax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const s of series) for (const [k, v] of s.pts) {
      kmin = Math.min(kmin, k); kmax = Math.max(kmax, k);
      vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
    }
    if (kmax === kmin) kmax = kmin + 1;
    const padv = Math.max((vmax - vmin) * 0.18, 0.4);
    vmin = Math.max(0, vmin - padv); vmax = vmax + padv;
    const X = (k) => L + ((k - kmin) / (kmax - kmin)) * W;
    const Y = (v) => T + H - ((v - vmin) / (vmax - vmin)) * H;

    c.font = FONT; c.textBaseline = "middle";
    for (const v of niceTicks(vmin, vmax, 4)) {
      const y = Math.round(Y(v)) + .5;
      c.strokeStyle = col.grid; c.lineWidth = 1;
      c.beginPath(); c.moveTo(L, y); c.lineTo(L + W, y); c.stroke();
      c.fillStyle = col.muted; c.textAlign = "right";
      c.fillText(v.toFixed(1) + "%", L - 6, y);
    }
    c.textBaseline = "top"; c.textAlign = "center";
    for (const k of niceTicks(kmin, kmax, 6)) {
      const x = Math.round(X(k)) + .5;
      if (x < L - 1 || x > L + W + 1) continue;
      c.strokeStyle = rgba(col.grid, .7);
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + H); c.stroke();
      c.fillStyle = col.muted;
      xTickLabel(c, fmtStrike(k, chain.kDigits), x, T + H + 5, L, W);
    }

    const S = isNum(chain.uq.last) ? chain.uq.last : null;
    if (S !== null && S >= kmin && S <= kmax) {
      const x = Math.round(X(S)) + .5;
      c.save(); c.setLineDash([4, 3]);
      c.strokeStyle = rgba(col.ink, .45); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + H); c.stroke();
      c.restore();
    }

    for (const s of series) {
      const cur = s.key === curMonthKey;
      c.strokeStyle = s.color; c.lineWidth = cur ? 2.2 : 1.3;
      c.globalAlpha = cur ? 1 : .8;
      c.beginPath();
      s.pts.forEach(([k, v], i) => { const x = X(k), y = Y(v); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
      c.fillStyle = s.color;
      for (const [k, v] of s.pts) { c.beginPath(); c.arc(X(k), Y(v), cur ? 2.2 : 1.6, 0, Math.PI * 2); c.fill(); }
      c.globalAlpha = 1;
    }

    drawLegend(c, series.map((s) => ({ label: s.label, color: s.color })), L + 2, T - 15);
    els.cnote.textContent = series.length + " 个到期月 · 每档取 CALL/PUT 中值 IV";
  }

  /* ======================= 对外 API ======================= */

  function mount(rootEl, options) {
    if (!rootEl) return false;
    destroy();
    opts = options || {};
    C = null;
    injectCss();
    root = rootEl;
    build();
    resizeCanvas();
    renderOverview();
    clearChart("选择标的后显示");
    loadUnderlyings();
    return true;
  }

  function isMounted() { return !!els; }

  function destroy() {
    reqSeq++;                       // 让在途响应失效
    if (ro) { try { ro.disconnect(); } catch (e) { } ro = null; }
    window.removeEventListener("resize", onWinResize);
    if (root) {
      root.innerHTML = "";
      root.removeAttribute("id");
    }
    root = null; els = null; chain = null; curMonthKey = null;
    unders = []; curU = null; opts = {};
    cvW = cvH = cvDpr = 0;
  }

  return { mount, destroy, isMounted };
})();
