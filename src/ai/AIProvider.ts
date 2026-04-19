import type { MessageContent } from "../types";

export interface AIProvider {
  readonly type: string;
  readonly displayName: string;

  sendMessage(
    messages: Array<{ role: "user" | "assistant"; content: MessageContent }>,
    systemPrompt: string,
    options: { maxTokens: number; temperature: number },
    signal?: AbortSignal,
    onToken?: (chunk: string) => void
  ): Promise<string>;

  validateConfig(): Promise<boolean>;

  listModels(): Promise<string[]>;
}
