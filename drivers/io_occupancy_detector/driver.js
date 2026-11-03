/* jslint node: true */

'use strict';

const Driver = require('../Driver');

/**
 * Driver class for the opening detector with the io:SomfyOccupancyIOSystemSensor, rtds:RTDSMotionSensor and io:OccupancyIOSystemDeviceSensor controllable name in TaHoma
 * @extends {Driver}
 */
class MotionDetectorDriver extends Driver {

  async onInit() {
		this.deviceType = ['io:SomfyOccupancyIOSystemSensor', 'rtds:RTDSMotionSensor', 'zwave:ZWaveNotificationMotionSensor', 'io:OccupancyIOSystemDeviceSensor'];

		/** * MOTION TRIGGERS ** */
		this._triggerMotionChange = this.homey.flow.getDeviceTriggerCard('motion_has_changed');
  }

  triggerFlows(device, capability, value)
  {
    const tokens = {
      isMotion: value,
    };

    const state = {
      alarm_motion: value,
    };

    this.triggerFlow(this._triggerMotionChange, device, tokens, state);
  }

}

module.exports = MotionDetectorDriver;
