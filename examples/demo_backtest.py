"""TqSdk 回测示例：双均线策略（模拟资金，不动真钱）

用法: 把快期账户密码填入同目录 tq_auth.env 后运行
    .venv/bin/python demo_backtest.py

策略逻辑: 5 日均线在 20 日均线上方持多 1 手，下方空仓。
标的: DCE.m2501 豆粕具体合约（主连 KQ.m@DCE.m 是指数合约不能下单）。
下单方式: TargetPosTask 目标持仓任务——日线回测中新 K 线生成时刻在收盘后，
直接 insert_order 会因"不在可交易时间段内"被拒，TargetPosTask 会自动
在下一个可交易时刻把持仓调整到目标手数。
"""
from datetime import date

from tqsdk import TqApi, TqAuth, TqBacktest, TqSim, TargetPosTask, BacktestFinished
from tqsdk.tafunc import ma

from tq_auth import load_auth

USER, PASSWORD = load_auth()

SYMBOL = "DCE.m2501"
INIT_BALANCE = 100000

sim = TqSim(init_balance=INIT_BALANCE)
api = TqApi(
    account=sim,
    backtest=TqBacktest(start_dt=date(2024, 3, 1), end_dt=date(2024, 12, 15)),
    auth=TqAuth(USER, PASSWORD),
    web_gui="http://127.0.0.1:9878",  # 图形界面地址，供天勤面板/浏览器查看
)

klines = api.get_kline_serial(SYMBOL, duration_seconds=24 * 60 * 60, data_length=30)
position = api.get_position(SYMBOL)
target_pos = TargetPosTask(api, SYMBOL)

try:
    while True:
        api.wait_update()
        if api.is_changing(position, "pos_long"):
            print(f"持仓变化: 多头 {position.pos_long} 手, 均价 {position.open_price_long}")
        if not api.is_changing(klines.iloc[-1], "datetime"):
            continue  # 只在新 K 线生成时判断信号
        ma5 = ma(klines.close, 5)
        ma20 = ma(klines.close, 20)
        if ma5.iloc[-2] > ma20.iloc[-2]:
            target_pos.set_target_volume(1)
        elif ma5.iloc[-2] < ma20.iloc[-2]:
            target_pos.set_target_volume(0)
except BacktestFinished:
    account = api.get_account()
    print(
        f"回测结束  权益: {account.balance:.2f}  "
        f"收益率: {(account.balance / INIT_BALANCE - 1) * 100:+.2f}%"
    )
    print("图表: http://127.0.0.1:9878  (程序保持运行以便查看, 按 Ctrl+C 或停止按钮退出)")
    while True:
        api.wait_update()  # 保持 web_gui 页面可访问
