/*jslint node: true */
'use strict';

const Device = require('./Device');
const Tahoma = require('./../lib/Tahoma');
const Homey = require('homey');

/**
 * Device class for a light controller 
 * @extends {Device}
 */

class LightControllerDevice extends Device
{
    async onInit()
    {
        this.commandExecuting = '';

        this.lightState = {
            off: false,
            on: true
        };

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
        this.registerCapabilityListener('light_temperature', this.onCapabilityLight_temperature.bind(this));

        await super.onInit();

        this.boostSync = true;
    }

    async onCapabilityOnOff(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.commandExecuting === 'onOff')
            {
                // This command is still processing
                return;
            }

            if (this.boostSync)
            {
                await Homey.app.boostSync();
            }

            const deviceData = this.getData();
            if (this.executionId !== null)
            {
                // Wait for previous command to complete
                let retries = 20;
                while ((this.executionId !== null) && (retries-- > 0))
                {
                    await Homey.app.asyncDelay(500);
                }
            }

            var action;
            if (value == false)
            {
                action = {
                    name: 'off',
                    parameters: []
                };
            }
            else
            {
                action = {
                    name: 'on',
                    parameters: []
                };
            }
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

                    if (this.boostSync)
                    {
                        await Homey.app.unBoostSync();
                    }
                    throw (new Error(result.error));
                }
                else
                {
                    this.commandExecuting = 'onOff';
                    this.executionId = result.execId;
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityOnOff", "Failed to send command");
                if (this.boostSync)
                {
                    await Homey.app.unBoostSync();
                }
                throw (new Error("Failed to send command"));
            }
        }
        else
        {
            this.setCapabilityValue('onoff', (value == true));
        }
    }

    async onCapabilityDim(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.commandExecuting === 'dim')
            {
                // This command is still processing
                return;
            }

            if (this.boostSync)
            {
                await Homey.app.boostSync();
            }

            const deviceData = this.getData();
            if (this.executionId !== null)
            {
                // Wait for previous command to complete
                let retries = 30;
                while ((this.executionId !== null) && (retries-- > 0))
                {
                    await Homey.app.asyncDelay(500);
                }
            }

            var action;
            action = {
                name: 'setIntensity',
                parameters: [Math.round(value * 100)]
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

                    if (this.boostSync)
                    {
                        await Homey.app.unBoostSync();
                    }
                    throw (new Error(result.error));
                }
                else
                {
                    this.commandExecuting = 'dim';
                    this.executionId = result.execId;
                }
            }
            else
            {
                if (Homey.app.infoLogEnabled)
                {
                    Homey.app.logInformation(this.getName() + ": onCapabilityDim", "Failed to send command");
                }

                if (this.boostSync)
                {
                    await Homey.app.unBoostSync();
                }
                throw (new Error("Failed to send command"));
            }
        }
        else
        {
            this.setCapabilityValue('dim', value);
        }
    }

    async onCapabilityLight_temperature(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.commandExecuting === 'light_temperature')
            {
                // This command is still processing
                return;
            }

            if (this.boostSync)
            {
                await Homey.app.boostSync();
            }

            const deviceData = this.getData();
            if (this.executionId !== null)
            {
                // Wait for previous command to complete
                let retries = 20;
                while ((this.executionId !== null) && (retries-- > 0))
                {
                    await Homey.app.asyncDelay();
                }
            }

            const minTemperature = this.getSetting('minTemperature');
            const maxTemperature = this.getSetting('maxTemperature');
            var action;
            action = {
                name: 'setColorTemperature',
                parameters: [Math.round(value * (maxTemperature - minTemperature) + minTemperature)]
            };
            let result = await Tahoma.executeDeviceAction(deviceData.label, deviceData.deviceURL, action);
            if (result !== undefined)
            {
                if (result.errorCode)
                {
                    if (Homey.app.infoLogEnabled)
                    {
                        Homey.app.logInformation(this.getName(),
                        {
                            message: result.error,
                            stack: result.errorCode
                        });
                    }

                    if (this.boostSync)
                    {
                        await Homey.app.unBoostSync();
                    }
                    throw (new Error(result.error));
                }
                else
                {
                    this.commandExecuting = 'light_temperature';
                    this.executionId = result.execId;
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityDim", "Failed to send command");
                if (this.boostSync)
                {
                    await Homey.app.unBoostSync();
                }
                throw (new Error("Failed to send command"));
            }
        }
        else
        {
            this.setCapabilityValue('light_temperature', value);
        }
    }

    /**
     * Gets the data from the TaHoma cloud
     */
    async getStates()
    {
        try
        {
            const states = await super.getStates();
            if (states)
            {
                // On / Off
                const OnOffState = states.find(state => state.name === 'core:OnOffState');
                if (OnOffState)
                {
                    Homey.app.logStates(this.getName() + ": core:OnOffState = " + OnOffState.value);
                    this.triggerCapabilityListener('onoff', (OnOffState.value === 'on'),
                    {
                        fromCloudSync: true
                    });
                }

                // Dim level
                const dimState = states.find(state => state.name === 'core:LightIntensityState');
                if (dimState)
                {
                    Homey.app.logStates(this.getName() + ": core:dimState = " + dimState.value);
                    this.triggerCapabilityListener('dim', (dimState.value / 100),
                    {
                        fromCloudSync: true
                    });
                }

                // Color level
                const colorState = states.find(state => state.name === 'core:ColorTemperatureState');
                if (colorState)
                {
                    const minTemperature = this.getSetting('minTemperature');
                    const maxTemperature = this.getSetting('maxTemperature');

                    Homey.app.logStates(this.getName() + ": core:ColorTemperatureState = " + colorState.value);
                    this.triggerCapabilityListener('light_temperature', ((colorState.value - minTemperature) / (maxTemperature - minTemperature)),
                    {
                        fromCloudSync: true
                    });
                }
            }

            return states;
        }
        catch (error)
        {
            this.setUnavailable(null);
            Homey.app.logInformation(this.getName(),
            {
                message: error.message,
                stack: error.stack
            });
        }

        return null;
    }

    // look for updates in the events array
    async syncEvents(events)
    {
        if (events === null)
        {
            return this.getStates();
        }

        const myURL = this.getDeviceUrl();

        // Process events sequentially so they are in the correct order
        for (var i = 0; i < events.length; i++)
        {
            const element = events[i];
            if (element.name === 'DeviceStateChangedEvent')
            {
                if ((element.deviceURL === myURL) && element.deviceStates)
                {
                    // Got what we need to update the device so lets find it
                    for (var x = 0; x < element.deviceStates.length; x++)
                    {
                        const deviceState = element.deviceStates[x];
                        await this.processEventState(deviceState);
                    }
                }
            }
            else if (element.name === 'ExecutionStateChangedEvent')
            {
                if ((element.newState === 'COMPLETED') || (element.newState === 'FAILED'))
                {
                    if (this.executionId === element.execId)
                    {
                        if (this.boostSync)
                        {
                            await Homey.app.unBoostSync();
                        }
                        this.commandExecuting = '';
                        this.executionId = null;
                    }
                }
            }
        }

        return myURL;
    }

    // Process the device sate
    async processEventState(deviceState)
    {
        if (deviceState.name === 'core:OnOffState')
        {
            Homey.app.logStates(this.getName() + ": core:OnOffState = " + deviceState.value);
            const oldState = this.getState().onoff;
            const newSate = (deviceState.value === 'on');
            if (oldState !== newSate)
            {
                this.triggerCapabilityListener('onoff', newSate,
                {
                    fromCloudSync: true
                });
            }
            return true;
        }

        if (deviceState.name === 'core:LightIntensityState')
        {
            Homey.app.logStates(this.getName() + ": core:LightIntensityState = " + deviceState.value);
            const oldState = this.getState().dim;
            const newSate = parseInt(deviceState.value) / 100;
            if (oldState !== newSate)
            {
                this.triggerCapabilityListener('dim', newSate,
                {
                    fromCloudSync: true
                });
            }
            return true;
        }

        if (deviceState.name === 'core:ColorTemperatureState')
        {
            const minTemperature = this.getSetting('minTemperature');
            const maxTemperature = this.getSetting('maxTemperature');
        
            Homey.app.logStates(this.getName() + ": core:ColorTemperatureState = " + deviceState.value);
            const oldState = this.getState().light_temperature;
            const newSate = ((parseInt(deviceState.value) - minTemperature) / (maxTemperature - minTemperature));
            if (oldState !== newSate)
            {
                this.triggerCapabilityListener('light_temperature', newSate,
                {
                    fromCloudSync: true
                });
            }
            return true;
        }

        return false;
    }
}

module.exports = LightControllerDevice;