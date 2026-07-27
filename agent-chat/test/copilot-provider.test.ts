import { expect, test } from "bun:test";
import { providerAvailabilityForTest, registeredProviderForTest } from "../server";

test("GitHub Copilot is registered as an ACP provider with the supported CLI command", () => {
  expect(registeredProviderForTest("copilot")).toEqual({
    id: "copilot",
    label: "GitHub Copilot",
    adapter: "acp",
    cmd: ["copilot", "--acp"],
    installCommand: "npm install -g @github/copilot",
    adapterRegistered: true,
  });
});

test("GitHub Copilot availability probes its CLI executable", () => {
  const checked: string[] = [];
  expect(providerAvailabilityForTest("copilot", (name) => {
    checked.push(name);
    return name === "copilot";
  })).toBe(true);
  expect(checked).toEqual(["copilot"]);
  expect(providerAvailabilityForTest("copilot", () => false)).toBe(false);
});
