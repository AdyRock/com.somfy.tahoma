/* jslint node: true */

'use strict';

const Driver = require('../Driver');

/**
 * Driver class for the pilot wire electric heater with the ovp:SomfyPilotWireElectricalHeaterOVPComponent controllable name in TaHoma
 * @extends {Driver}
 */
class PilotWireElectricHeaterDriver extends Driver
{

	async onInit()
	{
		this.deviceType = ['ovp:SomfyPilotWireElectricalHeaterOVPComponent'];
	}

}

module.exports = PilotWireElectricHeaterDriver;
