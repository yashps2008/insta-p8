import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"
import {
  sendTextDM,
  sendCardDM,
  sendMediaDM,
  replyToComment,
} from "@/lib/instagram-api"

const GRAPH = "https://graph.instagram.com/v24.0"
const DEFAULT_PUBLIC_REPLIES = ["Check your DMs! 📥", "Sent! 🔥", "Check inbox! ✨"]
const POLL_SECRET = process.env.POLL_SECRET || process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN

function keywordMatches(triggerValue: string, text: string): boolean {
  const lower = text.toLowerCase()
  return triggerValue
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((k) => lower.includes(k))
}
`
function parseContent(raw: any) {
  if (!raw) return {}
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw)
    } catch {
      return { message: raw }
    }
  }
  return raw
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

async function igGet(path: string, token: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?"
  const res = await fetch(${GRAPH}/${path}${sep}access_token=${token}, {
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  const manualSecret = request.nextUrl.searchParams.get("secret")
  const isCron = !!cronSecret && authHeader === Bearer ${cronSecret}
  const isManual = !!POLL_SECRET && !!manualSecret && manualSecret === POLL_SECRET
  if (!isCron && !isManual) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = await getSupabaseServerClient()
  const results: any[] = []

  try {
    const { data: users } = await supabase.from("users").select("id, username, access_token")

    for (const user of users || []) {
      if (!user.access_token) continue

      const { data: automations } = await supabase
        .from("automations")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("trigger_source", "comment")

      if (!automations?.length) {
        results.push({ user: user.username, status: "no active comment automations" })
        continue
      }

      const mediaData = await igGet("me/media?fields=id,timestamp&limit=10", user.access_token)
      if (mediaData.error) {
        results.push({ user: user.username, error: mediaData.error.message })
        continue
      }

      for (const media of mediaData.data || []) {
        const commentsData = await igGet(
          ${media.id}/comments?fields=id,text,username,timestamp&limit=50,
          user.access_token
        )
        if (commentsData.error) continue

        for (const comment of commentsData.data || []) {
          const commentText = (comment.text || "").toLowerCase().trim()
          if (!commentText) continue
          if (comment.username?.toLowerCase() === user.username?.toLowerCase()) continue

          let alreadyProcessed = false
          try {
            const { data: existing } = await supabase
              .from("poll_processed_comments")
              .select("comment_id")
              .eq("comment_id", comment.id)
              .single()
            alreadyProcessed = !!existing
          } catch {}
          if (alreadyProcessed) continue

          try {
            await supabase.from("poll_processed_comments").insert({
              comment_id: comment.id,
              user_id: user.id,
              media_id: media.id,
            })
          } catch {}

          let match = automations.find(
            (a: any) => a.specific_media_id = media.id && a.trigger_type = "reply_all"
          )
          if (!match) {
            match = automations.find(
              (a: any) =>
                a.specific_media_id === media.id &&
                a.trigger_type === "keyword" &&
                keywordMatches(a.trigger_value, commentText)
            )
          }
          if (!match) {
            match = automations.find(
              (a: any) =>
                !a.specific_media_id &&
                a.trigger_type === "keyword" &&
                keywordMatches(a.trigger_value, commentText)
            )
          }
          if (!match) continue

          const content = parseContent(match.response_content)
          const replyMode = content.reply_mode || "both"
          const getPublicReply = (): string => {
            const pool: string[] =
              Array.isArray(content.public_replies) && content.public_replies.filter(Boolean).length > 0
                ? content.public_replies.filter(Boolean)
                : DEFAULT_PUBLIC_REPLIES
            return pickRandom(pool)
          }

          console.log([poll] Match "${match.name}" for @${comment.username})

          if (replyMode !== "dm_only") {
            await replyToComment(user.access_token, comment.id, getPublicReply())
          }

          if (replyMode !== "public_only") {
            const recipient = { comment_id: comment.id }
            if (content.media?.url) {
              await sendMediaDM(user.access_token, recipient, content.media.type || "image", content.media.url)
              if (content.message) {
                await sendTextDM(user.access_token, recipient, content.message)
              }
            } else if (content.card) {
              await sendCardDM(user.access_token, recipient, content.card)
            } else if (content.message) {
              await sendTextDM(user.access_token, recipient, content.message)
            }
          }

          results.push({
            user: user.username,
            comment_by: comment.username,
            automation: match.name,
            status: "sent",
          })
        }
      }
    }

    return NextResponse.json({ success: true, polled_at: new Date().toISOString(), results })
  } catch (error: any) {
    console.error("[poll] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
