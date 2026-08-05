/* 主力合约看板 — 独立模块, 只暴露 window.Board
   数据来源: {"type":"board_meta","items":[...]} + {"type":"data","board":{sym:{lp,pre,oi,vol,b,a,u}}}
   纯原生 JS, 样式动态注入, 不依赖 app.js / style.css 的任何类名 */
"use strict";

window.Board = (function () {

  /* ================= 常量表 ================= */

  const EX_ORDER = ["SHFE", "INE", "DCE", "CZCE", "CFFEX", "GFEX"];
  const EX_LABEL = {
    SHFE: "上期所", INE: "能源中心", DCE: "大商所",
    CZCE: "郑商所", CFFEX: "中金所", GFEX: "广期所",
  };

  /* 底部板块 chips。cats 为该 chip 覆盖的 categories id */
  const SECTORS = [
    { id: "ALL", label: "全部" },
    { id: "__DAY", label: "日盘" },
    { id: "__NIGHT", label: "夜盘" },
    { id: "PRECIOUS", label: "贵金属", cats: ["PRECIOUS_METALS"] },
    { id: "NONFERROUS", label: "有色金属", cats: ["NONFERROUS_METALS"] },
    { id: "BLACK", label: "黑色", cats: ["FERROUS", "COAL"] },
    { id: "CHEM", label: "能源化工", cats: ["CHEMICAL", "OIL"] },
    { id: "AGRI", label: "农产品", cats: ["GRAIN", "GREASE", "AGRICULTURAL", "SOFT_COMMODITY", "LIGHT_INDUSTRY"] },
    { id: "FIN", label: "金融", cats: ["EQUITY_INDEX", "TREASURY_BOND"] },
    { id: "OTHER", label: "其他", cats: [] },   // cats 为空 / 未知分类
  ];
  const CAT2SECTOR = (() => {
    const m = {};
    for (const s of SECTORS) if (s.cats) for (const c of s.cats) m[c] = s.id;
    return m;
  })();

  /* 列定义: k 排序键, label 表头, num 是否数字列 */
  const COLS = [
    { k: "name", label: "名称", num: false },
    { k: "lp", label: "最新价", num: true },
    { k: "chg", label: "涨跌", num: true },
    { k: "pct", label: "涨跌幅", num: true },
    { k: "oi", label: "持仓量", num: true },
    { k: "vol", label: "成交量", num: true },
    { k: "b", label: "买一", num: true },
    { k: "a", label: "卖一", num: true },
  ];

  /* ================= 模块状态 ================= */

  let root = null;            // 挂载根
  let opts = {};
  let els = null;             // {tabs, chips, tbody, thead, count, empty}
  let metaList = [];          // [{s,u,n,ex,cats,catNames,night,secs:Set}]
  let rows = new Map();       // sym -> {item, tr, cells{}, d(最近一次board数据), digits, lastLp}
  let pendingBoard = null;    // meta 未到时缓存的 board 数据
  let curEx = "ALL";
  let curSec = "ALL";
  let sortKey = null;         // null = 默认序(交易所+品种)
  let sortDir = -1;           // -1 降序 / 1 升序
  let curOrder = "";          // 上次 DOM 排列指纹, 避免无谓重排
  let activeSym = null;

  /* ================= 工具 ================= */

  const isNum = (v) => v !== null && v !== undefined && isFinite(v);
  const DASH = "—";

  function fmtVol(n) {
    if (typeof opts.fmtVol === "function") return opts.fmtVol(n);
    if (!isNum(n)) return DASH;
    return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿"
      : n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(n);
  }

  /* 小数位: 优先 price_tick(tk), 否则由已见过的价格取最大小数位(单调, 避免跳动) */
  function digitsOfTick(tk) {
    if (!isNum(tk) || tk <= 0) return null;
    const s = String(Number(tk.toPrecision(12)));
    if (s.includes("e") || s.includes("E")) return 6;
    return s.includes(".") ? s.split(".")[1].replace(/0+$/, "").length : 0;
  }
  function decOf(v) {
    if (!isNum(v)) return 0;
    const s = String(Number(v.toPrecision(12)));
    if (s.includes("e") || s.includes("E")) return 4;
    return s.includes(".") ? Math.min(4, s.split(".")[1].length) : 0;
  }
  /* 只从 lp/b/a 学小数位: 它们必然对齐 price_tick;
     pre(昨结算) 可能带额外小数, 会把整个品种的显示位数带偏 */
  function refreshDigits(r, d) {
    if (r.tickDigits !== null && r.tickDigits !== undefined) { r.digits = r.tickDigits; return; }
    let m = r.digits || 0;
    for (const k of ["lp", "b", "a"]) {
      const v = d[k];
      if (isNum(v) && v !== 0) m = Math.max(m, decOf(v));
    }
    r.digits = Math.min(m, 4);
  }
  function fmtPx(v, digits) { return isNum(v) ? v.toFixed(digits) : DASH; }
  function sgnCls(v) { return !isNum(v) || v === 0 ? "bd-flat" : v > 0 ? "bd-up" : "bd-down"; }

  /* ================= 样式 ================= */

  const CSS = `
#bd-root { display:flex; flex-direction:column; height:100%; min-height:0;
  background:var(--page,#0d0d0d); color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC",sans-serif; }

/* 顶部交易所 tab 条 */
.bd-tabs { flex:0 0 auto; display:flex; align-items:center; gap:2px;
  padding:0 10px; background:var(--surface,#1a1a19);
  border-bottom:1px solid var(--border,rgba(255,255,255,.10)); overflow-x:auto; }
.bd-tab { background:none; border:none; font:inherit; cursor:pointer; white-space:nowrap;
  color:var(--muted,#898781); padding:9px 12px 8px; border-bottom:2px solid transparent; }
.bd-tab:hover { color:var(--ink-2,#c3c2b7); }
.bd-tab.on { color:var(--ink,#fff); font-weight:600; border-bottom-color:var(--ma5,#3987e5); }
.bd-count { margin-left:auto; padding-left:14px; color:var(--muted,#898781);
  font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }

/* 表格 */
.bd-scroll { flex:1 1 auto; min-height:0; overflow:auto; }
.bd-table { width:100%; border-collapse:separate; border-spacing:0;
  font-variant-numeric:tabular-nums; }
.bd-table th { position:sticky; top:0; z-index:2; background:var(--surface,#1a1a19);
  color:var(--muted,#898781); font-weight:400; font-size:11px; letter-spacing:.04em;
  text-align:right; padding:7px 10px; white-space:nowrap; cursor:pointer; user-select:none;
  border-bottom:1px solid var(--border,rgba(255,255,255,.10)); }
.bd-table th:first-child { text-align:left; padding-left:12px; }
.bd-table th:nth-child(1) { width:21%; }
.bd-table th:nth-child(2) { width:13%; }
.bd-table th:nth-child(3),
.bd-table th:nth-child(4) { width:11%; }
.bd-table th:nth-child(5),
.bd-table th:nth-child(6),
.bd-table th:nth-child(7),
.bd-table th:nth-child(8) { width:11%; }
.bd-table th:hover { color:var(--ink-2,#c3c2b7); }
.bd-table th.on { color:var(--ink,#fff); }
.bd-arrow { display:inline-block; margin-left:3px; width:8px; color:var(--ma5,#3987e5); }

.bd-row { cursor:pointer; }
.bd-row > td { padding:4px 10px; text-align:right; white-space:nowrap;
  border-bottom:1px solid var(--grid,#2c2c2a); }
.bd-row:hover > td { background:var(--surface-2,#222221); }
.bd-row.bd-sel > td { background:var(--surface-2,#222221);
  box-shadow:inset 2px 0 0 var(--ma5,#3987e5); }
.bd-c-name { text-align:left !important; padding-left:12px !important; }
.bd-n1 { color:var(--ink,#fff); font-weight:600; font-size:13px; }
.bd-n2 { color:var(--muted,#898781); font-size:10.5px; margin-top:1px; }
.bd-lp { font-size:14px; font-weight:600; }
.bd-dim { color:var(--muted,#898781); }
.bd-up { color:var(--up,#e66767); }
.bd-down { color:var(--down,#199e70); }
.bd-flat { color:var(--ink-2,#c3c2b7); }
.bd-night { display:inline-block; margin-left:5px; font-size:9px; line-height:1;
  padding:1px 3px; border-radius:2px; color:var(--muted,#898781);
  border:1px solid var(--grid,#2c2c2a); vertical-align:1px; font-weight:400; }

/* 价格跳动闪烁 (自有类名, 不与 app.js 的 f-up/f-down 冲突) */
@keyframes bd-flash-up   { from { background:rgba(230,103,103,.26); } to { background:transparent; } }
@keyframes bd-flash-down { from { background:rgba(25,158,112,.30); } to { background:transparent; } }
.bd-row.bd-f-up   > td { animation:bd-flash-up .55s ease-out; }
.bd-row.bd-f-down > td { animation:bd-flash-down .55s ease-out; }

.bd-empty { padding:26px; text-align:center; color:var(--muted,#898781); font-size:12px; }

/* 底部板块 chips */
.bd-chips { flex:0 0 auto; display:flex; flex-wrap:wrap; gap:6px; padding:8px 12px;
  background:var(--surface,#1a1a19);
  border-top:1px solid var(--border,rgba(255,255,255,.10)); }
.bd-chip { background:var(--surface-2,#222221); color:var(--muted,#898781);
  border:1px solid var(--border,rgba(255,255,255,.10)); border-radius:12px;
  padding:3px 11px; font:12px/1.4 inherit; cursor:pointer; white-space:nowrap; }
.bd-chip:hover { color:var(--ink-2,#c3c2b7); border-color:var(--muted,#898781); }
.bd-chip.on { color:var(--ink,#fff); background:var(--ma5,#3987e5); border-color:var(--ma5,#3987e5); }
.bd-scroll::-webkit-scrollbar { width:8px; height:8px; }
.bd-scroll::-webkit-scrollbar-thumb { background:var(--grid,#2c2c2a); border-radius:4px; }
`;

  function injectCSS() {
    if (document.getElementById("bd-style")) return;
    const st = document.createElement("style");
    st.id = "bd-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ================= 骨架 ================= */

  function mount(rootEl, options) {
    if (!rootEl) return;
    opts = options || {};
    injectCSS();
    root = rootEl;
    root.id = "bd-root";
    root.innerHTML = "";

    const tabs = document.createElement("div");
    tabs.className = "bd-tabs";
    const count = document.createElement("span");
    count.className = "bd-count";

    const scroll = document.createElement("div");
    scroll.className = "bd-scroll";
    const table = document.createElement("table");
    table.className = "bd-table";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const c of COLS) {
      const th = document.createElement("th");
      th.dataset.k = c.k;
      const lab = document.createElement("span");
      lab.textContent = c.label;
      const ar = document.createElement("span");
      ar.className = "bd-arrow";
      th.append(lab, ar);
      th.addEventListener("click", () => onSortClick(c.k));
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    const empty = document.createElement("div");
    empty.className = "bd-empty";
    empty.textContent = "等待看板数据…";
    scroll.append(table, empty);

    const chips = document.createElement("div");
    chips.className = "bd-chips";
    for (const s of SECTORS) {
      const b = document.createElement("button");
      b.className = "bd-chip" + (s.id === curSec ? " on" : "");
      b.textContent = s.label;
      b.dataset.id = s.id;
      b.addEventListener("click", () => { curSec = s.id; syncChips(); applyFilter(); });
      chips.appendChild(b);
    }

    root.append(tabs, scroll, chips);
    els = { tabs, chips, thead, tbody, count, empty, scroll };
    buildTabs();
    syncHeader();
    if (metaList.length) setMeta(metaList);
    return true;
  }

  function isMounted() { return !!els; }

  function buildTabs() {
    if (!els) return;
    const present = new Set(metaList.map((m) => m.ex).filter(Boolean));
    const list = ["ALL"].concat(EX_ORDER.filter((e) => !metaList.length || present.has(e)));
    for (const e of present) if (!list.includes(e)) list.push(e);
    els.tabs.innerHTML = "";
    for (const id of list) {
      const b = document.createElement("button");
      b.className = "bd-tab" + (id === curEx ? " on" : "");
      b.dataset.id = id;
      b.textContent = id === "ALL" ? "全部" : (EX_LABEL[id] || id);
      b.addEventListener("click", () => {
        curEx = id;
        for (const t of els.tabs.querySelectorAll(".bd-tab")) t.classList.toggle("on", t.dataset.id === id);
        applyFilter();
      });
      els.tabs.appendChild(b);
    }
    els.tabs.appendChild(els.count);
  }
  function syncChips() {
    for (const c of els.chips.querySelectorAll(".bd-chip")) c.classList.toggle("on", c.dataset.id === curSec);
  }

  /* ================= meta ================= */

  function setMeta(items) {
    metaList = (items || []).map((it) => {
      const secs = new Set();
      const cats = it.cats || [];
      for (const c of cats) if (CAT2SECTOR[c]) secs.add(CAT2SECTOR[c]);
      if (!secs.size) secs.add("OTHER");
      return {
        s: it.s, u: it.u || "", n: it.n || it.s,
        ex: it.ex || (it.u ? String(it.u).split(".")[0] : ""),
        cats, catNames: it.catNames || [], night: !!it.night, tk: it.tk, secs,
      };
    });
    if (!els) return;
    buildTabs();
    buildRows();
    if (pendingBoard) { const p = pendingBoard; pendingBoard = null; update(p); }
    else applyFilter();
  }

  function buildRows() {
    els.tbody.innerHTML = "";
    rows = new Map();
    for (const item of metaList) {
      const tr = document.createElement("tr");
      tr.className = "bd-row";
      tr.dataset.sym = item.s;
      const cells = {};

      const tdName = document.createElement("td");
      tdName.className = "bd-c-name";
      const n1 = document.createElement("div");
      n1.className = "bd-n1";
      n1.textContent = item.n;
      if (item.night) {
        const nb = document.createElement("span");
        nb.className = "bd-night";
        nb.textContent = "夜";
        n1.appendChild(nb);
      }
      const n2 = document.createElement("div");
      n2.className = "bd-n2";
      n2.textContent = item.u || item.s;
      tdName.append(n1, n2);
      cells.sub = n2;
      tr.appendChild(tdName);

      for (const c of COLS.slice(1)) {
        const td = document.createElement("td");
        td.textContent = DASH;
        if (c.k === "lp") td.className = "bd-lp";
        if (c.k === "oi" || c.k === "vol") td.className = "bd-dim";
        cells[c.k] = td;
        tr.appendChild(td);
      }

      tr.addEventListener("click", () => {
        activeSym = item.s;
        for (const r of rows.values()) r.tr.classList.toggle("bd-sel", r.item.s === activeSym);
        if (typeof opts.onPick === "function") opts.onPick(item.s, item);
      });

      rows.set(item.s, {
        item, tr, cells, d: null,
        digits: 0, tickDigits: digitsOfTick(item.tk), lastLp: null,
      });
      els.tbody.appendChild(tr);
    }
    curOrder = "";
    els.empty.style.display = metaList.length ? "none" : "";
    if (!metaList.length) els.empty.textContent = "等待看板数据…";
  }

  /* ================= 数据更新 ================= */

  function update(boardData) {
    if (!boardData) return;
    if (!els || !rows.size) { pendingBoard = boardData; return; }
    const flashUp = [], flashDown = [];

    for (const sym in boardData) {
      const r = rows.get(sym);
      if (!r) continue;
      const d = boardData[sym] || {};
      r.d = d;
      refreshDigits(r, d);
      const dg = r.digits;

      if (d.u && d.u !== r.cells.sub.textContent) r.cells.sub.textContent = d.u;

      const lp = isNum(d.lp) ? d.lp : null;
      const pre = isNum(d.pre) && d.pre !== 0 ? d.pre : null;
      const chg = lp !== null && pre !== null ? lp - pre : null;
      const pct = chg !== null ? (chg / pre) * 100 : null;
      const cls = sgnCls(chg);

      setCell(r.cells.lp, fmtPx(lp, dg), "bd-lp " + cls);
      setCell(r.cells.chg, chg === null ? DASH : (chg > 0 ? "+" : "") + chg.toFixed(dg), cls);
      setCell(r.cells.pct, pct === null ? DASH : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%", cls);
      setCell(r.cells.oi, fmtVol(d.oi), "bd-dim");
      setCell(r.cells.vol, fmtVol(d.vol), "bd-dim");
      setCell(r.cells.b, fmtPx(isNum(d.b) ? d.b : null, dg),
        pre === null || !isNum(d.b) ? "bd-flat" : sgnCls(d.b - pre));
      setCell(r.cells.a, fmtPx(isNum(d.a) ? d.a : null, dg),
        pre === null || !isNum(d.a) ? "bd-flat" : sgnCls(d.a - pre));

      if (lp !== null && r.lastLp !== null && lp !== r.lastLp) {
        (lp > r.lastLp ? flashUp : flashDown).push(r.tr);
      }
      if (lp !== null) r.lastLp = lp;
    }

    // 批量重启闪烁动画: 先统一去类, 触发一次 reflow, 再统一加类
    if (flashUp.length || flashDown.length) {
      for (const tr of flashUp) tr.classList.remove("bd-f-up", "bd-f-down");
      for (const tr of flashDown) tr.classList.remove("bd-f-up", "bd-f-down");
      void els.tbody.offsetWidth;
      for (const tr of flashUp) tr.classList.add("bd-f-up");
      for (const tr of flashDown) tr.classList.add("bd-f-down");
    }
    applyFilter();
  }

  function setCell(td, text, cls) {
    if (td.textContent !== text) td.textContent = text;
    if (td.className !== cls) td.className = cls;
  }

  /* ================= 筛选 + 排序 ================= */

  function matches(item) {
    if (curEx !== "ALL" && item.ex !== curEx) return false;
    if (curSec === "ALL") return true;
    if (curSec === "__DAY") return !item.night;
    if (curSec === "__NIGHT") return item.night;
    return item.secs.has(curSec);
  }

  function sortVal(r, k) {
    const d = r.d || {};
    switch (k) {
      case "lp": return isNum(d.lp) ? d.lp : NaN;
      case "b": return isNum(d.b) ? d.b : NaN;
      case "a": return isNum(d.a) ? d.a : NaN;
      case "oi": return isNum(d.oi) ? d.oi : NaN;
      case "vol": return isNum(d.vol) ? d.vol : NaN;
      case "chg": return isNum(d.lp) && isNum(d.pre) ? d.lp - d.pre : NaN;
      case "pct": return isNum(d.lp) && isNum(d.pre) && d.pre !== 0 ? (d.lp - d.pre) / d.pre : NaN;
      default: return NaN;
    }
  }
  function defaultRank(r) {
    const i = EX_ORDER.indexOf(r.item.ex);
    return (i < 0 ? EX_ORDER.length : i);
  }

  function applyFilter() {
    if (!els) return;
    const all = [...rows.values()];
    let shown = 0;
    for (const r of all) {
      const ok = matches(r.item);
      r.vis = ok;
      r.tr.style.display = ok ? "" : "none";
      if (ok) shown++;
    }
    els.count.textContent = shown + " / " + all.length + " 个品种";
    els.empty.style.display = shown ? "none" : "";
    if (!shown) els.empty.textContent = all.length ? "该筛选下没有品种" : "等待看板数据…";

    // 排序
    const list = all.slice();
    if (sortKey === null) {
      list.sort((x, y) => defaultRank(x) - defaultRank(y)
        || String(x.item.s).localeCompare(String(y.item.s)));
    } else if (sortKey === "name") {
      list.sort((x, y) => sortDir * String(x.item.n).localeCompare(String(y.item.n), "zh"));
    } else {
      list.sort((x, y) => {
        const a = sortVal(x, sortKey), b = sortVal(y, sortKey);
        const na = isNaN(a), nb = isNaN(b);
        if (na && nb) return 0;
        if (na) return 1;               // 缺数据永远沉底
        if (nb) return -1;
        if (a === b) return String(x.item.s).localeCompare(String(y.item.s));
        return sortDir * (a < b ? -1 : 1);
      });
    }
    const fp = list.map((r) => r.item.s).join(",");
    if (fp !== curOrder) {
      curOrder = fp;
      for (const r of list) els.tbody.appendChild(r.tr);   // appendChild 即移动
    }
  }

  /* 点击列头: 第1次主方向(数字列降序/名称列升序), 第2次反向, 第3次回到默认序 */
  function onSortClick(k) {
    const first = k === "name" ? 1 : -1;
    if (sortKey !== k) { sortKey = k; sortDir = first; }
    else if (sortDir === first) sortDir = -first;
    else { sortKey = null; sortDir = -1; }
    syncHeader();
    curOrder = "";
    applyFilter();
  }
  function syncHeader() {
    for (const th of els.thead.querySelectorAll("th")) {
      const on = th.dataset.k === sortKey;
      th.classList.toggle("on", on);
      th.querySelector(".bd-arrow").textContent = on ? (sortDir === -1 ? "▼" : "▲") : "";
    }
  }

  return { mount, setMeta, update, isMounted };
})();
