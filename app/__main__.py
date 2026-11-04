"""啟動:python -m app(讀取 .env 的 HOST / PORT)。"""
import uvicorn

from .config import settings

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.host, port=settings.port,
                proxy_headers=True, forwarded_allow_ips="*", log_level="warning")
