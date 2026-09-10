import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMeetingRequest,
  decodeMeetingMedia,
  isMeetingNavigationAllowed,
  isTeamsPage,
  meetingMentionsIdentity,
  normalizeMeetingOptions,
  runBoundedMeetingRequest,
  splitMeetingSpeech,
  truncateMeetingText,
  validateTeamsMeetingUrl,
} from "../electron/teams-meeting-policy.mjs";

test("Teams invitations are constrained to the intended HTTPS meeting hosts", () => {
  assert.equal(validateTeamsMeetingUrl("https://teams.microsoft.com/meet/123?p=test"), "https://teams.microsoft.com/meet/123?p=test");
  assert.ok(validateTeamsMeetingUrl("https://teams.live.com/meet/123"));
  assert.ok(validateTeamsMeetingUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting/0?context=test"));
  for (const value of [
    "http://teams.microsoft.com/meet/123",
    "https://teams.microsoft.com.evil.test/meet/123",
    "https://user@teams.microsoft.com/meet/123",
    "https://teams.microsoft.com:8443/meet/123",
    "https://teams.microsoft.com/",
    "javascript:alert(1)",
  ]) assert.throws(() => validateTeamsMeetingUrl(value));
  assert.equal(isTeamsPage("https://teams.microsoft.com/v2/"), true);
  assert.equal(isTeamsPage("https://login.microsoftonline.com/"), false);
  assert.equal(isMeetingNavigationAllowed("https://login.microsoftonline.com/"), true);
  assert.equal(isMeetingNavigationAllowed("file:///private/file"), false);
});

test("meeting settings default to silent synthetic output and reject malformed values", () => {
  assert.equal(normalizeMeetingOptions().speak, false);
  assert.equal(normalizeMeetingOptions({ identity: "r1" }).identity, "r1");
  assert.throws(() => normalizeMeetingOptions({ speak: "true" }));
  assert.throws(() => normalizeMeetingOptions({ identity: "r1 (AI)" }));
  assert.throws(() => normalizeMeetingOptions({ shell: "anything" }));
  assert.equal(meetingMentionsIdentity("R1 can you help?", "r1"), true);
  assert.equal(meetingMentionsIdentity("r11 can you help?", "r1"), false);
});

test("binary media cannot exceed its budget or exploit permissive base64 decoding", () => {
  assert.deepEqual(decodeMeetingMedia("aGVsbG8=", 5, "audio"), Buffer.from("hello"));
  assert.throws(() => decodeMeetingMedia("aGVs bG8=", 10, "audio"));
  assert.throws(() => decodeMeetingMedia("aGVsbG8=", 4, "audio"));
  assert.throws(() => decodeMeetingMedia("!!!!", 10, "audio"));
});

test("spoken replies preserve every word while fitting local synthesis limits", () => {
  const text = "A useful answer can contain multiple sentences. ".repeat(12).trim();
  const chunks = splitMeetingSpeech(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 120 && Buffer.byteLength(chunk) <= 480));
  assert.throws(() => splitMeetingSpeech("x".repeat(121)), /word is too long/);
  assert.throws(() => splitMeetingSpeech(""), /nonempty/);
});

test("a request larger than five megabytes fits after dropping complete oldest turns", () => {
  const request = buildMeetingRequest({
    identity: "r1",
    history: [
      { role: "user", content: "old".repeat(2_000_000) },
      { role: "assistant", content: "old answer" },
    ],
    input: "The newest question survives.",
  });
  assert.ok(request.bytes <= 256 * 1024);
  const body = JSON.parse(request.message.prompt);
  assert.deepEqual(body.conversation, [{ role: "user", content: "The newest question survives." }]);
  assert.deepEqual(request.config.availableTools, []);
  assert.deepEqual(request.config.tools, []);
  assert.equal(request.config.enableConfigDiscovery, false);
});

test("Unicode truncation preserves valid UTF-8 and both ends of the newest turn", () => {
  const text = "START" + "\u{1f9e0}".repeat(100_000) + "END";
  const clipped = truncateMeetingText(text, 1024);
  assert.ok(Buffer.byteLength(clipped) <= 1024);
  assert.ok(clipped.startsWith("START"));
  assert.ok(clipped.endsWith("END"));
  assert.equal(clipped.includes("\ufffd"), false);
  const request = buildMeetingRequest({ input: text, budgetBytes: 64 * 1024 });
  const newest = JSON.parse(request.message.prompt).conversation.at(-1);
  assert.equal(newest.role, "user");
  assert.ok(newest.content.startsWith("START"));
  assert.ok(newest.content.endsWith("END"));
  assert.ok(request.bytes <= 64 * 1024);
});

test("orphaned tool evidence and incomplete turns are rejected instead of mis-associated", () => {
  assert.throws(() => buildMeetingRequest({
    input: "new",
    history: [{ role: "user", content: "unfinished" }],
  }));
  assert.throws(() => buildMeetingRequest({
    input: "new",
    history: [
      { role: "assistant", content: "", tool_calls: [{ id: "tool-1" }] },
      { role: "tool", content: "result", tool_call_id: "tool-1" },
    ],
  }));
});

test("repeated size failures produce strictly smaller requests and continue the same task", async () => {
  const sizes = [];
  const result = await runBoundedMeetingRequest(async (request) => {
    sizes.push(request.bytes);
    const newest = JSON.parse(request.message.prompt).conversation.at(-1).content;
    assert.ok(newest.startsWith("START"));
    assert.ok(newest.endsWith("END"));
    if (sizes.length < 3) throw Object.assign(new Error("Payload too large"), { status: 413 });
    return "original task continued";
  }, { identity: "r1", input: "START" + "detail ".repeat(800_000) + "END" });
  assert.equal(result, "original task continued");
  assert.equal(sizes.length, 3);
  assert.ok(sizes[1] < sizes[0]);
  assert.ok(sizes[2] < sizes[1]);
});

test("oversized visual context is omitted whole with an explicit marker, never corrupted", () => {
  const request = buildMeetingRequest({
    input: "Describe the available context.",
    attachments: [{ type: "blob", data: "a".repeat(400_000), mimeType: "image/jpeg" }],
    budgetBytes: 64 * 1024,
  });
  assert.equal(request.imageOmitted, true);
  assert.equal(request.message.attachments, undefined);
  assert.equal(JSON.parse(request.message.prompt).visualContextOmittedForSize, true);
});
