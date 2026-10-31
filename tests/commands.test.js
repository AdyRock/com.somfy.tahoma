'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/harness');

const url = 'io://1234-5678-9012/1';
const action = { name: 'open', parameters: [] };

function create()
{
	const context = createApp();
	const { app } = context;
	app.getCloudClientForDevice = async () => app.tahomaCloud;
	app.tryLocalCommandForCurrentCredentials = async () => null;
	app.tryLocalCommandForSession = async () => null;
	app.getDeviceSessionUsername = () => '';
	app.ensureLocalConnectionForDevice = async () => false;
	app.updateConnectivityWarningFromLoginIssue = async () => {};
	app.boostSync = async () => {};
	app.initSync = async () => {};
	return context;
}

test('device command prefers a supported local connection and does not send a cloud duplicate', async () =>
{
	const { app } = create();
	let localCalls = 0;
	app.tahomaLocal = {
		authenticated: true,
supportedDevices: [{ deviceURL: url }],
		executeDeviceAction: async () => { localCalls++; return { execId: 'local' }; },
	};
	app.tahomaCloud.executeDeviceAction = async () => { throw new Error('Duplicate command'); };
	const result = await app.executeDeviceAction('Blind', url, action, false);
	assert.equal(result.local, true);
	assert.equal(localCalls, 1);
});

test('failed local transport falls back to the cloud and marks the result correctly', async () =>
{
	const { app, logs } = create();
	app.tahomaLocal = {
		authenticated: true,
supportedDevices: [{ deviceURL: url }],
		executeDeviceAction: async () => { throw new Error('Local socket failed'); },
	};
	app.tahomaCloud = { authenticated: true, executeDeviceAction: async () => ({ execId: 'cloud' }) };
	const result = await app.executeDeviceAction('Blind', url, action, false);
	assert.equal(result.local, false);
	assert.equal(result.execId, 'cloud');
	assert.ok(logs.some(([source]) => source.includes('will try cloud')));
});

test('forceCloud bypasses every local route and preserves the second command', async () =>
{
	const { app } = create();
	app.tahomaLocal = {
		authenticated: true,
supportedDevices: [{ deviceURL: url }],
		executeDeviceAction: async () => { throw new Error('Must not run locally'); },
	};
	app.tryLocalCommandForCurrentCredentials = async () => { throw new Error('Must not route locally'); };
	app.tryLocalCommandForSession = app.tryLocalCommandForCurrentCredentials;
	const second = { name: 'stop', parameters: [] };
	let received;
	app.tahomaCloud = {
		authenticated: true,
		executeDeviceAction: async (...args) => { received = args; return { execId: 'one' }; },
	};
	assert.equal((await app.executeDeviceAction('Blind', url, action, false, second, true)).local, false);
	assert.deepEqual(received, ['Blind', url, action, second]);
});

test('a Somfy cloud command error is preserved rather than replaced by an app.getName TypeError', async () =>
{
	const { app, logs } = create();
	app.tahomaCloud = { authenticated: true, executeDeviceAction: async () => ({ errorCode: 42, error: 'Command is unavailable' }) };
	await assert.rejects(app.executeDeviceAction('Blind', url, action, false), /^Error: Command is unavailable$/);
	assert.ok(logs.some(([source]) => source.startsWith('Blind:')));
});

for (const local of [false, true])
{
	test(`actuator-not-answering errors on ${local ? 'local' : 'cloud'} are surfaced without duplicate commands`, async () =>
	{
		const { app } = create();
		let cloudCalls = 0;
		app.tahomaCloud = {
			authenticated: true,
			executeDeviceAction: async () =>
			{
				cloudCalls++;
				return { errorCode: 102, error: 'ACTUATORNOANSWER' };
			},
		};
		if (local)
		{
			app.tahomaLocal = {
				authenticated: true,
supportedDevices: [{ deviceURL: url }],
				executeDeviceAction: async () => ({ errorCode: 102, error: 'ACTUATORNOANSWER' }),
			};
		}
		await assert.rejects(app.executeDeviceAction('Blind', url, action, false), /Actuator did not answer/);
		assert.equal(cloudCalls, local ? 0 : 1);
	});
}

test('cloud 400 recovery retries only after recovery succeeds and clears its failure counter', async () =>
{
	const { app } = create();
	let calls = 0;
	let recoveries = 0;
	let boosts = 0;
	app.tahomaCloud = {
		authenticated: true,
		executeDeviceAction: async () =>
		{
			if (++calls === 1)
			{
				throw Object.assign(new Error('bad session'), { response: { status: 400 } });
			}
			return { execId: 'recovered' };
		},
	};
	app.attemptCommand400Recovery = async () => { recoveries++; return true; };
	app.boostSync = () => { boosts++; };
	assert.equal((await app.executeDeviceAction('Blind', url, action, true)).execId, 'recovered');
	assert.equal(calls, 2);
	assert.equal(recoveries, 1);
	assert.equal(boosts, 1);
	assert.equal(app.deviceHttp400Tracker[app.getCommand400TrackerKey(url, false)], undefined);
});

test('failed cloud 400 recovery does not replay the device command', async () =>
{
	const { app } = create();
	let calls = 0;
	const error = Object.assign(new Error('bad session'), { response: { status: 400 } });
	app.tahomaCloud = { authenticated: true, executeDeviceAction: async () => { calls++; throw error; } };
	app.attemptCommand400Recovery = async () => false;
	await assert.rejects(app.executeDeviceAction('Blind', url, action, false), (err) => err === error);
	assert.equal(calls, 1);
});

test('an unauthenticated primary attempts recovery before reporting no valid connections', async () =>
{
	const { app } = create();
	let logins = 0;
	app.initSync = async () => { logins++; };
	await assert.rejects(app.executeDeviceAction('Blind', url, action, false), /no valid connections/);
	assert.equal(logins, 1);
});

test('state retrieval uses the supported local route before cloud', async () =>
{
	const { app } = create();
	const states = [{ name: 'core:PositionState', value: 50 }];
	app.tahomaLocal = { authenticated: true, supportedDevices: [{ deviceURL: url }], getDeviceStates: async () => states };
	assert.equal(await app.getDeviceStates(url), states);
	app.tahomaLocal = null;
	app.tahomaCloud = { authenticated: true, getDeviceStates: async () => states };
	app.localOnly = true;
	assert.equal(await app.getDeviceStates(url), states);
	assert.equal(app.localOnly, false);
	app.tahomaCloud.authenticated = false;
	assert.equal(await app.getDeviceStates(url), null);
});

test('getDeviceData merges cloud-only devices without duplicating local devices', async () =>
{
	const { app } = create();
	const local = { deviceURL: url, controllableName: 'io:Blind', label: 'local' };
	const cloud = { ...local, label: 'cloud' };
	const cloudOnly = { deviceURL: 'rts://1234-5678-9012/2', controllableName: 'rts:Blind' };
	app.getDiscoveredLocalBridges = () => [];
	app.tahomaLocal = { authenticated: true, getDeviceData: async () => [local] };
	app.tahomaCloud = { authenticated: true, getDeviceData: async () => [cloud, cloudOnly] };
	const result = await app.getDeviceData();
	assert.equal(result.length, 2);
	assert.equal(result[0], local);
	assert.equal(result[1], cloudOnly);
});

test('cancelExecution routes a secondary-account execution to its owning cloud client', async () =>
{
	const { app } = create();
	const calls = [];
	const owner = { authenticated: true, cancelExecution: async (id) => calls.push(['owner', id]) };
	app.tahomaCloud = { authenticated: true, cancelExecution: async (id) => calls.push(['primary', id]) };
	app.getCloudClientForDevice = async (deviceURL) =>
	{
		assert.equal(deviceURL, url);
		return owner;
	};
	await app.cancelExecution('Blind', 'execution', false, url);
	assert.deepEqual(calls, [['owner', 'execution']]);
});

test('cancellation never uses a different local gateway when routing fails', async () =>
{
	const { app } = create();
	let cancelled = false;
	app.tahomaLocal = { authenticated: true, cancelExecution: async () => { cancelled = true; } };
	await assert.rejects(app.cancelExecution('Blind', 'execution', true, url), /No local connection/);
	assert.equal(cancelled, false);
});

test('cloud cancellation remains available in local-only polling mode and surfaces transport failures', async () =>
{
	const { app, logs } = create();
	app.localOnly = true;
	app.tahomaCloud = { authenticated: true, cancelExecution: async () => { throw new Error('cancellation failed'); } };
	await assert.rejects(app.cancelExecution('Blind', 'execution', false, url), /cancellation failed/);
	assert.ok(logs.some(([source]) => source === 'Blind: cancelExecution failed'));
});

for (const route of ['tryLocalCommandForSession', 'tryLocalCommandForCurrentCredentials'])
{
	test(`${route} surfaces actuator failures without attempting other gateways`, async () =>
	{
		const { app } = create();
		app.homey.settings.set('username', 'test@example.test');
		app.homey.settings.set('password', 'test-password');
		app.getDeviceSessionUsername = () => 'test@example.test';
		app.getSessionByEmail = () => ({ username: 'test@example.test', password: 'test-password' });
		const bridge = { pin: '1234-5678-9012' };
		app.getDiscoveredLocalBridges = () => [bridge];
		app.getBridgeByPin = () => bridge;
		app.tahomaLocal = { authenticated: false };
		app.getLocalClientForBridge = () => ({
			authenticated: true,
supportedDevices: [{ deviceURL: url }],
			executeDeviceAction: async () => ({ errorCode: 102, error: 'ACTUATORNOANSWER' }),
		});
		app.doLocalLoginForClient = async () => true;
		// Exercise the real route, not the command-test setup's local-route stub.
		const prototype = Object.getPrototypeOf(app);
		await assert.rejects(prototype[route].call(app, 'Blind', url, action), /Actuator did not answer/);
	});
}
