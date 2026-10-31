/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

/**
 * Device class for the opening detector with the io:AlarmIOComponent controllable name in TaHoma
 * @extends {SensorDevice}
 */

class OneAlarmDevice extends SensorDevice
{

	logCapabilityCommandError(context, err)
	{
		const errorMessage = (err && err.message) ? err.message : String(err);
		if (this.homey && this.homey.app && (typeof this.homey.app.logInformation === 'function'))
		{
			this.homey.app.logInformation(`${this.getName()}: ${context}`, errorMessage);
		}
		else
		{
			this.error(errorMessage);
		}
	}

	async onInit()
	{
		this.retries = 0;
		this.registerCapabilityListener('off_button', this.onCapabilityAlarmOff.bind(this));
		this.registerCapabilityListener('on_button', this.onCapabilityAlarmOn.bind(this));
		this.registerMultipleCapabilityListener(['zone_button.a', 'zone_button.b', 'zone_button.c'], this.onCapabilityZone.bind(this), 1000);

		await super.onInit();
		this.boostSync = true;
	}

	async onCapabilityAlarmOn(value, opts)
	{
		const deviceData = this.getData();
		if (!opts || !opts.fromCloudSync)
		{
			try
			{
				if (this.executionCmd)
				{
					// Already executing a command so check if it is the same
					if (this.executionCmd === 'alarmOn')
					{
						// Already executing this command so ignore
						return;
					}

					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
					this.executionCmd = '';
					this.executionId = null;
				}

				let action;
				if (value === true)
				{
					action = {
						name: 'alarmOn',
						parameters: [],
					};
				}
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (error)
			{
				this.executionCmd = '';
				this.setWarning(error.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityAlarmOn', error);
			}
		}
		else
		{
			this.setCapabilityValue('on_button', value).catch(this.error);
		}
	}

	async onCapabilityAlarmOff(value, opts)
	{
		const deviceData = this.getData();
		if (!opts || !opts.fromCloudSync)
		{
			try
			{
				if (this.executionCmd)
				{
					// Already executing a command so check if it is the same
					if (this.executionCmd === 'alarmOff')
					{
						// Already executing this command so ignore
						return;
					}

					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
					this.executionCmd = '';
					this.executionId = null;
				}

				let action;
				if (value === true)
				{
					action = {
						name: 'alarmOff',
						parameters: [],
					};
				}
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionId = { id: result.execId, local: result.local };

				this.setWarning(null).catch(this.error);
			}
			catch (error)
			{
				this.executionCmd = '';
				this.setWarning(error.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityAlarmOff', error);
			}
		}
		else
		{
			this.setCapabilityValue('off_button', value).catch(this.error);
		}
	}

	async onCapabilityZone(capabilityValues, opts)
	{
		const deviceData = this.getData();
		let cloudSync = false;
		if (!opts)
		{
			cloudSync = true;
		}
		else if (opts['zone_button.a'] && opts['zone_button.a'].fromCloudSync)
		{
			cloudSync = true;
		}
		else if (opts['zone_button.b'] && opts['zone_button.b'].fromCloudSync)
		{
			cloudSync = true;
		}
		else if (opts['zone_button.c'] && opts['zone_button.c'].fromCloudSync)
		{
			cloudSync = true;
		}

		let value = (capabilityValues['zone_button.a'] ? 'A,' : '') + (capabilityValues['zone_button.b'] ? 'B,' : '') + (capabilityValues['zone_button.c'] ? 'C' : '');
		// Remove the last comma
		value = value.replace(/,\s*$/, '');

		if (!cloudSync)
		{
			let action;

			if (value)
			{
				if (this.executionCmd)
				{
					// Already executing a command so check if it is the same
					if (this.executionCmd === 'alarmZoneOn')
					{
						if (this.executionZone !== value && this.retries < 4)
						{
							// Already executing this command for another zone so try again later
							this.homey.setTimeout(() =>
							{
								this.retries++;
								this.onCapabilityZone(capabilityValues).catch(this.error);
							}, 5000);
							return;
						}

						// Already executing this command so ignore
						return;
					}

					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);

					this.retries = 0;
					this.executionCmd = '';
					this.executionId = null;
				}

				action = {
					name: 'alarmZoneOn',
					parameters: [value],
				};
				const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
				this.executionCmd = action.name;
				this.executionZone = value;
				this.executionId = { id: result.execId, local: result.local };
			}

			if ((capabilityValues['zone_button.a'] === false) || (capabilityValues['zone_button.b'] === false) || (capabilityValues['zone_button.c'] === false))
			{
				throw new Error('Cannot switch off zones');
			}
		}
		else
		{
			if (this.homey.app.infoLogEnabled)
			{
				this.homey.app.logInformation(this.getName(),
				{
					message: 'onCapabilityZone',
					stack: capabilityValues,
				});
			}

			const tokens = {
				zoneA: false,
				zoneB: false,
				zoneC: false,
			};

			const state = {
				zoneA: false,
				zoneB: false,
				zoneC: false,
			};

			if (capabilityValues['zone_button.a'] !== undefined)
			{
				this.setCapabilityValue('zone_button.a', capabilityValues['zone_button.a']).catch(this.error);
				tokens.zoneA = capabilityValues['zone_button.a'];
				state.zoneA = capabilityValues['zone_button.a'];
			}
			if (capabilityValues['zone_button.b'] !== undefined)
			{
				this.setCapabilityValue('zone_button.b', capabilityValues['zone_button.b']).catch(this.error);
				tokens.zoneB = capabilityValues['zone_button.b'];
				state.zoneB = capabilityValues['zone_button.b'];
			}
			if (capabilityValues['zone_button.c'] !== undefined)
			{
				this.setCapabilityValue('zone_button.c', capabilityValues['zone_button.c']).catch(this.error);
				tokens.zoneC = capabilityValues['zone_button.c'];
				state.zoneC = capabilityValues['zone_button.c'];
			}

			this.driver.triggerAlarmStateChanged(this, tokens, state).catch(this.error);
		}
	}

	/**
	 * Gets the sensor data from the TaHoma cloud
	 */
	async sync()
	{
		try
		{
			let states = await super.getStates();
			if (states)
			{
				const zoneState = states.find((state) => (state && (state.name === 'core:ActiveZonesState')));
				if (zoneState)
				{
					this.homey.app.logStates(`${this.getName()}: core:ActiveZonesState = ${zoneState.value}`);

					// Check if the zonestate contains a A
					this.triggerCapabilityListener('zone_button.a', (zoneState.value.indexOf('A') > -1), { fromCloudSync: true }).catch(this.error);

					// Check if the zonestate contains a B
					this.triggerCapabilityListener('zone_button.b', (zoneState.value.indexOf('B') > -1), { fromCloudSync: true }).catch(this.error);

					// Check if the zonestate contains a C
					this.triggerCapabilityListener('zone_button.c', (zoneState.value.indexOf('C') > -1), { fromCloudSync: true }).catch(this.error);
				}
				states = null;
			}
		}
		catch (error)
		{
			this.homey.app.logInformation(this.getName(),
			{
				message: error.message,
				stack: error.stack,
			});
		}
	}

	// look for updates in the events array
	async syncEvents(events, local)
	{
		if (events === null)
		{
			this.sync();
			return;
		}

		const myURL = this.getDeviceUrl();
		if (!local && this.homey.app.isLocalDevice(myURL))
		{
			// This device is handled locally so ignore cloud updates
			return;
		}

		// Process events sequentially so they are in the correct order
		for (let i = 0; i < events.length; i++)
		{
			const element = events[i];
			if (element.name === 'DeviceStateChangedEvent')
			{
				if ((element.deviceURL === myURL) && Array.isArray(element.deviceStates))
				{
					if (this.homey.app.infoLogEnabled)
					{
						this.homey.app.logInformation(this.getName(),
						{
							message: 'Processing device state change event',
							stack: element,
						});
					}
					// Got what we need to update the device so lets find it
					for (let x = 0; x < element.deviceStates.length; x++)
					{
						try
						{
							const deviceState = element.deviceStates[x];
							if (deviceState.name === 'core:ActiveZonesState')
							{
								this.homey.app.logStates(`${this.getName()}: core:ActiveZonesState = ${deviceState.value}`);

								this.triggerCapabilityListener('zone_button.a', (deviceState.value.indexOf('A') > -1), { fromCloudSync: true }).catch(this.error);

								// Check if the deviceState contains a B
								this.triggerCapabilityListener('zone_button.b', (deviceState.value.indexOf('B') > -1), { fromCloudSync: true }).catch(this.error);

								// Check if the deviceState contains a C
								this.triggerCapabilityListener('zone_button.c', (deviceState.value.indexOf('C') > -1), { fromCloudSync: true }).catch(this.error);
							}
						}
						catch (error)
						{
							this.homey.app.logInformation(this.getName(),
							{
								message: error.message,
								stack: error.stack,
							});
						}
					}
				}
			}
			else if (element.name === 'ExecutionRegisteredEvent')
			{
				if (!Array.isArray(element.actions))
				{
					continue;
				}
				for (let x = 0; x < element.actions.length; x++)
				{
					try
					{
						if (myURL === element.actions[x].deviceURL)
						{
							if (!this.executionId || (this.executionId.id !== element.execId))
							{
								this.executionId = { id: element.execId, local };
								if (element.actions[x].commands)
								{
									this.executionCmd = element.actions[x].commands[0].name;
								}
								else
								{
									this.executionCmd = element.actions[x].command;
								}
								if (!local && this.boostSync)
								{
									if (!await this.homey.app.boostSync())
									{
										this.retries = 0;
										this.executionId = null;
										this.executionCmd = '';
									}
								}
							}
						}
					}
					catch (error)
					{
						this.homey.app.logInformation(this.getName(),
						{
							message: error.message,
							stack: error.stack,
						});
					}
				}
			}
			else if (element.name === 'ExecutionStateChangedEvent')
			{
				if ((element.newState === 'COMPLETED') || (element.newState === 'FAILED'))
				{
					if (this.executionId && (this.executionId.id === element.execId))
					{
						if (!local && this.boostSync)
						{
							await this.homey.app.unBoostSync();
						}

						this.homey.app.triggerCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
						this.driver.triggerDeviceCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
						this.executionId = null;
						this.executionCmd = '';
					}
				}
			}
		}
	}

}

module.exports = OneAlarmDevice;
