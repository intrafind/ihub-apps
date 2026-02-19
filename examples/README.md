# Examples

These files are only meant to be used as references / examples of what is possible. No guarantee of being up-to-date.

## Contents

- **apps/** - Example application configurations
- **config/** - Example configuration files
- **models/** - Example model configurations
  - Includes **Model Hints** examples demonstrating the hint/info/warning/alert feature
  - See `models/MODEL_HINTS_EXAMPLES.md` for detailed documentation
- **prompts/** - Example prompts
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

