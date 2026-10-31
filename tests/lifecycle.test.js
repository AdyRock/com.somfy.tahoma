'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp } = require('./helpers/harness');

function prepare(pro)
{
	const context = createApp();
	const { homey } = context;
	const listeners = {};
	const conditions = {};
	homey.on = (event, listener) => { listeners[event] = listener; };
	homey.settings.on = (event, listener) => { listeners[`settings-${event}`] = listener; };
	homey.cloud.getLocalAddress = async () =>
	{
		if (!pro) throw new Error('No local network');
		return '192.0.2.1';
	};
	homey.flow = {
		getActionCard: () => ({
			registerRunListener() { return this; },
			getArgument() { return this; },
			registerAutocompleteListener() { return this; },
		}),
		getConditionCard: (id) => ({
			registerRunListener: (listener) => { conditions[id] = listener; },
		}),
		getTriggerCard: () => ({ registerRunListener() { return this; } }),
	};
	homey.discovery = {
		getStrategy: () => ({
			on: (event, listener) => { listeners[`discovery-${event}`] = listener; },
			getDiscoveryResults: () => ({}),
		}),
	};
	return { ...context, listeners, conditions };
}

for (const pro of [false, true])
{
	test(`app startup initializes ${pro ? 'Homey Pro' : 'Homey Cloud'} clients and schedules bounded initial sync`, async () =>
	{
		const { app, timers, conditions, listeners, settings } = prepare(pro);
		await app.onInit();
		assert.equal(app.tahomaCloud.authenticated, false);
		assert.equal(!!app.tahomaLocal, pro);
		assert.equal(app.infoLogEnabled, !pro);
		assert.equal(settings.debugMode, false);
		assert.ok(timers[0].delay >= (pro ? 15000 : 30000));
		assert.ok(timers[0].delay <= (pro ? 15000 : 150000));
		const device = { getState: () => ({ measure_temperature: 20, measure_luminance: 100 }), executionId: null };
		assert.equal(await conditions.has_temperature_more_than({ device, temperature: 19 }), true);
		assert.equal(await conditions.has_temperature_less_than({ device, temperature: 19 }), false);
		assert.equal(await conditions.has_temperature_between({ device, temperature_from: 19, temperature_to: 21 }), true);
		assert.equal(await conditions.has_luminance_more_than({ device, luminance: 90 }), true);
		assert.equal(await conditions.has_luminance_less_than({ device, luminance: 90 }), false);
		assert.equal(await conditions.has_luminance_between({ device, luminance_from: 90, luminance_to: 110 }), true);
		assert.equal(await conditions.is_moving({ device }), false);
		settings.infoLogEnabled = true;
		listeners['settings-set']('infoLogEnabled');
		assert.equal(app.infoLogEnabled, true);
		assert.equal(typeof listeners['discovery-result'], 'function');
		assert.equal(typeof listeners['discovery-addressChanged'], 'function');
		let logoutFlags;
		app.logOut = async (clear) => { logoutFlags = clear; };
		await app.onUninit();
		assert.equal(logoutFlags, false);
		logoutFlags = null;
		await listeners.unload();
		assert.equal(logoutFlags, false);
	});
}

test('mDNS discovery remembers valid bridges and falls back promptly when local login is unavailable', async () =>
{
	const { app, settings, timers } = createApp();
	app.homeyIP = '192.0.2.1';
	await app.mDNSBridgesUpdate({ address: '192.0.2.2' });
	assert.equal(timers.length, 0);
	await app.mDNSBridgesUpdate({
		txt: { gateway_pin: '1234-5678-9012', api_version: '1' },
		address: '192.0.2.2',
fullname: 'gateway-1234-5678-9012.local',
port: 8443,
	});
	assert.equal(settings.localBridge.pin, '1234-5678-9012');
	assert.equal(app.localBridges.length, 1);
	assert.equal(app.forceImmediateCloudSync, true);
	assert.equal(timers[0].delay, 15000);
});

test('mDNS discovery starts local-only polling after a matching account logs in', async () =>
{
	const { app, timers } = createApp();
	app.getCandidateCredentialsForLocalRouting = () => [{ username: 'test@example.test', password: 'test-password', region: 'europe' }];
	app.doLocalLogin = async () => true;
	await app.mDNSBridgesUpdate({
		txt: { gateway_pin: '1234-5678-9012' },
		address: '192.0.2.2',
fullname: 'gateway-1234-5678-9012.local',
port: 8443,
	});
	assert.equal(app.localOnly, true);
	assert.equal(timers[0].delay, 5000);
});

test('boost/unboost preserves queue counts and automatically times out missing completion events', async () =>
{
	const { app, timers } = createApp();
	app.tahomaCloud = { authenticated: true, eventsRegistered: () => true };
	assert.equal(await app.boostSync(), true);
	assert.equal(app.commandsQueued, 1);
	assert.equal(app.nextCloudInterval, 3000);
	assert.equal(timers[0].delay, 60000);
	assert.equal(await app.boostSync(), true);
	assert.equal(app.commandsQueued, 2);
	await app.unBoostSync();
	assert.equal(app.commandsQueued, 1);
	await app.unBoostSync(true);
	assert.equal(app.commandsQueued, 0);
	assert.equal(app.nextCloudInterval, 30000);
	assert.equal(app.boostTimerId, null);
	assert.equal(app.unBoosting, false);
});

test('stopping sync clears every registered cloud session and cancels outstanding timers', async () =>
{
	const { app, homey } = createApp();
	const cleared = [];
	const primary = { eventsClearRegistered: async () => cleared.push('primary') };
	const secondary = { eventsClearRegistered: async () => cleared.push('secondary') };
	app.tahomaCloud = primary;
	app.tahomaCloudsBySession = { first: primary, second: secondary };
	const syncTimer = homey.setTimeout(() => {}, 1);
	const boostTimer = homey.setTimeout(() => {}, 1);
	app.syncTimerId = syncTimer;
	app.boostTimerId = boostTimer;
	app.commandsQueued = 2;
	await app.stopSync('cloud');
	assert.deepEqual(cleared, ['primary', 'secondary']);
	assert.equal(syncTimer.cleared, true);
	assert.equal(boostTimer.cleared, true);
	assert.equal(app.commandsQueued, 0);
	assert.equal(app.nextCloudInterval, 0);
});

test('app logout joins concurrent calls and preserves credentials on shutdown', async () =>
{
	const { app, settings } = createApp({ username: 'test@example.test', password: 'test-password' });
	let logouts = 0;
	let release;
	const pending = new Promise((resolve) => { release = resolve; });
	app.stopSync = async () => {};
	app.tahomaCloud = { logout: async () => { logouts++; await pending; } };
	const first = app.logOut(false);
	const second = app.logOut(false);
	release();
	await Promise.all([first, second]);
	assert.equal(logouts, 1);
	assert.equal(settings.password, 'test-password');
	assert.equal(app._logoutInProgress, null);
	await app.logOut(true);
	assert.equal(settings.username, undefined);
	assert.equal(settings.password, undefined);
});

test('syncEvents dispatches cloud events and local state refreshes to each device', async () =>
{
	const { app, runtimeDrivers } = createApp();
	const calls = [];
	runtimeDrivers.blind = {
		getDevices: () => [{
			syncEvents: async (...args) => calls.push(args),
		}],
	};
	const events = [{ name: 'DeviceStateChangedEvent' }];
	await app.syncEvents(events, false);
	await app.syncEvents(null, true);
	assert.deepEqual(calls, [[events, false], [null, true]]);
});
