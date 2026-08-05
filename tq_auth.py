"""读取快期账户凭证：优先环境变量 TQ_USER/TQ_PASS，其次同目录 tq_auth.env 文件"""
import os
from pathlib import Path


def load_auth():
    user, password = os.environ.get("TQ_USER", ""), os.environ.get("TQ_PASS", "")
    env_file = Path(__file__).with_name("tq_auth.env")
    if not user and env_file.exists():
        kv = dict(
            line.split("=", 1)
            for line in env_file.read_text().splitlines()
            if "=" in line and not line.lstrip().startswith("#")
        )
        user, password = kv.get("TQ_USER", "").strip(), kv.get("TQ_PASS", "").strip()
    if not user:
        raise SystemExit(
            "未找到快期账户凭证：请把账户密码填入 tq_auth.env，"
            "或用 TQ_USER=... TQ_PASS=... 环境变量运行"
        )
    return user, password
