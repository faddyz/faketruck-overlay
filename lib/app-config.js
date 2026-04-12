const OVERLAY_MODES = new Set(['normal', 'offer', 'pickup']);
const DEFAULT_OFFER_TEXT = 'Yeni i\u015f teklifleri; ta\u015f\u0131nacak y\u00fck bekliyor.';
const OFFER_TEXT_MAX_LENGTH = 240;

const CHAT_COMMAND_DEFS = [
  { id: 'help', section: 'commands', label: 'Yardim', root: 'help', action: null, valueKind: null },
  { id: 'overlay_location_show', section: 'location_overlay', label: 'Lokasyon Goster', root: 'loc', action: 'on', valueKind: null },
  { id: 'overlay_location_hide', section: 'location_overlay', label: 'Lokasyon Gizle', root: 'loc', action: 'off', valueKind: null },
  { id: 'overlay_map_show', section: 'map_overlay', label: 'Harita Goster', root: 'map', action: 'on', valueKind: null },
  { id: 'overlay_map_hide', section: 'map_overlay', label: 'Harita Gizle', root: 'map', action: 'off', valueKind: null },
  { id: 'overlay_road_show', section: 'road_overlay', label: 'Yol Goster', root: 'road', action: 'on', valueKind: null },
  { id: 'overlay_road_hide', section: 'road_overlay', label: 'Yol Gizle', root: 'road', action: 'off', valueKind: null },
  { id: 'mode_offer', section: 'overlay_modes', label: 'Is/Yuk Bekliyor', root: 'mode', action: 'offer', valueKind: null },
  { id: 'mode_custom', section: 'overlay_modes', label: 'Bekleme Metni Yaz', root: 'mode', action: 'custom', valueKind: 'text' },
  { id: 'mode_normal', section: 'overlay_modes', label: 'Normal Gorunum', root: 'mode', action: 'normal', valueKind: null },
  { id: 'mode_pickup', section: 'overlay_modes', label: 'Pickup Gorunumu', root: 'mode', action: 'pickup', valueKind: null },
  { id: 'fare_set', section: 'fare', label: 'Ucret Ayarla', root: 'fare', action: 'set', valueKind: 'text' },
  { id: 'fare_clear', section: 'fare', label: 'Ucret Sil', root: 'fare', action: 'clear', valueKind: null },
  { id: 'fare_show', section: 'fare', label: 'Ucret Goster', root: 'fare', action: 'show', valueKind: null },
  { id: 'fare_hide', section: 'fare', label: 'Ucret Gizle', root: 'fare', action: 'hide', valueKind: null },
  { id: 'cargo_set', section: 'cargo', label: 'Yuk Belirle', root: 'cargo', action: 'set', valueKind: 'text' },
  { id: 'cargo_clear', section: 'cargo', label: 'Yuk Temizle', root: 'cargo', action: 'clear', valueKind: null },
  { id: 'cargo_show', section: 'cargo', label: 'Yuk Goster', root: 'cargo', action: 'show', valueKind: null },
  { id: 'cargo_hide', section: 'cargo', label: 'Yuk Gizle', root: 'cargo', action: 'hide', valueKind: null },
  { id: 'dest_search', section: 'destination', label: 'Varis Konum Ara', root: 'dest', action: 'ara', valueKind: 'address' },
  { id: 'dest_coords', section: 'destination', label: 'Varis Koordinat', root: 'dest', action: 'k', valueKind: 'coords' },
  { id: 'dest_clear', section: 'destination', label: 'Varis Sil', root: 'dest', action: 'clear', valueKind: null },
  { id: 'pickup_search', section: 'pickup', label: 'Baslangic Konum Ara', root: 'pickup', action: 'ara', valueKind: 'address' },
  { id: 'pickup_coords', section: 'pickup', label: 'Baslangic Koordinat', root: 'pickup', action: 'k', valueKind: 'coords' },
  { id: 'pickup_current', section: 'pickup', label: 'Baslangic Anlik', root: 'pickup', action: 'current', valueKind: null },
  { id: 'pickup_show', section: 'pickup', label: 'Baslangic Goster', root: 'pickup', action: 'show', valueKind: null },
  { id: 'pickup_hide', section: 'pickup', label: 'Baslangic Gizle', root: 'pickup', action: 'hide', valueKind: null },
  { id: 'pickup_clear', section: 'pickup', label: 'Baslangic Sil', root: 'pickup', action: 'clear', valueKind: null }
];

const CHAT_COMMAND_DEFS_BY_ID = new Map(CHAT_COMMAND_DEFS.map((item) => [item.id, item]));

const DEFAULT_CHAT_COMMAND_BINDINGS = {
  help: { prefix: '!', keyword: 'yardim' },
  overlay_location_show: { prefix: '!', keyword: 'lokasyongoster' },
  overlay_location_hide: { prefix: '!', keyword: 'lokasyongizle' },
  overlay_map_show: { prefix: '!', keyword: 'mapgoster' },
  overlay_map_hide: { prefix: '!', keyword: 'mapgizle' },
  overlay_road_show: { prefix: '!', keyword: 'yolgoster' },
  overlay_road_hide: { prefix: '!', keyword: 'yolgizle' },
  mode_offer: { prefix: '!', keyword: 'bekleme' },
  mode_custom: { prefix: '!', keyword: 'custom' },
  mode_normal: { prefix: '!', keyword: 'yoloverlay' },
  mode_pickup: { prefix: '!', keyword: 'yukegidiyor' },
  fare_set: { prefix: '!', keyword: 'ucret' },
  fare_clear: { prefix: '!', keyword: 'ucretsil' },
  fare_show: { prefix: '!', keyword: 'ucretgoster' },
  fare_hide: { prefix: '!', keyword: 'ucretgizle' },
  cargo_set: { prefix: '!', keyword: 'yuk' },
  cargo_clear: { prefix: '!', keyword: 'yuksil' },
  cargo_show: { prefix: '!', keyword: 'yukgoster' },
  cargo_hide: { prefix: '!', keyword: 'yukgizle' },
  dest_search: { prefix: '!', keyword: 'variskonum' },
  dest_coords: { prefix: '!', keyword: 'variskoordinat' },
  dest_clear: { prefix: '!', keyword: 'variskonumsil' },
  pickup_search: { prefix: '!', keyword: 'baslangickonum' },
  pickup_coords: { prefix: '!', keyword: 'baslangickoordinat' },
  pickup_current: { prefix: '!', keyword: 'baslangicanlik' },
  pickup_show: { prefix: '!', keyword: 'baslangicgoster' },
  pickup_hide: { prefix: '!', keyword: 'baslangicgizle' },
  pickup_clear: { prefix: '!', keyword: 'baslangicsil' }
};

const DEFAULT_APP_STATE = {
  destination: null,
  pickup: null,
  show_pickup: false,
  fare_amount: '',
  show_fare: false,
  cargo_text: '',
  show_cargo: false,
  overlay_mode: 'normal',
  offer_default_text: DEFAULT_OFFER_TEXT,
  offer_custom_text: '',
  show_road_hud_overlay: true,
  show_location_time_overlay: true,
  show_map_overlay: false,
  chat_command_bindings: null
};

const DEFAULT_PRIVATE_STATE = {
  rtirl_key: '',
  rtirl_key_revision: 0
};

function sanitizeCommandPrefix(value, fallback = '!') {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized) return fallback;
  if (normalized.startsWith('!')) return normalized;
  return `!${normalized}`;
}

function normalizeLowerTr(value) {
  return String(value == null ? '' : value).trim().toLocaleLowerCase('tr-TR');
}

function foldCommandText(value) {
  return normalizeLowerTr(value)
    .replace(/\u00E7/g, 'c')
    .replace(/\u011F/g, 'g')
    .replace(/\u0131/g, 'i')
    .replace(/\u00F6/g, 'o')
    .replace(/\u015F/g, 's')
    .replace(/\u00FC/g, 'u')
    .replace(/\u00E2/g, 'a')
    .replace(/\u00EE/g, 'i')
    .replace(/\u00FB/g, 'u');
}

function stripOfferEmoji(value) {
  return String(value || '')
    .replace(/[\u200D\uFE0E\uFE0F]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}]/gu, '');
}

function sanitizeOfferText(value, fallback = '') {
  const raw = typeof value === 'string'
    ? value
    : value == null
      ? ''
      : String(value);
  const text = stripOfferEmoji(raw).replace(/\s+/g, ' ').trim();
  const limited = text.slice(0, OFFER_TEXT_MAX_LENGTH);
  if (limited) return limited;
  const fallbackText = stripOfferEmoji(String(fallback || '')).replace(/\s+/g, ' ').trim();
  return fallbackText.slice(0, OFFER_TEXT_MAX_LENGTH);
}

function sanitizeCommandKeyword(value, fallback) {
  const normalized = normalizeLowerTr(value).replace(/^!+/, '');
  if (!normalized) return fallback;
  return normalized.split(/\s+/)[0];
}

function buildDefaultChatCommandBindings() {
  const next = {};
  for (const definition of CHAT_COMMAND_DEFS) {
    const fallback = DEFAULT_CHAT_COMMAND_BINDINGS[definition.id] || { prefix: '!', keyword: definition.id };
    next[definition.id] = {
      prefix: sanitizeCommandPrefix(fallback.prefix, '!'),
      keyword: sanitizeCommandKeyword(fallback.keyword, definition.id)
    };
  }
  return next;
}

function normalizeChatCommandBindings(value, baseBindings = null) {
  const defaults = baseBindings && typeof baseBindings === 'object'
    ? baseBindings
    : buildDefaultChatCommandBindings();
  const source = value && typeof value === 'object' ? value : {};
  const next = {};

  for (const definition of CHAT_COMMAND_DEFS) {
    const fallback = defaults[definition.id] || { prefix: '!', keyword: definition.id };
    const incoming = source[definition.id] && typeof source[definition.id] === 'object'
      ? source[definition.id]
      : null;
    next[definition.id] = {
      prefix: sanitizeCommandPrefix(incoming ? incoming.prefix : fallback.prefix, fallback.prefix),
      keyword: sanitizeCommandKeyword(incoming ? incoming.keyword : fallback.keyword, fallback.keyword)
    };
  }

  return next;
}

function buildDefaultAppState() {
  return {
    ...DEFAULT_APP_STATE,
    chat_command_bindings: normalizeChatCommandBindings(DEFAULT_CHAT_COMMAND_BINDINGS)
  };
}

module.exports = {
  OVERLAY_MODES,
  DEFAULT_OFFER_TEXT,
  CHAT_COMMAND_DEFS,
  CHAT_COMMAND_DEFS_BY_ID,
  DEFAULT_CHAT_COMMAND_BINDINGS,
  DEFAULT_PRIVATE_STATE,
  buildDefaultChatCommandBindings,
  normalizeChatCommandBindings,
  buildDefaultAppState,
  sanitizeOfferText,
  sanitizeCommandPrefix,
  sanitizeCommandKeyword,
  foldCommandText,
  normalizeLowerTr
};
