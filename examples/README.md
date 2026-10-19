# Examples

These files are only meant to be used as references / examples of what is possible. No guarantee of being up-to-date.

## Contents

- **apps/** - Example application configurations, copied into `contents/apps/` to try. CI checks
  them against the app schema.
  - Apps that list `sources` (`faq-bot`, `multi-source-bot`, `ifinder-research-bot`) only get
    their content when those sources exist. Copy the matching entries from
    `config/sources.json` into `contents/config/sources.json`, or create them under
    **Admin → Sources**. The `faq` source ships with iHub. Without its sources the app still runs,
    but without that content.
- **config/** - Example configuration files
- **models/** - Example model configurations
  - Includes **Model Hints** examples demonstrating the hint/info/warning/alert feature
  - See `models/MODEL_HINTS_EXAMPLES.md` for detailed documentation
- **prompts/** - Example prompts
- **agents/** - Example agent profiles and inboxes for the Agent Factory feature
  - `agents/profiles/todo-worker.json` — drain-only TODO worker demo
  - `agents/profiles/research-and-summarize.json` — Planner + drain demo
  - `agents/inboxes/engineering-todos.md` — sample inbox seeded with three items
  - Copy into `contents/agents/profiles/` and `contents/data/agent-inboxes/` to try
- **logging-demo.sh** - Interactive demonstration of structured logging with component names

## Logging Demo

Run the logging demonstration script to see how structured logging works:

```bash
./examples/logging-demo.sh
```

This script demonstrates:
- Filtering logs by component
- Filtering logs by type (CHAT_REQUEST, CHAT_RESPONSE, FEEDBACK)
- Filtering logs by level (error, warn, info, debug)
- Extracting specific fields from logs
- Counting requests by app
- Finding all logs for a specific session
- Identifying most active components

For more information on logging, see [docs/logging.md](../docs/logging.md).

