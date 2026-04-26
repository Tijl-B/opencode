# Telegram Integration

This document describes the required changes to integrate opencode with Telegram, enabling users to interact with AI assistants via a Telegram bot.

## Overview

The integration follows the same pattern as the existing Slack integration (`packages/slack/src/index.ts`). It:

1. Starts the opencode server via `@opencode-ai/sdk`
2. Listens for Telegram message events
3. Creates/stores sessions per user/conversation
4. Routes messages through the SDK's `session.prompt()` method
5. Subscribes to event stream for real-time tool updates

## Configuration

Configuration is loaded from `telegram.config.json` in the repo root:

```json
{
  "$schema": "./telegram.schema.json",
  "opencode": {
    "url": "http://127.0.0.1:4096"
  },
  "telegram": {
    "allowedChats": []
  },
  "session": {
    "defaultModel": {
      "providerID": "openai",
      "modelID": "gpt-4o"
    }
  }
}
```

### Options

| Field | Type | Description |
|------|------|-------------|
| `opencode.url` | string | Server URL (default: `http://127.0.0.1:4096`) |
| `opencode.directory` | string | Working directory for sessions |
| `telegram.allowedChats` | number[] | Chat IDs allowed (empty = all) |
| `telegram.allowedUsers` | number[] | User IDs allowed (empty = all) |
| `session.defaultModel.providerID` | string | Default LLM provider |
| `session.defaultModel.modelID` | string | Default model |
| `session.autoShare` | boolean | Auto-share sessions with URL |
| `session.persistDirectory` | string | Session state directory |

### Session State

Active sessions are stored in `telegram.session.json`:

```json
{
  "sessions": {
    "123456789-1": {
      "sessionId": "session_xxx",
      "chatId": 123456789,
      "thread": "1",
      "createdAt": 1716748800000
    }
  }
}
```

### Environment Variables

These take precedence over config file:

- `TELEGRAM_API_ID` - Telegram API ID
- `TELEGRAM_API_HASH` - Telegram API hash
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather

## Required Changes

### 1. Create TelegramBot Package

Create a new package at `packages/telegram-bot/` with:

```
packages/telegram-bot/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── .gitignore
```

#### package.json

```json
{
  "name": "@opencode-ai/telegram",
  "type": "module",
  "dependencies": {
    "@opencode-ai/sdk": "workspace:*",
    "gramjs": "^2.0.0"
  }
}
```

#### tsconfig.json

```json
{
  "extends": "@tsconfig/bun",
  "compilerOptions": {
    "types": ["node"]
  }
}
```

### 2. Implementation (src/index.ts)

```ts
import { TelegramClient } from "gramjs"
import { createOpencodeClient, type ToolPart } from "@opencode-ai/sdk"

const sessions = new Map<string, { client: any; sessionId: string; chatId: number; thread: string }>()

async function main() {
  // Start opencode server
  console.log("Starting opencode server...")
  const { client, server } = createOpencodeClient({
    baseUrl: process.env.OPENCODE_URL || "http://127.0.0.1:4096",
  })
  console.log("Opencode server ready at", server.url)

  // Subscribe to session events for tool updates
  void subscribeToEvents(client, sessions)

  // Setup Telegram client
  const tg = new TelegramClient({
    apiId: parseInt(process.env.TELEGRAM_API_ID!),
    apiHash: process.env.TELEGRAM_API_HASH!,
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
  })

  await tg.start()
  console.log("Telegram bot running!")

  tg.on("message", async (message) => {
    if (!message.text || message.outgoing) return

    const chatId = message.chat.id
    const thread = String((message.replyTo?.replyToMsgId) ?? message.id)
    const sessionKey = `${chatId}-${thread}`

    let session = sessions.get(sessionKey)

    if (!session) {
      // Create new session for this conversation
      const result = await client.session.create({
        body: { title: `Telegram ${chatId}` },
      })
      if (result.error) {
        await message.reply("Sorry, I had trouble creating a session.")
        return
      }

      session = { client, sessionId: result.data.id, chatId, thread }
      sessions.set(sessionKey, session)

      // Share session and send link
      const shareResult = await client.session.share({
        path: { id: result.data.id },
      })
      if (shareResult.data?.share?.url) {
        await message.reply(`Session created! ${shareResult.data.share.url}`)
      }
    }

    // Send message to opencode
    const result = await session.client.session.prompt({
      path: { id: session.sessionId },
      body: {
        parts: [{ type: "text", text: message.text }],
      },
    })

    if (result.error) {
      await message.reply("Sorry, I had trouble processing your message.")
      return
    }

    // Extract response text
    const responseText = result.data?.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") || "I received your message."

    await message.reply(responseText)
  })
}

async function subscribeToEvents(client: any, sessions: Map<string, any>) {
  const events = await client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type === "tool" && part.state.status === "completed") {
        // Find session and send tool completion to Telegram
        for (const [, session] of sessions.entries()) {
          if (session.sessionId === part.sessionID) {
            await tg.sendMessage(session.chatId, `*${part.tool}* - ${part.state.title}`)
          }
        }
      }
    }
  }
}

main()
```

### 3. Environment Variables

Add to your environment or `.env`:

```
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_BOT_TOKEN=your_bot_token
OPENCODE_URL=http://127.0.0.1:4096
```

### 4. Workspace Entry

Add the package to the workspace in `package.json`:

```json
{
  "workspaces": {
    "packages": [
      "packages/*",
      "packages/telegram-bot"
    ]
  }
}
```

## API Reference

### Server Endpoints

The opencode server exposes:

| Endpoint | Method | Description |
|----------|-------|------------|
| `/session` | POST | Create session |
| `/session/:sessionID` | GET | Get session info |
| `/session/:sessionID/message` | POST | Send prompt (streaming) |
| `/event` | GET | SSE for session events |

### SDK Client Methods

```ts
const client = createOpencodeClient({ baseUrl })

// Create session
const session = await client.session.create({
  body: { title: "session-name" }
})

// Send message (streaming response)
const response = await client.session.prompt({
  path: { id: session.data.id },
  body: {
    parts: [{ type: "text", text: "hello" }],
    providerID: "openai",
    modelID: "gpt-4o"
  }
})

// Subscribe to events
const events = await client.event.subscribe()
for await (const event of events.stream) {
  // event.type, event.properties
}
```

## Session Storage

The example above uses an in-memory `Map` for simplicity. For production:

1. **Database**: Store sessions in the opencode database (see existing patterns)
2. **Redis**: Use Redis for distributed state
3. **File**: Persist to JSON file

Session structure:

```ts
interface TelegramSession {
  client: OpencodeClient
  sessionId: string  // opencode session ID
  chatId: number  // Telegram chat ID
  thread: string // Thread/message ID
  createdAt: number
}
```

## File Handling

To support file uploads from Telegram:

1. Download file from Telegram API
2. Convert to base64
3. Add to prompt parts as `file` type:

```ts
const response = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [
      { type: "text", text: message.text },
      {
        type: "file",
        mime: fileMime,
        filename: fileName,
        url: `data:${mime};base64,${base64Content}`,
        source: { type: "file", text: { value: `@${fileName}`, start: 0, end: fileName.length } }
      }
    ]
  }
})
```

## Security Considerations

1. **Bot Token**: Store in environment, not in code
2. **Rate Limiting**: Implement per-user rate limits
3. **Session Isolation**: Ensure users can only access their own sessions
4. **Content Validation**: Sanitize user input before sending to AI

## Deployment

### Local Development

```bash
cd packages/telegram-bot
bun run src/index.ts
```

### Production

Use the existing deployment patterns:

```bash
# Start both server and bot
bun run --cwd packages/opencode serve &
bun run --cwd packages/telegram-bot start
```

Or run as a long-lived process manager (PM2, etc.).