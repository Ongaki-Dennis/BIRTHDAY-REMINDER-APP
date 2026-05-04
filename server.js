require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "birthdays.json");
const DAILY_JOB_HOUR = 7;
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.GMAIL_USER || "";

let dailyJobTimer = null;
let dataLock = Promise.resolve();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function sanitizeText(value, maxLength = 120) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return sanitizeText(value, 160).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidDateOfBirth(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);

  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "[]\n", "utf8");
  }
}

async function readEntries() {
  await ensureDataFile();
  const content = await fs.readFile(DATA_FILE, "utf8");

  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeEntries(entries) {
  await ensureDataFile();
  await fs.writeFile(DATA_FILE, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

function withDataLock(task) {
  const run = async () => task();
  const next = dataLock.then(run, run);
  dataLock = next.catch(() => {});
  return next;
}

function getDisplayDateParts(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

function formatBirthdayLabel(value) {
  const { year, month, day } = getDisplayDateParts(value);
  const date = new Date(year, month - 1, day);

  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function getTodayKey(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isBirthdayToday(dateOfBirth, today = new Date()) {
  const { month, day } = getDisplayDateParts(dateOfBirth);
  return month === today.getMonth() + 1 && day === today.getDate();
}

function buildTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

function buildBirthdayEmail(entry) {
  const escapedName = entry.username.replace(/[<>&"]/g, (char) => {
    return (
      {
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;"
      }[char] || char
    );
  });

  return {
    subject: `Happy Birthday, ${entry.username}!`,
    html: `
      <div style="margin:0;padding:32px 16px;background:#fff7ef;font-family:Arial,sans-serif;color:#2e241c;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden;border:1px solid #f2d7bf;box-shadow:0 18px 40px rgba(168,99,45,0.14);">
          <div style="padding:28px 32px;background:linear-gradient(135deg,#ffb36b 0%,#ff7b54 100%);color:#ffffff;">
            <p style="margin:0 0 10px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;">Birthday Wishes</p>
            <h1 style="margin:0;font-size:34px;line-height:1.1;">Happy Birthday, ${escapedName}!</h1>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 16px;font-size:16px;line-height:1.7;">
              Wishing you a joyful birthday filled with warm moments, sweet surprises, and a year ahead full of good health, growth, and success.
            </p>
            <p style="margin:0 0 24px;font-size:16px;line-height:1.7;">
              Thank you for being part of our community. We are celebrating you today and sending our very best wishes your way.
            </p>
            <div style="padding:18px 20px;border-radius:18px;background:#fff3e4;border:1px solid #f7d8b4;">
              <strong style="display:block;margin-bottom:8px;font-size:15px;">Have an amazing day!</strong>
              <span style="font-size:14px;line-height:1.6;color:#6d5847;">
                May your day be bright, your cake be sweet, and your next chapter be even better than the last.
              </span>
            </div>
          </div>
        </div>
      </div>
    `,
    text: `Happy Birthday, ${entry.username}! Wishing you a joyful day filled with sweet surprises and a wonderful year ahead.`
  };
}

async function sendBirthdayEmails({ reason = "manual" } = {}) {
  return withDataLock(async () => {
    const transporter = buildTransporter();
    const entries = await readEntries();
    const today = new Date();
    const todayKey = getTodayKey(today);
    const celebrants = entries.filter((entry) => {
      return isBirthdayToday(entry.dateOfBirth, today) && entry.lastBirthdayEmailSentOn !== todayKey;
    });

    if (!celebrants.length) {
      return {
        ok: true,
        reason,
        celebrantsChecked: entries.length,
        sentCount: 0,
        skippedCount: entries.length,
        message: "No new birthday emails were due today."
      };
    }

    if (!transporter) {
      return {
        ok: false,
        reason,
        celebrantsChecked: entries.length,
        sentCount: 0,
        skippedCount: celebrants.length,
        message:
          "Birthday matches were found, but Gmail credentials are missing. Set GMAIL_USER and GMAIL_APP_PASSWORD."
      };
    }

    let sentCount = 0;

    for (const entry of celebrants) {
      const email = buildBirthdayEmail(entry);

      await transporter.sendMail({
        from: EMAIL_FROM || process.env.GMAIL_USER,
        to: entry.email,
        subject: email.subject,
        html: email.html,
        text: email.text
      });

      entry.lastBirthdayEmailSentOn = todayKey;
      entry.lastBirthdayEmailSentAt = new Date().toISOString();
      sentCount += 1;
    }

    await writeEntries(entries);

    return {
      ok: true,
      reason,
      celebrantsChecked: entries.length,
      sentCount,
      skippedCount: entries.length - sentCount,
      message: `Birthday emails sent to ${sentCount} celebrant${sentCount === 1 ? "" : "s"}.`
    };
  });
}

function scheduleNextBirthdayRun() {
  if (dailyJobTimer) {
    clearTimeout(dailyJobTimer);
  }

  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(DAILY_JOB_HOUR, 0, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  const delay = nextRun.getTime() - now.getTime();

  dailyJobTimer = setTimeout(async () => {
    try {
      const result = await sendBirthdayEmails({ reason: "scheduled" });
      console.log(`[birthday-job] ${result.message}`);
    } catch (error) {
      console.error("[birthday-job] Failed to send scheduled birthday emails.", error);
    } finally {
      scheduleNextBirthdayRun();
    }
  }, delay);

  console.log(`[birthday-job] Next birthday check scheduled for ${nextRun.toString()}`);
}

app.get("/api/birthdays", async (_req, res) => {
  const entries = await readEntries();
  const sortedEntries = entries
    .slice()
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((entry) => ({
      ...entry,
      birthdayLabel: formatBirthdayLabel(entry.dateOfBirth)
    }));

  res.json({
    entries: sortedEntries,
    total: sortedEntries.length,
    nextScheduledCheck: "7:00 AM server time"
  });
});

app.post("/api/birthdays", async (req, res) => {
  const username = sanitizeText(req.body?.username, 60);
  const email = normalizeEmail(req.body?.email);
  const dateOfBirth = sanitizeText(req.body?.dateOfBirth, 10);

  if (username.length < 2) {
    res.status(400).json({ message: "Username must be at least 2 characters long." });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ message: "Enter a valid email address." });
    return;
  }

  if (!isValidDateOfBirth(dateOfBirth)) {
    res.status(400).json({ message: "Enter date of birth in YYYY-MM-DD format." });
    return;
  }

  try {
    const createdEntry = await withDataLock(async () => {
      const entries = await readEntries();
      const duplicateEmail = entries.some((entry) => entry.email === email);

      if (duplicateEmail) {
        const error = new Error("This email is already registered.");
        error.statusCode = 409;
        throw error;
      }

      const newEntry = {
        id: crypto.randomUUID(),
        username,
        email,
        dateOfBirth,
        createdAt: new Date().toISOString(),
        lastBirthdayEmailSentOn: null,
        lastBirthdayEmailSentAt: null
      };

      entries.push(newEntry);
      await writeEntries(entries);
      return newEntry;
    });

    res.status(201).json({
      message: `${username} was added to the birthday list.`,
      entry: {
        ...createdEntry,
        birthdayLabel: formatBirthdayLabel(createdEntry.dateOfBirth)
      }
    });
  } catch (error) {
    if (error.statusCode === 409) {
      res.status(409).json({ message: error.message });
      return;
    }

    console.error("Failed to save birthday entry.", error);
    res.status(500).json({ message: "Could not save birthday entry right now." });
  }
});

app.post("/api/jobs/send-birthday-emails", async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const providedSecret = req.get("x-cron-secret") || req.body?.secret;

  if (!cronSecret) {
    res.status(503).json({
      message: "Set CRON_SECRET before exposing the birthday job endpoint."
    });
    return;
  }

  if (providedSecret !== cronSecret) {
    res.status(401).json({ message: "Unauthorized job request." });
    return;
  }

  try {
    const result = await sendBirthdayEmails({ reason: "manual" });
    res.json(result);
  } catch (error) {
    console.error("[birthday-job] Manual run failed.", error);
    res.status(500).json({
      ok: false,
      message: "Birthday email job failed.",
      error: error.message
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    emailConfigured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    scheduler: "Daily 7:00 AM server time",
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    jobEndpointProtected: Boolean(process.env.CRON_SECRET)
  });
});

async function startServer() {
  await ensureDataFile();

  app.listen(PORT, () => {
    console.log(`Birthday reminder app running on http://localhost:${PORT}`);
  });

  scheduleNextBirthdayRun();
}

async function runOnceIfRequested() {
  if (!process.argv.includes("--run-birthday-job")) {
    return false;
  }

  await ensureDataFile();

  try {
    const result = await sendBirthdayEmails({ reason: "cli" });
    console.log(result.message);
    process.exit(0);
  } catch (error) {
    console.error("Birthday job failed.", error);
    process.exit(1);
  }
}

runOnceIfRequested().then((didRun) => {
  if (!didRun) {
    startServer().catch((error) => {
      console.error("Failed to start the birthday reminder app.", error);
      process.exit(1);
    });
  }
});
