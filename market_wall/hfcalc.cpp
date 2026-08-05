// 高频指标 / 多周期已实现波动率 / 区间统计 —— C++ 计算核心
//
// 为什么用 C++: 这些量要在每个 tick(500ms) 上对几百到几千笔快照做全量重算,
// 还要同时算 6 个时间尺度的已实现波动率。Python 里做这件事会跟采集线程抢 GIL,
// 直接拖慢行情推送。编译成 dylib 用 ctypes 调, 零第三方依赖。
//
// 编译(hf_native.py 会自动做):
//   clang++ -O3 -ffast-math -std=c++17 -dynamiclib -o libhfcalc.dylib hfcalc.cpp
//
// 约定: 所有接口都是 C 链接、只收 double 数组和长度、把结果写进调用方给的
// out 缓冲区, 返回写入的元素个数(负数=出错)。不分配、不抛异常、不持有状态。

#include <cmath>
#include <cstring>
#include <algorithm>
#include <vector>

#define API extern "C" __attribute__((visibility("default")))

namespace {

inline bool ok(double v) { return std::isfinite(v); }

// 线性插值分位数(输入必须已排序)
double quantile(const std::vector<double>& v, double q) {
    if (v.empty()) return NAN;
    if (v.size() == 1) return v[0];
    double pos = q * (v.size() - 1);
    size_t i = (size_t)pos;
    double f = pos - i;
    if (i + 1 >= v.size()) return v.back();
    return v[i] * (1.0 - f) + v[i + 1] * f;
}

}  // namespace

API int hf_version() { return 3; }

// ---------------------------------------------------------------- 高频指标
//
// 输入 n 笔 tick 快照(按时间升序):
//   ts   毫秒时间戳
//   px   最新价
//   vol  当日累计成交量
//   oi   持仓量快照
//   b1/a1/bv/av  买一价/卖一价/买一量/卖一量
//
// 输出 out[0..HF_N-1]:
//   0  order_imb       盘口委比 (bv-av)/(bv+av), 最后一笔
//   1  order_imb_avg   盘口委比均值(全窗口)
//   2  ofi             订单流失衡累计 (Cont/Kukanov 口径)
//   3  ofi_rate        OFI / 窗口秒数
//   4  aggr_buy        主动买成交量
//   5  aggr_sell       主动卖成交量
//   6  aggr_ratio      主动买占比 buy/(buy+sell)
//   7  trade_per_sec   有成交的快照数 / 秒
//   8  vol_per_sec     成交量 / 秒
//   9  avg_trade_size  平均每笔现手
//   10 large_ratio     大单成交量占比(现手 >= 90分位)
//   11 tick_mom        微观动量: 净价格变动 / 总绝对变动
//   12 spread_avg      平均价差(绝对)
//   13 spread_bp       平均价差(基点)
//   14 doi_sum         持仓净变化
//   15 doi_per_sec     持仓变化速率
//   16 open_ratio      开仓型成交占比(|doi| 与 dvol 同号且增仓)
//   17 vwap            窗口 VWAP(用 tick 价×现手 近似)
//   18 px_vs_vwap_bp   现价相对 VWAP 偏离(基点)
//   19 kyle_lambda     价格冲击系数: 回归 |dP| 对 sqrt(dV) 的斜率
//   20 window_sec      窗口时长(秒)
//   21 n_trades        有成交的快照数
#define HF_N 22

API int hf_metrics(int n,
                   const double* ts, const double* px, const double* vol, const double* oi,
                   const double* b1, const double* a1, const double* bv, const double* av,
                   double* out, int out_len) {
    if (out_len < HF_N) return -1;
    for (int i = 0; i < HF_N; ++i) out[i] = NAN;
    if (n < 2 || !ts || !px || !vol) return -2;

    double imb_last = NAN, imb_sum = 0; int imb_cnt = 0;
    double ofi = 0;
    double aggr_buy = 0, aggr_sell = 0;
    double dvol_sum = 0, doi_sum = 0;
    int n_trades = 0;
    double spread_sum = 0, spread_bp_sum = 0; int spread_cnt = 0;
    double px_move_net = 0, px_move_abs = 0;
    double pv_sum = 0;                       // Σ price*dvol, 求 VWAP
    double open_vol = 0;                     // 增仓成交量
    std::vector<double> sizes; sizes.reserve(n);
    // Kyle lambda 的最小二乘累加量
    double sx = 0, sy = 0, sxx = 0, sxy = 0; int reg_n = 0;

    for (int i = 1; i < n; ++i) {
        double dvol = vol[i] - vol[i - 1];
        if (!ok(dvol) || dvol < 0) continue;   // 跨交易日重置, 丢弃该笔
        double doi = (oi && ok(oi[i]) && ok(oi[i - 1])) ? oi[i] - oi[i - 1] : 0.0;
        // 每手成交最多改变 1 手持仓, 越界的是交易所修正
        if (doi > dvol) doi = dvol;
        if (doi < -dvol) doi = -dvol;

        // ---- 盘口委比 ----
        if (bv && av && ok(bv[i]) && ok(av[i]) && (bv[i] + av[i]) > 0) {
            double im = (bv[i] - av[i]) / (bv[i] + av[i]);
            imb_last = im; imb_sum += im; ++imb_cnt;
        }
        // ---- 订单流失衡 OFI: 买卖盘价格/数量变化的净贡献 ----
        if (b1 && a1 && bv && av && ok(b1[i]) && ok(b1[i - 1]) && ok(a1[i]) && ok(a1[i - 1])) {
            double e = 0;
            if (b1[i] > b1[i - 1]) e += bv[i];
            else if (b1[i] == b1[i - 1]) e += (bv[i] - bv[i - 1]);
            else e -= bv[i - 1];
            if (a1[i] < a1[i - 1]) e -= av[i];
            else if (a1[i] == a1[i - 1]) e -= (av[i] - av[i - 1]);
            else e += av[i - 1];
            if (ok(e)) ofi += e;
        }
        // ---- 价差 ----
        if (b1 && a1 && ok(b1[i]) && ok(a1[i]) && a1[i] > b1[i] && px[i] > 0) {
            double sp = a1[i] - b1[i];
            spread_sum += sp;
            spread_bp_sum += sp / px[i] * 10000.0;
            ++spread_cnt;
        }
        // ---- 价格动量 ----
        double dpx = px[i] - px[i - 1];
        if (ok(dpx)) { px_move_net += dpx; px_move_abs += std::fabs(dpx); }

        if (dvol <= 0) continue;               // 以下只统计真正有成交的快照
        ++n_trades;
        dvol_sum += dvol;
        doi_sum += doi;
        sizes.push_back(dvol);
        if (ok(px[i])) pv_sum += px[i] * dvol;

        // ---- 主动买卖: 用上一笔快照的盘口判定(成交发生在两快照之间) ----
        int side = 0;                          // +1 主买 / -1 主卖
        if (b1 && a1 && ok(b1[i - 1]) && ok(a1[i - 1]) && a1[i - 1] > b1[i - 1]) {
            if (px[i] >= a1[i - 1]) side = 1;
            else if (px[i] <= b1[i - 1]) side = -1;
            else {
                double mid = 0.5 * (a1[i - 1] + b1[i - 1]);
                side = px[i] > mid ? 1 : (px[i] < mid ? -1 : 0);
            }
        }
        if (side == 0) side = dpx > 0 ? 1 : (dpx < 0 ? -1 : 0);   // 回退 tick rule
        if (side > 0) aggr_buy += dvol; else if (side < 0) aggr_sell += dvol;

        if (doi > 0) open_vol += doi;          // 增仓部分

        // ---- Kyle lambda: |dP| = λ·sqrt(dV) ----
        if (ok(dpx)) {
            double x = std::sqrt(dvol), y = std::fabs(dpx);
            sx += x; sy += y; sxx += x * x; sxy += x * y; ++reg_n;
        }
    }

    double win_sec = (ts[n - 1] - ts[0]) / 1000.0;
    if (!(win_sec > 0)) win_sec = NAN;

    out[0] = imb_last;
    out[1] = imb_cnt ? imb_sum / imb_cnt : NAN;
    out[2] = ofi;
    out[3] = ok(win_sec) ? ofi / win_sec : NAN;
    out[4] = aggr_buy;
    out[5] = aggr_sell;
    out[6] = (aggr_buy + aggr_sell) > 0 ? aggr_buy / (aggr_buy + aggr_sell) : NAN;
    out[7] = ok(win_sec) ? n_trades / win_sec : NAN;
    out[8] = ok(win_sec) ? dvol_sum / win_sec : NAN;
    out[9] = n_trades ? dvol_sum / n_trades : NAN;

    if (!sizes.empty()) {
        std::vector<double> s = sizes;
        std::sort(s.begin(), s.end());
        double thr = quantile(s, 0.90);
        double big = 0;
        for (double v : sizes) if (v >= thr) big += v;
        out[10] = dvol_sum > 0 ? big / dvol_sum : NAN;
    }
    out[11] = px_move_abs > 0 ? px_move_net / px_move_abs : NAN;
    out[12] = spread_cnt ? spread_sum / spread_cnt : NAN;
    out[13] = spread_cnt ? spread_bp_sum / spread_cnt : NAN;
    out[14] = doi_sum;
    out[15] = ok(win_sec) ? doi_sum / win_sec : NAN;
    out[16] = dvol_sum > 0 ? open_vol / dvol_sum : NAN;
    double vwap = dvol_sum > 0 ? pv_sum / dvol_sum : NAN;
    out[17] = vwap;
    out[18] = (ok(vwap) && vwap > 0 && ok(px[n - 1])) ? (px[n - 1] - vwap) / vwap * 10000.0 : NAN;
    if (reg_n >= 3) {
        double den = reg_n * sxx - sx * sx;
        out[19] = std::fabs(den) > 1e-12 ? (reg_n * sxy - sx * sy) / den : NAN;
    }
    out[20] = win_sec;
    out[21] = n_trades;
    return HF_N;
}

// ------------------------------------------------- 多周期已实现波动率
//
// 对每个时间尺度 h(秒): 把 [t_end-lookback, t_end] 的价格按 h 重采样,
// 求对数收益的标准差, 再年化(按 252 交易日 × 每日 daily_sec 秒)。
//
// 输入: ts(毫秒) px  horizons(秒数组, hn 个)  lookback_mult(每个尺度取多少个 bar)
//       daily_sec 每个交易日的秒数(商品期货约 5.5*3600 + 夜盘)
// 输出: 每个尺度 3 个数 [年化波动率, 该尺度收益标准差, 有效样本数]
API int hf_realized_vol(int n, const double* ts, const double* px,
                        const double* horizons, int hn,
                        int lookback_mult, double daily_sec,
                        double* out, int out_len) {
    if (out_len < hn * 3) return -1;
    for (int i = 0; i < hn * 3; ++i) out[i] = NAN;
    if (n < 3 || !ts || !px) return -2;
    if (!(daily_sec > 0)) daily_sec = 5.5 * 3600.0;
    if (lookback_mult < 8) lookback_mult = 8;

    const double t_end = ts[n - 1];
    for (int k = 0; k < hn; ++k) {
        double h = horizons[k];
        if (!(h > 0)) continue;
        double h_ms = h * 1000.0;
        double t_start = t_end - h_ms * lookback_mult;

        // 按 h 网格重采样: 每格取该格内最后一个价
        std::vector<double> grid;
        grid.reserve(lookback_mult + 2);
        long long cur_bucket = -1;
        double cur_px = NAN;
        for (int i = 0; i < n; ++i) {
            if (ts[i] < t_start || !ok(px[i]) || px[i] <= 0) continue;
            long long b = (long long)std::floor((ts[i] - t_start) / h_ms);
            if (b != cur_bucket) {
                if (cur_bucket >= 0 && ok(cur_px)) grid.push_back(cur_px);
                cur_bucket = b;
            }
            cur_px = px[i];
        }
        if (ok(cur_px)) grid.push_back(cur_px);
        if (grid.size() < 3) continue;

        // 对数收益的标准差(样本方差, 不去均值 —— 高频下均值≈0 且去均值会低估)
        double s2 = 0; int m = 0;
        for (size_t i = 1; i < grid.size(); ++i) {
            if (grid[i] <= 0 || grid[i - 1] <= 0) continue;
            double r = std::log(grid[i] / grid[i - 1]);
            if (!ok(r)) continue;
            s2 += r * r; ++m;
        }
        if (m < 2) continue;
        double sd = std::sqrt(s2 / m);
        double per_year = 252.0 * daily_sec / h;      // 一年有多少个这样的 bar
        out[k * 3 + 0] = sd * std::sqrt(per_year);    // 年化
        out[k * 3 + 1] = sd;                          // 该尺度单期标准差
        out[k * 3 + 2] = m;
    }
    return hn * 3;
}

// ------------------------------------------------------------- 区间统计
//
// 对 K 线区间 [0, n) 统计。输入 o/h/l/c/v/oi(可为空)。
// 输出:
//   0 开   1 收   2 最高  3 最低
//   4 涨跌  5 涨跌幅%  6 振幅%(最高最低相对开盘)
//   7 成交量合计  8 VWAP(用典型价加权)
//   9 持仓变化   10 阳线数  11 阴线数
//   12 已实现波动率(对数收益标准差, 未年化)
//   13 年化波动率(按 bar_sec 与 daily_sec 折算)
//   14 最大回撤%   15 最大涨幅%
//   16 收益偏度   17 收益峰度
//   18 上行波动   19 下行波动
//   20 bar 数
#define RS_N 21
API int hf_range_stats(int n, const double* o, const double* h, const double* l,
                       const double* c, const double* v, const double* oi,
                       double bar_sec, double daily_sec,
                       double* out, int out_len) {
    if (out_len < RS_N) return -1;
    for (int i = 0; i < RS_N; ++i) out[i] = NAN;
    if (n < 1 || !o || !h || !l || !c) return -2;
    if (!(daily_sec > 0)) daily_sec = 5.5 * 3600.0;

    double hi = -INFINITY, lo = INFINITY, vsum = 0, pv = 0;
    int up = 0, dn = 0;
    for (int i = 0; i < n; ++i) {
        if (ok(h[i])) hi = std::max(hi, h[i]);
        if (ok(l[i])) lo = std::min(lo, l[i]);
        double vol = (v && ok(v[i])) ? v[i] : 0.0;
        vsum += vol;
        if (ok(h[i]) && ok(l[i]) && ok(c[i])) pv += (h[i] + l[i] + c[i]) / 3.0 * vol;
        if (ok(c[i]) && ok(o[i])) { if (c[i] > o[i]) ++up; else if (c[i] < o[i]) ++dn; }
    }
    double open = o[0], close = c[n - 1];
    out[0] = open; out[1] = close;
    out[2] = std::isfinite(hi) ? hi : NAN;
    out[3] = std::isfinite(lo) ? lo : NAN;
    out[4] = close - open;
    out[5] = open != 0 ? (close - open) / open * 100.0 : NAN;
    out[6] = (open != 0 && std::isfinite(hi) && std::isfinite(lo)) ? (hi - lo) / open * 100.0 : NAN;
    out[7] = vsum;
    out[8] = vsum > 0 ? pv / vsum : NAN;
    out[9] = (oi && ok(oi[n - 1]) && ok(oi[0])) ? oi[n - 1] - oi[0] : NAN;
    out[10] = up; out[11] = dn;

    // 对数收益的各阶矩
    std::vector<double> r;
    r.reserve(n);
    for (int i = 1; i < n; ++i)
        if (c[i] > 0 && c[i - 1] > 0) {
            double x = std::log(c[i] / c[i - 1]);
            if (ok(x)) r.push_back(x);
        }
    if (r.size() >= 2) {
        double mean = 0; for (double x : r) mean += x; mean /= r.size();
        double m2 = 0, m3 = 0, m4 = 0, dsum = 0, usum = 0;
        int dn_n = 0, up_n = 0;
        for (double x : r) {
            double d = x - mean;
            m2 += d * d; m3 += d * d * d; m4 += d * d * d * d;
            if (x < 0) { dsum += x * x; ++dn_n; } else { usum += x * x; ++up_n; }
        }
        double var = m2 / r.size();
        double sd = std::sqrt(var);
        out[12] = sd;
        if (bar_sec > 0) out[13] = sd * std::sqrt(252.0 * daily_sec / bar_sec);
        if (sd > 1e-12) {
            out[16] = (m3 / r.size()) / (sd * sd * sd);
            out[17] = (m4 / r.size()) / (var * var) - 3.0;
        }
        out[18] = up_n ? std::sqrt(usum / up_n) : NAN;
        out[19] = dn_n ? std::sqrt(dsum / dn_n) : NAN;
    }
    // 最大回撤 / 最大涨幅(按收盘价路径)
    double peak = c[0], trough = c[0], mdd = 0, mru = 0;
    for (int i = 0; i < n; ++i) {
        if (!ok(c[i])) continue;
        if (c[i] > peak) peak = c[i];
        if (c[i] < trough) trough = c[i];
        if (peak > 0) mdd = std::min(mdd, (c[i] - peak) / peak);
        if (trough > 0) mru = std::max(mru, (c[i] - trough) / trough);
    }
    out[14] = mdd * 100.0;
    out[15] = mru * 100.0;
    out[20] = n;
    return RS_N;
}
