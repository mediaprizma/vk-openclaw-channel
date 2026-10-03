import type { VK } from "vk-io";
import { extractVkInboundAttachments } from "./media.js";
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

function normalizePostAttachments(raw: unknown): VkInboundAttachment[] {
  return extractVkInboundAttachments(raw);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function isVkPhotoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "vkuserphoto.ru" || url.hostname.endsWith(".vkuserphoto.ru"))
    );
  } catch {
    return false;
  }
}

function collectVkPublicImageUrls(html: string): string[] {
  const urls = new Set<string>();

  const add = (raw: string | undefined) => {
    if (!raw) return;
    const url = decodeHtmlAttribute(raw.trim()).replace(/[\\\\\"}\],;]+$/g, "");
    if (isVkPhotoUrl(url)) urls.add(url);
  };

  // Prefer VK's explicit photo-viewer node when it is present.
  const pvPhotoRegex =
    /<img\b[^>]*data-testid=["']pv_photo_image["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const pvPhotoRegexReversed =
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*data-testid=["']pv_photo_image["'][^>]*>/gi;

  for (const match of html.matchAll(pvPhotoRegex)) add(match[1]);
  for (const match of html.matchAll(pvPhotoRegexReversed)) add(match[1]);

  // The ordinary wall page may not render the viewer at all. In that case VK
  // often embeds the real photo URL in serialized HTML/JSON. Current source
  // images use /s/v1/ig2/ and/or crop/as rendition parameters, unlike the
  // small avatar and icon URLs also present on the page.
  const embeddedUrlRegex =
    /https?:\/\/[^"'<\s]+vkuserphoto\.ru[^"'<\s]+/gi;
  for (const match of html.matchAll(embeddedUrlRegex)) {
    add(match[0].replace(/\\\//g, "/"));
  }

  const directVkUrlRegex =
    /(?:src|content|url|photo_\d+|image|original|orig|large)["'\s:=]+["']?(https?:\/\/[^"'\s<>]+vkuserphoto\.ru[^"'\s<>]*)/gi;
  for (const match of html.matchAll(directVkUrlRegex)) add(match[1]);

  const mediaCandidates = [...urls].filter((url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.toLowerCase();
      return path.includes("/s/v1/ig2/") || parsed.searchParams.has("as") || parsed.searchParams.has("crop");
    } catch {
      return false;
    }
  });

  // og:image is a weaker fallback, but it is still a legitimate post image.
  const ogUrls: string[] = [];
  const ogImageRegex =
    /<meta\b[^>]*(?:property|name)=["']og:image["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/gi;
  const ogImageRegexReversed =
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["'][^>]*>/gi;
  for (const match of html.matchAll(ogImageRegex)) {
    const raw = decodeHtmlAttribute(match[1]?.trim() ?? "");
    if (isVkPhotoUrl(raw)) ogUrls.push(raw);
  }
  for (const match of html.matchAll(ogImageRegexReversed)) {
    const raw = decodeHtmlAttribute(match[1]?.trim() ?? "");
    if (isVkPhotoUrl(raw)) ogUrls.push(raw);
  }

  return [...new Set([...mediaCandidates, ...ogUrls])];
}

function extractVkPublicMeta(html: string, key: "og:description" | "og:title"): string | undefined {
  const patterns =
    key === "og:description"
      ? [
          /<meta\b[^>]*(?:property|name)=["']og:description["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i,
          /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*(?:property|name)=["']og:description["'][^>]*>/i,
        ]
      : [
          /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*\bcontent=["']([^"']*)["'][^>]*>/i,
          /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
        ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = decodeHtmlAttribute(match[1]).trim();
      if (value) return value;
    }
  }
  return undefined;
}

async function fetchVkPublicWallPost(postUrl: string, logError?: (line: string) => void): Promise<{
  media: VkInboundAttachment[];
  text?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const urls = [postUrl];
    try {
      const parsed = new URL(postUrl);
      if (parsed.hostname === "vk.com") {
        parsed.hostname = "vk.ru";
        urls.push(parsed.toString());
      }
    } catch {
      // Keep the original URL as the only candidate.
    }

    let lastError: unknown;
    for (const url of urls) {
      try {
        logError?.(`vk: fetching public post page ${url}`);
        const response = await fetch(url, {
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "ru-RU,ru;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            pragma: "no-cache",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
          },
          redirect: "follow",
          signal: controller.signal,
        });

        const html = await response.text();
        logError?.(
          `vk: public post response status=${response.status} finalUrl=${response.url} htmlBytes=${Buffer.byteLength(html, "utf8")} contentType=${response.headers?.get?.("content-type") ?? "unknown"}`,
        );

        if (!response.ok) {
          throw new Error(`VK public page returned HTTP ${response.status}`);
        }
        if (html.length > 8_000_000) {
          throw new Error("VK public page is unexpectedly large");
        }

        const imageUrls = collectVkPublicImageUrls(html);
        logError?.(
          `vk: public post parsed images=${imageUrls.length} pvPhoto=${(html.match(/pv_photo_image/g) ?? []).length} vkUserPhoto=${(html.match(/vkuserphoto\.ru/gi) ?? []).length}`,
        );

        const media = imageUrls.map((imageUrl, index) => ({
          type: "photo",
          kind: "image",
          url: imageUrl,
          mimeType: "image/jpeg",
          title: `VK wall photo ${index + 1}`,
          fromPost: true,
        }));

        if (media.length > 0 || extractVkPublicMeta(html, "og:description")) {
          return {
            media,
            text: extractVkPublicMeta(html, "og:description"),
          };
        }

        lastError = new Error("VK public page contained no extractable post media");
      } catch (err) {
        lastError = err;
        logError?.(`vk: public post fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("VK public post could not be resolved");
  } finally {
    clearTimeout(timeout);
  }
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

  const sourceType: VkCommentSource["type"] = "post";
  const eventType: VkCommentEventType = "post_comment";

  const postType = readString(post?.postType) ?? readString(post?.post_type);
  const sourceType: VkCommentSource["type"] = postType === "clip" ? "clip" : "post";
  const eventType: VkCommentEventType = sourceType === "clip" ? "clip_comment" : "post_comment";

  const postMedia = apiPostMedia.length > 0 ? apiPostMedia : (publicPost?.media ?? []);

  const origin: VkPostOrigin = {
    type: sourceType,
    ownerId,
    id: postId,
    url: buildPostUrl(ownerId, postId),
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
