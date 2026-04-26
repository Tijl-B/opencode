import path from "path"
import { Log } from "@/util"
import { Instance } from "@/project/instance"
import { readJson, writeJson } from "@/util/filesystem"
import { Global } from "@opencode-ai/core/global"

const log = Log.create({ service: "telegram" })

// Global guard to prevent multiple instances
let botStarted = false

function parseIds(envVar: string | undefined): number[] {
  if (!envVar) return []
  return envVar.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
}

interface TelegramSessionRecord {
  sessionID: string
  directory: string
  chatId: number
  createdAt: number
}

export async function startTelegramBot(): Promise<void> {
  // Prevent double start
  if (botStarted) return
  botStarted = true

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN

  if (!telegramBotToken) {
    return
  }

  const allowedChats = parseIds(process.env.TELEGRAM_ALLOWED_CHATS)
  const allowedUsers = parseIds(process.env.TELEGRAM_ALLOWED_USERS)

  const directory = Instance.directory

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
    console.log("[telegram] bot auth failed")
    return
  }

  console.log("[telegram] bot started:", botInfo.result?.username)

  let offset = 0
  setInterval(async () => {
    try {
      const updates = await telegramRequest(telegramBotToken, "getUpdates", {
        timeout: 30,
        offset: offset + 1,
      })

      if (updates.ok && updates.result) {
        for (const update of updates.result) {
          offset = update.update_id
          await handleUpdate(update, telegramBotToken, sessionsMap, allowedChats, allowedUsers)
        }
      }
    } catch {
      // Ignore polling errors
    }
  }, 3000)

  async function handleUpdate(
    update: any,
    token: string,
    sessions: Map<string, TelegramSessionRecord>,
    allowedChats: number[],
    allowedUsers: number[],
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
        await handleAutoLink(chatId, token, sessions)
        return
      }

      if (parts[1] === "list") {
        await handleListSessions(chatId, token)
        return
      }

      if (parts[1] === "help") {
        await telegramRequest(token, "sendMessage", {
          chat_id: chatId,
          text: "Commands:\n/opencode - Link to latest session\n/opencode list - Show recent sessions\n/opencode disconnect - Unlink session",
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
      await handleOpencodeCommand(chatId, sessionSlug, token, sessions)
      return
    }

    const sessionKey = String(chatId)
    const sessionInfo = sessions.get(sessionKey)

    if (!sessionInfo) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "No linked session.\n\nSend /opencode to link to your session." })
      return
    }

    await handleSessionMessage(chatId, sessionInfo.sessionID, sessionInfo.directory, text, token)
  }

  async function handleOpencodeCommand(
    chatId: number,
    sessionSlug: string,
    token: string,
    sessions: Map<string, TelegramSessionRecord>,
  ) {
    const sessionDir = directory
    const getResult = await fetch(`http://localhost:4096/session/${sessionSlug}`, {
      headers: { "x-opencode-directory": sessionDir },
    }).then((r) => (r.ok ? r.json().catch(() => null) : null))

    if (!getResult?.id) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Session not found: ${sessionSlug}` })
      return
    }

    const key = String(chatId)
    sessions.set(key, {
      sessionID: getResult.id,
      directory: getResult.directory || sessionDir,
      chatId,
      createdAt: Date.now(),
    })

    await saveSessions()

    await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Session linked: ${getResult.title}` })
  }

  async function handleAutoLink(chatId: number, token: string, sessions: Map<string, TelegramSessionRecord>) {
    const listResult = await sessionHttpRequest("GET", "/session?limit=5")

    if (listResult?.sessions?.length > 0) {
      const latest = listResult.sessions[0]
      const key = String(chatId)
      sessions.set(key, {
        sessionID: latest.id,
        directory: latest.directory || directory,
        chatId,
        createdAt: Date.now(),
      })

      await saveSessions()
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Linked to: ${latest.title}` })
      return
    }

    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "No sessions found.\n\nIn browser:\n1. Open your session\n2. Click Share and copy the URL slug\n3. Send it as: /opencode <slug>",
    })
  }

  async function handleListSessions(chatId: number, token: string) {
    const listResult = await sessionHttpRequest("GET", "/session?limit=5")

    if (!listResult?.sessions?.length) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "No sessions found." })
      return
    }

    let msg = "Recent sessions:\n"
    for (let i = 0; i < listResult.sessions.length; i++) {
      const s = listResult.sessions[i]
      msg += `${i + 1}. ${s.title} (${s.slug})\n`
    }

    await telegramRequest(token, "sendMessage", { chat_id: chatId, text: msg })
  }

  async function handleSessionMessage(chatId: number, sessionID: string, sessionDir: string, text: string, token: string) {
    try {
      console.log("[telegram] handleSessionMessage:", sessionID, sessionDir, text.slice(0, 50))

      // Get current message count before sending
      const beforeMsgs = await sessionHttpRequest("GET", `/session/${sessionID}/message?limit=1`, undefined, sessionDir)
      console.log("[telegram] beforeMsgs raw:", JSON.stringify(beforeMsgs).slice(0, 500))
      // Response is an array at root, not .messages
      const msgsArray = Array.isArray(beforeMsgs) ? beforeMsgs : (beforeMsgs?.messages || [])
      const beforeCount = msgsArray.length
      console.log("[telegram] beforeCount:", beforeCount)

      // Use prompt_async endpoint - returns 204 immediately
      console.log("[telegram] sending to prompt_async...")
      const response = await fetch(`http://localhost:4096/session/${sessionID}/prompt_async`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": sessionDir,
        },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      })

      console.log("[telegram] prompt_async status:", response.status)

      if (!response.ok) {
        await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Sorry, error sending message." })
        return
      }

      // Poll for new messages until we get a response
      let attempts = 0
      let newMsgs = beforeMsgs
      while (attempts < 60) {
        await new Promise((r) => setTimeout(r, 1000))
        newMsgs = await sessionHttpRequest("GET", `/session/${sessionID}/message?limit=5`, undefined, sessionDir)
        console.log("[telegram] polling raw:", JSON.stringify(newMsgs).slice(0, 500))
        // Response is array at root
        const currentMsgs = Array.isArray(newMsgs) ? newMsgs : (newMsgs?.messages || [])
        const currentCount = currentMsgs.length
        console.log("[telegram] polling:", currentCount, "vs", beforeCount)

        if (currentCount > beforeCount) {
          const allMsgs = Array.isArray(newMsgs) ? newMsgs : (newMsgs?.messages || [])
          for (const msg of allMsgs) {
            if (msg.info.role === "assistant" && msg.parts) {
              let responseText = ""
              for (const p of msg.parts) {
                if (p.type === "text") responseText += p.text
              }
              if (responseText) {
                const textToSend = responseText.length > 4000 ? responseText.slice(0, 4000) : responseText
                await telegramRequest(token, "sendMessage", { chat_id: chatId, text: textToSend })
                return
              }
            }
          }
          // Got new messages but no assistant text yet - wait more
        }
        attempts++
      }

      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: "Response sent. Check browser for details." })
    } catch (e: any) {
      await telegramRequest(token, "sendMessage", { chat_id: chatId, text: `Error: ${e?.message || e}` })
    }
  }

  async function saveSessions() {
    const data = { sessions: Object.fromEntries(sessionsMap) }
    await writeJson(sessionsDir, data)
  }

  async function sessionHttpRequest(method: string, path: string, body?: any, sessionDir?: string): Promise<any> {
    const response = await fetch(`http://127.0.0.1:4096${path}`, {
      method,
      headers: { 
        "Content-Type": "application/json",
        "x-opencode-directory": sessionDir || "",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) return null
    return response.json().catch(() => null)
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
