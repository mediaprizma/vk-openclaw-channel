/** Channel diagnostic levels. Parsing and redaction live in src/diagnostics.ts. */
export const VK_DIAG_LEVELS = ["off", "redacted", "full"] as const;
export type VkDiagLevel = (typeof VK_DIAG_LEVELS)[number];

export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
type GroupPolicy = "open" | "disabled" | "allowlist";

/** The core's supplemental context visibility modes (`channels.<id>.contextVisibility`). */
export const VK_CONTEXT_VISIBILITY_MODES = ["all", "allowlist", "allowlist_quote"] as const;
export type VkContextVisibility = (typeof VK_CONTEXT_VISIBILITY_MODES)[number];

/** Reference to a secret the host resolves before the plugin reads the config. */
export type VkSecretRef = {
  source: string;
  provider?: string;
  id?: string;
};

export type VkCommentEventType = "post_comment" | "clip_comment" | "video_comment";

export type VkCommentSource = {
  type: "post" | "clip" | "video";
  ownerId: number;
  id: number;
  url: string;
  text?: string;
  title?: string;
  media: VkInboundAttachment[];
};

export type VkPostOrigin = VkCommentSource;

export type VkCommentReplyRoute = {
  type: "post_comment" | "clip_comment" | "video_comment";
  ownerId: number;
  contentId: number;
  commentId: number;
  parentCommentId?: number;
};

export function buildVkCommentTarget(params: {
  route: VkCommentReplyRoute;
  senderId: number;
}): string {
  return [
    "vk:comment",
    params.route.type,
    params.route.ownerId,
    params.route.contentId,
    params.route.commentId,
    params.senderId,
  ].join(":");
}

export function parseVkCommentTarget(value: string): {
  route: VkCommentReplyRoute;
  senderId: number;
} | undefined {
  const match =
    /^vk:comment:(post_comment|clip_comment|video_comment):(-?\d+):(\d+):(\d+):(-?\d+)$/.exec(
      value.trim(),
    );
  if (!match) return undefined;

  const ownerId = Number(match[2]);
  const contentId = Number(match[3]);
  const commentId = Number(match[4]);
  const senderId = Number(match[5]);
  if (
    !Number.isInteger(ownerId) ||
    !Number.isInteger(contentId) ||
    !Number.isInteger(commentId) ||
    !Number.isInteger(senderId) ||
    contentId <= 0 ||
    commentId <= 0 ||
    senderId === 0
  ) {
    return undefined;
  }

  return {
    route: {
      type: match[1] as VkCommentReplyRoute["type"],
      ownerId,
      contentId,
      commentId,
    },
    senderId,
  };
}

export type VkInboundComment = {
  eventType: VkCommentEventType;
  commentId: number;
  senderId: number;
  text: string;
  timestamp: number;
  ownerId: number;
  postId?: number;
  videoId?: number;
  replyToComment?: number;
  origin: VkPostOrigin;
};

export type VkAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Community token, or a SecretRef the host resolves into one. */
  token?: string | VkSecretRef;
  tokenFile?: string;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  defaultTo?: string;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  /** Long-poll transport tunables; see `resolveTransportSilenceMs` in monitor.ts. */
  transport?: { silenceMs?: number };
  /** Channel/account system prompt injected into every VK turn. */
  systemPrompt?: string;
  /** Template used to build the agent context for VK wall/video comments. */
  commentPromptTemplate?: string;
  commentResponseRules?: string;
  /** Which forwards reach the agent in groups; see `VK_CONTEXT_VISIBILITY_MODES`. */
  contextVisibility?: VkContextVisibility;
  comments?: {
    enabled?: boolean;
    postComments?: boolean;
    clipComments?: boolean;
    videoComments?: boolean;
  };
  groups?: Record<
    string,
    {
      enabled?: boolean;
      allowFrom?: Array<string | number>;
      requireMention?: boolean;
      systemPrompt?: string;
      tools?: {
        allow?: string[];
        alsoAllow?: string[];
        deny?: string[];
      };
    }
  >;
};

export type VkConfig = VkAccountConfig & {
  /** Channel-wide: one level for every account. */
  diagnostics?: { level?: VkDiagLevel };
  accounts?: Record<string, VkAccountConfig>;
};

export type ResolvedVkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  /** Empty when the token is missing or its SecretRef was not resolved. */
  token: string;
  /** `source:provider:id` of a SecretRef the host left unresolved. */
  tokenUnresolved?: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: VkAccountConfig;
};

/** A message forwarded into an inbound one, as VK delivers it. */
export type VkInboundForward = {
  /** Author of the forwarded message; negative for a community. */
  senderId: number;
  /** When it was originally sent, in milliseconds. */
  timestamp?: number;
  /** VK ids of the original, when VK sends them: enough to look it up again. */
  messageId?: number;
  conversationMessageId?: number;
  text: string;
  attachments?: VkInboundAttachment[];
  forwards?: VkInboundForward[];
};

export type VkInboundMessage = {
  eventType?: "message";
  comment?: VkInboundComment;
  replyRoute?: VkCommentReplyRoute;
  messageId: string;
  conversationMessageId?: number;
  peerId: number;
  senderId: number;
  text: string;
  timestamp: number;
  isGroup: boolean;
  messagePayload?: unknown;
  attachments?: VkInboundAttachment[];
  replyToMessageId?: string;
  replyToText?: string;
  /** When the quoted message was sent, in milliseconds. */
  replyToTimestamp?: number;
  /** Author of the quoted message; negative for a community. */
  replyToSenderId?: number;
  /** Messages forwarded into this one. */
  forwards?: VkInboundForward[];
  /** Messages forwarded into the quoted one. */
  replyToForwards?: VkInboundForward[];
};

export type VkButtonStyle = "primary" | "secondary" | "success" | "danger";

export type VkReplyButton = {
  text: string;
  callback_data: string;
  style?: VkButtonStyle;
};

export type VkReplyButtons = ReadonlyArray<ReadonlyArray<VkReplyButton>>;

export type VkInboundAttachment = {
  type: string;
  kind: string;
  url?: string;
  title?: string;
  mimeType?: string;
  /** A shared wall post: its address and text. The post has no media URL. */
  post?: { url?: string; text?: string };
  /**
   * The attachment belongs to a shared wall post, not to the sender. Only its
   * images are downloaded: post audio would be transcribed into the turn as if
   * the sender had said it. See `collectVkOwnMedia`.
   */
  fromPost?: boolean;
};

export type VkInboundResolvedMedia = {
  path?: string;
  url: string;
  contentType?: string;
  attachment: VkInboundAttachment;
};

export type VkProbe = {
  ok: boolean;
  groupId?: number;
  groupName?: string;
  screenName?: string;
  error?: string;
};

export type CoreConfig = {
  channels?: {
    "vk-openclaw-channel"?: VkConfig;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
