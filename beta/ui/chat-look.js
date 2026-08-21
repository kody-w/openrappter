(function registerChatLook(root) {
  const grailFrameCss = `
html[data-rapp-look="messages"] #chat {
  gap: 3px;
  padding: 20px;
}
html[data-rapp-look="messages"] .msg {
  max-width: min(82%, 760px);
  gap: 0;
}
html[data-rapp-look="messages"] .msg[data-group-last] {
  margin-bottom: 8px;
}
html[data-rapp-look="messages"] .msg .avatar {
  display: none !important;
}
html[data-rapp-look="messages"] .msg .bubble {
  position: relative;
  max-width: 100%;
  padding: 9px 13px;
  border: 0;
  border-radius: 18px;
  box-shadow: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.35;
}
html[data-rapp-look="messages"] .msg .bubble::after {
  content: none;
}
html[data-rapp-look="messages"] .msg.user .bubble {
  border-radius: 18px;
  background: #0A84FF;
  color: #fff;
}
html[data-rapp-look="messages"] .msg.assistant .bubble {
  border-radius: 18px;
  background: #3A3A3C;
  color: #f2f2f7;
}
html[data-rapp-look="messages"] .msg.assistant .bubble strong,
html[data-rapp-look="messages"] .msg.assistant .bubble h1,
html[data-rapp-look="messages"] .msg.assistant .bubble h2,
html[data-rapp-look="messages"] .msg.assistant .bubble h3 {
  color: inherit;
}
html[data-rapp-look="messages"] .msg.user[data-group-last] .bubble::after {
  position: absolute;
  right: -7px;
  bottom: 0;
  width: 14px;
  height: 14px;
  content: "";
  background: inherit;
  clip-path: polygon(0 0, 0 100%, 100% 100%);
}
html[data-rapp-look="messages"] .msg.assistant[data-group-last] .bubble::after {
  position: absolute;
  bottom: 0;
  left: -7px;
  width: 14px;
  height: 14px;
  content: "";
  background: inherit;
  clip-path: polygon(100% 0, 0 100%, 100% 100%);
}
html[data-rapp-look="messages"] .typing-indicator .bubble {
  min-width: 58px;
  padding: 10px 13px;
}
html[data-rapp-look="messages"] .typing-indicator .typing {
  display: flex;
  align-items: center;
  gap: 4px;
}
html[data-rapp-look="messages"] .typing-indicator .typing span {
  width: 8px;
  height: 8px;
  margin: 0;
  border-radius: 50%;
  background: #aeb2b8;
  opacity: .35;
  animation: rapp-messages-dot 1.2s infinite;
  animation-delay: 0s;
  transform: none !important;
}
html[data-rapp-look="messages"] .typing-indicator .typing span:nth-child(2) {
  animation-delay: .2s;
}
html[data-rapp-look="messages"] .typing-indicator .typing span:nth-child(3) {
  animation-delay: .4s;
}
html[data-rapp-look="messages"] .msg[data-rapp-arrived]:not(.stream-arriving) .bubble {
  animation: rapp-messages-pop .16s ease-out both;
  transform-origin: 50% 100%;
}
html[data-rapp-look="messages"] #input {
  min-height: 40px;
  border-radius: 999px;
  padding: 9px 16px;
}
html[data-rapp-look="messages"] #send {
  width: 40px;
  min-width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
  background: #0A84FF;
  font-size: 0;
}
html[data-rapp-look="messages"] #send::before {
  content: "\\2191";
  font-size: 25px;
  font-weight: 700;
  line-height: 1;
}
html[data-rapp-look="messages"] .agent-logs-wrapper {
  border-color: rgba(255, 255, 255, .16);
  border-radius: 12px;
}
html[data-rapp-look="messages"] .agent-logs-wrapper .logs-label {
  background: rgba(0, 0, 0, .16);
  color: #c7c7cc;
  text-transform: none;
  letter-spacing: 0;
}
html[data-rapp-look="messages"] body.light-mode .msg.user .bubble {
  background: #007AFF;
  color: #fff;
}
html[data-rapp-look="messages"] body.light-mode .msg.assistant .bubble {
  border: 0;
  background: #E9E9EB;
  color: #000;
}
html[data-rapp-look="messages"] body.light-mode #send {
  background: #007AFF;
}
html[data-rapp-look="messages"] body.light-mode .agent-logs-wrapper {
  border-color: rgba(0, 0, 0, .12);
}
html[data-rapp-look="messages"] body.light-mode .agent-logs-wrapper .logs-label {
  background: rgba(0, 0, 0, .04);
  color: #636366;
}
@keyframes rapp-messages-dot {
  0%, 60%, 100% { opacity: .35; }
  30% { opacity: 1; }
}
@keyframes rapp-messages-pop {
  from { opacity: .72; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  html[data-rapp-look="messages"] .typing-indicator .typing span,
  html[data-rapp-look="messages"] .msg[data-rapp-arrived]:not(.stream-arriving) .bubble {
    animation: none !important;
    opacity: 1;
    transform: none !important;
  }
}
`;

  const surgeonCss = `
html[data-rapp-look="messages"] .surgeon-session,
html[data-rapp-look="messages"] .twin-chat {
  gap: 3px;
}
html[data-rapp-look="messages"] .surgeon-message,
html[data-rapp-look="messages"] .tw-msg:not(.activity) {
  position: relative;
  max-width: 82%;
  padding: 9px 13px;
  border: 0;
  border-radius: 18px;
  box-shadow: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 15px;
  line-height: 1.35;
}
html[data-rapp-look="messages"] .tw-msg:not(.activity) {
  max-width: 100%;
  font-size: 13px;
}
html[data-rapp-look="messages"] .surgeon-message::after,
html[data-rapp-look="messages"] .tw-msg:not(.activity)::after {
  content: none;
}
html[data-rapp-look="messages"] .surgeon-message.user,
html[data-rapp-look="messages"] .tw-msg.user {
  border-radius: 18px;
  background: #0A84FF;
  color: #fff;
}
html[data-rapp-look="messages"] .surgeon-message.assistant,
html[data-rapp-look="messages"] .tw-msg.assistant,
html[data-rapp-look="messages"] .tw-msg.driver {
  border: 0;
  border-radius: 18px;
  background: #3A3A3C;
  color: #f2f2f7;
}
html[data-rapp-look="messages"] .surgeon-message[data-group-last],
html[data-rapp-look="messages"] .tw-turn[data-group-last] {
  margin-bottom: 8px;
}
html[data-rapp-look="messages"] .surgeon-message.user[data-group-last]::after,
html[data-rapp-look="messages"] .tw-turn.self[data-group-last] .tw-msg::after {
  position: absolute;
  right: -7px;
  bottom: 0;
  width: 14px;
  height: 14px;
  content: "";
  background: inherit;
  clip-path: polygon(0 0, 0 100%, 100% 100%);
}
html[data-rapp-look="messages"] .surgeon-message.assistant[data-group-last]::after,
html[data-rapp-look="messages"] .tw-turn:not(.self)[data-group-last] .tw-msg::after {
  position: absolute;
  bottom: 0;
  left: -7px;
  width: 14px;
  height: 14px;
  content: "";
  background: inherit;
  clip-path: polygon(100% 0, 0 100%, 100% 100%);
}
html[data-rapp-look="messages"] .surgeon-message.assistant.typing {
  min-width: 58px;
  min-height: 36px;
  padding: 10px 13px;
}
html[data-rapp-look="messages"] .surgeon-message.typing .surgeon-dots {
  display: flex;
  align-items: center;
  gap: 4px;
}
html[data-rapp-look="messages"] .surgeon-message.typing .surgeon-dots span {
  width: 8px;
  height: 8px;
  margin: 0;
  background: #aeb2b8;
  opacity: .35;
  animation: rapp-surgeon-messages-dot 1.2s infinite;
  animation-delay: 0s;
  transform: none !important;
}
html[data-rapp-look="messages"] .surgeon-message.typing .surgeon-dots span:nth-child(2) {
  animation-delay: .2s;
}
html[data-rapp-look="messages"] .surgeon-message.typing .surgeon-dots span:nth-child(3) {
  animation-delay: .4s;
}
html[data-rapp-look="messages"] .surgeon-message[data-rapp-arrived],
html[data-rapp-look="messages"] .tw-turn[data-rapp-arrived] .tw-msg {
  animation: rapp-surgeon-messages-pop .16s ease-out both;
  transform-origin: 50% 100%;
}
html[data-rapp-look="messages"] .surgeon-box,
html[data-rapp-look="messages"] .herd-tile .hcomp textarea,
html[data-rapp-look="messages"] .herd-tile.twin .twin-comp textarea {
  border-radius: 999px;
}
html[data-rapp-look="messages"] #surgeon-send,
html[data-rapp-look="messages"] .herd-tile .hcomp button,
html[data-rapp-look="messages"] .herd-tile.twin .twin-comp .tw-send {
  width: 40px;
  min-width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
  background: #0A84FF;
  font-size: 0;
}
html[data-rapp-look="messages"] #surgeon-send::before,
html[data-rapp-look="messages"] .herd-tile .hcomp button::before,
html[data-rapp-look="messages"] .herd-tile.twin .twin-comp .tw-send::before {
  content: "\\2191";
  font-size: 25px;
  font-weight: 700;
  line-height: 1;
}
@keyframes rapp-surgeon-messages-dot {
  0%, 60%, 100% { opacity: .35; }
  30% { opacity: 1; }
}
@keyframes rapp-surgeon-messages-pop {
  from { opacity: .72; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  html[data-rapp-look="messages"] .surgeon-message.typing .surgeon-dots span,
  html[data-rapp-look="messages"] .surgeon-message[data-rapp-arrived],
  html[data-rapp-look="messages"] .tw-turn[data-rapp-arrived] .tw-msg {
    animation: none !important;
    opacity: 1;
    transform: none !important;
  }
}
`;

  function normalizeChatLook(value) {
    return String(value || "").toLowerCase() === "business"
      ? "business"
      : "messages";
  }

  function cssForLook(look, css) {
    return normalizeChatLook(look) === "messages" ? String(css || "") : "";
  }

  function applyLookStyles(document, look, css, styleId) {
    const normalized = normalizeChatLook(look);
    let style = document.getElementById(styleId);
    if (normalized === "business") {
      style?.remove();
      document.documentElement.removeAttribute("data-rapp-look");
      return normalized;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    style.textContent = String(css || "");
    document.documentElement.setAttribute("data-rapp-look", "messages");
    return normalized;
  }

  function inferMessageSide(element) {
    if (element?.classList?.contains("user")
        || element?.classList?.contains("self")) {
      return "user";
    }
    if (element?.classList?.contains("assistant")
        || element?.classList?.contains("driver")
        || element?.classList?.contains("typing-indicator")) {
      return "assistant";
    }
    return null;
  }

  function markGroupLast(elements, sideOf = inferMessageSide) {
    const messages = Array.from(elements || []);
    for (const message of messages) {
      message.removeAttribute("data-group-last");
      message.classList?.remove("rapp-group-last");
    }
    for (let index = 0; index < messages.length; index += 1) {
      const side = sideOf(messages[index]);
      const nextSide = sideOf(messages[index + 1]);
      if (side && side !== nextSide) {
        messages[index].setAttribute("data-group-last", "");
        messages[index].classList?.add("rapp-group-last");
      }
    }
    return messages;
  }

  function markArrived(element, arrived = true) {
    if (!element) return element;
    if (arrived) {
      element.setAttribute("data-rapp-arrived", "");
      element.classList?.add("rapp-message-arrived");
    } else {
      element.removeAttribute("data-rapp-arrived");
      element.classList?.remove("rapp-message-arrived");
    }
    return element;
  }

  root.RappChatLook = Object.freeze({
    applyLookStyles,
    cssForLook,
    grailFrameCss,
    inferMessageSide,
    markArrived,
    markGroupLast,
    normalizeChatLook,
    surgeonCss,
  });
})(globalThis);
