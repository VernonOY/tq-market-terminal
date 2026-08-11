/* 交易 · 策略监控
 * 读 Trade/state/*.json 的策略状态并呈现。策略跑在独立子进程里, 本页只监控不干预。
 * 自包含: IIFE + 注入样式, 只暴露 window.StrategyView
 * 注意: 宿主 section 是 display:flex(行), 所以本模块必须只往里放一个根 div,
 * 否则各区块会被摊成一排。
 */
window.StrategyView = (function () {
  "use strict";

  const STYLE_ID = "st-style";
  const CSS = `
#st-root{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:10px 14px 30px;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#st-root *{box-sizing:border-box}
.st-warn{display:flex;align-items:flex-start;gap:8px;padding:7px 12px;margin-bottom:10px;
  background:rgba(217,89,38,.13);border:1px solid rgba(217,89,38,.3);border-radius:7px;
  font-size:11.5px;line-height:1.6}
.st-warn b{color:#e9a23b}
.st-cols{display:grid;grid-template-columns:236px minmax(0,1fr);gap:10px;align-items:start}
@media (max-width:960px){.st-cols{grid-template-columns:1fr}}
.st-card{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;overflow:hidden;margin-bottom:10px}
.st-h{display:flex;align-items:center;gap:8px;padding:6px 11px;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
.st-h b{color:var(--ink,#fff);font-size:12.5px}
.st-h .sp{flex:1 1 auto}
.st-h .cnt{color:var(--muted,#898781);font-size:11px}
.st-b{padding:8px 11px}
.st-b.pad0{padding:0}
.st-file{display:flex;align-items:center;gap:8px;padding:5px 11px;
  border-bottom:1px solid var(--grid,#2c2c2a)}
.st-file:last-child{border-bottom:none}
.st-file:hover{background:var(--surface-2,#222221)}
.st-file .n{color:var(--ink,#fff);font-size:12px;flex:1 1 auto;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.st-file .m{color:var(--muted,#898781);font-size:10px;white-space:nowrap}
.st-btn{background:var(--surface-2,#222221);color:var(--ink-2,#c3c2b7);
  border:1px solid var(--border,rgba(255,255,255,.1));border-radius:5px;
  padding:2px 10px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap}
.st-btn:hover{color:var(--ink,#fff);border-color:var(--muted,#898781)}
.st-btn.danger:hover{color:var(--up,#e66767);border-color:var(--up,#e66767)}
.st-run{border:1px solid var(--border,rgba(255,255,255,.1));border-radius:8px;
  background:var(--surface,#1a1a19);margin-bottom:9px;cursor:pointer}
.st-run.on{border-color:var(--ma5,#3987e5)}
.st-run .top{display:flex;align-items:center;gap:9px;padding:7px 11px;flex-wrap:wrap}
.st-run .nm{color:var(--ink,#fff);font-size:13.5px;font-weight:600}
.st-run .meta{color:var(--muted,#898781);font-size:11px}
.st-pill{font-size:10.5px;padding:1px 8px;border-radius:10px;white-space:nowrap}
.st-pill.running{background:rgba(25,158,112,.2);color:var(--down,#199e70)}
.st-pill.stopped{background:var(--surface-2,#222221);color:var(--muted,#898781)}
.st-pill.error{background:rgba(230,103,103,.2);color:var(--up,#e66767)}
.st-pill.stale{background:rgba(217,89,38,.2);color:#e9a23b}
.st-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:5px;padding:0 11px 9px}
.st-kv>div{background:var(--surface-2,#222221);border-radius:5px;padding:4px 8px;overflow:hidden}
.st-kv .k{color:var(--muted,#898781);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-kv .v{color:var(--ink,#fff);font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-phase{color:var(--muted,#898781);font-size:11.5px;padding:0 11px 8px}
.st-tw{overflow-x:auto;max-height:360px;overflow-y:auto}
table.st-t{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums}
table.st-t th{position:sticky;top:0;background:var(--surface,#1a1a19);z-index:1;
  color:var(--muted,#898781);font-weight:400;font-size:10.5px;text-align:right;
  padding:4px 8px;border-bottom:1px solid var(--border,rgba(255,255,255,.1));white-space:nowrap}
table.st-t th:first-child,table.st-t td:first-child{text-align:left}
table.st-t td{padding:3px 8px;text-align:right;border-bottom:1px solid var(--grid,#2c2c2a);white-space:nowrap}
table.st-t tr.hit td{background:rgba(57,135,229,.12)}
.st-log{background:#0a0a0a;border-radius:6px;padding:8px 10px;max-height:300px;overflow-y:auto;
  font:11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.st-log .e{color:var(--up,#e66767)}
.st-log .t{color:var(--muted,#898781)}
.st-up{color:var(--up,#e66767)}.st-down{color:var(--down,#199e70)}.st-flat{color:var(--ink-2,#c3c2b7)}
.st-empty{padding:18px 12px;color:var(--muted,#898781);font-size:12px;text-align:center;line-height:1.8}
.st-sym{color:var(--ma5,#3987e5);cursor:pointer}
.st-sym:hover{text-decoration:underline}
/* 策略死了但仓位还在 —— 这是最危险的状态, 必须比灰字 error 显眼得多 */
.st-run.hung{border-color:var(--up,#e66767);box-shadow:0 0 0 1px rgba(230,103,103,.35) inset}
.st-hung{margin:0 11px 8px;padding:7px 10px;border-radius:6px;font-size:11.5px;line-height:1.6;
  background:rgba(230,103,103,.14);border:1px solid rgba(230,103,103,.4)}
.st-hung b{color:var(--up,#e66767);display:block;margin-bottom:2px}
/* 盈亏分解带 */
.st-pnl{padding:2px 11px 9px}
.st-pnl .row{display:flex;align-items:center;gap:8px;height:19px}
.st-pnl .l{color:var(--muted,#898781);font-size:10.5px;width:60px;flex:0 0 auto;text-align:right}
.st-pnl .track{flex:1 1 auto;height:9px;background:var(--surface-2,#222221);border-radius:2px;
  overflow:hidden;min-width:40px}
.st-pnl .track i{display:block;height:100%;border-radius:2px}
.st-pnl .track i.g{background:var(--up,#e66767)}
.st-pnl .track i.f{background:var(--down,#199e70)}
.st-pnl .n{font-size:11.5px;font-variant-numeric:tabular-nums;width:88px;flex:0 0 auto;text-align:right}
.st-pnl .row.tot{border-top:1px solid var(--grid,#2c2c2a);margin-top:3px;padding-top:3px;height:22px}
.st-pnl .row.tot .l,.st-pnl .row.tot .n{color:var(--ink,#fff);font-weight:600;font-size:12.5px}
.st-pnl .note{color:var(--muted,#898781);font-size:10.5px;text-align:right;margin-top:2px}
.st-pnl .note.warn{color:#e9a23b}
.st-eq{display:block;width:100%;height:84px}
.st-foot{padding:5px 11px 8px;color:var(--muted,#898781);font-size:10.5px}
.st-warnv{color:#e9a23b}
`;

  let host = null, root = null, opts = {};
  let snap = {}, files = [], curId = null, raf = 0;
  let logLines = [], logFor = null, logTimer = 0, logStick = true;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "st-up" : v < 0 ? "st-down" : "st-flat");
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  function visible() {
    /* 同 account.js: #strat-wrap 在 89fbcdd「交易页改成账户优先」时就被删了,
       这里再按 id 找永远是 null → 每帧早退, 净值/持仓看着像卡死。
       以根节点是否真的在页面上、有没有布局盒为准。 */
    if (!root || !root.isConnected) return false;
    return !!(root.offsetParent || root.getClientRects().length);
  }
  /* 策略归属哪个账户: 跟 trade.js 用同一套判定, 否则两边会对不上 */
  function acctIdOf(s) {
    const m = String(s.mode || "");
    if (/TqKq|快期/i.test(m)) return "kq";
    if (/实盘|TqAccount/i.test(m)) return "real";
    return "strat:" + s.id;
  }
  function items() {
    return Object.entries(snap || {})
      .filter(([, v]) => v && typeof v === "object")
      .map(([id, v]) => Object.assign({ id }, v))
      .filter((v) => !opts.accountId || acctIdOf(v) === opts.accountId)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "zh"));
  }
  function curItem() {
    const l = items();
    return l.find((x) => x.id === curId) || l[0] || null;
  }
  function ago(s) {
    if (!s) return "—";
    const t = Date.parse(String(s).replace(" ", "T"));
    if (!isFinite(t)) return String(s);
    const d = Math.max(0, (Date.now() - t) / 1000);
    if (d < 60) return Math.round(d) + " 秒前";
    if (d < 3600) return Math.round(d / 60) + " 分钟前";
    return Math.round(d / 3600) + " 小时前";
  }
  function stateOf(x) {
    const st = String(x.status || x.state || "").toLowerCase();
    if (st.includes("err")) return ["error", "异常"];
    if (st.includes("stop") || st.includes("exit") || st.includes("dead")) return ["stopped", "已停止"];
    if (x.stale) return ["stale", "状态陈旧"];
    if (st.includes("run")) return ["running", "运行中"];
    return ["stopped", st || "未知"];
  }
  const ACC_KEY = {
    "权益": "balance", "浮动盈亏": "float_profit", "浮盈": "float_profit",
    "平仓盈亏": "close_profit", "手续费": "commission", "保证金": "margin",
    "可用": "available", "可用资金": "available",
  };
  function normAcc(a) {
    const o = {};
    for (const k in (a || {})) o[ACC_KEY[k] || k] = a[k];
    return o;
  }
  const SYM_COLS = new Set(["contract", "symbol", "合约", "instrument_id", "sym"]);
  function logHtml(lines) {
    if (!lines || !lines.length) return '<span class="t">(暂无日志)</span>';
    return lines.map((ln) => {
      const s = String(ln);
      const err = /error|traceback|exception|失败|异常/i.test(s);
      return `<div class="${err ? "e" : ""}">${esc(s)}</div>`;
    }).join("");
  }

  /* ---------------- 左栏: 可启动的策略文件 ---------------- */
  function fileCard() {
    const c = el("div", "st-card");
    const h = el("div", "st-h");
    h.innerHTML = `<b>策略文件</b><span class="sp"></span><span class="cnt">${files.length}</span>`;
    c.appendChild(h);
    const b = el("div", "st-b pad0");
    if (!files.length) {
      b.appendChild(Object.assign(el("div", "st-empty"), { textContent: "Trade/ 下没有 .py 文件" }));
    } else {
      for (const f of files) {
        const name = typeof f === "string" ? f : f.name;
        const row = el("div", "st-file");
        const kb = (f && f.size) ? (f.size / 1024).toFixed(1) + "KB" : "";
        row.innerHTML = `<span class="n">${esc(name)}</span><span class="m">${kb}</span>`;
        const btn = el("button", "st-btn");
        btn.textContent = "启动";
        btn.onclick = () => {
          const v = prompt(`启动「${name}」\n初始资金(模拟盘)`, "1000000");
          if (v == null) return;
          opts.request("strat_start", { file: name, init_balance: +v || 1000000 })
            .then((r) => { if (r && r.msg) alert(r.msg); pull(); })
            .catch((e) => alert("启动失败: " + e.message));
        };
        row.appendChild(btn);
        b.appendChild(row);
      }
    }
    c.appendChild(b);
    return c;
  }

  /* ---------------- 右栏: 策略卡 ---------------- */
  function runCard(x, isCur) {
    const [kind, label] = stateOf(x);
    const c = el("div", "st-run" + (isCur ? " on" : ""));
    c.dataset.id = x.id;
    c.onclick = () => { curId = x.id; logLines = []; logFor = null; build(); };
    /* 策略死了但仓位还在 —— 最危险的状态, 要比灰字 error 显眼得多。
       但判据必须用**权威信号**: 持仓数组 / 保证金。
       原来靠 已开仓 > 已平仓 推断, 而各策略上报的 stats 键并不统一 ——
       night_gap 压根没有「已平仓」这个键, 取不到当 0, 于是 14 笔全平了也报
       「14 个仓位未平」。误报比不报更糟: 它会让人怀疑真正的告警。 */
    const [k0] = [kind];
    const dead = k0 === "error" || k0 === "stopped" || k0 === "stale";
    const acc0 = normAcc(x.account);
    const marg = num(acc0.margin);
    const nPos = Array.isArray(x.positions) ? x.positions.length : null;
    let openLeft = 0;
    if (nPos != null) openLeft = nPos;                       // 策略明确报了持仓
    else if (marg != null) openLeft = marg > 0 ? 1 : 0;      // 退而求其次看保证金
    else {                                                   // 两者都没有才用计数差
      const o = num((x.stats || {})["已开仓"]) || 0;
      const c = num((x.stats || {})["已平仓"]);
      openLeft = c == null ? 0 : Math.max(0, o - c);
    }
    const hung = dead && openLeft > 0;
    const openN = openLeft, closeN = 0;
    if (hung) c.classList.add("hung");
    const top = el("div", "top");
    top.innerHTML = `<span class="nm">${esc(x.name || x.id)}</span>` +
      `<span class="st-pill ${kind}">${label}</span>` +
      `<span class="meta">${esc(x.mode || "")}</span>` +
      `<span class="sp"></span>` +
      `<span class="meta">${x.pid ? "PID " + x.pid + " · " : ""}更新 ${ago(x.updated)}</span>`;
    const stop = el("button", "st-btn danger");
    stop.textContent = "停止";
    stop.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`停止「${x.name || x.id}」?`)) return;
      opts.request("strat_stop", { id: x.id })
        .then((r) => { if (r && r.msg) alert(r.msg); pull(); })
        .catch((err) => alert(err.message));
    };
    top.appendChild(stop);
    c.appendChild(top);
    if (hung) {
      const w = el("div", "st-hung");
      w.innerHTML = `<b>⚠ 策略已停止, 但还有 ${openLeft} 个仓位未平</b>` +
        `<div>模拟盘(TqSim)的账户随进程消失, 本次结果作废。` +
        `如果是实盘或快期模拟(TqKq), 这些仓位仍然挂在市场上, 需要手动处理。</div>`;
      c.appendChild(w);
    }
    if (x.phase) c.appendChild(Object.assign(el("div", "st-phase"), { textContent: x.phase }));

    // 策略自己报什么就显示什么 —— 每个策略的字段都不一样, 写死会漏
    const kv = el("div", "st-kv");
    const add = (k, v, color) => {
      if (v === undefined || v === null || v === "") return;
      const d = el("div");
      d.dataset.k = k;                 // 供 tick() 增量更新定位, 不必整体重建
      d.innerHTML = `<div class="k">${esc(k)}</div><div class="v ${color || ""}">${esc(v)}</div>`;
      d.title = k + ": " + v;
      kv.appendChild(d);
    };
    const acc = normAcc(x.account);
    // 策略侧可能写英文键(TqSdk 原名)也可能写中文键, 两种都认 ——
    // 不兼容的话页面会静默什么都不显示(数据其实在), 排查起来很费时间。
    const pick = (...ks) => { for (const k of ks) if (num(acc[k]) != null) return +acc[k]; return null; };
    const bal = pick("balance", "权益");
    const fp = pick("float_profit", "浮动盈亏", "浮盈");
    const cp = pick("close_profit", "平仓盈亏");
    const cm = pick("commission", "手续费");
    const mg = pick("margin", "保证金");
    if (bal != null) add("权益", bal.toFixed(0));
    if (fp != null) add("浮盈", fp.toFixed(0), cls(fp));
    if (cp != null) add("平仓盈亏", cp.toFixed(0), cls(cp));
    if (cm != null) add("手续费", cm.toFixed(0));
    if (mg != null) add("保证金", mg.toFixed(0));
    if (bal != null && cp != null && cm != null) add("净盈亏", (cp - cm).toFixed(0), cls(cp - cm));
    if (num(x.nav) != null) add("净值", (+x.nav).toFixed(0));
    if (num(x.ret) != null) add("收益率", ((+x.ret) * 100).toFixed(2) + "%", cls(x.ret));
    for (const [k, v] of Object.entries(x.stats || {})) add(k, typeof v === "number" ? +v.toFixed(2) : v);
    for (const [k, v] of Object.entries(x.params || {})) add(k, typeof v === "boolean" ? (v ? "是" : "否") : v);
    if (x.started) add("启动于", String(x.started).slice(11) || x.started);
    if (kv.children.length) c.appendChild(kv);
    const pnl = pnlBar(x);
    if (pnl) c.appendChild(pnl);
    if (x.last_err || x.err) {
      const e = el("div", "st-phase");
      e.style.color = "var(--up,#e66767)";
      e.textContent = "错误: " + (x.last_err || x.err);
      c.appendChild(e);
    }
    return c;
  }

  /* 盈亏分解带: 把"毛利 - 手续费 = 已落袋"和浮盈画成一条可比长度的横条。
     光看数字很难感知手续费吃掉了多大比例, 画出来一眼就知道。 */
  function pnlBar(x) {
    const a = normAcc(x.account);
    const gross = num(a.close_profit), fee = num(a.commission), fp = num(a.float_profit);
    if (gross == null && fp == null) return null;
    const net = (gross || 0) - (fee || 0);
    const total = net + (fp || 0);
    const mx = Math.max(Math.abs(gross || 0), Math.abs(fee || 0),
                        Math.abs(fp || 0), Math.abs(total), 1);
    const box = el("div", "st-pnl");
    const seg = (label, v, kind2) => {
      if (v == null) return;
      const r = el("div", "row");
      const w = Math.min(100, Math.abs(v) / mx * 100);
      r.innerHTML = `<span class="l">${label}</span>` +
        `<span class="track"><i class="${kind2}" style="width:${w.toFixed(1)}%"></i></span>` +
        `<span class="n ${cls(v)}">${v > 0 ? "+" : ""}${v.toFixed(2)}</span>`;
      box.appendChild(r);
    };
    seg("平仓毛利", gross, "g");
    seg("手续费", fee == null ? null : -fee, "f");
    seg("已落袋", net, net >= 0 ? "g" : "f");
    seg("浮动盈亏", fp, fp >= 0 ? "g" : "f");
    const r = el("div", "row tot");
    r.innerHTML = `<span class="l">合计</span><span class="track"></span>` +
      `<span class="n ${cls(total)}">${total > 0 ? "+" : ""}${total.toFixed(2)}</span>`;
    box.appendChild(r);
    if (gross && fee) {
      const pctFee = fee / Math.abs(gross) * 100;
      const note = el("div", "note");
      note.textContent = `手续费占毛利 ${pctFee.toFixed(1)}%` +
        (pctFee >= 50 ? " —— 成本已经吃掉大半利润" : "");
      if (pctFee >= 50) note.classList.add("warn");
      box.appendChild(note);
    }
    return box;
  }

  /* 成交回顾: 从信号里的 entry_price/exit_price/side 倒推逐笔盈亏。
     用 bp(万分比) 而不是金额 —— 不需要合约乘数, 而且跨品种可比:
     豆一一个点和沪铜一个点值的钱差几十倍, 只有归一化后才能横向看策略表现。
     这也让已经跑完的策略能回看, 不用等净值序列重新采样。 */
  function trades(x) {
    const out = [];
    for (const r of (x.signals || [])) {
      const ep = num(r.entry_price), xp = num(r.exit_price), side = num(r.side);
      if (ep == null || xp == null || !side || !ep) continue;
      out.push({
        sym: r.contract || r.symbol || r.code,
        side, ep, xp,
        et: r.entry_time || "", xt: r.exit_time || "",
        bp: (xp - ep) / ep * side * 10000,
        epas: !!r.entry_passive, xpas: !!r.exit_passive,
      });
    }
    return out;
  }
  function tradeCard(x) {
    const ts = trades(x);
    if (!ts.length) return null;
    const c = el("div", "st-card");
    const win = ts.filter((t) => t.bp > 0), lose = ts.filter((t) => t.bp <= 0);
    const sum = ts.reduce((a, t) => a + t.bp, 0);
    const avgW = win.length ? win.reduce((a, t) => a + t.bp, 0) / win.length : 0;
    const avgL = lose.length ? lose.reduce((a, t) => a + t.bp, 0) / lose.length : 0;
    const h = el("div", "st-h");
    h.innerHTML = `<b>成交回顾</b><span class="cnt">${ts.length} 笔</span><span class="sp"></span>` +
      `<span class="cnt">胜率 ${(win.length / ts.length * 100).toFixed(0)}% · ` +
      `均盈 ${avgW.toFixed(1)}bp · 均亏 ${avgL.toFixed(1)}bp · ` +
      `盈亏比 ${avgL ? Math.abs(avgW / avgL).toFixed(2) : "—"}</span>`;
    c.appendChild(h);

    // 累计盈亏曲线(bp), canvas 自绘 —— 19 个点没必要上图表库
    const cv = el("canvas", "st-eq");
    c.appendChild(cv);
    requestAnimationFrame(() => drawEq(cv, ts));

    const w = el("div", "st-tw");
    const t = el("table", "st-t");
    t.innerHTML = "<thead><tr><th>合约</th><th>方向</th><th>开仓</th><th>价格</th>" +
      "<th>平仓</th><th>价格</th><th>盈亏bp</th><th>成交</th></tr></thead>";
    const tb = el("tbody");
    for (const tr of ts.slice().sort((a, b) => a.bp - b.bp)) {
      const row = el("tr");
      const pas = (tr.epas ? "被" : "主") + "/" + (tr.xpas ? "被" : "主");
      row.innerHTML = `<td><span class="st-sym">${esc(tr.sym)}</span></td>` +
        `<td class="${tr.side > 0 ? "st-up" : "st-down"}">${tr.side > 0 ? "多" : "空"}</td>` +
        `<td>${esc(tr.et)}</td><td>${tr.ep}</td>` +
        `<td>${esc(tr.xt)}</td><td>${tr.xp}</td>` +
        `<td class="${cls(tr.bp)}">${tr.bp > 0 ? "+" : ""}${tr.bp.toFixed(1)}</td>` +
        `<td class="${tr.epas && tr.xpas ? "" : "st-warnv"}">${pas}</td>`;
      const sy = row.querySelector(".st-sym");
      sy.onclick = (e) => { e.stopPropagation(); if (opts.onPick) opts.onPick(tr.sym); };
      tb.appendChild(row);
    }
    t.appendChild(tb);
    w.appendChild(t);
    c.appendChild(w);
    const f = el("div", "st-foot");
    f.innerHTML = `累计 <b class="${cls(sum)}">${sum > 0 ? "+" : ""}${sum.toFixed(1)}bp</b>` +
      ` · 这是价格口径, 未扣手续费和滑点; 实际到手看上面的盈亏分解`;
    c.appendChild(f);
    return c;
  }
  function drawEq(cv, ts) {
    const w = cv.clientWidth || 600, h = 84;
    const dpr = window.devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cum = [];
    let acc = 0;
    for (const t of ts) { acc += t.bp; cum.push(acc); }
    const lo = Math.min(0, ...cum), hi = Math.max(0, ...cum);
    const pad = (hi - lo) * 0.12 || 1;
    const y = (v) => h - 6 - (v - lo + pad) / (hi - lo + pad * 2) * (h - 12);
    const x = (i) => cum.length < 2 ? w / 2 : 4 + i / (cum.length - 1) * (w - 8);
    g.strokeStyle = "rgba(255,255,255,.16)"; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(0, y(0)); g.lineTo(w, y(0)); g.stroke(); g.setLineDash([]);
    const up = cssVar("--up", "#e66767"), down = cssVar("--down", "#199e70");
    const col = acc >= 0 ? up : down;
    g.beginPath(); g.moveTo(x(0), y(cum[0]));
    for (let i = 1; i < cum.length; i++) g.lineTo(x(i), y(cum[i]));
    g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
    g.lineTo(x(cum.length - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
    g.fillStyle = acc >= 0 ? "rgba(230,103,103,.13)" : "rgba(25,158,112,.15)";
    g.fill();
    g.fillStyle = cssVar("--muted", "#898781"); g.font = "10px system-ui";
    g.fillText("累计 " + (acc > 0 ? "+" : "") + acc.toFixed(1) + "bp", 6, 12);
  }
  function cssVar(n, d) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || d;
  }

  /* 信号表: 列名从数据里推 —— 各策略字段不同, 写死列表就只能服务一个策略 */
  function signalCard(x) {
    const rows = Array.isArray(x.signals) ? x.signals.filter((r) => r && typeof r === "object") : [];
    const c = el("div", "st-card");
    const h = el("div", "st-h");
    h.innerHTML = `<b>信号明细</b><span class="sp"></span><span class="cnt">${rows.length} 条</span>`;
    c.appendChild(h);
    if (!rows.length) {
      c.appendChild(Object.assign(el("div", "st-empty"),
        { textContent: x.phase || "暂无信号" }));
      return c;
    }
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const w = el("div", "st-tw");
    const t = el("table", "st-t");
    const tr = el("tr");
    for (const k of cols) tr.appendChild(Object.assign(el("th"), { textContent: k }));
    const th = el("thead"); th.appendChild(tr); t.appendChild(th);
    const tb = el("tbody");
    for (const r of rows) {
      const row = el("tr");
      if (r.hit || r.triggered) row.className = "hit";
      for (const k of cols) {
        const td = el("td");
        const v = r[k];
        // 合约代码做成可点击 —— 看到信号第一反应就是想看这个品种的图
        if (SYM_COLS.has(k) && typeof v === "string" && /\.|@/.test(v)) {
          const a = el("span", "st-sym");
          a.textContent = v;
          a.title = "点击查看 " + v + " 的K线";
          a.onclick = (e) => { e.stopPropagation(); if (opts.onPick) opts.onPick(v); };
          td.appendChild(a);
        } else if (typeof v === "number") {
          td.textContent = Number.isInteger(v) ? v : v.toFixed(2);
          if (/gap|z$|profit|盈|涨|跌|bp/i.test(k)) td.className = cls(v);
        } else if (typeof v === "boolean") {
          td.textContent = v ? "是" : "";
        } else {
          td.textContent = v == null ? "" : String(v);
        }
        row.appendChild(td);
      }
      tb.appendChild(row);
    }
    t.appendChild(tb);
    w.appendChild(t);
    c.appendChild(w);
    return c;
  }

  function logCard(x) {
    const c = el("div", "st-card");
    const h = el("div", "st-h");
    h.innerHTML = "<b>运行日志</b><span class=\"sp\"></span>";
    const stick = el("button", "st-btn");
    stick.textContent = logStick ? "跟随最新" : "已暂停跟随";
    stick.onclick = (e) => {
      e.stopPropagation();
      logStick = !logStick;
      stick.textContent = logStick ? "跟随最新" : "已暂停跟随";
      const box = document.getElementById("st-logbox");
      if (logStick && box) box.scrollTop = box.scrollHeight;
    };
    h.appendChild(stick);
    c.appendChild(h);
    const b = el("div", "st-b");
    const box = el("div", "st-log");
    box.id = "st-logbox";
    box.innerHTML = logHtml(logLines.length ? logLines : (x.notes || []));
    // 用户往上翻过就别再把他拽到底 —— 查日志时最烦这个
    box.addEventListener("scroll", () => {
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
      if (!atEnd && logStick) { logStick = false; stick.textContent = "已暂停跟随"; }
    });
    b.appendChild(box);
    c.appendChild(b);
    requestAnimationFrame(() => { if (logStick) box.scrollTop = box.scrollHeight; });
    return c;
  }

  /* ---------------- 组装 ---------------- */
  function build() {
    if (!root) return;
    root.innerHTML = "";
    const warn = el("div", "st-warn");
    warn.innerHTML = "<b>⚠</b><div>策略跑在<b>独立子进程</b>里, 用的是<b>模拟账户</b>。" +
      "策略文件是任意 Python 代码, 与本终端同权限运行, <b>没有沙箱</b> —— 别运行来路不明的文件。" +
      "本页只做监控。</div>";
    root.appendChild(warn);

    const cols = el("div", "st-cols");
    const left = el("div"), right = el("div");
    left.appendChild(fileCard());
    const list = items();
    if (!list.length) {
      right.appendChild(Object.assign(el("div", "st-empty"), {
        innerHTML: "没有正在运行的策略。<br>" +
          "从左侧选一个文件启动, 或在终端里手动运行 —— 手动跑的也会被这里发现。",
      }));
    } else {
      const cu = curItem();
      for (const x of list) right.appendChild(runCard(x, cu && x.id === cu.id));
      if (cu) {
        const tc = tradeCard(cu);
        if (tc) right.appendChild(tc);
        right.appendChild(signalCard(cu));
        right.appendChild(logCard(cu));
      }
    }
    cols.append(left, right);
    root.appendChild(cols);
    pullLog();
  }

  function pull() {
    if (!opts.request) return;
    opts.request("strat_files", {}).then((r) => {
      files = (r && r.files) || [];
      if (root) build();
    }).catch(() => { /* 忽略 */ });
    opts.request("strat_list", {}).then((r) => {
      for (const x of ((r && r.items) || [])) {
        if (x && x.id && !snap[x.id]) snap[x.id] = x;
      }
      if (root) build();
    }).catch(() => { /* 忽略 */ });
  }
  function pullLog() {
    const cu = curItem();
    if (!cu || !opts.request) return;
    opts.request("strat_log", { id: cu.id, limit: 400 }).then((r) => {
      if (!root) return;
      const ln = (r && r.lines) || [];
      if (logFor === cu.id && ln.length === logLines.length) return;
      logLines = ln; logFor = cu.id;
      const box = document.getElementById("st-logbox");
      if (box) {
        box.innerHTML = logHtml(ln);
        if (logStick) box.scrollTop = box.scrollHeight;
      }
    }).catch(() => { /* 忽略 */ });
  }

  /* 每帧只改会变的文字; 结构变了才整体重建 */
  let sig = "";
  function tick() {
    if (raf || !visible() || !root) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const list = items();
      const s = list.map((x) => x.id + stateOf(x)[0] + (x.signals || []).length).join(",");
      if (s !== sig) { sig = s; build(); return; }
      for (const x of list) {
        const card = root.querySelector('.st-run[data-id="' + x.id + '"]');
        if (!card) continue;
        const meta = card.querySelectorAll(".meta");
        if (meta[1]) meta[1].textContent = (x.pid ? "PID " + x.pid + " · " : "") + "更新 " + ago(x.updated);
        // ⚠️ 结构签名(id+状态+信号条数)不含账户和统计的**数值** —— 权益、浮盈每秒
        // 都在变但签名不变, 只刷 meta 的话数值会一直停在上次重建时的旧值,
        // 看起来就是"点一下才更新一下"。所以这里必须就地把数值也刷了。
        const acc = x.account || {}, stt = x.stats || {};
        const pk = (...ks) => { for (const k of ks) if (num(acc[k]) != null) return +acc[k]; return null; };
        const vals = {
          "权益": pk("balance", "权益"), "浮盈": pk("float_profit", "浮动盈亏", "浮盈"),
          "平仓盈亏": pk("close_profit", "平仓盈亏"), "手续费": pk("commission", "手续费"),
          "保证金": pk("margin", "保证金"),
        };
        const cp2 = vals["平仓盈亏"], cm2 = vals["手续费"];
        if (cp2 != null && cm2 != null) vals["净盈亏"] = cp2 - cm2;
        for (const [k, v] of Object.entries(stt)) vals[k] = v;
        for (const [k, v] of Object.entries(vals)) {
          if (v === null || v === undefined) continue;
          const cell = card.querySelector('.st-kv > div[data-k="' + k + '"] .v');
          if (!cell) continue;
          const txt = typeof v === "number"
            ? (Math.abs(v) >= 1000 || Number.isInteger(v) ? v.toFixed(0) : (+v).toFixed(2))
            : String(v);
          if (cell.textContent !== txt) {
            cell.textContent = txt;
            if (["浮盈", "平仓盈亏", "净盈亏"].includes(k))
              cell.className = "v " + cls(v);
          }
        }
        const ph = card.querySelector(".st-phase");
        if (ph && x.phase && ph.textContent !== x.phase) ph.textContent = x.phase;
      }
    });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      root = el("div"); root.id = "st-root";
      host.innerHTML = "";
      host.appendChild(root);
      build();
      pull();
      clearInterval(logTimer);
      logTimer = setInterval(() => { if (visible()) pullLog(); }, 4000);
      return true;
    },
    update(stratMap) {
      if (stratMap && typeof stratMap === "object") snap = stratMap;
      tick();
    },
    select(id) { curId = id; logLines = []; logFor = null; if (root) build(); },
    isMounted() { return !!root; },
    destroy() {
      clearInterval(logTimer); logTimer = 0;
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
