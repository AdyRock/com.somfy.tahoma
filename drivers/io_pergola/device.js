/* jslint node: true */

'use strict';

const WindowCoveringsDevice = require('../WindowCoveringsDevice');

/**
 * Device class for exterior venetian blinds with the io:SimpleBioclimaticPergolaIOComponent controllable name in TaHoma
 * @extends {WindowCoveringsDevice}
 */
class PergolaDevice extends WindowCoveringsDevice
{

	async onInit()
	{
		if (this.hasCapability('lock_state'))
		{
			this.removeCapability('lock_state').catch(this.error);
		}

		await super.onInit();

		const dd = this.getData();
		this.controllableName = '';
		if (dd.controllableName)
		{
			this.controllableName = dd.controllableName.toString().toLowerCase();
		}

		this.myParameter = [];
		if ((this.controllableName === 'ogp:pergola') || (this.controllableName === 'io:dynamicpergolaiocomponent'))
		{
			if (this.hasCapability('windowcoverings_state'))
			{
				this.removeCapability('windowcoverings_state').catch(this.error);
			}
			this.positionStateName = 'core:TiltState';
			this.setPositionActionName = 'setTilt';
			this.openClosedStateName = '';

			if (!this.hasCapability('my_position'))
			{
				this.addCapability('my_position').catch(this.error);
			}

			this.myCommand = 'goToAlias';
			this.myParameter = ['1'];
			this.registerCapabilityListener('my_position', this.onCapabilityMyPosition.bind(this));
		}
		else
		{
			this.windowcoveringsActions = {
				up: 'openSlats',
				idle: null,
				down: 'closeSlats',
			};

			this.positionStateName = 'core:SlatsOrientationState';
			this.setPositionActionName = 'setOrientation';
			this.openClosedStateName = 'core:SlatsOpenClosedState';
		}
	}

	async onCapabilityMyPosition(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			const deviceData = this.getData();
			try
			{
				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
				}

				const action = {
					name: this.myCommand,
					parameters: this.myParameter,
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
				this.logCapabilityCommandError('onCapabilityMyPosition', err);
			}
		}
	}

}

module.exports = PergolaDevice;
