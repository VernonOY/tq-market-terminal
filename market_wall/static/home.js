/* 首页 · 市场总览 —— 一屏看清全市场今天在发生什么
 * 自包含模块: IIFE + 动态注入样式, 只暴露 window.HomeView
 * 期货部分用实时 board 推送(WS), A股部分走 Tushare(日频, 盘中回退到上一交易日)
 */
window.HomeView = (function () {
  "use strict";

  const STYLE_ID = "hm-style";
  const CSS = `
#hm-root{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:12px 14px 28px;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#hm-root *{box-sizing:border-box}
.hm-sec{margin-bottom:18px}
.hm-h{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.hm-h b{color:var(--ink,#fff);font-size:14px}
.hm-h span{color:var(--muted,#898781);font-size:11px}
.hm-h a{margin-left:auto;color:var(--ma5,#3987e5);font-size:11px;cursor:pointer;text-decoration:none}
.hm-h a:hover{text-decoration:underline}
.hm-idx{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:6px}
.hm-card{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:7px;padding:8px 10px;cursor:pointer}
.hm-card:hover{border-color:var(--muted,#898781)}
.hm-n{color:var(--ink,#fff);font-weight:600;font-size:12.5px}
.hm-p{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
.hm-c{font-size:11.5px;font-variant-numeric:tabular-nums}
.hm-x{color:var(--muted,#898781);font-size:10px;font-variant-numeric:tabular-nums;margin-top:2px}
.hm-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:5px}
.hm-tile{border-radius:6px;padding:6px 8px;cursor:pointer;border:1px solid transparent;overflow:hidden}
.hm-tile:hover{border-color:var(--ink-2,#c3c2b7)}
.hm-tn{color:#fff;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hm-tp{color:#fff;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.hm-tc{color:rgba(255,255,255,.85);font-size:11px;font-variant-numeric:tabular-nums}
.hm-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:1100px){.hm-two{grid-template-columns:1fr}}
table.hm-t{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
table.hm-t th{color:var(--muted,#898781);font-weight:400;font-size:11px;text-align:right;
  padding:4px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
table.hm-t th:first-child,table.hm-t td:first-child{text-align:left}
table.hm-t td{padding:3px 8px;text-align:right;border-bottom:1px solid var(--grid,#2c2c2a);white-space:nowrap}
table.hm-t tbody tr{cursor:pointer}
table.hm-t tbody tr:hover td{background:var(--surface-2,#222221)}
.hm-up{color:var(--up,#e66767)} .hm-down{color:var(--down,#199e70)} .hm-flat{color:var(--ink-2,#c3c2b7)}
.hm-msg{color:var(--muted,#898781);font-size:12px;padding:14px}
.hm-bd{display:flex;height:16px;border-radius:3px;overflow:hidden;background:var(--surface-2,#222221)}
.hm-bd i{display:block;height:100%}
.hm-bdl{display:flex;justify-content:space-between;font-size:11px;margin-top:3px;
  font-variant-numeric:tabular-nums}
`;

  let host = null, root = null, opts = {};
  const board = {};
let meta = new Map(), quotes = {};
  let raf = 0, loadedOnce = false;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "hm-up" : v < 0 ? "hm-down" : "hm-flat");
  const pct = (v) => (num(v) == null ? "—" : (v > 0 ? "+" : "") + (+v).toFixed(2) + "%");
  function amt(v) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    return a >= 1e8 ? (n / 1e8).toFixed(1) + "亿" : a >= 1e4 ? (n / 1e4).toFixed(0) + "万" : n.toFixed(0);
  }
  function dg(v) {
    if (v == null) return 2;
    const a = Math.abs(v);
    return a >= 5000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  }
  function heat(p) {
    if (p == null) return "rgba(255,255,255,.04)";
    const t = Math.max(-1, Math.min(1, p / 3)), a = Math.abs(t);
    if (a < 0.02) return "rgba(255,255,255,.05)";
    const [r, g, b] = t > 0 ? [230, 103, 103] : [25, 158, 112];
    return `rgba(${r},${g},${b},${(0.14 + 0.72 * a).toFixed(3)})`;
  }
  function sec(title, note, linkLabel, linkTo) {
    const s = el("div", "hm-sec");
    const h = el("div", "hm-h");
    h.innerHTML = `<b>${title}</b><span>${note || ""}</span>`;
    if (linkLabel) {
      const a = el("a");
      a.textContent = linkLabel + " →";
      a.onclick = () => opts.onGoto && opts.onGoto(linkTo);
      h.appendChild(a);
    }
    s.appendChild(h);
    return s;
  }

  /* ---------- 期货: 板块热力 + 涨跌幅榜(实时, 来自 board 推送) ---------- */
  function futureBlock() {
    const s = sec("期货 · 板块与异动", "实时", "分区热力", "sector");
    if (!meta.size) { s.appendChild(Object.assign(el("div", "hm-msg"), { textContent: "正在订阅主力合约…" })); return s; }
    const rows = [];
    for (const [sym, m] of meta) {
      const d = board[sym];
      const lp = num(d && d.lp), pre = num(d && d.pre);
      if (lp == null || !pre) continue;
      rows.push({ sym, name: m.n, pct: (lp - pre) / pre * 100, lp, oi: num(d.oi), vol: num(d.vol),
                  cat: (m.catNames && m.catNames[0]) || "其他" });
    }
    if (!rows.length) { s.appendChild(Object.assign(el("div", "hm-msg"), { textContent: "等待行情…" })); return s; }
    rows.sort((a, b) => b.pct - a.pct);
    // 板块均值
    const byCat = new Map();
    for (const r of rows) {
      if (!byCat.has(r.cat)) byCat.set(r.cat, []);
      byCat.get(r.cat).push(r.pct);
    }
    const cats = [...byCat.entries()]
      .map(([k, v]) => ({ k, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
      .sort((a, b) => b.avg - a.avg);
    const tiles = el("div", "hm-tiles");
    for (const c of cats) {
      const t = el("div", "hm-tile");
      t.style.background = heat(c.avg);
      t.innerHTML = `<div class="hm-tn">${c.k}</div><div class="hm-tp">${pct(c.avg)}</div>` +
        `<div class="hm-tc">${c.n} 品种</div>`;
      t.onclick = () => opts.onGoto && opts.onGoto("sector");
      tiles.appendChild(t);
    }
    s.appendChild(tiles);
    // 涨跌榜
    const two = el("div", "hm-two");
    two.style.marginTop = "10px";
    two.append(rankTable("涨幅榜", rows.slice(0, 8)), rankTable("跌幅榜", rows.slice(-8).reverse()));
    s.appendChild(two);
    return s;
  }
  function rankTable(title, rows) {
    const box = el("div");
    box.innerHTML = `<div class="hm-h"><b style="font-size:12.5px">${title}</b></div>`;
    const t = el("table", "hm-t");
    t.innerHTML = "<thead><tr><th>品种</th><th>最新</th><th>涨跌幅</th><th>持仓</th></tr></thead>";
    const tb = el("tbody");
    for (const r of rows) {
      const tr = el("tr");
      tr.innerHTML = `<td><b style="color:var(--ink,#fff)">${r.name}</b></td>` +
        `<td>${r.lp.toFixed(dg(r.lp))}</td>` +
        `<td class="${cls(r.pct)}">${pct(r.pct)}</td><td>${amt(r.oi)}</td>`;
      tr.onclick = () => opts.onPick && opts.onPick(r.sym);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    box.appendChild(t);
    return box;
  }

  /* ---------- A股: 指数 + 涨跌停 + 热门板块(Tushare 日频) ---------- */
  async function ask(kind, args) {
    const r = await opts.request("fund", { kind, args: args || {} });
    return { cols: r.cols || [], rows: r.rows || [] };
  }
  async function stockBlocks(container) {
    const idxSec = sec("A股 · 指数", "日线口径", "全部指数", "sindex");
    const grid = el("div", "hm-idx");
    grid.innerHTML = '<div class="hm-msg">加载中…</div>';
    idxSec.appendChild(grid);
    container.appendChild(idxSec);

    const secSec = sec("A股 · 板块与情绪", "", "全部板块", "sboard");
    const two = el("div", "hm-two");
    const left = el("div"), right = el("div");
    left.innerHTML = '<div class="hm-msg">加载中…</div>';
    right.innerHTML = '<div class="hm-msg">加载中…</div>';
    two.append(left, right);
    secSec.appendChild(two);
    container.appendChild(secSec);

    try {
      const r = await ask("indices", {});
      const c = r.cols;
      const gi = (row, k) => { const i = c.indexOf(k); return i >= 0 ? row[i] : null; };
      grid.innerHTML = "";
      for (const row of r.rows) {
        const p = num(gi(row, "pct_chg")), close = num(gi(row, "close"));
        const card = el("div", "hm-card");
        card.innerHTML = `<div class="hm-n">${gi(row, "name")}</div>` +
          `<div class="hm-p ${cls(p)}">${close == null ? "—" : close.toFixed(2)}</div>` +
          `<div class="hm-c ${cls(p)}">${pct(p)}</div>` +
          `<div class="hm-x">额 ${amt(num(gi(row, "amount")) * 1000)}　PE ${num(gi(row, "pe_ttm")) == null ? "—" : (+gi(row, "pe_ttm")).toFixed(1)}</div>`;
        card.onclick = () => opts.onGoto && opts.onGoto("sindex");
        grid.appendChild(card);
      }
      if (!r.rows.length) grid.innerHTML = '<div class="hm-msg">暂无数据</div>';
    } catch (e) {
      grid.innerHTML = `<div class="hm-msg">指数加载失败: ${e.message}</div>`;
    }

    try {
      const r = await ask("sectors", { kind: "dc" });
      const c = r.cols;
      const gi = (row, k) => { const i = c.indexOf(k); return i >= 0 ? row[i] : null; };
      const top = r.rows.slice(0, 10);
      left.innerHTML = '<div class="hm-h"><b style="font-size:12.5px">领涨概念</b></div>';
      const t = el("table", "hm-t");
      t.innerHTML = "<thead><tr><th>板块</th><th>涨跌幅</th><th>主力净额</th><th>领涨股</th></tr></thead>";
      const tb = el("tbody");
      for (const row of top) {
        const p = num(gi(row, "pct_change")), na = num(gi(row, "net_amount"));
        const tr = el("tr");
        tr.innerHTML = `<td><b style="color:var(--ink,#fff)">${gi(row, "name")}</b></td>` +
          `<td class="${cls(p)}">${pct(p)}</td><td class="${cls(na)}">${amt(na)}</td>` +
          `<td>${gi(row, "leading") || "—"}</td>`;
        tr.onclick = () => opts.onGoto && opts.onGoto("sboard");
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      left.appendChild(t);
    } catch (e) {
      left.innerHTML = `<div class="hm-msg">板块加载失败: ${e.message}</div>`;
    }

    try {
      const r = await ask("hot_concepts", {});
      const c = r.cols;
      const gi = (row, k) => { const i = c.indexOf(k); return i >= 0 ? row[i] : null; };
      right.innerHTML = '<div class="hm-h"><b style="font-size:12.5px">涨停主线</b></div>';
      const t = el("table", "hm-t");
      t.innerHTML = "<thead><tr><th>板块</th><th>涨停家数</th><th>连板</th><th>涨跌幅</th></tr></thead>";
      const tb = el("tbody");
      for (const row of r.rows.slice(0, 10)) {
        const p = num(gi(row, "pct_chg"));
        const tr = el("tr");
        tr.innerHTML = `<td><b style="color:var(--ink,#fff)">${gi(row, "name")}</b></td>` +
          `<td>${gi(row, "up_nums") ?? "—"}</td><td>${gi(row, "up_stat") || "—"}</td>` +
          `<td class="${cls(p)}">${pct(p)}</td>`;
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      right.appendChild(t);
      if (!r.rows.length) right.innerHTML = '<div class="hm-msg">暂无数据</div>';
    } catch (e) {
      right.innerHTML = `<div class="hm-msg">涨停主线加载失败: ${e.message}</div>`;
    }
  }

  function render() {
    if (!root) return;
    const old = root.querySelector("[data-blk=fut]");
    if (!old) return;
    const next = futureBlock();
    next.dataset.blk = "fut";          // dataset 是只读访问器, 只能逐键赋值
    old.replaceWith(next);
  }
  function visible() {
    const w = document.getElementById("home-wrap");
    return w && !w.classList.contains("hidden");
  }
  function scheduleRender() {
    if (raf || !visible()) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      root = el("div"); root.id = "hm-root";
      const f = futureBlock();
      f.dataset.blk = "fut";
      root.appendChild(f);
      host.innerHTML = "";
      host.appendChild(root);
      if (!loadedOnce) { loadedOnce = true; stockBlocks(root); }
      return true;
    },
    /* 每次 data 推送调 */
    update(b, q) {
      if (b) Object.assign(board, b);      // 累积: 不在首页时也存着, 切回来立刻有数
      if (q) quotes = q;
      scheduleRender();
    },
    setMeta(items) {
      meta = new Map();
      for (const it of items || []) if (it && it.s) meta.set(it.s, it);
      if (root) scheduleRender();
    },
    refresh() { if (root) { render(); } },
    isMounted() { return !!root; },
    destroy() {
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
