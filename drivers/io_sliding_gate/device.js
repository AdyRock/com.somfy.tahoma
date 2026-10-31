/* jslint node: true */

'use strict';

const WindowCoveringsDevice = require('../WindowCoveringsDevice');

/**
 * Device class for exterior venetian blinds with the io:SlidingDiscreteGateOpenerIOComponent controllable name in TaHoma
 * @extends {WindowCoveringsDevice}
 */
class SlidingGateDevice extends WindowCoveringsDevice
{

    async resolveDynamicGatePedestrianAliasId()
    {
        try
        {
            const allDevices = await this.homey.app.getDeviceData();
            if (!Array.isArray(allDevices))
            {
                return '';
            }

            const myURL = this.getDeviceUrl();
            const current = allDevices.find((device) => device && device.deviceURL === myURL);
            if (!current || !Array.isArray(current.attributes))
            {
                return '';
            }

            const supportedAliasesAttribute = current.attributes.find((attribute) => (
                attribute
                && (attribute.name === 'core:SupportedAliases')
                && Array.isArray(attribute.value)
            ));
            if (!supportedAliasesAttribute)
            {
                return '';
            }

            const pedestrianAlias = supportedAliasesAttribute.value.find((alias) => (
                alias
                && (alias.type === 'pedestrian')
                && alias.id
            ));

            if (!pedestrianAlias)
            {
                return '';
            }

            return String(pedestrianAlias.id);
        }
        catch (error)
        {
            return '';
        }
    }

    async onCapabilityPedestrian(value, opts)
    {
        if (!opts || !opts.fromCloudSync)
        {
            if (this.controllableName !== 'io:dynamicgateiocomponent')
            {
                return super.onCapabilityPedestrian(value, opts);
            }

            if (value === false)
            {
                return Promise.resolve();
            }

            const aliasId = this.dynamicPedestrianAliasId || '';
            if (!aliasId)
            {
                return Promise.resolve();
            }

            const deviceData = this.getData();
            try
            {
                if (this.executionId !== null)
                {
                    await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
                }

                const action = {
                    name: 'goToAlias',
                    parameters: [aliasId],
                };
                const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
                this.executionCmd = action.name;
                this.executionId = { id: result.execId, local: result.local };

                this.setWarning(null).catch(this.error);
            }
            catch (err)
            {
                this.executionCmd = '';
                this.setWarning(err.message).catch(this.error);
                this.logCapabilityCommandError('onCapabilityPedestrian', err);
            }

            return Promise.resolve();
        }

        return super.onCapabilityPedestrian(value, opts);
    }

    async onInit()
    {
        if (this.hasCapability('lock_state'))
        {
            this.removeCapability('lock_state').catch(this.error);
        }

        this.registerCapabilityListener('pedestrian', this.onCapabilityPedestrian.bind(this));

        await super.onInit();

		const dd = this.getData();

		this.controllableName = '';
		if (dd.controllableName)
		{
			this.controllableName = dd.controllableName.toString().toLowerCase();
		}

        const isDynamicGate = (this.controllableName === 'io:dynamicgateiocomponent');
        this.dynamicPedestrianAliasId = isDynamicGate ? await this.resolveDynamicGatePedestrianAliasId() : '';

        if (isDynamicGate)
        {
            if (this.dynamicPedestrianAliasId)
            {
                if (!this.hasCapability('pedestrian'))
                {
                    this.addCapability('pedestrian').catch(this.error);
                }
            }
            else if (this.hasCapability('pedestrian'))
            {
                this.removeCapability('pedestrian').catch(this.error);
            }
        }
        else if (!this.hasCapability('pedestrian'))
        {
            this.addCapability('pedestrian').catch(this.error);
        }

		if (this.controllableName === 'io:slidinggateopeneriocomponent')
		{
			if (!this.hasCapability('windowcoverings_set'))
			{
				this.addCapability('windowcoverings_set').catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('windowcoverings_set'))
			{
				this.removeCapability('windowcoverings_set').catch(this.error);
			}

			if (!this.hasCapability('windowcoverings_state'))
			{
				this.addCapability('windowcoverings_state').catch(this.error);
			}

			this.positionStateName = ''; // Device is not positionable
			this.setPositionActionName = ''; // Device is not positionable
		}

        if (isDynamicGate)
        {
            this.openClosedStateName = 'core:OpenClosedState';
            this.myCommand = 'goToAlias'; // Name of the command to set the My position
        }
        else
        {
            this.openClosedStateName = 'core:OpenClosedPedestrianState';
            this.myCommand = 'setPedestrianPosition'; // Name of the command to set the My position
        }

        if (this.invertUpDown)
        {
            // Homey capability to Somfy command map
            this.windowcoveringsActions = {
                up: 'close',
                idle: 'stop',
                down: 'open',
            };

            // Somfy state to Homey capability map
            this.windowcoveringsStatesMap = {
                open: 'down',
                closed: 'up',
                pedestrian: 'idle',
            };
        }
        else
        {
            this.windowcoveringsActions = {
                up: 'open',
                idle: 'stop',
                down: 'close',
            };

            this.windowcoveringsStatesMap = {
                open: 'up',
                closed: 'down',
                pedestrian: 'idle',
            };
        }
    }

}

module.exports = SlidingGateDevice;
