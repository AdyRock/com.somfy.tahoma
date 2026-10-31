'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const api = require('../api');

for (const [endpoint, method, body, expected] of [
	['login', 'newLogin', { username: 'test@example.test' }, [{ username: 'test@example.test' }]],
	['logout', 'logOut', {}, []],
	['ListAccountSessions', 'getAccountSessionsForSettings', {}, []],
	['GetAccountSession', 'getAccountSessionDetails', { username: 'one' }, ['one']],
	['SaveAccountSession', 'saveAccountSession', { username: 'one' }, [{ username: 'one' }]],
	['DeleteAccountSession', 'deleteAccountSession', { username: 'one', force: true }, ['one', true]],
	['GetDeviceLog', 'logDevices', {}, []],
	['SendDeviceLog', 'sendLog', {}, ['deviceLog']],
	['SendInfoLog', 'sendLog', {}, ['infoLog']],
	['SendEventLog', 'sendLog', {}, ['eventLog']],
	['GetLocalTokens', 'getLocalTokens', {}, []],
	['DeleteLocalToken', 'deleteLocalToken', { uuid: 'token-one' }, ['token-one']],
	['GetDriverSupportMatrix', 'getDriverSupportMatrix', {}, []],
	['SendUnsupportedDevices', 'sendUnsupportedDevices', { unsupportedDevices: ['one'] }, [['one']]],
])
{
	test(`settings API ${endpoint} delegates arguments and preserves the app result`, async () =>
	{
		let received;
		const result = { ok: true };
		const homey = { app: { [method]: async (...args) => { received = args; return result; } } };
		assert.equal(await api[endpoint]({ homey, body }), result);
		assert.deepEqual(received, expected);
		const error = new Error('App failure');
		homey.app[method] = async () => { throw error; };
		await assert.rejects(api[endpoint]({ homey, body }), (err) => err === error);
	});
}
