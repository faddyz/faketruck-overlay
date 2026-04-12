function createAdminEventsService(deps) {
  const {
    fs,
    ensureDataDir,
    historyPath,
    maxHistory
  } = deps;

  const clients = new Set();
  let seq = 0;

  function normalizeEnvelope(value) {
    if (!value || typeof value !== 'object') return null;
    const id = Number(value.id || 0);
    if (!Number.isFinite(id) || id <= 0) return null;
    const safeEvent = String(value.event || value.type || 'message').trim() || 'message';
    const at = typeof value.at === 'string' && value.at.trim()
      ? value.at
      : new Date().toISOString();
    return {
      ...value,
      id: Math.floor(id),
      at,
      event: safeEvent
    };
  }

  function loadHistory() {
    ensureDataDir();
    if (!fs.existsSync(historyPath)) return [];
    try {
      const raw = fs.readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const normalized = parsed
        .map((entry) => normalizeEnvelope(entry))
        .filter(Boolean)
        .filter((entry) => entry.event !== 'heartbeat');
      normalized.sort((a, b) => a.id - b.id);
      if (normalized.length > maxHistory) {
        return normalized.slice(-maxHistory);
      }
      return normalized;
    } catch {
      return [];
    }
  }

  let history = loadHistory();
  if (history.length > 0) {
    seq = Number(history[history.length - 1].id || 0);
  }

  function saveHistory() {
    ensureDataDir();
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf8');
  }

  function shouldPersist(eventName) {
    return String(eventName || '').trim() !== 'heartbeat';
  }

  function appendHistory(envelope) {
    history.push(envelope);
    if (history.length > maxHistory) {
      history = history.slice(-maxHistory);
    }
    saveHistory();
  }

  function buildEnvelope(eventName, payload) {
    const safeEvent = String(eventName || 'message').trim() || 'message';
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    return {
      id: ++seq,
      at: new Date().toISOString(),
      ...safePayload,
      event: safeEvent
    };
  }

  function writeEvent(res, eventName, envelope) {
    if (!res || res.writableEnded) return;
    const safeEvent = String(eventName || 'message').trim() || 'message';
    res.write(`event: ${safeEvent}\n`);
    res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  }

  function addClient(res) {
    const client = {
      id: Date.now() + Math.random(),
      res
    };
    clients.add(client);
    return client;
  }

  function removeClient(client) {
    clients.delete(client);
  }

  function sendToClient(client, eventName, payload) {
    if (!client || !client.res) return null;
    const envelope = buildEnvelope(eventName, payload);
    writeEvent(client.res, eventName, envelope);
    return envelope;
  }

  function broadcast(eventName, payload) {
    const persist = shouldPersist(eventName);
    const hasClients = clients.size > 0;
    if (!persist && !hasClients) return null;
    const envelope = buildEnvelope(eventName, payload);
    if (persist) {
      appendHistory(envelope);
    }
    for (const client of clients) {
      writeEvent(client.res, eventName, envelope);
    }
    return envelope;
  }

  function getHistory(limit) {
    const safeLimit = Math.max(0, Number(limit) || 0);
    const start = Math.max(0, history.length - safeLimit);
    return history.slice(start);
  }

  function getTotal() {
    return history.length;
  }

  function getMax() {
    return maxHistory;
  }

  return {
    addClient,
    removeClient,
    sendToClient,
    broadcast,
    getHistory,
    getTotal,
    getMax
  };
}

module.exports = {
  createAdminEventsService
};
