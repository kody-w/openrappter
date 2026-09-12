import type { AutomationInput } from "./contracts.js";

export function nextSchedule(automation: AutomationInput, after: number): Date {
  const cadence = automation.cadence;
  if (cadence.kind === "interval") return new Date(after + cadence.minutes * 60_000);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cadence.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= after + 8 * 86_400_000; time += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    if (`${parts.hour}:${parts.minute}` === cadence.at && (cadence.kind === "daily" || parts.weekday === weekdays[cadence.weekday])) return new Date(time);
  }
  throw new Error("No bounded schedule occurrence.");
}
