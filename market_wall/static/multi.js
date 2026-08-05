/* 多图显示 —— 1/2/4/6/9 宫格同时看多个品种
 * 自包含模块: IIFE + 动态注入样式, 只暴露 window.MultiView
 * 每格是一张精简 K 线图(蜡烛 + 均线 + 成交量), 共用一套 WS 订阅。
 */
window.MultiView = (function () {
  "use strict";

  const STYLE_ID = "mv-style";
  const CSS = `
#mv-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;min-width:0;
  overflow:hidden;background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#mv-root *{box-sizing:border-box}
.mv-bar{display:flex;align-items:center;gap:10px;padding:6px 12px;flex:0 0 auto;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1));background:var(--surface,#1a1a19)}
.mv-bar button{background:transparent;color:var(--muted,#898781);border:1px solid transparent;
  border-radius:5px;padding:3px 10px;font-size:12px;cursor:pointer;font-family:inherit}
.mv-bar button:hover{color:var(--ink-2,#c3c2b7);background:var(--surface-2,#222221)}
.mv-bar button.on{color:var(--ink,#fff);background:var(--surface-2,#222221);
  border-color:var(--border,rgba(255,255,255,.1))}
.mv-lab{color:var(--muted,#898781);font-size:11px}
.mv-hint{margin-left:auto;color:var(--grid,#2c2c2a);font-size:11px}
.mv-grid{flex:1 1 auto;min-height:0;display:grid;gap:4px;padding:4px}
.mv-cell{position:relative;background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:6px;overflow:hidden;display:flex;flex-direction:column;min-height:0;min-width:0}
.mv-cell.sel{border-color:var(--ma5,#3987e5)}
.mv-head{display:flex;align-items:baseline;gap:8px;padding:4px 8px;flex:0 0 auto;
  font-variant-numeric:tabular-nums;cursor:pointer;border-bottom:1px solid var(--grid,#2c2c2a)}
.mv-n{color:var(--ink,#fff);font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mv-p{font-size:13px;font-weight:600;margin-left:auto}
.mv-c{font-size:11px}
.mv-dur{color:var(--muted,#898781);font-size:10px;border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:3px;padding:0 4px;cursor:pointer}
.mv-dur:hover{color:var(--ink,#fff)}
.mv-x{color:var(--grid,#2c2c2a);cursor:pointer;font-size:11px;padding:0 2px}
.mv-x:hover{color:var(--up,#e66767)}
.mv-chart{flex:1 1 auto;min-height:0}
.mv-empty{display:flex;align-items:center;justify-content:center;height:100%;
  color:var(--grid,#2c2c2a);font-size:12px;cursor:pointer;flex-direction:column;gap:4px}
.mv-empty b{color:var(--muted,#898781);font-size:20px;font-weight:400}
.mv-up{color:var(--up,#e66767)} .mv-down{color:var(--down,#199e70)} .mv-flat{color:var(--ink-2,#c3c2b7)}
`;

  const LAYOUTS = [
    { key: 1, label: "1", cols: 1, rows: 1 },
    { key: 2, label: "2", cols: 2, rows: 1 },
    { key: 4, label: "4", cols: 2, rows: 2 },
    { key: 6, label: "6", cols: 3, rows: 2 },
    { key: 9, label: "9", cols: 3, rows: 3 },
  ];
  const DURS = [[60, "1m"], [300, "5m"], [900, "15m"], [1800, "30m"], [3600, "1h"], [86400, "日"]];
  const TZ = 8 * 3600;

  let host = null, root = null, grid = null, opts = {};
  let layout = 4;
  let cells = [];                 // {symbol, duration, el, chart, candle, vol, ma, rows, name}
  let selIdx = 0;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const cssVar = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n) || d).trim();

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem("mw:multi") || "null");
      if (s && s.layout) layout = s.layout;
      if (s && Array.isArray(s.cells)) return s.cells;
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function saveState() {
    try {
      localStorage.setItem("mw:multi", JSON.stringify({
        layout, cells: cells.map((c) => ({ symbol: c.symbol, duration: c.duration })),
      }));
    } catch (e) { /* 忽略 */ }
  }

  function baseOpts() {
    return {
      autoSize: true,
      layout: { background: { type: "solid", color: cssVar("--surface", "#1a1a19") },
                textColor: cssVar("--muted", "#898781"), fontSize: 10 },
      grid: { vertLines: { color: cssVar("--grid", "#2c2c2a") }, horzLines: { color: cssVar("--grid", "#2c2c2a") } },
      rightPriceScale: { borderColor: cssVar("--grid", "#2c2c2a"), minimumWidth: 52 },
      timeScale: { borderColor: cssVar("--grid", "#2c2c2a"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScale: { axisPressedMouseMove: false },
    };
  }

  function buildGrid() {
    const L = LAYOUTS.find((x) => x.key === layout) || LAYOUTS[2];
    grid.style.gridTemplateColumns = `repeat(${L.cols}, minmax(0,1fr))`;
    grid.style.gridTemplateRows = `repeat(${L.rows}, minmax(0,1fr))`;
    // 多余的格子销毁, 不足的补空。
    // 幸存格子的图表也必须 remove(): innerHTML="" 只是摘掉 DOM, 图表实例和它
    // 自带的 ResizeObserver 还活着。切布局/切周期/换标的每次都走这里, 不销毁
    // 就是每次泄漏一批实例。
    while (cells.length > layout) destroyCell(cells.pop());
    for (const c of cells) destroyCell(c);
    grid.innerHTML = "";
    for (let i = 0; i < layout; i++) {
      if (!cells[i]) cells[i] = { symbol: null, duration: 60, rows: [] };
      cells[i].el = null;
      cells[i].chart = null;
      grid.appendChild(renderCell(i));
    }
    applySubs();
  }

  function destroyCell(c) {
    if (c && c.chart) { try { c.chart.remove(); } catch (e) { /* 已销毁 */ } c.chart = null; }
  }

  function renderCell(i) {
    const c = cells[i];
    const box = el("div", "mv-cell" + (i === selIdx ? " sel" : ""));
    box.onclick = () => { selIdx = i; refreshSel(); };
    if (!c.symbol) {
      const e2 = el("div", "mv-empty");
      e2.innerHTML = "<b>＋</b><span>点击选择标的</span>";
      e2.onclick = (ev) => { ev.stopPropagation(); selIdx = i; refreshSel(); pickSymbol(i); };
      box.appendChild(e2);
      c.el = box;
      return box;
    }
    const head = el("div", "mv-head");
    head.innerHTML = `<span class="mv-n"></span><span class="mv-dur">${durLabel(c.duration)}</span>` +
      `<span class="mv-p mv-flat">—</span><span class="mv-c mv-flat">—</span><span class="mv-x" title="移除">✕</span>`;
    head.querySelector(".mv-n").textContent = c.name || c.symbol;
    head.querySelector(".mv-dur").onclick = (ev) => { ev.stopPropagation(); cycleDur(i); };
    head.querySelector(".mv-x").onclick = (ev) => {
      ev.stopPropagation();
      if (c.symbol && opts.onDrop) opts.onDrop(c.symbol, c.duration);
      c.symbol = null; c.rows = [];
      destroyCell(c); c.chart = null;
      saveState(); buildGrid();
    };
    head.onclick = (ev) => {
      if (ev.target.classList.contains("mv-dur") || ev.target.classList.contains("mv-x")) return;
      selIdx = i; refreshSel();
      if (opts.onPick) opts.onPick(c.symbol);
    };
    const cv = el("div", "mv-chart");
    box.append(head, cv);
    c.el = box;
    // 图表要等元素进 DOM 且有尺寸后再建
    requestAnimationFrame(() => makeChart(i, cv));
    return box;
  }

  function makeChart(i, cv) {
    const c = cells[i];
    if (!c || !c.symbol || c.chart || !cv.isConnected) return;
    const ch = LightweightCharts.createChart(cv, baseOpts());
    const up = cssVar("--up", "#e66767"), down = cssVar("--down", "#199e70");
    c.chart = ch;
    c.candle = ch.addCandlestickSeries({
      upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down,
      priceLineVisible: false, lastValueVisible: true,
    });
    c.vol = ch.addHistogramSeries({
      priceScaleId: "v", priceFormat: { type: "volume" },
      lastValueVisible: false, priceLineVisible: false,
    });
    ch.priceScale("v").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    c.ma = [cssVar("--ma5", "#3987e5"), cssVar("--ma20", "#9085e9")].map((col) =>
      ch.addLineSeries({ color: col, lineWidth: 1, lastValueVisible: false,
                         priceLineVisible: false, crosshairMarkerVisible: false }));
    if (c.rows && c.rows.length) draw(i);
  }

  function durLabel(d) { return (DURS.find((x) => x[0] === d) || [0, d + "s"])[1]; }
  function cycleDur(i) {
    const c = cells[i];
    const idx = DURS.findIndex((x) => x[0] === c.duration);
    const old = c.duration;
    c.duration = DURS[(idx + 1) % DURS.length][0];
    c.rows = [];
    if (opts.onDrop) opts.onDrop(c.symbol, old);
    saveState();
    buildGrid();
  }
  function refreshSel() {
    [...grid.children].forEach((e, i) => e.classList.toggle("sel", i === selIdx));
  }
  function pickSymbol(i) {
    if (opts.onRequestSymbol) opts.onRequestSymbol((sym) => setCell(i, sym));
  }
  function setCell(i, sym, dur) {
    if (!cells[i]) cells[i] = { duration: 60, rows: [] };
    const c = cells[i];
    if (c.symbol && opts.onDrop) opts.onDrop(c.symbol, c.duration);
    c.symbol = sym;
    if (dur) c.duration = dur;
    c.rows = [];
    c.name = null;          // 换标的必须清掉旧名字, 否则价格变了名字还是上一个
    destroyCell(c); c.chart = null;
    saveState();
    buildGrid();
  }

  /* 把所有格子需要的 (symbol, duration) 告诉集成方去订阅 */
  function applySubs() {
    if (!opts.onSubscribe) return;
    const seen = new Set();
    for (const c of cells) {
      if (!c.symbol) continue;
      const k = c.symbol + "|" + c.duration;
      if (seen.has(k)) continue;
      seen.add(k);
      opts.onSubscribe(c.symbol, c.duration);
    }
  }

  function sma(vals, n) {
    const out = new Array(vals.length).fill(null);
    let s = 0;
    for (let i = 0; i < vals.length; i++) {
      s += vals[i];
      if (i >= n) s -= vals[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function draw(i) {
    const c = cells[i];
    if (!c || !c.chart || !c.rows || !c.rows.length) return;
    const up = cssVar("--up", "#e66767"), down = cssVar("--down", "#199e70");
    const bars = c.rows.map((r) => ({ time: r.t + TZ, open: r.o, high: r.h, low: r.l, close: r.c }));
    c.candle.setData(bars);
    c.vol.setData(c.rows.map((r) => ({
      time: r.t + TZ, value: r.v,
      color: r.c >= r.o ? "rgba(230,103,103,.4)" : "rgba(25,158,112,.45)",
    })));
    const closes = c.rows.map((r) => r.c);
    const times = bars.map((b) => b.time);
    [5, 20].forEach((n, j) => {
      const v = sma(closes, n);
      c.ma[j].setData(times.map((t, k) => (v[k] != null ? { time: t, value: v[k] } : { time: t })));
    });
    const n = bars.length;
    c.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 90), to: n + 2 });
  }

  function digits(v) {
    if (v == null) return 2;
    const a = Math.abs(v);
    return a >= 5000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      const saved = loadState();
      root = el("div"); root.id = "mv-root";
      const bar = el("div", "mv-bar");
      const lab = el("span", "mv-lab"); lab.textContent = "布局";
      bar.appendChild(lab);
      for (const L of LAYOUTS) {
        const b = el("button"); b.textContent = L.label; b.dataset.k = L.key;
        if (L.key === layout) b.className = "on";
        b.onclick = () => {
          layout = L.key;
          [...bar.querySelectorAll("button[data-k]")].forEach((x) => x.classList.toggle("on", +x.dataset.k === layout));
          saveState(); buildGrid();
        };
        bar.appendChild(b);
      }
      const hint = el("span", "mv-hint");
      hint.textContent = "点空格加标的 · 点周期标签切周期 · 点标题跳到主图";
      bar.appendChild(hint);
      grid = el("div", "mv-grid");
      root.append(bar, grid);
      host.innerHTML = "";
      host.appendChild(root);
      if (saved) saved.slice(0, layout).forEach((s, i) => { cells[i] = { symbol: s.symbol, duration: s.duration || 60, rows: [] }; });
      buildGrid();
      return true;
    },
    /* 收到 data 推送时调: klines 是 {"sym|dur": rows}, quotes 是行情表 */
    update(klines, quotes) {
      if (!root) return;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!c || !c.symbol || !c.el) continue;
        const rows = klines && klines[c.symbol + "|" + c.duration];
        if (rows && rows.length && rows !== c.rows) {
          const grew = !c.rows.length || rows.length !== c.rows.length;
          c.rows = rows;
          if (!c.chart) { /* 图表还没建好, 建好时会补画 */ }
          else if (grew) draw(i);
          else {                                   // 只动最后一根
            const r = rows[rows.length - 1];
            c.candle.update({ time: r.t + TZ, open: r.o, high: r.h, low: r.l, close: r.c });
            c.vol.update({ time: r.t + TZ, value: r.v,
              color: r.c >= r.o ? "rgba(230,103,103,.4)" : "rgba(25,158,112,.45)" });
          }
        }
        const q = quotes && quotes[c.symbol];
        if (q) {
          if (!c.name && q.instrument_name) {
            c.name = q.instrument_name;
            const n = c.el.querySelector(".mv-n");
            if (n) n.textContent = c.name;
          }
          const base = (q.pre_settlement > 0 ? q.pre_settlement : q.pre_close) || 0;
          const lp = q.last_price;
          const chg = (lp != null && base) ? lp - base : null;
          const pct = chg != null ? chg / base * 100 : null;
          const cls = chg > 0 ? "mv-up" : chg < 0 ? "mv-down" : "mv-flat";
          const d = digits(lp);
          const pe = c.el.querySelector(".mv-p"), ce = c.el.querySelector(".mv-c");
          if (pe) { pe.textContent = lp != null ? lp.toFixed(d) : "—"; pe.className = "mv-p " + cls; }
          if (ce) {
            ce.textContent = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%";
            ce.className = "mv-c " + cls;
          }
        }
      }
    },
    setSymbol(sym, dur) { setCell(selIdx, sym, dur); },
    subs() {
      const out = [];
      for (const c of cells) if (c.symbol) out.push([c.symbol, c.duration]);
      return out;
    },
    isMounted() { return !!root; },
    destroy() {
      for (const c of cells) destroyCell(c);
      cells = [];
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = grid = null;
    },
  };
})();
