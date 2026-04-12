function parseKickCommand(content, prefix = '!ft') {
  if (typeof content !== 'string') return { matched: false };

  const normalizedPrefix = String(prefix || '!ft').trim();
  const trimmed = content.trim();
  if (!normalizedPrefix) return { matched: false };
  if (!trimmed.toLowerCase().startsWith(normalizedPrefix.toLowerCase())) {
    return { matched: false };
  }

  const body = trimmed.slice(normalizedPrefix.length).trim();
  if (!body) {
    return {
      matched: true,
      valid: false,
      error: 'empty_command',
      tokens: [],
      root: '',
      action: '',
      remainder: ''
    };
  }

  const tokens = body.split(/\s+/).filter(Boolean);
  const root = (tokens[0] || '').toLowerCase();
  const action = (tokens[1] || '').toLowerCase();
  const remainder = tokens.slice(2).join(' ').trim();

  return {
    matched: true,
    valid: true,
    raw: body,
    tokens,
    root,
    action,
    remainder
  };
}

function hasModeratorBadge(sender) {
  const badges = sender && sender.identity && Array.isArray(sender.identity.badges)
    ? sender.identity.badges
    : [];

  return badges.some((badge) => {
    const type = String((badge && badge.type) || '').toLowerCase();
    const text = String((badge && badge.text) || '').toLowerCase();
    return type === 'moderator' || text.includes('moderator');
  });
}

function isAuthorizedSender(eventPayload, whitelistSet) {
  const sender = eventPayload && eventPayload.sender ? eventPayload.sender : {};
  const broadcaster = eventPayload && eventPayload.broadcaster ? eventPayload.broadcaster : {};

  const senderId = Number(sender.user_id);
  const broadcasterId = Number(broadcaster.user_id);
  const senderUsername = String(sender.username || '').toLowerCase();

  const isBroadcaster = Number.isFinite(senderId)
    && Number.isFinite(broadcasterId)
    && senderId === broadcasterId;
  const isModerator = hasModeratorBadge(sender);
  const isWhitelisted = Boolean(
    whitelistSet
    && typeof whitelistSet.has === 'function'
    && senderUsername
    && whitelistSet.has(senderUsername)
  );

  const authorized = isBroadcaster || isModerator || isWhitelisted;
  let reason = 'unauthorized';
  if (isBroadcaster) reason = 'broadcaster';
  else if (isModerator) reason = 'moderator';
  else if (isWhitelisted) reason = 'whitelist';

  return {
    authorized,
    reason,
    isBroadcaster,
    isModerator,
    isWhitelisted
  };
}

function parseCoordinates(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  let latText = '';
  let lonText = '';

  if (normalized.includes(',')) {
    const [latPart, lonPart] = normalized.split(',');
    latText = latPart;
    lonText = lonPart;
  } else {
    const parts = normalized.split(' ');
    if (parts.length >= 2) {
      latText = parts[0];
      lonText = parts[1];
    }
  }

  if (!String(latText).trim() || !String(lonText).trim()) return null;

  const lat = Number(latText);
  const lon = Number(lonText);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function truncateForChat(value, maxLength = 48) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3))}...`;
}

module.exports = {
  isAuthorizedSender,
  parseCoordinates,
  parseKickCommand,
  truncateForChat
};
