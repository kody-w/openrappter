import {
  decodeMeetingMedia,
  MAX_MEETING_IMAGE_BYTES,
  runBoundedMeetingRequest,
  truncateMeetingText,
} from "./teams-meeting-policy.mjs";

export class TeamsConversation {
  constructor({ runtime, identity, onState = () => {} }) {
    this.runtime = runtime;
    this.identity = identity;
    this.onState = onState;
    this.history = [];
    this.current = null;
    this.busy = false;
    this.closed = false;
  }

  async prepare() {
    const ready = await this.runtime.start();
    if (!ready.authenticated) {
      throw new Error("Sign in to the existing Frontier connection before enabling meeting replies.");
    }
    return { ready: true };
  }

  async respond({ text, source = "chat", author = "", frame = null, signal } = {}) {
    if (this.closed) throw new Error("The meeting conversation is closed.");
    if (this.busy) throw new Error("The meeting assistant is already answering.");
    if (typeof text !== "string" || !text.trim()) throw new Error("A meeting question is required.");
    signal?.throwIfAborted();
    const input = JSON.stringify({ source, author, text });
    const attachments = [];
    if (frame) {
      const image = decodeMeetingMedia(frame.jpegBase64, MAX_MEETING_IMAGE_BYTES, "Meeting frame");
      if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error("The meeting frame is not JPEG.");
      attachments.push({
        type: "blob",
        data: frame.jpegBase64,
        mimeType: "image/jpeg",
        displayName: "Current meeting view",
      });
    }
    this.busy = true;
    this.onState({ phase: "thinking" });
    try {
      const content = await runBoundedMeetingRequest(async (request) => {
        signal?.throwIfAborted();
        const session = await this.runtime.createSession({
          ...request.config,
          streaming: false,
          onPermissionRequest: () => ({
            kind: "reject",
            feedback: "Meeting participants cannot authorize device, file, shell, or network operations.",
          }),
        });
        const client = this.runtime.client;
        this.current = session;
        let failure;
        const abort = () => {
          if (typeof session.abort === "function") {
            void session.abort().catch((error) => {
              this.onState({ phase: "error", message: `Could not cancel the meeting turn: ${error.message}` });
            });
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) {
            abort();
            signal.throwIfAborted();
          }
          const response = await session.sendAndWait(request.message, 45000);
          signal?.throwIfAborted();
          if (this.closed) throw new Error("The meeting ended before its reply was ready.");
          if (typeof response?.data?.content !== "string" || !response.data.content.trim()) {
            throw new Error("The meeting assistant returned no reply.");
          }
          const reply = response.data.content.replace(/\s+/gu, " ").trim();
          if (reply === "[NO_REPLY]") return null;
          if (Buffer.byteLength(reply, "utf8") > 1600) {
            throw new Error("The meeting reply exceeded its conversational length limit.");
          }
          return reply;
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          this.current = null;
          try {
            await session.disconnect();
            if (client?.deleteSession && session.sessionId) {
              await client.deleteSession(session.sessionId);
            }
          } catch (error) {
            this.onState({ phase: "error", message: `Meeting-session cleanup failed: ${error.message}` });
            if (!failure) throw error;
          }
        }
      }, { identity: this.identity, history: this.history, input, attachments });
      this.onState({ phase: "ready" });
      return { text: content, input };
    } catch (error) {
      this.onState({ phase: "error", message: String(error.message || error) });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  commit(input, reply) {
    if (this.closed) return;
    this.history.push(
      { role: "user", content: truncateMeetingText(input, 16 * 1024) },
      { role: "assistant", content: truncateMeetingText(reply, 2048) },
    );
    this.history = this.history.slice(-12);
  }

  async close() {
    this.closed = true;
    this.history = [];
    if (this.current && typeof this.current.abort === "function") {
      await this.current.abort();
    }
  }
}
