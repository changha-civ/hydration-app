import { useState, useEffect, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
//  MY DAILY HYDRATION BOOST — 기상청 API 연동 스마트 수분 케어 앱
// ══════════════════════════════════════════════════════════════════

// ─── 상수 ────────────────────────────────────────────────────────
const ML_PER_KG = 30;
const GLASS_ML = 200;
const BASE_POINTS = 100;

// ─── 날짜 유틸 ───────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const todayYMD = () => today().replace(/-/g, "");
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" });

// ─── 기상청 Lambert CC 격자 변환 (위경도 → nx, ny) ────────────────
function kmaGrid(lat, lon) {
  const D = Math.PI / 180;
  const RE = 6371.00877, GRID = 5;
  const S1 = 30 * D, S2 = 60 * D, OLON = 126 * D, OLAT = 38 * D;
  const [XO, YO] = [43, 136];
  const re = RE / GRID;
  const sn =
    Math.log(Math.cos(S1) / Math.cos(S2)) /
    Math.log(Math.tan(D * 45 + S2 / 2) / Math.tan(D * 45 + S1 / 2));
  const sf = (Math.pow(Math.tan(D * 45 + S1 / 2), sn) * Math.cos(S1)) / sn;
  const ro = (re * sf) / Math.pow(Math.tan(D * 45 + OLAT / 2), sn);
  const ra = (re * sf) / Math.pow(Math.tan(D * 45 + (lat * D) / 2), sn);
  let theta = (lon * D - OLON) * sn;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

// ─── 기상청 단기예보 API ──────────────────────────────────────────
async function fetchKMA(apiKey, nx, ny) {
  const h = new Date().getHours();
  const baseH = [2, 5, 8, 11, 14, 17, 20, 23].reduce((a, b) => (h >= b ? b : a), 2);
  const base_time = String(baseH).padStart(2, "0") + "00";
  const params = new URLSearchParams({
    serviceKey: apiKey,
    pageNo: 1, numOfRows: 1000, dataType: "JSON",
    base_date: todayYMD(), base_time, nx, ny,
  });
  const res = await fetch(
    `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${params}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const code = data?.response?.header?.resultCode;
  if (code !== "00") throw new Error(data?.response?.header?.resultMsg || "API 오류");
  const items = data.response.body.items.item;
  const get = (c) => { const i = items.find((x) => x.category === c); return i ? +i.fcstValue : null; };
  const tmx = items.find((x) => x.category === "TMX");
  return {
    maxTemp: tmx ? +tmx.fcstValue : (get("TMP") ?? 25),
    humidity: get("REH") ?? 60,
    sky: get("SKY") ?? 1,
    pty: get("PTY") ?? 0,
    source: "기상청",
  };
}

// ─── Open-Meteo (CORS 친화적 대체 API) ───────────────────────────
async function fetchOpenMeteo(lat, lon) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code` +
    `&daily=temperature_2m_max&timezone=Asia%2FSeoul&forecast_days=1`;
  const d = await (await fetch(url)).json();
  const wmo = d.current?.weather_code ?? 0;
  const isRain = wmo >= 51 && wmo <= 82;
  const isSnow = wmo >= 71 && wmo <= 77;
  return {
    maxTemp: d.daily?.temperature_2m_max?.[0] ?? 25,
    humidity: d.current?.relative_humidity_2m ?? 60,
    tempNow: d.current?.temperature_2m ?? 22,
    sky: wmo >= 3 ? 4 : wmo >= 1 ? 3 : 1,
    pty: isRain ? (isSnow ? 3 : 1) : 0,
    source: "Open-Meteo",
  };
}

// ─── 스마트 목표량 계산 ───────────────────────────────────────────
function calcGoal(weight, w) {
  const base = Math.max(weight * ML_PER_KG, 1500);
  let extra = 0, bonus = 1.0, note = "체중 기반 표준 권장량", emoji = "💧";
  if (w) {
    const { maxTemp: t, humidity: h, pty: p } = w;
    if (t >= 33) { extra = 600; bonus = 1.5; note = "폭염경보! 평소보다 600ml 추가 섭취 권장"; emoji = "🌡️"; }
    else if (t >= 28) { extra = 400; bonus = 1.3; note = "폭염주의보! 평소보다 400ml 추가 권장"; emoji = "☀️"; }
    if (h < 30) { extra += 200; bonus = Math.max(bonus, 1.2); note += (note.includes("폭염") ? " + " : "") + "건조주의보 +200ml"; if (emoji === "💧") emoji = "💨"; }
    if (p > 0 && bonus === 1.0) { bonus = 1.2; note = "비 오는 날도 수분 보충 필수! ×1.2 보너스"; emoji = "🌧️"; }
  }
  return { goal: base + extra, base, extra, bonus, note, emoji };
}

// ─── 날씨 테마 ────────────────────────────────────────────────────
function getTheme(w) {
  if (!w) return { g1: "#060d1a", g2: "#0c4a6e", w1: "#38bdf8", w2: "#0369a1", glow: "#38bdf8", skyLabel: "—", icon: "☀️", sweat: false, dry: false };
  const { maxTemp: t, pty: p, humidity: h } = w;
  if (p === 1 || p === 4) return { g1: "#060d1a", g2: "#1e3a5f", w1: "#60a5fa", w2: "#1d4ed8", glow: "#60a5fa", skyLabel: "비", icon: "🌧️", sweat: false, dry: false };
  if (p === 3)            return { g1: "#060d1a", g2: "#1a2f4a", w1: "#bfdbfe", w2: "#2563eb", glow: "#bfdbfe", skyLabel: "눈", icon: "❄️", sweat: false, dry: false };
  if (t >= 33)            return { g1: "#1a0505", g2: "#7c2d12", w1: "#bae6fd", w2: "#0284c7", glow: "#f97316", skyLabel: "폭염경보", icon: "🌡️", sweat: true, dry: false };
  if (t >= 28)            return { g1: "#150a00", g2: "#6b3500", w1: "#7dd3fa", w2: "#0369a1", glow: "#fb923c", skyLabel: "폭염", icon: "☀️", sweat: true, dry: false };
  if (h < 30)             return { g1: "#140e00", g2: "#5c3b0a", w1: "#fcd34d", w2: "#d97706", glow: "#fcd34d", skyLabel: "건조주의보", icon: "💨", sweat: false, dry: true };
  if (w.sky >= 4)         return { g1: "#0a0f17", g2: "#1e2d40", w1: "#94a3b8", w2: "#475569", glow: "#94a3b8", skyLabel: "흐림", icon: "☁️", sweat: false, dry: false };
  return { g1: "#060d1a", g2: "#0c4a6e", w1: "#38bdf8", w2: "#0369a1", glow: "#38bdf8", skyLabel: "맑음", icon: "☀️", sweat: false, dry: false };
}

// ─── 저장소 헬퍼 ─────────────────────────────────────────────────
const S = {
  async get(k, fb = null) {
    try {
      const value = localStorage.getItem(k);
      return value ? JSON.parse(value) : fb;
    } catch {
      return fb;
    }
  },
  async set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {
      console.warn("storage:", e);
    }
  },
};

// ─── CSS ──────────────────────────────────────────────────────────
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:'DM Sans',sans-serif;-webkit-font-smoothing:antialiased}
::-webkit-scrollbar{width:3px}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-radius:2px}

@keyframes spin{to{transform:rotate(360deg)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes popIn{0%{transform:scale(0.75);opacity:0}70%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
@keyframes toastIn{0%{opacity:0;transform:translateX(-50%) translateY(12px)}15%,80%{opacity:1;transform:translateX(-50%) translateY(0)}100%{opacity:0;transform:translateX(-50%) translateY(-8px)}}
@keyframes waveA{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes waveB{from{transform:rotate(0deg)}to{transform:rotate(-360deg)}}
@keyframes celebrate{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@keyframes sweatDrop{0%{opacity:0;transform:translateY(-4px)}30%{opacity:0.9}100%{opacity:0;transform:translateY(28px)}}
@keyframes dryFlicker{0%,100%{opacity:0.4}50%{opacity:0.8}}
@keyframes glowPulse{0%,100%{opacity:0.15}50%{opacity:0.3}}
@keyframes bounceIn{0%{transform:scale(0.3);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
@keyframes rippleOut{0%{transform:scale(0.5);opacity:0.8}100%{transform:scale(2.5);opacity:0}}

.fu{animation:fadeUp 0.4s ease-out both}
.pi{animation:popIn 0.45s cubic-bezier(.34,1.56,.64,1) both}
.btn{cursor:pointer;transition:all 0.15s ease}
.btn:hover{filter:brightness(1.12)}
.btn:active{transform:scale(0.93)}
input:focus,textarea:focus{outline:none}
`;

// ══════════════════════════════════════════════════════════════════
//  종이컵 SVG 컴포넌트 (날씨 반응형)
// ══════════════════════════════════════════════════════════════════
function WaterCup({ pct, theme, intake, goal }) {
  const fill = Math.min(pct / 100, 1);
  const W = 160, H = 220;

  return (
    <div style={{ position: "relative", width: W, height: H + 20 }}>
      {/* 글로우 효과 */}
      <div style={{
        position: "absolute", top: "35%", left: "50%", transform: "translateX(-50%)",
        width: W * 1.4, height: H * 0.5,
        background: theme.w1,
        filter: "blur(44px)",
        opacity: 0.1 + fill * 0.22,
        borderRadius: "50%",
        transition: "opacity 0.8s ease",
        pointerEvents: "none",
        animation: fill > 0 ? "glowPulse 3s ease-in-out infinite" : "none",
      }} />

      {/* 컵 내부 물 채움 영역 */}
      <div style={{
        position: "absolute", top: 0, left: 0, width: W, height: H,
        clipPath: "polygon(8% 0%, 92% 0%, 80% 100%, 20% 100%)",
        overflow: "hidden",
      }}>
        {/* 유리 배경 */}
        <div style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.04)" }} />
        {/* 물 채움 */}
        {fill > 0 && (
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            height: `${fill * 100}%`,
            transition: "height 0.9s cubic-bezier(0.34,1.56,0.64,1)",
            overflow: "hidden",
          }}>
            <div style={{ position: "absolute", inset: 0, background: theme.w2 }} />
            {/* 파도 A */}
            <div style={{
              position: "absolute", top: "-52%", left: "-10%",
              width: "120%", height: "100%",
              background: theme.w1,
              borderRadius: "42%",
              opacity: 0.55,
              animation: "waveA 4.2s linear infinite",
              transformOrigin: "center center",
            }} />
            {/* 파도 B */}
            <div style={{
              position: "absolute", top: "-48%", left: "-5%",
              width: "110%", height: "100%",
              background: theme.w1,
              borderRadius: "38%",
              opacity: 0.38,
              animation: "waveB 5.8s linear infinite",
              transformOrigin: "center center",
            }} />
            {/* 폭염 시 얼음 효과 */}
            {theme.sweat && fill > 0 && (
              <div style={{
                position: "absolute", top: "15%", left: "20%",
                fontSize: 14, opacity: 0.65, userSelect: "none",
              }}>🧊</div>
            )}
          </div>
        )}
      </div>

      {/* SVG 컵 외형 */}
      <svg
        style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" }}
        viewBox={`0 0 ${W} ${H}`} width={W} height={H}
      >
        <defs>
          <linearGradient id="glassShine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(255,255,255,0.22)" />
            <stop offset="40%" stopColor="rgba(255,255,255,0.04)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.1)" />
          </linearGradient>
        </defs>
        {/* 컵 몸체 */}
        <path
          d={`M${W * 0.08},2 L${W * 0.92},2 L${W * 0.80},${H - 2} L${W * 0.20},${H - 2} Z`}
          fill="url(#glassShine)"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="1.8"
        />
        {/* 컵 상단 테두리 */}
        <line x1={W * 0.06} y1="1" x2={W * 0.94} y2="1" stroke="rgba(255,255,255,0.85)" strokeWidth="3" strokeLinecap="round" />
        {/* 유리 반사 */}
        <path d={`M${W * 0.13},${H * 0.08} Q${W * 0.17},${H * 0.28} ${W * 0.21},${H * 0.46}`}
          fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="5" strokeLinecap="round" />

        {/* 🌡️ 폭염 땀 방울 */}
        {theme.sweat && (
          <>
            <circle cx={W * 0.04} cy={H * 0.25} r="3.5" fill="#93c5fd" opacity="0.7" style={{ animation: "sweatDrop 2s ease-in 0s infinite" }} />
            <circle cx={W * 0.96} cy={H * 0.35} r="2.5" fill="#93c5fd" opacity="0.6" style={{ animation: "sweatDrop 2s ease-in 0.7s infinite" }} />
            <circle cx={W * 0.03} cy={H * 0.55} r="2" fill="#93c5fd" opacity="0.5" style={{ animation: "sweatDrop 2.4s ease-in 1.2s infinite" }} />
            <circle cx={W * 0.97} cy={H * 0.6} r="3" fill="#93c5fd" opacity="0.65" style={{ animation: "sweatDrop 2s ease-in 1.8s infinite" }} />
          </>
        )}

        {/* 💨 건조 균열 효과 */}
        {theme.dry && (
          <>
            <path d={`M${W * 0.4},${H * 0.3} L${W * 0.46},${H * 0.38} L${W * 0.44},${H * 0.45}`}
              fill="none" stroke="rgba(251,191,36,0.45)" strokeWidth="1.5" strokeLinecap="round"
              style={{ animation: "dryFlicker 2.5s ease-in-out infinite" }} />
            <path d={`M${W * 0.55},${H * 0.5} L${W * 0.5},${H * 0.6}`}
              fill="none" stroke="rgba(251,191,36,0.35)" strokeWidth="1"
              style={{ animation: "dryFlicker 3s ease-in-out 0.8s infinite" }} />
          </>
        )}
      </svg>

      {/* 텍스트 오버레이 */}
      <div style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        textAlign: "center", pointerEvents: "none", zIndex: 2,
      }}>
        <p style={{
          fontFamily: "Nunito, sans-serif", fontSize: 40, fontWeight: 900,
          color: "white", lineHeight: 1,
          textShadow: "0 2px 10px rgba(0,0,0,0.65), 0 0 24px rgba(0,0,0,0.4)",
        }}>{Math.round(pct)}%</p>
        <p style={{
          fontFamily: "DM Sans, sans-serif", fontSize: 13, fontWeight: 500,
          color: "rgba(255,255,255,0.7)",
          textShadow: "0 1px 6px rgba(0,0,0,0.8)",
          marginTop: 3,
        }}>{intake.toLocaleString()}ml / {goal.toLocaleString()}ml</p>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  메인 앱
// ══════════════════════════════════════════════════════════════════
export default function App() {
  const KMA_API_KEY = import.meta.env.VITE_KMA_API_KEY || "";
  const [screen, setScreen] = useState("loading");
  const [profile, setProfile] = useState({ name: "", weight: 65 });
  const [nameVal, setNameVal] = useState("");
  const [weightVal, setWeightVal] = useState("65");
  const [daily, setDaily] = useState({ intake: 0, goal: 2000, bonus: 1.0, bonusEarned: false, earnedPts: 0 });
  const [totalPts, setTotalPts] = useState(0);
  const [weather, setWeather] = useState(null);
  const [goalCalc, setGoalCalc] = useState(null);
  const [savedApiKey, setSavedApiKey] = useState(KMA_API_KEY);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState([]);
  const [notifEnabled, setNotifEnabled] = useState(false);
  const [ripple, setRipple] = useState(false);

  const theme = getTheme(weather);
  const totalPtsRef = useRef(0);
  const notifRef = useRef(null);
  const toastTimer = useRef(null);

  // ── CSS 주입 ────────────────────────────────────────────────────
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = GLOBAL_CSS;
    document.head.appendChild(el);
    return () => document.head.removeChild(el);
  }, []);

  useEffect(() => { totalPtsRef.current = totalPts; }, [totalPts]);

  // ── 앱 초기화 ───────────────────────────────────────────────────
  useEffect(() => { initApp(); }, []);

  async function initApp() {
    const [prof, pts, hist, prevDay] = await Promise.all([
      S.get("hyd:profile"), S.get("hyd:totalPts", 0),
      S.get("hyd:history", []),
      S.get("hyd:currentDay", ""),
    ]);
    setTotalPts(pts);
    totalPtsRef.current = pts;
    setSavedApiKey(KMA_API_KEY);
    setHistory(hist);

    const curDay = today();
    // 날짜 변경 시 이전 기록 히스토리에 저장
    if (prevDay && prevDay !== curDay) {
      const old = await S.get(`hyd:day:${prevDay}`);
      if (old && old.intake > 0) {
        const entry = { date: prevDay, intake: old.intake, goal: old.goal, earnedPts: old.earnedPts || 0, completed: old.bonusEarned || false };
        const newHist = [entry, ...hist].slice(0, 30);
        await S.set("hyd:history", newHist);
        setHistory(newHist);
      }
    }
    await S.set("hyd:currentDay", curDay);

    if (prof) {
      setProfile(prof);
      setNameVal(prof.name);
      setWeightVal(String(prof.weight));
      const todayData = await S.get(`hyd:day:${curDay}`);
      if (todayData) {
        setDaily(todayData);
      } else {
        const gc = calcGoal(prof.weight, null);
        const init = { intake: 0, goal: gc.goal, bonus: 1.0, bonusEarned: false, earnedPts: 0 };
        setDaily(init);
        await S.set(`hyd:day:${curDay}`, init);
      }
      setScreen("main");
      fetchWeather(prof, key);
    } else {
      setScreen("setup");
    }
  }

  // ── 날씨 가져오기 ───────────────────────────────────────────────
  async function fetchWeather(prof, key) {
    setWeatherLoading(true);
    let wData = null;
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation
          ? navigator.geolocation.getCurrentPosition(res, rej, { timeout: 7000 })
          : rej(new Error("no geo"))
      );
      const { latitude: lat, longitude: lon } = pos.coords;
      if (key && key.trim().length > 20) {
        try {
          const grid = kmaGrid(lat, lon);
          wData = await fetchKMA(key.trim(), grid.nx, grid.ny);
        } catch (e) {
          console.warn("기상청 API 실패 → Open-Meteo 대체:", e.message);
          wData = await fetchOpenMeteo(lat, lon);
          wData._kmaFailed = true;
        }
      } else {
        wData = await fetchOpenMeteo(lat, lon);
      }
    } catch {
      try {
        wData = await fetchOpenMeteo(37.5665, 126.978); // 서울 기본값
        wData._isDefault = true;
      } catch {
        wData = { maxTemp: 25, humidity: 60, sky: 1, pty: 0, source: "기본값" };
      }
    }
    setWeather(wData);
    if (wData) {
      const gc = calcGoal(prof.weight, wData);
      setGoalCalc(gc);
      setDaily((prev) => {
        if (prev.bonusEarned) return prev;
        const next = { ...prev, goal: gc.goal, bonus: gc.bonus };
        S.set(`hyd:day:${today()}`, next);
        return next;
      });
    }
    setWeatherLoading(false);
  }

  // ── 물 추가 / 수정 ───────────────────────────────────────────────
  function addWater(ml) {
    setRipple(true);
    setTimeout(() => setRipple(false), 700);
    setDaily((prev) => {
      const newIntake = prev.intake + ml;
      const justDone = !prev.bonusEarned && newIntake >= prev.goal;
      let earnedPts = prev.earnedPts;
      if (justDone) {
        earnedPts = Math.round(BASE_POINTS * prev.bonus);
        const newTotal = totalPtsRef.current + earnedPts;
        setTotalPts(newTotal);
        totalPtsRef.current = newTotal;
        S.set("hyd:totalPts", newTotal);
        showToast(`🎉 목표 달성! +${earnedPts}포인트 (×${prev.bonus})`);
        sendNotif("🎉 수분 목표 달성!", `오늘의 목표를 완료했어요! ${earnedPts}포인트 획득`);
        // 히스토리 저장
        setTimeout(() => saveHistory(newIntake, prev.goal, earnedPts, true), 100);
      } else if (!prev.bonusEarned) {
        const pct = Math.round((newIntake / prev.goal) * 100);
        showToast(`+${ml}ml 💧  ${pct}% — ${Math.max(prev.goal - newIntake, 0).toLocaleString()}ml 남음`);
      } else {
        showToast(`+${ml}ml 추가 💧`);
      }
      const next = { ...prev, intake: newIntake, bonusEarned: prev.bonusEarned || justDone, earnedPts };
      S.set(`hyd:day:${today()}`, next);
      return next;
    });
  }

  function rollbackPointsIfNeeded(prev, nextIntake) {
    if (!prev.bonusEarned || nextIntake >= prev.goal || !prev.earnedPts) {
      return { earnedPts: prev.earnedPts, bonusEarned: prev.bonusEarned };
    }

    const newTotal = Math.max(totalPtsRef.current - prev.earnedPts, 0);
    setTotalPts(newTotal);
    totalPtsRef.current = newTotal;
    S.set("hyd:totalPts", newTotal);

    setHistory((oldHistory) => {
      const nextHistory = oldHistory.filter((h) => h.date !== today());
      S.set("hyd:history", nextHistory);
      return nextHistory;
    });

    return { earnedPts: 0, bonusEarned: false };
  }

  function removeWater(ml) {
    setDaily((prev) => {
      const newIntake = Math.max(prev.intake - ml, 0);
      const rollback = rollbackPointsIfNeeded(prev, newIntake);
      const next = { ...prev, intake: newIntake, ...rollback };
      S.set(`hyd:day:${today()}`, next);
      showToast(`-${ml}ml 되돌림 ↩️`);
      return next;
    });
  }

  function resetWater() {
    setDaily((prev) => {
      const rollback = rollbackPointsIfNeeded(prev, 0);
      const next = { ...prev, intake: 0, ...rollback };
      S.set(`hyd:day:${today()}`, next);
      showToast("오늘 섭취량을 초기화했어요 ↩️");
      return next;
    });
  }

  async function saveHistory(intake, goal, earnedPts, completed) {
    const entry = { date: today(), intake, goal, earnedPts, completed };
    setHistory((prev) => {
      const newHist = [entry, ...prev.filter((h) => h.date !== today())].slice(0, 30);
      S.set("hyd:history", newHist);
      return newHist;
    });
  }

  // ── 알림 ────────────────────────────────────────────────────────
  async function toggleNotif() {
    if (!("Notification" in window)) { showToast("이 환경에서는 알림이 지원되지 않아요"); return; }
    if (notifEnabled) {
      clearInterval(notifRef.current);
      setNotifEnabled(false);
      showToast("알림이 꺼졌어요");
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      setNotifEnabled(true);
      // 4시간 정기 알림
      notifRef.current = setInterval(() => {
        setDaily((prev) => {
          if (!prev.bonusEarned) sendNotif("💧 수분 보충 시간!", `${prev.intake}ml 완료 — 목표까지 ${Math.max(prev.goal - prev.intake, 0).toLocaleString()}ml 남았어요!`);
          return prev;
        });
      }, 4 * 60 * 60 * 1000);
      showToast("✅ 알림 활성화! 4시간마다 리마인드");
    } else { showToast("알림 권한이 거부됐어요"); }
  }

  // 오후 6시 특별 알림
  useEffect(() => {
    const check = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 18 && now.getMinutes() === 0) {
        setDaily((prev) => {
          if (!prev.bonusEarned)
            sendNotif("⏰ 오후 6시 수분 정산!", `오늘 ${prev.intake.toLocaleString()}ml / 목표 ${prev.goal.toLocaleString()}ml — ${Math.max(prev.goal - prev.intake, 0).toLocaleString()}ml 더 마셔보세요!`);
          return prev;
        });
      }
    }, 58000);
    return () => clearInterval(check);
  }, []);

  function sendNotif(title, body) {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
  }

  // ── 토스트 ──────────────────────────────────────────────────────
  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2800);
  }

  // ── 설정 저장 ───────────────────────────────────────────────────
  async function completeSetup() {
    const w = parseFloat(weightVal);
    if (!nameVal.trim() || !w || w < 20 || w > 300) { showToast("이름과 체중(20~300kg)을 입력하세요"); return; }
    const prof = { name: nameVal.trim(), weight: w };
    await S.set("hyd:profile", prof);
    setProfile(prof);
    const gc = calcGoal(w, null);
    const init = { intake: 0, goal: gc.goal, bonus: 1.0, bonusEarned: false, earnedPts: 0 };
    setDaily(init);
    await S.set(`hyd:day:${today()}`, init);
    setScreen("main");
    fetchWeather(prof, KMA_API_KEY);
    showToast(`환영해요, ${prof.name}님! 오늘도 수분 충전 💧`);
  }

  async function saveSettings() {
    const w = parseFloat(weightVal);
    if (!w || w < 20 || w > 300) { showToast("올바른 체중을 입력해주세요"); return; }
    const prof = { name: nameVal.trim() || profile.name, weight: w };
    await S.set("hyd:profile", prof);
    setProfile(prof);
    setSavedApiKey(KMA_API_KEY);
    if (weather) {
      const gc = calcGoal(w, weather);
      setGoalCalc(gc);
      setDaily((prev) => {
        const next = { ...prev, goal: gc.goal, bonus: gc.bonus };
        S.set(`hyd:day:${today()}`, next);
        return next;
      });
    }
    showToast("💾 설정이 저장됐어요!");
    fetchWeather(prof, KMA_API_KEY);
  }

  // ── 파생 값 ─────────────────────────────────────────────────────
  const pct = daily.goal > 0 ? Math.min((daily.intake / daily.goal) * 100, 100) : 0;
  const remaining = Math.max(daily.goal - daily.intake, 0);
  const bgStyle = { background: `linear-gradient(160deg, ${theme.g1} 0%, ${theme.g2} 100%)` };

  // ══════════════════════════════════════════════════════════════════
  //  렌더링
  // ══════════════════════════════════════════════════════════════════

  // ── 로딩 ──────────────────────────────────────────────────────
  if (screen === "loading") return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#060d1a", flexDirection: "column", gap: 16 }}>
      <div style={{ width: 48, height: 48, border: "3px solid rgba(56,189,248,0.2)", borderTopColor: "#38bdf8", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 14, fontFamily: "DM Sans, sans-serif" }}>불러오는 중...</p>
    </div>
  );

  // ── 온보딩 ────────────────────────────────────────────────────
  if (screen === "setup") return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(160deg, #060d1a 0%, #0c4a6e 100%)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="pi" style={{ width: "100%", maxWidth: 420, background: "rgba(255,255,255,0.07)", backdropFilter: "blur(24px)", borderRadius: 28, padding: 36, border: "1px solid rgba(255,255,255,0.1)" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontSize: 80, marginBottom: 14, filter: "drop-shadow(0 0 32px rgba(56,189,248,0.5))" }}>💧</div>
          <h1 style={{ fontFamily: "Nunito, sans-serif", fontSize: 26, fontWeight: 900, color: "white", marginBottom: 10 }}>My Daily Hydration Boost</h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 14, lineHeight: 1.6 }}>기상청 API 연동 스마트 수분 케어<br />체중 + 날씨로 최적 수분량을 계산해드려요</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <label style={lblStyle}>이름</label>
            <input value={nameVal} onChange={(e) => setNameVal(e.target.value)} placeholder="이름을 입력하세요" style={inputStyle} />
          </div>
          <div>
            <label style={lblStyle}>체중 (kg)</label>
            <input value={weightVal} onChange={(e) => setWeightVal(e.target.value)} type="number" min="20" max="300" placeholder="예: 65"
              onKeyDown={(e) => e.key === "Enter" && completeSetup()} style={inputStyle} />
            {weightVal && !isNaN(parseFloat(weightVal)) && parseFloat(weightVal) >= 20 && (
              <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 6, paddingLeft: 2 }}>
                기본 권장량: <strong style={{ color: "rgba(255,255,255,0.65)" }}>{Math.max(parseFloat(weightVal) * ML_PER_KG, 1500).toLocaleString()}ml</strong>/일
              </p>
            )}
          </div>
          <button onClick={completeSetup} className="btn" style={primaryBtn}>시작하기 →</button>
        </div>
      </div>
      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );

  // ── 메인 / 히스토리 / 설정 공통 레이아웃 ─────────────────────
  return (
    <div style={{ minHeight: "100vh", ...bgStyle, fontFamily: "'DM Sans', sans-serif", transition: "background 1.2s ease", paddingBottom: 80 }}>
      {toast && <div style={toastStyle}>{toast}</div>}

      {/* ━━ 메인 화면 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {screen === "main" && (
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 20px" }}>

          {/* 헤더 */}
          <div className="fu" style={{ paddingTop: 52, paddingBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>{fmtDate(today())}</p>
              <h2 style={{ fontFamily: "Nunito, sans-serif", fontSize: 22, fontWeight: 900, color: "white", marginTop: 2 }}>
                안녕하세요, {profile.name}님 👋
              </h2>
            </div>
            <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 16, padding: "10px 14px", textAlign: "center", border: "1px solid rgba(255,255,255,0.12)", backdropFilter: "blur(12px)", flexShrink: 0 }}>
              <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>포인트</p>
              <p style={{ fontFamily: "Nunito, sans-serif", fontSize: 20, fontWeight: 900, color: "#fcd34d" }}>⭐ {totalPts.toLocaleString()}</p>
            </div>
          </div>

          {/* 날씨 카드 */}
          <div className="fu" style={glassCard}>
            {weatherLoading ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,0.15)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>날씨 데이터 로딩 중...</span>
              </div>
            ) : weather ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 36 }}>{theme.icon}</span>
                  <div>
                    <p style={{ color: "white", fontFamily: "Nunito, sans-serif", fontWeight: 800, fontSize: 17 }}>{theme.skyLabel}</p>
                    <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 2 }}>
                      {weather.source}{weather._isDefault ? " (서울 기준)" : ""}
                      {weather._kmaFailed ? " (Open-Meteo 대체)" : ""}
                       · 습도 {weather.humidity}%
                    </p>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <p style={{ fontFamily: "Nunito, sans-serif", fontSize: 34, fontWeight: 900, color: "white" }}>{weather.maxTemp}°</p>
                  <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>최고 기온</p>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13 }}>날씨 정보 없음</p>
                <button onClick={() => fetchWeather(profile, savedApiKey)} className="btn"
                  style={{ padding: "6px 14px", background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 8, color: "white", fontSize: 12 }}>
                  재시도
                </button>
              </div>
            )}
          </div>

          {/* 스마트 목표 배너 (날씨 보정 시에만) */}
          {goalCalc && (goalCalc.extra > 0 || goalCalc.bonus > 1.0) && (
            <div className="fu" style={{
              background: `rgba(${goalCalc.bonus >= 1.5 ? "239,68,68" : goalCalc.bonus >= 1.3 ? "249,115,22" : "96,165,250"},0.18)`,
              border: `1px solid rgba(${goalCalc.bonus >= 1.5 ? "239,68,68" : goalCalc.bonus >= 1.3 ? "249,115,22" : "96,165,250"},0.35)`,
              borderRadius: 16, padding: "13px 16px", marginBottom: 14, backdropFilter: "blur(10px)",
            }}>
              <p style={{ color: "white", fontSize: 14, fontWeight: 600 }}>{goalCalc.emoji} {goalCalc.note}</p>
              {goalCalc.extra > 0 && (
                <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 5 }}>
                  기본 {goalCalc.base.toLocaleString()}ml + 날씨 보정 +{goalCalc.extra}ml = 오늘 목표 <strong style={{ color: "white" }}>{goalCalc.goal.toLocaleString()}ml</strong>
                </p>
              )}
              {goalCalc.bonus > 1.0 && (
                <p style={{ color: "#fcd34d", fontSize: 12, marginTop: 4 }}>🌟 포인트 배수 ×{goalCalc.bonus} 적용</p>
              )}
            </div>
          )}

          {/* 목표 달성 배너 */}
          {daily.bonusEarned && (
            <div style={{ background: "rgba(16,185,129,0.2)", border: "1px solid rgba(16,185,129,0.35)", borderRadius: 16, padding: "14px 20px", marginBottom: 14, textAlign: "center", backdropFilter: "blur(10px)", animation: "celebrate 3s ease-in-out infinite" }}>
              <p style={{ fontFamily: "Nunito, sans-serif", fontSize: 20, fontWeight: 900, color: "#6ee7b7" }}>🎉 오늘 목표 달성!</p>
              <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 4 }}>+{daily.earnedPts}포인트 획득 (×{daily.bonus} 날씨 배수)</p>
            </div>
          )}

          {/* 종이컵 게이지 */}
          <div style={{ display: "flex", justifyContent: "center", margin: "10px 0 20px", position: "relative" }}>
            {ripple && (
              <div style={{
                position: "absolute", width: 80, height: 80, borderRadius: "50%",
                border: `2px solid ${theme.w1}`, top: "50%", left: "50%",
                transform: "translate(-50%, -50%)",
                animation: "rippleOut 0.7s ease-out forwards",
                pointerEvents: "none",
              }} />
            )}
            <WaterCup pct={pct} theme={theme} intake={daily.intake} goal={daily.goal} />
          </div>

          {/* 통계 3칸 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
            {[
              { label: "마신 양", val: `${daily.intake.toLocaleString()}ml`, sub: `${Math.floor(daily.intake / GLASS_ML)}잔`, c: theme.w1 },
              { label: "오늘 목표", val: `${daily.goal.toLocaleString()}ml`, sub: `${profile.weight}kg 기준`, c: "rgba(255,255,255,0.9)" },
              { label: "남은 양", val: remaining > 0 ? `${remaining.toLocaleString()}ml` : "완료!", sub: remaining > 0 ? `${Math.ceil(remaining / GLASS_ML)}잔` : "✅", c: remaining > 0 ? "rgba(255,255,255,0.9)" : "#6ee7b7" },
            ].map((s, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.07)", backdropFilter: "blur(10px)", borderRadius: 16, padding: "13px 8px", textAlign: "center", border: "1px solid rgba(255,255,255,0.09)" }}>
                <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{s.label}</p>
                <p style={{ fontFamily: "Nunito, sans-serif", fontSize: 15, fontWeight: 800, color: s.c }}>{s.val}</p>
                <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, marginTop: 2 }}>{s.sub}</p>
              </div>
            ))}
          </div>

          {/* 진행 바 */}
          <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, marginBottom: 20, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${theme.w2}, ${theme.w1})`, borderRadius: 3, transition: "width 0.8s ease", boxShadow: `0 0 10px ${theme.glow}80` }} />
          </div>

          {/* 물 섭취 버튼 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
            {[
              { ml: 200, emoji: "🥛", label: "+200ml", sub: "종이컵 1잔" },
              { ml: 500, emoji: "🍵", label: "+500ml", sub: "텀블러" },
              { ml: 1000, emoji: "💦", label: "+1,000ml", sub: "대형 물병" },
            ].map((b) => (
              <button key={b.ml} onClick={() => addWater(b.ml)} className="btn"
                style={{ padding: "16px 8px", background: "rgba(255,255,255,0.09)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 18, color: "white", backdropFilter: "blur(10px)" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.18)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.09)"; }}
              >
                <div style={{ fontSize: 28, marginBottom: 6 }}>{b.emoji}</div>
                <div style={{ fontFamily: "Nunito, sans-serif", fontSize: 14, fontWeight: 800 }}>{b.label}</div>
                <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, marginTop: 2 }}>{b.sub}</div>
              </button>
            ))}
          </div>

          {/* 되돌리기 버튼 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            <button onClick={() => removeWater(200)} className="btn"
              style={{ padding: "13px 8px", background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 16, color: "rgba(255,255,255,0.82)", backdropFilter: "blur(10px)", fontSize: 14, fontWeight: 700 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.14)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; }}
            >
              ↩️ -200ml 되돌리기
            </button>
            <button onClick={resetWater} className="btn"
              style={{ padding: "13px 8px", background: "rgba(239,68,68,0.16)", border: "1px solid rgba(248,113,113,0.28)", borderRadius: 16, color: "#fecaca", backdropFilter: "blur(10px)", fontSize: 14, fontWeight: 700 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.24)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
            >
              🧹 오늘 기록 초기화
            </button>
          </div>

          {/* 알림 버튼 */}
          <button onClick={toggleNotif} className="btn" style={{
            width: "100%", padding: 13,
            background: notifEnabled ? "rgba(16,185,129,0.15)" : "rgba(251,191,36,0.1)",
            border: `1px solid ${notifEnabled ? "rgba(16,185,129,0.3)" : "rgba(251,191,36,0.25)"}`,
            borderRadius: 14, color: notifEnabled ? "#6ee7b7" : "#fcd34d",
            fontSize: 14, fontWeight: 600, fontFamily: "DM Sans, sans-serif",
          }}>
            {notifEnabled ? "🔔 알림 켜짐 — 4시간마다 · 오후 6시 특별 알림" : "🔕 알림 활성화 (4시간 간격 + 오후 6시 정산)"}
          </button>

          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, textAlign: "center", lineHeight: 1.6, marginTop: 12 }}>
            본 서비스는 기상청 단기예보 API와 Open-Meteo 날씨 데이터를 활용합니다.
          </p>
        </div>
      )}

      {/* ━━ 히스토리 화면 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {screen === "history" && (
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "52px 20px 20px" }}>
          <h2 style={{ fontFamily: "Nunito, sans-serif", fontSize: 24, fontWeight: 900, color: "white", marginBottom: 6 }}>📅 수분 기록</h2>
          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginBottom: 20 }}>최근 30일 수분 섭취 현황</p>

          {/* 오늘 */}
          <div style={{ background: `rgba(56,189,248,0.12)`, border: "1px solid rgba(56,189,248,0.3)", borderRadius: 18, padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <p style={{ color: "#38bdf8", fontWeight: 600, fontSize: 12, marginBottom: 2 }}>오늘</p>
                <p style={{ color: "white", fontFamily: "Nunito, sans-serif", fontWeight: 800, fontSize: 20 }}>
                  {daily.intake.toLocaleString()}ml <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 14 }}>/ {daily.goal.toLocaleString()}ml</span>
                </p>
              </div>
              <div style={{ textAlign: "right" }}>
                <span style={{ fontSize: 28 }}>{daily.bonusEarned ? "✅" : "🔄"}</span>
                {daily.earnedPts > 0 && <p style={{ color: "#fcd34d", fontSize: 13, fontWeight: 700 }}>+{daily.earnedPts}pt</p>}
              </div>
            </div>
            <div style={{ height: 6, background: "rgba(255,255,255,0.1)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${theme.w2}, ${theme.w1})`, borderRadius: 3, transition: "width 0.5s ease" }} />
            </div>
          </div>

          {history.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 0", color: "rgba(255,255,255,0.3)" }}>
              <div style={{ fontSize: 52, marginBottom: 14 }}>📭</div>
              <p style={{ fontSize: 15 }}>아직 기록이 없어요</p>
              <p style={{ fontSize: 12, marginTop: 8 }}>목표를 달성하면 이곳에 기록됩니다</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {history.slice(0, 14).map((h, i) => {
                const bp = Math.min((h.intake / h.goal) * 100, 100);
                return (
                  <div key={i} style={{ background: "rgba(255,255,255,0.07)", backdropFilter: "blur(10px)", borderRadius: 16, padding: "14px 16px", border: h.completed ? "1px solid rgba(16,185,129,0.25)" : "1px solid rgba(255,255,255,0.08)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <div>
                        <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 12 }}>{fmtDate(h.date)}</p>
                        <p style={{ color: "white", fontFamily: "Nunito, sans-serif", fontWeight: 700, fontSize: 16, marginTop: 2 }}>
                          {h.intake.toLocaleString()}ml <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13 }}>/ {h.goal.toLocaleString()}ml</span>
                        </p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <span style={{ fontSize: 22 }}>{h.completed ? "✅" : "❌"}</span>
                        {h.earnedPts > 0 && <p style={{ color: "#fcd34d", fontSize: 12, marginTop: 3, fontWeight: 700 }}>+{h.earnedPts}pt</p>}
                      </div>
                    </div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${bp}%`, background: h.completed ? "linear-gradient(90deg, #10b981, #34d399)" : "linear-gradient(90deg, #38bdf8, #7dd3fa)", borderRadius: 2 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ━━ 설정 화면 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      {screen === "settings" && (
        <div style={{ maxWidth: 480, margin: "0 auto", padding: "52px 20px 20px" }}>
          <h2 style={{ fontFamily: "Nunito, sans-serif", fontSize: 24, fontWeight: 900, color: "white", marginBottom: 20 }}>⚙️ 설정</h2>

          {/* 프로필 */}
          <div style={{ ...glassCard, marginBottom: 14 }}>
            <h3 style={sectionLabel}>프로필</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={lblStyle}>이름</label>
                <input value={nameVal} onChange={(e) => setNameVal(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={lblStyle}>체중 (kg)</label>
                <input value={weightVal} onChange={(e) => setWeightVal(e.target.value)} type="number" min="20" max="300" style={inputStyle} />
              </div>
            </div>
          </div>


          <button onClick={saveSettings} className="btn" style={{ ...primaryBtn, marginBottom: 14 }}>💾 설정 저장</button>

          {/* 포인트 현황 */}
          <div style={{ ...glassCard, marginBottom: 14 }}>
            <h3 style={sectionLabel}>포인트 현황</h3>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <p style={{ fontFamily: "Nunito, sans-serif", fontSize: 46, fontWeight: 900, color: "#fcd34d", lineHeight: 1 }}>{totalPts.toLocaleString()}</p>
                <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, marginTop: 5 }}>포인트 → 지역화폐 전환 예정</p>
              </div>
              <span style={{ fontSize: 52 }}>⭐</span>
            </div>
            <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 14, padding: 14 }}>
              <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 600, marginBottom: 10 }}>날씨 배수 제도</p>
              {[
                { cond: "폭염경보 발효일", mult: "×1.5", pts: "150pt", c: "#f87171" },
                { cond: "폭염주의보 발효일", mult: "×1.3", pts: "130pt", c: "#fb923c" },
                { cond: "건조주의보 / 비 오는 날", mult: "×1.2", pts: "120pt", c: "#60a5fa" },
                { cond: "일반 (기본)", mult: "×1.0", pts: "100pt", c: "rgba(255,255,255,0.45)" },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: i < 3 ? "1px solid rgba(255,255,255,0.06)" : "none" }}>
                  <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>{r.cond}</p>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ color: r.c, fontSize: 13, fontWeight: 700 }}>{r.mult}</span>
                    <span style={{ color: "#fcd34d", fontSize: 12, fontWeight: 600 }}>{r.pts}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p style={{ color: "rgba(255,255,255,0.35)", fontSize: 11, textAlign: "center", lineHeight: 1.6, marginTop: 12 }}>
            본 서비스는 기상청 단기예보 API와 Open-Meteo 날씨 데이터를 활용합니다.
          </p>
        </div>
      )}

      {/* ━━ 하단 네비게이션 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(6,13,26,0.93)", backdropFilter: "blur(20px)", borderTop: "1px solid rgba(255,255,255,0.07)", padding: "10px 0 18px", display: "flex", justifyContent: "space-around", zIndex: 100 }}>
        {[
          { id: "main", emoji: "💧", label: "홈" },
          { id: "history", emoji: "📅", label: "기록" },
          { id: "settings", emoji: "⚙️", label: "설정" },
        ].map((tab) => (
          <button key={tab.id} onClick={() => setScreen(tab.id)} className="btn"
            style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "8px 28px", background: screen === tab.id ? "rgba(255,255,255,0.1)" : "transparent", borderRadius: 14, border: "none" }}>
            <span style={{ fontSize: 22 }}>{tab.emoji}</span>
            <span style={{ fontSize: 11, color: screen === tab.id ? "white" : "rgba(255,255,255,0.35)", fontWeight: screen === tab.id ? 700 : 400 }}>{tab.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── 공통 스타일 상수 ─────────────────────────────────────────────
const glassCard = { background: "rgba(255,255,255,0.08)", backdropFilter: "blur(20px)", borderRadius: 22, padding: "16px 20px", marginBottom: 14, border: "1px solid rgba(255,255,255,0.1)" };
const sectionLabel = { color: "rgba(255,255,255,0.55)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: 14 };
const lblStyle = { color: "rgba(255,255,255,0.6)", fontSize: 13, fontWeight: 500, display: "block", marginBottom: 7 };
const inputStyle = { width: "100%", padding: "12px 15px", background: "rgba(255,255,255,0.08)", border: "1.5px solid rgba(255,255,255,0.15)", borderRadius: 13, color: "white", fontSize: 15, transition: "border-color 0.2s" };
const primaryBtn = { width: "100%", padding: 15, background: "linear-gradient(135deg, #0ea5e9, #38bdf8)", border: "none", borderRadius: 16, color: "white", fontSize: 16, fontWeight: 800, fontFamily: "Nunito, sans-serif", boxShadow: "0 4px 22px rgba(56,189,248,0.35)" };
const toastStyle = { position: "fixed", bottom: 100, left: "50%", background: "rgba(10,20,35,0.93)", color: "white", padding: "11px 22px", borderRadius: 100, fontSize: 14, fontWeight: 600, zIndex: 9999, whiteSpace: "nowrap", animation: "toastIn 2.8s ease-in-out forwards", backdropFilter: "blur(16px)", border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 8px 32px rgba(0,0,0,0.45)" };
