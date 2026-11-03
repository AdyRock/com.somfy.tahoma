/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

const CapabilitiesXRef = [
	{
		homeyName: 'eh_operating_mode',
		somfyNameGet: 'core:OperatingModeState',
		somfyNameSet: ['setOperatingMode'],
	},
];

class NetatmoHomeControllerDevice extends SensorDevice
{

	async onInit()
	{
		await super.onInit(CapabilitiesXRef);
		this.boostSync = true;
	}

	async onCapability(capabilityXRef, value, opts)
	{
		if ((capabilityXRef.homeyName === 'eh_operating_mode') && (!opts || !opts.fromCloudSync))
		{
			const states = await super.getStates();
			const durationState = Array.isArray(states)
				? states.find((state) => state && state.name === 'netatmo:NetatmoDerogationDefaultDurationState')
				: null;

			if (!durationState || (durationState.value === null) || (durationState.value === undefined))
			{
				throw new Error('Unable to set the Netatmo operating mode because its default derogation duration is unavailable');
			}

			return super.onCapability({
				...capabilityXRef,
				parameterArray: [value, durationState.value],
			}, value, opts);
		}

		return super.onCapability(capabilityXRef, value, opts);
	}

	// Update the operating mode
	async syncEvents(events, local)
	{
		await this.syncEventsList(events, CapabilitiesXRef, local);
	}

}

module.exports = NetatmoHomeControllerDevice;
