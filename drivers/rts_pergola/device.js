/* jslint node: true */

'use strict';

const WindowCoveringsDevice = require('../WindowCoveringsDevice');

class RtsPergolaDevice extends WindowCoveringsDevice
{

	async onInit()
	{
		await super.onInit();

		this.myParameter = ['1'];
		this.positionStateName = '';
		this.openClosedStateName = '';
		this.boostSync = true;
	}

	async onCapabilityWindowcoveringsState(value, opts)
	{
		if (opts && opts.fromCloudSync)
		{
			await super.onCapabilityWindowcoveringsState(value, opts);
			return;
		}

		const command = this.windowcoveringsActions[value];
		if (!command)
		{
			this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, 'option not supported');
			return;
		}

		try
		{
			const deviceData = this.getData();
			if (this.shouldThrottleDuplicateCommand(`state:${command}`))
			{
				this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, `Ignoring duplicate command ${command}`);
				return;
			}

			if (value === 'idle' && (this.executionId !== null))
			{
				await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
				this.executionCmd = '';
				this.executionId = null;
			}

			if (this.executionCmd === command)
			{
				this.homey.app.logInformation(`${this.getName()}: onCapabilityWindowcoveringsState`, `command ${command} already executing`);
				return;
			}

			if (this.executionId !== null)
			{
				await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
				this.executionCmd = '';
				this.executionId = null;
			}

			const action = {
				name: command,
				parameters: [1],
			};
			const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
			this.executionCmd = command;
			this.executionId = { id: result.execId, local: result.local };
			this.setWarning(null).catch(this.error);
		}
		catch (err)
		{
			this.executionCmd = '';
			this.setWarning(err.message).catch(this.error);
			this.logCapabilityCommandError('onCapabilityWindowcoveringsState', err);
		}
		finally
		{
			if (!this.openClosedStateName)
			{
				this.clearStateTimer = this.homey.setTimeout(() =>
				{
					this.clearStateTimer = null;
					this.setCapabilityValue('windowcoverings_state', null).catch(this.error);
				}, 40000);
			}
		}
	}

	async sync()
	{
		return null;
	}

}

module.exports = RtsPergolaDevice;
