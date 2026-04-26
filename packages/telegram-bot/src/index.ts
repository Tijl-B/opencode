import { Bot, Context } from "grammy"
import { createOpencode, type ToolPart } from "@opencode-ai/sdk"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

interface Config {
  opencode: {
    url: string
    directory?: string
  }
  telegram: {
    allowedChats: number[]
    allowedUsers: number[]
  }
  session: {
    defaultModel: {
      providerID: string
      modelID: string
    }
    autoShare: boolean
    persistDirectory?: string
  }
}

interface SessionState {
  sessionId: string
  chatId: number
  thread?: number
  createdAt: number
}

interface SessionStore {
  sessions: Record<string, SessionState>
}

const configPath = resolve(process.cwd(), "telegram.config.json")
const sessionPath = resolve(process.cwd(), "telegram.session.json")

const config: Config = await loadConfig()
const sessions = new Map<string, SessionState>()

let bot: Bot
let opencode: Awaited<ReturnType<typeof createOpencode>>

async function loadConfig(): Promise<Config> {
  try {
    const content = await readFile(configPath, "utf-8")
    return JSON.parse(content)
  } catch {
    return {
      opencode: { url: "http://127.0.0.1:4096" },
      telegram: { allowedChats: [], allowedUsers: [] },
      session: {
        defaultModel: { providerID: "openai", modelID: "gpt-4o" },
        autoShare: true,
      },
    }
  }
}

async function loadSessions(): Promise<SessionStore> {
  try {
    const content = await readFile(sessionPath, "utf-8")
    return JSON.parse(content)
  } catch {
    return { sessions: {} }
  }
}

async function saveSessions(store: SessionStore): Promise<void> {
  await writeFile(sessionPath, JSON.stringify(store, null, 2))
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN

  console.log("🔧 Bot configuration:")
  console.log("- Bot token present:", !!botToken)

  if (!botToken) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable")
  }

  console.log("🚀 Starting opencode server...")
  opencode = await createOpencode({
    port: 0,
  })
  console.log("✅ Opencode server ready at", opencode.server.url)

  const store = await loadSessions()
  for (const [key, session] of Object.entries(store.sessions)) {
    sessions.set(key, session)
  }

  void subscribeToEvents()

  console.log("🚀 Starting Telegram bot...")
  bot = new Bot(botToken)

  bot.on("message:text", handleMessage)

  await bot.start()
  console.log("✅ Telegram bot running!")
}

async function subscribeToEvents() {
  const events = await opencode.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type === "tool") {
        for (const [, session] of sessions.entries()) {
          if (session.sessionId === part.sessionID) {
            await handleToolUpdate(part, session.chatId, session.thread)
            break
          }
        }
      }
    }
  }
}

async function handleToolUpdate(part: ToolPart, chatId: number, thread?: number) {
  if (part.state.status !== "completed") return
  const toolMessage = `*${part.tool}* - ${part.state.title}`
  try {
    await bot.api.sendMessage(chatId, toolMessage, { reply_to_message_id: thread })
  } catch (e) {
    console.error("Failed to send tool update:", e)
  }
}

async function handleMessage(ctx: Context) {
  const message = ctx.message
  if (!message || !message.text) return

  const chatId = ctx.chat?.id
  if (!chatId) return

  if (config.telegram.allowedChats.length > 0 && !config.telegram.allowedChats.includes(chatId)) {
    console.log("⏭️ Chat not allowed:", chatId)
    return
  }

  if (config.telegram.allowedUsers.length > 0 && !config.telegram.allowedUsers.includes(message.from?.id)) {
    console.log("⏭️ User not allowed:", message.from?.id)
    return
  }

  const thread = message.message_id
  const sessionKey = String(chatId)

  console.log("📨 Received message:", message.text)

  let session = sessions.get(sessionKey)

  if (!session) {
    console.log("🆕 Creating new opencode session...")

    const result = await opencode.client.session.create({
      body: { title: `Telegram ${chatId}` },
    })

    if (result.error) {
      console.error("❌ Failed to create session:", result.error)
      await ctx.reply("Sorry, I had trouble creating a session.")
      return
    }

    console.log("✅ Created opencode session:", result.data.id)

    session = {
      sessionId: result.data.id,
      chatId,
      thread,
      createdAt: Date.now(),
    }
    sessions.set(sessionKey, session)

    const store = await loadSessions()
    store.sessions[sessionKey] = session
    await saveSessions(store)

    if (config.session.autoShare) {
      const shareResult = await opencode.client.session.share({
        path: { id: result.data.id },
      })
      if (shareResult.data?.share?.url) {
        console.log("🔗 Session shared:", shareResult.data.share.url)
        await ctx.reply(`Session created! ${shareResult.data.share.url}`)
      }
    }
  }

  console.log("📝 Sending to opencode:", message.text)
  const result = await opencode.client.session.prompt({
    path: { id: session.sessionId },
    body: { parts: [{ type: "text", text: message.text }] },
  })

  console.log("📤 Opencode response:", JSON.stringify(result, null, 2))

  if (result.error) {
    console.error("❌ Failed to send message:", result.error)
    await ctx.reply("Sorry, I had trouble processing your message.")
    return
  }

  const responseText =
    result.data?.parts?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ||
    "I received your message."

  console.log("💬 Sending response:", responseText)

  await ctx.reply(responseText)
}

main().catch(console.error)