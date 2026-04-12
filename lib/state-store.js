function createStateStore(deps) {
  const {
    fs,
    ensureDataDir,
    paths,
    defaults,
    helpers
  } = deps;

  const {
    kickStorePath,
    appStatePath,
    privateStatePath
  } = paths;

  const {
    defaultPrivateState,
    buildDefaultAppState,
    defaultOfferText,
    overlayModes
  } = defaults;

  const {
    sanitizeOfferText,
    normalizeChatCommandBindings
  } = helpers;

  function normalizeKickStore(data) {
    const safe = data && typeof data === 'object' ? data : {};
    const rawMeta = safe.channel_meta && typeof safe.channel_meta === 'object'
      ? safe.channel_meta
      : null;
    const channelMeta = rawMeta
      ? {
          slug: String(rawMeta.slug || '').trim(),
          broadcaster_user_id: Number(rawMeta.broadcaster_user_id || 0),
          chatroom_id: Number(rawMeta.chatroom_id || 0),
          resolved_at: rawMeta.resolved_at || null
        }
      : null;

    return {
      channel_meta: channelMeta
        && channelMeta.slug
        && Number.isFinite(channelMeta.broadcaster_user_id)
        && channelMeta.broadcaster_user_id > 0
        && Number.isFinite(channelMeta.chatroom_id)
        && channelMeta.chatroom_id > 0
        ? channelMeta
        : null,
      last_error: safe.last_error || null,
      updated_at: safe.updated_at || null
    };
  }

  function loadKickStore() {
    ensureDataDir();
    if (!fs.existsSync(kickStorePath)) {
      return normalizeKickStore({});
    }

    try {
      const raw = fs.readFileSync(kickStorePath, 'utf8');
      return normalizeKickStore(JSON.parse(raw));
    } catch {
      return normalizeKickStore({});
    }
  }

  const kickStore = loadKickStore();

  function saveKickStore() {
    ensureDataDir();
    kickStore.updated_at = new Date().toISOString();
    fs.writeFileSync(kickStorePath, JSON.stringify(kickStore, null, 2), 'utf8');
  }

  function normalizePrivateState(value) {
    const safe = value && typeof value === 'object' ? value : {};
    const key = typeof safe.rtirl_key === 'string'
      ? safe.rtirl_key.trim()
      : safe.rtirl_key == null
        ? ''
        : String(safe.rtirl_key).trim();
    const revision = Number(safe.rtirl_key_revision);
    return {
      rtirl_key: key,
      rtirl_key_revision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0
    };
  }

  function loadPrivateState() {
    ensureDataDir();
    if (!fs.existsSync(privateStatePath)) {
      return { ...defaultPrivateState };
    }

    try {
      const raw = fs.readFileSync(privateStatePath, 'utf8');
      return normalizePrivateState(JSON.parse(raw));
    } catch {
      return { ...defaultPrivateState };
    }
  }

  let privateState = loadPrivateState();
  let appState = buildDefaultAppState();

  function savePrivateState() {
    ensureDataDir();
    privateState = normalizePrivateState(privateState);
    fs.writeFileSync(privateStatePath, JSON.stringify(privateState, null, 2), 'utf8');
  }

  function setPrivatePullKey(nextKey) {
    const value = typeof nextKey === 'string'
      ? nextKey.trim()
      : nextKey == null
        ? ''
        : String(nextKey).trim();
    const previous = String(privateState.rtirl_key || '');
    if (value === previous) return false;
    privateState.rtirl_key = value;
    privateState.rtirl_key_revision = Number(privateState.rtirl_key_revision || 0) + 1;
    savePrivateState();
    return true;
  }

  function getPrivatePullKey() {
    return String(privateState.rtirl_key || '').trim();
  }

  function sanitizeState() {
    if (!appState.pickup) {
      appState.show_pickup = false;
    }

    delete appState.overlay_view;
    delete appState.rtirl_key;

    appState.show_pickup = Boolean(appState.show_pickup);
    appState.fare_amount = typeof appState.fare_amount === 'string'
      ? appState.fare_amount.trim()
      : appState.fare_amount == null
        ? ''
        : String(appState.fare_amount).trim();
    appState.show_fare = Boolean(appState.show_fare);

    appState.cargo_text = typeof appState.cargo_text === 'string'
      ? appState.cargo_text.trim()
      : appState.cargo_text == null
        ? ''
        : String(appState.cargo_text).trim();
    appState.show_cargo = Boolean(appState.show_cargo);
    appState.offer_default_text = defaultOfferText;
    appState.offer_custom_text = sanitizeOfferText(appState.offer_custom_text, '');
    const overlayMode = String(appState.overlay_mode || '').trim().toLowerCase();
    appState.overlay_mode = overlayModes.has(overlayMode) ? overlayMode : 'normal';

    appState.show_road_hud_overlay = appState.show_road_hud_overlay !== false;
    appState.show_location_time_overlay = appState.show_location_time_overlay !== false;
    appState.show_map_overlay = Boolean(appState.show_map_overlay);
    appState.chat_command_bindings = normalizeChatCommandBindings(appState.chat_command_bindings);
    delete appState.command_prefix;
    delete appState.command_aliases;
  }

  function saveAppState() {
    ensureDataDir();
    sanitizeState();
    fs.writeFileSync(appStatePath, JSON.stringify(appState, null, 2), 'utf8');
  }

  function applyStatePatch(patch) {
    const body = patch && typeof patch === 'object' ? { ...patch } : {};
    let privateKeyChanged = false;
    if (Object.prototype.hasOwnProperty.call(body, 'rtirl_key')) {
      privateKeyChanged = setPrivatePullKey(body.rtirl_key);
      delete body.rtirl_key;
    }
    delete body.offer_default_text;
    const hasPickupUpdate = Object.prototype.hasOwnProperty.call(body, 'pickup');

    appState = { ...appState, ...body };

    if (hasPickupUpdate && body.pickup === null) {
      appState.show_pickup = false;
    }

    sanitizeState();
    saveAppState();
    return {
      state: appState,
      privateKeyChanged
    };
  }

  function loadAppState() {
    ensureDataDir();

    if (!fs.existsSync(appStatePath)) {
      appState = buildDefaultAppState();
      sanitizeState();
      return;
    }

    try {
      const raw = fs.readFileSync(appStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      const safe = parsed && typeof parsed === 'object' ? parsed : {};
      const migratedPullKey = typeof safe.rtirl_key === 'string' ? safe.rtirl_key.trim() : '';
      if (migratedPullKey && !getPrivatePullKey()) {
        setPrivatePullKey(migratedPullKey);
      }
      appState = { ...buildDefaultAppState(), ...safe };
      appState.offer_custom_text = '';
      sanitizeState();
      saveAppState();
    } catch {
      appState = buildDefaultAppState();
      sanitizeState();
    }
  }

  loadAppState();

  function buildPublicAppState() {
    const pullKey = getPrivatePullKey();
    return {
      ...appState,
      rtirl_key: pullKey,
      has_rtirl_key: Boolean(pullKey),
      rtirl_key_revision: Number(privateState.rtirl_key_revision || 0)
    };
  }

  function getAppState() {
    return appState;
  }

  function getPrivateState() {
    return privateState;
  }

  function getKickStore() {
    return kickStore;
  }

  return {
    getKickStore,
    saveKickStore,
    getAppState,
    getPrivateState,
    getPrivatePullKey,
    setPrivatePullKey,
    buildPublicAppState,
    applyStatePatch
  };
}

module.exports = {
  createStateStore
};
