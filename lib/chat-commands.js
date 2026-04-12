function createChatCommandService(deps) {
  const {
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
    buildLocationPayload,
    applyStatePatch,
    pickupFromCurrentLocation,
    getAppState
  } = deps;

  function getCommandDefinition(commandId) {
    return CHAT_COMMAND_DEFS_BY_ID.get(commandId) || null;
  }

  function commandArgPlaceholder(valueKind) {
    if (valueKind === 'text') return '<metin>';
    if (valueKind === 'address') return '<adres>';
    if (valueKind === 'coords') return '<lat,lon>';
    return '';
  }

  function composeCommandSyntax(prefix, keyword, argText = '') {
    const safePrefix = sanitizeCommandPrefix(prefix, '!');
    const safeKeyword = sanitizeCommandKeyword(keyword, 'komut');
    const base = safePrefix.length === 1
      ? `${safePrefix}${safeKeyword}`
      : `${safePrefix} ${safeKeyword}`;
    const safeArg = String(argText || '').trim();
    return safeArg ? `${base} ${safeArg}` : base;
  }

  function getBindingByCommandId(commandId, bindings = null) {
    const currentBindings = bindings || getAppState().chat_command_bindings;
    const source = normalizeChatCommandBindings(currentBindings);
    return source[commandId] || null;
  }

  function formatCommandUsageById(commandId, argOverride = null) {
    const definition = getCommandDefinition(commandId);
    if (!definition) return '';
    const binding = getBindingByCommandId(commandId);
    if (!binding) return '';
    const arg = argOverride == null ? commandArgPlaceholder(definition.valueKind) : String(argOverride || '').trim();
    return composeCommandSyntax(binding.prefix, binding.keyword, arg);
  }

  function matchesPrefix(text, prefix) {
    return normalizeLowerTr(text.slice(0, prefix.length)) === normalizeLowerTr(prefix);
  }

  function matchesCommandToken(inputToken, keyword) {
    const inputNorm = normalizeLowerTr(inputToken);
    const keyNorm = normalizeLowerTr(keyword);
    if (inputNorm === keyNorm) return true;
    return foldCommandText(inputToken) === foldCommandText(keyword);
  }

  function extractTokenAndRemainder(rawText) {
    const trimmedStart = rawText.replace(/^\s+/, '');
    if (!trimmedStart) return null;
    const match = trimmedStart.match(/^(\S+)([\s\S]*)$/);
    if (!match) return null;
    return {
      token: match[1],
      tailRaw: match[2] || ''
    };
  }

  function tryMatchCommandTrigger(content, prefix, keyword) {
    const text = String(content || '').trim();
    if (!text) return null;

    const safePrefix = sanitizeCommandPrefix(prefix, '!');
    const safeKeyword = sanitizeCommandKeyword(keyword, 'komut');

    if (safePrefix.length === 1) {
      if (!text.startsWith(safePrefix)) return null;
      const afterPrefix = text.slice(safePrefix.length);
      if (!afterPrefix || /^\s/.test(afterPrefix)) return null;
      const tokenized = extractTokenAndRemainder(afterPrefix);
      if (!tokenized) return null;
      if (!matchesCommandToken(tokenized.token, safeKeyword)) return null;
      return {
        remainder: tokenized.tailRaw.trim(),
        rawKeyword: tokenized.token
      };
    }

    if (!matchesPrefix(text, safePrefix)) return null;
    const afterPrefixRaw = text.slice(safePrefix.length);
    if (!/^\s+/.test(afterPrefixRaw)) return null;
    const tokenized = extractTokenAndRemainder(afterPrefixRaw);
    if (!tokenized) return null;
    if (!matchesCommandToken(tokenized.token, safeKeyword)) return null;
    return {
      remainder: tokenized.tailRaw.trim(),
      rawKeyword: tokenized.token
    };
  }

  function parseConfiguredChatCommand(content, bindingsOverride = null) {
    const text = String(content || '').trim();
    if (!text) return { matched: false };

    const bindings = normalizeChatCommandBindings(
      bindingsOverride && typeof bindingsOverride === 'object'
        ? bindingsOverride
        : getAppState().chat_command_bindings
    );
    for (const definition of CHAT_COMMAND_DEFS) {
      const binding = bindings[definition.id];
      if (!binding) continue;

      const trigger = tryMatchCommandTrigger(text, binding.prefix, binding.keyword);
      if (!trigger) continue;

      if (definition.valueKind && !trigger.remainder) {
        return {
          matched: true,
          valid: false,
          error: 'value_required',
          usage: formatCommandUsageById(definition.id),
          command_id: definition.id
        };
      }

      if (!definition.valueKind && trigger.remainder) {
        return {
          matched: true,
          valid: false,
          error: 'extra_value_not_allowed',
          usage: formatCommandUsageById(definition.id),
          command_id: definition.id
        };
      }

      return {
        matched: true,
        valid: true,
        command_id: definition.id,
        raw: trigger.remainder
          ? `${trigger.rawKeyword} ${trigger.remainder}`
          : trigger.rawKeyword,
        root: definition.root || '',
        action: definition.action || '',
        remainder: trigger.remainder
      };
    }

    return { matched: false };
  }

  function validateChatCommandBindingsPatch(patchBindings, currentBindings) {
    const current = normalizeChatCommandBindings(currentBindings);
    const source = patchBindings && typeof patchBindings === 'object' ? patchBindings : {};
    const merged = {};

    for (const definition of CHAT_COMMAND_DEFS) {
      const fallback = current[definition.id] || { prefix: '!', keyword: definition.id };
      const incoming = source[definition.id] && typeof source[definition.id] === 'object'
        ? source[definition.id]
        : null;
      merged[definition.id] = {
        prefix: sanitizeCommandPrefix(incoming ? incoming.prefix : fallback.prefix, fallback.prefix),
        keyword: sanitizeCommandKeyword(incoming ? incoming.keyword : fallback.keyword, fallback.keyword)
      };
    }

    const seen = new Map();
    for (const definition of CHAT_COMMAND_DEFS) {
      const binding = merged[definition.id];
      const conflictKey = `${normalizeLowerTr(binding.prefix)}::${foldCommandText(binding.keyword)}`;
      const existing = seen.get(conflictKey);
      if (existing && existing !== definition.id) {
        return {
          valid: false,
          error: `Komut cakismasi: ${existing} ve ${definition.id}`
        };
      }
      seen.set(conflictKey, definition.id);
    }

    return {
      valid: true,
      bindings: merged
    };
  }

  function commandHelpLines() {
    return [
      `Ornek: ${formatCommandUsageById('cargo_set', 'cam urunleri')}`,
      `Ornek: ${formatCommandUsageById('fare_set', '12500')}`,
      `Ornek: ${formatCommandUsageById('mode_custom', 'yeni is 10 dakikaya acilacak')}`,
      `Ornek: ${formatCommandUsageById('mode_pickup')}`,
      `Ornek: ${formatCommandUsageById('dest_search', 'Istanbul')}`,
      `Ornek: ${formatCommandUsageById('pickup_current')}`
    ];
  }

  function validateOnOff(action) {
    if (action === 'on') return true;
    if (action === 'off') return false;
    return null;
  }

  function applyLocation(scope, locationPayload) {
    if (scope === 'dest') {
      applyStatePatch({ destination: locationPayload });
      return 'Hedef guncellendi.';
    }

    applyStatePatch({ pickup: locationPayload, show_pickup: true });
    return 'Pickup guncellendi ve overlayde gosteriliyor.';
  }

  async function handleSearchCommand(scope, query) {
    const usageCommandId = scope === 'dest' ? 'dest_search' : 'pickup_search';
    if (!query || query.length < 3) {
      return {
        kind: 'error',
        lines: [`En az 3 karakter girin. Ornek: ${formatCommandUsageById(usageCommandId, 'Istanbul')}`]
      };
    }

    const items = await geocodeLookup(query, 5);
    const mapped = items
      .map(buildLocationPayload)
      .filter(Boolean)
      .slice(0, 5);

    if (!mapped.length) {
      return {
        kind: 'error',
        lines: ['Sonuc bulunamadi. Daha acik adres veya koordinat deneyin.']
      };
    }

    const chosen = mapped[0];
    const msg = applyLocation(scope, chosen);
    const compact = mapped.map((item, index) => `${index + 1}) ${truncateForChat(item.short_label || item.label, 32)}`);

    return {
      kind: 'success',
      lines: [
        msg,
        `Ilk sonuc otomatik secildi: ${truncateForChat(chosen.short_label || chosen.label, 60)}`,
        `Adaylar: ${compact.join(' | ')}`
      ]
    };
  }

  async function handleLocationCommand(scope, action, remainder) {
    const searchId = scope === 'dest' ? 'dest_search' : 'pickup_search';
    const coordsId = scope === 'dest' ? 'dest_coords' : 'pickup_coords';
    const clearId = scope === 'dest' ? 'dest_clear' : 'pickup_clear';
    if (action === 'clear') {
      if (scope === 'dest') {
        applyStatePatch({ destination: null });
        return { kind: 'success', lines: ['Hedef temizlendi.'] };
      }

      applyStatePatch({ pickup: null, show_pickup: false });
      return { kind: 'success', lines: ['Pickup temizlendi.'] };
    }

    if (action === 'ara') {
      return handleSearchCommand(scope, remainder);
    }

    if (action === 'k') {
      const coords = parseCoordinates(remainder);
      if (!coords) {
        return {
          kind: 'error',
          lines: [`Kullanim: ${formatCommandUsageById(coordsId)}`]
        };
      }

      const reverse = await deps.reverseGeocodeLookup(coords.lat, coords.lon);
      const location = buildLocationPayload(reverse);
      if (!location) {
        return {
          kind: 'error',
          lines: ['Konum cozumlenemedi.']
        };
      }

      const msg = applyLocation(scope, location);
      return {
        kind: 'success',
        lines: [msg, `Secilen: ${truncateForChat(location.short_label || location.label, 60)}`]
      };
    }

    return {
      kind: 'error',
      lines: [
        `Kullanim: ${formatCommandUsageById(searchId)} veya ${formatCommandUsageById(coordsId)} veya ${formatCommandUsageById(clearId)}`
      ]
    };
  }

  async function executeKickCommand(parsed) {
    const { root, action, remainder } = parsed;

    if (root === 'help') {
      return { kind: 'info', lines: commandHelpLines() };
    }

    if (root === 'road' || root === 'loc' || root === 'map') {
      const next = validateOnOff(action);
      if (next == null) {
        return { kind: 'error', lines: commandHelpLines() };
      }

      if (root === 'road') applyStatePatch({ show_road_hud_overlay: next });
      if (root === 'loc') applyStatePatch({ show_location_time_overlay: next });
      if (root === 'map') applyStatePatch({ show_map_overlay: next });

      return {
        kind: 'success',
        lines: [`${root.toUpperCase()} overlay ${next ? 'acildi' : 'kapatildi'}.`]
      };
    }

    if (root === 'mode') {
      if (action === 'custom') {
        if (!remainder) {
          return { kind: 'error', lines: [`Kullanim: ${formatCommandUsageById('mode_custom')}`] };
        }
        const customText = sanitizeOfferText(remainder, '');
        if (!customText) {
          return {
            kind: 'error',
            lines: ['Gecerli bir metin girin (emoji temizlenince bos kalamaz).']
          };
        }
        applyStatePatch({
          overlay_mode: 'offer',
          offer_custom_text: customText
        });
        return { kind: 'success', lines: ['Bekleme metni guncellendi ve overlay offer moda alindi.'] };
      }

      if (!OVERLAY_MODES.has(action)) {
        return { kind: 'error', lines: commandHelpLines() };
      }

      const currentAppState = getAppState();
      applyStatePatch({
        overlay_mode: action,
        offer_custom_text: action === 'offer' ? '' : currentAppState.offer_custom_text
      });
      if (action === 'offer') {
        return { kind: 'success', lines: ['Overlay modu: is teklifi bekleniyor (varsayilan metin).'] };
      }
      if (action === 'pickup') {
        return { kind: 'success', lines: ['Overlay modu: yeni yuk almaya gidiyor.'] };
      }
      return { kind: 'success', lines: ['Overlay modu: normal.'] };
    }

    if (root === 'fare') {
      if (action === 'set') {
        if (!remainder) {
          return { kind: 'error', lines: [`Kullanim: ${formatCommandUsageById('fare_set')}`] };
        }
        applyStatePatch({ fare_amount: remainder });
        return { kind: 'success', lines: ['Ucret kaydedildi.'] };
      }
      if (action === 'clear') {
        applyStatePatch({ fare_amount: '' });
        return { kind: 'success', lines: ['Ucret temizlendi.'] };
      }
      if (action === 'show') {
        applyStatePatch({ show_fare: true });
        return { kind: 'success', lines: ['Ucret overlayde gosteriliyor.'] };
      }
      if (action === 'hide') {
        applyStatePatch({ show_fare: false });
        return { kind: 'success', lines: ['Ucret overlayde gizlendi.'] };
      }
      return { kind: 'error', lines: commandHelpLines() };
    }

    if (root === 'cargo') {
      if (action === 'set') {
        if (!remainder) {
          return { kind: 'error', lines: [`Kullanim: ${formatCommandUsageById('cargo_set')}`] };
        }
        applyStatePatch({ cargo_text: remainder });
        return { kind: 'success', lines: ['Yuk metni kaydedildi.'] };
      }
      if (action === 'clear') {
        applyStatePatch({ cargo_text: '' });
        return { kind: 'success', lines: ['Yuk metni temizlendi.'] };
      }
      if (action === 'show') {
        applyStatePatch({ show_cargo: true });
        return { kind: 'success', lines: ['Yuk overlayde gosteriliyor.'] };
      }
      if (action === 'hide') {
        applyStatePatch({ show_cargo: false });
        return { kind: 'success', lines: ['Yuk overlayde gizlendi.'] };
      }
      return { kind: 'error', lines: commandHelpLines() };
    }

    if (root === 'dest') {
      return handleLocationCommand('dest', action, remainder);
    }

    if (root === 'pickup') {
      const currentAppState = getAppState();
      if (action === 'show') {
        if (!currentAppState.pickup) {
          return { kind: 'error', lines: ['Once pickup belirleyin.'] };
        }
        applyStatePatch({ show_pickup: true });
        return { kind: 'success', lines: ['Pickup overlayde gosteriliyor.'] };
      }

      if (action === 'hide') {
        if (!currentAppState.pickup) {
          return { kind: 'error', lines: ['Once pickup belirleyin.'] };
        }
        applyStatePatch({ show_pickup: false });
        return { kind: 'success', lines: ['Pickup overlayde gizlendi.'] };
      }

      if (action === 'current') {
        const currentPickup = await pickupFromCurrentLocation();
        applyStatePatch({ pickup: currentPickup, show_pickup: true });
        return {
          kind: 'success',
          lines: [
            'Anlik konum pickup olarak uygulandi.',
            `Pickup: ${truncateForChat(currentPickup.short_label || currentPickup.label, 60)}`
          ]
        };
      }

      return handleLocationCommand('pickup', action, remainder);
    }

    return { kind: 'error', lines: commandHelpLines() };
  }

  return {
    parseConfiguredChatCommand,
    validateChatCommandBindingsPatch,
    executeKickCommand,
    commandHelpLines
  };
}

module.exports = {
  createChatCommandService
};
