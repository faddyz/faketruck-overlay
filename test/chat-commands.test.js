const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

process.env.KICK_BROADCASTER_SLUG = '';

const {
  startServer,
  buildDefaultChatCommandBindings,
  parseConfiguredChatCommand
} = require('../server');

let server;
let baseUrl = '';

async function httpGet(path) {
  const response = await fetch(baseUrl + path);
  const body = await response.json();
  return { status: response.status, body };
}

async function httpPost(path, payload) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

test.before(async () => {
  server = startServer(0, { bootstrapKick: false, logStartup: false });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

test('parser: ! prefix bosluksuz, uzun prefix bosluklu', () => {
  const bindings = buildDefaultChatCommandBindings();

  const shortOk = parseConfiguredChatCommand('!yuk cam urunleri', bindings);
  assert.equal(shortOk.matched, true);
  assert.equal(shortOk.valid, true);
  assert.equal(shortOk.command_id, 'cargo_set');
  assert.equal(shortOk.remainder, 'cam urunleri');

  const shortInvalid = parseConfiguredChatCommand('! yuk cam urunleri', bindings);
  assert.equal(shortInvalid.matched, false);

  bindings.cargo_set.prefix = '!ft';
  bindings.cargo_set.keyword = 'yuk';

  const longOk = parseConfiguredChatCommand('!ft yuk cam urunleri', bindings);
  assert.equal(longOk.matched, true);
  assert.equal(longOk.valid, true);
  assert.equal(longOk.command_id, 'cargo_set');

  const longInvalid = parseConfiguredChatCommand('!ftyuk cam urunleri', bindings);
  assert.equal(longInvalid.matched, false);
});

test('parser: turkce/ascii komut esdegerligi', () => {
  const bindingsTr = buildDefaultChatCommandBindings();
  bindingsTr.cargo_set.keyword = 'yuk';
  const parsedTr = parseConfiguredChatCommand('!y\u00FCk cam', bindingsTr);
  assert.equal(parsedTr.matched, true);
  assert.equal(parsedTr.valid, true);
  assert.equal(parsedTr.command_id, 'cargo_set');

  const bindingsAscii = buildDefaultChatCommandBindings();
  bindingsAscii.cargo_set.keyword = 'y\u00FCk';
  const parsedAscii = parseConfiguredChatCommand('!yuk cam', bindingsAscii);
  assert.equal(parsedAscii.matched, true);
  assert.equal(parsedAscii.valid, true);
  assert.equal(parsedAscii.command_id, 'cargo_set');
});

test('api: cakisan komut taniminda 400 doner', async () => {
  await httpPost('/api/state', { chat_command_bindings_reset: true });

  const result = await httpPost('/api/state', {
    chat_command_bindings: {
      cargo_set: { prefix: '!', keyword: 'ucret' }
    }
  });

  assert.equal(result.status, 400);
  assert.match(String(result.body.error || ''), /Komut cakismasi/i);
});

test('api: bolum kaydi sadece ilgili komutlari gunceller', async () => {
  await httpPost('/api/state', { chat_command_bindings_reset: true });
  const before = await httpGet('/api/state');

  const saveSection = await httpPost('/api/state', {
    chat_command_bindings: {
      cargo_set: { prefix: '!ft', keyword: 'yuk' },
      cargo_show: { prefix: '!ft', keyword: 'yukgoster' }
    }
  });
  assert.equal(saveSection.status, 200);

  const after = await httpGet('/api/state');
  assert.equal(after.body.chat_command_bindings.cargo_set.prefix, '!ft');
  assert.equal(after.body.chat_command_bindings.cargo_show.prefix, '!ft');

  assert.deepEqual(
    after.body.chat_command_bindings.fare_set,
    before.body.chat_command_bindings.fare_set
  );
});

test('api: hepsini kaydet + varsayilanlara don akisi', async () => {
  await httpPost('/api/state', { chat_command_bindings_reset: true });
  const full = buildDefaultChatCommandBindings();
  full.cargo_set = { prefix: '!ft', keyword: 'yuk' };
  full.mode_pickup = { prefix: '!ft', keyword: 'yukegidiyor' };

  const saveAll = await httpPost('/api/state', { chat_command_bindings: full });
  assert.equal(saveAll.status, 200);

  const changed = await httpGet('/api/state');
  assert.equal(changed.body.chat_command_bindings.cargo_set.prefix, '!ft');
  assert.equal(changed.body.chat_command_bindings.mode_pickup.prefix, '!ft');

  const reset = await httpPost('/api/state', { chat_command_bindings_reset: true });
  assert.equal(reset.status, 200);

  const resetState = await httpGet('/api/state');
  const defaults = buildDefaultChatCommandBindings();
  assert.deepEqual(resetState.body.chat_command_bindings, defaults);
});

test('api: event history son degisiklikleri dondurur', async () => {
  const before = await httpGet('/api/events/history?limit=1');
  const beforeTotal = Number(before.body && before.body.total || 0);
  const stateBefore = await httpGet('/api/state');
  const nextMapOverlay = !Boolean(stateBefore.body && stateBefore.body.show_map_overlay);

  const patchResult = await httpPost('/api/state', { show_map_overlay: nextMapOverlay });
  assert.equal(patchResult.status, 200);

  const history = await httpGet('/api/events/history?limit=5');
  assert.equal(history.status, 200);
  assert.ok(Array.isArray(history.body.items));
  assert.ok(Number(history.body.total || 0) > beforeTotal);
  assert.ok(Number(history.body.max || 0) > 0);
  assert.ok(history.body.items.some((item) => item && item.event === 'state_patch'));
});

test('api: rtirl_key public state yanitinda doner', async () => {
  const saveResult = await httpPost('/api/state', { rtirl_key: 'test-secret-key' });
  assert.equal(saveResult.status, 200);

  const state = await httpGet('/api/state');
  assert.equal(Object.prototype.hasOwnProperty.call(state.body, 'rtirl_key'), true);
  assert.equal(String(state.body.rtirl_key || ''), 'test-secret-key');
  assert.equal(Boolean(state.body.has_rtirl_key), true);
  assert.ok(Number(state.body.rtirl_key_revision) >= 1);
});

test('api: offer custom metninde emoji temizleme ve max uzunluk uygulanir', async () => {
  const veryLong = `${'A'.repeat(260)}😀🚚`;
  const saveResult = await httpPost('/api/state', { offer_custom_text: veryLong });
  assert.equal(saveResult.status, 200);

  const state = await httpGet('/api/state');
  const text = String(state.body.offer_custom_text || '');
  assert.equal(text.length, 240);
  assert.equal(text.includes('😀'), false);
  assert.equal(text.includes('🚚'), false);

  const cleanupResult = await httpPost('/api/state', { offer_custom_text: '' });
  assert.equal(cleanupResult.status, 200);
});

test('api: offer_default_text patch kabul edilmez', async () => {
  const result = await httpPost('/api/state', { offer_default_text: 'degismez' });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error || ''), /unsupported_keys/i);
});
test('api: unsupported state key icin 400 doner', async () => {
  const result = await httpPost('/api/state', { unsupported_field: true });
  assert.equal(result.status, 400);
  assert.match(String(result.body.error || ''), /unsupported_keys/i);
});

