import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";

/** Plans, Stripe Checkout and portal, and the Stripe webhook (docs/06 pricing). */
export async function billingRoutes(app: FastifyInstance, { auth, billing }: Deps) {
  app.get("/billing", { preHandler: auth.requireWorkspace("viewer") }, async (req) =>
    billing.summary(currentWorkspace(req).orgId),
  );

  app.post("/billing/checkout", { preHandler: auth.requireWorkspace("owner") }, async (req) => {
    const { plan } = z.object({ plan: z.enum(["pro", "business"]) }).parse(req.body);
    return { url: await billing.checkout(currentWorkspace(req).orgId, plan, currentUser(req).email) };
  });

  app.post("/billing/portal", { preHandler: auth.requireWorkspace("owner") }, async (req) => ({
    url: await billing.portal(currentWorkspace(req).orgId),
  }));

  // Stripe signs the exact bytes it sends, so this route keeps the raw body.
  await app.register(async (hook) => {
    hook.removeContentTypeParser("application/json");
    hook.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    hook.post("/billing/webhook", async (req: FastifyRequest) =>
      billing.handleWebhook(String(req.body ?? ""), req.headers["stripe-signature"] as string | undefined),
    );
  });
}
