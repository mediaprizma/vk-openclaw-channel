import type { VkProbe } from "./types.js";

/**
 * Probe a VK community bot by calling groups.getById with the provided token.
 * Returns group info if successful.
 */
export async function probeVkBot(token: string, timeoutMs?: number): Promise<VkProbe> {
  if (!token.trim()) {
    return { ok: false, error: "No token provided" };
  }

  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const response = await fetch(
      `https://api.vk.com/method/groups.getById?v=5.199&access_token=${encodeURIComponent(token)}`,
      { signal: controller.signal },
    );
    const data = (await response.json()) as {
      response?: { groups?: Array<{ id: number; name: string; screen_name: string }> };
      error?: { error_msg: string };
    };

    if (data.error) {
      return { ok: false, error: data.error.error_msg };
    }

    const group = data.response?.groups?.[0];
    if (!group) {
      return { ok: false, error: "No group found for this token" };
    }

    return {
      ok: true,
      groupId: group.id,
      groupName: group.name,
      screenName: group.screen_name,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
