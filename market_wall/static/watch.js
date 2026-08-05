/* 首页 · 自选分区看板
 * 每个分区是一块可配置的面板, 形态可选:
 *   card     报价卡(默认)
 *   list     行情列表/看板 — 多列, 可点列头排序
 *   multi    迷你多图 — 每标的一张小图, 分时(canvas 自绘) 或 K线(lightweight-charts)
 *   heat     热力块 — 按涨跌幅着色
 *   research 个股研究摘要 — 绑定一只股票, 估值/资金流/财务摘要
 * 自包含: IIFE + 注入样式, 只暴露 window.WatchBoard
 */
window.WatchBoard = (function () {
  "use strict";

  const STYLE_ID = "wb-style";
  const TZ = 8 * 3600;
  const CHART_BUDGET = 12;   // 服务端 FOCUS_MAX=16, 给主图/叠加留余量
  const CSS = `
#wb-root{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:10px 14px 30px;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#wb-root *{box-sizing:border-box}
.wb-bar{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.wb-bar .sp{flex:1 1 auto}
.wb-btn{background:var(--surface-2,#222221);color:var(--ink-2,#c3c2b7);
  border:1px solid var(--border,rgba(255,255,255,.1));border-radius:6px;
  padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.wb-btn:hover{color:var(--ink,#fff);border-color:var(--muted,#898781)}
.wb-btn.on{color:var(--ink,#fff);border-color:var(--ma5,#3987e5)}
.wb-sec{margin-bottom:14px;border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;background:var(--surface,#1a1a19);overflow:hidden}
.wb-sec.drop{border-color:var(--ma5,#3987e5);box-shadow:0 0 0 1px var(--ma5,#3987e5) inset}
.wb-h{display:flex;align-items:center;gap:8px;padding:6px 12px;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
.wb-h .ttl{display:flex;align-items:center;gap:7px;cursor:pointer}
.wb-h b{color:var(--ink,#fff);font-size:13px}
.wb-h .cnt{color:var(--muted,#898781);font-size:11px}
.wb-h .caret{color:var(--muted,#898781);font-size:10px;transition:transform .12s}
.wb-sec.fold .caret{transform:rotate(-90deg)}
.wb-sec.fold .wb-body{display:none}
.wb-h .sp{flex:1 1 auto}
.wb-h .act{color:var(--muted,#898781);font-size:11px;padding:1px 8px;border-radius:4px;
  border:1px solid transparent;cursor:pointer;white-space:nowrap}
.wb-h .act:hover{color:var(--ink,#fff);border-color:var(--border,rgba(255,255,255,.1))}
.wb-seg{display:flex;gap:1px;background:var(--surface-2,#222221);border-radius:5px;padding:1px}
.wb-seg button{background:transparent;border:none;color:var(--muted,#898781);font-size:11px;
  padding:2px 8px;border-radius:4px;cursor:pointer;font-family:inherit;white-space:nowrap}
.wb-seg button:hover{color:var(--ink-2,#c3c2b7)}
.wb-seg button.on{background:var(--surface,#1a1a19);color:var(--ink,#fff)}
.wb-cfg{display:flex;align-items:center;gap:8px;padding:5px 12px;flex-wrap:wrap;
  background:var(--surface-2,#222221);border-bottom:1px solid var(--border,rgba(255,255,255,.1));
  font-size:11.5px;color:var(--muted,#898781)}
.wb-cfg.hidden{display:none}
.wb-cfg select,.wb-cfg input{background:var(--surface,#1a1a19);color:var(--ink,#fff);
  border:1px solid var(--border,rgba(255,255,255,.1));border-radius:4px;padding:1px 5px;
  font-size:11.5px;font-family:inherit}
.wb-note{padding:3px 12px;font-size:11px;color:var(--muted,#898781);
  background:rgba(217,89,38,.12);border-bottom:1px solid var(--border,rgba(255,255,255,.1))}

/* --- 卡片 --- */
.wb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:6px;padding:8px}
.wb-card{background:var(--surface-2,#222221);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:6px;padding:6px 9px;cursor:pointer;position:relative;
  transition:border-color .1s,background .18s}
.wb-card:hover{border-color:var(--muted,#898781)}
.wb-card.sel{border-color:var(--ma5,#3987e5)}
.wb-card.dragging{opacity:.4}
.wb-card .r1{display:flex;align-items:baseline;gap:6px}
.wb-card .nm{color:var(--ink,#fff);font-weight:600;font-size:12.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-card .cd{color:var(--muted,#898781);font-size:10px;margin-left:auto;flex:0 0 auto}
.wb-card .r2{display:flex;align-items:baseline;gap:8px;margin-top:1px}
.wb-card .px{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.wb-card .pc{font-size:11.5px;font-variant-numeric:tabular-nums;margin-left:auto}
.wb-card .r3{color:var(--muted,#898781);font-size:10.5px;font-variant-numeric:tabular-nums;
  margin-top:2px;display:flex;justify-content:space-between}
.wb-card .rm{position:absolute;top:2px;right:4px;color:var(--muted,#898781);font-size:11px;
  display:none;padding:0 3px}
.wb-card:hover .rm{display:block}
.wb-card .rm:hover{color:var(--up,#e66767)}
.wb-card.f-up{background:rgba(230,103,103,.16)}
.wb-card.f-down{background:rgba(25,158,112,.16)}

/* --- 列表 --- */
table.wb-t{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
table.wb-t th{color:var(--muted,#898781);font-weight:400;font-size:11px;text-align:right;
  padding:4px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));
  cursor:pointer;white-space:nowrap;user-select:none}
table.wb-t th:hover{color:var(--ink-2,#c3c2b7)}
table.wb-t th.s{color:var(--ink,#fff)}
table.wb-t th:first-child,table.wb-t td:first-child{text-align:left}
table.wb-t td{padding:3px 8px;text-align:right;border-bottom:1px solid var(--grid,#2c2c2a);white-space:nowrap}
table.wb-t tbody tr{cursor:pointer}
table.wb-t tbody tr:hover td{background:var(--surface-2,#222221)}
table.wb-t tbody tr.sel td{background:rgba(57,135,229,.13)}
table.wb-t .nm{color:var(--ink,#fff);font-weight:500}
table.wb-t .cd{color:var(--muted,#898781);font-size:10.5px;margin-left:5px}

/* --- 热力 --- */
.wb-heat{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:4px;padding:8px}
.wb-tile{border-radius:5px;padding:7px 9px;cursor:pointer;border:1px solid transparent;overflow:hidden}
.wb-tile:hover{border-color:var(--ink-2,#c3c2b7)}
.wb-tile .tn{color:#fff;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-tile .tp{color:#fff;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.wb-tile .tc{color:rgba(255,255,255,.85);font-size:10.5px;font-variant-numeric:tabular-nums}

/* --- 多图 --- */
.wb-mg{display:grid;gap:6px;padding:8px}
.wb-cell{background:var(--surface-2,#222221);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:6px;overflow:hidden;display:flex;flex-direction:column;height:168px}
.wb-cell:hover{border-color:var(--muted,#898781)}
.wb-ch{display:flex;align-items:baseline;gap:6px;padding:3px 8px;flex:0 0 auto;cursor:pointer}
.wb-ch .nm{color:var(--ink,#fff);font-size:11.5px;font-weight:600;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-ch .px{font-size:11.5px;font-variant-numeric:tabular-nums;margin-left:auto}
.wb-ch .pc{font-size:11px;font-variant-numeric:tabular-nums}
.wb-cb{flex:1 1 auto;min-height:0;position:relative}
.wb-cb canvas{display:block;width:100%;height:100%}
.wb-tip{position:absolute;top:2px;left:6px;font-size:10.5px;color:var(--ink-2,#c3c2b7);
  font-variant-numeric:tabular-nums;pointer-events:none;background:rgba(0,0,0,.55);
  padding:0 4px;border-radius:3px;display:none}

/* --- 研究摘要 --- */
.wb-rs{padding:8px 12px 12px}
.wb-rs-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.wb-rs-hd b{color:var(--ink,#fff);font-size:15px}
.wb-rs-hd .cd{color:var(--muted,#898781);font-size:11px}
.wb-rs-hd .px{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.wb-rs-g{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:5px}
.wb-rs-i{background:var(--surface-2,#222221);border-radius:5px;padding:5px 8px}
.wb-rs-i .k{color:var(--muted,#898781);font-size:10.5px}
.wb-rs-i .v{color:var(--ink,#fff);font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.wb-rs-sub{color:var(--muted,#898781);font-size:11px;margin:10px 0 5px}

.wb-up{color:var(--up,#e66767)}.wb-down{color:var(--down,#199e70)}.wb-flat{color:var(--ink-2,#c3c2b7)}
.wb-empty{padding:16px 12px;color:var(--muted,#898781);font-size:12px;text-align:center}
`;

  let host = null, root = null, opts = {};
  let groups = [], quotes = {}, klines = {}, selected = null, filter = "all";
  let dragSym = null, dragFrom = null, raf = 0;
  let secs = {};        // gid -> {el, cfg, cells:[], sortKey, sortDir}
  let cfgs = {};        // gid -> 持久化配置

  try { cfgs = JSON.parse(localStorage.getItem("mw:wbsec") || "{}"); } catch (e) { cfgs = {}; }
  try { filter = localStorage.getItem("mw:wbfilter") || "all"; } catch (e) { filter = "all"; }

  const DEF_CFG = { type: "card", chart: "ts", dur: 60, cols: 4, stock: "", fold: false };
  function cfgOf(gid) {
    if (!cfgs[gid]) cfgs[gid] = Object.assign({}, DEF_CFG);
    else for (const k in DEF_CFG) if (cfgs[gid][k] === undefined) cfgs[gid][k] = DEF_CFG[k];
    return cfgs[gid];
  }
  function saveCfg() { try { localStorage.setItem("mw:wbsec", JSON.stringify(cfgs)); } catch (e) { /* 忽略 */ } }

  const SEC_TYPES = [["card", "卡片"], ["list", "列表"], ["multi", "多图"], ["heat", "热力"], ["research", "研究"]];
  const DURS = [[60, "1m"], [300, "5m"], [900, "15m"], [3600, "1h"], [86400, "日K"]];

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const cls = (v) => (v > 0 ? "wb-up" : v < 0 ? "wb-down" : "wb-flat");
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  function cssVar(n, d) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || d;
  }
  function heatColor(p) {
    if (p == null) return "rgba(255,255,255,.04)";
    const t = Math.max(-1, Math.min(1, p / 3)), a = Math.abs(t);
    if (a < 0.02) return "rgba(255,255,255,.05)";
    const [r, g, b] = t > 0 ? [230, 103, 103] : [25, 158, 112];
    return `rgba(${r},${g},${b},${(0.14 + 0.72 * a).toFixed(3)})`;
  }
  const fmtNum = (v) => (num(v) == null ? "—" : num(v).toFixed(2));
  function amt(v) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    return a >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : a >= 1e4 ? (n / 1e4).toFixed(0) + "万" : n.toFixed(0);
  }

  const FILTERS = [["all", "全部"], ["fut", "期货"], ["stk", "A股"]];
  function pass(sym) { return filter === "all" || opts.marketOf(sym) === filter; }
  function symsOf(g) { return g.symbols.filter(pass); }
  function pctOf(sym) {
    const q = quotes[sym];
    if (!q) return null;
    const base = opts.baseline(q);
    return (q.last_price != null && base) ? (q.last_price - base) / base * 100 : null;
  }

  /* ============================ 卡片 ============================ */
  function cardEl(sym, gid) {
    const c = el("div", "wb-card");
    c.dataset.sym = sym; c.dataset.gid = gid;
    c.draggable = true;
    c.innerHTML = '<span class="rm" title="移出本区">✕</span>' +
      '<div class="r1"><span class="nm"></span><span class="cd"></span></div>' +
      '<div class="r2"><span class="px wb-flat">—</span><span class="pc wb-flat">—</span></div>' +
      '<div class="r3"><span class="ba">—</span><span class="vo">—</span></div>';
    paintCard(c, sym, true);
    c.onclick = (e) => {
      if (e.target.classList.contains("rm")) { e.stopPropagation(); opts.onRemove(sym, gid); }
      else opts.onPick(sym);
    };
    c.oncontextmenu = (e) => { e.preventDefault(); opts.onMenu(e, sym, gid); };
    wireDrag(c, sym, gid);
    return c;
  }
  function paintCard(c, sym, force) {
    const q = quotes[sym];
    if (!q) return;
    const base = opts.baseline(q);
    const chg = q.last_price != null && base ? q.last_price - base : null;
    const pct = chg != null && base ? (chg / base) * 100 : null;
    c.querySelector(".nm").textContent = q.instrument_name || sym;
    c.querySelector(".cd").textContent = sym.replace(/^KQ\.\w+@/, "");
    const px = c.querySelector(".px");
    const prev = px.textContent;
    px.textContent = opts.fmtQ(q.last_price, q);
    px.className = "px " + cls(chg);
    const pc = c.querySelector(".pc");
    pc.textContent = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
    pc.className = "pc " + cls(chg);
    c.querySelector(".ba").textContent = `${opts.fmtQ(q.bid_price1, q)} / ${opts.fmtQ(q.ask_price1, q)}`;
    c.querySelector(".vo").textContent = opts.isStock(q)
      ? `量${opts.fmtVol(q.volume)}`
      : `量${opts.fmtVol(q.volume)} 仓${opts.fmtVol(q.open_interest)}`;
    c.classList.toggle("sel", sym === selected);
    // 闪色方向必须比数值。之前比的是格式化后的字符串, "9.5" > "10.2" 会判反,
    // 价格跨十进位时闪色方向刚好相反。
    if (!force && prev !== px.textContent && prev !== "—") {
      const a = parseFloat(String(prev).replace(/,/g, "")), b = num(q.last_price);
      if (isFinite(a) && b != null && a !== b) {
        c.classList.remove("f-up", "f-down");
        void c.offsetWidth;
        c.classList.add(b > a ? "f-up" : "f-down");
      }
    }
  }

  /* ============================ 列表 ============================ */
  const COLS = [
    ["nm", "名称", (s) => (quotes[s] && quotes[s].instrument_name) || s],
    ["last", "最新", (s) => (quotes[s] ? quotes[s].last_price : null)],
    ["chg", "涨跌", (s) => { const q = quotes[s]; if (!q) return null; const b = opts.baseline(q);
      return q.last_price != null && b ? q.last_price - b : null; }],
    ["pct", "涨跌幅", pctOf],
    ["bid", "买一", (s) => (quotes[s] ? quotes[s].bid_price1 : null)],
    ["ask", "卖一", (s) => (quotes[s] ? quotes[s].ask_price1 : null)],
    ["vol", "成交量", (s) => (quotes[s] ? quotes[s].volume : null)],
    ["oi", "持仓", (s) => (quotes[s] ? quotes[s].open_interest : null)],
    ["amp", "振幅", (s) => { const q = quotes[s]; if (!q) return null; const b = opts.baseline(q);
      return (b && q.highest != null && q.lowest != null) ? (q.highest - q.lowest) / b * 100 : null; }],
  ];
  function listBody(gid, syms) {
    const st = secs[gid];
    const wrap = el("div");
    const t = el("table", "wb-t");
    const thead = el("thead"), tr = el("tr");
    for (const [k, label] of COLS) {
      const th = el("th", st.sortKey === k ? "s" : "");
      th.textContent = label + (st.sortKey === k ? (st.sortDir > 0 ? " ▲" : " ▼") : "");
      th.onclick = () => {
        if (st.sortKey === k) st.sortDir = -st.sortDir;
        else { st.sortKey = k; st.sortDir = -1; }
        rebuildSection(gid);
      };
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    t.appendChild(thead);
    const tb = el("tbody");
    let rows = syms.slice();
    if (st.sortKey) {
      const get = COLS.find((c) => c[0] === st.sortKey)[2];
      rows.sort((a, b) => {
        const x = get(a), y = get(b);
        if (typeof x === "string" || typeof y === "string")
          return String(x).localeCompare(String(y), "zh") * st.sortDir;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x - y) * st.sortDir;
      });
    }
    for (const sym of rows) {
      const r = el("tr");
      r.dataset.sym = sym; r.dataset.gid = gid;
      r.draggable = true;
      r.innerHTML = COLS.map(() => "<td>—</td>").join("");
      paintRow(r, sym);
      r.onclick = () => opts.onPick(sym);
      r.oncontextmenu = (e) => { e.preventDefault(); opts.onMenu(e, sym, gid); };
      wireDrag(r, sym, gid);
      tb.appendChild(r);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }
  function paintRow(r, sym) {
    const q = quotes[sym];
    if (!q) return;
    const td = r.children;
    const base = opts.baseline(q);
    const chg = q.last_price != null && base ? q.last_price - base : null;
    const pct = chg != null && base ? (chg / base) * 100 : null;
    td[0].innerHTML = `<span class="nm">${q.instrument_name || sym}</span>` +
      `<span class="cd">${sym.replace(/^KQ\.\w+@/, "")}</span>`;
    const c = cls(chg);
    td[1].textContent = opts.fmtQ(q.last_price, q); td[1].className = c;
    td[2].textContent = chg == null ? "—" : (chg > 0 ? "+" : "") + opts.fmtQ(chg, q); td[2].className = c;
    td[3].textContent = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%"; td[3].className = c;
    td[4].textContent = opts.fmtQ(q.bid_price1, q);
    td[5].textContent = opts.fmtQ(q.ask_price1, q);
    td[6].textContent = opts.fmtVol(q.volume);
    td[7].textContent = opts.isStock(q) ? "—" : opts.fmtVol(q.open_interest);
    const amp = (base && q.highest != null && q.lowest != null)
      ? (q.highest - q.lowest) / base * 100 : null;
    td[8].textContent = amp == null ? "—" : amp.toFixed(2) + "%";
    r.classList.toggle("sel", sym === selected);
  }

  /* ============================ 热力 ============================ */
  function heatBody(gid, syms) {
    const wrap = el("div", "wb-heat");
    for (const sym of syms) {
      const t = el("div", "wb-tile");
      t.dataset.sym = sym; t.dataset.gid = gid;
      t.draggable = true;
      t.innerHTML = '<div class="tn"></div><div class="tp">—</div><div class="tc">—</div>';
      paintTile(t, sym);
      t.onclick = () => opts.onPick(sym);
      t.oncontextmenu = (e) => { e.preventDefault(); opts.onMenu(e, sym, gid); };
      wireDrag(t, sym, gid);
      wrap.appendChild(t);
    }
    return wrap;
  }
  function paintTile(t, sym) {
    const q = quotes[sym];
    if (!q) return;
    const pct = pctOf(sym);
    t.style.background = heatColor(pct);
    t.querySelector(".tn").textContent = q.instrument_name || sym;
    t.querySelector(".tp").textContent = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
    t.querySelector(".tc").textContent = opts.fmtQ(q.last_price, q);
  }

  /* ============================ 多图 ============================ */
  function multiBody(gid, syms, cfg) {
    const st = secs[gid];
    st.cells = [];
    const wrap = el("div", "wb-mg");
    wrap.style.gridTemplateColumns = `repeat(${cfg.cols}, minmax(0, 1fr))`;
    const show = syms.slice(0, budgetFor(gid));
    for (const sym of show) {
      const c = el("div", "wb-cell");
      c.dataset.sym = sym; c.dataset.gid = gid;
      const h = el("div", "wb-ch");
      h.innerHTML = '<span class="nm"></span><span class="px">—</span><span class="pc">—</span>';
      h.onclick = () => opts.onPick(sym);
      const b = el("div", "wb-cb");
      c.append(h, b);
      c.oncontextmenu = (e) => { e.preventDefault(); opts.onMenu(e, sym, gid); };
      wrap.appendChild(c);
      st.cells.push({ sym, el: c, head: h, body: b, chart: null, rows: null, len: 0 });
    }
    return { node: wrap, truncated: syms.length - show.length };
  }
  /* 分时用 canvas 自绘 —— 每格一个 lightweight-charts 实例太重, 20 个标的会卡 */
  function drawSpark(cell, rows) {
    let cv = cell.body.querySelector("canvas");
    if (!cv) {
      cv = document.createElement("canvas");
      cell.body.appendChild(cv);
      const tip = el("div", "wb-tip");
      cell.body.appendChild(tip);
      cell.body.onmousemove = (e) => {
        const r = cell.body.getBoundingClientRect();
        const rs = cell.rows;
        if (!rs || !rs.length) return;
        const i = Math.max(0, Math.min(rs.length - 1,
          Math.round((e.clientX - r.left) / r.width * (rs.length - 1))));
        const b = rs[i];
        const q = quotes[cell.sym];
        tip.textContent = `${new Date((b.t + TZ) * 1000).toISOString().slice(11, 16)} ` +
          `${opts.fmtQ(b.c, q)} 量${opts.fmtVol(b.v)}`;
        tip.style.display = "block";
      };
      cell.body.onmouseleave = () => { const t = cell.body.querySelector(".wb-tip"); if (t) t.style.display = "none"; };
    }
    const dpr = window.devicePixelRatio || 1;
    const w = cell.body.clientWidth, h = cell.body.clientHeight;
    if (!w || !h) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!rows || rows.length < 2) return;
    const q = quotes[cell.sym] || {};
    const base = opts.baseline(q);
    const closes = rows.map((r) => r.c);
    let lo = Math.min(...closes), hi = Math.max(...closes);
    if (base) { lo = Math.min(lo, base); hi = Math.max(hi, base); }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const vh = h * 0.72, y = (v) => vh - (v - lo) / (hi - lo) * vh;
    const x = (i) => i / (rows.length - 1) * w;
    // 昨收基准线
    if (base) {
      g.strokeStyle = "rgba(255,255,255,.18)";
      g.setLineDash([3, 3]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y(base)); g.lineTo(w, y(base)); g.stroke();
      g.setLineDash([]);
    }
    const last = closes[closes.length - 1];
    const up = base ? last >= base : true;
    const col = up ? cssVar("--up", "#e66767") : cssVar("--down", "#199e70");
    // 成交量
    const maxV = Math.max(...rows.map((r) => r.v || 0)) || 1;
    g.fillStyle = up ? "rgba(230,103,103,.35)" : "rgba(25,158,112,.4)";
    const bw = Math.max(1, w / rows.length - 0.5);
    for (let i = 0; i < rows.length; i++) {
      const vh2 = (rows[i].v || 0) / maxV * (h - vh - 2);
      g.fillRect(x(i) - bw / 2, h - vh2, bw, vh2);
    }
    // 价格线 + 填充
    g.beginPath();
    g.moveTo(x(0), y(closes[0]));
    for (let i = 1; i < closes.length; i++) g.lineTo(x(i), y(closes[i]));
    g.strokeStyle = col; g.lineWidth = 1.3; g.stroke();
    g.lineTo(x(closes.length - 1), vh); g.lineTo(x(0), vh); g.closePath();
    g.fillStyle = up ? "rgba(230,103,103,.12)" : "rgba(25,158,112,.14)";
    g.fill();
  }
  function makeKChart(cell) {
    if (!window.LightweightCharts) return null;
    const c = LightweightCharts.createChart(cell.body, {
      layout: { background: { color: "transparent" }, textColor: cssVar("--muted", "#898781"),
                fontSize: 9 },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--grid", "#2c2c2a") } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScroll: false, handleScale: false,
      width: cell.body.clientWidth, height: cell.body.clientHeight,
    });
    const candle = c.addCandlestickSeries({
      upColor: cssVar("--up", "#e66767"), downColor: cssVar("--down", "#199e70"),
      borderVisible: false, wickUpColor: cssVar("--up", "#e66767"),
      wickDownColor: cssVar("--down", "#199e70"),
    });
    const vol = c.addHistogramSeries({
      priceScaleId: "v", priceFormat: { type: "volume" },
    });
    c.priceScale("v").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    return { chart: c, candle, vol };
  }
  function drawCell(cell, cfg) {
    const rows = cell.rows;
    if (!rows || !rows.length) return;
    if (cfg.chart === "ts") { drawSpark(cell, rows); return; }
    if (!cell.chart) {
      cell.chart = makeKChart(cell);
      if (!cell.chart) return;
    }
    const bars = rows.map((r) => ({ time: r.t + TZ, open: r.o, high: r.h, low: r.l, close: r.c }));
    cell.chart.candle.setData(bars);
    cell.chart.vol.setData(rows.map((r) => ({
      time: r.t + TZ, value: r.v,
      color: r.c >= r.o ? "rgba(230,103,103,.4)" : "rgba(25,158,112,.45)",
    })));
    const n = bars.length;
    try {
      cell.chart.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 80), to: n + 2 });
    } catch (e) { /* 尚无数据 */ }
  }
  function paintCellHead(cell) {
    const q = quotes[cell.sym];
    if (!q) return;
    const pct = pctOf(cell.sym);
    cell.head.querySelector(".nm").textContent = q.instrument_name || cell.sym;
    const px = cell.head.querySelector(".px");
    px.textContent = opts.fmtQ(q.last_price, q);
    px.className = "px " + cls(pct);
    const pc = cell.head.querySelector(".pc");
    pc.textContent = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
    pc.className = "pc " + cls(pct);
  }
  /* 多图分区需要的订阅 */
  /* CHART_BUDGET 是【全局】预算不是每分区预算 —— 服务端 FOCUS_MAX 是按连接算的,
     每个分区各要 12 条的话开两个多图分区就会把主图之外的订阅互相挤掉。 */
  function multiSubs() {
    const out = [], seen = new Set();
    for (const g of groups) {
      const cfg = cfgOf(g.id);
      if (cfg.type !== "multi" || cfg.fold) continue;
      for (const sym of symsOf(g)) {
        if (out.length >= CHART_BUDGET) return out;
        const k = sym + "|" + cfg.dur;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push([sym, cfg.dur]);
      }
    }
    return out;
  }
  /* 某个分区实际能画几格: 前面的分区先占预算 */
  function budgetFor(gid) {
    let used = 0;
    for (const g of groups) {
      const cfg = cfgOf(g.id);
      if (cfg.type !== "multi" || cfg.fold) continue;
      if (g.id === gid) return Math.max(0, CHART_BUDGET - used);
      used += Math.min(symsOf(g).length, Math.max(0, CHART_BUDGET - used));
    }
    return CHART_BUDGET;
  }
  function applySubs() {
    if (!opts.onSubscribe) return;
    const seen = new Set();
    for (const [s, d] of multiSubs()) {
      const k = s + "|" + d;
      if (seen.has(k)) continue;
      seen.add(k);
      opts.onSubscribe(s, d);
    }
  }

  /* ========================== 研究摘要 ========================== */
  function researchBody(gid, cfg) {
    const wrap = el("div", "wb-rs");
    const ts = cfg.stock || opts.defaultStock() || "600519.SH";
    wrap.innerHTML = '<div class="wb-empty">加载中…</div>';
    loadResearch(wrap, ts, gid);
    return wrap;
  }
  async function loadResearch(wrap, ts, gid) {
    // 只要最近一段, 不然 daily_basic 会把上市至今几千行全拉回来
    const d = new Date(Date.now() - 30 * 86400e3);
    const start = d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    const ask = async (kind, args) => {
      try {
        const r = await opts.request("fund", { kind, args: Object.assign({ ts_code: ts }, args || {}) });
        return { cols: r.cols || [], rows: r.rows || [] };
      } catch (e) { return { cols: [], rows: [], err: e.message }; }
    };
    const [val, mf, fin] = await Promise.all([
      ask("valuation", { start }), ask("moneyflow_series", { start }), ask("financials", { periods: 4 }),
    ]);
    if (!wrap.isConnected) return;                 // 期间分区被重建了
    // 行序不一致: valuation / moneyflow 按 trade_date 升序(最新在末尾),
    // financials 已经是从新到旧(最新在开头)。取错方向会读到上市首日的数据。
    const latest = (r, newestFirst) => (!r.rows.length ? null : r.rows[newestFirst ? 0 : r.rows.length - 1]);
    const vRow = latest(val, false), mRow = latest(mf, false), fRow = latest(fin, true);
    const at = (r, row, k) => {
      const j = r.cols.indexOf(k);
      return (j >= 0 && row) ? row[j] : null;
    };
    const q = quotes[opts.tqCodeOf(ts)];
    const pct = q ? pctOf(opts.tqCodeOf(ts)) : null;
    wrap.innerHTML = "";
    const hd = el("div", "wb-rs-hd");
    hd.innerHTML = `<b>${(q && q.instrument_name) || opts.stockName(ts) || ts}</b>` +
      `<span class="cd">${ts}</span>` +
      `<span class="px ${cls(pct)}">${q ? opts.fmtQ(q.last_price, q) : fmtNum(at(val, vRow, "close"))}` +
      `${pct == null ? "" : "  " + (pct > 0 ? "+" : "") + pct.toFixed(2) + "%"}</span>`;
    const go = el("span", "act");
    go.textContent = "展开完整面板 →";
    go.style.marginLeft = "auto";
    go.style.cursor = "pointer";
    go.onclick = () => opts.onResearch(ts);
    hd.appendChild(go);
    wrap.appendChild(hd);

    if (!vRow && !mRow && !fRow) {
      wrap.appendChild(Object.assign(el("div", "wb-empty"),
        { textContent: "基本面数据加载失败: " + (val.err || mf.err || fin.err || "无数据") }));
      return;
    }
    const dateTag = at(val, vRow, "trade_date");
    if (dateTag) {
      const t = el("div", "wb-rs-sub");
      t.textContent = `估值 (${String(dateTag).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")})`;
      wrap.appendChild(t);
    }
    const pctFmt = (v) => (num(v) == null ? "—" : num(v).toFixed(2) + "%");
    // total_mv / circ_mv 单位是万元
    const mvFmt = (v) => (num(v) == null ? "—" : amt(num(v) * 1e4));
    const g1 = el("div", "wb-rs-g");
    for (const [k, key, f] of [
      ["PE", "pe"], ["PE(TTM)", "pe_ttm"], ["PB", "pb"], ["PS(TTM)", "ps_ttm"],
      ["总市值", "total_mv", mvFmt], ["流通市值", "circ_mv", mvFmt],
      ["换手率", "turnover_rate", pctFmt], ["量比", "volume_ratio"],
      ["股息率(TTM)", "dv_ttm", pctFmt],
    ]) {
      const v = at(val, vRow, key);
      const i2 = el("div", "wb-rs-i");
      i2.innerHTML = `<div class="k">${k}</div><div class="v">${f ? f(v) : fmtNum(v)}</div>`;
      g1.appendChild(i2);
    }
    wrap.appendChild(g1);

    if (mRow) {
      const md = at(mf, mRow, "trade_date");
      wrap.appendChild(Object.assign(el("div", "wb-rs-sub"),
        { textContent: `资金流 (${String(md).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")})` }));
      const g2 = el("div", "wb-rs-g");
      // 各档要用 买-卖 算净额; buy_xx_amount 只是买入额。单位万元。
      const net = (a, b) => {
        const x = num(at(mf, mRow, a)), y = num(at(mf, mRow, b));
        return (x == null || y == null) ? null : (x - y) * 1e4;
      };
      const nmf = num(at(mf, mRow, "net_mf_amount"));
      for (const [k, v] of [
        ["主力净额", nmf == null ? null : nmf * 1e4],
        ["超大单净额", net("buy_elg_amount", "sell_elg_amount")],
        ["大单净额", net("buy_lg_amount", "sell_lg_amount")],
        ["中单净额", net("buy_md_amount", "sell_md_amount")],
        ["小单净额", net("buy_sm_amount", "sell_sm_amount")],
      ]) {
        const i2 = el("div", "wb-rs-i");
        i2.innerHTML = `<div class="k">${k}</div><div class="v ${cls(v)}">${v == null ? "—" : amt(v)}</div>`;
        g2.appendChild(i2);
      }
      wrap.appendChild(g2);
    }
    if (fRow) {
      const fd = at(fin, fRow, "end_date");
      wrap.appendChild(Object.assign(el("div", "wb-rs-sub"),
        { textContent: `财务 (${String(fd).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")})` }));
      const g3 = el("div", "wb-rs-g");
      for (const [k, key] of [["ROE", "roe"], ["毛利率", "grossprofit_margin"],
                              ["净利率", "netprofit_margin"], ["营收同比", "or_yoy"],
                              ["净利同比", "netprofit_yoy"], ["资产负债率", "debt_to_assets"]]) {
        const v = num(at(fin, fRow, key));
        const i2 = el("div", "wb-rs-i");
        // 资产负债率高低无所谓好坏, 不着色
        const c = key === "debt_to_assets" ? "" : cls(v);
        i2.innerHTML = `<div class="k">${k}</div><div class="v ${c}">${v == null ? "—" : v.toFixed(2) + "%"}</div>`;
        g3.appendChild(i2);
      }
      wrap.appendChild(g3);
    }
  }

  /* ============================ 分区 ============================ */
  function wireDrag(node, sym, gid) {
    node.addEventListener("dragstart", (e) => {
      dragSym = sym; dragFrom = gid;
      node.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sym);
    });
    node.addEventListener("dragend", () => {
      node.classList.remove("dragging");
      dragSym = dragFrom = null;
      if (root) root.querySelectorAll(".wb-sec.drop").forEach((s) => s.classList.remove("drop"));
    });
  }

  function sectionEl(g) {
    const cfg = cfgOf(g.id);
    const st = secs[g.id] || (secs[g.id] = { sortKey: null, sortDir: -1, cells: [] });
    const sec = el("div", "wb-sec" + (cfg.fold ? " fold" : ""));
    sec.dataset.gid = g.id;
    const syms = symsOf(g);

    /* 头部 */
    const h = el("div", "wb-h");
    const ttl = el("div", "ttl");
    ttl.innerHTML = '<span class="caret">▼</span><b></b><span class="cnt"></span>';
    ttl.querySelector("b").textContent = g.name;
    ttl.querySelector(".cnt").textContent =
      cfg.type === "research" ? "" :
        (syms.length === g.symbols.length ? `${g.symbols.length}` : `${syms.length}/${g.symbols.length}`);
    ttl.onclick = () => {
      cfg.fold = !cfg.fold;
      saveCfg();
      rebuildSection(g.id);
      applySubs();
    };
    h.appendChild(ttl);
    // 形态切换
    const seg = el("div", "wb-seg");
    for (const [k, label] of SEC_TYPES) {
      const b = el("button", k === cfg.type ? "on" : "");
      b.textContent = label;
      b.onclick = () => {
        if (cfg.type === k) return;
        cfg.type = k;
        saveCfg();
        rebuildSection(g.id);
        applySubs();
      };
      seg.appendChild(b);
    }
    h.appendChild(seg);
    h.appendChild(el("span", "sp"));
    for (const [label, fn] of [
      ["＋标的", () => opts.onAdd(g.id)],
      ["重命名", () => { const n = prompt("分区名称", g.name); if (n) opts.onRename(g.id, n); }],
      ["删除", () => {
        if (groups.length <= 1) { alert("至少保留一个分区"); return; }
        if (confirm(`删除分区「${g.name}」? 区内 ${g.symbols.length} 个标的会被移出自选`))
          opts.onDelete(g.id);
      }],
    ]) {
      const a = el("span", "act");
      a.textContent = label;
      a.onclick = (e) => { e.stopPropagation(); fn(); };
      h.appendChild(a);
    }
    sec.appendChild(h);

    /* 形态专属设置行 */
    if (cfg.type === "multi" || cfg.type === "research") {
      const cf = el("div", "wb-cfg");
      if (cfg.type === "multi") {
        cf.appendChild(Object.assign(el("span"), { textContent: "小图" }));
        const seg2 = el("div", "wb-seg");
        for (const [k, label] of [["ts", "分时"], ["kl", "K线"]]) {
          const b = el("button", k === cfg.chart ? "on" : "");
          b.textContent = label;
          b.onclick = () => { cfg.chart = k; saveCfg(); rebuildSection(g.id); applySubs(); };
          seg2.appendChild(b);
        }
        cf.appendChild(seg2);
        cf.appendChild(Object.assign(el("span"), { textContent: "周期" }));
        const sel = el("select");
        for (const [v, label] of DURS) {
          const o = document.createElement("option");
          o.value = v; o.textContent = label;
          if (+v === +cfg.dur) o.selected = true;
          sel.appendChild(o);
        }
        sel.onchange = () => { cfg.dur = +sel.value; saveCfg(); rebuildSection(g.id); applySubs(); };
        cf.appendChild(sel);
        cf.appendChild(Object.assign(el("span"), { textContent: "列数" }));
        const sc = el("select");
        for (const n of [2, 3, 4, 5, 6]) {
          const o = document.createElement("option");
          o.value = n; o.textContent = n;
          if (n === +cfg.cols) o.selected = true;
          sc.appendChild(o);
        }
        sc.onchange = () => { cfg.cols = +sc.value; saveCfg(); rebuildSection(g.id); };
        cf.appendChild(sc);
      } else {
        cf.appendChild(Object.assign(el("span"), { textContent: "研究标的" }));
        const inp = el("input");
        inp.value = cfg.stock || opts.defaultStock() || "600519.SH";
        inp.size = 12;
        inp.placeholder = "600519.SH";
        inp.onchange = () => {
          cfg.stock = inp.value.trim().toUpperCase();
          saveCfg();
          rebuildSection(g.id);
        };
        cf.appendChild(inp);
        // 自选里的股票一键切
        for (const sym of new Set(groups.flatMap((x) => x.symbols).filter((s) => opts.marketOf(s) === "stk"))) {
          const ts = opts.toTsCode(sym);
          const b = el("button", "wb-btn");
          b.style.padding = "1px 8px";
          b.textContent = (quotes[sym] && quotes[sym].instrument_name) || opts.stockName(ts) || ts;
          b.onclick = () => { cfg.stock = ts; saveCfg(); rebuildSection(g.id); };
          cf.appendChild(b);
        }
      }
      sec.appendChild(cf);
    }

    /* 主体 */
    const body = el("div", "wb-body");
    if (cfg.type === "research") {
      body.appendChild(researchBody(g.id, cfg));
    } else if (!syms.length) {
      const e2 = el("div", "wb-empty");
      e2.textContent = g.symbols.length
        ? `本区没有${filter === "stk" ? "A股" : "期货"}标的 (共 ${g.symbols.length} 个)`
        : "空分区 — 点「＋标的」添加, 或从别的分区拖一个过来";
      body.appendChild(e2);
    } else if (cfg.type === "list") {
      body.appendChild(listBody(g.id, syms));
    } else if (cfg.type === "heat") {
      body.appendChild(heatBody(g.id, syms));
    } else if (cfg.type === "multi") {
      const r = multiBody(g.id, syms, cfg);
      if (r.truncated > 0) {
        const n = el("div", "wb-note");
        n.textContent = `只画前 ${budgetFor(g.id)} 个 (还有 ${r.truncated} 个未显示) — ` +
          `同时推送的K线路数有上限, 想全看请拆成多个分区或换「列表/热力」形态`;
        body.appendChild(n);
      }
      body.appendChild(r.node);
    } else {
      const grid = el("div", "wb-grid");
      for (const sym of syms) grid.appendChild(cardEl(sym, g.id));
      body.appendChild(grid);
    }
    sec.appendChild(body);

    /* 拖放到本区 */
    sec.addEventListener("dragover", (e) => {
      if (!dragSym || dragFrom === g.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      sec.classList.add("drop");
    });
    sec.addEventListener("dragleave", (e) => {
      if (!sec.contains(e.relatedTarget)) sec.classList.remove("drop");
    });
    sec.addEventListener("drop", (e) => {
      e.preventDefault();
      sec.classList.remove("drop");
      if (!dragSym || dragFrom === g.id) return;
      opts.onMove(dragSym, dragFrom, g.id);
      dragSym = dragFrom = null;
    });
    return sec;
  }

  function rebuildSection(gid) {
    if (!root) return;
    const old = root.querySelector(`.wb-sec[data-gid="${gid}"]`);
    const g = groups.find((x) => x.id === gid);
    if (!old || !g) { build(); return; }
    disposeSection(gid);
    old.replaceWith(sectionEl(g));
    drawAll(gid);
  }
  function disposeSection(gid) {
    const st = secs[gid];
    if (!st) return;
    for (const c of st.cells) {
      if (c.chart) { try { c.chart.chart.remove(); } catch (e) { /* 已销毁 */ } c.chart = null; }
    }
    st.cells = [];
  }

  function build() {
    if (!root) return;
    for (const gid in secs) disposeSection(gid);
    root.innerHTML = "";
    const bar = el("div", "wb-bar");
    for (const [k, label] of FILTERS) {
      const n = k === "all"
        ? groups.reduce((a, g) => a + g.symbols.length, 0)
        : groups.reduce((a, g) => a + g.symbols.filter((s) => opts.marketOf(s) === k).length, 0);
      const b = el("button", "wb-btn" + (k === filter ? " on" : ""));
      b.textContent = `${label} ${n}`;
      b.onclick = () => {
        filter = k;
        try { localStorage.setItem("mw:wbfilter", k); } catch (e) { /* 忽略 */ }
        build(); applySubs();
      };
      bar.appendChild(b);
    }
    bar.appendChild(el("span", "sp"));
    const add = el("button", "wb-btn");
    add.textContent = "＋ 新建分区";
    add.onclick = () => {
      const n = prompt("新分区名称", "分区" + (groups.length + 1));
      if (n) opts.onCreate(n);
    };
    bar.appendChild(add);
    root.appendChild(bar);
    if (!groups.length) {
      root.appendChild(Object.assign(el("div", "wb-empty"), { textContent: "还没有自选分区" }));
      return;
    }
    for (const g of groups) root.appendChild(sectionEl(g));
    drawAll();
  }

  /* 图表首帧: 要等元素进 DOM 拿到尺寸 */
  function drawAll(onlyGid) {
    requestAnimationFrame(() => {
      for (const g of groups) {
        if (onlyGid && g.id !== onlyGid) continue;
        const cfg = cfgOf(g.id);
        if (cfg.type !== "multi" || cfg.fold) continue;
        const st = secs[g.id];
        if (!st) continue;
        for (const c of st.cells) {
          paintCellHead(c);
          const rows = klines[c.sym + "|" + cfg.dur];
          if (rows && rows.length) { c.rows = rows; c.len = rows.length; drawCell(c, cfg); }
        }
      }
    });
  }

  function visible() {
    const w = document.getElementById("watch-wrap");
    return w && !w.classList.contains("hidden");
  }
  function tick() {
    if (raf || !visible() || !root) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const g of groups) {
        const cfg = cfgOf(g.id);
        if (cfg.fold) continue;
        const st = secs[g.id];
        const sec = root.querySelector(`.wb-sec[data-gid="${g.id}"]`);
        if (!sec) continue;
        if (cfg.type === "card") sec.querySelectorAll(".wb-card").forEach((c) => paintCard(c, c.dataset.sym, false));
        else if (cfg.type === "list") sec.querySelectorAll("tbody tr").forEach((r) => paintRow(r, r.dataset.sym));
        else if (cfg.type === "heat") sec.querySelectorAll(".wb-tile").forEach((t) => paintTile(t, t.dataset.sym));
        else if (cfg.type === "multi" && st) {
          for (const c of st.cells) {
            paintCellHead(c);
            const rows = klines[c.sym + "|" + cfg.dur];
            if (!rows || !rows.length) continue;
            const grew = rows.length !== c.len;
            c.rows = rows; c.len = rows.length;
            if (cfg.chart === "ts") drawSpark(c, rows);     // canvas 重画很便宜
            else if (grew || !c.chart) drawCell(c, cfg);
            else {                                          // K线常态只动最后一根
              const r = rows[rows.length - 1];
              try {
                c.chart.candle.update({ time: r.t + TZ, open: r.o, high: r.h, low: r.l, close: r.c });
                c.chart.vol.update({ time: r.t + TZ, value: r.v,
                  color: r.c >= r.o ? "rgba(230,103,103,.4)" : "rgba(25,158,112,.45)" });
              } catch (e) { /* 时间倒退等异常, 下一轮全量重画 */ c.len = -1; }
            }
          }
        }
      }
    });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      root = el("div"); root.id = "wb-root";
      host.innerHTML = "";
      host.appendChild(root);
      build();
      applySubs();
      return true;
    },
    setGroups(gs) {
      const sig = JSON.stringify((gs || []).map((g) => [g.id, g.name, g.symbols]));
      if (sig === this._sig) { groups = gs || []; return; }
      this._sig = sig;
      groups = gs || [];
      if (root) { build(); applySubs(); }
    },
    update(q, sel, kl) {
      quotes = q || quotes;
      if (kl) klines = kl;
      if (sel !== undefined && sel !== selected) {
        selected = sel;
        if (root) {
          root.querySelectorAll(".wb-card").forEach((c) => c.classList.toggle("sel", c.dataset.sym === selected));
          root.querySelectorAll("tbody tr").forEach((r) => r.classList.toggle("sel", r.dataset.sym === selected));
        }
      }
      tick();
    },
    /* 视图重新显示时要补订阅(离开时被 unfocus 掉了) */
    subs() { return multiSubs(); },
    refresh() { if (root) { build(); applySubs(); } },
    isMounted() { return !!root; },
    destroy() {
      if (raf) cancelAnimationFrame(raf), raf = 0;
      for (const gid in secs) disposeSection(gid);
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
