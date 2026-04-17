import { test as base } from "@playwright/test";
import { PlaywrightAiFixture } from "@midscene/web/playwright";

export const test = base.extend(
  PlaywrightAiFixture({ waitForNetworkIdleTimeout: 1500 })
);

export { expect } from "@playwright/test";
