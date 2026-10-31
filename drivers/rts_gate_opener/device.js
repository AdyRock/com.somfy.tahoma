/* jslint node: true */

'use strict';

const Device = require('../Device');

class rtsGateOpenerDevice extends Device
{

	async onInit()
	{
		await super.onInit();
		this.registerCapabilityListener('open_button', this.onCapabilityOpen.bind(this));
		this.registerCapabilityListener('close_button', this.onCapabilityClose.bind(this));
		this.registerCapabilityListener('stop_button', this.onCapabilityStop.bind(this));

		const dd = this.getData();

		this.controllableName = '';
		if (dd.controllableName)
		{
			this.controllableName = dd.controllableName.toString().toLowerCase();
		}

		if (this.controllableName === 'rts:garagedoorwithventilationpositionrtscomponent')
		{
			if (!this.hasCapability('my_position'))
			{
				this.addCapability('my_position')
				.then(this.registerCapabilityListener('my_position', this.onCapabilityMyPosition.bind(this)))
				.catch(this.error);
			}
			else
			{
				this.registerCapabilityListener('my_position', this.onCapabilityMyPosition.bind(this));
			}
		}
		else if (this.hasCapability('my_position'))
		{
			this.removeCapability('my_position')
			.catch(this.error);
		}

		this.boostSync = true;
	}

	async onCapabilityOpen(value)
	{
		if (this.commandExecuting === 'open')
		{
			// This command is still processing
			return;
		}

		await this.sendOpenCloseStop('open');
	}

	async onCapabilityClose(value)
	{
		if (this.commandExecuting === 'close')
		{
			// This command is still processing
			return;
		}

		await this.sendOpenCloseStop('close');
	}

	async onCapabilityStop(value)
	{
		if (this.commandExecuting === 'stop')
		{
			// This command is still processing
			return;
		}

		await this.sendOpenCloseStop('stop');
	}

	async onCapabilityMyPosition(value)
	{
		if (this.commandExecuting === 'my')
		{
			// This command is still processing
			return;
		}

		await this.sendOpenCloseStop('my');
	}

	async sendOpenCloseStop(value)
	{
		if (this.boostSync)
		{
			if (!await this.homey.app.boostSync())
			{
				throw (new Error('Failed to Boost Sync'));
			}
		}

		const deviceData = this.getData();
		if (this.executionId !== null)
		{
			await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
		}

		let action;
		const actionParam = this.getSetting('open_command');
		if (actionParam && value === 'open')
		{
			action = {
				name: actionParam,
				parameters: [],
			};
		}
		else
		{
			action = {
				name: value,
				parameters: [],
			};
		}

		const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
		this.commandExecuting = action.name;
		this.executionCmd = action.name;
		this.executionId = { id: result.execId, local: result.local };
	}

	// look for updates in the events array
	async syncEvents(events, local)
	{
		if (events === null)
		{
			return this.sync();
		}

		const myURL = this.getDeviceUrl();
		if (!local && this.homey.app.isLocalDevice(myURL))
		{
			// This device is handled locally so ignore cloud updates
			return myURL;
		}

		// Process events sequentially so they are in the correct order
		for (let i = 0; i < events.length; i++)
		{
			const element = events[i];
			if (element.name === 'ExecutionRegisteredEvent')
			{
				if (!Array.isArray(element.actions))
				{
					continue;
				}
				for (let x = 0; x < element.actions.length; x++)
				{
					if (myURL === element.actions[x].deviceURL)
					{
						if (!this.executionId || (this.executionId.id !== element.execId))
						{
							this.executionId = { id: element.execId, local };
							if (element.actions[x].commands)
							{
								this.executionCmd = element.actions[x].commands[0].name;
							}
							else
							{
								this.executionCmd = element.actions[x].command;
							}
							if (!local && this.boostSync)
							{
								if (!await this.homey.app.boostSync())
								{
									this.executionCmd = '';
									this.executionId = null;
								}
							}
						}
					}
				}
			}
			else if (element.name === 'ExecutionStateChangedEvent')
			{
				if ((element.newState === 'COMPLETED') || (element.newState === 'FAILED'))
				{
					if (this.executionId && (this.executionId.id === element.execId))
					{
						if (!local && this.boostSync)
						{
							await this.homey.app.unBoostSync();
						}

						this.homey.app.triggerCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
						this.driver.triggerDeviceCommandComplete(this, this.executionCmd, (element.newState === 'COMPLETED'));
						this.commandExecuting = '';
						this.executionId = null;
						this.executionCmd = '';
					}
				}
			}
		}

		return myURL;
	}

}

module.exports = rtsGateOpenerDevice;
