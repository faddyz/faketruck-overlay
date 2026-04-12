const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { isDeepStrictEqual } = require('node:util');
const {
  isAuthorizedSender,
  parseCoordinates,
  truncateForChat
} = require('./kick-utils');
const {
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
} = require('./lib/app-config');
const { createChatCommandService } = require('./lib/chat-commands');
const { createAdminEventsService } = require('./lib/admin-events');
const { createKickWsService } = require('./lib/kick-ws');
const { createStateStore } = require('./lib/state-store');
const {
  firstText,
  buildLocationLabels,
  toFiniteNumber,
  normalizePoint,
  buildLinearPoints
} = require('./lib/location-utils');

const WebSocketCtor = globalThis.WebSocket || require('ws');
const WS_CONNECTING = typeof WebSocketCtor.CONNECTING === 'number' ? WebSocketCtor.CONNECTING : 0;
const WS_OPEN = typeof WebSocketCtor.OPEN === 'number' ? WebSocketCtor.OPEN : 1;

const app = express();
const PORT = 3456;

const DATA_DIR = path.join(__dirname, 'data');
const KICK_STORE_PATH = path.join(DATA_DIR, 'kick-ws.json');
const APP_STATE_PATH = path.join(DATA_DIR, 'app-state.json');
const PRIVATE_STATE_PATH = path.join(DATA_DIR, 'private-state.json');
const ADMIN_EVENT_HISTORY_PATH = path.join(DATA_DIR, 'admin-events.json');
const KICK_CHANNEL_META_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const PROCESSED_MESSAGE_TTL_MS = 10 * 60 * 1000;
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const KICK_DEFAULTS = {
  wsAppKey: '32cbd69e4b950bf97679',
  wsCluster: 'us2',
  wsProtocol: 7,
  wsClient: 'js',
  wsVersion: '8.4.0',
  wsReconnectBaseMs: 2000,
  wsReconnectMaxMs: 30000,
  wsPingIntervalMs: 45000
};

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex <= 0) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = trimmed.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  } catch {
    // Keep running with existing process env.
  }
}

loadEnvFile();

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const configuredCorsOrigins = parseCsvList(process.env.CORS_ALLOWED_ORIGINS);
const defaultCorsOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];
const corsAllowlist = new Set(
  (configuredCorsOrigins.length > 0 ? configuredCorsOrigins : defaultCorsOrigins)
    .map(normalizeOrigin)
    .filter(Boolean)
);

function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, corsAllowlist.has(normalizeOrigin(origin)));
    }
  };
}

const WRITE_API_KEY = String(process.env.STATE_WRITE_API_KEY || '').trim();

if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production' && !WRITE_API_KEY) {
  throw new Error('STATE_WRITE_API_KEY is required in production.');
}

function resolveApiKeyFromRequest(req) {
  const direct = String(req.headers['x-admin-api-key'] || '').trim();
  if (direct) return direct;

  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return '';
}

function isLoopbackIp(value) {
  const ip = String(value || '').trim();
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.0.0.1');
}

function isLoopbackRequest(req) {
  if (isLoopbackIp(req.ip)) return true;
  if (isLoopbackIp(req.socket && req.socket.remoteAddress)) return true;
  return false;
}

function requireWriteApiKey(req, res, next) {
  if (!WRITE_API_KEY || isLoopbackRequest(req)) {
    next();
    return;
  }

  const provided = resolveApiKeyFromRequest(req);
  if (provided && provided === WRITE_API_KEY) {
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
}

app.use(cors(buildCorsOptions()));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseCsvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const safeTimeout = Math.max(1000, Number(timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), safeTimeout);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Upstream timeout after ${safeTimeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRateLimitedPath(pathname) {
  const pathText = String(pathname || '').trim();
  return pathText === '/api/location'
    || pathText === '/api/geocode'
    || pathText === '/api/reverse-geocode'
    || pathText === '/api/route'
    || pathText.startsWith('/api/rtirl-overlay/');
}

const rateLimitBuckets = new Map();

function cleanupRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (!bucket || Number(bucket.resetAt || 0) <= now) {
      rateLimitBuckets.delete(key);
    }
  }
}

function rateLimitPublicApi(req, res, next) {
  if (!isRateLimitedPath(req.path)) {
    next();
    return;
  }

  const now = Date.now();
  const clientId = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const key = `${clientId}:${req.path}`;
  const current = rateLimitBuckets.get(key);

  if (!current || now >= current.resetAt) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    });
    next();
    return;
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'rate_limited' });
    return;
  }

  current.count += 1;
  next();
}

setInterval(cleanupRateLimitBuckets, 60 * 1000).unref();

app.use(rateLimitPublicApi);

const ADMIN_EVENT_HISTORY_MAX = parsePositiveInt(process.env.ADMIN_EVENT_HISTORY_MAX, 2000);
const ADMIN_EVENT_HISTORY_DEFAULT_LIMIT = parsePositiveInt(process.env.ADMIN_EVENT_HISTORY_DEFAULT_LIMIT, 300);

function loadKickConfig() {
  const broadcasterSlug = String(process.env.KICK_BROADCASTER_SLUG || '').trim();
  const broadcasterUserId = parsePositiveInt(process.env.KICK_BROADCASTER_USER_ID, 0);
  const chatroomId = parsePositiveInt(process.env.KICK_CHATROOM_ID, 0);
  const whitelist = parseCsvSet(process.env.KICK_WHITELIST || '');

  return {
    broadcasterSlug,
    broadcasterUserId,
    chatroomId,
    prefix: String(process.env.KICK_COMMAND_PREFIX || '!ft').trim() || '!ft',
    whitelist,
    wsAppKey: String(process.env.KICK_WS_APP_KEY || KICK_DEFAULTS.wsAppKey).trim() || KICK_DEFAULTS.wsAppKey,
    wsCluster: String(process.env.KICK_WS_CLUSTER || KICK_DEFAULTS.wsCluster).trim() || KICK_DEFAULTS.wsCluster,
    wsProtocol: parsePositiveInt(process.env.KICK_WS_PROTOCOL, KICK_DEFAULTS.wsProtocol),
    wsClient: String(process.env.KICK_WS_CLIENT || KICK_DEFAULTS.wsClient).trim() || KICK_DEFAULTS.wsClient,
    wsVersion: String(process.env.KICK_WS_VERSION || KICK_DEFAULTS.wsVersion).trim() || KICK_DEFAULTS.wsVersion,
    wsReconnectBaseMs: parsePositiveInt(process.env.KICK_WS_RECONNECT_BASE_MS, KICK_DEFAULTS.wsReconnectBaseMs),
    wsReconnectMaxMs: parsePositiveInt(process.env.KICK_WS_RECONNECT_MAX_MS, KICK_DEFAULTS.wsReconnectMaxMs),
    wsPingIntervalMs: parsePositiveInt(process.env.KICK_WS_PING_INTERVAL_MS, KICK_DEFAULTS.wsPingIntervalMs),
    enabled: false
  };
}

const kickConfig = loadKickConfig();
kickConfig.enabled = Boolean(
  kickConfig.broadcasterSlug
  || (kickConfig.broadcasterUserId > 0 && kickConfig.chatroomId > 0)
);

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

const stateStore = createStateStore({
  fs,
  ensureDataDir,
  paths: {
    kickStorePath: KICK_STORE_PATH,
    appStatePath: APP_STATE_PATH,
    privateStatePath: PRIVATE_STATE_PATH
  },
  defaults: {
    defaultPrivateState: DEFAULT_PRIVATE_STATE,
    buildDefaultAppState,
    defaultOfferText: DEFAULT_OFFER_TEXT,
    overlayModes: OVERLAY_MODES
  },
  helpers: {
    sanitizeOfferText,
    normalizeChatCommandBindings
  }
});
const kickStore = stateStore.getKickStore();
const saveKickStore = stateStore.saveKickStore;
const applyStatePatch = stateStore.applyStatePatch;
const getPrivatePullKey = stateStore.getPrivatePullKey;
const buildPublicAppState = stateStore.buildPublicAppState;
const getPrivateState = stateStore.getPrivateState;
const getAppState = stateStore.getAppState;
const processedKickMessages = new Map();

const kickRuntime = {
  connectionStatus: 'idle',
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastDisconnectReason: null,
  lastMessageAt: null,
  lastCommandAt: null,
  lastCommandUser: null,
  lastCommandText: null,
  lastFeedback: null,
  channelMeta: kickStore.channel_meta || null,
  lastError: kickStore.last_error || null
};

const kickSocketState = {
  ws: null,
  pingTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  subscribedChannels: new Set()
};

const adminEvents = createAdminEventsService({
  fs,
  ensureDataDir,
  historyPath: ADMIN_EVENT_HISTORY_PATH,
  maxHistory: ADMIN_EVENT_HISTORY_MAX
});

function broadcastAdminEvent(eventName, payload) {
  return adminEvents.broadcast(eventName, payload);
}

function setKickError(message) {
  const safeMessage = String(message || '').trim();
  kickRuntime.lastError = safeMessage || null;
  kickStore.last_error = kickRuntime.lastError;
  saveKickStore();
}

function clearKickError() {
  kickRuntime.lastError = null;
  kickStore.last_error = null;
  saveKickStore();
}

function cleanupMapByExpiry(targetMap) {
  const now = Date.now();
  for (const [key, value] of targetMap.entries()) {
    if (!value || typeof value !== 'object' || Number(value.expiresAt || 0) <= now) {
      targetMap.delete(key);
    }
  }
}

setInterval(() => {
  cleanupMapByExpiry(processedKickMessages);
}, 60 * 1000).unref();

setInterval(() => {
  broadcastAdminEvent('heartbeat', { type: 'heartbeat' });
}, 20 * 1000).unref();

let mockLocationState = {
  enabled: false,
  points: [],
  index: 0,
  loop: false,
  advance_on_request: true
};

function nextMockPoint() {
  if (!mockLocationState.enabled || !mockLocationState.points.length) return null;

  const idx = Math.max(0, Math.min(mockLocationState.index, mockLocationState.points.length - 1));
  const point = mockLocationState.points[idx];

  if (mockLocationState.advance_on_request) {
    if (idx < mockLocationState.points.length - 1) {
      mockLocationState.index = idx + 1;
    } else if (mockLocationState.loop) {
      mockLocationState.index = 0;
    }
  }

  return {
    latitude: point.lat,
    longitude: point.lon,
    mocked: true,
    mock_index: idx,
    mock_total: mockLocationState.points.length
  };
}

function buildLocationPayload(item) {
  const lat = toFiniteNumber(item && (item.lat ?? item.latitude));
  const lon = toFiniteNumber(item && (item.lon ?? item.longitude));
  if (lat == null || lon == null) return null;

  const shortLabel = firstText(item.short_label, item.label, item.medium_label, item.full_label, item.display_name);
  const mediumLabel = firstText(item.medium_label, shortLabel, item.full_label, item.display_name);
  const fullLabel = firstText(item.full_label, item.display_name, mediumLabel, shortLabel);

  return {
    lat,
    lon,
    short_label: shortLabel || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    label: shortLabel || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    medium_label: mediumLabel || shortLabel || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
    full_label: fullLabel || mediumLabel || shortLabel || `${lat.toFixed(4)}, ${lon.toFixed(4)}`
  };
}

async function fetchRtirLocation(pullKey) {
  const mockPoint = nextMockPoint();
  if (mockPoint) return mockPoint;

  const response = await fetchWithTimeout(`https://rtirl.com/api/pull?key=${encodeURIComponent(pullKey)}`);
  if (!response.ok) {
    throw new Error(`RTIrl error: ${response.status}`);
  }

  const data = await response.json();
  return data && data.location ? data.location : data;
}

async function geocodeLookup(query, limit = 5) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${Math.max(1, Math.min(10, limit))}&addressdetails=1`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'FakeTruck-Stream/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Geocode error: ${response.status}`);
  }

  const data = await response.json();
  return data.map((item) => {
    const { shortLabel, mediumLabel } = buildLocationLabels(item);
    return {
      ...item,
      short_label: shortLabel,
      medium_label: mediumLabel
    };
  });
}

async function reverseGeocodeLookup(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error('lat and lon required');
  }

  const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}&format=json&addressdetails=1`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'FakeTruck-Stream/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Reverse geocode error: ${response.status}`);
  }

  const item = await response.json();
  const { shortLabel, mediumLabel } = buildLocationLabels(item);

  return {
    lat: latitude,
    lon: longitude,
    short_label: shortLabel,
    label: shortLabel,
    medium_label: mediumLabel,
    full_label: item.display_name || shortLabel
  };
}

async function routeLookup(fromLat, fromLon, toLat, toLon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Route error: ${response.status}`);
  }
  return response.json();
}
function logKickFeedback(kind, lines) {
  const normalizedKind = String(kind || 'info').toLowerCase();
  const arr = Array.isArray(lines)
    ? lines.map((line) => String(line || '').trim()).filter(Boolean)
    : [String(lines || '').trim()].filter(Boolean);

  if (arr.length > 0) {
    console.log(`[Kick][${normalizedKind}] ${arr.join(' | ')}`);
  }

  kickRuntime.lastFeedback = {
    at: new Date().toISOString(),
    kind: normalizedKind,
    lines: arr.slice(0, 6)
  };

  broadcastAdminEvent('kick_feedback', {
    type: 'kick_feedback',
    feedback: kickRuntime.lastFeedback,
    last_command_text: kickRuntime.lastCommandText || null,
    last_command_user: kickRuntime.lastCommandUser || null,
    last_command_at: kickRuntime.lastCommandAt || null
  });
}

async function pickupFromCurrentLocation() {
  const key = getPrivatePullKey();
  if (!key) {
    throw new Error('RTIRL key not set in state');
  }

  const location = await fetchRtirLocation(key);
  const latitude = toFiniteNumber(location && location.latitude);
  const longitude = toFiniteNumber(location && location.longitude);
  if (latitude == null || longitude == null) {
    throw new Error('Location data is unavailable');
  }

  const reverse = await reverseGeocodeLookup(latitude, longitude);
  const payload = buildLocationPayload(reverse);
  if (!payload) {
    throw new Error('Pickup address could not be resolved');
  }

  return payload;
}

const chatCommandService = createChatCommandService({
  CHAT_COMMAND_DEFS,
  CHAT_COMMAND_DEFS_BY_ID,
  OVERLAY_MODES,
  sanitizeCommandPrefix,
  sanitizeCommandKeyword,
  normalizeChatCommandBindings,
  normalizeLowerTr,
  foldCommandText,
  sanitizeOfferText,
  parseCoordinates,
  truncateForChat,
  geocodeLookup,
  reverseGeocodeLookup,
  buildLocationPayload,
  applyStatePatch,
  pickupFromCurrentLocation,
  getAppState
});
const {
  parseConfiguredChatCommand,
  validateChatCommandBindingsPatch,
  executeKickCommand,
  commandHelpLines
} = chatCommandService;
const kickWsService = createKickWsService({
  fetchWithTimeout,
  WebSocketCtor,
  WS_CONNECTING,
  WS_OPEN,
  kickConfig,
  kickRuntime,
  kickStore,
  kickSocketState,
  saveKickStore,
  setKickError,
  clearKickError,
  broadcastAdminEvent,
  logKickFeedback,
  parseConfiguredChatCommand,
  executeKickCommand,
  commandHelpLines,
  isAuthorizedSender,
  processedKickMessages,
  processedMessageTtlMs: PROCESSED_MESSAGE_TTL_MS,
  channelMetaCacheTtlMs: KICK_CHANNEL_META_CACHE_TTL_MS,
  cleanupMapByExpiry,
  getAppState
});
const { bootstrapKickIntegration } = kickWsService;

app.get('/api/state', (req, res) => res.json(buildPublicAppState()));

app.get('/api/events/history', (req, res) => {
  const requestedLimit = parsePositiveInt(req.query && req.query.limit, ADMIN_EVENT_HISTORY_DEFAULT_LIMIT);
  const limit = Math.min(requestedLimit, adminEvents.getMax());
  res.json({
    items: adminEvents.getHistory(limit),
    total: adminEvents.getTotal(),
    max: adminEvents.getMax(),
    limit
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const client = adminEvents.addClient(res);
  adminEvents.sendToClient(client, 'connected', {
    type: 'connected',
    connection_status: kickRuntime.connectionStatus,
    last_command_at: kickRuntime.lastCommandAt || null,
    last_command_user: kickRuntime.lastCommandUser || null,
    last_command_text: kickRuntime.lastCommandText || null,
    last_feedback: kickRuntime.lastFeedback || null
  });

  req.on('close', () => {
    adminEvents.removeClient(client);
  });
});

const STATE_PATCH_ALLOWED_KEYS = new Set([
  'destination',
  'pickup',
  'show_pickup',
  'fare_amount',
  'show_fare',
  'cargo_text',
  'show_cargo',
  'overlay_mode',
  'offer_custom_text',
  'show_road_hud_overlay',
  'show_location_time_overlay',
  'show_map_overlay',
  'chat_command_bindings',
  'chat_command_bindings_reset',
  'command_prefix',
  'command_aliases',
  'rtirl_key'
]);

app.post('/api/state', requireWriteApiKey, (req, res) => {
  const patch = req.body && typeof req.body === 'object' ? { ...req.body } : {};
  const incomingKeys = Object.keys(patch);
  const unsupportedKeys = incomingKeys.filter((key) => !STATE_PATCH_ALLOWED_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    return res.status(400).json({ error: `unsupported_keys: ${unsupportedKeys.join(',')}` });
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'rtirl_key')) {
    const nextKey = typeof patch.rtirl_key === 'string' ? patch.rtirl_key.trim() : String(patch.rtirl_key || '').trim();
    if (nextKey.length > 512) {
      return res.status(400).json({ error: 'rtirl_key_too_long' });
    }
  }

  if (patch.chat_command_bindings_reset === true) {
    patch.chat_command_bindings = buildDefaultChatCommandBindings();
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'chat_command_bindings')) {
    const currentAppState = getAppState();
    const validation = validateChatCommandBindingsPatch(
      patch.chat_command_bindings,
      currentAppState.chat_command_bindings
    );
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    patch.chat_command_bindings = validation.bindings;
  }

  delete patch.command_aliases;
  delete patch.command_prefix;
  delete patch.chat_command_bindings_reset;

  const previousState = { ...getAppState() };
  const previousHasKey = Boolean(getPrivatePullKey());
  const previousKeyRevision = Number(getPrivateState().rtirl_key_revision || 0);
  const patchResult = applyStatePatch(patch);
  const nextState = getAppState();
  const changedKeys = Object.keys(patch).filter((key) => !isDeepStrictEqual(previousState[key], nextState[key]));
  if (patchResult.privateKeyChanged) {
    changedKeys.push('rtirl_key');
  }
  if (previousHasKey !== Boolean(getPrivatePullKey())) {
    changedKeys.push('has_rtirl_key');
  }
  if (previousKeyRevision !== Number(getPrivateState().rtirl_key_revision || 0)) {
    changedKeys.push('rtirl_key_revision');
  }
  const commandBindingKeys = patch.chat_command_bindings && typeof patch.chat_command_bindings === 'object'
    ? Object.keys(patch.chat_command_bindings)
    : [];
  if (changedKeys.length > 0) {
    broadcastAdminEvent('state_patch', {
      type: 'state_patch',
      source: 'panel',
      changed_keys: changedKeys,
      command_binding_keys: commandBindingKeys,
      requested_keys: incomingKeys
    });
  }
  res.json({ success: true });
});

function canUsePullKeyOverride(req) {
  if (isLoopbackRequest(req)) return true;
  if (!WRITE_API_KEY) return false;
  const provided = resolveApiKeyFromRequest(req);
  return Boolean(provided && provided === WRITE_API_KEY);
}

function resolvePullKeyFromRequest(req) {
  const stateKey = getPrivatePullKey();
  if (!canUsePullKeyOverride(req)) {
    return stateKey;
  }

  const bodyKey = req && req.body && typeof req.body === 'object'
    ? req.body.pullKey
    : '';
  const queryKey = req && req.query ? req.query.pullKey : '';
  const resolved = String(bodyKey || queryKey || stateKey || '').trim();
  return resolved;
}

async function handleLocationRequest(req, res) {
  const pullKey = resolvePullKeyFromRequest(req);
  if (!pullKey) return res.status(400).json({ error: 'RTIRL key ayarlanmadi' });

  try {
    const location = await fetchRtirLocation(pullKey);
    res.json(location);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

app.get('/api/location', handleLocationRequest);
app.post('/api/location', handleLocationRequest);

app.get(/^\/api\/rtirl-overlay\/(.+)$/, async (req, res) => {
  const pullKey = getPrivatePullKey();
  if (!pullKey) {
    res.status(400).type('text/plain; charset=utf-8').send('RTIRL key ayarlanmadi');
    return;
  }

  const relativePath = String(req.params[0] || '').replace(/^\/+/, '');
  if (!relativePath) {
    res.status(400).json({ error: 'overlay_path_required' });
    return;
  }

  try {
    const targetUrl = new URL(`https://overlays.rtirl.com/${relativePath}`);
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    for (const [key, value] of Object.entries(query)) {
      if (key === 'key' || value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item != null) targetUrl.searchParams.append(key, String(item));
        }
      } else {
        targetUrl.searchParams.set(key, String(value));
      }
    }
    targetUrl.searchParams.set('key', pullKey);

    const upstream = await fetchWithTimeout(targetUrl.toString(), {
      headers: {
        Accept: String(req.headers.accept || '*/*'),
        'User-Agent': 'FakeTruck-Proxy/1.0'
      }
    });

    const passthroughHeaders = [
      'content-type',
      'cache-control',
      'etag',
      'last-modified',
      'expires'
    ];
    for (const headerName of passthroughHeaders) {
      const headerValue = upstream.headers.get(headerName);
      if (headerValue) {
        res.setHeader(headerName, headerValue);
      }
    }
    res.setHeader('x-content-type-options', 'nosniff');

    const body = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status).send(body);
  } catch (error) {
    res.status(502).json({ error: error.message || 'overlay_proxy_failed' });
  }
});

app.get('/api/mock-location/status', (req, res) => {
  const current = mockLocationState.points[mockLocationState.index] || null;
  res.json({
    enabled: mockLocationState.enabled,
    points_count: mockLocationState.points.length,
    index: mockLocationState.index,
    loop: mockLocationState.loop,
    advance_on_request: mockLocationState.advance_on_request,
    current_point: current
  });
});

app.post('/api/mock-location/start', requireWriteApiKey, (req, res) => {
  const {
    points,
    fromLat,
    fromLon,
    toLat,
    toLon,
    steps,
    loop,
    advance_on_request
  } = req.body || {};

  let resolvedPoints = [];

  if (Array.isArray(points) && points.length > 0) {
    resolvedPoints = points.map(normalizePoint).filter(Boolean);
  } else {
    const fl = toFiniteNumber(fromLat);
    const fo = toFiniteNumber(fromLon);
    const tl = toFiniteNumber(toLat);
    const to = toFiniteNumber(toLon);
    if (fl != null && fo != null && tl != null && to != null) {
      resolvedPoints = buildLinearPoints(fl, fo, tl, to, steps);
    }
  }

  if (!resolvedPoints.length) {
    return res.status(400).json({
      error: 'Gecerli points dizisi verin veya from/to koordinatlari ile lineer rota olusturun'
    });
  }

  mockLocationState = {
    enabled: true,
    points: resolvedPoints,
    index: 0,
    loop: Boolean(loop),
    advance_on_request: advance_on_request !== undefined ? Boolean(advance_on_request) : true
  };

  res.json({
    success: true,
    message: 'Mock location baslatildi',
    points_count: mockLocationState.points.length,
    loop: mockLocationState.loop,
    advance_on_request: mockLocationState.advance_on_request
  });
});

app.post('/api/mock-location/step', requireWriteApiKey, (req, res) => {
  if (!mockLocationState.enabled || !mockLocationState.points.length) {
    return res.status(400).json({ error: 'Mock location aktif degil' });
  }

  if (mockLocationState.index < mockLocationState.points.length - 1) {
    mockLocationState.index += 1;
  } else if (mockLocationState.loop) {
    mockLocationState.index = 0;
  }

  const point = mockLocationState.points[mockLocationState.index];
  res.json({
    success: true,
    index: mockLocationState.index,
    latitude: point.lat,
    longitude: point.lon
  });
});

app.post('/api/mock-location/stop', requireWriteApiKey, (req, res) => {
  mockLocationState = {
    enabled: false,
    points: [],
    index: 0,
    loop: false,
    advance_on_request: true
  };
  res.json({ success: true, message: 'Mock location kapatildi' });
});

app.get('/api/route', async (req, res) => {
  const { fromLat, fromLon, toLat, toLon } = req.query;
  if (!fromLat || !fromLon || !toLat || !toLon) {
    return res.status(400).json({ error: 'Koordinatlar eksik' });
  }

  try {
    const route = await routeLookup(fromLat, fromLon, toLat, toLon);
    res.json(route);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q gerekli' });

  try {
    const result = await geocodeLookup(String(q), 5);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  try {
    const reverse = await reverseGeocodeLookup(lat, lon);
    res.json(reverse);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.get('/api/kick/status', async (req, res) => {
  const currentAppState = getAppState();
  const connected = Boolean(
    kickSocketState.ws && kickSocketState.ws.readyState === WS_OPEN
  );

  res.json({
    enabled: kickConfig.enabled,
    config: {
      broadcaster_slug: kickConfig.broadcasterSlug || null,
      broadcaster_user_id: kickConfig.broadcasterUserId || null,
      chatroom_id: kickConfig.chatroomId || null,
      chat_command_bindings: currentAppState.chat_command_bindings,
      whitelist: Array.from(kickConfig.whitelist.values()),
      ws: {
        app_key: kickConfig.wsAppKey,
        cluster: kickConfig.wsCluster,
        protocol: kickConfig.wsProtocol,
        client: kickConfig.wsClient,
        version: kickConfig.wsVersion,
        reconnect_base_ms: kickConfig.wsReconnectBaseMs,
        reconnect_max_ms: kickConfig.wsReconnectMaxMs,
        ping_interval_ms: kickConfig.wsPingIntervalMs
      }
    },
    channel: kickRuntime.channelMeta,
    connection: {
      status: kickRuntime.connectionStatus,
      connected,
      reconnect_attempts: kickSocketState.reconnectAttempts,
      last_connected_at: kickRuntime.lastConnectedAt,
      last_disconnected_at: kickRuntime.lastDisconnectedAt,
      last_disconnect_reason: kickRuntime.lastDisconnectReason,
      subscribed_channels: Array.from(kickSocketState.subscribedChannels.values())
    },
    runtime: {
      last_message_at: kickRuntime.lastMessageAt,
      last_command_at: kickRuntime.lastCommandAt,
      last_command_user: kickRuntime.lastCommandUser,
      last_command_text: kickRuntime.lastCommandText,
      last_feedback: kickRuntime.lastFeedback,
      last_error: kickRuntime.lastError
    },
    event_log: {
      total: adminEvents.getTotal(),
      max: adminEvents.getMax()
    }
  });
});
function startServer(port = PORT, options = {}) {
  const {
    bootstrapKick = true,
    logStartup = true
  } = options;
  const host = String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0';

  return app.listen(port, host, () => {
    if (logStartup) {
      console.log(`\nFakeTruck server running: http://${host}:${port}`);
      console.log(`   Admin Panel : http://localhost:${port}/admin.html`);
      console.log(`   OBS Overlay : http://localhost:${port}/road-overlay.html`);
      console.log(`   Kick Status : http://localhost:${port}/api/kick/status\n`);
    }

    if (bootstrapKick) {
      bootstrapKickIntegration();
    }
  });
}

if (require.main === module) {
  startServer(PORT, { bootstrapKick: true, logStartup: true });
}

module.exports = {
  app,
  startServer,
  CHAT_COMMAND_DEFS,
  DEFAULT_CHAT_COMMAND_BINDINGS,
  buildDefaultChatCommandBindings,
  normalizeChatCommandBindings,
  parseConfiguredChatCommand,
  validateChatCommandBindingsPatch
};
