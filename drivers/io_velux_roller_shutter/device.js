/* jslint node: true */

'use strict';

const WindowCoveringsDevice = require('../WindowCoveringsDevice');

/**
 * Device class for Velus interior blinds with the io:RollerShutterVeluxIOComponent controllable name in TaHoma
 * @extends {WindowCoveringsDevice}
 */
class VeluxRollerShutterDevice extends WindowCoveringsDevice {

	async onInit() {
		if (this.hasCapability('lock_state')) {
			this.removeCapability('lock_state').catch(this.error);
		}

		await super.onInit();

		if (!this.hasCapability('quwindowcoverings_closedick_open')) {
			this.addCapability('windowcoverings_closed').catch(this.error);
		}

		this.registerCapabilityListener('quiet_mode', this.onCapabilityQuietMode.bind(this));
	}

	async onCapabilityQuietMode(value, opts)
	{
		if (!opts || !opts.fromCloudSync)
		{
			try
			{
				const deviceData = this.getData();

				if (this.executionId !== null)
				{
					await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
					this.executionCmd = '';
					this.executionId = null;
				}
				else
				{
					const action = {
						name: 'activateOption',
						parameters: ['silence'],
					};

					if (value === false)
					{
						action.name = 'deactivateOption';
					}

					const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
					this.executionId = { id: result.execId, local: result.local };
				}

				this.setWarning(null).catch(this.error);
			}
			catch (err)
			{
				this.executionCmd = '';
				this.setWarning(err.message).catch(this.error);
				this.logCapabilityCommandError('onCapabilityQuietMode', err);
			}
		}
		else
		{
			// New value from Tahoma
			if (this.homey.app.infoLogEnabled)
			{
				const oldValue = this.getCapabilityValue('quiet_mode');
				this.homey.app.logInformation(`${this.getName()}: onCapabilityQuietMode`, `Old Value: ${oldValue}, New Value: ${value}`);
			}

			this.setCapabilityValue('quiet_mode', value).catch(this.error);
		}
	}

}

module.exports = VeluxRollerShutterDevice;
