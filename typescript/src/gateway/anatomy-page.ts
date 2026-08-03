/**
 * The anatomy page — one page, three surfaces.
 *
 * Served by the gateway at `/bones`, opened by the dino in a `WKWebView`, and
 * loadable in any browser. One implementation, three surfaces, which is the
 * brainstem parity Kody has asked for every round.
 *
 * It is deliberately a **museum plate**, not a dashboard: a specimen you explore
 * with the mouse, with pinned callouts and placards, in the register of a school
 * biology poster. His words were "just like it was an anatomy of a real thing
 * you were exploring at school or at a museum".
 *
 * Self-contained by requirement — no CDN, no webfont fetch, no external script.
 * The whole product thesis is that it works offline, so the page that explains
 * the product has to render with the network off.
 */

import type { Anatomy } from './anatomy.js';

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Where each organ's callout pin sits, and where its leader line attaches to the
 * figure. Hand-placed so the lines never cross the body or each other.
 */
const PINS: Record<string, { n: number; pin: [number, number]; anchor: [number, number]; side: 'l' | 'r' }> = {
  skull:  { n: 1,  pin: [966, 108], anchor: [806, 146], side: 'r' },
  brain:  { n: 2,  pin: [966, 176], anchor: [800, 140], side: 'r' },
  senses: { n: 3,  pin: [966, 244], anchor: [860, 160], side: 'r' },
  heart:  { n: 4,  pin: [966, 330], anchor: [624, 292], side: 'r' },
  claws:  { n: 5,  pin: [966, 402], anchor: [676, 306], side: 'r' },
  spine:  { n: 6,  pin: [452, 62],  anchor: [520, 226], side: 'r' },
  hide:   { n: 7,  pin: [162, 130], anchor: [300, 274], side: 'l' },
  blood:  { n: 8,  pin: [162, 206], anchor: [540, 288], side: 'l' },
  gut:    { n: 9,  pin: [162, 420], anchor: [486, 326], side: 'l' },
  vault:  { n: 10, pin: [162, 492], anchor: [418, 314], side: 'l' },
};

const STATE_WORD: Record<string, string> = {
  alive: 'alive',
  degraded: 'degraded',
  absent: 'absent',
  sealed: 'sealed',
};

export function renderAnatomyPage(a: Anatomy): string {
  const organById = new Map(a.organs.map(o => [o.id, o]));
  const title = a.vitals.name ?? 'openrappter';

  // ── Callout pins + leader lines ────────────────────────────────────────────
  const callouts = a.organs
    .filter(o => PINS[o.id])
    .map(o => {
      const p = PINS[o.id];
      const [px, py] = p.pin;
      const [ax, ay] = p.anchor;
      // Elbow the leader line so it reads as a drafted plate rather than a
      // straight tether: out horizontally from the pin, then to the anchor.
      const midX = p.side === 'r' ? px - 28 : px + 28;
      return `
      <g class="callout" data-organ="${esc(o.id)}">
        <path class="leader" d="M ${px} ${py} L ${midX} ${py} L ${ax} ${ay}" />
        <circle class="pin-dot" cx="${ax}" cy="${ay}" r="4.5" />
        <circle class="pin-ring" cx="${px}" cy="${py}" r="15" />
        <text class="pin-num" x="${px}" y="${py + 5.5}">${p.n}</text>
        <text class="pin-label ${p.side === 'r' ? 'lr' : 'll'}" x="${p.side === 'r' ? px + 24 : px - 24}" y="${py - 2}">${esc(o.plain)}</text>
        <text class="pin-sub ${p.side === 'r' ? 'lr' : 'll'}" x="${p.side === 'r' ? px + 24 : px - 24}" y="${py + 16}">${esc(o.anatomical)}</text>
      </g>`;
    })
    .join('');

  // ── Placards, one per organ, revealed on hover ─────────────────────────────
  const placards = a.organs
    .map(o => `
      <div class="placard" id="pc-${esc(o.id)}" data-state="${esc(o.state)}">
        <div class="pc-head">
          <div>
            <div class="pc-anat">${esc(o.anatomical)}</div>
            <div class="pc-plain">${esc(o.plain)}</div>
          </div>
          <div class="pc-state s-${esc(o.state)}">${esc(STATE_WORD[o.state] ?? o.state)}</div>
        </div>
        <div class="pc-reading">${esc(o.reading)}</div>
        <p class="pc-consequence">${esc(o.consequence)}</p>
        ${o.detail.length ? `<ul class="pc-detail">${o.detail
          .map(d => {
            const sub = d.sub && d.sub.length > 120 ? d.sub.slice(0, 117).trimEnd() + '…' : d.sub;
            return `<li><span class="d-label">${esc(d.label)}</span>${sub ? `<span class="d-sub">${esc(sub)}</span>` : ''}</li>`;
          })
          .join('')}</ul>` : ''}
        ${o.files.length ? `<div class="pc-files"><div class="pc-files-h">underneath</div>${o.files
          .map(f => `<div class="pc-file${f.missing ? ' missing' : ''}${f.secret ? ' sealed' : ''}">
            <span class="f-name">${esc(f.name)}</span>
            <span class="f-meta">${f.missing ? 'missing' : f.secret ? 'sealed' : `${f.bytes} B`}</span>
          </div>`)
          .join('')}</div>` : ''}
      </div>`)
    .join('');

  const vitalItems: [string, string, string][] = [
    ['state', a.vitals.awake ? 'awake' : 'asleep', a.vitals.awake ? 'ok' : 'warn'],
    ['mind', a.vitals.backend, a.vitals.awake ? 'ok' : 'warn'],
    ['uptime', a.vitals.uptime, 'plain'],
    ['next beat', a.vitals.heartbeat, 'plain'],
    ['capabilities', String(a.vitals.agentCount), 'plain'],
    ['name', a.vitals.name ?? 'unnamed', a.vitals.name ? 'ok' : 'warn'],
  ];

  const dinoMood = !a.vitals.awake ? '😴' : a.vitals.backend === 'none' ? '🦖' : '🦖';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Anatomy of a rappter</title>
<style>
  /* Editorial system from frame.md. Font stacks are local-only on purpose —
     the page must render with the network off. */
  :root {
    --ink: #141413;
    --cream: #FAF9F5;
    --tile: #EFE9DE;
    --coral: #CC785C;
    --coral-deep: #9A5233;
    --navy: #181715;
    --hair: rgba(20,20,19,0.12);
    --hair-strong: rgba(20,20,19,0.20);
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--cream); color: var(--ink); }
  body { font-family: var(--sans); -webkit-font-smoothing: antialiased; padding: 40px 44px 60px; }

  .kicker { font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: 0.16em;
            text-transform: uppercase; display: flex; align-items: center; gap: 12px; }
  .spike { color: var(--coral); }
  .rule { height: 1px; background: var(--hair); margin: 14px 0 0; }

  h1 { font-family: var(--serif); font-size: 54px; font-weight: 400; letter-spacing: -0.02em;
       line-height: 1.04; margin: 22px 0 4px; }
  .sub { font-family: var(--serif); font-style: italic; font-size: 21px; color: rgba(20,20,19,0.66); }

  /* ── the patient chart ── */
  .vitals { display: flex; flex-wrap: wrap; gap: 0; margin: 26px 0 8px;
            border: 1px solid var(--hair); border-radius: 10px; background: var(--tile); overflow: hidden; }
  .vital { flex: 1 1 150px; padding: 14px 18px; border-right: 1px solid var(--hair); }
  .vital:last-child { border-right: 0; }
  .v-label { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
             color: rgba(20,20,19,0.5); }
  .v-value { font-family: var(--serif); font-size: 27px; line-height: 1.15; margin-top: 5px; }
  .v-value.warn { color: var(--coral-deep); }
  .v-why { font-family: var(--mono); font-size: 11px; color: rgba(20,20,19,0.55); margin-top: 4px; }

  /* ── the plate ── */
  .plate { display: grid; grid-template-columns: minmax(0,1fr) 372px; gap: 30px; margin-top: 26px; align-items: start; }
  .specimen { border: 1px solid var(--hair); border-radius: 12px; background: var(--tile);
              position: relative; overflow: hidden; }
  .specimen-cap { position: absolute; left: 20px; top: 16px; font-family: var(--mono); font-size: 10.5px;
                  letter-spacing: 0.16em; text-transform: uppercase; color: rgba(20,20,19,0.45); }
  svg.figure { display: block; width: 100%; height: auto; }

  /* body */
  .body-fill { fill: var(--navy); }
  .body-line { fill: none; stroke: var(--navy); stroke-width: 2; }

  /* organs sit inside the silhouette as a cutaway */
  .organ { cursor: pointer; transition: opacity 140ms ease; }
  .organ .shape { fill: rgba(250,249,245,0.22); stroke: rgba(250,249,245,0.45); stroke-width: 1.4;
                  transition: fill 160ms ease, stroke 160ms ease; }
  .organ .shape.vessel { fill: none; stroke-width: 2.2; }
  .organ.outside .shape { fill: none; stroke: rgba(20,20,19,0.3); stroke-width: 2.4; }
  .body-far { fill: rgba(20,20,19,0.42); }
  .jaw { fill: rgba(20,20,19,0.72); }
  .organ:hover .shape, .organ.on .shape { fill: var(--coral); stroke: var(--coral); }
  .organ.on.sealed .shape { fill: rgba(204,120,92,0.35); stroke: var(--coral); }

  .callout { cursor: pointer; }
  .leader { fill: none; stroke: var(--hair-strong); stroke-width: 1; }
  .pin-dot { fill: rgba(20,20,19,0.35); }
  .pin-ring { fill: var(--cream); stroke: var(--hair-strong); stroke-width: 1; }
  .pin-num { font-family: var(--mono); font-size: 12px; font-weight: 600; text-anchor: middle; fill: var(--ink); }
  .pin-label { font-family: var(--serif); font-size: 19px; fill: var(--ink); }
  .pin-sub { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
             fill: rgba(20,20,19,0.45); }
  .pin-label.ll, .pin-sub.ll { text-anchor: end; }
  .callout.on .leader { stroke: var(--coral); }
  .callout.on .pin-ring { stroke: var(--coral); fill: var(--coral); }
  .callout.on .pin-num { fill: var(--cream); }
  .callout.on .pin-dot { fill: var(--coral); }
  .callout.on .pin-label { fill: var(--coral-deep); }

  /* ── placard column ── */
  .placards { position: sticky; top: 40px; }
  .placard { display: none; border: 1px solid var(--hair); border-radius: 12px; background: var(--cream);
             padding: 22px 22px 18px; box-shadow: 0 1px 3px rgba(20,20,19,0.07), 0 6px 22px rgba(20,20,19,0.05); }
  .placard.on { display: block; }
  .pc-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 14px;
             border-bottom: 1px solid var(--hair); padding-bottom: 13px; }
  .pc-anat { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
             color: rgba(20,20,19,0.45); }
  .pc-plain { font-family: var(--serif); font-size: 33px; line-height: 1.1; margin-top: 3px; }
  .pc-state { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase;
              padding: 5px 10px; border-radius: 999px; white-space: nowrap; }
  .s-alive { background: rgba(20,20,19,0.06); color: rgba(20,20,19,0.7); }
  .s-degraded, .s-absent { background: rgba(204,120,92,0.16); color: var(--coral-deep); }
  .s-sealed { background: var(--navy); color: var(--cream); }
  .pc-reading { font-family: var(--mono); font-size: 16px; margin-top: 14px; color: var(--ink); }
  .pc-consequence { font-size: 15.5px; line-height: 1.5; color: rgba(20,20,19,0.78); margin-top: 10px; }
  .pc-detail { list-style: none; margin-top: 16px; border-top: 1px solid var(--hair); }
  .pc-detail li { display: block; padding: 9px 0; border-bottom: 1px solid var(--hair); }
  .d-label { font-family: var(--sans); font-size: 14.5px; font-weight: 500; display: block; }
  .d-sub { font-family: var(--mono); font-size: 11.5px; line-height: 1.45; color: rgba(20,20,19,0.55);
           display: block; margin-top: 2px; }
  .pc-detail { max-height: 340px; overflow-y: auto; }
  .pc-files { margin-top: 16px; }
  .pc-files-h { font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;
                color: rgba(20,20,19,0.4); margin-bottom: 7px; }
  .pc-file { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 11.5px;
             color: rgba(20,20,19,0.62); padding: 3px 0; }
  .pc-file.missing .f-name { text-decoration: line-through; opacity: 0.55; }
  .pc-file.missing .f-meta, .pc-file.sealed .f-meta { color: var(--coral-deep); }

  .hint { font-family: var(--mono); font-size: 11.5px; color: rgba(20,20,19,0.45); text-align: center;
          margin-top: 14px; letter-spacing: 0.05em; }

  /* ── drop overlay ── */
  #drop { position: fixed; inset: 0; background: rgba(250,249,245,0.94); display: none;
          align-items: center; justify-content: center; z-index: 50; }
  #drop.on { display: flex; }
  .drop-card { border: 2px dashed var(--coral); border-radius: 16px; padding: 54px 66px; text-align: center;
               background: var(--cream); }
  .drop-title { font-family: var(--serif); font-size: 42px; }
  .drop-sub { font-family: var(--mono); font-size: 13px; color: rgba(20,20,19,0.6); margin-top: 12px;
              letter-spacing: 0.04em; }
  .drop-warn { font-family: var(--mono); font-size: 11.5px; color: var(--coral-deep); margin-top: 18px; }

  #toast { position: fixed; left: 50%; bottom: 30px; transform: translateX(-50%); z-index: 60;
           max-width: 640px; display: none; border: 1px solid var(--hair); border-radius: 12px;
           background: var(--navy); color: var(--cream); padding: 18px 22px;
           box-shadow: 0 8px 34px rgba(20,20,19,0.22); }
  #toast.on { display: block; }
  #toast .t-title { font-family: var(--serif); font-size: 22px; }
  #toast .t-body { font-family: var(--sans); font-size: 14.5px; margin-top: 6px; color: rgba(250,249,245,0.82);
                   line-height: 1.45; }
  #toast.bad { background: var(--coral-deep); }

  footer { margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--hair);
           font-family: var(--mono); font-size: 11px; color: rgba(20,20,19,0.42);
           display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }

  @media (max-width: 1040px) {
    .plate { grid-template-columns: 1fr; }
    .placards { position: static; }
  }
</style>
</head>
<body>

  <div class="kicker"><span class="spike">✱</span><span>ANATOMY OF A RAPPTER</span></div>
  <div class="rule"></div>

  <h1>${esc(title)}</h1>
  <div class="sub">${a.vitals.awake ? 'A living specimen, read from this machine just now.' : 'Asleep — bones intact, no pulse.'}</div>

  <div class="vitals">
    ${vitalItems.map(([label, value, tone]) => `
    <div class="vital">
      <div class="v-label">${esc(label)}</div>
      <div class="v-value ${tone === 'warn' ? 'warn' : ''}">${esc(value)}</div>
    </div>`).join('')}
  </div>
  <div class="v-why" style="padding: 6px 2px 0">${esc(a.vitals.backendReason)}</div>

  <div class="plate">
    <div class="specimen">
      <div class="specimen-cap">SPECIMEN · ${esc(a.home)}</div>
      <svg class="figure" viewBox="0 0 1120 580" role="img" aria-label="Anatomical figure of a rappter">

        <!-- ── the animal ───────────────────────────────────────────────── -->
        <g class="beast">
          <!-- far leg, set back and darkened so the stance reads as depth -->
          <path class="body-far" d="M 448 330 C 470 348 482 384 482 424 C 482 452 476 474 466 490
                                    L 508 490 C 516 470 520 446 520 420 C 520 380 510 348 494 326 Z" />
          <path class="body-far" d="M 456 484 C 444 494 440 504 444 512 L 524 512 C 526 500 518 490 506 484 Z" />

          <!-- One continuous silhouette. Back line and belly line are kept far
               apart on purpose: the first attempt drew them close together and
               the animal came out as a thin diagonal band rather than a
               deep-chested biped. -->
          <path class="body-fill" d="
            M 906 170
            C 902 150 888 132 864 120
            C 836 106 800 102 772 110
            C 748 118 736 134 734 154
            C 728 180 714 200 694 216
            C 662 240 618 252 564 258
            C 498 266 438 272 386 282
            C 314 278 212 286 128 306
            C 92 314 60 324 40 332
            C 64 334 104 330 138 324
            C 216 312 312 306 380 310
            C 396 334 412 354 434 368
            C 470 394 520 404 570 396
            C 618 388 660 364 686 328
            C 700 308 708 286 716 266
            C 724 242 736 222 752 210
            L 800 198
            C 842 192 880 184 906 170 Z" />

          <!-- jaw, so the head reads as a skull and not a beak -->
          <!-- the mouth line: without it the wedge reads as a beak -->
          <path class="body-line" d="M 906 170 C 868 180 822 186 778 186 L 748 184" />
          <!-- lower jaw, giving the head depth -->
          <path class="body-fill jaw" d="M 748 184 C 792 198 848 194 906 170
                                         C 880 184 842 192 800 198 L 752 210 Z" />
          <path class="body-line" d="M 828 116 C 850 124 870 138 882 154" />

          <!-- near leg -->
          <path class="body-fill" d="M 496 330 C 534 342 562 370 570 406
                                     C 578 444 570 480 550 508 L 604 508
                                     C 622 472 628 430 618 390 C 606 342 570 312 522 306 Z" />
          <path class="body-fill" d="M 540 502 C 526 514 522 526 526 536 L 622 536
                                     C 624 522 616 510 600 502 Z" />

          <!-- forelimb: small, two-clawed -->
          <path class="body-fill" d="M 662 284 C 682 292 698 306 706 322
                                     C 710 330 706 336 700 334 C 688 330 676 316 666 302 Z" />
          <path class="body-line" d="M 704 328 L 722 340 M 700 334 L 714 348" />
        </g>

        <!-- ── organs, as a cutaway ─────────────────────────────────────── -->
        <g class="organ" data-organ="skull">
          <path class="shape" d="M 900 170 C 896 150 882 134 860 124 C 834 112 800 108 774 116
                                 C 752 124 740 138 738 156 C 736 172 744 184 760 190
                                 C 800 196 850 188 900 170 Z" />
        </g>
        <g class="organ" data-organ="brain">
          <ellipse class="shape" cx="792" cy="146" rx="26" ry="18" />
        </g>
        <g class="organ" data-organ="senses">
          <circle class="shape" cx="836" cy="146" r="10" />
          <path class="shape" d="M 878 158 C 890 158 898 162 900 170 C 890 176 878 176 870 172 Z" />
        </g>
        <g class="organ" data-organ="spine">
          <path class="shape" d="M 726 176 C 712 196 692 210 668 222 C 626 242 578 250 526 256
                                 C 464 262 410 268 360 278 L 356 264 C 406 254 462 248 524 242
                                 C 576 236 622 228 660 210 C 686 198 704 184 716 166 Z" />
        </g>
        <g class="organ" data-organ="heart">
          <path class="shape" d="M 606 276 C 616 262 634 264 638 278 C 642 264 660 262 668 276
                                 C 676 292 652 316 636 326 C 618 316 598 292 606 276 Z" />
        </g>
        <g class="organ" data-organ="blood">
          <path class="shape vessel" d="M 610 288 C 566 296 516 306 470 316" />
          <path class="shape vessel" d="M 618 314 C 580 332 536 348 494 358" />
          <path class="shape vessel" d="M 650 274 C 676 266 696 248 710 224" />
          <path class="shape vessel" d="M 470 316 C 416 320 356 316 306 306" />
        </g>
        <g class="organ" data-organ="gut">
          <path class="shape" d="M 432 306 C 468 298 516 302 546 320 C 576 338 574 366 546 376
                                 C 510 388 458 378 434 358 C 416 344 414 316 432 306 Z" />
        </g>
        <g class="organ" data-organ="vault">
          <path class="shape" d="M 384 292 L 430 292 L 440 320 L 422 348 L 384 348 L 372 320 Z" />
          <path class="shape" d="M 396 312 L 416 312 L 416 332 L 396 332 Z" fill="none" />
        </g>
        <g class="organ" data-organ="claws">
          <path class="shape" d="M 664 286 C 684 294 700 308 708 324 C 712 332 708 338 702 336
                                 C 690 332 678 318 668 304 Z" />
        </g>
        <g class="organ outside" data-organ="hide">
          <path class="shape vessel" d="M 762 124 C 744 136 734 150 730 166 C 722 186 706 202 686 214
                                        C 652 234 606 244 552 250 C 496 256 442 262 392 272
                                        C 320 268 216 276 132 296 C 96 304 64 314 44 322" />
        </g>

        <!-- the thing he clicked to get here -->
        <text x="52" y="72" font-size="34">${dinoMood}</text>

        <!-- ── callouts ──────────────────────────────────────────────────── -->
        ${callouts}
      </svg>
    </div>

    <div class="placards">
      ${placards}
      <div class="hint">hover a part of the specimen</div>
    </div>
  </div>

  <footer>
    <span>read ${esc(a.generatedAt)}</span>
    <span>drop a .py agent anywhere on this page to teach it something new</span>
  </footer>

  <div id="drop">
    <div class="drop-card">
      <div class="drop-title">Drag &amp; Drop .py Agents Here</div>
      <div class="drop-sub">drop an agent file to instantly teach me new things</div>
      <div class="drop-warn">this runs code on your machine</div>
    </div>
  </div>

  <div id="toast"><div class="t-title"></div><div class="t-body"></div></div>

<script>
(function () {
  // ── hover to explore ──────────────────────────────────────────────────────
  var organs = document.querySelectorAll('[data-organ]');
  var hint = document.querySelector('.hint');
  var current = null;

  function show(id) {
    if (current === id) return;
    current = id;
    document.querySelectorAll('.placard.on').forEach(function (p) { p.classList.remove('on'); });
    document.querySelectorAll('.organ.on, .callout.on').forEach(function (n) { n.classList.remove('on'); });
    var card = document.getElementById('pc-' + id);
    if (card) { card.classList.add('on'); if (hint) hint.style.display = 'none'; }
    document.querySelectorAll('[data-organ="' + id + '"]').forEach(function (n) { n.classList.add('on'); });
  }
  function clear() {
    current = null;
    document.querySelectorAll('.placard.on').forEach(function (p) { p.classList.remove('on'); });
    document.querySelectorAll('.organ.on, .callout.on').forEach(function (n) { n.classList.remove('on'); });
    if (hint) hint.style.display = '';
  }
  organs.forEach(function (el) {
    el.addEventListener('mouseenter', function () { show(el.getAttribute('data-organ')); });
    el.addEventListener('click', function () { show(el.getAttribute('data-organ')); });
  });
  var plate = document.querySelector('.specimen');
  if (plate) plate.addEventListener('mouseleave', function () { if (!pinned) clear(); });

  // Deep link to one organ: /bones?organ=heart. Makes a specific finding
  // linkable, and gives the acceptance check something to assert against
  // without driving a synthetic mouse.
  var pinned = null;
  var wanted = new URLSearchParams(location.search).get('organ');
  if (wanted && document.getElementById('pc-' + wanted)) { pinned = wanted; show(wanted); }

  // ── drag & drop hot-load ──────────────────────────────────────────────────
  // Vocabulary and gesture deliberately match the grail brainstem, because the
  // ask was parity with it.
  var overlay = document.getElementById('drop');
  var toast = document.getElementById('toast');

  function say(title, body, bad) {
    toast.querySelector('.t-title').textContent = title;
    toast.querySelector('.t-body').textContent = body;
    toast.classList.toggle('bad', !!bad);
    toast.classList.add('on');
    clearTimeout(say._t);
    say._t = setTimeout(function () { toast.classList.remove('on'); }, 9000);
  }

  window.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
      overlay.classList.add('on');
    }
  });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault();
    // dragleave fires for every element crossed; only hide when the pointer
    // actually leaves the window, or the overlay sticks after a non-drop.
    if (e.relatedTarget === null || e.clientX <= 0 || e.clientY <= 0 ||
        e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
      overlay.classList.remove('on');
    }
  });

  window.addEventListener('drop', async function (e) {
    e.preventDefault();
    overlay.classList.remove('on');
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!/\\.(py|js)$/.test(file.name)) {
        say('That is not an agent', file.name + ' is not a .py or .js file, so there is nothing to load.', true);
        continue;
      }
      // The trust boundary, stated at the moment of the drop.
      if (!confirm('Install ' + file.name + '?\\n\\nThis runs code on your machine.')) continue;

      try {
        var text = await file.text();
        var res = await fetch('/agents/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, contents: text })
        });
        var data = await res.json();
        if (data.status === 'ok') {
          var names = (data.learned || []).map(function (l) { return l.name; }).join(', ');
          var what = (data.learned || [])[0];
          say(
            'I can ' + (what && what.description ? what.description.charAt(0).toLowerCase() + what.description.slice(1).replace(/\\.$/, '') : 'do something new') + '.',
            'Learned ' + names + ' from ' + data.file + '. Ask me in your next message — no restart needed.'
          );
          setTimeout(function () { location.reload(); }, 2200);
        } else {
          say('I could not learn that', data.error || 'unknown error', true);
        }
      } catch (err) {
        say('I could not learn that', String(err), true);
      }
    }
  });
})();
</script>
</body>
</html>`;
}
