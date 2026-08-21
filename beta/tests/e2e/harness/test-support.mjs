import test from "node:test";

import { isE2EUnavailable } from "./launch.mjs";

export const E2E_ENABLED = process.env.BRAINSTEM_BETA_E2E === "1";
export const E2E_REQUIRED = process.env.BRAINSTEM_BETA_E2E_REQUIRED === "1";
export const E2E_SKIP_REASON = E2E_ENABLED || E2E_REQUIRED
  ? false
  : "set BRAINSTEM_BETA_E2E=1 to run Electron end-to-end tests";

export function frontierTest(name, callback) {
  test(name, { skip: E2E_SKIP_REASON }, async (context) => {
    try {
      await callback(context);
    } catch (error) {
      if (isE2EUnavailable(error) && !E2E_REQUIRED) {
        context.skip(error.message);
        return;
      }
      throw error;
    }
  });
}
