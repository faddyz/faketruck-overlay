const US_STATE_MAP = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa', ks: 'Kansas',
  ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland', ma: 'Massachusetts',
  mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi', mo: 'Missouri', mt: 'Montana',
  ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey', nm: 'New Mexico',
  ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina',
  sd: 'South Dakota', tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont',
  va: 'Virginia', wa: 'Washington', wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming',
  dc: 'District of Columbia'
};

const US_STATE_NAMES = new Set(Object.values(US_STATE_MAP).map((state) => state.toLowerCase()));

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function titleCase(value) {
  return value
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeUsState(value) {
  if (!value) return '';
  const lower = value.toLowerCase();
  if (US_STATE_MAP[lower]) return US_STATE_MAP[lower];
  if (US_STATE_NAMES.has(lower)) return titleCase(value);
  return value;
}

function buildLocationLabels(item) {
  const address = item.address || {};
  const countryCode = String(address.country_code || '').toLowerCase();
  const city = firstText(
    address.city,
    address.town,
    address.village,
    address.hamlet,
    address.municipality,
    address.city_district,
    address.suburb,
    address.locality
  );
  const county = firstText(address.county);
  const state = firstText(address.state, address.region, address.state_district);

  if (countryCode === 'us') {
    const normalizedState = normalizeUsState(state);
    const safeCity = city || county || '';
    const shortLabel = safeCity && normalizedState
      ? `${safeCity}, ${normalizedState}`
      : safeCity || normalizedState || item.display_name;
    const mediumLabel = safeCity && county && normalizedState && county.toLowerCase() !== safeCity.toLowerCase()
      ? `${safeCity}, ${county}, ${normalizedState}`
      : shortLabel;

    return { shortLabel, mediumLabel };
  }

  const fallbackCity = city || county;
  const shortLabel = fallbackCity && state
    ? `${fallbackCity}, ${state}`
    : fallbackCity || state || item.display_name;

  return { shortLabel, mediumLabel: shortLabel };
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizePoint(point) {
  if (!point || typeof point !== 'object') return null;
  const lat = toFiniteNumber(point.lat ?? point.latitude);
  const lon = toFiniteNumber(point.lon ?? point.longitude);
  if (lat == null || lon == null) return null;
  return { lat, lon };
}

function buildLinearPoints(fromLat, fromLon, toLat, toLon, steps) {
  const safeSteps = Math.max(2, Math.min(500, Number(steps) || 12));
  const points = [];
  for (let i = 0; i < safeSteps; i += 1) {
    const t = safeSteps === 1 ? 1 : i / (safeSteps - 1);
    points.push({
      lat: fromLat + (toLat - fromLat) * t,
      lon: fromLon + (toLon - fromLon) * t
    });
  }
  return points;
}

module.exports = {
  firstText,
  buildLocationLabels,
  toFiniteNumber,
  normalizePoint,
  buildLinearPoints
};
