"""Vercel 함수: GET /api/status — 처리 로직은 루트의 dashboard_api.py"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # 프로젝트 루트 모듈을 불러오기 위해

from dashboard_api import VercelHandler  # noqa: E402


class handler(VercelHandler):
    route = "/api/status"
