import assert from "node:assert/strict";
import test from "node:test";

await import("../ui/chat-look.js");

const {
  cssForLook,
  grailFrameCss,
  normalizeChatLook,
  surgeonCss,
} = globalThis.RappChatLook;

test("Messages styles are scoped and never restore the kernel bounce", () => {
  for (const css of [grailFrameCss, surgeonCss]) {
    assert.match(css, /html\[data-rapp-look="messages"\]/);
    assert.doesNotMatch(css, /translateY/);
    assert.match(css, /animation-delay:\s*0s/);
    assert.match(css, /animation-delay:\s*\.2s/);
    assert.match(css, /animation-delay:\s*\.4s/);
    assert.match(css, /transform:\s*none !important/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
  }
});

test("Messages styles carry the specified bubbles, tails, composer, and pop", () => {
  assert.match(grailFrameCss, /#0A84FF/);
  assert.match(grailFrameCss, /#3A3A3C/);
  assert.match(grailFrameCss, /#007AFF/);
  assert.match(grailFrameCss, /#E9E9EB/);
  assert.match(grailFrameCss, /data-group-last/);
  assert.match(grailFrameCss, /border-radius:\s*18px/);
  assert.match(grailFrameCss, /#input/);
  assert.match(grailFrameCss, /#send::before/);
  assert.match(grailFrameCss, /data-rapp-arrived/);
  assert.match(grailFrameCss, /\.agent-logs-wrapper/);
  assert.match(surgeonCss, /\.surgeon-message/);
  assert.match(surgeonCss, /\.tw-msg/);
  assert.match(surgeonCss, /#surgeon-send::before/);
});

test("Messages pop never overrides the kernel stream reveal", () => {
  assert.match(
    grailFrameCss,
    /\.msg\[data-rapp-arrived\]:not\(\.stream-arriving\) \.bubble/,
  );
  assert.doesNotMatch(
    grailFrameCss,
    /\.msg\[data-rapp-arrived\] \.bubble/,
  );
});

test("Business resolves to no optional stylesheet data", () => {
  assert.equal(normalizeChatLook(), "messages");
  assert.equal(normalizeChatLook("MESSAGES"), "messages");
  assert.equal(normalizeChatLook("business"), "business");
  assert.equal(cssForLook("messages", grailFrameCss), grailFrameCss);
  assert.equal(cssForLook("business", grailFrameCss), "");
  assert.equal(cssForLook("business", surgeonCss), "");
});
