/* 交易 · 净值曲线与绩效分析
 * 数据来自后端持久化的净值序列(服务启动后开始采样), 全部指标由后端 nav_stats 算好,
 * 前端只负责呈现 —— 两边各算一套迟早会对不上口径。
 * 自包含: IIFE + 注入样式, 只暴露 window.NavChart
 */
window.NavChart = (function () {
  "use strict";

  const STYLE_ID = "nv-style";
  const TZ = 8 * 3600;          // lightweight-charts 按 UTC 渲染, 平移到北京时间
  const CSS = `
#nv-root{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;padding:10px 14px 30px;
  background:var(--page,#0d0d0d);color:var(--ink-2,#c3c2b7);
  font:13px/1.45 system-ui,-apple-system,"PingFang SC",sans-serif;display:flex;flex-direction:column}
#nv-root *{box-sizing:border-box}
.nv-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px;flex:0 0 auto}
.nv-bar .sp{flex:1 1 auto}
.nv-btn{background:var(--surface-2,#222221);color:var(--ink-2,#c3c2b7);
  border:1px solid var(--border,rgba(255,255,255,.1));border-radius:6px;
  padding:3px 11px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.nv-btn:hover{color:var(--ink,#fff);border-color:var(--muted,#898781)}
.nv-btn.on{color:var(--ink,#fff);border-color:var(--ma5,#3987e5)}
.nv-lab{color:var(--muted,#898781);font-size:11.5px}
.nv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(124px,1fr));gap:6px;
  margin-bottom:10px;flex:0 0 auto}
.nv-i{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:7px;padding:6px 10px}
.nv-i .k{color:var(--muted,#898781);font-size:10.5px}
.nv-i .v{color:var(--ink,#fff);font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.nv-i .s{color:var(--muted,#898781);font-size:10px;font-variant-numeric:tabular-nums}
.nv-i .v.dim{color:var(--muted,#898781);font-size:15px}
.nv-panes{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:340px}
.nv-p{background:var(--surface,#1a1a19);border:1px solid var(--border,rgba(255,255,255,.1));
  border-radius:8px;overflow:hidden;display:flex;flex-direction:column;position:relative}
.nv-p .t{color:var(--muted,#898781);font-size:11px;padding:3px 10px;flex:0 0 auto;
  border-bottom:1px solid var(--border,rgba(255,255,255,.1))}
.nv-p .t b{color:var(--ink,#fff);font-weight:500}
.nv-p .c{flex:1 1 auto;min-height:0}
.nv-p.main{flex:2 1 0}
.nv-p.dd{flex:1 1 0}
.nv-p.daily{flex:1 1 0}
.nv-up{color:var(--up,#e66767)}.nv-down{color:var(--down,#199e70)}.nv-flat{color:var(--ink-2,#c3c2b7)}
.nv-empty{padding:26px 14px;color:var(--muted,#898781);font-size:12.5px;text-align:center;line-height:1.8}
`;

  const RANGES = [[0, "全部"], [1, "今日"], [7, "近7天"], [30, "近30天"], [90, "近90天"]];

  let host = null, root = null, opts = {};
  let accounts = [], curId = null, days = 0;
  let data = null, loading = false;
  let charts = [];              // [{chart, series...}] 便于统一销毁
  let ro = null, syncing = false;

  function inject() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
  const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);
  const cls = (v) => (v > 0 ? "nv-up" : v < 0 ? "nv-down" : "nv-flat");
  function cssVar(n, d) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    return v || d;
  }
  function money(v) {
    const n = num(v);
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
    if (a >= 1e4) return (n / 1e4).toFixed(2) + "万";
    return n.toFixed(2);
  }
  const pct = (v, d) => (num(v) == null ? null : (num(v) * 100).toFixed(d == null ? 2 : d) + "%");
  const spct = (v, d) => { const s = pct(v, d); return s == null ? null : (num(v) > 0 ? "+" : "") + s; };
  function dstr(ts) {
    const n = num(ts);
    return n == null ? "" : new Date(n * 1000).toISOString().slice(0, 10);
  }

  /* ---------------- 指标网格 ---------------- */
  /* 后端样本不足时返回 null。这里必须显示"—"而不是 0 ——
     把"还算不出来"画成 0% 会让人以为策略真的没波动。 */
  function metricGrid(st) {
    const g = el("div", "nv-grid");
    const items = [
      ["累计收益", spct(st.ret), cls(st.ret), `${st.samples || 0} 个采样点`],
      ["年化收益", spct(st.ret_ann), cls(st.ret_ann), st.ret_ann == null ? "样本不足 2 天" : ""],
      ["最大回撤", pct(st.mdd), st.mdd ? "nv-down" : "",
        (st.mdd_start && st.mdd_end) ? `${dstr(st.mdd_start)} → ${dstr(st.mdd_end)}` : ""],
      ["当前回撤", pct(st.cur_dd), st.cur_dd ? "nv-down" : "",
        st.peak == null ? "" : `峰值 ${money(st.peak)}`],
      ["夏普", st.sharpe == null ? null : (+st.sharpe).toFixed(2), cls(st.sharpe),
        st.sharpe == null ? "样本不足 2 天" : "日频, rf=0"],
      ["卡玛", st.calmar == null ? null : (+st.calmar).toFixed(2), cls(st.calmar),
        st.calmar == null ? "无回撤或样本不足" : ""],
      ["年化波动", pct(st.vol_ann), "", st.vol_ann == null ? "样本不足 2 天" : ""],
      ["盈亏天数", (st.win_days == null ? null : `${st.win_days} : ${st.lose_days}`), "", "盈利 : 亏损"],
      ["最好一天", spct(st.best_day), cls(st.best_day), ""],
      ["最差一天", spct(st.worst_day), cls(st.worst_day), ""],
      ["统计天数", st.days == null ? null : String(st.days), "", ""],
    ];
    for (const [k, v, c, sub] of items) {
      const i = el("div", "nv-i");
      const shown = (v == null || v === "") ? "—" : v;
      const dim = (v == null || v === "") ? " dim" : "";
      i.innerHTML = `<div class="k">${k}</div><div class="v ${c || ""}${dim}">${shown}</div>` +
        (sub ? `<div class="s">${sub}</div>` : "");
      if (v == null || v === "") i.title = sub || "样本不足";
      g.appendChild(i);
    }
    return g;
  }

  /* ---------------- 图表 ---------------- */
  function disposeCharts() {
    for (const c of charts) { try { c.chart.remove(); } catch (e) { /* 已销毁 */ } }
    charts = [];
    if (ro) { try { ro.disconnect(); } catch (e) { /* 忽略 */ } ro = null; }
  }
  function baseOpts(h) {
    return {
      layout: { background: { color: "transparent" }, textColor: cssVar("--muted", "#898781"), fontSize: 10 },
      grid: { vertLines: { color: cssVar("--grid", "#2c2c2a") }, horzLines: { color: cssVar("--grid", "#2c2c2a") } },
      rightPriceScale: { borderColor: cssVar("--border", "rgba(255,255,255,.1)"), minimumWidth: 74 },
      timeScale: { borderColor: cssVar("--border", "rgba(255,255,255,.1)"),
                   timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      height: h,
    };
  }
  function makePanes(wrap, points) {
    disposeCharts();
    const up = cssVar("--up", "#e66767"), down = cssVar("--down", "#199e70");

    const p1 = el("div", "nv-p main");
    p1.innerHTML = '<div class="t"><b>账户权益</b> · 淡色为可用资金</div>';
    const c1 = el("div", "c"); p1.appendChild(c1);
    const p2 = el("div", "nv-p dd");
    p2.innerHTML = '<div class="t"><b>回撤</b> · 距历史峰值的百分比</div>';
    const c2 = el("div", "c"); p2.appendChild(c2);
    const p4 = el("div", "nv-p dd");
    p4.innerHTML = '<div class="t"><b>浮动盈亏</b> · 未平仓位的账面盈亏, 平仓前都会变</div>';
    const c4 = el("div", "c"); p4.appendChild(c4);
    const p3 = el("div", "nv-p daily");
    p3.innerHTML = '<div class="t"><b>日盈亏</b> · 按自然日归并</div>';
    const c3 = el("div", "c"); p3.appendChild(c3);
    wrap.append(p1, p2, p4, p3);

    const ch1 = LightweightCharts.createChart(c1, baseOpts(c1.clientHeight || 220));
    const eq = ch1.addLineSeries({ color: cssVar("--ma5", "#3987e5"), lineWidth: 2, title: "权益" });
    const av = ch1.addLineSeries({ color: "rgba(57,135,229,.35)", lineWidth: 1, title: "可用" });
    const ch2 = LightweightCharts.createChart(c2, baseOpts(c2.clientHeight || 110));
    const dd = ch2.addAreaSeries({
      lineColor: down, topColor: "rgba(25,158,112,.05)", bottomColor: "rgba(25,158,112,.35)",
      lineWidth: 1, priceFormat: { type: "percent" },
    });
    const ch4 = LightweightCharts.createChart(c4, baseOpts(c4.clientHeight || 110));
    const fpS = ch4.addAreaSeries({
      lineColor: cssVar("--ma5", "#3987e5"), lineWidth: 1,
      topColor: "rgba(57,135,229,.28)", bottomColor: "rgba(57,135,229,.02)",
    });
    const ch3 = LightweightCharts.createChart(c3, baseOpts(c3.clientHeight || 110));
    const dl = ch3.addHistogramSeries({ priceFormat: { type: "volume" } });

    /* 权益 / 可用 */
    const eqD = [], avD = [], ddD = [];
    let peak = -Infinity, last = null;
    for (const r of points) {
      const t = Math.round(r[0]) + TZ;
      if (last === t) continue;                 // 同秒多条会被 setData 判定成时间倒退
      last = t;
      const b = num(r[1]);
      if (b == null) continue;
      eqD.push({ time: t, value: b });
      if (num(r[2]) != null) avD.push({ time: t, value: r[2] });
      peak = Math.max(peak, b);
      ddD.push({ time: t, value: peak > 0 ? (b - peak) / peak : 0 });
    }
    const fpD = [];
    last = null;
    for (const r of points) {
      const t = Math.round(r[0]) + TZ;
      if (last === t) continue;
      last = t;
      if (num(r[4]) != null) fpD.push({ time: t, value: r[4] });
    }
    eq.setData(eqD); av.setData(avD); dd.setData(ddD); fpS.setData(fpD);

    /* 日盈亏: 按自然日取每日最后一条权益做差 */
    const byDay = new Map();
    for (const r of points) {
      const b = num(r[1]);
      if (b == null) continue;
      byDay.set(new Date((r[0] + TZ) * 1000).toISOString().slice(0, 10), { t: Math.round(r[0]) + TZ, b });
    }
    const dayKeys = [...byDay.keys()].sort();
    const dlD = [];
    let prevB = null;
    for (const k of dayKeys) {
      const { t, b } = byDay.get(k);
      if (prevB != null) dlD.push({ time: t, value: b - prevB, color: b >= prevB ? up : down });
      prevB = b;
    }
    dl.setData(dlD);

    /* 时间轴同步: 以权益图为中心单向推。两两互联时空图会回灌异常区间, 这个坑踩过。 */
    const push = (r) => {
      if (syncing || !r) return;
      syncing = true;
      for (const c of [ch2, ch3, ch4]) {
        try { c.timeScale().setVisibleLogicalRange(r); } catch (e) { /* 尚无数据 */ }
      }
      syncing = false;
    };
    ch1.timeScale().subscribeVisibleLogicalRangeChange(push);

    charts = [{ chart: ch1 }, { chart: ch2 }, { chart: ch3 }, { chart: ch4 }];
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        for (const [c, box] of [[ch1, c1], [ch2, c2], [ch3, c3], [ch4, c4]]) {
          if (box.clientWidth && box.clientHeight) c.resize(box.clientWidth, box.clientHeight);
        }
      });
      ro.observe(c1); ro.observe(c2); ro.observe(c3); ro.observe(c4);
    }
    requestAnimationFrame(() => {
      for (const [c, box] of [[ch1, c1], [ch2, c2], [ch3, c3], [ch4, c4]]) {
        if (box.clientWidth && box.clientHeight) c.resize(box.clientWidth, box.clientHeight);
      }
      ch1.timeScale().fitContent();
    });
  }

  /* ---------------- 组装 ---------------- */
  function toolbar() {
    const bar = el("div", "nv-bar");
    // 外壳已经选好账户了, 这里不该再出现第二个账户选择器
    if (!opts.fixedAccount && accounts.length > 1) {
      bar.appendChild(Object.assign(el("span", "nv-lab"), { textContent: "账户" }));
      for (const a of accounts) {
        const b = el("button", "nv-btn" + (a.id === curId ? " on" : ""));
        // 策略跑在各自独立的模拟账户上, 和终端自带账户不是一回事, 标出来
        b.textContent = (a.kind === "strat" ? "策略·" : "") + (a.name || a.id);
        b.onclick = () => { curId = a.id; load(); };
        bar.appendChild(b);
      }
    }
    bar.appendChild(Object.assign(el("span", "nv-lab"), { textContent: "区间" }));
    for (const [d, label] of RANGES) {
      const b = el("button", "nv-btn" + (d === days ? " on" : ""));
      b.textContent = label;
      b.onclick = () => { days = d; load(); };
      bar.appendChild(b);
    }
    bar.appendChild(el("span", "sp"));
    const r = el("button", "nv-btn");
    r.textContent = "↻ 刷新";
    r.onclick = () => load();
    bar.appendChild(r);
    return bar;
  }
  function build() {
    if (!root) return;
    disposeCharts();
    root.innerHTML = "";
    root.appendChild(toolbar());
    if (loading && !data) {
      root.appendChild(Object.assign(el("div", "nv-empty"), { textContent: "加载中…" }));
      return;
    }
    if (!data) {
      root.appendChild(Object.assign(el("div", "nv-empty"),
        { textContent: "还没有账户数据。到「交易 · 账户」看看账户是否已连接。" }));
      return;
    }
    const pts = data.points || [];
    const st = data.stats || {};
    root.appendChild(metricGrid(st));
    if (pts.length < 2) {
      const e = el("div", "nv-empty");
      e.innerHTML = "净值序列还太短, 画不出曲线。<br>" +
        "采样是从<b>服务启动后</b>开始的, 每 30 秒一条(权益跳变时会补点), " +
        "跑一段时间就有了。<br>历史会落盘, 重启不丢。";
      root.appendChild(e);
      return;
    }
    const panes = el("div", "nv-panes");
    root.appendChild(panes);
    // 要等元素进 DOM 拿到尺寸, 否则图表宽高都是 0
    requestAnimationFrame(() => { if (root && root.contains(panes)) makePanes(panes, pts); });
  }
  function load() {
    if (!opts.request || !curId) { build(); return; }
    loading = true;
    build();
    opts.request("acct_nav", { id: curId, days }).then((r) => {
      loading = false;
      if (!root) return;
      data = (r && r.points) ? r : null;
      build();
    }).catch(() => { loading = false; data = null; build(); });
  }
  function pullAccounts() {
    if (!opts.request) return;
    opts.request("acct_list", {}).then((r) => {
      accounts = (r && r.accounts) || [];
      if (!curId && accounts.length) {
        // 终端自带的 sim 账户没人交易, 默认选它的话打开永远是一条直线。
        // 有策略账户就优先选第一个策略。
        const st = accounts.find((a) => a.kind === "strat");
        curId = (st || accounts[0]).id;
      }
      load();
    }).catch(() => build());
  }

  return {
    mount(rootEl, options) {
      if (!rootEl) return false;
      inject();
      host = rootEl; opts = options || {};
      root = el("div"); root.id = "nv-root";
      host.innerHTML = "";
      host.appendChild(root);
      if (opts.fixedAccount) { curId = opts.fixedAccount; build(); load(); }
      else { build(); pullAccounts(); }
      return true;
    },
    setAccount(id) { if (id && id !== curId) { curId = id; load(); } },
    refresh() { if (root) (curId ? load() : pullAccounts()); },
    isMounted() { return !!root; },
    destroy() {
      disposeCharts();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      host = root = null;
    },
  };
})();
