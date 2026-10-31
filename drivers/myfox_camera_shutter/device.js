/* jslint node: true */

'use strict';

const SensorDevice = require('../SensorDevice');

const CapabilitiesXRef = [
	{
		homeyName: 'onoff',
		somfyNameGet: 'myfox:ShutterStatusState',
		somfyNameSet: ['close', 'open'],
		compare: ['closed', 'opened'],
		ignoreValue: true,
	},
];

/**
 * Device class for the security camera privacy shutter with the
 * myfox:SomfyOnePlusCameraController and myfox:SomfyProtectSecurityCameraController
 * controllable names in TaHoma
 * @extends {SensorDevice}
 */
class myFoxCameraShutterDevice extends SensorDevice
{

	async onInit()
	{
		await super.onInit(CapabilitiesXRef);
		this.boostSync = true;
	}

	// Update the capabilities
	async syncEvents(events, local)
	{
		this.syncEventsList(events, CapabilitiesXRef, local);
	}

}

module.exports = myFoxCameraShutterDevice;
