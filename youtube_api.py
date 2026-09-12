"""YouTube Data API v3 호출 모듈 (서버 전용).

- API 키는 URL 이 아니라 X-Goog-Api-Key 헤더로 보낸다.
  → 요청 주소·로그·오류 메시지 어디에도 키가 찍히지 않는다.
- 같은 요청은 10분 동안 메모리에 캐시해서 할당량(quota)을 아낀다.
- 브라우저로 돌려주는 값은 필요한 필드만 골라 정리한 dict 뿐이다.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_BASE = "https://www.googleapis.com/youtube/v3/"
CACHE_TTL = 600  # 초
CACHE_MAX = 500
# 요청 1번당 할당량 비용 — https://developers.google.com/youtube/v3/determine_quota_cost
QUOTA_COST = {"channels": 1, "playlistItems": 1, "videos": 1, "search": 100}

CHANNEL_ID_RE = re.compile(r"^UC[\w-]{22}$")
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")
DURATION_RE = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?")


class YouTubeError(Exception):
    """브라우저에 그대로 보여 줄 수 있는(키가 없는) 오류."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def parse_duration(text):
    """ISO 8601 기간(PT1H2M3S, P1DT2H 등)을 초로 바꾼다."""
    m = DURATION_RE.fullmatch(text or "")
    if not m:
        return None
    d, h, mi, s = (int(g or 0) for g in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + s


def parse_channel_input(text):
    """사용자가 넣은 값을 (종류, 값) 으로 해석한다.

    종류: id / handle / username / video / text
    """
    text = text.strip()
    if re.search(r"(^|[/.])(youtube\.com|youtu\.be)(/|$)", text):
        if not re.match(r"^https?://", text):
            text = "https://" + text
        url = urllib.parse.urlparse(text)
        parts = [urllib.parse.unquote(p) for p in url.path.split("/") if p]
        if url.netloc.endswith("youtu.be") and parts:
            return "video", parts[0]
        if parts:
            head = parts[0]
            if head.startswith("@"):
                return "handle", head
            if head == "channel" and len(parts) > 1:
                return "id", parts[1]
            if head == "user" and len(parts) > 1:
                return "username", parts[1]
            if head == "c" and len(parts) > 1:
                return "text", parts[1]
            if head in ("shorts", "live") and len(parts) > 1:
                return "video", parts[1]
            if head == "watch":
                v = urllib.parse.parse_qs(url.query).get("v", [""])[0]
                if v:
                    return "video", v
        raise ValueError("이 주소에서 채널을 알아내지 못했습니다. 채널 페이지 주소나 @핸들을 넣어 주세요.")
    if CHANNEL_ID_RE.match(text):
        return "id", text
    if text.startswith("@"):
        return "handle", text
    return "text", text


def _int(value):
    return int(value) if value is not None else None


def _thumb(snippet, *sizes):
    thumbs = snippet.get("thumbnails") or {}
    for size in sizes:
        if thumbs.get(size, {}).get("url"):
            return thumbs[size]["url"]
    return None


def _video(item):
    sn = item.get("snippet", {})
    st = item.get("statistics", {})
    cd = item.get("contentDetails", {})
    return {
        "id": item["id"],
        "title": sn.get("title", ""),
        "channelId": sn.get("channelId"),
        "channelTitle": sn.get("channelTitle", ""),
        "publishedAt": sn.get("publishedAt"),
        "durationSec": parse_duration(cd.get("duration")),
        "views": _int(st.get("viewCount")) or 0,
        "likes": _int(st.get("likeCount")),  # 좋아요 수 비공개면 None
        "comments": _int(st.get("commentCount")),  # 댓글 사용 중지면 None
        "tags": sn.get("tags", []),
        "thumbnail": _thumb(sn, "medium", "default"),
        "live": sn.get("liveBroadcastContent", "none"),
    }


def _channel(item):
    sn = item.get("snippet", {})
    st = item.get("statistics", {})
    return {
        "id": item["id"],
        "title": sn.get("title", ""),
        "handle": sn.get("customUrl"),
        "description": (sn.get("description") or "")[:1000],
        "publishedAt": sn.get("publishedAt"),
        "country": sn.get("country"),
        "thumbnail": _thumb(sn, "medium", "default"),
        "subscribers": None if st.get("hiddenSubscriberCount") else _int(st.get("subscriberCount")),
        "views": _int(st.get("viewCount")),
        "videoCount": _int(st.get("videoCount")),
    }


def _chunks(items, size=50):
    for i in range(0, len(items), size):
        yield items[i:i + size]


class YouTubeClient:
    def __init__(self, api_key):
        self._key = api_key
        self._cache = {}
        self._lock = threading.Lock()
        self.quota_used = 0

    def scrub(self, text):
        """혹시라도 문자열에 키가 섞여 있으면 가린다."""
        return text.replace(self._key, "[API_KEY]") if self._key else text

    # ── 저수준 호출 ────────────────────────────────────────────
    def _get(self, resource, **params):
        params = {k: v for k, v in params.items() if v not in (None, "")}
        url = f"{API_BASE}{resource}?{urllib.parse.urlencode(sorted(params.items()))}"
        now = time.time()
        with self._lock:
            hit = self._cache.get(url)
            if hit and now - hit[0] < CACHE_TTL:
                return hit[1]

        request = urllib.request.Request(
            url, headers={"X-Goog-Api-Key": self._key, "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as err:
            with self._lock:
                self.quota_used += QUOTA_COST.get(resource, 1)
            message, status = _explain_http_error(err)
            raise YouTubeError(self.scrub(message), status) from None
        except (urllib.error.URLError, TimeoutError):
            raise YouTubeError("YouTube 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.") from None

        with self._lock:
            self.quota_used += QUOTA_COST.get(resource, 1)
            if len(self._cache) >= CACHE_MAX:
                self._cache = {k: v for k, v in self._cache.items() if now - v[0] < CACHE_TTL}
            self._cache[url] = (now, data)
        return data

    # ── 조회 도우미 ────────────────────────────────────────────
    def get_videos(self, ids):
        videos = []
        for chunk in _chunks(ids):
            data = self._get("videos", part="snippet,statistics,contentDetails", id=",".join(chunk), maxResults=50)
            videos += [_video(item) for item in data.get("items", [])]
        # 아직 공개 전인 예약·프리미어 영상은 조회수가 0이라 분석에서 뺀다
        return [v for v in videos if v["live"] != "upcoming"]

    def get_channels(self, ids):
        channels = {}
        for chunk in _chunks(list(dict.fromkeys(ids))):
            data = self._get("channels", part="snippet,statistics", id=",".join(chunk), maxResults=50)
            for item in data.get("items", []):
                channels[item["id"]] = _channel(item)
        return channels

    def resolve_channel(self, text):
        kind, value = parse_channel_input(text)
        parts = "snippet,statistics,contentDetails"
        resolved_by = kind
        items = []

        if kind == "id":
            items = self._get("channels", part=parts, id=value).get("items", [])
        elif kind == "video":
            if not VIDEO_ID_RE.match(value):
                raise ValueError("영상 주소가 올바르지 않습니다.")
            found = self._get("videos", part="snippet", id=value).get("items", [])
            if found:
                items = self._get("channels", part=parts, id=found[0]["snippet"]["channelId"]).get("items", [])
        elif kind == "handle":
            items = self._get("channels", part=parts, forHandle=value).get("items", [])
        elif kind == "username":
            items = self._get("channels", part=parts, forUsername=value).get("items", [])
        elif kind == "text" and " " not in value:
            # @ 없이 적은 경우 먼저 핸들로 시도 (할당량 1)
            items = self._get("channels", part=parts, forHandle="@" + value).get("items", [])
            resolved_by = "handle"

        if not items and kind in ("text", "handle", "username"):
            # 마지막 수단: 채널 검색 (할당량 100)
            found = self._get("search", part="snippet", type="channel", q=value.lstrip("@"), maxResults=1)
            hits = found.get("items", [])
            if hits:
                cid = hits[0]["snippet"]["channelId"]
                items = self._get("channels", part=parts, id=cid).get("items", [])
                resolved_by = "search"

        if not items:
            raise YouTubeError(f"'{text}' 채널을 찾지 못했습니다. @핸들이나 채널 주소를 다시 확인하세요.", 404)
        return items[0], resolved_by

    # ── 대시보드용 묶음 응답 ───────────────────────────────────
    def channel_report(self, text, max_videos):
        item, resolved_by = self.resolve_channel(text)
        uploads = item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")

        ids, token = [], None
        while uploads and len(ids) < max_videos:
            try:
                page = self._get(
                    "playlistItems", part="contentDetails", playlistId=uploads, maxResults=50, pageToken=token
                )
            except YouTubeError as err:
                if err.status == 404:  # 영상이 하나도 없는 채널
                    break
                raise
            ids += [it["contentDetails"]["videoId"] for it in page.get("items", [])]
            token = page.get("nextPageToken")
            if not token:
                break

        return {
            "kind": "channel",
            "channel": _channel(item),
            "videos": self.get_videos(ids[:max_videos]),
            "requested": max_videos,
            "resolvedBy": resolved_by,
        }

    def search_report(self, q, order, max_results, days, region):
        published_after = None
        if days:
            # 1시간 단위로 잘라야 같은 검색을 다시 할 때 캐시가 맞는다
            since = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) - timedelta(days=days)
            published_after = since.strftime("%Y-%m-%dT%H:%M:%SZ")

        ids, token = [], None
        while len(ids) < max_results:
            page = self._get(
                "search",
                part="snippet",
                type="video",
                q=q,
                order=order,
                maxResults=50,
                regionCode=region or None,
                relevanceLanguage="ko" if region == "KR" else None,
                publishedAfter=published_after,
                pageToken=token,
            )
            ids += [it["id"]["videoId"] for it in page.get("items", []) if it.get("id", {}).get("videoId")]
            token = page.get("nextPageToken")
            if not token:
                break

        videos = self.get_videos(list(dict.fromkeys(ids))[:max_results])
        return {
            "kind": "search",
            "query": q,
            "order": order,
            "days": days,
            "region": region,
            "videos": videos,
            "channels": self.get_channels([v["channelId"] for v in videos if v["channelId"]]),
        }


def _explain_http_error(err):
    """Google 오류 응답을 사람이 이해할 수 있는 한국어 안내로 바꾼다."""
    reasons, message = set(), ""
    try:
        info = json.loads(err.read().decode("utf-8")).get("error", {})
        message = info.get("message", "")
        reasons = {e.get("reason") for e in info.get("errors", [])}
        reasons |= {d.get("reason") for d in info.get("details", []) if isinstance(d, dict)}
    except Exception:
        pass

    if reasons & {"quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"}:
        return ("오늘 쓸 수 있는 YouTube API 할당량을 모두 썼습니다. "
                "태평양 시간 자정(한국 시간 오후 4~5시)에 다시 채워집니다."), 429
    if reasons & {"keyInvalid", "API_KEY_INVALID"}:
        return "API 키가 올바르지 않습니다. .env 의 YOUTUBE_API_KEY 값을 확인하세요.", 502
    if reasons & {"accessNotConfigured", "SERVICE_DISABLED"}:
        return ("이 API 키의 Google Cloud 프로젝트에서 'YouTube Data API v3'가 사용 설정되어 있지 않습니다. "
                "콘솔에서 사용 설정 후 몇 분 뒤 다시 시도하세요."), 502
    if reasons & {"ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED",
                  "API_KEY_SERVICE_BLOCKED", "forbidden"}:
        return ("API 키의 사용 제한 설정 때문에 요청이 거부되었습니다. "
                "'웹사이트(HTTP 리퍼러)' 제한은 서버 호출과 맞지 않으니, 'API 제한: YouTube Data API v3'로 설정하세요."), 502
    if reasons & {"channelNotFound", "playlistNotFound", "videoNotFound"} or err.code == 404:
        return "요청한 채널 또는 영상을 찾지 못했습니다.", 404
    return f"YouTube API 오류 ({err.code}): {message}"[:300], 502
