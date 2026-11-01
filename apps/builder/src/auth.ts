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
