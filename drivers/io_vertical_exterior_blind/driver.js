"use strict";

const Driver = require('../../lib/Driver');
var taHoma = require('../../lib/tahoma');

var windowcoveringsStateMap = {
	up: 'open',
	idle: null,
	down: 'close'
};

//Driver for a io:VerticalExteriorAwningIOComponent device
class VerticalExteriorBlind extends Driver {

	constructor() {
		super();
		var _self = this;

		this.capabilities = {
			windowcoverings_state: {
				get: function(device_data, callback) {
					try {
						var device = _self.getDeviceByData(device_data);
						callback(null, device.state.windowcoverings_state);
					} catch(e) {
						console.log(e.message);
						callback(e);
					}
				},

				set: function(device_data, state, callback) {
					var device = _self.getDeviceByData(device_data);
					if(device instanceof Error) {
						return callback(device);
					}

					var oldWindowCoveringsState = device.state.windowcoverings_state;
					if (oldWindowCoveringsState != state) {
						if (state == 'idle') {
							if (device.executionId) {
								taHoma.cancelExecution(device.executionId, function(err, result) {
									if (!err) {
										//let's set the state to open, because Tahoma, doesn't have an idle state. If a blind isn't closed for 100%, the state will remain open.
										device.state.windowcoverings_state = 'up';
										//module.exports.realtime(device_data, 'windowcoverings_state', device.state.windowcoverings_state);
										callback(null, device.state.windowcoverings_state);
									}
								});
							}
						} else {
							var action = {
								name: windowcoveringsStateMap[state],
								parameters: []
							};

							taHoma.executeDeviceAction(device_data.label, device_data.deviceURL, action, function(err, result) {
								if (!err) {
									device.executionId = result.execId;
									device.state.windowcoverings_state = state;
									module.exports.realtime(device_data, 'windowcoverings_state', device.state.windowcoverings_state);
									callback(null, state);
								}
							});
						}
					}
				}
			}
		}
	}

	pair(socket) {
		socket.on('list_devices', function(data, callback) {
			taHoma.setup(function(err, data) {
				if (err) {
					return callback(err);
				}
				if (data && data.devices) {
					var blinds = new Array();
					for (var i=0; i<data.devices.length; i++) {
						var device = data.devices[i];
						if (device.controllableName == 'io:VerticalExteriorAwningIOComponent') {
							var device_data = {
								name: device.label,
								data: {
									id: device.oid,
									deviceURL: device.deviceURL,
									label: device.label
								}
							};
							blinds.push(device_data);
						}
					}

					callback(null, blinds);
				}
			});

		});

		socket.on('disconnect', function() {
			console.log("User aborted pairing, or pairing is finished");
		});
	}
}

module.exports = new VerticalExteriorBlind();