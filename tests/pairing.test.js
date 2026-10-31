'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, load, plain } = require('./helpers/harness');

function create()
{
	const context = createApp({ username: 'primary@example.test', password: 'primary-password', region: 'europe' });
	const Driver = load('drivers\\Driver.js');
	const driver = new Driver();
	driver.homey = context.homey;
	driver.deviceType = ['io:Blind'];
	driver.homey.__ = (key) => key;
	const handlers = {};
	let nextViews = 0;
	const session = {
		setHandler: (name, callback) => { handlers[name] = callback; },
		nextView: async () => { nextViews++; },
	};
	return { ...context, driver, session, handlers, nextViews: () => nextViews };
}

test('pairing supports saved-account selection, credential reuse and restoration of the primary', async () =>
{
	const { app, driver, session, handlers, nextViews } = create();
	app.upsertAccountSession({ username: 'second@example.test', password: 'secondary-password', region: 'usa' });
	const logins = [];
	const restored = [];
	app.newLogin_2 = async (...args) => { logins.push(args); return true; };
	app.restorePrimaryCloudSession = async (...args) => restored.push(args);
	await driver.onPair(session);
	assert.equal((await handlers.sessions_list()).length, 2);
	assert.equal((await handlers.session_select({ username: 'missing@example.test' })).found, false);
	const selected = await handlers.session_select({ username: 'second@example.test' });
	assert.equal(selected.found, true);
	assert.equal('password' in selected, false);
	await handlers.showView('login_credentials');
	assert.equal(nextViews(), 1);
	assert.equal(await handlers.login({}), true);
	assert.deepEqual(logins[0], ['second@example.test', 'secondary-password', 'usa', null, true]);
	await handlers.disconnect();
	assert.deepEqual(restored[0], ['primary@example.test', 'primary-password', 'europe']);
});

test('pairing rejects invalid identities and missing passwords before listing devices', async () =>
{
	const { driver, session, handlers } = create();
	await driver.onPair(session);
	await assert.rejects(handlers.login({ username: 'invalid', password: 'x' }), /valid email/);
	await assert.rejects(handlers.login({ username: 'new@example.test' }), /password/);
	await assert.rejects(handlers.list_devices(), /on_pair_login_failure/);
});

test('device pairing filters controllable types, disambiguates gateway labels and records account ownership', async () =>
{
	const { app, driver } = create();
	app.getDeviceData = async () => [
		{ deviceURL: 'io://1234-5678-9012/1', label: 'Blind', controllableName: 'io:Blind' },
		{ deviceURL: 'io://9876-5432-1098/1', label: 'Blind', controllableName: 'io:Blind' },
		{ deviceURL: 'rts://1234-5678-9012/2', label: 'Other', controllableName: 'rts:Blind' },
	];
	const result = await driver.onReceiveSetupData();
	assert.equal(result.length, 2);
	assert.equal(result[0].name, 'Blind (1234-5678-9012)');
	assert.equal(result[1].name, 'Blind (9876-5432-1098)');
	assert.deepEqual(plain(result[0].settings), { sessionUsername: 'primary@example.test' });
	assert.equal(result[0].data.id, 'io://1234-5678-9012/1');
	assert.deepEqual(plain(driver.getDeviceType()), ['io:Blind']);
	app.getDeviceData = async () => { throw new Error('discovery failed'); };
	await assert.rejects(driver.onReceiveSetupData(), /discovery failed/);
});

test('repair reauthenticates with the supplied credentials', async () =>
{
	const { app, driver, session, handlers } = create();
	const logins = [];
	app.newLogin_2 = async (...args) => { logins.push(args); return true; };
	await driver.onRepair(session);
	assert.equal(await handlers.login({ username: 'repair@example.test', password: 'replacement' }), true);
	assert.deepEqual(logins[0], ['repair@example.test', 'replacement', 'europe', null, true]);
});
