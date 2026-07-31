import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

/**
 * SMTP mailer. Configure via env vars:
 *   SMTP_HOST   e.g. smtp.gmail.com
 *   SMTP_PORT   587 (STARTTLS) or 465 (SSL) - defaults to 587
 *   SMTP_USER   the sending account (e.g. your Gmail address)
 *   SMTP_PASS   an App Password (for Gmail: a 16-char app password, NOT the login password)
 *   MAIL_FROM   optional display From (defaults to SMTP_USER)
 *
 * Nothing sends until these are set - sendMail throws a clear error otherwise.
 */
let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      "Email is not configured - set SMTP_HOST, SMTP_USER and SMTP_PASS in the backend .env.",
    );
  }
  const port = Number(SMTP_PORT ?? 587);
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  const from =
    process.env.MAIL_FROM ||
    process.env.SMTP_USER ||
    "no-reply@mdwwellness.com";
  return getTransporter().sendMail({ from, ...opts });
}

export async function sendPasswordResetEmail(
  to: string,
  otp: string,
  name?: string,
) {
  const hi = name ? `Hi ${name},` : "Hi,";
  const subject = "Your MDW Wellness password reset code";
  const text = `${hi}\n\nYour password reset code is ${otp}. It expires in 10 minutes.\nIf you didn't request this, you can ignore this email.`;
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:auto;color:#0e2833">
      <p>${hi}</p>
      <p>Your MDW Wellness password reset code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px;color:#018bc4;margin:12px 0">${otp}</p>
      <p style="color:#5c7482">This code expires in <b>10 minutes</b>. If you didn't request a reset, you can safely ignore this email.</p>
    </div>`;
  return sendMail({ to, subject, html, text });
}
