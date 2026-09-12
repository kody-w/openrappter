import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
const selectionStorage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    get length() { return selectionStorage.size; },
    getItem: (key: string) => selectionStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { selectionStorage.set(key, String(value)); },
    removeItem: (key: string) => { selectionStorage.delete(key); },
    clear: () => selectionStorage.clear(),
    key: (index: number) => [...selectionStorage.keys()][index] ?? null,
  } satisfies Storage,
});
afterEach(() => {
  cleanup(); window.location.hash = ""; window.localStorage.clear();
  delete window.SpeechRecognition; delete window.webkitSpeechRecognition;
  document.documentElement.removeAttribute("data-theme"); document.documentElement.removeAttribute("data-density");
});
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
