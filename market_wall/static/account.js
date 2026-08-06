/* 交易 · 账户监控
 * 只读监控: 权益/风险度/持仓/委托/成交。刻意不提供任何下单或撤单入口 ——
 * 盯盘面板和下单通道混在一条 WS 协议里, 一次前端 bug 就可能变成一笔真实交易。
 * 自包含: IIFE + 注入样式, 只暴露 window.AccountView
 */
window.AccountView = (function () {
  "use strict";

  const STYLE_ID = "ac-style";
  const CSS = `
#ac-root{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:10px 14px 30px;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#ac-root *{box-sizing:border-box}
.ac-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.ac-tab{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:7px;padding:5px 12px;cursor:pointer;min-width:150px}
.ac-tab:hover{border-color:var(--muted,#898781)}
.ac-tab.on{border-color:var(--ma5,#3987e5)}
.ac-tab.real{border-color:rgba(230,103,103,.55)}
.ac-tab .n{color:var(--ink,#fff);font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px}
.ac-tab .b{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.ac-tab .d{font-size:11px;font-variant-numeric:tabular-nums}
.ac-badge{font-size:9.5px;padding:0 4px;border-radius:3px;font-weight:400}
.ac-badge.sim{background:var(--surface-2,#222221);color:var(--muted,#898781)}
.ac-badge.real{background:rgba(230,103,103,.22);color:var(--up,#e66767)}
.ac-badge.err{background:rgba(230,103,103,.22);color:var(--up,#e66767)}
.ac-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:6px;margin-bottom:12px}
.ac-c{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:7px;padding:7px 10px;transition:background .2s}
.ac-c .k{color:var(--muted,#898781);font-size:10.5px}
.ac-c .v{color:var(--ink,#fff);font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ac-c.big{grid-column:span 2}
.ac-c.big .v{font-size:23px}
.ac-c.f-up{background:rgba(230,103,103,.14)}
.ac-c.f-down{background:rgba(25,158,112,.14)}
.ac-c.warn{border-color:var(--up,#e66767)}
.ac-sec{margin-bottom:12px;border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;background:var(--surface,#1a1a19);overflow:hidden}
.ac-h{display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
.ac-h b{color:var(--ink,#fff);font-size:12.5px}
.ac-h .cnt{color:var(--muted,#898781);font-size:11px}
.ac-h .caret{color:var(--muted,#898781);font-size:10px;transition:transform .12s}
.ac-sec.fold .caret{transform:rotate(-90deg)}
.ac-sec.fold .ac-b{display:none}
.ac-b{overflow-x:auto}
table.ac-t{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
table.ac-t th{color:var(--muted,#898781);font-weight:400;font-size:11px;text-align:right;
  padding:4px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));
  white-space:nowrap;cursor:pointer;user-select:none}
table.ac-t th:hover{color:var(--ink-2,#c3c2b7)}
table.ac-t th.s{color:var(--ink,#fff)}
table.ac-t th:first-child,table.ac-t td:first-child{text-align:left}
table.ac-t td{padding:3px 8px;text-align:right;border-bottom:1px solid var(--grid,#2c2c2a);white-space:nowrap}
table.ac-t tbody tr:hover td{background:var(--surface-2,#222221)}
table.ac-t .sym{color:var(--ink,#fff);cursor:pointer}
table.ac-t .sym:hover{text-decoration:underline}
.ac-dir-l{color:var(--up,#e66767)}.ac-dir-s{color:var(--down,#199e70)}
.ac-up{color:var(--up,#e66767)}.ac-down{color:var(--down,#199e70)}.ac-flat{color:var(--ink-2,#c3c2b7)}
.ac-empty{padding:16px 12px;color:var(--muted,#898781);font-size:12px;text-align:center}
.ac-guide{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;padding:14px 16px;line-height:1.7}
.ac-guide h3{color:var(--ink,#fff);font-size:14px;margin-bottom:6px}
.ac-guide pre{background:var(--surface-2,#222221);border-radius:6px;padding:10px;
  margin:8px 0;overflow-x:auto;font:11.5px/1.5 ui-monospace,Menlo,monospace;color:var(--ink-2,#c3c2b7)}
.ac-note{color:var(--muted,#898781);font-size:11px;padding:4px 12px 8px}
`;

  let host = null, root = null, opts = {};
  let accounts = [], snap = {}, curId = null, raf = 0;
  let fold = { ord: true, trd: true };
  let sortPos = { k: "margin", d: -1 };
  let trades = null, tradesFor = null;
  let orders = null, ordersFor = null;

  try { fold = Object.assign(fold, JSON.parse(localStorage.getItem("mw:acfold") || "{}")); } catch (e) { /* 忽略 */ }

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "ac-up" : v < 0 ? "ac-down" : "ac-flat");
  function money(v, d) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
    if (a >= 1e4) return (n / 1e4).toFixed(2) + "万";
    return n.toFixed(d == null ? 2 : d);
  }
  function signed(v) {
    const n = num(v);
    if (n == null) return "—";
    return (n > 0 ? "+" : "") + money(n);
  }
  function pct(v, d) {
    const n = num(v);
    return n == null ? "—" : (n * 100).toFixed(d == null ? 2 : d) + "%";
  }
  function visible() {
    /* ⚠️ 不能再按容器 id 判断: 本视图早就改挂在交易页(#trade-wrap)里了,
       #acct-wrap 已不存在 —— getElementById 返回 null, visible() 恒 false,
       于是每帧的增量刷新被静默跳过, 表面症状是「点一下才更新一下」。
       改成看自己的根节点: 在文档里、且有实际布局盒, 就算可见。
       这样以后容器再怎么改名/搬家都不会把刷新悄悄关掉。 */
    if (!root || !root.isConnected) return false;
    return !!(root.offsetParent || root.getClientRects().length);
  }
  function cur() { return snap[curId] || null; }
  function accMeta(id) { return accounts.find((a) => a.id === id) || null; }

  /* ---------------- 账户切换条 ---------------- */
  function buildTabs() {
    const bar = el("div", "ac-tabs");
    for (const a of accounts) {
      const s = snap[a.id] || {};
      const sum = s.sum || {};
      const t = el("div", "ac-tab" + (a.id === curId ? " on" : "") + (a.kind === "real" ? " real" : ""));
      t.dataset.id = a.id;
      const real = a.kind === "real";
      const badge = !a.ok ? '<span class="ac-badge err">未连接</span>'
        : real ? '<span class="ac-badge real">实盘</span>'
          : '<span class="ac-badge sim">模拟</span>';
      const day = (num(sum.balance) != null && num(sum.pre_balance) != null)
        ? sum.balance - sum.pre_balance : null;
      t.innerHTML = `<div class="n">${a.name || a.id}${badge}</div>` +
        `<div class="b">${money(sum.balance)}</div>` +
        `<div class="d ${cls(day)}">当日 ${signed(day)}</div>`;
      t.onclick = () => { curId = a.id; trades = orders = null; build(); };
      bar.appendChild(t);
    }
    return bar;
  }

  /* ---------------- 指标卡 ---------------- */
  const CARDS = [
    ["day", "当日盈亏", true],
    ["balance", "账户权益"],
    ["available", "可用资金"],
    ["margin", "保证金占用"],
    ["risk_ratio", "风险度"],
    ["float_profit", "浮动盈亏"],
    ["position_profit", "持仓盈亏"],
    ["close_profit", "平仓盈亏"],
    ["commission", "手续费"],
    ["static_balance", "静态权益"],
  ];
  function cardValue(sum, k) {
    if (k === "day") {
      const a = num(sum.balance), b = num(sum.pre_balance);
      return (a == null || b == null) ? null : a - b;
    }
    return num(sum[k]);
  }
  function buildCards() {
    const g = el("div", "ac-cards");
    const sum = (cur() && cur().sum) || {};
    for (const [k, label, big] of CARDS) {
      const c = el("div", "ac-c" + (big ? " big" : ""));
      c.dataset.k = k;
      c.innerHTML = `<div class="k">${label}</div><div class="v">—</div>`;
      g.appendChild(c);
    }
    paintCards(g, sum, true);
    return g;
  }
  function paintCards(scope, sum, force) {
    for (const c of scope.querySelectorAll(".ac-c")) {
      const k = c.dataset.k;
      const v = cardValue(sum, k);
      const box = c.querySelector(".v");
      const prev = box.textContent;
      let txt, color = "";
      if (k === "risk_ratio") {
        txt = pct(v);
        c.classList.toggle("warn", v != null && v >= 0.8);
      } else if (k === "day" || k === "float_profit" || k === "position_profit" || k === "close_profit") {
        txt = signed(v);
        color = cls(v);
      } else {
        txt = money(v);
      }
      box.textContent = txt;
      box.className = "v " + color;
      if (!force && prev !== txt && prev !== "—" && (k === "day" || k === "risk_ratio")) {
        const a = parseFloat(String(prev).replace(/[^\d.\-]/g, ""));
        const b = parseFloat(String(txt).replace(/[^\d.\-]/g, ""));
        if (isFinite(a) && isFinite(b) && a !== b) {
          c.classList.remove("f-up", "f-down");
          void c.offsetWidth;                       // 强制重排, 否则连续同向变化不闪
          c.classList.add(b > a ? "f-up" : "f-down");
        }
      }
    }
  }

  /* ---------------- 持仓 ---------------- */
  const POS_COLS = [
    ["symbol", "合约"], ["dir", "方向"], ["today", "今仓"], ["his", "昨仓"], ["vol", "总量"],
    ["open", "开仓均价"], ["last", "最新价"], ["fp", "浮动盈亏"], ["fpr", "盈亏比例"],
    ["margin", "保证金"],
  ];
  /* 一个合约同时有多空时拆成两行 —— 合并显示会把净头寸算错方向 */
  function posRows() {
    const c = cur();
    const out = [];
    for (const p of (c && c.pos) || []) {
      if (num(p.pos_long)) {
        out.push({
          symbol: p.symbol, dir: "多", long: true,
          today: num(p.pos_long_today) || 0,
          his: (num(p.pos_long) || 0) - (num(p.pos_long_today) || 0),
          vol: num(p.pos_long), open: num(p.open_price_long),
          last: num(p.last_price), fp: num(p.float_profit_long),
          fpr: num(p.float_profit_r), margin: num(p.margin_long),
        });
      }
      if (num(p.pos_short)) {
        out.push({
          symbol: p.symbol, dir: "空", long: false,
          today: num(p.pos_short_today) || 0,
          his: (num(p.pos_short) || 0) - (num(p.pos_short_today) || 0),
          vol: num(p.pos_short), open: num(p.open_price_short),
          last: num(p.last_price), fp: num(p.float_profit_short),
          fpr: num(p.float_profit_r), margin: num(p.margin_short),
        });
      }
      // 后端只给了合计浮盈时的兜底: 单边持仓直接用合计值
      const last = out[out.length - 1];
      if (last && last.fp == null) last.fp = num(p.float_profit);
      if (last && last.margin == null) last.margin = num(p.margin);
    }
    const k = sortPos.k, d = sortPos.d;
    out.sort((a, b) => {
      const x = a[k], y = b[k];
      if (typeof x === "string" || typeof y === "string")
        return String(x).localeCompare(String(y), "zh") * d;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * d;
    });
    return out;
  }
  function buildPos() {
    const sec = el("div", "ac-sec");
    const rows = posRows();
    const h = el("div", "ac-h");
    h.innerHTML = `<span class="caret">▼</span><b>持仓</b><span class="cnt">${rows.length} 条</span>`;
    sec.appendChild(h);
    const b = el("div", "ac-b");
    if (!rows.length) {
      b.appendChild(Object.assign(el("div", "ac-empty"), { textContent: "当前无持仓" }));
      sec.appendChild(b);
      return sec;
    }
    const t = el("table", "ac-t");
    const tr = el("tr");
    for (const [k, label] of POS_COLS) {
      const th = el("th", sortPos.k === k ? "s" : "");
      th.textContent = label + (sortPos.k === k ? (sortPos.d > 0 ? " ▲" : " ▼") : "");
      th.onclick = () => {
        if (sortPos.k === k) sortPos.d = -sortPos.d; else { sortPos.k = k; sortPos.d = -1; }
        build();
      };
      tr.appendChild(th);
    }
    const thead = el("thead"); thead.appendChild(tr); t.appendChild(thead);
    const tb = el("tbody");
    for (const r of rows) {
      const x = el("tr");
      x.dataset.key = r.symbol + "|" + r.dir;
      x.innerHTML = POS_COLS.map(() => "<td>—</td>").join("");
      paintPosRow(x, r);
      const sy = x.querySelector(".sym");
      if (sy) sy.onclick = () => opts.onPick && opts.onPick(r.symbol);
      tb.appendChild(x);
    }
    t.appendChild(tb);
    b.appendChild(t);
    sec.appendChild(b);
    return sec;
  }
  function paintPosRow(x, r) {
    const td = x.children;
    td[0].innerHTML = `<span class="sym">${r.symbol}</span>`;
    td[1].textContent = r.dir;
    td[1].className = r.long ? "ac-dir-l" : "ac-dir-s";
    td[2].textContent = r.today || "";
    td[3].textContent = r.his || "";
    td[4].textContent = r.vol == null ? "—" : r.vol;
    td[5].textContent = r.open == null ? "—" : r.open.toFixed(2);
    td[6].textContent = r.last == null ? "—" : r.last.toFixed(2);
    td[7].textContent = signed(r.fp); td[7].className = cls(r.fp);
    td[8].textContent = r.fpr == null ? "—" : pct(r.fpr); td[8].className = cls(r.fpr);
    td[9].textContent = money(r.margin);
  }

  /* ---------------- 委托 / 成交(折叠, 按需拉) ---------------- */
  function buildTable(key, title, cols, rows, note) {
    const sec = el("div", "ac-sec" + (fold[key] ? " fold" : ""));
    const h = el("div", "ac-h");
    h.innerHTML = `<span class="caret">▼</span><b>${title}</b>` +
      `<span class="cnt">${rows ? rows.length + " 条" : "点击展开"}</span>`;
    h.onclick = () => {
      fold[key] = !fold[key];
      try { localStorage.setItem("mw:acfold", JSON.stringify(fold)); } catch (e) { /* 忽略 */ }
      sec.classList.toggle("fold");
      if (!fold[key]) loadTable(key);
    };
    sec.appendChild(h);
    const b = el("div", "ac-b");
    if (!rows) {
      b.appendChild(Object.assign(el("div", "ac-empty"), { textContent: "加载中…" }));
    } else if (!rows.length) {
      b.appendChild(Object.assign(el("div", "ac-empty"), { textContent: "暂无记录" }));
    } else {
      const t = el("table", "ac-t");
      const tr = el("tr");
      for (const c of cols) tr.appendChild(Object.assign(el("th"), { textContent: COL_LABEL[c] || c }));
      const thead = el("thead"); thead.appendChild(tr); t.appendChild(thead);
      const tb = el("tbody");
      for (const r of rows.slice(0, 300)) {
        const x = el("tr");
        for (let i = 0; i < cols.length; i++) {
          const td = el("td");
          fmtCell(td, cols[i], r[i]);
          x.appendChild(td);
        }
        tb.appendChild(x);
      }
      t.appendChild(tb);
      b.appendChild(t);
    }
    if (note) b.appendChild(Object.assign(el("div", "ac-note"), { textContent: note }));
    sec.appendChild(b);
    return sec;
  }
  const COL_LABEL = {
    trade_date_time: "时间", insert_date_time: "时间", symbol: "合约", direction: "方向",
    offset: "开平", price: "成交价", volume: "手数", trade_id: "成交号", order_id: "委托号",
    price_type: "类型", limit_price: "委托价", volume_orign: "委托量", volume_left: "未成",
    trade_price: "成交价", status: "状态", last_msg: "信息", exchange_order_id: "交易所单号",
  };
  const DIR_CN = { BUY: "买", SELL: "卖" };
  const OFF_CN = { OPEN: "开", CLOSE: "平", CLOSETODAY: "平今", CLOSEYESTERDAY: "平昨" };
  function fmtCell(td, col, v) {
    if (col === "trade_date_time" || col === "insert_date_time") {
      const n = num(v);
      td.textContent = n == null ? "—" : new Date(n * 1000).toLocaleTimeString("zh-CN", { hour12: false });
      td.title = n == null ? "" : new Date(n * 1000).toLocaleString("zh-CN", { hour12: false });
      return;
    }
    if (col === "direction") {
      td.textContent = DIR_CN[v] || v || "—";
      td.className = v === "BUY" ? "ac-dir-l" : v === "SELL" ? "ac-dir-s" : "";
      return;
    }
    if (col === "offset") { td.textContent = OFF_CN[v] || v || "—"; return; }
    if (col === "symbol") { td.textContent = v || "—"; td.style.textAlign = "left"; return; }
    if (typeof v === "number") { td.textContent = isFinite(v) ? v : "—"; return; }
    td.textContent = (v === null || v === undefined || v === "") ? "—" : String(v);
  }
  function loadTable(key) {
    if (!curId || !opts.request) return;
    const action = key === "ord" ? "acct_orders" : "acct_trades";
    const payload = key === "ord" ? { id: curId } : { id: curId, limit: 300 };
    opts.request(action, payload).then((r) => {
      if (!root || curId !== r.id) return;
      if (key === "ord") { orders = r; ordersFor = r.id; } else { trades = r; tradesFor = r.id; }
      build();
    }).catch(() => { /* 展开时再试 */ });
  }

  /* ---------------- 组装 ---------------- */
  function guide() {
    const g = el("div", "ac-guide");
    g.innerHTML =
      "<h3>还没有可监控的账户</h3>" +
      "<div>默认会起一个<b>本地模拟盘</b>(TqSim, 不需要任何凭证)。要接快期模拟或实盘, " +
      "在数据目录下建 <code>accounts.json</code>:</div>" +
      "<pre>[\n" +
      '  {"id":"sim",  "kind":"sim",  "name":"本地模拟", "init_balance":1000000},\n' +
      '  {"id":"kq",   "kind":"kq",   "name":"快期模拟"},\n' +
      '  {"id":"real", "kind":"real", "name":"实盘",\n' +
      '   "broker_id":"你的期货公司", "account_id":"资金账号", "password":"交易密码"}\n' +
      "]</pre>" +
      "<div style=\"color:var(--up,#e66767)\">这个文件含明文交易密码, 务必确认它在 .gitignore 里, " +
      "且本终端只监控不下单。</div>";
    return g;
  }
  function build() {
    if (!root) return;
    root.innerHTML = "";
    if (opts.fixedAccount) {
      // 外壳已选好账户, 不再显示第二个选择器
      curId = opts.fixedAccount;
      if (!accounts.some((a) => a.id === curId)) accounts = [{ id: curId, name: curId, ok: true }];
    } else {
      if (!accounts.length) { root.appendChild(guide()); return; }
      if (!curId || !accMeta(curId)) curId = accounts[0].id;
      root.appendChild(buildTabs());
    }
    const meta = accMeta(curId);
    if (meta && !meta.ok) {
      const e = el("div", "ac-empty");
      e.textContent = "该账户未连接: " + (meta.err || "未知原因");
      root.appendChild(e);
      return;
    }
    if (!cur()) {
      root.appendChild(Object.assign(el("div", "ac-empty"),
        { textContent: opts.fixedAccount
          ? "这个账户还没有资金快照"
          : "正在连接账户… (TqSdk 首次建连约 40 秒)" }));
      return;
    }
    root.appendChild(buildCards());
    root.appendChild(buildPos());
    const oc = (orders && ordersFor === curId) ? orders.cols : null;
    root.appendChild(buildTable("ord", "委托",
      oc || [], (orders && ordersFor === curId) ? orders.rows : (fold.ord ? [] : null),
      "只读监控, 不提供撤单"));
    const tc = (trades && tradesFor === curId) ? trades.cols : null;
    root.appendChild(buildTable("trd", "成交",
      tc || [], (trades && tradesFor === curId) ? trades.rows : (fold.trd ? [] : null)));
    if (!fold.ord && !(orders && ordersFor === curId)) loadTable("ord");
    if (!fold.trd && !(trades && tradesFor === curId)) loadTable("trd");
  }

  /* 每帧只改文字, 不重建 DOM —— 结构变了(持仓增减/账户增减)才重建 */
  let posSig = "";
  function tick() {
    if (raf || !visible() || !root) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const c = cur();
      if (!c) return;
      const rows = posRows();
      const sig = rows.map((r) => r.symbol + r.dir + r.vol).join(",");
      if (sig !== posSig) { posSig = sig; build(); return; }
      paintCards(root, c.sum || {}, false);
      const tb = root.querySelector(".ac-sec .ac-b tbody");
      if (tb) {
        const byKey = new Map(rows.map((r) => [r.symbol + "|" + r.dir, r]));
        for (const x of tb.children) {
          const r = byKey.get(x.dataset.key);
          if (r) paintPosRow(x, r);
        }
      }
      // 账户切换条上的权益/当日盈亏也要跟着动
      for (const t of root.querySelectorAll(".ac-tab")) {
        const s = (snap[t.dataset.id] || {}).sum || {};
        const day = (num(s.balance) != null && num(s.pre_balance) != null)
          ? s.balance - s.pre_balance : null;
        const b = t.querySelector(".b"), d = t.querySelector(".d");
        if (b) b.textContent = money(s.balance);
        if (d) { d.textContent = "当日 " + signed(day); d.className = "d " + cls(day); }
      }
    });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      // 快照随挂载一起传进来, 免得 build() 先跑一次空的再等 update() 补 ——
      // 那一下会闪一个"正在连接账户…", 对本来就有数据的账户是错的提示
      if (opts.snapshot) snap = opts.snapshot;
      root = el("div"); root.id = "ac-root";
      host.innerHTML = "";
      host.appendChild(root);
      if (opts.request) {
        opts.request("acct_list", {}).then((r) => {
          accounts = (r && r.accounts) || [];
          build();
        }).catch(() => build());
      }
      build();
      return true;
    },
    /* 服务端每帧推的 {id:{sum,pos,nord}} */
    update(acctMap) {
      const had = !!cur();
      if (acctMap) snap = acctMap;
      // 首次拿到快照但还没有账户列表时, 用快照的键兜底, 免得一直停在引导页
      if (!accounts.length && snap && Object.keys(snap).length) {
        accounts = Object.keys(snap).map((id) => ({ id, name: id, kind: "sim", ok: true }));
        build();
        return;
      }
      // 挂载时通常还没有快照, build() 停在"正在连接账户…"。快照第一次到达必须整体
      // 重建一次, 否则 tick() 只会重绘已有 DOM —— 而那时候卡片和表格根本还没建。
      if (!had && cur()) { build(); return; }
      tick();
    },
    setAccounts(list) {
      accounts = list || [];
      if (root) build();
    },
    accounts() { return accounts; },
    isMounted() { return !!root; },
    destroy() {
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
