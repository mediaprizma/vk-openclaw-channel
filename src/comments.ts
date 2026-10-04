import type { VK } from "vk-io";
import { getOrCreateVk, resolveVkOwnGroup } from "./send.js";
import type {
  VkCommentEventType,
  VkCommentSource,
  VkInboundAttachment,
  VkInboundComment,
  VkPostOrigin,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function bestVideoImage(video: Record<string, unknown>): string | undefined {
  const images = Array.isArray(video.image) ? video.image : [];
  let best: { width: number; url: string } | undefined;
  for (const raw of images) {
    const image = asRecord(raw);
    const url = readString(image?.url);
    if (!url) continue;
    const width = readInt(image?.width) ?? 0;
    if (!best || width > best.width) best = { width, url };
  }
  return best?.url;
}

function buildPostUrl(ownerId: number, postId: number): string {
  return `https://vk.com/wall${ownerId}_${postId}`;
}

function buildVideoUrl(ownerId: number, videoId: number): string {
  return `https://vk.com/video${ownerId}_${videoId}`;
}

function buildClipUrl(ownerId: number, videoId: number): string {
  return `https://vk.com/clip${ownerId}_${videoId}`;
}

export function isVkCommentEventType(value: string): value is VkCommentEventType {
  return value === "post_comment" || value === "clip_comment" || value === "video_comment";
}

export async function resolveVkWallComment(
  vk: VK,
  rawComment: unknown,
): Promise<VkInboundComment | null> {
  const comment = asRecord(rawComment);
  if (!comment) return null;

  const id = readInt(comment.id);
  const ownerId = readInt(comment.owner_id);
  const postId = readInt(comment.post_id);
  const senderId = readInt(comment.from_id);
  const text = readString(comment.text) ?? "";

  if (!id || ownerId === undefined || !postId || senderId === undefined) {
    return null;
  }

  const origin: VkPostOrigin = {
    type: "post",
    ownerId,
    id: postId,
    url: buildPostUrl(ownerId, postId),
    media: [],
  };

  return {
    eventType: "post_comment",
    commentId: id,
    senderId,
    text,
    timestamp:
      (readInt(comment.date) ?? Math.floor(Date.now() / 1000)) * 1000,
    ownerId,
    postId,
    replyToComment: readInt(comment.reply_to_comment),
    origin,
  };
}

export async function resolveVkVideoComment(
  vk: VK,
  rawComment: unknown,
): Promise<VkInboundComment | null> {
  const comment = asRecord(rawComment);
  if (!comment) return null;

  const id = readInt(comment.id);
  const ownerId = readInt(comment.owner_id);
  const videoId = readInt(comment.video_id);
  const senderId = readInt(comment.from_id);
  const text = readString(comment.text) ?? "";

  if (!id || ownerId === undefined || !videoId || senderId === undefined) {
    return null;
  }

  let video: Record<string, unknown> | undefined;
  try {
    const response = await vk.api.video.get({
      videos: `${ownerId}_${videoId}`,
      extended: 1,
    } as never);
    const items = Array.isArray((response as { items?: unknown[] }).items)
      ? (response as { items: unknown[] }).items
      : [];
    video = asRecord(items[0]);
  } catch {
    video = undefined;
  }

  const videoType = readString(video?.type);
  const sourceType: VkCommentSource["type"] =
    videoType === "short_video" ? "clip" : "video";
  const eventType: VkCommentEventType =
    sourceType === "clip" ? "clip_comment" : "video_comment";

  const imageUrl = video ? bestVideoImage(video) : undefined;
  const media: VkInboundAttachment[] = imageUrl
    ? [
        {
          type: "photo",
          kind: "image",
          url: imageUrl,
          mimeType: "image/jpeg",
          title: "VK video preview",
        },
      ]
    : [];

  const origin: VkPostOrigin = {
    type: sourceType,
    ownerId,
    id: videoId,
    url: sourceType === "clip" ? buildClipUrl(ownerId, videoId) : buildVideoUrl(ownerId, videoId),
    text: readString(video?.description) ?? readString(video?.title),
    media,
    title: readString(video?.title),
  };

  return {
    eventType,
    commentId: id,
    senderId,
    text,
    timestamp:
      (readInt(comment.date) ?? Math.floor(Date.now() / 1000)) * 1000,
    ownerId,
    videoId,
    replyToComment: readInt(comment.reply_to_comment),
    origin,
  };
}

export const DEFAULT_VK_COMMENT_PROMPT_TEMPLATE = [
  "Источник обращения:",
  "ВКонтакте → {{source_label}}",
  "Автор VK ID: {{sender_id}}",
  "Комментарий ID: {{comment_id}}",
  "",
  "Комментарий клиента:",
  "{{comment_text}}",
  "",
  "Исходный контент: {{origin_type}}",
  "ID: {{origin_id}}",
  "Ссылка: {{origin_url}}",
  "{{origin_extra}}",
  "",
  "Правило ответа:",
  "{{response_rules}}",
].join("\n");

export const DEFAULT_VK_COMMENT_RESPONSE_RULES = [
  "Если вопрос можно решить публично — отвечай в текущем комментарии.",
  "Если для расчёта или консультации нужны персональные детали, предложи клиенту написать в личные сообщения.",
  "Не утверждай, что можешь написать клиенту первым в личные сообщения, если это не подтверждено успешной доставкой.",
].join("\n");

function renderVkCommentPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

export function formatVkCommentContext(
  comment: VkInboundComment,
  template = DEFAULT_VK_COMMENT_PROMPT_TEMPLATE,
  responseRules = DEFAULT_VK_COMMENT_RESPONSE_RULES,
): string {
  const sourceLabel =
    comment.eventType === "post_comment"
      ? "комментарий к записи"
      : comment.eventType === "clip_comment"
        ? "комментарий к VK Клипу"
        : "комментарий к видео";

  const origin = comment.origin;
  const extraLines: string[] = [];
  if (origin.title) extraLines.push(`Название: ${origin.title}`);
  if (origin.text) extraLines.push("Текст исходного контента:", origin.text);
  if (origin.media.length > 0) {
    extraLines.push(
      `В исходном контенте доступно медиа: ${origin.media.length}`,
      "Медиа передано агенту отдельно; используй его для анализа, если это необходимо для ответа.",
    );
  }

  return renderVkCommentPromptTemplate(template, {
    source_label: sourceLabel,
    sender_id: String(comment.senderId),
    comment_id: String(comment.commentId),
    comment_text: comment.text || "(без текста)",
    origin_type: origin.type,
    origin_id: String(origin.id),
    origin_url: origin.url,
    origin_extra: extraLines.join("\n"),
    response_rules: responseRules,
  });
}

export async function sendVkCommentReply(params: {
  token: string;
  comment: VkInboundComment;
  text: string;
  replyToComment?: number;
}): Promise<string> {
  const vk = getOrCreateVk(params.token);
  const group = await resolveVkOwnGroup(params.token);
  const fromGroup = group?.id;

  if ((params.comment.eventType === "post_comment" || params.comment.eventType === "clip_comment") && params.comment.postId !== undefined) {
    const response = await vk.api.wall.createComment({
      owner_id: params.comment.ownerId,
      post_id: params.comment.postId!,
      message: params.text,
      ...(fromGroup !== undefined ? { from_group: fromGroup } : {}),
      ...(params.replyToComment
        ? { reply_to_comment: params.replyToComment }
        : { reply_to_comment: params.comment.commentId }),
      guid: `openclaw-vk-${params.comment.commentId}-${Date.now()}`,
    } as never);
    const commentId = readInt((response as { comment_id?: unknown }).comment_id);
    return String(commentId ?? response);
  }

  if (
    (params.comment.eventType === "clip_comment" || params.comment.eventType === "video_comment") &&
    params.comment.videoId !== undefined
  ) {
    const response = await vk.api.video.createComment({
      owner_id: params.comment.ownerId,
      video_id: params.comment.videoId,
      message: params.text,
      ...(fromGroup !== undefined ? { from_group: fromGroup } : {}),
      ...(params.replyToComment
        ? { reply_to_comment: params.replyToComment }
        : { reply_to_comment: params.comment.commentId }),
      guid: `openclaw-vk-${params.comment.commentId}-${Date.now()}`,
    } as never);
    return String(readInt(response) ?? response);
  }

  throw new Error(`Unsupported VK comment event: ${params.comment.eventType}`);
}
