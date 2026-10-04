# Principles

1. **Nothing hidden.** Every piece of state the app uses can be seen and read by the user, including defaults, history, sync caches and plugin actions.
2. **Every change has an author.** Edits from the user, agents, plugins and sync all go through the same change log and say who made them.
3. **Agents are first-class users.** Anything you can do in the UI, you can do through the CLI or MCP, using the same operations.
4. **Plain formats.** Notes are markdown. Config and settings are JSON with a published schema. No YAML and no frontmatter.
5. **Built-in features are plugins.** They use the same API third-party plugins do, and users can replace them.
6. **Minimal by default.** A feature has to earn its place. When in doubt, leave it out.
7. **The roadmap belongs to a person.** Agents implement work that has been scoped. They don't choose what to build next.
