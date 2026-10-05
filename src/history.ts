import { getOrCreateVk, resolveVkOwnGroup } from "./send.js";
import { extractVkInboundAttachments } from "./media.js";
import type { ResolvedVkAccount, VkInboundMessage } from "./types.js";

const DEFAULT_HISTORY_COUNT = 30;
const MAX_HISTORY_CHARS = 12_000;

type VkHistoryItem = {
  id?: number;
  conversation_message_id?: number;
  from_id?: number;
  date?: number;
  out?: number;
  text?: string;
  attachments?: Array<Record<string, unknown>>;
};

type VkHistoryResponse = {
  count?: number;
  items?: VkHistoryItem[];
};

type VkUser = {
  id?: number;
  first_name?: string;
  last_name?: string;
};

const importInFlight = new Map<string, Promise<string | undefined>>();
const importedKeys = new Set<string>();

function historyKey(account: ResolvedVkAccount, senderId: number): string {
  return `${account.accountId}:${senderId}`;
}

function trimText(value: string | undefined): string {
  return value?.trim() ?? "";
}

function largestPhotoUrl(photo: Record<string, unknown>): string | undefined {
  const sizes = Array.isArray(photo.sizes) ? photo.sizes : [];
  let best: { area: number; url: string } | undefined;

  for (const raw of sizes) {
    if (!raw || typeof raw !== "object") continue;
    const size = raw as Record<string, unknown>;
    const url = typeof size.url === "string" ? size.url : undefined;
    if (!url) continue;
    const width = typeof size.width === "number" ? size.width : 0;
    const height = typeof size.height === "number" ? size.height : 0;
    const area = width * height;
    if (!best || area > best.area) {
      best = { area, url };
    }
  }

  return best?.url;
}

function historyAttachmentLines(attachments: VkHistoryItem["attachments"]): string[] {
  const lines: string[] = [];

  for (const attachment of attachments ?? []) {
    const type = typeof attachment.type === "string" ? attachment.type : "unknown";
    const object =
      attachment[type] && typeof attachment[type] === "object"
        ? (attachment[type] as Record<string, unknown>)
        : undefined;

    if (type === "photo" && object) {
      const url = largestPhotoUrl(object);
      lines.push(url ? `Вложение: фото — ${url}` : "Вложение: фото");
      continue;
    }

    if ((type === "doc" || type === "audio") && object) {
      const url = typeof object.url === "string" ? object.url : undefined;
      const title = typeof object.title === "string" ? object.title.trim() : "";
      lines.push(url ? `Вложение: ${type}${title ? ` «${title}»` : ""} — ${url}` : `Вложение: ${type}${title ? ` «${title}»` : ""}`);
      continue;
    }

    if (object) {
      const title =
        (typeof object.title === "string" && object.title.trim()) ||
        (typeof object.description === "string" && object.description.trim()) ||
        "";
      lines.push(`Вложение: ${type}${title ? ` «${title}»` : ""}`);
    } else {
      lines.push(`Вложение: ${type}`);
    }
  }

  return lines;
}

async function resolveUserLabels(
  vk: ReturnType<typeof getOrCreateVk>,
  senderIds: number[],
): Promise<Map<number, string>> {
  const labels = new Map<number, string>();
  const ids = [...new Set(senderIds.filter((id) => id > 0))];
  if (ids.length === 0) return labels;

  try {
    const response = (await vk.api.users.get({
      user_ids: ids.join(","),
    })) as VkUser[] | { items?: VkUser[] };
    const users = Array.isArray(response) ? response : response.items ?? [];

    for (const user of users) {
      if (!Number.isInteger(user.id) || user.id <= 0) continue;
      const name = [user.first_name, user.last_name]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(" ");
      if (name) labels.set(user.id!, name);
    }
  } catch {
    // A name lookup is enrichment only. History import must still work when
    // VK refuses or temporarily fails users.get.
  }

  return labels;
}

async function buildHistoryContext(
  account: ResolvedVkAccount,
  message: VkInboundMessage,
): Promise<string | undefined> {
  const vk = getOrCreateVk(account.token);
  const ownGroup = await resolveVkOwnGroup(account.token);

  const params: {
    peer_id: number;
    count: number;
    rev: 0;
    group_id?: number;
  } = {
    peer_id: message.senderId,
    count: DEFAULT_HISTORY_COUNT,
    rev: 0,
    ...(ownGroup ? { group_id: ownGroup.id } : {}),
  };

  const response = (await vk.api.messages.getHistory(params)) as VkHistoryResponse;
  const items = Array.isArray(response.items) ? response.items : [];

  const currentId = Number(message.messageId);
  const currentConversationId = message.conversationMessageId;
  const filtered = items.filter((item) => {
    if (Number.isSafeInteger(currentId) && item.id === currentId) return false;
    if (
      currentConversationId !== undefined &&
      item.conversation_message_id === currentConversationId
    ) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return undefined;
  }

  const senderIds = filtered
    .map((item) => item.from_id)
    .filter((id): id is number => typeof id === "number");
  const labels = await resolveUserLabels(vk, senderIds);

  const communityLabel =
    account.name?.trim() || ownGroup?.name?.trim() || "VK сообщество";

  const lines = [
    "Ранее сохранённая переписка VK (импортирована один раз перед первым сообщением этого клиента):",
    "Используй её только как контекст предыдущего разговора, а не как новое сообщение клиента.",
    "",
  ];
  let renderedEntries = 0;

  for (const item of [...filtered].reverse()) {
    const senderId = typeof item.from_id === "number" ? item.from_id : undefined;
    let senderLabel = senderId !== undefined ? `VK ID ${senderId}` : "VK отправитель";

    if (senderId !== undefined && senderId < 0 && ownGroup && senderId === -ownGroup.id) {
      senderLabel = `${communityLabel} (сообщество)`;
    } else if (senderId !== undefined && senderId > 0) {
      const name = labels.get(senderId);
      senderLabel = name ? `${name} (VK ID ${senderId})` : `VK ID ${senderId}`;
    }

    const date =
      typeof item.date === "number" && Number.isFinite(item.date)
        ? new Date(item.date * 1000).toLocaleString("ru-RU")
        : undefined;
    const text = trimText(item.text);
    const attachments = historyAttachmentLines(item.attachments);
    if (!text && attachments.length === 0) continue;

    lines.push(
      `[${date ?? "дата неизвестна"}] ${senderLabel}:`,
      text || "(без текста)",
      ...attachments,
      "",
    );
    renderedEntries += 1;
  }

  if (renderedEntries === 0) return undefined;

  const result = lines.join("\n").trim();

  if (result.length <= MAX_HISTORY_CHARS) {
    return result;
  }

  return (
    result.slice(0, MAX_HISTORY_CHARS).trimEnd() +
    "\n\n[История сокращена до безопасного размера. Более старые сообщения не импортированы.]"
  );
}

export async function resolveVkHistoryContext(params: {
  account: ResolvedVkAccount;
  message: VkInboundMessage;
  sessionExists: boolean;
  onError?: (error: unknown) => void;
}): Promise<string | undefined> {
  if (params.sessionExists || params.message.isGroup) return undefined;

  const key = historyKey(params.account, params.message.senderId);
  if (importedKeys.has(key)) return undefined;

  const existing = importInFlight.get(key);
  if (existing) return await existing;

  const task = (async () => {
    try {
      const context = await buildHistoryContext(params.account, params.message);
      // Mark the key only after VK answered successfully. A transport/API
      // failure must be retried on the next inbound message.
      importedKeys.add(key);
      return context;
    } catch (error) {
      params.onError?.(error);
      return undefined;
    } finally {
      importInFlight.delete(key);
    }
  })();

  importInFlight.set(key, task);
  return await task;
}

export async function recoverVkUnreadHistory(params: {
  account: ResolvedVkAccount;
  enqueue: (message: VkInboundMessage) => Promise<void>;
  onError?: (error: unknown) => void;
}): Promise<number> {
  const vk = getOrCreateVk(params.account.token);
  const ownGroup = await resolveVkOwnGroup(params.account.token);
  if (!ownGroup) {
    return 0;
  }

  try {
    const response = (await vk.api.messages.getConversations({
      filter: "unread",
      count: 100,
      extended: 0,
      group_id: ownGroup.id,
    } as never)) as { items?: unknown[] };

    const peers = new Set<number>();
    for (const raw of response.items ?? []) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const conversation =
        item.conversation && typeof item.conversation === "object"
          ? (item.conversation as Record<string, unknown>)
          : undefined;
      const peer =
        conversation?.peer && typeof conversation.peer === "object"
          ? (conversation.peer as Record<string, unknown>)
          : undefined;
      const peerId =
        typeof peer?.id === "number"
          ? peer.id
          : typeof (item.last_message as Record<string, unknown> | undefined)?.peer_id === "number"
            ? ((item.last_message as Record<string, unknown>).peer_id as number)
            : undefined;
      if (peerId !== undefined && peerId > 0) {
        peers.add(peerId);
      }
    }

    let recovered = 0;
    for (const peerId of peers) {
      const history = (await vk.api.messages.getHistory({
        peer_id: peerId,
        count: DEFAULT_HISTORY_COUNT,
        rev: 1,
        group_id: ownGroup.id,
      } as never)) as VkHistoryResponse;

      const items = Array.isArray(history.items) ? history.items : [];
      for (const item of items) {
        if (item.out === 1 || item.id === undefined || item.from_id === undefined) {
          continue;
        }
        const message: VkInboundMessage = {
          eventType: "message",
          messageId: String(item.id),
          conversationMessageId: item.conversation_message_id,
          peerId,
          senderId: item.from_id,
          text: item.text ?? "",
          timestamp:
            typeof item.date === "number" && Number.isFinite(item.date)
              ? item.date * 1000
              : Date.now(),
          isGroup: peerId >= 2_000_000_000,
          attachments: extractVkInboundAttachments(item.attachments),
        };
        await params.enqueue(message);
        recovered += 1;
      }
    }

    return recovered;
  } catch (error) {
    params.onError?.(error);
    throw error;
  }
}

export function resetVkHistoryImportStateForTests(): void {
  importedKeys.clear();
  importInFlight.clear();
}
