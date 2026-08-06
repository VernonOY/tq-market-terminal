/* 行情终端: 全市场搜索 / 监控墙 / K线+指标 / 画线 / 盘口深度 / Tick */
"use strict";

/* 顶层脚本一旦抛异常, 后面全部不执行(WS 都连不上), 页面会是一片空白且毫无线索。
   把错误直接摆到连接状态栏上, 免得下次又要靠猜。 */
window.addEventListener("error", (e) => {
  const bar = document.getElementById("conn-text");
  if (!bar) return;
  const dot = document.getElementById("conn-dot");
  if (dot) dot.className = "dot err";
  bar.textContent = "脚本错误: " + (e.message || e.error) + " — 试试强制刷新 (⌘⇧R)";
  bar.title = (e.filename || "") + ":" + (e.lineno || "");
});

const C = {
  up: "#e66767", down: "#199e70",
  surface: "#1a1a19", grid: "#2c2c2a", border: "#383835",
  muted: "#898781", ink2: "#c3c2b7", ink: "#ffffff",
  ma5: "#3987e5", ma10: "#d95926", ma20: "#9085e9", ma60: "#d55181",
  draw: "#eda100", drawSel: "#3987e5",
};
const RIGHT_PAD = 14;        // 最新一根右侧预留的空白根数(留给画图往未来延伸)
const TZ_SHIFT = 8 * 3600; // lightweight-charts 按 UTC 渲染, 平移到北京时间
/* ---- 指标参数(全部可自定义, 存 localStorage) ---- */
const LINE_COLORS = [C.ma5, C.ma10, C.ma20, C.ma60, "#199e70", "#eda100"];
const P_DEFAULT = {
  ma: [5, 10, 20, 60],      // 均线组, 最多 6 条
  mavol: [5, 10],           // 均量线, 最多 3 条
  boll: [20, 2],            // 周期, 倍数
  macd: [12, 26, 9],
  kdj: [9, 3, 3],
  rsi: [6, 12, 24],
  cci: [14],
  kc: [20, 20, 2],      // 波动率通道: EMA周期, ATR周期, 倍数
};
const MA_MAX = 6, MAVOL_MAX = 3;
let P = JSON.parse(JSON.stringify(P_DEFAULT));
try {
  const s = JSON.parse(localStorage.getItem("mw:params") || "null");
  if (s) for (const k of Object.keys(P_DEFAULT)) if (Array.isArray(s[k]) && s[k].length) P[k] = s[k];
} catch (e) { /* 忽略 */ }
function saveParams() { try { localStorage.setItem("mw:params", JSON.stringify(P)); } catch (e) { /* 忽略 */ } }
/* 兼容原来的 [周期, 颜色] 结构 */
function maDefs() { return P.ma.slice(0, MA_MAX).map((n, i) => [n, LINE_COLORS[i % LINE_COLORS.length]]); }
function mavolDefs() { return P.mavol.slice(0, MAVOL_MAX).map((n, i) => [n, LINE_COLORS[(i + 1) % LINE_COLORS.length]]); }
const WEEK = 604800, MONTH = 2592000; // 前端聚合周期标记 (由日线合成)
const TIMESHARE = -1;                 // 分时: 用 1 分钟线数据, 由 timeshare.js 渲染
let tsMounted = false;
const CLS_LABEL = { CONT: "主连", FUTURE: "期货", STOCK: "股票", INDEX: "指数", INDEX_CONT: "指数" };

let ws = null;
let watchlist = [];
let groups = [];               // 多分组自选(多页面看板)
let activeGroup = "g1";
let pendingAddTo = null;       // 新建分组后要自动加进去的标的
let lastQuotes = {};
let lastKlines = {};      // 最近一次推送的 K 线表, 键 "sym|dur"
let lastAcct = {};        // 账户快照 {accId: {sum, pos, nord}}
let lastStrat = {};       // 策略快照 {stratId: {...}}
let selected = null;
let duration = 60;          // 显示周期(含 WEEK/MONTH 虚拟周期)
// 指标开关: 参数/副图槽位/波动率窗口/吸附/布局全都持久化了, 唯独"我开了哪几个
// 指标"每次刷新回到硬编码默认值 —— 开了 BOLL 关了 VOL, 刷新就没了。
const IND_KEY = "mw:ind";
const ind = { ma: true, boll: false, vol: true, macd: true, kc: false };
try {
  const v = JSON.parse(localStorage.getItem(IND_KEY) || "null");
  if (v && typeof v === "object") for (const k in ind) if (typeof v[k] === "boolean") ind[k] = v[k];
} catch (e) { /* 忽略 */ }
function saveInd() { try { localStorage.setItem(IND_KEY, JSON.stringify(ind)); } catch (e) { /* 忽略 */ } }
const $ = (id) => document.getElementById(id);

/* 数据周期: 周/月线用日线聚合, 分时用 1 分钟线 */
function dataDuration() {
  if (duration === WEEK || duration === MONTH) return 86400;
  if (duration === TIMESHARE) return 60;
  return duration;
}
function isTimeShare() { return duration === TIMESHARE; }

/* ================= WebSocket ================= */
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => setConn("ok", "已连接");
  ws.onclose = () => { setConn("err", "已断开, 2s 后重连"); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.req) { settleRequest(msg); return; }   // 请求-响应型先分流
    if (msg.type === "warn") {                     // 服务端主动告警(如订阅被挤掉)
      setHistHint(msg.msg || msg.code, 6000);
      return;
    }
    if (msg.type === "config" || msg.type === "watchlist") {
      const prevIds = new Set(groups.map((g) => g.id));
      groups = msg.groups || [{ id: "g1", name: "自选", symbols: msg.watchlist || [] }];
      const fresh = groups.find((g) => !prevIds.has(g.id));
      if (fresh && prevIds.size) {
        activeGroup = fresh.id;                       // 新建分组后自动切过去
        if (pendingAddTo) { send({ action: "watchlist_add", symbol: pendingAddTo, group: fresh.id }); pendingAddTo = null; }
      }
      if (!groups.some((g) => g.id === activeGroup)) activeGroup = groups[0].id;
      watchlist = msg.watchlist || groups.flatMap((g) => g.symbols);
      buildGroupTabs();
      buildWall();
      if (window.WatchBoard) WatchBoard.setGroups(groups);
      const inWall = curGroup().symbols;
      if (pendingSelect && watchlist.includes(pendingSelect)) {
        const s = pendingSelect; pendingSelect = null;
        selectSymbol(s);                       // 走完整切换: 标题/画线/详情全部跟上
      } else if (!selected || !watchlist.includes(selected)) selectSymbol(inWall[0] || watchlist[0]);
      else subscribe();
    } else if (msg.type === "search_result") {
      if (searchTarget === "stock") renderStockPick(msg);
      else renderSearch(msg);
    } else if (msg.type === "board_meta") {
      if (window.Board) Board.setMeta(msg.items);
      if (window.HomeView) HomeView.setMeta(msg.items);
      if (window.SectorView) SectorView.setMeta(msg.items);
    } else if (msg.type === "data") {
      if (msg.status && msg.status.ok === false) setConn("err", "采集异常: " + (msg.status.err || "未知"));
      else if (ws.readyState === 1) setConn("ok", "已连接");
      updateWall(msg.quotes);
      checkAlerts(msg.quotes);
      const q = msg.quotes[selected];
      if (q) { updateBook(q); updateDetail(q); }
      const dd = dataDuration();
      const rows = msg.klines && msg.klines[`${selected}|${dd}`];
      if (rows && rows.length) { cacheKl(`${selected}|${dd}`, rows); applyKlines(rows); }
      if (msg.hf) renderHF(msg.hf);
      if (msg.klines) for (const sym of overlays.keys()) {
        const r = msg.klines[`${sym}|${dd}`];
        if (r && r.length) applyOverlay(sym, r);
      }
      const ticks = msg.ticks && msg.ticks[selected];
      if (ticks && ticks.length) renderTicks(ticks);
      if (msg.klines) lastKlines = msg.klines;   // 切回自选页时多图能立刻画, 不用空等一轮
      if (window.MultiView && MultiView.isMounted()) MultiView.update(msg.klines, msg.quotes);
      // 自选看板用的是 lastQuotes 和 klines, 跟 board 数据源无关。原来挂在
      // board 分支里, 一旦 board 正确关闭它就不刷新了 —— 之前能刷新是靠
      // boardOff 那个 bug 让 board 永远开着。
      if (window.WatchBoard && WatchBoard.isMounted())
        WatchBoard.update(lastQuotes, selected, msg.klines);
      if (msg.acct) lastAcct = msg.acct;
      if (msg.strat) lastStrat = msg.strat;
      if ((msg.acct || msg.strat) && window.TradeView && TradeView.isMounted())
        TradeView.update(lastAcct, lastStrat);
      if ("board" in msg) {
        if (window.Board) Board.update(msg.board);
        if (window.SectorView) SectorView.update(msg.board);
        if (window.HomeView) HomeView.update(msg.board, msg.quotes);
      }   // board 关闭时该 key 整个不存在
    }
  };
}
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

/* ---- 请求-响应通道: 给 option.js / stock.js / 历史懒加载用 ---- */
const pending = new Map();
let reqSeq = 0;
function request(action, payload, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("未连接"));
    const req = `r${++reqSeq}`;
    const timer = setTimeout(() => {
      pending.delete(req);
      reject(new Error("请求超时"));
    }, timeoutMs);
    pending.set(req, { resolve, reject, timer });
    send(Object.assign({ action, req }, payload || {}));
  });
}
function settleRequest(msg) {
  const p = pending.get(msg.req);
  if (!p) return true;                      // 已超时或非本连接的响应, 静默丢弃
  pending.delete(msg.req);
  clearTimeout(p.timer);
  if (msg.type === "err") p.reject(new Error(msg.msg || "服务端错误"));
  else p.resolve(msg);
  return true;
}
function subscribe() {
  if (!selected) return;
  const d = dataDuration();
  // 分时要一整天的分钟线(沪金夜盘到次日2:30 共 555 根), 默认 300 根只够半天
  const req = { action: "subscribe", symbol: selected, duration: d };
  if (isTimeShare()) req.length = 1200;
  send(req);
  send({ action: "subscribe", symbol: selected, duration: 0 });
  // 不再额外发 focus: 服务端 subscribe 分支已隐含 focus, 多发一倍指令只会让
  // 每轮限流的指令队列积压, 反而拖慢切换
}
function setConn(cls, text) {
  $("conn-dot").className = "dot " + cls;
  $("conn-text").textContent = text;
}

/* ================= 工具 ================= */
function priceDigits(sym) {
  const q = lastQuotes[sym || selected];
  const tk = q && q.price_tick;
  if (!tk || !isFinite(tk)) return null;
  const s = String(tk);
  return s.includes(".") ? s.split(".")[1].replace(/0+$/, "").length : 0;
}
function fmt(n, d) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  if (d !== undefined) return n.toFixed(d);
  const pd = priceDigits();
  if (pd !== null) return n.toFixed(pd);
  const ad = Math.abs(n) >= 500 ? 0 : Math.abs(n) >= 10 ? 1 : 2;
  return n.toFixed(ad);
}
function fmtQ(n, q) { // 按某合约自身精度格式化(监控墙用)
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const tk = q && q.price_tick;
  if (tk && isFinite(tk)) {
    const s = String(tk);
    return n.toFixed(s.includes(".") ? s.split(".")[1].replace(/0+$/, "").length : 0);
  }
  return n.toFixed(Math.abs(n) >= 500 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
}
function fmtVol(n) {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(n);
}
function chgCls(v) { return v > 0 ? "up" : v < 0 ? "down" : "flat"; }
/* 判定"无结算价/无持仓"的品种(股票/基金/股票指数)。
   注意 KQ.i@ 期货指数的 ins_class 也是 INDEX, 但它有结算价和持仓量, 必须按期货处理 */
function isStock(q) {
  if (!q) return false;
  if (q.ins_class === "STOCK" || q.ins_class === "FUND") return true;
  if (q.ins_class === "INDEX") return !(q.pre_settlement > 0);
  return false;
}
/* 涨跌基准: 期货用昨结算, 股票/指数用昨收 */
function baseline(q) {
  if (!q) return null;
  return isStock(q) ? (q.pre_close || q.pre_settlement) : (q.pre_settlement || q.pre_close);
}

/* ================= 搜索 ================= */
let searchTimer = null, searchResults = [], searchActive = -1;
$("search-input").addEventListener("input", (e) => {
  const text = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!text) { hideSearch(); return; }
  searchTimer = setTimeout(() => send({ action: "search", text }), 300);
});
$("search-input").addEventListener("keydown", (e) => {
  const box = $("search-results");
  if (!box.classList.contains("show")) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    searchActive += e.key === "ArrowDown" ? 1 : -1;
    searchActive = Math.max(0, Math.min(searchResults.length - 1, searchActive));
    [...box.children].forEach((el, i) => el.classList.toggle("active", i === searchActive));
  } else if (e.key === "Enter" && searchActive >= 0) {
    addSymbol(searchResults[searchActive].s);
  } else if (e.key === "Escape") hideSearch();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#search-box")) hideSearch();
});
function renderSearch(msg) {
  const box = $("search-results");
  searchActive = -1;
  if (msg.building) {
    searchResults = [];
    box.innerHTML = '<div class="sr-empty">合约索引构建中, 请稍候…</div>';
    box.classList.add("show");
    return;
  }
  searchResults = msg.results || [];
  if (!searchResults.length) {
    box.innerHTML = '<div class="sr-empty">无匹配标的</div>';
  } else {
    box.innerHTML = searchResults.map((r) =>
      `<div class="sr-item" data-sym="${r.s}">` +
      `<span class="badge ${r.c}">${CLS_LABEL[r.c] || r.c}</span>` +
      `<span class="sr-code">${r.s}</span>` +
      `<span class="sr-name">${r.n}</span>` +
      `<span class="sr-ex">${r.e}</span></div>`).join("");
    box.querySelectorAll(".sr-item").forEach((el) => {
      el.onclick = () => addSymbol(el.dataset.sym);
      el.oncontextmenu = (e) => { hideSearch(); symbolMenu(e, el.dataset.sym); };
    });
  }
  box.classList.add("show");
}
function hideSearch() { $("search-results").classList.remove("show"); }

/* ---------- 个股研究: 选股条 ----------
   顶部全局搜索是"加自选"的入口, 这里要的是"换研究标的", 语义不同, 所以给一条
   独立通道。后端 search 是单一广播, 用 searchTarget 决定这批结果归谁。 */
let searchTarget = "global", spTimer = 0, spResults = [], spActive = -1;
const SP_STOCK_CLS = new Set(["STOCK", "FUND", "INDEX"]);
function initStockPick() {
  const inp = $("sp-input"), box = $("sp-results");
  if (!inp) return;
  inp.addEventListener("input", () => {
    const text = inp.value.trim();
    clearTimeout(spTimer);
    if (!text) { box.classList.remove("show"); return; }
    searchTarget = "stock";
    spTimer = setTimeout(() => send({ action: "search", text }), 250);
  });
  inp.addEventListener("focus", () => { searchTarget = "stock"; });
  inp.addEventListener("blur", () => {
    // 延后, 否则点结果项时 blur 先触发把 searchTarget 抢回去
    setTimeout(() => { if (document.activeElement !== inp) searchTarget = "global"; }, 200);
  });
  inp.addEventListener("keydown", (e) => {
    if (!box.classList.contains("show")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      spActive = Math.max(0, Math.min(spResults.length - 1,
        spActive + (e.key === "ArrowDown" ? 1 : -1)));
      box.querySelectorAll(".sp-item").forEach((el, i) => el.classList.toggle("on", i === spActive));
    } else if (e.key === "Enter") {
      const pick = spResults[spActive >= 0 ? spActive : 0];
      if (pick) pickStock(pick.s);
    } else if (e.key === "Escape") { box.classList.remove("show"); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#stock-pick")) box.classList.remove("show");
  });
}
function renderStockPick(msg) {
  const box = $("sp-results");
  if (!box) return;
  spActive = -1;
  if (msg.building) {
    spResults = [];
    box.innerHTML = '<div class="sp-empty">合约索引构建中, 请稍候…</div>';
    box.classList.add("show");
    return;
  }
  spResults = (msg.results || []).filter((r) => SP_STOCK_CLS.has(r.c));
  box.innerHTML = spResults.length
    ? spResults.map((r) =>
        `<div class="sp-item" data-sym="${r.s}"><span class="c">${toTsCode(r.s)}</span>` +
        `<span class="n">${r.n}</span><span class="e">${r.e}</span></div>`).join("")
    : '<div class="sp-empty">无匹配股票 (这里只搜 A股/ETF/指数)</div>';
  box.querySelectorAll(".sp-item").forEach((el) => {
    el.onclick = () => pickStock(el.dataset.sym);
  });
  box.classList.add("show");
}
function pickStock(sym) {
  $("sp-results").classList.remove("show");
  $("sp-input").value = "";
  searchTarget = "global";
  const hit = spResults.find((r) => r.s === sym);
  showStock(toTsCode(sym), null, hit && hit.n);
}
/* 快捷入口: 自选里的股票 + 最近看过的, 免得每次都要搜 */
const SP_RECENT_KEY = "mw:stockrecent";
function spRecent() {
  try { return JSON.parse(localStorage.getItem(SP_RECENT_KEY) || "[]"); } catch (e) { return []; }
}
function spPushRecent(ts) {
  const list = spRecent().filter((x) => x !== ts);
  list.unshift(ts);
  try { localStorage.setItem(SP_RECENT_KEY, JSON.stringify(list.slice(0, 12))); } catch (e) { /* 忽略 */ }
}
function renderStockChips() {
  const bar = $("sp-chips");
  if (!bar) return;
  const cur = (() => { try { return localStorage.getItem("mw:stock"); } catch (e) { return null; } })();
  const seen = new Set(), items = [];
  for (const sym of watchlist) {
    if (marketOf(sym) !== "stk") continue;
    const ts = toTsCode(sym);
    if (seen.has(ts)) continue;
    seen.add(ts);
    // 刚加进自选的股票行情还没推到, 用记下来的名字兜底, 别退化成一串代码
    items.push({ ts, name: (lastQuotes[sym] && lastQuotes[sym].instrument_name) || stockNames[ts] || ts });
  }
  for (const ts of spRecent()) {
    if (seen.has(ts)) continue;
    seen.add(ts);
    const q = lastQuotes[tqCodeOf(ts)];
    items.push({ ts, name: (q && q.instrument_name) || stockNames[ts] || ts });
  }
  bar.innerHTML = "";
  for (const it of items.slice(0, 14)) {
    const b = document.createElement("button");
    b.textContent = it.name;
    b.title = it.ts;
    if (it.ts === cur) b.className = "on";
    b.onclick = () => showStock(it.ts, null, it.name);
    bar.appendChild(b);
  }
}
let pendingSelect = null;
let multiPick = null;      // 多图视图正在等一个标的
let wallAddTarget = null;  // 自选看板正在等一个标的(加到这个分区)
function addSymbol(sym, gid) {
  if (wallAddTarget && !gid) {      // 自选看板点了「＋标的」
    gid = wallAddTarget;
    wallAddTarget = null;
    send({ action: "watchlist_add", symbol: sym, group: gid });
    hideSearch();
    $("search-input").value = "";
    return;                          // 不切主图, 用户还在自选看板上
  }
  if (multiPick) {           // 多图: 选中的格子填这个标的
    const cb = multiPick; multiPick = null;
    hideSearch(); $("search-input").value = "";
    cb(sym);
    return;
  }
  const meta = searchResults.find((r) => r.s === sym);
  const stockLike = meta && (meta.c === "STOCK" || meta.c === "FUND" || meta.c === "INDEX");
  // 在个股视图里搜到股票 -> 直接切研究标的, 不打扰自选
  if (curView === "stock" && stockLike) {
    showStock(toTsCode(sym), null);
    hideSearch();
    $("search-input").value = "";
    return;
  }
  send({ action: "watchlist_add", symbol: sym, group: gid || activeGroup });
  pendingSelect = sym;      // 等 watchlist 广播回来、卡片建好后再正式切换
  hideSearch();
  $("search-input").value = "";
}

/* ================= 监控墙 ================= */
/* 标的归类: 期货(含期权) / A股(股票·ETF·股指)。行情视图按大类只显示对应的自选,
   免得在"A股·个股行情"里还混着一堆商品期货。 */
function marketOf(sym) {
  const q = lastQuotes[sym];
  if (q && q.ins_class) {
    if (q.ins_class === "STOCK" || q.ins_class === "FUND") return "stk";
    // 股指(如上证指数)没有昨结算; 商品指数有
    if (q.ins_class === "INDEX") return q.pre_settlement > 0 ? "fut" : "stk";
    return "fut";
  }
  if (/^KQ\./.test(sym)) return "fut";            // 主连/指数一律期货
  const ex = String(sym).split(".")[0];
  return (ex === "SSE" || ex === "SZSE" || ex === "BSE") ? "stk" : "fut";
}
const WALL_FILTERS = [["all", "全部"], ["fut", "期货"], ["stk", "A股"]];
let wallFilter = "all";
function wallSymbols(gid) {
  const g = gid ? groups.find((x) => x.id === gid) : curGroup();
  const syms = (g && g.symbols) || [];
  return wallFilter === "all" ? syms : syms.filter((x) => marketOf(x) === wallFilter);
}
function setWallFilter(f, silent) {
  if (wallFilter === f) return;
  wallFilter = f;
  if (!silent) { try { localStorage.setItem("mw:wallfilter", f); } catch (e) { /* 忽略 */ } }
  buildWallFilter();
  buildWall();
}
function buildWallFilter() {
  const bar = $("wall-filter");
  if (!bar) return;
  const all = curGroup().symbols;
  bar.innerHTML = "";
  for (const [k, label] of WALL_FILTERS) {
    const n = k === "all" ? all.length : all.filter((x) => marketOf(x) === k).length;
    const b = document.createElement("button");
    b.innerHTML = `${label}<span class="n">${n}</span>`;
    b.className = k === wallFilter ? "on" : "";
    b.onclick = () => setWallFilter(k);
    bar.appendChild(b);
  }
}
function curGroup() {
  return groups.find((g) => g.id === activeGroup) || groups[0] || { id: "g1", name: "自选", symbols: [] };
}
function buildGroupTabs() {
  const bar = $("group-tabs");
  if (!bar) return;
  bar.innerHTML = "";
  for (const g of groups) {
    const b = document.createElement("button");
    b.textContent = `${g.name}${g.symbols.length ? " " + g.symbols.length : ""}`;
    b.className = g.id === activeGroup ? "on" : "";
    b.onclick = () => { activeGroup = g.id; buildGroupTabs(); buildWall(); };
    b.oncontextmenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      showMenu(e.clientX, e.clientY, [
        { label: "重命名分组", act: () => {
          const n = prompt("分组名称", g.name);
          if (n) send({ action: "group_rename", group: g.id, name: n });
        } },
        { label: "删除分组", danger: true, disabled: groups.length <= 1, act: () => {
          if (confirm(`删除分组「${g.name}」? 组内 ${g.symbols.length} 个标的会被移出自选`))
            send({ action: "group_delete", group: g.id });
        } },
      ]);
    };
    bar.appendChild(b);
  }
  const add = document.createElement("button");
  add.textContent = "+";
  add.title = "新建分组";
  add.className = "gt-add";
  add.onclick = () => {
    const n = prompt("新分组名称", "分组" + (groups.length + 1));
    if (n) send({ action: "group_create", name: n });
  };
  bar.appendChild(add);
}
function buildWall() {
  const wall = $("wall");
  wall.innerHTML = "";
  buildWallFilter();
  const syms = wallSymbols();
  if (!syms.length) {
    const total = curGroup().symbols.length;
    wall.innerHTML = (total && wallFilter !== "all")
      ? `<div class="wall-empty">本组没有${wallFilter === "stk" ? "A股" : "期货"}标的<br><span>共 ${total} 个, 点上方「全部」查看</span></div>`
      : '<div class="wall-empty">该分组为空<br><span>搜索标的后右键「加入自选」</span></div>';
    return;
  }
  for (const sym of syms) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = "card-" + cssId(sym);
    card.innerHTML = `
      <div class="rm" title="移出自选">✕</div>
      <div class="row1"><span class="name">${sym}</span><span class="sym"></span></div>
      <div class="row2"><span class="last flat">—</span><span class="chg flat">—</span></div>
      <div class="row3"><span class="ba">—</span><span class="voi">—</span></div>`;
    card.onclick = (e) => {
      if (e.target.classList.contains("rm")) {
        e.stopPropagation();
        send({ action: "watchlist_remove", symbol: sym, group: curGroup().id });
      } else selectSymbol(sym);
    };
    card.oncontextmenu = (e) => { e.preventDefault(); symbolMenu(e, sym, { inWall: true }); };
    wall.appendChild(card);
  }
  if (selected) {
    const c = $("card-" + cssId(selected));
    if (c) c.classList.add("selected");
  }
}

/* ================= 叠加对比 =================
   用 lightweight-charts 的 Percentage 价格轴: 它按"当前可见区间的第一根"自动归一,
   缩放平移时基准跟着重算 —— 比自己预先算收益率正确(后者一平移基准就错了) */
const OVERLAY_COLORS = [C.ma10, C.ma20, C.ma60, "#199e70", "#eda100", "#e87ba4", "#4a3aa7"];
const overlays = new Map();    // symbol -> {series, color}

function addOverlay(sym) {
  if (sym === selected || overlays.has(sym)) return;
  if (overlays.size >= OVERLAY_COLORS.length) { alert("最多叠加 " + OVERLAY_COLORS.length + " 个标的"); return; }
  const color = OVERLAY_COLORS[overlays.size % OVERLAY_COLORS.length];
  const o = { color, mode: ovMode(), series: null, raw: null };
  o.series = mkOverlaySeries(o);
  overlays.set(sym, o);
  syncCmpMode();
  send({ action: "subscribe", symbol: sym, duration: dataDuration(), overlay: true });
  renderOverlayBar();
}
function removeOverlay(sym) {
  const o = overlays.get(sym);
  if (!o) return;
  try { chart.removeSeries(o.series); } catch (e) { /* 已移除 */ }
  overlays.delete(sym);
  syncCmpMode();
  send({ action: "unfocus", symbol: sym });
  renderOverlayBar();
}
function clearOverlays() { for (const s of [...overlays.keys()]) removeOverlay(s); }

/* 主图切换合约/周期时, 叠加线要按新周期重订 */
/* 叠加形态: 线 或 K线。K线在百分比刻度下同样成立 —— 每根的 OHLC 一起归一。
   存 localStorage, 换合约后保持。 */
const OV_MODE_KEY = "mw:ovmode";
function ovMode() {
  try { return localStorage.getItem(OV_MODE_KEY) === "candle" ? "candle" : "line"; }
  catch (e) { return "line"; }
}
function mkOverlaySeries(o) {
  if (o.mode === "candle") {
    return chart.addCandlestickSeries({
      priceScaleId: "right",
      upColor: o.color, downColor: "transparent",
      borderUpColor: o.color, borderDownColor: o.color,
      wickUpColor: o.color, wickDownColor: o.color,
      lastValueVisible: false, priceLineVisible: false,
    });
  }
  return chart.addLineSeries({
    color: o.color, lineWidth: 2, priceScaleId: "right",
    lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: true,
  });
}
function setOverlayMode(sym, mode) {
  const o = overlays.get(sym);
  if (!o || o.mode === mode) return;
  try { chart.removeSeries(o.series); } catch (e) { /* 已销毁 */ }
  o.mode = mode;
  o.series = mkOverlaySeries(o);
  try { localStorage.setItem(OV_MODE_KEY, mode); } catch (e) { /* 忽略 */ }
  refillOverlay(sym);
  renderOverlayBar();
}
/* 叠加对比的前提: 主图和叠加必须在**同一种刻度**下。
   之前主图右轴是普通价格模式、叠加走隐藏的百分比刻度, 两条线各归一各的,
   橙线相对蜡烛的高低毫无意义(实测左端沪金在 936、沪银线在 940 上方 ——
   若真同基准归一, 起点应当重合)。
   改成 TradingView 的做法: 一有叠加就把整张图切成百分比, 清空后切回价格。
   百分比按**当前可见区间的第一根**归一, 缩放/平移时基准自动重算 ——
   所以看的是"这个窗口内的相对涨跌", 真实价格由上方叠加条给出。 */
function syncCmpMode() {
  const on = overlays.size > 0;
  try {
    chart.priceScale("right").applyOptions({
      mode: on ? LightweightCharts.PriceScaleMode.Percentage
               : LightweightCharts.PriceScaleMode.Normal,
    });
  } catch (e) { /* 尚未初始化 */ }
}
function resubOverlays() {
  for (const sym of overlays.keys())
    send({ action: "subscribe", symbol: sym, duration: dataDuration(), overlay: true });
}
/* 叠加线必须对齐到主标的的时间栅格。
   lightweight-charts 的时间轴是所有 series 时间点的并集: 直接喂叠加标的自己的
   时间戳, 主图就会多出主标的没有的那些点(甘醇夜盘到 23:00, 原油到 02:30),
   于是同一个 logical index 在主图和副图上指向不同的根 —— 副图会被星型同步挤成
   左边一条竖线。所以只在主标的已有的时间点上出值, 中间用前值填充(forward-fill)。 */
function applyOverlay(sym, raw) {
  const o = overlays.get(sym);
  if (!o || !raw || !raw.length) return;
  o.raw = raw;                       // 主图根数变了要重铺, 存一份原始数据
  refillOverlay(sym);
}
function refillOverlay(sym) {
  const o = overlays.get(sym);
  if (!o || !o.raw) return;
  if (!lastTimes.length) { try { o.series.setData([]); } catch (e) { /* 已销毁 */ } return; }
  const rows = (duration === WEEK || duration === MONTH) ? aggregate(o.raw, duration) : o.raw;
  const src = rows.map((r) => [r.t + TZ_SHIFT, r]).sort((a, b) => a[0] - b[0]);
  const out = new Array(lastTimes.length);
  const vals = new Array(lastTimes.length);     // 供图例读数用
  let j = 0, cur = null;
  for (let i = 0; i < lastTimes.length; i++) {
    const t = lastTimes[i];
    while (j < src.length && src[j][0] <= t) { cur = src[j][1]; j++; }
    vals[i] = cur ? cur.c : null;
    if (!cur) { out[i] = { time: t }; continue; }   // 还没开盘: whitespace, 不能给 null
    out[i] = o.mode === "candle"
      ? { time: t, open: cur.o, high: cur.h, low: cur.l, close: cur.c }
      : { time: t, value: cur.c };
  }
  o.vals = vals;
  try { o.series.setData(out); } catch (e) { /* 时间倒退等异常, 下一帧再来 */ }
}
function refillOverlays() { for (const sym of overlays.keys()) refillOverlay(sym); }
/* 叠加条 = 叠加对比的读数区。
   cmp 轴是隐藏的百分比刻度, 右侧价格轴上的数字**对叠加线不适用** ——
   不给读数的话用户根本没法判断橙线画的是多少, 只能看个形状。
   所以这里必须显示: 光标所在那根的真实价格 + 相对可见区间首根的涨跌幅
   (百分比刻度就是按可见区间首根归一的, 口径要和图上一致)。 */
function ovBasisIdx() {
  // 百分比刻度以"当前可见区间的第一根"为 0%, 图例要用同一个基准
  try {
    const r = chart.timeScale().getVisibleLogicalRange();
    if (r) return Math.max(0, Math.min(lastTimes.length - 1, Math.ceil(r.from)));
  } catch (e) { /* 尚无数据 */ }
  return 0;
}
function ovReadout(vals, idx, base, sym) {
  if (!vals) return ["—", null];
  const v = vals[idx != null ? idx : vals.length - 1];
  if (v == null) return ["—", null];
  const b = vals[base];
  const pct = (b != null && b) ? (v / b - 1) * 100 : null;
  return [fmtNum(v, sym), pct];
}
function fmtNum(v, sym) {
  const d = priceDigits(sym);          // 按该合约的最小变动价位定小数位
  if (d != null) return v.toFixed(d);
  return Math.abs(v) >= 5000 ? v.toFixed(0) : v.toFixed(2);
}
function renderOverlayBar() {
  const bar = $("overlay-bar");
  if (!bar) return;
  bar.innerHTML = "";
  bar.classList.toggle("hidden", overlays.size === 0);
  if (!overlays.size) return;
  const idx = hoverIdx();
  const base = ovBasisIdx();
  const mkPct = (p) => p == null ? "" :
    `<em class="${p > 0 ? "up" : p < 0 ? "dn" : ""}">${p > 0 ? "+" : ""}${p.toFixed(2)}%</em>`;

  // 基准标的自己也要有读数, 否则没法比
  const mc = lastRows.length ? lastRows.map((r) => r.c) : null;
  const [mv, mp] = ovReadout(mc, idx, base, selected);
  const b0 = document.createElement("span");
  b0.className = "ov-chip base";
  b0.innerHTML = `<i style="background:${C.ma5}"></i>` +
    `${(lastQuotes[selected] || {}).instrument_name || selected}` +
    `<span class="ov-v">${mv}</span>${mkPct(mp)}<em class="ov-tag">基准</em>`;
  bar.appendChild(b0);

  for (const [sym, o] of overlays) {
    const [v, p] = ovReadout(o.vals, idx, base, sym);
    const chip = document.createElement("span");
    chip.className = "ov-chip";
    chip.innerHTML = `<i style="background:${o.color}"></i>` +
      `${(lastQuotes[sym] || {}).instrument_name || sym}` +
      `<span class="ov-v">${v}</span>${mkPct(p)}` +
      `<u title="切换 线/K线">${o.mode === "candle" ? "K" : "线"}</u>` +
      `<b title="移除">✕</b>`;
    chip.querySelector("u").onclick = () =>
      setOverlayMode(sym, o.mode === "candle" ? "line" : "candle");
    chip.querySelector("b").onclick = () => removeOverlay(sym);
    bar.appendChild(chip);
  }
  const note = document.createElement("span");
  note.className = "ov-note";
  note.textContent = (idx != null ? "光标处" : "最新") + " · 涨跌幅相对可见区间首根(缩放会重算)";
  note.title = "有叠加时整张图切换为百分比刻度, 两个标的按同一基准(当前可见区间的" +
    "第一根)归一, 这样量级差几十倍也能比形状。缩放或平移时基准跟着重算。" +
    "右轴显示的是百分比, 真实价格看这里。";
  bar.appendChild(note);
  const clr = document.createElement("span");
  clr.className = "ov-clear";
  clr.textContent = "清空叠加";
  clr.onclick = clearOverlays;
  bar.appendChild(clr);
}

/* ================= 右键菜单 ================= */
let menuEl = null;
function showMenu(x, y, items) {
  hideMenu();
  menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";
  for (const it of items) {
    if (it.sep) { menuEl.appendChild(Object.assign(document.createElement("div"), { className: "ctx-sep" })); continue; }
    const d = document.createElement("div");
    d.className = "ctx-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "") + (it.sub ? " has-sub" : "");
    d.textContent = it.label;
    if (it.sub) {
      const s = document.createElement("div");
      s.className = "ctx-sub";
      for (const si of it.sub) {
        const sd = document.createElement("div");
        sd.className = "ctx-item";
        sd.textContent = si.label;
        sd.onclick = (ev) => { ev.stopPropagation(); hideMenu(); si.act(); };
        s.appendChild(sd);
      }
      d.appendChild(s);
    } else if (!it.disabled) {
      d.onclick = () => { hideMenu(); it.act(); };
    }
    menuEl.appendChild(d);
  }
  document.body.appendChild(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.min(x, innerWidth - r.width - 6) + "px";
  menuEl.style.top = Math.min(y, innerHeight - r.height - 6) + "px";
}
function hideMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
document.addEventListener("click", hideMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideMenu(); });
window.addEventListener("blur", hideMenu);

/* 标的通用右键菜单: 监控墙卡片 / 搜索结果 / 看板行 都用它 */
function symbolMenu(e, sym, opt = {}) {
  e.preventDefault(); e.stopPropagation();
  const q = lastQuotes[sym] || {};
  const items = [
    { label: "查看K线", act: () => gotoChart(sym) },
    { label: "加入自选", sub: groups.map((g) => ({
        label: g.name + (g.symbols.includes(sym) ? " ✓" : ""),
        act: () => send({ action: "watchlist_add", symbol: sym, group: g.id }),
      })).concat([{ label: "＋ 新建分组…", act: () => {
        const n = prompt("新分组名称", "分组" + (groups.length + 1));
        if (n) { pendingAddTo = sym; send({ action: "group_create", name: n }); }
      } }]) },
    { label: "叠加到当前图", act: () => addOverlay(sym) },
  ];
  if (opt.inWall) items.push(
    { sep: true },
    { label: "从本组移除", danger: true, act: () => send({ action: "watchlist_remove", symbol: sym, group: curGroup().id }) },
    { label: "从所有分组移除", danger: true, act: () => send({ action: "watchlist_remove", symbol: sym }) },
  );
  items.push({ sep: true }, { label: "复制代码", act: () => navigator.clipboard?.writeText(sym) });
  if (isStock(q)) items.push({ label: "个股研究", act: () => { showView("stock"); if (window.StockView) StockView.show(toTsCode(sym), q); } });
  showMenu(e.clientX, e.clientY, items);
}
function cssId(sym) { return sym.replace(/[^A-Za-z0-9]/g, "_"); }

function updateWall(quotes) {
  for (const sym of watchlist) {
    const q = quotes[sym];
    if (!q) continue;
    const card = $("card-" + cssId(sym));
    const prev = lastQuotes[sym];
    // 行情缓存必须无条件更新: 左栏现在按市场过滤, 隐藏的标的没有卡片,
    // 但自选看板/首页/搜索都还要用它的报价
    lastQuotes[sym] = q;
    if (!card) continue;
    const base = baseline(q);
    const chg = q.last_price != null && base ? q.last_price - base : null;
    const pct = chg != null ? (chg / base) * 100 : null;
    card.querySelector(".name").textContent = q.instrument_name || sym;
    card.querySelector(".sym").textContent = q.underlying_symbol || sym;
    const lastEl = card.querySelector(".last");
    lastEl.textContent = fmtQ(q.last_price, q);
    lastEl.className = "last " + chgCls(chg);
    const chgEl = card.querySelector(".chg");
    chgEl.innerHTML = chg == null ? "—"
      : `${chg > 0 ? "+" : ""}${fmtQ(chg, q)}<br>${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
    chgEl.className = "chg " + chgCls(chg);
    card.querySelector(".ba").textContent = `${fmtQ(q.bid_price1, q)} / ${fmtQ(q.ask_price1, q)}`;
    card.querySelector(".voi").textContent = isStock(q)
      ? `量${fmtVol(q.volume)}`
      : `量${fmtVol(q.volume)} 仓${fmtVol(q.open_interest)}`;
    if (prev && prev.last_price !== q.last_price && q.last_price != null) {
      card.classList.remove("f-up", "f-down");
      void card.offsetWidth;
      card.classList.add(q.last_price > prev.last_price ? "f-up" : "f-down");
    }
  }
}
function selectSymbol(sym) {
  if (!sym) return;
  selected = sym;
  renderedKey = null;
  hideBarDetail();
  document.querySelectorAll(".card").forEach((c) => c.classList.remove("selected"));
  const card = $("card-" + cssId(sym));
  if (card) card.classList.add("selected");
  const q = lastQuotes[sym];
  $("chart-title").textContent = (q && q.instrument_name ? q.instrument_name + "  " : "") + sym;
  if (overlays.has(sym)) removeOverlay(sym);   // 选中的合约不该同时是叠加线
  loadDrawings();
  // 先把缓存的画上去, 别让用户盯着空图等 1~2 秒; 没缓存就清空并显示加载态,
  // 绝不能留着上一个合约的 K 线配新标题
  if (!showCached()) enterLoading();
  if (q) { updateBook(q); updateDetail(q); }    // 盘口/详情有现成报价, 立刻刷
  subscribe();
  resubOverlays();
  renderOverlayBar();
}

/* 客户端 K 线缓存: 切合约/切周期时先渲染上次的数据, 新数据到了再覆盖。
   服务端首次订阅一条新序列要 1~1.8s(TqSdk 拉 300 根的固有往返), 这段空窗
   正是"加载慢"的观感来源。 */
const klCache = new Map();
const KL_CACHE_MAX = 60;
function cacheKl(key, rows) {
  if (!rows || !rows.length) return;
  klCache.set(key, rows);
  if (klCache.size > KL_CACHE_MAX) klCache.delete(klCache.keys().next().value);
}
function showCached() {
  const key = `${selected}|${dataDuration()}`;
  const rows = klCache.get(key);
  if (rows && rows.length) { renderedKey = null; applyKlines(rows); return true; }
  return false;
}
/* 缓存没命中时必须把上一个合约的数据清干净。服务端首订阅要 1~1.8s, 这段时间
   标题已经换成新合约、图上画的却还是上一个合约的 K 线 —— 用户读到的每个数
   都是错的。这是正确性问题, 不是观感问题。 */
let loadingKey = null, loadingTimer = 0;
function enterLoading() {
  loadingKey = `${selected}|${dataDuration()}`;
  lastRows = []; lastTimes = []; timeIndex = new Map();
  lastMA = {}; lastMAVOL = {}; lastBOLL = null;
  const blank = (s2) => { if (s2) { try { s2.setData([]); } catch (e) { /* 已销毁 */ } } };
  blank(candleS); blank(volS);
  maS.forEach(blank); mavolS.forEach(blank);          // 数量随参数变, 必须遍历句柄
  ["mid", "up", "lo"].forEach((k) => { blank(bollS[k]); blank(kcS[k]); });
  for (const p of subPanes) {
    [p.hist, p.dif, p.dea, p.k, p.d, p.j, p.r6, p.r12, p.r24, p.cci, p.oi].forEach(blank);
    (p.rv || []).forEach(blank);
    p.last = null;
  }
  for (const id of ["tick-tape", "hf-grid", "vol-table"]) {
    const el = $(id);
    if (el) el.innerHTML = '<div class="note">加载中…</div>';
  }
  const tc = $("tick-canvas");
  if (tc) { const g = tc.getContext("2d"); g && g.clearRect(0, 0, tc.width, tc.height); }
  const box = $("chart-loading");
  if (box) box.classList.remove("hidden");
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => exitLoading(true), 8000);   // 订阅失败也要收场
}
function exitLoading(timedOut) {
  clearTimeout(loadingTimer);
  loadingKey = null;
  const box = $("chart-loading");
  if (box) box.classList.add("hidden");
  if (timedOut) setHistHint("数据迟迟没到, 检查连接或换个合约试试", 4000);
}

/* ================= 指标 ================= */
function sma(vals, n) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function ema(vals, n) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (n + 1);
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function bollCalc(vals, n = 20, mult = 2) {
  const mid = sma(vals, n), up = new Array(vals.length).fill(null), lo = up.slice();
  for (let i = n - 1; i < vals.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (vals[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    up[i] = mid[i] + mult * sd; lo[i] = mid[i] - mult * sd;
  }
  return { mid, up, lo };
}
/* ---- 副图指标 ---- */
function kdjCalc(rows, n = 9, m1 = 3, m2 = 3) {
  const K = [], D = [], J = [];
  let k = 50, d = 50;
  for (let i = 0; i < rows.length; i++) {
    const s = Math.max(0, i - n + 1);
    let hi = -Infinity, lo = Infinity;
    for (let j = s; j <= i; j++) { if (rows[j].h > hi) hi = rows[j].h; if (rows[j].l < lo) lo = rows[j].l; }
    const rsv = hi === lo ? 50 : ((rows[i].c - lo) / (hi - lo)) * 100;
    k = (rsv + (m1 - 1) * k) / m1;
    d = (k + (m2 - 1) * d) / m2;
    K.push(k); D.push(d); J.push(3 * k - 2 * d);
  }
  return { K, D, J };
}
function rsiCalc(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const u = ch > 0 ? ch : 0, d = ch < 0 ? -ch : 0;
    if (i <= n) { up += u / n; dn += d / n; if (i === n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }
    else { up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + d) / n; out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn); }
  }
  return out;
}
/* ================= 波动率 =================
   盯盘要回答三个问题, 各用一种呈现:
     状态 —— 现在是高波还是低波? 看**分位**, 不看年化绝对值
     方向 —— 在扩张还是收缩? 看短/长窗比值
     含义 —— 价格层面意味什么? 叠到主图的通道上
   估计量不用 close-to-close(日内噪声大), 默认 Garman-Klass(吃 OHLC, 更平滑)。 */

/* 单根 bar 的方差贡献(未年化) */
function barVar(r, kind) {
  const o = r.o, h = r.h, l = r.l, c = r.c;
  if (!(o > 0 && h > 0 && l > 0 && c > 0)) return null;
  const hl = Math.log(h / l), co = Math.log(c / o);
  if (kind === "pk") return hl * hl / (4 * Math.LN2);          // Parkinson
  if (kind === "cc") return null;                              // 走收益率路径
  return 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;          // Garman-Klass
}
/* 滚动年化波动率(%)。kind: gk | pk | cc */
function rvCalc(rows, n, barSec, dailySec, kind) {
  kind = kind || volEst;
  const N = rows.length;
  const out = new Array(N).fill(null);
  const v = new Array(N).fill(null);
  if (kind === "cc") {
    for (let i = 1; i < N; i++)
      if (rows[i].c > 0 && rows[i - 1].c > 0) {
        const x = Math.log(rows[i].c / rows[i - 1].c);
        v[i] = x * x;
      }
  } else {
    for (let i = 0; i < N; i++) v[i] = barVar(rows[i], kind);
  }
  const ann = Math.sqrt(252 * (dailySec || 5.5 * 3600) / (barSec || 60)) * 100;
  let s = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    if (v[i] != null) { s += v[i]; cnt++; }
    const drop = i - n;
    if (drop >= 0 && v[drop] != null) { s -= v[drop]; cnt--; }
    if (i >= n - 1 && cnt >= 2) out[i] = Math.sqrt(Math.max(0, s / cnt)) * ann;
  }
  return out;
}
/* 分位: 当前 σ 在最近 look 根里的百分位(0~100)。
   数据够 3 天时改用"同一分钟槽位的跨日基线" —— 夜盘/日盘开盘天然高波,
   用固定阈值每天开盘都会误报。 */
function rvPercentile(sigma, rows, look) {
  const N = sigma.length;
  const out = new Array(N).fill(null);
  const slotOf = (t) => Math.floor(((t + TZ_SHIFT) % 86400) / 60);   // 当天第几分钟
  const slots = rows.map((r) => slotOf(r.t));
  const spanDays = N > 1 ? (rows[N - 1].t - rows[0].t) / 86400 : 0;
  const bySlot = new Map();
  const useSlot = spanDays >= 3;
  if (useSlot) {
    for (let i = 0; i < N; i++) {
      if (sigma[i] == null) continue;
      const k = slots[i];
      if (!bySlot.has(k)) bySlot.set(k, []);
      bySlot.get(k).push(sigma[i]);
    }
    for (const arr of bySlot.values()) arr.sort((a, b) => a - b);
  }
  for (let i = 0; i < N; i++) {
    const cur = sigma[i];
    if (cur == null) continue;
    let arr;
    if (useSlot) arr = bySlot.get(slots[i]);
    else {
      const from = Math.max(0, i - look);
      arr = [];
      for (let j = from; j <= i; j++) if (sigma[j] != null) arr.push(sigma[j]);
      arr.sort((a, b) => a - b);
    }
    if (!arr || arr.length < 5) continue;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < cur) lo = m + 1; else hi = m; }
    out[i] = (lo / (arr.length - 1)) * 100;
  }
  out.mode = useSlot ? "同时段基线" : "滚动窗口";
  return out;
}
/* ATR (Wilder), 用于主图波动率通道 */
function atrCalc(rows, n) {
  const N = rows.length, out = new Array(N).fill(null);
  let prev = null, acc = 0;
  for (let i = 0; i < N; i++) {
    const r = rows[i];
    const pc = i > 0 ? rows[i - 1].c : r.o;
    const tr = Math.max(r.h - r.l, Math.abs(r.h - pc), Math.abs(r.l - pc));
    if (!isFinite(tr)) continue;
    if (i < n) { acc += tr; if (i === n - 1) { prev = acc / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + tr) / n; out[i] = prev; }
  }
  return out;
}
function cciCalc(rows, n = 14) {
  const out = new Array(rows.length).fill(null);
  const tp = rows.map((r) => (r.h + r.l + r.c) / 3);
  for (let i = n - 1; i < rows.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += tp[j];
    const ma = sum / n;
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - ma);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - ma) / (0.015 * md);
  }
  return out;
}
function macdCalc(vals, fast = 12, slow = 26, sig = 9) {
  const ef = ema(vals, fast), es = ema(vals, slow);
  const dif = ef.map((v, i) => v - es[i]);
  const dea = ema(dif, sig);
  return { dif, dea, hist: dif.map((v, i) => (v - dea[i]) * 2) };
}
/* null 必须用"空白点"({time} 不带 value)占位, 不能直接丢掉 ——
   副图之间是按**逻辑下标**同步的, 少几个点就整体错位:
   波动率(前 120 根为 null)会比主图短 120 根, 时间轴对不上。 */
function toLine(times, arr) {
  // 长度必须由时间轴说了算, 不能由指标返回的数组说了算。
  // 某个指标算出来的数组比 times 短(实测 rvPercentile 有 237 vs 300 的情况),
  // 序列就跟着短一截, 副图时间轴随之偏移, 和主图对不上。缺的补 whitespace。
  const n = times.length;
  const out = new Array(n);
  const a = arr || [];
  for (let i = 0; i < n; i++) {
    const v = a[i];
    out[i] = (v != null && isFinite(v)) ? { time: times[i], value: v } : { time: times[i] };
  }
  return out;
}

/* 日线 -> 周线/月线聚合 */
function aggregate(rows, period) {
  const out = [];
  let cur = null, curKey = null;
  for (const r of rows) {
    const d = new Date((r.t + TZ_SHIFT) * 1000); // UTC 视角下的北京日期
    let key;
    if (period === WEEK) {
      const day = d.getUTCDay() || 7;
      const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 1) / 1000;
      key = monday;
    } else {
      key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
    }
    if (key !== curKey) {
      if (cur) out.push(cur);
      curKey = key;
      cur = { t: key - TZ_SHIFT, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0, oi: r.oi };
    } else {
      cur.h = Math.max(cur.h, r.h); cur.l = Math.min(cur.l, r.l);
      cur.c = r.c; cur.v += r.v || 0; cur.oi = r.oi;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ================= 图表 ================= */
let chart, candleS, volS, macdChart;
const maS = [], bollS = {}, kcS = {};
let renderedKey = null, lastBarTime = 0, lastRows = [], lastMA = {}, lastMAVOL = {}, lastBOLL = null, lastTimes = [];
let timeIndex = new Map();     // bar time -> lastRows 下标
let syncing = false;      // 星型时间轴同步的递归保护
let noHistLoad = 0;       // >0 时程序化改视窗, 不该被当成用户往左拖
let pointerInChart = false;   // 指针是否在图表区内(决定十字光标去留)
let hoverTime = null;         // 当前悬停的 bar 时间, 数据刷新后据此复位光标
/* 当前悬停的 K 线下标: 画线模式看 drawCur, 光标模式看 hoverTime */
function hoverIdx() {
  const t = (typeof drawCur !== "undefined" && drawCur) ? drawCur.t : hoverTime;
  if (t == null) return null;
  const i = timeIndex.get(t);
  return i == null ? null : i;
}
const mavolS = [];

function syncCrosshair(time, src) {
  const targets = [{ chart, series: candleS }].concat(subPanes.map((p) => ({ chart: p.chart, series: p.hist })));
  for (const t of targets) {
    if (t.chart === src) continue;
    try { t.chart.setCrosshairPosition(0, time, t.series || candleS); } catch (e) { /* 该图无数据 */ }
  }
}
function clearAllCrosshair() {
  for (const c of [chart].concat(subPanes.map((p) => p.chart)))
    try { c.clearCrosshairPosition(); } catch (e) { /* 忽略 */ }
}
/* 数据刷新会把程序化设置的十字线冲掉, 悬停时要复位 */
function restoreCrosshair() {
  if (!pointerInChart || hoverTime == null) return;
  xhairSyncGuard(() => syncCrosshair(hoverTime, null));
}
let xhairSync = false;
function xhairSyncGuard(fn) {
  if (xhairSync) return;
  xhairSync = true;
  try { fn(); } finally { xhairSync = false; }
}
/* 副图槽位: 每个槽有自己的 chart 和全套 series, 显示哪一组由 kind 决定 */
const subPanes = [];
const SUB_SLOTS = [
  { kind: "macd", wrap: "macd-wrap", legend: "macd-legend" },
  { kind: "none", wrap: "sub2-wrap", legend: "sub2-legend" },
];
function makeSubPane(divId) {
  const ch = LightweightCharts.createChart($(divId), baseOpts());
  const line = (color, w, vis) => ch.addLineSeries({
    color, lineWidth: w || 1, lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, visible: !!vis,
  });
  return {
    chart: ch,
    hist: ch.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false }),
    dif: line(C.ma5, 1, true), dea: line(C.ma10, 1, true),
    k: line(C.ma5), d: line(C.ma10), j: line(C.ma20),
    r6: line(C.ma5), r12: line(C.ma10), r24: line(C.ma20),
    cci: line(C.ma5, 1.5), oi: line(C.ma20, 1.5),
    rv: [line(C.ma5, 1.5), line(C.ma10), line(C.ma20)],
    last: null,
  };
}
/* 波动率副图的可选窗口(以 K 线根数计) */
const RV_WINDOWS = [
  { key: "s", label: "短(10/20/40)", n: [10, 20, 40] },
  { key: "m", label: "中(20/60/120)", n: [20, 60, 120] },
  { key: "l", label: "长(60/120/250)", n: [60, 120, 250] },
];
let rvWin = "m";
let volEst = "gk";       // gk 高低开收 | pk 高低 | cc 收盘价
try {
  rvWin = localStorage.getItem("mw:rvwin") || "m";
  volEst = localStorage.getItem("mw:volest") || "gk";
} catch (e) { /* 忽略 */ }
function rvNs() { return (RV_WINDOWS.find((w) => w.key === rvWin) || RV_WINDOWS[1]).n; }
const VOL_EST_LABEL = { gk: "Garman-Klass", pk: "Parkinson", cc: "收盘价" };

function baseOpts() {
  return {
    autoSize: true,
    layout: { background: { type: "solid", color: C.surface }, textColor: C.muted, fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.border },
    // rightOffset 给最新一根右边留空白: 趋势线/目标位要能画到未来
    timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false,
                 rightOffset: RIGHT_PAD },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  };
}
function initCharts() {
  chart = LightweightCharts.createChart($("main-chart"), baseOpts());
  candleS = chart.addCandlestickSeries({
    upColor: C.up, downColor: C.down, borderVisible: false,
    wickUpColor: C.up, wickDownColor: C.down,
  });
  volS = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  for (let i = 0; i < MAVOL_MAX; i++)
    mavolS.push(chart.addLineSeries({
      color: LINE_COLORS[(i + 1) % LINE_COLORS.length], lineWidth: 1, priceScaleId: "vol",
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false,
    }));
  for (let i = 0; i < MA_MAX; i++)
    maS.push(chart.addLineSeries({
      color: LINE_COLORS[i % LINE_COLORS.length], lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false,
    }));
  for (const k of ["mid", "up", "lo"])
    bollS[k] = chart.addLineSeries({ color: C.muted, lineWidth: 1, lineStyle: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false });
  // 波动率通道(Keltner: EMA ± k·ATR) —— 叠在主图上, 看价格时同时感知波动
  for (const k of ["mid", "up", "lo"])
    kcS[k] = chart.addLineSeries({
      color: k === "mid" ? C.ma20 : "#9085e9", lineWidth: 1, lineStyle: k === "mid" ? 0 : 2,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, visible: false,
    });

  // 两个副图槽位, 每槽可自由选 MACD/KDJ/RSI/CCI/持仓/关
  subPanes.push(makeSubPane("macd-chart"), makeSubPane("sub2-chart"));
  macdChart = subPanes[0].chart;            // 兼容既有的 timeScale 同步代码

  // 往左拖到剩不到 20 根时自动回补更早的历史。
  // 必须要求已有数据且不在同步回灌中, 否则初始化/切换瞬间会误触发。
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (!r || noHistLoad || histLoading || !lastRows.length) return;
    if (r.from < 20 && r.to > 0) loadMoreHistory();
  });
  // 三张图的价格轴标签宽度不同(主图是价格, 副图是分位/比值), 绘图区就会差几像素,
  // 同一个 x 落到不同的 K 线上。固定一个最小轴宽让绘图区左右边界严格对齐。
  const PS_W = 64;
  chart.priceScale("right").applyOptions({ minimumWidth: PS_W });
  for (const p of subPanes) p.chart.priceScale("right").applyOptions({ minimumWidth: PS_W });

  // 时间轴同步做成"以主图为中心"的星型, 不要两两互联 ——
  // 空副图会回灌一个异常范围给主图, 既把 K 线挤成一条, 又误触发历史回补
  const setRange = (c, r) => { try { c.timeScale().setVisibleLogicalRange(r); } catch (e) { /* 尚无数据 */ } };
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (syncing || !r) return;
    syncing = true;
    for (const p of subPanes) setRange(p.chart, r);
    syncing = false;
  });
  for (let si = 0; si < subPanes.length; si++) {
    const p = subPanes[si];
    p.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      // 只有"当前真的在显示指标"的副图才有资格驱动主图。
      // 关掉的副图是空的, 它的逻辑区间是个巨大的负数区间, 回灌过去会把
      // 主图 K 线挤成右边一条竖线。
      if (syncing || !r || !lastRows.length) return;
      if (SUB_SLOTS[si].kind === "none" || !ind.macd) return;
      if (!(r.to > 0 && r.from > -lastRows.length)) return;
      syncing = true;
      setRange(chart, r);
      for (const q of subPanes) if (q !== p) setRange(q.chart, r);
      syncing = false;
      // 主图的回补监听被 syncing 挡掉了, 这里补一次: 拖副图往左同样该加载历史
      if (!histLoading && r.from < 20 && r.to > 0) loadMoreHistory();
    });
  }

  /* 主副图光标截面同步: 在任意一张图上移动, 三张图的十字线都落到同一根 K 线,
     所有图例(主图OHLC/均线/成交量/副图指标)同时显示该截面的数值 */
  // xhairSync 在模块作用域(见上方 xhairSyncGuard)
  function onCrosshair(param, fromMain) {
    const hasBar = param && param.time != null && param.point;
    // 行情每 120ms 就 update 一次, 每次更新 lightweight-charts 都会补发一条
    // time 为空的 crosshairMove。如果照单全收去 clear, 光标停在蜡烛上一会就没了。
    // 只有指针真的离开图表区(mouseleave)才清。
    if (!hasBar && pointerInChart) return;
    if (hasBar) hoverTime = param.time;
    const idx = hasBar ? timeIndex.get(param.time) : undefined;
    renderOhlcLegend(hasBar && fromMain ? param.seriesData.get(candleS) : barAt(idx));
    renderMaLegend(idx);
    renderVolLegend(idx);
    if (overlays.size) renderOverlayBar();      // 叠加读数跟着光标走
    if (ind.macd) renderSubLegend(idx);
    if (!pinned) {
      if (idx == null || !fromMain) hideBarDetail();
      else showBarDetail(idx, param.point);
    }
    if (xhairSync) return;
    xhairSync = true;
    try {
      if (hasBar) syncCrosshair(param.time, param.__src);
      else clearAllCrosshair();
    } finally { xhairSync = false; }
  }
  function barAt(i) {
    const r = i != null ? lastRows[i] : null;
    return r ? { open: r.o, high: r.h, low: r.l, close: r.c } : null;
  }
  chart.subscribeCrosshairMove((p) => { p.__src = chart; onCrosshair(p, true); });
  for (const pane of subPanes)
    pane.chart.subscribeCrosshairMove((p) => { p.__src = pane.chart; onCrosshair(p, false); });

  // 指针进出整个图表区(主图+副图)才决定光标去留
  const area = $("chart-area");
  area.addEventListener("mouseenter", () => { pointerInChart = true; }, true);
  area.addEventListener("mouseleave", () => {
    pointerInChart = false;
    hoverTime = null;
    clearAllCrosshair();
    renderOhlcLegend(null); renderMaLegend(); renderVolLegend();
    if (ind.macd) renderSubLegend();
    if (!pinned) hideBarDetail();
  });
  chart.subscribeClick((p) => {          // 点击 = 钉住/取消钉住
    if (tool !== "cursor" || !p || p.time == null || !p.point) { pinned = false; hideBarDetail(); return; }
    const idx = timeIndex.get(p.time);
    if (idx == null) { pinned = false; hideBarDetail(); return; }
    pinned = !pinned;
    showBarDetail(idx, p.point);
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => redraw());
  new ResizeObserver(() => { resizeCanvas(); redraw(); }).observe($("chart-stack"));
}

/* ================= 历史懒加载 =================
   往左拖到头时自动向后端要更早的一段。lightweight-charts v4 没有 prependData,
   只能重建整条数组再 setData, 所以每段要拉得够大, 别切太碎。 */
const histCache = new Map();       // "sym|dur" -> {rows, exhausted, earliest}
let histLoading = false;

function histPageDays(dur) {
  if (dur >= 86400) return 4000;   // 日线一次拉完(全市场最多也就 2570 根)
  if (dur >= 3600) return 400;
  if (dur >= 900) return 60;
  return 20;                       // 1m/3m/5m: 一次 20 天
}
function ymd(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
async function loadMoreHistory() {
  if (histLoading || isTimeShare() || !selected) return;
  const dur = dataDuration();
  const key = `${selected}|${dur}`;
  const st = histCache.get(key) || { rows: [], exhausted: false, earliest: null };
  if (st.exhausted) return;
  const oldest = st.earliest != null ? st.earliest
    : (lastRows.length ? lastRows[0].t : null);
  if (oldest == null) return;
  histLoading = true;
  setHistHint("正在加载更早的历史…");
  try {
    const endD = new Date((oldest - 1) * 1000);
    const startD = new Date(endD.getTime() - histPageDays(dur) * 86400e3);
    const res = await request("history", {
      symbol: selected, duration: dur, start: ymd(startD), end: ymd(endD),
    }, 180000);
    const got = (res.rows || []).filter((r) => r.t < oldest);
    if (!got.length) {
      st.exhausted = true;
      setHistHint("已到最早可得数据", 2500);
    } else {
      st.rows = got.concat(st.rows);
      st.earliest = got[0].t;
      setHistHint(`已回补 ${got.length} 根, 起点 ${new Date((got[0].t + TZ_SHIFT) * 1000).toISOString().slice(0, 10)}`, 2500);
    }
    histCache.set(key, st);
    if (got.length) {
      // 保住用户当前的观察窗口: 前面插了 got.length 根, 逻辑下标整体右移
      const vr = chart.timeScale().getVisibleLogicalRange();
      // 不要清 renderedKey: 那会让 fullRender 以为是换了合约, 先自动跳到最新一屏
      // (副图就被同步到那儿了), 再被下面拉回来 —— 两张图从此各看各的。
      // 根数变了本来就会走全量渲染, 不需要额外触发。
      applyKlines(lastRaw);
      if (vr) {
        noHistLoad++;              // 只挡历史回补, 不挡星型同步, 否则副图不会跟过来
        try {
          chart.timeScale().setVisibleLogicalRange(
            { from: vr.from + got.length, to: vr.to + got.length });
        } catch (e) { /* 忽略 */ }
        noHistLoad--;
      }
    }
  } catch (e) {
    setHistHint("历史加载失败: " + e.message, 3000);
  } finally {
    histLoading = false;
  }
}
let hintTimer = 0;
function setHistHint(text, autoHideMs) {
  const el = $("hist-hint");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(hintTimer);
  if (autoHideMs) hintTimer = setTimeout(() => el.classList.add("hidden"), autoHideMs);
}

let lastRaw = [];
function applyKlines(rawIn) {
  if (loadingKey && loadingKey === `${selected}|${dataDuration()}` && rawIn && rawIn.length) exitLoading();
  lastRaw = rawIn;
  // 拼接已回补的历史: 服务端推的是滚动窗口, 历史段在前
  const st = histCache.get(`${selected}|${dataDuration()}`);
  const raw = (st && st.rows.length && rawIn.length)
    ? st.rows.filter((r) => r.t < rawIn[0].t).concat(rawIn)
    : rawIn;
  if (isTimeShare()) {                       // 分时图走独立渲染器
    lastRows = raw;
    const q = lastQuotes[selected] || {};
    if (window.TimeShare) {
      TimeShare.render({
        bars: raw,
        tradingTime: q.trading_time || null,
        base: baseline(q),
        dayVolume: q.volume,
        digits: priceDigits() != null ? priceDigits() : 2,
        name: q.instrument_name || selected,
      });
    }
    return;
  }
  const rows = (duration === WEEK || duration === MONTH) ? aggregate(raw, duration) : raw;
  const key = `${selected}|${duration}`;
  const structural = key !== renderedKey || rows.length !== lastRows.length;
  lastRows = rows;
  if (structural) fullRender(rows, key);
  else tailRender(rows);          // 常态: 每 0.5s 只动最后一根, 不重算整条序列
  redraw();
}

/* 全量渲染: 换合约/换周期/根数变化时才走这里 */
function fullRender(rows, key) {
  const bars = rows.map((r) => ({ time: r.t + TZ_SHIFT, open: r.o, high: r.h, low: r.l, close: r.c }));
  const vols = rows.map((r) => ({
    time: r.t + TZ_SHIFT, value: r.v,
    color: r.c >= r.o ? "rgba(230,103,103,0.45)" : "rgba(25,158,112,0.5)",
  }));
  const fresh = key !== renderedKey;
  candleS.setData(bars);
  volS.setData(vols);
  renderedKey = key;
  lastBarTime = bars.length ? bars[bars.length - 1].time : 0;
  if (fresh) {
    const n = bars.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + RIGHT_PAD });
  }
  const times = bars.map((b) => b.time);
  const closes = rows.map((r) => r.c);
  timeIndex = new Map(times.map((t, i) => [t, i]));
  lastTimes = times;
  lastMA = {};
  const mad = maDefs();
  maS.forEach((s2, i) => s2.applyOptions({ visible: ind.ma && i < mad.length, color: LINE_COLORS[i % LINE_COLORS.length] }));
  mad.forEach(([n], i) => {
    const v = sma(closes, n);
    lastMA[n] = v;
    maS[i].setData(ind.ma ? toLine(times, v) : []);
  });
  lastMAVOL = {};
  const volsRaw = rows.map((r) => r.v || 0);
  const mvd = mavolDefs();
  mavolS.forEach((s2, i) => s2.applyOptions({ visible: ind.vol && i < mvd.length }));
  mvd.forEach(([n], i) => {
    const v = sma(volsRaw, n);
    lastMAVOL[n] = v;
    mavolS[i].setData(ind.vol ? toLine(times, v) : []);
  });
  const kcOn = !!ind.kc;
  ["mid", "up", "lo"].forEach((k) => kcS[k] && kcS[k].applyOptions({ visible: kcOn }));
  if (kcOn) {
    const e = ema(closes, P.kc[0]), a = atrCalc(rows, P.kc[1]), m = P.kc[2];
    kcS.mid.setData(toLine(times, e));
    kcS.up.setData(toLine(times, e.map((x, i) => (x != null && a[i] != null) ? x + m * a[i] : null)));
    kcS.lo.setData(toLine(times, e.map((x, i) => (x != null && a[i] != null) ? x - m * a[i] : null)));
  }
  if (ind.boll) {
    const b = bollCalc(closes, P.boll[0], P.boll[1]);
    lastBOLL = b;
    bollS.mid.setData(toLine(times, b.mid));
    bollS.up.setData(toLine(times, b.up));
    bollS.lo.setData(toLine(times, b.lo));
  }
  refillOverlays();          // 主图时间栅格变了, 叠加线要按新栅格重铺
  syncCmpMode();
  if (ind.macd) renderSubChart(rows, times, closes);
  // 悬停时图例要停在悬停那根上, 不能被 120ms 一次的行情刷新拉回最后一根
  const hi = hoverIdx();
  renderOhlcLegend(hi != null ? barAtIdx(hi) : null);
  renderMaLegend(hi);
  renderVolLegend(hi);
  if (ind.macd) renderSubLegend(hi);
  restoreCrosshair();   // 刷新会冲掉程序化设置的十字线
}

/* 两个副图槽位各自渲染 */
function renderSubChart(rows, times, closes) {
  SUB_SLOTS.forEach((slot, i) => renderSubPane(i, rows, times, closes));
  // 副图从空变成有数据时会自己 auto-fit 到自身区间, 跟主图就错开了。
  // 喂完数据再把主图区间推过去 (rAF 延后, 不会和本次渲染打架)。
  pushRangeToSubs();
}
function renderSubPane(slotIdx, rows, times, closes) {
  const slot = SUB_SLOTS[slotIdx], p = subPanes[slotIdx];
  if (!p) return;
  const wrap = $(slot.wrap);
  const off = slot.kind === "none" || !ind.macd;
  if (wrap) wrap.classList.toggle("hidden", off);
  if (off) return;
  // 只设 visible:false 是不够的 —— 隐藏的序列照样参与时间轴计算, 里面留着
  // 上一个指标/上一个周期的数据, 会把副图时间轴撑得和主图对不上(实测副图
  // 三条序列长度变成 237/300/300, 逻辑区间整体偏移 2 根)。用不到的必须清空。
  const on = (s, v) => {
    if (!s) return;
    s.applyOptions({ visible: v });
    if (!v) { try { s.setData([]); } catch (e) { /* 已销毁 */ } }
  };
  const k = slot.kind;
  [p.hist, p.dif, p.dea].forEach((s) => on(s, k === "macd"));
  [p.k, p.d, p.j].forEach((s) => on(s, k === "kdj"));
  [p.r6, p.r12, p.r24].forEach((s) => on(s, k === "rsi"));
  on(p.cci, k === "cci");
  on(p.oi, k === "oi");
  p.rv.forEach((s2, i) => on(s2, (k === "vol") || (k === "volq") || (k === "volr" && i < 2)));
  if (k === "macd") {
    const m = macdCalc(closes, P.macd[0], P.macd[1], P.macd[2]);
    p.dif.setData(toLine(times, m.dif));
    p.dea.setData(toLine(times, m.dea));
    // 预热期要给 whitespace(只有 time), 不能给 value:null —— 否则算一个有效点,
    // 副图左边界比主图晚一根
    p.hist.setData(times.map((t, i) => (m.hist[i] != null && isFinite(m.hist[i]))
      ? { time: t, value: m.hist[i], color: m.hist[i] >= 0 ? C.up : C.down }
      : { time: t }));
    p.last = m;
  } else if (k === "kdj") {
    const v = kdjCalc(rows, P.kdj[0], P.kdj[1], P.kdj[2]);
    p.k.setData(toLine(times, v.K)); p.d.setData(toLine(times, v.D)); p.j.setData(toLine(times, v.J));
    p.last = v;
  } else if (k === "rsi") {
    const v = { r6: rsiCalc(closes, P.rsi[0]), r12: rsiCalc(closes, P.rsi[1]), r24: rsiCalc(closes, P.rsi[2]) };
    p.r6.setData(toLine(times, v.r6)); p.r12.setData(toLine(times, v.r12)); p.r24.setData(toLine(times, v.r24));
    p.last = v;
  } else if (k === "cci") {
    const v = cciCalc(rows, P.cci[0]);
    p.cci.setData(toLine(times, v));
    p.last = { cci: v };
  } else if (k === "oi") {
    const v = rows.map((r) => r.oi);
    p.oi.setData(toLine(times, v));
    p.last = { oi: v };
  } else if (k === "vol" || k === "volq" || k === "volr") {
    const ns = rvNs(), bs = dataDuration(), ds = dailySecOf(lastQuotes[selected]);
    if (k === "vol") {                          // 绝对年化(多窗口)
      const vs = ns.map((n) => rvCalc(rows, n, bs, ds));
      vs.forEach((v, i) => p.rv[i].setData(toLine(times, v)));
      p.last = { rv: vs, ns, kind: k };
    } else if (k === "volq") {                  // 状态: 分位
      const sig = rvCalc(rows, ns[1], bs, ds);
      const q = rvPercentile(sig, rows, 500);
      p.rv[0].setData(toLine(times, q));
      p.rv[1].setData(times.map((t) => ({ time: t, value: 80 })));   // 高波线
      p.rv[2].setData(times.map((t) => ({ time: t, value: 20 })));   // 压缩线
      p.last = { q, sig, ns, kind: k, mode: q.mode };
    } else {                                    // 方向: 短/长比值
      const a = rvCalc(rows, ns[0], bs, ds), b = rvCalc(rows, ns[2], bs, ds);
      const ratio = a.map((x, i) => (x != null && b[i]) ? x / b[i] : null);
      p.rv[0].setData(toLine(times, ratio));
      p.rv[1].setData(times.map((t) => ({ time: t, value: 1 })));    // 分界线
      p.rv[2].setData([]);
      p.last = { ratio, ns, kind: k };
    }
  }
  renderSubLegend(undefined, slotIdx);
}
function renderSubLegend(idx, slotIdx) {
  if (slotIdx == null) { SUB_SLOTS.forEach((_, i) => renderSubLegend(idx, i)); return; }
  const slot = SUB_SLOTS[slotIdx], p = subPanes[slotIdx];
  const el = $(slot.legend);
  if (!el || !p) return;
  if (slot.kind === "none") { el.innerHTML = ""; return; }
  const i = idx != null ? idx : lastRows.length - 1;
  const f = (a) => (a && a[i] != null ? fmt(a[i], 2) : "—");
  const chip = (c) => `<span class="lg-chip" style="background:${c}"></span>`;
  const s = p.last || {};
  const K = slot.kind;
  if (K === "macd") el.innerHTML = `<span class="mi">MACD(${P.macd.join(",")})</span>${chip(C.ma5)}DIF ${f(s.dif)}${chip(C.ma10)}DEA ${f(s.dea)}${chip(C.muted)}MACD ${f(s.hist)}`;
  else if (K === "kdj") el.innerHTML = `<span class="mi">KDJ(${P.kdj.join(",")})</span>${chip(C.ma5)}K ${f(s.K)}${chip(C.ma10)}D ${f(s.D)}${chip(C.ma20)}J ${f(s.J)}`;
  else if (K === "rsi") el.innerHTML = `<span class="mi">RSI(${P.rsi.join(",")})</span>${chip(C.ma5)}${f(s.r6)}${chip(C.ma10)}${f(s.r12)}${chip(C.ma20)}${f(s.r24)}`;
  else if (K === "cci") el.innerHTML = `<span class="mi">CCI(${P.cci[0]})</span>${chip(C.ma5)}${f(s.cci)}`;
  else if (K === "oi") el.innerHTML = `<span class="mi">持仓量</span>${chip(C.ma20)}${s.oi && s.oi[i] != null ? fmtVol(s.oi[i]) : "—"}`;
  else if (K === "vol") {
    const ns = s.ns || rvNs();
    el.innerHTML = `<span class="mi">波动率 ${VOL_EST_LABEL[volEst]} (年化%)</span>` + ns.map((n, j) => {
      const a = s.rv && s.rv[j];
      return `${chip(LINE_COLORS[j])}${n}根 ${a && a[i] != null ? a[i].toFixed(1) : "—"}`;
    }).join("");
  } else if (K === "volq") {
    const q = s.q && s.q[i], sg = s.sig && s.sig[i];
    const st = q == null ? ["—", "flat"] : q >= 80 ? ["高波", "up"] : q <= 20 ? ["压缩", "down"] : ["正常", "flat"];
    el.innerHTML = `<span class="mi">波动率分位 · ${s.mode || ""}</span>` +
      `${chip(LINE_COLORS[0])}分位 <b class="${st[1]}">${q == null ? "—" : q.toFixed(0) + "%"}</b>` +
      `　<b class="${st[1]}">${st[0]}</b>　σ ${sg != null ? sg.toFixed(1) : "—"}%`;
  } else if (K === "volr") {
    const v = s.ratio && s.ratio[i];
    const st = v == null ? ["—", "flat"] : v > 1.15 ? ["扩张", "up"] : v < 0.85 ? ["收缩", "down"] : ["平稳", "flat"];
    el.innerHTML = `<span class="mi">波动扩张/收缩 σ${(s.ns || rvNs())[0]}/σ${(s.ns || rvNs())[2]}</span>` +
      `${chip(LINE_COLORS[0])}<b class="${st[1]}">${v == null ? "—" : v.toFixed(2)}</b>　<b class="${st[1]}">${st[0]}</b>`;
  }
}
/* 每交易日秒数(波动率年化用): 从 trading_time 推 */
function dailySecOf(q) {
  const tt = q && q.trading_time;
  if (!tt) return 5.5 * 3600;
  const hm = (s) => s.split(":").reduce((a, x, i) => a + (+x) * [3600, 60, 1][i], 0);
  let t = 0;
  for (const seg of [].concat(tt.day || [], tt.night || []))
    if (seg && seg.length >= 2) t += Math.max(0, hm(seg[1]) - hm(seg[0]));
  return t > 600 ? t : 5.5 * 3600;
}

/* 增量渲染: 只重算最后一根所需的尾部窗口, 与序列长度无关 —— 这是几万根K线不卡的关键 */
function tailRender(rows) {
  const n = rows.length;
  if (!n) return;
  const i = n - 1;
  const r = rows[i], t = r.t + TZ_SHIFT;
  candleS.update({ time: t, open: r.o, high: r.h, low: r.l, close: r.c });
  volS.update({ time: t, value: r.v, color: r.c >= r.o ? "rgba(230,103,103,0.45)" : "rgba(25,158,112,0.5)" });
  lastBarTime = t;
  const tailAt = (win) => Math.max(0, n - win);
  if (ind.ma) maDefs().forEach(([w], j) => {
    const from = tailAt(w);
    const v = sma(rows.slice(from).map((x) => x.c), w);
    const val = v[v.length - 1];
    if (lastMA[w]) lastMA[w][i] = val;
    if (val != null) maS[j].update({ time: t, value: val });
  });
  if (ind.vol) mavolDefs().forEach(([w], j) => {
    const v = sma(rows.slice(tailAt(w)).map((x) => x.v || 0), w);
    const val = v[v.length - 1];
    if (lastMAVOL[w]) lastMAVOL[w][i] = val;
    if (val != null) mavolS[j].update({ time: t, value: val });
  });
  if (ind.boll) {
    const b = bollCalc(rows.slice(tailAt(P.boll[0] * 3)).map((x) => x.c), P.boll[0], P.boll[1]);
    const k = b.mid.length - 1;
    if (b.mid[k] != null) {
      if (lastBOLL) { lastBOLL.mid[i] = b.mid[k]; lastBOLL.up[i] = b.up[k]; lastBOLL.lo[i] = b.lo[k]; }
      bollS.mid.update({ time: t, value: b.mid[k] });
      bollS.up.update({ time: t, value: b.up[k] });
      bollS.lo.update({ time: t, value: b.lo[k] });
    }
  }
  if (ind.macd) SUB_SLOTS.forEach((slot, si) => {
    const p = subPanes[si];
    if (!p || slot.kind === "none") return;
    const S = p.last || {};
    if (slot.kind === "macd") {
      // EMA 是递归的, 尾窗要足够长才收敛: 26*4 根足以让初值影响衰减到可忽略
      const m = macdCalc(rows.slice(tailAt(P.macd[1] * 6)).map((x) => x.c), P.macd[0], P.macd[1], P.macd[2]);
      const k = m.dif.length - 1;
      if (S.dif) { S.dif[i] = m.dif[k]; S.dea[i] = m.dea[k]; S.hist[i] = m.hist[k]; }
      p.dif.update({ time: t, value: m.dif[k] });
      p.dea.update({ time: t, value: m.dea[k] });
      p.hist.update({ time: t, value: m.hist[k], color: m.hist[k] >= 0 ? C.up : C.down });
    } else if (slot.kind === "kdj") {
      const v = kdjCalc(rows.slice(tailAt(P.kdj[0] * 12)), P.kdj[0], P.kdj[1], P.kdj[2]);      // K/D 是递归平滑, 留足收敛窗口
      const k = v.K.length - 1;
      if (S.K) { S.K[i] = v.K[k]; S.D[i] = v.D[k]; S.J[i] = v.J[k]; }
      p.k.update({ time: t, value: v.K[k] });
      p.d.update({ time: t, value: v.D[k] });
      p.j.update({ time: t, value: v.J[k] });
    } else if (slot.kind === "rsi") {
      const tail = rows.slice(tailAt(200)).map((x) => x.c);
      for (const [n, key, s] of [[P.rsi[0], "r6", p.r6], [P.rsi[1], "r12", p.r12], [P.rsi[2], "r24", p.r24]]) {
        const a = rsiCalc(tail, n), val = a[a.length - 1];
        if (S[key]) S[key][i] = val;
        if (val != null) s.update({ time: t, value: val });
      }
    } else if (slot.kind === "cci") {
      const a = cciCalc(rows.slice(tailAt(P.cci[0] * 3)), P.cci[0]);
      const val = a[a.length - 1];
      if (S.cci) S.cci[i] = val;
      if (val != null) p.cci.update({ time: t, value: val });
    } else if (slot.kind === "oi") {
      if (S.oi) S.oi[i] = r.oi;
      if (r.oi != null) p.oi.update({ time: t, value: r.oi });
    }
    renderSubLegend(undefined, si);
  });
  // 悬停时图例要停在悬停那根上, 不能被 120ms 一次的行情刷新拉回最后一根
  const hi = hoverIdx();
  renderOhlcLegend(hi != null ? barAtIdx(hi) : null);
  renderMaLegend(hi);
  renderVolLegend(hi);
  if (ind.macd) renderSubLegend(hi);
  restoreCrosshair();   // 刷新会冲掉程序化设置的十字线
}

function renderOhlcLegend(bar) {
  const last = lastRows[lastRows.length - 1];
  const r = bar || (last ? { open: last.o, high: last.h, low: last.l, close: last.c } : null);
  if (!r) { $("ohlc-legend").textContent = ""; return; }
  const cls = r.close >= r.open ? "up" : "down";
  $("ohlc-legend").innerHTML =
    `开 <span class="${cls}">${fmt(r.open)}</span> 高 <span class="${cls}">${fmt(r.high)}</span> ` +
    `低 <span class="${cls}">${fmt(r.low)}</span> 收 <span class="${cls}">${fmt(r.close)}</span>`;
}
function renderMaLegend(idx) {
  if (!ind.ma) { $("ma-legend").innerHTML = ""; return; }
  $("ma-legend").innerHTML = maDefs().map(([n, color]) => {
    const arr = lastMA[n] || [];
    const v = arr[idx != null ? idx : arr.length - 1];
    return `<span class="lg-chip" style="background:${color}"></span>MA${n} ${v != null ? fmt(v) : "—"}`;
  }).join("");
}
function renderVolLegend(idx) {
  if (!ind.vol) { $("vol-legend").innerHTML = ""; return; }
  const i = idx != null ? idx : lastRows.length - 1;
  const r = lastRows[i];
  if (!r) { $("vol-legend").innerHTML = ""; return; }
  const oiTxt = isStock(lastQuotes[selected]) ? ""
    : `<span class="lg-chip" style="background:${C.ma20}"></span>持仓 ${fmtVol(r.oi)}`;
  $("vol-legend").innerHTML =
    `<span class="mi">VOL(${P.mavol.join(",")})</span>成交量 ${fmtVol(r.v)}` +
    mavolDefs().map(([n, color]) => {
      const arr = lastMAVOL[n] || [];
      return `<span class="lg-chip" style="background:${color}"></span>MAVOL${n} ${arr[i] != null ? fmtVol(Math.round(arr[i])) : "—"}`;
    }).join("") + oiTxt;
}

/* ================= K线详情框(跟随光标, 点击可钉住) ================= */
let pinned = false;
function showBarDetail(idx, point) {
  const r = lastRows[idx], prev = lastRows[idx - 1];
  if (!r) { hideBarDetail(); return; }
  const base = prev ? prev.c : r.o;
  const chg = r.c - base, pct = base ? (chg / base) * 100 : 0;
  const amp = r.o ? ((r.h - r.l) / base) * 100 : 0;
  const q = lastQuotes[selected];
  const d = new Date((r.t + TZ_SHIFT) * 1000);
  const p2 = (x) => String(x).padStart(2, "0");
  const showTime = duration < 86400;
  const label = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    (showTime ? ` ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : "");
  const cls = chg >= 0 ? "up" : "down";
  const oiRow = isStock(q) ? "" :
    `<div class="bd-row"><span class="bd-k">持仓</span><span>${fmtVol(r.oi)}</span></div>`;
  const maRows = maDefs().map(([n, color]) => {
    const arr = lastMA[n] || [];
    return arr[idx] != null
      ? `<div class="bd-row"><span class="bd-k"><span class="lg-chip" style="background:${color};margin-left:0"></span>MA${n}</span><span>${fmt(arr[idx])}</span></div>`
      : "";
  }).join("");
  const el = $("bar-detail");
  el.innerHTML =
    `<div class="bd-head"><span>${label}</span><span class="bd-close">${pinned ? "✕" : "📌"}</span></div>` +
    `<div class="bd-row"><span class="bd-k">开盘</span><span class="${r.o >= base ? "up" : "down"}">${fmt(r.o)}</span></div>` +
    `<div class="bd-row"><span class="bd-k">最高</span><span class="up">${fmt(r.h)}</span></div>` +
    `<div class="bd-row"><span class="bd-k">最低</span><span class="down">${fmt(r.l)}</span></div>` +
    `<div class="bd-row"><span class="bd-k">收盘</span><span class="${cls}">${fmt(r.c)}</span></div>` +
    `<div class="bd-row"><span class="bd-k">涨跌</span><span class="${cls}">${chg > 0 ? "+" : ""}${fmt(chg)} (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)</span></div>` +
    `<div class="bd-row"><span class="bd-k">振幅</span><span>${amp.toFixed(2)}%</span></div>` +
    `<div class="bd-row"><span class="bd-k">成交量</span><span>${fmtVol(r.v)}</span></div>` + oiRow + maRows;
  el.classList.remove("hidden");
  el.classList.toggle("pinned", pinned);
  const stack = $("chart-stack").getBoundingClientRect();
  const w = el.offsetWidth || 200, h = el.offsetHeight || 220;
  let x = point.x + 16, y = point.y + 12;
  if (x + w > stack.width) x = point.x - w - 16;
  if (y + h > stack.height) y = Math.max(0, stack.height - h - 4);
  el.style.left = Math.max(0, x) + "px";
  el.style.top = Math.max(0, y) + "px";
  el.querySelector(".bd-close").onclick = (ev) => { ev.stopPropagation(); pinned = false; hideBarDetail(); };
}
function hideBarDetail() { $("bar-detail").classList.add("hidden"); }

/* ================= 画线引擎 ================= */
let tool = "cursor";
let shapes = [];         // {type, a:{t,p}, b:{t,p}, text}
let selectedShape = -1;
let drafting = null;     // 绘制中的图形
let dragHandle = null;   // {idx, which:'a'|'b'}
const canvas = $("draw-canvas");
const ctx = canvas.getContext("2d");

function drawKey() { return `draw:${selected}|${duration}`; }
function loadDrawings() {
  try { shapes = JSON.parse(localStorage.getItem(drawKey()) || "[]"); }
  catch { shapes = []; }
  selectedShape = -1;
  redraw();
}
function saveDrawings() {
  try { localStorage.setItem(drawKey(), JSON.stringify(shapes)); } catch { /* 配额满则忽略 */ }
}
function resizeCanvas() {
  const st = $("chart-stack");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = st.clientWidth * dpr;
  canvas.height = st.clientHeight * dpr;
  canvas.style.width = st.clientWidth + "px";
  canvas.style.height = st.clientHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
/* 数据坐标 <-> 像素
   timeToCoordinate / coordinateToTime 只认数据里真实存在的时间, 最后一根之后
   一律返回 null。趋势线、通道、目标位这些本来就要往右延伸到未来, 所以超出
   末根的部分改用 logical 坐标线性外推 —— logical 轴在数据范围外仍然有效。
   两个方向必须严格互逆, 否则画完的图形自己会漂。 */
function lastBarSec() {
  // 周K/月K 是前端聚合出来的, dataDuration() 返回的是 86400 而不是真实跨度,
  // 所以优先从实际渲染出来的时间轴量。夜盘/午休会造成大跳空, 取最小间隔最接近周期。
  const n = lastTimes.length;
  if (n >= 2) {
    let m = Infinity;
    for (let i = Math.max(1, n - 20); i < n; i++) {
      const d = lastTimes[i] - lastTimes[i - 1];
      if (d > 0 && d < m) m = d;
    }
    if (isFinite(m)) return m;
  }
  const d = dataDuration();
  return d > 0 ? d : 60;
}
function futureTime(logical) {
  const n = lastTimes.length;
  if (!n) return null;
  return lastTimes[n - 1] + Math.round(logical - (n - 1)) * lastBarSec();
}
function futureLogical(t) {
  const n = lastTimes.length;
  if (!n) return null;
  return (n - 1) + (t - lastTimes[n - 1]) / lastBarSec();
}
function xOfTime(t) {
  const ts = chart.timeScale();
  const n = lastTimes.length;
  if (n && t > lastTimes[n - 1]) {
    const lg = futureLogical(t);
    return lg == null ? null : ts.logicalToCoordinate(lg);
  }
  return ts.timeToCoordinate(t);
}
function timeOfX(x) {
  const ts = chart.timeScale();
  const t = ts.coordinateToTime(x);
  if (t != null) return t;
  const n = lastTimes.length;
  if (!n) return null;
  const lg = ts.coordinateToLogical(x);
  if (lg == null) return null;
  if (lg > n - 1) return futureTime(lg);        // 末根右侧: 外推到未来
  return lastTimes[0];                          // 首根左侧: 贴住最早一根
}
function toXY(pt) {
  const x = xOfTime(pt.t);
  const y = candleS.priceToCoordinate(pt.p);
  return x == null || y == null ? null : { x, y };
}
/* 画线吸附: 打开后端点自动贴到最近一根 K 线的 开/高/低/收 里最接近的那个价位,
   画支撑压力、框选区间时能精确落在实际价位上, 而不是像素随手位置。
   按住 Alt 临时关闭吸附。 */
let snapOn = true;
try { snapOn = localStorage.getItem("mw:snap") !== "0"; } catch (e) { /* 忽略 */ }
let snapSuspend = false;
const SNAP_PX = 14;          // 价格方向的吸附半径(像素)

function toData(x, y) {
  const t = timeOfX(x);          // 末根右侧会外推出未来时间, 不再钳回最后一根
  const p = candleS.coordinateToPrice(y);
  if (t == null || p == null) return null;
  if (!snapOn || snapSuspend || !lastRows.length) return { t, p };
  // 落在真实 K 线上才吸附; 外推到未来的位置没有 K 线可贴, 保持原价
  const idx = timeIndex.get(t);
  const r = idx != null ? lastRows[idx] : null;
  if (!r) return { t, p };
  let best = p, bestD = Infinity;
  for (const cand of [r.o, r.h, r.l, r.c]) {
    if (cand == null) continue;
    const cy = candleS.priceToCoordinate(cand);
    if (cy == null) continue;
    const d = Math.abs(cy - y);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return { t, p: bestD <= SNAP_PX ? best : p };
}
function redraw() {
  if (!canvas.width) resizeCanvas();
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  const all = drafting ? shapes.concat([drafting]) : shapes;
  all.forEach((s, i) => drawShape(s, i === selectedShape));
  drawDrawCrosshair(W, H);
}

/* 画线模式下 lightweight-charts 收不到鼠标(画布接管了 pointer-events),
   自带的十字光标没了。这里自己画一套, 并且**落在吸附后的位置**上,
   所见即所得 —— 松手画出来的点就是十字线交叉的点。 */
let drawCur = null;          // {x, y, t, p, snapped}
function drawDrawCrosshair(W, H) {
  if (tool === "cursor" || !drawCur) return;
  const { x, y, snapped } = drawCur;
  ctx.save();
  ctx.strokeStyle = snapped ? C.ma5 : C.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y); ctx.lineTo(W, y);
  ctx.moveTo(x, 0); ctx.lineTo(x, H);
  ctx.stroke();
  ctx.setLineDash([]);
  if (snapped) {                     // 吸附到某个价位时给个小方块提示
    ctx.fillStyle = C.ma5;
    ctx.fillRect(x - 3, y - 3, 6, 6);
  }
  // 右侧价格标签
  const label = fmt(drawCur.p);
  ctx.font = "11px system-ui, -apple-system, sans-serif";
  const tw = ctx.measureText(label).width + 8;
  ctx.fillStyle = snapped ? C.ma5 : "#3a3a38";
  ctx.fillRect(W - tw - 2, y - 8, tw, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, W - tw + 2, y + 4);
  ctx.restore();
}
function drawShape(s, sel) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  // 水平线只由价格决定, 不依赖时间锚点 —— 否则换周期后锚点时间不在数据里就整条消失
  if (s.type === "hline") {
    const y = candleS.priceToCoordinate(s.a.p);
    if (y == null) return;
    ctx.save();
    ctx.strokeStyle = sel ? C.drawSel : C.draw;
    ctx.lineWidth = sel ? 2 : 1.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.font = "11px system-ui, -apple-system, sans-serif";
    ctx.fillStyle = sel ? C.drawSel : C.draw;
    ctx.fillText(fmt(s.a.p), 4, y - 3);
    ctx.restore();
    return;
  }
  const a = toXY(s.a), b = s.b ? toXY(s.b) : null;
  if (!a) return;
  ctx.save();
  ctx.strokeStyle = sel ? C.drawSel : C.draw;
  ctx.fillStyle = sel ? C.drawSel : C.draw;
  ctx.lineWidth = sel ? 2 : 1.5;
  ctx.beginPath();
  if (s.type === "vline") { ctx.moveTo(a.x, 0); ctx.lineTo(a.x, H); ctx.stroke(); }
  else if (s.type === "trend" && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
  else if (s.type === "rect" && b) {
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.stroke();
    ctx.globalAlpha = 0.10; ctx.fill(); ctx.globalAlpha = 1;
  } else if (s.type === "text") {
    ctx.font = "12px system-ui, -apple-system, sans-serif";
    ctx.fillText(s.text || "", a.x + 4, a.y - 4);
    ctx.beginPath(); ctx.arc(a.x, a.y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  if (sel) {
    [a, b].forEach((pt) => {
      if (!pt) return;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = C.drawSel; ctx.fill();
      ctx.strokeStyle = C.surface; ctx.lineWidth = 1.5; ctx.stroke();
    });
  }
  ctx.restore();
}
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function hitTest(x, y) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === "hline") {                 // 与 drawShape 一致: 只看价格
      const yy = candleS.priceToCoordinate(s.a.p);
      if (yy != null && Math.abs(y - yy) < 6) return i;
      continue;
    }
    const a = toXY(s.a), b = s.b ? toXY(s.b) : null;
    if (!a) continue;
    let hit = false;
    if (s.type === "vline") hit = Math.abs(x - a.x) < 6;
    else if (s.type === "trend" && b) hit = distToSeg(x, y, a.x, a.y, b.x, b.y) < 6;
    else if (s.type === "rect" && b) {
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
      hit = [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]]
        .some((e) => distToSeg(x, y, e[0], e[1], e[2], e[3]) < 6);
    } else if (s.type === "text") hit = Math.hypot(x - a.x, y - a.y) < 26 && y < a.y + 6 && x > a.x - 6;
    if (hit) return i;
  }
  return -1;
}
function localXY(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
canvas.addEventListener("mousedown", (e) => {
  const { x, y } = localXY(e);
  if (tool === "cursor") return;
  const d = toData(x, y);
  if (!d) return;
  if (tool === "text") {
    const txt = prompt("标注文字:");
    if (txt) { shapes.push({ type: "text", a: d, text: txt }); saveDrawings(); }
    setTool("cursor"); redraw(); return;
  }
  if (tool === "hline" || tool === "vline") {
    shapes.push({ type: tool, a: d });
    saveDrawings(); setTool("cursor"); redraw(); return;
  }
  drafting = { type: tool, a: d, b: d };
});
/* mousemove / mouseup 统一绑在 document 上(见下方): 鼠标拖出图表区也能跟手并正常收尾 */
/* 光标模式下: canvas 不拦事件, 在 stack 上做选中/拖动 */
$("chart-stack").addEventListener("mousedown", (e) => {
  if (tool !== "cursor" || e.target.closest("#bar-detail")) return;
  const { x, y } = localXY(e);
  const hit = hitTest(x, y);
  if (hit >= 0) {
    selectedShape = hit;
    const s = shapes[hit];
    for (const w of ["a", "b"]) {
      const pt = s[w] && toXY(s[w]);
      if (pt && Math.hypot(x - pt.x, y - pt.y) < 8) {
        dragHandle = { idx: hit, which: w };
        canvas.classList.add("active");
        // 拖锚点期间冻结图表自身的平移/缩放, 否则坐标系一边滚一边换算, 锚点会乱跳
        chart.applyOptions({ handleScroll: false, handleScale: false });
        e.preventDefault(); e.stopPropagation();
        break;
      }
    }
    redraw();
  } else if (selectedShape >= 0) { selectedShape = -1; redraw(); }
}, true);
document.addEventListener("mouseup", () => {
  if (drafting) {
    const a = toXY(drafting.a), b = toXY(drafting.b);
    if (a && b && Math.hypot(b.x - a.x, b.y - a.y) > 4) shapes.push(drafting);
    drafting = null;
    saveDrawings(); setTool("cursor"); redraw();   // setTool 会摘掉 .active
  }
  if (dragHandle) {
    dragHandle = null; saveDrawings();
    chart.applyOptions({ handleScroll: true, handleScale: true });
    if (tool === "cursor") canvas.classList.remove("active");
  }
});
/* 绘制中的移动也绑到 document: 鼠标移出图表区仍能跟手 */
document.addEventListener("mousemove", (e) => {
  if (!drafting && !dragHandle) return;
  const { x, y } = localXY(e);
  const d = toData(x, y);
  if (!d) return;
  if (drafting) drafting.b = d;
  else shapes[dragHandle.idx][dragHandle.which] = d;
  updateDrawCursor(x, y, d);
  redraw();
});
/* 画线模式: 光标位置 + 吸附提示 + 图例跟随 */
canvas.addEventListener("mousemove", (e) => {
  if (tool === "cursor") return;
  const { x, y } = localXY(e);
  const d = toData(x, y);
  if (d) { updateDrawCursor(x, y, d); redraw(); }
});
canvas.addEventListener("mouseleave", () => {
  if (drawCur) { drawCur = null; redraw(); }
});
function updateDrawCursor(x, y, d) {
  const py = candleS.priceToCoordinate(d.p);
  const px = xOfTime(d.t);
  // 吸附成功时把十字线画在吸附后的位置, 而不是鼠标的原始像素位置
  drawCur = {
    x: px != null ? px : x,
    y: py != null ? py : y,
    t: d.t, p: d.p,
    snapped: py != null && Math.abs(py - y) > 0.5,
  };
  const idx = timeIndex.get(d.t);
  if (idx != null) {                       // 画线时图例也跟着走
    renderOhlcLegend(barAtIdx(idx));
    renderMaLegend(idx);
    renderVolLegend(idx);
    if (overlays.size) renderOverlayBar();      // 叠加读数跟着光标走
    if (ind.macd) renderSubLegend(idx);
    xhairSyncGuard(() => syncCrosshair(d.t, null));   // 副图十字线跟随
  }
}
function barAtIdx(i) {
  const r = i != null ? lastRows[i] : null;
  return r ? { open: r.o, high: r.h, low: r.l, close: r.c } : null;
}
/* 按住 Alt 临时关闭吸附 */
window.addEventListener("keydown", (e) => { if (e.altKey) snapSuspend = true; });
window.addEventListener("keyup", (e) => { if (!e.altKey) snapSuspend = false; });
window.addEventListener("blur", () => { snapSuspend = false; });

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedShape >= 0) {
    shapes.splice(selectedShape, 1); selectedShape = -1; saveDrawings(); redraw();
  } else if (e.key === "Escape") { setTool("cursor"); drafting = null; redraw(); }
});
function setTool(t) {
  tool = t;
  canvas.classList.toggle("active", t !== "cursor");
  document.querySelectorAll("#draw-tools button[data-tool]")
    .forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
}
$("draw-tools").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.tool) setTool(btn.dataset.tool);
  else if (btn.dataset.act === "snap") {
    snapOn = !snapOn;
    btn.classList.toggle("on", snapOn);
    try { localStorage.setItem("mw:snap", snapOn ? "1" : "0"); } catch (e) { /* 忽略 */ }
  } else if (btn.dataset.act === "delete") {
    if (selectedShape >= 0) { shapes.splice(selectedShape, 1); selectedShape = -1; saveDrawings(); redraw(); }
  } else if (btn.dataset.act === "clear") {
    if (shapes.length && confirm("清空本图全部标注?")) { shapes = []; selectedShape = -1; saveDrawings(); redraw(); }
  }
});

/* ================= Tick ================= */
function renderTicks(ticks) {
  const cv = $("tick-canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext("2d");
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  const ps = ticks.map((t) => t.p).filter((p) => p != null);
  if (ps.length > 1) {
    const lo = Math.min(...ps), hi = Math.max(...ps);
    const pad = (hi - lo) * 0.1 || 1;
    const y = (p) => 4 + (H - 8) * (1 - (p - (lo - pad)) / ((hi + pad) - (lo - pad)));
    const x = (i) => (i / (ps.length - 1)) * (W - 44) + 2;
    c.beginPath();
    ps.forEach((p, i) => (i ? c.lineTo(x(i), y(p)) : c.moveTo(x(i), y(p))));
    c.strokeStyle = C.ma5; c.lineWidth = 1.2; c.stroke();
    const lastP = ps[ps.length - 1];
    c.beginPath(); c.arc(x(ps.length - 1), y(lastP), 2.5, 0, Math.PI * 2);
    c.fillStyle = C.ma5; c.fill();
    c.font = "10px system-ui"; c.textAlign = "left";
    c.fillStyle = C.up; c.fillText(fmt(hi), W - 42, y(hi) + 8);
    c.fillStyle = C.down; c.fillText(fmt(lo), W - 42, y(lo) - 2);
    c.fillStyle = C.ink2; c.fillText(fmt(lastP), W - 42, y(lastP) + 3);
  }
  // 逐笔成交: 开平性质由后端按 成交量增量 + 持仓量变化 + 主动方向 推断
  const NAT_CLS = {
    "双开": "nat-open", "多开": "nat-open", "空开": "nat-open",
    "双平": "nat-close", "多平": "nat-close", "空平": "nat-close",
    "多换": "nat-swap", "空换": "nat-swap", "换手": "nat-swap",
  };
  const rows = [];
  for (let i = Math.max(0, ticks.length - 40); i < ticks.length; i++) {
    const t = ticks[i];
    if (t.dv == null && t.v == null) continue;
    const d = new Date(t.t), p2 = (x) => String(x).padStart(2, "0");
    const sideCls = t.side === "B" ? "up" : t.side === "S" ? "down" : "flat";
    const doiTxt = t.doi == null ? "" : (t.doi > 0 ? "+" + t.doi : String(t.doi));
    rows.push(
      `<div class="tape-row">` +
      `<span class="tt">${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}</span>` +
      `<span class="tp ${sideCls}">${fmt(t.p)}</span>` +
      `<span class="tv">${t.dv != null ? t.dv : "—"}</span>` +
      `<span class="tn ${NAT_CLS[t.nat] || "nat-swap"}">${t.nat || "—"}</span>` +
      `<span class="to">${doiTxt || "0"}</span></div>`);
  }
  $("tick-tape").innerHTML = rows.reverse().join("");
}

/* ================= 盘口 & 深度 ================= */
function updateBook(q) {
  const asks = [];
  for (let i = 5; i >= 1; i--)
    if (q[`ask_price${i}`] != null) asks.push({ n: i, p: q[`ask_price${i}`], v: q[`ask_volume${i}`] || 0 });
  const bids = [];
  for (let i = 1; i <= 5; i++)
    if (q[`bid_price${i}`] != null) bids.push({ n: i, p: q[`bid_price${i}`], v: q[`bid_volume${i}`] || 0 });
  const maxV = Math.max(1, ...asks.concat(bids).map((l) => l.v));
  const base = baseline(q);
  const chg = q.last_price != null && base ? q.last_price - base : null;
  const pct = chg != null ? (chg / base) * 100 : null;
  let html = asks.map((l) => bookRow(`卖${l.n}`, l, maxV, C.down)).join("");
  html += `<div class="book-mid"><span class="p ${chgCls(chg)}">${fmt(q.last_price)}</span>` +
    `<span class="c ${chgCls(chg)}">${chg == null ? "—" : (chg > 0 ? "+" : "") + fmt(chg) + "  " + (pct > 0 ? "+" : "") + pct.toFixed(2) + "%"}</span></div>`;
  html += bids.map((l) => bookRow(`买${l.n}`, l, maxV, C.up)).join("");
  $("book").innerHTML = html;
  drawDepth(bids, asks.slice().reverse());
  const lv = Math.max(bids.length, asks.length);
  $("depth-note").textContent = `数据源提供 ${lv} 档行情` + (lv <= 1 ? " (该品种仅一档)" : "");
}
function bookRow(tag, l, maxV, color) {
  return `<div class="book-row"><span class="tag">${tag}</span>` +
    `<span class="px" style="color:${color}">${fmt(l.p)}</span><span class="vol">${l.v}</span>` +
    `<span class="bar" style="width:${Math.round((l.v / maxV) * 100)}%;background:${color}"></span></div>`;
}
function drawDepth(bids, asks) {
  const cv = $("depth-canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext("2d");
  c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  if (!bids.length && !asks.length) {
    c.fillStyle = C.muted; c.font = "11px system-ui"; c.textAlign = "center";
    c.fillText("暂无盘口数据", W / 2, H / 2); return;
  }
  let acc = 0;
  const bidPts = bids.map((l) => ({ cum: (acc += l.v) }));
  acc = 0;
  const askPts = asks.map((l) => ({ cum: (acc += l.v) }));
  const maxCum = Math.max(bidPts.at(-1)?.cum || 0, askPts.at(-1)?.cum || 0, 1);
  const mid = W / 2, gap = 5, bottom = H - 11, top = 4;
  const scaleY = (v) => bottom - (v / maxCum) * (bottom - top);
  const step = (pts, dir, color) => {
    if (!pts.length) return;
    const dx = (mid - gap - 4) / pts.length;
    c.beginPath(); c.moveTo(mid + dir * gap, bottom);
    pts.forEach((pt, i) => {
      const y = scaleY(pt.cum);
      c.lineTo(mid + dir * (gap + i * dx), y);
      c.lineTo(mid + dir * (gap + (i + 1) * dx), y);
    });
    c.lineTo(mid + dir * (gap + pts.length * dx), bottom);
    c.closePath();
    c.fillStyle = color + "33"; c.fill();
    c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
  };
  step(bidPts, -1, C.up);
  step(askPts, +1, C.down);
  c.fillStyle = C.muted; c.font = "10px system-ui";
  c.textAlign = "left"; c.fillText("卖盘 " + (askPts.at(-1)?.cum || 0), mid + gap, H - 3);
  c.textAlign = "right"; c.fillText("买盘 " + (bidPts.at(-1)?.cum || 0), mid - gap, H - 3);
}

/* ================= 合约信息 ================= */
function updateDetail(q) {
  const stock = isStock(q);
  const oiChg = q.open_interest != null && q.pre_open_interest != null ? q.open_interest - q.pre_open_interest : null;
  const kv = [
    ["今开", fmt(q.open)], [stock ? "昨收" : "昨结", fmt(baseline(q))],
    ["最高", fmt(q.highest)], ["最低", fmt(q.lowest)],
    ["均价", fmt(q.average)], ["涨停", fmt(q.upper_limit)],
    ["跌停", fmt(q.lower_limit)], ["总手", fmtVol(q.volume)],
    ["金额", fmtVol(q.amount)],
  ];
  if (!stock) {
    kv.push(["持仓", fmtVol(q.open_interest)],
      ["日增", oiChg == null ? "—" : (oiChg > 0 ? "+" : "") + oiChg],
      ["乘数", q.volume_multiple ?? "—"]);
  }
  kv.push(["最小变动", q.price_tick ?? "—"],
    ["类别", CLS_LABEL[q.ins_class] || q.ins_class || "—"],
    ["时间", q.datetime ? String(q.datetime).slice(5, 19) : "—"]);
  if (!stock && q.expire_datetime) {
    const d = new Date(q.expire_datetime * 1000);
    kv.push(["到期", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`]);
  }
  if (kv.length % 2) kv.push(["", ""]);
  $("quote-detail").innerHTML = kv.map(([k, v]) =>
    k ? `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>` : "<div></div>").join("");
}

/* ================= 工具栏 ================= */
$("periods").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  duration = parseInt(btn.dataset.dur, 10);
  document.querySelectorAll("#periods button").forEach((b) => b.classList.toggle("on", b === btn));
  renderedKey = null;
  pinned = false;
  hideBarDetail();
  applyModeUI();
  loadDrawings();
  // 叠加线也要按新周期重订。不重订的话它会拿着旧周期的数据往新时间栅格上
  // forward-fill, 画出来大半截是条直线。
  for (const o of overlays.values()) o.raw = null;
  subscribe();
  resubOverlays();
});
/* 分时模式: 隐藏 K 线图/画线/指标, 显示分时渲染器 */
function applyModeUI() {
  const ts = isTimeShare();
  $("ts-host").classList.toggle("hidden", !ts);
  $("main-chart").style.visibility = ts ? "hidden" : "";
  $("draw-canvas").style.display = ts ? "none" : "";
  $("draw-tools").style.visibility = ts ? "hidden" : "";
  syncSubVisibility();
  for (const id of ["ohlc-legend", "ma-legend", "vol-legend"])
    $(id).style.display = ts ? "none" : "";
  $("indicators").style.visibility = ts ? "hidden" : "";
  if (ts && window.TimeShare && !tsMounted) { TimeShare.mount($("ts-host"), { fmtVol }); tsMounted = true; }
  if (!ts && tsMounted) { TimeShare.destroy(); tsMounted = false; }
}

/* ================= 布局: 左右栏拖动 / 折叠 ================= */
const LAY_KEY = "mw:layout";
const layout = { left: 250, right: 300, leftOn: true, rightOn: true };
try { Object.assign(layout, JSON.parse(localStorage.getItem(LAY_KEY) || "{}")); } catch (e) { /* 忽略 */ }
function applyLayout() {
  const L = $("wall-col"), R = $("right");
  if (L) {
    L.style.flexBasis = layout.leftOn ? layout.left + "px" : "0px";
    L.classList.toggle("collapsed", !layout.leftOn);
  }
  if (R) {
    R.style.flexBasis = layout.rightOn ? layout.right + "px" : "0px";
    R.classList.toggle("collapsed", !layout.rightOn);
  }
  $("split-l").classList.toggle("folded", !layout.leftOn);
  $("split-r").classList.toggle("folded", !layout.rightOn);
  try { localStorage.setItem(LAY_KEY, JSON.stringify(layout)); } catch (e) { /* 忽略 */ }
  requestAnimationFrame(() => { resizeCanvas(); redraw(); });
}
function initSplitter(id, side) {
  const el = $(id);
  if (!el) return;
  let dragging = false, moved = false;
  el.addEventListener("mousedown", (e) => {
    dragging = true; moved = false;
    e.preventDefault();
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    moved = true;
    const w = side === "left" ? e.clientX : innerWidth - e.clientX;
    const v = Math.max(150, Math.min(560, w));
    if (side === "left") { layout.left = v; layout.leftOn = true; }
    else { layout.right = v; layout.rightOn = true; }
    applyLayout();
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = false; document.body.style.cursor = ""; }
  });
  el.addEventListener("dblclick", () => {
    if (moved) { moved = false; return; }
    if (side === "left") layout.leftOn = !layout.leftOn;
    else layout.rightOn = !layout.rightOn;
    applyLayout();
  });
}

/* 右栏分区折叠(状态记忆) */
const RP_KEY = "mw:rpanes";
let rpState = {};
try { rpState = JSON.parse(localStorage.getItem(RP_KEY) || "{}"); } catch (e) { rpState = {}; }
function initRightPanes() {
  document.querySelectorAll("#right .rp").forEach((sec) => {
    const id = sec.dataset.rp;
    if (rpState[id] === false) sec.classList.add("fold");
    sec.querySelector(".rp-h").addEventListener("click", () => {
      sec.classList.toggle("fold");
      rpState[id] = !sec.classList.contains("fold");
      try { localStorage.setItem(RP_KEY, JSON.stringify(rpState)); } catch (e) { /* 忽略 */ }
    });
  });
}

/* ================= 高频指标 + 实时波动率 ================= */
const HF_ROWS = [
  ["order_imb", "盘口委比", (v) => pctBar(v)],
  ["aggr_ratio", "主动买占比", (v) => pctBar(v * 2 - 1, (v * 100).toFixed(1) + "%")],
  ["ofi_rate", "订单流失衡/秒", (v) => signed(v, 1)],
  ["tick_mom", "微观动量", (v) => pctBar(v)],
  ["trade_per_sec", "成交笔/秒", (v) => v.toFixed(2)],
  ["vol_per_sec", "成交量/秒", (v) => fmtVol(Math.round(v))],
  ["avg_trade_size", "平均现手", (v) => v.toFixed(1)],
  ["large_ratio", "大单占比", (v) => (v * 100).toFixed(1) + "%"],
  ["open_ratio", "开仓占比", (v) => (v * 100).toFixed(1) + "%"],
  ["doi_per_sec", "持仓变化/秒", (v) => signed(v, 2)],
  ["spread_bp", "平均价差", (v) => v.toFixed(2) + " bp"],
  ["px_vs_vwap_bp", "现价-VWAP", (v) => signed(v, 1) + " bp"],
  ["kyle_lambda", "冲击系数λ", (v) => v.toFixed(4)],
];
function signed(v, d) { return (v > 0 ? "+" : "") + v.toFixed(d); }
function pctBar(v, label) {
  const p = Math.max(-1, Math.min(1, v));
  const cls = p > 0.02 ? "up" : p < -0.02 ? "down" : "flat";
  const w = Math.abs(p) * 50;
  const left = p >= 0 ? 50 : 50 - w;
  return `<span class="hf-bar"><i style="left:${left}%;width:${w}%;background:var(--${p >= 0 ? "up" : "down"})"></i></span>` +
    `<b class="${cls}">${label || p.toFixed(3)}</b>`;
}
function renderHF(hf) {
  const g = $("hf-grid");
  if (!g) return;
  const m = hf && hf.m;
  if (!m) { g.innerHTML = '<div class="note">等待逐笔数据…</div>'; return; }
  g.innerHTML = HF_ROWS.map(([k, label, fmtf]) => {
    const v = m[k];
    const body = (v == null || !isFinite(v)) ? '<b class="flat">—</b>' : fmtf(v);
    return `<div class="hf-row"><span>${label}</span>${body}</div>`;
  }).join("") +
    `<div class="hf-foot">窗口 ${m.window_sec != null ? m.window_sec.toFixed(0) : "—"}s · ` +
    `${m.n_trades != null ? m.n_trades : "—"} 笔 · 主买 ${fmtVol(m.aggr_buy)} / 主卖 ${fmtVol(m.aggr_sell)}</div>`;
  renderVolTable(hf.rv);
}
const VOL_LABEL = { 30: "30秒", 60: "1分钟", 300: "5分钟", 900: "15分钟", 1800: "30分钟", 3600: "1小时" };
function renderVolTable(rv) {
  const box = $("vol-table");
  if (!box) return;
  if (!rv || !Object.keys(rv).length) { box.innerHTML = '<div class="note">等待逐笔数据…</div>'; return; }
  const ks = Object.keys(rv).map(Number).sort((a, b) => a - b);
  const vals = ks.map((k) => rv[k] && rv[k].ann).filter((v) => v != null);
  const mx = vals.length ? Math.max(...vals) : 1;
  box.innerHTML = ks.map((k) => {
    const d = rv[k] || {};
    const a = d.ann;
    const w = a != null && mx > 0 ? Math.max(2, (a / mx) * 100) : 0;
    return `<div class="vt-row"><span class="vt-l">${VOL_LABEL[k] || k + "s"}</span>` +
      `<span class="vt-bar"><i style="width:${w}%"></i></span>` +
      `<b>${a != null ? a.toFixed(2) + "%" : "—"}</b>` +
      `<em>${d.n || 0}</em></div>`;
  }).join("") + '<div class="hf-foot">已实现波动率 · 对数收益标准差年化(252日)</div>';
}

/* ================= 条件预警 ================= */
const ALERT_KEY = "mw:alerts";
let alerts = [];
try { alerts = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"); } catch (e) { alerts = []; }
function saveAlerts() { try { localStorage.setItem(ALERT_KEY, JSON.stringify(alerts)); } catch (e) { /* 配额满 */ } }

function checkAlerts(quotes) {
  const now = Date.now();
  for (const a of alerts) {
    if (a.done) continue;
    const q = quotes[a.symbol];
    if (!q) continue;
    const lp = q.last_price, base = baseline(q);
    let hit = false, desc = "";
    if (a.type === "gt" && lp != null && lp >= a.value) { hit = true; desc = `涨破 ${a.value}`; }
    else if (a.type === "lt" && lp != null && lp <= a.value) { hit = true; desc = `跌破 ${a.value}`; }
    else if (a.type === "pct" && lp != null && base) {
      const p = (lp - base) / base * 100;
      if (Math.abs(p) >= Math.abs(a.value)) { hit = true; desc = `涨跌幅 ${p.toFixed(2)}% 达到 ±${Math.abs(a.value)}%`; }
    }
    if (hit && now - (a.lastFire || 0) > 60000) {
      a.lastFire = now;
      if (a.once) a.done = true;
      saveAlerts();
      fireAlert(q.instrument_name || a.symbol, `${desc} — 现价 ${fmtAny(lp, a.symbol)}`);
      renderAlertList();
    }
  }
}
function fmtAny(v, sym) {
  const q = lastQuotes[sym] || {};
  const tk = q.price_tick;
  const d = tk ? Math.max(0, (String(tk).split(".")[1] || "").replace(/0+$/, "").length) : 2;
  return v == null ? "—" : v.toFixed(d);
}
function fireAlert(title, body) {
  const box = $("alert-toasts");
  if (box) {
    const t = document.createElement("div");
    t.className = "toast";
    t.innerHTML = `<b>${title}</b><span>${body}</span><i>✕</i>`;
    t.querySelector("i").onclick = () => t.remove();
    box.appendChild(t);
    setTimeout(() => t.remove(), 15000);
  }
  try {
    if (Notification && Notification.permission === "granted") new Notification("行情预警 · " + title, { body });
  } catch (e) { /* 浏览器不支持 */ }
}
function addAlert(symbol, type, value, once) {
  alerts.push({ id: "a" + Date.now(), symbol, type, value: +value, once: !!once, done: false });
  saveAlerts(); renderAlertList();
}
function renderAlertList() {
  const box = $("alert-list");
  if (!box) return;
  const TYPE = { gt: "涨破", lt: "跌破", pct: "涨跌幅达" };
  box.innerHTML = alerts.length ? "" : '<div class="al-empty">还没有预警</div>';
  for (const a of alerts) {
    const q = lastQuotes[a.symbol] || {};
    const d = document.createElement("div");
    d.className = "al-item" + (a.done ? " done" : "");
    d.innerHTML = `<span class="al-n">${q.instrument_name || a.symbol}</span>` +
      `<span class="al-c">${TYPE[a.type]} ${a.type === "pct" ? "±" + Math.abs(a.value) + "%" : a.value}</span>` +
      `<span class="al-s">${a.done ? "已触发" : "监控中"}</span><i>✕</i>`;
    d.querySelector("i").onclick = () => {
      alerts = alerts.filter((x) => x.id !== a.id); saveAlerts(); renderAlertList();
    };
    box.appendChild(d);
  }
}
function openAlertPanel() {
  const p = $("alert-panel");
  if (!p) return;
  p.classList.toggle("hidden");
  if (p.classList.contains("hidden")) return;
  const q = lastQuotes[selected] || {};
  $("al-sym").textContent = (q.instrument_name || selected || "—") + "  " + (q.last_price != null ? q.last_price : "");
  $("al-val").value = q.last_price != null ? q.last_price : "";
  renderAlertList();
  try { if (Notification && Notification.permission === "default") Notification.requestPermission(); } catch (e) { /* 忽略 */ }
}

/* ---- 视图注册表: 加新视图只需在这里加一项 ---- */
function gotoChart(sym) {
  showView("chart");
  if (!sym) return;
  if (watchlist.includes(sym)) selectSymbol(sym);
  else addSymbol(sym);          // 不在自选里就加进去再切
}
function mountStockBoard(tab) {
  if (!window.StockBoard) return;
  if (!StockBoard.isMounted())
    StockBoard.mount($("sboard-view"), {
      request,
      onPickStock: (ts) => { showView("stock"); showStock(toTsCode(ts), null); },
      onPickIndex: (ts, nm) => {
        const sym = tqCodeOf(ts);              // 000001.SH -> SSE.000001
        gotoChart(sym);
        setHistHint(`已切到 ${nm || sym}`, 2500);
      },
    });
  StockBoard.show(tab);
}

const BOARD_VIEWS = new Set(["board", "sector", "home"]);
// onHide 是在 curView 更新之前调用的, 用 curView 判断等于问"我要离开的这个视图
// 是不是看板视图" —— 永远为真, board 数据源打开就再也关不掉。必须看目标视图。
function boardOff(next) { if (!BOARD_VIEWS.has(next)) send({ action: "board", on: false }); }
/* 多图/自选看板离开时要交还 overlay 名额, 否则一路逛下来把 FOCUS_MAX 占满,
   后面订阅的都会被挤掉。主图和叠加对比在用的标的不能退。 */
function dropSubs(pairs) {
  for (const [sym] of pairs || []) {
    if (sym === selected || overlays.has(sym)) continue;
    send({ action: "unfocus", symbol: sym });
  }
}

const VIEWS = {
  home: {
    el: "home-wrap",
    onShow() {
      send({ action: "board", on: true });          // 首页的期货板块热力复用 board 数据源
      if (window.HomeView && !HomeView.isMounted())
        HomeView.mount($("home-view"), {
          request,
          onPick: (sym) => gotoChart(sym),
          onGoto: (v) => showView(v),
        });
      else if (window.HomeView) HomeView.refresh();
    },
    onHide: boardOff,
  },
  trade: {
    el: "trade-wrap",
    onShow() {
      send({ action: "acct_sub", on: true });
      send({ action: "strat_sub", on: true });
      if (window.TradeView && !TradeView.isMounted())
        TradeView.mount($("trade-view"), {
          request, fmtVol, fmtQ,
          onPick: (sym) => { showView("chart"); gotoChart(sym); },
        });
      if (window.TradeView) TradeView.update(lastAcct, lastStrat);
    },
    onHide(next) {
      if (next !== "trade") {
        send({ action: "acct_sub", on: false });
        send({ action: "strat_sub", on: false });
      }
    },
  },
  watch: {
    el: "watch-wrap",
    onShow() {
      if (!window.WatchBoard) return;
      if (!WatchBoard.isMounted())
        WatchBoard.mount($("watch-view"), {
          marketOf, baseline, fmtQ, fmtVol, isStock, request, toTsCode, tqCodeOf,
          stockName: (ts) => stockNames[ts],
          defaultStock: () => { try { return localStorage.getItem("mw:stock"); } catch (e) { return null; } },
          // 多图分区用 overlay 订阅, 不抢主图的 focus
          onSubscribe: (sym, dur) => send({ action: "subscribe", symbol: sym, duration: dur, overlay: true }),
          onResearch: (ts) => { showView("stock"); showStock(ts, null); },
          onPick: (sym) => gotoChart(sym),
          onMenu: (e, sym) => symbolMenu(e, sym, { inWall: true }),
          onRemove: (sym, gid) => send({ action: "watchlist_remove", symbol: sym, group: gid }),
          onCreate: (name) => send({ action: "group_create", name }),
          onRename: (gid, name) => send({ action: "group_rename", group: gid, name }),
          onDelete: (gid) => send({ action: "group_delete", group: gid }),
          onMove: (sym, from, to) => {
            send({ action: "watchlist_add", symbol: sym, group: to });
            send({ action: "watchlist_remove", symbol: sym, group: from });
          },
          // 加标的: 借用顶部全局搜索, 选中后落到指定分区
          onAdd: (gid) => {
            wallAddTarget = gid;
            $("search-input").focus();
            setHistHint("在上方搜索框选一个标的, 它会加入该分区", 6000);
          },
        });
      else WatchBoard.subs().forEach(([s2, d]) =>
        send({ action: "subscribe", symbol: s2, duration: d, overlay: true }));
      WatchBoard.setGroups(groups);
      WatchBoard.update(lastQuotes, selected, lastKlines);
    },
    onHide(next) {
      boardOff(next);
      if (window.WatchBoard && WatchBoard.isMounted()) dropSubs(WatchBoard.subs());
    },
  },
  chart: {
    el: "layout",
    onShow() { setWallFilter("fut", true); resizeCanvas(); redraw(); },
  },
  // 个股行情: 复用主图, 但进入时把标的切到最近看过的股票
  stkchart: {
    el: "layout",
    onShow(same) {
      setWallFilter("stk", true);
      resizeCanvas(); redraw();
      if (same) return;
      if (isStock(lastQuotes[selected])) return;      // 已经是股票就别乱切
      let last = null;
      try { last = localStorage.getItem("mw:stock"); } catch (e) { /* 隐私模式 */ }
      const sym = tqCodeOf(last || "600519.SH");
      if (watchlist.includes(sym)) selectSymbol(sym); else addSymbol(sym);
    },
  },
  board: {
    el: "board-wrap",
    onShow() {
      send({ action: "board", on: true });
      if (window.Board && !Board.isMounted()) {
        Board.mount($("board-view"), { fmtVol, onPick: gotoChart });
        // board.js 自身不暴露右键回调, 用事件委托挂在容器上(行带 data-sym)
        $("board-wrap").addEventListener("contextmenu", (e) => {
          const tr = e.target.closest("[data-sym]");
          if (tr && tr.dataset.sym) symbolMenu(e, tr.dataset.sym);
        });
      }
    },
    onHide: boardOff,
  },
  multi: {
    el: "multi-wrap",
    onShow() {
      if (!window.MultiView) return;
      if (!MultiView.isMounted()) {
        MultiView.mount($("multi-view"), {
          onPick: (sym) => gotoChart(sym),
          // 每格用 overlay 订阅, 不抢主图的 focus
          onSubscribe: (sym, dur) => send({ action: "subscribe", symbol: sym, duration: dur, overlay: true }),
          onDrop: (sym) => { if (sym !== selected && !overlays.has(sym)) send({ action: "unfocus", symbol: sym }); },
          onRequestSymbol: (cb) => {
            multiPick = cb;
            $("search-input").focus();
            setHistHint("在上方搜索框选一个标的, 它会填进选中的格子", 6000);
          },
        });
      } else MultiView.subs().forEach(([s, d]) =>
        send({ action: "subscribe", symbol: s, duration: d, overlay: true }));
    },
    onHide() { if (window.MultiView && MultiView.isMounted()) dropSubs(MultiView.subs()); },
  },
  // 板块 / 指数是同一个容器的两个内页, 挂载一次, 由二级页签决定进哪个 tab
  sindex: { el: "sboard-wrap", onShow() { mountStockBoard("index"); } },
  sboard: { el: "sboard-wrap", onShow() { mountStockBoard("sector"); } },
  sector: {
    el: "sector-wrap",
    onShow() {
      send({ action: "board", on: true });      // 分区看板复用 board 数据源
      if (window.SectorView && !SectorView.isMounted())
        SectorView.mount($("sector-view"), {
          fmtVol, onPick: gotoChart,
          onMenu: (e, sym) => symbolMenu(e, sym),
        });
    },
    onHide: boardOff,
  },
  option: {
    el: "option-wrap",
    onShow() {
      if (window.OptionView && !OptionView.isMounted())
        OptionView.mount($("option-view"), { request, fmtVol, onPickSymbol: gotoChart });
    },
  },
  stock: {
    el: "stock-wrap",
    onShow() {
      renderStockChips();
      if (!window.StockView) return;
      if (!StockView.isMounted()) StockView.mount($("stock-view"), { request, fmtVol });
      // 当前选中的常常是期货合约 —— 那样 show() 永远不会被调用, 面板就一直停在
      // 加载骨架。回退到上次看过的股票, 再回退到一只默认股。
      const q = lastQuotes[selected];
      if (isStock(q)) showStock(toTsCode(selected), q);
      else {
        let last = null;
        try { last = localStorage.getItem("mw:stock"); } catch (e) { /* 隐私模式 */ }
        showStock(last || "600519.SH", null);
      }
    },
  },
};
/* ---- 两级导航: 一级大类 -> 二级子页 ----
   同一个视图可以挂在多个大类下(比如"行情"期货和A股都用), 靠 view 名区分入口。 */
const NAV = [
  { grp: "home", label: "首页", subs: [["home", "市场总览"], ["watch", "自选"]] },
  { grp: "fut", label: "期货", subs: [["chart", "行情"], ["multi", "多图"],
                                      ["sector", "分区热力"], ["board", "主力合约"]] },
  { grp: "opt", label: "期权", subs: [["option", "T型报价"]] },
  { grp: "stk", label: "A股", subs: [["stkchart", "个股行情"], ["stock", "个股研究"],
                                     ["sboard", "板块"], ["sindex", "指数"]] },
  { grp: "trade", label: "交易", subs: [["trade", "交易"]] },
];
let curView = "chart", curGrp = "fut";
const GRP_LAST = { home: "home", fut: "chart", opt: "option", stk: "stkchart" };  // 每个大类各记各的子页

function viewEl(v) { return VIEWS[v] && VIEWS[v].el; }
function showView(v) {
  const cfg = VIEWS[v];
  if (!cfg) return;
  if (v !== curView) {
    const prev = VIEWS[curView];
    if (prev && prev.onHide) prev.onHide(v);
  }
  const wasSame = v === curView;
  curView = v;
  // 多个视图可能共用一个容器(个股行情复用主图, 指数复用板块页), 所以按容器去重
  const active = viewEl(v);
  const seen = new Set();
  for (const cfg2 of Object.values(VIEWS)) {
    if (seen.has(cfg2.el)) continue;
    seen.add(cfg2.el);
    const el = $(cfg2.el);
    if (el) el.classList.toggle("hidden", cfg2.el !== active);
  }
  const g = NAV.find((n) => n.subs.some(([k]) => k === v));
  if (g) { curGrp = g.grp; GRP_LAST[g.grp] = v; }
  renderNav();
  if (cfg.onShow) cfg.onShow(wasSame);
}
function renderNav() {
  document.querySelectorAll("#nav-top button")
    .forEach((b) => b.classList.toggle("on", b.dataset.grp === curGrp));
  const bar = $("nav-sub");
  const g = NAV.find((n) => n.grp === curGrp);
  bar.innerHTML = "";
  if (!g || g.subs.length <= 1) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  for (const [v, label] of g.subs) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.view = v;
    b.className = v === curView ? "on" : "";
    b.onclick = () => showView(v);
    bar.appendChild(b);
  }
}
$("nav-top").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const g = NAV.find((n) => n.grp === btn.dataset.grp);
  if (!g) return;
  curGrp = g.grp;
  // 切回某个大类时回到上次看的那个子页
  const last = GRP_LAST[g.grp];
  showView(g.subs.some(([k]) => k === last) ? last : g.subs[0][0]);
});
/* 切个股研究标的(记住上次看的) */
/* 名字缓存: 研究的股票多半不在自选里, 没有实时行情, 标题就只剩代码。
   把搜索/自选拿到的名字记下来复用。 */
let stockNames = {};
try { stockNames = JSON.parse(localStorage.getItem("mw:stocknames") || "{}"); } catch (e) { stockNames = {}; }
function showStock(tsCode, q, nameHint) {
  if (!window.StockView || !tsCode) return;
  try { localStorage.setItem("mw:stock", tsCode); } catch (e) { /* 隐私模式 */ }
  spPushRecent(tsCode);
  const live = q || lastQuotes[tqCodeOf(tsCode)] || null;
  const name = (live && live.instrument_name) || nameHint || stockNames[tsCode];
  if (name && name !== stockNames[tsCode]) {
    stockNames[tsCode] = name;
    try { localStorage.setItem("mw:stocknames", JSON.stringify(stockNames)); } catch (e) { /* 忽略 */ }
  }
  // 没订阅上的股票也至少要有名字, 否则头部只剩一串代码
  StockView.show(tsCode, live || (name ? { instrument_name: name } : null));
  renderStockChips();
}
/* Tushare 代码 -> TqSdk 代码: 600519.SH -> SSE.600519 */
function tqCodeOf(ts) {
  if (!ts || !ts.includes(".")) return ts;
  const [code, ex] = ts.split(".", 2);
  const map = { SH: "SSE", SZ: "SZSE", BJ: "BSE" };
  return map[ex] ? `${map[ex]}.${code}` : ts;
}

/* TqSdk 代码 -> Tushare 代码: SSE.600519 -> 600519.SH */
function toTsCode(sym) {
  if (!sym || !sym.includes(".")) return sym;
  const [ex, code] = sym.split(".", 2);
  const map = { SSE: "SH", SZSE: "SZ", BSE: "BJ" };
  return map[ex] ? `${code}.${map[ex]}` : sym;
}
/* ================= 指标参数设置面板 ================= */
const PARAM_DEFS = [
  { key: "ma", label: "均线 MA", hint: "最多 6 条, 逗号分隔", list: true, max: MA_MAX },
  { key: "mavol", label: "均量线 MAVOL", hint: "最多 3 条", list: true, max: MAVOL_MAX },
  { key: "boll", label: "BOLL", fields: ["周期", "倍数"] },
  { key: "macd", label: "MACD", fields: ["快线", "慢线", "信号"] },
  { key: "kdj", label: "KDJ", fields: ["N", "M1", "M2"] },
  { key: "rsi", label: "RSI", fields: ["短", "中", "长"] },
  { key: "cci", label: "CCI", fields: ["周期"] },
  { key: "kc", label: "波动率通道", fields: ["EMA", "ATR", "倍数"] },
];
function openParams(focusKey) {
  const p = $("param-panel");
  p.innerHTML = `<div class="rg-h">指标参数<i>✕</i></div>` +
    PARAM_DEFS.map((d) => {
      const cur = P[d.key];
      if (d.list) {
        return `<div class="pp-row"><label>${d.label}</label>` +
          `<input data-k="${d.key}" data-list="1" value="${cur.join(",")}" placeholder="${d.hint}"></div>`;
      }
      return `<div class="pp-row"><label>${d.label}</label><span class="pp-fs">` +
        d.fields.map((f, i) =>
          `<input data-k="${d.key}" data-i="${i}" type="number" step="any" value="${cur[i]}" title="${f}">`).join("") +
        `</span></div>`;
    }).join("") +
    `<div class="pp-act"><button id="pp-reset">恢复默认</button><button id="pp-ok">应用</button></div>`;
  p.classList.remove("hidden");
  p.querySelector("i").onclick = () => p.classList.add("hidden");
  $("pp-reset").onclick = () => { P = JSON.parse(JSON.stringify(P_DEFAULT)); saveParams(); openParams(); applyParams(); };
  $("pp-ok").onclick = () => {
    p.querySelectorAll("input").forEach((el) => {
      const k = el.dataset.k;
      if (el.dataset.list) {
        const v = el.value.split(/[,，\s]+/).map(Number).filter((x) => x >= 1 && x <= 1000)
          .slice(0, PARAM_DEFS.find((d) => d.key === k).max);
        if (v.length) P[k] = v;
      } else {
        const v = parseFloat(el.value);
        if (isFinite(v) && v > 0) P[k][+el.dataset.i] = v;
      }
    });
    saveParams();
    applyParams();
    p.classList.add("hidden");
  };
  if (focusKey) {
    const el = p.querySelector(`input[data-k="${focusKey}"]`);
    if (el) { el.focus(); el.select(); }
  }
}
function applyParams() {
  if (!lastRows.length) return;
  renderedKey = null;
  fullRender(lastRows, `${selected}|${duration}`);
}

/* 副图设置: 齿轮在副图右下角弹出, 不占顶部空间 */
const SUB_CHOICES = [["macd", "MACD"], ["kdj", "KDJ"], ["rsi", "RSI"], ["cci", "CCI"],
                     ["volq", "波动率·分位(状态)"], ["volr", "波动率·扩张收缩(方向)"],
                     ["vol", "波动率·绝对值"], ["oi", "持仓量"], ["none", "关闭本副图"]];
document.querySelectorAll(".sub-gear").forEach((g) => {
  g.addEventListener("click", (e) => {
    e.stopPropagation();
    const slot = +g.dataset.slot;
    const menu = $("sub-menu");
    menu.innerHTML = "";
    // 第二个副图关着时, 在第一个的菜单里给个"添加副图2"的入口
    const items = SUB_CHOICES.slice();
    if (slot === 0 && SUB_SLOTS[1].kind === "none")
      items.push(["+add2", "＋ 添加第二个副图"]);
    for (const [k, label] of items) {
      const d = document.createElement("div");
      d.className = "sm-item" + (SUB_SLOTS[slot].kind === k ? " on" : "");
      d.textContent = label;
      d.onclick = () => {
        menu.classList.add("hidden");
        if (k === "+add2") { setSubKind(1, "kdj"); return; }
        setSubKind(slot, k);
      };
      menu.appendChild(d);
    }
    // 波动率副图: 追加窗口选择
    if (SUB_SLOTS[slot].kind.startsWith("vol")) {
      menu.appendChild(Object.assign(document.createElement("div"), { className: "sm-sep" }));
      for (const w of RV_WINDOWS) {
        const d = document.createElement("div");
        d.className = "sm-item" + (rvWin === w.key ? " on" : "");
        d.textContent = "窗口 " + w.label;
        d.onclick = () => {
          menu.classList.add("hidden");
          rvWin = w.key;
          try { localStorage.setItem("mw:rvwin", w.key); } catch (e) { /* 忽略 */ }
          applyParams();
        };
        menu.appendChild(d);
      }
    }
    if (SUB_SLOTS[slot].kind.startsWith("vol")) {
      menu.appendChild(Object.assign(document.createElement("div"), { className: "sm-sep" }));
      for (const [k2, lbl] of Object.entries(VOL_EST_LABEL)) {
        const d = document.createElement("div");
        d.className = "sm-item" + (volEst === k2 ? " on" : "");
        d.textContent = "估计量 " + lbl;
        d.onclick = () => {
          menu.classList.add("hidden");
          volEst = k2;
          try { localStorage.setItem("mw:volest", k2); } catch (e) { /* 忽略 */ }
          applyParams();
        };
        menu.appendChild(d);
      }
    }
    menu.appendChild(Object.assign(document.createElement("div"), { className: "sm-sep" }));
    const ps = document.createElement("div");
    ps.className = "sm-item";
    ps.textContent = "⚙ 指标参数设置…";
    ps.onclick = () => { menu.classList.add("hidden"); openParams(SUB_SLOTS[slot].kind); };
    menu.appendChild(ps);
    menu.classList.remove("hidden");
    const r = g.getBoundingClientRect(), mr = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(r.right - mr.width, innerWidth - mr.width - 6)) + "px";
    menu.style.top = Math.max(6, r.top - mr.height - 4) + "px";
  });
});
document.addEventListener("click", () => $("sub-menu").classList.add("hidden"));
function setSubKind(slot, kind) {
  SUB_SLOTS[slot].kind = kind;
  if (!ind.macd && kind !== "none") {
    ind.macd = true;
    saveInd();
    document.querySelector('#indicators button[data-ind="macd"]').classList.add("on");
  }
  saveSubSlots();
  syncSubVisibility();
  if (lastRows.length) {
    const times = lastRows.map((r) => r.t + TZ_SHIFT);
    renderSubChart(lastRows, times, lastRows.map((r) => r.c));
  }
}
function saveSubSlots() {
  try { localStorage.setItem("mw:subs", JSON.stringify(SUB_SLOTS.map((s) => s.kind))); } catch (e) { /* 忽略 */ }
}
function loadSubSlots() {
  try {
    const v = JSON.parse(localStorage.getItem("mw:subs") || "null");
    if (Array.isArray(v)) v.forEach((k, i) => { if (SUB_SLOTS[i] && k) SUB_SLOTS[i].kind = k; });
  } catch (e) { /* 忽略 */ }
}
function syncSubVisibility() {
  SUB_SLOTS.forEach((slot, i) => {
    const w = $(slot.wrap);
    if (w) w.classList.toggle("hidden", slot.kind === "none" || !ind.macd);
  });
  // 刚打开的副图还停在自己的旧区间(通常是个巨大的空区间), 主动把主图的推给它。
  // 副图是在 display:none 下创建的, 画布宽度为 0, 此时设区间不生效 ——
  // 所以要在它完成 resize 之后再推一次。
  pushRangeToSubs();
  setTimeout(pushRangeToSubs, 60);
  setTimeout(pushRangeToSubs, 250);
}
function pushRangeToSubs() {
  requestAnimationFrame(() => {
    const r = chart && chart.timeScale().getVisibleLogicalRange();
    if (!r || !lastRows.length) return;
    syncing = true;
    for (const p of subPanes) {
      try { p.chart.timeScale().setVisibleLogicalRange(r); } catch (e) { /* 尚无数据 */ }
    }
    syncing = false;
  });
}
$("alert-btn").addEventListener("click", openAlertPanel);
$("param-btn").addEventListener("click", () => openParams());
$("al-close").addEventListener("click", () => $("alert-panel").classList.add("hidden"));
$("al-add").addEventListener("click", () => {
  const v = parseFloat($("al-val").value);
  if (!selected || !isFinite(v)) return;
  addAlert(selected, $("al-type").value, v, $("al-once").checked);
});
$("indicators").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const key = btn.dataset.ind;
  ind[key] = !ind[key];
  saveInd();
  btn.classList.toggle("on", ind[key]);
  if (key === "ma") { maS.forEach((s) => s.applyOptions({ visible: ind.ma })); if (!ind.ma) $("ma-legend").innerHTML = ""; }
  if (key === "boll") Object.values(bollS).forEach((s) => s.applyOptions({ visible: ind.boll }));
  if (key === "kc") Object.values(kcS).forEach((s) => s.applyOptions({ visible: ind.kc }));
  if (key === "vol") volS.applyOptions({ visible: ind.vol });
  if (key === "macd") syncSubVisibility();
  if (lastRows.length) { renderedKey = null; fullRender(lastRows, `${selected}|${duration}`); }
});

/* ================= 框选区间统计 =================
   与后端 hfcalc.cpp 的 hf_range_stats 同口径, 但在前端直接算:
   框选是高频交互, 走一次 WS 往返(几百 ms ~ 几秒)体验太差。 */
function localRangeStats(bars, barSec, dailySec) {
  const n = bars.length;
  if (n < 2) return null;
  let hi = -Infinity, lo = Infinity, vsum = 0, pv = 0, up = 0, dn = 0;
  for (const b of bars) {
    if (b.h != null && b.h > hi) hi = b.h;
    if (b.l != null && b.l < lo) lo = b.l;
    const v = b.v || 0;
    vsum += v;
    if (b.h != null && b.l != null && b.c != null) pv += ((b.h + b.l + b.c) / 3) * v;
    if (b.c != null && b.o != null) { if (b.c > b.o) up++; else if (b.c < b.o) dn++; }
  }
  const open = bars[0].o, close = bars[n - 1].c;
  const r = [];
  for (let i = 1; i < n; i++)
    if (bars[i].c > 0 && bars[i - 1].c > 0) r.push(Math.log(bars[i].c / bars[i - 1].c));
  let sd = null, skew = null, kurt = null, upv = null, dnv = null;
  if (r.length >= 2) {
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    let m2 = 0, m3 = 0, m4 = 0, us = 0, ds = 0, un = 0, dnn = 0;
    for (const x of r) {
      const d = x - mean;
      m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
      if (x < 0) { ds += x * x; dnn++; } else { us += x * x; un++; }
    }
    const varr = m2 / r.length;
    sd = Math.sqrt(varr);
    if (sd > 1e-12) { skew = (m3 / r.length) / (sd ** 3); kurt = (m4 / r.length) / (varr * varr) - 3; }
    upv = un ? Math.sqrt(us / un) * 100 : null;
    dnv = dnn ? Math.sqrt(ds / dnn) * 100 : null;
  }
  let peak = bars[0].c, trough = bars[0].c, mdd = 0, mru = 0;
  for (const b of bars) {
    if (b.c == null) continue;
    if (b.c > peak) peak = b.c;
    if (b.c < trough) trough = b.c;
    if (peak > 0) mdd = Math.min(mdd, (b.c - peak) / peak);
    if (trough > 0) mru = Math.max(mru, (b.c - trough) / trough);
  }
  return {
    open, close, high: isFinite(hi) ? hi : null, low: isFinite(lo) ? lo : null,
    chg: close - open, chg_pct: open ? (close - open) / open * 100 : null,
    amp_pct: (open && isFinite(hi) && isFinite(lo)) ? (hi - lo) / open * 100 : null,
    volume: vsum, vwap: vsum > 0 ? pv / vsum : null,
    doi: (bars[n - 1].oi != null && bars[0].oi != null) ? bars[n - 1].oi - bars[0].oi : null,
    up_bars: up, dn_bars: dn,
    vol_sd: sd != null ? sd * 100 : null,
    vol_ann: sd != null ? sd * Math.sqrt(252 * (dailySec || 5.5 * 3600) / (barSec || 60)) * 100 : null,
    max_dd: mdd * 100, max_run: mru * 100, skew, kurt, up_vol: upv, dn_vol: dnv, bars: n,
  };
}
async function rangeStatsFor(t0, t1, title) {
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const bars = lastRows.filter((r) => r.t >= a && r.t <= b);
  const panel = $("range-panel");
  if (bars.length < 2) {
    panel.innerHTML = '<div class="rg-h">框选统计<i>✕</i></div><div class="note">选中的区间不足 2 根 K 线</div>';
    panel.classList.remove("hidden");
    panel.querySelector("i").onclick = () => panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  try {
    // 本地直接算 —— 之前走 WebSocket 到后端 C++ 再回来, 一次往返几百毫秒到几秒,
    // 框选是高频交互操作, 必须即时出结果。几百根 K 线在 JS 里是微秒级。
    const t0 = performance.now();
    const s = localRangeStats(bars, dataDuration(), dailySecOf(lastQuotes[selected]));
    const res = { engine: `本地 ${(performance.now() - t0).toFixed(1)}ms` };
    if (!s) throw new Error("数据不足");
    const d = priceDigits() != null ? priceDigits() : 2;
    const f = (v, dd) => (v == null ? "—" : (+v).toFixed(dd != null ? dd : d));
    const sp = (v, dd, unit) => v == null ? '<b class="flat">—</b>'
      : `<b class="${v > 0 ? "up" : v < 0 ? "down" : "flat"}">${v > 0 ? "+" : ""}${(+v).toFixed(dd)}${unit || ""}</b>`;
    const t = (x) => new Date((x + TZ_SHIFT) * 1000).toISOString().replace("T", " ").slice(5, 16);
    panel.innerHTML =
      `<div class="rg-h">框选统计 <span>${title || ""}</span><i>✕</i></div>` +
      `<div class="rg-sub">${t(bars[0].t)} → ${t(bars[bars.length - 1].t)} · ${s.bars} 根 · 引擎 ${res.engine || "—"}</div>` +
      `<div class="rg-grid">` +
      `<div><span>区间涨跌</span>${sp(s.chg, d)}</div>` +
      `<div><span>涨跌幅</span>${sp(s.chg_pct, 2, "%")}</div>` +
      `<div><span>开盘</span><b>${f(s.open)}</b></div>` +
      `<div><span>收盘</span><b>${f(s.close)}</b></div>` +
      `<div><span>最高</span><b class="up">${f(s.high)}</b></div>` +
      `<div><span>最低</span><b class="down">${f(s.low)}</b></div>` +
      `<div><span>振幅</span><b>${f(s.amp_pct, 2)}%</b></div>` +
      `<div><span>VWAP</span><b>${f(s.vwap)}</b></div>` +
      `<div><span>成交量</span><b>${fmtVol(s.volume)}</b></div>` +
      `<div><span>持仓变化</span>${sp(s.doi, 0)}</div>` +
      `<div><span>阳线/阴线</span><b><span class="up">${s.up_bars}</span> / <span class="down">${s.dn_bars}</span></b></div>` +
      `<div><span>年化波动率</span><b>${f(s.vol_ann, 2)}%</b></div>` +
      `<div><span>最大回撤</span>${sp(s.max_dd, 2, "%")}</div>` +
      `<div><span>最大涨幅</span>${sp(s.max_run, 2, "%")}</div>` +
      `<div><span>上行/下行波动</span><b>${f(s.up_vol, 3)} / ${f(s.dn_vol, 3)}</b></div>` +
      `<div><span>偏度/峰度</span><b>${f(s.skew, 2)} / ${f(s.kurt, 2)}</b></div>` +
      `</div>`;
    panel.querySelector("i").onclick = () => panel.classList.add("hidden");
  } catch (e) {
    panel.innerHTML = `<div class="rg-h">框选统计<i>✕</i></div><div class="note">失败: ${e.message}</div>`;
    panel.querySelector("i").onclick = () => panel.classList.add("hidden");
  }
}
/* 图上右键: 命中矩形则统计该矩形覆盖的区间, 否则给通用菜单 */
$("chart-stack").addEventListener("contextmenu", (e) => {
  if (isTimeShare()) return;
  const { x, y } = localXY(e);
  const hit = hitTest(x, y);
  const s = hit >= 0 ? shapes[hit] : null;
  e.preventDefault();
  const items = [];
  if (s && s.type === "rect" && s.a && s.b) {
    items.push({ label: "统计框选区间", act: () => rangeStatsFor(s.a.t, s.b.t, "矩形") });
    items.push({ label: "删除该矩形", danger: true, act: () => {
      shapes.splice(hit, 1); selectedShape = -1; saveDrawings(); redraw();
    } });
    items.push({ sep: true });
  }
  const vr = chart.timeScale().getVisibleLogicalRange();
  if (vr && lastRows.length) {
    const i0 = Math.max(0, Math.floor(vr.from)), i1 = Math.min(lastRows.length - 1, Math.ceil(vr.to));
    if (i1 > i0) items.push({
      label: "统计当前可见区间",
      act: () => rangeStatsFor(lastRows[i0].t, lastRows[i1].t, "可见区间"),
    });
  }
  items.push({ label: "画矩形框选…", act: () => setTool("rect") });
  showMenu(e.clientX, e.clientY, items);
});

initCharts();
// 按钮的 on 态是写死在 HTML 里的, 要跟恢复出来的 ind 对齐
document.querySelectorAll("#indicators button[data-ind]").forEach((b) => {
  if (b.dataset.ind in ind) b.classList.toggle("on", ind[b.dataset.ind]);
});
renderNav();
initStockPick();
loadSubSlots();
syncSubVisibility();
initSplitter("split-l", "left");
initSplitter("split-r", "right");
initRightPanes();
applyLayout();
resizeCanvas();
connect();
