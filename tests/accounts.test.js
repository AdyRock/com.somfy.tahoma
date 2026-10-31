'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApp, device, plain } = require('./helpers/harness');

const first = 'first@example.test';
const second = 'second@example.test';
const pin = '1234-5678-9012';
const session = (username, extra = {}) => ({ username, password: 'test-password', region: 'europe', ...extra });

for (const [input, normalized, valid] of [
	[' USER@Example.test ', 'user@example.test', true],
	['a+b@example.test', 'a+b@example.test', true],
	['a@b', 'a@b', false], ['a b@example.test', 'a b@example.test', false],
	['a@@example.test', 'a@@example.test', false], ['', '', false], [null, '', false],
])
{
	test(`session identity normalization and validation: ${JSON.stringify(input)}`, () =>
	{
		const { app } = createApp();
		assert.equal(app.normalizeSessionEmail(input), normalized);
		assert.equal(app.isValidSessionEmail(input), valid);
	});
}

test('session storage rejects malformed containers and round-trips valid records', () =>
{
	const { app, settings } = createApp({ accountSessions: {} });
	assert.deepEqual(plain(app.getAccountSessions()), []);
	app.saveAccountSessions([session(first)]);
	assert.equal(settings.accountSessions.length, 1);
	assert.equal(app.getSessionByEmail(` ${first.toUpperCase()} `).username, first);
	assert.equal(app.getSessionByEmail(second), null);
	assert.equal(app.getSessionByEmail(''), null);
});

test('upserting a saved account preserves omitted credentials, tokens and valid gateway links', () =>
{
	const { app, settings } = createApp();
	const created = app.upsertAccountSession(session(first, { localToken: 'local-token' }));
	assert.ok(created.id);
	assert.ok(created.lastUsed > 0);
	created.bridgePins = [pin, 'invalid'];
	const updated = app.upsertAccountSession({ username: first.toUpperCase(), region: 'usa' });
	assert.equal(settings.accountSessions.length, 1);
	assert.equal(updated.id, created.id);
	assert.equal(updated.password, 'test-password');
	assert.equal(updated.localToken, 'local-token');
	assert.equal(updated.region, 'usa');
	assert.deepEqual(plain(updated.bridgePins), [pin]);
	assert.throws(() => app.upsertAccountSession({ username: 'invalid' }), /valid email/);
});

test('legacy migration is idempotent and list endpoints never expose saved secrets', () =>
{
	const { app } = createApp({ username: first, password: 'test-password' });
	app.migrateLegacyCredentialsToSessions();
	app.migrateLegacyCredentialsToSessions();
	assert.equal(app.getAccountSessions().length, 1);
	for (const entry of [...app.getPairingSessions(), ...app.getAccountSessionsForSettings()])
	{
		assert.equal(entry.username, first);
		assert.equal('password' in entry, false);
		assert.equal('localToken' in entry, false);
	}
	assert.equal(app.getAccountSessionsForSettings()[0].isPrimary, true);
	assert.equal(app.getAccountSessionDetails(first).password, 'test-password');
	assert.equal(app.getAccountSessionDetails(second).password, '');
	assert.equal(app.getAccountSessionDetails(second).isPrimary, false);
});

test('credential recovery chooses the newest usable account without overwriting an existing login', () =>
{
	const { app, settings } = createApp({
		accountSessions: [session(first, { lastUsed: 1 }), session(second, { lastUsed: 2 }), session('invalid', { lastUsed: 3 })],
	});
	assert.equal(app.ensureCredentialsFromSessions(), true);
	assert.equal(settings.username, second);
	assert.equal(settings.region, 'europe');
	assert.equal(app.ensureCredentialsFromSessions(), false);
	assert.equal(createApp().app.ensureCredentialsFromSessions(), false);
});

test('gateway links are validated, de-duplicated and learned from cloud device URLs', () =>
{
	const { app } = createApp({ accountSessions: [session(first)] });
	assert.equal(app.linkSessionToBridgePin(first, 'invalid'), false);
	assert.equal(app.linkSessionToBridgePin(second, pin), false);
	assert.equal(app.linkSessionToBridgePin(first, pin), true);
	assert.equal(app.linkSessionToBridgePin(first, pin), false);
	assert.equal(app.doesSessionMatchBridgePin(app.getSessionByEmail(first), pin), true);
	assert.equal(app.doesSessionMatchBridgePin(null, pin), false);
	assert.equal(app.linkSessionToBridgePinsFromDevices(first, [
		{ deviceURL: `io://${pin}/1` }, { deviceURL: 'rts://9876-5432-1098/2' }, null,
	]), 1);
	assert.deepEqual(plain(app.getSessionByEmail(first).bridgePins), [pin, '9876-5432-1098']);
	assert.equal(app.linkSessionToBridgePinsFromDevices(first, null), 0);
});

test('local credential candidates prioritize the owner and never cross a learned gateway boundary', () =>
{
	const { app } = createApp({
		username: first,
		password: 'test-password',
		accountSessions: [session(first, { bridgePins: ['9876-5432-1098'] }), session(second, { bridgePins: [pin], region: 'usa' })],
	});
	assert.deepEqual(plain(app.getCandidateCredentialsForLocalRouting(second)).map((item) => item.username), [second, first]);
	assert.deepEqual(plain(app.getCandidateCredentialsForLocalRouting(first, pin)).map((item) => item.username), [second]);
	assert.deepEqual(plain(app.getCandidateCredentialsForLocalRouting('', '1111-2222-3333')), []);
	assert.equal(app.getLocalAttemptKey(pin, ` ${first.toUpperCase()} `, 'usa'), `${pin}|${first}|usa`);
	assert.equal(app.getLocalAttemptKey('bad', first), '');
});

test('session usage detects paired devices and prevents accidental deletion', () =>
{
	const { app, runtimeDrivers } = createApp({ accountSessions: [session(first)] });
	runtimeDrivers.blinds = { getDevices: () => [device({ id: 'one', deviceURL: `io://${pin}/1` }, { sessionUsername: first.toUpperCase() })] };
	const usage = app.getSessionUsage(first);
	assert.equal(usage.inUse, true);
	assert.equal(usage.deviceCount, 1);
	assert.equal(usage.devices[0].driverId, 'blinds');
	assert.equal(app.removeAccountSession(first).inUse, true);
	assert.equal(app.getAccountSessions().length, 1);
	assert.equal(app.removeAccountSession(first, { force: true }).removed, true);
	assert.equal(app.removeAccountSession(first).notFound, true);
	assert.equal(app.getSessionUsage('invalid').inUse, false);
	assert.throws(() => app.removeAccountSession('invalid'), /valid email/);
});

test('unused secondary account cleanup does not clear the primary credentials', async () =>
{
	const { app, settings, runtimeDrivers } = createApp({
		username: first, password: 'test-password', accountSessions: [session(first), session(second)],
	});
	runtimeDrivers.blinds = { getDevices: () => [device({ id: 'one' }, { sessionUsername: first })] };
	assert.equal((await app.autoRemoveUnusedSession(first)).reason, 'still_used_by_devices');
	assert.equal((await app.autoRemoveUnusedSession(second)).autoRemoved, true);
	assert.equal(settings.username, first);
	assert.equal((await app.autoRemoveUnusedSession('invalid')).reason, 'invalid_username');
});

test('deleting the primary account promotes the newest usable remaining account', async () =>
{
	const { app, settings } = createApp({
		username: first,
password: 'test-password',
		accountSessions: [session(first), session(second, { lastUsed: 10 }), session('old@example.test', { lastUsed: 1 })],
	});
	const logins = [];
	app.newLogin_2 = async (username, password, region) =>
	{
		logins.push(username);
		settings.username = username;
		settings.password = password;
		settings.region = region;
		return true;
	};
	assert.equal((await app.deleteAccountSession(first, true)).removed, true);
	assert.deepEqual(logins, [second]);
	assert.equal(settings.username, second);
});

test('deleting the last primary logs out its client and clears the active session', async () =>
{
	const { app, settings } = createApp({ username: first, password: 'test-password', accountSessions: [session(first)] });
	let logouts = 0;
	const client = { authenticated: true, username: first, logout: async () => { logouts++; client.authenticated = false; } };
	app.tahomaCloud = client;
	app.tahomaCloudsBySession[first] = client;
	await app.deleteAccountSession(first, true);
	assert.equal(logouts, 1);
	assert.equal(app.isLoggedIn(), false);
	assert.equal(settings.username, undefined);
	assert.equal(settings.password, undefined);
});

test('primary promotion preserves replacement credentials when Somfy is temporarily unavailable', async () =>
{
	const { app, settings, logs } = createApp({
		username: first, password: 'test-password', accountSessions: [session(first), session(second)],
	});
	app.newLogin_2 = async () => { throw new Error('Temporary service outage'); };
	await app.deleteAccountSession(first, true);
	assert.equal(settings.username, second);
	assert.equal(settings.password, 'test-password');
	assert.equal(app.primaryCloudSessionUsername, second);
	assert.ok(logs.some(([source]) => source === 'deleteAccountSession promote next primary'));
});

test('a failed account rename preserves the original saved credentials', async () =>
{
	const { app } = createApp({ accountSessions: [session(first)] });
	app.ensureCloudSessionAuthenticated = async () => false;
	app.newLogin_2 = async () => false;
	await assert.rejects(app.saveAccountSession({ originalUsername: first, username: second, password: 'wrong-password' }), /Unable to authenticate/);
	assert.equal(app.getSessionByEmail(first).password, 'test-password');
	assert.equal(app.getSessionByEmail(second), null);
});

test('editing the current primary without originalUsername still updates its active credentials', async () =>
{
	const { app } = createApp({ username: first, password: 'old-password', accountSessions: [session(first)] });
	const logins = [];
	app.newLogin_2 = async (...args) => { logins.push(args); return true; };
	app.ensureCloudSessionAuthenticated = async () => { throw new Error('Should use primary login'); };
	await app.saveAccountSession({ username: first, password: 'new-password' });
	assert.equal(logins.length, 1);
	assert.equal(logins[0][1], 'new-password');
});

test('saving a secondary account authenticates it without switching the primary', async () =>
{
	const { app, settings } = createApp({ username: first, password: 'primary-password', accountSessions: [session(first)] });
	app.ensureCloudSessionAuthenticated = async () => true;
	const result = await app.saveAccountSession({ username: second, password: 'secondary-password', region: 'usa' });
	assert.equal(result.isPrimary, false);
	assert.equal(result.region, 'usa');
	assert.equal(settings.username, first);
	assert.equal(settings.password, 'primary-password');
	assert.equal(app.getSessionByEmail(second).password, 'secondary-password');
	await assert.rejects(app.saveAccountSession({ username: 'invalid', password: 'x' }), /valid email/);
	await assert.rejects(app.saveAccountSession({ username: second, password: '' }), /password/);
});

test('device cloud routing does not silently substitute the primary when the owner cannot authenticate', async () =>
{
	const { app } = createApp({ accountSessions: [session(second)] });
	const primary = { authenticated: true, username: first };
	const owner = { authenticated: false, username: second };
	app.tahomaCloud = primary;
	app.tahomaCloudsBySession[second] = owner;
	app.getDeviceSessionUsername = () => second;
	app.ensureCloudSessionAuthenticated = async () => false;
	assert.equal(await app.getCloudClientForDevice(`io://${pin}/1`), owner);
});

test('cloud client maps normalize identities and preserve the selected primary', () =>
{
	const { app } = createApp();
	const client = app.getCloudClientForSession(first.toUpperCase());
	assert.equal(app.getCloudClientForSession(first), client);
	app.setPrimaryCloudSession(first);
	assert.equal(app.tahomaCloud, client);
	assert.equal(app.primaryCloudSessionUsername, first);
	assert.equal(app.getCloudClientForSession(''), client);
	app.setPrimaryCloudSession('');
	assert.equal(app.tahomaCloud, client);
});

test('cloud polling sessions include legacy credentials only once and filter unusable accounts', () =>
{
	const { app } = createApp({
		username: first,
password: 'test-password',
		accountSessions: [session(second), session('invalid'), { username: 'empty@example.test' }],
	});
	assert.deepEqual(plain(app.getCloudPollingSessions()).map((item) => item.username), [first, second]);
	app.homey.settings.set('accountSessions', [session(first), session(second)]);
	assert.equal(app.getCloudPollingSessions().length, 2);
});
