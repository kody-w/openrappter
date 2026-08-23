import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  approveProcedure,
  loadCases,
  loadPatient,
  operate,
  rejectProcedure,
  sendTurn as requestSurgeonTurn,
} from '../services/surgeon.js';
import { askPatient } from '../services/patient.js';
import type {
  SurgeonCase,
  SurgeonOption,
  SurgeonPatientSnapshot,
  SurgeonPatientState,
  SurgeonProcedure,
  SurgeonTurn,
} from '../types.js';
import {
  copilotReadiness,
  type CopilotReadinessSnapshot,
} from '../services/copilot-readiness.js';

@customElement('openrappter-surgeon')
export class OpenRappterSurgeon extends LitElement {
  static styles = css`
    :host {
      --theater: #050711;
      --theater-soft: #0b1020;
      --glass: rgba(13, 20, 39, 0.72);
      --line: rgba(130, 170, 255, 0.16);
      --cyan: #58f5d2;
      --blue: #6fa8ff;
      --violet: #a78bfa;
      --pink: #f472b6;
      --amber: #fbbf24;
      --red: #fb7185;
      display: block;
      min-height: 100vh;
      color: #f7f9ff;
      background:
        radial-gradient(circle at 18% 22%, rgba(88, 245, 210, 0.12), transparent 32rem),
        radial-gradient(circle at 82% 18%, rgba(167, 139, 250, 0.15), transparent 31rem),
        radial-gradient(circle at 56% 88%, rgba(244, 114, 182, 0.09), transparent 28rem),
        var(--theater);
      overflow: hidden;
    }

    * {
      box-sizing: border-box;
    }

    button,
    textarea,
    input {
      font: inherit;
    }

    button {
      color: inherit;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
      position: relative;
      isolation: isolate;
    }

    .noise {
      position: fixed;
      inset: 0;
      z-index: -1;
      pointer-events: none;
      opacity: 0.25;
      background-image:
        linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, black, transparent 86%);
    }

    .topbar {
      min-height: 72px;
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 15px clamp(18px, 3vw, 42px);
      border-bottom: 1px solid var(--line);
      background: rgba(5, 7, 17, 0.76);
      backdrop-filter: blur(24px);
      z-index: 5;
    }

    .mark {
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(88, 245, 210, 0.35);
      border-radius: 14px;
      background: linear-gradient(145deg, rgba(88,245,210,.14), rgba(111,168,255,.08));
      box-shadow: 0 0 28px rgba(88, 245, 210, 0.12);
      font-size: 22px;
    }

    .brand {
      min-width: 0;
    }

    .brand strong {
      display: block;
      font-size: 15px;
      letter-spacing: 0.02em;
    }

    .brand span {
      color: #8d98b5;
      font-size: 12px;
    }

    .tagline {
      margin-left: auto;
      color: #d7deef;
      font-size: clamp(13px, 1.2vw, 16px);
      font-weight: 560;
      letter-spacing: 0.02em;
    }

    .top-actions {
      display: flex;
      gap: 8px;
    }

    .quiet-button,
    .icon-button {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.035);
      border-radius: 12px;
      padding: 9px 13px;
      cursor: pointer;
      transition: 150ms ease;
    }

    .quiet-button:hover,
    .icon-button:hover {
      border-color: rgba(88, 245, 210, 0.4);
      background: rgba(88, 245, 210, 0.08);
      transform: translateY(-1px);
    }

    .operating-room {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(330px, 0.82fr) minmax(480px, 1.18fr);
    }

    .patient-wing {
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: clamp(24px, 4vw, 56px);
      border-right: 1px solid var(--line);
      overflow: auto;
    }

    .eyebrow {
      color: var(--cyan);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }

    h1 {
      max-width: 670px;
      margin: 12px 0 8px;
      font-size: clamp(33px, 4.5vw, 66px);
      line-height: 0.97;
      letter-spacing: -0.055em;
      font-weight: 630;
    }

    .premise {
      max-width: 580px;
      color: #9da9c5;
      font-size: 15px;
      line-height: 1.65;
    }

    .premise strong {
      color: #eef3ff;
      font-weight: 600;
    }

    .patient {
      position: relative;
      min-height: 350px;
      display: grid;
      place-items: center;
      margin: 24px 0 18px;
    }

    .orbit {
      position: absolute;
      width: min(29vw, 340px);
      aspect-ratio: 1;
      border: 1px solid rgba(111, 168, 255, 0.2);
      border-radius: 48% 52% 44% 56% / 57% 40% 60% 43%;
      animation: orbit 18s linear infinite;
    }

    .orbit:nth-child(2) {
      width: min(23vw, 275px);
      border-color: rgba(244, 114, 182, 0.18);
      animation-direction: reverse;
      animation-duration: 13s;
      border-radius: 61% 39% 55% 45% / 42% 58% 42% 58%;
    }

    .organism {
      position: relative;
      width: 180px;
      height: 230px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(88, 245, 210, 0.34);
      border-radius: 47% 53% 50% 50% / 31% 32% 68% 69%;
      background:
        radial-gradient(circle at 45% 35%, rgba(88,245,210,.22), transparent 28%),
        radial-gradient(circle at 62% 58%, rgba(167,139,250,.22), transparent 35%),
        rgba(8, 14, 29, 0.82);
      box-shadow:
        inset 0 0 48px rgba(88, 245, 210, 0.07),
        0 0 80px rgba(111, 168, 255, 0.12);
      animation: breathe 4.6s ease-in-out infinite;
    }

    .organism::before,
    .organism::after {
      content: '';
      position: absolute;
      top: 30%;
      width: 58px;
      height: 92px;
      border: 1px solid rgba(111,168,255,.22);
      background: rgba(111,168,255,.04);
    }

    .organism::before {
      right: 96%;
      border-radius: 70% 30% 44% 56%;
      transform: rotate(-18deg);
    }

    .organism::after {
      left: 96%;
      border-radius: 30% 70% 56% 44%;
      transform: rotate(18deg);
    }

    .patient-core {
      text-align: center;
      filter: drop-shadow(0 0 18px rgba(88,245,210,.3));
    }

    .patient-core .dino {
      display: block;
      font-size: 42px;
    }

    .patient-core b {
      display: block;
      margin-top: 8px;
      font-size: 12px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .patient-core small {
      display: block;
      margin-top: 4px;
      color: #8c98b4;
      font-size: 11px;
    }

    .state {
      margin-top: 9px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 9px;
      border-radius: 999px;
      background: rgba(88,245,210,.09);
      color: var(--cyan);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
    }

    .state::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 10px currentColor;
    }

    .state.degraded,
    .state.dormant {
      color: var(--amber);
      background: rgba(251,191,36,.09);
    }

    .state.critical {
      color: var(--red);
      background: rgba(251,113,133,.09);
    }

    .tissues {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .tissue {
      min-width: 0;
      padding: 11px 12px;
      border: 1px solid var(--line);
      border-radius: 13px;
      background: rgba(255,255,255,.025);
    }

    .tissue-head {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .tissue-dot {
      flex: 0 0 auto;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--cyan);
      box-shadow: 0 0 9px rgba(88,245,210,.7);
    }

    .tissue[data-state='degraded'] .tissue-dot,
    .tissue[data-state='dormant'] .tissue-dot {
      background: var(--amber);
      box-shadow: 0 0 9px rgba(251,191,36,.6);
    }

    .tissue[data-state='critical'] .tissue-dot {
      background: var(--red);
      box-shadow: 0 0 9px rgba(251,113,133,.7);
    }

    .tissue b {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      font-weight: 650;
    }

    .tissue p {
      margin: 6px 0 0;
      color: #7f8aa5;
      font-size: 10px;
      line-height: 1.35;
    }

    .surgeon-wing {
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: linear-gradient(180deg, rgba(10,15,31,.64), rgba(5,7,17,.76));
    }

    .surgeon-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 19px clamp(20px, 3vw, 38px);
      border-bottom: 1px solid var(--line);
      flex-wrap: wrap;
    }

    /* The title must be allowed to shrink, and the voice switch must be pushed
       away from it. Without this the two buttons sat ON TOP of the subtitle —
       visible immediately in a screenshot of the running page, and in nothing
       else. */
    .surgeon-header .surgeon-title {
      min-width: 0;
      flex: 1 1 auto;
    }

    .surgeon-header .toolbar {
      margin-left: auto;
      flex: 0 0 auto;
    }

    .copilot {
      width: 38px;
      height: 38px;
      display: grid;
      place-items: center;
      border: 1px solid rgba(167,139,250,.34);
      border-radius: 13px;
      background: rgba(167,139,250,.1);
      color: #d8ccff;
      font-size: 18px;
      box-shadow: 0 0 26px rgba(167,139,250,.11);
    }

    .surgeon-title b {
      display: block;
      font-size: 13px;
    }

    .surgeon-title span {
      color: #808ca8;
      font-size: 11px;
    }

    .case-status {
      margin-left: auto;
      padding: 6px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: #9da9c5;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .transcript {
      min-height: 0;
      overflow: auto;
      padding: clamp(22px, 3vw, 40px);
      scroll-behavior: smooth;
    }

    .welcome {
      max-width: 740px;
      margin: 0 auto;
      padding-top: clamp(16px, 5vh, 72px);
    }

    .welcome h2 {
      margin: 12px 0;
      font-size: clamp(27px, 3vw, 44px);
      line-height: 1.08;
      letter-spacing: -0.04em;
      font-weight: 590;
    }

    .welcome p {
      color: #97a3bd;
      line-height: 1.7;
    }

    .starter-portals,
    .portals {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      margin-top: 22px;
    }

    .portal {
      min-height: 58px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(135deg, rgba(111,168,255,.055), rgba(167,139,250,.035));
      text-align: left;
      cursor: pointer;
      transition: 160ms ease;
    }

    .portal:hover:not(:disabled) {
      border-color: rgba(111,168,255,.44);
      background: linear-gradient(135deg, rgba(111,168,255,.11), rgba(167,139,250,.075));
      transform: translateY(-2px);
    }

    .portal:disabled {
      opacity: .55;
      cursor: wait;
    }

    .portal span:first-child {
      font-size: 12px;
      font-weight: 580;
    }

    .portal .arrow {
      color: var(--blue);
    }

    .exchange {
      max-width: 780px;
      margin: 0 auto 28px;
    }

    .user-line {
      margin: 0 0 12px auto;
      max-width: 80%;
      width: fit-content;
      padding: 10px 13px;
      border: 1px solid rgba(111,168,255,.2);
      border-radius: 16px 16px 4px 16px;
      background: rgba(111,168,255,.08);
      color: #cbd7ef;
      font-size: 12px;
      line-height: 1.5;
    }

    .surgeon-line {
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 4px 18px 18px 18px;
      background: var(--glass);
      box-shadow: 0 18px 60px rgba(0,0,0,.14);
    }

    .surgeon-line.error {
      border-color: rgba(251,113,133,.28);
    }

    .turn-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      color: var(--violet);
      font-size: 10px;
      font-weight: 760;
      letter-spacing: .12em;
      text-transform: uppercase;
    }

    .surgeon-copy {
      color: #e7ebf6;
      font-size: 14px;
      line-height: 1.72;
      white-space: pre-wrap;
    }

    .diagnosis {
      margin-top: 15px;
      padding: 12px 14px;
      border-left: 2px solid var(--cyan);
      background: rgba(88,245,210,.035);
      color: #9eabc4;
      font-size: 11px;
      line-height: 1.55;
    }

    .diagnosis.warning {
      border-color: var(--amber);
      background: rgba(251,191,36,.035);
    }

    .diagnosis.critical {
      border-color: var(--red);
      background: rgba(251,113,133,.04);
    }

    .diagnosis b {
      color: #e9edf7;
    }

    .procedure {
      margin-top: 16px;
      padding: 16px;
      border: 1px solid rgba(244,114,182,.24);
      border-radius: 15px;
      background: linear-gradient(145deg, rgba(244,114,182,.065), rgba(167,139,250,.04));
    }

    .procedure-head {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }

    .procedure.superseded {
      border-color: var(--line);
      background: rgba(255, 255, 255, 0.02);
      opacity: 0.62;
    }

    .procedure-head h3 {
      margin: 0;
      font-size: 14px;
    }

    .procedure-head p {
      margin: 5px 0 0;
      color: #9aa6bf;
      font-size: 11px;
      line-height: 1.5;
    }

    .risk {
      flex: 0 0 auto;
      margin-left: auto;
      padding: 4px 7px;
      border-radius: 7px;
      background: rgba(88,245,210,.1);
      color: var(--cyan);
      font-size: 9px;
      font-weight: 760;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .risk.medium {
      color: var(--amber);
      background: rgba(251,191,36,.1);
    }

    .risk.high {
      color: var(--red);
      background: rgba(251,113,133,.1);
    }

    .procedure ol,
    .evidence ul {
      margin: 13px 0;
      padding-left: 21px;
      color: #aab4ca;
      font-size: 11px;
      line-height: 1.6;
    }

    .digest {
      color: #68748f;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 9px;
      word-break: break-all;
    }

    .confirmation {
      width: 100%;
      margin-top: 12px;
      padding: 10px 11px;
      border: 1px solid var(--line);
      border-radius: 10px;
      outline: none;
      background: rgba(0,0,0,.2);
      color: #fff;
      font-size: 11px;
    }

    .confirmation:focus {
      border-color: rgba(251,113,133,.5);
    }

    .procedure-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    .primary,
    .danger,
    .secondary {
      border-radius: 10px;
      padding: 9px 12px;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 11px;
      font-weight: 650;
    }

    .primary {
      background: var(--cyan);
      color: #04100e;
    }

    .secondary {
      border-color: var(--line);
      background: rgba(255,255,255,.035);
    }

    .danger {
      border-color: rgba(251,113,133,.24);
      background: rgba(251,113,133,.08);
      color: #ffafbc;
    }

    .primary:disabled,
    .danger:disabled,
    .secondary:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    .outcome {
      max-width: 780px;
      margin: -12px auto 28px;
      padding: 14px 16px;
      border: 1px solid rgba(88,245,210,.2);
      border-radius: 14px;
      background: rgba(88,245,210,.045);
    }

    .outcome.needs_attention,
    .outcome.failed {
      border-color: rgba(251,191,36,.24);
      background: rgba(251,191,36,.045);
    }

    .outcome b {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .outcome p {
      margin: 8px 0 0;
      color: #a4aec4;
      font-size: 11px;
      line-height: 1.55;
    }

    .evidence {
      margin-top: 10px;
    }

    .evidence summary {
      color: #8793ae;
      cursor: pointer;
      font-size: 10px;
      font-weight: 650;
      letter-spacing: .05em;
    }

    .thinking {
      max-width: 780px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #8692ad;
      font-size: 11px;
    }

    .pulse {
      display: flex;
      gap: 4px;
    }

    .pulse i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--violet);
      animation: dot 1.15s ease-in-out infinite;
    }

    .pulse i:nth-child(2) { animation-delay: .13s; }
    .pulse i:nth-child(3) { animation-delay: .26s; }

    .error-banner {
      max-width: 780px;
      margin: 0 auto 15px;
      padding: 10px 12px;
      border: 1px solid rgba(251,113,133,.26);
      border-radius: 11px;
      background: rgba(251,113,133,.07);
      color: #ffb2be;
      font-size: 11px;
    }

    .error-banner button {
      margin-left: 10px;
      border: 1px solid rgba(251,113,133,.32);
      border-radius: 8px;
      padding: 5px 8px;
      background: rgba(251,113,133,.08);
      color: #ffd4db;
      cursor: pointer;
      font-size: 10px;
    }

    .composer-wrap {
      padding: 16px clamp(20px, 3vw, 38px) 22px;
      border-top: 1px solid var(--line);
      background: rgba(5,7,17,.84);
      backdrop-filter: blur(22px);
    }

    .composer {
      max-width: 780px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: end;
      gap: 9px;
      padding: 8px 8px 8px 14px;
      border: 1px solid rgba(111,168,255,.2);
      border-radius: 17px;
      background: rgba(13,20,39,.78);
      box-shadow: 0 16px 60px rgba(0,0,0,.22);
    }

    textarea {
      width: 100%;
      min-height: 40px;
      max-height: 150px;
      resize: none;
      border: 0;
      outline: 0;
      padding: 9px 0;
      color: #f7f9ff;
      background: transparent;
      line-height: 1.45;
    }

    textarea::placeholder {
      color: #66718c;
    }

    .send {
      width: 42px;
      height: 42px;
      display: grid;
      place-items: center;
      border: 0;
      border-radius: 13px;
      background: linear-gradient(135deg, var(--cyan), #72b5ff);
      color: #05100f;
      cursor: pointer;
      font-weight: 900;
      box-shadow: 0 8px 24px rgba(88,245,210,.14);
    }

    .send:disabled {
      opacity: .45;
      cursor: not-allowed;
    }

    .composer-note {
      max-width: 780px;
      margin: 8px auto 0;
      display: flex;
      justify-content: space-between;
      color: #5f6981;
      font-size: 9px;
      letter-spacing: .04em;
    }

    @keyframes orbit {
      to { transform: rotate(360deg); }
    }

    @keyframes breathe {
      0%, 100% { transform: scale(.985); }
      50% { transform: scale(1.025); }
    }

    @keyframes dot {
      0%, 100% { opacity: .25; transform: translateY(0); }
      50% { opacity: 1; transform: translateY(-3px); }
    }

    @media (max-width: 980px) {
      :host {
        overflow: auto;
      }

      .operating-room {
        grid-template-columns: 1fr;
      }

      .patient-wing {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      .patient {
        min-height: 300px;
      }

      .orbit {
        width: 300px;
      }

      .orbit:nth-child(2) {
        width: 240px;
      }

      .surgeon-wing {
        min-height: 720px;
      }
    }

    @media (max-width: 640px) {
      .topbar {
        min-height: 64px;
        gap: 10px;
      }

      .tagline {
        display: none;
      }

      .quiet-button {
        padding: 8px 9px;
        font-size: 0;
      }

      .quiet-button::first-letter {
        font-size: 14px;
      }

      .patient-wing {
        padding: 28px 18px;
      }

      .tissues,
      .starter-portals,
      .portals {
        grid-template-columns: 1fr;
      }

      .patient {
        min-height: 270px;
      }

      .organism {
        width: 145px;
        height: 185px;
      }

      .orbit {
        width: 250px;
      }

      .orbit:nth-child(2) {
        width: 200px;
      }

      .transcript {
        padding: 22px 15px;
      }

      .user-line {
        max-width: 92%;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .orbit,
      .organism,
      .pulse i {
        animation: none;
      }
    }
  `;

  @state() private patient: SurgeonPatientSnapshot | null = null;
  @state() private patientCase: SurgeonCase | null = null;
  @state() private input = '';
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private confirmation = '';
  @state() private voiceEnabled = false;
  /**
   * Which voice the composer is speaking to. #99.
   *
   * 'surgeon' is Copilot examining the patient — what this screen has always
   * done. 'patient' is OpenRappter answering for itself, which it could not do
   * here at all: every turn went to surgeon.turn and nothing reached the agent.
   */
  @state() private mode: 'surgeon' | 'patient' = 'surgeon';
  @state() private patientTurns: Array<{ q: string; a: string; model?: string }> = [];
  @state() private patientSession = '';
  @state() private copilotStatus: CopilotReadinessSnapshot =
    copilotReadiness.snapshot();
  @state() private staleCopilotCleared = false;
  private unsubscribeCopilot?: () => void;

  private readonly starterOptions: SurgeonOption[] = [
    {
      label: 'Run a full examination',
      value: 'Run a full examination of OpenRappter and tell me what deserves attention.',
    },
    {
      label: 'Inspect the agent cortex',
      value: 'Inspect OpenRappter’s agent cortex for capability gaps and unhealthy behavior.',
    },
    {
      label: 'Trace the nervous system',
      value: 'Trace OpenRappter’s gateway, channels, and scheduled jobs for broken signals.',
    },
    {
      label: 'Ask what to build next',
      value: 'Study the patient and recommend the highest-leverage improvement to build next.',
    },
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeCopilot = copilotReadiness.subscribe((snapshot) => {
      const wasReady = this.copilotStatus.state === 'ready';
      this.copilotStatus = snapshot;
      if (snapshot.state !== 'ready') {
        if (this.patientCase) this.staleCopilotCleared = true;
        this.patientCase = null;
        this.confirmation = '';
      } else if (!wasReady) {
        void this.hydrate();
      }
    });
    void this.hydrate();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeCopilot?.();
  }

  private async hydrate(): Promise<void> {
    try {
      const [patient, cases] = await Promise.all([loadPatient(), loadCases()]);
      this.patient = patient;
      if (this.copilotStatus.state === 'ready') {
        this.patientCase = cases[0] ?? null;
        this.staleCopilotCleared = false;
      } else {
        this.patientCase = null;
        this.staleCopilotCleared = cases.length > 0;
      }
      this.error = null;
    } catch (error) {
      this.error = (error as Error).message;
      this.dispatchEvent(new CustomEvent('copilot-auth-failure', {
        detail: { error },
        bubbles: true,
        composed: true,
      }));
    }
  }

  private navigate(view: string): void {
    this.dispatchEvent(new CustomEvent('navigate', {
      bubbles: true,
      composed: true,
      detail: { view },
    }));
  }

  private newExamination(): void {
    this.patientCase = null;
    this.input = '';
    this.confirmation = '';
    this.error = null;
  }

  /** Ask the patient directly, over the same public /chat wire a neighbor uses. */
  private async askThePatient(value: string): Promise<void> {
    const q = value.trim();
    if (!q || this.busy) return;
    this.busy = true;
    this.error = null;
    this.input = '';
    try {
      const reply = await askPatient(q, this.patientSession || undefined);
      this.patientSession = reply.session_id || this.patientSession;
      this.patientTurns = [...this.patientTurns, { q, a: reply.response, model: reply.model }];
      this.speak(reply.voice_response ?? reply.response);
      await this.updateComplete;
      const t = this.shadowRoot?.querySelector('.transcript');
      if (t) t.scrollTo({ top: t.scrollHeight, behavior: 'smooth' });
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async sendTurn(value = this.input): Promise<void> {
    if (this.mode === 'patient') return this.askThePatient(value);
    if (this.copilotBlocked) {
      this.error = this.copilotStatus.message;
      return;
    }
    const userInput = value.trim();
    if (!userInput || this.busy) return;
    this.busy = true;
    this.error = null;
    this.input = '';
    let result: Awaited<ReturnType<typeof requestSurgeonTurn>>;
    try {
      result = await requestSurgeonTurn(userInput, this.patientCase?.id);
    } catch (error) {
      this.error = (error as Error).message;
      this.dispatchEvent(new CustomEvent('copilot-auth-failure', {
        detail: { error },
        bubbles: true,
        composed: true,
      }));
      this.busy = false;
      return;
    }
    try {
      this.patient = result.patient;
      this.patientCase = result.case;
      this.confirmation = '';
      try {
        this.speak(result.turn.voiceLine);
      } catch (speechError) {
        this.error = (speechError as Error).message;
      }
      await this.updateComplete;
      this.shadowRoot?.querySelector('.transcript')?.scrollTo({
        top: this.shadowRoot.querySelector('.transcript')!.scrollHeight,
        behavior: 'smooth',
      });
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
    }

  }

  private get copilotBlocked(): boolean {
    return this.mode === 'surgeon' && this.copilotStatus.state !== 'ready';
  }

  private onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.sendTurn();
    }
  }

  private async approve(procedure: SurgeonProcedure): Promise<void> {
    if (!this.patientCase || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.patientCase = await approveProcedure(
        this.patientCase.id,
        procedure,
        procedure.risk === 'high' ? this.confirmation : undefined,
      );
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async reject(procedure: SurgeonProcedure): Promise<void> {
    if (!this.patientCase || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.patientCase = await rejectProcedure(this.patientCase.id, procedure);
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async startOperation(procedure: SurgeonProcedure): Promise<void> {
    if (!this.patientCase || this.busy) return;
    this.busy = true;
    this.error = null;
    try {
      this.patientCase = await operate(this.patientCase.id, procedure);
      this.patient = this.patientCase.outcome?.patientAfter ?? await loadPatient();
      const outcome = this.patientCase.outcome;
      if (outcome) this.speak(outcome.summary);
    } catch (error) {
      this.error = (error as Error).message;
      await this.hydrate();
    } finally {
      this.busy = false;
    }
  }

  private speak(text: string): void {
    if (!this.voiceEnabled || !text || !('speechSynthesis' in globalThis)) return;
    try {
      globalThis.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.pitch = 0.94;
      globalThis.speechSynthesis.speak(utterance);
    } catch {
      // Speech is a progressive enhancement; the visible turn remains canonical.
    }
  }

  private renderPatient(): unknown {
    const state = this.patient?.state ?? 'dormant';
    return html`
      <div class="patient" aria-label="OpenRappter patient state: ${state}">
        <div class="orbit"></div>
        <div class="orbit"></div>
        <div class="organism">
          <div class="patient-core">
            <span class="dino">🦖</span>
            <b>OpenRappter</b>
            <small>${this.patient ? `v${this.patient.version}` : 'reading vitals'}</small>
            <span class="state ${state}">${state}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderTissues(): unknown {
    if (!this.patient) return nothing;
    return html`
      <div class="tissues">
        ${this.patient.tissues.map(tissue => html`
          <article class="tissue" data-state=${tissue.status} title=${tissue.summary}>
            <div class="tissue-head">
              <i class="tissue-dot"></i>
              <b>${tissue.label}</b>
            </div>
            <p>${tissue.summary}</p>
          </article>
        `)}
      </div>
    `;
  }

  private renderTurn(userInput: string, turn: SurgeonTurn): unknown {
    return html`
      <section class="exchange">
        <div class="user-line">${userInput}</div>
        <article class="surgeon-line ${turn.kind === 'error' ? 'error' : ''}">
          <div class="turn-meta">
            <span>Copilot surgeon</span>
            <span>·</span>
            <span>${turn.kind}</span>
          </div>
          <div class="surgeon-copy">${turn.response}</div>
          ${turn.diagnosis ? html`
            <div class="diagnosis ${turn.diagnosis.severity}">
              <b>${turn.diagnosis.summary}</b>
              ${turn.diagnosis.findings.length > 0
                ? html`<div>${turn.diagnosis.findings.join(' · ')}</div>`
                : nothing}
            </div>
          ` : nothing}
          ${turn.procedure ? this.renderProcedure(turn.procedure) : nothing}
          ${this.isLatestTurn(turn) && turn.options.length > 0 ? html`
            <div class="portals" aria-label=${turn.prompt}>
              ${turn.options.map(option => html`
                <button
                  class="portal"
                  ?disabled=${this.busy || this.copilotBlocked}
                  @click=${() => this.sendTurn(option.value)}
                >
                  <span>${option.label}</span>
                  <span class="arrow">↗</span>
                </button>
              `)}
            </div>
          ` : nothing}
        </article>
      </section>
    `;
  }

  private renderProcedure(procedure: SurgeonProcedure): unknown {
    const caseProcedure = this.patientCase?.procedure;
    const isCurrent = caseProcedure?.id === procedure.id;
    const current = isCurrent ? caseProcedure : procedure;
    const highRiskReady = current.risk !== 'high'
      || this.confirmation === 'OPERATE OPENRAPPTER';
    return html`
      <section class="procedure ${isCurrent ? '' : 'superseded'}">
        <div class="procedure-head">
          <div>
            <h3>${current.title}</h3>
            <p>${current.summary}</p>
          </div>
          <span class="risk ${current.risk}">${current.risk} risk</span>
        </div>
        <ol>
          ${current.steps.map(step => html`<li>${step}</li>`)}
        </ol>
        <div class="digest">Procedure digest · ${current.digest}</div>

        ${!isCurrent ? html`
          <div class="procedure-actions">
            <span class="case-status">superseded</span>
          </div>
        ` : current.status === 'proposed' ? html`
          ${current.risk === 'high' ? html`
            <input
              class="confirmation"
              aria-label="High risk confirmation"
              placeholder="Type OPERATE OPENRAPPTER"
              .value=${this.confirmation}
              @input=${(event: Event) => {
                this.confirmation = (event.target as HTMLInputElement).value;
              }}
            />
          ` : nothing}
          <div class="procedure-actions">
            <button
              class="primary"
              ?disabled=${this.busy || !highRiskReady}
              @click=${() => this.approve(current)}
            >Approve exact procedure</button>
            <button
              class="danger"
              ?disabled=${this.busy || this.copilotBlocked}
              @click=${() => this.reject(current)}
            >Reject</button>
          </div>
        ` : current.status === 'approved' ? html`
          <div class="procedure-actions">
            <button
              class="primary"
              ?disabled=${this.busy || this.copilotStatus.state !== 'ready'}
              @click=${() => this.startOperation(current)}
            >Start approved operation</button>
          </div>
        ` : html`
          <div class="procedure-actions">
            <span class="case-status">${current.status.replace('_', ' ')}</span>
          </div>
        `}
      </section>
    `;
  }

  private renderOutcome(): unknown {
    const outcome = this.patientCase?.outcome;
    if (!outcome) return nothing;
    return html`
      <section class="outcome ${outcome.status}">
        <b>${outcome.status.replace('_', ' ')}</b>
        <p>${outcome.summary}</p>
        ${outcome.evidence.length > 0 ? html`
          <details class="evidence">
            <summary>Agent evidence · ${outcome.evidence.length}</summary>
            <ul>${outcome.evidence.map(item => html`<li>${item}</li>`)}</ul>
          </details>
        ` : nothing}
      </section>
    `;
  }

  private isLatestTurn(turn: SurgeonTurn): boolean {
    const turns = this.patientCase?.turns ?? [];
    return turns.at(-1)?.turn.id === turn.id;
  }

  private renderPatientTranscript(): unknown {
    if (this.patientTurns.length === 0) {
      return html`
        <div class="welcome">
          <span class="eyebrow">Direct line</span>
          <h2>Ask OpenRappter itself.</h2>
          <p>
            This goes over <code>POST /chat</code> — the same public wire a
            brainstem or any neighbor would use, not a private back channel.
            Copilot is not in this conversation.
          </p>
          <div class="starter-portals">
            ${[
              { label: 'Ask what it can do', value: 'What can you actually do? Answer from your real agent list, not in general terms.' },
              { label: 'Look inside its head', value: 'What is in your memory right now, and where is it stored?' },
              { label: 'Trust, then verify', value: 'Name one thing you believe about your own state that you cannot prove, and say why.' },
            ].map(o => html`
              <button class="portal" ?disabled=${this.busy} @click=${() => this.askThePatient(o.value)}>
                <span>${o.label}</span><span class="arrow">↗</span>
              </button>`)}
          </div>
        </div>`;
    }
    return html`${this.patientTurns.map(t => html`
      <div class="turn">
        <div class="ask">${t.q}</div>
        <div class="answer">
          <span class="eyebrow">OpenRappter${t.model ? html` · <span class="bn">${t.model}</span>` : nothing}</span>
          <p>${t.a}</p>
        </div>
      </div>`)}`;
  }

  private renderTranscript(): unknown {
    if (this.mode === 'patient') return this.renderPatientTranscript();
    const turns = this.patientCase?.turns ?? [];
    if (turns.length === 0) {
      return html`
        <div class="welcome">
          <span class="eyebrow">Adaptive agent mode</span>
          <h2>Tell Copilot what the patient needs.</h2>
          <p>
            There is no menu tree to learn. Copilot examines live OpenRappter
            anatomy, answers directly, and creates the next useful choices.
            Nothing mutates without a visible, digest-bound procedure.
          </p>
          <div class="starter-portals">
            ${this.starterOptions.map(option => html`
              <button
                class="portal"
                ?disabled=${this.busy || this.copilotBlocked}
                @click=${() => this.sendTurn(option.value)}
              >
                <span>${option.label}</span>
                <span class="arrow">↗</span>
              </button>
            `)}
          </div>
        </div>
      `;
    }

    return html`
      ${turns.map(entry => this.renderTurn(entry.userInput, entry.turn))}
      ${this.renderOutcome()}
    `;
  }

  render(): unknown {
    return html`
      <div class="shell">
        <div class="noise"></div>
        <header class="topbar">
          <div class="mark">🦖</div>
          <div class="brand">
            <strong>OpenRappter</strong>
            <span>patient interface</span>
          </div>
          <div class="tagline">It’s above that.</div>
          <div class="top-actions">
            <button
              class="icon-button"
              title=${this.voiceEnabled ? 'Turn spoken replies off' : 'Turn spoken replies on'}
              aria-pressed=${this.voiceEnabled}
              @click=${() => {
                this.voiceEnabled = !this.voiceEnabled;
                if (!this.voiceEnabled && 'speechSynthesis' in globalThis) {
                  globalThis.speechSynthesis.cancel();
                }
              }}
            >${this.voiceEnabled ? '◉ Voice' : '○ Voice'}</button>
            <button class="quiet-button" @click=${this.newExamination}>＋ New examination</button>
            <button
              class="quiet-button"
              @click=${() => this.navigate('presence')}
            >⌁ Open anatomy</button>
          </div>
        </header>

        <main class="operating-room">
          <section class="patient-wing">
            <span class="eyebrow">Living local system</span>
            <h1>OpenRappter is the patient.</h1>
            <p class="premise">
              <strong>Copilot is the surgeon.</strong>
              The interface forms around the patient’s real state instead of
              forcing every task through borrowed dashboard chrome.
            </p>
            ${this.renderPatient()}
            ${this.renderTissues()}
          </section>

          <section class="surgeon-wing">
            <header class="surgeon-header">
              <div class="copilot">${this.mode === 'patient' ? '🦖' : '⌘'}</div>
              <div class="surgeon-title">
                <b>${this.mode === 'patient' ? 'OpenRappter' : 'GitHub Copilot'}</b>
                <span>${this.mode === 'patient'
                  ? 'the patient, answering for itself · over POST /chat'
                  : 'Brain surgeon · adaptive agent mode'}</span>
              </div>
              <div class="toolbar" role="group" aria-label="Who you are talking to">
                <button
                  class="tbtn${this.mode === 'surgeon' ? ' on' : ''}"
                  aria-pressed=${this.mode === 'surgeon'}
                  ?disabled=${this.busy || this.copilotStatus.state !== 'ready'}
                  @click=${() => { this.mode = 'surgeon'; this.error = null; }}
                >⌘ Surgeon</button>
                <button
                  class="tbtn${this.mode === 'patient' ? ' on' : ''}"
                  aria-pressed=${this.mode === 'patient'}
                  ?disabled=${this.busy}
                  @click=${() => { this.mode = 'patient'; this.error = null; }}
                >🦖 Patient</button>
              </div>
              <span class="case-status">
                ${this.mode === 'patient'
                  ? (this.patientSession ? 'in conversation' : 'ready')
                  : this.copilotBlocked
                    ? this.copilotStatus.state
                    : (this.patientCase?.status.replace('_', ' ') ?? 'ready')}
              </span>
            </header>

            <div class="transcript">
              ${this.mode === 'surgeon' && this.copilotBlocked
                ? html`
                    <div class="error-banner" role="alert" aria-live="assertive">
                      <strong>Copilot ${this.copilotStatus.state}.</strong>
                      ${this.copilotStatus.message}
                      ${this.staleCopilotCleared
                        ? html` Previous Copilot consultation content was cleared as stale.`
                        : nothing}
                      ${this.copilotStatus.state === 'needs-sign-in'
                        ? html`
                            <button
                              data-desktop-sensitive="copilot-sign-in"
                              @click=${() => this.dispatchEvent(
                              new CustomEvent('copilot-sign-in', {
                                bubbles: true,
                                composed: true,
                              }),
                            )}
                            >Sign in to Copilot</button>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              ${this.error ? html`
                <div class="error-banner">
                  ${this.error}
                </div>
              ` : nothing}
              ${this.renderTranscript()}
              ${this.busy ? html`
                <div class="thinking">
                  <span class="pulse"><i></i><i></i><i></i></span>
                  ${this.mode === 'patient' ? 'OpenRappter is answering…' : 'Copilot is examining OpenRappter…'}
                </div>
              ` : nothing}
            </div>

            <footer class="composer-wrap">
              <div class="composer">
                <textarea
                  aria-label=${this.mode === 'patient' ? 'Ask OpenRappter directly' : 'Ask the Copilot surgeon'}
                  placeholder=${this.mode === 'patient'
                    ? 'Ask OpenRappter itself…'
                    : 'Describe what OpenRappter needs…'}
                  .value=${this.input}
                  ?disabled=${this.busy || this.copilotBlocked}
                  @input=${(event: Event) => {
                    this.input = (event.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${this.onComposerKeydown}
                ></textarea>
                <button
                  class="send"
                  aria-label=${this.mode === 'patient' ? 'Send to OpenRappter' : 'Send to Copilot surgeon'}
                  ?disabled=${this.busy || this.copilotBlocked || !this.input.trim()}
                  @click=${() => this.sendTurn()}
                >↑</button>
              </div>
              <div class="composer-note">
                ${this.mode === 'patient' ? html`
                  <span>Straight to the agent over <code>POST /chat</code> — the same wire a neighbor uses.</span>
                  <span>Copilot is not in this conversation.</span>
                ` : html`
                  <span>Copilot shapes the next interface from this turn.</span>
                  <span>Mutations require explicit approval.</span>
                `}
              </div>
            </footer>
          </section>
        </main>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-surgeon': OpenRappterSurgeon;
  }
}
