'use strict';

const WindowCoveringsDevice = require( '../WindowCoveringsDevice' );

/**
 * Device class for exterior venetian blinds with the io:ExteriorVenetianBlindIOComponent controllable name in TaHoma
 * @extends {WindowCoveringsDevice}
 */
class InteriorBlindDevice extends WindowCoveringsDevice
{
    onInit()
    {
        super.onInit();

        this.closureStateName = '';
    }
}

module.exports = InteriorBlindDevice;