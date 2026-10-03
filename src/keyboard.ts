import type { VkReplyButton, VkReplyButtons } from "./types.js";

const MAX_KEYBOARD_ROWS = 10;
const MAX_BUTTONS_PER_ROW = 4;
const MAX_BUTTON_LABEL_CHARS = 40;
const MAX_PAYLOAD_BYTES = 255;
const OPENCLAW_COMMAND_KEY = "oc";
const ROW_LABEL_WIDTH_LIMITS = {
  1: 40,
  2: 22,
  3: 14,
  4: 9,
} as const;

type VkKeyboardPayload = {
  [OPENCLAW_COMMAND_KEY]?: string;
};

type VkSendKeyboardButton = {
  action: {
    type: "text";
    label: string;
    payload: string;
  };
  color: "primary" | "secondary" | "positive" | "negative";
};

type VkKeyboardMenu =
  | { kind: "providers"; buttons: VkReplyButtons }
  | { kind: "models"; buttons: VkReplyButtons }
  | { kind: "summary"; buttons: VkReplyButtons }
  | { kind: "command-options"; buttons: VkReplyButtons }
  | null;

const COMMAND_DESCRIPTOR_ALIASES: Record<string, string> = {
  thinking: "think",
};

const COMMAND_DESCRIPTOR_STOPWORDS = new Set([
  "access",
  "current",
  "level",
  "mode",
  "permission",
  "permissions",
  "setting",
  "state",
  "status",
]);

function truncateLabel(text: string): string {
  const normalized = text.trim();
  const chars = Array.from(normalized);
  if (chars.length <= MAX_BUTTON_LABEL_CHARS) {
    return normalized;
  }
  return `${chars.slice(0, MAX_BUTTON_LABEL_CHARS - 1).join("")}…`;
}

function toVkColor(style?: VkReplyButton["style"]): VkSendKeyboardButton["color"] {
  if (style === "danger") {
    return "negative";
  }
  if (style === "success") {
    return "positive";
  }
  return style === "primary" ? "primary" : "secondary";
}

function serializeCommandPayload(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const json = JSON.stringify({ [OPENCLAW_COMMAND_KEY]: trimmed } satisfies VkKeyboardPayload);
  return Buffer.byteLength(json, "utf8") <= MAX_PAYLOAD_BYTES ? json : null;
}

function estimateLabelWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(truncateLabel(text))) {
    if (/\s/u.test(char)) {
      width += 0.5;
      continue;
    }
    if (/[-_/\\|.,:;()[\]{}]/u.test(char)) {
      width += 0.75;
      continue;
    }
    if (/[\u0000-\u007f]/u.test(char)) {
      width += 1;
      continue;
    }
    width += 2;
  }
  return width;
}

function canFitRow(items: ReadonlyArray<{ text: string }>): boolean {
  const rowSize = items.length;
  if (rowSize < 1 || rowSize > MAX_BUTTONS_PER_ROW) {
    return false;
  }
  const maxLabelWidth = ROW_LABEL_WIDTH_LIMITS[rowSize as keyof typeof ROW_LABEL_WIDTH_LIMITS];
  return items.every((item) => estimateLabelWidth(item.text) <= maxLabelWidth);
}

function normalizeButton(raw: unknown): VkReplyButton | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }

  const record = raw as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const callbackData =
    typeof record.callback_data === "string" ? record.callback_data.trim() : "";
  const style = typeof record.style === "string" ? record.style.trim().toLowerCase() : undefined;
  if (!text || !callbackData) {
    return undefined;
  }

  return {
    text,
    callback_data: callbackData,
    style:
      style === "primary" || style === "secondary" || style === "success" || style === "danger"
        ? style
        : undefined,
  };
}

export function normalizeVkButtons(raw: unknown): VkReplyButtons | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const rows = raw
    .map((row) => {
      if (!Array.isArray(row)) {
        return [];
      }
      return row
        .map((button) => normalizeButton(button))
        .filter((button): button is VkReplyButton => Boolean(button))
        .slice(0, MAX_BUTTONS_PER_ROW);
    })
    .filter((row) => row.length > 0)
    .slice(0, MAX_KEYBOARD_ROWS);

  return rows.length > 0 ? rows : undefined;
}

function buildButtonRows(params: {
  items: ReadonlyArray<{ text: string; command: string; style?: VkReplyButton["style"] }>;
}): VkReplyButtons | undefined {
  const rows: VkReplyButton[][] = [];
  let currentRow: VkReplyButton[] = [];

  for (const item of params.items) {
    if (rows.length >= MAX_KEYBOARD_ROWS) {
      break;
    }

    const text = item.text.trim();
    const command = item.command.trim();
    if (!text || !command || !serializeCommandPayload(command)) {
      continue;
    }

    const button = {
      text,
      callback_data: command,
      style: item.style,
    } satisfies VkReplyButton;

    if (currentRow.length === 0) {
      currentRow = [button];
      continue;
    }

    const candidateRow = [...currentRow, button];
    if (canFitRow(candidateRow)) {
      currentRow = candidateRow;
      continue;
    }

    rows.push(currentRow);
    currentRow = [button];
  }

  if (currentRow.length > 0 && rows.length < MAX_KEYBOARD_ROWS) {
    rows.push(currentRow);
  }

  return rows.length > 0 ? rows : undefined;
}

function parseProviderButtons(text: string): VkKeyboardMenu {
  if (!/^Providers:\s*$/m.test(text) && !/^Available providers:\s*$/m.test(text)) {
    return null;
  }

  const providers = [...text.matchAll(/^- (.+?) \(\d+\)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));

  if (providers.length === 0) {
    return null;
  }

  const buttons = buildButtonRows({
    items: providers.map((provider) => ({
      text: provider,
      command: `/models ${provider}`,
      style: "primary",
    })),
  });

  return buttons ? { kind: "providers", buttons } : null;
}

function parseModelsButtons(text: string): VkKeyboardMenu {
  const headerMatch = text.match(/^Models \((.+?)\) — showing \d+-\d+ of \d+ \(page (\d+)\/(\d+)\)$/m);
  const modelRefs = [...text.matchAll(/^- ([^\n]+\/[^\n]+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((entry): entry is string => Boolean(entry));

  if (!headerMatch || modelRefs.length === 0) {
    return null;
  }

  const page = Number.parseInt(headerMatch[2] ?? "1", 10);
  const totalPages = Number.parseInt(headerMatch[3] ?? "1", 10);
  const provider = modelRefs[0]?.split("/", 1)[0]?.trim();
  if (!provider) {
    return null;
  }

  const items = modelRefs.map((modelRef) => ({
    text: modelRef.split("/").slice(1).join("/"),
    command: `/model ${modelRef}`,
    style: "primary" as const,
  }));

  const buttons = buildButtonRows({ items });
  if (!buttons) {
    return null;
  }

  const rows = buttons.map((row) => [...row]);
  const navigation: VkReplyButton[] = [];
  if (page > 1) {
    navigation.push({
      text: "Prev",
      callback_data: `/models ${provider} ${page - 1}`,
      style: "secondary",
    });
  }
  if (page < totalPages) {
    navigation.push({
      text: "Next",
      callback_data: `/models ${provider} ${page + 1}`,
      style: "secondary",
    });
  }
  if (navigation.length > 0 && rows.length < MAX_KEYBOARD_ROWS) {
    rows.push(navigation.filter((button) => Boolean(serializeCommandPayload(button.callback_data))));
  }
  if (rows.length < MAX_KEYBOARD_ROWS) {
    rows.push([
      {
        text: "Providers",
        callback_data: "/models",
        style: "secondary",
      },
    ]);
  }

  return { kind: "models", buttons: rows.slice(0, MAX_KEYBOARD_ROWS) };
}

function parseBrowseSummaryButton(text: string): VkKeyboardMenu {
  if (!text.includes("Browse: /models")) {
    return null;
  }

  const buttons = buildButtonRows({
    items: [{ text: "Browse providers", command: "/models", style: "primary" }],
  });

  return buttons ? { kind: "summary", buttons } : null;
}

function parseCurrentCommandOptions(text: string): VkKeyboardMenu {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const currentLine = lines.find((line) => line.includes("Current "));
  const optionsLine = lines.find((line) => line.startsWith("Options: "));
  if (!currentLine || !optionsLine) {
    return null;
  }

  const explicitCommands = Array.from(
    new Set(
      [...text.matchAll(/\/([a-z][a-z0-9-]*)\b/gi)]
        .map((match) => match[1]?.trim().toLowerCase())
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  let resolvedCommand =
    explicitCommands.length === 1 ? `/${explicitCommands[0]}` : undefined;
  if (!resolvedCommand) {
    const descriptor = currentLine.match(/Current\s+([^:]+):/i)?.[1]?.toLowerCase() ?? "";
    const descriptorTokens = descriptor
      .split(/[\s/(),.-]+/)
      .map((token) => token.trim())
      .filter((token) => token && !COMMAND_DESCRIPTOR_STOPWORDS.has(token));
    const commandToken = descriptorTokens[0];
    if (commandToken) {
      resolvedCommand = `/${COMMAND_DESCRIPTOR_ALIASES[commandToken] ?? commandToken}`;
    }
  }
  if (!resolvedCommand) {
    return null;
  }

  const currentMatch = currentLine.match(/Current [^:]+:\s*([^.]+)\./i);
  const currentValue = currentMatch?.[1]?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const rawOptions = optionsLine.replace(/^Options:\s*/i, "").replace(/\.$/, "");
  const options = rawOptions
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);
  if (options.length === 0) {
    return null;
  }

  const buttons = buildButtonRows({
    items: options.map((option) => ({
      text: option,
      command: `${resolvedCommand} ${option}`,
      style: option.toLowerCase() === currentValue ? "success" : "secondary",
    })),
  });

  return buttons ? { kind: "command-options", buttons } : null;
}

export function buildVkButtonsFromTextMenu(text: string): VkReplyButtons | undefined {
  const normalized = text.trim();
  if (!normalized) {
    return undefined;
  }

  const parsed =
    parseModelsButtons(normalized) ??
    parseProviderButtons(normalized) ??
    parseBrowseSummaryButton(normalized) ??
    parseCurrentCommandOptions(normalized);

  return parsed?.buttons;
}

export function buildVkKeyboard(buttons?: VkReplyButtons): string | undefined {
  if (!buttons || buttons.length === 0) {
    return undefined;
  }

  const keyboardButtons = buttons
    .slice(0, MAX_KEYBOARD_ROWS)
    .map((row) => {
      return row
        .slice(0, MAX_BUTTONS_PER_ROW)
        .map((button) => {
          const payload = serializeCommandPayload(button.callback_data);
          if (!payload) {
            return undefined;
          }
          return {
            action: {
              type: "text" as const,
              label: truncateLabel(button.text),
              payload,
            },
            color: toVkColor(button.style),
          } satisfies VkSendKeyboardButton;
        })
        .filter((button): button is VkSendKeyboardButton => Boolean(button));
    })
    .filter((row) => row.length > 0);

  if (keyboardButtons.length === 0) {
    return undefined;
  }

  return JSON.stringify({
    one_time: true,
    buttons: keyboardButtons,
  });
}

export function buildVkKeyboardRemoval(): string {
  return JSON.stringify({
    one_time: false,
    buttons: [],
  });
}

export function resolveVkButtonsFromPayload(payload: unknown): VkReplyButtons | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const channelData =
    record.channelData && typeof record.channelData === "object" && !Array.isArray(record.channelData)
      ? (record.channelData as Record<string, unknown>)
      : undefined;
  const vkData =
    channelData?.vk && typeof channelData.vk === "object" && !Array.isArray(channelData.vk)
      ? (channelData.vk as Record<string, unknown>)
      : undefined;
  const explicitButtons = normalizeVkButtons(vkData?.buttons);
  if (explicitButtons) {
    return explicitButtons;
  }

  const text = typeof record.text === "string" ? record.text : "";
  return buildVkButtonsFromTextMenu(text);
}

export function resolveVkCommandFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const command = (payload as Record<string, unknown>)[OPENCLAW_COMMAND_KEY];
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}
