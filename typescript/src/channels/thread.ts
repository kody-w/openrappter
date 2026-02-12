export interface ThreadContext {
  threadId: string;
  parentMessageId?: string;
  channelId: string;
  title?: string;
}
