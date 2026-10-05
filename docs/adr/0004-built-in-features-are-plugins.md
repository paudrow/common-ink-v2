# Built-in features are plugins

Plugins are now called extensions (ADR 0006), and this holds more strongly: anything that can be an extension is one.

Todos, calendar, contacts and command bar providers are built as plugins on the same public API offered to third parties, and users can disable or replace them. This keeps the core small, makes the plugin API proven before anyone else depends on it, and pushes back against the feature sprawl that slowed down v1.
