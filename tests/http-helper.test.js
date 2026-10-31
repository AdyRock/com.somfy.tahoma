'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { load, plain } = require('./helpers/harness');

function create()
{
	let interceptor;
	let cookiesCleared = 0;
	const requests = [];
	const axios = {
		defaults: {},
		interceptors: { request: { use: (fn) => { interceptor = fn; } } },
	};
	for (const method of ['get', 'post', 'delete'])
	{
		axios[method] = async (...args) =>
		{
			requests.push([method, ...args]);
			return { data: { ok: true } };
		};
	}
	const HttpHelper = load('lib\\HttpHelper.js', {
		axios: { create: () => axios },
		'axios-cookiejar-support': { default: () => {} },
		'tough-cookie': { CookieJar: function CookieJar() { this.removeAllCookies = () => { cookiesCleared++; }; } },
	});
	const helper = new HttpHelper();
	return { helper, axios, requests, interceptor, cookiesCleared: () => cookiesCleared };
}

test('HTTP client uses isolated cookies, a bounded timeout, and no redirects', () =>
{
	const { helper, axios, interceptor } = create();
	assert.equal(axios.defaults.jar, helper.cookieJar);
	assert.equal(axios.defaults.withCredentials, true);
	assert.equal(axios.defaults.timeout, 20000);
	assert.equal(axios.defaults.maxRedirects, 0);
	const config = { headers: { Authorization: ' Bearer token\r\n' } };
	assert.equal(interceptor(config), config);
	assert.equal(config.headers.Authorization, 'Bearer token');
	assert.equal(interceptor(undefined), undefined);
});

for (const [region, host, local] of [
	['europe', 'ha101-1.overkiz.com'],
	['usa', 'ha401-1.overkiz.com'],
	['oceana', 'ha201-1.overkiz.com'],
	['unknown', 'ha101-1.overkiz.com'],
	['local', 'gateway-1234-5678-9012.local', true],
	['local2', '1234-5678-9012.local', true],
])
{
	test(`region ${region} selects the expected API host and path`, () =>
	{
		const { helper, axios } = create();
		assert.equal(helper.getHostName(region, '1234-5678-9012'), host);
		const expected = local
			? `https://${host}:8443/enduser-mobile-web/1/enduserAPI`
			: `https://${host}/enduser-mobile-web/enduserAPI`;
		assert.equal(helper.getBaseURL(region, '1234-5678-9012', 8443), expected);
		helper.setBaseURL(region, '1234-5678-9012', 8443);
		assert.equal(axios.defaults.baseURL, expected);
	});
}

for (const [input, expected] of [
	[null, null], [undefined, undefined], [42, '42'],
	[' \tBearer token\r\n\0\x7f ', 'Bearer token'],
	['application/json', 'application/json'],
])
{
	test(`header values are cleaned without changing their meaning (${JSON.stringify(input)})`, () =>
	{
		assert.equal(create().helper.sanitizeHeaderValue(input), expected);
	});
}

test('nested and multi-value headers are sanitized without mutating input', () =>
{
	const { helper, cookiesCleared, axios } = create();
	const input = { common: { Authorization: ' token\r\n' }, Accept: [' one\n', 'two\t'] };
	assert.deepEqual(plain(helper.sanitizeHeaders(input)), { common: { Authorization: 'token' }, Accept: ['one', 'two'] });
	assert.equal(input.common.Authorization, ' token\r\n');
	assert.equal(helper.sanitizeHeaders(null), null);
	helper.setDefaultHeaders(input, true);
	assert.equal(cookiesCleared(), 0);
	helper.setDefaultHeaders({ Authorization: 'new' }, false);
	assert.equal(cookiesCleared(), 1);
	assert.equal(axios.defaults.withCredentials, false);
	assert.deepEqual(plain(axios.defaults.headers), { Authorization: 'new' });
});

for (const issue of [
	{ code: 'ECONNRESET' }, { code: 'EPIPE' }, { code: 'ETIMEDOUT' }, { code: 'ECONNABORTED' },
	{ message: 'socket hang up' }, { message: 'timeout of 20000ms exceeded' },
	{ message: 'Request timeout' }, { message: 'Missing expected CR after response line' },
])
{
	test(`transient HTTP errors retry with bounded backoff: ${issue.code || issue.message}`, async () =>
	{
		const { helper } = create();
		const delays = [];
		helper.delay = async (ms) => delays.push(ms);
		let calls = 0;
		const result = await helper.requestWithRetry(async () =>
		{
			if (++calls < 3)
			{
				throw issue;
			}
			return { data: 'recovered' };
		});
		assert.equal(result, 'recovered');
		assert.equal(calls, 3);
		assert.equal(delays.length, 2);
		assert.ok(delays[0] >= 250 && delays[0] < 400);
		assert.ok(delays[1] >= 500 && delays[1] < 650);
	});
}

for (const status of [400, 401, 403, 404, 429, 500])
{
	test(`HTTP ${status} is surfaced without automatic network retries`, async () =>
	{
		const { helper } = create();
		const error = Object.assign(new Error(`HTTP ${status}`), { response: { status } });
		let calls = 0;
		await assert.rejects(helper.requestWithRetry(async () => { calls++; throw error; }), (err) => err === error);
		assert.equal(calls, 1);
	});
}

test('retry exhaustion reports the original network error after exactly four attempts', async () =>
{
	const { helper } = create();
	const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
	helper.delay = async () => {};
	let calls = 0;
	await assert.rejects(helper.requestWithRetry(async () => { calls++; throw error; }), (err) => err === error);
	assert.equal(calls, 4);
	assert.equal(helper.isTransientNetworkError(null), false);
	assert.equal(helper.isTransientNetworkError(new Error('bad input')), false);
	assert.ok(helper.getRetryDelayMs(100) >= 3000 && helper.getRetryDelayMs(100) < 3150);
});

test('the HTTP retry delay yields asynchronously before continuing', async () =>
{
	const { helper } = create();
	let complete = false;
	const pending = helper.delay(0).then(() => { complete = true; });
	assert.equal(complete, false);
	await pending;
	assert.equal(complete, true);
});

for (const method of ['get', 'post', 'delete'])
{
	test(`HTTP ${method} preserves URL, options and payload and unwraps response data`, async () =>
	{
		const { helper, requests } = create();
		const options = { headers: { Test: 'value' } };
		const data = { value: 1 };
		assert.deepEqual(await helper[method]('/test', options, data), { ok: true });
		assert.deepEqual(requests[0], method === 'post' ? [method, '/test', data, options] : [method, '/test', options]);
	});
}
