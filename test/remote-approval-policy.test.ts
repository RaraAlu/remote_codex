import { describe, expect, it } from "vitest";
import { RemoteApprovalPolicyTracker } from "../src/shim/remote-approval-policy.js";

describe("remote approval policy tracking", () => {
  it("maps a full-access thread to automatic remote command approval", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 1,
      method: "thread/start",
      params: { permissions: "full-access" },
    });
    tracker.observeServerMessage({
      id: 1,
      result: { thread: { id: "thread-full" } },
    });

    expect(tracker.modeForThread("thread-full")).toBe("never");
    expect(tracker.requiresApproval("thread-full")).toBe(false);
  });

  it("honors approvalPolicy never and later turn overrides", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 2,
      method: "thread/start",
      params: { approvalPolicy: "never" },
    });
    tracker.observeServerMessage({
      id: 2,
      result: { thread: { id: "thread-policy" } },
    });
    expect(tracker.requiresApproval("thread-policy")).toBe(false);

    tracker.observeClientMessage({
      id: 3,
      method: "turn/start",
      params: {
        threadId: "thread-policy",
        approvalPolicy: "on-request",
        input: [],
      },
    });
    expect(tracker.requiresApproval("thread-policy")).toBe(true);
  });

  it("fails closed for resumed and unknown threads without an explicit mode", () => {
    const tracker = new RemoteApprovalPolicyTracker();
    tracker.observeClientMessage({
      id: 4,
      method: "thread/resume",
      params: { threadId: "thread-resumed" },
    });

    expect(tracker.requiresApproval("thread-resumed")).toBe(true);
    expect(tracker.requiresApproval("thread-unknown")).toBe(true);
  });
});
