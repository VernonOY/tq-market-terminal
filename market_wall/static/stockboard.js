/* 股票板块 / 指数看板 —— 对齐商业股票终端的「板块」「指数」页
 * 自包含模块: IIFE + 动态注入样式, 只暴露 window.StockBoard
 * 数据全部经 opts.request("fund", {kind, args}) 走 Tushare 适配层
 */
window.StockBoard = (function () {
  "use strict";

  const STYLE_ID = "sb-style";
  const CSS = `
#sb-root{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;min-width:0;
  overflow:hidden;background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#sb-root *{box-sizing:border-box}
.sb-bar{display:flex;align-items:center;gap:8px;padding:7px 12px;flex:0 0 auto;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1));background:var(--surface,#1a1a19)}
.sb-bar button{background:transparent;color:var(--muted,#898781);border:1px solid transparent;
  border-radius:5px;padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.sb-bar button:hover{color:var(--ink-2,#c3c2b7);background:var(--surface-2,#222221)}
.sb-bar button.on{color:var(--ink,#fff);background:var(--surface-2,#222221);
  border-color:var(--border,rgba(255,255,255,.1))}
.sb-sep{width:1px;height:16px;background:var(--border,rgba(255,255,255,.1));margin:0 2px}
.sb-note{margin-left:auto;color:var(--grid,#2c2c2a);font-size:11px}
.sb-body{flex:1 1 auto;min-height:0;display:flex;gap:0}
.sb-main{flex:1 1 auto;min-width:0;min-height:0;overflow:auto}
.sb-side{flex:0 0 300px;min-height:0;overflow:auto;border-left:1px solid var(--border,rgba(255,255,255,.1));padding:8px 10px}
.sb-side.hidden{display:none}
table.sb-t{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px}
table.sb-t th{position:sticky;top:0;z-index:2;background:var(--surface,#1a1a19);
  color:var(--muted,#898781);font-weight:400;font-size:11px;text-align:right;
  padding:5px 10px;white-space:nowrap;cursor:pointer;border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
table.sb-t th:first-child,table.sb-t td:first-child{text-align:left}
table.sb-t th.on{color:var(--ink,#fff)}
table.sb-t td{padding:4px 10px;text-align:right;white-space:nowrap;
  border-bottom:1px solid var(--grid,#2c2c2a)}
table.sb-t tbody tr{cursor:pointer}
table.sb-t tbody tr:hover td{background:var(--surface-2,#222221)}
table.sb-t tbody tr.sel td{background:var(--surface-2,#222221);box-shadow:inset 2px 0 0 var(--ma5,#3987e5)}
.sb-nm{color:var(--ink,#fff);font-weight:600}
.sb-sub{color:var(--muted,#898781);font-size:10px}
.sb-up{color:var(--up,#e66767)} .sb-down{color:var(--down,#199e70)} .sb-flat{color:var(--ink-2,#c3c2b7)}
.sb-pill{display:inline-block;padding:1px 6px;border-radius:10px;font-size:11px;font-weight:600;min-width:56px;text-align:center}
.sb-h{color:var(--muted,#898781);font-size:11px;letter-spacing:.05em;padding:8px 0 6px;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1));margin-bottom:6px}
.sb-msg{padding:36px;text-align:center;color:var(--muted,#898781);font-size:12px}
.sb-tag{display:inline-block;margin:0 5px 5px 0;padding:2px 8px;border-radius:4px;font-size:11px;
  background:var(--surface-2,#222221);border:1px solid var(--border,rgba(255,255,255,.1));cursor:pointer}
.sb-tag:hover{border-color:var(--ma5,#3987e5);color:var(--ink,#fff)}
.sb-tag b{color:var(--muted,#898781);font-weight:400;margin-right:4px}
.sb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:6px;padding:10px 12px}
.sb-card{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:7px;padding:9px 11px;cursor:pointer}
.sb-card:hover{border-color:var(--muted,#898781)}
.sb-c-n{color:var(--ink,#fff);font-weight:600;font-size:12.5px}
.sb-c-p{font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.sb-c-c{font-size:12px;font-variant-numeric:tabular-nums}
.sb-c-x{color:var(--muted,#898781);font-size:10px;font-variant-numeric:tabular-nums;margin-top:3px}
`;

  const KINDS = [
    { k: "dc", label: "东财概念" },
    { k: "sw", label: "申万行业" },
    { k: "ths", label: "同花顺" },
    { k: "hot", label: "涨停主线" },
  ];

  let host = null, root = null, els = {}, opts = {};
  let tab = "sector";          // sector | index
  let kind = "dc";
  let data = { cols: [], rows: [] };
  let sortCol = null, sortDesc = true;
  let selRow = null;
  let loading = false;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "sb-up" : v < 0 ? "sb-down" : "sb-flat");
  function fmtAmt(v) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
    if (a >= 1e4) return (n / 1e4).toFixed(1) + "万";
    return n.toFixed(0);
  }
  function pct(v, d) {
    const n = num(v);
    return n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(d == null ? 2 : d) + "%";
  }
  function idxOf(cols, name) { return cols.indexOf(name); }

  function build() {
    root = el("div"); root.id = "sb-root";
    const bar = el("div", "sb-bar");
    for (const [k, label] of [["sector", "板块"], ["index", "指数"]]) {
      const b = el("button"); b.textContent = label; b.dataset.tab = k;
      if (k === tab) b.className = "on";
      b.onclick = () => { tab = k; syncBar(); load(); };
      bar.appendChild(b);
    }
    bar.appendChild(el("div", "sb-sep"));
    els.kinds = el("span");
    for (const K of KINDS) {
      const b = el("button"); b.textContent = K.label; b.dataset.kind = K.k;
      if (K.k === kind) b.className = "on";
      b.onclick = () => { kind = K.k; sortCol = null; syncBar(); load(); };
      els.kinds.appendChild(b);
    }
    bar.appendChild(els.kinds);
    els.note = el("span", "sb-note");
    bar.appendChild(els.note);

    const body = el("div", "sb-body");
    els.main = el("div", "sb-main");
    els.side = el("div", "sb-side hidden");
    body.append(els.main, els.side);
    root.append(bar, body);
    host.innerHTML = "";
    host.appendChild(root);
    els.bar = bar;
    syncBar();
  }
  function syncBar() {
    els.bar.querySelectorAll("button[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    els.kinds.style.display = tab === "sector" ? "" : "none";
    els.kinds.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
    if (tab !== "sector") els.side.classList.add("hidden");
  }

  async function ask(k, args) {
    if (!opts.request) throw new Error("未接入数据通道");
    const r = await opts.request("fund", { kind: k, args: args || {} });
    return { cols: r.cols || [], rows: r.rows || [] };
  }

  async function load() {
    if (loading) return;
    loading = true;
    els.main.innerHTML = '<div class="sb-msg">加载中…</div>';
    els.note.textContent = "";
    try {
      if (tab === "index") {
        data = await ask("indices", {});
        renderIndex();
      } else if (kind === "hot") {
        data = await ask("hot_concepts", {});
        renderTable(HOT_COLS);
      } else {
        data = await ask("sectors", { kind });
        renderTable(kind === "dc" ? DC_COLS : kind === "sw" ? SW_COLS : THS_COLS);
      }
    } catch (e) {
      els.main.innerHTML = `<div class="sb-msg">加载失败: ${e.message}</div>`;
    } finally { loading = false; }
  }

  /* 各口径的列定义: [数据列名, 表头, 渲染器] */
  const R = {
    name: (v, row, cols) => `<span class="sb-nm">${v == null ? "—" : v}</span>`,
    pct: (v) => `<span class="sb-pill ${cls(num(v))}">${pct(v)}</span>`,
    px: (v) => (num(v) == null ? "—" : num(v).toFixed(2)),
    amt: (v) => fmtAmt(v),
    // moneyflow_ind_dc.net_amount 单位是元
    net: (v) => {
      const n = num(v);
      return n == null ? "—" : `<span class="${cls(n)}">${fmtAmt(n)}</span>`;
    },
    // dc_index.total_mv / sw_daily.float_mv 单位是万元
    mv: (v) => (num(v) == null ? "—" : fmtAmt(num(v) * 1e4)),
    lead: (v, row, cols) => {
      const p = num(row[idxOf(cols, "leading_pct")]);
      return v == null ? "—" : `${v} <span class="${cls(p)}">${pct(p)}</span>`;
    },
    raw: (v) => (v == null || v === "" ? "—" : String(v)),
    int: (v) => (num(v) == null ? "—" : num(v).toFixed(0)),
  };
  const DC_COLS = [
    ["name", "板块", R.name], ["pct_change", "涨跌幅", R.pct],
    ["net_amount", "主力净额", R.net], ["leading", "领涨股", R.lead],
    ["up_num", "涨", R.int], ["down_num", "跌", R.int],
    ["turnover_rate", "换手%", R.px], ["total_mv", "总市值", R.mv],
  ];
  const SW_COLS = [
    ["name", "行业", R.name], ["pct_change", "涨跌幅", R.pct],
    ["close", "点位", R.px], ["amount", "成交额", R.mv],
    ["pe", "PE", R.px], ["pb", "PB", R.px], ["float_mv", "流通市值", R.mv],
  ];
  const THS_COLS = [
    ["name", "板块", R.name], ["pct_change", "涨跌幅", R.pct],
    ["close", "点位", R.px], ["turnover_rate", "换手%", R.px],
    ["pe", "PE", R.px], ["count", "成分数", R.int],
  ];
  const HOT_COLS = [
    ["name", "板块", R.name], ["days", "连板天数", R.int],
    ["up_stat", "涨停统计", R.raw], ["cons_nums", "连板数", R.raw],
    ["up_nums", "涨停家数", R.int], ["pct_chg", "涨跌幅", R.pct],
  ];

  function renderTable(spec) {
    const cols = data.cols;
    let rows = data.rows.slice();
    if (sortCol != null) {
      const ci = idxOf(cols, sortCol);
      if (ci >= 0) rows.sort((a, b) => {
        const x = num(a[ci]), y = num(b[ci]);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return sortDesc ? y - x : x - y;
      });
    }
    if (!rows.length) { els.main.innerHTML = '<div class="sb-msg">没有数据</div>'; return; }
    const t = el("table", "sb-t");
    const thead = el("thead"), tr = el("tr");
    for (const [key, label] of spec) {
      const th = el("th");
      th.textContent = label + (sortCol === key ? (sortDesc ? " ▼" : " ▲") : "");
      if (sortCol === key) th.className = "on";
      th.onclick = () => {
        if (sortCol === key) sortDesc = !sortDesc; else { sortCol = key; sortDesc = true; }
        renderTable(spec);
      };
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    const tb = el("tbody");
    for (const row of rows) {
      const r = el("tr");
      if (selRow && row[idxOf(cols, "ts_code")] === selRow) r.className = "sel";
      for (const [key, , render] of spec) {
        const td = el("td");
        const ci = idxOf(cols, key);
        td.innerHTML = render(ci >= 0 ? row[ci] : null, row, cols);
        r.appendChild(td);
      }
      r.onclick = () => {
        selRow = row[idxOf(cols, "ts_code")];
        renderTable(spec);
        showMembers(selRow, row[idxOf(cols, "name")]);
      };
      tb.appendChild(r);
    }
    t.append(thead, tb);
    els.main.innerHTML = "";
    els.main.appendChild(t);
    els.note.textContent = `${rows.length} 个板块 · 点击看成分股`;
  }

  async function showMembers(code, name) {
    if (kind === "hot") return;
    els.side.classList.remove("hidden");
    els.side.innerHTML = `<div class="sb-h">${name || code} · 成分股</div><div class="sb-msg">加载中…</div>`;
    try {
      const r = await ask("sector_members", { ts_code: code, kind });
      if (!r.rows.length) {
        els.side.innerHTML = `<div class="sb-h">${name || code} · 成分股</div>` +
          '<div class="sb-msg">该口径没有返回成分股</div>';
        return;
      }
      const ci = r.cols.indexOf("con_code") >= 0 ? r.cols.indexOf("con_code") : 0;
      const ni = r.cols.indexOf("con_name") >= 0 ? r.cols.indexOf("con_name") : r.cols.indexOf("name");
      const box = el("div");
      box.innerHTML = `<div class="sb-h">${name || code} · ${r.rows.length} 只成分股</div>`;
      for (const row of r.rows.slice(0, 200)) {
        const tag = el("span", "sb-tag");
        tag.innerHTML = `<b>${row[ci]}</b>${ni >= 0 ? (row[ni] || "") : ""}`;
        tag.onclick = () => { if (opts.onPickStock) opts.onPickStock(row[ci]); };
        box.appendChild(tag);
      }
      els.side.innerHTML = "";
      els.side.appendChild(box);
    } catch (e) {
      els.side.innerHTML = `<div class="sb-msg">成分股加载失败: ${e.message}</div>`;
    }
  }

  function renderIndex() {
    const c = data.cols, rows = data.rows;
    if (!rows.length) { els.main.innerHTML = '<div class="sb-msg">没有数据</div>'; return; }
    const g = el("div", "sb-grid");
    for (const row of rows) {
      const get = (k) => { const i = idxOf(c, k); return i >= 0 ? row[i] : null; };
      const p = num(get("pct_chg")), close = num(get("close"));
      const card = el("div", "sb-card");
      card.innerHTML =
        `<div class="sb-c-n">${get("name")}</div>` +
        `<div class="sb-c-p ${cls(p)}">${close == null ? "—" : close.toFixed(2)}</div>` +
        `<div class="sb-c-c ${cls(p)}">${pct(p)}　${num(get("change")) == null ? "" : (num(get("change")) > 0 ? "+" : "") + num(get("change")).toFixed(2)}</div>` +
        `<div class="sb-c-x">额 ${fmtAmt(num(get("amount")) * 1000)}　PE ${num(get("pe_ttm")) == null ? "—" : num(get("pe_ttm")).toFixed(1)}　PB ${num(get("pb")) == null ? "—" : num(get("pb")).toFixed(2)}</div>`;
      card.onclick = () => { if (opts.onPickIndex) opts.onPickIndex(get("ts_code"), get("name")); };
      g.appendChild(card);
    }
    els.main.innerHTML = "";
    els.main.appendChild(g);
    els.note.textContent = "指数日线口径 · 点击在主图查看";
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      build();
      load();
      return true;
    },
    show(t) { if (t && t !== tab) { tab = t; syncBar(); load(); } },
    refresh() { load(); },
    isMounted() { return !!root; },
    destroy() {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null; els = {};
    },
  };
})();
