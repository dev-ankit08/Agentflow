import { describe, expect, it } from "vitest";
import { validateFlow } from "@agentflow/flow-schema";
import { templates } from "../src";

describe("templates", () => {
  it.each(templates.map((t) => [t.slug, t] as const))("%s builds a valid flow", (_slug, template) => {
    const flow = template.build({
      id: "flw_test",
      name: template.name,
      model: { provider: "anthropic", name: "claude-haiku-5-5" },
      connectorId: template.connector ? "con_demo" : undefined,
    });
    const result = validateFlow(flow);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("has unique slugs", () => {
    expect(new Set(templates.map((t) => t.slug)).size).toBe(templates.length);
  });
});
