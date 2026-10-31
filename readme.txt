
Connect your Somfy TaHoma, Switch or Connexoon account to Homey then control and read your devices, sensors and scenarios directly from Homey.

Use the power of Homey Flows to automate your Somfy devices.

TaHoma scenarios are fetched and executed through the Somfy cloud, even when devices use local mode. Scenarios require a Somfy cloud login and an internet connection; a local token alone is not sufficient.
Enable Information Log in the app settings to record successful scenario fetches, including the number, names and IDs of scenarios returned. Open the scenario selector in a Flow to fetch the list. Failed lookups are logged and reported to Homey rather than shown as an empty list.

Written to fully comply with Somfy's latest guidelines, so you can use the app with peace of mind.
The app requires one of the Somfy gateways, TaHoma, Connexoon, Switch or Connectivity kit.

Connectivity kit devices:
- Add the kit's status LED using Dimmable light (IO, Hue, ZWave). It supports brightness control rather than a separate on/off switch.
- Add RTS screens such as Screen Veranda using Blind or Shutter (RTS).
- Add RTS awnings such as Zonnescherm Tuin using Awning (RTS).
The RTS screen and awning support up, down, stop and the My favourite position, but do not report their position or support percentage positioning.
The kit's internal io2way and RTS bridges are not separate devices to add.

Somfy Zigbee devices:
- Add Somfy roller shades using Roller shutter (IO), including percentage positioning and the My favourite position.
- Add Zigbee smart plugs using Socket (IO), including on/off and the timer.
- Add remote channels using Somfy Ergonomic Remote. This driver reports ergonomics mode and battery information, not button presses.
Battery readings on related configuration endpoints are used automatically. Discrete battery reports provide a low-battery indicator rather than an estimated percentage.

Additional devices:
- Add Sonos Audio Players using Audio Player (Sonos) for volume and mute control.
- Add RTS bioclimatic pergola screens using Pergola Screen (RTS) for open, close, stop and My favourite position. These devices do not report position.
- Add the privacy shutter of Somfy One+ and Somfy Protect security cameras using Security Camera Shutter, to open or close the camera's lens cover.

Suggestions or problems?
If you have a device that's not supported or a suggestion or problem with this app please go to the forum or the github page linked on this page and let me know.
