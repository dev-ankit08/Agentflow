import { timingSafeEqual } from "node:crypto";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { accounts, sessions, users, verificationTokens } from "@agentflow/db";
import { getDb } from "./lib/db";

export const DEV_LOGIN_EMAIL = "demo@agentflow.local";
export const devLoginEnabled = process.env.AUTH_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
export const googleEnabled = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
/**
 * Hosted trials (e.g. GitHub Codespaces) without email or Google sign-in: anyone with the shared access code signs
 * in with their own email (not verified) and gets their own account. Off unless TRIAL_ACCESS_CODE is set.
 */
const trialCode = process.env.TRIAL_ACCESS_CODE ?? "";
export const trialLoginEnabled = trialCode.length >= 8;
export const emailLinksEnabled = Boolean(process.env.EMAIL_SERVER) || !trialLoginEnabled;

const sameCode = (given: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(trialCode);
  return a.length === b.length && timingSafeEqual(a, b);
};

const db = getDb();
const providers: NextAuthConfig["providers"] = [
  Nodemailer({
    server: process.env.EMAIL_SERVER || "smtp://localhost:25",
    from: process.env.EMAIL_FROM || "AgentFlow <no-reply@agentflow.local>",
    async sendVerificationRequest({ identifier, url, provider }) {
      if (!process.env.EMAIL_SERVER) {
        // No SMTP configured: print the link so local sign-in still works.
        console.log(`\n[auth] Magic link for ${identifier}:\n${url}\n`);
        return;
      }
      await createTransport(provider.server).sendMail({
        to: identifier,
        from: provider.from,
        subject: "Sign in to AgentFlow",
        text: `Sign in to AgentFlow:\n${url}\n\nIf you did not request this email you can ignore it.`,
      });
    },
  }),
];

if (googleEnabled) providers.push(Google);

if (trialLoginEnabled) {
  providers.push(
    Credentials({
      id: "trial",
      name: "Trial access",
      credentials: { email: {}, code: {} },
      async authorize(input) {
        const email = String(input?.email ?? "")
          .trim()
          .toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !sameCode(String(input?.code ?? ""))) return null;
        const [existing] = await db.select().from(users).where(eq(users.email, email));
        if (existing) return existing;
        const [created] = await db
          .insert(users)
          .values({ email, name: email.split("@")[0] })
          .returning();
        return created ?? null;
      },
    }),
  );
}

if (devLoginEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Dev login",
      credentials: {},
      async authorize() {
        const [user] = await db.select().from(users).where(eq(users.email, DEV_LOGIN_EMAIL));
        return user ?? null;
      },
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  providers,
  pages: { signIn: "/login", verifyRequest: "/login?check=1", error: "/login" },
  callbacks: {
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
  trustHost: true,
});
