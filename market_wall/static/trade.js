/* 交易 · 外壳
 * 信息架构: 账户是容器, 先选账户, 再看这个账户里的东西。
 *   账户栏(一级)  →  概览 / 策略 / 净值 / 持仓成交(二级)  →  内容
 * 之前三个平级标签各自带一个账户选择器, 切换时互不同步, 是拧的。
 *
 * 账户从哪来:
 *   - accounts.json 里配置的终端账户(本地模拟 / 快期模拟 / 实盘)
 *   - 每个跑在 TqSim 上的策略 —— TqSim 活在策略自己的进程内存里, 天然是独立账户
 *   - 跑在 TqKq(快期模拟) 上的策略则归到那个共享账户下, 所以一个账户能挂多个策略
 *
 * 自包含: IIFE + 注入样式, 只暴露 window.TradeView
 */
window.TradeView = (function () {
  "use strict";

  const STYLE_ID = "tv-style";
  const CSS = `
#tv-root{flex:1 1 auto;min-height:0;min-width:0;display:flex;flex-direction:column;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif}
#tv-root *{box-sizing:border-box}
.tv-accs{display:flex;gap:6px;padding:9px 14px 0;flex-wrap:wrap;flex:0 0 auto}
.tv-acc{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;padding:6px 12px;cursor:pointer;min-width:158px;position:relative}
.tv-acc:hover{border-color:var(--muted,#898781)}
.tv-acc.on{border-color:var(--ma5,#3987e5);background:var(--surface-2,#222221)}
.tv-acc.real{border-color:rgba(230,103,103,.5)}
.tv-acc.dead{opacity:.62}
.tv-acc .n{color:var(--ink,#fff);font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:5px}
.tv-acc .b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:1px}
.tv-acc .d{font-size:11px;font-variant-numeric:tabular-nums}
.tv-acc .s{color:var(--muted,#898781);font-size:10px;margin-top:1px}
.tv-tag{font-size:9.5px;padding:0 5px;border-radius:3px;font-weight:400;white-space:nowrap}
.tv-tag.real{background:rgba(230,103,103,.22);color:var(--up,#e66767)}
.tv-tag.sim{background:var(--surface-2,#222221);color:var(--muted,#898781)}
.tv-tag.kq{background:rgba(57,135,229,.2);color:var(--ma5,#3987e5)}
.tv-tag.warn{background:rgba(230,103,103,.22);color:var(--up,#e66767)}
.tv-tabs{display:flex;gap:2px;padding:9px 14px 0;flex:0 0 auto;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
.tv-tabs button{background:transparent;color:var(--muted,#898781);border:none;
  border-bottom:2px solid transparent;padding:5px 14px 7px;font-size:12.5px;cursor:pointer;
  font-family:inherit;white-space:nowrap}
.tv-tabs button:hover{color:var(--ink-2,#c3c2b7)}
.tv-tabs button.on{color:var(--ink,#fff);border-bottom-color:var(--ma5,#3987e5)}
.tv-tabs .cnt{font-size:10px;color:var(--muted,#898781);margin-left:4px}
.tv-body{flex:1 1 auto;min-height:0;min-width:0;display:flex}
.tv-up{color:var(--up,#e66767)}.tv-down{color:var(--down,#199e70)}.tv-flat{color:var(--ink-2,#c3c2b7)}
.tv-empty{flex:1 1 auto;padding:26px 16px;color:var(--muted,#898781);font-size:12.5px;
  text-align:center;line-height:1.9}
`;

  const TABS = [["home", "概览"], ["strat", "策略"], ["nav", "净值"], ["pos", "持仓成交"]];

  let host = null, root = null, opts = {};
  let els = null;
  let accounts = [], strat = {}, acctSnap = {};
  let curAcct = null, curTab = "home", raf = 0;
  let gotAccts = false, gotStrat = false;

  try { curAcct = localStorage.getItem("mw:tvacct") || null; } catch (e) { /* 忽略 */ }
  try { curTab = localStorage.getItem("mw:tvtab") || "home"; } catch (e) { /* 忽略 */ }

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "tv-up" : v < 0 ? "tv-down" : "tv-flat");
  function money(v) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
    if (a >= 1e4) return (n / 1e4).toFixed(2) + "万";
    return n.toFixed(2);
  }
  const signed = (v) => (num(v) == null ? "—" : (num(v) > 0 ? "+" : "") + money(v));
  function visible() {
    const w = document.getElementById("trade-wrap");
    return w && !w.classList.contains("hidden");
  }

  /* ---------- 策略 → 账户归属 ----------
     策略在状态里报了 mode(如 "模拟盘(TqSim)" / "快期模拟账户(TqKq)")。
     TqSim 在策略进程内, 别人碰不到 → 自成一个账户;
     TqKq 是服务端账户, 多个策略进程共用 → 归到终端配置的那个 kq 账户下。 */
  function acctIdOfStrategy(s) {
    const m = String(s.mode || "");
    if (/TqKq|快期/i.test(m)) return "kq";
    if (/实盘|TqAccount/i.test(m)) return "real";
    return "strat:" + s.id;
  }
  function stratList() {
    return Object.entries(strat || {})
      .filter(([, v]) => v && typeof v === "object")
      .map(([id, v]) => Object.assign({ id }, v));
  }
  function stratOf(acctId) {
    return stratList().filter((s) => acctIdOfStrategy(s) === acctId);
  }
  function normAcc(a) {
    const M = { "权益": "balance", "浮动盈亏": "float_profit", "浮盈": "float_profit",
                "平仓盈亏": "close_profit", "手续费": "commission", "保证金": "margin",
                "可用": "available", "可用资金": "available" };
    const o = {};
    for (const k in (a || {})) o[M[k] || k] = a[k];
    return o;
  }
  /* 账户清单 = 终端账户 + 每个自带 TqSim 的策略 */
  function buildAccounts() {
    const out = [];
    const seen = new Set();
    for (const a of accounts) {
      if (a.kind === "strat") continue;        // 后端也会塞策略账户, 这里统一自己算
      out.push(Object.assign({}, a));
      seen.add(a.id);
    }
    for (const s of stratList()) {
      const id = acctIdOfStrategy(s);
      if (seen.has(id)) continue;              // 挂在 kq/real 上的策略不另起账户
      seen.add(id);
      out.push({ id, kind: "strat", name: s.name || s.id, ok: true, _strat: s });
    }
    return out;
  }
  function accMeta(id) { return buildAccounts().find((a) => a.id === id) || null; }
  /* 账户的资金快照: 终端账户走 acct 推送, 策略账户走策略自己上报的 */
  function sumOf(a) {
    if (!a) return {};
    if (a.kind === "strat") {
      const s = (a._strat) || stratOf(a.id)[0];
      return s ? normAcc(s.account) : {};
    }
    const snap = acctSnap[a.id];
    if (snap && snap.sum) return snap.sum;
    // 终端账户上没数据时, 用挂在它下面的策略的账户快照兜底(TqKq 共享账户就是这种情况)
    const ss = stratOf(a.id);
    return ss.length ? normAcc(ss[0].account) : {};
  }
  /* 策略账户的数据在策略状态里, 不在 acct 推送里 —— 合成一份给 AccountView 用,
     否则它按 id 查不到快照, 会一直停在"正在连接账户…" */
  /* 策略上报的持仓是「一笔一行」的简表(code/方向/手数/开仓价/浮盈bp),
     AccountView 认的却是 TqSdk 那套 pos_long/pos_short/open_price_long…
     —— 形状不一样, 得转一次。原来这里直接写死 pos:[], 结果策略明明报了持仓,
     「持仓」表永远显示"当前无持仓"。日内策略开的都是今仓。 */
  function posOfStrat(a) {
    const out = [];
    for (const s of stratOf(a.id)) {
      for (const p of (s.positions || [])) {
        const v = num(p.volume) || 0;
        if (!v) continue;
        const long = String(p.direction || "") !== "空";
        const o = { symbol: p.symbol || p.code, last_price: num(p.last_price),
                    float_profit: num(p.float_profit), margin: num(p.margin) };
        const op = num(p.open_price);
        if (long) { o.pos_long = v; o.pos_long_today = v; o.open_price_long = op; }
        else { o.pos_short = v; o.pos_short_today = v; o.open_price_short = op; }
        const bp = num(p.float_bp);
        if (bp != null) o.float_profit_r = bp / 1e4;   // 浮盈相对开仓价
        out.push(o);
      }
    }
    return out;
  }
  function snapFor(id) {
    const a = accMeta(id);
    if (!a) return acctSnap;
    if (a.kind !== "strat") return acctSnap;
    const pos = posOfStrat(a);
    const o = Object.assign({}, acctSnap);
    o[id] = { sum: sumOf(a), pos: pos, nord: pos.length };
    return o;
  }
  function hungOf(a) {
    for (const s of stratOf(a.id)) {
      const st = String(s.status || "").toLowerCase();
      const dead = st.includes("err") || st.includes("stop") || st.includes("disconn");
      const o = num((s.stats || {})["已开仓"]) || 0, c = num((s.stats || {})["已平仓"]) || 0;
      if (dead && o > c) return o - c;
    }
    return 0;
  }

  /* ---------------- 账户栏 ----------------
     ⚠️ 这里**不能每帧重建 DOM**。原来 tick() 每帧 `bar.innerHTML=""` 再整条重建,
     一个动作同时毁掉两件事:
       · 视觉上一直在闪
       · **点击失效** —— mousedown 之后节点就被换掉了, mouseup 落到新节点上,
         浏览器不判定为 click, 表现就是"点了没反应、要连点好几下才切得动"
     所以拆成两条路: 结构(账户增减/改名/选中项/挂仓警告)变了才重建, 其余只改数字。 */
  let accSig = "";
  function setTxt(n, s) { if (n && n.textContent !== s) n.textContent = s; }
  function dayPnl(sum) {
    if (num(sum.balance) != null && num(sum.pre_balance) != null)
      return sum.balance - sum.pre_balance;
    if (num(sum.close_profit) != null || num(sum.float_profit) != null)
      return (num(sum.close_profit) || 0) - (num(sum.commission) || 0)
        + (num(sum.float_profit) || 0);
    return null;
  }
  function renderAccs() {
    const bar = els.accs;
    const list = buildAccounts();
    if (!list.length) { bar.innerHTML = ""; accSig = ""; return; }
    // 策略快照通常比 acct_list 晚到, 这时 list 里还没有策略账户。若此刻就把
    // 持久化的选择重置成 list[0], 用户刷新后永远回到第一个账户。等两边都到齐再兜底。
    if (!curAcct) curAcct = list[0].id;
    else if (gotAccts && gotStrat && !list.some((a) => a.id === curAcct)) curAcct = list[0].id;

    const sig = list.map((a) => [a.id, a.name || a.id, a.kind, a.ok === false ? 1 : 0,
      a.id === curAcct ? 1 : 0, hungOf(a)].join("~")).join("|");
    if (sig !== accSig) {
      accSig = sig;
      bar.innerHTML = "";
      for (const a of list) {
        const t = el("div", "tv-acc" + (a.id === curAcct ? " on" : "") +
          (a.kind === "real" ? " real" : "") + (a.ok === false ? " dead" : ""));
        t.dataset.id = a.id;
        const tag = a.kind === "real" ? '<span class="tv-tag real">实盘</span>'
          : a.kind === "kq" ? '<span class="tv-tag kq">快期模拟</span>'
            : '<span class="tv-tag sim">模拟</span>';
        const hung = hungOf(a);
        t.innerHTML = `<div class="n">${a.name || a.id}${tag}` +
          (hung ? `<span class="tv-tag warn">${hung} 仓未平</span>` : "") + "</div>" +
          `<div class="b"></div><div class="d"></div><div class="s"></div>`;
        t.onclick = () => {
          if (curAcct === a.id) return;          // 点当前账户不必整页重绘
          curAcct = a.id;
          try { localStorage.setItem("mw:tvacct", curAcct); } catch (e) { /* 忽略 */ }
          renderAccs(); renderTabs(); renderBody();
        };
        bar.appendChild(t);
      }
    }
    // 每帧只写数字。按下标取节点 —— 上面就是按 list 顺序建的, 且 id 也在签名里,
    // 顺序一定对得上; 这样不用给带冒号的 id(strat:xxx)做选择器转义。
    list.forEach((a, i) => {
      const t = bar.children[i];
      if (!t || t.dataset.id !== a.id) return;
      const sum = sumOf(a), day = dayPnl(sum);
      const ns = stratOf(a.id).length;
      const run = stratOf(a.id).filter((s) => String(s.status || "").includes("run")).length;
      setTxt(t.querySelector(".b"), money(sum.balance));
      const d = t.querySelector(".d");
      setTxt(d, "盈亏 " + signed(day));
      if (d && d.className !== "d " + cls(day)) d.className = "d " + cls(day);
      setTxt(t.querySelector(".s"),
        ns ? `${ns} 个策略` + (run ? ` · ${run} 运行中` : "") : "无策略");
    });
  }

  /* ---------------- 内部页签 ---------------- */
  function renderTabs() {
    const bar = els.tabs;
    bar.innerHTML = "";
    const ns = stratOf(curAcct).length;
    for (const [k, label] of TABS) {
      const b = el("button", k === curTab ? "on" : "");
      b.innerHTML = label + (k === "strat" && ns ? `<span class="cnt">${ns}</span>` : "");
      b.onclick = () => {
        curTab = k;
        try { localStorage.setItem("mw:tvtab", k); } catch (e) { /* 忽略 */ }
        renderTabs(); renderBody();
      };
      bar.appendChild(b);
    }
  }

  /* ---------------- 内容 ---------------- */
  let mounted = { home: false, strat: false, nav: false, pos: false };
  let ovSig = "", ovNode = null;                 // 概览页: 结构签名 + 根节点
  function renderBody() {
    const b = els.body;
    b.innerHTML = "";
    mounted = { home: false, strat: false, nav: false, pos: false };
    const a = accMeta(curAcct);
    if (!a) {
      b.appendChild(Object.assign(el("div", "tv-empty"), {
        innerHTML: "还没有账户。<br>默认会起一个本地模拟盘; 要接快期模拟或实盘, " +
          "在数据目录建 <code>accounts.json</code>。",
      }));
      return;
    }
    const sec = el("div");
    sec.style.cssText = "flex:1 1 auto;min-height:0;min-width:0;display:flex";
    b.appendChild(sec);
    if (curTab === "strat") {
      if (window.StrategyView) {
        StrategyView.mount(sec, Object.assign({}, opts, { accountId: curAcct }));
        StrategyView.update(strat);
        mounted.strat = true;
      }
    } else if (curTab === "nav") {
      if (window.NavChart) {
        NavChart.mount(sec, Object.assign({}, opts, { fixedAccount: curAcct }));
        mounted.nav = true;
      }
    } else if (curTab === "pos") {
      if (window.AccountView) {
        AccountView.mount(sec, Object.assign({}, opts,
          { fixedAccount: curAcct, snapshot: snapFor(curAcct) }));
        mounted.pos = true;
      }
      if (a.kind === "strat") {
        const n = el("div");
        n.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:6px 14px;" +
          "color:var(--muted,#898781);font-size:11px;background:var(--surface,#1a1a19);" +
          "border-top:1px solid var(--border,rgba(255,255,255,.1))";
        n.textContent = "策略账户跑在子进程里, 持仓/委托/成交都是策略自己上报的 —— " +
          "只在它活着的时候有数据; 进程停了就停在最后一次上报。";
        sec.style.position = "relative";
        sec.appendChild(n);
      }
    } else {
      ovNode = overview(a);
      ovSig = homeSig(a);
      sec.appendChild(ovNode);
      mounted.home = true;
    }
  }

  /* 概览的数字。建和刷新共用同一份定义, 免得两处对不上 */
  function ovItems(sum) {
    const net = (num(sum.close_profit) || 0) - (num(sum.commission) || 0);
    return [
      ["balance", "账户权益", money(sum.balance), ""],
      ["available", "可用资金", money(sum.available), ""],
      ["margin", "保证金占用", money(sum.margin), ""],
      ["float", "浮动盈亏", signed(sum.float_profit), cls(sum.float_profit)],
      ["close", "平仓盈亏", signed(sum.close_profit), cls(sum.close_profit)],
      ["fee", "手续费",
        num(sum.commission) == null ? "—" : "-" + money(sum.commission), ""],
      ["net", "已落袋", signed(net), cls(net)],
    ];
  }

  /* 概览: 这个账户的资金 + 挂在它下面的策略一览 */
  function overview(a) {
    const wrap = el("div");
    wrap.style.cssText = "flex:1 1 auto;min-height:0;overflow:auto;padding:12px 14px 26px";
    const sum = sumOf(a);
    const g = el("div");
    g.style.cssText = "display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;margin-bottom:14px";
    for (const [k, label, v, c] of ovItems(sum)) {
      const d = el("div");
      d.style.cssText = "background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));border-radius:7px;padding:7px 10px";
      d.innerHTML = `<div style="color:var(--muted,#898781);font-size:10.5px">${label}</div>` +
        `<div class="${c}" data-k="${k}" style="font-size:18px;font-weight:600;font-variant-numeric:tabular-nums">${v}</div>`;
      g.appendChild(d);
    }
    wrap.appendChild(g);

    const ss = stratOf(a.id);
    const t = el("div");
    t.style.cssText = "color:var(--ink,#fff);font-size:13px;font-weight:600;margin-bottom:7px";
    t.textContent = `本账户的策略 (${ss.length})`;
    wrap.appendChild(t);
    if (!ss.length) {
      wrap.appendChild(Object.assign(el("div", "tv-empty"), {
        textContent: "这个账户下还没有策略。到「策略」页启动一个, 或在终端里手动运行。",
      }));
      return wrap;
    }
    for (const s of ss) {
      const row = el("div");
      row.dataset.sid = s.id;
      row.style.cssText = "display:flex;align-items:center;gap:10px;padding:8px 11px;margin-bottom:6px;" +
        "background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));" +
        "border-radius:7px;cursor:pointer;flex-wrap:wrap";
      row.innerHTML =
        `<b style="color:var(--ink,#fff);font-size:13px">${s.name || s.id}</b>` +
        `<span data-k="lab" style="font-size:11px"></span>` +
        `<span data-k="phase" style="color:var(--muted,#898781);font-size:11px"></span>` +
        `<span style="flex:1 1 auto"></span>` +
        `<span data-k="cnt" style="color:var(--muted,#898781);font-size:11px"></span>` +
        `<span data-k="hung" class="tv-tag warn" style="display:none"></span>`;
      row.onclick = () => {
        curTab = "strat";
        try { localStorage.setItem("mw:tvtab", "strat"); } catch (e) { /* 忽略 */ }
        renderTabs(); renderBody();
        if (window.StrategyView && StrategyView.select) StrategyView.select(s.id);
      };
      wrap.appendChild(row);
    }
    updateOverview(a, wrap);
    return wrap;
  }

  /* 概览的每帧刷新: 只改文字, 不动 DOM 结构 */
  function updateOverview(a, wrap) {
    const sum = sumOf(a);
    for (const [k, , v, c] of ovItems(sum)) {
      const n = wrap.querySelector(`[data-k="${k}"]`);
      if (!n) continue;
      setTxt(n, v);
      if (n.className !== c) n.className = c;
    }
    for (const s of stratOf(a.id)) {
      const row = wrap.querySelector(`[data-sid="${s.id.replace(/"/g, '\\"')}"]`);
      if (!row) continue;
      const st = String(s.status || "").toLowerCase();
      const kind = st.includes("err") ? "error" : st.includes("run") ? "running" : "stopped";
      const lab = row.querySelector('[data-k="lab"]');
      setTxt(lab, kind === "error" ? "异常" : kind === "running" ? "运行中" : "已停止");
      lab.style.color = kind === "running" ? "var(--down,#199e70)"
        : kind === "error" ? "var(--up,#e66767)" : "var(--muted,#898781)";
      setTxt(row.querySelector('[data-k="phase"]'), s.phase || "");
      const o = num((s.stats || {})["已开仓"]) || 0;
      const cN = num((s.stats || {})["已平仓"]) || 0;
      setTxt(row.querySelector('[data-k="cnt"]'), `开 ${o} / 平 ${cN}`);
      const h = row.querySelector('[data-k="hung"]');
      const show = kind !== "running" && o > cN;
      setTxt(h, show ? `${o - cN} 仓未平` : "");
      h.style.display = show ? "" : "none";
    }
  }

  /* 概览页的结构签名: 账户 + 它下面的策略集合。只有这个变了才值得重建 DOM */
  function homeSig(a) {
    return a.id + "|" + stratOf(a.id).map((s) => s.id).join(",");
  }

  function tick() {
    if (raf || !visible() || !root) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      renderAccs();
      if (curTab === "home" && mounted.home) {
        const a = accMeta(curAcct);
        if (!a) return;
        // 结构没变就只刷数字 —— 每帧重建概览同样会闪, 还会把滚动位置顶回顶部
        if (homeSig(a) !== ovSig || !ovNode || !ovNode.isConnected) renderBody();
        else updateOverview(a, ovNode);
      }
    });
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      root = el("div"); root.id = "tv-root";
      const accs = el("div", "tv-accs");
      const tabs = el("div", "tv-tabs");
      const body = el("div", "tv-body");
      root.append(accs, tabs, body);
      host.innerHTML = "";
      host.appendChild(root);
      els = { accs, tabs, body };
      renderAccs(); renderTabs(); renderBody();
      if (opts.request) {
        opts.request("acct_list", {}).then((r) => {
          accounts = (r && r.accounts) || [];
          gotAccts = true;
          renderAccs(); renderTabs(); renderBody();
        }).catch(() => { /* 忽略 */ });
      }
      return true;
    },
    /* 每帧的账户与策略推送 */
    update(acct, st) {
      const hadAcc = Object.keys(acctSnap).length, hadStrat = Object.keys(strat).length;
      if (acct) acctSnap = acct;
      // 空对象也是真值 —— 挂载时传进来的 lastStrat 常常还是 {}, 直接置 gotStrat
      // 会让"两边都到齐了"提前成立, 于是 acct_list 一回来就把持久化的账户选择冲掉
      if (st) { strat = st; if (Object.keys(st).length) gotStrat = true; }
      if (!root) return;
      // 账户/策略集合本身变了要整体重建, 否则只刷数字
      if (!hadAcc !== !Object.keys(acctSnap).length || !hadStrat !== !Object.keys(strat).length) {
        renderAccs(); renderTabs(); renderBody();
        return;
      }
      if (mounted.strat && window.StrategyView) StrategyView.update(strat);
      if (mounted.pos && window.AccountView) AccountView.update(snapFor(curAcct));
      tick();
    },
    account() { return curAcct; },
    isMounted() { return !!root; },
    destroy() {
      if (raf) cancelAnimationFrame(raf), raf = 0;
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = els = null;
    },
  };
})();
