import { createMarkdownToVkPipeline } from "markdown-to-vk";
import type {
  VkMarkdownChunk,
  VkMarkdownPipelineOptions,
} from "markdown-to-vk";

export type {
  VkFormatData,
  VkFormattedMessage,
  VkFormatItem,
  VkFormatType,
} from "markdown-to-vk";

export type VkPreparedFormattedMessage = {
  text: string;
  formatData?: { version: 1; items: VkMarkdownChunk[number]["items"] };
};

export function renderVkMarkdownChunks(markdown: string, options: VkMarkdownPipelineOptions = {}): VkPreparedFormattedMessage[] {
  const pipeline = createMarkdownToVkPipeline(options);
  return pipeline.render(markdown ?? "").map((chunk) =>
    chunk.items.length > 0
      ? {
          text: chunk.text,
          formatData: { version: 1, items: chunk.items },
        }
      : { text: chunk.text },
  );
}
