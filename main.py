"""YouTube 분석 대시보드 실행 파일.

    python main.py                # 서버를 켜고 브라우저를 연다
    python main.py --no-browser   # 브라우저 자동 열기 끄기
    python main.py --port 8080    # 다른 포트 사용
"""
import argparse

from server import run


def main():
    parser = argparse.ArgumentParser(description="YouTube 분석 대시보드 (이 컴퓨터에서만 열림)")
    parser.add_argument("--port", type=int, default=8000, help="사용할 포트 (기본 8000)")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args()
    run(port=args.port, open_browser=not args.no_browser)


if __name__ == "__main__":
    main()
