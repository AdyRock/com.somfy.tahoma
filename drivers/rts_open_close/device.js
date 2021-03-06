/*jslint node: true */
"use strict";

const Device = require('../Device');
const Tahoma = require('../../lib/Tahoma');
const Homey = require('homey');

/**
 * Device class for the opening detector with the rts:GarageDoor4TRTSComponent, rts:SlidingGateOpener4TRTSComponent controllable name in TaHoma
 * @extends {SensorDevice}
 */
class OpenCloseDevice extends Device
{
    async onInit()
    {
		this.registerCapabilityListener('button', this.onCapabilityButton.bind(this));
        await super.onInit();
		this.boostSync = true;
    }

    async onCapabilityButton(value)
    {
        const deviceData = this.getData();
        if (this.executionId !== null)
        {
            await Tahoma.cancelExecution(this.executionId);
            return;
        }

        var action = {
            name: 'cycle',
            parameters: []
        };
        let result = await Tahoma.executeDeviceAction(deviceData.label, deviceData.deviceURL, action);
        if (result !== undefined)
        {
            if (result.errorCode)
            {
                Homey.app.logInformation(this.getName(),
                {
                    message: result.error,
                    stack: result.errorCode
                });
                throw (new Error(result.error));
            }
            else
            {
				this.executionId = result.execId;
				if (this.boostSync)
				{
					await Homey.app.boostSync();
				}
            }
        }
        else
        {
            Homey.app.logInformation(this.getName() + ": onCapabilityOnOff", "Failed to send command");
            throw (new Error("Failed to send command"));
        }

    }

    /**
     * Gets the sensor data from the TaHoma cloud
     * @param {Array} data - device data from all the devices in the TaHoma cloud
     */
    async sync() {}

    // look for updates in the events array
    async syncEvents(events)
    {
        if (events === null)
        {
            return this.sync();
        }

        try
        {
            const myURL = this.getDeviceUrl();

            // Process events sequentially so they are in the correct order
            for (var i = 0; i < events.length; i++)
            {
                const element = events[i];
                if (element['name'] === 'ExecutionStateChangedEvent')
                {
                    if ((element['newState'] === 'COMPLETED') || (element['newState'] === 'FAILED'))
                    {
                        if (this.executionId === element['execId'])
                        {
                            if (this.boostSync)
                            {
                                await Homey.app.unBoostSync();
                            }
                            this.executionId = null;
                        }
                    }
                }
            }
        }
        catch (error)
        {
            this.setUnavailable(error.message);
            Homey.app.logInformation(this.getName(),
            {
                message: error.message,
                stack: error.stack
            });

        }
    }
}

module.exports = OpenCloseDevice;