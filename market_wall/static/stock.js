/* 个股研究面板 — 独立自包含模块, 只暴露 window.StockView
   数据: opts.request("fund", {kind, args:{ts_code, ...}}) -> {cols:[...], rows:[[...]]}
   纯原生 JS, 样式动态注入(#stk-style), 类名 stk- 前缀, 不依赖 app.js / style.css
   面板懒加载(IntersectionObserver) + 每面板独立错误态 + 按标的缓存 */
"use strict";

window.StockView = (function () {

  /* ============================================================
     0. 常量 / 工具
     ============================================================ */

  const DASH = "—";
  const F = 'system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif';

  /* 运行时读取 CSS 变量, 取不到用规范里的默认值 */
  const CDEF = {
    page: "#0d0d0d", surface: "#1a1a19", "surface-2": "#222221",
    ink: "#ffffff", "ink-2": "#c3c2b7", muted: "#898781", grid: "#2c2c2a",
    up: "#e66767", down: "#199e70",
    ma5: "#3987e5", ma10: "#d95926", ma20: "#9085e9", ma60: "#d55181",
  };
  let C = Object.assign({}, CDEF);
  function readVars() {
    try {
      const cs = getComputedStyle(document.documentElement);
      for (const k in CDEF) {
        const v = (cs.getPropertyValue("--" + k) || "").trim();
        C[k] = v || CDEF[k];
      }
    } catch (e) { C = Object.assign({}, CDEF); }
  }

  const isNum = (v) => v !== null && v !== undefined && v !== "" && isFinite(v);
  function nz(v) { const f = parseFloat(v); return isFinite(f) ? f : null; }

  /* 金额: 输入单位=元 */
  function fmtYuan(v, dg) {
    if (!isNum(v)) return DASH;
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e12) return s + (a / 1e12).toFixed(dg === undefined ? 2 : dg) + "万亿";
    if (a >= 1e8) return s + (a / 1e8).toFixed(dg === undefined ? 2 : dg) + "亿";
    if (a >= 1e4) return s + (a / 1e4).toFixed(dg === undefined ? 2 : dg) + "万";
    return s + a.toFixed(0);
  }
  /* 带符号的金额(资金流用) */
  function fmtYuanSign(v, dg) {
    if (!isNum(v)) return DASH;
    return (v > 0 ? "+" : "") + fmtYuan(v, dg);
  }
  /* 股数 */
  function fmtShares(v) {
    if (!isNum(v)) return DASH;
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e8) return s + (a / 1e8).toFixed(2) + "亿股";
    if (a >= 1e4) return s + (a / 1e4).toFixed(2) + "万股";
    return s + a.toFixed(0) + "股";
  }
  function fmtCount(v) {
    if (!isNum(v)) return DASH;
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e8) return s + (a / 1e8).toFixed(2) + "亿";
    if (a >= 1e4) return s + (a / 1e4).toFixed(2) + "万";
    return s + (Math.round(a) === a ? a.toFixed(0) : a.toFixed(2));
  }
  function fmtPct(v, dg) { return isNum(v) ? v.toFixed(dg === undefined ? 2 : dg) + "%" : DASH; }
  function fmtPctSign(v, dg) { return isNum(v) ? (v > 0 ? "+" : "") + v.toFixed(dg === undefined ? 2 : dg) + "%" : DASH; }
  function fmtNum(v, dg) { return isNum(v) ? v.toFixed(dg === undefined ? 2 : dg) : DASH; }

  /* 按 unit 统一格式化。unit: yuan/wan(万元)/baiwan(百万元)/yi(亿元)/pct/ratio/
     shares/wanshares/hand/price/count/date/text */
  function fmtBy(v, unit) {
    if (unit === "text" || unit === "date") return v === null || v === undefined || v === "" ? DASH : String(v);
    const n = nz(v);
    if (n === null) return DASH;
    switch (unit) {
      case "yuan": return fmtYuan(n);
      case "wan": return fmtYuan(n * 1e4);
      case "baiwan": return fmtYuan(n * 1e6);
      case "yi": return fmtYuan(n * 1e8);
      case "pct": return fmtPct(n);
      case "ratio": return fmtNum(n, 2);
      case "price": return fmtNum(n, 2);
      case "shares": return fmtShares(n);
      case "wanshares": return fmtShares(n * 1e4);
      case "hand": return fmtCount(n) + "手";
      case "count": return fmtCount(n);
      default: return fmtNum(n, 2);
    }
  }

  /* 日期 20250630 / 2025-06-30 / 2025-06-30 00:00:00 -> 各种展示 */
  function dstr(v) {
    if (v === null || v === undefined) return "";
    let s = String(v).trim();
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }
  function dnum(v) {                                  // 排序键
    const s = String(v === null || v === undefined ? "" : v).replace(/[^0-9]/g, "");
    return s ? parseInt(s.slice(0, 8), 10) : 0;
  }
  function mdShort(v) { const s = dstr(v); return s.length >= 10 ? s.slice(5) : s; }
  /* 报告期 -> 25Q2 */
  function qLabel(v) {
    const s = dstr(v);
    if (s.length < 10) return s;
    const y = s.slice(2, 4), m = parseInt(s.slice(5, 7), 10);
    const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
    return y + "Q" + q;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function sgn(v) { return !isNum(v) || v === 0 ? "stk-flat" : v > 0 ? "stk-up" : "stk-down"; }
  function arrow(v) { return !isNum(v) || v === 0 ? "" : v > 0 ? "▲" : "▼"; }

  /* ============================================================
     1. 列式数据集包装 (对列名做别名容错)
     ============================================================ */

  function ds(resp) {
    let cols = [], rows = [];
    if (resp && Array.isArray(resp.cols)) { cols = resp.cols; rows = Array.isArray(resp.rows) ? resp.rows : []; }
    else if (Array.isArray(resp)) { rows = resp; }
    const map = {};
    cols.forEach((c, i) => { map[String(c).toLowerCase()] = i; });
    const o = {
      cols, rows, n: rows.length,
      idx(names) {
        const list = Array.isArray(names) ? names : [names];
        for (const k of list) { const i = map[String(k).toLowerCase()]; if (i !== undefined) return i; }
        return -1;
      },
      has(names) { return o.idx(names) >= 0; },
      raw(r, names) { const i = o.idx(names); return i < 0 || !r ? null : (r[i] === undefined ? null : r[i]); },
      num(r, names) { return nz(o.raw(r, names)); },
      str(r, names) { const v = o.raw(r, names); return v === null || v === undefined ? "" : String(v); },
      numsOf(list, names) { const i = o.idx(names); return i < 0 ? null : list.map((r) => nz(r[i])); },
      strsOf(list, names) { const i = o.idx(names); return i < 0 ? null : list.map((r) => (r[i] === null || r[i] === undefined ? "" : String(r[i]))); },
      /* 按日期列升序返回行数组 */
      byDate(names, asc) {
        const i = o.idx(names || DATE_KEYS);
        const list = rows.slice();
        if (i >= 0) list.sort((a, b) => dnum(a[i]) - dnum(b[i]));
        else if (asc === false) list.reverse();
        if (asc === false) list.reverse();
        return list;
      },
    };
    return o;
  }
  const DATE_KEYS = ["trade_date", "end_date", "ann_date", "date", "t"];

  /* ============================================================
     2. 字段字典 (三大报表 / 财务指标)
     [中文名, 单位, 分组]
     ============================================================ */
  const G_INC = "利润表", G_BAL = "资产负债表", G_CF = "现金流量表", G_IND = "财务指标";
  const FIELD = {
    /* 利润表 */
    total_revenue: ["营业总收入", "yuan", G_INC],
    revenue: ["营业收入", "yuan", G_INC],
    oper_cost: ["营业成本", "yuan", G_INC],
    sell_exp: ["销售费用", "yuan", G_INC],
    admin_exp: ["管理费用", "yuan", G_INC],
    rd_exp: ["研发费用", "yuan", G_INC],
    fin_exp: ["财务费用", "yuan", G_INC],
    operate_profit: ["营业利润", "yuan", G_INC],
    total_profit: ["利润总额", "yuan", G_INC],
    income_tax: ["所得税", "yuan", G_INC],
    n_income: ["净利润", "yuan", G_INC],
    n_income_attr_p: ["归母净利润", "yuan", G_INC],
    ebit: ["EBIT", "yuan", G_INC],
    ebitda: ["EBITDA", "yuan", G_INC],
    basic_eps: ["基本每股收益", "price", G_INC],
    diluted_eps: ["稀释每股收益", "price", G_INC],
    /* 资产负债表 */
    total_assets: ["资产总计", "yuan", G_BAL],
    total_cur_assets: ["流动资产合计", "yuan", G_BAL],
    money_cap: ["货币资金", "yuan", G_BAL],
    accounts_receiv: ["应收账款", "yuan", G_BAL],
    inventories: ["存货", "yuan", G_BAL],
    fix_assets: ["固定资产", "yuan", G_BAL],
    total_liab: ["负债合计", "yuan", G_BAL],
    total_cur_liab: ["流动负债合计", "yuan", G_BAL],
    total_ncl: ["非流动负债合计", "yuan", G_BAL],
    st_borr: ["短期借款", "yuan", G_BAL],
    lt_borr: ["长期借款", "yuan", G_BAL],
    total_hldr_eqy_exc_min_int: ["归母股东权益", "yuan", G_BAL],
    total_hldr_eqy_inc_min_int: ["股东权益合计", "yuan", G_BAL],
    cap_rese: ["资本公积", "yuan", G_BAL],
    undistr_porfit: ["未分配利润", "yuan", G_BAL],
    total_share: ["总股本", "shares", G_BAL],
    /* 现金流量表 */
    n_cashflow_act: ["经营现金流净额", "yuan", G_CF],
    n_cashflow_inv_act: ["投资现金流净额", "yuan", G_CF],
    n_cash_flows_fnc_act: ["筹资现金流净额", "yuan", G_CF],
    c_fr_sale_sg: ["销售商品收现", "yuan", G_CF],
    c_paid_goods_s: ["购买商品付现", "yuan", G_CF],
    free_cashflow: ["自由现金流", "yuan", G_CF],
    n_incr_cash_cash_equ: ["现金净增加额", "yuan", G_CF],
    im_net_cashflow_oper_act: ["经营现金流(间接法)", "yuan", G_CF],
    /* 财务指标 */
    roe: ["ROE", "pct", G_IND],
    roe_dt: ["ROE(扣非)", "pct", G_IND],
    roe_waa: ["ROE(加权)", "pct", G_IND],
    roa: ["ROA", "pct", G_IND],
    grossprofit_margin: ["毛利率", "pct", G_IND],
    netprofit_margin: ["净利率", "pct", G_IND],
    debt_to_assets: ["资产负债率", "pct", G_IND],
    current_ratio: ["流动比率", "ratio", G_IND],
    quick_ratio: ["速动比率", "ratio", G_IND],
    assets_turn: ["总资产周转率", "ratio", G_IND],
    inv_turn: ["存货周转率", "ratio", G_IND],
    ar_turn: ["应收账款周转率", "ratio", G_IND],
    eps: ["每股收益", "price", G_IND],
    bps: ["每股净资产", "price", G_IND],
    ocfps: ["每股经营现金流", "price", G_IND],
    or_yoy: ["营收同比", "pct", G_IND],
    op_yoy: ["营业利润同比", "pct", G_IND],
    netprofit_yoy: ["净利同比", "pct", G_IND],
    dt_netprofit_yoy: ["扣非净利同比", "pct", G_IND],
    q_sales_yoy: ["单季营收同比", "pct", G_IND],
    q_profit_yoy: ["单季净利同比", "pct", G_IND],
  };
  const GROUP_ORDER = [G_INC, G_BAL, G_CF, G_IND, "其他"];
  const SKIP_FIELDS = new Set(["ts_code", "ann_date", "f_ann_date", "end_date", "report_type",
    "comp_type", "end_type", "update_flag", "trade_date"]);

  /* ============================================================
     3. 样式
     ============================================================ */
  const CSS = `
#stk-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:12.5px/1.5 ${F};font-variant-numeric:tabular-nums;}
#stk-root *{box-sizing:border-box;}

/* ---------- 头部 ---------- */
.stk-hd{flex:0 0 auto;display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:10px 14px 9px;background:var(--surface,#1a1a19);
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.stk-hd-id{min-width:0;display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;}
.stk-name{font-size:19px;font-weight:700;color:var(--ink,#fff);letter-spacing:.5px;}
.stk-code{font-size:12px;color:var(--muted,#898781);letter-spacing:.05em;}
.stk-tags{font-size:11.5px;color:var(--muted,#898781);}
.stk-tag{display:inline-block;padding:1px 6px;margin-right:4px;border-radius:2px;
  border:1px solid var(--grid,#2c2c2a);color:var(--ink-2,#c3c2b7);font-size:10.5px;}
.stk-hd-px{margin-left:auto;display:flex;align-items:baseline;gap:10px;white-space:nowrap;}
.stk-last{font-size:26px;font-weight:700;line-height:1;}
.stk-chg,.stk-pct{font-size:14px;font-weight:600;}
.stk-hd-note{font-size:10.5px;color:var(--muted,#898781);align-self:flex-end;padding-bottom:2px;}

/* ---------- 估值条 ---------- */
.stk-val{flex:0 0 auto;display:grid;gap:1px;background:var(--border,rgba(255,255,255,.10));
  grid-template-columns:repeat(8,minmax(0,1fr));
  border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.stk-root.stk-narrow .stk-val{grid-template-columns:repeat(4,minmax(0,1fr));}
.stk-vc{background:var(--surface,#1a1a19);padding:6px 10px 7px;min-width:0;}
.stk-vc-k{font-size:10.5px;color:var(--muted,#898781);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.stk-vc-v{font-size:15px;font-weight:600;color:var(--ink,#fff);margin-top:1px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.stk-vc-s{font-size:10px;color:var(--muted,#898781);}
.stk-val.stk-err .stk-vc-v{color:var(--muted,#898781);font-size:12px;font-weight:400;}

/* ---------- 滚动区 + 栅格 ---------- */
.stk-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px;}
.stk-scroll::-webkit-scrollbar{width:9px;height:9px;}
.stk-scroll::-webkit-scrollbar-thumb{background:var(--grid,#2c2c2a);border-radius:4px;}
.stk-scroll::-webkit-scrollbar-track{background:transparent;}
.stk-grid{display:grid;gap:10px;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start;}
.stk-root.stk-narrow .stk-grid{grid-template-columns:minmax(0,1fr);}
.stk-col{display:flex;flex-direction:column;gap:10px;min-width:0;}

/* ---------- 面板 ---------- */
.stk-p{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.10));
  border-radius:3px;overflow:hidden;min-width:0;}
.stk-p-hd{display:flex;align-items:center;gap:8px;padding:7px 10px 6px;
  background:var(--surface-2,#222221);border-bottom:1px solid var(--border,rgba(255,255,255,.10));}
.stk-p-t{font-size:12px;font-weight:600;color:var(--ink,#fff);letter-spacing:.06em;white-space:nowrap;}
.stk-p-t::before{content:"";display:inline-block;width:3px;height:11px;margin-right:7px;
  vertical-align:-1px;background:var(--ma5,#3987e5);border-radius:1px;}
.stk-p-n{font-size:10.5px;color:var(--muted,#898781);margin-left:auto;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;}
.stk-p-bd{padding:9px 10px 10px;min-width:0;}

.stk-state{padding:16px 10px;text-align:center;font-size:11.5px;color:var(--muted,#898781);}
.stk-state.stk-e{color:#c98b8b;}
.stk-retry{margin-left:8px;background:var(--surface-2,#222221);border:1px solid var(--grid,#2c2c2a);
  color:var(--ink-2,#c3c2b7);font:11px ${F};padding:2px 9px;border-radius:2px;cursor:pointer;}
.stk-retry:hover{border-color:var(--muted,#898781);color:var(--ink,#fff);}
.stk-sk{height:9px;border-radius:2px;margin:7px 0;
  background:linear-gradient(90deg,#1f1f1e 25%,#2a2a28 50%,#1f1f1e 75%);
  background-size:400% 100%;animation:stk-sh 1.3s ease-in-out infinite;}
@keyframes stk-sh{0%{background-position:100% 0}100%{background-position:0 0}}
.stk-sub-e{font-size:11px;color:#c98b8b;padding:8px 0;}

/* ---------- 通用小件 ---------- */
.stk-up{color:var(--up,#e66767);} .stk-down{color:var(--down,#199e70);}
.stk-flat{color:var(--ink-2,#c3c2b7);} .stk-mut{color:var(--muted,#898781);}
.stk-strong{color:var(--ink,#fff);font-weight:600;}
.stk-sec{font-size:10.5px;color:var(--muted,#898781);letter-spacing:.08em;
  margin:10px 0 5px;padding-bottom:3px;border-bottom:1px solid var(--grid,#2c2c2a);}
.stk-sec:first-child{margin-top:0;}
.stk-cv{display:block;width:100%;}
.stk-lg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:10.5px;color:var(--muted,#898781);margin-top:5px;}
.stk-lg i{display:inline-block;width:8px;height:8px;border-radius:1px;margin-right:4px;vertical-align:0;}

/* KV 网格 */
.stk-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;font-size:11.5px;}
.stk-kv-2{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:3px 10px;font-size:11.5px;}
.stk-kv dt,.stk-kv-2 dt,.stk-k{color:var(--muted,#898781);white-space:nowrap;}
.stk-kv dd,.stk-kv-2 dd,.stk-v{margin:0;color:var(--ink-2,#c3c2b7);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.stk-v.stk-wrap{white-space:normal;overflow:visible;}

/* 表格 */
.stk-tb{width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;}
.stk-tb th{color:var(--muted,#898781);font-weight:400;font-size:10.5px;text-align:right;
  padding:4px 6px;white-space:nowrap;border-bottom:1px solid var(--border,rgba(255,255,255,.10));
  position:sticky;top:0;background:var(--surface,#1a1a19);z-index:1;}
.stk-tb td{padding:4px 6px;text-align:right;white-space:nowrap;
  border-bottom:1px solid var(--grid,#2c2c2a);}
.stk-tb tr:last-child td{border-bottom:none;}
.stk-tb tbody tr:hover td{background:var(--surface-2,#222221);}
.stk-tb .stk-l{text-align:left;}
.stk-tb .stk-el{max-width:0;overflow:hidden;text-overflow:ellipsis;}
.stk-tw{overflow-x:auto;max-height:290px;overflow-y:auto;}
.stk-tw::-webkit-scrollbar{width:8px;height:8px;}
.stk-tw::-webkit-scrollbar-thumb{background:var(--grid,#2c2c2a);border-radius:4px;}

/* 指标小卡 */
.stk-mcards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}
.stk-mc{background:var(--surface-2,#222221);border:1px solid var(--grid,#2c2c2a);
  border-radius:2px;padding:6px 8px 3px;min-width:0;}
.stk-mc-k{font-size:10.5px;color:var(--muted,#898781);}
.stk-mc-r{display:flex;align-items:baseline;gap:6px;}
.stk-mc-v{font-size:16px;font-weight:700;color:var(--ink,#fff);}
.stk-mc-d{font-size:10.5px;}

/* 展开按钮 */
.stk-more{width:100%;margin-top:9px;background:var(--surface-2,#222221);
  border:1px solid var(--grid,#2c2c2a);color:var(--ink-2,#c3c2b7);
  font:11px ${F};padding:4px;border-radius:2px;cursor:pointer;}
.stk-more:hover{border-color:var(--muted,#898781);color:var(--ink,#fff);}
.stk-rep{margin-top:8px;}
.stk-rep .stk-gh{background:var(--surface-2,#222221);color:var(--ink,#fff);
  font-size:10.5px;letter-spacing:.08em;text-align:left;padding:4px 6px;}

/* 筹码条 */
.stk-bar{position:relative;height:16px;border-radius:2px;background:var(--surface-2,#222221);
  border:1px solid var(--grid,#2c2c2a);overflow:hidden;}
.stk-bar>i{position:absolute;left:0;top:0;bottom:0;background:var(--up,#e66767);opacity:.75;}
.stk-bar>b{position:absolute;top:0;bottom:0;right:6px;font-size:10px;font-weight:600;
  color:var(--ink,#fff);line-height:16px;}
.stk-chip-row{display:flex;align-items:center;gap:8px;margin-top:6px;}
.stk-chip{display:inline-block;padding:2px 8px;margin:0 5px 5px 0;border-radius:10px;
  background:var(--surface-2,#222221);border:1px solid var(--grid,#2c2c2a);
  font-size:10.5px;color:var(--ink-2,#c3c2b7);white-space:nowrap;}
.stk-chip em{font-style:normal;color:var(--muted,#898781);margin-left:5px;}
.stk-note{font-size:10.5px;color:var(--muted,#898781);margin-top:6px;}
`;

  function injectCSS() {
    if (document.getElementById("stk-style")) return;
    const st = el("style"); st.id = "stk-style"; st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ============================================================
     4. Canvas 图元
     ============================================================ */

  function fit(cv, h) {
    const w = Math.max(40, cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 280);
    const dpr = window.devicePixelRatio || 1;
    cv.style.height = h + "px";
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.font = "10px " + F;
    c.textBaseline = "alphabetic";
    return { c, w, h };
  }
  function noData(c, w, h) {
    c.fillStyle = C.muted; c.font = "11px " + F; c.textAlign = "center";
    c.fillText("无数据", w / 2, h / 2 + 4);
  }
  function clean(a) { return (a || []).filter((v) => v !== null && isFinite(v)); }

  /* 单序列柱状图 (可正可负, 0 轴对齐) */
  function drawBars(cv, vals, o) {
    o = o || {};
    const h = o.height || 92;
    const g = fit(cv, h); const c = g.c, w = g.w;
    const vs = clean(vals);
    if (!vs.length) { noData(c, w, h); return; }
    const padT = o.padT === undefined ? 14 : o.padT;
    const padB = o.padB === undefined ? 15 : o.padB;
    let mx = Math.max.apply(null, vs.concat([0]));
    let mn = Math.min.apply(null, vs.concat([0]));
    if (mx === mn) { mx = mx + Math.abs(mx || 1) * 0.5; mn = mn - Math.abs(mn || 1) * 0.5; }
    mx += (mx - mn) * 0.12;
    const span = (mx - mn) || 1;
    const H = h - padT - padB;
    const y = (v) => padT + (mx - v) / span * H;
    const n = vals.length, slot = w / n;
    const bw = Math.max(2, Math.min(o.maxBar || 24, slot * 0.6));
    const y0 = y(0);
    c.strokeStyle = C.grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, Math.round(y0) + .5); c.lineTo(w, Math.round(y0) + .5); c.stroke();
    const step = Math.ceil((n * 26) / Math.max(1, w));
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const cx = slot * i + slot / 2;
      if (v !== null && isFinite(v)) {
        const yv = y(v);
        c.fillStyle = typeof o.color === "function" ? o.color(v, i) : (o.color || (v >= 0 ? C.up : C.down));
        c.fillRect(Math.round(cx - bw / 2), Math.min(yv, y0), Math.round(bw), Math.max(1, Math.abs(yv - y0)));
        if (o.vlabel) {
          c.fillStyle = C["ink-2"]; c.font = "9.5px " + F; c.textAlign = "center";
          const t = o.vlabel(v, i);
          if (t) c.fillText(t, cx, v >= 0 ? Math.min(yv, y0) - 3 : Math.max(yv, y0) + 9);
        }
      }
      if (o.labels && o.labels[i] !== undefined && i % step === 0) {
        c.fillStyle = C.muted; c.font = "9.5px " + F; c.textAlign = "center";
        c.fillText(o.labels[i], cx, h - 4);
      }
    }
  }

  /* 堆叠柱状图: groups = [{name,color,vals}] , 正负分别向上/向下堆 */
  function drawStack(cv, groups, o) {
    o = o || {};
    const h = o.height || 120;
    const g = fit(cv, h); const c = g.c, w = g.w;
    const n = groups.length ? groups[0].vals.length : 0;
    if (!n) { noData(c, w, h); return; }
    let mx = 0, mn = 0;
    for (let i = 0; i < n; i++) {
      let p = 0, q = 0;
      for (const s of groups) { const v = s.vals[i]; if (!isNum(v)) continue; if (v >= 0) p += v; else q += v; }
      mx = Math.max(mx, p); mn = Math.min(mn, q);
    }
    if (mx === 0 && mn === 0) { noData(c, w, h); return; }
    const padT = 12, padB = 15;
    const span = (mx - mn) * 1.12 || 1;
    const top = mx + (mx - mn) * 0.06;
    const H = h - padT - padB;
    const y = (v) => padT + (top - v) / span * H;
    const slot = w / n, bw = Math.max(2, Math.min(o.maxBar || 16, slot * 0.66));
    const y0 = y(0);
    c.strokeStyle = C.grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, Math.round(y0) + .5); c.lineTo(w, Math.round(y0) + .5); c.stroke();
    for (let i = 0; i < n; i++) {
      const cx = Math.round(slot * i + slot / 2 - bw / 2);
      let accP = 0, accN = 0;
      for (const s of groups) {
        const v = s.vals[i];
        if (!isNum(v) || v === 0) continue;
        c.fillStyle = s.color;
        if (v > 0) { const y1 = y(accP + v), y2 = y(accP); c.fillRect(cx, y1, Math.round(bw), Math.max(1, y2 - y1)); accP += v; }
        else { const y1 = y(accN), y2 = y(accN + v); c.fillRect(cx, y1, Math.round(bw), Math.max(1, y2 - y1)); accN += v; }
      }
    }
    if (o.labels) {
      const step = Math.ceil((n * 34) / Math.max(1, w));
      c.fillStyle = C.muted; c.font = "9.5px " + F; c.textAlign = "center";
      for (let i = 0; i < n; i += step) if (o.labels[i] !== undefined) c.fillText(o.labels[i], slot * i + slot / 2, h - 4);
    }
  }

  /* 折线 / 面积 */
  function drawLine(cv, vals, o) {
    o = o || {};
    const h = o.height || 60;
    const g = fit(cv, h); const c = g.c, w = g.w;
    const vs = clean(vals);
    if (vs.length < 1) { noData(c, w, h); return; }
    const padT = o.padT === undefined ? 8 : o.padT;
    const padB = o.padB === undefined ? (o.labels ? 15 : 6) : o.padB;
    let mx = Math.max.apply(null, vs), mn = Math.min.apply(null, vs);
    if (o.zero) { mx = Math.max(mx, 0); mn = Math.min(mn, 0); }
    if (mx === mn) { mx += Math.abs(mx || 1) * .05 + .5; mn -= Math.abs(mn || 1) * .05 + .5; }
    const pad = (mx - mn) * .1; mx += pad; mn -= pad;
    const H = h - padT - padB, span = (mx - mn) || 1;
    const n = vals.length;
    const X = (i) => n <= 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1;
    const Y = (v) => padT + (mx - v) / span * H;
    const col = o.color || C.ma5;
    if (o.area) {
      const grd = c.createLinearGradient(0, padT, 0, padT + H);
      grd.addColorStop(0, hexA(col, .28)); grd.addColorStop(1, hexA(col, 0));
      c.beginPath(); let started = false;
      for (let i = 0; i < n; i++) { const v = vals[i]; if (!isNum(v)) continue; const x = X(i), yy = Y(v); if (!started) { c.moveTo(x, yy); started = true; } else c.lineTo(x, yy); }
      if (started) { c.lineTo(X(n - 1), padT + H); c.lineTo(X(0), padT + H); c.closePath(); c.fillStyle = grd; c.fill(); }
    }
    c.beginPath(); c.strokeStyle = col; c.lineWidth = o.lw || 1.5; c.lineJoin = "round";
    let st = false;
    for (let i = 0; i < n; i++) { const v = vals[i]; if (!isNum(v)) continue; const x = X(i), yy = Y(v); if (!st) { c.moveTo(x, yy); st = true; } else c.lineTo(x, yy); }
    c.stroke();
    if (o.dots !== false && n <= 20) {
      c.fillStyle = col;
      for (let i = 0; i < n; i++) { const v = vals[i]; if (!isNum(v)) continue; c.beginPath(); c.arc(X(i), Y(v), 1.9, 0, 6.284); c.fill(); }
    }
    if (o.labels) {
      const step = Math.ceil((n * 40) / Math.max(1, w));
      c.fillStyle = C.muted; c.font = "9.5px " + F; c.textAlign = "center";
      for (let i = 0; i < n; i += step) if (o.labels[i] !== undefined) c.fillText(o.labels[i], X(i), h - 3);
    }
    if (o.lastLabel) {
      const li = lastIdx(vals);
      if (li >= 0) {
        c.fillStyle = col; c.font = "10px " + F;
        const t = o.lastLabel(vals[li]);
        c.textAlign = "right"; c.fillText(t, w - 2, Math.max(9, Y(vals[li]) - 5));
      }
    }
  }
  function lastIdx(a) { for (let i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return i; return -1; }
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }

  /* 迷你 sparkline (小卡用) */
  function drawSpark(cv, vals, color) {
    drawLine(cv, vals, { height: 34, color, area: true, padT: 5, padB: 4, lw: 1.3, dots: false });
  }

  /* ============================================================
     5. 模块状态
     ============================================================ */

  let root = null, opts = {}, els = null;
  let io = null, ro = null, roTimer = null;
  let curCode = null, curQuote = null;
  const cache = Object.create(null);     // "code|kind" -> {ok:true,data} | {ok:false,err}
  const inflight = Object.create(null);
  let panels = [];                        // 运行时面板对象
  let finExpanded = false;

  /* ts_code 归一化: SSE.600519 / 600519 / 600519.SH -> 600519.SH */
  function normCode(s) {
    if (!s) return "";
    s = String(s).trim();
    const EX = { SSE: "SH", SZSE: "SZ", BSE: "BJ", SH: "SH", SZ: "SZ", BJ: "BJ" };
    if (s.indexOf(".") >= 0) {
      const a = s.split(".");
      if (EX[a[0].toUpperCase()]) return a[1] + "." + EX[a[0].toUpperCase()];
      if (EX[a[1].toUpperCase()]) return a[0] + "." + EX[a[1].toUpperCase()];
      return s;
    }
    if (/^6/.test(s)) return s + ".SH";
    if (/^(0|3)/.test(s)) return s + ".SZ";
    if (/^(4|8)/.test(s)) return s + ".BJ";
    return s;
  }

  function fetchKind(code, kind, force) {
    const key = code + "|" + kind;
    if (!force && cache[key]) return Promise.resolve(cache[key]);
    if (inflight[key]) return inflight[key];
    let p;
    if (typeof opts.request !== "function") {
      p = Promise.resolve({ ok: false, err: "无 request 通道" });
    } else {
      const args = { ts_code: code };
      if (LIMITS[kind]) args.limit = LIMITS[kind];
      p = Promise.resolve()
        .then(() => opts.request("fund", { kind, args }))
        .then((resp) => {
          if (resp && resp.type === "err") throw new Error(resp.msg || "服务端错误");
          if (!resp || !Array.isArray(resp.cols)) throw new Error("响应格式异常");
          return { ok: true, data: ds(resp) };
        })
        .catch((e) => ({ ok: false, err: (e && e.message) || String(e) }));
    }
    p = p.then((r) => { cache[key] = r; delete inflight[key]; return r; },
      (e) => { delete inflight[key]; const r = { ok: false, err: String(e) }; cache[key] = r; return r; });
    inflight[key] = p;
    return p;
  }
  const LIMITS = {
    financials: 12, moneyflow_series: 20, northbound: 20, chips: 60,
    margin: 60, dragon_list: 20, block: 20, holder_number: 12, factors: 60, valuation: 60,
  };

  /* ============================================================
     6. 面板框架
     ============================================================ */

  function makePanel(def) {
    const box = el("div", "stk-p");
    box.dataset.pid = def.id;
    const hd = el("div", "stk-p-hd");
    hd.appendChild(el("div", "stk-p-t", def.title));
    const note = el("div", "stk-p-n");
    hd.appendChild(note);
    const bd = el("div", "stk-p-bd");
    box.append(hd, bd);
    const p = { def, box, bd, note, loaded: false, code: null, results: null };
    p.setState = function (kind) {
      bd.innerHTML = ""; note.textContent = "";
      if (kind === "idle" || kind === "loading") {
        for (let i = 0; i < 3; i++) {
          const s = el("div", "stk-sk");
          s.style.width = [92, 74, 60][i] + "%";
          bd.appendChild(s);
        }
      }
    };
    p.setError = function (msg) {
      bd.innerHTML = ""; note.textContent = "";
      const d = el("div", "stk-state stk-e");
      d.appendChild(el("span", null, "数据获取失败"));
      const b = el("button", "stk-retry", "重试");
      b.addEventListener("click", () => load(p, true));
      d.appendChild(b);
      if (msg) { const m = el("div", "stk-note", String(msg).slice(0, 120)); d.appendChild(m); }
      bd.appendChild(d);
    };
    p.setState("idle");
    return p;
  }

  function load(p, force) {
    if (!curCode) return;
    const code = curCode;
    p.loaded = true; p.code = code;
    /* 已全部命中缓存则直接同步渲染, 无闪烁 */
    const allCached = !force && p.def.kinds.every((k) => cache[code + "|" + k]);
    if (!allCached) p.setState("loading");
    Promise.all(p.def.kinds.map((k) => fetchKind(code, k, force))).then((rs) => {
      if (!els || curCode !== code) return;
      const map = {};
      p.def.kinds.forEach((k, i) => { map[k] = rs[i]; });
      p.results = map;
      const anyOk = p.def.kinds.some((k) => map[k].ok);
      if (!anyOk) { p.setError(map[p.def.kinds[0]].err); return; }
      renderPanel(p);
    });
  }

  function renderPanel(p) {
    if (!p.results) return;
    p.bd.innerHTML = ""; p.note.textContent = "";
    try {
      p.def.render(p.bd, p.results, p);
    } catch (e) {
      p.bd.innerHTML = "";
      const d = el("div", "stk-state stk-e", "渲染失败: " + ((e && e.message) || e));
      p.bd.appendChild(d);
      if (window.console) console.error("[StockView]", p.def.id, e);
    }
  }

  /* 子区块错误行 (面板内单个 kind 失败) */
  function subErr(host, label) {
    host.appendChild(el("div", "stk-sub-e", label + " · 数据获取失败"));
  }

  /* ============================================================
     7. 通用渲染小工具
     ============================================================ */

  function sec(host, text) { host.appendChild(el("div", "stk-sec", text)); return host; }

  function kvGrid(pairs, two) {
    const dl = el("dl", two ? "stk-kv-2" : "stk-kv");
    for (const [k, v, cls, wrap] of pairs) {
      dl.appendChild(el("dt", null, k));
      const dd = el("dd", "stk-v" + (cls ? " " + cls : "") + (wrap ? " stk-wrap" : ""));
      if (v instanceof Node) dd.appendChild(v); else dd.textContent = v === "" || v === null || v === undefined ? DASH : v;
      dl.appendChild(dd);
    }
    return dl;
  }

  /* head: [{t,a}] , body: rows of ({t,cls,title} | string) */
  function mkTable(head, body, o) {
    o = o || {};
    const wrap = el("div", "stk-tw");
    if (o.maxH) wrap.style.maxHeight = o.maxH + "px";
    const tb = el("table", "stk-tb");
    const th = el("thead"), tr0 = el("tr");
    for (const h of head) {
      const th1 = el("th", h.a === "l" ? "stk-l" : null, h.t);
      if (h.w) th1.style.width = h.w;
      tr0.appendChild(th1);
    }
    th.appendChild(tr0);
    const tb2 = el("tbody");
    for (const r of body) {
      const tr = el("tr");
      r.forEach((cell, i) => {
        const c = typeof cell === "object" && cell !== null ? cell : { t: cell };
        const td = el("td", (head[i] && head[i].a === "l" ? "stk-l " : "") + (c.cls || "") + (c.el ? " stk-el" : ""));
        td.textContent = c.t === null || c.t === undefined || c.t === "" ? DASH : c.t;
        if (c.title) td.title = c.title;
        tr.appendChild(td);
      });
      tb2.appendChild(tr);
    }
    tb.append(th, tb2);
    wrap.appendChild(tb);
    if (!body.length) { wrap.innerHTML = ""; wrap.appendChild(el("div", "stk-state", "暂无记录")); }
    return wrap;
  }

  function canvas(host, h) {
    const cv = el("canvas", "stk-cv");
    cv.style.height = h + "px";
    host.appendChild(cv);
    return cv;
  }
  function legend(host, items) {
    const d = el("div", "stk-lg");
    for (const it of items) {
      const s = el("span");
      const i = el("i"); i.style.background = it.c;
      s.append(i, document.createTextNode(it.t));
      d.appendChild(s);
    }
    host.appendChild(d);
    return d;
  }
  function metricCard(host, label, valText, deltaText, deltaVal, series, color) {
    const c = el("div", "stk-mc");
    c.appendChild(el("div", "stk-mc-k", label));
    const r = el("div", "stk-mc-r");
    r.appendChild(el("div", "stk-mc-v", valText));
    if (deltaText) r.appendChild(el("div", "stk-mc-d " + sgn(deltaVal), (arrow(deltaVal) || "") + deltaText));
    c.appendChild(r);
    const cv = canvas(c, 34);
    host.appendChild(c);
    return () => drawSpark(cv, series, color);
  }

  /* 把待重绘的 canvas 闭包挂到面板上 (resize 时重放) */
  function defer(p, fn) { (p._draw || (p._draw = [])).push(fn); }
  function flush(p) {
    /* canvas 需要先入 DOM 才有宽度, 用 rAF 保证布局完成 */
    const list = p._draw || [];
    p._draw = [];
    if (!list.length) return;
    requestAnimationFrame(() => { for (const f of list) { try { f(); } catch (e) { } } });
  }

  /* ============================================================
     8. 各面板渲染
     ============================================================ */

  /* ---------- 公司概况 + 指数归属 ---------- */
  function renderProfile(bd, R, p) {
    const b = R.stock_basic, ix = R.index_members;
    if (b && b.ok && b.data.n) {
      const d = b.data, r = d.rows[0];
      const get = (n) => { const v = d.str(r, n); return v && v !== "None" ? v : ""; };
      const pairs = [
        ["所属行业", get(["industry", "sw_l2", "sw_industry"])],
        ["地区", get(["area", "province"])],
        ["市场", get(["market"])],
        ["上市日期", dstr(get(["list_date"])) || ""],
        ["交易所", get(["exchange"])],
        ["公司全称", get(["fullname", "com_name"])],
        ["董事长", get(["chairman"])],
        ["总经理", get(["manager"])],
        ["董秘", get(["secretary"])],
        ["注册资本", (function () { const v = d.num(r, ["reg_capital"]); return v === null ? "" : fmtYuan(v * 1e4); })()],
        ["员工人数", (function () { const v = d.num(r, ["employees"]); return v === null ? "" : fmtCount(v) + "人"; })()],
        ["注册地", get(["office", "introduction"]) ? "" : ""],
      ].filter((x) => x[1] !== "" && x[1] !== undefined);
      bd.appendChild(kvGrid(pairs.slice(0, 12), true));
      const mb = get(["main_business", "business_scope", "introduction"]);
      if (mb) {
        sec(bd, "主营业务");
        const t = el("div", "stk-v stk-wrap");
        t.style.fontSize = "11.5px"; t.style.lineHeight = "1.6";
        t.textContent = mb.length > 220 ? mb.slice(0, 220) + "…" : mb;
        t.title = mb;
        bd.appendChild(t);
      }
    } else if (b && !b.ok) subErr(bd, "公司资料");

    if (ix && ix.ok && ix.data.n) {
      sec(bd, "指数归属");
      const d = ix.data, box = el("div");
      const list = d.rows.slice(0, 12);
      for (const r of list) {
        const nm = d.str(r, ["index_name", "name", "idx_name"]) || d.str(r, ["index_code", "con_code", "ts_code"]);
        const w = d.num(r, ["weight", "wt"]);
        const c = el("span", "stk-chip", nm);
        if (w !== null) { const e2 = el("em", null, fmtPct(w)); c.appendChild(e2); }
        box.appendChild(c);
      }
      bd.appendChild(box);
    } else if (ix && !ix.ok) subErr(bd, "指数归属");
    p.note.textContent = b && b.ok && b.data.n ? (ds({ cols: b.data.cols, rows: b.data.rows }).str(b.data.rows[0], ["ts_code"]) || "") : "";
  }

  /* ---------- 财务摘要 + 三大报表 ---------- */
  function renderFinancials(bd, R, p) {
    const r0 = R.financials;
    const d = r0.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "暂无财务数据")); return; }
    const all = d.byDate(["end_date", "ann_date"]);          // 升序
    const rows = all.slice(-8);
    const labels = (d.strsOf(rows, ["end_date", "ann_date"]) || rows.map(() => "")).map(qLabel);
    p.note.textContent = "最新报告期 " + dstr(d.str(rows[rows.length - 1], ["end_date", "ann_date"]));

    const rev = d.numsOf(rows, ["total_revenue", "revenue", "oper_revenue"]) || [];
    const np = d.numsOf(rows, ["n_income_attr_p", "n_income", "netprofit"]) || [];
    let revYoy = d.numsOf(rows, ["or_yoy", "tr_yoy"]);
    let npYoy = d.numsOf(rows, ["netprofit_yoy", "dt_netprofit_yoy"]);
    /* 缺同比就用 4 期前自算 */
    const allRev = d.numsOf(all, ["total_revenue", "revenue", "oper_revenue"]);
    const allNp = d.numsOf(all, ["n_income_attr_p", "n_income", "netprofit"]);
    const off = all.length - rows.length;
    function calcYoy(src) {
      if (!src) return null;
      return rows.map((_, i) => {
        const j = off + i, k = j - 4;
        if (k < 0 || !isNum(src[j]) || !isNum(src[k]) || src[k] === 0) return null;
        return (src[j] / Math.abs(src[k]) - 1) * 100;
      });
    }
    if (!revYoy || !clean(revYoy).length) revYoy = calcYoy(allRev);
    if (!npYoy || !clean(npYoy).length) npYoy = calcYoy(allNp);

    /* --- 营收 / 净利 柱状 --- */
    sec(bd, "营业总收入 / 归母净利润 (近 " + rows.length + " 期)");
    const g2 = el("div");
    g2.style.display = "grid"; g2.style.gridTemplateColumns = "minmax(0,1fr) minmax(0,1fr)"; g2.style.gap = "8px";
    const c1box = el("div"), c2box = el("div");
    c1box.appendChild(el("div", "stk-mc-k", "营业总收入"));
    c2box.appendChild(el("div", "stk-mc-k", "归母净利润"));
    const cv1 = canvas(c1box, 96), cv2 = canvas(c2box, 96);
    g2.append(c1box, c2box);
    bd.appendChild(g2);
    defer(p, () => {
      drawBars(cv1, rev, { height: 96, labels, color: C.ma5, vlabel: (v) => fmtYuan(v, 1) });
      drawBars(cv2, np, { height: 96, labels, color: C.ma20, vlabel: (v) => fmtYuan(v, 1) });
    });

    /* --- 同比行 --- */
    const yr = el("div");
    yr.style.display = "grid"; yr.style.gridTemplateColumns = "minmax(0,1fr) minmax(0,1fr)"; yr.style.gap = "8px";
    yr.style.marginTop = "4px";
    const li = rows.length - 1;
    function yoyCell(label, arr) {
      const v = arr ? arr[li] : null;
      const box = el("div", "stk-mc-r");
      box.appendChild(el("span", "stk-k", label));
      box.appendChild(el("span", "stk-mc-d " + sgn(v), (arrow(v) || "") + " " + fmtPctSign(v)));
      return box;
    }
    yr.append(yoyCell("同比", revYoy), yoyCell("同比", npYoy));
    bd.appendChild(yr);

    /* --- 关键指标小卡 --- */
    sec(bd, "关键指标");
    const cards = el("div", "stk-mcards");
    bd.appendChild(cards);
    const specs = [
      { k: ["roe", "roe_waa", "roe_dt"], t: "ROE", c: C.ma5 },
      { k: ["grossprofit_margin", "gross_margin"], t: "毛利率", c: C.ma10 },
      { k: ["debt_to_assets", "debt_to_asset"], t: "资产负债率", c: C.ma60 },
    ];
    let anyCard = false;
    for (const s of specs) {
      const arr = d.numsOf(all, s.k);
      if (!arr || !clean(arr).length) continue;
      anyCard = true;
      const li2 = lastIdx(arr);
      let prev = null;
      for (let i = li2 - 1; i >= 0; i--) if (isNum(arr[i])) { prev = arr[i]; break; }
      const dv = prev === null ? null : arr[li2] - prev;
      const f = metricCard(cards, s.t, fmtPct(arr[li2]),
        dv === null ? "" : Math.abs(dv).toFixed(2) + "pt", dv, arr.slice(-16), s.c);
      defer(p, f);
    }
    if (!anyCard) cards.appendChild(el("div", "stk-note", "无可用指标字段"));

    /* --- 净利率 / 每股 --- */
    const extra = [];
    const pairsSpec = [
      ["netprofit_margin", "净利率"], ["eps", "每股收益"], ["bps", "每股净资产"],
      ["ocfps", "每股经营现金流"], ["current_ratio", "流动比率"], ["assets_turn", "总资产周转率"],
    ];
    for (const [k, lab] of pairsSpec) {
      const v = d.num(rows[li], [k]);
      if (v === null) continue;
      extra.push([lab, fmtBy(v, (FIELD[k] && FIELD[k][1]) || "ratio")]);
    }
    if (extra.length) { sec(bd, "其他指标"); bd.appendChild(kvGrid(extra, true)); }

    /* --- 三大报表可展开 --- */
    const btn = el("button", "stk-more", finExpanded ? "收起三大报表 ▲" : "展开三大报表关键行 ▼");
    const repHost = el("div", "stk-rep");
    bd.append(btn, repHost);
    function paint() {
      repHost.innerHTML = "";
      if (!finExpanded) return;
      repHost.appendChild(reportTable(d, rows.slice(-6)));
    }
    btn.addEventListener("click", () => {
      finExpanded = !finExpanded;
      btn.textContent = finExpanded ? "收起三大报表 ▲" : "展开三大报表关键行 ▼";
      paint();
    });
    paint();
    flush(p);
  }

  function reportTable(d, rows) {
    const labels = (d.strsOf(rows, ["end_date", "ann_date"]) || []).map(qLabel);
    const head = [{ t: "科目", a: "l", w: "40%" }].concat(labels.map((t) => ({ t })));
    const body = [];
    const buckets = {};
    for (const c of d.cols) {
      const key = String(c).toLowerCase();
      if (SKIP_FIELDS.has(key)) continue;
      const f = FIELD[key];
      const grp = f ? f[2] : "其他";
      (buckets[grp] || (buckets[grp] = [])).push({ key, label: f ? f[0] : key, unit: f ? f[1] : "count" });
    }
    const wrap = el("div", "stk-tw");
    wrap.style.maxHeight = "340px";
    const tb = el("table", "stk-tb");
    const th = el("thead"), tr0 = el("tr");
    head.forEach((h, i) => { const x = el("th", i === 0 ? "stk-l" : null, h.t); if (h.w) x.style.width = h.w; tr0.appendChild(x); });
    th.appendChild(tr0);
    const tbody = el("tbody");
    let printed = 0;
    for (const g of GROUP_ORDER) {
      const list = buckets[g];
      if (!list || !list.length) continue;
      /* 该组内至少有一个非空值才输出 */
      const usable = list.filter((f) => rows.some((r) => d.num(r, [f.key]) !== null));
      if (!usable.length) continue;
      const gtr = el("tr");
      const gtd = el("td", "stk-gh"); gtd.colSpan = head.length; gtd.textContent = g;
      gtr.appendChild(gtd); tbody.appendChild(gtr);
      for (const f of usable) {
        const tr = el("tr");
        tr.appendChild(el("td", "stk-l stk-el", f.label));
        for (const r of rows) {
          const v = d.num(r, [f.key]);
          const td = el("td", v === null ? "stk-mut" : (f.unit === "pct" ? sgn(v) : ""));
          td.textContent = fmtBy(v, f.unit);
          tr.appendChild(td);
        }
        tbody.appendChild(tr); printed++;
      }
    }
    tb.append(th, tbody); wrap.appendChild(tb);
    if (!printed) { wrap.innerHTML = ""; wrap.appendChild(el("div", "stk-state", "无可展开科目")); }
    return wrap;
  }

  /* ---------- 股东 ---------- */
  function renderHolders(bd, R, p) {
    const h = R.holders, hn = R.holder_number;
    if (h && h.ok && h.data.n) {
      const d = h.data;
      const dateKey = d.idx(["end_date"]) >= 0 ? "end_date" : "ann_date";
      const latest = d.rows.reduce((m, r) => Math.max(m, dnum(d.str(r, [dateKey]))), 0);
      let list = d.rows.filter((r) => dnum(d.str(r, [dateKey])) === latest);
      const rk = d.idx(["hold_ratio", "hold_float_ratio", "ratio"]);
      if (rk >= 0) list.sort((a, b) => (nz(b[rk]) || 0) - (nz(a[rk]) || 0));
      list = list.slice(0, 10);
      sec(bd, "十大股东 · " + dstr(latest));
      p.note.textContent = dstr(latest);
      const body = list.map((r, i) => {
        const nm = d.str(r, ["holder_name", "name"]);
        const amt = d.num(r, ["hold_amount", "hold_vol", "amount"]);
        const rt = d.num(r, ["hold_ratio", "hold_float_ratio", "ratio"]);
        const ch = d.num(r, ["hold_change", "change", "chg"]);
        return [
          { t: String(i + 1), cls: "stk-mut" },
          { t: nm, title: nm, el: true },
          { t: fmtShares(amt) },
          { t: fmtPct(rt), cls: "stk-strong" },
          { t: ch === null ? DASH : (ch > 0 ? "+" : "") + fmtCount(ch), cls: sgn(ch) },
        ];
      });
      bd.appendChild(mkTable(
        [{ t: "#", w: "24px" }, { t: "股东名称", a: "l" }, { t: "持股数" }, { t: "占比" }, { t: "变动" }],
        body, { maxH: 250 }));
    } else if (h && !h.ok) subErr(bd, "十大股东");

    if (hn && hn.ok && hn.data.n) {
      const d = hn.data;
      const rows = d.byDate(["end_date", "ann_date"]).slice(-12);
      const vals = d.numsOf(rows, ["holder_num", "holder_number", "num"]) || [];
      const labs = (d.strsOf(rows, ["end_date", "ann_date"]) || []).map(qLabel);
      const li = lastIdx(vals);
      let prev = null;
      for (let i = li - 1; i >= 0; i--) if (isNum(vals[i])) { prev = vals[i]; break; }
      const chg = prev !== null && prev !== 0 ? (vals[li] / prev - 1) * 100 : null;
      sec(bd, "股东户数");
      const row = el("div", "stk-mc-r");
      row.appendChild(el("span", "stk-mc-v", li >= 0 ? fmtCount(vals[li]) + "户" : DASH));
      /* 户数下降是利好 -> 红; 上升 -> 绿 */
      row.appendChild(el("span", "stk-mc-d " + sgn(chg === null ? null : -chg),
        chg === null ? "" : (arrow(chg) + " 环比" + fmtPctSign(chg))));
      bd.appendChild(row);
      const cv = canvas(bd, 62);
      defer(p, () => drawLine(cv, vals, { height: 62, labels: labs, color: C.ma10, area: true }));
    } else if (hn && !hn.ok) subErr(bd, "股东户数");
    flush(p);
  }

  /* ---------- 融资融券 ---------- */
  function renderMargin(bd, R, p) {
    const d = R.margin.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "非两融标的 / 暂无数据")); return; }
    const rows = d.byDate(["trade_date"]);
    const labs = (d.strsOf(rows, ["trade_date"]) || []).map(mdShort);
    const rzye = d.numsOf(rows, ["rzye", "rz_ye", "fin_balance"]) || [];
    const rqye = d.numsOf(rows, ["rqye", "rq_ye"]) || [];
    const rzrq = d.numsOf(rows, ["rzrqye", "rzrq_ye"]) || [];
    const rzmre = d.numsOf(rows, ["rzmre"]);
    const rzche = d.numsOf(rows, ["rzche"]);
    const li = lastIdx(rzye);
    p.note.textContent = rows.length ? dstr(d.str(rows[rows.length - 1], ["trade_date"])) : "";

    let prev = null;
    for (let i = li - 1; i >= 0; i--) if (isNum(rzye[i])) { prev = rzye[i]; break; }
    const dchg = prev !== null && prev !== 0 ? (rzye[li] / prev - 1) * 100 : null;

    const pairs = [
      ["融资余额", li >= 0 ? fmtYuan(rzye[li]) : DASH],
      ["日变化", el2(fmtPctSign(dchg), sgn(dchg))],
      ["融券余额", fmtYuan(rqye[lastIdx(rqye)])],
      ["融资融券余额", fmtYuan(rzrq[lastIdx(rzrq)])],
    ];
    if (rzmre && rzche) {
      const j = lastIdx(rzmre);
      const net = isNum(rzmre[j]) && isNum(rzche[j]) ? rzmre[j] - rzche[j] : null;
      pairs.push(["融资买入", fmtYuan(rzmre[j])], ["融资净买入", el2(fmtYuanSign(net), sgn(net))]);
    }
    bd.appendChild(kvGrid(pairs, true));
    sec(bd, "融资余额趋势 (近 " + rows.length + " 日)");
    const cv = canvas(bd, 78);
    defer(p, () => drawLine(cv, rzye, { height: 78, labels: labs, color: C.ma5, area: true, dots: false }));
    if (rzmre && rzche) {
      const net = rows.map((_, i) => (isNum(rzmre[i]) && isNum(rzche[i]) ? rzmre[i] - rzche[i] : null));
      sec(bd, "融资净买入");
      const cv2 = canvas(bd, 66);
      defer(p, () => drawBars(cv2, net, { height: 66, labels: labs, padT: 8, maxBar: 10 }));
    }
    flush(p);
  }
  function el2(text, cls) { return el("span", cls, text); }

  /* ---------- 资金流 ---------- */
  const FLOW_SPEC = [
    { key: "elg", t: "超大单", c: "#e66767", buy: ["buy_elg_amount"], sell: ["sell_elg_amount"], net: ["net_elg_amount", "net_mf_elg_amount"] },
    { key: "lg", t: "大单", c: "#d99a26", buy: ["buy_lg_amount"], sell: ["sell_lg_amount"], net: ["net_lg_amount"] },
    { key: "md", t: "中单", c: "#3987e5", buy: ["buy_md_amount"], sell: ["sell_md_amount"], net: ["net_md_amount"] },
    { key: "sm", t: "小单", c: "#7d7c74", buy: ["buy_sm_amount"], sell: ["sell_sm_amount"], net: ["net_sm_amount"] },
  ];
  function renderFlow(bd, R, p) {
    const d = R.moneyflow_series.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "暂无资金流数据")); return; }
    const rows = d.byDate(["trade_date"]).slice(-20);
    const labs = (d.strsOf(rows, ["trade_date"]) || []).map(mdShort);
    p.note.textContent = "近 " + rows.length + " 日 · 万元口径";
    /* tushare moneyflow 金额单位为万元 -> 换成元 */
    const K = 1e4;
    const groups = [];
    for (const s of FLOW_SPEC) {
      let arr = d.numsOf(rows, s.net);
      if (!arr || !clean(arr).length) {
        const b = d.numsOf(rows, s.buy), se = d.numsOf(rows, s.sell);
        if (b && se) arr = rows.map((_, i) => (isNum(b[i]) && isNum(se[i]) ? b[i] - se[i] : null));
        else arr = null;
      }
      if (arr) groups.push({ name: s.t, color: s.c, vals: arr.map((v) => (isNum(v) ? v * K : null)) });
    }
    if (!groups.length) {
      /* 只有总净额 */
      const nm = d.numsOf(rows, ["net_mf_amount", "net_amount"]);
      if (!nm) { bd.appendChild(el("div", "stk-state", "字段不足, 无法绘制")); return; }
      groups.push({ name: "净流入", color: C.up, vals: nm.map((v) => (isNum(v) ? v * K : null)) });
    }
    /* 汇总 */
    const main = rows.map((_, i) => {
      let s = 0, ok = false;
      for (const g of groups) if ((g.name === "超大单" || g.name === "大单") && isNum(g.vals[i])) { s += g.vals[i]; ok = true; }
      return ok ? s : null;
    });
    const total = rows.map((_, i) => {
      let s = 0, ok = false;
      for (const g of groups) if (isNum(g.vals[i])) { s += g.vals[i]; ok = true; }
      return ok ? s : null;
    });
    function sum(a, n) { let s = 0, ok = false; for (let i = Math.max(0, a.length - n); i < a.length; i++) if (isNum(a[i])) { s += a[i]; ok = true; } return ok ? s : null; }
    bd.appendChild(kvGrid([
      ["今日主力净流入", el2(fmtYuanSign(main[main.length - 1]), sgn(main[main.length - 1]))],
      ["今日总净流入", el2(fmtYuanSign(total[total.length - 1]), sgn(total[total.length - 1]))],
      ["5日主力累计", el2(fmtYuanSign(sum(main, 5)), sgn(sum(main, 5)))],
      ["20日主力累计", el2(fmtYuanSign(sum(main, 20)), sgn(sum(main, 20)))],
    ], true));
    sec(bd, "分单资金净流入 (堆叠)");
    const cv = canvas(bd, 124);
    legend(bd, groups.map((g) => ({ c: g.color, t: g.name })));
    sec(bd, "主力净流入 (超大单+大单)");
    const cv2 = canvas(bd, 74);
    defer(p, () => {
      drawStack(cv, groups, { height: 124, labels: labs });
      drawBars(cv2, main, { height: 74, labels: labs, padT: 8, maxBar: 11 });
    });
    flush(p);
  }

  /* ---------- 北向资金 ---------- */
  function renderNorth(bd, R, p) {
    const d = R.northbound.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "非陆股通标的 / 暂无数据")); return; }
    const rows = d.byDate(["trade_date"]);
    const labs = (d.strsOf(rows, ["trade_date"]) || []).map(mdShort);
    p.note.textContent = rows.length ? dstr(d.str(rows[rows.length - 1], ["trade_date"])) : "";

    const ratio = d.numsOf(rows, ["ratio", "hold_ratio"]);
    const vol = d.numsOf(rows, ["vol", "hold_vol", "share"]);
    const amount = d.numsOf(rows, ["amount", "market_value", "mv"]);
    const north = d.numsOf(rows, ["north_money", "net_amount", "net_buy"]);

    if (ratio && clean(ratio).length) {
      const li = lastIdx(ratio);
      let prev = null; for (let i = li - 1; i >= 0; i--) if (isNum(ratio[i])) { prev = ratio[i]; break; }
      const dv = prev === null ? null : ratio[li] - prev;
      const pairs = [["陆股通持股占比", fmtPct(ratio[li], 3)],
      ["日变化", el2((dv === null ? DASH : (dv > 0 ? "+" : "") + dv.toFixed(3) + "pt"), sgn(dv))]];
      if (vol) pairs.push(["持股数量", fmtShares(vol[lastIdx(vol)])]);
      if (amount) pairs.push(["持股市值", fmtYuan(amount[lastIdx(amount)])]);
      bd.appendChild(kvGrid(pairs, true));
      sec(bd, "持股占比走势");
      const cv = canvas(bd, 74);
      defer(p, () => drawLine(cv, ratio, { height: 74, labels: labs, color: C.ma20, area: true, dots: false, lastLabel: (v) => fmtPct(v, 2) }));
      if (vol && clean(vol).length) {
        sec(bd, "持股数量变化");
        const chg = rows.map((_, i) => (i && isNum(vol[i]) && isNum(vol[i - 1]) ? vol[i] - vol[i - 1] : null));
        const cv2 = canvas(bd, 66);
        defer(p, () => drawBars(cv2, chg, { height: 66, labels: labs, padT: 8, maxBar: 11 }));
      }
    } else if (north && clean(north).length) {
      /* 市场级北向净流入, 百万元 */
      const vals = north.map((v) => (isNum(v) ? v * 1e6 : null));
      const li = lastIdx(vals);
      function sum(a, n) { let s = 0, ok = false; for (let i = Math.max(0, a.length - n); i < a.length; i++) if (isNum(a[i])) { s += a[i]; ok = true; } return ok ? s : null; }
      bd.appendChild(kvGrid([
        ["当日北向净流入", el2(fmtYuanSign(vals[li]), sgn(vals[li]))],
        ["5日累计", el2(fmtYuanSign(sum(vals, 5)), sgn(sum(vals, 5)))],
        ["20日累计", el2(fmtYuanSign(sum(vals, 20)), sgn(sum(vals, 20)))],
        ["样本天数", String(clean(vals).length)],
      ], true));
      sec(bd, "北向净流入 (市场)");
      const cv = canvas(bd, 86);
      defer(p, () => drawBars(cv, vals, { height: 86, labels: labs, maxBar: 12 }));
    } else {
      bd.appendChild(el("div", "stk-state", "字段不足, 无法展示"));
    }
    flush(p);
  }

  /* ---------- 龙虎榜 ---------- */
  function renderDragon(bd, R, p) {
    const d = R.dragon_list.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "近期未上榜")); return; }
    const rows = d.byDate(["trade_date"], false).slice(0, 20);   // 降序
    p.note.textContent = "近 " + rows.length + " 次上榜";
    const body = rows.map((r) => {
      const buy = d.num(r, ["l_buy", "buy_amount", "l_amount"]);
      const sell = d.num(r, ["l_sell", "sell_amount"]);
      let net = d.num(r, ["net_amount", "net_buy"]);
      if (net === null && buy !== null && sell !== null) net = buy - sell;
      const pct = d.num(r, ["pct_change", "pct_chg", "change"]);
      const reason = d.str(r, ["reason", "exalter"]);
      return [
        { t: mdShort(d.str(r, ["trade_date"])), cls: "stk-mut" },
        { t: fmtPctSign(pct), cls: sgn(pct) },
        { t: fmtYuan(buy) },
        { t: fmtYuan(sell) },
        { t: fmtYuanSign(net), cls: sgn(net) + " stk-strong" },
        { t: reason, title: reason, el: true },
      ];
    });
    bd.appendChild(mkTable(
      [{ t: "日期" }, { t: "涨跌幅" }, { t: "买入额" }, { t: "卖出额" }, { t: "净额" }, { t: "上榜原因", a: "l" }],
      body, { maxH: 240 }));
  }

  /* ---------- 筹码分布 ---------- */
  function renderChips(bd, R, p) {
    const d = R.chips.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "暂无筹码数据")); return; }
    const rows = d.byDate(["trade_date"]);
    const last = rows[rows.length - 1];
    p.note.textContent = dstr(d.str(last, ["trade_date"]));
    const win = d.num(last, ["winner_rate"]);
    const avg = d.num(last, ["weight_avg", "cost_50pct"]);
    const q = ["cost_5pct", "cost_15pct", "cost_50pct", "cost_85pct", "cost_95pct"].map((k) => d.num(last, [k]));
    const px = curQuote ? qLast(curQuote) : null;

    /* 获利比例条 */
    sec(bd, "获利比例");
    const bar = el("div", "stk-bar");
    const fill = el("i"); fill.style.width = Math.max(0, Math.min(100, isNum(win) ? win : 0)) + "%";
    fill.style.background = isNum(win) && win < 50 ? C.down : C.up;
    const lab = el("b", null, fmtPct(win, 1));
    bar.append(fill, lab);
    bd.appendChild(bar);

    /* 成本分位 */
    const lo = q[0], hi = q[4];
    if (isNum(lo) && isNum(hi) && hi > lo) {
      sec(bd, "成本分布 (5% ~ 95% 分位)");
      const host = el("div");
      host.style.position = "relative";
      const cv = canvas(host, 58);
      bd.appendChild(host);
      defer(p, () => {
        const g = fit(cv, 58); const c = g.c, w = g.w, h = 58;
        const X = (v) => 4 + ((v - lo) / (hi - lo)) * (w - 8);
        /* 分位区间带 */
        const bands = [[q[0], q[1], hexA(C.ma5, .18)], [q[1], q[2], hexA(C.ma5, .34)],
        [q[2], q[3], hexA(C.up, .34)], [q[3], q[4], hexA(C.up, .18)]];
        for (const [a, b, col] of bands) {
          if (!isNum(a) || !isNum(b)) continue;
          c.fillStyle = col; c.fillRect(X(a), 14, Math.max(1, X(b) - X(a)), 20);
        }
        c.strokeStyle = C.grid; c.strokeRect(4.5, 14.5, w - 9, 19);
        c.font = "9.5px " + F; c.fillStyle = C.muted;
        c.textAlign = "left"; c.fillText(fmtNum(lo, 2), 4, 45);
        c.textAlign = "right"; c.fillText(fmtNum(hi, 2), w - 4, 45);
        c.textAlign = "center";
        if (isNum(avg)) {
          const x = X(avg);
          c.strokeStyle = C["ink-2"]; c.lineWidth = 1;
          c.beginPath(); c.moveTo(x, 12); c.lineTo(x, 36); c.stroke();
          c.fillStyle = C["ink-2"]; c.fillText("均价 " + fmtNum(avg, 2), Math.min(w - 26, Math.max(26, x)), 9);
        }
        if (isNum(px) && px >= lo && px <= hi) {
          const x = X(px);
          c.strokeStyle = C.up; c.lineWidth = 2;
          c.beginPath(); c.moveTo(x, 12); c.lineTo(x, 36); c.stroke();
          c.fillStyle = C.up; c.fillText("现价 " + fmtNum(px, 2), Math.min(w - 26, Math.max(26, x)), 45);
        }
      });
    }
    const pairs = [];
    const names = ["5%分位", "15%分位", "50%分位", "85%分位", "95%分位"];
    q.forEach((v, i) => { if (isNum(v)) pairs.push([names[i], fmtNum(v, 2)]); });
    if (isNum(avg)) pairs.push(["平均成本", fmtNum(avg, 2)]);
    const hl = d.num(last, ["his_low"]), hh = d.num(last, ["his_high"]);
    if (isNum(hl)) pairs.push(["历史最低", fmtNum(hl, 2)]);
    if (isNum(hh)) pairs.push(["历史最高", fmtNum(hh, 2)]);
    if (pairs.length) { sec(bd, "成本分位"); bd.appendChild(kvGrid(pairs, true)); }

    const wr = d.numsOf(rows, ["winner_rate"]);
    if (wr && clean(wr).length > 1) {
      sec(bd, "获利比例走势");
      const cv2 = canvas(bd, 62);
      const labs = (d.strsOf(rows, ["trade_date"]) || []).map(mdShort);
      defer(p, () => drawLine(cv2, wr, { height: 62, labels: labs, color: C.ma60, area: true, dots: false }));
    }
    flush(p);
  }

  /* ---------- 大宗交易 ---------- */
  function renderBlock(bd, R, p) {
    const d = R.block.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "近期无大宗交易")); return; }
    const rows = d.byDate(["trade_date"], false).slice(0, 20);
    p.note.textContent = "近 " + rows.length + " 笔";
    const px = curQuote ? qLast(curQuote) : null;
    const body = rows.map((r) => {
      const pr = d.num(r, ["price"]);
      const vol = d.num(r, ["vol"]);          // 万股
      const amt = d.num(r, ["amount"]);       // 万元
      const prem = isNum(pr) && isNum(px) && px ? (pr / px - 1) * 100 : null;
      const buyer = d.str(r, ["buyer"]), seller = d.str(r, ["seller"]);
      return [
        { t: mdShort(d.str(r, ["trade_date"])), cls: "stk-mut" },
        { t: fmtNum(pr, 2), cls: "stk-strong" },
        { t: prem === null ? DASH : fmtPctSign(prem, 1), cls: sgn(prem) },
        { t: isNum(vol) ? fmtShares(vol * 1e4) : DASH },
        { t: isNum(amt) ? fmtYuan(amt * 1e4) : DASH },
        { t: buyer, title: buyer + " ← " + seller, el: true },
      ];
    });
    bd.appendChild(mkTable(
      [{ t: "日期" }, { t: "成交价" }, { t: "折溢价" }, { t: "成交量" }, { t: "成交额" }, { t: "买方营业部", a: "l" }],
      body, { maxH: 240 }));
    bd.appendChild(el("div", "stk-note", "折溢价 = 大宗成交价 / 最新价 - 1"));
  }

  /* ---------- 技术指标 ---------- */
  function renderFactors(bd, R, p) {
    const d = R.factors.data;
    if (!d.n) { bd.appendChild(el("div", "stk-state", "暂无技术指标")); return; }
    const rows = d.byDate(["trade_date"]);
    const last = rows[rows.length - 1];
    p.note.textContent = dstr(d.str(last, ["trade_date"]));
    const close = d.numsOf(rows, ["close", "close_qfq"]) || [];
    const labs = (d.strsOf(rows, ["trade_date"]) || []).map(mdShort);
    const cl = close[lastIdx(close)];

    const maSpec = [["ma_qfq_5", "ma5", "MA5", C.ma5], ["ma_qfq_10", "ma10", "MA10", C.ma10],
    ["ma_qfq_20", "ma20", "MA20", C.ma20], ["ma_qfq_60", "ma60", "MA60", C.ma60]];
    const pairs = [];
    for (const [k1, k2, lab, col] of maSpec) {
      const v = d.num(last, [k1, k2]);
      if (v === null) continue;
      const dev = isNum(cl) && v ? (cl / v - 1) * 100 : null;
      const sp = el("span");
      sp.appendChild(el("span", null, fmtNum(v, 2) + " "));
      sp.appendChild(el("span", sgn(dev), "(" + fmtPctSign(dev, 1) + ")"));
      sp.style.color = col;
      pairs.push([lab, sp]);
    }
    if (pairs.length) { sec(bd, "均线偏离"); bd.appendChild(kvGrid(pairs, true)); }

    const ind = [];
    const dif = d.num(last, ["macd_dif", "dif"]), dea = d.num(last, ["macd_dea", "dea"]), mac = d.num(last, ["macd"]);
    if (dif !== null) ind.push(["MACD DIF", el2(fmtNum(dif, 3), sgn(dif))]);
    if (dea !== null) ind.push(["DEA", el2(fmtNum(dea, 3), sgn(dea))]);
    if (mac !== null) ind.push(["MACD", el2(fmtNum(mac, 3), sgn(mac))]);
    for (const [k, lab] of [["kdj_k", "KDJ K"], ["kdj_d", "KDJ D"], ["kdj_j", "KDJ J"],
    ["rsi_6", "RSI6"], ["rsi_12", "RSI12"], ["rsi_24", "RSI24"], ["cci", "CCI"]]) {
      const v = d.num(last, [k]);
      if (v === null) continue;
      let cls = "";
      if (k.indexOf("rsi") === 0) cls = v >= 70 ? "stk-up" : v <= 30 ? "stk-down" : "";
      if (k === "cci") cls = v >= 100 ? "stk-up" : v <= -100 ? "stk-down" : "";
      ind.push([lab, el2(fmtNum(v, 2), cls)]);
    }
    const bu = d.num(last, ["boll_upper"]), bm = d.num(last, ["boll_mid"]), blo = d.num(last, ["boll_lower"]);
    if (bu !== null) ind.push(["BOLL 上/中/下", fmtNum(bu, 2) + " / " + fmtNum(bm, 2) + " / " + fmtNum(blo, 2)]);
    if (ind.length) { sec(bd, "技术指标"); bd.appendChild(kvGrid(ind, true)); }
    else if (!pairs.length) { bd.appendChild(el("div", "stk-state", "无可识别指标字段")); return; }

    if (clean(close).length > 1) {
      sec(bd, "收盘价 (近 " + clean(close).length + " 日)");
      const cv = canvas(bd, 70);
      defer(p, () => drawLine(cv, close, { height: 70, labels: labs, color: C["ink-2"], area: true, dots: false }));
    }
    flush(p);
  }

  /* ============================================================
     9. 面板定义
     ============================================================ */
  const PANELS = [
    { id: "profile", col: "L", title: "公司概况", kinds: ["stock_basic", "index_members"], render: renderProfile },
    { id: "fin", col: "L", title: "财务摘要", kinds: ["financials"], render: renderFinancials },
    { id: "holders", col: "L", title: "股东结构", kinds: ["holders", "holder_number"], render: renderHolders },
    { id: "margin", col: "L", title: "融资融券", kinds: ["margin"], render: renderMargin },
    { id: "flow", col: "R", title: "资金流向", kinds: ["moneyflow_series"], render: renderFlow },
    { id: "north", col: "R", title: "北向资金", kinds: ["northbound"], render: renderNorth },
    { id: "dragon", col: "R", title: "龙虎榜", kinds: ["dragon_list"], render: renderDragon },
    { id: "chips", col: "R", title: "筹码分布", kinds: ["chips"], render: renderChips },
    { id: "block", col: "R", title: "大宗交易", kinds: ["block"], render: renderBlock },
    { id: "tech", col: "R", title: "技术指标", kinds: ["factors"], render: renderFactors },
  ];

  /* ============================================================
     10. 头部 / 估值条
     ============================================================ */

  function qLast(q) {
    if (!q) return null;
    const v = q.last_price !== undefined ? q.last_price : (q.last !== undefined ? q.last : q.close);
    return isNum(v) ? +v : null;
  }
  function qBase(q) {
    if (!q) return null;
    const v = q.pre_close !== undefined && isNum(q.pre_close) && q.pre_close !== 0 ? q.pre_close
      : (isNum(q.pre) ? q.pre : (isNum(q.pre_settlement) ? q.pre_settlement : null));
    return isNum(v) && v !== 0 ? +v : null;
  }

  function paintHead() {
    if (!els) return;
    const q = curQuote;
    const lp = qLast(q), base = qBase(q);
    const chg = lp !== null && base !== null ? lp - base : null;
    const pct = chg !== null ? (chg / base) * 100 : null;
    const cls = sgn(chg);
    els.last.textContent = lp === null ? DASH : lp.toFixed(2);
    els.last.className = "stk-last " + cls;
    els.chg.textContent = chg === null ? DASH : (chg > 0 ? "+" : "") + chg.toFixed(2);
    els.chg.className = "stk-chg " + cls;
    els.pct.textContent = pct === null ? DASH : fmtPctSign(pct);
    els.pct.className = "stk-pct " + cls;
    if (q && (q.instrument_name || q.name) && els.name.dataset.fromBasic !== "1") {
      els.name.textContent = q.instrument_name || q.name;
    }
    let note = "";
    if (q) {
      const parts = [];
      if (isNum(q.volume)) parts.push("量 " + (typeof opts.fmtVol === "function" ? opts.fmtVol(q.volume) : fmtCount(q.volume)));
      if (isNum(q.amount)) parts.push("额 " + fmtYuan(q.amount));
      if (q.datetime) parts.push(String(q.datetime).slice(0, 19));
      note = parts.join("  ");
    }
    els.hnote.textContent = note;
  }

  function setBasicHead(res) {
    if (!els) return;
    if (!res || !res.ok || !res.data.n) { els.tags.textContent = ""; return; }
    const d = res.data, r = d.rows[0];
    const nm = d.str(r, ["name", "short_name"]);
    if (nm) { els.name.textContent = nm; els.name.dataset.fromBasic = "1"; }
    const tags = [d.str(r, ["industry"]), d.str(r, ["area"]), d.str(r, ["market"])].filter(Boolean);
    els.tags.innerHTML = "";
    for (const t of tags) els.tags.appendChild(el("span", "stk-tag", t));
  }

  const VAL_SPEC = [
    { t: "PE", k: ["pe"], f: (v) => (isNum(v) ? (v < 0 ? "亏损" : v.toFixed(2)) : DASH) },
    { t: "PE(TTM)", k: ["pe_ttm"], f: (v) => (isNum(v) ? (v < 0 ? "亏损" : v.toFixed(2)) : DASH) },
    { t: "PB", k: ["pb"], f: (v) => fmtNum(v, 2) },
    { t: "总市值", k: ["total_mv"], f: (v) => (isNum(v) ? fmtYuan(v * 1e4) : DASH) },
    { t: "流通市值", k: ["circ_mv"], f: (v) => (isNum(v) ? fmtYuan(v * 1e4) : DASH) },
    { t: "换手率", k: ["turnover_rate_f", "turnover_rate"], f: (v) => fmtPct(v) },
    { t: "量比", k: ["volume_ratio"], f: (v) => fmtNum(v, 2) },
    { t: "股息率TTM", k: ["dv_ttm", "dv_ratio"], f: (v) => fmtPct(v) },
  ];

  function paintVal(res) {
    if (!els) return;
    const host = els.val;
    host.innerHTML = ""; host.classList.remove("stk-err");
    if (!res || !res.ok) {
      host.classList.add("stk-err");
      const c = el("div", "stk-vc");
      c.style.gridColumn = "1 / -1";
      c.appendChild(el("div", "stk-vc-k", "估值指标"));
      const v = el("div", "stk-vc-v", "数据获取失败");
      const b = el("button", "stk-retry", "重试");
      b.addEventListener("click", () => loadVal(true));
      v.appendChild(b);
      c.appendChild(v);
      host.appendChild(c);
      return;
    }
    const d = res.data;
    if (!d.n) {
      const c = el("div", "stk-vc"); c.style.gridColumn = "1 / -1";
      c.appendChild(el("div", "stk-vc-v", "无估值数据"));
      host.appendChild(c); return;
    }
    const rows = d.byDate(["trade_date"]);
    const last = rows[rows.length - 1];
    for (const s of VAL_SPEC) {
      const v = d.num(last, s.k);
      const c = el("div", "stk-vc");
      c.appendChild(el("div", "stk-vc-k", s.t));
      c.appendChild(el("div", "stk-vc-v", s.f(v)));
      /* 副行: 与上一日比较 */
      const arr = d.numsOf(rows, s.k);
      if (arr && rows.length > 1) {
        const li = lastIdx(arr);
        let prev = null; for (let i = li - 1; i >= 0; i--) if (isNum(arr[i])) { prev = arr[i]; break; }
        if (prev !== null && prev !== 0 && isNum(arr[li])) {
          const dp = (arr[li] / prev - 1) * 100;
          const sub = el("div", "stk-vc-s " + sgn(dp), arrow(dp) + " " + Math.abs(dp).toFixed(2) + "%");
          c.appendChild(sub);
        }
      }
      host.appendChild(c);
    }
    els.hnote.title = "估值日期 " + dstr(d.str(last, ["trade_date"]));
  }

  function loadVal(force) {
    const code = curCode;
    if (!code) return;
    fetchKind(code, "valuation", force).then((r) => {
      if (!els || curCode !== code) return;
      paintVal(r);
    });
    fetchKind(code, "stock_basic", force).then((r) => {
      if (!els || curCode !== code) return;
      setBasicHead(r);
    });
  }

  /* ============================================================
     11. 生命周期
     ============================================================ */

  function mount(rootEl, options) {
    if (!rootEl) return false;
    opts = options || {};
    injectCSS(); readVars();
    root = rootEl;
    root.id = "stk-root";
    root.classList.add("stk-root");
    root.innerHTML = "";

    /* 头部 */
    const hd = el("div", "stk-hd");
    const idb = el("div", "stk-hd-id");
    const name = el("div", "stk-name", DASH);
    const code = el("div", "stk-code", "");
    const tags = el("div", "stk-tags");
    idb.append(name, code, tags);
    const px = el("div", "stk-hd-px");
    const last = el("div", "stk-last", DASH);
    const chg = el("div", "stk-chg", DASH);
    const pct = el("div", "stk-pct", DASH);
    px.append(last, chg, pct);
    const hnote = el("div", "stk-hd-note");
    hd.append(idb, px, hnote);

    const val = el("div", "stk-val");

    const scroll = el("div", "stk-scroll");
    const grid = el("div", "stk-grid");
    const colL = el("div", "stk-col"), colR = el("div", "stk-col");
    grid.append(colL, colR);
    scroll.appendChild(grid);
    root.append(hd, val, scroll);

    els = { hd, name, code, tags, last, chg, pct, hnote, val, scroll, grid, colL, colR };

    panels = PANELS.map((def) => {
      const p = makePanel(def);
      (def.col === "L" ? colL : colR).appendChild(p.box);
      return p;
    });

    /* 懒加载 */
    setupIO();
    /* 宽度自适应 + 图表重绘 */
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        applyNarrow();
        clearTimeout(roTimer);
        roTimer = setTimeout(redrawAll, 140);
      });
      try { ro.observe(root); } catch (e) { }
    }
    window.addEventListener("resize", onWinResize);
    applyNarrow();
    return true;
  }

  function setupIO() {
    if (io) { try { io.disconnect(); } catch (e) { } io = null; }
    if (!window.IntersectionObserver || !els) return;
    io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        if (!e.isIntersecting) continue;
        const p = panels.find((x) => x.box === e.target);
        if (!p || p.loaded) continue;
        io.unobserve(e.target);
        load(p, false);
      }
    }, { root: els.scroll, rootMargin: "220px 0px", threshold: 0 });
  }

  function observeAll() {
    if (!io) {
      /* 没有 IO 支持: 直接全量加载 */
      for (const p of panels) if (!p.loaded) load(p, false);
      return;
    }
    for (const p of panels) { p.loaded = false; try { io.observe(p.box); } catch (e) { } }
  }

  function applyNarrow() {
    if (!root) return;
    const w = root.clientWidth || 0;
    root.classList.toggle("stk-narrow", w > 0 && w < 900);
  }
  function onWinResize() { applyNarrow(); clearTimeout(roTimer); roTimer = setTimeout(redrawAll, 160); }
  function redrawAll() {
    if (!els) return;
    readVars();
    for (const p of panels) if (p.results && p.bd.querySelector("canvas")) renderPanel(p);
  }

  function show(tsCode, quote) {
    if (!els) return false;
    const code = normCode(tsCode);
    if (!code) return false;
    if (quote !== undefined) curQuote = quote;
    if (code === curCode) { paintHead(); return true; }
    curCode = code;
    els.code.textContent = code;
    els.name.textContent = (quote && (quote.instrument_name || quote.name)) || DASH;
    els.name.dataset.fromBasic = "";
    els.tags.innerHTML = "";
    els.val.innerHTML = "";
    els.val.classList.remove("stk-err");
    for (let i = 0; i < 8; i++) {
      const c = el("div", "stk-vc");
      c.appendChild(el("div", "stk-vc-k", VAL_SPEC[i] ? VAL_SPEC[i].t : ""));
      c.appendChild(el("div", "stk-vc-v", DASH));
      els.val.appendChild(c);
    }
    for (const p of panels) { p.results = null; p._draw = []; p.setState("idle"); }
    els.scroll.scrollTop = 0;
    paintHead();
    loadVal(false);
    observeAll();
    return true;
  }

  function updateQuote(quote) {
    if (!els) return;
    if (quote) curQuote = quote;
    paintHead();
  }

  function destroy() {
    if (io) { try { io.disconnect(); } catch (e) { } io = null; }
    if (ro) { try { ro.disconnect(); } catch (e) { } ro = null; }
    clearTimeout(roTimer); roTimer = null;
    window.removeEventListener("resize", onWinResize);
    if (root) { root.innerHTML = ""; root.classList.remove("stk-root"); }
    root = null; els = null; panels = []; curQuote = null; curCode = null;
  }

  function isMounted() { return !!els; }

  return { mount, show, updateQuote, destroy, isMounted };
})();
