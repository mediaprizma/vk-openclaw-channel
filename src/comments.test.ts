import { describe, expect, it } from "vitest";
import { formatVkCommentContext, isVkCommentEventType } from "./comments.js";
import type { VkInboundComment } from "./types.js";

describe("VK comment context", () => {
  it("keeps the source post and tells the agent how to route the answer", () => {
    const comment: VkInboundComment = {
      eventType: "post_comment",
      commentId: 42,
      senderId: 123,
      text: "Сколько стоит такая татуировка?",
      timestamp: 1_700_000_000_000,
      ownerId: -100,
      postId: 777,
      origin: {
        type: "post",
        ownerId: -100,
        id: 777,
        url: "https://vk.com/wall-100_777",
        text: "Новая работа",
        media: [
          {
            type: "photo",
            kind: "image",
            url: "https://example.test/tattoo.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
    };

    const context = formatVkCommentContext(comment);

    expect(context).toContain("ВКонтакте → комментарий к записи");
    expect(context).toContain("Комментарий ID: 42");
    expect(context).toContain("https://vk.com/wall-100_777");
    expect(context).toContain("Новая работа");
    expect(context).toContain("Медиа передано агенту отдельно");
    expect(context).toContain("продолжить разговор в личных сообщениях");
  });

  it("recognizes only normalized comment event types", () => {
    expect(isVkCommentEventType("post_comment")).toBe(true);
    expect(isVkCommentEventType("clip_comment")).toBe(true);
    expect(isVkCommentEventType("message")).toBe(false);
  });
});
