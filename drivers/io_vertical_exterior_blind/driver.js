/* jslint node: true */

'use strict';

const ioWindowCoveringsDriver = require('../ioWindowCoveringsDriver');

/**
 * Driver class for vertical exterior blinds with the io:VerticalExteriorAwningIOComponent controllable name in TaHoma
 * @extends {ioWindowCoveringsDriver}
 */
class VerticalExteriorBlindDriver extends ioWindowCoveringsDriver
{

	async onInit()
	{
		this.deviceType = [
			'io:VerticalExteriorAwningIOComponent',
			'io:VerticalExteriorAwningVeluxIOComponent',
			'io:VerticalExteriorAwningWithBatteryIOComponent',
			'io:DynamicBlindIOComponent',
			'io:DynamicScreenIOComponent',
		];
		this.deviceWidgetType = ['DynamicScreen'];

		await super.onInit();
	}

}

module.exports = VerticalExteriorBlindDriver;
