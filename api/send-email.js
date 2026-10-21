'use strict';

const crypto = require('node:crypto');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 5;
const MESSAGE_MAX = 5000;
const rateBuckets = new Map();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function clean(value, max) {
  return typeof value === 'string' ? value.trim().replace(/\u0000/g, '').slice(0, max) : '';
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim().slice(0, 80);
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 80);
}

function checkRateLimit(ip, now = Date.now()) {
  // Serverless memory is best-effort; use Vercel Firewall/Upstash for shared persistent limits.
  for (const [key, bucket] of rateBuckets) if (now - bucket.startedAt > WINDOW_MS) rateBuckets.delete(key);
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

function renderEmail({ name, email, subject, message }) {
  const n = escapeHtml(name);
  const e = escapeHtml(email);
  const sub = escapeHtml(subject);
  const msg = escapeHtml(message).replace(/\r?\n/g, '<br>');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4efe6;font-family:Arial,Helvetica,sans-serif;color:#17231f;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4efe6;width:100%;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #ded5c6;border-radius:18px;overflow:hidden;">
<tr><td style="background:#173d32;padding:26px 30px;border-bottom:5px solid #c8f05a;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="font-size:11px;letter-spacing:2px;font-weight:bold;color:#d7ff69;">MAKHDOOM NAWAZ&nbsp; / &nbsp;PORTFOLIO</td><td align="right" style="font-size:11px;color:#ffffff;">NEW INQUIRY</td></tr></table>
<h1 style="font-size:26px;line-height:1.25;margin:20px 0 4px;color:#ffffff;">A new project message</h1><p style="font-size:14px;line-height:1.6;margin:0;color:#e4eee8;">Someone has reached out through your portfolio.</p>
</td></tr>
<tr><td style="padding:28px 30px 12px;"><p style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;color:#63706a;margin:0 0 8px;">Project / subject</p><div style="font-size:18px;line-height:1.5;font-weight:bold;color:#173d32;overflow-wrap:anywhere;">${sub}</div></td></tr>
<tr><td style="padding:10px 30px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0;"><tr><td style="padding:14px;background:#f4efe6;border:1px solid #ded5c6;border-radius:10px;"><p style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#63706a;margin:0 0 5px;font-weight:bold;">From</p><p style="font-size:15px;color:#17231f;margin:0 0 5px;font-weight:bold;overflow-wrap:anywhere;">${n}</p><p style="font-size:13px;margin:0;overflow-wrap:anywhere;"><a href="mailto:${e}" style="color:#173d32;text-decoration:underline;">${e}</a></p></td></tr></table></td></tr>
<tr><td style="padding:20px 30px 28px;"><p style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;color:#63706a;margin:0 0 10px;">Message</p><div style="font-size:14px;line-height:1.8;color:#17231f;overflow-wrap:anywhere;white-space:normal;border-left:3px solid #ff6b35;padding:4px 0 4px 16px;">${msg}</div>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:26px;"><tr><td bgcolor="#c8f05a" style="border-radius:8px;"><a href="mailto:${e}?subject=${encodeURIComponent('Re: ' + subject)}" style="display:inline-block;padding:13px 18px;color:#17231f;text-decoration:none;font-size:13px;font-weight:bold;">Reply to ${n} &rarr;</a></td></tr></table>
<p style="font-size:12px;line-height:1.7;color:#63706a;margin:20px 0 0;">Tip: use your email client's Reply button to respond directly to the visitor. The reply address is set to the visitor's email.</p>
</td></tr>
<tr><td style="padding:17px 30px;background:#17231f;color:#d5ded9;font-size:11px;line-height:1.6;">Sent from <span style="color:#d7ff69;">makhdoom-portfolio.vercel.app</span> · Portfolio contact notification</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    'MAKHDOOM NAWAZ — NEW PORTFOLIO INQUIRY',
    '',
    'Project / subject: ' + subject,
    'Name: ' + name,
    'Email: ' + email,
    '',
    'Message:',
    message,
    '',
    'Reply directly to this email to respond to the visitor.'
  ].join('\n');
  return { html, text };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().includes('application/json')) {
    return res.status(415).json({ error: 'Please submit the form using the website.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const name = clean(body.name, 100);
  const email = clean(body.email, 254);
  const subject = clean(body.subject, 160);
  const message = clean(body.message, MESSAGE_MAX);

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'Please complete all required fields.' });
  }
  if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (name.length < 2 || subject.length < 2 || message.length < 10) {
    return res.status(400).json({ error: 'Please provide a name, subject, and message with a little more detail.' });
  }
  if (/[\r\n]/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) return res.status(429).json({ error: 'Too many messages were sent from this connection. Please try again in a few minutes.' });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.CONTACT_TO_EMAIL;
  if (!apiKey || !from || !to) {
    console.error('Contact email configuration is incomplete.');
    return res.status(503).json({ error: 'The contact service is not configured yet. Please email me directly instead.' });
  }

  const rendered = renderEmail({ name, email, subject, message });
  const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));
  const idempotencyKey = crypto.createHash('sha256')
    .update([ip, email.toLowerCase(), subject, message, String(timeBucket)].join('|'))
    .digest('hex');

  try {
    const providerResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: 'New Portfolio Inquiry: ' + subject.slice(0, 120),
        html: rendered.html,
        text: rendered.text
      })
    });

    const providerData = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok || !providerData.id) {
      console.error('Resend rejected contact email:', providerResponse.status, providerData.name || providerData.error || 'provider error');
      return res.status(502).json({ error: 'Your message could not be sent right now. Please try again later or email me directly.' });
    }

    return res.status(200).json({ ok: true, id: providerData.id });
  } catch (error) {
    console.error('Contact email provider request failed:', error && error.name ? error.name : 'UnknownError');
    return res.status(502).json({ error: 'The email service is temporarily unavailable. Please try again later.' });
  }
};
