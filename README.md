# Birthday Reminder App

A simple customer birthday reminder app built with `Express`, a lightweight JSON data store, and `Nodemailer`.

## What it does

- Collects `username`, `email`, and `date of birth`
- Enforces unique email addresses
- Stores customer records in `data/birthdays.json`
- Checks birthdays every day at `7:00 AM` server time
- Sends a styled birthday email through Gmail
- Prevents duplicate birthday emails from being sent twice on the same day
- Protects the job endpoint with `CRON_SECRET`

## Environment variables

Create a `.env` file or set these in your hosting platform:

```bash
GMAIL_USER=your-gmail-address@gmail.com
GMAIL_APP_PASSWORD=your-gmail-app-password
EMAIL_FROM=your-gmail-address@gmail.com
CRON_SECRET=choose-a-secret-for-your-cron-caller
TZ=Africa/Nairobi
```

`TZ` matters because the built-in scheduler runs at `7:00 AM` using the server's local time.

## Run locally

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Run the birthday job manually

```bash
npm run birthday-job
```

To trigger the job over HTTP, send a `POST` request to `/api/jobs/send-birthday-emails` with the `x-cron-secret` header set to your `CRON_SECRET`.

## Production note

The app includes an in-process 7:00 AM scheduler, but for stricter production cron behavior you should configure your hosting platform's scheduler to call the protected `/api/jobs/send-birthday-emails` endpoint each day at 7:00 AM in your preferred time zone.
