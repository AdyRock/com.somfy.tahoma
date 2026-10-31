'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { load, createHomey, plain } = require('./helpers/harness');

const Device = load('drivers\\Device.js');
const url = 'io://1234-5678-9012/123#1';

function create()
{
	const device = new Device();
	const context = createHomey();
	device.homey = context.homey;
	device.data = { deviceURL: url, label: 'Blind' };
	device.getData = () => device.data;
	device.getName = () => 'Blind';
	device.getClass = () => 'blinds';
	device.getSettings = () => ({});
	device.values = {};
	device.getCapabilityValue = (name) => device.values[name];
	device.setCapabilityValue = async (name, value) => { device.values[name] = value; };
	device.capabilities = new Set();
	device.hasCapability = (name) => device.capabilities.has(name);
	device.addCapability = async (name) => device.capabilities.add(name);
	device.registerCapabilityListener = () => {};
	device.executionCommands = [];
	const actions = [];
	const cancellations = [];
	device.homey.app = {
		logInformation: (...args) => context.logs.push(args),
		logStates: () => {},
		executeDeviceAction: async (...args) => { actions.push(args); return { execId: 'one', local: false }; },
		cancelExecution: async (...args) => cancellations.push(args),
	};
	return { device, actions, cancellations, ...context };
}

for (const [index, expected] of [[undefined, url], [0, url.split('#')[0]], [1, url], [2, `${url.split('#')[0]}#2`]])
{
	test(`base device URL selection supports sub-device index ${index}`, () =>
	{
		const { device } = create();
		assert.equal(device.getDeviceUrl(index), expected);
		device.data.deviceURL = 'io://gateway/123';
		assert.equal(device.getDeviceUrl(2), null);
		device.data.deviceURL = '';
		assert.equal(device.getDeviceUrl(), null);
	});
}

test('component relationships exclude devices whose ID merely shares a prefix', () =>
{
	const { device } = create();
	device.combineSubURLs = true;
	assert.equal(device.isRelatedDeviceURL(`${url.split('#')[0]}#2`, url), true);
	assert.equal(device.isRelatedDeviceURL('io://1234-5678-9012/1234#1', url), false);
	assert.equal(device.isRelatedDeviceURL(null, url), false);
	assert.equal(device.getDeviceComponentRoot('invalid'), null);
	assert.equal(device.getDeviceComponentRoot('zigbee://gateway/123/232'), 'zigbee://gateway/123');
});

for (const [value, xref, expected] of [
	[true, { somfyNameSet: ['off', 'on'], ignoreValue: true }, { name: 'on', parameters: [] }],
	[false, { somfyNameSet: ['off', 'on'], ignoreValue: true }, { name: 'off', parameters: [] }],
	[0.25, { somfyNameSet: ['setClosure'], scale: 100 }, { name: 'setClosure', parameters: [25] }],
	[0.25, { somfyNameSet: ['setClosure'], scale: 100, invert: true }, { name: 'setClosure', parameters: [75] }],
	[true, { somfyNameSet: ['setMode'], parameters: ['off', 'on'] }, { name: 'setMode', parameters: ['on'] }],
	[false, { somfyNameSet: ['setMode'], compare: ['off', 'on'] }, { name: 'setMode', parameters: ['off'] }],
	[true, { somfyNameSet: ['setMode'], parameters: 'fixed' }, { name: 'setMode', parameters: ['fixed'] }],
	[true, { somfyNameSet: ['setMode'], parameterArray: [1, 2] }, { name: 'setMode', parameters: [1, 2] }],
	['', { somfyNameSet: ['stop'] }, { name: 'stop' }],
])
{
	test(`base capability command transforms ${JSON.stringify(xref)} with value ${JSON.stringify(value)}`, async () =>
	{
		const { device, actions } = create();
		await device.onCapability({ homeyName: 'test', ...xref }, value);
		assert.deepEqual(plain(actions[0][2]), expected);
		assert.equal(device.executionCommands[0].id, 'one');
		assert.equal(device.executionCommands[0].name, expected.name);
	});
}

test('replacing a running capability command cancels it through the device owner route', async () =>
{
	const { device, cancellations, actions } = create();
	device.executionCommands = [{ id: 'old', name: 'setClosure', local: false }];
	await device.onCapability({ somfyNameSet: ['setClosure'], scale: 100 }, 0.5);
	assert.deepEqual(cancellations[0], ['Blind', 'old', false, url]);
	assert.equal(actions.length, 1);
	assert.equal(device.executionCommands[0].id, 'one');
});

test('cloud-originated capability changes update state without sending another physical command', async () =>
{
	const { device, actions } = create();
	device.driver = {};
	await device.onCapability({ homeyName: 'dim' }, 0.5, { fromCloudSync: true });
	assert.equal(device.values.dim, 0.5);
	assert.equal(actions.length, 0);
});

for (const [name, value, expected] of [
	['core:BatteryLevelState', 75, 75], ['core:BatteryLevelState', '55', 55],
	['core:BatteryLevelState', -10, 0], ['core:BatteryLevelState', 150, 100],
	['core:BatteryLevelState', null, null], ['core:BatteryLevelState', 'bad', null],
	['core:BatteryState', 'FULL', 100], ['core:BatteryState', 'verylow', 0],
	['core:BatteryState', 'unknown', null], ['core:BatteryDiscreteLevelState', 'low', null],
])
{
	test(`battery conversion ${name}=${JSON.stringify(value)}`, () =>
	{
		assert.equal(create().device.getBatteryLevelPercent(name, value), expected);
	});
}

test('base device initialization adds mapped capabilities and rejects command failures', async () =>
{
	const { device } = create();
	await device.onInit([{ homeyName: 'dim', somfyNameSet: ['setIntensity'] }]);
	assert.equal(device.hasCapability('dim'), true);
	assert.equal(device.executionCommands.length, 0);
	const error = new Error('device command failed');
	device.homey.app.executeDeviceAction = async () => { throw error; };
	await assert.rejects(device.onCapability({ somfyNameSet: ['open'], ignoreValue: true }, true), (err) => err === error);
	assert.equal(device.executionCommands.length, 0);
});
