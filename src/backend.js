// ---- サーバー不要版のデータ層：ブラウザから公開APIを直接取得し、端末内に保存する ----
const STORE_KEY = 'fd.v1';
const CACHE_TTL_MIN = 30; // これより新しい取得結果は再利用（更新ボタンで強制取得）
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const uid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-4);
const DEFAULT_SPOT = () => ({ id: uid(), name: '坂出', region: '香川県坂出市', lat: 34.3167, lon: 133.8606, isDefault: true }); // 座標は概略値
let DB = LS.get(STORE_KEY, null);
if (!DB || !Array.isArray(DB.spots) || !DB.spots.length) DB = { spots: [DEFAULT_SPOT()], catchReports: [], catchLogs: [] };
const saveDb = () => LS.set(STORE_KEY, DB);
saveDb();

async function getJSON(url) {
  // 独自ヘッダーは付けない（CORS の事前確認を避けるため）
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.url = url; throw e; }
  return res.json();
}
const addD = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const nowLocal = () => new Date(Date.now() + TZ_OFF_MIN * 60000).toISOString().slice(0, 16);

// ---------- 天気（Open-Meteo → MET Norway）----------
async function openMeteo(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', forecast_days: '7', wind_speed_unit: 'ms',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,wind_direction_10m_dominant,wind_speed_10m_max,wind_gusts_10m_max,precipitation_probability_max,sunrise,sunset',
  });
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?${q}`);
  const c = j.current, h = j.hourly, d = j.daily;
  return {
    offsetMin: Math.round((j.utc_offset_seconds || 0) / 60),
    source: { name: 'Open-Meteo', url: 'https://open-meteo.com/' },
    current: { temp: c.temperature_2m, feels: c.apparent_temperature, humidity: c.relative_humidity_2m, pressure: c.pressure_msl, code: c.weather_code, windDir: c.wind_direction_10m, windSpeed: c.wind_speed_10m, windGust: c.wind_gusts_10m },
    hourly: h.time.map((t, i) => ({ time: t, temp: h.temperature_2m[i], code: h.weather_code[i], windDir: h.wind_direction_10m[i], windSpeed: h.wind_speed_10m[i], windGust: h.wind_gusts_10m[i], pop: h.precipitation_probability[i] })),
    daily: d.time.map((t, i) => ({
      date: t, tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i], code: d.weather_code[i], windDir: d.wind_direction_10m_dominant[i],
      windMax: d.wind_speed_10m_max[i], gustMax: d.wind_gusts_10m_max[i], popMax: d.precipitation_probability_max[i],
      sunrise: d.sunrise[i] ? d.sunrise[i].slice(11, 16) : null, sunset: d.sunset[i] ? d.sunset[i].slice(11, 16) : null,
    })),
  };
}
function symbolToWmo(sym = '') {
  const s = sym.replace(/_(day|night|polartwilight)$/, '');
  if (s.includes('thunder')) return 95;
  if (s.includes('snow')) return s.includes('heavy') ? 75 : s.includes('light') ? 71 : 73;
  if (s.includes('sleet')) return 66;
  if (s.includes('rainshowers')) return s.includes('heavy') ? 82 : s.includes('light') ? 80 : 81;
  if (s.includes('rain')) return s.includes('heavy') ? 65 : s.includes('light') ? 61 : 63;
  return { fog: 45, cloudy: 3, partlycloudy: 2, fair: 1, clearsky: 0 }[s] ?? 3;
}
function apparentTemp(t, rh, ws) { // 豪州気象局の体感温度式（MET Norway は体感温度を返さないため）
  if ([t, rh, ws].some(v => v == null)) return null;
  const e = rh / 100 * 6.105 * Math.exp(17.27 * t / (237.7 + t));
  return Math.round((t + 0.33 * e - 0.70 * ws - 4.00) * 10) / 10;
}
const severity = c => (c >= 95 ? 9 : c >= 71 && c <= 77 ? 8 : c >= 61 ? 7 : c >= 45 && c <= 48 ? 4 : c);
async function metNorway(lat, lon) {
  const j = await getJSON(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${(+lat).toFixed(4)}&lon=${(+lon).toFixed(4)}`);
  const toLocal = iso => new Date(Date.parse(iso) + TZ_OFF_MIN * 60000).toISOString().slice(0, 16);
  const hourly = j.properties.timeseries.map(e => {
    const det = e.data.instant.details, nx = e.data.next_1_hours || e.data.next_6_hours || {};
    return { time: toLocal(e.time), temp: det.air_temperature, code: symbolToWmo(nx.summary && nx.summary.symbol_code), windDir: det.wind_from_direction, windSpeed: det.wind_speed, windGust: det.wind_speed_of_gust ?? null, pop: nx.details ? nx.details.probability_of_precipitation ?? null : null, _rh: det.relative_humidity, _p: det.air_pressure_at_sea_level };
  });
  const by = {};
  hourly.forEach(h => { (by[h.time.slice(0, 10)] = by[h.time.slice(0, 10)] || []).push(h); });
  const daily = Object.keys(by).sort().slice(0, 7).map(date => {
    const a = by[date], vals = k => a.map(x => x[k]).filter(v => v != null);
    let x = 0, y = 0; a.forEach(v => { x += Math.sin(v.windDir * Math.PI / 180) * v.windSpeed; y += Math.cos(v.windDir * Math.PI / 180) * v.windSpeed; });
    const st = sunTimes(date, lat, lon);
    return { date, tmax: Math.max(...vals('temp')), tmin: Math.min(...vals('temp')), code: a.reduce((m, v) => (severity(v.code) > severity(m) ? v.code : m), a[0].code), windDir: Math.round((Math.atan2(x, y) * 180 / Math.PI + 360) % 360), windMax: Math.max(...vals('windSpeed')), gustMax: vals('windGust').length ? Math.max(...vals('windGust')) : null, popMax: vals('pop').length ? Math.max(...vals('pop')) : null, sunrise: st.sunrise, sunset: st.sunset };
  });
  const f = hourly[0];
  return {
    source: { name: 'MET Norway', url: 'https://api.met.no/' },
    current: { temp: f.temp, feels: apparentTemp(f.temp, f._rh, f.windSpeed), humidity: f._rh, pressure: f._p, code: f.code, windDir: f.windDir, windSpeed: f.windSpeed, windGust: f.windGust },
    hourly: hourly.map(({ _rh, _p, ...r }) => r), daily,
  };
}

// ---------- 海洋（Open-Meteo Marine：水温・波・潮流・潮位モデル）----------
function toMs(v, unit) {
  if (v == null) return null;
  const u = (unit || '').toLowerCase();
  return u.includes('km') ? v / 3.6 : u.includes('kn') ? v * 0.514444 : u.includes('mph') ? v * 0.44704 : v;
}
async function marine(lat, lon) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, timezone: 'auto', past_days: '1', forecast_days: '8', cell_selection: 'sea',
    current: 'wave_height,wave_direction,wave_period,sea_surface_temperature,ocean_current_velocity,ocean_current_direction',
    hourly: 'wave_height,sea_surface_temperature,sea_level_height_msl',
  });
  const j = await getJSON(`https://marine-api.open-meteo.com/v1/marine?${q}`);
  const c = j.current || {}, cu = j.current_units || {}, h = j.hourly || { time: [] };
  const hourly = {};
  h.time.forEach((t, i) => { hourly[t] = { sst: h.sea_surface_temperature ? h.sea_surface_temperature[i] : null, waveH: h.wave_height ? h.wave_height[i] : null }; });
  return {
    offsetMin: Math.round((j.utc_offset_seconds || 0) / 60),
    source: { name: 'Open-Meteo Marine', url: 'https://open-meteo.com/en/docs/marine-weather-api' },
    current: { sst: c.sea_surface_temperature ?? null, waveH: c.wave_height ?? null, waveDir: c.wave_direction ?? null, wavePeriod: c.wave_period ?? null, curDir: c.ocean_current_direction ?? null, curSpeed: c.ocean_current_velocity != null ? Math.round(toMs(c.ocean_current_velocity, cu.ocean_current_velocity) * 100) / 100 : null },
    hourly,
    seaLevel: { time: h.time, m: h.sea_level_height_msl || [] },
  };
}

// 毎時の潮位（m）から 20分刻みの曲線と満潮・干潮を求める（Catmull-Rom 補間）
function tidesFromSeaLevel(sl, dates) {
  const T = [], V = [];
  sl.time.forEach((t, i) => { const v = sl.m[i]; if (v != null) { T.push(Date.parse(t + 'Z') / 60000); V.push(v * 100); } });
  const out = {};
  if (T.length < 6) { dates.forEach(d => { out[d] = null; }); return out; }
  const at = tm => {
    let i = Math.floor((tm - T[0]) / 60);
    i = Math.max(1, Math.min(T.length - 3, i));
    const u = (tm - T[i]) / (T[i + 1] - T[i]);
    const p0 = V[i - 1], p1 = V[i], p2 = V[i + 1], p3 = V[i + 2];
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  };
  // 5分刻みで極値を探す
  const ext = [];
  for (let tm = T[1] + 5; tm < T[T.length - 2] - 5; tm += 5) {
    const a = at(tm - 5), b = at(tm), c = at(tm + 5);
    if (b > a && b >= c) ext.push({ tm, cm: b, hi: true });
    else if (b < a && b <= c) ext.push({ tm, cm: b, hi: false });
  }
  // 微小な揺らぎ（3cm未満）を除去し、満干を交互にする
  const clean = [];
  ext.forEach(e => {
    const last = clean[clean.length - 1];
    if (!last) { clean.push(e); return; }
    if (last.hi === e.hi) { if ((e.hi && e.cm > last.cm) || (!e.hi && e.cm < last.cm)) clean[clean.length - 1] = e; return; }
    if (Math.abs(e.cm - last.cm) < 3) { clean.pop(); return; }
    clean.push(e);
  });
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
  dates.forEach(date => {
    const d0 = Date.parse(date + 'T00:00:00Z') / 60000;
    if (d0 < T[1] || d0 + 1440 > T[T.length - 2]) { out[date] = null; return; }
    const points = [];
    for (let m = 0; m <= 1440; m += 20) points.push({ m, cm: Math.round(at(d0 + m)) });
    const day = clean.filter(e => e.tm >= d0 && e.tm < d0 + 1440).map(e => ({ time: hhmm(e.tm - d0), m: e.tm - d0, cm: Math.round(e.cm), hi: e.hi }));
    out[date] = { points, highs: day.filter(e => e.hi), lows: day.filter(e => !e.hi) };
  });
  return out;
}

async function fetchConditions(spot) {
  const errors = [];
  const [w0, m0] = await Promise.allSettled([openMeteo(spot.lat, spot.lon), marine(spot.lat, spot.lon)]);
  let wx = w0.status === 'fulfilled' ? w0.value : null;
  const mr = m0.status === 'fulfilled' ? m0.value : null;
  // 地点のUTCオフセット（日本なら+9時間）。取得できなければ経度から概算
  TZ_OFF_MIN = (wx && wx.offsetMin != null) ? wx.offsetMin : (mr && mr.offsetMin != null) ? mr.offsetMin : Math.round(spot.lon / 15) * 60;
  if (!wx) {
    const e = w0.reason;
    try {
      wx = await metNorway(spot.lat, spot.lon);
      wx.source.fallbackReason = e && e.status === 429 ? 'Open-Meteo がレート制限中のため切替' : 'Open-Meteo に接続できないため切替';
    } catch (e2) { errors.push('天気: 取得できませんでした（' + (e && e.message || e2.message) + '）'); }
  }
  if (!mr) errors.push('海洋・潮位: 取得できませんでした（' + (m0.reason && m0.reason.message) + '）');
  const now = nowLocal(), today = now.slice(0, 10);
  const dates = Array.from({ length: 7 }, (_, i) => addD(today, i));
  const tides = mr ? tidesFromSeaLevel(mr.seaLevel, dates) : {};
  const hourly = (wx ? wx.hourly : []).map(h => ({ ...h, sst: mr && mr.hourly[h.time] ? mr.hourly[h.time].sst : null, waveH: mr && mr.hourly[h.time] ? mr.hourly[h.time].waveH : null }));
  const days = dates.map(date => {
    const d = (wx && wx.daily.find(x => x.date === date)) || { date };
    const st = sunTimes(date, spot.lat, spot.lon), moon = moonInfo(date, spot.lat, spot.lon), t = tides[date];
    return {
      ...d, sunrise: d.sunrise || st.sunrise, sunset: d.sunset || st.sunset,
      tide: { port: '潮位モデル', highs: t ? t.highs : [], lows: t ? t.lows : [], points: t ? t.points : [], moonAge: moon.age, moonFraction: moon.fraction, moonRise: moon.rise, moonSet: moon.set, tideName: moon.tideName },
    };
  });
  return {
    spotId: spot.id, fetchedAt: new Date().toISOString(), fetchedAtJst: now, tzOffsetMin: TZ_OFF_MIN,
    sources: { weather: wx ? wx.source : null, marine: mr ? mr.source : null, tide: { name: 'Open-Meteo 潮位モデル（平均海面基準）', url: 'https://open-meteo.com/en/docs/marine-weather-api', port: '' } },
    current: wx ? wx.current : null, marine: mr ? mr.current : null, hourly, days, errors,
  };
}
async function getConditions(spot, force) {
  const key = 'fd.cond.' + spot.id;
  const cached = LS.get(key, null);
  if (cached && cached.tzOffsetMin != null) TZ_OFF_MIN = cached.tzOffsetMin;
  const fresh = cached && (Date.now() - Date.parse(cached.fetchedAt)) / 60000 < CACHE_TTL_MIN && cached.fetchedAtJst.slice(0, 10) === nowLocal().slice(0, 10) && cached.lat === spot.lat;
  if (fresh && !force) return { ...cached, cached: true };
  const data = await fetchConditions(spot);
  data.lat = spot.lat;
  if (!data.current && !data.marine && cached) { TZ_OFF_MIN = cached.tzOffsetMin; return { ...cached, cached: true, stale: true, errors: data.errors }; }
  LS.set(key, data);
  return data;
}
async function geocode(q) {
  const p = new URLSearchParams({ name: q, count: '10', language: 'ja', format: 'json' });
  const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?${p}`);
  return (j.results || []).map(r => ({ name: r.name, region: [r.admin1, r.admin2 || r.admin3].filter(Boolean).join(' '), country: r.country, lat: r.latitude, lon: r.longitude }));
}

// ---------- 画面からの呼び出し口（サーバー版と同じ形）----------
const isUrl = u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const clip = (v, n) => (v == null ? '' : String(v).slice(0, n).trim());
async function api(path, opts = {}) {
  const u = new URL(path, 'https://local.invalid'); const seg = u.pathname.split('/').filter(Boolean);
  const m = opts.method || 'GET', b = opts.body || {};
  const fail = msg => { throw new Error(msg); };
  if (seg[1] === 'spots') {
    if (m === 'GET') return DB.spots;
    if (m === 'POST') {
      if (!clip(b.name, 60) || !isFinite(+b.lat) || !isFinite(+b.lon)) fail('地点名と緯度経度が必要です');
      const s = { id: uid(), name: clip(b.name, 60), region: clip(b.region, 100), lat: +b.lat, lon: +b.lon, isDefault: false };
      DB.spots.push(s); saveDb(); return s;
    }
    const s = DB.spots.find(x => x.id === seg[2]) || fail('地点が見つかりません');
    if (m === 'PATCH') { if (b.isDefault) DB.spots.forEach(x => { x.isDefault = x.id === s.id; }); saveDb(); return s; }
    if (m === 'DELETE') {
      if (DB.spots.length <= 1) fail('最後の地点は削除できません');
      DB.spots = DB.spots.filter(x => x.id !== s.id);
      if (!DB.spots.some(x => x.isDefault)) DB.spots[0].isDefault = true;
      LS.del('fd.cond.' + s.id); saveDb(); return { ok: true };
    }
  }
  if (seg[1] === 'geocode') { const q = clip(u.searchParams.get('q'), 80); return q ? geocode(q) : []; }
  if (seg[1] === 'conditions') return getConditions(DB.spots.find(x => x.id === seg[2]) || fail('地点が見つかりません'), u.searchParams.get('force') === '1');
  const coll = seg[1] === 'reports' ? 'catchReports' : seg[1] === 'logs' ? 'catchLogs' : fail('not found');
  const clean = o => coll === 'catchReports'
    ? { spotId: clip(o.spotId, 40), fish: clip(o.fish, 60), size: clip(o.size, 40), count: clip(o.count, 40), place: clip(o.place, 100), date: clip(o.date, 10), url: clip(o.url, 500), note: clip(o.note, 300) }
    : { spotId: clip(o.spotId, 40), date: clip(o.date, 10), fish: clip(o.fish, 60), size: clip(o.size, 40), count: clip(o.count, 40), tackle: clip(o.tackle, 300), memo: clip(o.memo, 2000) };
  const check = o => { if (!o.fish) fail('魚種を入力してください'); if (coll === 'catchReports' && !isUrl(o.url)) fail('出典URL（http/https）は必須です'); };
  if (m === 'GET') {
    const sid = u.searchParams.get('spotId');
    return DB[coll].filter(x => x.spotId === sid || (coll === 'catchLogs' && !x.spotId)).sort((a, c) => (c.date || '').localeCompare(a.date || '') || (c.createdAt || '').localeCompare(a.createdAt || ''));
  }
  if (m === 'POST') { const o = clean(b); check(o); const r = { id: uid(), ...o, createdAt: new Date().toISOString() }; DB[coll].push(r); saveDb(); return r; }
  const r = DB[coll].find(x => x.id === seg[2]) || fail('見つかりません');
  if (m === 'PUT') { const o = clean({ ...r, ...b }); check(o); Object.assign(r, o, { updatedAt: new Date().toISOString() }); saveDb(); return r; }
  if (m === 'DELETE') { DB[coll] = DB[coll].filter(x => x.id !== r.id); saveDb(); return { ok: true }; }
}

// ---------- バックアップ（機種変更・ブラウザのデータ削除に備える）----------
function exportBackup() {
  const blob = new Blob([JSON.stringify({ app: 'fishing-dashboard', version: 1, exportedAt: new Date().toISOString(), ...DB }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fishing-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function importBackup(file) {
  const j = JSON.parse(await file.text());
  if (!j || !Array.isArray(j.spots) || !j.spots.length) throw new Error('バックアップファイルの形式が違います');
  DB = { spots: j.spots, catchReports: j.catchReports || [], catchLogs: j.catchLogs || [] };
  if (!DB.spots.some(s => s.isDefault)) DB.spots[0].isDefault = true;
  saveDb();
}
