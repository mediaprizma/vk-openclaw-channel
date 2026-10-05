import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetVkHistoryImportStateForTests,
  resolveVkHistoryContext,
} from "./history.js";
import type { ResolvedVkAccount, VkInboundMessage } from "./types.js";

const getHistory = vi.fn();
const usersGet = vi.fn();

vi.mock("./send.js", () => ({
  getOrCreateVk: vi.fn(() => ({
    api: {
      messages: { getHistory },
      users: { get: usersGet },
    },
  })),
  resolveVkOwnGroup: vi.fn(async () => ({ id: 80752341, name: "Тату Тюмень" })),
}));

const account: ResolvedVkAccount = {
  accountId: "default",
  enabled: true,
  name: "Тату Тюмень",
  token: "token",
  tokenSource: "config",
  config: {},
};

const message: VkInboundMessage = {
  messageId: "99",
  conversationMessageId: 99,
  peerId: 62517700,
  senderId: 62517700,
  text: "Текущее сообщение",
  timestamp: 1791150000000,
  isGroup: false,
};

describe("VK history import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVkHistoryImportStateForTests();
  });

  it("imports previous messages once, labels real senders and excludes the current message", async () => {
    getHistory.mockResolvedValueOnce({
      count: 4,
      items: [
        {
          id: 99,
          conversation_message_id: 99,
          from_id: 62517700,
          date: 1791150000,
          out: 0,
          text: "Текущее сообщение",
        },
        {
          id: 3,
          conversation_message_id: 3,
          from_id: -80752341,
          date: 1791140063,
          out: 1,
          text: "Примеры эскизов",
          attachments: [
            {
              type: "photo",
              photo: {
                sizes: [{ url: "https://example.test/small.jpg", width: 320, height: 240 }],
              },
            },
          ],
        },
        {
          id: 2,
          conversation_message_id: 2,
          from_id: 62517700,
          date: 1791140000,
          out: 0,
          text: "На руку 10 см",
        },
      ],
    });
    usersGet.mockResolvedValueOnce([
      { id: 62517700, first_name: "Дмитрий", last_name: "Николаев" },
    ]);

    const first = await resolveVkHistoryContext({
      account,
      message,
      sessionExists: false,
    });

    expect(getHistory).toHaveBeenCalledWith({
      peer_id: 62517700,
      count: 30,
      rev: 0,
      group_id: 80752341,
    });
    expect(usersGet).toHaveBeenCalledWith({ user_ids: "62517700" });
    expect(first).toContain("Дмитрий Николаев (VK ID 62517700):");
    expect(first).toContain("Тату Тюмень (сообщество):");
    expect(first).toContain("Вложение: фото — https://example.test/small.jpg");
    expect(first).toContain("На руку 10 см");
    expect(first).not.toContain("Текущее сообщение");

    const second = await resolveVkHistoryContext({
      account,
      message,
      sessionExists: false,
    });
    expect(second).toBeUndefined();
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it("does not query VK when the OpenClaw session already exists", async () => {
    const result = await resolveVkHistoryContext({
      account,
      message,
      sessionExists: true,
    });

    expect(result).toBeUndefined();
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("allows a failed import to retry on the next message", async () => {
    getHistory
      .mockRejectedValueOnce(new Error("temporary VK error"))
      .mockResolvedValueOnce({
        items: [
          {
            id: 1,
            from_id: 62517700,
            date: 1791140000,
            text: "Старое сообщение",
          },
        ],
      });
    usersGet.mockResolvedValueOnce([]);

    await expect(
      resolveVkHistoryContext({ account, message, sessionExists: false }),
    ).resolves.toBeUndefined();

    const result = await resolveVkHistoryContext({
      account,
      message: { ...message, messageId: "100" },
      sessionExists: false,
    });

    expect(result).toContain("Старое сообщение");
    expect(getHistory).toHaveBeenCalledTimes(2);
  });
});
