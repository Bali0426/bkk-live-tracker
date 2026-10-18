import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    BKK_API_KEY: str = os.getenv("BKK_API_KEY", "bkk-web").strip()
    CACHE_TTL_SECONDS: int = int(os.getenv("CACHE_TTL_SECONDS", "8"))
    
    # BKK FUTÁR REST API alap URL
    FUTAR_BASE_URL: str = "https://go.bkk.hu/api/query/v1/ws/otp/api/where"
    
    # BKK GTFS-Realtime Protobuf alap URL
    GTFS_RT_BASE_URL: str = "https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full"

settings = Settings()
