/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

const CapabilitiesXRef = [
	{
		homeyName: 'measure_noise',
		somfyNameGet: 'core:NoiseState',
		somfyNameSet: [],
	},
];

class NetatmoNoiseSensorDevice extends SensorDevice
{

	async onInit()
	{
		await super.onInit(CapabilitiesXRef);
	}

	// Update the noise measurement
	async syncEvents(events, local)
	{
		await this.syncEventsList(events, CapabilitiesXRef, local);
	}

}

module.exports = NetatmoNoiseSensorDevice;
