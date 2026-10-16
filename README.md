
# Talkomatic Message Logger

A Node.js bot that records Talkomatic live typing updates and consolidates older text versions into cleaner entries.

## Features

- Consolidated text history
- Hidden older versions instead of deleting them
- Raw typing history lookup
- Search recorded text
- Per-room log storage
- Local JSON storage

## Requirements

- Node.js
- A Talkomatic token
- Access to a Talkomatic room

## Setup

1. Clone or download this repository.
2. Install dependencies:

   npm install

3. Create `talkomatic-token.json` locally using the token format expected by the bot.
4. Start the logger:

   npm start

5. Enter the six-digit room ID when prompted.

## Commands

- `!help` — Show commands
- `!logs` — Show consolidated entries
- `!logs username` — Show entries from a user
- `!logs raw username` — Show raw history
- `!search keyword` — Search recorded text
- `!logstats` — Show statistics
- `!logclear` — Clear local history

## Privacy

Logs are stored locally. Only record chats where logging is appropriate, and don't publish private chat histories or authentication tokens.

The logger can only record updates it receives while connected.

## License

MIT
