/*jslint node: true */
'use strict';

const Homey = require('homey');
const Driver = require('../Driver');

/**
 * Driver class for exterior venetian blinds with the rts:DualCurtainRTSComponent, rts:CurtainRTSComponent controllable name in TaHoma
 * @extends {Driver}
 */
class InteriorCurtainDriver extends Driver
{

    async onInit()
    {
        this.deviceType = ['rts:DualCurtainRTSComponent', 'rts:CurtainRTSComponent'];

        this.set_my_position = new Homey.FlowCardAction('set_my_position');
        this.set_my_position
            .register()
            .registerRunListener(async (args, state) =>
            {
                console.log("set_my_position");
                return args.device.onCapabilityMyPosition(true, null);
            });
    }

}

module.exports = InteriorCurtainDriver;