import { getOrCreateVk, resolveVkOwnGroup } from "./send.js";
import type {
  VkCommentEventType,
  VkCommentSource,
  VkInboundComment,
  VkPostOrigin,
} from "./types.js";

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

  const sourceType: VkCommentSource["type"] = "post";
  const eventType: VkCommentEventType = "post_comment";


  const sourceType: VkCommentSource["type"] = postType === "clip" ? "clip" : "post";
  const eventType: VkCommentEventType = sourceType === "clip" ? "clip_comment" : "post_comment";

  const postMedia = apiPostMedia.length > 0 ? apiPostMedia : (publicPost?.media ?? []);

  const origin: VkPostOrigin = {
    type: sourceType,
    ownerId,
    id: postId,
    url: buildPostUrl(ownerId, postId),
    text: undefined,
    media: [],
  };
  return {
    eventType,
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

export function formatVkCommentContext(comment: VkInboundComment): string {
  const sourceLabel =
    comment.eventType === "post_comment"
      ? "комментарий к записи"
      : comment.eventType === "clip_comment"
        ? "комментарий к VK Клипу"
        : "комментарий к видео";

  const origin = comment.origin;
  const lines = [
    "Источник обращения:",
    `ВКонтакте → ${sourceLabel}`,
    `Автор VK ID: ${comment.senderId}`,
    `Комментарий ID: ${comment.commentId}`,
    "",
    "Комментарий клиента:",
    comment.text || "(без текста)",
    "",
    `Исходный контент: ${origin.type}`,
    `ID: ${origin.id}`,
    `Ссылка: ${origin.url}`,
  ];

  if (origin.title) lines.push(`Название: ${origin.title}`);
  if (origin.text) {
    lines.push("", "Текст исходного контента:", origin.text);
  }

  if (origin.media.length > 0) {
    lines.push(
      "",
      `В исходном контенте доступно медиа: ${origin.media.length}`,
      "Медиа передано агенту отдельно; используй его для анализа, если это необходимо для ответа.",
    );
  }

  lines.push(
    "",
    "Правило ответа:",
    "Если вопрос можно решить публично — отвечай в текущем комментарии.",
    "Если для расчёта или консультации нужны персональные детали, предложи клиенту написать в личные сообщения.",
    "Не утверждай, что можешь написать клиенту первым в личные сообщения, если это не подтверждено успешной доставкой.",
  );

  return lines.join("\n");
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
