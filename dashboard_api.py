"""/api 요청 처리 — 로컬 서버(server.py)와 Vercel 함수(api/*.py)가 함께 쓴다.

API 키는 환경 변수 YOUTUBE_API_KEY 에서만 읽고, 응답에는 절대 넣지 않는다.
  - 로컬: config.py 가 .env 를 읽어 환경 변수로 올려 준다.
  - Vercel: 프로젝트 Settings → Environment Variables 에 저장한 값이 들어온다.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

from youtube_api import YouTubeClient, YouTubeError

KEY_NAME = "YOUTUBE_API_KEY"
CHANNEL_MAX = {50, 100, 200}
SEARCH_MAX = {50, 100}
SEARCH_ORDERS = {"relevance", "viewCount", "date"}
SEARCH_DAYS = {0, 7, 30, 90, 365}
REGIONS = {"", "KR", "US", "JP"}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self' data: https://i.ytimg.com https://*.ggpht.com https://*.googleusercontent.com; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
}

_client = None


def get_client():
    """키가 있으면 YouTubeClient 를 돌려준다 (캐시를 살리려고 한 번만 만든다). 없으면 None."""
    global _client
    key = os.environ.get(KEY_NAME, "").strip()
    if not key:
        return None
    if _client is None:
        _client = YouTubeClient(key)
    return _client


def is_cross_site(headers):
    # 다른 웹사이트의 페이지가 몰래 이 API 를 불러 할당량을 쓰지 못하게 막는다
    return headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none")


def _choice(value, allowed, cast=str):
    try:
        value = cast(value)
    except ValueError:
        raise ValueError("요청 값이 올바르지 않습니다.") from None
    if value not in allowed:
        raise ValueError("허용되지 않은 요청 값입니다.")
    return value


def _required(value, message):
    if not value:
        raise ValueError(message)
    if len(value) > 200:
        raise ValueError("입력이 너무 깁니다. (200자 이하)")
    return value


def handle_api(path, query, track_quota=True):
    """/api 요청 하나를 처리해 (HTTP 상태, JSON 으로 보낼 dict) 를 돌려준다.

    track_quota: 로컬에서는 이 프로세스가 쓴 할당량을 알려 준다. Vercel 은 인스턴스가
    여러 개라 숫자가 맞지 않으므로 끈다.
    """
    client = get_client()

    def arg(name, default=""):
        return (query.get(name) or [default])[0].strip()

    def with_quota(payload):
        if track_quota and client:
            payload["quotaUsed"] = client.quota_used
        return payload

    path = path.rstrip("/")
    if path == "/api/status":
        return 200, with_quota({"ok": True, "keyConfigured": client is not None, "quotaTracking": track_quota})
    if path not in ("/api/channel", "/api/search"):
        return 404, {"error": "없는 API 입니다."}
    if client is None:
        return 503, {"error": "서버에 YouTube API 키(YOUTUBE_API_KEY)가 설정되어 있지 않습니다. "
                              "Vercel 이라면 Settings → Environment Variables 에 추가한 뒤 재배포하세요."}

    try:
        if path == "/api/channel":
            q = _required(arg("q"), "채널 주소나 @핸들을 입력하세요.")
            data = client.channel_report(q, _choice(arg("max", "100"), CHANNEL_MAX, int))
        else:
            q = _required(arg("q"), "검색어를 입력하세요.")
            data = client.search_report(
                q,
                order=_choice(arg("order", "relevance"), SEARCH_ORDERS),
                max_results=_choice(arg("max", "50"), SEARCH_MAX, int),
                days=_choice(arg("days", "0"), SEARCH_DAYS, int),
                region=_choice(arg("region", "KR"), REGIONS),
            )
    except ValueError as err:
        return 400, with_quota({"error": str(err)})
    except YouTubeError as err:
        return err.status, with_quota({"error": str(err)})
    except Exception as err:  # 예상 못 한 오류도 키가 새지 않게 가려서 기록
        print(f"[서버 오류] {type(err).__name__}: {client.scrub(str(err))}", file=sys.stderr)
        return 500, {"error": "서버 내부 오류가 발생했습니다. 서버 로그를 확인하세요."}
    return 200, with_quota(data)


def send_body(handler, status, body, content_type):
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    for name, value in SECURITY_HEADERS.items():
        handler.send_header(name, value)
    handler.end_headers()
    handler.wfile.write(body)


def send_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    send_body(handler, status, body, "application/json; charset=utf-8")


class VercelHandler(BaseHTTPRequestHandler):
    """Vercel 함수용 핸들러. api/*.py 가 route 만 정해서 상속한다."""

    route = ""

    def do_GET(self):
        if is_cross_site(self.headers):
            return send_json(self, 403, {"error": "허용되지 않은 요청입니다."})
        status, payload = handle_api(self.route, parse_qs(urlparse(self.path).query), track_quota=False)
        send_json(self, status, payload)
