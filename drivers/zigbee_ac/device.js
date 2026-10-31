/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

/**
 * Device class for the AC controller with the zigbee:ThermostatAndFanComponent and zigbee:ThermostatHeatingAndCoolingComponent controllable name in TaHoma
 * @extends {SensorDevice}
 */

class zigbeeACDevice extends SensorDevice
{

	async onInit()
	{
		this.boostSync = true;
		this.registerCapabilityListener('ac_louver_position', this.onCapabilityLouverPosition.bind(this));
		this.registerCapabilityListener('ac_fan_speed_mode', this.onCapabilityFanSpeed.bind(this));
		this.registerCapabilityListener('target_temperature.cooling', this.onCapabilityTargetTemperatureCooling.bind(this));
		this.registerCapabilityListener('target_temperature.heating', this.onCapabilityTargetTemperatureHeating.bind(this));
		this.registerCapabilityListener('ac_control_mode', this.onCapabilityControlMode.bind(this));
		this.registerCapabilityListener('ac_thermostat_mode', this.onCapabilityThermostateMode.bind(this));

		await super.onInit();
	}

	async onCapabilityTargetTemperatureCooling(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			const action = {
				name: 'setCoolingTargetTemperature',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('target_temperature.cooling', value).catch(this.error);
		}
	}

	async onCapabilityTargetTemperatureHeating(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			const action = {
				name: 'setHeatingTargetTemperature',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('target_temperature.heating', value).catch(this.error);
		}
	}

	async onCapabilityLouverPosition(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			const action = {
				name: 'setACLouverPosition',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('ac_louver_position', value).catch(this.error);
		}
	}

	async onCapabilityControlMode(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			const action = {
				name: 'setControlSequenceOfThermostatOperation',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('ac_control_mode', value).catch(this.error);
		}
	}

	async onCapabilityThermostateMode(value, opts)
	{
		const deviceData = this.getData();
		if (!opts || !opts.fromCloudSync)
		{
			const action = {
				name: 'setThermostatMode',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('ac_thermostat_mode', value).catch(this.error);
		}
	}

	async onCapabilityFanSpeed(value, opts)
	{
		const deviceData = this.getData();
		if (!opts || !opts.fromCloudSync)
		{
			const action = {
				name: 'setFanMode',
				parameters: [value],
			};

			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = action.name;
			this.executionId = { id: result.execId, local: result.local };
		}
		else
		{
			this.setCapabilityValue('ac_fan_speed_mode', value).catch(this.error);
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
				const temperature = states.find((state) => (state && (state.name === 'core:TemperatureState')));
				if (temperature)
				{
					this.homey.app.logStates(`${this.getName()}: core:TemperatureState = ${temperature.value}`);
					this.setCapabilityValue('measure_temperature', temperature.value).catch(this.error);
				}

				const louverState = states.find((state) => (state && (state.name === 'zigbee:ACLouverPositionState')));
				if (louverState)
				{
					this.homey.app.logStates(`${this.getName()}: zigbee:ACLouverPositionState = ${louverState.value}`);
					this.triggerCapabilityListener('ac_louver_position', louverState.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				const controlModeState = states.find((state) => (state && (state.name === 'zigbee:ControlSequenceOfThermostatOperationState')));
				if (controlModeState)
				{
					this.homey.app.logStates(`${this.getName()}: zigbee:ControlSequenceOfThermostatOperationState = ${controlModeState.value}`);
					this.triggerCapabilityListener('ac_control_mode', controlModeState.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				const thermostateState = states.find((state) => (state && (state.name === 'zigbee:ThermostatModeState')));
				if (thermostateState)
				{
					this.homey.app.logStates(`${this.getName()}: zigbee:ThermostatModeState = ${thermostateState.value}`);
					this.triggerCapabilityListener('ac_thermostat_mode', thermostateState.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				const fanMode = states.find((state) => (state && (state.name === 'zigbee:FanSpeedModeState')));
				if (fanMode)
				{
					this.homey.app.logStates(`${this.getName()}: zigbee:FanSpeedModeState = ${fanMode.value}`);
					this.triggerCapabilityListener('ac_fan_speed_mode', fanMode.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}

				const coolingTemp = states.find((state) => (state && (state.name === 'core:CoolingTargetTemperatureState')));
				if (coolingTemp)
				{
					this.homey.app.logStates(`${this.getName()}: core:CoolingTargetTemperatureState = ${coolingTemp.value}`);
					this.triggerCapabilityListener('target_temperature.cooling', coolingTemp.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
				}
				const heatingTemp = states.find((state) => (state && (state.name === 'core:HeatingTargetTemperatureState')));
				if (heatingTemp)
				{
					this.homey.app.logStates(`${this.getName()}: core:HeatingTargetTemperatureState = ${heatingTemp.value}`);
					this.triggerCapabilityListener('target_temperature.heating', heatingTemp.value,
					{
						fromCloudSync: true,
					}).catch(this.error);
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
						const deviceState = element.deviceStates[x];
						if (deviceState.name === 'core:TemperatureState')
						{
							this.homey.app.logStates(`${this.getName()}: core:TemperatureState = ${deviceState.value}`);
							const oldState = this.getState().measure_temperature;
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.setCapabilityValue('measure_temperature', newState).catch(this.error);
							}
						}
						else if (deviceState.name === 'zigbee:ACLouverPositionState')
						{
							this.homey.app.logStates(`${this.getName()}: zigbee:ACLouverPositionState = ${deviceState.value}`);
							const oldState = this.getState().ac_louver_position;
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('ac_louver_position', deviceState.value,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
						else if (deviceState.name === 'zigbee:ControlSequenceOfThermostatOperationState')
						{
							this.homey.app.logStates(`${this.getName()}: zigbee:ControlSequenceOfThermostatOperationState = ${deviceState.value}`);
							const oldState = this.getState().ac_control_mode;
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('ac_control_mode', deviceState.value,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
						else if (deviceState.name === 'zigbee:ThermostatModeState')
						{
							this.homey.app.logStates(`${this.getName()}: zigbee:ThermostatModeState = ${deviceState.value}`);
							const oldState = this.getState().ac_thermostat_mode;
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('ac_thermostat_mode', deviceState.value,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
						else if (deviceState.name === 'zigbee:FanSpeedModeState')
						{
							this.homey.app.logStates(`${this.getName()}: zigbee:FanSpeedModeState = ${deviceState.value}`);
							const oldState = this.getState().ac_fan_speed_mode;
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('ac_fan_speed_mode', newState,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
						else if (deviceState.name === 'core:CoolingTargetTemperatureState')
						{
							this.homey.app.logStates(`${this.getName()}: core:CoolingTargetTemperatureState = ${deviceState.value}`);
							const oldState = this.getState()['target_temperature.cooling'];
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('target_temperature.cooling', newState,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
						else if (deviceState.name === 'core:HeatingTargetTemperatureState')
						{
							this.homey.app.logStates(`${this.getName()}: core:HeatingTargetTemperatureState = ${deviceState.value}`);
							const oldState = this.getState()['target_temperature.heating'];
							const newState = deviceState.value;
							if (oldState !== newState)
							{
								this.triggerCapabilityListener('target_temperature.heating', newState,
								{
									fromCloudSync: true,
								}).catch(this.error);
							}
						}
					}
				}
			}
		}
	}

}

module.exports = zigbeeACDevice;
