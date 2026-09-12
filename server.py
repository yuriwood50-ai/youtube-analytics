"""이 컴퓨터에서만 열리는 대시보드 서버 (로컬 실행용).

    브라우저 ──(/api/...)──▶ 이 서버 ──(X-Goog-Api-Key 헤더)──▶ YouTube Data API

API 키는 이 프로세스 메모리에만 있고, 브라우저로 보내는 응답·정적 파일 어디에도 들어가지 않는다.
Vercel 에 배포하면 이 파일 대신 api/*.py 함수가 같은 일을 한다 (공통 로직: dashboard_api.py).
"""
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from config import load_api_key, mask
from dashboard_api import handle_api, is_cross_site, send_body, send_json

HOST = "127.0.0.1"  # 이 컴퓨터에서만 접속 가능 (같은 와이파이의 다른 기기도 못 들어옴)
STATIC_DIR = Path(__file__).resolve().parent / "public"
# 여기 적힌 파일만 내보낸다 → .env 같은 다른 파일은 주소를 알아도 가져갈 수 없다
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "YTDashboard"
    sys_version = ""

    def do_GET(self):
        # DNS 리바인딩 방어: 주소창에 127.0.0.1 / localhost 로 들어온 요청만 받는다
        port = self.server.server_address[1]
        if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return send_json(self, 403, {"error": "허용되지 않은 접속입니다."})

        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            if is_cross_site(self.headers):
                return send_json(self, 403, {"error": "허용되지 않은 요청입니다."})
            status, payload = handle_api(url.path, parse_qs(url.query), track_quota=True)
            return send_json(self, status, payload)

        entry = STATIC_FILES.get(url.path)
        if not entry:
            return send_json(self, 404, {"error": "없는 페이지입니다."})
        name, content_type = entry
        send_body(self, 200, (STATIC_DIR / name).read_bytes(), content_type)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")


class LocalServer(ThreadingHTTPServer):
    # Windows 에서는 재사용 옵션이 켜져 있으면 다른 프로그램이 같은 포트를 가로챌 수 있어 끈다
    allow_reuse_address = False
    allow_reuse_port = False
    daemon_threads = True


def run(port=8000, open_browser=True):
    api_key = load_api_key()  # .env → 환경 변수 (없으면 안내 문구를 띄우고 종료)
    try:
        httpd = LocalServer((HOST, port), Handler)
    except OSError:
        sys.exit(f"[오류] {port}번 포트를 이미 다른 프로그램이 쓰고 있습니다.  예) python main.py --port 8080")

    url = f"http://{HOST}:{port}/"
    print(f"API 키를 불러왔습니다: {mask(api_key)}  (서버 안에서만 쓰고 브라우저로 보내지 않음)")
    print(f"대시보드 주소: {url}")
    print("끝내려면 이 창에서 Ctrl+C 를 누르세요.")
    if open_browser:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")
    finally:
        httpd.server_close()
