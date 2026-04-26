import path from "path"
import { Log } from "@/util"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { Instance } from "@/project/instance"
import { readJson, writeJson } from "@/util/filesystem"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "telegram" })

function parseIds(envVar: string | undefined): number[] {
  if (!envVar) return []
  return envVar.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
}

interface TelegramSessionRecord {
  sessionID: string
  chatId: number
  createdAt: number
}

export async function startTelegramBot(): Promise<void> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN

  console.log("[telegram] TELEGRAM_BOT_TOKEN:", process.env.TELEGRAM_BOT_TOKEN)

  if (!telegramBotToken) {
    log.info("telegram bot not configured, skipping")
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set")
    return
  }

  const allowedChats = parseIds(process.env.TELEGRAM_ALLOWED_CHATS)
  const allowedUsers = parseIds(process.env.TELEGRAM_ALLOWED_USERS)

  console.log("[telegram] checking config:", { token: !!telegramBotToken })

  const directory = Instance.directory
  console.log("[telegram] directory:", directory)

  const sessionsDir = path.join(Global.Path.state, "telegram-sessions.json")

  let sessionsData = { sessions: {} as Record<string, TelegramSessionRecord> }
  try {
    sessionsData = await readJson<typeof sessionsData>(sessionsDir).catch(() => ({ sessions: {} }))
  } catch {
    sessionsData = { sessions: {} }
  }

  const sessionsMap = new Map<string, TelegramSessionRecord>()
  for (const [key, val] of Object.entries(sessionsData.sessions)) {
    sessionsMap.set(key, val)
  }

  // Test the bot token
  const botInfo = await telegramRequest(telegramBotToken, "getMe")
  if (!botInfo.ok) {
    console.log("[telegram] bot auth failed:", botInfo)
    return
  }

  console.log("[telegram] bot started:", botInfo.result?.username)

  // Use polling - but long polling via getUpdates is complex, 
  // let's use webhook approach or simple polling
  console.log("[telegram] polling initialized")

  // For simplicity with Bot API, we'll store pending messages and check via getUpdates
  // Actually, bots can only receive messages via webhooks orpolling. 
  // Let's use a simple approach - just respond to commands via getUpdates
  
  // Start a simple polling loop
  let offset = 0
  const pollInterval = setInterval(async () => {
    try {
      const updates = await telegramRequest(telegramBotToken, "getUpdates", {
        timeout: 30,
        offset: offset + 1,
      })

      if (updates.ok && updates.result) {
        for (const update of updates.result) {
          offset = update.update_id
          await handleUpdate(update, telegramBotToken, sessionsMap, allowedChats, allowedUsers, saveSessions)
        }
      }
    } catch (e) {
      // Ignore polling errors
    }
  }, 5000)

  async function handleUpdate(
    update: any,
    token: string,
    sessions: Map<string, TelegramSessionRecord>,
    allowedChats: number[],
    allowedUsers: number[],
    saveFn: () => Promise<void>,
  ) {
    const message = update.message
    if (!message) return

    const chatId = message.chat.id
    const userId = message.from?.id
    const text = message.text || ""

    // Access control
    if (allowedChats.length > 0 && !allowedChats.includes(chatId)) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Access denied." })
      return
    }
    if (allowedUsers.length > 0 && userId && !allowedUsers.includes(userId)) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Access denied." })
      return
    }

    if (text.startsWith("/opencode")) {
      const parts = text.split(" ").filter(Boolean)
      
      if (parts.length === 1) {
        // No args - auto-link to most recent session
        await handleAutoLink(chatId, token, sessions, saveFn)
        return
      }
      
      if (parts[1] === "list") {
        await handleListSessions(chatId, token)
        return
      }
      
      if (parts[1] === "help") {
        await telegramRequest(token, "sendMessage", { 
          chat_id: chatId, 
          text: "Commands:\n/opencode - Link to latest session\n/opencode <slug> - Link to specific session\n/opencode list - Show recent sessions\n/opencode disconnect - Unlink session" 
        })
        return
      }
      
      if (parts[1] === "disconnect") {
        sessions.delete(String(chatId))
        await saveSessions()
        await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Session unlinked." })
        return
      }

      const sessionSlug = parts[1]
      await handleOpencodeCommand(chatId, sessionSlug, token, sessions, saveFn)
      return
    }

    const sessionKey = String(chatId)
    const sessionInfo = sessions.get(sessionKey)

    if (!sessionInfo) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "No linked session.\n\nJust send /opencode to link to your most recent session!" })
      return
    }

    await handleSessionMessage(chatId, sessionInfo.sessionID, text, token)
  }

  async function handleOpencodeCommand(
    chatId: number,
    sessionSlug: string,
    token: string,
    sessions: Map<string, TelegramSessionRecord>,
    saveFn: () => Promise<void>,
  ) {
    const allSessions = await Session.list({ search: sessionSlug })

    let foundID: SessionID | undefined
    for await (const s of allSessions) {
      if (s.slug === sessionSlug) {
        foundID = s.id
        break
      }
    }

    if (!foundID) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Session not found: ${sessionSlug}` })
      return
    }

    const key = String(chatId)
    sessions.set(key, {
      sessionID: foundID,
      chatId,
      createdAt: Date.now(),
    })

    await saveSessions()

    await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Session linked: ${sessionSlug}` })
  }

  async function handleAutoLink(
    chatId: number,
    token: string,
    sessions: Map<string, TelegramSessionRecord>,
    saveFn: () => Promise<void>,
  ) {
    // Get recent sessions and link to the most recent one
    const allSessions = await Session.list({ limit: 5 })
    
    const sessionList: Array<{id: SessionID, slug: string, title: string}> = []
    for await (const s of allSessions) {
      sessionList.push({ id: s.id, slug: s.slug, title: s.title })
    }
    
    if (sessionList.length === 0) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "No sessions found. Create one in the browser first." })
      return
    }
    
    // Link to the most recent session
    const latest = sessionList[0]
    const key = String(chatId)
    sessions.set(key, {
      sessionID: latest.id,
      chatId,
      createdAt: Date.now(),
    })
    
    await saveFn()
    
    await telegramRequest(token, "sendMessage", { 
      chat_id: chatId, 
      text: `Linked to latest session: ${latest.title}\nSlug: ${latest.slug}` 
    })
  }

  async function handleListSessions(
    chatId: number,
    token: string,
  ) {
    const allSessions = await Session.list({ limit: 5 })
    
    let msg = "Recent sessions:\n"
    let i = 0
    for await (const s of allSessions) {
      i++
      msg += `${i}. ${s.title} (${s.slug})\n`
    }
    msg += "\nUse /opencode to link to the latest"
    
    await telegramRequest(token, "sendMessage", { chat_id: chatId, text: msg })
  }

  async function handleSessionMessage(
    chatId: number,
    sessionIDStr: string,
    text: string,
    token: string,
  ) {
    const sessionID = SessionID.make(sessionIDStr)

    try {
      const result = await Session.prompt({
        sessionID,
        parts: [{ type: "text" as const, text }],
      })

      if (!result) {
        await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Sorry, I had trouble processing your message." })
        return
      }

      const responseText = result.parts
        ?.filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")

      if (responseText) {
        await telegramRequest(token, "sendMessage", { chat_id: chatId, text: responseText })
      }
    } catch (e: any) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Error: ${e?.message || e}` })
    }
  }

  async function saveSessions() {
    const data = { sessions: Object.fromEntries(sessionsMap) }
    await writeJson(sessionsDir, data)
  }

  console.log("[telegram] telegram bot polling started")
}

async function telegramRequest(token: string, method: string, params?: any): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`
  
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : undefined,
  })

  return response.json()
}