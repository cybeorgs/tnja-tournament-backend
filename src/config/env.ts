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
  isProduction: process.env.NODE_ENV === "production",
  smtp: {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || "",
    fromName: process.env.SMTP_FROM_NAME || "",
  },
};

if (env.jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}
