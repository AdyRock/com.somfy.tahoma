'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, plain } = require('./helpers/harness');

function create()
{
	const { app } = createApp();
	const cards = {};
	const calls = [];
	const writes = [];
	app.homey.flow = {
		getActionCard: (id) => ({
			registerRunListener: (listener) => { cards[id] = listener; },
		}),
	};
	app.registerActionFlowCards();
	const device = {
		triggerCapabilityListener: async (...args) => { calls.push(args); return 'sent'; },
		setCapabilityValue: async (...args) => writes.push(args),
	};
	return { app, cards, device, calls, writes };
}

for (const [card, args, expected] of [
	['calendar_state_on', {}, ['calendar_state_on', true, null]],
	['calendar_state_off', {}, ['calendar_state_off', true, null]],
	['set_my_heat_level', {}, ['my_heat_level', true, null]],
	['set_heat_level', { heat_level: 3 }, ['heat_level', 3, null]],
	['set_on', {}, ['on_button', true, null]],
	['set_off', {}, ['off_button', true, null]],
	['set_on_timer', { duration: 30 }, ['on_with_timer', 30, null]],
	['set_open_window_activation', { open_window_activation: 'on' }, ['open_window_activation', true, null]],
	['set_open_window_activation', { open_window_activation: 'off' }, ['open_window_activation', false, null]],
	['set_valve_auto_mode', { set_valve_auto: 'on' }, ['valve_auto_mode', true, null]],
	['start_siren', {}, ['ring_button', null]],
	['stop_siren', {}, ['stop_button', null]],
	['set_heating_level2_state', { state: 'eco' }, ['heating_level2_state', 'eco']],
	['windowcoverings_upper_set', { windowcoverings_set: 0.3 }, ['windowcoverings_set.upper', 0.3]],
	['windowcoverings_lower_set', { windowcoverings_set: 0.7 }, ['windowcoverings_set.lower', 0.7]],
	['set_pedestrian', {}, ['pedestrian']],
	['set_open', {}, ['open_button']],
	['set_close', {}, ['close_button']],
	['target_temperature_manual_set', { target_temperature: 20, derogation_type: 'next' }, ['target_temperature.manual', 20, { derogation_type: 'next' }]],
	['target_temperature_manual_set_for', { target_temperature: 21, days: 1, hours: 2, minutes: 3 }, ['target_temperature.manual', 21, { derogation_type: 93780 }]],
	['target_temperature_comfort_heating_set', { target_temperature: 22 }, ['target_temperature.comfort_heating', 22]],
	['target_temperature_eco_heating_set', { target_temperature: 17 }, ['target_temperature.eco_heating', 17]],
	['target_temperature_away_set', { target_temperature: 14 }, ['target_temperature.away', 14]],
	['target_temperature_frost_protection_set', { target_temperature: 8 }, ['target_temperature.frost_protection', 8]],
	['nudge_windowcoverings_tilt', { direction: 'down' }, ['windowcoverings_tilt_down']],
	['nudge_windowcoverings_tilt', { direction: 'up' }, ['windowcoverings_tilt_up']],
	['set_quiet_mode', { quiet_mode: true }, ['quiet_mode', true]],
	['sound_alarm1', { duration: 2, on_off_ratio: 50, repeats: 3, volume: 20 }, ['soundAlarm_1_button', null, [2000, 50, 2, 20]]],
])
{
	test(`Flow ${card} sends the expected capability arguments (${JSON.stringify(args)})`, async () =>
	{
		const { cards, device, calls } = create();
		assert.equal(await cards[card]({ device, ...args }), 'sent');
		assert.deepEqual(plain(calls), [expected]);
		const error = new Error('device rejected command');
		device.triggerCapabilityListener = async () => { throw error; };
		await assert.rejects(cards[card]({ device, ...args }), (err) => err === error);
	});
}

for (const [card, method, argument, capability] of [
	['eco_temperature_set', 'onCapabilityTargetTemperatureEco', 'target_temperature', 'target_temperature.eco'],
	['comfort_temperature_set', 'onCapabilityTargetTemperatureComfort', 'target_temperature', 'target_temperature.comfort'],
	['boiler_mode_set', 'onCapabilityBoilerMode', 'state', 'boiler_mode'],
	['boost_on_off', 'onCapabilityBoostState', 'state', 'boost'],
	['eco_cooling_temperature_set', 'onCapabilityTargetTemperatureEcoCooling', 'target_temperature', 'target_temperature.eco_cooling'],
	['eco_heating_temperature_set', 'onCapabilityTargetTemperatureEcoHeating', 'target_temperature', 'target_temperature.eco_heating'],
	['comfort_cooling_temperature_set', 'onCapabilityTargetTemperatureComfortCooling', 'target_temperature', 'target_temperature.comfort_cooling'],
	['comfort_heating_temperature_set', 'onCapabilityTargetTemperatureComfortHeating', 'target_temperature', 'target_temperature.comfort_heating'],
	['target_temperature_cooling_set', 'onCapabilityTargetTemperatureCooling', 'target_temperature', 'target_temperature.cooling'],
	['target_temperature_heating_set', 'onCapabilityTargetTemperatureHeating', 'target_temperature', 'target_temperature.heating'],
	['set_heating_mode', 'onCapabilityHeatingModeState', 'state', 'heating_mode'],
	['cool_mode_set', 'onCapabilityHeatCoolModeCool', 'state', 'heat_cool_mode.cool'],
	['heat_mode_set', 'onCapabilityHeatCoolModeHeat', 'state', 'heat_cool_mode.heat'],
	['ac_louver_position_set', 'onCapabilityLouverPosition', 'louver_position', 'ac_louver_position'],
	['ac_control_mode_set', 'onCapabilityControlMode', 'control_mode', 'ac_control_mode'],
	['ac_thermostat_mode_set', 'onCapabilityThermostateMode', 'thermostat_mode', 'ac_thermostat_mode'],
	['ac_fan_speed_set', 'onCapabilityFanSpeed', 'fan_speed', 'ac_fan_speed_mode'],
])
{
	test(`Flow ${card} only updates ${capability} after the device command succeeds`, async () =>
	{
		const { cards, device, writes } = create();
		const calls = [];
		device[method] = async (...args) => calls.push(args);
		const args = { device, [argument]: 20 };
		await cards[card](args);
		assert.deepEqual(calls, [[20, null]]);
		assert.deepEqual(writes, [[capability, 20]]);
		device[method] = async () => { throw new Error('command failed'); };
		await assert.rejects(cards[card](args), /command failed/);
		assert.equal(writes.length, 1);
	});
}

test('zone Flow only triggers selected zones and propagates failures', async () =>
{
	const { cards, device, calls } = create();
	await cards.set_zone({ device, zone_button_a: '1', zone_button_b: '0', zone_button_c: '1' });
	assert.deepEqual(calls, [['zone_button.a', true, null], ['zone_button.c', true, null]]);
	device.triggerCapabilityListener = async () => { throw new Error('zone failed'); };
	await assert.rejects(cards.set_zone({ device, zone_button_a: '1' }), /zone failed/);
});

test('derogation Flow sets the type before sending the mode', async () =>
{
	const { cards, device, writes, calls } = create();
	await cards.set_derogation_mode({ device, type: 'next', derogation_mode: 'eco' });
	assert.deepEqual(writes, [['derogation_type', 'next']]);
	assert.deepEqual(calls, [['derogation_mode', 'eco', null]]);
});
