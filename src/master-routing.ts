import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type VkMasterQuestionBinding = {
  messageId: string;
  accountId: string;
  sessionKey: string;
  agentId?: string;
  clientPeerId: number;
  clientTarget: string;
  createdAt: number;
};

type PersistedState = {
  version: 1;
  clients: Record<string, VkClientSessionBinding>;
  questions: Record<string, VkMasterQuestionBinding>;
};

export type VkClientSessionBinding = {
  accountId: string;
  sessionKey: string;
  agentId?: string;
  clientPeerId: number;
  clientTarget: string;
  updatedAt: number;
};

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const clients = new Map<string, VkClientSessionBinding>();
const questions = new Map<string, VkMasterQuestionBinding>();
let loaded = false;
let loadPromise: Promise<void> | undefined;
let writePromise: Promise<void> = Promise.resolve();

function stateFilePath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
  return join(stateDir, "state", "vk-openclaw-channel", "master-routing.json");
}

function prune(now = Date.now()): void {
  for (const [key, value] of clients) {
    if (now - value.updatedAt > RETENTION_MS) clients.delete(key);
  }
  for (const [key, value] of questions) {
    if (now - value.createdAt > RETENTION_MS) questions.delete(key);
  }
}

async function persist(): Promise<void> {
  prune();
  const snapshot: PersistedState = {
    version: 1,
    clients: Object.fromEntries(clients),
    questions: Object.fromEntries(questions),
  };
  const path = stateFilePath();
  const temp = `${path}.tmp-${process.pid}`;
  writePromise = writePromise.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, JSON.stringify(snapshot), "utf8");
    await rename(temp, path);
  }).catch(() => undefined);
  await writePromise;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loadPromise ??= (async () => {
    try {
      const raw = await readFile(stateFilePath(), "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed?.version === 1) {
        for (const [key, value] of Object.entries(parsed.clients ?? {})) {
          if (value && Number.isSafeInteger(value.clientPeerId) && value.clientPeerId > 0) {
            clients.set(key, value);
          }
        }
        for (const [key, value] of Object.entries(parsed.questions ?? {})) {
          if (
            value &&
            typeof value.messageId === "string" &&
            typeof value.sessionKey === "string" &&
            Number.isSafeInteger(value.clientPeerId) &&
            value.clientPeerId > 0
          ) {
            questions.set(key, value);
          }
        }
        prune();
      }
    } catch {
      // Missing/corrupt local correlation state must not prevent the VK channel
      // from starting. New client turns will rebuild it.
    }
    loaded = true;
  })();
  await loadPromise;
}

export async function rememberVkClientSession(binding: VkClientSessionBinding): Promise<void> {
  if (!binding.sessionKey || !Number.isSafeInteger(binding.clientPeerId) || binding.clientPeerId <= 0) return;
  await ensureLoaded();
  clients.set(binding.sessionKey, binding);
  await persist();
}

export async function rememberVkMasterQuestion(binding: VkMasterQuestionBinding): Promise<void> {
  if (!binding.messageId || !binding.sessionKey || !Number.isSafeInteger(binding.clientPeerId) || binding.clientPeerId <= 0) {
    return;
  }
  await ensureLoaded();
  questions.set(binding.messageId, binding);
  await persist();
}

export async function findVkMasterQuestion(messageId: string): Promise<VkMasterQuestionBinding | undefined> {
  const id = messageId.trim();
  if (!id) return undefined;
  await ensureLoaded();
  prune();
  return questions.get(id);
}

export async function consumeVkMasterQuestion(messageId: string): Promise<VkMasterQuestionBinding | undefined> {
  const id = messageId.trim();
  if (!id) return undefined;
  await ensureLoaded();
  const binding = questions.get(id);
  if (!binding) return undefined;
  questions.delete(id);
  await persist();
  return binding;
}

export function clearVkMasterRoutingForTest(): void {
  clients.clear();
  questions.clear();
  loaded = true;
  loadPromise = undefined;
  writePromise = Promise.resolve();
}

export async function getVkClientSession(sessionKey: string): Promise<VkClientSessionBinding | undefined> {
  await ensureLoaded();
  return clients.get(sessionKey);
}
