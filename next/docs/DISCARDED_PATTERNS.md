# Discarded legacy patterns

These are deliberate product/architecture decisions, not missing compatibility.
The old code remains reference evidence until cutover is qualified.

| Discarded | Replacement |
|---|---|
| UI screens/forms define the product and require users to pre-organize it | Natural thought -> canonical context -> inferred complete plan -> material tradeoffs -> human review |
| Workspaces or internal agents appear as separate visible bots | One canonical root GUID, one Librarian, hidden recursive organs |
| Names, UUID tails, navigation IDs or duplicate aliases act as bot identity | Full mint-once canonical RAPPID |
| A second conversation/task/schedule database shadows canonical state | Existing RAPP/1 particles are sole durable product state |
| Renderer-owned orchestration, approvals or model/tool routing | Small headless core with a passive projection contract |
| One Python process/interpreter per bot or code-in-Egg auto-execution | One shared spine, independently scoped hotloads, verified target-owned boundary; unavailable means refused |
| Observation or “resume” restarts models and jobs | Read-only orientation/observation; no replay on restart |
| Implicit tool/profile discovery, shell fallback or provider substitution | Fixed Astra max/long, deny-all tool surface, explicit host bindings |
| Clear/delete erases a bot or its memory | Hide/unregister; restore exact GUID and history |
| Multiple setup flows fragment “make a world and do X every Monday” | One complete reviewed recurring intent; schedule stays internal |
| Arbitrary recurring instructions imply arbitrary execution | Declared bounded canonical-recap capability; unsupported work remains out of authority |
| Shared mutable peer memory, merged histories or hidden reasoning exchange | Bilaterally scoped, signed public requests and distinct perspective turns |
| Synthesis suppresses disagreement or implies consensus/actions | Preserve disagreements/unknowns; no consensus or action authority |
| Native Copilot/Claude/Hermes/Grokbot/Scout data is copied into a universal workspace shape | Provider-owned native locators and shape descriptors remain pointers |
| RAPP Global Estate is presented as live owner-verified inventory | Historical/derived reference map with honest uncertainty |
| A new app Egg format, mixed-frame filtering or pathname domain inference | Byte-identical canonical rooted data; adopted GODD/DOGG/both authority or refusal |
| Local relationships silently merge bot identities | Explicit exact-object consent plus existing signed Private Hive authority |
| iMessage is always on or infers recipients/permissions | Default-off transport, explicit local binding, canonical delivery/recap |
| A zero-frame checker pass or mocked UI screenshot counts as parity | Nonzero exact reference verification, real CLI processes, deterministic restart and bounded-effect tests |
| Relaxing the old release ban to declare the replacement shippable | Preserve legacy gates, qualify the new release boundary separately |
| A fixed UI drives the agent, or only one provider can publish the experience | Any authorized AI host publishes canonical work and bounded declarative projection intents through one portable skill |
| AI supplies HTML/JS/CSS, DOM selectors, coordinates or executable components | Closed enum/reference hints validated against authorized canonical state |
| Latest client silently wins focus/layout or mixes native memory | Explicit causal view heads, attributed public work, visible conflicts and separate resolution authority |
| Subscriber state, reconnect cache or skill text becomes authority | Disposable bounded event stream reconstructed from canonical frames; exact root capability remains mandatory |
| Root/Librarian/Global Estate becomes a copied central activity journal | Original scope-owned streams with reference-based aggregate projections |
| Recap queues or caller synthesis duplicate source/peer exhaust | Exact source references, transient recap text and distinct authored public perspectives |
| Comparing local sequence numbers or global array offsets across independent sources | Causally closed source-head vectors and unseen-occurrence replay |
| Retrofitting old centralized history by moving, splitting or relabeling frames | Byte-identical original history labeled `legacy-root-stream`; new successors use proper sources |

Prototype principles retained: bounded historical discovery, root GUID honesty,
canonical public transcript provenance, observer non-mutation, same-byte Egg
identity, and a tool-free injected Copilot adapter. Old UI state machines,
service layers, stores and provisional authority shortcuts were not adopted.
