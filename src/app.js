{
'use strict';
// ================= ユーティリティ =================
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
const dir16 = d => (d == null ? '—' : DIRS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16]);
const fmt = (v, digits = 1) => (v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(digits));
const WD = ['日', '月', '火', '水', '木', '金', '土'];
// 端末のタイムゾーンに関係なく JST で扱う
const jstNow = () => new Date(Date.now() + TZ_OFF_MIN * 60000).toISOString().slice(0, 16); // 表示地点の現地時刻
const minOf = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const dayLabel = ymd => { const d = new Date(ymd + 'T00:00:00Z'); return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, wd: WD[d.getUTCDay()] }; };

// 矢印：風・波は「吹いてくる/来る方向」なので進行方向(+180°)へ、潮流は流れる向きを指す
const arrow = (deg, from = true, cls = '') => deg == null ? '' :
  `<svg class="arrow ${cls}" style="transform:rotate(${(deg + (from ? 180 : 0)) % 360}deg)" aria-hidden="true"><use href="#i-arrow"/></svg>`;

const WMO = {
  0: ['快晴', 'sun'], 1: ['晴れ', 'sun'], 2: ['晴れ時々曇り', 'partly'], 3: ['曇り', 'cloud'],
  45: ['霧', 'fog'], 48: ['霧（着氷）', 'fog'], 51: ['弱い霧雨', 'rain'], 53: ['霧雨', 'rain'], 55: ['強い霧雨', 'rain'],
  56: ['着氷性の霧雨', 'rain'], 57: ['着氷性の霧雨', 'rain'], 61: ['小雨', 'rain'], 63: ['雨', 'rain'], 65: ['強い雨', 'rain'],
  66: ['みぞれ', 'snow'], 67: ['強いみぞれ', 'snow'], 71: ['小雪', 'snow'], 73: ['雪', 'snow'], 75: ['大雪', 'snow'], 77: ['霧雪', 'snow'],
  80: ['にわか雨', 'rain'], 81: ['にわか雨', 'rain'], 82: ['激しいにわか雨', 'rain'], 85: ['にわか雪', 'snow'], 86: ['強いにわか雪', 'snow'],
  95: ['雷雨', 'thunder'], 96: ['雷雨（ひょう）', 'thunder'], 99: ['激しい雷雨（ひょう）', 'thunder'],
};
const wxText = c => (WMO[c] || ['—'])[0];
const wxIcon = (c, cls = 'wx') => c == null ? '' : `<svg class="${cls}" role="img" aria-label="${esc(wxText(c))}"><use href="#i-${(WMO[c] || [0, 'cloud'])[1]}"/></svg>`;

function moonSvg(phase) { // phase 0=新月 0.5=満月
  const r = 18, c = 20;
  const lit = Math.cos(phase * 2 * Math.PI); // 1 新月, -1 満月
  const rx = Math.abs(lit) * r;
  const waxing = phase < 0.5;
  const sweepOuter = waxing ? 1 : 0;
  const sweepInner = lit > 0 ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  return `<svg class="moonicon" viewBox="0 0 40 40" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="#33464d"/>` +
    `<path d="M${c} ${c - r}A${r} ${r} 0 0 ${sweepOuter} ${c} ${c + r}A${rx} ${r} 0 0 ${sweepInner} ${c} ${c - r}z" fill="#f4e7b4"/></svg>`;
}


// ================= 状態 =================
const state = { spots: [], spotId: null, data: null, expanded: new Set(), showPast: false, loadedAt: 0 };
const spot = () => state.spots.find(s => s.id === state.spotId);
const PRESETS = [ // 概略座標
  { name: '高松', region: '香川県高松市', lat: 34.3428, lon: 134.0466 },
  { name: '丸亀', region: '香川県丸亀市', lat: 34.2897, lon: 133.7975 },
  { name: '宇野', region: '岡山県玉野市', lat: 34.4919, lon: 133.9500 },
  { name: '松山', region: '愛媛県松山市', lat: 33.8392, lon: 132.7656 },
  { name: '多度津', region: '香川県多度津町', lat: 34.2725, lon: 133.7528 },
  { name: '小豆島（土庄）', region: '香川県土庄町', lat: 34.4867, lon: 134.1856 },
];

// ================= チャート =================
const charts = new Map();
const ro = new ResizeObserver(entries => entries.forEach(en => { const f = charts.get(en.target); if (f) f(); }));
function chart(svg, draw) {
  charts.set(svg, () => { if (svg.isConnected) draw(svg, svg.clientWidth, svg.clientHeight); });
  ro.observe(svg);
  charts.get(svg)();
}
function niceStep(range, target) {
  const raw = range / target, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

// 潮位曲線。points:[{m,cm}] 0〜1440分
function drawTide(svg, W, H, t, nowMin, mini = false, sun = null) {
  if (!t || !t.points.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">潮汐データなし</text>`; return; }
  const pad = mini ? { l: 8, r: 8, t: 4, b: 15 } : { l: 38, r: 12, t: 26, b: 24 };
  const cms = t.points.map(p => p.cm);
  let lo = Math.min(...cms), hi = Math.max(...cms);
  const span = Math.max(hi - lo, 20); lo -= span * (mini ? 0.4 : 0.22); hi += span * 0.15;
  const x = m => pad.l + (W - pad.l - pad.r) * m / 1440;
  const y = cm => pad.t + (H - pad.t - pad.b) * (1 - (cm - lo) / (hi - lo));
  const line = t.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.m).toFixed(1)},${y(p.cm).toFixed(1)}`).join('');
  const area = `${line}L${x(1440)},${H - pad.b}L${x(0)},${H - pad.b}Z`;
  // 満潮・干潮の位置に、潮位点から下端まで白い破線を引く（塗りの上・曲線の下）
  const exLines = [...t.highs, ...t.lows].map(e =>
    `<line class="exline${mini ? ' mini' : ''}" x1="${x(e.m)}" x2="${x(e.m)}" y1="${y(e.cm)}" y2="${H - pad.b}"/>`).join('');
  let labels = ''; // 満干潮の文字は現在線より手前に描く
  // 夜（日の出前・日の入り後）に薄い色をグラフの上から重ねる（斜線なし）
  let night = '';
  if (sun && /^\d\d:\d\d$/.test(sun.rise || '') && /^\d\d:\d\d$/.test(sun.set || '')) {
    const r = x(minOf(sun.rise)), s = x(minOf(sun.set)), top = pad.t, h = H - pad.t - pad.b;
    night = `<rect class="night" x="${x(0)}" y="${top}" width="${Math.max(0, r - x(0))}" height="${h}"/>` +
      `<rect class="night" x="${s}" y="${top}" width="${Math.max(0, x(1440) - s)}" height="${h}"/>`;
  }
  let g = `<path d="${area}" fill="var(--tealfill)"/>${exLines}<path d="${line}" fill="none" stroke="var(--teal)" stroke-width="${mini ? 1.6 : 2.5}"/>${night}`;
  if (mini) {
    // 週間予報のミニグラフ：2時間ごとの目盛りと時刻（数字のみ）
    let ticks = '';
    for (let h = 0; h <= 24; h += 2) {
      const tx = x(h * 60);
      ticks += `<line x1="${tx}" x2="${tx}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--line)" stroke-width="${h % 6 ? 0.5 : 0.9}"/>`;
      g += `<text x="${tx}" y="${H - 3}" text-anchor="middle">${h}</text>`;
    }
    g = ticks + g;
  }
  if (!mini) {
    const step = niceStep(hi - lo, 4);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g = `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>` + g;
    }
    // 2時間ごとの目盛り（狭い画面では「時」を省いて数字だけ）
    const narrow = W < 520;
    let ticks = '';
    for (let h = 0; h <= 24; h += 2) {
      const tx = x(h * 60);
      ticks += `<line x1="${tx}" x2="${tx}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--line)" stroke-width="${h % 6 ? 0.6 : 1}"/>`;
      g += `<text x="${tx}" y="${H - 6}" text-anchor="middle">${narrow && h !== 0 ? h : h + '時'}</text>`;
    }
    g = ticks + g;
    g += `<text x="${pad.l - 6}" y="14" text-anchor="end">cm</text>`;
    [...t.highs.map(e => ({ ...e, hi: true })), ...t.lows].forEach(e => {
      const ex = x(e.m), ey = y(e.cm);
      const ty = e.hi ? ey - 9 : ey + 17;
      const anchor = ex < 40 ? 'start' : ex > W - 40 ? 'end' : 'middle';
      g += `<circle cx="${ex}" cy="${ey}" r="3.5" fill="${e.hi ? 'var(--teal)' : 'var(--sub)'}"/>`;
      labels += `<text class="lbl" x="${ex}" y="${ty}" text-anchor="${anchor}">${esc(e.time)} ${e.cm}</text>`;
    });
  }
  if (nowMin != null) {
    const nx = x(nowMin);
    // 現在潮位を点列から補間
    const i = Math.min(t.points.length - 2, Math.floor(nowMin / 20));
    const a = t.points[i], b = t.points[i + 1];
    const cm = a.cm + (b.cm - a.cm) * (nowMin - a.m) / 20;
    g += `<line x1="${nx}" x2="${nx}" y1="${pad.t - (mini ? 0 : 8)}" y2="${H - pad.b}" stroke="var(--accent)" stroke-width="2"/>` +
      `<circle cx="${nx}" cy="${y(cm)}" r="${mini ? 3 : 5}" fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>`;
    if (!mini) {
      const anchor = nx > W - 90 ? 'end' : 'start';
      g += `<text class="nowlbl" x="${nx + (anchor === 'start' ? 6 : -6)}" y="${pad.t - 10}" text-anchor="${anchor}">現在 ${Math.round(cm)}cm</text>`;
    }
  }
  g += labels;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;
}

// 風速グラフ。hours:[{time,windSpeed,windGust}]
function drawWind(svg, W, H, hours, nowStr) {
  if (!hours.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">風のデータなし</text>`; return; }
  const pad = { l: 34, r: 12, t: 22, b: 24 };
  const t0 = Date.parse(hours[0].time + 'Z'), t1 = Date.parse(hours[hours.length - 1].time + 'Z');
  const tx = s => pad.l + (W - pad.l - pad.r) * (Date.parse(s + 'Z') - t0) / Math.max(1, t1 - t0);
  const maxV = Math.max(5, ...hours.map(h => Math.max(h.windSpeed ?? 0, h.windGust ?? 0)));
  const hi = Math.ceil(maxV / 2) * 2 + 1;
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / hi);
  const path = k => hours.filter(h => h[k] != null).map((h, i) => `${i ? 'L' : 'M'}${tx(h.time).toFixed(1)},${y(h[k]).toFixed(1)}`).join('');
  let g = '';
  const step = niceStep(hi, 4);
  for (let v = 0; v <= hi; v += step) g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  g += `<text x="${pad.l - 6}" y="12" text-anchor="end">m/s</text>`;
  const every = (W < 520 ? 12 : 6) * 3600e3;
  hours.forEach(h => {
    const ms = Date.parse(h.time + 'Z');
    if ((ms - Date.parse(h.time.slice(0, 10) + 'T00:00Z')) % every === 0) {
      const hh = +h.time.slice(11, 13);
      const label = hh === 0 ? `${+h.time.slice(5, 7)}/${+h.time.slice(8, 10)}` : `${hh}時`;
      g += `<text x="${tx(h.time)}" y="${H - 6}" text-anchor="middle">${label}</text>`;
      if (hh === 0) g += `<line x1="${tx(h.time)}" x2="${tx(h.time)}" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
    }
  });
  g += `<path d="${path('windGust')}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
  g += `<path d="${path('windSpeed')}" fill="none" stroke="var(--teal)" stroke-width="2.5"/>`;
  const top = hours.reduce((m, h) => (h.windSpeed ?? -1) > (m.windSpeed ?? -1) ? h : m, hours[0]);
  if (top.windSpeed != null) {
    const mx = tx(top.time), anchor = mx < 60 ? 'start' : mx > W - 60 ? 'end' : 'middle';
    g += `<circle cx="${mx}" cy="${y(top.windSpeed)}" r="3.5" fill="var(--teal)"/><text class="lbl" x="${mx}" y="${y(top.windSpeed) - 8}" text-anchor="${anchor}">最大 ${fmt(top.windSpeed)}</text>`;
  }
  if (nowStr && nowStr >= hours[0].time && nowStr <= hours[hours.length - 1].time) {
    const nx = tx(nowStr);
    g += `<line x1="${nx}" x2="${nx}" y1="${pad.t - 6}" y2="${H - pad.b}" stroke="var(--accent)" stroke-width="2"/>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;
}

// ================= 描画 =================
function renderHeader() {
  const s = spot(), d = state.data;
  $('#spotSel').innerHTML = state.spots.map(x => `<option value="${esc(x.id)}" ${x.id === state.spotId ? 'selected' : ''}>${esc(x.name)}${x.isDefault ? '（既定）' : ''}</option>`).join('');
  $('#spotName').textContent = s ? s.name : '';
  if (!d) return;
  const ft = d.fetchedAtJst || '';
  $('#fetchedAt').textContent = `データ取得 ${ft.slice(5, 7)}/${ft.slice(8, 10)} ${ft.slice(11, 16)}${d.tzOffsetMin != null && d.tzOffsetMin !== 540 ? `（現地時刻 UTC${d.tzOffsetMin >= 0 ? '+' : '−'}${Math.abs(d.tzOffsetMin / 60)}）` : ''}${d.cached ? '（キャッシュ）' : ''}${d.stale ? '・最新取得に失敗' : ''}`;
  const src = d.sources || {};
  const parts = [];
  if (src.weather) parts.push(`天気・風：<a href="${esc(src.weather.url)}" target="_blank" rel="noopener">${esc(src.weather.name)}</a>${src.weather.fallbackReason ? `（${esc(src.weather.fallbackReason)}）` : ''}`);
  if (src.marine) parts.push(`海洋：<a href="${esc(src.marine.url)}" target="_blank" rel="noopener">${esc(src.marine.name)}</a>`);
  if (src.tide) parts.push(`潮汐：<a href="${esc(src.tide.url)}" target="_blank" rel="noopener">${esc(src.tide.name)}</a>`);
  $('#sources').innerHTML = parts.join(' ／ ') + '（数値予報モデルの値）';
  const er = $('#errors');
  er.hidden = !(d.errors && d.errors.length);
  er.textContent = (d.errors || []).join(' / ');
}

function renderNow() {
  const d = state.data, c = d.current || {}, m = d.marine || {}, today = d.days[0] || {}, t = today.tide || {};
  const moonPhase = (t.moonAge ?? 0) / 29.53;
  const cell = (k, v) => `<div class="nc"><span class="nk">${k}</span><span class="nv">${v}</span></div>`;
  $('#now').innerHTML = `
    <div class="nhero">
      <div class="nh">${wxIcon(c.code)}<div><span class="hv">${fmt(c.temp)}<span class="u">℃</span></span><span class="hs">${esc(wxText(c.code))}</span><span class="hs">体感${fmt(c.feels)}℃</span></div></div>
      <div class="nh">${arrow(c.windDir, true, 'lg')}<div><span class="hv">${fmt(c.windSpeed)}<span class="u">m/s</span></span><span class="hs">${esc(dir16(c.windDir))}の風</span><span class="hs">瞬間${fmt(c.windGust)}m/s</span></div></div>
      <div class="nh">${moonSvg(moonPhase)}<div><span class="hv">${fmt(m.sst)}<span class="u">℃</span></span><span class="hs">水温</span><span class="hs">${esc(t.tideName || '—')}</span></div></div>
    </div>
    <div class="ngrid">
      ${cell('波高', `${fmt(m.waveH, 2)}m`)}
      ${cell('波向', `${arrow(m.waveDir)}${esc(dir16(m.waveDir))}`)}
      ${cell('波周期', `${fmt(m.wavePeriod)}秒`)}
      ${cell('潮流', `${arrow(m.curDir, false)}${esc(dir16(m.curDir))}`)}
      ${cell('流速', `${fmt(m.curSpeed, 2)}m/s<small>${m.curSpeed == null ? '' : (m.curSpeed / 0.514444).toFixed(1) + 'kt'}</small>`)}
      ${cell('湿度', `${fmt(c.humidity, 0)}%`)}
      ${cell('気圧', `${fmt(c.pressure, 0)}hPa`)}
      ${cell('月齢', `${fmt(t.moonAge)}<small>輝面${t.moonFraction == null ? '—' : Math.round(t.moonFraction * 100)}%</small>`)}
      ${cell('月の出', esc(t.moonRise || '—'))}
      ${cell('月の入り', esc(t.moonSet || '—'))}
      ${cell('日の出', esc(today.sunrise || '—'))}
      ${cell('日の入り', esc(today.sunset || '—'))}
    </div>`;
}

function tideListHtml(t, nowMin) {
  const ex = [...t.highs.map(e => ({ ...e, k: '満潮' })), ...t.lows.map(e => ({ ...e, k: '干潮' }))].sort((a, b) => a.m - b.m);
  if (!ex.length) return '<p class="empty">満潮・干潮のデータがありません</p>';
  return ex.map(e => `<div class="tl ${nowMin != null && e.m < nowMin ? 'past' : ''}"><span class="k ${e.k === '満潮' ? 'h' : 'l'}">${e.k}</span><span class="t">${esc(e.time)}</span><span class="c">${e.cm}cm</span></div>`).join('');
}

function renderTide() {
  const d = state.data, t = d.days[0]?.tide;
  const now = jstNow(), nowMin = minOf(now.slice(11, 16));
  $('#tidePort').textContent = t ? `${t.tideName}・平均海面基準` : '';
  chart($('#tideFig svg'), (svg, W, H) => drawTide(svg, W, H, t, minOf(jstNow().slice(11, 16)), false, { rise: d.days[0].sunrise, set: d.days[0].sunset }));
  $('#tideList').innerHTML = t ? tideListHtml(t, nowMin) : '';
  // 次の満潮・干潮
  const ext = [];
  d.days.slice(0, 2).forEach((day, i) => {
    (day.tide?.highs || []).forEach(e => ext.push({ ...e, k: '満潮', abs: e.m + i * 1440 }));
    (day.tide?.lows || []).forEach(e => ext.push({ ...e, k: '干潮', abs: e.m + i * 1440 }));
  });
  ext.sort((a, b) => a.abs - b.abs);
  const nexts = ['満潮', '干潮'].map(k => ext.find(e => e.k === k && e.abs > nowMin)).filter(Boolean).sort((a, b) => a.abs - b.abs);
  const left = mins => (mins >= 60 ? `${Math.floor(mins / 60)}時間` : '') + `${mins % 60}分`;
  $('#nextTide').innerHTML = nexts.length ? nexts.map(e => `次の${e.k} <b>${esc(e.time)}</b>${e.abs >= 1440 ? '（明日）' : ''} あと${left(e.abs - nowMin)}`).join('<br>') : '';
}

function hoursFor(date) { return state.data.hourly.filter(h => h.time.startsWith(date)); }

function renderWind() {
  const d = state.data;
  const hours = d.hourly.filter(h => h.time.slice(0, 10) <= (d.days[1]?.date || '') && h.time.slice(0, 10) >= d.days[0].date);
  const now = jstNow();
  const nowH = hours.filter(h => h.time >= now.slice(0, 13));
  const top = nowH.reduce((m, h) => (h.windSpeed ?? -1) > (m?.windSpeed ?? -1) ? h : m, null);
  $('#windNote').innerHTML = top ? `これから明日までの最大風速 <b>${fmt(top.windSpeed)}</b> m/s（${+top.time.slice(8, 10)}日 ${+top.time.slice(11, 13)}時・${esc(dir16(top.windDir))}）、突風 最大 <b>${fmt(Math.max(...nowH.map(h => h.windGust ?? 0)))}</b> m/s` : '';
  chart($('#windFig svg'), (svg, W, H) => drawWind(svg, W, H, hours, jstNow()));
}

function hourlyHtml(hours, nowStr, collapsePast, showPast, toggleId) {
  if (!hours.length) return '<p class="empty">時間別データがありません</p>';
  const curH = nowStr.slice(0, 13);
  const past = collapsePast ? hours.filter(h => h.time.slice(0, 13) < curH) : [];
  const rows = h => `<div class="hr ${h.time.slice(0, 13) === curH ? 'cur' : ''}">
      <span>${+h.time.slice(11, 13)}時</span>${wxIcon(h.code)}<span class="r">${fmt(h.temp)}°</span>
      <span class="w"><small class="dn">${arrow(h.windDir)}${esc(dir16(h.windDir))}</small><span>${fmt(h.windSpeed)}<small>/${fmt(h.windGust)}</small></span></span>
      <span class="r">${h.pop == null ? '—' : h.pop + '%'}</span><span class="r">${fmt(h.sst)}°</span><span class="r">${fmt(h.waveH, 2)}</span></div>`;
  const head = `<div class="hr head"><span>時刻</span><span>天気</span><span class="r">気温</span><span>風向・風速/突風</span><span class="r">降水</span><span class="r">水温</span><span class="r">波高m</span></div>`;
  const shown = collapsePast && !showPast ? hours.filter(h => h.time.slice(0, 13) >= curH) : hours;
  const toggle = past.length ? `<button class="toggle" type="button" data-toggle="${toggleId}" aria-expanded="${showPast}">${showPast ? '▲ 過ぎた時間を隠す' : `▼ 過ぎた時間（${past.length}件）`}</button>` : '';
  return `<div class="hrs">${toggle}${head}${shown.map(rows).join('')}</div>`;
}

function renderHourly() {
  const today = state.data.days[0].date;
  $('#hourly').innerHTML = hourlyHtml(hoursFor(today), jstNow(), true, state.showPast, 'today');
}

function renderWeek() {
  const d = state.data, now = jstNow();
  $('#week').innerHTML = d.days.map((day, i) => {
    const L = dayLabel(day.date), t = day.tide || {};
    const ex = [...(t.highs || []).map(e => `満${e.time}`), ...(t.lows || []).map(e => `干${e.time}`)];
    const open = state.expanded.has(day.date);
    return `<div class="day ${open ? 'open' : ''}" data-date="${esc(day.date)}">
      <button class="dayrow" type="button" aria-expanded="${open}" data-day="${esc(day.date)}">
        <span class="d">${i === 0 ? '今日' : i === 1 ? '明日' : esc(L.md)}<small>${i < 2 ? esc(L.md) : ''}（${L.wd}）</small></span>
        ${wxIcon(day.code)}
        <span class="m"><span><span class="tmax">${fmt(day.tmax, 0)}°</span> / <span class="tmin">${fmt(day.tmin, 0)}°</span></span><span>降水${day.popMax == null ? '—' : day.popMax + '%'}</span><span>${arrow(day.windDir)}${esc(dir16(day.windDir))} ${fmt(day.windMax)}m/s</span></span>
        <span class="t"><b>${esc(t.tideName || '')}</b><span>月齢${fmt(t.moonAge)}</span>${[...(t.highs || []).map(e => ({ ...e, k: '満' })), ...(t.lows || []).map(e => ({ ...e, k: '干' }))].sort((a, b) => a.m - b.m).map(e => `<span>${e.k} ${esc(e.time)} ${e.cm}</span>`).join('')}</span>
        <span class="g"><svg aria-label="潮位ミニグラフ ${esc(ex.join(' '))}" role="img"></svg></span>
      </button>
      ${open ? `<div class="detail">
        <div class="sum"><span>${esc(wxText(day.code))}</span><span>最高 <b>${fmt(day.tmax)}℃</b></span><span>最低 <b>${fmt(day.tmin)}℃</b></span><span>降水確率 <b>${day.popMax ?? '—'}%</b></span>
          <span>卓越風向 <b>${esc(dir16(day.windDir))}</b></span><span>最大風速 <b>${fmt(day.windMax)}</b> m/s</span><span>突風 <b>${fmt(day.gustMax)}</b> m/s</span>
          <span>日の出 <b>${esc(day.sunrise || '—')}</b></span><span>日の入り <b>${esc(day.sunset || '—')}</b></span>
          <span>月の出 <b>${esc(t.moonRise || '—')}</b></span><span>月の入り <b>${esc(t.moonSet || '—')}</b></span><span>輝面比 <b>${t.moonFraction == null ? '—' : Math.round(t.moonFraction * 100)}%</b></span></div>
        <h4>タイドグラフ</h4><div class="fig big"><svg class="dtide" role="img" aria-label="潮位曲線"></svg></div>
        <div class="tidelist">${tideListHtml(t, i === 0 ? minOf(now.slice(11, 16)) : null)}</div>
        <h4>風速予報</h4><div class="fig short"><svg class="dwind" role="img" aria-label="風速予報"></svg></div>
        <h4>時間ごとの予報</h4>${hourlyHtml(hoursFor(day.date), now, false, true, '')}
      </div>` : ''}
    </div>`;
  }).join('');
  d.days.forEach((day, i) => {
    const el = document.querySelector(`.day[data-date="${day.date}"]`);
    const nm = () => (i === 0 ? minOf(jstNow().slice(11, 16)) : null);
    chart(el.querySelector('.g svg'), (svg, W, H) => drawTide(svg, W, H, day.tide, nm(), true, { rise: day.sunrise, set: day.sunset }));
    if (state.expanded.has(day.date)) {
      chart(el.querySelector('.dtide'), (svg, W, H) => drawTide(svg, W, H, day.tide, nm(), false, { rise: day.sunrise, set: day.sunset }));
      chart(el.querySelector('.dwind'), (svg, W, H) => drawWind(svg, W, H, hoursFor(day.date), jstNow()));
    }
  });
}

// ---- 釣果情報・自分の釣果記録 ----
async function renderReports() {
  const s = spot();
  $('#reportsSpot').textContent = s ? `${s.name}周辺` : '';
  $('#lnkSearch').href = `https://www.google.com/search?q=${encodeURIComponent((s?.name || '') + ' 釣果')}`;
  const list = await api(`/api/reports?spotId=${encodeURIComponent(state.spotId)}`).catch(() => []);
  $('#reports').innerHTML = list.length ? list.map(r => `<div class="card">
      <div class="ttl">${esc(r.fish)} <span>${esc(r.size)}</span> <span>${esc(r.count)}</span></div>
      <div class="sub">${esc(r.date)} ${esc(r.place)}</div>${r.note ? `<p class="memo">${esc(r.note)}</p>` : ''}
      <div class="sub">出典：<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(hostOf(r.url))}</a></div>
      <div class="acts"><button class="mini" data-edit-report="${esc(r.id)}" type="button">編集</button><button class="mini danger" data-del-report="${esc(r.id)}" type="button">削除</button></div></div>`).join('')
    : '<p class="empty">この地点の釣果情報はまだありません。釣果サイトで見つけた情報を出典URL付きで追加できます。</p>';
  state.reports = list;
}
const hostOf = u => { try { return new URL(u).hostname; } catch { return u; } };

async function renderLogs() {
  const list = await api(`/api/logs?spotId=${encodeURIComponent(state.spotId)}`).catch(() => []);
  const name = id => state.spots.find(s => s.id === id)?.name || '';
  $('#logs').innerHTML = list.length ? list.map(r => `<div class="card">
      <div class="ttl">${esc(r.fish)} <span>${esc(r.size)}</span> <span>${r.count ? esc(r.count) + '匹' : ''}</span></div>
      <div class="sub">${esc(r.date)}${r.spotId ? '・' + esc(name(r.spotId)) : ''}</div>
      ${r.tackle ? `<div class="sub">タックル：${esc(r.tackle)}</div>` : ''}${r.memo ? `<p class="memo">${esc(r.memo)}</p>` : ''}
      <div class="acts"><button class="mini" data-edit-log="${esc(r.id)}" type="button">編集</button><button class="mini danger" data-del-log="${esc(r.id)}" type="button">削除</button></div></div>`).join('')
    : '<p class="empty">まだ記録がありません。</p>';
  state.logs = list;
}

function renderAll() {
  renderHeader();
  if (!state.data) return;
  renderNow(); renderTide(); renderWind(); renderHourly(); renderWeek();
}

// ================= データ読み込み =================
async function loadConditions(force = false) {
  document.body.classList.add('loading');
  try {
    state.data = await api(`/api/conditions/${encodeURIComponent(state.spotId)}${force ? '?force=1' : ''}`);
    state.loadedAt = Date.now();
    renderAll();
  } catch (e) {
    $('#fetchedAt').textContent = '取得に失敗しました：' + e.message;
  } finally { document.body.classList.remove('loading'); }
}
async function selectSpot(id) {
  state.spotId = id;
  state.expanded = new Set(); // 地点切替で週間予報の展開をリセット
  state.showPast = false;
  try { localStorage.setItem('fd.spot', id); } catch { /* ignore */ }
  renderHeader();
  await loadConditions();
  renderReports(); renderLogs();
}
async function loadSpots() { state.spots = await api('/api/spots'); }

// ================= 地点管理 =================
async function renderSpotSheet() {
  $('#spotList').innerHTML = state.spots.map(s => `<div class="sp"><div class="nm">${esc(s.name)}${s.isDefault ? '<span class="badge">既定</span>' : ''}<small>${esc(s.region || '')}</small></div>
      <div class="sub" style="font-size:12px;color:var(--sub)">緯度 ${(+s.lat).toFixed(4)} / 経度 ${(+s.lon).toFixed(4)}（潮位はこの地点に最も近い海上格子のモデル値）</div>
      <div class="acts row" style="margin-top:8px">${s.isDefault ? '' : `<button class="mini" type="button" data-default="${esc(s.id)}">既定にする</button>`}<button class="mini" type="button" data-show="${esc(s.id)}">表示</button><button class="mini danger" type="button" data-delspot="${esc(s.id)}">削除</button></div></div>`).join('');
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" type="button" data-preset="${i}">${esc(p.name)}</button>`).join('');
}
async function addSpot(p) {
  $('#spotErr').textContent = '';
  try {
    const s = await api('/api/spots', { method: 'POST', body: p });
    await loadSpots(); await renderSpotSheet(); renderHeader();
    $('#spotErr').textContent = `「${s.name}」を追加しました`;
  } catch (e) { $('#spotErr').textContent = e.message; }
}

// ================= フォーム =================
function bindForm(formSel, boxSel, endpoint, after, extra) {
  const form = $(formSel), box = $(boxSel), err = form.querySelector('.formerr');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    err.textContent = '';
    const fd = Object.fromEntries(new FormData(form));
    const id = fd.rid; delete fd.rid;
    Object.assign(fd, extra ? extra(fd, form) : {});
    try {
      await api(id ? `${endpoint}/${encodeURIComponent(id)}` : endpoint, { method: id ? 'PUT' : 'POST', body: fd });
      form.reset(); form.rid.value = ''; box.open = false; resetDate(form);
      after();
    } catch (e) { err.textContent = e.message; }
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => { form.reset(); form.rid.value = ''; err.textContent = ''; box.open = false; resetDate(form); });
}
const resetDate = form => { form.date.value = jstNow().slice(0, 10); };
function fillForm(form, box, rec) {
  for (const el of form.elements) if (el.name && el.name in rec && el.type !== 'checkbox') el.value = rec[el.name] ?? '';
  form.rid.value = rec.id;
  if (form.thisSpot) form.thisSpot.checked = !!rec.spotId;
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ================= イベント =================
$('#spotSel').addEventListener('change', e => selectSpot(e.target.value));
$('#btnRefresh').addEventListener('click', async () => { await loadConditions(true); renderReports(); renderLogs(); });
$('#btnExport').addEventListener('click', () => { try { exportBackup(); } catch (e) { $('#spotErr').textContent = e.message; } });
$('#fileImport').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { await importBackup(f); await loadSpots(); await renderSpotSheet(); await selectSpot((state.spots.find(s => s.isDefault) || state.spots[0]).id); $('#spotErr').textContent = 'バックアップを読み込みました'; }
  catch (er) { $('#spotErr').textContent = '読み込めませんでした：' + er.message; }
  e.target.value = '';
});
$('#btnSpots').addEventListener('click', async () => { $('#spotSheet').hidden = false; await renderSpotSheet(); });
$('#spotSheet').addEventListener('click', async e => {
  const b = e.target.closest('button'); const sheet = $('#spotSheet');
  if (e.target === sheet || (b && b.hasAttribute('data-close'))) { sheet.hidden = true; return; }
  if (!b) return;
  try {
    if (b.dataset.preset) await addSpot(PRESETS[+b.dataset.preset]);
    if (b.dataset.geo) await addSpot(JSON.parse(b.dataset.geo));
    if (b.dataset.default) { await api(`/api/spots/${b.dataset.default}`, { method: 'PATCH', body: { isDefault: true } }); await loadSpots(); await renderSpotSheet(); renderHeader(); }
    if (b.dataset.show) { sheet.hidden = true; await selectSpot(b.dataset.show); }
    if (b.dataset.delspot) {
      const s = state.spots.find(x => x.id === b.dataset.delspot);
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = `「${s.name}」を削除する`; return; }
      await api(`/api/spots/${b.dataset.delspot}`, { method: 'DELETE' });
      await loadSpots(); await renderSpotSheet();
      if (!state.spots.some(x => x.id === state.spotId)) await selectSpot((state.spots.find(x => x.isDefault) || state.spots[0]).id); else renderHeader();
    }
  } catch (er) { $('#spotErr').textContent = er.message; }
});
$('#geoForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#geoQ').value.trim(); if (!q) return;
  $('#geoResults').textContent = '検索中…';
  try {
    const rs = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    $('#geoResults').innerHTML = rs.length ? rs.map(r => `<div class="geo"><span>${esc(r.name)} <small>${esc(r.region)} ${esc(r.country || '')}</small></span><button class="mini" type="button" data-geo="${esc(JSON.stringify({ name: r.name, region: r.region, lat: r.lat, lon: r.lon }))}">追加</button></div>`).join('') : '<p class="hint">見つかりませんでした</p>';
  } catch (er) { $('#geoResults').textContent = er.message; }
});

document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.day) {
    const d = b.dataset.day;
    state.expanded.has(d) ? state.expanded.delete(d) : state.expanded.add(d);
    renderWeek();
    document.querySelector(`.dayrow[data-day="${d}"]`)?.focus();
  }
  if (b.dataset.toggle === 'today') { state.showPast = !state.showPast; renderHourly(); }
  const confirmDel = async (attr, url, after) => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = '本当に削除'; return; }
    await api(url, { method: 'DELETE' }); after();
  };
  if (b.dataset.delReport) await confirmDel('delReport', `/api/reports/${b.dataset.delReport}`, renderReports);
  if (b.dataset.delLog) await confirmDel('delLog', `/api/logs/${b.dataset.delLog}`, renderLogs);
  if (b.dataset.editReport) fillForm($('#reportForm'), $('#reportFormBox'), state.reports.find(r => r.id === b.dataset.editReport));
  if (b.dataset.editLog) fillForm($('#logForm'), $('#logFormBox'), state.logs.find(r => r.id === b.dataset.editLog));
});

bindForm('#reportForm', '#reportFormBox', '/api/reports', renderReports, () => ({ spotId: state.spotId }));
bindForm('#logForm', '#logFormBox', '/api/logs', renderLogs, (fd, form) => { delete fd.thisSpot; return { spotId: form.thisSpot.checked ? state.spotId : '' }; });

// 画面表示時、古ければ再取得（サーバー側でキャッシュの鮮度を判定）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.spotId && Date.now() - state.loadedAt > 10 * 60e3) loadConditions();
});
// 現在時刻ライン・ハイライトの更新（5分ごと）
setInterval(() => { if (state.data && document.visibilityState === 'visible') { renderTide(); renderWind(); renderHourly(); } }, 5 * 60e3);

// ================= 起動 =================
(async () => {
  resetDate($('#reportForm')); resetDate($('#logForm'));
  try {
    await loadSpots();
    const def = state.spots.find(s => s.isDefault) || state.spots[0];
    await selectSpot(def.id); // 起動時は既定地点を表示
  } catch (e) { $('#fetchedAt').textContent = '起動に失敗しました：' + e.message; }
})();
}
