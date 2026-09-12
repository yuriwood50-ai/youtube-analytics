"use strict";

/* =============================================================
   YouTube 분석 대시보드 — 프런트엔드
   API 키는 브라우저에 절대 오지 않는다. 모든 데이터는 같은 컴퓨터의
   Python 서버(/api/...)를 거치고, 서버가 키를 붙여 YouTube 에 요청한다.
   ============================================================= */

const SVG_NS = "http://www.w3.org/2000/svg";
const DAY_MS = 86_400_000;
const KST_OFFSET = 9 * 3_600_000;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월 → 일
const WEEK_NAME = ["일", "월", "화", "수", "목", "금", "토"];
const SHORT_MAX_SEC = 180;
const LOW_N = 3; // 이보다 영상이 적은 묶음은 “참고용”으로 연하게
const DURATION_BUCKETS = [
  { label: "1분 이하", max: 60 },
  { label: "1–3분", max: 180 },
  { label: "3–10분", max: 600 },
  { label: "10–20분", max: 1200 },
  { label: "20–60분", max: 3600 },
  { label: "1시간+", max: Infinity },
];
const RECENT_KEY = "yt-dash-recent";

const state = {
  mode: "channel",
  data: null, // 서버 응답
  videos: [], // 파생 지표를 붙인 전체 영상
  list: [], // 필터 적용 결과
  filters: { period: "all", length: "all", text: "" },
  sort: { key: "t", dir: -1 },
  trendMetric: "views",
  trendLog: false,
  tableView: new Set(),
};

/* ── 작은 도우미 ─────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function s(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

function text(parent, x, y, content, cls, anchor = "start", extra = {}) {
  const node = s("text", { x, y, class: cls, "text-anchor": anchor, ...extra }, parent);
  node.textContent = content;
  return node;
}

const debounce = (fn, ms) => {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
};

/* ── 통계 ───────────────────────────────────────────────── */
function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(values) {
  const a = values.filter(Number.isFinite);
  return a.length ? a.reduce((p, c) => p + c, 0) / a.length : null;
}
const sum = (values) => values.filter(Number.isFinite).reduce((p, c) => p + c, 0);

/* ── 숫자·날짜 표기 ─────────────────────────────────────── */
const nf = new Intl.NumberFormat("ko-KR");
const pad2 = (n) => String(n).padStart(2, "0");

function trimNum(x) {
  const fixed = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
function fmtInt(n) {
  return n == null || !Number.isFinite(n) ? "–" : nf.format(Math.round(n));
}
function fmtCompact(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e8) return `${trimNum(n / 1e8)}억`;
  if (a >= 1e4) {
    const man = n / 1e4;
    return Math.abs(man) >= 1000 ? `${nf.format(Math.round(man))}만` : `${trimNum(man)}만`;
  }
  return nf.format(Math.round(n));
}
function fmtPct(x, digits = 2) {
  return x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(digits)}%`;
}
function fmtShare(x) {
  if (x == null || !Number.isFinite(x)) return "–";
  const p = x * 100;
  return `${p >= 100 ? nf.format(Math.round(p)) : p.toFixed(1)}%`;
}
function fmtTimes(x) {
  return x == null || !Number.isFinite(x) ? "–" : `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}배`;
}
function fmtDuration(sec) {
  if (sec == null) return "–";
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}
function kst(t) {
  const d = new Date(t + KST_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mi: d.getUTCMinutes() };
}
function toTime(x) {
  return typeof x === "number" ? x : Date.parse(x);
}
function fmtDate(x) {
  const t = toTime(x);
  if (!Number.isFinite(t)) return "–";
  const p = kst(t);
  return `${p.y}.${pad2(p.m)}.${pad2(p.d)}`;
}
function fmtDateTime(x) {
  const t = toTime(x);
  if (!Number.isFinite(t)) return "–";
  const p = kst(t);
  return `${fmtDate(t)} ${pad2(p.hh)}:${pad2(p.mi)}`;
}
const videoUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const openVideo = (id) => window.open(videoUrl(id), "_blank", "noopener,noreferrer");

/* ── 서버 호출 ───────────────────────────────────────────── */
async function api(path, params = {}) {
  let res;
  try {
    res = await fetch(`${path}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("대시보드 서버에 연결할 수 없습니다. 서버 창(터미널)이 켜져 있는지 확인하세요.");
  }
  const body = await res.json().catch(() => ({}));
  if (body.quotaUsed != null) setQuota(body.quotaUsed);
  if (!res.ok) throw new Error(body.error || `요청에 실패했습니다 (${res.status}).`);
  return body;
}

function setQuota(n) {
  $("#quota").textContent = `할당량 ${nf.format(n)} 사용`;
}

async function checkStatus() {
  const pill = $("#keyStatus");
  try {
    const st = await api("/api/status");
    // Vercel 에서는 서버 인스턴스가 여러 개라 할당량 합계를 정확히 셀 수 없어 숨긴다
    $("#quota").hidden = st.quotaTracking === false;
    if (st.keyConfigured === false) {
      pill.textContent = "API 키 미설정";
      pill.className = "pill bad";
      pill.title = "서버 환경 변수 YOUTUBE_API_KEY 를 설정해야 데이터를 불러올 수 있습니다.";
      return;
    }
    pill.textContent = "API 키: 서버에만 보관";
    pill.className = "pill ok";
    pill.title = "키는 .env 에서 서버가 읽어 쓰며, 이 페이지로는 전달되지 않습니다.";
  } catch (err) {
    pill.textContent = "서버 연결 안 됨";
    pill.className = "pill bad";
    pill.title = err.message;
  }
}

/* ── 데이터 불러오기 ─────────────────────────────────────── */
function setMessage(msg) {
  const box = $("#message");
  box.textContent = msg || "";
  box.hidden = !msg;
}

function setBusy(busy) {
  for (const btn of $$("form button[type=submit]")) {
    btn.disabled = busy;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = busy ? "불러오는 중…" : btn.dataset.label;
  }
  $("#report").classList.toggle("stale", busy);
}

async function runQuery(kind, params) {
  setBusy(true);
  setMessage("");
  try {
    const data = await api(`/api/${kind}`, params);
    loadData(data);
    rememberQuery(kind, params);
  } catch (err) {
    setMessage(err.message);
  } finally {
    setBusy(false);
  }
}

function enrich(v, subscribers) {
  const t = Date.parse(v.publishedAt);
  const local = new Date(t + KST_OFFSET);
  const ageDays = Math.max((Date.now() - t) / DAY_MS, 1); // 하루 미만은 1일로 계산
  const hasReaction = v.likes != null || v.comments != null;
  return {
    ...v,
    tags: v.tags || [],
    t,
    weekday: local.getUTCDay(),
    hour: local.getUTCHours(),
    ageDays,
    engagement: v.views > 0 && hasReaction ? ((v.likes ?? 0) + (v.comments ?? 0)) / v.views : null,
    likeRate: v.views > 0 && v.likes != null ? v.likes / v.views : null,
    viewsPerDay: v.views / ageDays,
    subscribers,
    subRatio: subscribers ? v.views / subscribers : null,
    relMedian: null,
  };
}

function loadData(data) {
  state.data = data;
  const subsOf =
    data.kind === "channel"
      ? () => data.channel.subscribers
      : (v) => data.channels?.[v.channelId]?.subscribers ?? null;
  state.videos = data.videos.map((v) => enrich(v, subsOf(v))).filter((v) => Number.isFinite(v.t));
  state.sort = data.kind === "channel" ? { key: "t", dir: -1 } : { key: "views", dir: -1 };
  state.filters = { period: "all", length: "all", text: "" };
  $("#filterText").value = "";
  syncFilterButtons();
  document.body.dataset.kind = data.kind;
  $("#empty").hidden = true;
  $("#report").hidden = false;
  renderHeader();
  renderAll();
}

/* ── 필터 ───────────────────────────────────────────────── */
function applyFilters() {
  const { period, length, text: q0 } = state.filters;
  const cutoff = period === "all" ? -Infinity : Date.now() - Number(period) * DAY_MS;
  const q = q0.trim().toLowerCase();
  const list = state.videos.filter((v) => {
    if (v.t < cutoff) return false;
    const d = v.durationSec ?? 0;
    if (length === "short" && d > SHORT_MAX_SEC) return false;
    if (length === "long" && d <= SHORT_MAX_SEC) return false;
    if (q && !v.title.toLowerCase().includes(q) && !v.tags.some((t) => t.toLowerCase().includes(q))) return false;
    return true;
  });
  const med = median(list.map((v) => v.views));
  for (const v of list) v.relMedian = med ? v.views / med : null;
  return list;
}

function syncFilterButtons() {
  for (const group of $$(".seg[data-filter]")) {
    const current = state.filters[group.dataset.filter];
    for (const btn of $$("button", group)) btn.setAttribute("aria-pressed", String(btn.dataset.value === current));
  }
}

function renderAll() {
  const list = applyFilters();
  state.list = list;
  $("#filterCount").textContent = `${nf.format(list.length)} / ${nf.format(state.videos.length)}개 영상`;
  const has = list.length > 0;
  $("#noMatch").hidden = has;
  $("#charts").hidden = !has;
  renderKpis(list);
  if (has) renderCharts(list);
  renderTable(list);
}

/* ── 헤더 ───────────────────────────────────────────────── */
function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("div", { class: "k", text: label }), h("div", { class: "v", text: value, title: value }), sub ? h("div", { class: "s", text: sub, title: sub }) : null);
}

function renderHeader() {
  const box = $("#header");
  const data = state.data;
  const times = state.videos.map((v) => v.t);
  const range = times.length ? `${fmtDate(Math.min(...times))} ~ ${fmtDate(Math.max(...times))}` : "영상 없음";

  if (data.kind === "channel") {
    const c = data.channel;
    const link = `https://www.youtube.com/channel/${encodeURIComponent(c.id)}`;
    // 일부 공식 채널은 개설일이 1970-01-01 같은 자리표시 값으로 와서 YouTube 이전 날짜는 숨긴다
    const opened = Date.parse(c.publishedAt) >= Date.UTC(2005, 0, 1) ? `개설 ${fmtDate(c.publishedAt)}` : null;
    const meta = [c.handle, c.country, opened].filter(Boolean).join(" · ");
    box.replaceChildren(
      h(
        "div",
        { class: "ch-id" },
        c.thumbnail ? h("img", { class: "avatar", src: c.thumbnail, alt: "", referrerpolicy: "no-referrer" }) : null,
        h(
          "div",
          { class: "ch-text" },
          h("h2", {}, h("a", { href: link, target: "_blank", rel: "noopener noreferrer", text: c.title })),
          h("p", { class: "meta", text: meta }),
          c.description ? h("p", { class: "desc", text: c.description }) : null
        )
      ),
      h(
        "div",
        { class: "ch-stats" },
        stat("구독자", c.subscribers == null ? "비공개" : fmtCompact(c.subscribers), c.subscribers == null ? null : `${fmtInt(c.subscribers)}명`),
        stat("채널 총 조회수", fmtCompact(c.views), fmtInt(c.views)),
        stat("전체 영상", `${fmtInt(c.videoCount)}개`),
        stat("분석한 영상", `최근 ${nf.format(state.videos.length)}개`, range)
      )
    );
  } else {
    const orderName = { relevance: "관련성순", viewCount: "조회수순", date: "최신순" }[data.order] || data.order;
    const days = data.days ? `최근 ${data.days}일` : "전체 기간";
    const region = { KR: "한국", US: "미국", JP: "일본", "": "전체 지역" }[data.region ?? ""];
    const channelCount = new Set(state.videos.map((v) => v.channelId)).size;
    const top = [...state.videos].sort((a, b) => b.views - a.views)[0];
    box.replaceChildren(
      h(
        "div",
        { class: "ch-id" },
        h("div", { class: "ch-text" }, h("h2", { text: `“${data.query}” 검색 결과` }), h("p", { class: "meta", text: [orderName, days, region].join(" · ") }), h("p", { class: "desc", text: `게시 기간: ${range}` }))
      ),
      h(
        "div",
        { class: "ch-stats" },
        stat("영상", `${nf.format(state.videos.length)}개`),
        stat("채널", `${nf.format(channelCount)}개`),
        stat("조회수 합계", fmtCompact(sum(state.videos.map((v) => v.views)))),
        stat("최다 조회", top ? fmtCompact(top.views) : "–", top ? top.title : null)
      )
    );
  }
}

/* ── 핵심 지표 ──────────────────────────────────────────── */
function kpi(label, value, sub, help) {
  return h("div", { class: "kpi", title: help || null }, h("div", { class: "k", text: label }), h("div", { class: "v", text: value }), sub ? h("div", { class: "s", text: sub }) : null);
}

function uploadCadence(list) {
  const ts = list.map((v) => v.t).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / DAY_MS);
  const g = median(gaps);
  const weeks = Math.max((ts.at(-1) - ts[0]) / (7 * DAY_MS), 1);
  return {
    value: g < 1 ? `하루 ${trimNum(1 / Math.max(g, 1 / 24))}개` : `${trimNum(g)}일마다`,
    sub: `주 평균 ${trimNum(ts.length / weeks)}개 업로드`,
  };
}

function renderKpis(list) {
  const views = list.map((v) => v.views);
  const tiles = [
    kpi("중앙값 조회수", fmtCompact(median(views)), `평균 ${fmtCompact(mean(views))}`, "영상의 절반이 이 값보다 많이 봤어요. 대박 영상 몇 개에 휘둘리지 않는 값입니다."),
    kpi("조회수 합계", fmtCompact(sum(views)), `${nf.format(list.length)}개 영상`),
    kpi("참여율 (중앙값)", fmtPct(median(list.map((v) => v.engagement))), "(좋아요 + 댓글) ÷ 조회수"),
    kpi("좋아요율 (중앙값)", fmtPct(median(list.map((v) => v.likeRate))), "좋아요 ÷ 조회수"),
    kpi("구독자 대비 조회수", fmtShare(median(list.map((v) => v.subRatio))), "영상별 조회수 ÷ 구독자, 중앙값", "100%를 넘으면 구독자 밖으로도 퍼진다는 뜻입니다."),
  ];
  if (state.data.kind === "channel") {
    const c = uploadCadence(list);
    tiles.push(kpi("업로드 간격", c ? c.value : "–", c ? c.sub : "영상이 2개 이상 필요"));
  } else {
    tiles.push(kpi("등장 채널", `${nf.format(new Set(list.map((v) => v.channelId)).size)}개`, "검색 결과에 나온 채널 수"));
  }
  $("#kpis").replaceChildren(...tiles);
}

/* ── 툴팁 ───────────────────────────────────────────────── */
function showTip(evt, content) {
  const tip = $("#tooltip");
  tip.replaceChildren(
    content.image ? h("img", { src: content.image, alt: "", referrerpolicy: "no-referrer" }) : null,
    content.title ? h("div", { class: "t-title", text: content.title }) : null,
    h("dl", {}, content.rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
    content.foot ? h("div", { class: "t-foot", text: content.foot }) : null
  );
  tip.hidden = false;
  moveTip(evt);
}
function moveTip(evt) {
  const tip = $("#tooltip");
  if (tip.hidden) return;
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, evt.clientY - r.height - pad);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y}px`;
}
function hideTip() {
  $("#tooltip").hidden = true;
}

function videoTip(v, extraRows = []) {
  const rows = [
    ["게시", fmtDateTime(v.t)],
    ...(state.data.kind === "search" ? [["채널", v.channelTitle]] : []),
    ["길이", fmtDuration(v.durationSec)],
    ["조회수", fmtInt(v.views)],
    ["좋아요", fmtInt(v.likes)],
    ["댓글", fmtInt(v.comments)],
    ["참여율", fmtPct(v.engagement)],
    ["중앙값 대비", fmtTimes(v.relMedian)],
    ...extraRows,
  ];
  return { image: v.thumbnail, title: v.title, rows, foot: "클릭하면 YouTube에서 열려요" };
}

/* ── 차트 공통 ──────────────────────────────────────────── */
function chartWidth(body) {
  return Math.max(body.clientWidth || body.parentElement.clientWidth - 36, 280);
}

function newSvg(body, W, H, label) {
  const root = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": label });
  body.replaceChildren(root);
  return root;
}

function emptyChart(body, msg = "표시할 데이터가 없어요.") {
  body.replaceChildren(h("div", { class: "chart-empty", text: msg }));
}

function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => st >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.5 && ticks.length < 12; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks.at(-1) < max) ticks.push(Number((ticks.at(-1) + step).toPrecision(12)));
  return ticks;
}

// r0 = 값 0(또는 최솟값)의 픽셀 위치, r1 = 최댓값의 픽셀 위치
function linearScale(maxValue, r0, r1) {
  const ticks = niceTicks(maxValue);
  const hi = ticks.at(-1) || 1;
  return { map: (v) => r0 + (v / hi) * (r1 - r0), ticks };
}
function logScale(values, r0, r1) {
  const pos = values.filter((v) => v > 0);
  const lo = 10 ** Math.floor(Math.log10(pos.length ? Math.min(...pos) : 1));
  let hi = 10 ** Math.ceil(Math.log10(pos.length ? Math.max(...pos) : 10));
  if (hi <= lo) hi = lo * 10;
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const ticks = [];
  for (let e = Math.round(l0); e <= Math.round(l1); e++) ticks.push(10 ** e);
  return { map: (v) => r0 + ((Math.log10(Math.max(v, lo)) - l0) / (l1 - l0)) * (r1 - r0), ticks };
}

function drawYAxis(root, scale, x0, x1, fmt) {
  const g = s("g", {}, root);
  scale.ticks.forEach((tv, i) => {
    const y = Math.round(scale.map(tv)) + 0.5;
    s("line", { x1: x0, x2: x1, y1: y, y2: y, class: i === 0 ? "axis" : "grid" }, g);
    text(g, x0 - 8, y + 4, fmt(tv), "tick", "end");
  });
}

function drawXLogAxis(root, scale, y0, y1, fmt, plotW) {
  const g = s("g", {}, root);
  const every = Math.max(1, Math.ceil(scale.ticks.length / Math.max(2, Math.floor(plotW / 56))));
  scale.ticks.forEach((tv, i) => {
    const x = Math.round(scale.map(tv)) + 0.5;
    s("line", { x1: x, x2: x, y1: y1, y2: y0, class: "grid" }, g);
    if (i % every === 0) text(g, x, y0 + 16, fmt(tv), "tick", "middle");
  });
}

function drawTimeAxis(root, t0, t1, x, y0, plotW) {
  const g = s("g", {}, root);
  const span = t1 - t0;
  const n = Math.max(2, Math.min(8, Math.floor(plotW / 110)));
  for (let i = 0; i <= n; i++) {
    const t = t0 + (span * i) / n;
    const p = kst(t);
    const label = span > 200 * DAY_MS ? `${String(p.y).slice(2)}.${pad2(p.m)}` : `${p.m}/${p.d}`;
    const anchor = i === 0 ? "start" : i === n ? "end" : "middle";
    text(g, x(t), y0 + 18, label, "tick", anchor);
  }
}

function refLine(root, x0, x1, y, label) {
  const yy = Math.round(y) + 0.5;
  s("line", { x1: x0, x2: x1, y1: yy, y2: yy, class: "ref" }, root);
  if (label) text(root, x1 - 4, yy - 5, label, "ref-label", "end");
}

function roundTopBar(x, y, w, hgt, r = 4) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function roundRightBar(x, y, w, hgt, r = 4) {
  r = Math.max(0, Math.min(r, hgt / 2, w));
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

function pointerPos(root, evt) {
  const r = root.getBoundingClientRect();
  const scale = Number(root.getAttribute("width")) / r.width || 1;
  return [(evt.clientX - r.left) * scale, (evt.clientY - r.top) * scale];
}

// 가장 가까운 점을 찾아 강조하고 툴팁을 띄운다 (작은 점을 정확히 겨누지 않아도 됨)
function attachNearest(root, items, nodes, coords, tipFor, radius = 30) {
  let active = -1;
  const set = (i, evt) => {
    if (i === active) {
      if (i >= 0) moveTip(evt);
      return;
    }
    if (active >= 0) nodes[active].classList.remove("active");
    active = i;
    if (i < 0) {
      hideTip();
      root.style.cursor = "default";
      return;
    }
    nodes[i].classList.add("active");
    nodes[i].parentNode.append(nodes[i]);
    root.style.cursor = "pointer";
    showTip(evt, tipFor(items[i]));
  };
  root.addEventListener("pointermove", (evt) => {
    const [px, py] = pointerPos(root, evt);
    let best = -1;
    let bestD = radius * radius;
    coords.forEach(([cx, cy], i) => {
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    set(best, evt);
  });
  root.addEventListener("pointerleave", () => set(-1));
  root.addEventListener("click", () => {
    if (active >= 0 && items[active].id) openVideo(items[active].id);
  });
}

// 막대/행 단위 호버: 띠(band) 전체가 반응 영역
function attachBands(root, bands, tipFor) {
  let active = -1;
  const set = (i, evt) => {
    if (i === active) {
      if (i >= 0) moveTip(evt);
      return;
    }
    if (active >= 0) {
      bands[active].bg?.classList.remove("active");
      bands[active].mark?.classList.remove("active");
    }
    active = i;
    if (i < 0) return hideTip();
    bands[i].bg?.classList.add("active");
    bands[i].mark?.classList.add("active");
    showTip(evt, tipFor(bands[i].row));
  };
  root.addEventListener("pointermove", (evt) => {
    const [px, py] = pointerPos(root, evt);
    set(bands.findIndex((b) => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h), evt);
  });
  root.addEventListener("pointerleave", () => set(-1));
}

function legendItem(kind, label) {
  return h("span", { class: "lg" }, h("i", { class: kind }), label);
}

/* ── 카드 그리기 (차트 ↔ 표 전환 포함) ───────────────────── */
const CHARTS = {
  trend: renderTrend,
  scatter: renderScatter,
  weekday: renderWeekday,
  heatmap: renderHeatmap,
  duration: renderDuration,
  tags: renderTags,
  channels: renderChannels,
};

function renderCharts(list) {
  hideTip();
  for (const id of Object.keys(CHARTS)) {
    if (id === "channels" && state.data.kind !== "search") continue;
    drawCard(id, list);
  }
}

function drawCard(id, list) {
  const card = document.getElementById(`card-${id}`);
  const body = $(".chart-body", card);
  const tableBox = $(".chart-table", card);
  const legend = $(".legend", card);
  const insight = $(".insight", card);
  const asTable = state.tableView.has(id) && tableBox;
  body.hidden = !!asTable;
  if (tableBox) tableBox.hidden = !asTable;
  legend.replaceChildren();
  const out = CHARTS[id](body, list, legend) || {};
  if (tableBox) tableBox.replaceChildren(out.table ? miniTable(out.table) : h("div", { class: "chart-empty", text: "표시할 데이터가 없어요." }));
  insight.replaceChildren(...(out.insight || []));
  const toggle = $("[data-toggle-table]", card);
  if (toggle) {
    toggle.textContent = asTable ? "차트" : "표";
    toggle.setAttribute("aria-pressed", String(!!asTable));
  }
}

function miniTable({ columns, rows }) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "data" },
      h("thead", {}, h("tr", {}, columns.map((c, i) => h("th", { class: i ? "num" : null, text: c })))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((cell, i) => h("td", { class: i ? "num" : null, text: String(cell) })))))
    )
  );
}

/* ── 1. 영상별 추이 ─────────────────────────────────────── */
const TREND_METRICS = {
  views: { label: "조회수", get: (v) => v.views, fmt: fmtCompact, full: fmtInt },
  viewsPerDay: { label: "일평균 조회수", get: (v) => v.viewsPerDay, fmt: fmtCompact, full: fmtInt },
  likes: { label: "좋아요", get: (v) => v.likes, fmt: fmtCompact, full: fmtInt },
  comments: { label: "댓글", get: (v) => v.comments, fmt: fmtCompact, full: fmtInt },
  engagement: {
    label: "참여율",
    get: (v) => (v.engagement == null ? null : v.engagement * 100),
    fmt: (x) => `${trimNum(x)}%`,
    full: (x) => `${x.toFixed(2)}%`,
    noLog: true,
  },
};

function renderTrend(body, list, legend) {
  const metric = TREND_METRICS[state.trendMetric];
  const useLog = state.trendLog && !metric.noLog;
  $("#trendLog").disabled = !!metric.noLog;
  const pts = list.filter((v) => Number.isFinite(metric.get(v))).sort((a, b) => a.t - b.t);
  if (!pts.length) return emptyChart(body, `${metric.label} 값이 공개된 영상이 없어요.`);

  const win = Math.min(5, Math.max(2, Math.floor(pts.length / 4)));
  legend.replaceChildren(legendItem("dot", `영상 (${metric.label})`), legendItem("line-2", `이동 중앙값 (직전 ${win}개)`), legendItem("ref", "전체 중앙값"));

  const W = chartWidth(body);
  const H = 300;
  const m = { top: 16, right: 16, bottom: 30, left: 58 };
  const root = newSvg(body, W, H, `${metric.label} 추이`);
  const plotW = W - m.left - m.right;

  let t0 = pts[0].t;
  let t1 = pts.at(-1).t;
  if (t1 - t0 < DAY_MS) {
    t0 -= DAY_MS;
    t1 += DAY_MS;
  }
  const padT = (t1 - t0) * 0.02;
  t0 -= padT;
  t1 += padT;
  const x = (t) => m.left + ((t - t0) / (t1 - t0)) * plotW;
  const values = pts.map(metric.get);
  const y = useLog ? logScale(values, H - m.bottom, m.top) : linearScale(Math.max(...values, 0) || 1, H - m.bottom, m.top);

  drawYAxis(root, y, m.left, W - m.right, metric.fmt);
  drawTimeAxis(root, t0, t1, x, H - m.bottom, plotW);

  const med = median(values);
  refLine(root, m.left, W - m.right, y.map(med), `중앙값 ${metric.fmt(med)}`);

  const roll = values.map((_, i) => (i >= win - 1 ? median(values.slice(i - win + 1, i + 1)) : null));
  const d = roll.map((r, i) => (r == null ? null : `${x(pts[i].t).toFixed(1)},${y.map(r).toFixed(1)}`)).filter(Boolean);
  if (d.length > 1) s("path", { d: `M${d.join("L")}`, class: "line-2" }, root);

  const g = s("g", {}, root);
  const coords = pts.map((p) => [x(p.t), y.map(metric.get(p))]);
  const nodes = coords.map(([cx, cy]) => s("circle", { cx, cy, r: 4, class: "dot" }, g));
  attachNearest(root, pts, nodes, coords, (v) => videoTip(v, state.trendMetric === "views" ? [] : [[metric.label, metric.full(metric.get(v))]]));

  const insight = [];
  const lastRoll = roll.at(-1);
  if (pts.length >= 8 && med > 0 && lastRoll != null) {
    const diff = lastRoll / med - 1;
    const word = diff >= 0 ? "높아요" : "낮아요";
    insight.push(`최근 ${win}개 영상의 ${metric.label} 중앙값은 전체 중앙값보다 `, h("b", { text: `${Math.abs(diff * 100).toFixed(0)}% ${word}` }), ".");
    if (state.trendMetric === "views" || state.trendMetric === "likes" || state.trendMetric === "comments") {
      insight.push(" (최근 영상은 아직 수치가 쌓이는 중일 수 있어요 — ‘일평균 조회수’로도 비교해 보세요.)");
    }
  }
  return { insight };
}

/* ── 2. 조회수 × 참여율 ─────────────────────────────────── */
function renderScatter(body, list) {
  const pts = list.filter((v) => v.views > 0 && v.engagement != null);
  if (pts.length < 2) return emptyChart(body, "좋아요·댓글이 공개된 영상이 부족해요.");
  const W = chartWidth(body);
  const H = 300;
  const m = { top: 16, right: 16, bottom: 30, left: 50 };
  const root = newSvg(body, W, H, "조회수와 참여율");
  const plotW = W - m.left - m.right;

  const x = logScale(pts.map((v) => v.views), m.left, W - m.right);
  const engs = pts.map((v) => v.engagement * 100);
  const y = linearScale(Math.max(...engs), H - m.bottom, m.top);
  drawYAxis(root, y, m.left, W - m.right, (v) => `${trimNum(v)}%`);
  drawXLogAxis(root, x, H - m.bottom, m.top, fmtCompact, plotW);

  const mx = median(pts.map((v) => v.views));
  const my = median(engs);
  const xx = Math.round(x.map(mx)) + 0.5;
  s("line", { x1: xx, x2: xx, y1: m.top, y2: H - m.bottom, class: "ref" }, root);
  refLine(root, m.left, W - m.right, y.map(my), null);

  text(root, W - m.right - 4, m.top + 12, "많이 보고 반응도 큼", "quad-label", "end");
  text(root, m.left + 6, m.top + 12, "반응 좋은 숨은 영상", "quad-label", "start");

  const g = s("g", {}, root);
  const coords = pts.map((v) => [x.map(v.views), y.map(v.engagement * 100)]);
  const nodes = coords.map(([cx, cy]) => s("circle", { cx, cy, r: 4, class: "dot" }, g));
  attachNearest(root, pts, nodes, coords, (v) => videoTip(v));

  const star = pts.filter((v) => v.views >= mx && v.engagement * 100 >= my).length;
  const hidden = pts.filter((v) => v.views < mx && v.engagement * 100 >= my).length;
  return {
    insight: ["오른쪽 위(많이 보고 반응도 큰 영상) ", h("b", { text: `${star}개` }), ", 왼쪽 위(반응은 좋은데 덜 본 영상) ", h("b", { text: `${hidden}개` }), ". 왼쪽 위 영상은 제목·썸네일을 바꿔 볼 후보예요."],
  };
}

/* ── 막대 차트 (세로) ───────────────────────────────────── */
function columnChart(body, rows, legend, { label, tipFor }) {
  const W = chartWidth(body);
  const H = 250;
  const m = { top: 24, right: 8, bottom: 44, left: 52 };
  const root = newSvg(body, W, H, label);
  const vals = rows.map((r) => r.value ?? 0);
  const maxV = Math.max(...vals, 0);
  const y = linearScale(maxV || 1, H - m.bottom, m.top);
  drawYAxis(root, y, m.left, W - m.right, fmtCompact);

  const band = (W - m.left - m.right) / rows.length;
  const bw = Math.min(46, band * 0.64);
  const maxIdx = vals.indexOf(maxV);
  const bands = [];
  rows.forEach((r, i) => {
    const bx = m.left + band * i;
    const cx = bx + band / 2;
    const bg = s("rect", { x: bx + 1, y: m.top, width: band - 2, height: H - m.bottom - m.top, class: "hover-band" }, root);
    text(root, cx, H - m.bottom + 17, r.label, "cat-label", "middle");
    text(root, cx, H - m.bottom + 33, `${r.count}개`, "tick", "middle");
    let mark = null;
    if (r.value) {
      const top = y.map(r.value);
      mark = s("path", { d: roundTopBar(cx - bw / 2, top, bw, H - m.bottom - top), class: `bar${r.count < LOW_N ? " low-n" : ""}` }, root);
      if (i === maxIdx) text(root, cx, top - 7, fmtCompact(r.value), "value-label", "middle");
    }
    bands.push({ x: bx, y: 0, w: band, h: H, row: r, bg, mark });
  });
  const base = Math.round(H - m.bottom) + 0.5;
  s("line", { x1: m.left, x2: W - m.right, y1: base, y2: base, class: "axis" }, root);
  attachBands(root, bands, tipFor);
  if (rows.some((r) => r.count > 0 && r.count < LOW_N)) legend.replaceChildren(legendItem("bar-faint", `연한 막대: 영상 ${LOW_N - 1}개 이하라 참고만`));
}

function groupRow(label, vs) {
  const views = vs.map((v) => v.views);
  return { label, count: vs.length, value: median(views), avg: mean(views), eng: median(vs.map((v) => v.engagement)) };
}
const groupTip = (title) => (r) => ({
  title: title(r),
  rows: [
    ["영상 수", `${r.count}개`],
    ["중앙값 조회수", fmtInt(r.value)],
    ["평균 조회수", fmtInt(r.avg)],
    ["참여율 (중앙값)", fmtPct(r.eng)],
  ],
});
const groupTable = (first, rows) => ({
  columns: [first, "영상 수", "중앙값 조회수", "평균 조회수", "참여율"],
  rows: rows.map((r) => [r.label, r.count, fmtInt(r.value), fmtInt(r.avg), fmtPct(r.eng)]),
});
function bestGroup(rows) {
  return rows.filter((r) => r.count >= LOW_N && r.value != null).sort((a, b) => b.value - a.value)[0];
}

/* ── 3. 요일별 ──────────────────────────────────────────── */
function renderWeekday(body, list, legend) {
  const rows = WEEK_ORDER.map((d) => groupRow(WEEK_NAME[d], list.filter((v) => v.weekday === d)));
  columnChart(body, rows, legend, { label: "요일별 중앙값 조회수", tipFor: groupTip((r) => `${r.label}요일 게시`) });
  const best = bestGroup(rows);
  const most = [...rows].sort((a, b) => b.count - a.count)[0];
  const insight = [];
  if (best) insight.push("조회수가 가장 좋은 요일은 ", h("b", { text: `${best.label}요일` }), ` (중앙값 ${fmtCompact(best.value)}, ${best.count}개)`, ". ");
  if (most?.count) insight.push(`가장 많이 올린 요일은 ${most.label}요일(${most.count}개)이에요.`);
  return { table: groupTable("요일", rows), insight };
}

/* ── 4. 업로드 시간표 (요일 × 시간) ─────────────────────── */
function renderHeatmap(body, list, legend) {
  const cellVideos = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const v of list) cellVideos[v.weekday][v.hour].push(v);
  const maxCount = Math.max(1, ...cellVideos.flat().map((c) => c.length));
  const level = (n) => (n ? Math.max(1, Math.ceil((n / maxCount) * 6)) : 0);

  legend.replaceChildren(
    h("span", { class: "lg" }, "적음", ...[1, 2, 3, 4, 5, 6].map((k) => h("i", { class: `sw seq-${k}` })), "많음"),
    h("span", { class: "lg", text: `가장 진한 칸 = ${maxCount}개` }),
    h("span", { class: "lg" }, h("i", { class: "sw seq-0" }), "업로드 없음")
  );

  const W = chartWidth(body);
  const m = { top: 4, right: 4, bottom: 24, left: 26 };
  const gap = 2;
  const cw = (W - m.left - m.right - gap * 23) / 24;
  const ch = Math.min(26, Math.max(16, cw));
  const H = m.top + 7 * ch + 6 * gap + m.bottom;
  const root = newSvg(body, W, H, "요일과 시간별 업로드 수");

  const bands = [];
  WEEK_ORDER.forEach((d, ri) => {
    const y = m.top + ri * (ch + gap);
    text(root, m.left - 8, y + ch / 2 + 4, WEEK_NAME[d], "cat-label", "end");
    for (let hr = 0; hr < 24; hr++) {
      const x = m.left + hr * (cw + gap);
      const vs = cellVideos[d][hr];
      const rect = s("rect", { x, y, width: cw, height: ch, rx: 3, class: `cell seq-${level(vs.length)}` }, root);
      bands.push({ x: x - gap / 2, y: y - gap / 2, w: cw + gap, h: ch + gap, mark: rect, row: { d, hr, vs } });
    }
  });
  const labelEvery = cw * 3 >= 26 ? 3 : 6;
  for (let hr = 0; hr < 24; hr += labelEvery) text(root, m.left + hr * (cw + gap) + cw / 2, H - 6, `${hr}시`, "tick", "middle");

  attachBands(root, bands, ({ d, hr, vs }) => ({
    title: `${WEEK_NAME[d]}요일 ${hr}시대`,
    rows: [
      ["업로드", `${vs.length}개`],
      ["중앙값 조회수", fmtInt(median(vs.map((v) => v.views)))],
    ],
  }));

  const slots = bands.map((b) => b.row).filter((r) => r.vs.length).sort((a, b) => b.vs.length - a.vs.length);
  const top = slots[0];
  const hourCounts = Array.from({ length: 24 }, (_, hr) => list.filter((v) => v.hour === hr).length);
  const topHour = hourCounts.indexOf(Math.max(...hourCounts));
  return {
    table: {
      columns: ["요일", "시간", "업로드 수", "중앙값 조회수"],
      rows: slots.map((r) => [`${WEEK_NAME[r.d]}요일`, `${r.hr}시`, r.vs.length, fmtInt(median(r.vs.map((v) => v.views)))]),
    },
    insight: top
      ? ["가장 자주 올린 시간은 ", h("b", { text: `${WEEK_NAME[top.d]}요일 ${top.hr}시대` }), ` (${top.vs.length}개), 요일 상관없이는 `, h("b", { text: `${topHour}시대` }), ` (${hourCounts[topHour]}개)예요.`]
      : [],
  };
}

/* ── 5. 영상 길이별 ─────────────────────────────────────── */
function renderDuration(body, list, legend) {
  let lo = -1;
  const rows = DURATION_BUCKETS.map((b) => {
    const vs = list.filter((v) => (v.durationSec ?? 0) > lo && (v.durationSec ?? 0) <= b.max);
    lo = b.max;
    return groupRow(b.label, vs);
  }).filter((r) => r.count > 0);
  if (!rows.length) return emptyChart(body);
  columnChart(body, rows, legend, { label: "영상 길이별 중앙값 조회수", tipFor: groupTip((r) => `길이 ${r.label}`) });
  const best = bestGroup(rows);
  return {
    table: groupTable("길이", rows),
    insight: best ? ["조회수가 가장 좋은 길이는 ", h("b", { text: best.label }), ` (중앙값 ${fmtCompact(best.value)}, ${best.count}개)예요.`] : [],
  };
}

/* ── 가로 막대 (태그·채널) ─────────────────────────────── */
function hbarChart(body, rows, { label, valueText, tipFor, labelWidth = 132 }) {
  const W = chartWidth(body);
  const rowH = 28;
  const m = { top: 4, right: 110, bottom: 4, left: labelWidth };
  const H = m.top + rows.length * rowH + m.bottom;
  const root = newSvg(body, W, H, label);
  const x = linearScale(Math.max(...rows.map((r) => r.value ?? 0), 1), m.left, W - m.right);
  const bands = [];
  rows.forEach((r, i) => {
    const y = m.top + i * rowH;
    const bg = s("rect", { x: 0, y, width: W, height: rowH, class: "hover-band" }, root);
    const name = r.label.length > 11 ? `${r.label.slice(0, 10)}…` : r.label;
    text(root, m.left - 10, y + rowH / 2 + 4, name, "cat-label", "end");
    const w = Math.max(2, x.map(r.value ?? 0) - m.left);
    const mark = s("path", { d: roundRightBar(m.left, y + 7, w, rowH - 14), class: `bar${r.count < 2 ? " low-n" : ""}` }, root);
    text(root, m.left + w + 8, y + rowH / 2 + 4, valueText(r), "tick", "start");
    bands.push({ x: 0, y, w: W, h: rowH, row: r, bg, mark });
  });
  s("line", { x1: m.left + 0.5, x2: m.left + 0.5, y1: m.top, y2: H - m.bottom, class: "axis" }, root);
  attachBands(root, bands, tipFor);
}

/* ── 6. 태그 ────────────────────────────────────────────── */
function renderTags(body, list) {
  const groups = new Map();
  for (const v of list) {
    for (const tag of new Set(v.tags.map((t) => t.trim()).filter(Boolean))) {
      const key = tag.toLowerCase();
      if (!groups.has(key)) groups.set(key, { label: tag, vs: [] });
      groups.get(key).vs.push(v);
    }
  }
  const rows = [...groups.values()]
    .filter((g) => g.vs.length >= 2)
    .map((g) => groupRow(g.label, g.vs))
    .sort((a, b) => b.count - a.count || b.value - a.value)
    .slice(0, 10);
  if (!rows.length) return emptyChart(body, "2개 이상 영상에 함께 쓰인 공개 태그가 없어요.");
  hbarChart(body, rows, {
    label: "태그별 중앙값 조회수",
    valueText: (r) => `${fmtCompact(r.value)} · ${r.count}개`,
    tipFor: groupTip((r) => `#${r.label}`),
  });
  const best = bestGroup(rows);
  return {
    table: groupTable("태그", rows),
    insight: best ? ["자주 쓴 태그 중 조회수가 가장 좋은 태그는 ", h("b", { text: `#${best.label}` }), ` (중앙값 ${fmtCompact(best.value)})예요.`] : [],
  };
}

/* ── 7. 채널별 (검색 모드) ─────────────────────────────── */
function renderChannels(body, list) {
  const groups = new Map();
  for (const v of list) {
    if (!groups.has(v.channelId)) groups.set(v.channelId, []);
    groups.get(v.channelId).push(v);
  }
  const info = state.data.channels || {};
  const rows = [...groups.entries()]
    .map(([id, vs]) => ({
      ...groupRow(info[id]?.title || vs[0].channelTitle, vs),
      total: sum(vs.map((v) => v.views)),
      subs: info[id]?.subscribers ?? null,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((r) => ({ ...r, value: r.total }));
  if (!rows.length) return emptyChart(body);
  hbarChart(body, rows, {
    label: "채널별 조회수 합계",
    valueText: (r) => `${fmtCompact(r.total)} · ${r.count}개`,
    tipFor: (r) => ({
      title: r.label,
      rows: [
        ["구독자", r.subs == null ? "비공개" : fmtInt(r.subs)],
        ["결과 속 영상", `${r.count}개`],
        ["조회수 합계", fmtInt(r.total)],
        ["중앙값 조회수", fmtInt(median(list.filter((v) => (info[v.channelId]?.title || v.channelTitle) === r.label).map((v) => v.views)))],
      ],
    }),
  });
  const totalAll = sum(list.map((v) => v.views));
  const top = rows[0];
  return {
    table: {
      columns: ["채널", "구독자", "영상 수", "조회수 합계", "점유율"],
      rows: rows.map((r) => [r.label, r.subs == null ? "비공개" : fmtInt(r.subs), r.count, fmtInt(r.total), fmtShare(totalAll ? r.total / totalAll : null)]),
    },
    insight: top && totalAll ? [h("b", { text: top.label }), ` 채널이 검색 결과 조회수의 ${fmtShare(top.total / totalAll)}를 차지해요.`] : [],
  };
}

/* ── 영상 목록 표 ───────────────────────────────────────── */
const TABLE_COLUMNS = [
  { key: "rank", label: "#", num: true, sortable: false },
  { key: "title", label: "영상", cls: "col-title" },
  { key: "channelTitle", label: "채널", searchOnly: true },
  { key: "t", label: "게시일", fmt: (v) => fmtDate(v.t) },
  { key: "durationSec", label: "길이", num: true, fmt: (v) => fmtDuration(v.durationSec) },
  { key: "views", label: "조회수", num: true, fmt: (v) => fmtInt(v.views) },
  { key: "likes", label: "좋아요", num: true, fmt: (v) => fmtInt(v.likes) },
  { key: "comments", label: "댓글", num: true, fmt: (v) => fmtInt(v.comments) },
  { key: "engagement", label: "참여율", num: true, fmt: (v) => fmtPct(v.engagement), help: "(좋아요 + 댓글) ÷ 조회수" },
  { key: "viewsPerDay", label: "일평균 조회", num: true, fmt: (v) => fmtInt(v.viewsPerDay), help: "조회수 ÷ 게시 후 지난 일수" },
  { key: "subRatio", label: "구독자 대비", num: true, fmt: (v) => fmtShare(v.subRatio), help: "조회수 ÷ 채널 구독자 수" },
  { key: "relMedian", label: "중앙값 대비", num: true, help: "조회수 ÷ 현재 필터의 중앙값 조회수" },
];

function visibleColumns() {
  return TABLE_COLUMNS.filter((c) => !c.searchOnly || state.data.kind === "search");
}

function sortedList(list) {
  const { key, dir } = state.sort;
  return [...list].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; // 값이 없는 영상은 항상 맨 아래
    if (y == null) return -1;
    return typeof x === "string" ? dir * x.localeCompare(y, "ko") : dir * (x - y);
  });
}

function renderTable(list) {
  const cols = visibleColumns();
  const table = $("#videoTable");
  $("thead", table).replaceChildren(
    h(
      "tr",
      {},
      cols.map((c) => {
        const sorted = state.sort.key === c.key;
        const th = h("th", { class: [c.num ? "num" : "", c.cls || ""].join(" ").trim() || null, title: c.help || null, scope: "col" });
        if (sorted) th.setAttribute("aria-sort", state.sort.dir > 0 ? "ascending" : "descending");
        th.append(c.sortable === false ? c.label : h("button", { type: "button", "data-sort": c.key, text: c.label }));
        return th;
      })
    )
  );

  const rows = sortedList(list).map((v, i) =>
    h(
      "tr",
      {},
      cols.map((c) => {
        if (c.key === "rank") return h("td", { class: "num rank", text: String(i + 1) });
        if (c.key === "title") {
          return h(
            "td",
            { class: "col-title" },
            h(
              "div",
              { class: "vid" },
              v.thumbnail ? h("img", { src: v.thumbnail, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
              h("a", { href: videoUrl(v.id), target: "_blank", rel: "noopener noreferrer", text: v.title, title: v.title })
            )
          );
        }
        if (c.key === "relMedian") {
          const r = v.relMedian;
          const cls = r >= 2 ? "hot" : r != null && r < 0.5 ? "cool" : null;
          return h("td", { class: `num ${cls || ""}`.trim(), text: `${r >= 2 ? "▲ " : ""}${fmtTimes(r)}` });
        }
        return h("td", { class: c.num ? "num" : null, text: c.fmt ? c.fmt(v) : v[c.key] ?? "–" });
      })
    )
  );
  $("tbody", table).replaceChildren(...rows);
}

/* ── CSV 내보내기 ───────────────────────────────────────── */
function exportCsv() {
  const list = sortedList(state.list);
  if (!list.length) return;
  const cols = [
    ["영상 ID", (v) => v.id],
    ["제목", (v) => v.title],
    ["채널", (v) => v.channelTitle],
    ["게시일(KST)", (v) => fmtDateTime(v.t)],
    ["길이(초)", (v) => v.durationSec],
    ["조회수", (v) => v.views],
    ["좋아요", (v) => v.likes],
    ["댓글", (v) => v.comments],
    ["참여율(%)", (v) => (v.engagement == null ? "" : (v.engagement * 100).toFixed(3))],
    ["일평균 조회수", (v) => Math.round(v.viewsPerDay)],
    ["구독자 대비(%)", (v) => (v.subRatio == null ? "" : (v.subRatio * 100).toFixed(2))],
    ["중앙값 대비(배)", (v) => (v.relMedian == null ? "" : v.relMedian.toFixed(2))],
    ["태그", (v) => v.tags.join(" | ")],
    ["URL", (v) => videoUrl(v.id)],
  ];
  const cell = (val) => {
    if (val == null) return "";
    let str = String(val);
    // 엑셀 수식 주입 방지: =, +, -, @ 로 시작하는 글자는 앞에 ' 를 붙인다
    if (typeof val === "string" && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [cols.map(([name]) => cell(name)).join(","), ...list.map((v) => cols.map(([, get]) => cell(get(v))).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const name = state.data.kind === "channel" ? state.data.channel.title : state.data.query;
  const p = kst(Date.now());
  const a = h("a", { href: URL.createObjectURL(blob), download: `youtube_${name.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40)}_${p.y}${pad2(p.m)}${pad2(p.d)}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── 최근 조회 (이 브라우저에만 저장) ───────────────────── */
function loadRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function rememberQuery(kind, params) {
  const entry = { kind, params };
  const list = [entry, ...loadRecent().filter((e) => !(e.kind === kind && e.params.q === params.q))].slice(0, 6);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 저장 불가 환경이면 무시 */
  }
  renderRecent();
}
function renderRecent() {
  const items = loadRecent().filter((e) => e.kind === state.mode);
  const box = $("#recent");
  box.replaceChildren(
    ...(items.length ? [h("span", { class: "label", text: "최근" })] : []),
    ...items.map((e) =>
      h("button", {
        type: "button",
        class: "chip",
        text: e.params.q,
        onclick: () => {
          const form = $(`#form-${e.kind}`);
          for (const [k, v] of Object.entries(e.params)) if (form.elements[k]) form.elements[k].value = v;
          runQuery(e.kind, e.params);
        },
      })
    )
  );
}

/* ── 이벤트 연결 ────────────────────────────────────────── */
function setMode(mode) {
  state.mode = mode;
  for (const tab of $$(".tabs [data-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  for (const node of $$(".query [data-mode]")) node.hidden = node.dataset.mode !== mode;
  setMessage("");
  renderRecent();
  $(`#form-${mode} input[name=q]`).focus();
}

function init() {
  for (const tab of $$(".tabs [data-mode]")) tab.addEventListener("click", () => setMode(tab.dataset.mode));

  for (const form of $$(".query form")) {
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      const params = Object.fromEntries(new FormData(form));
      params.q = params.q.trim();
      if (!params.q) return;
      runQuery(form.dataset.mode, params);
    });
  }

  for (const group of $$(".seg[data-filter]")) {
    group.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button[data-value]");
      if (!btn) return;
      state.filters[group.dataset.filter] = btn.dataset.value;
      syncFilterButtons();
      renderAll();
    });
  }
  $("#filterText").addEventListener(
    "input",
    debounce((evt) => {
      state.filters.text = evt.target.value;
      renderAll();
    }, 180)
  );
  $("#exportCsv").addEventListener("click", exportCsv);

  $("#trendMetric").addEventListener("change", (evt) => {
    state.trendMetric = evt.target.value;
    drawCard("trend", state.list);
  });
  $("#trendLog").addEventListener("change", (evt) => {
    state.trendLog = evt.target.checked;
    drawCard("trend", state.list);
  });

  for (const btn of $$("[data-toggle-table]")) {
    btn.addEventListener("click", () => {
      const id = btn.closest(".chart-card").id.replace("card-", "");
      state.tableView.has(id) ? state.tableView.delete(id) : state.tableView.add(id);
      drawCard(id, state.list);
    });
  }

  $("#videoTable thead").addEventListener("click", (evt) => {
    const btn = evt.target.closest("button[data-sort]");
    if (!btn) return;
    const key = btn.dataset.sort;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: key === "title" || key === "channelTitle" ? 1 : -1 };
    renderTable(state.list);
  });

  let lastWidth = 0;
  new ResizeObserver(
    debounce((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastWidth && state.list.length && !$("#charts").hidden) {
        lastWidth = w;
        renderCharts(state.list);
      }
    }, 150)
  ).observe($("#charts"));
  window.addEventListener("scroll", hideTip, { passive: true });

  renderRecent();
  checkStatus();
}

init();
