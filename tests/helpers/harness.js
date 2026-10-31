/* eslint-disable max-classes-per-file */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..', '..');
const requireFromRoot = createRequire(path.join(root, 'app.js'));

class HomeyStub
{
	log(...args) { this.messages = [...(this.messages || []), args]; }

	error(...args) { this.errors = [...(this.errors || []), args]; }
}

class HttpStub
{
	constructor()
	{
		this.calls = [];
		this.headers = {};
	}

	setBaseURL(...args) { this.baseURL = args; }

	setDefaultHeaders(headers, cookies) { this.headers = headers; this.cookies = cookies; }

	async get(...args) { this.calls.push(['get', ...args]); return this.response; }

	async post(...args) { this.calls.push(['post', ...args]); return this.response; }

	async delete(...args) { this.calls.push(['delete', ...args]); return this.response; }
}

const homeyModule = {
	App: HomeyStub,
	Device: HomeyStub,
	Driver: HomeyStub,
	SimpleClass: HomeyStub,
	env: { SOMFY_OAUTH_URL: 'https://accounts.example.test/token' },
	manifest: { id: 'com.somfy.tahoma', version: 'test' },
};

function load(relativePath, overrides = {})
{
	const filename = path.resolve(root, relativePath);
	const module = { exports: {} };
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
		module,
		__dirname: path.dirname(filename),
		process: { env: {}, nextTick: process.nextTick },
		Buffer,
		URL,
		Error,
		Date,
		setTimeout,
		clearTimeout,
		require: (name) =>
		{
			if (Object.prototype.hasOwnProperty.call(overrides, name))
			{
				return overrides[name];
			}
			if (name === 'homey')
			{
				return homeyModule;
			}
			if (name === './HttpHelper')
			{
				return HttpStub;
			}
			if (name === './lib/Tahoma')
			{
				return load('lib\\Tahoma.js');
			}
			return requireFromRoot(name);
		},
	}, { filename });
	return module.exports;
}

function plain(value)
{
	return JSON.parse(JSON.stringify(value));
}

function createHomey(initialSettings = {})
{
	const settings = { ...initialSettings };
	const writes = [];
	const timers = [];
	const logs = [];
	const runtimeDrivers = {};
	const homey = {
		settings: {
			get: (key) => (settings[key] === undefined ? null : settings[key]),
			set: (key, value) =>
			{
				settings[key] = value;
				writes.push([key, value]);
			},
			unset: (key) => { delete settings[key]; },
		},
		drivers: { getDrivers: () => runtimeDrivers },
		cloud: { getHomeyId: async () => 'test-homey' },
		setTimeout: (callback, delay) =>
		{
			const timer = { callback, delay };
			timers.push(timer);
			return timer;
		},
		clearTimeout: (timer) => { if (timer) timer.cleared = true; },
		log: (...args) => logs.push(args),
		error: (...args) => logs.push(args),
	};
	return { homey, settings, writes, timers, logs, runtimeDrivers };
}

function createApp(initialSettings)
{
	const App = load('app.js');
	const app = new App();
	const context = createHomey(initialSettings);
	app.homey = context.homey;
	app.homey.app = app;
	app.logInformation = (...args) => context.logs.push(args);
	app.tahomaCloud = { authenticated: false };
	app.tahomaCloudsBySession = {};
	app.cloudSessionAuthInFlight = {};
	app.cloudSessionRetryAfter = {};
	app.cloudLastSyncBySession = {};
	app.localCredentialRetryAfter = {};
	app.localMdnsLookup = {};
	app.localBridges = [];
	app.localBearersByPin = {};
	app.syncing = false;
	app.commandsQueued = 0;
	app.boostTimerId = null;
	app.currentConnectivityWarning = null;
	return { app, ...context };
}

function createTahoma(local = false, initialSettings)
{
	const Tahoma = load('lib\\Tahoma.js');
	const context = createHomey(initialSettings);
	const client = new Tahoma(context.homey, false);
	client.localLogin = local;
	context.homey.app = { logInformation: (...args) => context.logs.push(args) };
	return { client, ...context };
}

function device(data, settings = {})
{
	return {
		getData: () => data,
		getSettings: () => settings,
		getName: () => data.label || 'Test device',
	};
}

module.exports = { load, plain, createHomey, createApp, createTahoma, device };
