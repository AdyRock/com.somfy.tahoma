/* eslint-disable no-nested-ternary */
/* eslint-disable max-len */
/* jslint node: true */

'use strict';

if (process.env.DEBUG === '1')
{
	// eslint-disable-next-line node/no-unsupported-features/node-builtins, global-require
	require('inspector').open(9223, '0.0.0.0', true);
}

const Homey = require('homey');
const nodemailer = require('nodemailer');
const fs = require('fs/promises');
const path = require('path');
const net = require('net');
const Tahoma = require('./lib/Tahoma');

const LOCAL_INTERVAL = 3;
const CLOUD_INTERVAL = 30;
class myApp extends Homey.App
{

	/**
	 * Initializes the app
	 */
	async onInit()
	{
		this.log(`${Homey.manifest.id} running...`);
		this.homeyApi = null;

		this.localOnly = false; // set to true to prevent the cloud polling and only use local bridge if possible

		this.syncing = false;
		this.syncTimerId = null;
		this.loginTimerId = null;
		this.initSyncInFlight = null;
		this.boostTimerId = null;
		this.unBoostTimerID = null;
		this.unBoosting = false;
		this.commandsQueued = 0;
		this.lastSync = 0;
		this._logoutInProgress = null;
		this.lastLogTime = new Date(Date.now());
		this.deviceHttp400Tracker = {};
		this.deviceStateLogSignatures = {};

		this.localBridgeInfo = this.homey.settings.get('localBridge');
		this.localBearer = this.homey.settings.get('localBearer');
		this.tahomaLocalsByPin = {};
		this.localBridges = this.homey.settings.get('localBridges');
		if (!Array.isArray(this.localBridges))
		{
			this.localBridges = [];
		}

		this.localMdnsLookup = this.homey.settings.get('localMdnsLookup');
		if (!this.localMdnsLookup || (typeof this.localMdnsLookup !== 'object') || Array.isArray(this.localMdnsLookup))
		{
			this.localMdnsLookup = {};
		}

		for (const bridge of this.localBridges)
		{
			this.upsertLocalMdnsLookup(bridge, false);
		}

		this.localBearersByPin = this.homey.settings.get('localBearersByPin');
		if (!this.localBearersByPin || (typeof this.localBearersByPin !== 'object'))
		{
			this.localBearersByPin = {};
		}
		this.localCredentialRetryAfter = {};
		this.localPollingNoPinMatchLogged = false;
		this.tahomaCloudsBySession = {};
		this.cloudSessionRetryAfter = {};
		this.cloudSessionAuthInFlight = {};
		this.cloudLastSyncBySession = {};
		this.primaryCloudSessionUsername = '';
		this.forceImmediateCloudSync = false;
		this.currentConnectivityWarning = null;

		if (this.localBridgeInfo && this.localBridgeInfo.pin && this.localBearer)
		{
			this.localBearersByPin[this.localBridgeInfo.pin] = this.localBearer;
		}
		this.localAuthenticatedBridgePin = this.normalizeBridgePin(this.localBridgeInfo ? this.localBridgeInfo.pin : '');
		this.usingDebugData = false;

		if (process.env.DEBUG === '1')
		{
			this.homey.settings.set('debugMode', true);
			const simData = this.homey.settings.get('simData');
			if (simData)
			{
				this.usingDebugData = true;
			}
		}
		else
		{
			this.homey.settings.set('debugMode', false);
		}

		this.syncLoop = this.syncLoop.bind(this);
		this.homey.settings.unset('errorLog'); // Clean out obsolete entry
		this.homey.settings.unset('diagLog');
		this.homey.settings.unset('logEnabled');

		this.homey.settings.set('deviceLog', '');
		this.homey.settings.set('infoLog', '');
		this.homey.settings.set('statusLogEnabled', false);
		this.homey.settings.set('statusLog', '');

		this.homeyHash = await this.homey.cloud.getHomeyId();
		this.homeyHash = this.hashCode(this.homeyHash).toString();

		this.infoLogEnabled = this.homey.settings.get('infoLogEnabled');
		if (this.infoLogEnabled === null)
		{
			this.infoLogEnabled = false;
			this.homey.settings.set('infoLogEnabled', this.infoLogEnabled);
		}

		this.eventLogEnabled = this.homey.settings.get('eventLogEnabled');
		if (this.eventLogEnabled === null)
		{
			this.eventLogEnabled = false;
			this.homey.settings.set('eventLogEnabled', this.eventLogEnabled);
		}

		this.migrateLegacyCredentialsToSessions();
		this.ensureCredentialsFromSessions();

		this.homey.on('unload', async () =>
		{
			await this.logOut(false).catch((error) =>
			{
				this.error('unload logOut failed', error && error.message ? error.message : error);
			});
		});

		this.homey.settings.on('set', (setting) =>
		{
			if (setting === 'infoLogEnabled')
			{
				this.infoLogEnabled = this.homey.settings.get('infoLogEnabled');
			}
			else if (setting === 'eventLogEnabled')
			{
				this.eventLogEnabled = this.homey.settings.get('eventLogEnabled');
			}
			else if (setting === 'simData')
			{
				const simData = this.homey.settings.get('simData');
				if (simData)
				{
					this.usingDebugData = true;
				}
				else
				{
					this.usingDebugData = false;
				}

					this.syncEvents(null).catch((error) =>
					{
						this.logInformation('settings simData syncEvents', error.message ? error.message : error);
					});
			}
		});

		try
		{
			this.homeyIP = await this.homey.cloud.getLocalAddress();
			if (this.homeyIP)
			{
				this.tahomaLocal = new Tahoma(this.homey, true);
				if (this.localBridgeInfo && this.localBridgeInfo.pin)
				{
					this.tahomaLocalsByPin[this.normalizeBridgePin(this.localBridgeInfo.pin)] = this.tahomaLocal;
				}
			}
		}
		catch (err)
		{
			// Homey cloud or Bridge so no LAN access
			this.tahomaLocal = null;
			this.homeyIP = null;

			// Enable logging for Homey cloud
			this.infoLogEnabled = true;
		}

		this.tahomaCloud = new Tahoma(this.homey, false);
		const initialCloudUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		if (initialCloudUsername)
		{
			this.tahomaCloudsBySession[initialCloudUsername] = this.tahomaCloud;
			this.tahomaCloud.sessionUsername = initialCloudUsername;
			this.primaryCloudSessionUsername = initialCloudUsername;
		}

		// Setup the flow listeners
		this.addScenarioActionListeners();
		this.addPollingSpeedActionListeners();
		this.addPollingActionListeners();

		/** * TEMPERATURE CONDITIONS ** */
		this._conditionTemperatureMoreThan = this.homey.flow.getConditionCard('has_temperature_more_than');
		this._conditionTemperatureMoreThan.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_temperature > args.temperature;
			return Promise.resolve(conditionMet);
		});

		this._conditionTemperatureLessThan = this.homey.flow.getConditionCard('has_temperature_less_than');
		this._conditionTemperatureLessThan.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_temperature < args.temperature;
			return Promise.resolve(conditionMet);
		});

		this._conditionTemperatureBetween = this.homey.flow.getConditionCard('has_temperature_between');
		this._conditionTemperatureBetween.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_temperature > args.temperature_from && device.getState().measure_temperature < args.temperature_to;
			return Promise.resolve(conditionMet);
		});

		/** * LUMINANCE CONDITIONS ** */
		this._conditionLuminanceMoreThan = this.homey.flow.getConditionCard('has_luminance_more_than');
		this._conditionLuminanceMoreThan.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_luminance > args.luminance;
			return Promise.resolve(conditionMet);
		});

		this._conditionLuminanceLessThan = this.homey.flow.getConditionCard('has_luminance_less_than');
		this._conditionLuminanceLessThan.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_luminance < args.luminance;
			return Promise.resolve(conditionMet);
		});

		this._conditionLuminanceBetween = this.homey.flow.getConditionCard('has_luminance_between');
		this._conditionLuminanceBetween.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = device.getState().measure_luminance > args.luminance_from && device.getState().measure_luminance < args.luminance_to;
			return Promise.resolve(conditionMet);
		});

		/** * IS MOVING CONDITION ** */
		this._conditionIsMoving = this.homey.flow.getConditionCard('is_moving');
		this._conditionIsMoving.registerRunListener((args) =>
		{
			const { device } = args;
			const conditionMet = (device.executionId !== null);
			return Promise.resolve(conditionMet);
		});

		/** * COMMAND COMPLETE TRIGGER ** */
		this.commandCompleteTrigger = this.homey.flow.getTriggerCard('command_complete');
		this.commandCompleteTrigger
			.registerRunListener(async (args, state) =>
			{
				return (args.device.getAppId() === state.device.appId);
			});

		this.registerActionFlowCards();

		// On Homey Pro start syncing sooner; keep cloud stagger to avoid synchronized bursts.
		const randomDelay = this.homeyIP ? 0 : Math.floor(Math.random() * 120000);
		const initialSyncDelay = this.homeyIP ? 15000 : 30000;
		this.syncTimerId = this.homey.setTimeout(() => this.initSync(), initialSyncDelay + randomDelay);

		this.discoveryStrategy = this.homey.discovery.getStrategy('somfy_tahoma');
		this.discoveryStrategy.on('result', (discoveryResult) =>
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('mDNS: Got mDNS result', this.varToString(discoveryResult));
			}
			this.mDNSBridgesUpdate(discoveryResult);
		});

		const results = this.discoveryStrategy.getDiscoveryResults();
		for (const result of Object.values(results))
		{
			this.log('Got mDNS result:', this.varToString(result));
			this.mDNSBridgesUpdate(result);
		}

		this.log(`${Homey.manifest.id} Initialised`);

		this.discoveryStrategy.on('addressChanged', (discoveryResult) =>
		{
			this.logInformation(`Got mDNS address changed:${this.varToString(discoveryResult)}`);
			this.mDNSBridgesUpdate(discoveryResult);
		});
	}

	async mDNSBridgesUpdate(discoveryResult)
	{
		if (!discoveryResult.txt)
		{
			this.logInformation('mDNS', 'No txt field in discovery');
			return;
		}

		this.localBridgeInfo = {
			pin: discoveryResult.txt.gateway_pin,
			address: discoveryResult.address,
			url: discoveryResult.fullname,
			port: discoveryResult.port,
			api_version: discoveryResult.txt.api_version,
			fw_version: discoveryResult.txt.fw_version,
		};
		this.upsertDiscoveredLocalBridge(this.localBridgeInfo);
		this.upsertLocalMdnsLookup(this.localBridgeInfo);
		if (!this.localBridgeInfo.pin)
		{
			this.logInformation('mDNS', 'No local pin discovered');
			return;
		}

		if (this.syncTimerId)
		{
			this.homey.clearTimeout(this.syncTimerId);
			this.syncTimerId = null;
		}

		this.homey.settings.set('localBridge', this.localBridgeInfo);
		this.logInformation('mDNS Found a local bridge',
			{
				pin: '####-####-####',
				address: this.localBridgeInfo.address,
				port: this.localBridgeInfo.port,
				api_version: this.localBridgeInfo.api_version,
				fw_version: this.localBridgeInfo.fw_version,
			});

		const username = this.homey.settings.get('username');
		const password = this.homey.settings.get('password');
		let region = this.homey.settings.get('region');
		if ((!username || !password) && (typeof this.ensureCredentialsFromSessions === 'function'))
		{
			this.ensureCredentialsFromSessions();
		}

		const retryUsername = this.homey.settings.get('username');
		const retryPassword = this.homey.settings.get('password');
		const effectiveUsername = retryUsername || username;
		const effectivePassword = retryPassword || password;
		region = this.homey.settings.get('region') || region;
		if (!region && effectiveUsername && effectivePassword)
		{
			region = 'europe';
			this.homey.settings.set('region', region);
		}

		const bridgeCandidates = this.getCandidateCredentialsForLocalRouting(effectiveUsername, this.localBridgeInfo.pin);
		for (const candidate of bridgeCandidates)
		{
			try
			{
				if (await this.doLocalLogin(candidate.username, candidate.password, candidate.region))
				{
					this.localOnly = true;

					// Start sync in 5 seconds
					this.syncTimerId = this.homey.setTimeout(() => this.startSync(), 5000);
					return;
				}
			}
			catch (err)
			{
				this.logInformation('Local login failed', err.message);
			}
		}

		// Retry sync sooner on Homey Pro when no local PIN-matched login is available.
		if (this.homeyIP)
		{
			// On Homey Pro, trigger cloud sync on the first loop after fallback startSync.
			this.forceImmediateCloudSync = true;
		}

		const mdnsFallbackDelay = this.homeyIP ? 15000 : 60000;
		this.syncTimerId = this.homey.setTimeout(() => this.startSync(), mdnsFallbackDelay);
	}

	async doLocalLoginForClient(localClient, username, password, region, localToken, bridgeInfo, persistCredentials = true, quiet = false, setAsActive = true)
	{
		if (!localClient)
		{
			return false;
		}

		const bridgePin = this.normalizeBridgePin(bridgeInfo ? bridgeInfo.pin : '');
		const currentAuthenticatedBridgePin = this.normalizeBridgePin(this.localAuthenticatedBridgePin || '');
		const attemptKey = this.getLocalAttemptKey(bridgePin, username, region);
		const now = Date.now();

		if (attemptKey && this.localCredentialRetryAfter[attemptKey] && (this.localCredentialRetryAfter[attemptKey] > now))
		{
			return false;
		}

		if (bridgePin && localClient.authenticated && ((currentAuthenticatedBridgePin === bridgePin) || !setAsActive) && Array.isArray(localClient.supportedDevices) && (localClient.supportedDevices.length > 0))
		{
			return true;
		}

		if (username && password && bridgeInfo)
		{
			if (this.infoLogEnabled && !quiet)
			{
				this.logInformation('Doing local login');
			}

			let newToken = null;
			if (localToken)
			{
				if (!quiet)
				{
					this.logInformation('Using provided local token');
				}
				newToken = { token: localToken };
			}

			const bearerForBridge = (this.localBearersByPin && bridgeInfo.pin) ? this.localBearersByPin[bridgeInfo.pin] : this.localBearer;
			const localBearer = await localClient.getLocalAuthCode(username, password, region, bridgeInfo.pin, bridgeInfo.port, bearerForBridge, await this.homey.cloud.getHomeyId(), newToken);
			if (!localBearer)
			{
				const statusCode = localClient.lastLocalTokenError && localClient.lastLocalTokenError.statusCode;
				if (attemptKey && [400, 401, 403].includes(statusCode))
				{
					// The bridge rejected this account; avoid hammering token generation for a while.
					this.localCredentialRetryAfter[attemptKey] = Date.now() + (5 * 60 * 1000);
				}
				return false;
			}

			if (!this.localBearersByPin || (typeof this.localBearersByPin !== 'object'))
			{
				this.localBearersByPin = {};
			}

			if (bridgeInfo && bridgeInfo.pin)
			{
				this.localBearersByPin[bridgeInfo.pin] = localBearer;
				this.homey.settings.set('localBearersByPin', this.localBearersByPin);
			}

			if (attemptKey && this.localCredentialRetryAfter[attemptKey])
			{
				delete this.localCredentialRetryAfter[attemptKey];
			}

			if (setAsActive)
			{
				this.localBearer = localBearer;
			}
			else
			{
				this.localBearer = this.localBearer || localBearer;
			}
		}
		else
		{
			if (bridgeInfo)
			{
				this.logInformation('Local login', 'Missing credentials');
			}
			else
			{
				this.logInformation('Local login', 'No local bridge detected yet');
			}
			return false;
		}

		if (setAsActive ? !!this.localBearer : !!(this.localBearersByPin && this.localBearersByPin[bridgePin]))
		{
			if (bridgeInfo && bridgeInfo.pin && setAsActive)
			{
				this.localAuthenticatedBridgePin = this.normalizeBridgePin(bridgeInfo.pin);
			}

			if (setAsActive)
			{
				this.tahomaLocal = localClient;
			}

			// Login was successful
			if (persistCredentials)
			{
				this.homey.settings.set('username', username);
				this.homey.settings.set('password', password);
				this.homey.settings.set('region', region);
				this.homey.settings.set('localToken', localToken);
				this.homey.settings.set('localBearer', this.localBearer);
			}

			try
			{
				if (this.infoLogEnabled && !quiet)
				{
					this.logInformation('Local login: Getting local API version');
					const apiVer = await localClient.getLocalAPIVersion();
					this.logInformation('Local login Successful', apiVer);
				}
				await localClient.getDeviceData();
			}
			catch (error)
			{
				if (error.message)
				{
					this.logInformation('Local login: getDevices', `Error: ${error.message}`);
					if (error.message.indexOf('ECONNREFUSED ') !== -1)
					{
						if (persistCredentials)
						{
							this.homey.settings.unset('localBearer');
						}
						this.localBearer = null;
						localClient.authenticated = false;
						if (bridgePin && (this.localAuthenticatedBridgePin === bridgePin))
						{
							this.localAuthenticatedBridgePin = '';
						}
						if (bridgeInfo && bridgeInfo.pin && this.localBearersByPin)
						{
							delete this.localBearersByPin[bridgeInfo.pin];
							this.homey.settings.set('localBearersByPin', this.localBearersByPin);
						}
					}
				}
				else
				{
					this.logInformation('Local login', error);
				}

				return false;
			}

			if (bridgeInfo && bridgeInfo.pin)
			{
				if (persistCredentials)
				{
					this.upsertAccountSession({ username, password, region });
				}
				this.linkSessionToBridgePin(username, bridgeInfo.pin);
			}

			return true;
		}

		this.logInformation('No local Bearer token');
		return false;
	}

	getLocalAttemptKey(bridgePin, username, region)
	{
		const pin = this.normalizeBridgePin(bridgePin || '');
		const normalizedUsername = this.normalizeSessionEmail(username);
		if (!pin || !normalizedUsername)
		{
			return '';
		}

		return `${pin}|${normalizedUsername}|${region || 'europe'}`;
	}

	async doLocalLogin(username, password, region, localToken, bridgeOverride = null, persistCredentials = true, quiet = false)
	{
		const bridgeInfo = bridgeOverride || this.localBridgeInfo;
		const localClient = this.getLocalClientForBridge(bridgeInfo);
		return this.doLocalLoginForClient(localClient, username, password, region, localToken, bridgeInfo, persistCredentials, quiet, true);
	}

	async getLocalTokens()
	{
		if (!this.localBridgeInfo)
		{
			throw new Error('No Somfy bridges have been detected.\n'
				+ 'Make sure the Developer mode has been enabled on you Somfy account.\n'
				+ 'The Somfy bridge should broadcast it\'s IP and PIN via mDNS once the option is enabled.');
		}
		try
		{
			if (this.tahomaCloud.authenticated === false)
			{
				await this.initSync();
			}
			const tokens = await this.tahomaCloud.getLocalTokens(this.localBridgeInfo.pin);
			return this.varToString(tokens);
		}
		catch (err)
		{
			this.logInformation('getLocalTokens failed', err.message);
			throw (err);
		}
	}

	async deleteLocalToken(uuid)
	{
		try
		{
			const tokens = await this.tahomaCloud.deleteLocalToken(this.localBridgeInfo.pin, uuid);
			return this.varToString(tokens);
		}
		catch (err)
		{
			this.logInformation('getLocalTokens failed', err.message);
			throw (err);
		}
	}

	async onUninit()
	{
		// Log out but don't clear the credentials
		try
		{
			await this.logOut(false);
		}
		catch (error)
		{
			this.error('onUninit logOut failed', error && error.message ? error.message : error);
		}
	}

	registerActionFlowCards()
	{
		this.homey.flow.getActionCard('absence_heating_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('absence_heating_temperature_set');
				await args.device.onCapabilityTargetTemperatureEco(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.absence_cooling', args.target_temperature);
			});

		this.homey.flow.getActionCard('cancel_absence_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('cancel_absence_set');
				await args.device.onCapabilityBoilerMode(args.state, null);
			});

		this.homey.flow.getActionCard('set_auto_heat_cool')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_auto_heat_cool');
				await args.device.onCapabilityBoostState(args.state, null);
				return args.device.setCapabilityValue('heating_cooling_auto_switch', args.state);
			});

		this.homey.flow.getActionCard('set_pac_operating_mode')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_pac_operating_mode');
				await args.device.onCapabilityBoostState(args.state, null);
				return args.device.setCapabilityValue('pass_apc_operating_mode', args.state);
			});

		this.homey.flow.getActionCard('eco_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('eco_temperature_set');
				await args.device.onCapabilityTargetTemperatureEco(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.eco', args.target_temperature);
			});

		this.homey.flow.getActionCard('comfort_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('comfort_temperature_set');
				await args.device.onCapabilityTargetTemperatureComfort(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.comfort', args.target_temperature);
			});

		this.homey.flow.getActionCard('boiler_mode_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('boiler_mode_set');
				await args.device.onCapabilityBoilerMode(args.state, null);
				return args.device.setCapabilityValue('boiler_mode', args.state);
			});

		this.homey.flow.getActionCard('boost_on_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('boost_on_off');
				await args.device.onCapabilityBoostState(args.state, null);
				return args.device.setCapabilityValue('boost', args.state);
			});

		this.homey.flow.getActionCard('calendar_state_on')
			.registerRunListener(async (args, state) =>
			{
				this.log('calendar_state_on');
				return args.device.triggerCapabilityListener('calendar_state_on', true, null);
			});

		this.homey.flow.getActionCard('calendar_state_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('calendar_state_off');
				return args.device.triggerCapabilityListener('calendar_state_off', true, null);
			});

		this.homey.flow.getActionCard('windowcoverings_tilt')
			.registerRunListener(async (args, state) =>
			{
				this.log('windowcoverings_tilt');
				return args.device.onCapabilityWindowcoveringsTiltSet(args.windowcoverings_set, null);
			});

		this.homey.flow.getActionCard('set_my_position')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_my_position');
				return args.device.onCapabilityMyPosition(true, null);
			});

		this.homey.flow.getActionCard('set_my_heat_level')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_my_heat_level');
				return args.device.triggerCapabilityListener('my_heat_level', true, null);
			});

		this.homey.flow.getActionCard('set_heat_level')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_heat_level');
				return args.device.triggerCapabilityListener('heat_level', args.heat_level, null);
			});

		this.homey.flow.getActionCard('set_on')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_on');
				return args.device.triggerCapabilityListener('on_button', true, null);
			});

		this.homey.flow.getActionCard('set_on_timer')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_on_timer');
				return args.device.triggerCapabilityListener('on_with_timer', args.duration, null);
			});

		this.homey.flow.getActionCard('set_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_off');
				return args.device.triggerCapabilityListener('off_button', true, null);
			});

		this.homey.flow.getActionCard('set_open_window_activation')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_open_window_activation');
				return args.device.triggerCapabilityListener('open_window_activation', args.open_window_activation === 'on', null);
			});

		this.homey.flow.getActionCard('set_valve_auto_mode')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_valve_auto_mode');
				return args.device.triggerCapabilityListener('valve_auto_mode', args.set_valve_auto === 'on', null);
			});

		this.homey.flow.getActionCard('set_derogation_mode')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_derogation_mode');
				await args.device.setCapabilityValue('derogation_type', args.type);
				return args.device.triggerCapabilityListener('derogation_mode', args.derogation_mode, null);
			});

		this.homey.flow.getActionCard('set_open_close_stop')
			.registerRunListener(async (args, state) =>
			{
				this.log('open_close_stop');
				return args.device.sendOpenCloseStop(args.state, null);
			});

		this.homey.flow.getActionCard('start_siren')
			.registerRunListener(async (args, state) =>
			{
				this.log('start_siren');
				return args.device.triggerCapabilityListener('ring_button', null);
			});

		this.homey.flow.getActionCard('sound_alarm1')
			.registerRunListener(async (args, state) =>
			{
				this.log('sound_alarm1');
				const parameters = [args.duration * 1000, args.on_off_ratio, args.repeats - 1, args.volume];
				return args.device.triggerCapabilityListener('soundAlarm_1_button', null, parameters);
			});

		this.homey.flow.getActionCard('stop_siren')
			.registerRunListener(async (args, state) =>
			{
				this.log('stop_siren');
				return args.device.triggerCapabilityListener('stop_button', null);
			});

		this.homey.flow.getActionCard('trigger_tahoma_alarm')
			.registerRunListener(async (args, state) =>
			{
				this.log('trigger_tahoma_alarm');
				return args.device.triggerAlarmAction(args.state);
			});

		this.homey.flow.getActionCard('set_on_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_on_off');
				return args.device.sendOnOff(args.state === 'on', null);
			});

		this.homey.flow.getActionCard('set_on_with_timer')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_on_with_timer');
				return args.device.sendOnWithTimer(args.onTime, null);
			});

		this.homey.flow.getActionCard('eco_cooling_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('eco_cooling_temperature_set');
				await args.device.onCapabilityTargetTemperatureEcoCooling(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.eco_cooling', args.target_temperature);
			});

		this.homey.flow.getActionCard('eco_heating_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('eco_heating_temperature_set');
				await args.device.onCapabilityTargetTemperatureEcoHeating(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.eco_heating', args.target_temperature);
			});

		this.homey.flow.getActionCard('comfort_cooling_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('comfort_cooling_temperature_set');
				await args.device.onCapabilityTargetTemperatureComfortCooling(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.comfort_cooling', args.target_temperature);
			});

		this.homey.flow.getActionCard('comfort_heating_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('comfort_heating_temperature_set');
				await args.device.onCapabilityTargetTemperatureComfortHeating(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.comfort_heating', args.target_temperature);
			});

		this.homey.flow.getActionCard('derogation_temperature_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('derogation_temperature_set');
				await args.device.onCapabilityTargetTemperatureDerogated(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.derogated', args.target_temperature);
			});

		this.homey.flow.getActionCard('cooling_on_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('cooling_on_off');
				await args.device.onCapabilityOnOffCooling(args.state, null);
				return args.device.setCapabilityValue('boost.cooling', args.state === 'on');
			});

		this.homey.flow.getActionCard('heating_on_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('heating_on_off');
				await args.device.onCapabilityOnOffHeating(args.state, null);
				return args.device.setCapabilityValue('boost.heating', args.state === 'on');
			});

		this.homey.flow.getActionCard('derogation_on_off')
			.registerRunListener(async (args, state) =>
			{
				this.log('derogation_on_off');
				await args.device.onCapabilityOnOffDerogated(args.state, null);
				return args.device.setCapabilityValue('boost.derogated', args.state === 'on');
			});

		this.homey.flow.getActionCard('cool_mode_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('cool_mode_set');
				await args.device.onCapabilityHeatCoolModeCool(args.state, null);
				return args.device.setCapabilityValue('heat_cool_mode.cool', args.state);
			});

		this.homey.flow.getActionCard('heat_mode_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('heat_mode_set');
				await args.device.onCapabilityHeatCoolModeHeat(args.state, null);
				return args.device.setCapabilityValue('heat_cool_mode.heat', args.state);
			});

		this.homey.flow.getActionCard('set_heating_mode')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_heating_mode');
				await args.device.onCapabilityHeatingModeState(args.state, null);
				return args.device.setCapabilityValue('heating_mode', args.state);
			});

		this.homey.flow.getActionCard('set_heating_level2_state')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_heating_level2_state');
				return args.device.triggerCapabilityListener('heating_level2_state', args.state);
			});

		this.homey.flow.getActionCard('windowcoverings_upper_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('windowcoverings_set.upper');
				return args.device.triggerCapabilityListener('windowcoverings_set.upper', args.windowcoverings_set);
			});

		this.homey.flow.getActionCard('windowcoverings_lower_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('windowcoverings_set.lower');
				return args.device.triggerCapabilityListener('windowcoverings_set.lower', args.windowcoverings_set);
			});

		this.homey.flow.getActionCard('set_pedestrian')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_open');
				return args.device.triggerCapabilityListener('pedestrian');
			});

		this.homey.flow.getActionCard('set_open')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_open');
				return args.device.triggerCapabilityListener('open_button');
			});

		this.homey.flow.getActionCard('set_close')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_open');
				return args.device.triggerCapabilityListener('close_button');
			});

		this.homey.flow.getActionCard('target_temperature_manual_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_manual_set');
				return args.device.triggerCapabilityListener('target_temperature.manual', args.target_temperature, { derogation_type: args.derogation_type });
			});

		this.homey.flow.getActionCard('target_temperature_manual_set_for')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_manual_set_for');

				const duration = (args.days * 86400) + (args.hours * 3600) + (args.minutes * 60);
				return args.device.triggerCapabilityListener('target_temperature.manual', args.target_temperature, { derogation_type: duration });
			});

		this.homey.flow.getActionCard('target_temperature_comfort_heating_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_comfort_heating_set');
				return args.device.triggerCapabilityListener('target_temperature.comfort_heating', args.target_temperature);
			});

		this.homey.flow.getActionCard('target_temperature_eco_heating_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_eco_heating_set');
				return args.device.triggerCapabilityListener('target_temperature.eco_heating', args.target_temperature);
			});

		this.homey.flow.getActionCard('target_temperature_away_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_away_set');
				return args.device.triggerCapabilityListener('target_temperature.away', args.target_temperature);
			});

		this.homey.flow.getActionCard('target_temperature_frost_protection_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_frost_protection_set');
				return args.device.triggerCapabilityListener('target_temperature.frost_protection', args.target_temperature);
			});

		this.homey.flow.getActionCard('set_zone')
			.registerRunListener(async (args, state) =>
			{
				this.log('set_zone');
				const promises = [];
				if (args.zone_button_a === '1')
				{
					promises.push(args.device.triggerCapabilityListener('zone_button.a', true, null));
				}

				if (args.zone_button_b === '1')
				{
					promises.push(args.device.triggerCapabilityListener('zone_button.b', true, null));
				}

				if (args.zone_button_c === '1')
				{
					promises.push(args.device.triggerCapabilityListener('zone_button.c', true, null));
				}

				return Promise.all(promises);
			});

		this.homey.flow.getActionCard('nudge_windowcoverings_tilt')
			.registerRunListener(async (args, state) =>
			{
				this.log('nudge_windowcoverings_tilt');
				if (args.direction === 'down')
				{
					return args.device.triggerCapabilityListener('windowcoverings_tilt_down');
				}
				return args.device.triggerCapabilityListener('windowcoverings_tilt_up');
			});

		this.homey.flow.getActionCard('set_quiet_mode')
			.registerRunListener(async (args, state) =>
			{
				this.log(`set_quiet_mode ${args.quiet_mode}`);
				return args.device.triggerCapabilityListener('quiet_mode', args.quiet_mode);
			});

		this.homey.flow.getActionCard('wait_for_action_to_finish')
			.registerRunListener(async (args, state) =>
			{
				this.log(`wait_for_action_to_finish ${args.timeout}`);
				return args.device.waitForActionToFinish(args.timeout);
			});

		this.homey.flow.getActionCard('target_temperature_cooling_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_cooling_set');
				await args.device.onCapabilityTargetTemperatureCooling(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.cooling', args.target_temperature);
			});

		this.homey.flow.getActionCard('target_temperature_heating_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('target_temperature_heating_set');
				await args.device.onCapabilityTargetTemperatureHeating(args.target_temperature, null);
				return args.device.setCapabilityValue('target_temperature.heating', args.target_temperature);
			});

		this.homey.flow.getActionCard('ac_louver_position_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('ac_louver_position_set');
				await args.device.onCapabilityLouverPosition(args.louver_position, null);
				return args.device.setCapabilityValue('ac_louver_position', args.louver_position);
			});

		this.homey.flow.getActionCard('ac_control_mode_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('ac_control_mode_set');
				await args.device.onCapabilityControlMode(args.control_mode, null);
				return args.device.setCapabilityValue('ac_control_mode', args.control_mode);
			});

		this.homey.flow.getActionCard('ac_thermostat_mode_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('ac_thermostat_mode_set');
				await args.device.onCapabilityThermostateMode(args.thermostat_mode, null);
				return args.device.setCapabilityValue('ac_thermostat_mode', args.thermostat_mode);
			});

		this.homey.flow.getActionCard('ac_fan_speed_set')
			.registerRunListener(async (args, state) =>
			{
				this.log('ac_fan_speed_set');
				await args.device.onCapabilityFanSpeed(args.fan_speed, null);
				return args.device.setCapabilityValue('ac_fan_speed_mode', args.fan_speed);
			});
	}

	hashCode(s)
	{
		let h = 0;
		for (let i = 0; i < s.length; i++)
		{
			h = Math.imul(31, h) + s.charCodeAt(i) | 0;
		}
		return h;
	}

	isTransientSyncError(error)
	{
		if (!error)
		{
			return false;
		}

		const message = String(error.message || '').toLowerCase();
		const code = String(error.code || '').toUpperCase();

		if (message.indexOf('timeout of') >= 0 && message.indexOf('exceeded') >= 0)
		{
			return true;
		}

		if (message.indexOf('request timeout') >= 0)
		{
			return true;
		}

		if (message.indexOf('missing expected cr after response line') >= 0)
		{
			return true;
		}

		if (message.indexOf('invalid header value char') >= 0)
		{
			return true;
		}

		return (
			code === 'ECONNABORTED'
			|| code === 'ETIMEDOUT'
			|| code === 'ECONNRESET'
			|| message.indexOf('socket hang up') >= 0
		);
	}

	isHttpStatus(error, statusCode)
	{
		if (!error)
		{
			return false;
		}

		if (error.response && error.response.status === statusCode)
		{
			return true;
		}

		return String(error.message || '') === `Request failed with status code ${statusCode}`;
	}

	getCommand400TrackerKey(deviceURL, local)
	{
		return `${local ? 'local' : 'cloud'}:${deviceURL || ''}`;
	}

	recordCommand400(deviceURL, local)
	{
		const key = this.getCommand400TrackerKey(deviceURL, local);
		const now = Date.now();
		const windowMs = 300000;

		if (!this.deviceHttp400Tracker || (typeof this.deviceHttp400Tracker !== 'object'))
		{
			this.deviceHttp400Tracker = {};
		}

		const current = this.deviceHttp400Tracker[key] || { count: 0, firstAt: now, lastAt: now };
		if ((now - current.lastAt) > windowMs)
		{
			current.count = 0;
			current.firstAt = now;
		}

		current.count += 1;
		current.lastAt = now;
		this.deviceHttp400Tracker[key] = current;

		return current.count;
	}

	clearCommand400(deviceURL, local)
	{
		const key = this.getCommand400TrackerKey(deviceURL, local);
		if (this.deviceHttp400Tracker && this.deviceHttp400Tracker[key])
		{
			delete this.deviceHttp400Tracker[key];
		}
	}

	async attemptCommand400Recovery(label, local)
	{
		const connectionType = local ? 'Local' : 'Cloud';
		const tahomaConnection = local ? this.tahomaLocal : this.tahomaCloud;

		if (!tahomaConnection)
		{
			return false;
		}

		try
		{
			if (!tahomaConnection.authenticated)
			{
				await this.initSync();
				return !!tahomaConnection.authenticated;
			}

			await tahomaConnection.getEvents();
			return true;
		}
		catch (error)
		{
			this.logInformation(`${label}: ${connectionType} command 400 recovery failed`, error.message ? error.message : error);
			if (!tahomaConnection.authenticated)
			{
				try
				{
					await this.initSync();
					return !!tahomaConnection.authenticated;
				}
				catch (initError)
				{
					this.logInformation(`${label}: ${connectionType} command 400 re-auth failed`, initError.message ? initError.message : initError);
				}
			}
		}

		return false;
	}

	getCloudClientForSession(username)
	{
		const normalizedUsername = this.normalizeSessionEmail(username);
		if (!normalizedUsername)
		{
			return this.tahomaCloud;
		}

		if (!this.tahomaCloudsBySession || (typeof this.tahomaCloudsBySession !== 'object'))
		{
			this.tahomaCloudsBySession = {};
		}

		if (!this.tahomaCloudsBySession[normalizedUsername])
		{
			this.tahomaCloudsBySession[normalizedUsername] = new Tahoma(this.homey, false);
		}

		this.tahomaCloudsBySession[normalizedUsername].sessionUsername = normalizedUsername;

		return this.tahomaCloudsBySession[normalizedUsername];
	}

	// Resolves the cloud client that actually owns a given device, so commands/state reads
	// always target the account the device was paired with, not whichever account is
	// currently the "active" primary session (which pairing can temporarily switch).
	async getCloudClientForDevice(deviceURL)
	{
		const sessionUsername = this.getDeviceSessionUsername(deviceURL);
		const currentPrimaryUsername = this.normalizeSessionEmail(this.tahomaCloud && this.tahomaCloud.username ? this.tahomaCloud.username : '');
		if (!sessionUsername || (sessionUsername === currentPrimaryUsername))
		{
			return this.tahomaCloud;
		}

		const session = this.getSessionByEmail(sessionUsername);
		if (!session || !session.password)
		{
			return this.tahomaCloud;
		}

		const client = this.getCloudClientForSession(sessionUsername);
		if (!client.authenticated)
		{
			try
			{
				await this.ensureCloudSessionAuthenticated(session.username, session.password, session.region || 'europe', false, 'device-session-routing');
			}
			catch (error)
			{
				this.logInformation('getCloudClientForDevice', error.message ? error.message : error);
			}
		}

		return client.authenticated ? client : this.tahomaCloud;
	}

	setPrimaryCloudSession(username)
	{
		const normalizedUsername = this.normalizeSessionEmail(username);
		if (!normalizedUsername)
		{
			return;
		}

		this.primaryCloudSessionUsername = normalizedUsername;
		this.tahomaCloud = this.getCloudClientForSession(normalizedUsername);
	}

	// Restores the app's configured primary account (as shown in the app Settings page) as the
	// active cloud session. Used after a pairing wizard, which may have temporarily switched the
	// active/"primary" session to a different account to list that account's devices.
	async restorePrimaryCloudSession(username, password, region)
	{
		const normalizedUsername = this.normalizeSessionEmail(username);
		if (!normalizedUsername || !password)
		{
			return;
		}

		const currentUsername = this.normalizeSessionEmail(this.tahomaCloud && this.tahomaCloud.username ? this.tahomaCloud.username : '');
		const currentSettingsUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		if ((currentUsername === normalizedUsername) && (currentSettingsUsername === normalizedUsername))
		{
			// Already pointing at the primary account, nothing to restore.
			return;
		}

		// Pairing's login handler persists whichever account it authenticated as the app's
		// single configured account; restore the original primary account credentials here.
		this.homey.settings.set('username', normalizedUsername);
		this.homey.settings.set('password', password);
		this.homey.settings.set('region', region || 'europe');

		this.setPrimaryCloudSession(normalizedUsername);

		try
		{
			await this.ensureCloudSessionAuthenticated(normalizedUsername, password, region || 'europe', false, 'restore-primary-after-pairing');
		}
		catch (error)
		{
			this.logInformation('restorePrimaryCloudSession', error.message ? error.message : error);
		}
	}

	getCloudPollingSessions()
	{
		const sessions = this.getAccountSessions()
			.filter((session) => session && this.isValidSessionEmail(session.username) && session.password)
			.map((session) => ({
				username: this.normalizeSessionEmail(session.username),
				password: session.password,
				region: session.region || 'europe',
			}));

		const currentUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		const currentPassword = this.homey.settings.get('password');
		const currentRegion = this.homey.settings.get('region') || 'europe';
		if (currentUsername && currentPassword && !sessions.find((session) => session.username === currentUsername))
		{
			sessions.unshift({
				username: currentUsername,
				password: currentPassword,
				region: currentRegion,
			});
		}

		return sessions;
	}

	async loginCloudClient(cloudClient, username, password, region, loginReason = 'session-auth')
	{
		let loginMethod = true;
		try
		{
			await cloudClient.login(username, password, region, loginMethod, this.homeyIP, false, '', loginReason);
		}
		catch (error)
		{
			if (error.message)
			{
				this.logInformation('Login OAuth', `Error: ${error.message}`);
			}
			else
			{
				this.logInformation('Login OAuth', error);
			}

			loginMethod = !loginMethod;
		}

		if (!cloudClient.authenticated)
		{
			try
			{
				await cloudClient.login(username, password, region, loginMethod, this.homeyIP, false, '', `${loginReason}:fallback`);
			}
			catch (error)
			{
				if (error.message)
				{
					this.logInformation('Login OAuth 2', `Error: ${error.message}`);
				}
				else
				{
					this.logInformation('Login OAuth 2', error);
				}
			}
		}

		return cloudClient.authenticated;
	}

	async ensureCloudSessionAuthenticated(username, password, region, forceLogin = false, loginReason = 'session-auth')
	{
		const normalizedUsername = this.normalizeSessionEmail(username);
		if (!normalizedUsername || !password)
		{
			return false;
		}

		if (!this.cloudSessionAuthInFlight || (typeof this.cloudSessionAuthInFlight !== 'object'))
		{
			this.cloudSessionAuthInFlight = {};
		}

		const inFlightAuth = this.cloudSessionAuthInFlight[normalizedUsername];
		if (inFlightAuth)
		{
			if (!forceLogin)
			{
				return inFlightAuth;
			}

			try
			{
				await inFlightAuth;
			}
			catch (error)
			{
				// Ignore previous in-flight failure and continue with forced login.
			}
		}

		const authPromise = (async () =>
		{
			const cloudClient = this.getCloudClientForSession(normalizedUsername);
			const clientUsername = this.normalizeSessionEmail(cloudClient.username);
			const shouldRelogin = forceLogin || !cloudClient.authenticated || (clientUsername && (clientUsername !== normalizedUsername));
			if (!shouldRelogin)
			{
				return true;
			}

			const retryAfter = this.cloudSessionRetryAfter[normalizedUsername] || 0;
			if (!forceLogin && (retryAfter > Date.now()))
			{
				return false;
			}

			try
			{
				await cloudClient.logout();
			}
			catch (error)
			{
				this.logInformation('Cloud logout before relogin', error.message ? error.message : error);
			}

			// Keep a small gap between logout and login to avoid auth race conditions.
			await new Promise((resolve) => this.homey.setTimeout(resolve, 1000));

			const effectiveReason = forceLogin ? `${loginReason}:forced` : loginReason;
			const authenticated = await this.loginCloudClient(cloudClient, normalizedUsername, password, region || 'europe', effectiveReason);
			if (!authenticated)
			{
				this.cloudSessionRetryAfter[normalizedUsername] = Date.now() + 60000;
				return false;
			}

			delete this.cloudSessionRetryAfter[normalizedUsername];
			return true;
		})();

		this.cloudSessionAuthInFlight[normalizedUsername] = authPromise;
		try
		{
			return await authPromise;
		}
		finally
		{
			if (this.cloudSessionAuthInFlight[normalizedUsername] === authPromise)
			{
				delete this.cloudSessionAuthInFlight[normalizedUsername];
			}
		}
	}

	async syncAllCloudSessions()
	{
		const sessions = this.getCloudPollingSessions();
		if (!Array.isArray(sessions) || (sessions.length === 0))
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('Cloud syncLoop', 'No cloud sessions available for polling');
			}
			return CLOUD_INTERVAL * 1000;
		}

		let nextInterval = CLOUD_INTERVAL * 1000;
		for (const session of sessions)
		{
			const authenticated = await this.ensureCloudSessionAuthenticated(session.username, session.password, session.region, false, 'sync-loop');
			if (!authenticated)
			{
				continue;
			}

			const cloudClient = this.getCloudClientForSession(session.username);
			nextInterval = await this.syncWorker(cloudClient);
		}

		return nextInterval;
	}

	// Throws an exception if the login fails
	async newLogin(args)
	{
		const authenticated = await this.newLogin_2(args.username, args.password, args.region, args.localToken, true);
		if (!authenticated)
		{
			throw new Error('Unable to authenticate with Somfy cloud or the local bridge');
		}

		return true;
	}

	// Throws an exception if the login fails
	async newLogin_2(username, password, region, localToken, forceLogin = false)
	{
		region = region || 'europe';
		const normalizedRequestedUsername = this.normalizeSessionEmail(username);
		const normalizedCurrentCloudUsername = this.normalizeSessionEmail(this.tahomaCloud && this.tahomaCloud.username ? this.tahomaCloud.username : '');
		const normalizedCurrentLocalUsername = this.normalizeSessionEmail(this.tahomaLocal && this.tahomaLocal.username ? this.tahomaLocal.username : '');
		const switchCloudAccount = !!(normalizedRequestedUsername && normalizedCurrentCloudUsername && (normalizedRequestedUsername !== normalizedCurrentCloudUsername));
		const switchLocalAccount = !!(normalizedRequestedUsername && normalizedCurrentLocalUsername && (normalizedRequestedUsername !== normalizedCurrentLocalUsername));
		const needsCloudLogin = !!(this.tahomaCloud && (!this.tahomaCloud.authenticated || forceLogin || switchCloudAccount));
		let cloudAuthenticated = !needsCloudLogin && this.tahomaCloud ? this.tahomaCloud.authenticated : false;

		// Stop the timer so periodic updates don't happen while changing login
		if (this.loginTimerId)
		{
			this.homey.clearTimeout(this.loginTimerId);
			this.loginTimerId = null;
		}

		// Need to do cloud login
		if (needsCloudLogin)
		{
			if (switchCloudAccount && this.infoLogEnabled)
			{
				this.logInformation('newLogin_2', `Switching cloud account from ${normalizedCurrentCloudUsername} to ${normalizedRequestedUsername}`);
			}

			await this.stopSync('cloud');

			cloudAuthenticated = await this.ensureCloudSessionAuthenticated(username, password, region, true, 'new-login');
			if (cloudAuthenticated)
			{
				this.setPrimaryCloudSession(username);

				// All good so save the credentials
				this.homey.settings.set('username', username);
				this.homey.settings.set('password', password);
				this.homey.settings.set('region', region);

				const setupInfo = await this.tahomaCloud.getSetupOID();
				this.somfySetupOID = setupInfo.result;
			}
		}

		const hasProvidedLocalToken = !!(localToken && `${localToken}`.trim());
		if ((hasProvidedLocalToken || !forceLogin || !needsCloudLogin || cloudAuthenticated) && this.localBridgeInfo && this.localBridgeInfo.pin && this.tahomaLocal && (!this.tahomaLocal.authenticated || forceLogin || switchLocalAccount))
		{
			const bridgeCandidates = this.getCandidateCredentialsForLocalRouting(username, this.localBridgeInfo.pin);
			if (hasProvidedLocalToken || (bridgeCandidates.length > 0))
			{
				try
				{
					await this.stopSync('local');

					// Need to get a local bearer token
					await this.doLocalLogin(username, password, region, localToken);
				}
				catch (error)
				{
					if (error.message)
					{
						this.logInformation('Login doLocal', `Error: ${error.message}`);
					}
					else
					{
						this.logInformation('Login doLocal', error);
					}
				}
			}
		}

		// Start the sync process
		this.startSync();
		if (needsCloudLogin)
		{
			return cloudAuthenticated || (this.tahomaLocal && this.tahomaLocal.authenticated);
		}

		if (this.localOnly)
		{
			return !!(this.tahomaLocal && this.tahomaLocal.authenticated);
		}

		return this.tahomaCloud.authenticated;
	}

	async logOut(ClearCredentials = true)
	{
		if (this._logoutInProgress)
		{
			await this._logoutInProgress;
			if (ClearCredentials)
			{
				this.homey.settings.unset('username');
				this.homey.settings.unset('password');
			}
			return true;
		}

		this._logoutInProgress = (async () =>
		{
			if (this.unBoostTimerID)
			{
				this.homey.clearTimeout(this.unBoostTimerID);
				this.unBoostTimerID = null;
			}

			let maxLoops = 50;
			while (this.unBoosting && (maxLoops-- > 0))
			{
				await this.asyncDelay(1000);
			}

			if (this.tahomaCloud)
			{
				await this.stopSync('cloud');

				const cloudClients = new Set();
				cloudClients.add(this.tahomaCloud);
				if (this.tahomaCloudsBySession && (typeof this.tahomaCloudsBySession === 'object'))
				{
					for (const cloudClient of Object.values(this.tahomaCloudsBySession))
					{
						if (cloudClient)
						{
							cloudClients.add(cloudClient);
						}
					}
				}

				for (const cloudClient of cloudClients)
				{
					await cloudClient.logout();
				}
			}
		})();

		try
		{
			await this._logoutInProgress;
		}
		finally
		{
			this._logoutInProgress = null;
		}

		if (ClearCredentials)
		{
			this.homey.settings.unset('username');
			this.homey.settings.unset('password');
		}

		return true;
	}

	async logDevices()
	{
		if (this.infoLogEnabled)
		{
			this.logInformation('logDevices', 'Fetching devices');
		}

		const devices = {
			sessions: [],
			local: {
				ip: this.localBridgeInfo ? this.localBridgeInfo.address : null,
				devices: [],
			},
		};

		const buildDiscoveryStatus = (discovery) =>
		{
			if (!discovery || (typeof discovery !== 'object'))
			{
				return null;
			}

			return {
				setupOID: discovery.setupOID || '',
				accountSetupCount: discovery.accountSetupCount || 0,
				attemptedSetupOIDCount: Array.isArray(discovery.attemptedSetupOIDs) ? discovery.attemptedSetupOIDs.length : 0,
				crossSetupAttemptCount: discovery.crossSetupAttemptCount || 0,
				crossSetupSuccessCount: discovery.crossSetupSuccessCount || 0,
				crossSetupErrorCount: discovery.crossSetupErrorCount || 0,
				totalGatewayCount: discovery.totalGatewayCount || 0,
				totalDeviceCount: discovery.totalDeviceCount || 0,
				deviceEndpointHitCount: Array.isArray(discovery.deviceEndpointHits) ? discovery.deviceEndpointHits.length : 0,
				gatewayEndpointHitCount: Array.isArray(discovery.gatewayEndpointHits) ? discovery.gatewayEndpointHits.length : 0,
			};
		};
		let cloudFetches = 0;

		const cloudSessions = this.getCloudPollingSessions();
		if ((!Array.isArray(cloudSessions) || (cloudSessions.length === 0)) && this.tahomaCloud && !this.tahomaCloud.authenticated)
		{
			// Keep legacy behavior when no account session list exists yet.
			await this.initSync();
		}

		if (Array.isArray(cloudSessions) && (cloudSessions.length > 0))
		{
			for (const session of cloudSessions)
			{
				const sessionLog = {
					login: session.username,
					devices: {
						cloud: {
							devices: [],
						},
					},
				};

				try
				{
					const authenticated = await this.ensureCloudSessionAuthenticated(session.username, session.password, session.region, false, 'log-devices');
					if (!authenticated)
					{
						devices.sessions.push(sessionLog);
						continue;
					}

					const cloudClient = this.getCloudClientForSession(session.username);
					const sessionDevices = await cloudClient.getDeviceData();
					if (Array.isArray(sessionDevices))
					{
						sessionLog.devices.cloud.devices = sessionDevices;
						if (cloudClient.lastSetupDiscovery)
						{
							sessionLog.devices.cloud.discovery = cloudClient.lastSetupDiscovery;
							sessionLog.devices.cloud.discoveryStatus = buildDiscoveryStatus(cloudClient.lastSetupDiscovery);
							if (this.infoLogEnabled)
							{
								this.logInformation('logDevices', `Cloud setup discovery for ${session.username}: ${cloudClient.lastSetupDiscovery.totalDeviceCount} devices across ${cloudClient.lastSetupDiscovery.totalGatewayCount} gateway(s) (${cloudClient.lastSetupDiscovery.fetchedDeviceCount} fetched from dedicated device endpoint, ${cloudClient.lastSetupDiscovery.embeddedDeviceCount} from embedded setup)`);
								this.logInformation('logDevices multi-setup status', {
									scope: 'cloud',
									session: session.username,
									status: sessionLog.devices.cloud.discoveryStatus,
									crossSetupAttempts: cloudClient.lastSetupDiscovery.crossSetupAttempts || [],
								});
							}
						}
						cloudFetches++;
					}
				}
				catch (error)
				{
					this.logInformation('logDevices', error);
				}

				devices.sessions.push(sessionLog);
			}
		}
		else if (this.tahomaCloud && this.tahomaCloud.authenticated)
		{
			try
			{
				const singleCloudDevices = await this.tahomaCloud.getDeviceData();
				const singleLogin = this.normalizeSessionEmail(this.tahomaCloud.username || this.homey.settings.get('username') || '');
				const singleSessionLog = {
					login: singleLogin,
					devices: {
						cloud: {
							devices: Array.isArray(singleCloudDevices) ? singleCloudDevices : [],
						},
					},
				};
				if (this.tahomaCloud.lastSetupDiscovery)
				{
					singleSessionLog.devices.cloud.discovery = this.tahomaCloud.lastSetupDiscovery;
					singleSessionLog.devices.cloud.discoveryStatus = buildDiscoveryStatus(this.tahomaCloud.lastSetupDiscovery);
					if (this.infoLogEnabled)
					{
						this.logInformation('logDevices', `Cloud setup discovery for ${singleLogin}: ${this.tahomaCloud.lastSetupDiscovery.totalDeviceCount} devices across ${this.tahomaCloud.lastSetupDiscovery.totalGatewayCount} gateway(s) (${this.tahomaCloud.lastSetupDiscovery.fetchedDeviceCount} fetched from dedicated device endpoint, ${this.tahomaCloud.lastSetupDiscovery.embeddedDeviceCount} from embedded setup)`);
						this.logInformation('logDevices multi-setup status', {
							scope: 'cloud',
							session: singleLogin,
							status: singleSessionLog.devices.cloud.discoveryStatus,
							crossSetupAttempts: this.tahomaCloud.lastSetupDiscovery.crossSetupAttempts || [],
						});
					}
				}
				devices.sessions.push(singleSessionLog);

				if (Array.isArray(singleCloudDevices))
				{
					cloudFetches = 1;
				}
			}
			catch (error)
			{
				this.logInformation('logDevices', error);
			}
		}

		if (this.tahomaLocal && this.tahomaLocal.authenticated)
		{
			try
			{
				const localDevices = await this.tahomaLocal.getDeviceData();
				if (Array.isArray(localDevices))
				{
					devices.local.devices = localDevices;
				}

				if (this.tahomaLocal.lastSetupDiscovery)
				{
					devices.local.discovery = this.tahomaLocal.lastSetupDiscovery;
					devices.local.discoveryStatus = buildDiscoveryStatus(this.tahomaLocal.lastSetupDiscovery);
					if (this.infoLogEnabled)
					{
						this.logInformation('logDevices', `Local setup discovery: ${this.tahomaLocal.lastSetupDiscovery.totalDeviceCount} devices across ${this.tahomaLocal.lastSetupDiscovery.totalGatewayCount} gateway(s) (${this.tahomaLocal.lastSetupDiscovery.fetchedDeviceCount} fetched from dedicated device endpoint, ${this.tahomaLocal.lastSetupDiscovery.embeddedDeviceCount} from embedded setup)`);
						this.logInformation('logDevices multi-setup status', {
							scope: 'local',
							status: devices.local.discoveryStatus,
							crossSetupAttempts: this.tahomaLocal.lastSetupDiscovery.crossSetupAttempts || [],
						});
					}
				}
			}
			catch (error)
			{
				this.logInformation('logDevices', error);
			}
		}

		// Do a deep copy
		const logData = JSON.parse(JSON.stringify(devices));

		if (Array.isArray(logData.sessions))
		{
			const localByLogin = {};
			if (Array.isArray(logData.local.devices))
			{
				for (const localDevice of logData.local.devices)
				{
					const login = this.normalizeSessionEmail(this.getDeviceSessionUsername(localDevice.deviceURL));
					if (!login)
					{
						continue;
					}

					if (!localByLogin[login])
					{
						localByLogin[login] = [];
					}

					localByLogin[login].push(localDevice);
				}
			}

			for (const sessionLog of logData.sessions)
			{
				if (!sessionLog || !sessionLog.login || !sessionLog.devices)
				{
					continue;
				}

				const sessionLocalDevices = localByLogin[this.normalizeSessionEmail(sessionLog.login)] || [];
				sessionLog.devices.local = {
					ip: logData.local.ip,
					devices: sessionLocalDevices,
				};
			}
		}

		if (this.infoLogEnabled)
		{
			const cloudCount = Array.isArray(logData.sessions)
				? logData.sessions.reduce((count, sessionLog) => count + ((sessionLog && sessionLog.devices && sessionLog.devices.cloud && Array.isArray(sessionLog.devices.cloud.devices)) ? sessionLog.devices.cloud.devices.length : 0), 0)
				: 0;
			const localCount = Array.isArray(logData.local.devices) ? logData.local.devices.length : 0;
			this.logInformation('logDevices', `Log contains ${cloudCount + localCount} devices (${cloudCount} cloud from ${cloudFetches} session(s), ${localCount} local)`);
		}

		if (this.homey.settings.get('debugMode'))
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('logDevices', 'Debug Mode');
			}
		}
		else
		{
			// Remove personal device information
			if (Array.isArray(logData.local.devices))
			{
				logData.local.devices.forEach((element) =>
				{
					delete element.creationTime;
					delete element.lastUpdateTime;
					delete element.shortcut;
					delete element.placeOID;
				});
			}

			if (Array.isArray(logData.sessions))
			{
				logData.sessions.forEach((sessionLog) =>
				{
					if (sessionLog && sessionLog.devices && sessionLog.devices.cloud && Array.isArray(sessionLog.devices.cloud.devices))
					{
						sessionLog.devices.cloud.devices.forEach((element) =>
						{
							delete element.creationTime;
							delete element.lastUpdateTime;
							delete element.shortcut;
							delete element.placeOID;
						});
					}
				});
			}
		}

		this.homey.settings.set('deviceLog',
			{
				devices: logData,
			});
	}

	async getDriverSupportMatrix()
	{
		const hasConnectedSession = this.hasActiveDriverSupportSession();
		const [drivers, somfyDevices] = await Promise.all([
			this.getDriverDefinitions(),
			this.getSomfyDevicesForDriverSupport(),
		]);

		const driversByControllableName = {};
		for (const driver of drivers)
		{
			for (const controllableName of driver.supportedControllableNames)
			{
				const controllableNameKey = String(controllableName || '').toLowerCase();
				if (!controllableNameKey)
				{
					continue;
				}

				if (!driversByControllableName[controllableNameKey])
				{
					driversByControllableName[controllableNameKey] = [];
				}

				driversByControllableName[controllableNameKey].push(driver);
			}
		}

		const controllableMap = {};
		const recommendations = [];
		for (const device of somfyDevices)
		{
			const controllableName = (device && device.controllableName) ? String(device.controllableName) : '';
			const controllableNameKey = controllableName.toLowerCase();
			if (!controllableName)
			{
				continue;
			}

			if (!controllableMap[controllableName])
			{
				const mappedDrivers = driversByControllableName[controllableNameKey] || [];
				controllableMap[controllableName] = {
					controllableName,
					deviceCount: 0,
					devices: [],
					drivers: mappedDrivers.map((driver) => ({
						driverId: driver.driverId,
						driverName: driver.driverName,
					})),
				};
			}

			controllableMap[controllableName].deviceCount += 1;
			controllableMap[controllableName].devices.push(
				{
					label: device.label || '',
					oid: device.oid || '',
					deviceURL: device.deviceURL || '',
					source: device.source || '',
					session: device.session || '',
					commands: Array.isArray(device.commands) ? device.commands : [],
					states: Array.isArray(device.states) ? device.states : [],
				},
			);

			const candidateDrivers = driversByControllableName[controllableNameKey] || [];
			const scoredCandidates = candidateDrivers
				.map((driver) =>
				{
					const scoreResult = this.scoreDriverForSomfyDevice(driver, device);
					return {
						driverId: driver.driverId,
						driverName: driver.driverName,
						driverIcon: driver.driverIcon || '',
						score: scoreResult.score,
						matchedCapabilities: scoreResult.matchedCapabilities,
						unmatchedCapabilities: scoreResult.unmatchedCapabilities,
						compatibilityRatio: scoreResult.compatibilityRatio,
					};
				})
				.sort((a, b) =>
				{
					if (b.score !== a.score)
					{
						return b.score - a.score;
					}

					if (b.compatibilityRatio !== a.compatibilityRatio)
					{
						return b.compatibilityRatio - a.compatibilityRatio;
					}

					if (a.unmatchedCapabilities.length !== b.unmatchedCapabilities.length)
					{
						return a.unmatchedCapabilities.length - b.unmatchedCapabilities.length;
					}

					return a.driverName.localeCompare(b.driverName);
				});

			const best = scoredCandidates.length > 0 ? scoredCandidates[0] : null;
			recommendations.push(
				{
					label: device.label || '',
					oid: device.oid || '',
					deviceURL: device.deviceURL || '',
					controllableName,
					source: device.source || '',
					session: device.session || '',
					commands: Array.isArray(device.commands) ? device.commands : [],
					states: Array.isArray(device.states) ? device.states : [],
					somfyDevice: device.somfyDevice || {},
					recommendedDriverId: best ? best.driverId : '',
					recommendedDriverName: best ? best.driverName : '',
					recommendedDriverIcon: best ? best.driverIcon : '',
					candidates: scoredCandidates,
				},
			);
		}

		const controllableNames = Object.values(controllableMap)
			.sort((a, b) => a.controllableName.localeCompare(b.controllableName));

		const matchedDriverIds = new Set();
		for (const entry of controllableNames)
		{
			for (const driver of entry.drivers)
			{
				matchedDriverIds.add(driver.driverId);
			}
		}

		const driverList = drivers
			.filter((driver) => matchedDriverIds.has(driver.driverId))
			.map((driver) =>
			{
				const getControllableEntry = (name) => controllableMap[name] || controllableMap[String(name || '').toLowerCase()] || null;
				const matchedControllableNames = driver.supportedControllableNames
					.filter((controllableName) => !!getControllableEntry(controllableName));

				const matchedDeviceCount = matchedControllableNames
					.reduce((count, controllableName) =>
					{
						const entry = getControllableEntry(controllableName);
						return count + (entry ? entry.deviceCount : 0);
					}, 0);

				return {
					driverId: driver.driverId,
					driverName: driver.driverName,
					supportedControllableNames: driver.supportedControllableNames,
					matchedControllableNames,
					matchedDeviceCount,
				};
			})
			.sort((a, b) => a.driverName.localeCompare(b.driverName));

		const installedKeysByDriverId = {};

		const addInstalledKey = (driverShortId, key) =>
		{
			if (!driverShortId || !key)
			{
				return;
			}

			if (!installedKeysByDriverId[driverShortId])
			{
				installedKeysByDriverId[driverShortId] = new Set();
			}

			installedKeysByDriverId[driverShortId].add(key);
		};

		const addInstalledDeviceEntry = (driverShortId, existing, dataOverride = null) =>
		{
			if (!driverShortId || !existing)
			{
				return;
			}

			const data = dataOverride || existing.data || {};
			if (data.deviceURL)
			{
				addInstalledKey(driverShortId, `url:${data.deviceURL}`);
			}

			const candidateIds = [data.id, data.oid, existing.id];
			for (const candidateId of candidateIds)
			{
				if (candidateId)
				{
					addInstalledKey(driverShortId, `id:${candidateId}`);
				}
			}
		};

		const runtimeDrivers = this.homey.drivers && (typeof this.homey.drivers.getDrivers === 'function')
			? this.homey.drivers.getDrivers()
			: {};
		for (const [driverKey, runtimeDriver] of Object.entries(runtimeDrivers || {}))
		{
			if (!runtimeDriver || (typeof runtimeDriver.getDevices !== 'function'))
			{
				continue;
			}

			const driverIdCandidates = [
				String(driverKey || '').trim(),
				String(runtimeDriver.id || '').trim(),
			];
			const driverShortId = driverIdCandidates
				.map((id) => (id ? id.split(':').pop() : ''))
				.find((id) => !!id);
			if (!driverShortId)
			{
				continue;
			}

			const devices = runtimeDriver.getDevices();
			for (const existing of Object.values(devices || {}))
			{
				if (!existing)
				{
					continue;
				}

				const data = (typeof existing.getData === 'function') ? existing.getData() : null;
				addInstalledDeviceEntry(driverShortId, existing, data);
			}
		}

		if (Object.keys(installedKeysByDriverId).length === 0 && this.homey.devices && (typeof this.homey.devices.getDevices === 'function'))
		{
			try
			{
				const installedDevices = await this.homey.devices.getDevices();
				for (const existing of Object.values(installedDevices || {}))
				{
					if (!existing)
					{
						continue;
					}

					const existingDriverId = String(existing.driverId || '').trim();
					const existingDriverShortId = existingDriverId ? existingDriverId.split(':').pop() : '';
					addInstalledDeviceEntry(existingDriverShortId, existing);
				}
			}
			catch (error)
			{
				this.logInformation('getDriverSupportMatrix getDevices', error.message ? error.message : error);
			}
		}

		let totalSupportedInstalled = 0;
		let totalSupportedNotInstalled = 0;
		for (const recommendation of recommendations)
		{
			const recommendedDriverId = String(recommendation.recommendedDriverId || '').trim();
			if (!recommendedDriverId)
			{
				recommendation.isInstalled = false;
				continue;
			}

			const recommendedDriverShortId = recommendedDriverId.split(':').pop();
			const installedKeys = installedKeysByDriverId[recommendedDriverShortId] || new Set();
			const deviceURL = String(recommendation.deviceURL || '').trim();
			const oid = String(recommendation.oid || '').trim();
			const byUrl = !!(deviceURL && installedKeys.has(`url:${deviceURL}`));
			const byId = !!(oid && installedKeys.has(`id:${oid}`));
			recommendation.isInstalled = byUrl || byId;

			if (recommendation.isInstalled)
			{
				totalSupportedInstalled += 1;
			}
			else
			{
				totalSupportedNotInstalled += 1;
			}
		}

		const totalUnsupported = recommendations.length - (totalSupportedInstalled + totalSupportedNotInstalled);

		return {
			generatedAt: new Date().toISOString(),
			hasConnectedSession,
			totalSomfyDevices: somfyDevices.length,
			totalMatchedDrivers: driverList.length,
			totalSupportedInstalled,
			totalSupportedNotInstalled,
			totalUnsupported,
			recommendations: recommendations.sort((a, b) =>
			{
				const an = (a.label || a.deviceURL || '').toLowerCase();
				const bn = (b.label || b.deviceURL || '').toLowerCase();
				return an.localeCompare(bn);
			}),
			controllableNames,
			drivers: driverList,
		};
	}

	hasActiveDriverSupportSession()
	{
		const cloudLoggedIn = (this.tahomaCloud && this.tahomaCloud.authenticated)
			|| (this.tahomaCloudsBySession && Object.values(this.tahomaCloudsBySession).some((client) => client && client.authenticated));

		const localLoggedIn = this.tahomaLocal && this.tahomaLocal.authenticated;

		return !!(cloudLoggedIn || localLoggedIn);
	}

	async getSomfyDevicesForDriverSupport()
	{
		const collected = [];
		const seen = new Set();
		const ignoredControllableNames = new Set([
			'internal:wificomponent',
			'zigbee:zigbeenetworknode',
			'zigbee:somfyconfigurationtoolcomponent',
		]);

		const isProtocolGatewayDevice = (device) =>
		{
			const uiClass = device && device.uiClass ? String(device.uiClass) : '';
			const definitionUiClass = device && device.definition && device.definition.uiClass ? String(device.definition.uiClass) : '';
			return (uiClass === 'ProtocolGateway') || (definitionUiClass === 'ProtocolGateway');
		};

		const addDevices = (source, sessionName, deviceList) =>
		{
			if (!Array.isArray(deviceList))
			{
				return;
			}

			const serializeSomfyDevice = (candidate) =>
			{
				try
				{
					return JSON.parse(JSON.stringify(candidate || {}));
				}
				catch (error)
				{
					this.logInformation('getSomfyDevicesForDriverSupport serialize', error.message ? error.message : error);
					return {};
				}
			};

			for (const device of deviceList)
			{
				if (isProtocolGatewayDevice(device))
				{
					continue;
				}

				const deviceURL = device && device.deviceURL ? String(device.deviceURL) : '';
				const oid = device && device.oid ? String(device.oid) : '';
				const label = device && device.label ? String(device.label) : '';
				const controllableName = device && device.controllableName ? String(device.controllableName) : '';
				if (!controllableName)
				{
					continue;
				}

				if (ignoredControllableNames.has(controllableName.toLowerCase()))
				{
					continue;
				}

				const key = deviceURL
					? `url:${deviceURL}`
					: (oid ? `oid:${oid}` : `fallback:${controllableName}:${label}`);
				if (seen.has(key))
				{
					continue;
				}

				seen.add(key);
				collected.push(
					{
						label,
						oid,
						deviceURL,
						controllableName,
						source,
						session: sessionName,
						commands: this.getSomfyDeviceCommandNames(device),
						states: this.getSomfyDeviceStateNames(device),
						somfyDevice: serializeSomfyDevice(device),
					},
				);
			}
		};

		const cloudSessions = this.getCloudPollingSessions();
		if ((!Array.isArray(cloudSessions) || (cloudSessions.length === 0)) && this.tahomaCloud && !this.tahomaCloud.authenticated)
		{
			await this.initSync();
		}

		if (Array.isArray(cloudSessions) && (cloudSessions.length > 0))
		{
			for (const session of cloudSessions)
			{
				try
				{
					const authenticated = await this.ensureCloudSessionAuthenticated(session.username, session.password, session.region, false, 'driver-support');
					if (!authenticated)
					{
						continue;
					}

					const cloudClient = this.getCloudClientForSession(session.username);
					const devices = await cloudClient.getDeviceData();
					addDevices('cloud', this.normalizeSessionEmail(session.username), devices);
				}
				catch (error)
				{
					this.logInformation('getSomfyDevicesForDriverSupport cloud', error.message ? error.message : error);
				}
			}
		}
		else if (this.tahomaCloud && this.tahomaCloud.authenticated)
		{
			try
			{
				const devices = await this.tahomaCloud.getDeviceData();
				const session = this.normalizeSessionEmail(this.tahomaCloud.username || this.homey.settings.get('username') || '');
				addDevices('cloud', session, devices);
			}
			catch (error)
			{
				this.logInformation('getSomfyDevicesForDriverSupport cloud', error.message ? error.message : error);
			}
		}

		if (this.tahomaLocal && this.tahomaLocal.authenticated)
		{
			try
			{
				const localDevices = await this.tahomaLocal.getDeviceData();
				addDevices('local', 'local', localDevices);
			}
			catch (error)
			{
				this.logInformation('getSomfyDevicesForDriverSupport local', error.message ? error.message : error);
			}
		}

		return collected;
	}

	async getDriverDefinitions()
	{
		const driversRoot = path.join(__dirname, 'drivers');
		const runtimeDrivers = this.homey.drivers && (typeof this.homey.drivers.getDrivers === 'function')
			? this.homey.drivers.getDrivers()
			: {};
		const runtimeDriverList = Object.values(runtimeDrivers || {});
		let entries = [];
		try
		{
			entries = await fs.readdir(driversRoot, { withFileTypes: true });
		}
		catch (error)
		{
			this.logInformation('getDriverDefinitions readdir', error.message ? error.message : error);
		}

		const runtimeDriverMap = {};
		for (const runtimeDriver of runtimeDriverList)
		{
			if (!runtimeDriver)
			{
				continue;
			}

			const runtimeDriverId = String(runtimeDriver.id || '').trim();
			if (!runtimeDriverId)
			{
				continue;
			}

			runtimeDriverMap[runtimeDriverId] = runtimeDriver;
		}

		const drivers = [];
		const seenDriverIds = new Set();

		for (const [driverId, runtimeDriver] of Object.entries(runtimeDriverMap))
		{
			const supportedControllableNames = Array.isArray(runtimeDriver.deviceType)
				? [...new Set(runtimeDriver.deviceType
					.map((name) => String(name || '').trim())
					.filter((name) => !!name))]
				: [];

			if (supportedControllableNames.length === 0)
			{
				continue;
			}

			const manifest = runtimeDriver.manifest || {};
			drivers.push(
				{
					driverId,
					driverName: this.getDriverFriendlyName(manifest, driverId),
					driverIcon: this.getDriverIconPath(manifest, driverId),
					supportedControllableNames,
					capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
				},
			);

			seenDriverIds.add(driverId);
		}

		for (const entry of entries)
		{
			if (!entry.isDirectory())
			{
				continue;
			}

			const driverId = entry.name;
			if (seenDriverIds.has(driverId))
			{
				continue;
			}

			const driverDir = path.join(driversRoot, driverId);
			const driverJsPath = path.join(driverDir, 'driver.js');
			const composePath = path.join(driverDir, 'driver.compose.json');
			try
			{
				let supportedControllableNames = [];
				const runtimeDriver = runtimeDriverMap[driverId] || null;
				if (runtimeDriver && Array.isArray(runtimeDriver.deviceType))
				{
					supportedControllableNames = runtimeDriver.deviceType
						.map((name) => String(name || '').trim())
						.filter((name) => !!name);
				}
				else if (await this.fileExists(driverJsPath))
				{
					const driverJs = await fs.readFile(driverJsPath, 'utf8');
					supportedControllableNames = this.extractDeviceTypesFromDriverJs(driverJs);
				}

				supportedControllableNames = [...new Set(supportedControllableNames)];
				if (supportedControllableNames.length === 0)
				{
					continue;
				}

				let compose = {};
				if (await this.fileExists(composePath))
				{
					try
					{
						const composeRaw = await fs.readFile(composePath, 'utf8');
						compose = JSON.parse(composeRaw);
					}
					catch (parseError)
					{
						this.logInformation('getDriverDefinitions compose parse', `${driverId}: ${parseError.message ? parseError.message : parseError}`);
					}
				}

				let driverName = this.getDriverFriendlyName(compose, driverId);
				let driverIcon = this.getDriverIconPath(compose, driverId);
				const runtimeManifest = runtimeDriver && runtimeDriver.manifest ? runtimeDriver.manifest : null;
				if (runtimeManifest)
				{
					driverName = this.getDriverFriendlyName(runtimeManifest, driverId);
					driverIcon = this.getDriverIconPath(runtimeManifest, driverId) || driverIcon;
				}

				let capabilities = Array.isArray(compose.capabilities) ? compose.capabilities : [];
				if (runtimeManifest && Array.isArray(runtimeManifest.capabilities) && (runtimeManifest.capabilities.length > 0))
				{
					capabilities = runtimeManifest.capabilities;
				}

				drivers.push(
					{
						driverId,
						driverName,
						driverIcon,
						supportedControllableNames,
						capabilities,
					},
				);

				seenDriverIds.add(driverId);
			}
			catch (error)
			{
				this.logInformation('getDriverDefinitions', `${driverId}: ${error.message ? error.message : error}`);
			}
		}

		return drivers;
	}

	async fileExists(filePath)
	{
		try
		{
			await fs.access(filePath);
			return true;
		}
		catch (error)
		{
			return false;
		}
	}

	getDriverFriendlyName(compose, driverId)
	{
		if (!compose || !compose.name)
		{
			return driverId;
		}

		if (typeof compose.name === 'string')
		{
			return compose.name;
		}

		const language = (this.homey && this.homey.i18n && (typeof this.homey.i18n.getLanguage === 'function'))
			? this.homey.i18n.getLanguage()
			: 'en';
		if (language && compose.name[language])
		{
			return compose.name[language];
		}

		if (compose.name.en)
		{
			return compose.name.en;
		}

		const firstName = Object.values(compose.name).find((name) => typeof name === 'string' && name.length > 0);
		return firstName || driverId;
	}

	getDriverIconPath(compose, driverId)
	{
		return `/drivers/${driverId}/assets/icon.svg`;
	}

	extractDeviceTypesFromDriverJs(driverJs)
	{
		if (!driverJs)
		{
			return [];
		}

		const match = driverJs.match(/this\.deviceType\s*=\s*\[([\s\S]*?)\];/m);
		if (!match)
		{
			return [];
		}

		const block = match[1];
		const results = [];
		const regex = /'([^']+)'|"([^"]+)"/g;
		let token = regex.exec(block);
		while (token)
		{
			const value = token[1] || token[2] || '';
			if (value && !results.includes(value))
			{
				results.push(value);
			}

			token = regex.exec(block);
		}

		return results;
	}

	getSomfyDeviceCommandNames(device)
	{
		if (!device || !device.definition || !Array.isArray(device.definition.commands))
		{
			return [];
		}

		const names = [];
		for (const command of device.definition.commands)
		{
			if (!command || !command.commandName)
			{
				continue;
			}

			const name = String(command.commandName).toLowerCase();
			if (name && !names.includes(name))
			{
				names.push(name);
			}
		}

		return names;
	}

	getSomfyDeviceStateNames(device)
	{
		const names = [];
		if (device && device.definition && Array.isArray(device.definition.states))
		{
			for (const state of device.definition.states)
			{
				const name = state && state.qualifiedName ? String(state.qualifiedName).toLowerCase() : '';
				if (name && !names.includes(name))
				{
					names.push(name);
				}
			}
		}

		if (device && Array.isArray(device.states))
		{
			for (const state of device.states)
			{
				const name = state && state.name ? String(state.name).toLowerCase() : '';
				if (name && !names.includes(name))
				{
					names.push(name);
				}
			}
		}

		return names;
	}

	scoreDriverForSomfyDevice(driver, somfyDevice)
	{
		const capabilities = Array.isArray(driver && driver.capabilities) ? driver.capabilities : [];
		const commands = Array.isArray(somfyDevice && somfyDevice.commands) ? somfyDevice.commands : [];
		const states = Array.isArray(somfyDevice && somfyDevice.states) ? somfyDevice.states : [];
		const matchedCapabilities = [];
		const unmatchedCapabilities = [];

		let score = 100;
		for (const capability of capabilities)
		{
			if (this.doesCapabilityMatchSomfyFeatures(capability, commands, states))
			{
				score += 20;
				matchedCapabilities.push(capability);
			}
			else
			{
				score -= 12;
				unmatchedCapabilities.push(capability);
			}
		}

		const capabilityCount = capabilities.length;
		const compatibilityRatio = capabilityCount > 0 ? (matchedCapabilities.length / capabilityCount) : 0;
		score += Math.round(compatibilityRatio * 10);

		return {
			score,
			matchedCapabilities,
			unmatchedCapabilities,
			compatibilityRatio,
		};
	}

	doesCapabilityMatchSomfyFeatures(capability, commands, states)
	{
		const cap = String(capability || '').toLowerCase();
		if (!cap)
		{
			return false;
		}

		const hasCommand = (regex) => commands.some((command) => regex.test(command));
		const hasState = (regex) => states.some((state) => regex.test(state));

		if (cap === 'windowcoverings_state')
		{
			return hasState(/openclosed|closure|position|deployment|blind|shutter|window/i);
		}

		if (cap === 'windowcoverings_set')
		{
			return hasCommand(/setclosure|setposition|setdeployment|setpositionandlinearspeed|deploy|undeploy|open|close|go(?:to)?alias|partialposition/i);
		}

		if (cap === 'windowcoverings_closed')
		{
			return hasState(/openclosedstate|openclosed|closed|open/i);
		}

		if (cap === 'my_position')
		{
			return hasCommand(/^my$|go(?:to)?alias|partialposition/i);
		}

		if (cap === 'quiet_mode')
		{
			return hasState(/activatedoptionsstate|activatedoptions|silence|silent/i)
				|| hasCommand(/setpositionandlinearspeed|lowspeed|silence|silent/i);
		}

		if (cap === 'onoff')
		{
			return hasCommand(/^on$|^off$|setonoff/i) || hasState(/onoff/i);
		}

		if (cap === 'dim')
		{
			return hasCommand(/setintensity/i) || hasState(/lightintensity/i);
		}

		if (cap === 'measure_temperature')
		{
			return hasState(/temperature/i);
		}

		if (cap === 'measure_humidity')
		{
			return hasState(/humidity/i);
		}

		if (cap === 'measure_luminance')
		{
			return hasState(/light|lux|luminance/i);
		}

		if (cap === 'lock_state' || cap === 'locked')
		{
			return hasCommand(/lock|unlock/i) || hasState(/lock|prioritylock/i);
		}

		if (cap.indexOf('target_temperature') >= 0)
		{
			return hasCommand(/set.*temperature/i) || hasState(/targettemperature|setpoint/i);
		}

		const tokens = cap
			.replace(/[^a-z0-9]/g, ' ')
			.split(/\s+/)
			.filter((token) => token.length >= 4 && ['measure', 'windowcoverings', 'target', 'alarm', 'state', 'mode'].indexOf(token) < 0);

		for (const token of tokens)
		{
			if (hasCommand(new RegExp(token, 'i')) || hasState(new RegExp(token, 'i')))
			{
				return true;
			}
		}

		return false;
	}

	logInformation(source, error, level = 1)
	{
		let data = '';
		if (error)
		{
			if (error.stack)
			{
				data = {
					message: error.message,
					stack: error.stack.stack ? error.stack.stack : error.stack,
				};
			}
			else if (error.message)
			{
				data = error.message;
			}
			else if (error.data)
			{
				data = error.data;
			}
			else
			{
				data = error;
			}

			data = this.varToString(data);
		}

		this.homey.error(`[L${level}] ${source}, ${data}`);

		if (this.homeyIP)
		{
			try
			{
				let logData = this.homey.settings.get('infoLog');
				if (!Array.isArray(logData))
				{
					logData = [];
				}

				// Calculate time since last log message
				const nowTime = new Date(Date.now());
				const timeDiff = (nowTime.getTime() - this.lastLogTime.getTime()) / 1000;
				this.lastLogTime = nowTime;

				logData.push(
					{
						time: nowTime.toJSON(),
						elapsed: timeDiff,
						level,
						source,
						data,
					},
				);

				if (logData && logData.length > 200)
				{
					logData.splice(0, logData.length - 200);
				}
				this.homey.settings.set('infoLog', logData);
			}
			catch (err)
			{
				this.homey.error('logInformation persist failed', err && err.message ? err.message : err);
			}
		}
	}

	logStates(txt)
	{
		if (this.homey.settings.get('stateLogEnabled'))
		{
			const log = `${this.homey.settings.get('stateLog') + txt}\n`;
			if (log && (log.length > 30000))
			{
				this.homey.settings.set('stateLogEnabled', false);
			}
			else
			{
				this.homey.settings.set('stateLog', log);
			}
		}
	}

	logEvents(txt)
	{
		const nowTime = new Date(Date.now());
		let log = `${this.homey.settings.get('eventLog') + nowTime.toJSON()}\r\n${txt}\r\n`;
		if (log.length > 30000)
		{
			log = log.substring(log.length - 1000);
			const n = log.indexOf('\n');
			if (n >= 0)
			{
				// Remove up to and including the first \n so the log starts on a whole line
				log = log.substring(n + 1);
			}
		}
		this.homey.settings.set('eventLog', log);
	}

	async sendLog(logType)
	{
		let tries = 5;
		this.log('Send Log');
		while (tries-- > 0)
		{
			try
			{
				let subject = '';
				let text = '';
				if (logType === 'infoLog')
				{
					subject = 'Tahoma Information log';
					text = this.varToString(this.homey.settings.get('infoLog'));
				}
				else if (logType === 'deviceLog')
				{
					subject = 'Tahoma device log';
					text = this.varToString(this.homey.settings.get('deviceLog'));
				}
				else if (logType === 'eventLog')
				{
					subject = 'Tahoma event log';
					text = this.varToString(this.homey.settings.get('eventLog'));
				}

				text = text.replace(/\\n/g, '\n              ');
				text = text.replace(/\\"/g, '"');

				subject += `(${this.homeyHash} : ${Homey.manifest.version})`;

				// create reusable transporter object using the default SMTP transport
				const transporter = nodemailer.createTransport(
					{
						host: Homey.env.MAIL_HOST, // Homey.env.MAIL_HOST,
						port: 465,
						ignoreTLS: false,
						secure: true, // true for 465, false for other ports
						auth:
						{
							user: Homey.env.MAIL_USER, // generated ethereal user
							pass: Homey.env.MAIL_SECRET, // generated ethereal password
						},
						tls:
						{
							// do not fail on invalid certs
							rejectUnauthorized: false,
						},
					},
				);

				// send mail with defined transport object
				const response = await transporter.sendMail(
					{
						from: `"Homey User" <${Homey.env.MAIL_USER}>`, // sender address
						to: Homey.env.MAIL_RECIPIENT, // list of receivers
						subject, // Subject line
						text, // plain text body
					},
				);

				return {
					error: response.err,
					message: response.err ? null : `${this.homeyHash}`,
				};
			}
			catch (err)
			{
				this.logInformation('Send log error', err);
				return {
					error: err,
					message: null,
				};
			}
		}
		return {
			message: 'Failed 5 attempts',
		};
	}

	async sendUnsupportedDevices(unsupportedDevices)
	{
		try
		{
			const devices = Array.isArray(unsupportedDevices) ? unsupportedDevices : [];
			if (!devices.length)
			{
				return {
					error: new Error('No unsupported devices to send'),
					message: null,
				};
			}

			const lines = [];
			lines.push('Unsupported devices report');
			lines.push(`Homey hash: ${this.homeyHash}`);
			lines.push(`App version: ${Homey.manifest.version}`);
			lines.push(`Generated at: ${new Date().toISOString()}`);
			lines.push('');

			const groupedByControllableName = devices.reduce((groups, device) =>
			{
				const groupName = (device && device.controllableName)
					? String(device.controllableName)
					: 'Unknown controllableName';

				if (!groups[groupName])
				{
					groups[groupName] = [];
				}

				groups[groupName].push(device);
				return groups;
			}, {});

			const orderedGroupNames = Object.keys(groupedByControllableName)
				.sort((a, b) => a.localeCompare(b));

			let globalIndex = 0;
			for (const groupName of orderedGroupNames)
			{
				const groupDevices = groupedByControllableName[groupName] || [];
				lines.push(`ControllableName: ${groupName} (${groupDevices.length})`);
				lines.push('');

				for (const device of groupDevices)
				{
					globalIndex += 1;
					const label = device && device.label ? device.label : '-';
					const url = device && device.deviceURL ? device.deviceURL : '';
					const cls = device && device.deviceClass ? device.deviceClass : '';
					const commands = device && Array.isArray(device.availableCommands) ? device.availableCommands.join(', ') : '';
					const controllableName = device && device.controllableName ? device.controllableName : '';
					const states = device && Array.isArray(device.states) ? device.states.join(', ') : '';
					const source = device && device.source ? device.source : '';
					const oid = device && device.oid ? device.oid : '';
					const somfyDeviceSection = device && device.somfyDevice ? device.somfyDevice : {};

					lines.push(`${globalIndex}. ${label}`);
					if (url)
					{
						lines.push(`   URL: ${url}`);
					}
					if (oid)
					{
						lines.push(`   OID: ${oid}`);
					}
					if (controllableName)
					{
						lines.push(`   ControllableName: ${controllableName}`);
					}
					if (source)
					{
						lines.push(`   Source: ${source}`);
					}
					if (cls)
					{
						lines.push(`   Class: ${cls}`);
					}
					if (commands)
					{
						lines.push(`   Commands: ${commands}`);
					}
					if (states)
					{
						lines.push(`   States: ${states}`);
					}

					lines.push('   Somfy device section:');
					const somfyDeviceJson = JSON.stringify(somfyDeviceSection, null, 2) || '{}';
					somfyDeviceJson.split('\n').forEach((line) => lines.push(`   ${line}`));
					lines.push('');
				}

				lines.push('------------------------------------------------------------');
				lines.push('');
			}

			const transporter = nodemailer.createTransport(
				{
					host: Homey.env.MAIL_HOST,
					port: 465,
					ignoreTLS: false,
					secure: true,
					auth:
					{
						user: Homey.env.MAIL_USER,
						pass: Homey.env.MAIL_SECRET,
					},
					tls:
					{
						rejectUnauthorized: false,
					},
				},
			);

			const response = await transporter.sendMail(
				{
					from: `"Homey User" <${Homey.env.MAIL_USER}>`,
					to: Homey.env.MAIL_RECIPIENT,
					subject: 'Unsupported devices in the Tahoma app',
					text: lines.join('\n'),
				},
			);

			return {
				error: response.err,
				message: response.err ? null : `${this.homeyHash}`,
			};
		}
		catch (err)
		{
			this.logInformation('Send unsupported devices error', err);
			return {
				error: err,
				message: null,
			};
		}
	}

	/**
	 * Initializes synchronization between Homey and TaHoma
	 * with the interval as defined in the settings.
	 */
	async initSync()
	{
		if (this.loginTimerId)
		{
			this.homey.clearTimeout(this.loginTimerId);
			this.loginTimerId = null;
		}

		if (this.initSyncInFlight)
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('initSync', 'Already running; joining existing attempt');
			}
			return this.initSyncInFlight;
		}

		const syncPromise = (async () =>
		{
			const username = this.homey.settings.get('username');
			const password = this.homey.settings.get('password');
			const region = this.homey.settings.get('region');
			if ((!username || !password) && (typeof this.ensureCredentialsFromSessions === 'function'))
			{
				this.ensureCredentialsFromSessions();
			}

			const retryUsername = this.homey.settings.get('username');
			const retryPassword = this.homey.settings.get('password');
			const effectiveUsername = retryUsername || username;
			const effectivePassword = retryPassword || password;
			const effectiveRegion = this.homey.settings.get('region') || region;
			if (!effectiveUsername || !effectivePassword)
			{
				return;
			}

			let timeout = 15000;

			try
			{
				if (this.infoLogEnabled)
				{
					this.logInformation('initSync', 'Starting');
				}

				await this.newLogin_2(effectiveUsername, effectivePassword, effectiveRegion);
				return;
			}
			catch (error)
			{
				if (error.message)
				{
					this.logInformation('initSync', `Error: ${error.message}`);

					if (error.message.indexOf('Far Too many') >= 0)
					{
						this.homey.clearTimeout(this.boostTimerId);
						this.boostTimerId = null;
						this.commandsQueued = 0;
						timeout = this.homeyIP ? 910000 : 86410000;
					}
					else if (error.message === 'Please leave 1 minutes between login attempts')
					{
						this.homey.clearTimeout(this.boostTimerId);
						this.boostTimerId = null;
						this.commandsQueued = 0;
						timeout = 61000;
					}
				}
				else
				{
					this.logInformation('initSync', error);
				}
			}

			// Try again later
			this.loginTimerId = this.homey.setTimeout(() => this.initSync(), timeout);
		})();

		this.initSyncInFlight = syncPromise;
		try
		{
			return await syncPromise;
		}
		finally
		{
			if (this.initSyncInFlight === syncPromise)
			{
				this.initSyncInFlight = null;
			}
		}
	}

	// Boost the sync speed when a command is executed that has status feedback
	async boostSync()
	{
		if (!this.localOnly)
		{
			if (this.tahomaCloud.authenticated)
			{
				if (this.unBoostTimerID)
				{
					this.homey.clearTimeout(this.unBoostTimerID);
					this.unBoostTimerID = null;
				}

				let maxLoops = 50;
				while (this.unBoosting && (maxLoops-- > 0))
				{
					await this.asyncDelay(1000);
				}

				this.commandsQueued++;

				if (this.boostTimerId)
				{
					this.homey.clearTimeout(this.boostTimerId);
					this.boostTimerId = null;
				}

				// Set a time limit in case the command complete signal is missed
				this.boostTimerId = this.homey.setTimeout(() => this.unBoostSync(true), 60000);

				if (this.infoLogEnabled)
				{
					this.logInformation('Boost Sync',
						{
							message: 'Increased Polling',
							stack: { syncInterval: 3, queSize: this.commandsQueued },
						});
				}

				if (this.commandsQueued === 1)
				{
					this.nextCloudInterval = 0;
					if (this.syncTimerId)
					{
						this.homey.clearTimeout(this.syncTimerId);
						this.syncTimerId = null;
					}

					if (!this.tahomaCloud.eventsRegistered())
					{
						// The events are not currently registered so do that now
						try
						{
							await this.tahomaCloud.getEvents();
						}
						catch (error)
						{
							this.logInformation('Boost Sync register events: ', error.message);
							this.commandsQueued = 0;
							return false;
						}
					}

					this.nextCloudInterval = LOCAL_INTERVAL * 1000;
					if (!this.syncing)
					{
						// We can't run the sync loop from here so fire it from a timer
						this.syncTimerId = this.homey.setTimeout(this.syncLoop, LOCAL_INTERVAL * 1000);
					}
				}
				else
				{
					let maxDelay = 6;
					while ((maxDelay > 0) && (this.commandsQueued > 0) && (!this.tahomaCloud.eventsRegistered()))
					{
						await this.asyncDelay(500);
						maxDelay--;
					}

					if ((!this.tahomaCloud.eventsRegistered()))
					{
						return false;
					}
				}
			}
		}
		return true;
	}

	async unBoostSync(immediate = false)
	{
		this.unBoosting = true;

		if (immediate)
		{
			if (this.unBoostTimerID)
			{
				this.homey.clearTimeout(this.unBoostTimerID);
				this.unBoostTimerID = null;
			}
			this.commandsQueued = 0;
		}

		if (this.infoLogEnabled)
		{
			this.logInformation('UnBoost Sync',
				{
					message: 'Reverting to previous Polling',
					stack:
					{
						timeOut: immediate,
						syncInterval: CLOUD_INTERVAL,
						queSize: this.commandsQueued,
					},
				});
		}

		if (this.commandsQueued > 0)
		{
			this.commandsQueued--;
		}

		if (this.commandsQueued === 0)
		{
			this.homey.clearTimeout(this.boostTimerId);
			this.boostTimerId = null;
			this.startSync();
		}
		this.unBoosting = false;
	}

	async stopSync(CloudLocal)
	{
		if (CloudLocal === 'cloud')
		{
			if (this.commandsQueued > 0)
			{
				this.commandsQueued = 0;
				this.homey.clearTimeout(this.boostTimerId);
				this.boostTimerId = null;
				if (this.infoLogEnabled)
				{
					this.logInformation('stopSync', 'Cleared commandsQueued');
				}
			}

			this.nextCloudInterval = 0;
		}

		if (this.syncTimerId)
		{
			this.homey.clearTimeout(this.syncTimerId);
			this.syncTimerId = null;
			if (this.infoLogEnabled)
			{
				this.logInformation('stopSync', 'Stopped sync timer');
			}
		}

		if (this.tahomaCloud && (CloudLocal === 'cloud'))
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('stopSync', 'Stopping Cloud Event Polling');
			}

			const cloudClients = new Set();
			if (this.tahomaCloud)
			{
				cloudClients.add(this.tahomaCloud);
			}
			if (this.tahomaCloudsBySession && (typeof this.tahomaCloudsBySession === 'object'))
			{
				for (const cloudClient of Object.values(this.tahomaCloudsBySession))
				{
					if (cloudClient)
					{
						cloudClients.add(cloudClient);
					}
				}
			}

			for (const cloudClient of cloudClients)
			{
				await cloudClient.eventsClearRegistered();
			}
		}

		if (this.tahomaLocal && (CloudLocal === 'local'))
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('stopSync', 'Stopping Local Event Polling');
			}

			await this.tahomaLocal.eventsClearRegistered();

			if (this.tahomaLocalsByPin && (typeof this.tahomaLocalsByPin === 'object'))
			{
				for (const localClient of Object.values(this.tahomaLocalsByPin))
				{
					if (localClient && localClient !== this.tahomaLocal)
					{
						await localClient.eventsClearRegistered();
					}
				}
			}
		}
	}

	async startSync()
	{
		if (this.commandsQueued > 0)
		{
			// Boost already running
			return;
		}

		this.nextCloudInterval = 0;

		if (this.syncTimerId)
		{
			this.homey.clearTimeout(this.syncTimerId);
			this.syncTimerId = null;
		}

		if (this.infoLogEnabled)
		{
			this.logInformation(`Restart local sync in: ${LOCAL_INTERVAL} seconds, cloud sync in: ${CLOUD_INTERVAL} seconds`);
		}

		let nextCloudDelay = CLOUD_INTERVAL * 1000;
		if (this.forceImmediateCloudSync && !this.localOnly)
		{
			nextCloudDelay = LOCAL_INTERVAL * 1000;
			this.forceImmediateCloudSync = false;
		}

		this.nextCloudInterval = nextCloudDelay;
		if (!this.syncing)
		{
			this.syncTimerId = this.homey.setTimeout(this.syncLoop, LOCAL_INTERVAL * 1000);
		}
	}

	// The main polling loop that fetches events and sends them to the devices
	async syncLoop()
	{
		if (this.syncTimerId)
		{
			// make sure any existing timer is canceled
			this.homey.clearTimeout(this.syncTimerId);
			this.syncTimerId = null;
		}

		let nextInterval = 0;

		if (this.nextCloudInterval !== 0)
		{
			if (this.tahomaLocal)
			{
				nextInterval = await this.syncAllLocalBridges();
			}
			else
			{
				nextInterval = LOCAL_INTERVAL * 1000;
			}

			if (!this.localOnly)
			{
				if ((this.nextCloudInterval - (LOCAL_INTERVAL * 1000)) <= 0)
				{
					nextInterval = await this.syncAllCloudSessions();
					this.nextCloudInterval = nextInterval;
				}
				else
				{
					this.nextCloudInterval -= (LOCAL_INTERVAL * 1000);
				}
			}
		}

		if (nextInterval > 0)
		{
			// Setup timer for next sync
			this.syncTimerId = this.homey.setTimeout(this.syncLoop, LOCAL_INTERVAL * 1000);
		}
		else
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('Not renewing sync');
			}

			this.syncTimerId = this.homey.setTimeout(() => this.initSync(), 10000);
		}
	}

	async syncAllLocalBridges()
	{
		const nextInterval = LOCAL_INTERVAL * 1000;

		const bridges = this.getDiscoveredLocalBridges();
		if (!Array.isArray(bridges) || (bridges.length === 0))
		{
			if (this.infoLogEnabled)
			{
				this.logInformation('Local syncLoop', 'No discovered local bridges');
			}

			return nextInterval;
		}

		const normalizedBridges = bridges.filter((bridge) => bridge && this.normalizeBridgePin(bridge.pin));
		const bridgeCandidatesByPin = new Map();
		let hasPinMatchedSessions = false;

		for (const bridge of normalizedBridges)
		{
			const bridgePin = this.normalizeBridgePin(bridge.pin);
			const bridgeCandidates = this.getCandidateCredentialsForLocalRouting('', bridgePin);
			bridgeCandidatesByPin.set(bridgePin, bridgeCandidates);
			if (bridgeCandidates.length > 0)
			{
				hasPinMatchedSessions = true;
			}
		}

		if (!hasPinMatchedSessions)
		{
			if (this.infoLogEnabled && !this.localPollingNoPinMatchLogged)
			{
				this.logInformation('Local syncLoop', 'No local sessions match discovered bridge pin(s); local polling is disabled until a pin match is learned.');
			}
			this.localPollingNoPinMatchLogged = true;
			return nextInterval;
		}

		this.localPollingNoPinMatchLogged = false;

		const bridgeTasks = normalizedBridges
			.map(async (bridge) =>
			{
				const bridgePin = this.normalizeBridgePin(bridge.pin);
				const bridgeCandidates = bridgeCandidatesByPin.get(bridgePin) || [];
				if (bridgeCandidates.length === 0)
				{
					return { bridge, bridgePin, synced: false, events: undefined, skipped: true };
				}
				const localClientForBridge = this.getLocalClientForBridge(bridge);
				if (!localClientForBridge)
				{
					return { bridge, bridgePin, synced: false, events: undefined };
				}

				let authenticated = localClientForBridge.authenticated && Array.isArray(localClientForBridge.supportedDevices) && (localClientForBridge.supportedDevices.length > 0);
				if (!authenticated)
				{
					for (const candidate of bridgeCandidates)
					{
						try
						{
							const ok = await this.doLocalLoginForClient(localClientForBridge, candidate.username, candidate.password, candidate.region, candidate.localToken || null, bridge, false, true, false);
							if (ok && localClientForBridge.authenticated)
							{
								authenticated = true;
								break;
							}
						}
						catch (error)
						{
							this.logInformation('syncAllLocalBridges login', error.message ? error.message : error);
						}
					}
				}

				if (!authenticated)
				{
					if (this.infoLogEnabled)
					{
						this.logInformation('Local syncLoop', `Failed to sync bridge ${bridge.pin}`);
					}
					return { bridge, bridgePin, synced: false, events: undefined };
				}

				if (this.infoLogEnabled)
				{
					this.logInformation('Local syncLoop', `Syncing bridge ${bridge.pin}`);
				}

				try
				{
					const events = await localClientForBridge.getEvents();
					return { bridge, bridgePin, synced: true, events };
				}
				catch (error)
				{
					this.logInformation('syncAllLocalBridges events', error.message ? error.message : error);
					return { bridge, bridgePin, synced: false, events: undefined };
				}
			});

		const bridgeResults = await Promise.all(bridgeTasks);
		let requiresFullRefresh = false;
		const mergedEvents = [];

		for (const result of bridgeResults)
		{
			if (!result || !result.synced)
			{
				continue;
			}

			if (!this.localBridgeInfo)
			{
				this.localBridgeInfo = result.bridge;
				this.homey.settings.set('localBridge', this.localBridgeInfo);
			}

			if ((result.events === null) && (this.boostTimerId === null))
			{
				requiresFullRefresh = true;
			}
			else if (Array.isArray(result.events) && (result.events.length > 0))
			{
				mergedEvents.push(...result.events);
			}
		}

		if (requiresFullRefresh || (mergedEvents.length > 0))
		{
			await this.syncEvents(requiresFullRefresh ? null : mergedEvents, true);
		}

		return nextInterval;
	}

	async syncWorker(tahomaConnection)
	{
		let nextInterval = CLOUD_INTERVAL * 1000;
		if (this.boostTimerId)
		{
			nextInterval = LOCAL_INTERVAL * 1000;
		}

		if (!tahomaConnection.authenticated)
		{
			await this.updateConnectivityWarningFromLoginIssue(tahomaConnection.lastLoginIssue || '');

			if (this.infoLogEnabled)
			{
				this.logInformation(`Skipping ${tahomaConnection.localLogin ? 'local' : 'cloud'} sync: Not logged in`);
				if (tahomaConnection.lastLoginIssue)
				{
					this.logInformation('Last login issue', tahomaConnection.lastLoginIssue);
				}
			}

			if (!this.loginTimerId)
			{
				this.loginTimerId = this.homey.setTimeout(() => this.initSync(), 10000);
			}

			return nextInterval;
		}

		await this.updateConnectivityWarningFromLoginIssue('');

		if (this.infoLogEnabled)
		{
			if (tahomaConnection.localLogin)
			{
				this.logInformation('Local syncLoop',
					`Logged in = ${tahomaConnection.authenticated}, Local = ${tahomaConnection.localLogin}, Old Sync State = ${this.syncing}, Next cloud sync in ${this.nextCloudInterval / 1000}s`);
			}
			else
			{
				this.logInformation('Cloud syncLoop',
					`Logged in = ${tahomaConnection.authenticated}, Local = ${tahomaConnection.localLogin}, Old Sync State = ${this.syncing}`);
			}
		}

		if (!this.syncing)
		{
			this.syncing = true;
			const cloudSessionKey = !tahomaConnection.localLogin
				? this.normalizeSessionEmail(tahomaConnection.sessionUsername || tahomaConnection.username || '')
				: '';
			const connectionLastSync = tahomaConnection.localLogin
				? this.lastSync
				: (cloudSessionKey ? (this.cloudLastSyncBySession[cloudSessionKey] || 0) : this.lastSync);

			// Make sure it has been about 30 seconds since last sync unless boost is on or a local login
			if (tahomaConnection.localLogin || this.boostTimerId || ((Date.now() - connectionLastSync) > 28000))
			{
				if (!tahomaConnection.localLogin)
				{
					if (cloudSessionKey)
					{
						this.cloudLastSyncBySession[cloudSessionKey] = Date.now();
					}
					else
					{
						this.lastSync = Date.now();
					}
				}

				try
				{
					let events = await tahomaConnection.getEvents();
					if ((events === null && this.boostTimerId === null) || (events && events.length > 0))
					{
						// If events === null and boostTimer === null then refresh all the devices, but don't do that if the boost is on
						if (events !== null && this.eventLogEnabled)
						{
							this.logEvents(this.varToString(events));
						}
						await this.syncEvents(events, tahomaConnection.localLogin);
					}
					events = null;
				}
				catch (error)
				{
					if (this.isTransientSyncError(error))
					{
						const connectionType = tahomaConnection.localLogin ? 'Local' : 'Cloud';
						this.log(`${connectionType} sync transient issue: ${error.message}`);
						this.syncing = false;
						return nextInterval;
					}

					// this.logInformation('syncLoop', error.message);
					if (error.message)
					{
						if (error.message.indexOf('Far Too many') >= 0)
						{
							this.homey.clearTimeout(this.boostTimerId);
							this.boostTimerId = null;
							this.commandsQueued = 0;
							await this.updateConnectivityWarningFromLoginIssue(error.message);
							if (error.message.indexOf('15 minutes') >= 0)
							{
								nextInterval = 900000;
								this.logInformation('syncLoop', 'Postponed for 15 minutes');
							}
							else
							{
								nextInterval = 86400000;
								this.logInformation('syncLoop', 'Postponed for 24 hours');
							}
						}
						else if (error.message === 'Please leave 1 minutes between login attempts')
						{
							this.homey.clearTimeout(this.boostTimerId);
							this.boostTimerId = null;
							this.commandsQueued = 0;
							await this.updateConnectivityWarningFromLoginIssue(error.message);
							this.logInformation('syncLoop', 'Postponed for 1 minute');
							nextInterval = 61000;
						}
						else if (tahomaConnection.localLogin && this.isHttpStatus(error, 400))
						{
							await this.syncEvents(null, true);
						}
					}
					else
					{
						this.logInformation('syncLoop', error);
					}
				}
			}
			else if (this.infoLogEnabled)
			{
				this.logInformation('Skipping sync: too soon');
			}

			// Signal that the sync has completed
			this.syncing = false;
		}
		else if (this.infoLogEnabled)
		{
			this.logInformation('Skipping sync: Previous sync active');
		}

		return nextInterval;
	}

	// Pass the new events to each device so they can update their status
	async syncEvents(events, local)
	{
		try
		{
			if (events)
			{
				if (this.infoLogEnabled)
				{
					this.logInformation('Device status update', 'Checking events');
				}
			}
			else if (this.infoLogEnabled)
			{
				this.logInformation('Device status update', 'Initialising');
			}

			let drivers = this.homey.drivers.getDrivers();
			for (const driver of Object.values(drivers))
			{
				let devices = driver.getDevices();
				for (let device of Object.values(devices))
				{
					if (device.syncEvents)
					{
						try
						{
							await device.syncEvents(events, local);
						}
						catch (error)
						{
							this.logInformation('Sync Devices error', error.message);
						}
					}

					device = null;
				}
				devices = null;
			}

			drivers = null;

			if (this.infoLogEnabled)
			{
				this.logInformation('Device status update', 'Complete');
			}
		}
		catch (error)
		{
			this.logInformation(error.message, error.stack);
		}
	}

	// Trigger command complete
	triggerCommandComplete(device, commandName, success)
	{
		// trigger the card
		const tokens = { state: success, name: commandName };
		const state = { device };

		this.commandCompleteTrigger.trigger(tokens, state)
			.then(this.log)
			.catch(this.error);
	}

	/**
	 * Adds a listener for flowcard scenario actions
	 */
	addScenarioActionListeners()
	{
		/** * ADD FLOW ACTION LISTENERS ** */
		this.homey.flow.getActionCard('activate_scenario')
			.registerRunListener(async (args, state) =>
			{
				if (this.localOnly)
				{
					return this.tahomaLocal.executeScenario(args.scenario.oid);
				}
				return this.tahomaCloud.executeScenario(args.scenario.oid);
			})
			.getArgument('scenario').registerAutocompleteListener((query) =>
			{
				if (this.localOnly)
				{
					return this.tahomaLocal.getScenarios().then((data) => data.map(({ oid, label }) => (
					{
						oid,
						name: label,
					})).filter(({ name }) => name.toLowerCase().indexOf(query.toLowerCase()) > -1)).catch((error) =>
					{
						this.logInformation('addScenarioActionListeners', error.message);
					});
				}
				return this.tahomaCloud.getActionGroups().then((data) => data.map(({ oid, label }) => (
					{
						oid,
						name: label,
					})).filter(({ name }) => name.toLowerCase().indexOf(query.toLowerCase()) > -1)).catch((error) =>
					{
						this.logInformation('addScenarioActionListeners', error.message);
					});
			});
	}

	/**
	 * Adds a listener for polling speed flowcard actions
	 */
	addPollingSpeedActionListeners()
	{
		// Deprecated so do nothing
	}

	/**
	 * Adds a listener for polling mode flowcard actions
	 */
	addPollingActionListeners()
	{
		// Deprecated so do nothing
	}

	async asyncDelay(period)
	{
		await new Promise((resolve) => this.homey.setTimeout(resolve, period));
	}

	logDeviceStatesDelta(source, deviceURL, states)
	{
		if (!this.infoLogEnabled)
		{
			return;
		}

		if (!this.deviceStateLogSignatures || (typeof this.deviceStateLogSignatures !== 'object'))
		{
			this.deviceStateLogSignatures = {};
		}

		const stateSignature = this.varToString(states);
		const signatureKey = `${source}|${String(deviceURL || '')}`;
		if (this.deviceStateLogSignatures[signatureKey] === stateSignature)
		{
			return;
		}

		this.deviceStateLogSignatures[signatureKey] = stateSignature;
		this.logInformation(source, states);
	}

	varToString(source)
	{
		try
		{
			if (source === null)
			{
				return 'null';
			}
			if (source === undefined)
			{
				return 'undefined';
			}
			if (source instanceof Error)
			{
				const stack = source.stack.replace('/\\n/g', '\n');
				return `${source.message}\n${stack}`;
			}
			if (typeof (source) === 'object')
			{
				const getCircularReplacer = () =>
				{
					const seen = new WeakSet();
					return (key, value) =>
					{
						if (typeof value === 'object' && value !== null)
						{
							if (seen.has(value))
							{
								return '';
							}
							seen.add(value);
						}
						return value;
					};
				};

				return JSON.stringify(source, getCircularReplacer(), 2);
			}
			if (typeof (source) === 'string')
			{
				return source;
			}
		}
		catch (err)
		{
			this.homey.error(`VarToString Error: ${err && err.message ? err.message : err}`);
		}

		return String(source);
	}

	isActuatorNoAnswer(issue)
	{
		if (!issue)
		{
			return false;
		}

		const message = String(issue.message || issue.error || issue).toUpperCase();
		const failureType = String(issue.failureType || '').toUpperCase();
		const errorCode = String(issue.errorCode || '');

		return (message.indexOf('ACTUATORNOANSWER') >= 0)
			|| (failureType === 'ACTUATORNOANSWER')
			|| (errorCode === '102');
	}

	async cancelExecution(label, id, local)
	{
		if (this.infoLogEnabled)
		{
			this.homey.app.logInformation(`${label}: cancelExecution`, ` ${id}`);
		}

		if (local && this.tahomaLocal && this.tahomaLocal.authenticated)
		{
			try
			{
				await this.tahomaLocal.cancelExecution(id);
			}
			catch (err)
			{

			}
		}

		if (!this.localOnly && !local && this.tahomaCloud.authenticated)
		{
			try
			{
				await this.tahomaCloud.cancelExecution(id);
			}
			catch (err)
			{

			}
		}
	}

	async executeDeviceAction(label, deviceURL, action, boostSync, action2 = null, forceCloud = false)
	{
		if (this.infoLogEnabled)
		{
			this.logInformation(`${label}: Send command ${deviceURL}`, `command: ${this.varToString(action)}`);
		}

		if (!forceCloud && this.tahomaLocal && this.tahomaLocal.authenticated && this.tahomaLocal.supportedDevices)
		{
			if (this.tahomaLocal.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0)
			{
				try
				{
					const data = await this.tahomaLocal.executeDeviceAction(label, deviceURL, action, action2);
					if (data.errorCode)
					{
						this.homey.app.logInformation(`${label}: onCapabilityHeatingModeState`, `Failed to send local command: ${JSON.stringify(action)}, error = ${data.error} (${data.errorCode})`);
						if (this.isActuatorNoAnswer(data))
						{
							throw (new Error('Actuator did not answer'));
						}
						throw (new Error(data.error));
					}

					data.local = true;
					this.clearCommand400(deviceURL, true);
					return data;
				}
				catch (err)
				{
					if (this.isActuatorNoAnswer(err))
					{
						throw (new Error('Actuator did not answer'));
					}

					if (this.isHttpStatus(err, 400))
					{
						const count = this.recordCommand400(deviceURL, true);
						this.logInformation(`${label}: Local command 400 transient`, `count=${count}, device=${deviceURL}`);
						await this.attemptCommand400Recovery(label, true);
					}

					this.logInformation(`${label}: Local command failed (will try cloud)`, `command: ${this.varToString(action)}, error = ${this.varToString(err)})`);
				}
			}
		}

		if (!forceCloud)
		{
			const currentCredentialsLocalData = await this.tryLocalCommandForCurrentCredentials(label, deviceURL, action, action2);
			if (currentCredentialsLocalData)
			{
				this.clearCommand400(deviceURL, true);
				return currentCredentialsLocalData;
			}

			const sessionLocalData = await this.tryLocalCommandForSession(label, deviceURL, action, action2);
			if (sessionLocalData)
			{
				this.clearCommand400(deviceURL, true);
				return sessionLocalData;
			}
		}

		const cloudClient = await this.getCloudClientForDevice(deviceURL);
		const usingPrimaryCloudClient = (cloudClient === this.tahomaCloud);

		if (cloudClient.authenticated === false)
		{
			if (usingPrimaryCloudClient)
			{
				await this.initSync();
			}

			if (cloudClient.authenticated === false)
			{
				await this.updateConnectivityWarningFromLoginIssue(this.getCurrentLoginBlockIssue());
			}
		}

		if (cloudClient.authenticated && !this.usingDebugData)
		{
			try
			{
				const data = await cloudClient.executeDeviceAction(label, deviceURL, action, action2);
				if (data.errorCode)
				{
					this.homey.app.logInformation(`${this.getName()}: onCapabilityHeatingModeState`, `Failed to send cloud command: ${JSON.stringify(action)}, error = ${data.error} (${data.errorCode})`);
						if (this.isActuatorNoAnswer(data))
						{
							throw (new Error('Actuator did not answer'));
						}
					throw (new Error(data.error));
				}

				data.local = false;
				this.clearCommand400(deviceURL, false);
				if (boostSync)
				{
					this.boostSync();
				}
				return data;
			}
			catch (err)
			{
				let finalError = err;
				if (this.isActuatorNoAnswer(err))
				{
					throw (new Error('Actuator did not answer'));
				}

				if (this.isHttpStatus(err, 400))
				{
					const count = this.recordCommand400(deviceURL, false);
					this.logInformation(`${label}: Cloud command 400 transient`, `count=${count}, device=${deviceURL}`);

					if (count <= 2 && usingPrimaryCloudClient)
					{
						const recovered = await this.attemptCommand400Recovery(label, false);
						if (recovered)
						{
							try
							{
								const retryData = await cloudClient.executeDeviceAction(label, deviceURL, action, action2);
								if (!retryData.errorCode)
								{
									retryData.local = false;
									this.clearCommand400(deviceURL, false);
									if (boostSync)
									{
										this.boostSync();
									}
									return retryData;
								}

								if (this.isActuatorNoAnswer(retryData))
								{
									throw (new Error('Actuator did not answer'));
								}

								throw (new Error(retryData.error || 'Cloud retry command failed'));
							}
							catch (retryError)
							{
								finalError = retryError;
							}
						}
					}
					else
					{
						this.logInformation(`${label}: Cloud command 400 actionable`, `count=${count}, device=${deviceURL}`);
					}
				}

				this.logInformation(`${label}: Cloud command failed`, `command: ${this.varToString(action)}, error = ${this.varToString(finalError)})`);
				throw (finalError);
			}
		}

		this.logInformation(`${label}: Command failed, no valid connections`, `command: ${this.varToString(action)}`);
		await this.updateConnectivityWarningFromLoginIssue(this.getCurrentLoginBlockIssue());
		throw (new Error('Failed to send command, no valid connections'));
	}

	isLoginBlockedIssue(message)
	{
		const text = String(message || '').toLowerCase();
		if (!text)
		{
			return false;
		}

		return (text.indexOf('please leave 1 minutes between login attempts') >= 0)
			|| (text.indexOf('far too many') >= 0)
			|| (text.indexOf('blocked for ') >= 0);
	}

	getCurrentLoginBlockIssue()
	{
		const issueCandidates = [];
		if (this.tahomaCloud && this.tahomaCloud.lastLoginIssue)
		{
			issueCandidates.push(this.tahomaCloud.lastLoginIssue);
		}

		if (this.tahomaLocal && this.tahomaLocal.lastLoginIssue)
		{
			issueCandidates.push(this.tahomaLocal.lastLoginIssue);
		}

		if (this.tahomaCloudsBySession && (typeof this.tahomaCloudsBySession === 'object'))
		{
			for (const cloudClient of Object.values(this.tahomaCloudsBySession))
			{
				if (cloudClient && cloudClient.lastLoginIssue)
				{
					issueCandidates.push(cloudClient.lastLoginIssue);
				}
			}
		}

		for (const issue of issueCandidates)
		{
			if (this.isLoginBlockedIssue(issue))
			{
				return issue;
			}
		}

		return '';
	}

	async setConnectivityWarningForAllDevices(warning)
	{
		const normalizedWarning = warning ? String(warning) : null;
		if (this.currentConnectivityWarning === normalizedWarning)
		{
			return;
		}

		let drivers = {};
		try
		{
			drivers = this.homey.drivers.getDrivers();
		}
		catch (error)
		{
			this.logInformation('setConnectivityWarningForAllDevices getDrivers', error.message ? error.message : error);
			return;
		}

		for (const driver of Object.values(drivers || {}))
		{
			const devices = (driver && (typeof driver.getDevices === 'function')) ? driver.getDevices() : {};
			for (const device of Object.values(devices || {}))
			{
				if (!device || (typeof device.setWarning !== 'function'))
				{
					continue;
				}

				try
				{
					await device.setWarning(normalizedWarning);
				}
				catch (error)
				{
					this.logInformation('setConnectivityWarningForAllDevices setWarning', error.message ? error.message : error);
				}
			}
		}

		this.currentConnectivityWarning = normalizedWarning;
	}

	formatConnectivityWarning(issue)
	{
		const text = String(issue || '');
		const lower = text.toLowerCase();
		if (lower.indexOf('please leave 1 minutes between login attempts') >= 0)
		{
			return 'App offline: login is rate-limited. Retrying soon.';
		}

		const buildBlockedUntilMessage = (untilDate) =>
		{
			if (!(untilDate instanceof Date) || Number.isNaN(untilDate.getTime()))
			{
				return 'Sorry, login is temporarily blocked.';
			}

			const now = new Date();
			const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
			const tomorrowDate = new Date(now.getTime());
			tomorrowDate.setDate(tomorrowDate.getDate() + 1);
			const tomorrowKey = `${tomorrowDate.getFullYear()}-${tomorrowDate.getMonth()}-${tomorrowDate.getDate()}`;
			const untilKey = `${untilDate.getFullYear()}-${untilDate.getMonth()}-${untilDate.getDate()}`;

			let dayLabel = 'soon';
			if (untilKey === todayKey)
			{
				dayLabel = 'today';
			}
			else if (untilKey === tomorrowKey)
			{
				dayLabel = 'tomorrow';
			}

			const hours = String(untilDate.getHours()).padStart(2, '0');
			const minutes = String(untilDate.getMinutes()).padStart(2, '0');
			const timeText = `${hours}:${minutes}`;
			return `Sorry, login is blocked until ${timeText} ${dayLabel}.`;
		};

		if (lower.indexOf('far too many') >= 0)
		{
			let blockedMs = 0;
			if (lower.indexOf('15 minutes') >= 0)
			{
				blockedMs = 15 * 60 * 1000;
			}
			else if (lower.indexOf('24 hours') >= 0)
			{
				blockedMs = 24 * 60 * 60 * 1000;
			}

			if (blockedMs > 0)
			{
				return buildBlockedUntilMessage(new Date(Date.now() + blockedMs));
			}

			return 'Sorry, login is temporarily blocked.';
		}

		const blockedMatch = lower.match(/blocked for\s+(\d+)s/);
		if (blockedMatch)
		{
			const seconds = Number(blockedMatch[1]);
			if (Number.isFinite(seconds) && seconds > 0)
			{
				return buildBlockedUntilMessage(new Date(Date.now() + (seconds * 1000)));
			}
		}

		return 'App offline: login is temporarily unavailable. Retrying automatically.';
	}

	async updateConnectivityWarningFromLoginIssue(issue)
	{
		const blockedIssue = this.isLoginBlockedIssue(issue) ? issue : this.getCurrentLoginBlockIssue();
		if (!blockedIssue)
		{
			if (this.currentConnectivityWarning)
			{
				this.logInformation('Connectivity warning cleared', 'Login connectivity restored');
			}
			await this.setConnectivityWarningForAllDevices(null);
			return;
		}

		const userWarning = this.formatConnectivityWarning(blockedIssue);
		if (this.currentConnectivityWarning !== userWarning)
		{
			this.logInformation('Connectivity warning active', blockedIssue);
		}

		await this.setConnectivityWarningForAllDevices(userWarning);
	}

	async getDeviceStates(deviceURL)
	{
		if (this.tahomaLocal && this.tahomaLocal.authenticated && this.tahomaLocal.supportedDevices)
		{
			// Check if the local connection supports the device
			if (this.tahomaLocal.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0)
			{
				const states = await this.tahomaLocal.getDeviceStates(deviceURL);
				if (states)
				{
					if (this.infoLogEnabled)
					{
						this.logDeviceStatesDelta('Device local states', deviceURL, states);
					}

					return states;
				}
			}
		}

		const preferredSessionUsername = this.getDeviceSessionUsername(deviceURL);
		if (await this.ensureLocalConnectionForDevice(deviceURL, preferredSessionUsername))
		{
			const states = await this.tahomaLocal.getDeviceStates(deviceURL);
			if (states)
			{
				if (this.infoLogEnabled)
				{
					this.logDeviceStatesDelta('Device routed local states', deviceURL, states);
				}

				return states;
			}
		}

		const cloudClient = await this.getCloudClientForDevice(deviceURL);
		if (!cloudClient.authenticated && (cloudClient === this.tahomaCloud))
		{
			// Try to login to the cloud first
			await this.initSync();
		}

		if (cloudClient.authenticated && !this.usingDebugData)
		{
			const states = await cloudClient.getDeviceStates(deviceURL);
			if (this.infoLogEnabled)
			{
				this.logDeviceStatesDelta('Device cloud states', deviceURL, states);
			}

			// Make sure we are not in local only mode as this device is cloud only
			this.localOnly = false;
			return states;
		}

		return null;
	}

	async getDeviceData()
	{
		let data = null;
		if (this.tahomaLocal)
		{
			const localByKey = new Map();
			const bridges = this.getDiscoveredLocalBridges();

			for (const bridge of bridges)
			{
				const bridgeCandidates = this.getCandidateCredentialsForLocalRouting('', bridge ? bridge.pin : '');
				for (const candidate of bridgeCandidates)
				{
					try
					{
						const localClientForBridge = this.getLocalClientForBridge(bridge);
						const ok = await this.doLocalLoginForClient(localClientForBridge, candidate.username, candidate.password, candidate.region, candidate.localToken || null, bridge, false, true, false);
						if (!ok || !localClientForBridge || !localClientForBridge.authenticated)
						{
							continue;
						}

						const bridgeData = await localClientForBridge.getDeviceData();
						if (!Array.isArray(bridgeData) || (bridgeData.length === 0))
						{
							continue;
						}

						for (const entry of bridgeData)
						{
							if (!entry || !entry.deviceURL)
							{
								continue;
							}

							const key = `${entry.deviceURL}|${entry.controllableName || ''}`;
							if (!localByKey.has(key))
							{
								localByKey.set(key, entry);
							}
						}

						break;
					}
					catch (error)
					{
						this.logInformation('getDeviceData local bridge', error.message ? error.message : error);
					}
				}
			}

			if (localByKey.size > 0)
			{
				data = [...localByKey.values()];
			}
			else if (this.tahomaLocal && this.tahomaLocal.authenticated)
			{
				// Fallback to current local connection if present
				data = await this.tahomaLocal.getDeviceData();
			}
		}
		if (!this.tahomaCloud.authenticated)
		{
			// Try to login to the cloud first
			await this.initSync();
		}

		if (this.tahomaCloud.authenticated)
		{
			// Get the cloud data, as it will support devices not available in the local connection
			const cloudData = await this.tahomaCloud.getDeviceData();
			const sessionUsernameForCloudData = this.tahomaCloud && this.tahomaCloud.username
				? this.tahomaCloud.username
				: this.homey.settings.get('username');
			if (sessionUsernameForCloudData)
			{
				this.linkSessionToBridgePinsFromDevices(sessionUsernameForCloudData, cloudData);
			}

			if (data)
			{
				// join the local and cloud data but remove duplicates
				if (Array.isArray(data) && Array.isArray(cloudData))
				{
					// Filter cloud devices to remove local devices
					const unique = cloudData.filter((cloud) =>
					{
						const isDuplicate = (data.findIndex((local) => (local.deviceURL === cloud.deviceURL) && (local.controllableName === cloud.controllableName)) >= 0);

						if (!isDuplicate)
						{
							return true;
						}

						return false;
					});

					data = data.concat(unique);
				}
			}
			else
			{
				data = cloudData;
			}
		}

		return data;
	}

	upsertDiscoveredLocalBridge(bridgeInfo)
	{
		if (!bridgeInfo || !bridgeInfo.pin)
		{
			return;
		}

		const normalizedPin = this.normalizeBridgePin(bridgeInfo.pin);
		if (!normalizedPin)
		{
			return;
		}

		const normalizedBridgeInfo = {
			...bridgeInfo,
			pin: normalizedPin,
		};

		if (!Array.isArray(this.localBridges))
		{
			this.localBridges = [];
		}

		const idx = this.localBridges.findIndex((bridge) => bridge && this.normalizeBridgePin(bridge.pin) === normalizedPin);
		if (idx >= 0)
		{
			this.localBridges[idx] = { ...this.localBridges[idx], ...normalizedBridgeInfo };
		}
		else
		{
			this.localBridges.push({ ...normalizedBridgeInfo });
		}

		this.homey.settings.set('localBridges', this.localBridges);
	}

	normalizeMdnsHost(hostValue)
	{
		if (!hostValue)
		{
			return '';
		}

		let normalizedHost = `${hostValue}`.trim().toLowerCase();
		if (!normalizedHost)
		{
			return '';
		}

		if (normalizedHost.includes('://'))
		{
			try
			{
				const parsed = new URL(normalizedHost);
				normalizedHost = parsed.hostname || '';
			}
			catch (error)
			{
				normalizedHost = normalizedHost.split('/')[0];
			}
		}

		normalizedHost = normalizedHost.split('/')[0];
		if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']'))
		{
			normalizedHost = normalizedHost.slice(1, -1);
		}

		if (normalizedHost.indexOf(':') >= 0)
		{
			const parts = normalizedHost.split(':');
			if (parts.length === 2 && /^\d+$/.test(parts[1]))
			{
				normalizedHost = parts[0];
			}
		}

		normalizedHost = normalizedHost.replace(/\.+$/, '');
		return normalizedHost;
	}

	getMdnsHostCandidatesForBridge(bridgeInfo)
	{
		const candidates = new Set();
		if (!bridgeInfo)
		{
			return candidates;
		}

		const bridgePin = this.normalizeBridgePin(bridgeInfo.pin);
		if (bridgePin)
		{
			candidates.add(`gateway-${bridgePin}.local`);
			candidates.add(`${bridgePin}.local`);
		}

		const normalizedUrlHost = this.normalizeMdnsHost(bridgeInfo.url);
		if (normalizedUrlHost)
		{
			candidates.add(normalizedUrlHost);
		}

		return candidates;
	}

	upsertLocalMdnsLookup(bridgeInfo, persist = true)
	{
		if (!bridgeInfo || !bridgeInfo.address)
		{
			return false;
		}

		const mappedIp = `${bridgeInfo.address}`.trim();
		if (!net.isIP(mappedIp))
		{
			return false;
		}

		const hosts = this.getMdnsHostCandidatesForBridge(bridgeInfo);
		if (hosts.size === 0)
		{
			return false;
		}

		let changed = false;
		for (const host of hosts)
		{
			const normalizedHost = this.normalizeMdnsHost(host);
			if (!normalizedHost)
			{
				continue;
			}

			if (this.localMdnsLookup[normalizedHost] !== mappedIp)
			{
				this.localMdnsLookup[normalizedHost] = mappedIp;
				changed = true;
			}
		}

		if (changed && persist)
		{
			this.homey.settings.set('localMdnsLookup', this.localMdnsLookup);
		}

		return changed;
	}

	resolveMdnsHostname(hostname)
	{
		const normalizedHost = this.normalizeMdnsHost(hostname);
		if (!normalizedHost)
		{
			return '';
		}

		const mappedIp = this.localMdnsLookup && this.localMdnsLookup[normalizedHost];
		if (mappedIp && net.isIP(mappedIp))
		{
			return mappedIp;
		}

		for (const bridge of this.getDiscoveredLocalBridges())
		{
			if (!bridge || !bridge.address || !net.isIP(bridge.address))
			{
				continue;
			}

			const hostCandidates = this.getMdnsHostCandidatesForBridge(bridge);
			if (hostCandidates.has(normalizedHost))
			{
				this.upsertLocalMdnsLookup(bridge);
				return bridge.address;
			}
		}

		return '';
	}

	normalizeBridgePin(pin)
	{
		if (!pin)
		{
			return '';
		}

		const normalized = `${pin}`.trim();
		if (!/^\d{4}-\d{4}-\d{4}$/.test(normalized))
		{
			return '';
		}

		return normalized;
	}

	getBridgePinFromDeviceURL(deviceURL)
	{
		if (!deviceURL)
		{
			return '';
		}

		const matches = `${deviceURL}`.match(/^[a-z0-9_+.-]+:\/\/(\d{4}-\d{4}-\d{4})\//i);
		if (!matches || !matches[1])
		{
			return '';
		}

		return this.normalizeBridgePin(matches[1]);
	}

	getBridgeByPin(pin)
	{
		const normalizedPin = this.normalizeBridgePin(pin);
		if (!normalizedPin)
		{
			return null;
		}

		const bridges = this.getDiscoveredLocalBridges();
		const idx = bridges.findIndex((bridge) => bridge && this.normalizeBridgePin(bridge.pin) === normalizedPin);
		if (idx < 0)
		{
			return null;
		}

		return bridges[idx];
	}

	getLocalClientForBridge(bridgeInfo)
	{
		if (!this.homeyIP)
		{
			return null;
		}

		const normalizedPin = this.normalizeBridgePin(bridgeInfo && bridgeInfo.pin ? bridgeInfo.pin : '');
		if (!normalizedPin)
		{
			return this.tahomaLocal || null;
		}

		if (!this.tahomaLocalsByPin || (typeof this.tahomaLocalsByPin !== 'object'))
		{
			this.tahomaLocalsByPin = {};
		}

		if (!this.tahomaLocalsByPin[normalizedPin])
		{
			this.tahomaLocalsByPin[normalizedPin] = new Tahoma(this.homey, true);
		}

		return this.tahomaLocalsByPin[normalizedPin];
	}

	getDiscoveredLocalBridges()
	{
		if (!Array.isArray(this.localBridges))
		{
			this.localBridges = this.homey.settings.get('localBridges');
			if (!Array.isArray(this.localBridges))
			{
				this.localBridges = [];
			}
		}

		if (this.localBridgeInfo && this.localBridgeInfo.pin)
		{
			this.upsertDiscoveredLocalBridge(this.localBridgeInfo);
		}

		return this.localBridges;
	}

	getDeviceSessionUsername(deviceURL)
	{
		try
		{
			const drivers = this.homey.drivers.getDrivers();
			for (const driver of Object.values(drivers))
			{
				const devices = (driver && (typeof driver.getDevices === 'function')) ? driver.getDevices() : {};
				for (const device of Object.values(devices))
				{
					const data = (device && (typeof device.getData === 'function')) ? device.getData() : null;
					if (!data || !data.deviceURL)
					{
						continue;
					}

					if ((data.deviceURL === deviceURL) || (deviceURL && data.deviceURL && data.deviceURL.startsWith(`${deviceURL}#`)) || (data.deviceURL && data.deviceURL.indexOf('#') > 0 && data.deviceURL.split('#')[0] === deviceURL))
					{
						const settings = (typeof device.getSettings === 'function') ? device.getSettings() : {};
						const sessionUsername = settings ? settings.sessionUsername : null;
						return this.normalizeSessionEmail(sessionUsername);
					}
				}
			}
		}
		catch (error)
		{
			this.logInformation('getDeviceSessionUsername', error.message ? error.message : error);
		}

		return '';
	}

	getCandidateCredentialsForLocalRouting(preferredSessionUsername = '', preferredBridgePin = '')
	{
		if (typeof this.ensureCredentialsFromSessions === 'function')
		{
			this.ensureCredentialsFromSessions();
		}

		const candidates = [];
		const seen = new Set();

		const addCandidate = (username, password, region, localToken) =>
		{
			const normalized = this.normalizeSessionEmail(username);
			if (!normalized || !password)
			{
				return;
			}

			const key = `${normalized}|${region || 'europe'}`;
			if (seen.has(key))
			{
				return;
			}

			seen.add(key);
			candidates.push({
				username: normalized,
				password,
				region: region || 'europe',
				localToken: localToken || '',
			});
		};

		const normalizedPreferredBridgePin = this.normalizeBridgePin(preferredBridgePin || '');
		const sessions = this.getAccountSessions();
		let bridgeScopedSessionUsernames = null;
		if (normalizedPreferredBridgePin)
		{
			bridgeScopedSessionUsernames = new Set(
				sessions
					.filter((session) => this.doesSessionMatchBridgePin(session, normalizedPreferredBridgePin))
					.map((session) => this.normalizeSessionEmail(session.username))
					.filter((username) => !!username),
			);
		}

		const preferred = preferredSessionUsername ? this.getSessionByEmail(preferredSessionUsername) : null;
		if (preferred && preferred.password)
		{
			addCandidate(preferred.username, preferred.password, preferred.region, preferred.localToken);
		}

		addCandidate(this.homey.settings.get('username'), this.homey.settings.get('password'), this.homey.settings.get('region'), this.homey.settings.get('localToken'));

		for (const session of sessions)
		{
			if (session && session.password)
			{
				addCandidate(session.username, session.password, session.region, session.localToken);
			}
		}

		if (bridgeScopedSessionUsernames)
		{
			if (bridgeScopedSessionUsernames.size === 0)
			{
				return [];
			}

			return candidates.filter((candidate) => bridgeScopedSessionUsernames.has(candidate.username));
		}

		return candidates;
	}

	async ensureLocalConnectionForDevice(deviceURL, preferredSessionUsername = '')
	{
		if (!this.tahomaLocal)
		{
			return false;
		}

		if (this.tahomaLocal.authenticated && this.tahomaLocal.supportedDevices && (this.tahomaLocal.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0))
		{
			return true;
		}

		const bridges = this.getDiscoveredLocalBridges();
		const deviceBridgePin = this.getBridgePinFromDeviceURL(deviceURL);
		const preferredBridge = deviceBridgePin ? this.getBridgeByPin(deviceBridgePin) : null;
		const prioritizedBridges = preferredBridge
			? [preferredBridge, ...bridges.filter((bridge) => !bridge || (this.normalizeBridgePin(bridge.pin) !== this.normalizeBridgePin(preferredBridge.pin)))]
			: bridges;

		for (const bridge of prioritizedBridges)
		{
			const candidates = this.getCandidateCredentialsForLocalRouting(preferredSessionUsername, bridge ? bridge.pin : '');
			for (const candidate of candidates)
			{
				try
				{
					const localClientForBridge = this.getLocalClientForBridge(bridge);
					const ok = await this.doLocalLoginForClient(localClientForBridge, candidate.username, candidate.password, candidate.region, candidate.localToken || null, bridge, false, true, false);
					if (!ok || !localClientForBridge || !localClientForBridge.authenticated || !localClientForBridge.supportedDevices)
					{
						continue;
					}

					if (localClientForBridge.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0)
					{
						this.localBridgeInfo = bridge;
						this.homey.settings.set('localBridge', this.localBridgeInfo);
						this.tahomaLocal = localClientForBridge;
						this.localAuthenticatedBridgePin = this.normalizeBridgePin(bridge.pin);
						return true;
					}
				}
				catch (error)
				{
					this.logInformation('ensureLocalConnectionForDevice', error.message ? error.message : error);
				}
			}
		}

		return false;
	}

	doesSessionMatchBridgePin(session, bridgePin)
	{
		if (!session || !bridgePin)
		{
			return false;
		}

		const normalizedBridgePin = this.normalizeBridgePin(bridgePin);
		if (!normalizedBridgePin)
		{
			return false;
		}

		const bridgePins = Array.isArray(session.bridgePins) ? session.bridgePins : [];
		return bridgePins.some((pin) => this.normalizeBridgePin(pin) === normalizedBridgePin);
	}

	linkSessionToBridgePin(username, bridgePin)
	{
		const normalizedUsername = this.normalizeSessionEmail(username);
		const normalizedBridgePin = this.normalizeBridgePin(bridgePin);
		if (!normalizedUsername || !normalizedBridgePin)
		{
			return false;
		}

		const sessions = this.getAccountSessions();
		const idx = sessions.findIndex((session) => this.normalizeSessionEmail(session.username) === normalizedUsername);
		if (idx < 0)
		{
			return false;
		}

		const existingPins = Array.isArray(sessions[idx].bridgePins) ? sessions[idx].bridgePins : [];
		const normalizedPins = existingPins
			.map((pin) => this.normalizeBridgePin(pin))
			.filter((pin) => !!pin);

		if (normalizedPins.includes(normalizedBridgePin))
		{
			return false;
		}

		sessions[idx] = {
			...sessions[idx],
			bridgePins: [...normalizedPins, normalizedBridgePin],
		};
		this.saveAccountSessions(sessions);
		return true;
	}

	linkSessionToBridgePinsFromDevices(username, devices)
	{
		if (!Array.isArray(devices) || !username)
		{
			return 0;
		}

		const linkedPins = new Set();
		for (const device of devices)
		{
			const pin = this.getBridgePinFromDeviceURL(device && device.deviceURL ? device.deviceURL : '');
			if (!pin)
			{
				continue;
			}

			if (this.linkSessionToBridgePin(username, pin))
			{
				linkedPins.add(pin);
			}
		}

		return linkedPins.size;
	}

	async tryLocalCommandForSession(label, deviceURL, action, action2)
	{
		if (!this.tahomaLocal)
		{
			return null;
		}

		const sessionUsername = this.getDeviceSessionUsername(deviceURL);
		if (!sessionUsername)
		{
			return null;
		}

		const session = this.getSessionByEmail(sessionUsername);
		if (!session || !session.password)
		{
			return null;
		}

		const bridges = this.getDiscoveredLocalBridges();
		const deviceBridgePin = this.getBridgePinFromDeviceURL(deviceURL);
		const preferredBridge = deviceBridgePin ? this.getBridgeByPin(deviceBridgePin) : null;
		const prioritizedBridges = preferredBridge
			? [preferredBridge, ...bridges.filter((bridge) => !bridge || (this.normalizeBridgePin(bridge.pin) !== this.normalizeBridgePin(preferredBridge.pin)))]
			: bridges;

		for (const bridge of prioritizedBridges)
		{
			try
			{
				const localClientForBridge = this.getLocalClientForBridge(bridge);
				const ok = await this.doLocalLoginForClient(localClientForBridge, session.username, session.password, session.region || 'europe', session.localToken || null, bridge, false, true, false);
				if (!ok || !localClientForBridge || !localClientForBridge.authenticated || !localClientForBridge.supportedDevices)
				{
					continue;
				}

				const supportsDevice = localClientForBridge.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0;
				if (!supportsDevice)
				{
					continue;
				}

				this.localBridgeInfo = bridge;
				this.homey.settings.set('localBridge', this.localBridgeInfo);

				const data = await localClientForBridge.executeDeviceAction(label, deviceURL, action, action2);
				if (data.errorCode)
				{
					continue;
				}

				data.local = true;
				return data;
			}
			catch (error)
			{
				this.logInformation(`${label}: session local attempt failed`, error.message ? error.message : error);
			}
		}

		return null;
	}

	async tryLocalCommandForCurrentCredentials(label, deviceURL, action, action2)
	{
		if (!this.tahomaLocal)
		{
			return null;
		}

		const bridgePin = this.getBridgePinFromDeviceURL(deviceURL);
		if (!bridgePin)
		{
			return null;
		}

		const bridge = this.getBridgeByPin(bridgePin);
		if (!bridge)
		{
			return null;
		}

		if (typeof this.ensureCredentialsFromSessions === 'function')
		{
			this.ensureCredentialsFromSessions();
		}

		const username = this.homey.settings.get('username');
		const password = this.homey.settings.get('password');
		const region = this.homey.settings.get('region') || 'europe';
		if (!username || !password)
		{
			return null;
		}

		try
		{
			const localClientForBridge = this.getLocalClientForBridge(bridge);
			const ok = await this.doLocalLoginForClient(localClientForBridge, username, password, region, null, bridge, false, true, false);
			if (!ok || !localClientForBridge || !localClientForBridge.authenticated || !localClientForBridge.supportedDevices)
			{
				return null;
			}

			const supportsDevice = localClientForBridge.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0;
			if (!supportsDevice)
			{
				return null;
			}

			this.localBridgeInfo = bridge;
			this.homey.settings.set('localBridge', this.localBridgeInfo);

			const data = await localClientForBridge.executeDeviceAction(label, deviceURL, action, action2);
			if (data.errorCode)
			{
				return null;
			}

			data.local = true;
			return data;
		}
		catch (error)
		{
			this.logInformation(`${label}: current-credentials local attempt failed`, error.message ? error.message : error);
		}

		return null;
	}

	isLocalDevice(deviceURL, combineSubURLs)
	{
		if (this.tahomaLocal && this.tahomaLocal.authenticated && this.tahomaLocal.supportedDevices)
		{
			// Check if the local connection supports the device
			if (combineSubURLs)
			{
				if (this.tahomaLocal.supportedDevices.findIndex((element) => element.deviceURL.startsWith(deviceURL)))
				{
					return true;
				}
			}
			else
				if (this.tahomaLocal.supportedDevices.findIndex((element) => element.deviceURL === deviceURL) >= 0)
				{
					return true;
				}
		}

		return false;
	}

	isLoggedIn()
	{
		const cloudLoggedIn = (this.tahomaCloud && this.tahomaCloud.authenticated)
			|| (this.tahomaCloudsBySession && Object.values(this.tahomaCloudsBySession).some((client) => client && client.authenticated));

		return (cloudLoggedIn || (this.tahomaLocal && this.tahomaLocal.authenticated));
	}

	normalizeSessionEmail(username)
	{
		if (!username)
		{
			return '';
		}

		return `${username}`.trim().toLowerCase();
	}

	isValidSessionEmail(username)
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!normalized)
		{
			return false;
		}

		return (/^[^\s@]+@[^\s@]+\.[^\s@]+$/).test(normalized);
	}

	getAccountSessions()
	{
		const sessions = this.homey.settings.get('accountSessions');
		if (!Array.isArray(sessions))
		{
			return [];
		}

		return sessions;
	}

	saveAccountSessions(sessions)
	{
		this.homey.settings.set('accountSessions', sessions);
	}

	getSessionByEmail(username)
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!normalized)
		{
			return null;
		}

		const sessions = this.getAccountSessions();
		const idx = sessions.findIndex((session) => this.normalizeSessionEmail(session.username) === normalized);
		if (idx < 0)
		{
			return null;
		}

		return sessions[idx];
	}

	upsertAccountSession({
		username, password, region, localToken,
	})
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!this.isValidSessionEmail(normalized))
		{
			throw new Error('Please enter a valid email address');
		}

		const sessions = this.getAccountSessions();
		const now = Date.now();
		const idx = sessions.findIndex((session) => this.normalizeSessionEmail(session.username) === normalized);

		if (idx >= 0)
		{
			const existingPins = Array.isArray(sessions[idx].bridgePins) ? sessions[idx].bridgePins : [];
			const normalizedPins = existingPins
				.map((pin) => this.normalizeBridgePin(pin))
				.filter((pin) => !!pin);
			sessions[idx] = {
				...sessions[idx],
				username: normalized,
				password: password === undefined ? sessions[idx].password : password,
				region: region || sessions[idx].region || 'europe',
				localToken: localToken === undefined ? sessions[idx].localToken : localToken,
				bridgePins: normalizedPins,
				lastUsed: now,
			};
			this.saveAccountSessions(sessions);
			return sessions[idx];
		}

		const session = {
			id: this.hashCode(`${normalized}:${now.toString()}:${Math.random().toString(36)}`).toString(),
			username: normalized,
			password,
			region: region || 'europe',
			localToken: localToken || '',
			bridgePins: [],
			lastUsed: now,
		};

		sessions.push(session);
		this.saveAccountSessions(sessions);
		return session;
	}

	getPairingSessions()
	{
		this.migrateLegacyCredentialsToSessions();

		return this.getAccountSessions().map((session) => ({
			username: session.username,
			region: session.region,
			lastUsed: session.lastUsed,
		}));
	}

	// Account list for the Settings page dropdown (no passwords).
	getAccountSessionsForSettings()
	{
		this.migrateLegacyCredentialsToSessions();
		const primaryUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));

		return this.getAccountSessions().map((session) => ({
			username: session.username,
			region: session.region || 'europe',
			hasLocalToken: !!(session.localToken && `${session.localToken}`.trim()),
			isPrimary: (this.normalizeSessionEmail(session.username) === primaryUsername) && !!primaryUsername,
			lastUsed: session.lastUsed,
		}));
	}

	// Full details (including password) for the Settings page edit/add popup.
	getAccountSessionDetails(username)
	{
		const normalized = this.normalizeSessionEmail(username);
		const primaryUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		const session = normalized ? this.getSessionByEmail(normalized) : null;

		if (!session)
		{
			return {
				username: normalized || '', password: '', region: 'europe', localToken: '', isPrimary: false,
			};
		}

		return {
			username: session.username,
			password: session.password || '',
			region: session.region || 'europe',
			localToken: session.localToken || '',
			isPrimary: (this.normalizeSessionEmail(session.username) === primaryUsername) && !!primaryUsername,
		};
	}

	// Adds/updates an account from the Settings page popup. Only ever switches the app's
	// single primary/active account (Settings' username/password) when explicitly requested,
	// when it is editing the current primary, or when there is no primary configured yet.
	async saveAccountSession({
		originalUsername, username, password, region, localToken, setPrimary,
	})
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!this.isValidSessionEmail(normalized))
		{
			throw new Error('Please enter a valid email address');
		}

		if (!password)
		{
			throw new Error('Please enter a password');
		}

		const normalizedOriginal = originalUsername ? this.normalizeSessionEmail(originalUsername) : '';
		const currentPrimaryUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		const wasPrimary = !!(normalizedOriginal && (normalizedOriginal === currentPrimaryUsername));
		const shouldBePrimary = !!setPrimary || wasPrimary || !currentPrimaryUsername;

		if (normalizedOriginal && (normalizedOriginal !== normalized))
		{
			this.removeAccountSession(normalizedOriginal, { force: true, clearGlobalCredentials: false });
		}

		if (shouldBePrimary)
		{
			const authenticated = await this.newLogin_2(normalized, password, region, localToken, true);
			if (!authenticated)
			{
				throw new Error('Unable to authenticate with Somfy cloud or the local bridge');
			}
		}
		else
		{
			const authenticated = await this.ensureCloudSessionAuthenticated(normalized, password, region || 'europe', true, 'settings-save-account');
			if (!authenticated)
			{
				throw new Error('Unable to authenticate with Somfy cloud');
			}
		}

		this.upsertAccountSession({
			username: normalized, password, region, localToken,
		});

		return this.getAccountSessionDetails(normalized);
	}

	// Deletes a saved account. If it was the primary/active account, promotes the most
	// recently used remaining account to primary (if any are left).
	async deleteAccountSession(username, force = false)
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!this.isValidSessionEmail(normalized))
		{
			throw new Error('Please enter a valid email address');
		}

		const result = this.removeAccountSession(normalized, { force, clearGlobalCredentials: true });
		if (result && result.removed)
		{
			if (this.tahomaCloudsBySession && this.tahomaCloudsBySession[normalized])
			{
				delete this.tahomaCloudsBySession[normalized];
			}

			const currentPrimaryUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
			if (currentPrimaryUsername === normalized)
			{
				const remaining = this.getAccountSessions()
					.filter((session) => session && session.password)
					.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

				if (remaining.length > 0)
				{
					const next = remaining[0];
					try
					{
						await this.newLogin_2(next.username, next.password, next.region, next.localToken, true);
					}
					catch (error)
					{
						this.logInformation('deleteAccountSession promote next primary', error.message ? error.message : error);
					}
				}
			}
		}

		return result;
	}

	getSessionUsage(username)
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!this.isValidSessionEmail(normalized))
		{
			return {
				inUse: false,
				globalCredentialsMatch: false,
				deviceCount: 0,
				devices: [],
			};
		}

		const devicesUsingSession = [];

		try
		{
			const drivers = this.homey.drivers.getDrivers();
			for (const [driverId, driver] of Object.entries(drivers))
			{
				const devices = (driver && (typeof driver.getDevices === 'function')) ? driver.getDevices() : {};
				for (const device of Object.values(devices))
				{
					let matched = false;
					try
					{
						const settings = (device && (typeof device.getSettings === 'function')) ? device.getSettings() : {};
						const data = (device && (typeof device.getData === 'function')) ? device.getData() : {};

						const sessionCandidates = [
							settings.username,
							settings.email,
							settings.accountEmail,
							settings.sessionEmail,
							settings.sessionUsername,
							data.username,
							data.email,
						];

						matched = sessionCandidates.some((candidate) => this.normalizeSessionEmail(candidate) === normalized);
					}
					catch (error)
					{
						this.logInformation('getSessionUsage device inspect', error.message ? error.message : error);
					}

					if (matched)
					{
						devicesUsingSession.push({
							driverId,
							name: (device && (typeof device.getName === 'function')) ? device.getName() : 'Unknown device',
							id: (device && (typeof device.getData === 'function') && device.getData()) ? device.getData().id : null,
						});
					}
				}
			}
		}
		catch (error)
		{
			this.logInformation('getSessionUsage', error.message ? error.message : error);
		}

		const currentUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		const globalCredentialsMatch = (currentUsername === normalized);

		return {
			inUse: globalCredentialsMatch || (devicesUsingSession.length > 0),
			globalCredentialsMatch,
			deviceCount: devicesUsingSession.length,
			devices: devicesUsingSession,
		};
	}

	removeAccountSession(username, options = {})
	{
		const force = !!(options && options.force);
		const clearGlobalCredentials = !!(options && options.clearGlobalCredentials);
		const normalized = this.normalizeSessionEmail(username);

		if (!this.isValidSessionEmail(normalized))
		{
			throw new Error('Please enter a valid email address');
		}

		const sessions = this.getAccountSessions();
		const idx = sessions.findIndex((session) => this.normalizeSessionEmail(session.username) === normalized);
		if (idx < 0)
		{
			return {
				removed: false,
				notFound: true,
				usage: this.getSessionUsage(normalized),
			};
		}

		const usage = this.getSessionUsage(normalized);
		if (usage.inUse && !force)
		{
			return {
				removed: false,
				inUse: true,
				usage,
			};
		}

		sessions.splice(idx, 1);
		this.saveAccountSessions(sessions);

		const currentUsername = this.normalizeSessionEmail(this.homey.settings.get('username'));
		if (clearGlobalCredentials && (currentUsername === normalized))
		{
			this.homey.settings.unset('username');
			this.homey.settings.unset('password');
		}

		return {
			removed: true,
			forced: force,
			usage,
		};
	}

	async autoRemoveUnusedSession(username)
	{
		const normalized = this.normalizeSessionEmail(username);
		if (!this.isValidSessionEmail(normalized))
		{
			return {
				removed: false,
				reason: 'invalid_username',
			};
		}

		const usage = this.getSessionUsage(normalized);
		if (usage.deviceCount > 0)
		{
			return {
				removed: false,
				reason: 'still_used_by_devices',
				usage,
			};
		}

		const removal = this.removeAccountSession(normalized,
			{
				force: true,
				clearGlobalCredentials: false,
			});
		return {
			...removal,
			autoRemoved: !!(removal && removal.removed),
		};
	}

	ensureCredentialsFromSessions()
	{
		try
		{
			const currentUsername = this.homey.settings.get('username');
			const currentPassword = this.homey.settings.get('password');
			if (currentUsername && currentPassword)
			{
				return false;
			}

			const sessions = this.getAccountSessions();
			if (!Array.isArray(sessions) || (sessions.length === 0))
			{
				return false;
			}

			const candidates = sessions
				.filter((session) => session && this.isValidSessionEmail(session.username) && session.password)
				.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

			if (candidates.length === 0)
			{
				return false;
			}

			const selected = candidates[0];
			this.homey.settings.set('username', this.normalizeSessionEmail(selected.username));
			this.homey.settings.set('password', selected.password);
			this.homey.settings.set('region', selected.region || 'europe');

			this.logInformation('ensureCredentialsFromSessions', `Recovered credentials for ${this.normalizeSessionEmail(selected.username)}`);
			return true;
		}
		catch (error)
		{
			this.logInformation('ensureCredentialsFromSessions', error.message ? error.message : error);
		}

		return false;
	}

	migrateLegacyCredentialsToSessions()
	{
		try
		{
			const username = this.homey.settings.get('username');
			const password = this.homey.settings.get('password');
			const region = this.homey.settings.get('region') || 'europe';

			if (!username || !password)
			{
				return;
			}

			const existing = this.getSessionByEmail(username);
			if (!existing)
			{
				this.upsertAccountSession({ username, password, region });
			}
		}
		catch (error)
		{
			this.logInformation('migrateLegacyCredentialsToSessions', error.message ? error.message : error);
		}
	}

}
module.exports = myApp;
