"""TqSdk 看行情示例：实时盘口 + K线图（带图形界面）

用法: .venv/bin/python demo_market.py
图表: http://127.0.0.1:9879  (和回测的 9878 端口错开, 可同时运行)
按 Ctrl+C 退出。
"""
from tqsdk import TqApi, TqAuth

from tq_auth import load_auth

USER, PASSWORD = load_auth()

api = TqApi(auth=TqAuth(USER, PASSWORD), web_gui="http://127.0.0.1:9879")

# ---- 1. 实时盘口: get_quote，返回一个会自动更新的对象 ----
cu = api.get_quote("KQ.m@SHFE.cu")   # 沪铜主连
rb = api.get_quote("SHFE.rb2601")    # 螺纹钢具体合约

# ---- 2. K线: get_kline_serial，返回会自动更新的 DataFrame ----
# duration_seconds: 60=1分钟, 300=5分钟, 3600=1小时, 86400=日线
klines = api.get_kline_serial("KQ.m@SHFE.cu", duration_seconds=60, data_length=200)

# ---- 3. 事件循环: wait_update 阻塞到任何数据更新, 驱动 GUI 和数据刷新 ----
# 盘口/K线都在网页里看; 想在终端打印的话, 用 api.is_changing(cu, "last_price")
# 判断更新后 print(cu.last_price, cu.bid_price1, cu.ask_price1) 即可
print("行情图表: http://127.0.0.1:9879  盘口在网页右侧栏(点订阅合约列表切换), Ctrl+C 退出")
while True:
    api.wait_update()
