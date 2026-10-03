import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatVkCommentContext, isVkCommentEventType, resolveVkVideoComment, resolveVkWallComment, sendVkCommentReply } from "./comments.js";
import { buildVkCommentTarget, parseVkCommentTarget } from "./types.js";
import type { VkInboundComment } from "./types.js";

vi.mock("./media.js", () => ({
  extractVkInboundAttachments: vi.fn((raw: unknown) =>
    Array.isArray(raw) ? raw : [],
  ),
}));

const mockVk = {
  api: {
    wall: {
      getById: vi.fn(),
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

  it("resolves a wall comment with the source post and image media", async () => {
    mockVk.api.wall.getById.mockResolvedValueOnce({
      items: [{
        post_type: "post",
        text: "Новая татуировка",
        attachments: [{ type: "photo", kind: "image", url: "https://example.test/tattoo.jpg", mimeType: "image/jpeg" }],
      }],
    });
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
        text: "Новая татуировка",
      },
    });
    expect(result?.origin.media).toHaveLength(1);
  });

  it("loads source post image from the public VK page when wall.getById is unavailable", async () => {
    mockVk.api.wall.getById.mockRejectedValueOnce(new Error("VK error 27"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<div id="pv_photo"><img data-testid="pv_photo_image" src="https://sun9-48.vkuserphoto.ru/photo.jpg?quality=95&amp;crop=0,0,1961,1593"></div>',
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveVkWallComment(mockVk as never, {
      id: 43,
      owner_id: -80752341,
      post_id: 512,
      from_id: 123,
      text: "такую хочу",
      date: 1700000000,
    });

    expect(result?.origin.url).toBe("https://vk.com/wall-80752341_512");
    expect(result?.origin.media).toEqual([
      expect.objectContaining({
        type: "photo",
        kind: "image",
        url: "https://sun9-48.vkuserphoto.ru/photo.jpg?quality=95&crop=0,0,1961,1593",
        mimeType: "image/jpeg",
        fromPost: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://vk.com/wall-80752341_512",
      expect.objectContaining({
        method: "GET",
        redirect: "follow",
      }),
    );
  });

  it("extracts embedded VK source image URLs from the ordinary wall page", async () => {
    mockVk.api.wall.getById.mockRejectedValueOnce(new Error("VK error 27"));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<div data-json="{&quot;photo&quot;:&quot;https:\/\/sun9-48.vkuserphoto.ru\/s\/v1\/ig2\/abc.jpg?quality=95&amp;crop=0,0,1961,1593&amp;as=32x26,1961x1593&quot;}">' +
        '<img src="https://sun9-48.vkuserphoto.ru/avatar.jpg?size=73x73">',
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveVkWallComment(mockVk as never, {
      id: 45,
      owner_id: -80752341,
      post_id: 515,
      from_id: 123,
      text: "что на фото?",
      date: 1700000000,
    });

    expect(result?.origin.media).toEqual([
      expect.objectContaining({
        kind: "image",
        url: "https://sun9-48.vkuserphoto.ru/s/v1/ig2/abc.jpg?quality=95&crop=0,0,1961,1593&as=32x26,1961x1593",
        fromPost: true,
      }),
    ]);
  });

  it("uses the public page when the VK API returns a partial post without media", async () => {
    mockVk.api.wall.getById.mockResolvedValueOnce({
      items: [{ post_type: "post", text: "Пост без вложений в API", attachments: [] }],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        '<meta property="og:image" content="https://sun9-48.vkuserphoto.ru/s/v1/ig2/abc.jpg?crop=0,0,1200,900">',
    })));

    const result = await resolveVkWallComment(mockVk as never, {
      id: 46,
      owner_id: -80752341,
      post_id: 515,
      from_id: 123,
      text: "покажи",
      date: 1700000000,
    });

    expect(result?.origin.text).toBe("Пост без вложений в API");
    expect(result?.origin.media).toHaveLength(1);
    expect(result?.origin.media[0]?.url).toContain("/s/v1/ig2/abc.jpg");
  });

  it("falls back safely when both VK API and public page are unavailable", async () => {
    mockVk.api.wall.getById.mockRejectedValueOnce(new Error("VK error 27"));
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));
    const result = await resolveVkWallComment(mockVk as never, {
      id: 44, owner_id: -100, post_id: 778, from_id: 123, text: "Цена?", date: 1700000000,
    });
    expect(result?.eventType).toBe("post_comment");
    expect(result?.origin.text).toBeUndefined();
    expect(result?.origin.media).toEqual([]);
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
        media: [{ type: "photo", kind: "image", url: "https://example.test/t.jpg", mimeType: "image/jpeg" }],
      },
    } satisfies VkInboundComment;
    const text = formatVkCommentContext(comment);
    expect(text).toContain("ВКонтакте → комментарий к записи");
    expect(text).toContain("https://vk.com/wall-100_777");
    expect(text).toContain("Медиа передано агенту отдельно");
    expect(text).toContain("предложи клиенту написать в личные сообщения");
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
