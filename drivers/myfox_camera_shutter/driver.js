/* jslint node: true */

'use strict';

const Driver = require('../Driver');

/**
 * Driver class for the security camera privacy shutter with the
 * myfox:SomfyOnePlusCameraController and myfox:SomfyProtectSecurityCameraController
 * controllable names in TaHoma
 * @extends {Driver}
 */
class myFoxCameraShutterDriver extends Driver
{

	async onInit()
	{
		this.deviceType = ['myfox:SomfyOnePlusCameraController', 'myfox:SomfyProtectSecurityCameraController'];
		await super.onInit();
	}

}

module.exports = myFoxCameraShutterDriver;
