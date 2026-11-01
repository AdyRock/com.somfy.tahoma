/* jslint node: true */

'use strict';

const Driver = require('../Driver');

class HumiditySensorDriver extends Driver
{
	async onInit()
	{
		this.deviceType = [
			'zigbee:RelativeHumidityComponent',
			'netatmo:HumidityComponent',
			'somfythermostat:SomfyThermostatHumiditySensor',
		];
	}
}

module.exports = HumiditySensorDriver;
