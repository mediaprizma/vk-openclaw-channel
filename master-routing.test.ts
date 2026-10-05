import { beforeEach, describe, expect, it } from "vitest";
import {
  clearVkMasterRoutingForTest,
  findVkMasterQuestion,
  getVkClientSession,
  rememberVkClientSession,
  rememberVkMasterQuestion,
} from "./src/master-routing.js";

describe("VK master reply routing", () => {
  beforeEach(() => {
    clearVkMasterRoutingForTest();
  });

  it("keeps two master questions bound to two independent client sessions", async () => {
    await rememberVkClientSession({
      accountId: "default",
      sessionKey: "agent:main:vk-openclaw-channel:default:direct:62517700",
      agentId: "main",
      clientPeerId: 62517700,
      clientTarget: "vk:62517700",
      updatedAt: Date.now(),
    });
    await rememberVkClientSession({
      accountId: "default",
      sessionKey: "agent:support:vk-openclaw-channel:default:direct:77777777",
      agentId: "support",
      clientPeerId: 77777777,
      clientTarget: "vk:77777777",
      updatedAt: Date.now(),
    });

    await rememberVkMasterQuestion({
      messageId: "101",
      accountId: "default",
      sessionKey: "agent:main:vk-openclaw-channel:default:direct:62517700",
      agentId: "main",
      clientPeerId: 62517700,
      clientTarget: "vk:62517700",
      createdAt: Date.now(),
    });
    await rememberVkMasterQuestion({
      messageId: "102",
      accountId: "default",
      sessionKey: "agent:support:vk-openclaw-channel:default:direct:77777777",
      agentId: "support",
      clientPeerId: 77777777,
      clientTarget: "vk:77777777",
      createdAt: Date.now(),
    });

    expect((await findVkMasterQuestion("101"))?.clientPeerId).toBe(62517700);
    expect((await findVkMasterQuestion("101"))?.sessionKey).toContain("62517700");
    expect((await findVkMasterQuestion("102"))?.clientPeerId).toBe(77777777);
    expect((await findVkMasterQuestion("102"))?.sessionKey).toContain("77777777");
  });

  it("persists the client session binding independently from the question", async () => {
    await rememberVkClientSession({
      accountId: "default",
      sessionKey: "agent:main:vk-openclaw-channel:default:direct:62517700",
      clientPeerId: 62517700,
      clientTarget: "vk:62517700",
      updatedAt: Date.now(),
    });

    expect((await getVkClientSession("agent:main:vk-openclaw-channel:default:direct:62517700"))?.clientTarget)
      .toBe("vk:62517700");
  });
});
