const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAuthorizedSender,
  parseCoordinates,
  parseKickCommand
} = require('../kick-utils');

test('parseKickCommand parses prefix and tokens', () => {
  const parsed = parseKickCommand('!ft fare set 12500', '!ft');
  assert.equal(parsed.matched, true);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.root, 'fare');
  assert.equal(parsed.action, 'set');
  assert.equal(parsed.remainder, '12500');
});

test('parseKickCommand parses mode commands', () => {
  const offer = parseKickCommand('!ft mode offer', '!ft');
  assert.equal(offer.matched, true);
  assert.equal(offer.valid, true);
  assert.equal(offer.root, 'mode');
  assert.equal(offer.action, 'offer');
  assert.equal(offer.remainder, '');

  const pickup = parseKickCommand('!ft mode pickup', '!ft');
  assert.equal(pickup.root, 'mode');
  assert.equal(pickup.action, 'pickup');
});

test('parseKickCommand returns unmatched when prefix missing', () => {
  const parsed = parseKickCommand('fare set 12500', '!ft');
  assert.equal(parsed.matched, false);
});

test('parseCoordinates supports comma and space formats', () => {
  assert.deepEqual(parseCoordinates('41.0082, 28.9784'), { lat: 41.0082, lon: 28.9784 });
  assert.deepEqual(parseCoordinates('41.0082 28.9784'), { lat: 41.0082, lon: 28.9784 });
  assert.equal(parseCoordinates('invalid'), null);
});

test('isAuthorizedSender accepts broadcaster, moderator, and whitelist', () => {
  const payload = {
    broadcaster: { user_id: 10 },
    sender: { user_id: 10, username: 'streamer' }
  };
  assert.equal(isAuthorizedSender(payload, new Set()).authorized, true);

  const modPayload = {
    broadcaster: { user_id: 10 },
    sender: {
      user_id: 20,
      username: 'mod',
      identity: { badges: [{ type: 'moderator', text: 'Moderator' }] }
    }
  };
  assert.equal(isAuthorizedSender(modPayload, new Set()).authorized, true);

  const whitelistPayload = {
    broadcaster: { user_id: 10 },
    sender: { user_id: 30, username: 'trusted_user' }
  };
  assert.equal(isAuthorizedSender(whitelistPayload, new Set(['trusted_user'])).authorized, true);
});
