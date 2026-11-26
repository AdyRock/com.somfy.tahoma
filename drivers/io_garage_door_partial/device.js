/* jslint node: true */

'use strict';

const WindowCoveringsDevice = require('../WindowCoveringsDevice');

/**
 * Device class for exterior venetian blinds with the io:DiscreteGarageOpenerWithPartialPositionIOComponent controllable name in TaHoma
 * @extends {WindowCoveringsDevice}
 */
class GarageDoorPartialIODevice extends WindowCoveringsDevice
{

	async onInit()
	{
		if (this.hasCapability('lock_state'))
		{
			this.removeCapability('lock_state').catch(this.error);
		}

		await super.onInit();

		this.positionStateName = ''; // Device is not positionable
		this.setPositionActionName = ''; // Device is not positionable

		const dd = this.getData();

		this.controllableName = '';
		if (dd.controllableName)
		{
			this.controllableName = dd.controllableName.toString().toLowerCase();
		}

		if ((this.controllableName === 'io:discretegarageopeneriocomponent') || (this.controllableName === 'ogp:garagedoor'))
		{
			if (this.hasCapability('my_position'))
			{
				this.removeCapability('my_position').catch(this.error);
			}

			if (this.controllableName === 'ogp:garagedoor')
			{
				this.openClosedStateName = 'core:OpenClosedState';
			}
			else
			{
				this.openClosedStateName = 'core:OpenClosedUnknownState';
			}
		}
		else if (this.controllableName === 'io:dynamicgaragedoor')
		{
			this.openClosedStateName = 'core:OpenClosedState';
			this.myCommand = 'goToAlias';
			// Resolve STOP support before the first button press when the gateway is available.
			this.refreshDynamicGarageDoorMetadata();
		}
		else
		{
			this.openClosedStateName = 'core:OpenClosedPartialState';
			this.myCommand = 'partialPosition'; // Name of the command to set the My position
		}

		this.windowcoveringsActions.idle = null;
		this.windowcoveringsStatesMap.partial = 'idle';
	}

	async onSettings(settings)
	{
		const result = super.onSettings(settings);
		this.windowcoveringsActions.idle = this.stopSupported ? 'stop' : null;
		this.windowcoveringsStatesMap.partial = 'idle';
		return result;
	}

	async refreshDynamicGarageDoorMetadata()
	{
		if (!this.metadataRequest)
		{
			this.metadataRequest = this.homey.app.getDeviceMetadata(this.getDeviceUrl())
				.then((device) =>
				{
					const commands = device?.definition?.commands;
					if (Array.isArray(commands))
					{
						this.stopSupported = commands.some((command) => (command?.commandName === 'stop') && (command.nparams === 0));
						this.windowcoveringsActions.idle = this.stopSupported ? 'stop' : null;
					}
					return device;
				})
				.catch((error) =>
				{
					this.logCapabilityCommandError('refreshDynamicGarageDoorMetadata', error);
					return null;
				})
				.finally(() => { this.metadataRequest = null; });
		}
		return this.metadataRequest;
	}

	async onCapabilityWindowcoveringsState(value, opts)
	{
		if (opts?.fromCloudSync || (this.controllableName !== 'io:dynamicgaragedoor'))
		{
			return super.onCapabilityWindowcoveringsState(value, opts);
		}

		this.pendingMyPosition = null;
		if ((value === 'idle') && (this.stopSupported === undefined))
		{
			await this.refreshDynamicGarageDoorMetadata();
		}
		return super.onCapabilityWindowcoveringsState(value, opts, (value === 'idle') && (this.stopSupported === true));
	}

	async onCapabilityMyPosition(value, opts)
	{
		if ((this.controllableName !== 'io:dynamicgaragedoor') || opts?.fromCloudSync)
		{
			return super.onCapabilityMyPosition(value, opts);
		}

		const request = Symbol('myPosition');
		this.pendingMyPosition = request;
		const device = await this.refreshDynamicGarageDoorMetadata();
		if (this.pendingMyPosition !== request)
		{
			return undefined;
		}

		const commands = device?.definition?.commands;
		if (!Array.isArray(commands) || !commands.some((command) => (command?.commandName === 'goToAlias') && (command.nparams === 1)))
		{
			this.homey.app.logInformation(`${this.getName()}: onCapabilityMyPosition`, 'Could not verify Somfy alias support. Check the gateway connection and device configuration.');
			return undefined;
		}

		const attributes = device?.attributes;
		const aliases = Array.isArray(attributes) && attributes.find((attribute) => attribute?.name === 'core:SupportedAliases')?.value;
		const partialAlias = Array.isArray(aliases) && aliases.find((alias) => (
			(alias?.type === 'partial') && (typeof alias.id === 'string') && alias.id.trim()
		));
		if (!partialAlias)
		{
			this.homey.app.logInformation(`${this.getName()}: onCapabilityMyPosition`, 'No partial alias advertised. Check the ventilation position in TaHoma.');
			return undefined;
		}
		return super.onCapabilityMyPosition(value, opts, () => (this.pendingMyPosition === request ? [partialAlias.id] : null));
	}

}

module.exports = GarageDoorPartialIODevice;
