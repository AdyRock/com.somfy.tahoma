/* jslint node: true */

'use strict';

const Driver = require('../Driver');

class NetatmoHomeControllerDriver extends Driver
{

	async onInit()
	{
		this.deviceType = ['netatmo:HomeController'];
	}

}

module.exports = NetatmoHomeControllerDriver;
