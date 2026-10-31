/* eslint-disable no-tabs */
/* eslint-disable no-lonely-if */
/* jslint node: true */

'use strict';

const Homey = require('homey');
/**
 * Base class for devices
 * @extends {Homey.Device}
 */
class Device extends Homey.Device
{

	async onInit(CapabilitiesXRef)
	{
		this.boostSync = false;
		this.executionId = null;
		this.executionCmd = '';

		this.executionCommands = [];

		if (CapabilitiesXRef)
		{
			for (const element of CapabilitiesXRef)
			{
				if (!this.hasCapability(element.homeyName))
				{
					try
					{
						await this.addCapability(element.homeyName);
					}
					catch (err)
					{
						this.error(err);
					}
				}

				this.registerCapabilityListener(element.homeyName, this.onCapability.bind(this, element));
			}

			//			this.syncEventsList(null, CapabilitiesXRef);
		}
		this.log('Device init:', this.getName(), 'class:', this.getClass());
	}

	onAdded()
	{
		this.log('device added');
	}

	onDeleted()
	{
		if (this.timerId)
		{
			clearTimeout(this.timerId);
		}

		try
		{
			const app = this.getAppSafe();
			const settings = (typeof this.getSettings === 'function') ? this.getSettings() : {};
			const sessionUsername = settings ? settings.sessionUsername : null;
			if (sessionUsername && app && (typeof app.autoRemoveUnusedSession === 'function'))
			{
				this.homey.setTimeout(() =>
				{
					app.autoRemoveUnusedSession(sessionUsername).catch((error) =>
					{
						this.error('autoRemoveUnusedSession failed', error);
					});
				}, 2000);
			}
		}
		catch (error)
		{
			this.error('onDeleted session cleanup failed', error);
		}

		this.log('device deleted');
	}

	/**
	 * Returns the TaHoma device url
	 * Some devices use multiple URL's that have an index on the end
	 * E.g. device#1, device#2, etc
	 * Therefore hashIndex specifies the index where 0 is the url without the #1, 1 is the recorded url and 2 onwards specifies the extra urls
	 * @return {String}
	 * If hashIndex > 0 and there is no #1 at the end of the recorded url then return is null
	 */
	getDeviceUrl(hashIndex)
	{
		const { deviceURL } = this.getData();
		if (!deviceURL)
		{
			return null;
		}

		if ((hashIndex === undefined) || (hashIndex === 1))
		{
			// Return the original url
			return deviceURL;
		}

		let subUrl = deviceURL.split('#');
		if (hashIndex === 0)
		{
			// Return the original url without the #1
			return subUrl[0];
		}

		if (!subUrl || (subUrl.length < 2) || (subUrl[1] !== '1'))
		{
			// There was no #1 so return null
			return null;
		}

		// Return the url with the new bub # number
		subUrl = `${subUrl[0]}#${hashIndex.toString()}`;
		return subUrl;
	}

	/**
	 * Build a component root for related URLs (e.g. zigbee://.../23988/1 and zigbee://.../23988/232)
	 * @param {String} deviceURL
	 * @returns {String|null}
	 */
	getDeviceComponentRoot(deviceURL)
	{
		if (!deviceURL)
		{
			return null;
		}

		const value = String(deviceURL);
		const hashIndex = value.indexOf('#');
		if (hashIndex >= 0)
		{
			return value.substring(0, hashIndex);
		}

		const schemeIndex = value.indexOf('://');
		if (schemeIndex < 0)
		{
			return null;
		}

		const pathStart = value.indexOf('/', schemeIndex + 3);
		if (pathStart < 0)
		{
			return null;
		}

		const path = value.substring(pathStart + 1);
		const pathParts = path.split('/').filter((part) => part !== '');
		if (pathParts.length < 2)
		{
			return null;
		}

		const base = value.substring(0, pathStart + 1);
		return `${base}${pathParts.slice(0, -1).join('/')}`;
	}

	/**
	 * Check if an event URL belongs to this device, including sibling components when applicable
	 * @param {String} eventURL
	 * @param {String} referenceURL
	 * @returns {Boolean}
	 */
	isRelatedDeviceURL(eventURL, referenceURL)
	{
		if (!eventURL || !referenceURL)
		{
			return false;
		}

		const eventURLText = String(eventURL);
		const referenceURLText = String(referenceURL);
		if (eventURLText === referenceURLText)
		{
			return true;
		}

		if (this.combineSubURLs)
		{
			const subURLRoot = this.getDeviceUrl(0);
			if (subURLRoot && ((eventURLText === subURLRoot) || eventURLText.startsWith(`${subURLRoot}#`)))
			{
				return true;
			}
		}

		const eventRoot = this.getDeviceComponentRoot(eventURLText);
		const referenceRoot = this.getDeviceComponentRoot(referenceURLText);
		return !!(eventRoot && referenceRoot && (eventRoot === referenceRoot));
	}

	/**
	 * Get a state by name from a related sibling component URL
	 * @param {Array} stateNames
	 * @param {String} referenceURL
	 * @returns {Object|null}
	 */
	async getRelatedDeviceState(stateNames, referenceURL)
	{
		if (!Array.isArray(stateNames) || (stateNames.length === 0))
		{
			return null;
		}

		const rootURL = this.getDeviceComponentRoot(referenceURL);
		if (!rootURL)
		{
			return null;
		}

		if (!this.relatedStatesCache)
		{
			this.relatedStatesCache = new Map();
		}

		const namesKey = stateNames.join('|');
		const cacheKey = `${rootURL}|${namesKey}`;
		const cacheEntry = this.relatedStatesCache.get(cacheKey);
		const now = Date.now();
		if (cacheEntry && ((now - cacheEntry.time) < 300000))
		{
			return cacheEntry.state;
		}

		let state = null;
		try
		{
			const app = this.getAppSafe();
			if (!app)
			{
				this.relatedStatesCache.set(cacheKey, { time: now, state: null });
				return null;
			}

			const allDevices = await app.getDeviceData();
			if (Array.isArray(allDevices))
			{
				for (const relatedDevice of allDevices)
				{
					if (!relatedDevice || !relatedDevice.deviceURL || (relatedDevice.deviceURL === referenceURL))
					{
						continue;
					}

					if (this.getDeviceComponentRoot(relatedDevice.deviceURL) !== rootURL)
					{
						continue;
					}

					if (!Array.isArray(relatedDevice.states))
					{
						continue;
					}

					for (const stateName of stateNames)
					{
						state = relatedDevice.states.find((entry) => (entry && (entry.name === stateName)));
						if (state)
						{
							break;
						}
					}

					if (state)
					{
						break;
					}
				}
			}
		}
		catch (error)
		{
			const app = this.getAppSafe();
			if (app && app.infoLogEnabled)
			{
				this.logInformationSafe(this.getName(),
					{
						message: 'Failed to read related component states',
						stack: error,
					});
			}
		}

		this.relatedStatesCache.set(cacheKey, { time: now, state: state || null });
		return state;
	}

	/**
	 * Returns the io controllable name(s) of TaHoma
	 * @return {Array} deviceType
	 */
	getDeviceType()
	{
		return this.driver.getDeviceType();
	}

	isReady()
	{
		return this._ready;
	}

	getAppSafe()
	{
		try
		{
			return this.homey.app;
		}
		catch (error)
		{
			return null;
		}
	}

	logInformationSafe(source, details)
	{
		const app = this.getAppSafe();
		if (app && (typeof app.logInformation === 'function'))
		{
			app.logInformation(source, details);
			return;
		}

		if (details && details.message)
		{
			this.error(`${source}: ${details.message}`);
		}
	}

	logStatesSafe(message)
	{
		const app = this.getAppSafe();
		if (app && (typeof app.logStates === 'function'))
		{
			app.logStates(message);
		}
	}

	async onCapability(capabilityXRef, value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			let somfyValue = value;
			if (value === null)
			{
				somfyValue = opts;
			}
			else
			{
				if (capabilityXRef.parameters !== undefined)
				{
					if (Array.isArray(capabilityXRef.parameters) && capabilityXRef.parameters.length > 1)
					{
						somfyValue = capabilityXRef.parameters[(value ? 1 : 0)];
					}
					else
					{
						somfyValue = capabilityXRef.parameters;
					}
				}
				else if (capabilityXRef.scale)
				{
					if (capabilityXRef.invert)
					{
						somfyValue = 1 - somfyValue;
					}
					somfyValue *= capabilityXRef.scale;
				}
				else if (capabilityXRef.compare)
				{
					somfyValue = capabilityXRef.compare[(value === false ? 0 : 1)];
				}

				if (capabilityXRef.parameterArray !== undefined)
				{
					somfyValue = capabilityXRef.parameterArray;
				}
				else
				{
					somfyValue = somfyValue === '' ? null : [somfyValue];
				}
			}

			const deviceData = this.getData();
			// Check if this command is already being executed
			const existingCommandIdx = this.executionCommands.findIndex((element) => capabilityXRef.somfyNameSet.indexOf(element.name) >= 0);
			if (existingCommandIdx >= 0)
			{
				// Found it so cancel the current command first
				try
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionCommands[existingCommandIdx].id, this.executionCommands[existingCommandIdx].local, deviceData.deviceURL);
				}
				catch (err)
				{
					this.homey.app.logInformation(this.getName(),
						{
							message: err.message,
							stack: err.stack,
						});
				}
				// Remove the command from the array
				this.executionCommands.splice(existingCommandIdx, 1);
			}

			let cmdIdx = 0;
			if (capabilityXRef.somfyNameSet.length > 1)
			{
				cmdIdx = (value ? 1 : 0);
			}

			if (typeof capabilityXRef.somfyNameSet[cmdIdx] === 'number')
			{
				// Set a different capability
				const otherCapabilityIdx = capabilityXRef.somfyNameSet[cmdIdx];
				const capabilityName = capabilityXRef.otherCapability[otherCapabilityIdx];
				value = this.getCapabilityValue(capabilityName);
				this.triggerCapabilityListener(capabilityName, value).catch(this.error);
				return;
			}

			let action;
			if (capabilityXRef.ignoreValue)
			{
				action = {
					name: capabilityXRef.somfyNameSet[cmdIdx],
					parameters: [],
				};
			}
			else if ((somfyValue === null) || (Array.isArray(somfyValue) && somfyValue.length === 0))
			{
				action = {
					name: capabilityXRef.somfyNameSet[cmdIdx],
				};
			}
			else
			{
				action = {
					name: capabilityXRef.somfyNameSet[cmdIdx],
					parameters: somfyValue,
				};
			}

			let action2;
			if (capabilityXRef.secondaryCommand && capabilityXRef.secondaryCommand[somfyValue])
			{
				action2 = capabilityXRef.secondaryCommand[somfyValue];
			}

			// Send the command
			let result = null;
			result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync, action2);
			const idx = this.executionCommands.findIndex((element) => capabilityXRef.somfyNameSet.indexOf(element.name) >= 0);
			if (idx < 0)
			{
				// Add the command reference to the executing array
				this.executionCommands.push({ id: result.execId, name: action.name, local: result.local });
			}
			else
			{
				// The command must have been added by the event handler so cancel this boost request so we don't have two
				await this.homey.app.unBoostSync();
			}
		}
		else
		{
			const { homeyName } = capabilityXRef;
			try
			{
				const oldValue = this.getCapabilityValue(homeyName);
				if (oldValue !== value)
				{
					this.setCapabilityValue(homeyName, value).catch(this.error);

					// For boolean states, setup a safety timeout incase the off state is not received.
					if (typeof value === 'boolean')
					{
						if (value && (value !== oldValue))
						{
							this.checkTimerID = this.homey.setTimeout(() =>
							{
								this.syncEvents(null);
							}, 60000);
						}
						else
						{
							clearTimeout(this.checkTimerID);
						}
					}

					if (this.driver.triggerFlows)
					{
						// trigger flows
						this.driver.triggerFlows(this, homeyName, value);
					}
				}
			}
			catch (err)
			{
				this.homey.app.logInformation(`${this.getName()}: onCapability ${homeyName}`, err);
			}
		}
	}

	/**
	 * Convert a TaHoma battery state value to a Homey battery percentage
	 * @param {String} stateName
	 * @param {*} stateValue
	 * @returns {Number|null}
	 */
	getBatteryLevelPercent(stateName, stateValue)
	{
		if ((stateName === 'core:BatteryLevelState') && (stateValue !== null) && (stateValue !== undefined))
		{
			const batteryLevel = Number(stateValue);
			if (Number.isFinite(batteryLevel))
			{
				return Math.max(0, Math.min(100, batteryLevel));
			}
		}

		if ((stateName === 'core:BatteryState') && (typeof stateValue === 'string'))
		{
			const batteryStates = ['verylow', 'low', 'normal', 'full'];
			const batteryIndex = batteryStates.findIndex((state) => state === stateValue.toLowerCase());
			if (batteryIndex >= 0)
			{
				return (batteryIndex * 100) / 3;
			}
		}

		return null;
	}

	/**
	 * Update Homey battery capability from a single TaHoma battery state
	 * @param {Object} tahomaState
	 * @returns {Boolean}
	 */
	async updateBatteryLevelCapability(tahomaState)
	{
		if (!tahomaState || !tahomaState.name)
		{
			return false;
		}

		if (tahomaState.name === 'core:BatteryDiscreteLevelState')
		{
			if (!['good', 'low', 'critical'].includes(tahomaState.value))
			{
				this.logInformationSafe(this.getName(), `Unknown discrete battery level: ${tahomaState.value}`);
				return false;
			}
			if (!this.hasCapability('alarm_battery'))
			{
				await this.addCapability('alarm_battery');
			}
			await this.setCapabilityValue('alarm_battery', tahomaState.value !== 'good');
			return true;
		}

		const batteryLevel = this.getBatteryLevelPercent(tahomaState.name, tahomaState.value);
		if (batteryLevel === null)
		{
			return false;
		}

		if (!this.hasCapability('measure_battery'))
		{
			try
			{
				await this.addCapability('measure_battery');
			}
			catch (error)
			{
				this.logInformationSafe(this.getName(),
					{
						message: error.message,
						stack: error.stack,
					});
				return false;
			}
		}

		this.logStatesSafe(`${this.getName()}: ${tahomaState.name} = ${tahomaState.value}`);
		this.logStatesSafe(`${this.getName()}: measure_battery = ${batteryLevel}`);
		this.setCapabilityValue('measure_battery', batteryLevel).catch(this.error);

		return true;
	}

	/**
	 * Update Homey battery capability from all TaHoma states when this driver does not define measure_battery itself
	 * @param {Array} tahomaStates
	 * @param {Array} CapabilitiesXRef
	 */
	async syncBatteryLevelCapability(tahomaStates, CapabilitiesXRef)
	{
		if (!Array.isArray(tahomaStates) || !Array.isArray(CapabilitiesXRef))
		{
			return;
		}

		const hasMeasureBatteryMapping = CapabilitiesXRef.some((entry) => entry.homeyName === 'measure_battery');
		if (hasMeasureBatteryMapping)
		{
			return;
		}

		const batteryLevelState = tahomaStates.find((state) => (state && (state.name === 'core:BatteryLevelState')));
		if (await this.updateBatteryLevelCapability(batteryLevelState))
		{
			return;
		}

		const batteryState = tahomaStates.find((state) => (state && (state.name === 'core:BatteryState')));
		if (await this.updateBatteryLevelCapability(batteryState))
		{
			return;
		}

		const relatedBatteryState = await this.getRelatedDeviceState(
			['core:BatteryLevelState', 'core:BatteryState', 'core:BatteryDiscreteLevelState'],
			this.getDeviceUrl(),
		);
		if (!await this.updateBatteryLevelCapability(relatedBatteryState))
		{
			const discreteBatteryState = tahomaStates.find((state) => (state && (state.name === 'core:BatteryDiscreteLevelState')));
			await this.updateBatteryLevelCapability(discreteBatteryState);
		}
	}

	/**
	 * Gets the sensor data from the TaHoma cloud
	 * Capabilities{somfyNameGet: 'name of the Somfy capability, homeyName: 'name of the Homey capability', compare:[] 'text array for false and true value or not specified if real value' }
	 */
	async syncList(CapabilitiesXRef)
	{
		const app = this.getAppSafe();
		if (!app)
		{
			return;
		}

		try
		{
			// Get this devices states from Tahoma
			let tahomaStates = await this.getStates();
			if (tahomaStates)
			{
				// Look for each of the required capabilities
				for (let i = 0; i < CapabilitiesXRef.length; i++)
				{
					let xRefEntry = CapabilitiesXRef[i];
					const { homeyName } = xRefEntry;
					try
					{
						// Find the tahoma device state for the table entry
						const somfyNames = Array.isArray(xRefEntry.somfyNameGet)
							? xRefEntry.somfyNameGet
							: [xRefEntry.somfyNameGet];
						const tahomaState = tahomaStates.find((state) => (state && somfyNames.indexOf(state.name) >= 0));
						if (tahomaState)
						{
							let { value } = tahomaState;
							if (typeof value === 'string')
							{
								value = value.toLowerCase();
							}

							// Check if Somfy is returning an alternative state name
							if (xRefEntry.conversions && xRefEntry.conversions[value])
							{
								// Yep, so convert to the published one
								value = xRefEntry.conversions[value];
							}

							if (typeof value === 'string')
							{
								try
								{
									// Find the translation for this capability with the Somfy enum id
									const translateName = `${xRefEntry.homeyName}.${value}`;
									const translatedState = this.homey.__(translateName);
									if (translatedState && (translatedState !== translateName))
									{
										value = translatedState;
									}
								}
								catch (err)
								{

								}
							}

							// Found the entry
							this.logStatesSafe(`${this.getName()}: ${tahomaState.name} = ${value}`);
							if (xRefEntry.compare)
							{
								if (xRefEntry.compare[1].charAt(0) === '!')
								{
									value = (value !== xRefEntry.compare[1]);
								}
								else
								{
									value = (value === xRefEntry.compare[1]);
								}
							}
							else if (xRefEntry.scale)
							{
								if (CapabilitiesXRef.invert)
								{
									value = 1 - value;
								}

								value /= xRefEntry.scale;
							}

							this.triggerCapabilityListener(homeyName, value, { fromCloudSync: true }).catch(this.error);
						}
						else
						{
							// Information not found for this parameter
							if (homeyName === 'alarm_battery')
							{
								this.triggerCapabilityListener(homeyName, false, { fromCloudSync: true }).catch(this.error);
							}
							else if (homeyName === 'defect_state')
							{
								this.triggerCapabilityListener(homeyName, null, { fromCloudSync: true }).catch(this.error);
							}
						}
					}
					catch (error)
					{
						this.logInformationSafe(this.getName(),
							{
								message: error.message,
								stack: error.stack,
							});
					}

					xRefEntry = null;
				}

				await this.syncBatteryLevelCapability(tahomaStates, CapabilitiesXRef);

				tahomaStates = null;
			}
			else
			{
				this.logInformationSafe(this.getName(),
					{
						message: 'No states returned from Tahoma',
					});
			}
		}
		catch (error)
		{
			this.logInformationSafe(this.getName(),
				{
					message: error.message,
					stack: error.stack,
				});
		}
	}

	// look for updates in the events array
	async syncEventsList(events, CapabilitiesXRef, local)
	{
		const app = this.getAppSafe();
		if (!app)
		{
			return;
		}

		if (events === null)
		{
			// No events so synchronise all capabilities
			await this.syncList(CapabilitiesXRef);
			return;
		}

		// get the url including the #n on the end if there is one
		let myURL;
		if (this.combineSubURLs)
		{
			// get the url without the #1 on the end
			myURL = this.getDeviceUrl(0);
		}
		else
		{
			myURL = this.getDeviceUrl();
		}

		if (!local && app.isLocalDevice(myURL, this.combineSubURLs))
		{
			// This device is handled locally so ignore cloud updates
			return;
		}

		const hasMeasureBatteryMapping = Array.isArray(CapabilitiesXRef)
			&& CapabilitiesXRef.some((entry) => entry.homeyName === 'measure_battery');

		// Get the capability values for this device
		const oldCapabilityStates = this.getState();

		// Process events sequentially so they are in the correct order
		// For each event that has been received
		for (const event of events)
		{
			// Ensure we are processing a state changed event
			if (event.name === 'DeviceStateChangedEvent')
			{
				// If the URL matches then it is for this device
				if (Array.isArray(event.deviceStates) && this.isRelatedDeviceURL(event.deviceURL, myURL))
				{
					if (!hasMeasureBatteryMapping)
					{
						const batteryLevelState = event.deviceStates.find((state) => (state && (state.name === 'core:BatteryLevelState')));
						if (!await this.updateBatteryLevelCapability(batteryLevelState))
						{
							const batteryState = event.deviceStates.find((state) => (state && (state.name === 'core:BatteryState')));
							await this.updateBatteryLevelCapability(batteryState);
						}
					}

					if (app.infoLogEnabled)
					{
						this.logInformationSafe(this.getName(),
							{
								message: 'Processing device state change event',
								stack: event,
							});
					}
					// Got what we need to update the device so lets process each capability
					for (const tahomaState of event.deviceStates)
					{
						if (tahomaState.name === 'core:OperatingModeState')
						{
							this.log('core:OperatingModeState');
						}

						// look up the entry so we can get all the Homey capability, etc
						for (const xRefEntry of CapabilitiesXRef)
						{
							const somfyNames = Array.isArray(xRefEntry.somfyNameGet)
								? xRefEntry.somfyNameGet
								: [xRefEntry.somfyNameGet];
							if (somfyNames.indexOf(tahomaState.name) >= 0)
							{
								// Yep we can relate to this one
								let deviceValue = 'nodefect';
								if (tahomaState.value)
								{
									deviceValue = tahomaState.value;
								}
								else if (!xRefEntry.allowNull)
								{
									if (app.infoLogEnabled)
									{
										this.logInformationSafe(this.getName(),
											{
												message: 'State has no value',
												stack: { capability: xRefEntry.homeyName },
											});
									}

									continue;
								}

								// Check if Somfy is returning an alternative state name
								if (xRefEntry.conversions && xRefEntry.conversions[tahomaState.value])
								{
									// Yep, so convert to the published one
									deviceValue = xRefEntry.conversions[tahomaState.value];
								}

								this.logStatesSafe(`${this.getName()}: ${tahomaState.name}= ${deviceValue}`);
								const oldState = oldCapabilityStates[xRefEntry.homeyName];
								let newState = deviceValue;
								if (xRefEntry.compare)
								{
									if (xRefEntry.compare[1].charAt(0) === '!')
									{
										newState = (deviceValue !== xRefEntry.compare[1]);
									}
									else
									{
										newState = (deviceValue === xRefEntry.compare[1]);
									}
								}
								else if (xRefEntry.scale)
								{
									if (CapabilitiesXRef.invert)
									{
										deviceValue = 1 - deviceValue;
									}
									newState = deviceValue ? (deviceValue / xRefEntry.scale) : 0;
								}

								if (xRefEntry.homeyName === 'measure_luminance')
								{
									const luminance = Number(newState);
									if (Number.isFinite(luminance))
									{
										newState = luminance;
									}
									else
									{
										this.logInformationSafe(this.getName(),
											{
												message: 'Invalid luminance payload type',
												stack: { capability: xRefEntry.homeyName, state: newState },
											});
										continue;
									}
								}

								if (typeof oldState === 'number')
								{
									newState = Number(newState);
								}
								else if ((typeof oldState === 'string') && (typeof newState === 'string'))
								{
									newState = newState.toLowerCase();
								}

								if (oldState !== newState)
								{
									if (xRefEntry.conversions && xRefEntry.conversions[newState])
									{
										newState = xRefEntry.conversions[newState];
									}

									if (typeof newState === 'string')
									{
										try
										{
											// Find the translation for this capability with the Somfy enum id
											const translateName = `${xRefEntry.homeyName}.${newState}`;
											const translatedState = this.homey.__(translateName);
											if (translatedState && (translatedState !== translateName))
											{
												newState = translatedState;
											}
											else if (newState === 'nodefect')
											{
												newState = '';
											}
										}
										catch (err)
										{

										}
									}

									if (app.infoLogEnabled)
									{
										this.logInformationSafe(this.getName(),
											{
												message: 'Setting new state',
												stack: { capability: xRefEntry.homeyName, state: newState },
											});
									}
									const { homeyName } = xRefEntry;
									this.triggerCapabilityListener(homeyName, newState, { fromCloudSync: true }).catch(this.error);
								}
								else if (app.infoLogEnabled)
								{
									this.logInformationSafe(this.getName(),
										{
											message: 'Same as existing state',
											stack: { capability: xRefEntry.homeyName, state: newState },
										});
								}
							}
						}
					}
				}
			}
			else if (event.name === 'ExecutionRegisteredEvent')
			{
				if (Array.isArray(event.actions))
				{
					// A command is being executed so check if we already know about it
					for (const eventAction of event.actions)
					{
						if (myURL === eventAction.deviceURL)
						{
							// Check if this command is already in the execution array
							const idx = this.executionCommands.findIndex((element2) => element2.name === eventAction.command);
							if (idx < 0)
							{
								// Not known so record it and boost the events interval
								const newIdx = this.executionCommands.push({ id: event.execId, name: eventAction.command });
								if (!local && this.boostSync)
								{
									if (!await app.boostSync())
									{
										this.executionCommands.splice(newIdx, 1);
									}
								}
							}
						}
						}
					}
			}
			else if (event.name === 'ExecutionStateChangedEvent')
			{
				if ((event.newState === 'COMPLETED') || (event.newState === 'FAILED'))
				{
					// Check if we know about this command
					const idx = this.executionCommands.findIndex((element2) => element2.id === event.execId);
					if (idx >= 0)
					{
						// We did know so unreference our event boost
						await app.unBoostSync();
						this.executionCommands.splice(idx, 1);

						app.triggerCommandComplete(this, this.executionCmd, (event.newState === 'COMPLETED'));
						this.driver.triggerDeviceCommandComplete(this, this.executionCmd, (event.newState === 'COMPLETED'));
						this.commandExecuting = '';

						if (event.newState === 'COMPLETED')
						{
							this.setWarning(null).catch(this.error);
						}
						else
						{
							this.setWarning(this.homey.__('command_failed')).catch(this.error);
						}
					}
				}
				else if (event.newState === 'QUEUED_GATEWAY_SIDE')
				{
					const idx = this.executionCommands.findIndex((element2) => element2.id === event.execId);
					if (idx >= 0)
					{
						this.setWarning(this.homey.__('command_queued')).catch(this.error);
					}
				}
			}
		}
	}

	// Get all the states for this device from Tahoma
	async getStates()
	{
		const app = this.getAppSafe();
		if (!app)
		{
			return null;
		}

		try
		{
			if (app.isLoggedIn())
			{
				if (app.infoLogEnabled)
				{
					this.logInformationSafe('Device Get States.', this.getName());
				}

				// Get the recorded url (might include a #1 on the end)
				const deviceURL = this.getDeviceUrl(1);
				if (deviceURL)
				{
					let states = await app.getDeviceStates(deviceURL);
					if (!states)
					{
						const url0 = this.getDeviceUrl(0);
						if (url0 && (deviceURL !== url0))
						{
							// We have a sub url to check
							states = await app.getDeviceStates(url0);
						}
					}

					if (states)
					{
						// Get the next sub url if the original url ended with #1
						const url2 = this.getDeviceUrl(2);
						if (url2)
						{
							// We have a sub url to check
							try
							{
								const states2 = await app.getDeviceStates(url2);
								states = states.concat(states2);
							}
							catch (err)
							{
								// Ignore errors here
							}
						}
					}

					if (states)
					{
						return states;
					}
				}

				if (this.homey.settings.get('debugMode'))
				{
					const simData = this.homey.settings.get('simData');
					if (simData)
					{
						const deviceData = this.getData();
						const deviceOid = deviceData.oid || deviceData.id;
						if (simData.devices.cloud)
						{
							for (let i = 0; i < simData.devices.cloud.length; i++)
							{
								if (simData.devices.cloud[i].oid === deviceOid)
								{
									return simData.devices.cloud[i].states;
								}
							}
						}

						if (simData.devices.local)
						{
							for (let i = 0; i < simData.devices.local.length; i++)
							{
								if (simData.devices.local[i].oid === deviceOid)
								{
									return simData.devices.local[i].states;
								}
							}
							return null;
						}
					}
				}
			}
		}
		catch (error)
		{
			const stack = error.response ? error.response.data : error;
			this.logInformationSafe('Device initial sync error',
				{
					message: this.getName(),
					stack,
				});
		}
		return null;
	}

	checkForDuplicatesEvents(events, startElement, startState, myURL, stateName)
	{
		if (!events)
		{
			return false;
		}
		for (let i = startElement; i < events.length; i++)
		{
			const element = events[i];
			if ((element.name === 'DeviceStateChangedEvent') && this.isRelatedDeviceURL(element.deviceURL, myURL) && element.deviceStates)
			{
				for (let x = startState; x < element.deviceStates.length; x++)
				{
					const deviceState = element.deviceStates[x];
					if (deviceState.name === stateName)
					{
						// Found a duplicate
						const app = this.getAppSafe();
						if (app && app.infoLogEnabled)
						{
							this.logInformationSafe(this.getName(),
								{
									message: 'Ignoring duplicate event',
									stack: deviceState,
								});
						}
						return true;
					}
				}
				startState = 0;
			}
		}

		return false;
	}

}
module.exports = Device;
