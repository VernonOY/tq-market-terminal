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
    const w = document.getElementById("strat-wrap");
    return w && !w.classList.contains("hidden");
  }
  function items() {
    return Object.entries(snap || {})
      .filter(([, v]) => v && typeof v === "object")
      .map(([id, v]) => Object.assign({ id }, v))
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
    if (x.phase) c.appendChild(Object.assign(el("div", "st-phase"), { textContent: x.phase }));

    // 策略自己报什么就显示什么 —— 每个策略的字段都不一样, 写死会漏
    const kv = el("div", "st-kv");
    const add = (k, v, color) => {
      if (v === undefined || v === null || v === "") return;
      const d = el("div");
      d.innerHTML = `<div class="k">${esc(k)}</div><div class="v ${color || ""}">${esc(v)}</div>`;
      d.title = k + ": " + v;
      kv.appendChild(d);
    };
    const acc = x.account || {};
    if (num(acc.balance) != null) add("权益", (+acc.balance).toFixed(0));
    if (num(acc.float_profit) != null) add("浮盈", (+acc.float_profit).toFixed(0), cls(acc.float_profit));
    if (num(x.nav) != null) add("净值", (+x.nav).toFixed(0));
    if (num(x.ret) != null) add("收益率", ((+x.ret) * 100).toFixed(2) + "%", cls(x.ret));
    for (const [k, v] of Object.entries(x.stats || {})) add(k, typeof v === "number" ? +v.toFixed(2) : v);
    for (const [k, v] of Object.entries(x.params || {})) add(k, typeof v === "boolean" ? (v ? "是" : "否") : v);
    if (x.started) add("启动于", String(x.started).slice(11) || x.started);
    if (kv.children.length) c.appendChild(kv);
    if (x.last_err || x.err) {
      const e = el("div", "st-phase");
      e.style.color = "var(--up,#e66767)";
      e.textContent = "错误: " + (x.last_err || x.err);
      c.appendChild(e);
    }
    return c;
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
        if (typeof v === "number") {
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
      if (cu) { right.appendChild(signalCard(cu)); right.appendChild(logCard(cu)); }
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
    isMounted() { return !!root; },
    destroy() {
      clearInterval(logTimer); logTimer = 0;
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
