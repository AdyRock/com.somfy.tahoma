/* jslint node: true */

'use strict';

const Device = require('../Device');

/**
 * Device class for the opening detector with the rts:GarageDoor4TRTSComponent, rts:SlidingGateOpener4TRTSComponent, io:CyclicGarageOpenerIOComponent, io:CyclicSlidingGateOpenerIOComponent controllable name in TaHoma
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
			await this.homey.app.cancelExecution(deviceData.label, this.executionId.id, this.executionId.local, deviceData.deviceURL);
			return;
		}

		const action = {
			name: 'cycle',
			parameters: [],
		};
		const result = await this.homey.app.executeDeviceAction(deviceData.label, deviceData.deviceURL, action, this.boostSync);
		this.executionId = { id: result.execId, local: result.local };
		this.executionCmd = action.name;
	}

	/**
	 * Gets the sensor data from the TaHoma cloud
	 * @param {Array} data - device data from all the devices in the TaHoma cloud
	 */
	async sync() { return null; }

	// look for updates in the events array
	async syncEvents(events, local)
	{
		if (events === null)
		{
			this.sync();
			return;
		}

		try
		{
			const myURL = this.getDeviceUrl();
			if (!local && this.homey.app.isLocalDevice(myURL))
			{
				// This device is handled locally so ignore cloud updates
				return;
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
							this.executionId = null;
							this.executionCmd = '';
						}
					}
				}
			}
		}
		catch (error)
		{
			this.homey.app.logInformation(this.getName(),
			{
				message: error.message,
				stack: error.stack,
			});
		}
	}

}

module.exports = OpenCloseDevice;
