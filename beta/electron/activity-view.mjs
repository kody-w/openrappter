export function installActivityView(window, document) {
  window.__rappBetaActivityView = window.__rappBetaActivityView === true;
  window.__rappBetaSetActivityView = (on) => {
    window.__rappBetaActivityView = on === true;
    if (!window.__rappBetaActivityView) {
      document.getElementById("beta-drive-feed")?.remove();
    }
    return window.__rappBetaActivityView;
  };

  function driveFeed() {
    if (!window.__rappBetaActivityView) return null;
    const host = document.body;
    if (!host) return null;
    let feed = document.getElementById("beta-drive-feed");
    if (!feed) {
      feed = document.createElement("div");
      feed.id = "beta-drive-feed";
      feed.className = "beta-drive-feed";
      feed.dataset.brainstemAiDriver = "true";
      host.appendChild(feed);
    }
    return feed;
  }

  window.__rappBetaRenderDriveStep = (summary) => {
    const feed = driveFeed();
    const line = String(summary || "").replace(/\s+/g, " ").trim().slice(0, 220);
    if (!feed || !line) return false;
    const tile = document.createElement("div");
    tile.className = "beta-drive-step-tile";
    tile.dataset.driveStepTile = "true";
    tile.setAttribute("role", "status");
    tile.textContent = line;
    feed.appendChild(tile);
    while (feed.querySelectorAll(".beta-drive-step-tile").length > 20) {
      feed.querySelector(".beta-drive-step-tile")?.remove();
    }
    feed.parentElement.scrollTop = feed.parentElement.scrollHeight;
    return true;
  };

  window.__rappBetaRenderDriveMedia = (artifact) => {
    const feed = driveFeed();
    if (!feed || !artifact?.url) return false;
    const tile = document.createElement("div");
    tile.className = "beta-drive-media-tile";
    const media = artifact.kind === "video"
      ? document.createElement("video")
      : document.createElement("img");
    media.src = String(artifact.url);
    if (artifact.kind === "video") {
      media.controls = true;
      media.preload = "metadata";
    } else {
      media.alt = String(artifact.alt || "OpenRappter capture");
    }
    const link = document.createElement("a");
    link.href = String(artifact.url);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = String(artifact.alt || "Open artifact");
    tile.append(media, link);
    feed.appendChild(tile);
    while (feed.querySelectorAll(".beta-drive-media-tile").length > 8) {
      feed.querySelector(".beta-drive-media-tile")?.remove();
    }
    feed.parentElement.scrollTop = feed.parentElement.scrollHeight;
    return true;
  };
}

export function createActivityViewInstallationSource() {
  return `;(${installActivityView.toString()})(window, document);`;
}
