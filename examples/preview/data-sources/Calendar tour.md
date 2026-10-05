# Calendar tour

Your calendar's events are records from a data source, not notes. Here that's the **Sample calendar**: Work, Personal and Holidays, with a weekday standup (one moved, one cancelled), a weekly review, the gym twice a week for a few weeks, and payday on the last Friday of each month.

- ⌘⇧P, **Show calendar**: the coming two weeks.
- ⌘⇧P, **Show data sources**: what the Sample calendar holds, and that it has nothing to sync.
- ⌘⇧P, **Show history of everything**: every event is a record with history. Open one to see its JSON, read-only.

Agents use the same records through MCP or the CLI: `list_events`, `read_event`, `create_event`, `update_event` and `delete_event`, choosing **this**, **this and following** or **all** for an occurrence of a repeating event.

- [ ] Ask an agent to move Thursday's standup to 10:00, this one only
