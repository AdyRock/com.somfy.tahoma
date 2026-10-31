'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHomey, load } = require('./helpers/harness');

function create()
{
	const messages = [];
	let mailError;
	const App = load('app.js', {
		nodemailer: {
			createTransport: () => ({
				sendMail: async (message) =>
				{
					messages.push(message);
					if (mailError) throw mailError;
					return {};
				},
			}),
		},
	});
	const app = new App();
	const context = createHomey({ infoLog: [], stateLog: '', eventLog: '' });
	app.homey = context.homey;
	app.homeyIP = '192.0.2.1';
	app.homeyHash = 'test-hash';
	app.lastLogTime = new Date();
	return { ...context, app, messages, failMail: (error) => { mailError = error; } };
}

test('information log records timing and error details and retains only the newest 200 entries', () =>
{
	const { app, settings } = create();
	for (let i = 0; i < 205; i++)
	{
		app.logInformation(`test-${i}`, { message: `message-${i}` });
	}
	assert.equal(settings.infoLog.length, 200);
	assert.equal(settings.infoLog[0].source, 'test-5');
	assert.equal(settings.infoLog[199].source, 'test-204');
	app.logInformation('failure', new Error('diagnostic failure'));
	assert.match(settings.infoLog[199].data, /diagnostic failure/);
	assert.ok(settings.infoLog[199].elapsed >= 0);
});

test('state and event logs respect size limits without disabling unrelated logging', () =>
{
	const { app, settings } = create();
	settings.stateLogEnabled = false;
	app.logStates('ignored');
	assert.equal(settings.stateLog, '');
	settings.stateLogEnabled = true;
	app.logStates('test');
	assert.equal(settings.stateLog, 'test\n');
	settings.stateLog = 'x'.repeat(30000);
	app.logStates('overflow');
	assert.equal(settings.stateLogEnabled, false);
	settings.eventLog = 'old\n'.repeat(10000);
	app.logEvents('latest');
	assert.ok(settings.eventLog.length <= 1000);
	assert.ok(settings.eventLog.includes('latest'));
});

for (const type of ['infoLog', 'deviceLog', 'eventLog'])
{
	test(`sending ${type} formats the correct diagnostic message using a mocked mail transport`, async () =>
	{
		const { app, settings, messages, failMail } = create();
		settings[type] = { test: 'diagnostic data' };
		const result = await app.sendLog(type);
		assert.equal(result.message, 'test-hash');
		assert.equal(messages.length, 1);
		assert.match(messages[0].subject, /test-hash/);
		assert.match(messages[0].text, /diagnostic data/);
		const error = new Error('mail unavailable');
		failMail(error);
		const failed = await app.sendLog(type);
		assert.equal(failed.error, error);
		assert.equal(failed.message, null);
	});
}

test('unsupported-device report groups controllable types and surfaces mail failures', async () =>
{
	const { app, messages, failMail } = create();
	assert.match((await app.sendUnsupportedDevices([])).error.message, /No unsupported devices/);
	const devices = [
		{ label: 'Test device', controllableName: 'io:NewDevice', deviceURL: 'io://gateway/1', availableCommands: ['open'], states: ['core:State'], somfyDevice: { test: true } },
	];
	assert.equal((await app.sendUnsupportedDevices(devices)).message, 'test-hash');
	assert.equal(messages.length, 1);
	assert.match(messages[0].text, /io:NewDevice/);
	assert.match(messages[0].text, /Test device/);
	failMail(new Error('mail failed'));
	assert.match((await app.sendUnsupportedDevices(devices)).error.message, /mail failed/);
});
