// 月齢・輝面比・月の出入り・日の出入り・潮名を日付から算出する
// アルゴリズムは SunCalc (Vladimir Agafonkin, BSD-2) の手法に基づく近似計算
let TZ_OFF_MIN = 540; // 表示地点のUTCオフセット（分）。取得データで上書き

const PI = Math.PI, rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545;
const e = rad * 23.4397;
const SYNODIC = 29.530588853;

const toJulian = d => d.valueOf() / dayMs - 0.5 + J1970;
const fromJulian = j => new Date((j + 0.5 - J1970) * dayMs);
const toDays = d => toJulian(d) - J2000;

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
function astroRefraction(h) {
  if (h < 0) h = 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}
const solarMeanAnomaly = d => rad * (357.5291 + 0.98560028 * d);
function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + rad * 102.9372 + PI;
}
function sunCoords(d) {
  const L = eclipticLongitude(solarMeanAnomaly(d));
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d);
  const M = rad * (134.963 + 13.064993 * d);
  const F = rad * (93.272 + 13.229350 * d);
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}
function moonAltitude(date, lat, lng) {
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitude(H, phi, c.dec);
  h += astroRefraction(h);
  return h;
}
function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / PI };
}

// JST の日付文字列 'YYYY-MM-DD' と時刻(時) から Date を作る
const jstDate = (ymd, hours = 0) => new Date(Date.parse(ymd + 'T00:00:00Z') - TZ_OFF_MIN * 60000 + hours * 3600e3);
function fmtJST(date) {
  if (!date) return null;
  const t = new Date(date.getTime() + TZ_OFF_MIN * 60000);
  return String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
}

// 月の出・月の入り（その日 0:00〜24:00 JST の範囲）
function moonTimes(ymd, lat, lng) {
  const t = jstDate(ymd, 0);
  const hc = 0.133 * rad;
  const alt = h => moonAltitude(new Date(t.getTime() + h * 3600e3), lat, lng) - hc;
  let h0 = alt(0), rise, set;
  for (let i = 1; i <= 24; i += 2) {
    const h1 = alt(i), h2 = alt(i + 1);
    const a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2;
    const xe = -b / (2 * a), ye = (a * xe + b) * xe + h1;
    const d = b * b - 4 * a * h1;
    let roots = 0, x1 = 0, x2 = 0;
    if (d >= 0) {
      const dx = Math.sqrt(d) / (Math.abs(a) * 2);
      x1 = xe - dx; x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }
    if (roots === 1) {
      if (h0 < 0) rise = i + x1; else set = i + x1;
    } else if (roots === 2) {
      rise = i + (ye < 0 ? x2 : x1);
      set = i + (ye < 0 ? x1 : x2);
    }
    if (rise !== undefined && set !== undefined) break;
    h0 = h2;
  }
  const at = h => (h === undefined ? null : fmtJST(new Date(t.getTime() + h * 3600e3)));
  return { rise: at(rise), set: at(set) };
}

// 日の出・日の入り（気象APIが返さない場合のフォールバック）
function sunTimes(ymd, lat, lng) {
  const J0 = 0.0009, date = jstDate(ymd, 12);
  const lw = rad * -lng, phi = rad * lat, d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * PI));
  const approxTransit = (Ht) => J0 + (Ht + lw) / (2 * PI) + n;
  const ds = approxTransit(0);
  const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
  const transitJ = (dsx) => J2000 + dsx + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const Jnoon = transitJ(ds);
  const h0 = -0.833 * rad;
  const w = Math.acos((Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const Jset = transitJ(approxTransit(w));
  const Jrise = Jnoon - (Jset - Jnoon);
  return { sunrise: fmtJST(fromJulian(Jrise)), sunset: fmtJST(fromJulian(Jset)) };
}

// 潮名：旧暦日（月齢から近似）による一般的な区分
function tideName(lunarDay) {
  // 1-2 大潮 / 3-6 中潮 / 7-9 小潮 / 10 長潮 / 11 若潮 / 12-13 中潮 / 14-17 大潮
  // 18-21 中潮 / 22-24 小潮 / 25 長潮 / 26 若潮 / 27-29 中潮 / 30 大潮
  const d = lunarDay;
  if (d <= 2 || (d >= 14 && d <= 17) || d >= 30) return '大潮';
  if ((d >= 7 && d <= 9) || (d >= 22 && d <= 24)) return '小潮';
  if (d === 10 || d === 25) return '長潮';
  if (d === 11 || d === 26) return '若潮';
  return '中潮';
}

function moonInfo(ymd, lat, lng) {
  const noon = jstDate(ymd, 12);
  const ill = moonIllumination(noon);
  const age = ill.phase * SYNODIC;
  const lunarDay = Math.min(30, Math.floor(age) + 1);
  const times = moonTimes(ymd, lat, lng);
  return {
    age: Math.round(age * 10) / 10,
    fraction: Math.round(ill.fraction * 100) / 100,
    phase: ill.phase,
    rise: times.rise,
    set: times.set,
    tideName: tideName(lunarDay),
  };
}

