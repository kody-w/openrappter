export function migrationReplayHtml(evidence, displays) {
  if (!displays.length) throw new Error('Observed display events are required; a synthetic animation is not migration proof.');
  const data = JSON.stringify({ evidence, displays }).replaceAll('<', '\\u003c').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Observed RAPP Work Migration — Fixture Release Gate</title>
<script>
  (() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
</script>
<style>
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}
*{box-sizing:border-box}body{margin:0;background:var(--cp-bg);color:var(--cp-text);font:16px/1.45 "Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif}
main{max-width:1240px;margin:auto;padding:24px}h1{font-size:28px;margin:0 0 8px}h2{font-size:20px;margin:0 0 12px}h3{font-size:17px;margin:0 0 8px}
p{margin:8px 0}.muted{color:var(--cp-text-muted)}.banner{padding:12px 16px;background:var(--cp-accent-soft);border:1px solid var(--cp-accent);border-radius:0.625rem}
.card{padding:16px;background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px;margin-top:16px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0}
button{font:inherit;min-height:40px;padding:8px 16px;border:1px solid var(--cp-border-strong);border-radius:0.625rem;background:var(--cp-surface);color:var(--cp-text);cursor:pointer}
button.primary{background:var(--cp-accent);color:var(--cp-accent-fg);border-color:var(--cp-accent)}
button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid var(--cp-accent);outline-offset:3px}
input[type=range]{width:100%;accent-color:var(--cp-accent)}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.metric{padding:12px;border:1px solid var(--cp-border);border-radius:0.625rem;background:var(--cp-surface)}.number{display:block;font-size:28px;font-weight:650}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.grid .card{min-width:0}
code,.mono{font-family:Consolas,"Courier New",Courier,monospace;overflow-wrap:anywhere;font-size:12px}
ul{padding-left:20px;margin:8px 0}li{margin:4px 0;overflow-wrap:anywhere}.scope-kind{font-size:12px;color:var(--cp-text-muted)}
.pointer{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid var(--cp-border);overflow-wrap:anywhere}
.pointer:last-child{border:0}.badge{font-size:12px;color:var(--cp-text-muted)}.good{color:var(--cp-success)}.pending{color:var(--cp-warning)}
#additions{padding:8px 0;min-height:32px;color:var(--cp-accent)}#position{font-variant-numeric:tabular-nums}
@media(max-width:680px){main{padding:16px}h1{font-size:24px}.grid{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.pointer{grid-template-columns:1fr}.mono{font-size:11px}}
</style></head><body><main>
<h1>Observed RAPP Work migration</h1><p class="muted">NEW greenfield application · public provider-neutral API · separately launched passive projection</p>
<p class="banner">Sanitized fixture proof, not product UI. Live profiles were untouched. Release remains blocked until an approved controlled-local migration passes.</p>
<section class="card" aria-label="Observed event playback">
<div class="controls"><button id="play" class="primary" type="button">Play</button><button id="next" type="button">Next event</button><button id="reset" type="button">Reset</button><span id="position" aria-live="polite"></span></div>
<label for="seek">Observed migration event</label><input id="seek" type="range" min="0" value="0" step="1">
<div id="additions" aria-live="polite"></div><p id="cursor" class="mono"></p>
</section>
<section class="metrics" aria-label="Canonical destination counts">
<div class="metric">Root bots<strong class="number" id="roots-count">0</strong></div>
<div class="metric">Scoped organs<strong class="number" id="scopes-count">0</strong></div>
<div class="metric">Pointers<strong class="number" id="pointers-count">0</strong></div>
<div class="metric">Artifacts<strong class="number" id="artifacts-count">0</strong></div>
</section>
<div id="roots" class="grid"></div>
<section class="card"><h2>Live additions and provenance</h2><div id="items"></div></section>
<section class="card"><h2>Transaction continuity</h2><ul id="batches"></ul><p id="verdict"></p></section>
<section class="card"><h2>Measured evidence</h2><p id="proof"></p><p class="mono" id="plan"></p><p class="muted">All data is embedded from the recorded passive-client output. Playback makes no network request, model call, source mutation or destination write.</p></section>
</main>
<script id="observed-data" type="application/json">${data}</script>
<script>
(() => {
  const dataset=JSON.parse(document.getElementById("observed-data").textContent);
  const rows=dataset.displays, evidence=dataset.evidence;
  let index=0, timer=null;
  const byId=id=>document.getElementById(id);
  const make=(tag,value,className)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;if(className)node.className=className;return node;};
  const stop=()=>{if(timer!==null)clearInterval(timer);timer=null;byId("play").textContent="Play";};
  function render(){
    const row=rows[index], state=row.state;
    byId("seek").max=String(rows.length-1);byId("seek").value=String(index);
    byId("position").textContent="Event "+(index+1)+" / "+rows.length+" · application run "+row.run;
    byId("next").disabled=index===rows.length-1;
    byId("roots-count").textContent=String(state.counts.roots);
    byId("scopes-count").textContent=String(state.counts.scopes);
    byId("pointers-count").textContent=String(state.counts.pointers);
    byId("artifacts-count").textContent=String(state.counts.artifacts);
    byId("cursor").textContent="Canonical estate cursor: "+row.cursorHash;
    byId("additions").textContent=row.additions.length?"Appeared live: "+row.additions.slice(0,6).map(a=>a.title).join(" · ")+(row.additions.length>6?" · +"+(row.additions.length-6)+" more, listed below":""):"Canonical transaction/status update; no visible identity was reminted.";
    const roots=byId("roots");roots.replaceChildren();
    for(const root of state.roots){
      const card=make("article",undefined,"card");card.append(make("h2",root.name+(root.hidden?" · hidden root retained":"")),make("p",root.root,"mono"));
      const list=make("ul");
      for(const scope of root.scopes){const item=make("li");item.append(make("span",scope.name+" "),make("span","["+scope.kind+"] parent: "+(scope.parent||"none"),"scope-kind"));list.append(item);}
      card.append(list,make("p",root.branches.length+" preserved branch(es) · "+root.artifacts.length+" canonical artifacts","muted"));roots.append(card);
    }
    if(!state.roots.length)roots.append(make("section","The isolated profile is empty. Source fixtures exist separately; no destination seeding occurred.","card muted"));
    const items=byId("items");items.replaceChildren();
    for(const item of state.items){const line=make("div",undefined,"pointer");line.append(make("strong",item.title),make("span",item.provider,"badge"),make("span",item.classification,"badge"));items.append(line);}
    if(!state.items.length)items.append(make("p","No source item has been committed yet.","muted"));
    const batches=byId("batches");batches.replaceChildren();
    for(const batch of state.batches)batches.append(make("li",batch.id+" — "+batch.status+" ("+batch.items.length+" selected item(s))"));
    byId("verdict").textContent=state.complete?"All approved fixture items are present. Controlled-local release gate is still pending.":"The full selected estate is not yet committed.";
    byId("verdict").className=state.complete?"good":"pending";
    byId("proof").textContent=evidence.canonical.framesScanned+" signed destination/control frames checked "+evidence.canonical.verdict+"; "+evidence.sourceFilesCompared+" source files unchanged; 0 source writes/moves/deletes; interruption/resume and incomplete-only rollback verified.";
    byId("plan").textContent="Approved plan: "+evidence.planHash;
  }
  byId("next").addEventListener("click",()=>{stop();index=Math.min(rows.length-1,index+1);render();});
  byId("reset").addEventListener("click",()=>{stop();index=0;render();});
  byId("seek").addEventListener("input",event=>{stop();index=Number(event.target.value);render();});
  byId("play").addEventListener("click",()=>{if(timer!==null){stop();return;}if(index===rows.length-1)index=0;byId("play").textContent="Pause";timer=setInterval(()=>{index=Math.min(rows.length-1,index+1);render();if(index===rows.length-1)stop();},120);});
  render();
})();
</script></body></html>`;
}
