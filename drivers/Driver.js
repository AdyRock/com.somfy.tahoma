/* eslint-disable no-tabs */
/* eslint-disable no-nested-ternary */
/* jslint node: true */

'use strict';

const Homey = require('homey');
/**
 * Base class for drivers
 * @class
 * @extends {Homey.Driver}
 */
class Driver extends Homey.Driver
{

	logInformationSafe(context, details)
	{
		try
		{
			const { app } = this.homey;
			if (app && (typeof app.logInformation === 'function'))
			{
				app.logInformation(context, details);
				return;
			}
		}
		catch (err)
		{
			// App is shutting down or already destroyed.
		}

		this.error(context, details);
	}

	async onInit()
	{
		/** * Command Complete ** */
		this._triggerCommandComplete = this.homey.flow.getDeviceTriggerCard('device_command_complete');
	}

	triggerDeviceCommandComplete(device, commandName, success)
	{
		const tokens = { state: success, name: commandName };
		this.triggerFlow(this._triggerCommandComplete, device, tokens);
		return this;
	}

	async onPair(session)
	{
		let username = '';
		let password = '';
		let region = this.homey.settings.get('region');
		let selectedExistingSession = false;
		const originalPrimaryUsername = this.homey.settings.get('username');
		const originalPrimaryPassword = this.homey.settings.get('password');
		const originalPrimaryRegion = this.homey.settings.get('region');

		session.setHandler('disconnect', async () =>
		{
			// Pairing can temporarily switch the app's "active" cloud session to a
			// different (secondary) account so its devices can be listed. Restore the
			// original primary account once the pairing wizard closes so devices/settings
			// tied to the primary account keep working afterwards.
			if (originalPrimaryUsername && username && (typeof this.homey.app.restorePrimaryCloudSession === 'function'))
			{
				try
				{
					await this.homey.app.restorePrimaryCloudSession(originalPrimaryUsername, originalPrimaryPassword, originalPrimaryRegion);
				}
				catch (error)
				{
					this.error('Failed to restore primary session after pairing', error);
				}
			}
		});

		session.setHandler('showView', async (view) =>
		{
			if (view === 'login_credentials')
			{
				if (selectedExistingSession && username && password)
				{
					await session.nextView();
				}
			}
		});

		session.setHandler('sessions_list', async () =>
		{
			if (typeof this.homey.app.getPairingSessions === 'function')
			{
				return this.homey.app.getPairingSessions();
			}

			return [];
		});

		session.setHandler('session_select', async (data) =>
		{
			const email = data && data.username ? data.username : '';
			if (!email || (typeof this.homey.app.getSessionByEmail !== 'function'))
			{
				return { found: false };
			}

			const existing = this.homey.app.getSessionByEmail(email);
			if (!existing)
			{
				return { found: false };
			}

			username = existing.username;
			password = existing.password || '';
			region = existing.region || region;
			selectedExistingSession = true;

			return {
				found: true,
				username,
				region,
			};
		});

		session.setHandler('session_delete', async (data) =>
		{
			const email = data && data.username ? data.username : '';
			const force = !!(data && data.force);

			if (!email || (typeof this.homey.app.removeAccountSession !== 'function'))
			{
				return {
					removed: false,
					notSupported: true,
				};
			}

			const result = this.homey.app.removeAccountSession(email, { force });
			const normalized = (typeof this.homey.app.normalizeSessionEmail === 'function')
				? this.homey.app.normalizeSessionEmail(email)
				: email;

			if (result && result.removed && normalized === username)
			{
				username = '';
				password = '';
				selectedExistingSession = false;
			}

			return result;
		});

		session.setHandler('select_region_setup', async () =>
		{
			this.log('Select Region Setup');
			const result = { region };
			return result;
		});

		session.setHandler('login', async (data) =>
		{
			const requestedUsername = data && data.username ? data.username : username;
			const requestedPassword = data && data.password ? data.password : '';
			const requestedRegion = data && data.region ? data.region : region;

			if (typeof this.homey.app.normalizeSessionEmail === 'function')
			{
				username = this.homey.app.normalizeSessionEmail(requestedUsername);
			}
			else
			{
				username = requestedUsername;
			}

			if (typeof this.homey.app.isValidSessionEmail === 'function' && !this.homey.app.isValidSessionEmail(username))
			{
				throw new Error('Please enter a valid email address');
			}

			region = requestedRegion || region || 'europe';

			let sessionPassword = requestedPassword;
			if ((!sessionPassword || sessionPassword.length === 0) && (typeof this.homey.app.getSessionByEmail === 'function'))
			{
				const existing = this.homey.app.getSessionByEmail(username);
				if (existing && existing.password)
				{
					sessionPassword = existing.password;
					region = existing.region || region;
					selectedExistingSession = true;
				}
			}

			if (!sessionPassword || sessionPassword.length === 0)
			{
				throw new Error('Please enter your password or select an existing session');
			}

			password = sessionPassword;
			const credentialsAreValid = await this.homey.app.newLogin_2(username, password, region, null, true);

			if (credentialsAreValid && (typeof this.homey.app.upsertAccountSession === 'function'))
			{
				this.homey.app.upsertAccountSession({ username, password, region });
			}

			// return true to continue adding the device if the login succeeded
			// return false to indicate to the user the login attempt failed
			// thrown errors will also be shown to the user
			return credentialsAreValid;
		});

		session.setHandler('list_devices', async () =>
		{
			this.log('list_devices');
			if (this.homey.app && this.homey.app.infoLogEnabled && this.homey.app.tahomaCloud)
			{
				const cloudUsername = (typeof this.homey.app.normalizeSessionEmail === 'function')
					? this.homey.app.normalizeSessionEmail(this.homey.app.tahomaCloud.username)
					: (this.homey.app.tahomaCloud.username || '');
				this.homey.app.logInformation('Pairing list_devices', `Cloud authenticated user: ${cloudUsername || 'not authenticated'}`);
			}
			if (!username || !password)
			{
				if (selectedExistingSession && (typeof this.homey.app.getSessionByEmail === 'function'))
				{
					const existing = this.homey.app.getSessionByEmail(username);
					if (!existing || !existing.password)
					{
						throw new Error(this.homey.__('errors.on_pair_login_failure'));
					}
				}
				else
				{
					throw new Error(this.homey.__('errors.on_pair_login_failure'));
				}
			}
			return this.onReceiveSetupData();
		});
	}

	async onRepair(session, device)
	{
		let username = this.homey.settings.get('username');
		let password = this.homey.settings.get('password');
		const region = this.homey.settings.get('region');

		// session.setHandler('showView', async view =>
		// {
		//	 if (view === 'login_credentials')
		//	 {
		//		 if (username && password && this.homey.app.isLoggedIn())
		//		 {
		//			 await session.nextView();
		//		 }
		//	 }
		// });

		session.setHandler('login', async (data) =>
		{
			username = data.username;
			password = data.password;
			const credentialsAreValid = await this.homey.app.newLogin_2(username, password, region, null, true);

			// return true to continue adding the device if the login succeeded
			// return false to indicate to the user the login attempt failed
			// thrown errors will also be shown to the user
			return credentialsAreValid;
		});
	}

	async onReceiveSetupData()
	{
		try
		{
			let devices = await this.homey.app.getDeviceData();
			if (devices && devices.devices && devices.devices.cloud)
			{
				const cloudDevices = ((devices.devices.cloud ? (devices.devices.cloud.devices ? devices.devices.cloud.devices : devices.devices.cloud) : null));
				const localDevices = (devices.devices.local ? (devices.devices.local.devices ? devices.devices.local.devices : devices.devices.local) : null);

				// Merge the arrays into one
				if (cloudDevices && localDevices)
				{
					devices = cloudDevices.concat(localDevices);
				}
				else if (cloudDevices)
				{
					devices = cloudDevices;
				}
				else if (localDevices)
				{
					devices = localDevices;
				}
			}

			this.logInformationSafe('OnReceiveSetupData', devices);
			if (devices)
			{
				this.log('setup resolve');
				const currentSessionUsername = this.homey.settings.get('username');
				const normalizedSessionUsername = (this.homey.app && (typeof this.homey.app.normalizeSessionEmail === 'function'))
					? this.homey.app.normalizeSessionEmail(currentSessionUsername)
					: currentSessionUsername;
				const gatewayIdFromDeviceURL = (deviceURL) =>
				{
					if (!deviceURL)
					{
						return '';
					}

					const match = `${deviceURL}`.match(/^[^:]+:\/\/([^/]+)\//);
					return (match && match[1]) ? match[1] : '';
				};
				const supportedControllableNames = (this.deviceType || []).map((type) => String(type).toLowerCase());
				const supportedWidgetNames = (this.deviceWidgetType || []).map((type) => String(type).toLowerCase());
				const filteredDevices = devices.filter((device) =>
				{
					const controllableName = String(device && device.controllableName ? device.controllableName : '').toLowerCase();
					const widgetName = String(device && device.widget ? device.widget : '').toLowerCase();
					return supportedControllableNames.includes(controllableName)
						|| supportedWidgetNames.includes(widgetName);
				});
				const labelCounts = {};
				filteredDevices.forEach((device) =>
				{
					const label = String(device && device.label ? device.label : '').trim();
					if (!label)
					{
						return;
					}

					labelCounts[label] = (labelCounts[label] || 0) + 1;
				});

				const homeyDevices = filteredDevices.map((device) =>
				{
					const gatewayId = device.gatewayId || gatewayIdFromDeviceURL(device.deviceURL);
					const label = String(device && device.label ? device.label : 'Unnamed device');
					const hasDuplicateLabel = !!(labelCounts[label] > 1);
					const displayName = (hasDuplicateLabel && gatewayId) ? `${label} (${gatewayId})` : label;

					return {
						name: displayName,
						data:
						{
							id: device.deviceURL || device.oid,
							oid: device.oid,
							deviceURL: device.deviceURL,
							gatewayId,
							label: device.label,
							controllableName: device.controllableName,
						},
						settings: normalizedSessionUsername
							? { sessionUsername: normalizedSessionUsername }
							: undefined,
					};
				});
				return homeyDevices;
			}
		}
		catch (error)
		{
			this.logInformationSafe('OnReceiveSetupData', error);
			throw error;
		}

		return [];
	}

	/**
	 * Triggers a flow
	 * @param {this.homey.flow.getDeviceTriggerCard} trigger - A this.homey.flow.getDeviceTriggerCard instance
	 * @param {Device} device - A Device instance
	 * @param {Object} tokens - An object with tokens and their typed values, as defined in the app.json
	 */
	triggerFlow(trigger, device, tokens, state)
	{
		if (trigger)
		{
			trigger.trigger(device, tokens, state)
				.then((result) =>
				{
					if (result)
					{
						this.log(result);
					}
				})
				.catch((error) =>
				{
					this.logInformationSafe(`triggerFlow (${trigger.id})`, error);
				});
		}
	}

	/**
	 * Returns the io controllable name(s) of TaHoma
	 * @return {Array} deviceType
	 */
	getDeviceType()
	{
		return this.deviceType ? this.deviceType : false;
	}

}
module.exports = Driver;
