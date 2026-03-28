# Why AI Messaging Needs Three Layers of Privacy (Not Just Encryption)

*Kody Wildfeuer — March 28, 2026*

Everyone talks about end-to-end encryption like it's the finish line. It's not. It's the starting line.

When AI agents start messaging each other — and messaging you — on your behalf, encryption alone isn't enough. Here's why, and what we're building instead.

## The Problem With Encryption Alone

Signal is brilliant. The Signal Protocol is the gold standard for human-to-human encrypted messaging. But it was designed for a world where:

1. Messages are routed through centralized servers
2. Only humans send messages
3. The encrypted payload contains everything — including your name, email, phone number

If the encryption breaks — and cryptographic assumptions do evolve — everything is exposed. Your PII, your conversations, your identity. All of it.

Now add AI agents to the mix. Agents that message on your behalf. Agents that talk to each other. Agents running on edge devices, syncing over whatever network is available. The threat model changes completely.

## Three Layers, Not One

We've been working on a messaging architecture at OpenRappter that treats privacy as a stack, not a single layer:

**Layer 1: PII Stripping (Before Encryption)**

Before a message is encrypted, we strip personally identifiable information. Emails, phone numbers, names, addresses — they're replaced with tokens. The mapping between tokens and real values lives exclusively on your device. It never touches a server. It never enters the encrypted payload.

This means even if someone breaks the encryption 10 years from now, they get a conversation between `[P:1]` and `[P:2]` discussing `[P:3]`. Useless without the local vault.

**Layer 2: Per-Conversation AES-256-GCM Encryption**

Each conversation gets its own symmetric key. Messages are encrypted with AES-256-GCM — authenticated encryption that prevents both reading and tampering. Only people (or agents) with the key can read the messages.

But the messages they read are already PII-stripped. The encryption protects the conversation content. The PII stripping protects identity.

**Layer 3: HMAC-SHA256 Signing**

Every message is signed with the conversation key. This serves two purposes:
- **Tamper detection**: If anyone modifies a message in transit or at rest, the signature breaks
- **Authenticity**: Only someone with the key could have produced the signature

We also sign the entire message chain, so you can detect if messages were deleted or reordered.

## Why Static Files Beat Servers

Here's where it gets interesting. Most encrypted messaging systems need servers — for routing, for storing messages, for managing keys. We don't.

Our encrypted, PII-stripped, signed message blobs are just JSON files. You can host them on GitHub Pages. On S3. On a USB drive. On any static file host in the world.

Any device with HTTP access and the conversation key can:
1. Fetch the latest messages
2. Verify the signatures
3. Decrypt the content
4. Reattach PII from the local vault (if it has one)

No WebSocket servers. No message brokers. No federation protocol. Just files.

This is what we call **edge-universal messaging**. It works on a phone, a laptop, an embedded device, or an AI agent running in the cloud. The only requirement is HTTP GET and a 32-byte key.

## AI Agents as First-Class Citizens

In our system, AI agents aren't bolted on. They're participants. Each agent has:
- Its own persona (name, personality, conversation style)
- Its own conversation memory (separate from other agents in the same channel)
- Its own PII boundary (the agent sees tokenized content, not raw PII)

When Rex the dinosaur AI and Nova the stargazer AI have a conversation in an encrypted channel, they're operating on PII-stripped content. They never see your real name or email. They work with tokens. The full context only exists on your local device.

## The Paper Trail Problem

One thing that keeps me up at night: when AI agents communicate, who owns the audit trail? Where does it live? Who controls it?

Our answer: you do. The encrypted static files are the audit trail. They're portable, verifiable (via HMAC), and owned by whoever holds the key. No platform can lock you out of your own conversation history.

## What's Next

We're calling this system **RappterSignal**. It's built into OpenRappter and it works today — with optional iMessage sync on macOS as a delivery layer (not a dependency).

The protocol is open. The implementation is open source. The architecture is documented.

If you're building AI agents that communicate, think about what happens when those conversations contain PII. Think about what happens when encryption alone isn't enough. Think about what happens when you need messaging to work at the edge, without servers, without platforms, without trust.

That's what we built.

---

*Kody Wildfeuer is the founder of Wildhaven and creator of OpenRappter, an open-source AI agent framework. Follow the project at [github.com/kody-w/openrappter](https://github.com/kody-w/openrappter).*
