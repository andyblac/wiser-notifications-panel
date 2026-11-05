# Wiser Notifications Panel

A Home Assistant panel for creating and managing native Wiser notifications.

Notifications are stored on the Wiser hub. The panel does not create Home Assistant automations or substitute Home Assistant notifications.

## Features

- Configure under-power and over-power equipment notifications.
- Set the power limit and period in minutes.
- Enable, disable, update, or delete existing notifications.
- Manage supported smoke alarm, sensor, and automation notification toggles.
- Support multiple Wiser hubs.
- Configure the desktop column count and device order for each notification category.
- Responsive Home Assistant-native layout.
- Danish, Dutch, English, Finnish, French, German, Hungarian, Norwegian
  Bokmål, Portuguese, Spanish, and Swedish translations.

## Requirements

The panel requires a compatible version of the Wiser Home Assistant integration exposing:

- `wiser/hubs`
- `wiser/notifications`
- `wiser/power_notification/set`
- `wiser/power_notification/delete`
- `wiser/device_notification/set`
- `wiser/automation_notification/set`
- `wiser/panel/configure`

Write operations require a Home Assistant administrator account.

## Development

Node.js 22 or newer is required.

```sh
npm test
npm run build:dev
```

The built panel is written to `dist/wiser-notifications-panel.js`.
