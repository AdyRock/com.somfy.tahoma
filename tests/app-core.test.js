'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, device, plain } = require('./helpers/harness');

const pin = '1234-5678-9012';
const url = `io://${pin}/123`;

for (const [input, expected] of [['', 0], ['a', 97], ['abc', 96354], ['Homey', 69908314]])
{
	test(`hashCode stays deterministic for ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createApp().app.hashCode(input), expected);
	});
}

for (const [input, expected] of [
	[pin, pin], [` ${pin} `, pin], ['123456789012', ''], ['1234-5678-901', ''], [null, ''],
])
{
	test(`bridge pin validation: ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createApp().app.normalizeBridgePin(input), expected);
	});
}

for (const [input, expected] of [[url, pin], [`rts://${pin}/2#1`, pin], ['bad', ''], [null, ''], ['io://wrong/1', '']])
{
	test(`bridge pin extraction: ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createApp().app.getBridgePinFromDeviceURL(input), expected);
	});
}

for (const [input, expected] of [
	[' GATEWAY.local. ', 'gateway.local'], ['https://Gateway.local:8443/path', 'gateway.local'],
	['gateway.local:8443', 'gateway.local'], ['[fe80::1]', 'fe80::1'], ['', ''], [null, ''],
])
{
	test(`mDNS hostname normalization: ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createApp().app.normalizeMdnsHost(input), expected);
	});
}

test('bridge discovery merges updates and resolves both supported mDNS hostnames', () =>
{
	const { app, settings, writes } = createApp();
	const bridge = { pin, address: '192.0.2.10', port: 8443, url: 'https://custom.local:8443' };
	app.upsertDiscoveredLocalBridge(bridge);
	app.upsertDiscoveredLocalBridge({ pin, address: '192.0.2.11' });
	assert.equal(app.getDiscoveredLocalBridges().length, 1);
	assert.equal(app.getBridgeByPin(pin).address, '192.0.2.11');
	assert.equal(app.getBridgeByPin('invalid'), null);
	assert.equal(app.getBridgeByPin('1111-2222-3333'), null);
	assert.equal(app.upsertLocalMdnsLookup(bridge), true);
	const count = writes.length;
	assert.equal(app.upsertLocalMdnsLookup(bridge), false);
	assert.equal(writes.length, count);
	assert.equal(app.resolveMdnsHostname(`GATEWAY-${pin}.local.`), '192.0.2.10');
	assert.equal(app.resolveMdnsHostname(`${pin}.local`), '192.0.2.10');
	assert.equal(app.resolveMdnsHostname('custom.local'), '192.0.2.10');
	assert.equal(app.resolveMdnsHostname('missing.local'), '');
	assert.equal(app.upsertLocalMdnsLookup({ pin, address: 'invalid' }), false);
	assert.equal(app.upsertLocalMdnsLookup(null), false);
	assert.equal(settings.localBridges.length, 1);
});

test('mDNS lookup falls back to discovered bridge data when the cache is empty', () =>
{
	const { app } = createApp();
	app.localBridges = [{ pin, address: '192.0.2.20' }];
	assert.equal(app.resolveMdnsHostname(`${pin}.local`), '192.0.2.20');
	assert.equal(app.localMdnsLookup[`${pin}.local`], '192.0.2.20');
	assert.equal(app.getMdnsHostCandidatesForBridge(null).size, 0);
});

for (const index of [0, 1, -1])
{
	test(`combined local-device lookup handles findIndex=${index} correctly`, () =>
	{
		const { app } = createApp();
		const match = { deviceURL: `${url}#1` };
		const other = { deviceURL: `io://${pin}/456` };
		const byIndex = { 0: [match, other], 1: [other, match], '-1': [other] };
		app.tahomaLocal = { authenticated: true, supportedDevices: byIndex[index] };
		assert.equal(app.isLocalDevice(url, true), index >= 0);
	});
}

test('combined local-device lookup does not mistake a longer device ID for a sub-device', () =>
{
	const { app } = createApp();
	app.tahomaLocal = { authenticated: true, supportedDevices: [{ deviceURL: `${url}4#1` }] };
	assert.equal(app.isLocalDevice(url, true), false);
	app.tahomaLocal.supportedDevices = [{ deviceURL: url }];
	assert.equal(app.isLocalDevice(url, false), true);
	assert.equal(app.isLocalDevice(`${url}#1`, false), false);
});

test('device account lookup recognizes base and numbered sub-device URLs', () =>
{
	const { app, runtimeDrivers } = createApp();
	runtimeDrivers.blind = { getDevices: () => [device({ deviceURL: `${url}#1` }, { sessionUsername: ' USER@Example.test ' })] };
	assert.equal(app.getDeviceSessionUsername(url), 'user@example.test');
	assert.equal(app.getDeviceSessionUsername(`${url}#1`), 'user@example.test');
	assert.equal(app.getDeviceSessionUsername(`${url}4`), '');
});

for (const error of [
	{ code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { code: 'ECONNABORTED' },
	{ message: 'timeout of 20000ms exceeded' }, { message: 'socket hang up' },
	{ message: 'Request timeout' }, { message: 'Invalid header value char' },
	{ message: 'Missing expected CR after response line' },
])
{
	test(`sync error classifier recognizes ${error.code || error.message}`, () =>
	{
		assert.equal(createApp().app.isTransientSyncError(error), true);
	});
}

test('HTTP and actuator error classifiers reject unrelated errors', () =>
{
	const { app } = createApp();
	assert.equal(app.isTransientSyncError(null), false);
	assert.equal(app.isTransientSyncError(new Error('bad input')), false);
	assert.equal(app.isHttpStatus({ response: { status: 400 } }, 400), true);
	assert.equal(app.isHttpStatus(new Error('Request failed with status code 400'), 400), true);
	assert.equal(app.isHttpStatus(null, 400), false);
	assert.equal(app.isHttpStatus(new Error('bad input'), 400), false);
	for (const issue of ['ACTUATORNOANSWER', { failureType: 'ACTUATORNOANSWER' }, { errorCode: 102 }])
	{
		assert.equal(app.isActuatorNoAnswer(issue), true);
	}
	assert.equal(app.isActuatorNoAnswer(null), false);
	assert.equal(app.isActuatorNoAnswer({ errorCode: 42 }), false);
});

test('400 counters are isolated by device and transport, expire, and clear after success', () =>
{
	const { app } = createApp();
	assert.equal(app.recordCommand400(url, false), 1);
	assert.equal(app.recordCommand400(url, false), 2);
	assert.equal(app.recordCommand400(url, true), 1);
	assert.equal(app.recordCommand400(`${url}#2`, false), 1);
	app.deviceHttp400Tracker[app.getCommand400TrackerKey(url, false)].lastAt = Date.now() - 300001;
	assert.equal(app.recordCommand400(url, false), 1);
	app.clearCommand400(url, false);
	assert.equal(app.recordCommand400(url, false), 1);
});

test('state logging is deduplicated per source and device and respects the logging toggle', () =>
{
	const { app, logs } = createApp();
	app.logDeviceStatesDelta('states', url, [1]);
	assert.equal(logs.length, 0);
	app.infoLogEnabled = true;
	app.logDeviceStatesDelta('states', url, [1]);
	app.logDeviceStatesDelta('states', url, [1]);
	app.logDeviceStatesDelta('states', url, [2]);
	app.logDeviceStatesDelta('other', url, [2]);
	assert.equal(logs.length, 3);
});

test('diagnostic serialization handles primitives, errors and circular objects', () =>
{
	const { app } = createApp();
	assert.equal(app.varToString(null), 'null');
	assert.equal(app.varToString(undefined), 'undefined');
	assert.equal(app.varToString(42), '42');
	assert.equal(app.varToString(true), 'true');
	assert.equal(app.varToString('text'), 'text');
	assert.match(app.varToString(new Error('test failure')), /test failure/);
	const object = { value: 1 };
	object.self = object;
	assert.deepEqual(JSON.parse(app.varToString(object)), { value: 1, self: '' });
});

test('connectivity warning clears after a successful login instead of retaining a stale block', async () =>
{
	const { app, runtimeDrivers } = createApp();
	const warnings = [];
	runtimeDrivers.blind = { getDevices: () => [{ setWarning: async (value) => warnings.push(value) }] };
	app.tahomaCloud.lastLoginIssue = 'Far Too many OAuth login attempts (blocked for 15 minutes)';
	await app.updateConnectivityWarningFromLoginIssue(app.tahomaCloud.lastLoginIssue);
	assert.ok(warnings[0].includes('blocked'));
	app.tahomaCloud.authenticated = true;
	app.tahomaCloud.lastLoginIssue = '';
	await app.updateConnectivityWarningFromLoginIssue('');
	assert.equal(warnings[1], null);
	await app.updateConnectivityWarningFromLoginIssue('');
	assert.equal(warnings.length, 2);
});

test('connectivity warning recognizes current cloud cooldown wording and fractional blocked seconds', () =>
{
	const { app } = createApp();
	const cooldown = 'Please leave 1 minutes between cloud login attempts, next allowed login time: test';
	assert.equal(app.isLoginBlockedIssue(cooldown), true);
	assert.match(app.formatConnectivityWarning(cooldown), /rate-limited/);
	assert.match(app.formatConnectivityWarning('blocked for 59.5s'), /blocked until/);
	assert.equal(app.isLoginBlockedIssue('ordinary error'), false);
	assert.equal(app.isLoginBlockedIssue(''), false);
});

test('connection state includes secondary cloud accounts and local-only connections', () =>
{
	const { app } = createApp();
	assert.equal(!!app.isLoggedIn(), false);
	assert.equal(app.hasActiveDriverSupportSession(), false);
	app.tahomaCloudsBySession.second = { authenticated: true };
	assert.equal(app.isLoggedIn(), true);
	assert.equal(app.hasActiveDriverSupportSession(), true);
	delete app.tahomaCloudsBySession.second;
	app.tahomaLocal = { authenticated: true };
	assert.equal(app.isLoggedIn(), true);
});

test('healthy polling schedules the next local interval and preserves cloud cadence', async () =>
{
	const { app, timers } = createApp();
	app.nextCloudInterval = 30000;
	await app.syncLoop();
	assert.equal(app.nextCloudInterval, 27000);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, 3000);
	app.commandsQueued = 0;
	await app.startSync();
	assert.equal(timers[0].cleared, true);
	assert.equal(app.nextCloudInterval, 30000);
});

test('initSync joins concurrent login attempts and retries a false result rather than reporting success', async () =>
{
	const { app, timers } = createApp({ username: 'user@example.test', password: 'test-password' });
	let finish;
	const pending = new Promise((resolve) => { finish = resolve; });
	let logins = 0;
	app.newLogin_2 = async () => { logins++; return pending; };
	const firstAttempt = app.initSync();
	const secondAttempt = app.initSync();
	finish(false);
	await Promise.all([firstAttempt, secondAttempt]);
	assert.equal(logins, 1);
	assert.equal(app.initSyncInFlight, null);
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, 15000);
});

test('missing credentials do not trigger repeated cloud logins', async () =>
{
	const { app, timers } = createApp();
	app.newLogin_2 = async () => { throw new Error('Unexpected login'); };
	await app.initSync();
	assert.equal(timers.length, 0);
});

test('local client selection uses one client per gateway and requires LAN access', () =>
{
	const { app } = createApp();
	assert.equal(app.getLocalClientForBridge({ pin }), null);
	app.homeyIP = '192.0.2.1';
	const client = app.getLocalClientForBridge({ pin });
	assert.equal(app.getLocalClientForBridge({ pin }), client);
	assert.notEqual(app.getLocalClientForBridge({ pin: '9876-5432-1098' }), client);
	app.tahomaLocal = client;
	assert.equal(app.getLocalClientForBridge(null), client);
	assert.deepEqual(plain(app.localBridges), []);
});
