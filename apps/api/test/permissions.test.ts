import { describe, expect, it } from "vitest";
import { canDecideApproval, canEditFlows, presetPermissions } from "../src/permissions";

describe("permission helpers", () => {
  it("decides approvals by custom permission, otherwise by the node's approver role", () => {
    expect(canDecideApproval({ role: "builder" }, "reviewer")).toBe(true);
    expect(canDecideApproval({ role: "reviewer" }, "admin")).toBe(false);
    // A custom role without inbox.decide can't approve, whatever its base role.
    expect(canDecideApproval({ role: "admin", customRoleId: "r1", customPermissions: ["audit.view"] }, "viewer")).toBe(
      false,
    );
    expect(
      canDecideApproval({ role: "viewer", customRoleId: "r1", customPermissions: ["inbox.decide"] }, "admin"),
    ).toBe(true);
  });

  it("allows live editing only with flows.edit", () => {
    expect(canEditFlows({ role: "builder" })).toBe(true);
    expect(canEditFlows({ role: "reviewer" })).toBe(false);
    expect(canEditFlows({ role: "builder", customRoleId: "r1", customPermissions: ["flows.publish"] })).toBe(false);
    expect(canEditFlows({ role: "viewer", customRoleId: "r1", customPermissions: ["flows.edit"] })).toBe(true);
  });

  it("keeps owner-only permissions out of admin presets", () => {
    expect(presetPermissions("admin")).not.toContain("billing.manage");
    expect(presetPermissions("owner")).toContain("billing.manage");
  });
});
