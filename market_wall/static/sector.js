/* 分区看板 —— 按板块分组的涨跌热力图 (同花顺"板块"风格)
 * 自包含模块: IIFE + 动态注入样式, 只暴露 window.SectorView
 * 数据源复用 board 协议(88 个主力合约 + board_meta 的 cats/catNames)
 */
window.SectorView = (function () {
  "use strict";

  const STYLE_ID = "sec-style";
  const CSS = `
#sec-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;min-width:0;overflow:hidden;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#sec-root *{box-sizing:border-box}
.sec-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;flex:0 0 auto;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1));background:var(--surface,#1a1a19)}
.sec-title{color:var(--ink,#fff);font-weight:600}
.sec-modes{display:flex;gap:2px}
.sec-modes button,.sec-sorts button{background:transparent;color:var(--muted,#898781);
  border:1px solid transparent;border-radius:5px;padding:3px 10px;font-size:12px;
  cursor:pointer;font-family:inherit}
.sec-modes button:hover,.sec-sorts button:hover{color:var(--ink-2,#c3c2b7);background:var(--surface-2,#222221)}
.sec-modes button.on,.sec-sorts button.on{color:var(--ink,#fff);background:var(--surface-2,#222221);
  border-color:var(--border,rgba(255,255,255,.1))}
.sec-legend{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted,#898781)}
.sec-legend i{display:inline-block;width:16px;height:10px;border-radius:2px}
/* min-height:0 必须有 —— flex 列里的子项默认 min-height:auto 会被内容撑开,
   overflow-y:auto 就永远不触发, 配上 body{overflow:hidden} 表现为"拖不动" */
.sec-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;
  padding:10px 12px 24px}
.sec-group{margin-bottom:16px}
.sec-ghead{display:flex;align-items:baseline;gap:10px;margin-bottom:6px;
  padding-bottom:4px;border-bottom:1px solid var(--grid,#2c2c2a)}
.sec-gname{color:var(--ink,#fff);font-weight:600;font-size:13px}
.sec-gstat{font-size:11px;color:var(--muted,#898781);font-variant-numeric:tabular-nums}
.sec-gavg{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.sec-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:6px}
.sec-tile{border-radius:6px;padding:7px 8px;cursor:pointer;position:relative;
  border:1px solid transparent;transition:border-color .12s;overflow:hidden}
.sec-tile:hover{border-color:var(--ink-2,#c3c2b7)}
.sec-tile.sel{border-color:var(--ma5,#3987e5)}
.sec-n{color:#fff;font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sec-p{color:#fff;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
.sec-c{color:rgba(255,255,255,.88);font-size:11.5px;font-variant-numeric:tabular-nums}
.sec-x{color:rgba(255,255,255,.6);font-size:10px;font-variant-numeric:tabular-nums;margin-top:2px}
.sec-empty{padding:40px;text-align:center;color:var(--muted,#898781)}
@keyframes sec-fu{from{box-shadow:inset 0 0 0 2px rgba(255,255,255,.55)}to{box-shadow:none}}
.sec-tile.f{animation:sec-fu .45s ease-out}
`;

  // 板块 id -> 展示名 + 顺序(和 board.js 的 chips 保持一致的产业口径)
  const SECTORS = [
    ["EQUITY_INDEX", "股指期货"], ["TREASURY_BOND", "国债期货"],
    ["PRECIOUS_METALS", "贵金属"], ["NONFERROUS_METALS", "有色金属"],
    ["FERROUS", "黑色金属"], ["COAL", "煤炭"],
    ["CHEMICAL", "化工"], ["OIL", "石油"],
    ["GRAIN", "谷物"], ["GREASE", "油脂油料"], ["AGRICULTURAL", "农副"],
    ["SOFT_COMMODITY", "软商品"], ["LIGHT_INDUSTRY", "轻工"],
  ];
  const SEC_NAME = new Map(SECTORS);
  const SEC_ORDER = new Map(SECTORS.map(([k], i) => [k, i]));

  let host = null, root = null, els = {}, opts = {};
  let meta = new Map();          // sym -> {u,n,ex,cats,catNames,night}
  let data = {};                 // sym -> {lp,pre,oi,vol,b,a,u}
  let prev = {};
  let mode = "sector";           // sector | exchange
  let sortBy = "pct";            // pct | oi | vol | name
  let selectedSym = null;
  let raf = 0;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);

  function fmtVol(n) {
    if (opts.fmtVol) return opts.fmtVol(n);
    if (n == null) return "—";
    return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(n);
  }
  function digitsOf(v) {
    if (v == null) return 2;
    const a = Math.abs(v);
    return a >= 5000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  }

  /* 涨跌幅 -> 背景色。±3% 打满, 中间线性插值。
     红涨绿跌; 用 HSL 控制明度让 0 附近接近面板底色, 不刺眼 */
  function heatColor(pct) {
    if (pct == null) return "rgba(255,255,255,.04)";
    const t = Math.max(-1, Math.min(1, pct / 3));
    const a = Math.abs(t);
    if (a < 0.02) return "rgba(255,255,255,.05)";
    // 涨: 230,103,103 ; 跌: 25,158,112
    const [r, g, b] = t > 0 ? [230, 103, 103] : [25, 158, 112];
    const alpha = 0.14 + 0.72 * a;
    return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }

  function pctOf(d) {
    const lp = num(d && d.lp), pre = num(d && d.pre);
    if (lp == null || !pre) return null;
    return (lp - pre) / pre * 100;
  }

  function buildSkeleton() {
    root = el("div"); root.id = "sec-root";
    const bar = el("div", "sec-bar");
    const title = el("div", "sec-title"); title.textContent = "分区看板";
    const modes = el("div", "sec-modes");
    for (const [k, label] of [["sector", "按板块"], ["exchange", "按交易所"]]) {
      const b = el("button"); b.textContent = label; b.dataset.k = k;
      if (k === mode) b.className = "on";
      b.onclick = () => { mode = k; syncBtns(); render(true); };
      modes.appendChild(b);
    }
    const sorts = el("div", "sec-sorts");
    for (const [k, label] of [["pct", "涨跌幅"], ["oi", "持仓"], ["vol", "成交"], ["name", "名称"]]) {
      const b = el("button"); b.textContent = label; b.dataset.s = k;
      if (k === sortBy) b.className = "on";
      b.onclick = () => { sortBy = k; syncBtns(); render(true); };
      sorts.appendChild(b);
    }
    const lg = el("div", "sec-legend");
    lg.innerHTML = `<span>-3%</span><i style="background:${heatColor(-3)}"></i>`
      + `<i style="background:${heatColor(-1)}"></i><i style="background:${heatColor(0)}"></i>`
      + `<i style="background:${heatColor(1)}"></i><i style="background:${heatColor(3)}"></i><span>+3%</span>`;
    bar.append(title, modes, sorts, lg);
    els.scroll = el("div", "sec-scroll");
    els.scroll.innerHTML = '<div class="sec-empty">等待看板数据…</div>';
    root.append(bar, els.scroll);
    host.innerHTML = "";
    host.appendChild(root);
    els.modes = modes; els.sorts = sorts;
  }
  function syncBtns() {
    [...els.modes.children].forEach((b) => b.classList.toggle("on", b.dataset.k === mode));
    [...els.sorts.children].forEach((b) => b.classList.toggle("on", b.dataset.s === sortBy));
  }

  function grouped() {
    const buckets = new Map();
    for (const [sym, m] of meta) {
      let keys;
      if (mode === "exchange") keys = [m.ex || "其他"];
      else {
        const cs = (m.cats || []).filter((c) => SEC_NAME.has(c));
        keys = cs.length ? cs : ["OTHER"];
      }
      for (const k of keys) {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(sym);
      }
    }
    const EXN = { SHFE: "上期所", INE: "能源中心", DCE: "大商所", CZCE: "郑商所", CFFEX: "中金所", GFEX: "广期所" };
    const arr = [...buckets.entries()].map(([k, syms]) => ({
      key: k,
      name: mode === "exchange" ? (EXN[k] || k) : (SEC_NAME.get(k) || "其他"),
      order: mode === "exchange" ? 0 : (SEC_ORDER.has(k) ? SEC_ORDER.get(k) : 99),
      syms,
    }));
    arr.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "zh"));
    return arr;
  }

  function sortSyms(syms) {
    const key = (s) => {
      const d = data[s] || {};
      if (sortBy === "pct") return pctOf(d);
      if (sortBy === "oi") return num(d.oi);
      if (sortBy === "vol") return num(d.vol);
      return null;
    };
    if (sortBy === "name") {
      return syms.slice().sort((a, b) => (meta.get(a)?.n || a).localeCompare(meta.get(b)?.n || b, "zh"));
    }
    return syms.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;           // 无数据的沉底
      if (y == null) return -1;
      return y - x;
    });
  }

  function render(force) {
    if (!root) return;
    if (!meta.size) return;
    const gs = grouped();
    const frag = document.createDocumentFragment();
    for (const g of gs) {
      const syms = sortSyms(g.syms);
      const pcts = syms.map((s) => pctOf(data[s])).filter((v) => v != null);
      const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
      const up = pcts.filter((v) => v > 0).length, dn = pcts.filter((v) => v < 0).length;

      const box = el("div", "sec-group");
      const head = el("div", "sec-ghead");
      const nm = el("span", "sec-gname"); nm.textContent = g.name;
      const av = el("span", "sec-gavg");
      if (avg != null) {
        av.textContent = (avg > 0 ? "+" : "") + avg.toFixed(2) + "%";
        av.style.color = avg > 0 ? "var(--up,#e66767)" : avg < 0 ? "var(--down,#199e70)" : "var(--ink-2,#c3c2b7)";
      } else av.textContent = "—";
      const st = el("span", "sec-gstat");
      st.textContent = `${syms.length} 品种 · 涨 ${up} 跌 ${dn}`;
      head.append(nm, av, st);

      const tiles = el("div", "sec-tiles");
      for (const sym of syms) {
        const m = meta.get(sym) || {}, d = data[sym] || {};
        const pct = pctOf(d), lp = num(d.lp), pre = num(d.pre);
        const chg = lp != null && pre ? lp - pre : null;
        const dg = digitsOf(lp);
        const t = el("div", "sec-tile");
        t.style.background = heatColor(pct);
        t.dataset.sym = sym;
        if (sym === selectedSym) t.classList.add("sel");
        t.innerHTML =
          `<div class="sec-n">${m.n || sym}</div>` +
          `<div class="sec-p">${lp != null ? lp.toFixed(dg) : "—"}</div>` +
          `<div class="sec-c">${pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(2) + "%"}` +
          `${chg == null ? "" : "　" + (chg > 0 ? "+" : "") + chg.toFixed(dg)}</div>` +
          `<div class="sec-x">仓 ${fmtVol(num(d.oi))}　量 ${fmtVol(num(d.vol))}</div>`;
        t.onclick = () => {
          selectedSym = sym;
          root.querySelectorAll(".sec-tile.sel").forEach((x) => x.classList.remove("sel"));
          t.classList.add("sel");
          if (opts.onPick) opts.onPick(sym, m);
        };
        t.oncontextmenu = (e) => { if (opts.onMenu) opts.onMenu(e, sym, m); };
        tiles.appendChild(t);
      }
      box.append(head, tiles);
      frag.appendChild(box);
    }
    els.scroll.innerHTML = "";
    els.scroll.appendChild(frag);
  }

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(false); });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      buildSkeleton();
      if (meta.size) render(true);
      return true;
    },
    setMeta(items) {
      meta = new Map();
      for (const it of items || []) {
        if (!it || !it.s) continue;
        meta.set(it.s, {
          u: it.u, n: it.n || it.s, ex: it.ex || (it.u || "").split(".")[0],
          cats: it.cats || [], catNames: it.catNames || [], night: !!it.night,
        });
      }
      if (root) render(true);
    },
    update(board) {
      if (!board) return;
      prev = data;
      data = Object.assign({}, data, board);
      scheduleRender();
    },
    isMounted() { return !!root; },
    destroy() {
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null; els = {};
    },
  };
})();
