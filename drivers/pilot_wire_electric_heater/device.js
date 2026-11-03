/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

const CapabilitiesXRef = [
	{
		homeyName: 'heating_level_state',
		somfyNameGet: ['ovp:TargetHeatingLevelState', 'core:TargetHeatingLevelState'],
		somfyNameSet: ['setHeatingLevel'],
		conversions: { 'comfort-1': 'comfort_1', 'comfort-2': 'comfort_2' },
	},
	{
		homeyName: 'onoff',
		somfyNameGet: 'core:OnOffState',
		somfyNameSet: ['off'],
		compare: ['off', 'on'],
		parameters: '',
	},
];
class PilotWireElectricHeaterDevice extends SensorDevice
{

	async onInit()
	{
		await super.onInit(CapabilitiesXRef);
		this.boostSync = true;
	}

	async onCapability(capabilityXRef, value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			if (capabilityXRef.homeyName === 'onoff')
			{
				if (value)
				{
					// There is no 'on' command, so turn on by applying a heating level
					let level = this.getCapabilityValue('heating_level_state');
					if (!level || (level === 'off'))
					{
						level = 'comfort';
					}
					return this.triggerCapabilityListener('heating_level_state', level);
				}
			}
			else if ((capabilityXRef.homeyName === 'heating_level_state') && (typeof value === 'string'))
			{
				// Somfy uses comfort-1 / comfort-2 rather than the Homey enum ids comfort_1 / comfort_2
				value = value.replace('_', '-');
			}
		}

		return super.onCapability(capabilityXRef, value, opts);
	}

	// Update the capabilities
	async syncEvents(events, local)
	{
		this.syncEventsList(events, CapabilitiesXRef, local);
	}

}

module.exports = PilotWireElectricHeaterDevice;
