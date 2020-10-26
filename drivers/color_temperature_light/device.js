'use strict';

const SensorDevice = require('../SensorDevice');
const Tahoma = require('../../lib/Tahoma');
const Homey = require('homey');

/**
 * Device class for the light controller with the io_dimmable_light controllable name in TaHoma
 * @extends {SensorDevice}
 */

class ColorTemperatureLightControllerDevice extends SensorDevice
{
    async onInit()
    {
        this.hueDelayTimerId = null;

        await super.onInit();
        this.lightState = {
            off: false,
            on: true
        };

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('dim', this.onCapabilityDim.bind(this));
        this.registerCapabilityListener('light_temperature', this.onCapabilityLight_temperature.bind(this));
        this.registerCapabilityListener('light_hue', this.onCapabilityLight_hue.bind(this));
        this.registerCapabilityListener('light_saturation', this.onCapabilityLight_saturation.bind(this));
        this.registerCapabilityListener('light_mode', this.onCapabilityLight_mode.bind(this));
    }

    async onCapabilityOnOff(value, opts, callback)
    {
        if (!opts || !opts.fromCloudSync)
        {
            const deviceData = this.getData();
            const executionId = this.getStoreValue('executionId');
            if ((executionId !== undefined) && (executionId !== null))
            {
                await Tahoma.cancelExecution(executionId);
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
                    throw (new Error(result.error));
                }
                else
                {
                    this.setStoreValue('executionId', result.execId);
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityOnOff", "Failed to send command");
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
            const deviceData = this.getData();
            const executionId = this.getStoreValue('executionId');
            if ((executionId !== undefined) && (executionId !== null))
            {
                await Tahoma.cancelExecution(executionId);
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
                    throw (new Error(result.error));
                }
                else
                {
                    this.setStoreValue('executionId', result.execId);
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityDim", "Failed to send command");
                throw (new Error("Failed to send command"));
            };
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
            const deviceData = this.getData();
            const executionId = this.getStoreValue('executionId');
            if ((executionId !== undefined) && (executionId !== null))
            {
                await Tahoma.cancelExecution(executionId);
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
                    Homey.app.logInformation(this.getName(),
                    {
                        message: result.error,
                        stack: result.errorCode
                    });
                    throw (new Error(result.error));
                }
                else
                {
                    this.setStoreValue('executionId', result.execId);
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityDim", "Failed to send command");
                throw (new Error("Failed to send command"));
            };
        }
        else
        {
            this.setCapabilityValue('light_temperature', value);
        }
    }

    async onCapabilityLight_hue(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {

            // Delay hue as the UI send both hue and saturation. Flows will only send one
            if (!opts['timer'])
            {
                this.log("Hue delayed: ", this.hueDelayTimerId);
                if (this.hueDelayTimerId)
                {
                    clearTimeout(this.hueDelayTimerId);
                    this.hueDelayTimerId = null;
                }
                opts.timer = true;
                this.hueDelayTimerId = setTimeout(() => this.onCapabilityLight_hue(value, opts), 1000);
                return;
            }

            this.log("Hue run");

            const deviceData = this.getData();
            const executionId = this.getStoreValue('executionId');
            if ((executionId !== undefined) && (executionId !== null))
            {
                await Tahoma.cancelExecution(executionId);
            }

            const saturation = this.getState().light_saturation;
            var action;
            action = {
                name: 'setHueAndSaturation',
                parameters: [Math.round(value * 360), saturation * 100]
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
                    this.setStoreValue('executionId', result.execId);
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityLight_hue", "Failed to send command");
                throw (new Error("Failed to send command"));
            };
        }
        else
        {
            this.setCapabilityValue('light_hue', value);
        }
    }

    async onCapabilityLight_saturation(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.hueDelayTimerId)
            {
                clearTimeout(this.hueDelayTimerId);
                this.hueDelayTimerId = null;
                this.log("Hue cleared");
            }

            this.log("saturation run");

            const deviceData = this.getData();
            const executionId = this.getStoreValue('executionId');
            if ((executionId !== undefined) && (executionId !== null))
            {
                await Tahoma.cancelExecution(executionId);
            }

            const hue = this.getState().hue;
            var action;
            action = {
                name: 'setHueAndSaturation',
                parameters: [hue * 360, value * 100]
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
                    this.setStoreValue('executionId', result.execId);
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapabilityDim", "Failed to send command");
                throw (new Error("Failed to send command"));
            };
        }
        else
        {
            this.setCapabilityValue('light_saturation', value);
        }
    }

    async onCapabilityLight_mode(value, opts)
    {}

    /**
     * Gets the data from the TaHoma cloud
     */
    async sync()
    {
        try
        {
            const states = await super.sync();
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

                // White level
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

                // Hue level
                const hueState = states.find(state => state.name === 'core:ColorHueState');
                if (hueState)
                {
                    Homey.app.logStates(this.getName() + ": core:ColorHueState = " + hueState.value);
                    this.triggerCapabilityListener('light_hue', (hueState.value / 360),
                    {
                        fromCloudSync: true
                    });
                }

                // Saturation level
                const saturationState = states.find(state => state.name === 'core:ColorSaturationState');
                if (saturationState)
                {
                    Homey.app.logStates(this.getName() + ": core:ColorSaturationState = " + saturationState.value);
                    this.triggerCapabilityListener('light_hue', (saturationState.value / 100),
                    {
                        fromCloudSync: true
                    });
                }
            }
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
    }

    // look for updates in the events array
    async syncEvents(events)
    {
        if (events === null)
        {
            return this.sync();
        }

        const myURL = this.getDeviceUrl();

        // Process events sequentially so they are in the correct order
        for (var i = 0; i < events.length; i++)
        {
            const element = events[i];
            if (element['name'] === 'DeviceStateChangedEvent')
            {
                if ((element['deviceURL'] === myURL) && element['deviceStates'])
                {
                    // Got what we need to update the device so lets find it
                    for (var x = 0; x < element.deviceStates.length; x++)
                    {
                        const deviceState = element.deviceStates[x];
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
                        }
                        else if (deviceState.name === 'core:LightIntensityState')
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
                        }
                        else if (deviceState.name === 'core:ColorTemperatureState')
                        {
                            Homey.app.logStates(this.getName() + ": core:ColorTemperatureState = " + deviceState.value);
                            const oldState = this.getState().light_temperature;
                            const minTemperature = this.getSetting('minTemperature');
                            const maxTemperature = this.getSetting('maxTemperature');

                            const newSate = ((parseInt(deviceState.value) - minTemperature) / (maxTemperature - minTemperature));
                            if (oldState !== newSate)
                            {
                                this.triggerCapabilityListener('light_temperature', newSate,
                                {
                                    fromCloudSync: true
                                });
                            }
                        }
                        else if (deviceState.name === 'core:ColorHueState')
                        {
                            Homey.app.logStates(this.getName() + ": core:ColorHueState = " + deviceState.value);
                            const oldState = this.getState().light_hue;
                            const newSate = (parseInt(deviceState.value) / 360);
                            if (oldState !== newSate)
                            {
                                this.triggerCapabilityListener('light_hue', newSate,
                                {
                                    fromCloudSync: true
                                });
                            }
                        }
                        else if (deviceState.name === 'core:ColorSaturationState')
                        {
                            Homey.app.logStates(this.getName() + ": core:ColorSaturationState = " + deviceState.value);
                            const oldState = this.getState().light_saturation;
                            const newSate = (parseInt(deviceState.value) / 100);
                            if (oldState !== newSate)
                            {
                                this.triggerCapabilityListener('light_saturation', newSate,
                                {
                                    fromCloudSync: true
                                });
                            }
                        }
                    }
                }
            }
        }
    }
}

module.exports = ColorTemperatureLightControllerDevice;