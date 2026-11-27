# Somfy TaHoma for Homey

## Documentation

`readme.txt` is published in the Athom store. Keep it limited to user-facing information. Put developer notes and contributor documentation in this `readme.md` file instead.

## Development tests

Use Node.js 22 or newer:

```sh
npm test
npm run test:coverage
```

Tests cover account storage and routing, login recovery and rate limits, HTTP requests, API handlers, Flows, pairing, driver recommendations and device commands.

External Homey and Somfy services are mocked: tests do not use saved credentials, send email, or move real devices. A real Homey/Somfy smoke test is still required before publishing.

## Adding a device type

Start with the device's entry from a Homey app Device Log. Preserve the `controllableName`, `widgetName`, commands, states, and current values; do not commit gateway URLs or account credentials.

1. Find the closest existing driver under `drivers/` and confirm its command and state names match the Somfy device.
2. Add the exact `controllableName` to that driver's `deviceType` list in `driver.js`, or create a new driver folder when the capabilities or command model differ materially.
3. Update `device.js` when Somfy state names, command names, scaling, inversion, or extra capabilities require translation.
4. Update `driver.compose.json` and `driver.flow.compose.json` when Homey capabilities or Flow cards change.
5. Add a focused test that proves discovery and the affected command/state translation, then run `npm test`.
6. Run `npx homey app build` to regenerate and validate `app.json`.

When an existing driver is close but the device metadata differs, include both the advertised `commands` and `states` in the issue. A log containing only the device label or controllable name is generally insufficient to implement reliable support.

## Driver Support recommendations

Only drivers declaring the device's controllable name are candidates (case-insensitive). Each candidate starts with 100 points for that match. Capability checks add 20 points per match, subtract 12 per unmatched capability, and add up to 10 coverage bonus points. This ranks drivers sharing a controllable name; it is not a percentage of actual device support.

The information popup shows the matched controllable name and score breakdown. Its capability evidence percentage is a heuristic based on advertised commands and states, so an unmatched capability does not prove that the driver cannot handle it.

The "already added to Homey" status matches device URLs or IDs across all installed drivers, not just the recommended driver. A device paired through a different driver is still counted as installed; its recommendation does not change.

## Window covering feedback

For devices using `core:OpenClosedState`, polling and events use the raw closure percentage for the physical state: 0 is open, 100 is closed, and intermediate positions are idle. Position feedback takes precedence when both position and binary feedback are supplied together. Invert Position affects the slider only; Invert Up / Down affects the state/control mapping, and Invert Tile Action affects the tile. Feedback updates await capability writes so the slider and tile finish updating in order, without modifying the received state objects.
