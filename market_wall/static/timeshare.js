/* ============================================================================
   timeshare.js — 分时图渲染模块 (原生 Canvas 2D, 无依赖)
   ----------------------------------------------------------------------------
   复刻手机行情 App 的"分时"页:
     · 序号轴  —— x 轴是当日交易时段的分钟槽位序号, 夜盘与日盘无缝拼接
     · 价格线  —— 当日 1 分钟收盘价 (--ma5 蓝), 线下渐变填充
     · 均价线  —— hlc3 按 volume 加权的累计 VWAP (--ma10 橙)
     · y 轴    —— 以昨结/昨收为中轴上下等幅对称, 左标价格右标涨跌幅
     · 副图    —— 底部 1/4 高的分钟成交量柱, 红涨绿跌
     · 十字光标 —— 独立 overlay canvas, 不触发主图重绘

   对外接口:
     window.TimeShare.mount(containerEl, opts)   opts: { fmtVol(n) }
     window.TimeShare.render(state)
        state = {
          bars:        [{t,o,h,l,c,v}, ...]  // 全部 1 分钟K线, t 为 UTC 纪元秒
          tradingTime: {day:[["09:00:00","10:15:00"],...], night:[...]}
          base:        昨结算价(期货) / 昨收(股票)
          digits:      小数位
          name:        合约名
          dayVolume:   当日累计成交量(quote.volume), 用于切出当日部分
        }
     window.TimeShare.destroy()
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------- 常量 ---------------- */
  const TZ_SHIFT = 8 * 3600;        // 时间戳是 UTC 纪元秒, +8h 后用 getUTC* 读出北京时间
  const STYLE_ID = "timeshare-style";
  const FONT = '11px system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif';
  const FONT_SM = '10px system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif';
  const GAP_BREAK = 5;              // 槽位间隔超过这么多就断线(视为缺口)

  const CSS = `
.ts-root{position:relative;width:100%;height:100%;overflow:hidden;
  font:${FONT};color:var(--ink-2,#c3c2b7);-webkit-user-select:none;user-select:none;}
.ts-root canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}
.ts-root .ts-ov{pointer-events:none;}
.ts-legend{position:absolute;left:6px;top:4px;right:6px;z-index:3;pointer-events:none;
  display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;
  font-size:11px;line-height:1.4;color:var(--muted,#898781);
  font-variant-numeric:tabular-nums;text-shadow:0 0 4px var(--page,#0d0d0d);}
.ts-legend .ts-name{color:var(--ink,#fff);font-weight:600;}
.ts-legend b{font-weight:600;font-variant-numeric:tabular-nums;}
.ts-legend b.up{color:var(--up,#e66767);}
.ts-legend b.down{color:var(--down,#199e70);}
.ts-legend b.flat{color:var(--ink-2,#c3c2b7);}
.ts-legend .ts-avg{color:var(--ma10,#d95926);}
.ts-legend .ts-vol{color:var(--ink-2,#c3c2b7);}
`;

  /* ---------------- 工具 ---------------- */
  const $c = (t) => document.createElement(t);

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    const s = $c("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  let C = null;
  function cssVar(n, fb) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      return v || fb;
    } catch (e) { return fb; }
  }
  function colors() {
    if (C) return C;
    C = {
      page: cssVar("--page", "#0d0d0d"),
      surface2: cssVar("--surface-2", "#222221"),
      ink: cssVar("--ink", "#ffffff"),
      ink2: cssVar("--ink-2", "#c3c2b7"),
      muted: cssVar("--muted", "#898781"),
      grid: cssVar("--grid", "#2c2c2a"),
      up: cssVar("--up", "#e66767"),
      down: cssVar("--down", "#199e70"),
      line: cssVar("--ma5", "#3987e5"),
      avg: cssVar("--ma10", "#d95926"),
    };
    return C;
  }
  function rgba(hex, a) {
    let h = String(hex).trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16) || 0,
      g = parseInt(h.slice(2, 4), 16) || 0,
      b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r},${g},${b},${a})`;
  }
  const p2 = (x) => String(x).padStart(2, "0");
  function min2hm(m) { m = ((m % 1440) + 1440) % 1440; return p2((m / 60) | 0) + ":" + p2(m % 60); }
  function defVol(n) {
    if (n == null || !isFinite(n)) return "—";
    return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(n);
  }

  /* trading_time 里的 "25:00:00"/"26:30:00" 是跨零点表示法, 这里保留原始分钟数(不取模),
     方便算区间长度; 落到轴上时再 %1440 换成真实时钟 */
  function hms2min(s) {
    const p = String(s).split(":");
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  /* 由 trading_time 生成当日交易分钟槽位表。
     一根 1 分钟K线的时间戳是该根的**起始**分钟, 所以区间 [a,b) 长度就是 b-a 根。
     顺序: 夜盘在前(夜盘属于同一交易日的开头), 日盘在后。 */
  function buildSlots(tt) {
    const ranges = [];
    if (tt && Array.isArray(tt.night)) tt.night.forEach((r) => ranges.push(r));
    if (tt && Array.isArray(tt.day)) tt.day.forEach((r) => ranges.push(r));
    const segs = [];
    const map = new Map();          // 真实分钟(0..1439) -> 槽位序号
    let slot = 0;
    for (const r of ranges) {
      if (!r || r.length < 2) continue;
      const a = hms2min(r[0]);
      let n = hms2min(r[1]) - a;
      if (n <= 0) n += 1440;
      if (n <= 0 || n > 1440) continue;
      for (let i = 0; i < n; i++) {
        const m = (a + i) % 1440;
        if (!map.has(m)) map.set(m, slot + i);
      }
      segs.push({ s: slot, e: slot + n, sMin: a % 1440, eMin: (a + n) % 1440 });
      slot += n;
    }
    return { n: slot, segs, map };
  }

  /* 切出"当日"那一段。
     ① dayVolume 存在时先做便宜的预筛: 从末尾往回累计 volume, 第一个累计值 <= dayVolume 的位置是起点
     ② 再用槽位序号的严格递增性收紧 —— 跨交易日时槽位序号必然回退, 这一步单独就足以定界 */
  function sliceDay(bars, dayVolume, map, slotCount) {
    if (!bars || !bars.length) return [];
    let from = 0;
    if (dayVolume > 0) {
      let cum = 0;
      from = bars.length;
      for (let i = bars.length - 1; i >= 0; i--) {
        cum += bars[i].v || 0;
        if (cum > dayVolume) break;
        from = i;
      }
      if (from >= bars.length) from = Math.max(0, bars.length - slotCount);
    } else {
      from = Math.max(0, bars.length - slotCount);
    }
    const pts = [];
    for (let i = from; i < bars.length; i++) {
      const b = bars[i];
      if (!b || b.c == null || !isFinite(b.c)) continue;
      const d = new Date((b.t + TZ_SHIFT) * 1000);
      const si = map.get(d.getUTCHours() * 60 + d.getUTCMinutes());
      if (si == null) continue;     // 不在交易时段的槽位表里 -> 丢弃
      pts.push({ si: si, b: b });
    }
    if (!pts.length) return [];
    let k = pts.length - 1;
    while (k > 0 && pts[k - 1].si < pts[k].si) k--;
    return pts.slice(k);
  }

  /* 累计 VWAP: quote.average 被舍入到 price_tick 量级不可用, 这里用 1 分钟线的 hlc3 按量加权 */
  function calcSeries(pts) {
    let cumPV = 0, cumV = 0, lastAvg = null;
    for (const p of pts) {
      const b = p.b, v = b.v || 0;
      if (v > 0) { cumPV += ((b.h + b.l + b.c) / 3) * v; cumV += v; }
      p.avg = cumV > 0 ? cumPV / cumV : (lastAvg != null ? lastAvg : b.c);
      lastAvg = p.avg;
      p.cumV = cumV;
    }
    return pts;
  }

  /* 按槽位连续性切段, 缺口处断线(未成交/未开盘的槽位留空) */
  function runsOf(pts) {
    const out = [];
    let cur = [];
    for (let i = 0; i < pts.length; i++) {
      if (cur.length && pts[i].si - pts[i - 1].si > GAP_BREAK) { out.push(cur); cur = []; }
      cur.push(pts[i]);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /* ---------------- 模块状态 ---------------- */
  let host = null, root = null, mainCv = null, ovCv = null, legendEl = null;
  let ro = null, opts = {};
  let W = 0, H = 0, dpr = 1;
  let sig = null;               // 主图重绘签名
  let view = null;              // 最近一次成功渲染的几何 + 数据
  let hoverIdx = -1;

  /* ---------------- 布局 ---------------- */
  function layout() {
    const padL = 52, padR = 50, padT = 22, padB = 16, gap = 8;
    const plotH = Math.max(20, H - padT - padB);
    const volH = Math.max(18, Math.round(plotH * 0.24));
    const mainT = padT, mainB = padT + plotH - volH - gap;
    const volT = mainB + gap, volB = padT + plotH;
    return { padL, padR, padT, padB, mainT, mainB, volT, volB, plotW: Math.max(10, W - padL - padR) };
  }

  /* ---------------- 主图绘制 ---------------- */
  function drawMain(st) {
    const c = mainCv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const K = colors();
    c.font = FONT_SM;
    c.textBaseline = "middle";

    const slots = buildSlots(st.tradingTime);
    if (!slots.n) { placeholder(c, "无交易时段信息"); view = null; return; }

    const pts = calcSeries(sliceDay(st.bars || [], st.dayVolume, slots.map, slots.n));
    const L = layout();
    const N = slots.n;
    const colW = L.plotW / N;
    const X = (si) => L.padL + (si + 0.5) * colW;

    /* --- 基准价与对称幅度 --- */
    let base = st.base;
    if (!(base > 0)) base = pts.length ? pts[0].b.o : null;
    if (!(base > 0)) { placeholder(c, "暂无分时数据"); view = null; return; }
    let amp = 0;
    for (const p of pts) {
      amp = Math.max(amp, Math.abs(p.b.h - base), Math.abs(p.b.l - base), Math.abs(p.avg - base));
    }
    amp = amp * 1.06;
    const minAmp = Math.max(base * 0.0012, 1e-9);
    if (!(amp > minAmp)) amp = minAmp;
    const hi = base + amp, lo = base - amp;
    const Y = (v) => L.mainB - ((v - lo) / (hi - lo)) * (L.mainB - L.mainT);

    /* --- 成交量副图刻度 --- */
    let maxV = 0;
    for (const p of pts) maxV = Math.max(maxV, p.b.v || 0);
    if (!(maxV > 0)) maxV = 1;
    const VY = (v) => L.volB - (v / maxV) * (L.volB - L.volT);

    const digits = st.digits != null ? st.digits : 2;
    const fmtP = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(digits));
    const fmtPct = (v) => (v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%");

    /* 最新价在左轴上的位置 —— 提前算出来, 让被"现价牌"压住的刻度标签让位 */
    const lastPt = pts.length ? pts[pts.length - 1] : null;
    const lastY = lastPt ? Y(lastPt.b.c) : null;

    /* --- 横向网格 + 左右轴 --- */
    const levels = [1, 0.5, 0, -0.5, -1];
    for (const f of levels) {
      const v = base + amp * f;
      const y = Math.round(Y(v)) + 0.5;
      c.beginPath();
      c.moveTo(L.padL, y); c.lineTo(W - L.padR, y);
      if (f === 0) { c.strokeStyle = K.muted; c.setLineDash([3, 3]); }
      else { c.strokeStyle = K.grid; c.setLineDash([]); }
      c.lineWidth = 1;
      c.stroke();
      c.setLineDash([]);
      const pct = ((v - base) / base) * 100;
      c.fillStyle = f > 0 ? K.up : f < 0 ? K.down : K.ink2;
      c.textAlign = "right";
      if (lastY == null || Math.abs(y - lastY) > 9) c.fillText(fmtP(v), L.padL - 5, y);
      c.textAlign = "left";
      c.fillText(fmtPct(pct), W - L.padR + 5, y);
    }
    /* 副图上下边界 */
    c.strokeStyle = K.grid; c.lineWidth = 1;
    for (const y0 of [L.volT, L.volB]) {
      const y = Math.round(y0) + 0.5;
      c.beginPath(); c.moveTo(L.padL, y); c.lineTo(W - L.padR, y); c.stroke();
    }
    c.fillStyle = K.muted; c.textAlign = "right";
    c.fillText((opts.fmtVol || defVol)(maxV), L.padL - 5, L.volT + 6);

    /* --- 分段竖线 + 时间刻度(按真实 trading_time 的分段边界打标) ---
       规则: 首段起点、末段终点必标; 每个内部分界标"上一段收盘"时间,
       休市 >=30 分钟时(夜盘→日盘 10h、午休 2h)再补标"下一段开盘"时间,
       10:15→10:30 这种 15 分钟小憩只标 10:15, 避免两个标签挤在一起。 */
    const segs = slots.segs;
    const ticks = [];
    if (segs.length) {
      ticks.push({ x: L.padL, label: min2hm(segs[0].sMin), align: "left", pri: 3 });
      ticks.push({ x: W - L.padR, label: min2hm(segs[segs.length - 1].eMin), align: "right", pri: 3 });
      for (let i = 0; i < segs.length - 1; i++) {
        const bx = X(segs[i + 1].s) - colW / 2;
        const brk = ((segs[i + 1].sMin - segs[i].eMin) % 1440 + 1440) % 1440;
        const pri = brk >= 120 ? 3 : 2;   // 夜/日交界(>=2h)优先级最高
        ticks.push({ x: bx - 3, label: min2hm(segs[i].eMin), align: "right", pri: pri });
        if (brk >= 30) ticks.push({ x: bx + 3, label: min2hm(segs[i + 1].sMin), align: "left", pri: pri - 1 });
      }
    }
    // 分段竖线
    c.strokeStyle = K.grid; c.setLineDash([]);
    for (let i = 1; i < slots.segs.length; i++) {
      const x = Math.round(X(slots.segs[i].s) - colW / 2) + 0.5;
      c.beginPath(); c.moveTo(x, L.mainT); c.lineTo(x, L.mainB); c.stroke();
      c.beginPath(); c.moveTo(x, L.volT); c.lineTo(x, L.volB); c.stroke();
    }
    // 标签避让: 高优先级先占位, 与已占位重叠的丢弃(窄图上自动只保留关键刻度)
    const placed = [];
    ticks.sort((a, b) => b.pri - a.pri);
    c.fillStyle = K.muted;
    c.textBaseline = "top";
    for (const t of ticks) {
      const tw = c.measureText(t.label).width;
      const x0 = t.align === "right" ? t.x - tw : t.x;
      const x1 = x0 + tw;
      if (x0 < L.padL - 12 || x1 > W - L.padR + 12) continue;
      if (placed.some((p) => x0 < p[1] + 2 && x1 + 2 > p[0])) continue;
      placed.push([x0, x1]);
      c.textAlign = t.align;
      c.fillText(t.label, t.x, L.volB + 4);
    }
    c.textBaseline = "middle";

    if (!pts.length) {
      placeholder(c, "当日暂无成交", L.padL + L.plotW / 2, (L.mainT + L.mainB) / 2);
      view = { L, pts, X, Y, VY, base, amp, hi, lo, maxV, digits, slots, colW, N, st };
      updateLegend(-1);
      return;
    }

    /* --- 成交量柱: 红涨绿跌(该分钟 close>=open) --- */
    const bw = Math.max(1, Math.min(6, colW * 0.72));
    for (const p of pts) {
      const b = p.b, v = b.v || 0;
      if (v <= 0) continue;
      const up = b.c >= b.o;
      c.fillStyle = up ? rgba(K.up, 0.85) : rgba(K.down, 0.85);
      const y = VY(v);
      c.fillRect(X(p.si) - bw / 2, y, bw, Math.max(1, L.volB - y));
    }

    /* --- 价格线 + 线下渐变填充(蓝线浅蓝填充, 比红绿双色填充更耐看) --- */
    const runs = runsOf(pts);
    const grad = c.createLinearGradient(0, L.mainT, 0, L.mainB);
    grad.addColorStop(0, rgba(K.line, 0.30));
    grad.addColorStop(1, rgba(K.line, 0.02));
    for (const run of runs) {
      if (run.length < 1) continue;
      c.beginPath();
      c.moveTo(X(run[0].si), L.mainB);
      for (const p of run) c.lineTo(X(p.si), Y(p.b.c));
      c.lineTo(X(run[run.length - 1].si), L.mainB);
      c.closePath();
      c.fillStyle = grad;
      c.fill();
    }
    c.lineJoin = "round"; c.lineCap = "round";
    /* 单点段: 首尾同点 + round lineCap 才画得出一个点, 否则 Canvas 什么都不画 */
    const poly = (getY) => {
      for (const run of runs) {
        c.beginPath();
        run.forEach((p, i) => (i ? c.lineTo(X(p.si), getY(p)) : c.moveTo(X(p.si), getY(p))));
        if (run.length === 1) c.lineTo(X(run[0].si), getY(run[0]));
        c.stroke();
      }
    };
    c.strokeStyle = K.line; c.lineWidth = 1.4;
    poly((p) => Y(p.b.c));
    /* --- 均价线 --- */
    c.strokeStyle = K.avg; c.lineWidth = 1.1;
    poly((p) => Y(p.avg));

    /* --- 最新价光点 + 左轴价格牌 --- */
    const lx = X(lastPt.si), ly = lastY;
    const upCol = lastPt.b.c > base ? K.up : lastPt.b.c < base ? K.down : K.ink2;
    c.fillStyle = rgba(K.line, 0.28);
    c.beginPath(); c.arc(lx, ly, 4.5, 0, Math.PI * 2); c.fill();
    c.fillStyle = K.line;
    c.beginPath(); c.arc(lx, ly, 2, 0, Math.PI * 2); c.fill();
    tag(c, fmtP(lastPt.b.c), L.padL - 4, ly, "right", upCol, K.surface2);

    view = { L, pts, X, Y, VY, base, amp, hi, lo, maxV, digits, slots, colW, N, st };
    updateLegend(-1);
  }

  function placeholder(c, text, x, y) {
    const K = colors();
    c.fillStyle = K.muted;
    c.font = FONT;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(text, x == null ? W / 2 : x, y == null ? H / 2 : y);
  }

  /* 轴上的高亮价格牌 */
  function tag(c, text, x, y, align, fg, bg) {
    c.font = FONT_SM;
    const w = c.measureText(text).width + 8;
    const x0 = align === "right" ? x - w : x;
    c.fillStyle = bg;
    c.fillRect(x0, y - 8, w, 16);
    c.strokeStyle = fg; c.lineWidth = 1;
    c.strokeRect(x0 + 0.5, y - 7.5, w - 1, 15);
    c.fillStyle = fg;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(text, x0 + w / 2, y);
  }

  /* ---------------- 十字光标(独立图层) ---------------- */
  let hoverY = null;
  function drawOverlay() {
    const c = ovCv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!view || hoverIdx < 0 || !view.pts.length) return;
    const K = colors();
    const { L, pts, X, Y, base, digits } = view;
    // 换合约/跨日后当日点数可能变少, 把停留的光标夹回有效范围
    if (hoverIdx >= pts.length) hoverIdx = pts.length - 1;
    const p = pts[hoverIdx];
    const x = X(p.si);
    const fmtP = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(digits));

    c.setLineDash([3, 3]);
    c.strokeStyle = rgba(K.ink, 0.55);
    c.lineWidth = 1;
    const xr = Math.round(x) + 0.5;
    c.beginPath(); c.moveTo(xr, L.mainT); c.lineTo(xr, L.volB); c.stroke();

    let yy = hoverY;
    if (yy == null) yy = Y(p.b.c);
    const inVol = yy >= view.L.volT - 4;
    yy = Math.max(L.mainT, Math.min(L.volB, yy));
    const yr = Math.round(yy) + 0.5;
    c.beginPath(); c.moveTo(L.padL, yr); c.lineTo(W - L.padR, yr); c.stroke();
    c.setLineDash([]);

    // 光标点
    c.fillStyle = K.ink;
    c.beginPath(); c.arc(x, Y(p.b.c), 2.5, 0, Math.PI * 2); c.fill();

    // 左右轴数值牌
    if (inVol) {
      const v = ((L.volB - yy) / Math.max(1, L.volB - L.volT)) * view.maxV;
      tag(c, (opts.fmtVol || defVol)(Math.round(v)), L.padL - 4, yy, "right", K.ink, K.surface2);
    } else {
      const v = view.lo + ((L.mainB - yy) / (L.mainB - L.mainT)) * (view.hi - view.lo);
      const pct = ((v - base) / base) * 100;
      const col = v > base ? K.up : v < base ? K.down : K.ink2;
      tag(c, fmtP(v), L.padL - 4, yy, "right", col, K.surface2);
      tag(c, (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%", W - L.padR + 4, yy, "left", col, K.surface2);
    }
    // 底部时间牌
    const d = new Date((p.b.t + TZ_SHIFT) * 1000);
    const hm = p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
    c.font = FONT_SM;
    const tw = c.measureText(hm).width + 8;
    let tx = x - tw / 2;
    tx = Math.max(L.padL, Math.min(W - L.padR - tw, tx));
    c.fillStyle = K.surface2;
    c.fillRect(tx, L.volB + 2, tw, 14);
    c.fillStyle = K.ink;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(hm, tx + tw / 2, L.volB + 9);
  }

  /* ---------------- 图例(顶部读数) ---------------- */
  function updateLegend(idx) {
    if (!legendEl) return;
    if (!view || !view.pts.length) {
      legendEl.innerHTML = `<span class="ts-name">${esc((view && view.st && view.st.name) || "")}</span>`;
      return;
    }
    const { pts, base, digits, st } = view;
    const p = pts[idx >= 0 && idx < pts.length ? idx : pts.length - 1];
    const d = new Date((p.b.t + TZ_SHIFT) * 1000);
    const hm = p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes());
    const chg = p.b.c - base, pct = base ? (chg / base) * 100 : 0;
    const cls = chg > 0 ? "up" : chg < 0 ? "down" : "flat";
    const f = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(digits));
    const fv = opts.fmtVol || defVol;
    legendEl.innerHTML =
      `<span class="ts-name">${esc(st.name || "")}</span>` +
      `<span>${hm}</span>` +
      `<span>价 <b class="${cls}">${f(p.b.c)}</b></span>` +
      `<span>均 <b class="ts-avg">${f(p.avg)}</b></span>` +
      `<span><b class="${cls}">${(chg >= 0 ? "+" : "") + f(chg)}</b> <b class="${cls}">${(pct >= 0 ? "+" : "") + pct.toFixed(2)}%</b></span>` +
      `<span>量 <b class="ts-vol">${fv(p.b.v || 0)}</b></span>` +
      `<span>总量 <b class="ts-vol">${fv(p.cumV || 0)}</b></span>`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  }

  /* ---------------- 事件 ---------------- */
  function hitIndex(mx) {
    if (!view || !view.pts.length) return -1;
    const { L, colW, pts } = view;
    const target = (mx - L.padL) / colW - 0.5;
    // pts.si 严格递增, 二分找最近
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].si < target) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(pts[lo - 1].si - target) <= Math.abs(pts[lo].si - target)) lo--;
    return lo;
  }
  function onMove(e) {
    if (!view) return;
    const r = root.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (mx < view.L.padL - 20 || mx > W - view.L.padR + 20 || my < 0 || my > H) { onLeave(); return; }
    hoverY = my;
    const i = hitIndex(mx);
    hoverIdx = i;
    drawOverlay();
    updateLegend(i);
  }
  function onLeave() {
    if (hoverIdx === -1 && hoverY === null) return;
    hoverIdx = -1; hoverY = null;
    if (ovCv) {
      const c = ovCv.getContext("2d");
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, H);
    }
    updateLegend(-1);
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    if (!root) return false;
    const w = root.clientWidth, h = root.clientHeight;
    const d = window.devicePixelRatio || 1;
    if (w === W && h === H && d === dpr) return false;
    W = w; H = h; dpr = d;
    for (const cv of [mainCv, ovCv]) {
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
    }
    return true;
  }

  /* ---------------- 签名(避免无谓全量重绘) ---------------- */
  function signature(st) {
    const b = st.bars || [];
    const last = b.length ? b[b.length - 1] : null;
    return [
      W, H, dpr, b.length, st.base, st.digits, st.name, st.dayVolume,
      last ? last.t : 0, last ? last.c : 0, last ? last.v : 0, last ? last.h : 0, last ? last.l : 0,
      st.tradingTime ? JSON.stringify(st.tradingTime) : "",
    ].join("|");
  }

  /* ---------------- 对外 API ---------------- */
  const TimeShare = {
    mount(containerEl, options) {
      if (!containerEl) return;
      TimeShare.destroy();
      injectCss();
      host = containerEl;
      opts = options || {};
      root = $c("div"); root.className = "ts-root";
      mainCv = $c("canvas"); mainCv.className = "ts-main";
      ovCv = $c("canvas"); ovCv.className = "ts-ov";
      legendEl = $c("div"); legendEl.className = "ts-legend";
      root.appendChild(mainCv);
      root.appendChild(ovCv);
      root.appendChild(legendEl);
      host.appendChild(root);
      sig = null; view = null; hoverIdx = -1; hoverY = null;
      root.addEventListener("mousemove", onMove);
      root.addEventListener("mouseleave", onLeave);
      if (window.ResizeObserver) {
        ro = new ResizeObserver(() => {
          if (resize() && view) { sig = null; TimeShare.render(view.st); }
        });
        ro.observe(root);
      }
      window.addEventListener("resize", onWinResize);
      resize();
    },

    render(state) {
      if (!root || !state) return;
      const changed = resize();
      const s = signature(state);
      if (!changed && s === sig) return;
      sig = s;
      try {
        drawMain(state);
      } catch (err) {
        console.error("[TimeShare] render failed", err);
        sig = null;
        return;
      }
      if (hoverIdx >= 0) drawOverlay();
    },

    destroy() {
      if (ro) { try { ro.disconnect(); } catch (e) { } ro = null; }
      window.removeEventListener("resize", onWinResize);
      if (root) {
        root.removeEventListener("mousemove", onMove);
        root.removeEventListener("mouseleave", onLeave);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
      host = root = mainCv = ovCv = legendEl = null;
      sig = null; view = null; hoverIdx = -1; hoverY = null;
      W = H = 0;
    },
  };
  function onWinResize() {
    if (resize() && view) { sig = null; TimeShare.render(view.st); }
  }

  window.TimeShare = TimeShare;
})();
