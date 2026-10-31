import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

export const env = {
  port: Number(process.env.PORT || 9100),
  corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:3100")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  adminUsername: process.env.ADMIN_USERNAME || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  /** Public site URL printed on certificates for verification, e.g. https://tournament.example.in */
  publicSiteUrl: process.env.PUBLIC_SITE_URL || "",
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
};

if (env.jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}
