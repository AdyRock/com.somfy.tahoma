/*jslint node: true */
'use strict';
const Homey = require('homey');
const Tahoma = require('./../lib/Tahoma');
/**
 * Base class for devices
 * @extends {Homey.Device}
 */
class Device extends Homey.Device
{
    async onInit(CapabilitiesXRef)
    {
        this.boostSync = false;
        this.executionId = null;

        if (CapabilitiesXRef)
        {
            CapabilitiesXRef.forEach(element =>
            {
                this.registerCapabilityListener(element.homeyName, this.onCapability.bind(this, element));
            });

            this.syncEventsList(null, CapabilitiesXRef);
        }
        else
        {
            this.getStates();
        }
        this.log('Device init:', this.getName(), 'class:', this.getClass());
    }

    onAdded()
    {
        this.log('device added');
    }

    onDeleted()
    {
        if (this.timerId)
        {
            clearTimeout(this.timerId);
        }
        this.log('device deleted');
    }

    /**
     * Returns the TaHoma device url
     * @return {String}
     */
    getDeviceUrl()
    {
        return this.getData().deviceURL;
    }

    /**
     * Returns the io controllable name(s) of TaHoma
     * @return {Array} deviceType
     */
    getDeviceType()
    {
        return this.getDriver().getDeviceType();
    }

    isReady()
    {
        return this._ready;
    }

    async onCapability(capabilityXRef, value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.boostSync)
            {
                await Homey.app.boostSync();
            }

            let somfyValue = value;
            if (capabilityXRef.parameters)
            {
                somfyValue = capabilityXRef.parameters;
            }
            else if (capabilityXRef.scale)
            {
                somfyValue *= capabilityXRef.scale;
            }
            else if (capabilityXRef.compare)
            {
                somfyValue = capabilityXRef.compare[(value === false ? 0 : 1)];
            }

            const deviceData = this.getData();
            if (this.executionId !== null)
            {
                await Tahoma.cancelExecution(this.executionId);
            }

            var action = {
                name: capabilityXRef.somfyNameSet,
                parameters: [somfyValue]
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
                    this.executionId = result.execId;
                }
            }
            else
            {
                Homey.app.logInformation(this.getName() + ": onCapability " + capabilityXRef.somfyNameSet, "Failed to send command");
                if (this.boostSync)
                {
                    await Homey.app.unBoostSync();
                }
                throw (new Error("Failed to send command"));
            }
        }
        else
        {
            try
            {
                await this.setCapabilityValue(capabilityXRef.homeyName, value);

                // For boolean states, setup a safety timeout incase the off state is not received.
                if (typeof value === 'boolean')
                {
                    if (value)
                    {
                        this.checkTimerID = setTimeout(() =>
                        {
                            this.syncEvents(null);
                        }, 60000);
                    }
                    else
                    {
                        clearTimeout(this.checkTimerID);
                    }
                }

                if (this.getDriver().triggerFlows)
                {
                    //trigger flows
                    this.getDriver().triggerFlows(this, capabilityXRef.homeyName, value);

                }
            }
            catch (err)
            {
                Homey.app.logInformation(this.getName() + ": onCapability " + capabilityXRef.homeyName, err);
            }
        }
    }

    /**
     * Gets the sensor data from the TaHoma cloud
     * Capabilities{somfyNameGet: 'name of the Somfy capability, homeyName: 'name of the Homey capability', compare:[] 'text array for false and true value or not specified if real value' }
     */
    async syncList(CapabilitiesXRef)
    {
        try
        {
            const states = await this.getStates();
            if (states)
            {
                // Look for each of the required capabilities
                for (const capability of CapabilitiesXRef)
                {
                    try
                    {
                        const state = states.find(state => state.name === capability.somfyNameGet);
                        if (state)
                        {
                            if (typeof state.value === 'string')
                            {
                                state.value = state.value.toLowerCase();
                            }

                            // Found the entry
                            Homey.app.logStates(this.getName() + ": " + capability.somfyNameGet + "= " + state.value);
                            await this.triggerCapabilityListener(capability.homeyName, (capability.compare ? (state.value === capability.compare[1]) : (capability.scale ? state.value / capability.scale : state.value)), { fromCloudSync: true });
                        }
                    }
                    catch (error)
                    {
                        Homey.app.logInformation(this.getName(),
                        {
                            message: error.message,
                            stack: error.stack
                        });
                    }
                }
            }
        }
        catch (error)
        {
            Homey.app.logInformation(this.getName(),
            {
                message: error.message,
                stack: error.stack
            });
        }
    }

    // look for updates in the events array
    async syncEventsList(events, CapabilitiesXRef)
    {
        if (events === null)
        {
            // No events so synchronise all capabilities
            return this.syncList(CapabilitiesXRef);
        }

        const myURL = this.getDeviceUrl();
        const oldStates = this.getState();

        // Process events sequentially so they are in the correct order
        // For each event that has been received
        for (var i = 0; i < events.length; i++)
        {
            // get the event
            const element = events[i];

            // Ensure we are processing a state changed event
            if (element.name === 'DeviceStateChangedEvent')
            {
                // If the URL matches the it is for this device
                if ((element.deviceURL === myURL) && element.deviceStates)
                {
                    // Got what we need to update the device so lets process each capability
                    for (var x = 0; x < element.deviceStates.length; x++)
                    {
                        // Get the Somfy capability
                        const deviceState = element.deviceStates[x];

                        // look up the entry so we can get the Homey capability, etc
                        const found = CapabilitiesXRef.find(element => element.somfyNameGet === deviceState.name);

                        if (found)
                        {
                            // Yep we can relate to this one
                            Homey.app.logStates(this.getName() + ": " + found.somfyNameGet + "= " + deviceState.value);
                            const oldState = oldStates[found.homeyName];
                            let newState = (found.compare ? (deviceState.value === found.compare[1]) : (deviceState.value));

                            if (typeof oldState === 'number')
                            {
                                newState = Number(newState);
                            }
                            else if (typeof oldState === 'string')
                            {
                                newState = newState.toLowerCase();
                            }

                            if (oldState !== newState)
                            {
                                this.triggerCapabilityListener(found.homeyName, newState, { fromCloudSync: true });
                            }
                        }
                    }
                }
            }
        }
    }

    // Get all the states for this device from Tahoma
    async getStates()
    {
        try
        {
            if (Homey.app.loggedIn)
            {
                if (Homey.app.infoLogEnabled)
                {
                    Homey.app.logInformation("Device initial sync.", this.getName());
                }

                const deviceURL = this.getDeviceUrl();
                if (deviceURL)
                {
                    return await Tahoma.getDeviceStates(deviceURL);
                }

                if (process.env.DEBUG === '1')
                {
                    const simData = Homey.ManagerSettings.get('simData');
                    if (simData)
                    {
                        const deviceOid = this.getData().id;
                        for (var i = 0; i < simData.length; i++)
                        {
                            if (simData[i].oid == deviceOid)
                            {
                                return simData[i].states;
                            }
                        }
                        return null;
                    }
                }
            }
        }
        catch (error)
        {
            Homey.app.logInformation("Device initial sync.",
            {
                message: this.getName(),
                stack: error
            });
        }
        return null;
    }
}
module.exports = Device;