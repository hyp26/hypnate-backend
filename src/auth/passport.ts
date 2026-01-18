import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import prisma from "../prisma/client";

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: "/auth/google/callback",
    },
    async (_, __, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;

        if (!email) {
          return done(new Error("Google account has no email"));
        }

        let user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user) {
          user = await prisma.user.create({
            data: {
              name: profile.displayName,
              email,
              authProvider: "GOOGLE",
              role: "SELLER",
            },
          });
        }

        return done(null, user);
      } catch (err) {
        done(err as any, undefined);
      }
    }
  )
);

// ❗ No serializeUser / deserializeUser (JWT, not sessions)
export default passport;
