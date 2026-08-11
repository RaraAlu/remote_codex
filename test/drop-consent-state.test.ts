import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { DropConsentState } from "../src/extension/drop-consent-state.js";

function storage(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) =>
      (values.has(key) ? values.get(key) : fallback) as T,
    keys: () => [...values.keys()],
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        values.delete(key);
      } else {
        values.set(key, value);
      }
    },
  };
}

describe("DropConsentState", () => {
  it("persists and clears the existing automatic drop consent", async () => {
    const state = storage();
    const consent = new DropConsentState(state);

    expect(consent.enabled()).toBe(false);
    await consent.setEnabled(true);
    expect(new DropConsentState(state).enabled()).toBe(true);
    await consent.setEnabled(false);
    expect(consent.enabled()).toBe(false);
  });
});
