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

## Driver Support recommendations

Only drivers declaring the device's controllable name are candidates (case-insensitive). Each candidate starts with 100 points for that match. Capability checks add 20 points per match, subtract 12 per unmatched capability, and add up to 10 coverage bonus points. This ranks drivers sharing a controllable name; it is not a percentage of actual device support.

The information popup shows the matched controllable name and score breakdown. Its capability evidence percentage is a heuristic based on advertised commands and states, so an unmatched capability does not prove that the driver cannot handle it.
