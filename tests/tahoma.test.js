'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTahoma, load, plain } = require('./helpers/harness');

const url = 'io://1234-5678-9012/1#1';

test('new clients start unauthenticated with isolated request and authentication state', () =>
{
	const first = createTahoma().client;
	const second = createTahoma().client;
	assert.equal(first.authenticated, false);
	assert.equal(first.registerResponse, null);
	assert.equal(first.refreshToken, null);
	assert.equal(first.authGeneration, 0);
	assert.notEqual(first.httpHelper, second.httpHelper);
	assert.equal(first.nextAuthCycleId('OAuth'), 'oauth-1');
	assert.equal(first.nextAuthCycleId('Simple'), 'simple-2');
	assert.equal(first.nextLoginStartNumber(), 1);
	assert.equal(first.nextLoginStartNumber(), 2);
});

for (const [input, expected] of [
	['', ''], ['ab@xy', 'a*@x*'], [' USER@Example.test ', 'us***@ex***'],
	['a', 'a**'], ['abcdef', 'ab***f'],
])
{
	test(`session log masking: ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createTahoma().client.maskedSessionIdentifier(input), expected);
	});
}

test('app bridge helpers safely delegate logging, bearer storage and DNS resolution', () =>
{
	const { client, homey, logs } = createTahoma();
	client.setAppLocalBearer('test-bearer');
	assert.equal(homey.app.localBearer, 'test-bearer');
	homey.app.infoLogEnabled = true;
	assert.equal(client.appInfoLoggingEnabled(), true);
	homey.app.resolveMdnsHostname = () => '192.0.2.1';
	assert.equal(client.resolveMdnsHostname('test.local'), '192.0.2.1');
	client.appLogInformation('test', { ok: true }, 0);
	assert.equal(logs[0][0], 'test');
	assert.equal(logs[0][2], 0);
	assert.equal(client.appVarToString({ a: 1 }), '{"a":1}');
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(client.appVarToString(cyclic), '[object Object]');
	delete homey.app;
	assert.equal(client.appInfoLoggingEnabled(), false);
	assert.equal(client.resolveMdnsHostname('test.local'), '');
});

test('local DNS fallback logging is throttled independently for each host and address', () =>
{
	const { client } = createTahoma();
	assert.equal(client.shouldLogLocalDnsFallback('', ''), false);
	assert.equal(client.shouldLogLocalDnsFallback('test.local', '192.0.2.1'), true);
	assert.equal(client.shouldLogLocalDnsFallback('test.local', '192.0.2.1'), false);
	assert.equal(client.shouldLogLocalDnsFallback('test.local', '192.0.2.2'), true);
	client.localDnsFallbackLogTimestamps['test.local|192.0.2.1'] = Date.now() - 300001;
	assert.equal(client.shouldLogLocalDnsFallback('test.local', '192.0.2.1'), true);
});

for (const [ip, family] of [['192.0.2.1', 4], ['2001:db8::1', 6]])
{
	test(`local DNS cache resolves family ${family} using both Node callback shapes`, async () =>
	{
		const { client, homey } = createTahoma();
		homey.app.resolveMdnsHostname = () => ip;
		const lookup = client.createLocalDnsLookup();
		const single = await new Promise((resolve, reject) => lookup('test.local', (error, address, actualFamily) =>
		{
			if (error) reject(error);
			else resolve({ address, family: actualFamily });
		}));
		assert.deepEqual(single, { address: ip, family });
		const all = await new Promise((resolve, reject) => lookup('test.local', { all: true }, (error, results) =>
		{
			if (error) reject(error);
			else resolve(results);
		}));
		assert.deepEqual(plain(all), [{ address: ip, family }]);
	});
}

test('local DNS delegates unknown hosts to the system resolver without external network access', async () =>
{
	const calls = [];
	const Tahoma = load('lib\\Tahoma.js', {
		dns: { lookup: (hostname, options, callback) =>
		{
			calls.push([hostname, options]);
			callback(null, '192.0.2.30', 4);
		} },
	});
	const client = Object.create(Tahoma.prototype);
	client.resolveMdnsHostname = () => '';
	await new Promise((resolve, reject) => client.createLocalDnsLookup()('test.local', {}, (error, address) =>
	{
		if (error) reject(error);
		else { assert.equal(address, '192.0.2.30'); resolve(); }
	}));
	assert.equal(calls[0][0], 'test.local');
});

for (const [input, expected] of [[url, '1234-5678-9012'], ['zigbee://gateway/1', 'gateway'], ['', ''], ['invalid', '']])
{
	test(`gateway extraction: ${JSON.stringify(input)}`, () =>
	{
		assert.equal(createTahoma().client.extractGatewayIdFromDeviceURL(input), expected);
	});
}

test('device annotation preserves explicit gateway IDs and does not mutate responses', () =>
{
	const { client } = createTahoma();
	const input = [{ deviceURL: url }, { deviceURL: 'io://other/1', gatewayId: 'explicit' }];
	assert.deepEqual(plain(client.annotateDevicesWithGateway(input)), [
		{ deviceURL: url, gatewayId: '1234-5678-9012' },
		{ deviceURL: 'io://other/1', gatewayId: 'explicit' },
	]);
	assert.equal(input[0].gatewayId, undefined);
	assert.deepEqual(plain(client.annotateDevicesWithGateway(null)), []);
});

for (const [method, args, expected] of [
	['getDeviceStates', [url], `/setup/devices/${encodeURIComponent(url)}/states`],
	['getDeviceSingleState', [url, 'core:PositionState'], `/setup/devices/${encodeURIComponent(url)}/states/core%3APositionState`],
	['getDeviceStateHistory', [url, 'core:PositionState', 1, 2], `/setup/devices/${encodeURIComponent(url)}/states/core%3APositionState/history/1/2`],
	['getActionGroups', [], '/actionGroups'],
])
{
	test(`${method} encodes API arguments and rejects unauthenticated calls`, async () =>
	{
		const { client } = createTahoma();
		await assert.rejects(client[method](...args), /Not Logged in/);
		client.authenticated = true;
		client.httpHelper.response = [{ name: 'test' }];
		assert.deepEqual(plain(await client[method](...args)), [{ name: 'test' }]);
		assert.equal(client.httpHelper.calls[0][1], expected);
	});
}

test('empty device states return null and OAuth time remaining never becomes negative', async () =>
{
	const { client } = createTahoma();
	client.authenticated = true;
	client.httpHelper.response = [];
	assert.equal(await client.getDeviceStates(url), null);
	assert.equal(client.isEmpty({}), true);
	assert.equal(client.isEmpty({ a: 1 }), false);
	assert.equal(client.getOAuthTimeLeft(), -1);
	client.refreshToken = 'test-refresh';
	client.oAuthTimeEnd = Date.now() - 1000;
	assert.equal(client.getOAuthTimeLeft(), 0);
	client.oAuthTimeEnd = Date.now() + 60000;
	assert.ok(client.getOAuthTimeLeft() > 59);
});

test('device commands preserve both commands, labels and transport errors', async () =>
{
	const { client } = createTahoma();
	client.authenticated = true;
	client.registerEvents = async () => true;
	client.httpHelper.response = { execId: 'execution' };
	const action = { name: 'open', parameters: [] };
	const action2 = { name: 'stop', parameters: [] };
	assert.equal((await client.executeDeviceAction('Blind', url, action, action2)).execId, 'execution');
	const [method, endpoint, options, payload] = client.httpHelper.calls[0];
	assert.equal(method, 'post');
	assert.equal(endpoint, '/exec/apply');
	assert.equal(options.json, true);
	assert.equal(payload.label, 'Blind - open  - Homey');
	assert.deepEqual(plain(payload.actions), [{ deviceURL: url, commands: [action, action2] }]);
	await assert.rejects(client.executeDeviceAction('Blind', '', action), /No device URL/);
	client.authenticated = false;
	await assert.rejects(client.executeDeviceAction('Blind', url, action), /Cloud Not Logged in/);
});

test('scenario execution, cancellation, state refresh and API helpers use the intended endpoints', async () =>
{
	const { client } = createTahoma();
	client.authenticated = true;
	client.registerEvents = async () => true;
	await client.executeScenario('scenario-one');
	await client.cancelExecution('execution-one');
	await client.refreshStates();
	await client.getUserId();
	await client.getSetupOID();
	await client.getLocalAPIVersion();
	assert.deepEqual(client.httpHelper.calls.map((entry) => entry[1]), [
		'/exec/scenario-one', '/exec/current/setup/execution-one', '/setup/devices/states/refresh',
		'/currentUserId', '/enduser/defaultSetupOID', 'apiVersion',
	]);
	client.updateBaseURL('usa');
	assert.deepEqual(client.httpHelper.baseURL, ['usa']);
	client.authenticated = false;
	await assert.rejects(client.executeScenario('one'), /Not Logged in/);
	await assert.rejects(client.cancelExecution('one'), /Not Logged in/);
	await assert.rejects(client.getSetupOID(), /Not Logged in/);
});

test('event registration happens once, reuses the listener and resets after an error', async () =>
{
	const { client } = createTahoma();
	client.authenticated = true;
	client.httpHelper.response = { id: 'listener' };
	assert.equal(!!client.eventsRegistered(), false);
	assert.equal(await client.registerEvents(), false);
	assert.equal(!!client.eventsRegistered(), true);
	assert.equal(await client.registerEvents(), true);
	assert.equal(client.httpHelper.calls.length, 1);
	await client.eventsClearRegistered();
	assert.equal(client.registerResponse, null);
	assert.equal(client.registeringEvents, false);
	client.httpHelper.post = async () => { throw new Error('registration failed'); };
	await assert.rejects(client.registerEvents(), /registration failed/);
	assert.equal(client.registeringEvents, false);
	assert.equal(client.registerResponse, null);
});

test('event fetch recovers an invalid listener and rejects an undefined response', async () =>
{
	const { client } = createTahoma();
	client.authenticated = true;
	client.registerResponse = { id: 'old' };
	client.httpHelper.post = async (endpoint) =>
	{
		if (endpoint === '/events/old/fetch')
		{
			throw Object.assign(new Error('bad listener'), { response: { status: 400 } });
		}
		return { id: 'new' };
	};
	assert.equal(await client.getEvents(), null);
	assert.equal(client.registerResponse.id, 'new');
	client.httpHelper.post = async () => undefined;
	await assert.rejects(client.getEvents(), /Undefined response/);
	assert.equal(client.registerResponse, null);
	client.authenticated = false;
	await assert.rejects(client.getEvents(), /Not Logged in/);
});

test('setup discovery merges embedded and dedicated endpoints without duplicate devices', async () =>
{
	const { client } = createTahoma(true);
	const calls = [];
	client.getWithReAuth = async (endpoint) =>
	{
		calls.push(endpoint);
		if (endpoint === '/setup')
		{
			return { oid: 'setup one', devices: [{ deviceURL: url }], gateways: [{ gatewayId: '1234-5678-9012' }] };
		}
		if (endpoint === '/enduser/setups')
		{
			return [{ oid: 'setup one' }];
		}
		if (endpoint.includes('/devices'))
		{
			return [{ deviceURL: url }, { deviceURL: 'io://9876-5432-1098/2' }];
		}
		if (endpoint.includes('/gateways'))
		{
			return [{ gatewayId: '1234-5678-9012' }, { gatewayId: '9876-5432-1098' }];
		}
		throw new Error('Unexpected request');
	};
	const snapshot = await client.getSetupSnapshot();
	assert.equal(snapshot.devices.length, 2);
	assert.equal(snapshot.gateways.length, 2);
	assert.equal(client.lastSetupDiscovery.accountSetupCount, 1);
	assert.equal(client.lastSetupDiscovery.totalDeviceCount, 2);
	assert.ok(calls.includes('/setup/setup%20one/devices'));
	client.authenticated = true;
	client.getSetupSnapshot = async () => snapshot;
	const devices = await client.getDeviceData();
	assert.equal(devices[0].gatewayId, '1234-5678-9012');
	assert.deepEqual(plain(client.supportedDevices), [
		{ deviceURL: url, gatewayId: '1234-5678-9012' },
		{ deviceURL: 'io://9876-5432-1098/2', gatewayId: '9876-5432-1098' },
	]);
});

for (const kind of ['OAuth', 'local'])
{
	test(`${kind} login observes its own cooldown instead of the simple-login timestamp`, async () =>
	{
		const suffix = kind === 'OAuth' ? 'OA' : 'Local';
		const { client } = createTahoma(false, {
			[`loginAttempts${suffix}`]: 1,
			[`loginTime${suffix}`]: Date.now() + 10000,
		});
		client.httpHelper.post = async () => { throw new Error('Cooldown was bypassed'); };
		await assert.rejects(client.login('user@example.test', 'test-password', 'europe', true, true, false, '', kind === 'local' ? 'local-token-refresh' : 'test'), /Please leave/);
	});
}

test('a successful login clears an old login-block issue so device warnings can recover', async () =>
{
	const { client } = createTahoma();
	client.lastLoginIssue = 'Far Too many OAuth login attempts (blocked for 15 minutes)';
	client.httpHelper.post = async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
	client.httpHelper.get = async () => 'test-user';
	await client.login('user@example.test', 'test-password', 'europe', true, true);
	assert.equal(client.authenticated, true);
	assert.equal(client.lastLoginIssue, '');
	assert.equal(client.refreshToken, 'refresh');
});
