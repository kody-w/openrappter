export const FORCE_MODE_BOOTSTRAP =
  "<!-- Added by the OpenRappter host: a force-mode"
  + " capability marker, so the driver can tell a real responsive layout from one"
  + " the host is simulating. This marker changes nothing else; the separately"
  + " declared RAPP Autopilot driver follows. -->"
  + "<script>window.__rappForceModeCapable=true;"
  + "try{document.documentElement.setAttribute('data-rapp-force-mode','ready');}catch(e){}</script>";

export function createAutopilotInstallationSource({
  capability,
  classicSource,
  semanticControl = false,
}) {
  return `/* Added by the OpenRappter host: the RAPP Autopilot driver
   (rapp-autopilot/1.0), which installs window.rapp as an allowlisted command
   surface the host uses to drive this UI the way a person would, plus a
   per-session capability token. It reads and operates the existing UI only; it
   adds no capability this interface does not already offer a person. */
;(() => {
window.__rappAutopilotCapability = ${JSON.stringify(capability)};
window.__openrappterSemanticControlEnabled = ${semanticControl === true};
${String(classicSource || "")}
})();`;
}

export function createOpenRappterBrandingSource() {
  return `/* OpenRappter owns the application identity. Brainstem remains the
   unchanged runtime component hosted inside this frame. */
;(() => {
  document.documentElement.setAttribute("data-openrappter-branded", "true");
  const brandNode = (node) => {
    if (!node || ["SCRIPT", "STYLE"].includes(node.parentElement?.tagName)) return;
    const current = String(node.nodeValue || "");
    const branded = current.replaceAll("RAPP Brainstem", "OpenRappter");
    if (branded !== current) node.nodeValue = branded;
  };
  const brandText = (root) => {
    if (!root) return;
    if (root.nodeType === 3) {
      brandNode(root);
      return;
    }
    const walker = document.createTreeWalker(root, 4);
    while (walker.nextNode()) brandNode(walker.currentNode);
  };
  const applyFrameChrome = () => {
    if (document.title !== "OpenRappter") document.title = "OpenRappter";
    const composer = document.getElementById("input");
    if (composer && composer.placeholder !== "Message OpenRappter...") {
      composer.placeholder = "Message OpenRappter...";
    }
    const logo = document.querySelector("header .logo .icon");
    if (logo && logo.dataset.openrappterLogo !== "1") {
      logo.dataset.openrappterLogo = "1";
      logo.innerHTML = '<svg viewBox="0 0 1024 1024" aria-label="OpenRappter">'
      + '<path fill="#58f5d2" d="M238 614c40-182 157-302 320-302 107 0 198 56 227 144 31 95-4 187-84 226-63 31-128 27-183-11l-39 130-94-28 39-130c-78 16-140 6-186-29zm350-192c-31 0-57 25-57 57s26 57 57 57 57-25 57-57-26-57-57-57z"/>'
      + '<path fill="#07111f" d="M612 452a22 22 0 1 1 0 44 22 22 0 0 1 0-44z"/>'
      + '<path fill="#58f5d2" d="M214 626c-50 4-90-14-119-53 35 10 70 7 104-9l15 62z"/>'
      + '</svg>';
      const tile = logo.closest(".logo");
      if (tile) {
        tile.style.background = "linear-gradient(135deg, #07111f, #102b27)";
        tile.style.border = "1px solid #285b55";
      }
    }
  };
  brandText(document.body);
  applyFrameChrome();
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") brandText(record.target);
      if (record.type === "childList") {
        for (const node of record.addedNodes) brandText(node);
      }
    }
    applyFrameChrome();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["placeholder"],
    characterData: true,
    childList: true,
    subtree: true,
  });
})();`;
}

export function createFrameBridgeInstallationSource({
  autopilotSource,
  brandingSource,
  bridgeSource,
}) {
  return `/* Added by the OpenRappter host: the Brainstem frame bridge,
   the dimension-tiles bridge when Agent Arena is enabled, and the separately
   declared RAPP Autopilot payload below. These adapters operate the existing
   visible interface and carry host state across the frame boundary. */
${String(brandingSource || "")}
${String(bridgeSource || "")}
${String(autopilotSource || "")}`;
}

export function instrumentRappUi(html, {
  autopilotSource,
  forceModeBootstrap = FORCE_MODE_BOOTSTRAP,
}) {
  const classicSource = String(autopilotSource || "")
    .replace(/<\/script/gi, "<\\/script");
  const marker = forceModeBootstrap + `<script>${classicSource}</script>`;
  return /<head[^>]*>/i.test(html)
    ? String(html).replace(/<head[^>]*>/i, (match) => match + marker)
    : marker + String(html);
}

export function createViewToggle(startMobile) {
  return `
<!-- Added by the OpenRappter host: a viewport toggle so a person can
     see the page as it looks on a narrow screen. It changes presentation only. -->
<style id="__rappViewStyle">
  html[data-rapp-view="mobile"] body { max-width: 480px !important; margin: 0 auto !important;
    box-shadow: 0 0 0 100vmax rgba(0,0,0,.25); }
  #__rappViewToggle { position: fixed; top: 8px; right: 8px; z-index: 2147483647;
    font: 600 11px Inter,system-ui,sans-serif; background: rgba(22,27,34,.9); color: #c8c9cc;
    border: 1px solid #30363d; border-radius: 7px; padding: 4px 9px; cursor: pointer; }
  #__rappViewToggle:hover { color: #e6edf3; border-color: #58a6ff; }
</style>
<script>
  (function(){
    document.documentElement.dataset.rappView = ${startMobile ? '"mobile"' : '"full"'};
    var b = document.createElement("button");
    b.id = "__rappViewToggle";
    function label(){ b.textContent = document.documentElement.dataset.rappView === "mobile" ? "⤢ Full width" : "▭ Mobile view"; }
    b.addEventListener("click", function(){
      document.documentElement.dataset.rappView = document.documentElement.dataset.rappView === "mobile" ? "full" : "mobile";
      label();
    });
    label();
    (document.body || document.documentElement).appendChild(b);
  })();
</script>`;
}
