'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTahoma, createApp } = require('./helpers/harness');

const pin = '1234-5678-9012';
const username = 'test@example.test';

function create()
{
	const context = createTahoma(true);
	context.client.httpHelper.getHostName = (region) => (region === 'local' ? `gateway-${pin}.local` : `${pin}.local`);
	context.client.getLocalAPIVersion = async () => ({ version: 1 });
	return context;
}

test('a cached local token connects without cloud login and records gateway routing details', async () =>
{
	const { client } = create();
	client.login = async () => { throw new Error('Must not log in to cloud'); };
	assert.equal(await client.getLocalAuthCode(username, 'test-password', 'europe', pin, 8443, 'cached-token', 'test-homey'), 'cached-token');
	assert.equal(client.authenticated, true);
	assert.equal(client.devicePin, pin);
	assert.equal(client.homeyID, 'test-homey');
	assert.equal(client.httpHelper.headers.Authorization, 'Bearer cached-token');
	assert.equal(client.httpHelper.cookies, false);
	assert.deepEqual(client.httpHelper.baseURL, ['local', pin, 8443]);
	client.local_httpsAgent.destroy();
});

test('a supplied local token skips token generation and is validated before use', async () =>
{
	const { client } = create();
	client.login = async () => { throw new Error('Must not log in to cloud'); };
	assert.equal(await client.getLocalAuthCode(username, 'test-password', 'europe', pin, 8443, null, 'test-homey', { token: 'supplied-token' }), 'supplied-token');
	assert.equal(client.httpHelper.headers.Authorization, 'Bearer supplied-token');
	client.local_httpsAgent.destroy();
});

test('local DNS ENOTFOUND retries the alternate supported hostname', async () =>
{
	const { client } = create();
	let probes = 0;
	client.getLocalAPIVersion = async () =>
	{
		if (++probes === 1)
		{
			throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
		}
		return { version: 1 };
	};
	assert.equal(await client.getLocalAuthCode(username, 'test-password', 'europe', pin, 8443, 'token', 'test-homey'), 'token');
	assert.equal(probes, 2);
	assert.deepEqual(client.httpHelper.baseURL, ['local2', pin, 8443]);
	client.local_httpsAgent.destroy();
});

for (const status of [401, 403, 500])
{
	test(`local API HTTP ${status} is not falsely marked as a successful login`, async () =>
	{
		const { client } = create();
		client.authenticated = true;
		client.getLocalAPIVersion = async () =>
		{
			throw Object.assign(new Error(`HTTP ${status}`), { response: { status } });
		};
		assert.equal(await client.getLocalAuthCode(username, 'test-password', 'europe', pin, 8443, 'token', 'test-homey'), null);
		assert.equal(client.authenticated, false);
		assert.equal(client.lastLocalTokenError.statusCode, status);
		client.local_httpsAgent.destroy();
	});
}

test('local token creation removes only this Homey token and activates its replacement', async () =>
{
	const { client } = create();
	const calls = [];
	client.login = async (...args) => { calls.push(['login', ...args]); };
	client.httpHelper.get = async (endpoint) =>
	{
		calls.push(['get', endpoint]);
		if (endpoint.endsWith('/devmode'))
		{
			return [{ label: 'Homey token test-homey', uuid: 'old' }, { label: 'Other integration', uuid: 'other' }];
		}
		return { token: 'generated-token' };
	};
	client.httpHelper.delete = async (endpoint) => calls.push(['delete', endpoint]);
	client.httpHelper.post = async (endpoint, config, data) => calls.push(['post', endpoint, data]);
	assert.equal(await client.getLocalAuthCode(username, 'test-password', 'europe', pin, 8443, null, 'test-homey'), 'generated-token');
	assert.ok(calls.some(([method, endpoint]) => method === 'delete' && endpoint.endsWith('/old')));
	assert.equal(calls.some(([method, endpoint]) => method === 'delete' && endpoint.endsWith('/other')), false);
	const activation = calls.find(([method]) => method === 'post');
	assert.equal(activation[2].token, 'generated-token');
	assert.equal(activation[2].scope, 'devmode');
	client.local_httpsAgent.destroy();
});

test('local token management is cloud-only and requires authentication', async () =>
{
	const { client } = create();
	await assert.rejects(client.getLocalTokens(pin), /Not logged in/);
	await assert.rejects(client.deleteLocalToken(pin, 'old'), /Not logged in/);
	client.authenticated = true;
	await assert.rejects(client.getLocalTokens(pin), /local login/);
	await assert.rejects(client.deleteLocalToken(pin, 'old'), /local login/);
	client.localLogin = false;
	await client.getLocalTokens(pin);
	await client.deleteLocalToken(pin, 'old');
	assert.equal(client.httpHelper.calls[0][1], `/config/${pin}/local/tokens/devmode`);
	assert.equal(client.httpHelper.calls[1][1], `/config/${pin}/local/tokens/old`);
});

test('local account login persists the validated bearer and links the account to the gateway', async () =>
{
	const { app, settings } = createApp();
	let received;
	const localClient = {
		authenticated: false,
		getLocalAuthCode: async (...args) => { received = args; localClient.authenticated = true; return 'new-bearer'; },
		getDeviceData: async () => [],
	};
	const bridge = { pin, port: 8443 };
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', null, bridge), true);
	assert.equal(received[3], pin);
	assert.equal(settings.localBearersByPin[pin], 'new-bearer');
	assert.equal(settings.localBearer, 'new-bearer');
	assert.equal(app.tahomaLocal, localClient);
	assert.equal(app.doesSessionMatchBridgePin(app.getSessionByEmail(username), pin), true);
});

test('a rejected local account is cooled down without generating more tokens', async () =>
{
	const { app } = createApp();
	let calls = 0;
	const localClient = {
		lastLocalTokenError: { statusCode: 403 },
		getLocalAuthCode: async () => { calls++; return null; },
	};
	const bridge = { pin, port: 8443 };
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', null, bridge), false);
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', null, bridge), false);
	assert.equal(calls, 1);
});

test('entering a replacement local token does not silently reuse the cached bearer', async () =>
{
	const { app } = createApp();
	app.localBearersByPin[pin] = 'old-bearer';
	let received;
	const localClient = {
		authenticated: false,
		getLocalAuthCode: async (...args) => { received = args; return 'new-bearer'; },
		getDeviceData: async () => [],
	};
	await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', 'new-bearer', { pin, port: 8443 });
	assert.equal(received[5], null);
	assert.equal(received[7].token, 'new-bearer');
});

test('an explicit replacement token is applied even when an existing local client is authenticated', async () =>
{
	const { app } = createApp();
	app.localAuthenticatedBridgePin = pin;
	let calls = 0;
	const localClient = {
		authenticated: true,
supportedDevices: [{ deviceURL: `io://${pin}/1` }],
		getLocalAuthCode: async () => { calls++; return 'new-bearer'; },
		getDeviceData: async () => [],
	};
	await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', 'new-bearer', { pin, port: 8443 });
	assert.equal(calls, 1);
	assert.equal(app.localBearer, 'new-bearer');
});

test('a rejected cached bearer is discarded so the next allowed attempt can generate a replacement', async () =>
{
	const { app, settings } = createApp({ localBearer: 'expired-token' });
	app.localBearer = 'expired-token';
	app.localBearersByPin[pin] = 'expired-token';
	const bearers = [];
	const localClient = {
		authenticated: false,
		lastLocalTokenError: { statusCode: 401 },
		getLocalAuthCode: async (...args) =>
		{
			bearers.push(args[5]);
			return bearers.length === 1 ? null : 'replacement';
		},
		getDeviceData: async () => [],
	};
	const bridge = { pin, port: 8443 };
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', null, bridge), false);
	assert.equal(app.localBearer, null);
	assert.equal(settings.localBearer, undefined);
	assert.equal(app.localBearersByPin[pin], undefined);
	delete app.localCredentialRetryAfter[app.getLocalAttemptKey(pin, username, 'europe')];
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', null, bridge), true);
	assert.deepEqual(bearers, ['expired-token', undefined]);
	assert.equal(settings.localBearer, 'replacement');
});

test('rejecting an explicitly supplied token does not erase the previously cached bearer', async () =>
{
	const { app, settings } = createApp({ localBearer: 'cached-token' });
	app.localBearer = 'cached-token';
	app.localBearersByPin[pin] = 'cached-token';
	const localClient = {
		authenticated: false,
		lastLocalTokenError: { statusCode: 401 },
		getLocalAuthCode: async () => null,
	};
	assert.equal(await app.doLocalLoginForClient(localClient, username, 'test-password', 'europe', 'invalid-replacement', { pin, port: 8443 }), false);
	assert.equal(app.localBearersByPin[pin], 'cached-token');
	assert.equal(settings.localBearer, 'cached-token');
});
