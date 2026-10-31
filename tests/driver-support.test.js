'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createApp, device, plain } = require('./helpers/harness');

for (const [capability, commands, states] of [
	['windowcoverings_state', [], ['core:ClosureState']],
	['windowcoverings_set', ['setClosure'], []],
	['windowcoverings_closed', [], ['core:OpenClosedState']],
	['my_position', ['goToAlias'], []],
	['quiet_mode', ['setPositionAndLinearSpeed'], []],
	['onoff', ['on'], []],
	['homealarm_state', ['arm', 'disarm', 'partial'], []],
	['homealarm_state', [], ['myfox:AlarmStatusState']],
	['homealarm_state', [], ['core:HomeAlarmState']],
	['alarm_generic', [], ['core:IntrusionState']],
	['alarm_generic', [], ['core:GenericAlarmState']],
	['alarm_generic', [], ['internal:IntrusionDetectedState']],
	['tahoma_alarm_state', [], ['internal:CurrentAlarmModeState']],
	['tahoma_alarm_state', ['setTargetAlarmMode'], []],
	['dim', ['setIntensity'], []],
	['measure_temperature', [], ['core:TemperatureState']],
	['measure_humidity', [], ['core:HumidityState']],
	['measure_luminance', [], ['core:LuminanceState']],
	['locked', ['lock'], []],
	['target_temperature.eco', ['setEcoTemperature'], []],
	['alarm_smoke', [], ['core:SmokeState']],
])
{
	test(`driver recommendation recognizes ${capability} and rejects absent features`, () =>
	{
		const { app } = createApp();
		assert.equal(app.doesCapabilityMatchSomfyFeatures(capability, commands, states), true);
		assert.equal(app.doesCapabilityMatchSomfyFeatures(capability, [], []), false);
	});
}

test('windowcoverings_state matches movement commands for stateless RTS devices', () =>
{
	const { app } = createApp();
	assert.equal(app.doesCapabilityMatchSomfyFeatures('windowcoverings_state', ['up', 'down', 'stop', 'my'], []), true);
	assert.equal(app.doesCapabilityMatchSomfyFeatures('windowcoverings_state', ['identify'], []), false);
});

test('driver scoring rewards matching capabilities and penalizes unsupported features', () =>
{
	const { app } = createApp();
	const result = app.scoreDriverForSomfyDevice({ capabilities: ['onoff', 'dim'] }, { commands: ['on'], states: [] });
	assert.equal(result.score, 113);
	assert.equal(result.baseScore, 100);
	assert.equal(result.compatibilityRatio, 0.5);
	assert.deepEqual(plain(result.matchedCapabilities), ['onoff']);
	assert.deepEqual(plain(result.unmatchedCapabilities), ['dim']);
	assert.equal(app.scoreDriverForSomfyDevice({}, {}).score, 100);
	assert.equal(app.doesCapabilityMatchSomfyFeatures('', [], []), false);
});

test('driver metadata extraction handles quote styles, duplicates and localized names', () =>
{
	const { app } = createApp();
	assert.deepEqual(plain(app.extractDeviceTypesFromDriverJs('this.deviceType = [\'io:Blind\', "rts:Blind", \'io:Blind\'];')), ['io:Blind', 'rts:Blind']);
	assert.deepEqual(plain(app.extractDeviceTypesFromDriverJs('')), []);
	assert.deepEqual(plain(app.extractDeviceTypesFromDriverJs('this.somethingElse = [];')), []);
	app.homey.i18n = { getLanguage: () => 'nl' };
	assert.equal(app.getDriverFriendlyName({ name: { en: 'Blind', nl: 'Gordijn' } }, 'blind'), 'Gordijn');
	assert.equal(app.getDriverFriendlyName({ name: { en: 'Blind' } }, 'blind'), 'Blind');
	assert.equal(app.getDriverFriendlyName({ name: { de: 'Rollo' } }, 'blind'), 'Rollo');
	assert.equal(app.getDriverFriendlyName({ name: 'Blind' }, 'blind'), 'Blind');
	assert.equal(app.getDriverFriendlyName({}, 'blind'), 'blind');
	assert.equal(app.getDriverIconPath({}, 'blind'), '/drivers/blind/assets/icon.svg');
});

test('Somfy command and state extraction de-duplicates case-insensitively and ignores invalid entries', () =>
{
	const { app } = createApp();
	const somfy = {
		definition: {
			commands: [{ commandName: 'Open' }, { commandName: 'open' }, null, {}],
			states: [{ qualifiedName: 'core:PositionState' }],
		},
		states: [{ name: 'core:PositionState' }, { name: 'core:BatteryState' }, null],
	};
	assert.deepEqual(plain(app.getSomfyDeviceCommandNames(somfy)), ['open']);
	assert.deepEqual(plain(app.getSomfyDeviceStateNames(somfy)), ['core:positionstate', 'core:batterystate']);
	assert.deepEqual(plain(app.getSomfyDeviceCommandNames(null)), []);
	assert.deepEqual(plain(app.getSomfyDeviceStateNames(null)), []);
});

test('driver definitions can be discovered from real manifests without starting drivers', async () =>
{
	const { app } = createApp();
	const definitions = await app.getDriverDefinitions();
	assert.ok(definitions.length > 50);
	const socket = definitions.find((driver) => driver.driverId === 'on_off_socket');
	assert.ok(socket.supportedControllableNames.includes('zigbee:OnOffComponent'));
	assert.ok(socket.capabilities.includes('onoff'));
	assert.equal(await app.fileExists(path.resolve(__dirname, '..', 'package.json')), true);
	assert.equal(await app.fileExists(path.resolve(__dirname, 'missing-file')), false);
});

test('driver support matrix matches mixed-case controllable names and detects installed devices', async () =>
{
	const { app, runtimeDrivers } = createApp();
	app.tahomaCloud.authenticated = true;
	app.getDriverDefinitions = async () => [{
		driverId: 'blind',
driverName: 'Blind',
capabilities: ['windowcoverings_set'],
		supportedControllableNames: ['io:Blind'],
	}];
	app.getSomfyDevicesForDriverSupport = async () => [
		{ deviceURL: 'io://gateway/1', label: 'Bedroom', controllableName: 'IO:BLIND', commands: ['open'], states: [] },
		{ deviceURL: 'io://gateway/2', label: 'Kitchen', controllableName: 'io:Blind', commands: ['open'], states: [] },
		{ deviceURL: 'unknown://gateway/1', label: 'Unknown', controllableName: 'unknown:Device', commands: [], states: [] },
	];
	runtimeDrivers.blind = { getDevices: () => [device({ deviceURL: 'io://gateway/1' })] };
	const result = await app.getDriverSupportMatrix();
	assert.equal(result.hasConnectedSession, true);
	assert.equal(result.totalSomfyDevices, 3);
	assert.equal(result.totalMatchedDrivers, 1);
	assert.equal(result.totalSupportedInstalled, 1);
	assert.equal(result.totalSupportedNotInstalled, 1);
	assert.equal(result.totalUnsupported, 1);
	assert.equal(result.drivers[0].matchedDeviceCount, 2);
	assert.equal(result.controllableNames.length, 2);
	assert.equal(result.recommendations.find((entry) => entry.label === 'Bedroom').isInstalled, true);
	const candidate = result.recommendations.find((entry) => entry.label === 'Bedroom').candidates[0];
	assert.equal(candidate.matchedControllableName, 'io:Blind');
	assert.equal(candidate.baseScore, 100);
	assert.deepEqual(plain(result.recommendations.find((entry) => entry.label === 'Unknown').candidates), []);
});

test('One Alarm matches its real commands and states and retains its controllable-name score without evidence', async () =>
{
	const { app } = createApp();
	const definitions = await app.getDriverDefinitions();
	const driver = definitions.find((entry) => entry.driverId === 'one_alarm');
	app.getDriverDefinitions = async () => [driver];
	app.getSomfyDevicesForDriverSupport = async () => [{
		controllableName: 'myfox:SomfyProtectAlarmController',
		commands: ['arm', 'disarm', 'partial'],
		states: ['core:IntrusionState', 'myfox:AlarmStatusState'],
	}, {
		controllableName: 'myfox:HomeKeeperProAlarmController',
		commands: [],
		states: [],
	}];
	const result = await app.getDriverSupportMatrix();
	const [withEvidence, withoutEvidence] = result.recommendations;
	assert.equal(withEvidence.recommendedDriverId, 'one_alarm');
	assert.deepEqual(plain(withEvidence.candidates[0].unmatchedCapabilities), []);
	assert.equal(withEvidence.candidates[0].compatibilityRatio, 1);
	assert.equal(withEvidence.candidates[0].score, 150);
	assert.equal(withoutEvidence.recommendedDriverId, 'one_alarm');
	assert.equal(withoutEvidence.candidates[0].matchedControllableName, 'myfox:HomeKeeperProAlarmController');
	assert.equal(withoutEvidence.candidates[0].baseScore, 100);
	assert.equal(withoutEvidence.candidates[0].score, 76);
});

test('TaHoma Alarm matches its advertised states and mode command', async () =>
{
	const { app } = createApp();
	const definitions = await app.getDriverDefinitions();
	const driver = definitions.find((entry) => entry.driverId === 'tahoma_alarm');
	app.getDriverDefinitions = async () => [driver];
	app.getSomfyDevicesForDriverSupport = async () => [{
		controllableName: 'internal:TSKAlarmComponent',
		commands: ['setTargetAlarmMode', 'setIntrusionDetected'],
		states: ['internal:IntrusionDetectedState', 'internal:CurrentAlarmModeState'],
	}];
	const result = await app.getDriverSupportMatrix();
	const recommendation = result.recommendations[0];
	assert.equal(recommendation.recommendedDriverId, 'tahoma_alarm');
	const candidate = recommendation.candidates[0];
	assert.equal(candidate.matchedControllableName, 'internal:TSKAlarmComponent');
	assert.deepEqual(plain(candidate.matchedCapabilities), ['alarm_generic', 'tahoma_alarm_state']);
	assert.deepEqual(plain(candidate.unmatchedCapabilities), []);
	assert.equal(candidate.compatibilityRatio, 1);
	assert.equal(candidate.score, 150);
	assert.equal(app.doesCapabilityMatchSomfyFeatures('alarm_generic', ['setIntrusionDetected'], []), false);
	assert.equal(app.doesCapabilityMatchSomfyFeatures('alarm_generic', [], ['internal:CurrentAlarmModeState']), false);
	assert.equal(app.doesCapabilityMatchSomfyFeatures('tahoma_alarm_state', ['identify'], ['core:IntrusionState']), false);
});

test('driver support popup explains the controllable-name score separately from capability evidence', () =>
{
	const html = fs.readFileSync(path.resolve(__dirname, '..', 'settings', 'index.html'), 'utf8');
	const start = html.indexOf('var formatCapabilityList = function');
	const end = html.indexOf('var appendSupportedSection = function', start);
	assert.ok(start >= 0 && end > start);
	const reason = vm.runInNewContext(`${html.slice(start, end)}\nbuildRecommendationReason(item);`, {
		tr: (key, fallback) => fallback,
		item: {
			recommendedDriverId: 'one_alarm',
			candidates: [{
				driverId: 'one_alarm',
				matchedControllableName: 'myfox:SomfyProtectAlarmController',
				baseScore: 100,
				score: 76,
				compatibilityRatio: 0,
				matchedCapabilities: [],
				unmatchedCapabilities: ['alarm_generic', 'homealarm_state'],
			}],
		},
	});
	assert.match(reason, /Matched controllable name: myfox:SomfyProtectAlarmController/);
	assert.match(reason, /Controllable-name match: \+100 points/);
	assert.match(reason, /Capability adjustment \(including coverage bonus\): -24 points/);
	assert.match(reason, /Match score: 76/);
	assert.match(reason, /Capability evidence: 0%/);
	assert.match(reason, /unmatched capabilities do not necessarily mean unsupported features/);
	assert.doesNotMatch(reason, /Compatibility:/);
});

test('driver discovery combines cloud and local devices while excluding internal protocol bridges', async () =>
{
	const { app } = createApp();
	const shade = {
		deviceURL: 'io://gateway/1',
controllableName: 'io:Blind',
label: 'Blind',
		definition: { commands: [{ commandName: 'open' }] },
	};
	app.tahomaCloud = {
		authenticated: true,
username: 'test@example.test',
		getDeviceData: async () => [shade, { controllableName: 'ogp:Bridge', uiClass: 'ProtocolGateway', label: 'rts', deviceURL: 'ogp://gateway/rts' }],
	};
	app.tahomaLocal = { authenticated: true, getDeviceData: async () => [shade] };
	const result = await app.getSomfyDevicesForDriverSupport();
	assert.equal(result.length, 1);
	assert.equal(result[0].source, 'cloud');
	assert.deepEqual(plain(result[0].commands), ['open']);
});
