import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import type { XpeditionAppExtensionV1 } from '../services/xpedition-extensions.js';

export interface XpeditionExtensionContextV1 {
  schema: 'openrappter-xpedition-extension-context/1.0';
  product: 'OpenRappter Personal';
  openApp(appId: string): void;
}

@customElement('openrappter-xpedition-extension-host')
export class OpenRappterXpeditionExtensionHost extends LitElement {
  static styles = css`
    :host { display: block; min-height: 100%; }
    .mount { min-height: 100%; }
    .unavailable {
      margin: 1rem;
      padding: 1rem;
      border: 1px solid var(--warning);
      border-radius: 0.5rem;
      background: color-mix(in srgb, var(--warning) 10%, var(--bg-secondary));
      color: var(--text-primary);
      line-height: 1.55;
    }
    code {
      border-radius: 0.25rem;
      padding: 0.12rem 0.3rem;
      background: var(--bg-tertiary);
    }
  `;

  @property({ attribute: false }) extension: XpeditionAppExtensionV1 | null = null;
  @query('.mount') private mount?: HTMLDivElement;
  private mountedTag = '';

  protected updated(): void {
    this.mountExtension();
  }

  private mountExtension(): void {
    const extension = this.extension;
    if (!extension || !this.mount) return;
    if (this.mountedTag === extension.elementTag && this.mount.firstElementChild) {
      return;
    }
    this.mount.replaceChildren();
    this.mountedTag = '';
    if (!customElements.get(extension.elementTag)) {
      return;
    }
    const element = document.createElement(extension.elementTag) as HTMLElement & {
      openrappterXpedition?: XpeditionExtensionContextV1;
    };
    element.openrappterXpedition = Object.freeze({
      schema: 'openrappter-xpedition-extension-context/1.0',
      product: 'OpenRappter Personal',
      openApp: (appId: string) => {
        this.dispatchEvent(new CustomEvent('open-xpedition-app', {
          detail: { appId },
          bubbles: true,
          composed: true,
        }));
      },
    });
    this.mount.append(element);
    this.mountedTag = extension.elementTag;
  }

  render() {
    const missing = this.extension &&
      !customElements.get(this.extension.elementTag);
    const error = missing
      ? `Extension ${this.extension!.id} is registered, but ` +
        `${this.extension!.elementTag} is not installed in this build.`
      : '';
    return html`
      ${error
        ? html`
            <div class="unavailable" role="status">
              <strong>Extension unavailable</strong>
              <p>${error}</p>
              ${this.extension
                ? html`
                    <p>
                      Declared interfaces:
                      ${this.extension.dataSeams.map((seam) =>
                        html` <code>${seam}</code>`)}
                    </p>
                  `
                : nothing}
            </div>
          `
        : nothing}
      <div class="mount"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-xpedition-extension-host': OpenRappterXpeditionExtensionHost;
  }
}
