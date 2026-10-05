import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatVkCommentContext, isVkCommentEventType, resolveVkVideoComment, resolveVkWallComment, sendVkCommentReply } from "./comments.js";
import { buildVkCommentTarget, parseVkCommentTarget } from "./types.js";
import type { VkInboundComment } from "./types.js";

const mockVk = {
  api: {
    wall: {
      createComment: vi.fn(),
    },
    video: {
      get: vi.fn(),
      createComment: vi.fn(),
    },
  },
};

vi.mock("./send.js", () => ({
  getOrCreateVk: vi.fn(() => mockVk),
  resolveVkOwnGroup: vi.fn(async () => ({ id: 999 })),
}));

describe("VK comment routes", () => {
  it("round-trips a public comment target without treating it as a VK peer id", () => {
    const target = buildVkCommentTarget({
      route: { type: "post_comment", ownerId: -80752341, contentId: 515, commentId: 539 },
      senderId: 62517700,
    });
    expect(target).toBe("vk:comment:post_comment:-80752341:515:539:62517700");
    expect(parseVkCommentTarget(target)).toEqual({
      route: { type: "post_comment", ownerId: -80752341, contentId: 515, commentId: 539 },
      senderId: 62517700,
    });
  });

  it("rejects malformed public comment targets", () => {
    expect(parseVkCommentTarget("vk:comment:post_comment:comment:539")).toBeUndefined();
    expect(parseVkCommentTarget("vk:comment:post_comment:-80752341:515:0:62517700")).toBeUndefined();
  });
});

describe("VK comments", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes all normalized comment event types", () => {
    expect(isVkCommentEventType("post_comment")).toBe(true);
    expect(isVkCommentEventType("clip_comment")).toBe(true);
    expect(isVkCommentEventType("video_comment")).toBe(true);
    expect(isVkCommentEventType("message")).toBe(false);
  });

  it("rejects malformed wall comments", async () => {
    await expect(resolveVkWallComment(mockVk as never, { id: 1 })).resolves.toBeNull();
  });

  it("resolves a wall comment when the VK event is wrapped under object", async () => {
    const result = await resolveVkWallComment(mockVk as never, {
      type: "wall_reply_new",
      object: {
        id: 43,
        owner_id: -100,
        post_id: 778,
        from_id: 124,
        text: "Привет",
        date: 1700000001,
      },
      group_id: 100,
    });
    expect(result).toMatchObject({
      eventType: "post_comment",
      commentId: 43,
      senderId: 124,
      ownerId: -100,
      postId: 778,
      text: "Привет",
    });
  });

  it("resolves a wall comment with the source post link only", async () => {
    const result = await resolveVkWallComment(mockVk as never, {
      id: 42,
      owner_id: -100,
      post_id: 777,
      from_id: 123,
      text: "Сколько стоит?",
      date: 1700000000,
      reply_to_comment: 7,
    });
    expect(result).toMatchObject({
      eventType: "post_comment",
      commentId: 42,
      senderId: 123,
      ownerId: -100,
      postId: 777,
      replyToComment: 7,
      origin: {
        type: "post",
        id: 777,
        url: "https://vk.com/wall-100_777",
        media: [],
      },
    });
  });

  it("resolves a short video comment as a Clip and chooses its largest preview", async () => {
    mockVk.api.video.get.mockResolvedValueOnce({
      items: [{
        type: "short_video",
        title: "Клип с тату",
        description: "Описание клипа",
        image: [
          { url: "https://example.test/small.jpg", width: 320 },
          { url: "https://example.test/large.jpg", width: 1080 },
        ],
      }],
    });
    const result = await resolveVkVideoComment(mockVk as never, {
      id: 50, owner_id: -100, video_id: 900, from_id: 123, text: "А цена?", date: 1700000000,
    });
    expect(result).toMatchObject({
      eventType: "clip_comment",
      videoId: 900,
      origin: {
        type: "clip",
        url: "https://vk.com/clip-100_900",
        title: "Клип с тату",
        text: "Описание клипа",
      },
    });
    expect(result?.origin.media[0]?.url).toBe("https://example.test/large.jpg");
  });

  it("resolves an ordinary video comment separately", async () => {
    mockVk.api.video.get.mockResolvedValueOnce({
      items: [{ type: "video", title: "Видео", image: [] }],
    });
    const result = await resolveVkVideoComment(mockVk as never, {
      id: 51, owner_id: -100, video_id: 901, from_id: 123, text: "Ок", date: 1700000000,
    });
    expect(result?.eventType).toBe("video_comment");
    expect(result?.origin.url).toBe("https://vk.com/video-100_901");
    expect(result?.origin.media).toEqual([]);
  });

  it("formats the comment with source and response-routing rules", () => {
    const comment = {
      eventType: "post_comment",
      commentId: 42,
      senderId: 123,
      text: "Сколько стоит?",
      timestamp: 1700000000000,
      ownerId: -100,
      postId: 777,
      origin: {
        type: "post",
        ownerId: -100,
        id: 777,
        url: "https://vk.com/wall-100_777",
        text: "Новая работа",
        media: [],
      },
    } satisfies VkInboundComment;
    const text = formatVkCommentContext(comment);
    expect(text).toContain("ВКонтакте → комментарий к записи");
    expect(text).toContain("https://vk.com/wall-100_777");
    expect(text).not.toContain("Правило ответа:");
  });

  it("appends optional VK comment response instructions", () => {
    const comment = {
      eventType: "post_comment",
      commentId: 42,
      senderId: 123,
      text: "Цена?",
      timestamp: 1700000000000,
      ownerId: -100,
      postId: 777,
      origin: { type: "post", ownerId: -100, id: 777, url: "https://vk.com/wall-100_777", media: [] },
    } satisfies VkInboundComment;
    const text = formatVkCommentContext(comment, "Перед ответом открой ссылку в браузере.");
    expect(text).toContain("Автор VK ID: 123");
    expect(text).toContain("Ссылка: https://vk.com/wall-100_777");
    expect(text).toContain("Инструкция агенту при ответе на комментарий:");
    expect(text).toContain("Перед ответом открой ссылку в браузере.");
  });

  it("sends a wall comment reply to the original comment", async () => {
    mockVk.api.wall.createComment.mockResolvedValueOnce({ comment_id: 501 });
    const comment = {
      eventType: "post_comment",
      commentId: 42,
      senderId: 123,
      text: "Цена?",
      timestamp: 1700000000000,
      ownerId: -100,
      postId: 777,
      origin: { type: "post", ownerId: -100, id: 777, url: "https://vk.com/wall-100_777", media: [] },
    } satisfies VkInboundComment;
    await expect(sendVkCommentReply({ token: "token", comment, text: "Уточню детали." })).resolves.toBe("501");
    expect(mockVk.api.wall.createComment).toHaveBeenCalledWith(expect.objectContaining({
      owner_id: -100, post_id: 777, message: "Уточню детали.", from_group: 999, reply_to_comment: 42,
    }));
  });

  it("sends a Clip reply through the video comment API", async () => {
    mockVk.api.video.createComment.mockResolvedValueOnce(502);
    const comment = {
      eventType: "clip_comment",
      commentId: 43,
      senderId: 123,
      text: "Цена?",
      timestamp: 1700000000000,
      ownerId: -100,
      videoId: 900,
      origin: { type: "clip", ownerId: -100, id: 900, url: "https://vk.com/clip-100_900", media: [] },
    } satisfies VkInboundComment;
    await expect(sendVkCommentReply({ token: "token", comment, text: "Напишите в ЛС." })).resolves.toBe("502");
    expect(mockVk.api.video.createComment).toHaveBeenCalledWith(expect.objectContaining({
      owner_id: -100, video_id: 900, message: "Напишите в ЛС.", from_group: 999, reply_to_comment: 43,
    }));
  });

  it("uses an explicit parent comment when one is supplied", async () => {
    mockVk.api.wall.createComment.mockResolvedValueOnce({ comment_id: 503 });
    const comment = {
      eventType: "post_comment", commentId: 44, senderId: 123, text: "?", timestamp: 1700000000000,
      ownerId: -100, postId: 777,
      origin: { type: "post", ownerId: -100, id: 777, url: "https://vk.com/wall-100_777", media: [] },
    } satisfies VkInboundComment;
    await sendVkCommentReply({ token: "token", comment, text: "Ответ", replyToComment: 11 });
    expect(mockVk.api.wall.createComment).toHaveBeenLastCalledWith(expect.objectContaining({ reply_to_comment: 11 }));
  });
});
