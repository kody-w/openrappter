// Show Mode — click-through preview for OpenRappter.
//
// A guided spotlight tour overlaid on the live three-pane window. It is a
// PREVIEW: nothing here records, analyzes, hotloads, or sends anything. Each
// step paints "ghost" content over the Explorer, the center Brainstem, and the
// Rappter Surgeon so a presenter can walk a customer through what Show Mode will
// do — record live or import a video / screenshots / transcript, approve the
// reconstructed steps, hotload the generated agent, test it in the real chat,
// confirm, and promote into the Microsoft AI stack. Exit the tour and nothing
// about the page differs from stock.
//
// Entry points: the "Show Mode: click-through preview" Rappter Surgeon pill,
// the intro tile button, `window.rappShowModeTour.start()`, the
// `rapp-beta:show-mode-tour` window event, or `?tour=show-mode` / `#show-mode-tour`.
//
// The same file drives beta/show-mode.html (a static replica of the shell) so
// the click-through can be shared as a GitHub Pages link.
(function () {
  "use strict";
  if (window.rappShowModeTour) return;

  const NOTES_KEY = "rapp-brainstem-beta-show-mode-notes";
  const AGENT_FILE = "show_campaign_makegood_agent.py";
  const AGENT_TOOL = "ShowCampaignMakegood";

  // ── styles ────────────────────────────────────────────────────────────
  const css = `
    #smt-hole { position: fixed; z-index: 9990; pointer-events: none; border-radius: 10px;
      box-shadow: 0 0 0 100vmax rgba(1,4,9,.66); transition: all .25s ease; }
    #smt-hole.off { display: none; }
    #smt-ring { position: fixed; z-index: 9991; pointer-events: none; border-radius: 10px;
      border: 1px solid #58a6ff; box-shadow: 0 0 0 3px rgba(88,166,255,.22); transition: all .25s ease; }
    #smt-ring.off { display: none; }
    #smt-shade { position: fixed; z-index: 9989; inset: 0; background: rgba(1,4,9,.66); }
    #smt-shade.off { display: none; }
    .smt-ghost { position: fixed; z-index: 9992; pointer-events: none; overflow: hidden;
      display: flex; flex-direction: column; gap: 10px; padding: 14px 14px 18px;
      font: 13px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #e6edf3; }
    .smt-ghost.smt-explorer { padding: 8px 6px 12px; gap: 4px; }
    .smt-ghost.smt-surgeon { padding: 14px; justify-content: flex-end; }
    .smt-ghost.smt-center { padding: 18px clamp(14px, 6%, 80px) 22px; justify-content: flex-end; }
    .smt-ghost .smt-msg { max-width: 92%; padding: 10px 13px; border-radius: 12px; border: 1px solid #2a2d33;
      background: #1a1c21; color: #d7dae0; white-space: normal; animation: smt-in .35s ease both; }
    .smt-ghost .smt-msg.user { align-self: flex-end; background: #14284a; border-color: #1f4b8f; color: #e8f0ff; }
    .smt-ghost .smt-msg.tool { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #8b949e; background: #0d1117; border-color: #21262d; }
    .smt-ghost .smt-msg.tile { border-color: #30363d; background: #161b22; }
    .smt-ghost .smt-msg.tile b { color: #f0f6fc; }
    .smt-ghost .smt-msg.link { border-color: #8957e5; background: linear-gradient(135deg,#25163f,#10263f); color: #f0e7ff; }
    .smt-ghost .smt-msg.evidence { border-color: #1f6feb; background: #071d36; color: #dbeafe; }
    .smt-ghost .smt-msg .smt-mono { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #9ea7b3; }
    .smt-ghost .smt-msg .smt-mono.blue { color: #79c0ff; }
    .smt-ghost .smt-msg.code { font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: #0d1117; border-color: #30363d; color: #c9d1d9; max-width: 100%; white-space: pre-wrap; }
    .smt-ghost .smt-msg.code .k { color: #ff7b72; } .smt-ghost .smt-msg.code .s { color: #a5d6ff; }
    .smt-ghost .smt-msg.code .c { color: #8b949e; }
    .smt-ghost .smt-steps { margin: 6px 0 0; padding-left: 20px; }
    .smt-ghost .smt-steps li { margin: 3px 0; }
    .smt-ghost .smt-steps li em { color: #8b949e; font-style: normal; }
    .smt-ghost .smt-steps li.changed { color: #f0f6fc; background: rgba(88,166,255,.12); border-radius: 4px; padding: 1px 4px; margin-left: -4px; }
    .smt-ghost .smt-pill-list { display: flex; flex-direction: column; gap: 7px; }
    .smt-ghost .smt-pill { padding: 9px 12px; border: 1px solid #2a2d33; border-radius: 10px; background: #1a1c21; color: #d7dae0; font-size: 12px; }
    .smt-ghost .smt-pill.show { border-color: #d0463a; background: linear-gradient(135deg,#3a1614,#26191f); color: #ffe9e6; font-weight: 800; box-shadow: inset 3px 0 #ff6a5c; }
    .smt-ghost .smt-pill.show::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #ff5f52; margin-right: 8px; box-shadow: 0 0 0 3px rgba(255,95,82,.25); vertical-align: 1px; }
    .smt-ghost .smt-doors { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .smt-ghost .smt-door { border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; background: #0d1117; font-size: 12px; }
    .smt-ghost .smt-door b { display: block; color: #79c0ff; margin-bottom: 2px; }
    .smt-ghost .smt-door.on { border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88,166,255,.2); }
    .smt-ghost .smt-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; color: #c9d1d9; }
    .smt-ghost .smt-row.dim { color: #6e7681; }
    .smt-ghost .smt-row.hot { background: rgba(88,166,255,.14); color: #f0f6fc; outline: 1px solid rgba(88,166,255,.5); }
    .smt-ghost .smt-row .smt-scope { margin-left: auto; font: 10px/1 ui-monospace, Menlo, monospace; padding: 3px 6px; border-radius: 4px; background: #21262d; color: #8b949e; }
    .smt-ghost .smt-row.hot .smt-scope { background: #1f6feb; color: #fff; }
    .smt-ghost .smt-row .smt-scope.eph { background: #3d2a05; color: #e3b341; }
    .smt-ghost .smt-row .smt-scope.stack { background: #0f3d2a; color: #56d364; }
    .smt-ghost .smt-heading { font-size: 10.5px; letter-spacing: .12em; text-transform: uppercase; color: #8b949e; margin: 10px 10px 4px; }
    .smt-ghost table { border-collapse: collapse; width: 100%; margin: 6px 0; font-size: 12px; }
    .smt-ghost th, .smt-ghost td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; }
    .smt-ghost th { color: #8b949e; font-weight: 600; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; }
    .smt-ghost td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .smt-ghost td.bad { color: #ff7b72; font-weight: 700; } .smt-ghost td.ok { color: #56d364; }
    .smt-ghost .smt-thumb { display: inline-block; width: 92px; height: 58px; border-radius: 6px; margin: 6px 8px 0 0; vertical-align: top;
      background: linear-gradient(135deg,#0d1117 0 30%,#161b22 30% 70%,#0d1117 70%); border: 1px solid #30363d; }
    .smt-ghost .smt-thumb.center { background: linear-gradient(90deg,#161b22 0 28%,#0d1117 28% 72%,#161b22 72%); }
    #smt-tile { position: fixed; z-index: 9995; width: min(430px, calc(100vw - 32px));
      background: #161b22; border: 1px solid #30363d; border-radius: 12px; color: #e6edf3;
      box-shadow: 0 8px 30px rgba(1,4,9,.7); font: 14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      transition: top .25s ease, left .25s ease; }
    #smt-tile .smt-bar { height: 3px; margin: 12px 18px 0; background: #21262d; border-radius: 3px; overflow: hidden; }
    #smt-tile .smt-bar > div { height: 100%; background: linear-gradient(90deg,#ff5f52,#1f6feb); transition: width .3s ease; }
    #smt-tile .smt-head { display: flex; align-items: center; gap: 10px; padding: 8px 18px 0; font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .12em; }
    #smt-tile .smt-head .smt-rec { width: 8px; height: 8px; border-radius: 50%; background: #ff5f52; box-shadow: 0 0 0 3px rgba(255,95,82,.25); animation: smt-blink 2.2s ease-in-out infinite; }
    #smt-tile .smt-head .smt-x { margin-left: auto; background: none; border: 0; color: #8b949e; cursor: pointer; font-size: 14px; padding: 0 2px; }
    #smt-tile .smt-head .smt-x:hover { color: #e6edf3; }
    #smt-tile .smt-body { padding: 2px 18px 6px; }
    #smt-tile .smt-body h3 { margin: 8px 0 6px; font-size: 18px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
    #smt-tile .smt-body p { margin: 0 0 8px; color: #9ea7b3; font-size: 13.5px; }
    #smt-tile .smt-body p b { color: #e6edf3; font-weight: 600; }
    #smt-tile .smt-body ol { margin: 4px 0 8px; padding-left: 20px; color: #c9d1d9; font-size: 13.5px; }
    #smt-tile .smt-body ol li { margin: 2px 0; }
    #smt-tile .smt-body .smt-quote { margin: 8px 0; padding: 2px 0 2px 12px; border-left: 3px solid #30363d; font-size: 12.5px; font-style: italic; color: #8b949e; }
    #smt-tile .smt-body .smt-punch { color: #e6edf3; font-weight: 600; font-size: 13.5px; }
    #smt-tile .smt-notes { margin: 4px 16px; padding: 8px 12px; border-radius: 8px; background: #0d1117; border: 1px solid #21262d; color: #e3b341; font-size: 12.5px; line-height: 1.5; }
    #smt-tile .smt-notes b { color: #f0f6fc; font-weight: 600; }
    #smt-tile .smt-notes.off { display: none; }
    #smt-tile .smt-foot { display: flex; align-items: center; gap: 10px; padding: 8px 16px 14px; }
    #smt-tile .smt-foot .smt-ghostbtn { background: none; border: 0; color: #8b949e; cursor: pointer; font-size: 12.5px; padding: 4px 0; }
    #smt-tile .smt-foot .smt-ghostbtn:hover { color: #e6edf3; text-decoration: underline; }
    #smt-tile .smt-foot .smt-ghostbtn.on { color: #e3b341; }
    #smt-tile .smt-foot .smt-next { margin-left: auto; background: #1f6feb; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 13px; font-weight: 600; }
    #smt-tile .smt-foot .smt-next:hover { background: #388bfd; }
    #smt-tile .smt-foot .smt-back { background: none; border: 1px solid #30363d; color: #c9d1d9; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 12.5px; }
    #smt-tile .smt-foot .smt-back:disabled { opacity: .35; cursor: default; }
    #smt-tile .smt-keys { padding: 0 18px 12px; font-size: 10.5px; color: #5f636b; }
    #smt-cursor { position: fixed; z-index: 9996; width: 22px; height: 22px; pointer-events: none; opacity: 0;
      transition: left .9s cubic-bezier(.4,0,.2,1), top .9s cubic-bezier(.4,0,.2,1), opacity .3s; }
    #smt-cursor svg { filter: drop-shadow(0 1px 2px rgba(1,4,9,.6)); }
    #smt-pulse { position: fixed; z-index: 9994; width: 36px; height: 36px; border-radius: 50%; border: 2px solid #58a6ff; pointer-events: none; opacity: 0; transform: translate(-50%,-50%) scale(.4); }
    #smt-pulse.go { animation: smt-click .7s ease-out; }
    body.smt-running #intro { visibility: hidden; }
    body.smt-running.smt-intro-step #intro { visibility: visible; }
    @keyframes smt-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes smt-blink { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    @keyframes smt-click { 0% { opacity: .9; transform: translate(-50%,-50%) scale(.4); } 100% { opacity: 0; transform: translate(-50%,-50%) scale(1.6); } }
    @media (prefers-reduced-motion: reduce) {
      #smt-cursor, #smt-tile, #smt-hole, #smt-ring, .smt-ghost .smt-msg { transition: none; animation: none; }
    }
  `;

  // ── content ───────────────────────────────────────────────────────────
  const INTERVIEW_PROMPT =
    "I am working on a rapid customer proof. Interview me until you understand the business problem, users, inputs, expected outputs, constraints, and what would prove success. Then propose the smallest single-file RAPP agent set that can test the idea locally with synthetic or approved data. Build it, run it through Brainstem, show me the evidence, identify production gaps, and recommend whether the final experience belongs in Scout, Copilot Studio, Foundry, or custom code. Do not call the prototype production-ready.";

  const STEP_LIST = (changed) => `
    <ol class="smt-steps">
      <li>Open the ad server and run last week's <em>campaign delivery report</em>.</li>
      <li>Export the delivery CSV and open the <em>insertion-order tracker</em> workbook.</li>
      <li>Filter the tracker to the advertiser and campaign flight.</li>
      <li class="${changed ? "changed" : ""}">${changed
        ? "Compare booked vs delivered impressions per line; flag under-delivery over 5% <em>on guaranteed lines only</em>."
        : "Compare booked vs delivered impressions per line and flag any shortfall."}</li>
      <li>Draft the makegood proposal email with the shortfall table and proposed added-value units.</li>
      <li>Log the makegood in the tracker and note the follow-up date.</li>
    </ol>`;

  const starterGhost = (hot) => `
    <div class="smt-heading">Rappter Surgeon · start here</div>
    <div class="smt-pill-list">
      <div class="smt-pill">Build and test an agent for this customer use case</div>
      <div class="smt-pill">Inspect this Brainstem and tell me what it can do</div>
      <div class="smt-pill">Record a short autopilot demo of the current workflow</div>
      <div class="smt-pill show${hot ? " hot" : ""}">Show Mode: turn a recording into an agent</div>
      <div class="smt-pill" style="opacity:.6">🚀 Deploy loaded agents to Copilot Studio</div>
    </div>`;

  const explorerBase = (extra) => `
    <div class="smt-heading">global agents</div>
    <div class="smt-row dim">📄 context_memory_agent.py <span class="smt-scope">memory</span></div>
    <div class="smt-row dim">📄 manage_memory_agent.py <span class="smt-scope">memory</span></div>
    <div class="smt-row dim">📄 hacker_news_agent.py <span class="smt-scope">global</span></div>
    ${extra || ""}`;

  const centerBase = `
    <div class="smt-msg" style="align-self:flex-start;max-width:70%">👋 Hi. I'm your Brainstem — I know a few things and I can learn a lot more. Ask me what I can do.</div>`;

  const agentCode = `
<span class="c"># Generated by OpenRappter Show Mode — reviewed and approved by the user</span>
<span class="c"># source: video spring-campaign-makegood.mp4 (+vtt)  analysis_revision: 2</span>
SHOW_MODE_FRONTIER_TAG = <span class="k">True</span>
__manifest__ = {<span class="s">"schema"</span>: <span class="s">"rapp-agent/1.0"</span>, <span class="s">"name"</span>: <span class="s">"@aibast/show-campaign-makegood"</span>, …}
<span class="k">from</span> agents.basic_agent <span class="k">import</span> BasicAgent

<span class="k">class</span> ${AGENT_TOOL}Agent(BasicAgent):
    <span class="k">def</span> __init__(self):
        self.name = <span class="s">"${AGENT_TOOL}"</span>
        self.metadata = {<span class="s">"name"</span>: self.name, <span class="s">"description"</span>: <span class="s">"Reconcile weekly campaign delivery …"</span>, …}
        super().__init__(name=self.name, metadata=self.metadata)

    <span class="k">def</span> perform(self, action=<span class="s">"describe"</span>, inputs=None, dry_run=<span class="k">True</span>, **kwargs):
        …`;

  const steps = [
    {
      id: "welcome",
      target: null,
      html: `<h3>Two ways in.<br>Describe it — or show it.</h3>
        <p>This is a <b>click-through preview</b> of Show Mode inside the Frontier. Nothing runs live; the panes show what the customer will see, using standard industry synthetic data.</p>
        <p class="smt-punch">The interview loop is for people who can describe the process. Show Mode is for people who would rather show it.</p>`,
      notes: `<b>Say:</b> Same call, same laptop, no tenant. If they can't articulate the process — or won't — they can just do it once and we watch.`,
    },
    {
      id: "interview",
      target: () => visibleIntroPrompt() || firstStarter(),
      introStep: true,
      html: `<h3>The interview loop — describe it.</h3>
        <p>The existing start prompt: Copilot interviews you until it understands the problem, users, inputs, outputs, constraints and success proof, then builds the smallest agent set and proves it locally with synthetic or approved data.</p>
        <p class="smt-quote">“Interview me until you understand the business problem… Do not call the prototype production-ready.”</p>`,
      notes: `<b>Say:</b> This is how most engagements start today. Keep it for customers who can articulate the workflow.`,
    },
    {
      id: "pill",
      target: () => surgeonPane(),
      open: { surgeon: true },
      ghosts: { surgeon: starterGhost(true) },
      cursorTo: () => ghostEl(".smt-pill.show"),
      html: `<h3>Show Mode — show it.</h3>
        <p>Some customers can't describe the workflow, or the person who can isn't on the call. One pill in the Rappter Surgeon; Copilot asks how they'd like to show it.</p>
        <p>Chat stays the control surface — every step you're about to see is a visible Surgeon tool call.</p>`,
      notes: `<b>Say:</b> Nothing to configure. The Rappter Surgeon runs Show Mode the same way it runs everything else — in the open.`,
    },
    {
      id: "doors",
      target: () => surgeonPane(),
      open: { surgeon: true },
      ghosts: { surgeon: `
        <div class="smt-msg user">Show Mode</div>
        <div class="smt-msg">How would you like to show me the task?
          <div class="smt-doors">
            <div class="smt-door"><b>● Record live</b>I capture your screen, apps, pages and clipboard while you do it once.</div>
            <div class="smt-door on"><b>▶ Import a video</b>A Teams recording, Loom, or phone capture — with its transcript if you have one.</div>
            <div class="smt-door"><b>▣ Drop screenshots</b>In order, with a one-line caption each if you like.</div>
            <div class="smt-door"><b>≡ Paste a transcript</b>A meeting transcript or a written SOP.</div>
          </div>
          Nothing leaves this machine until you tell me to analyze.</div>` },
      html: `<h3>Four doors into one pipe.</h3>
        <p>They don't have to perform live. A recording someone made last week, a folder of screenshots, or a transcript all land in the <b>same</b> analysis — as if it had been recorded in Show Mode in real time.</p>`,
      notes: `<b>Say:</b> Ask for the Teams recording and its transcript <i>before</i> the call. Then the proof happens on the call.`,
    },
    {
      id: "import",
      target: () => surgeonPane(),
      open: { surgeon: true },
      ghosts: { surgeon: `
        <div class="smt-msg user">Import a video</div>
        <div class="smt-msg user">📎 spring-campaign-makegood.mp4 · 3:12<br>📎 spring-campaign-makegood.vtt</div>
        <div class="smt-msg">Got both. Here's what will leave this laptop when I analyze: about 190 screen frames and the transcript text go to <b>GitHub Copilot</b>. Nothing else — no files, no other windows. Recorded secrets should never be in a recording; I'll redact anything that looks like one.<br><br>Go ahead?</div>
        <div class="smt-msg user">Yes</div>` },
      html: `<h3>Consent is a chat turn.</h3>
        <p>Before anything is analyzed, the Surgeon says exactly what leaves the machine and waits for a yes. Same posture as Skill Recorder's privacy warning, but in the conversation where the customer can see it.</p>`,
      notes: `<b>Say:</b> Local-first is not a slogan here — the only thing that leaves is the analysis payload, and they approve it.`,
    },
    {
      id: "analyze",
      target: () => surgeonPane(),
      open: { surgeon: true },
      ghosts: { surgeon: `
        <div class="smt-msg tool">describe_recording · reading the timeline… 6 scenes<br>looking at 9 frames around 00:41 and 02:10<br>reading 38 transcript cues · redaction: 0 hits</div>
        <div class="smt-msg tile"><b>Weekly campaign makegood reconciliation</b><br>
          <span class="smt-mono">intent · high confidence</span><br>
          Every Monday, compare last week's delivered impressions against what was booked on the insertion order, flag under-delivery, and send the advertiser a makegood proposal.
          ${STEP_LIST(false)}
          <span class="smt-mono">apps: ad server (browser) · Excel · Outlook</span></div>
        <div class="smt-msg">Does that read right? Tell me what to change in plain language, or say <b>approve</b>.</div>` },
      html: `<h3>Copilot reconstructs intent + ordered steps.</h3>
        <p>Frames, narration and events become one intent and six concrete actions — with the apps involved and a confidence. The customer reviews it as text, not as code.</p>`,
      notes: `<b>If they ask what data you used / how you simulated it:</b> standard industry synthetic data on the MVP use case — nothing the customer shared. The recording and the numbers here are synthetic.`,
    },
    {
      id: "edit",
      target: () => surgeonPane(),
      open: { surgeon: true },
      ghosts: { surgeon: `
        <div class="smt-msg user">Step 4 is wrong — we only flag under-delivery over 5%, and only for guaranteed lines.</div>
        <div class="smt-msg tile"><b>Revision 2</b>
          ${STEP_LIST(true)}
          <span class="smt-mono">changed: step 4 · other steps unchanged</span></div>
        <div class="smt-msg">Updated. Approve, or keep editing.</div>
        <div class="smt-msg user">Approve</div>` },
      html: `<h3>Edit it like you'd correct a colleague.</h3>
        <p>No forms, no fields. The customer says what's wrong; the analysis is revised and the change is highlighted. Every revision is kept.</p>`,
      notes: `<b>Say:</b> This is the moment the customer's tribal knowledge gets locked in — the thing no requirements doc ever captures.`,
    },
    {
      id: "approve",
      target: () => explorerPane(),
      open: { surgeon: true, explorer: true },
      ghosts: {
        surgeon: `
          <div class="smt-msg">Rendered <b>${AGENT_FILE}</b> from revision 2.
            <br><span class="smt-mono">validated: syntax ✓ · imports ✓ · no secrets ✓ · redaction ✓ · 5.8 KB</span></div>
          <div class="smt-msg code">${agentCode}</div>
          <div class="smt-msg tool">delegate_to_brainstem · ephemeral_agent: ${AGENT_FILE}<br>hotloading for a one-turn preview…</div>`,
        explorer: explorerBase(`
          <div class="smt-heading">this chat</div>
          <div class="smt-row hot">📄 ${AGENT_FILE} <span class="smt-scope eph">ephemeral</span></div>`),
      },
      html: `<h3>The approved steps become a single-file agent.</h3>
        <p>One <b>agent.py</b> — the same shape as every agent in the library. Deterministic, validated before it is ever loaded, and visible in the Explorer the moment it enters the Brainstem's agents folder.</p>`,
      notes: `<b>Say:</b> Nothing hidden. That file on the left is the whole thing — you can read it, download it, delete it.`,
    },
    {
      id: "preview",
      target: () => centerPane(),
      open: { surgeon: true, explorer: true },
      ghosts: {
        center: `${centerBase}
          <div class="smt-msg user">Introduce yourself and list your steps.</div>
          <div class="smt-msg" style="align-self:flex-start;max-width:78%">I'm <b>${AGENT_TOOL}</b>. I reconcile last week's campaign delivery against the insertion order, flag guaranteed lines under-delivered by more than 5%, and draft the makegood proposal.<br><br>Steps: 1 · delivery report → 2 · export + tracker → 3 · filter to flight → 4 · compare, flag &gt;5% guaranteed → 5 · draft makegood email → 6 · log it.<br><span class="smt-mono">Say "run" with an advertiser and flight to try me.</span></div>`,
        explorer: explorerBase(`
          <div class="smt-heading">this chat</div>
          <div class="smt-row hot">📄 ${AGENT_FILE} <span class="smt-scope eph">ephemeral</span></div>`),
      },
      html: `<h3>Hotloaded into the real Brainstem — for one turn.</h3>
        <p>The center pane is the unchanged Brainstem chat. The new agent answers there first as a preview; then it's installed into a test stack so the customer can use it freely.</p>`,
      notes: `<b>Say:</b> This is the actual product chat, not a mock of it. Same wire the production hosts speak.`,
    },
    {
      id: "test",
      target: () => centerPane(),
      open: { surgeon: true, explorer: true },
      ghosts: {
        center: `${centerBase}
          <div class="smt-msg user">Reconcile last week's delivery for the Contoso Outdoors spring campaign and draft the makegood.</div>
          <div class="smt-msg" style="align-self:flex-start;max-width:86%"><b>Contoso Outdoors · Spring flight · week of Aug 10</b>
            <table>
              <tr><th>Line</th><th>Booked</th><th>Delivered</th><th>Δ</th><th></th></tr>
              <tr><td>Homepage takeover (guaranteed)</td><td class="num">2,400,000</td><td class="num">2,110,400</td><td class="num bad">−12.1%</td><td class="bad">makegood</td></tr>
              <tr><td>Pre-roll (guaranteed)</td><td class="num">6,000,000</td><td class="num">5,928,000</td><td class="num ok">−1.2%</td><td class="ok">ok</td></tr>
              <tr><td>Sponsorship units (guaranteed)</td><td class="num">1,200,000</td><td class="num">1,020,000</td><td class="num bad">−15.0%</td><td class="bad">makegood</td></tr>
              <tr><td>Programmatic (non-guaranteed)</td><td class="num">3,000,000</td><td class="num">2,610,000</td><td class="num">−13.0%</td><td>excluded</td></tr>
            </table>
            <b>Draft — Makegood proposal</b><br><span class="smt-mono">Subject: Spring flight — week of Aug 10 delivery and proposed makegood<br>Hi team — two guaranteed lines under-delivered last week (homepage takeover −12.1%, sponsorship −15.0%). Proposed makegood: 470k added-value impressions across… </span><br><span class="smt-mono blue">agent: ${AGENT_TOOL} · dry_run · synthetic data</span></div>`,
        explorer: explorerBase(`
          <div class="smt-heading">stack: show-mode-makegood</div>
          <div class="smt-row hot">📄 ${AGENT_FILE} <span class="smt-scope stack">stack</span></div>`),
      },
      html: `<h3>They test it. Proof of value on the same call.</h3>
        <p>Installed into a test stack, the agent is now theirs to poke at in the real chat: real questions, visible tool calls, synthetic data. The Explorer shows it under <b>stack:show-mode-makegood</b>.</p>`,
      notes: `<b>Say:</b> A prototype that locks in the end-to-end use case for the user. Nothing about it changes when it moves to a production host.`,
    },
    {
      id: "confirm",
      target: () => surgeonPane(),
      open: { surgeon: true, explorer: true },
      ghosts: {
        surgeon: `
          <div class="smt-msg user">Confirmed — that's the process.</div>
          <div class="smt-msg evidence"><b>Confirmed and recorded</b><br>
            <span class="smt-thumb"></span><span class="smt-thumb center"></span><br>
            <span class="smt-mono">chat transcript · screenshot · agent_logs saved<br>rappid:@microsoft/show-campaign-makegood:3f9c…e21a<br>egg  routing/eggs/7b2e…c904.egg<br>frame show-mode.confirmed · rev 2 · source 9d1f…</span></div>
          <div class="smt-msg">That's the proven artifact. Where should it live?</div>`,
        explorer: explorerBase(`
          <div class="smt-heading">stack: show-mode-makegood</div>
          <div class="smt-row hot">📄 ${AGENT_FILE} <span class="smt-scope stack">stack</span></div>`),
      },
      html: `<h3>Confirmation records the evidence.</h3>
        <p>What was tested, what it answered, its identity and its portable egg. The tested bytes are the bytes that promote — no rewrite between “it worked here” and “it ships there”.</p>`,
      notes: `<b>Say:</b> The evidence is the deliverable. Screenshots, transcript, identity — this is what goes into the SOW conversation.`,
    },
    {
      id: "promote",
      target: () => surgeonPane(),
      open: { surgeon: true, explorer: true },
      ghosts: {
        surgeon: `
          <div class="smt-msg">Where should it live?
            <div class="smt-doors">
              <div class="smt-door on"><b>🚀 Copilot Studio</b>Governed agent, connectors, M365 reach. Draft first — publishing is your action.</div>
              <div class="smt-door"><b>Scout</b>On-device employee workflow with Work IQ.</div>
              <div class="smt-door"><b>Cowork</b>Microsoft 365 Copilot agent skill.</div>
              <div class="smt-door"><b>Keep local</b>Portable RAPP egg; promote later.</div>
            </div></div>
          <div class="smt-msg user">Copilot Studio</div>
          <div class="smt-msg tool">ensure_copilot_studio_deploy_agents · doctor ✓ plan ✓ build ✓ provision ✓ push ✓ parity ✓</div>
          <div class="smt-msg link"><b>Campaign Makegood Assistant — Draft</b><br>Copilot Studio · environment: your dev env · AgentId 8c1e…<br><span class="smt-mono" style="color:#e2d4ff">Open in Copilot Studio ↗ · Draft only; live publication is a manual action in the linked UI.</span></div>`,
        explorer: explorerBase(`
          <div class="smt-heading">stack: show-mode-makegood</div>
          <div class="smt-row hot">📄 ${AGENT_FILE} <span class="smt-scope stack">stack</span></div>`),
      },
      html: `<h3>Maps into the whole Microsoft AI stack.</h3>
        <p>Copilot Studio through the existing one-click Draft path; Scout and Cowork as skills; Foundry, Hippocampus, or custom Azure code when the requirements say so. Promotion changes the host and the governance level — never the agent's intent or its chat contract.</p>`,
      notes: `<b>If they ask where the AI solution lives:</b> our prototyping tool maps into the full Microsoft AI stack — it comes down to their requirements and yours for how we sell it. It keeps it fluid and shows the power of the stack.`,
    },
    {
      id: "why",
      target: null,
      open: { surgeon: true, explorer: true },
      html: `<h3>Why this is the launchpad.</h3>
        <p>Brainstem is built for the call where all five are true at once:</p>
        <ol>
          <li>You don't have access to the customer tenant.</li>
          <li>You don't have access to a trial instance.</li>
          <li>You only have your local machine.</li>
          <li>You need to learn all of AI yesterday.</li>
          <li>You need to show proof of value on the same call.</li>
        </ol>
        <p class="smt-punch">Every other surface assumes one of those is false. Show Mode assumes all five are true — and the local artifact is the artifact that ships.</p>`,
      notes: `<b>Say:</b> Think of it as a prototype that locks in the end-to-end use case for the user and can then map to any part of our product using AI.`,
    },
    {
      id: "end",
      target: null,
      html: `<h3>That's Show Mode.</h3>
        <p>Record it, import it, or drop screenshots and a transcript. Approve the steps. Test the agent in your own Brainstem. Confirm. Promote — Copilot Studio, Scout, Cowork, or keep it local.</p>
        <p class="smt-punch">Preview only — the click-through you just saw is the design; the feature ships in phases (see the beta README).</p>`,
      notes: `<b>Close:</b> Offer the interview loop as the alternative for the same customer, or restart the click-through for a second stakeholder.`,
      last: true,
    },
  ];

  // ── DOM helpers ───────────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const explorerPane = () => $("#explorer");
  const surgeonPane = () => $("#surgeon");
  const centerPane = () => $("main");
  const firstStarter = () => $(".surgeon-starters button") || $("#surgeon-log") || surgeonPane();
  const visibleIntroPrompt = () => {
    const intro = $("#intro");
    if (!intro || intro.classList.contains("hidden")) return null;
    return $("#show-mode-interview-prompt") || $("#intro .intro-tile.wide .prompt") || intro;
  };
  const ghostEl = (sel) => $(sel, root);

  let root, shade, hole, ring, tile, cursor, pulse, ghosts;
  let idx = 0, running = false, prevState = null, resizeTimer = 0;
  let notesOn = safeGet(NOTES_KEY) === "on";

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

  function build() {
    if (root) return;
    const style = document.createElement("style");
    style.id = "smt-css";
    style.textContent = css;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "smt-root";
    root.innerHTML = `
      <div id="smt-shade"></div>
      <div id="smt-hole" class="off"></div>
      <div id="smt-ring" class="off"></div>
      <div class="smt-ghost smt-explorer" data-pane="explorer" hidden></div>
      <div class="smt-ghost smt-center" data-pane="center" hidden></div>
      <div class="smt-ghost smt-surgeon" data-pane="surgeon" hidden></div>
      <div id="smt-pulse"></div>
      <div id="smt-cursor"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 3l14 8-6 1.5L16 20l-2.5 1-3-7.5L6 18z" fill="#fff" stroke="#0d1117" stroke-width="1.2"/></svg></div>
      <div id="smt-tile" role="dialog" aria-modal="true" aria-label="Show Mode click-through">
        <div class="smt-bar"><div></div></div>
        <div class="smt-head"><span class="smt-rec" aria-hidden="true"></span><span class="smt-step">Show Mode · click-through preview</span><button class="smt-x" type="button" title="Exit (Esc)" aria-label="Exit click-through">✕</button></div>
        <div class="smt-body"></div>
        <div class="smt-notes off"></div>
        <div class="smt-foot">
          <button class="smt-back" type="button">← Back</button>
          <button class="smt-ghostbtn smt-notes-toggle" type="button" title="Presenter notes (N)">notes</button>
          <button class="smt-next" type="button">Next →</button>
        </div>
        <div class="smt-keys">→ / space next · ← back · N notes · Esc exit</div>
      </div>`;
    document.body.appendChild(root);
    shade = $("#smt-shade", root); hole = $("#smt-hole", root); ring = $("#smt-ring", root);
    tile = $("#smt-tile", root); cursor = $("#smt-cursor", root); pulse = $("#smt-pulse", root);
    ghosts = {
      explorer: $('.smt-ghost[data-pane="explorer"]', root),
      center: $('.smt-ghost[data-pane="center"]', root),
      surgeon: $('.smt-ghost[data-pane="surgeon"]', root),
    };
    $(".smt-x", tile).addEventListener("click", () => stop());
    $(".smt-next", tile).addEventListener("click", () => next());
    $(".smt-back", tile).addEventListener("click", () => prev());
    $(".smt-notes-toggle", tile).addEventListener("click", () => toggleNotes());
    root.hidden = true;
  }

  // Panes: remember what the user had open, open what a step needs, restore on exit.
  function paneState() {
    return {
      explorer: !!explorerPane()?.classList.contains("open"),
      surgeon: !!surgeonPane()?.classList.contains("open"),
      bodyExplorer: document.body.classList.contains("explorer-open"),
      bodySurgeon: document.body.classList.contains("surgeon-open"),
    };
  }
  function setPane(name, open) {
    const el = name === "explorer" ? explorerPane() : surgeonPane();
    if (!el) return;
    el.classList.toggle("open", open);
    document.body.classList.toggle(`${name}-open`, open);
  }
  function restorePanes() {
    if (!prevState) return;
    setPane("explorer", prevState.explorer);
    setPane("surgeon", prevState.surgeon);
    document.body.classList.toggle("explorer-open", prevState.bodyExplorer);
    document.body.classList.toggle("surgeon-open", prevState.bodySurgeon);
    prevState = null;
  }

  function rectOf(el) { return el ? el.getBoundingClientRect() : null; }

  // Each ghost layer paints over the pane's *content* only: below the pane
  // header and above its composer/input, with the pane's own background, so the
  // preview reads as the pane's state rather than a translucent overlay.
  function ghostBox(pane, target) {
    const r = rectOf(target);
    if (!r || r.width < 40) return null;
    let top = r.top, bottom = r.bottom;
    const header = pane === "center"
      ? (target.querySelector(".k-head") || null)
      : target.querySelector(":scope > header");
    if (header) top = rectOf(header).bottom;
    else if (pane === "center") top = r.top + Math.min(118, r.height * 0.18);
    const footer = pane === "surgeon"
      ? target.querySelector(".surgeon-composer")
      : pane === "center" ? target.querySelector(".k-input") : null;
    if (footer) bottom = rectOf(footer).top;
    else if (pane === "center") bottom = r.bottom - Math.min(96, r.height * 0.14);
    else if (pane === "explorer") bottom = r.bottom - 34; // leave the status line
    const bg = getComputedStyle(target).backgroundColor;
    return {
      left: r.left, top, width: r.width, height: Math.max(0, bottom - top),
      background: bg && bg !== "rgba(0, 0, 0, 0)" ? bg : (pane === "center" ? "#0d1117" : "#141518"),
    };
  }

  function placeGhosts(step) {
    for (const [pane, el] of Object.entries(ghosts)) {
      const html = step.ghosts && step.ghosts[pane];
      if (!html) { el.hidden = true; el.innerHTML = ""; delete el.dataset.html; continue; }
      const target = pane === "explorer" ? explorerPane() : pane === "surgeon" ? surgeonPane() : centerPane();
      const box = target ? ghostBox(pane, target) : null;
      if (!box || box.height < 40) { el.hidden = true; continue; }
      el.hidden = false;
      el.style.left = `${box.left}px`; el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`; el.style.height = `${box.height}px`;
      el.style.background = box.background;
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    }
  }

  function position(step) {
    const target = typeof step.target === "function" ? step.target() : step.target;
    const r = target ? rectOf(target) : null;
    if (r && r.width > 0 && r.height > 0) {
      const pad = 6;
      hole.classList.remove("off"); ring.classList.remove("off"); shade.classList.add("off");
      for (const el of [hole, ring]) {
        el.style.left = `${r.left - pad}px`; el.style.top = `${r.top - pad}px`;
        el.style.width = `${r.width + pad * 2}px`; el.style.height = `${r.height + pad * 2}px`;
      }
      const cw = tile.offsetWidth, ch = tile.offsetHeight;
      let top, left;
      // Keep the tile off the spotlighted pane: beside it when there is room
      // (right first, then left), otherwise below/above, otherwise the bottom.
      const spaceRight = innerWidth - r.right, spaceLeft = r.left;
      if (spaceRight >= cw + 24) {
        left = r.right + 16;
        top = Math.max(8, Math.min(r.top + 24, innerHeight - ch - 8));
      } else if (spaceLeft >= cw + 24) {
        left = r.left - cw - 16;
        top = Math.max(8, Math.min(r.top + 24, innerHeight - ch - 8));
      } else if (r.bottom + 12 + ch < innerHeight) {
        top = r.bottom + 12;
        left = Math.max(8, Math.min(r.left + r.width / 2 - cw / 2, innerWidth - cw - 8));
      } else if (r.top - ch - 12 > 8) {
        top = r.top - ch - 12;
        left = Math.max(8, Math.min(r.left + r.width / 2 - cw / 2, innerWidth - cw - 8));
      } else {
        top = Math.max(8, innerHeight - ch - 8);
        left = Math.max(8, Math.min(r.left + r.width / 2 - cw / 2, innerWidth - cw - 8));
      }
      tile.style.top = `${top}px`; tile.style.left = `${left}px`;
    } else {
      hole.classList.add("off"); ring.classList.add("off"); shade.classList.remove("off");
      tile.style.top = `${Math.max(8, innerHeight / 2 - tile.offsetHeight / 2)}px`;
      tile.style.left = `${Math.max(8, innerWidth / 2 - tile.offsetWidth / 2)}px`;
    }
    placeGhosts(step);
    if (step.cursorTo) {
      const el = step.cursorTo();
      const cr = rectOf(el);
      if (cr) {
        cursor.style.opacity = "1";
        cursor.style.left = `${cr.left + cr.width * 0.35}px`;
        cursor.style.top = `${cr.top + cr.height * 0.55}px`;
        setTimeout(() => {
          pulse.style.left = `${cr.left + cr.width * 0.35 + 4}px`;
          pulse.style.top = `${cr.top + cr.height * 0.55 + 4}px`;
          pulse.classList.remove("go"); void pulse.offsetWidth; pulse.classList.add("go");
        }, 950);
      }
    } else {
      cursor.style.opacity = "0";
    }
  }

  function render() {
    const step = steps[idx];
    $(".smt-bar > div", tile).style.width = `${((idx + 1) / steps.length) * 100}%`;
    $(".smt-step", tile).textContent = `Show Mode · click-through preview · ${idx + 1} / ${steps.length}`;
    $(".smt-body", tile).innerHTML = step.html;
    const notes = $(".smt-notes", tile);
    notes.innerHTML = step.notes || "";
    notes.classList.toggle("off", !notesOn || !step.notes);
    $(".smt-notes-toggle", tile).classList.toggle("on", notesOn);
    $(".smt-back", tile).disabled = idx === 0;
    $(".smt-next", tile).textContent = step.last ? "Finish" : "Next →";
    document.body.classList.toggle("smt-intro-step", !!step.introStep && !!visibleIntroPrompt());
    if (step.open) {
      if (step.open.explorer) setPane("explorer", true);
      if (step.open.surgeon) setPane("surgeon", true);
    }
    // Panes slide in over ~280ms; position now and again once they settle.
    position(step);
    setTimeout(() => running && position(steps[idx]), 320);
    setTimeout(() => running && position(steps[idx]), 700);
  }

  function start(at) {
    build();
    if (running) { setStep(typeof at === "number" ? at : 0); return; }
    running = true;
    prevState = paneState();
    document.body.classList.add("smt-running");
    root.hidden = false;
    setStep(typeof at === "number" ? at : 0);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    $(".smt-next", tile).focus();
  }
  function stop() {
    if (!running) return;
    running = false;
    root.hidden = true;
    for (const el of Object.values(ghosts)) { el.hidden = true; el.innerHTML = ""; delete el.dataset.html; }
    cursor.style.opacity = "0";
    document.body.classList.remove("smt-running", "smt-intro-step");
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    restorePanes();
    document.dispatchEvent(new CustomEvent("rapp-beta:show-mode-tour-ended"));
  }
  function setStep(i) {
    if (i < 0) i = 0;
    if (i >= steps.length) return stop();
    idx = i;
    render();
  }
  function next() { setStep(idx + 1); }
  function prev() { setStep(idx - 1); }
  function toggleNotes() {
    notesOn = !notesOn;
    safeSet(NOTES_KEY, notesOn ? "on" : "off");
    render();
  }
  function onKey(event) {
    if (!running) return;
    const k = event.key;
    if (k === "Escape") { event.preventDefault(); stop(); }
    else if (k === "ArrowRight" || k === " " || k === "Enter") {
      if (event.target && /^(TEXTAREA|INPUT)$/.test(event.target.tagName) && k !== "ArrowRight") return;
      event.preventDefault(); next();
    }
    else if (k === "ArrowLeft") { event.preventDefault(); prev(); }
    else if (k === "n" || k === "N") { event.preventDefault(); toggleNotes(); }
  }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => running && position(steps[idx]), 80);
  }

  window.rappShowModeTour = {
    start, stop, next, prev,
    get running() { return running; },
    get step() { return steps[idx]?.id; },
    steps: steps.map((s) => s.id),
  };
  window.addEventListener("rapp-beta:show-mode-tour", () => start(0));
  document.addEventListener("click", (event) => {
    const trigger = event.target && event.target.closest && event.target.closest("[data-show-mode-tour]");
    if (trigger) { event.preventDefault(); start(0); }
  });
  const wantsAuto = /(?:^|[?&])tour=show-mode(?:&|$)/.test(location.search) || location.hash === "#show-mode-tour";
  if (wantsAuto) {
    if (document.readyState === "complete") setTimeout(() => start(0), 250);
    else window.addEventListener("load", () => setTimeout(() => start(0), 250), { once: true });
  }
})();
