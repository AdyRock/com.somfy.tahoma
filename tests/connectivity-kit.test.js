'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const modules = new Map();

class HomeyDevice
{
	log() {}

	error(error) { throw error; }

	getData() { return this.data; }

	getName() { return this.data.label; }

	getClass() { return 'blinds'; }

	getSetting(key) { return this.settings[key]; }

	getState() { return { ...this.values }; }

	getCapabilityValue(name) { return this.values[name]; }

	hasCapability(name) { return this.capabilities.has(name); }

	async addCapability(name) { this.capabilities.add(name); }

	async removeCapability(name) { this.capabilities.delete(name); }

	registerCapabilityListener(name, listener) { this.listeners[name] = listener; }

	async triggerCapabilityListener(name, value, opts) { return this.listeners[name](value, opts); }

	async setCapabilityValue(name, value) { this.values[name] = value; }

	async setWarning(value) { this.warning = value; }
}

function load(relativePath)
{
	const filename = path.resolve(root, relativePath);
	if (modules.has(filename))
	{
		return modules.get(filename);
	}

	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
		module,
		require: (name) =>
		{
			if (name === 'homey')
			{
				return { Device: HomeyDevice, Driver: HomeyDevice };
			}
			return load(path.relative(root, path.resolve(path.dirname(filename), `${name}.js`)));
		},
		clearTimeout,
	}, { filename });
	modules.set(filename, module.exports);
	return module.exports;
}

function create(relativePath, controllableName, capabilities, settings = {})
{
	const Device = load(relativePath);
	const device = new Device();
	device.data = { controllableName, label: 'Test device', deviceURL: 'ogp://test/1' };
	device.capabilities = new Set(capabilities);
	device.settings = settings;
	device.listeners = {};
	device.values = {};
	device.actions = [];
	device.driver = {};
	device.homey = {
		settings: { get: () => '' },
		flow: { getDeviceTriggerCard: () => ({}) },
		setTimeout: () => null,
		app: {
			logInformation: () => {},
			logStates: () => {},
			isLocalDevice: () => false,
			getDeviceData: async () => [],
			executeDeviceAction: async (label, url, action) =>
			{
				device.actions.push(JSON.parse(JSON.stringify(action)));
				return { execId: 'test', local: false };
			},
			cancelExecution: async () => {},
		},
	};
	return device;
}

async function sendState(device, value)
{
	device.executionId = null;
	device.executionCmd = '';
	device.lastDispatchedCommand = '';
	await device.listeners.windowcoverings_state(value);
	assert.equal(device.warning, null);
	return device.actions[device.actions.length - 1];
}

test('the three logged controllable types are discoverable using existing drivers', async () =>
{
	const cases = [
		['drivers\\dimmable_light\\driver.js', 'ogp:Light'],
		['drivers\\rts_interior_blind\\driver.js', 'ogp:Blind'],
		['drivers\\rts_horizontal_awning\\driver.js', 'ogp:Awning'],
	];
	for (const [filename, controllableName] of cases)
	{
		const driver = create(filename, controllableName, []);
		await driver.onInit();
		driver.homey.app.getDeviceData = async () => [
			driver.data,
			{ controllableName: 'ogp:Bridge', label: 'rts' },
			{ controllableName: 'ogp:Gateway', label: 'Connectivity kit-box' },
		];
		const devices = await driver.onReceiveSetupData();
		assert.equal(devices.length, 1);
		assert.equal(devices[0].data.controllableName, controllableName);
		assert.equal(devices[0].data.deviceURL, driver.data.deviceURL);
	}
});

test('the status LED exposes dimming without unsupported on/off or timer controls', async () =>
{
	const device = create('drivers\\dimmable_light\\device.js', 'ogp:Light', ['onoff', 'dim', 'on_with_timer']);
	await device.onInit();
	assert.deepEqual([...device.capabilities], ['dim']);
	for (const [value, intensity] of [[0, 0], [0.42, 42], [1, 100]])
	{
		device.commandExecuting = '';
		device.executionId = null;
		await device.listeners.dim(value);
		assert.deepEqual(device.actions[device.actions.length - 1], { name: 'setIntensity', parameters: [intensity] });
	}
	await device.listeners.dim(0.42, { fromCloudSync: true });
	assert.equal(device.values.dim, 0.42);
});

test('OGP blinds restore My on existing devices and use the advertised alias', async () =>
{
	const device = create('drivers\\rts_interior_blind\\device.js', 'ogp:Blind', ['windowcoverings_state']);
	await device.onInit();
	assert.equal(device.hasCapability('my_position'), true);
	assert.equal(device.hasCapability('windowcoverings_set'), false);
	assert.equal(device.openClosedStateName, '');
	assert.equal(device.positionStateName, '');
	for (const [value, command] of [['up', 'open'], ['down', 'close'], ['idle', 'stop']])
	{
		assert.deepEqual(await sendState(device, value), { name: command, parameters: [] });
	}
	await device.listeners.my_position();
	assert.deepEqual(device.actions[device.actions.length - 1], { name: 'goToAlias', parameters: ['1'] });
	await device.onSettings({ newSettings: { invertUpDown: true }, changedKeys: ['invertUpDown'] });
	assert.equal((await sendState(device, 'up')).name, 'close');
	assert.equal((await sendState(device, 'down')).name, 'open');
});

test('OGP awnings support retract, extend, stop and My without position feedback', async () =>
{
	const device = create('drivers\\rts_horizontal_awning\\device.js', 'ogp:Awning', ['windowcoverings_state', 'my_position']);
	await device.onInit();
	assert.equal(device.hasCapability('windowcoverings_set'), false);
	assert.equal(device.hasCapability('windowcoverings_closed'), false);
	assert.equal(device.openClosedStateName, '');
	assert.equal(device.positionStateName, '');
	for (const [value, command] of [['up', 'rollUp'], ['down', 'rollOut'], ['idle', 'stop']])
	{
		assert.deepEqual(await sendState(device, value), { name: command, parameters: [] });
	}
	await device.listeners.my_position();
	assert.deepEqual(device.actions[device.actions.length - 1], { name: 'goToAlias', parameters: ['1'] });
});

test('OGP awning inversion works at startup and after changing settings', async () =>
{
	const device = create('drivers\\rts_horizontal_awning\\device.js', 'ogp:Awning', ['windowcoverings_state', 'my_position'], { invertUpDown: true });
	await device.onInit();
	assert.equal((await sendState(device, 'up')).name, 'rollOut');
	assert.equal((await sendState(device, 'down')).name, 'rollUp');
	await device.onSettings({ newSettings: { invertUpDown: false }, changedKeys: ['invertUpDown'] });
	assert.equal((await sendState(device, 'up')).name, 'rollUp');
	assert.equal((await sendState(device, 'down')).name, 'rollOut');
	assert.equal((await sendState(device, 'idle')).name, 'stop');
});

test('legacy RTS blind and awning commands remain unchanged', async () =>
{
	for (const [filename, controllableName] of [
		['drivers\\rts_interior_blind\\device.js', 'rts:BlindRTSComponent'],
		['drivers\\rts_horizontal_awning\\device.js', 'rts:HorizontalAwningRTSComponent'],
	])
	{
		const device = create(filename, controllableName, ['windowcoverings_state', 'my_position']);
		await device.onInit();
		assert.equal((await sendState(device, 'up')).name, 'open');
		assert.equal((await sendState(device, 'down')).name, 'close');
		await device.listeners.my_position();
		assert.deepEqual(device.actions[device.actions.length - 1], { name: 'my', parameters: [] });
		await device.onSettings({ newSettings: { invertUpDown: true }, changedKeys: ['invertUpDown'] });
		assert.equal((await sendState(device, 'up')).name, 'close');
		assert.equal((await sendState(device, 'down')).name, 'open');
	}
});

test('Somfy Zigbee shades retain My and support percentage positioning', async () =>
{
	const device = create('drivers\\io_roller_shutter\\device.js', 'zigbee:SomfyRollerShadeComponent',
		['windowcoverings_state', 'windowcoverings_set', 'windowcoverings_closed']);
	await device.onInit();
	assert.equal(device.hasCapability('my_position'), true);
	await device.listeners.my_position();
	assert.deepEqual(device.actions.pop(), { name: 'my', parameters: [] });
	for (const [value, position] of [[0, 100], [0.25, 75], [1, 0]])
	{
		device.executionCmd = '';
		await device.listeners.windowcoverings_set(value);
		assert.deepEqual(device.actions.pop(), { name: 'setPosition', parameters: [position] });
	}
	assert.equal(device.openClosedStateName, '');
	assert.equal(device.positionStateName, 'core:ClosureState');
});

test('window covering state returns from idle when closure reaches an endpoint', async () =>
{
	const device = create('drivers\\io_vertical_exterior_blind\\device.js', 'ogp:Blind',
		['windowcoverings_state', 'windowcoverings_set', 'windowcoverings_closed']);
	await device.onInit();

	await device.syncEvents([
		{
			name: 'DeviceStateChangedEvent',
			deviceURL: device.data.deviceURL,
			deviceStates: [{ name: 'core:OpenClosedState', value: 'open' }],
		},
	], false);
	assert.equal(device.values.windowcoverings_state, 'up');

	for (const [position, state, closed] of [
		[21, 'idle', false],
		[0, 'up', false],
		[85, 'idle', false],
		[100, 'down', true],
	])
	{
		await device.syncEvents([{
			name: 'DeviceStateChangedEvent',
			deviceURL: device.data.deviceURL,
			deviceStates: [{ name: 'core:ClosureState', value: position }],
		}], false);
		assert.equal(device.values.windowcoverings_state, state);
		assert.equal(device.values.windowcoverings_closed, closed);
	}
});

test('Zigbee smart plugs can be paired as sockets and support on/off and timers', async () =>
{
	const driver = create('drivers\\on_off_socket\\driver.js', 'zigbee:OnOffComponent', []);
	await driver.onInit();
	driver.homey.app.getDeviceData = async () => [driver.data];
	assert.equal((await driver.onReceiveSetupData()).length, 1);
	const device = create('drivers\\on_off_socket\\device.js', 'zigbee:OnOffComponent', ['onoff', 'on_with_timer']);
	await device.onInit();
	assert.equal(device.hasCapability('on_with_timer'), true);
	for (const [value, command] of [[true, 'on'], [false, 'off']])
	{
		device.commandExecuting = '';
		device.executionId = null;
		await device.listeners.onoff(value);
		assert.deepEqual(device.actions.pop(), { name: command, parameters: [] });
	}
	device.executionId = null;
	await device.listeners.on_with_timer(5);
	assert.deepEqual(device.actions.pop(), { name: 'onWithTimer', parameters: [5] });
});

test('configuration endpoints supply battery percentages or discrete alarms without fabricated percentages', async () =>
{
	for (const state of [
		{ name: 'core:BatteryLevelState', value: 99 },
		{ name: 'core:BatteryDiscreteLevelState', value: 'good' },
		{ name: 'core:BatteryDiscreteLevelState', value: 'low' },
	])
	{
		const device = create('drivers\\Device.js', 'zigbee:SomfyRollerShadeComponent', []);
		device.data.deviceURL = 'zigbee://test/123/1';
		device.homey.app.getDeviceData = async () => [
			{ deviceURL: 'zigbee://test/456/232', states: [{ name: 'core:BatteryLevelState', value: 1 }] },
			{ deviceURL: 'zigbee://test/123/232', states: [state] },
		];
		await device.syncBatteryLevelCapability([], []);
		if (state.name === 'core:BatteryLevelState')
		{
			assert.equal(device.values.measure_battery, 99);
		}
		else
		{
			assert.equal(device.hasCapability('measure_battery'), false);
			assert.equal(device.values.alarm_battery, state.value !== 'good');
		}
	}
});

test('discrete battery events from a shade configuration endpoint update the shade alarm', async () =>
{
	const device = create('drivers\\io_roller_shutter\\device.js', 'zigbee:SomfyRollerShadeComponent',
		['windowcoverings_state', 'windowcoverings_set', 'my_position', 'windowcoverings_closed']);
	device.data.deviceURL = 'zigbee://test/123/1';
	await device.onInit();
	for (const [value, alarm] of [['low', true], ['good', false]])
	{
		await device.syncEvents([{
			name: 'DeviceStateChangedEvent',
			deviceURL: 'zigbee://test/123/232',
			deviceStates: [{ name: 'core:BatteryDiscreteLevelState', value }],
		}], true);
		assert.equal(device.values.alarm_battery, alarm);
	}
});

test('remote events use only related endpoints and accept empty event batches', async () =>
{
	const device = create('drivers\\zigbee_remote_ergonomics\\device.js', 'zigbee:SomfyRemoteWithErgonomicsComponent',
		['measure_battery', 'ergonomics_mode']);
	device.data.deviceURL = 'zigbee://test/51050/1';
	await device.onInit();
	await device.syncEvents([], true);
	await device.syncEvents([{
		name: 'DeviceStateChangedEvent',
		deviceURL: 'zigbee://test/51050/232',
		deviceStates: [{ name: 'core:BatteryLevelState', value: 99 }],
	}], true);
	assert.equal(device.values.measure_battery, 99);
	await device.syncEvents([{
		name: 'DeviceStateChangedEvent',
		deviceURL: 'zigbee://test/99999/232',
		deviceStates: [{ name: 'core:BatteryLevelState', value: 1 }],
	}], true);
	assert.equal(device.values.measure_battery, 99);
});

test('shade polling reads battery data from its configuration endpoint', async () =>
{
	for (const state of [
		{ name: 'core:BatteryLevelState', value: 100 },
		{ name: 'core:BatteryDiscreteLevelState', value: 'good' },
	])
	{
		const device = create('drivers\\io_roller_shutter\\device.js', 'zigbee:SomfyRollerShadeComponent',
			['windowcoverings_state', 'windowcoverings_set', 'my_position', 'windowcoverings_closed']);
		device.data.deviceURL = 'zigbee://test/123/1';
		await device.onInit();
		device.homey.app.isLoggedIn = () => true;
		device.homey.app.getDeviceStates = async () => [];
		device.homey.app.getDeviceData = async () => [{ deviceURL: 'zigbee://test/123/232', states: [state] }];
		await device.sync();
		if (state.name === 'core:BatteryLevelState')
		{
			assert.equal(device.values.measure_battery, 100);
		}
		else
		{
			assert.equal(device.values.alarm_battery, false);
			assert.equal(device.hasCapability('measure_battery'), false);
		}
	}
});

test('remote polling gets the physical remote battery for each channel', async () =>
{
	for (const channel of [1, 2, 3, 4, 5])
	{
		const device = create('drivers\\zigbee_remote_ergonomics\\device.js', 'zigbee:SomfyRemoteWithErgonomicsComponent',
			['measure_battery', 'ergonomics_mode']);
		device.data.deviceURL = `zigbee://test/51050/${channel}`;
		await device.onInit();
		device.homey.app.isLoggedIn = () => true;
		device.homey.app.getDeviceStates = async () => [];
		device.homey.app.getDeviceData = async () => [{
			deviceURL: 'zigbee://test/51050/232',
			states: [{ name: 'core:BatteryLevelState', value: 99 }],
		}];
		await device.syncEvents(null, true);
		assert.equal(device.values.measure_battery, 99);
	}
});
