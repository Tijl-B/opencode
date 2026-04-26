# Telegram Bot

A Telegram bot integration for opencode, allowing users to interact with AI assistants via Telegram.

## Prerequisites

1. **Telegram Bot Token** - Get from [@BotFather](https://t.me/BotFather)
2. **Node.js/Bun** - Runtime

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` to create a new bot
3. Follow the prompts to name your bot
4. Copy the bot token (starts with `:`)

### 2. Configure the Bot

Copy the example env file and add your token:

```bash
cp .env.example .env
# Edit .env and add your TELEGRAM_BOT_TOKEN
```

### 3. Configure opencode (Optional)

Edit `telegram.config.json` in the repo root:

```json
{
  "opencode": {
    "url": "http://127.0.0.1:4096"
  },
  "telegram": {
    "allowedChats": [],
    "allowedUsers": []
  },
  "session": {
    "defaultModel": {
      "providerID": "openai",
      "modelID": "gpt-4o"
    },
    "autoShare": true
  }
}
```

#### Config Options

| Field | Type | Description |
|------|------|-------------|
| `opencode.url` | string | Server URL (default: `http://127.0.0.1:4096`) |
| `opencode.directory` | string | Working directory for sessions |
| `telegram.allowedChats` | number[] | Chat IDs allowed (empty = all) |
| `telegram.allowedUsers` | number[] | User IDs allowed (empty = all) |
| `session.defaultModel.providerID` | string | LLM provider (default: `openai`) |
| `session.defaultModel.modelID` | string | Model (default: `gpt-4o`) |
| `session.autoShare` | boolean | Auto-share sessions |
| `session.persistDirectory` | string | Session storage directory |

### 4. Run the Bot

```bash
bun run dev
```

The bot will:
1. Start the opencode server (if not already running)
2. Load saved sessions from `telegram.session.json`
3. Connect to Telegram
4. Listen for messages

## Usage

### Starting a Conversation

1. Open your bot in Telegram
2. Send a message to start a session
3. The bot will create an opencode session and reply with a share link
4. Continue messaging to chat with the AI

### Commands

- Any text message - Gets processed by the AI
- Reply to a message - Continues the conversation in the same thread

### Session Management

Sessions are stored in `telegram.session.json`. Each chat has its own persistent session.

```json
{
  "sessions": {
    "123456789": {
      "sessionId": "session_xxx",
      "chatId": 123456789,
      "createdAt": 1716748800000
    }
  }
}
```

## Security

### Restricting Access

To limit who can use the bot, add chat or user IDs to config:

```json
{
  "telegram": {
    "allowedChats": [123456789],
    "allowedUsers": [987654321]
  }
}
```

- `allowedChats` - Specific chat IDs allowed
- `allowedUsers` - Specific user IDs allowed

Leave empty to allow everyone.

## Development

### Logs

Logs are output to stdout. You'll see:

- `🔧` - Configuration info
- `🚀` - Server/status messages
- `✅` - Success messages
- `📨` - Incoming messages
- `📝` - Messages sent to AI
- `📤` - AI responses
- `💬` - Outgoing messages
- `❌` - Errors

### Debugging

Set `LOG_LEVEL=debug` in `.env` for detailed logs.

## Deployment

### Production

For production deployment:

1. Use a process manager (PM2, etc.)
2. Set up environment variables
3. Configure persistence directory
4. Use a reverse proxy (nginx, etc.)

Example PM2 config:

```json
{
  "apps": [{
    "name": "opencode-telegram",
    "script": "src/index.ts",
    "cwd": "packages/telegram-bot",
    "interpreter": "bun",
    "env": {
      "NODE_ENV": "production"
    }
  }]
}
```

### Docker

```dockerfile
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

CMD ["bun", "run", "src/index.ts"]
```

Build and run:

```bash
docker build -t opencode-telegram .
docker run -e TELEGRAM_BOT_TOKEN=xxx opencode-telegram
```

## Troubleshooting

### Bot not responding

1. Check the bot token is correct
2. Ensure the bot is started (`/start` in Telegram)
3. Check logs for errors

### Session errors

1. Delete `telegram.session.json` to reset
2. Restart the bot

### Port already in use

The opencode server default port is `4096`. If in use, the bot will auto-select an available port.

### Rate limiting

Telegram has rate limits. If you hit them, the bot will show errors. Wait and try again.