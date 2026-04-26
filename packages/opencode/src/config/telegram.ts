import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Config = Schema.Struct({
  opencode: Schema.Struct({
    url: Schema.optional(Schema.String),
    directory: Schema.optional(Schema.String),
  }),
  telegram: Schema.Struct({
    allowedChats: Schema.optional(Schema.Array(Schema.Number)),
    allowedUsers: Schema.optional(Schema.Array(Schema.Number)),
  }),
  session: Schema.Struct({
    defaultModel: Schema.Struct({
      providerID: Schema.optional(Schema.String),
      modelID: Schema.optional(Schema.String),
    }),
    autoShare: Schema.optional(Schema.Boolean),
    persistDirectory: Schema.optional(Schema.String),
  }),
})
  .annotate({ identifier: "TelegramConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Config = Schema.Schema.Type<typeof Config>

export const TelegramSession = Schema.Struct({
  sessionId: Schema.String,
  chatId: Schema.Number,
  thread: Schema.optional(Schema.String),
  createdAt: Schema.Number,
})

export type TelegramSession = Schema.Schema.Type<typeof TelegramSession>

export const SessionState = Schema.Struct({
  sessions: Schema.Record(Schema.String, TelegramSession),
})

export type SessionState = Schema.Schema.Type<typeof SessionState>