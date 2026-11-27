/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

const CapabilitiesXRef = [
	{
		homeyName: 'meter_power',
		somfyNameGet: 'core:ElectricEnergyConsumptionState',
		somfyNameSet: [],
		scale: 1000,
	},
];
const CapabilitiesXRefWithPower = [
	{
		homeyName: 'meter_power',
		somfyNameGet: 'core:ElectricEnergyConsumptionState',
		somfyNameSet: [],
		scale: 1,
	},
	{
		homeyName: 'measure_power',
		somfyNameGet: 'core:ElectricPowerConsumptionState',
		somfyNameSet: [],
		scale: 1,
	},
];
const CapabilitiesXRefLinky = [
	{
		homeyName: 'meter_power',
		somfyNameGet: 'core:ElectricEnergyConsumptionState',
		somfyNameSet: [],
		scale: 1000,
	},
	{
		homeyName: 'measure_power',
		somfyNameGet: 'core:ElectricPowerConsumptionState',
		somfyNameSet: [],
		scale: 1,
	},
];
class EnergySensorDevice extends SensorDevice
{

	async onInit()
	{
		this.CapabilitiesXRef = CapabilitiesXRef;
		const dd = this.getData();
		let controllableName = '';
		if (dd.controllableName)
		{
			controllableName = dd.controllableName.toString().toLowerCase();
		}
		if (controllableName === 'zigbee:linkyradiotransmittersensorcomponent')
		{
			this.CapabilitiesXRef = CapabilitiesXRefLinky;
		}
		else if (controllableName === 'zigbee:electricalenergyconsumptionsensorcomponent')
		{
			this.CapabilitiesXRef = CapabilitiesXRefWithPower;
		}
		else if (this.hasCapability('measure_power'))
		{
			this.removeCapability('measure_power').catch(this.error);
		}
		await super.onInit(this.CapabilitiesXRef);
	}

	// Update the capabilities
	async syncEvents(events, local)
	{
		this.syncEventsList(events, this.CapabilitiesXRef, local);
	}

}
module.exports = EnergySensorDevice;
