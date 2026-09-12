"""YouTube Data API 키를 .env 에서 읽어 온다.

    from config import load_api_key, mask
    api_key = load_api_key()   # 키가 없으면 안내 문구를 띄우고 종료
    print(mask(api_key))       # 화면에는 가린 값만
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

KEY_NAME = "YOUTUBE_API_KEY"
ENV_PATH = Path(__file__).resolve().parent / ".env"
SAMPLE_PATH = ENV_PATH.with_name(".env.sample")
CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials"


def mask(secret: str) -> str:
    """키 전체를 보여 주지 않도록 앞 4자리와 길이만 남긴다. 예: AIza****** (39자)"""
    visible = secret[:4] if len(secret) > 8 else ""
    return f"{visible}{'*' * 6} ({len(secret)}자)"


def load_api_key() -> str:
    # .env 가 없어도 오류 없이 넘어가고, 이미 설정된 환경 변수가 있으면 그 값을 우선한다
    load_dotenv(ENV_PATH)
    key = os.getenv(KEY_NAME, "").strip()
    if key:
        return key

    if not ENV_PATH.exists():
        reason = f".env 파일이 없습니다: {ENV_PATH}"
        fix = f"  1) {SAMPLE_PATH.name} 을 복사해 .env 를 만드세요.  (Windows: copy .env.sample .env)"
    else:
        reason = f".env 에 {KEY_NAME} 값이 비어 있습니다: {ENV_PATH}"
        fix = f"  1) .env 를 열어 {KEY_NAME}= 뒤에 키를 붙여 넣으세요. (따옴표·공백 없이)"

    sys.exit(
        f"[오류] YouTube API 키를 찾지 못해 중단합니다.\n"
        f"  - {reason}\n"
        f"\n해결 방법\n"
        f"{fix}\n"
        f"  2) 키가 없다면 Google Cloud 콘솔에서 'YouTube Data API v3'를 사용 설정하고\n"
        f"     API 키를 만드세요: {CREDENTIALS_URL}"
    )
