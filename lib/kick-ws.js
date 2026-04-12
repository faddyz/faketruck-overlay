function createKickWsService(deps) {
  const {
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
    processedMessageTtlMs,
    channelMetaCacheTtlMs,
    cleanupMapByExpiry
  } = deps;

  function safeJsonParse(value) {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function normalizeKickBadges(sender) {
    const identityBadges = sender && sender.identity && Array.isArray(sender.identity.badges)
      ? sender.identity.badges
      : null;
    const directBadges = Array.isArray(sender && sender.badges)
      ? sender.badges
      : null;
    const source = identityBadges || directBadges || [];

    return source.map((badge) => {
      const type = String((badge && (badge.type || badge.name || badge.slug || badge.text)) || '').trim();
      const text = String((badge && (badge.text || badge.type || badge.name || badge.slug)) || '').trim();
      return { type, text };
    });
  }

  function normalizeKickWsChatPayload(envelopeData) {
    const parsedData = typeof envelopeData === 'string' ? safeJsonParse(envelopeData) : envelopeData;
    if (!parsedData || typeof parsedData !== 'object') return null;

    const candidate = parsedData.message && typeof parsedData.message === 'object'
      ? parsedData.message
      : parsedData;

    const content = String(
      candidate.content
      || candidate.message
      || parsedData.content
      || ''
    ).trim();
    if (!content) return null;

    const sender = candidate.sender && typeof candidate.sender === 'object'
      ? candidate.sender
      : parsedData.sender && typeof parsedData.sender === 'object'
        ? parsedData.sender
        : {};

    const senderUsername = String(
      sender.username
      || sender.slug
      || sender.name
      || sender.display_name
      || candidate.username
      || parsedData.username
      || ''
    ).trim();
    if (!senderUsername) return null;

    const senderUserId = Number(
      sender.user_id
      || sender.id
      || sender.userId
      || sender.userid
      || 0
    );

    const messageId = String(
      candidate.id
      || candidate.uuid
      || candidate.message_id
      || parsedData.id
      || parsedData.uuid
      || `${senderUserId}-${content.slice(0, 40)}-${Date.now()}`
    );

    const broadcasterUserId = Number(
      (kickRuntime.channelMeta && kickRuntime.channelMeta.broadcaster_user_id)
      || 0
    );

    return {
      messageId,
      payload: {
        content,
        sender: {
          user_id: senderUserId,
          username: senderUsername,
          identity: {
            badges: normalizeKickBadges(sender)
          }
        },
        broadcaster: {
          user_id: broadcasterUserId
        }
      }
    };
  }

  function isKickChatEventName(eventName) {
    const name = String(eventName || '').trim();
    if (!name) return false;
    return /ChatMessage/i.test(name);
  }

  function extractChannelMetaFromKickResponse(data, slug) {
    const root = data && typeof data === 'object' ? data : null;
    if (!root) return null;

    const candidate = Array.isArray(root)
      ? root[0]
      : Array.isArray(root.data)
        ? root.data[0]
        : root.data && typeof root.data === 'object'
          ? root.data
          : root;

    if (!candidate || typeof candidate !== 'object') return null;

    const broadcasterUserId = Number(
      candidate.broadcaster_user_id
      || (candidate.broadcaster && candidate.broadcaster.user_id)
      || candidate.user_id
      || candidate.id
      || 0
    );

    const chatroomId = Number(
      candidate.chatroom_id
      || (candidate.chatroom && candidate.chatroom.id)
      || (candidate.chatroom && candidate.chatroom.chatroom_id)
      || 0
    );

    if (!Number.isFinite(broadcasterUserId) || broadcasterUserId <= 0) return null;
    if (!Number.isFinite(chatroomId) || chatroomId <= 0) return null;

    return {
      slug,
      broadcaster_user_id: broadcasterUserId,
      chatroom_id: chatroomId,
      resolved_at: new Date().toISOString()
    };
  }

  async function fetchKickChannelMetaFromSlug(slug) {
    const safeSlug = String(slug || '').trim();
    if (!safeSlug) throw new Error('KICK_BROADCASTER_SLUG missing');

    const url = `https://kick.com/api/v2/channels/${encodeURIComponent(safeSlug)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `https://kick.com/${encodeURIComponent(safeSlug)}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Channel resolve failed (${response.status}): ${body.slice(0, 120)}`);
    }

    const data = await response.json();
    const meta = extractChannelMetaFromKickResponse(data, safeSlug);
    if (!meta) {
      throw new Error('Kick channel payload missing broadcaster/chatroom identifiers');
    }

    return meta;
  }

  function cachedChannelMetaForSlug(slug) {
    const cached = kickStore.channel_meta;
    if (!cached) return null;
    if (String(cached.slug || '').toLowerCase() !== String(slug || '').toLowerCase()) return null;

    const resolvedAtMs = new Date(cached.resolved_at || 0).getTime();
    const fresh = Number.isFinite(resolvedAtMs) && Date.now() - resolvedAtMs <= channelMetaCacheTtlMs;
    if (!fresh) return null;

    const broadcasterUserId = Number(cached.broadcaster_user_id || 0);
    const chatroomId = Number(cached.chatroom_id || 0);
    if (!Number.isFinite(broadcasterUserId) || broadcasterUserId <= 0) return null;
    if (!Number.isFinite(chatroomId) || chatroomId <= 0) return null;

    return {
      slug: String(cached.slug || '').trim(),
      broadcaster_user_id: broadcasterUserId,
      chatroom_id: chatroomId,
      resolved_at: cached.resolved_at || null
    };
  }

  function manualChannelMetaFromConfig() {
    if (kickConfig.broadcasterUserId <= 0 || kickConfig.chatroomId <= 0) {
      return null;
    }

    return {
      slug: kickConfig.broadcasterSlug || '',
      broadcaster_user_id: kickConfig.broadcasterUserId,
      chatroom_id: kickConfig.chatroomId,
      resolved_at: new Date().toISOString()
    };
  }

  async function resolveKickChannelMeta() {
    const manual = manualChannelMetaFromConfig();
    if (manual) {
      kickRuntime.channelMeta = manual;
      kickStore.channel_meta = manual;
      saveKickStore();
      clearKickError();
      return manual;
    }

    const slug = kickConfig.broadcasterSlug;
    if (!slug) {
      throw new Error('KICK_BROADCASTER_SLUG missing. Set slug or provide KICK_BROADCASTER_USER_ID + KICK_CHATROOM_ID.');
    }

    const cached = cachedChannelMetaForSlug(slug);
    if (cached) {
      kickRuntime.channelMeta = cached;
      return cached;
    }

    try {
      const fresh = await fetchKickChannelMetaFromSlug(slug);
      kickStore.channel_meta = fresh;
      kickRuntime.channelMeta = fresh;
      saveKickStore();
      clearKickError();
      return fresh;
    } catch (err) {
      const fallback = kickStore.channel_meta
        && String(kickStore.channel_meta.slug || '').toLowerCase() === String(slug || '').toLowerCase()
        ? kickStore.channel_meta
        : null;

      if (fallback) {
        kickRuntime.channelMeta = fallback;
        setKickError(`Slug resolve failed, cached channel_meta kullaniliyor: ${err.message}`);
        return fallback;
      }

      throw new Error(
        `${err.message} | Slug resolve blocked ise KICK_BROADCASTER_USER_ID ve KICK_CHATROOM_ID girin.`
      );
    }
  }

  function buildKickWsUrl() {
    const params = new URLSearchParams({
      protocol: String(kickConfig.wsProtocol),
      client: kickConfig.wsClient,
      version: kickConfig.wsVersion,
      flash: 'false'
    });

    return `wss://ws-${kickConfig.wsCluster}.pusher.com/app/${kickConfig.wsAppKey}?${params.toString()}`;
  }

  function clearKickPingTimer() {
    if (kickSocketState.pingTimer) {
      clearInterval(kickSocketState.pingTimer);
      kickSocketState.pingTimer = null;
    }
  }

  function startKickPingTimer() {
    clearKickPingTimer();

    kickSocketState.pingTimer = setInterval(() => {
      const ws = kickSocketState.ws;
      if (!ws || ws.readyState !== WS_OPEN) return;
      try {
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
      } catch {
        // Ignore intermittent send errors.
      }
    }, kickConfig.wsPingIntervalMs);

    kickSocketState.pingTimer.unref?.();
  }

  function clearKickReconnectTimer() {
    if (kickSocketState.reconnectTimer) {
      clearTimeout(kickSocketState.reconnectTimer);
      kickSocketState.reconnectTimer = null;
    }
  }

  function scheduleKickReconnect(reason) {
    if (!kickConfig.enabled) return;
    if (kickSocketState.reconnectTimer) return;

    const attempt = kickSocketState.reconnectAttempts;
    const maxDelay = Math.max(kickConfig.wsReconnectBaseMs, kickConfig.wsReconnectMaxMs);
    const delay = Math.min(maxDelay, kickConfig.wsReconnectBaseMs * (2 ** attempt));
    kickSocketState.reconnectAttempts += 1;

    kickRuntime.connectionStatus = 'reconnecting';
    kickRuntime.lastDisconnectReason = String(reason || 'unknown');

    kickSocketState.reconnectTimer = setTimeout(() => {
      kickSocketState.reconnectTimer = null;
      connectKickWebSocket().catch((err) => {
        setKickError(`Reconnect failed: ${err.message}`);
        scheduleKickReconnect('connect_failed');
      });
    }, delay);

    kickSocketState.reconnectTimer.unref?.();
  }

  function subscribeKickChatChannels(ws, chatroomId) {
    const channels = [`chatrooms.${chatroomId}.v2`, `chatrooms.${chatroomId}`];
    kickSocketState.subscribedChannels = new Set(channels);

    for (const channel of channels) {
      ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel
        }
      }));
    }
  }

  async function processKickChatEvent(payload) {
    const senderUsername = payload && payload.sender && payload.sender.username
      ? payload.sender.username
      : 'unknown';
    const eventBroadcasterId = Number(payload && payload.broadcaster && payload.broadcaster.user_id || 0);
    const configuredBroadcasterId = Number(kickRuntime.channelMeta && kickRuntime.channelMeta.broadcaster_user_id || 0);
    const content = String(payload && payload.content || '').trim();

    const parsed = parseConfiguredChatCommand(content);
    if (!parsed.matched) {
      return { ignored: true, reason: 'not_command' };
    }

    broadcastAdminEvent('kick_command', {
      type: 'kick_command',
      status: 'detected',
      username: senderUsername,
      content
    });

    kickRuntime.lastCommandAt = new Date().toISOString();
    kickRuntime.lastCommandUser = senderUsername;
    kickRuntime.lastCommandText = content;

    if (!parsed.valid) {
      if (parsed.error === 'value_required' || parsed.error === 'extra_value_not_allowed') {
        logKickFeedback('error', [
          `Kullanim: ${parsed.usage || 'Gecersiz kisayol komutu'}`
        ]);
        broadcastAdminEvent('kick_command', {
          type: 'kick_command',
          status: 'invalid',
          username: senderUsername,
          content,
          reason: parsed.error
        });
        return { ignored: true, reason: 'invalid_command' };
      }
      logKickFeedback('error', commandHelpLines());
      broadcastAdminEvent('kick_command', {
        type: 'kick_command',
        status: 'invalid',
        username: senderUsername,
        content,
        reason: 'invalid_command'
      });
      return { ignored: true, reason: 'invalid_command' };
    }

    if (
      configuredBroadcasterId > 0
      && eventBroadcasterId > 0
      && eventBroadcasterId !== configuredBroadcasterId
    ) {
      setKickError(`WS broadcaster mismatch. Expected ${configuredBroadcasterId}, got ${eventBroadcasterId}`);
      broadcastAdminEvent('kick_command', {
        type: 'kick_command',
        status: 'ignored',
        username: senderUsername,
        content,
        reason: 'broadcaster_mismatch'
      });
      return {
        ignored: true,
        reason: 'broadcaster_mismatch',
        expected_broadcaster_user_id: configuredBroadcasterId,
        received_broadcaster_user_id: eventBroadcasterId
      };
    }

    const auth = isAuthorizedSender(payload, kickConfig.whitelist);
    if (!auth.authorized) {
      logKickFeedback('error', [`@${senderUsername} bu komut icin yetkin yok.`]);
      broadcastAdminEvent('kick_command', {
        type: 'kick_command',
        status: 'unauthorized',
        username: senderUsername,
        content,
        reason: 'unauthorized'
      });
      return { ignored: true, reason: 'unauthorized' };
    }

    try {
      const result = await executeKickCommand(parsed, payload);
      if (result && Array.isArray(result.lines) && result.lines.length > 0) {
        logKickFeedback(result.kind || 'info', result.lines);
      }
      clearKickError();
      broadcastAdminEvent('kick_command', {
        type: 'kick_command',
        status: 'processed',
        username: senderUsername,
        content,
        result: result ? result.kind : 'ok'
      });
      return { processed: true, command: parsed.raw, result: result ? result.kind : 'ok' };
    } catch (err) {
      const message = err && err.message ? err.message : 'Command failed';
      logKickFeedback('error', [`Komut hatasi: ${message}`]);
      setKickError(`Command execution failed: ${message}`);
      broadcastAdminEvent('kick_command', {
        type: 'kick_command',
        status: 'error',
        username: senderUsername,
        content,
        reason: message
      });
      return { processed: false, reason: message };
    }
  }

  async function handleKickWsEnvelope(messageData) {
    const envelope = safeJsonParse(String(messageData || ''));
    if (!envelope || typeof envelope !== 'object') return;

    const eventName = String(envelope.event || '').trim();

    if (eventName === 'pusher:connection_established') {
      const meta = kickRuntime.channelMeta || await resolveKickChannelMeta();
      if (!kickSocketState.ws || kickSocketState.ws.readyState !== WS_OPEN) return;
      subscribeKickChatChannels(kickSocketState.ws, meta.chatroom_id);
      kickRuntime.connectionStatus = 'connected';
      kickRuntime.lastConnectedAt = new Date().toISOString();
      kickRuntime.lastDisconnectReason = null;
      kickSocketState.reconnectAttempts = 0;
      startKickPingTimer();
      clearKickError();
      return;
    }

    if (eventName === 'pusher:ping') {
      if (kickSocketState.ws && kickSocketState.ws.readyState === WS_OPEN) {
        kickSocketState.ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      }
      return;
    }

    if (eventName === 'pusher:error') {
      const details = safeJsonParse(envelope.data) || envelope.data;
      setKickError(`Pusher error: ${JSON.stringify(details)}`);
      return;
    }

    if (!isKickChatEventName(eventName)) {
      return;
    }

    const normalized = normalizeKickWsChatPayload(envelope.data);
    if (!normalized) return;

    cleanupMapByExpiry(processedKickMessages);
    if (processedKickMessages.has(normalized.messageId)) return;

    processedKickMessages.set(normalized.messageId, {
      expiresAt: Date.now() + processedMessageTtlMs
    });

    kickRuntime.lastMessageAt = new Date().toISOString();
    await processKickChatEvent(normalized.payload);
  }

  function normalizeWsMessageData(value) {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value == null) return '';
    return String(value);
  }

  function normalizeWsCloseReason(value) {
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    return String(value || '').trim();
  }

  function handleKickWsClose(ws, code, reason) {
    if (kickSocketState.ws === ws) {
      kickSocketState.ws = null;
    }

    clearKickPingTimer();
    kickRuntime.connectionStatus = 'disconnected';
    kickRuntime.lastDisconnectedAt = new Date().toISOString();
    const numericCode = Number.isFinite(Number(code)) ? Number(code) : 0;
    const reasonText = normalizeWsCloseReason(reason);
    kickRuntime.lastDisconnectReason = `${numericCode}${reasonText ? ` ${reasonText}` : ''}`;

    scheduleKickReconnect(kickRuntime.lastDisconnectReason || 'socket_closed');
  }

  async function connectKickWebSocket() {
    if (!kickConfig.enabled) return;

    const existing = kickSocketState.ws;
    if (existing && (existing.readyState === WS_CONNECTING || existing.readyState === WS_OPEN)) {
      return;
    }

    const meta = await resolveKickChannelMeta();
    kickRuntime.channelMeta = meta;

    const ws = new WebSocketCtor(buildKickWsUrl());
    kickSocketState.ws = ws;
    kickRuntime.connectionStatus = 'connecting';

    const handleOpen = () => {
      kickRuntime.connectionStatus = 'connecting';
    };
    const handleMessage = (message) => {
      const payload = message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'data')
        ? message.data
        : message;
      handleKickWsEnvelope(normalizeWsMessageData(payload)).catch((err) => {
        setKickError(`WS message handling failed: ${err.message}`);
      });
    };
    const handleError = () => {
      setKickError('WebSocket transport error');
    };

    if (typeof ws.on === 'function') {
      ws.on('open', handleOpen);
      ws.on('message', handleMessage);
      ws.on('error', handleError);
      ws.on('close', (code, reason) => {
        handleKickWsClose(ws, code, reason);
      });
      return;
    }

    ws.onopen = handleOpen;
    ws.onmessage = handleMessage;
    ws.onerror = handleError;
    ws.onclose = (event) => {
      handleKickWsClose(ws, event && event.code, event && event.reason);
    };
  }

  async function bootstrapKickIntegration() {
    if (!kickConfig.enabled) {
      console.log('\n[Kick] Integration is disabled. Set KICK_BROADCASTER_SLUG to enable.');
      return;
    }

    console.log(`\n[Kick] Command bindings: ${Object.keys(deps.getAppState().chat_command_bindings || {}).length}`);
    console.log(`[Kick] Broadcaster slug: ${kickConfig.broadcasterSlug}`);
    if (kickConfig.broadcasterUserId > 0 && kickConfig.chatroomId > 0) {
      console.log(`[Kick] Manual IDs: broadcaster=${kickConfig.broadcasterUserId}, chatroom=${kickConfig.chatroomId}`);
    }

    try {
      await resolveKickChannelMeta();
      await connectKickWebSocket();
      console.log('[Kick] WebSocket listener baslatildi.');
    } catch (err) {
      const msg = err && err.message ? err.message : 'unknown';
      setKickError(`Kick bootstrap failed: ${msg}`);
      console.log(`[Kick] Bootstrap error: ${msg}`);
      scheduleKickReconnect('bootstrap_failed');
    }
  }

  return {
    bootstrapKickIntegration,
    connectKickWebSocket,
    resolveKickChannelMeta,
    scheduleKickReconnect
  };
}

module.exports = {
  createKickWsService
};
