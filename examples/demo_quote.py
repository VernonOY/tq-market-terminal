"""TqSdk 入门示例：订阅实时行情

用法: 把快期账户密码填入同目录 tq_auth.env 后运行
    .venv/bin/python demo_quote.py
"""
from tqsdk import TqApi, TqAuth

from tq_auth import load_auth

USER, PASSWORD = load_auth()

api = TqApi(auth=TqAuth(USER, PASSWORD))

# 订阅上期所沪铜主连行情（主力连续合约）
quote = api.get_quote("KQ.m@SHFE.cu")
print(f"合约: {quote.instrument_id}  最新价: {quote.last_price}")

# 收 5 次行情更新后退出
count = 0
while count < 5:
    api.wait_update()
    if api.is_changing(quote, "last_price"):
        count += 1
        print(
            f"[{quote.datetime}] 最新价: {quote.last_price}  "
            f"买一: {quote.bid_price1}({quote.bid_volume1})  "
            f"卖一: {quote.ask_price1}({quote.ask_volume1})  "
            f"成交量: {quote.volume}"
        )

api.close()
