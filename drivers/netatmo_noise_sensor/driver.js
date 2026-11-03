/* jslint node: true */

'use strict';

const Driver = require('../Driver');

class NetatmoNoiseSensorDriver extends Driver
{

	async onInit()
	{
		this.deviceType = ['netatmo:NoiseComponent'];
	}

}

module.exports = NetatmoNoiseSensorDriver;
