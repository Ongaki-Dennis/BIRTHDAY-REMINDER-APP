const state = {
  entries: []
};

const birthdayForm = document.querySelector("#birthday-form");
const usernameInput = document.querySelector("#username");
const emailInput = document.querySelector("#email");
const dateOfBirthInput = document.querySelector("#dateOfBirth");
const submitButton = document.querySelector("#submit-button");
const formFeedback = document.querySelector("#form-feedback");
const entriesList = document.querySelector("#entries-list");
const totalCount = document.querySelector("#total-count");
const jobFeedback = document.querySelector("#job-feedback");
const schedulerNote = document.querySelector("#scheduler-note");

function showFeedback(message, type = "success") {
  formFeedback.hidden = false;
  formFeedback.textContent = message;
  formFeedback.className = `feedback ${type}`;
}

function createEntryCard(entry) {
  const card = document.createElement("article");
  card.className = "entry-card";

  const identity = document.createElement("div");
  const name = document.createElement("p");
  name.className = "entry-name";
  name.textContent = entry.username;

  const email = document.createElement("p");
  email.className = "entry-email";
  email.textContent = entry.email;

  identity.append(name, email);

  const meta = document.createElement("div");
  meta.className = "entry-meta";

  const birthday = document.createElement("span");
  birthday.textContent = entry.birthdayLabel;

  const sentNote = document.createElement("span");
  sentNote.textContent = entry.lastBirthdayEmailSentAt
    ? `Last sent: ${new Date(entry.lastBirthdayEmailSentAt).toLocaleString()}`
    : "No birthday email sent yet";

  meta.append(birthday, sentNote);
  card.append(identity, meta);

  return card;
}

function renderEntries(entries) {
  state.entries = entries;
  totalCount.textContent = `${entries.length} customer${entries.length === 1 ? "" : "s"} saved`;
  entriesList.replaceChildren();

  if (!entries.length) {
    const emptyState = document.createElement("article");
    emptyState.className = "empty-state";

    const title = document.createElement("strong");
    title.textContent = "No birthdays saved yet.";

    const text = document.createElement("p");
    text.textContent = "Add your first customer to start automating birthday wishes.";

    emptyState.append(title, text);
    entriesList.append(emptyState);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    fragment.append(createEntryCard(entry));
  }

  entriesList.append(fragment);
}

async function loadHealth() {
  const response = await fetch("/api/health");
  const data = await response.json();
  const timezone = data.timezone || "server time";

  schedulerNote.textContent = data.emailConfigured
    ? `Gmail is configured and the scheduler is ready for the daily 7:00 AM run in ${timezone}.`
    : `Set GMAIL_USER and GMAIL_APP_PASSWORD before the 7:00 AM scheduler in ${timezone} can send birthday emails.`;

  jobFeedback.textContent = data.jobEndpointProtected
    ? "The birthday job endpoint is protected with CRON_SECRET for secure automation."
    : "Set CRON_SECRET to protect the birthday job endpoint before wiring any external cron service.";
}

async function loadEntries() {
  const response = await fetch("/api/birthdays");
  const data = await response.json();
  renderEntries(data.entries || []);
}

async function saveBirthday(event) {
  event.preventDefault();
  submitButton.disabled = true;
  formFeedback.hidden = true;

  try {
    const response = await fetch("/api/birthdays", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        username: usernameInput.value,
        email: emailInput.value,
        dateOfBirth: dateOfBirthInput.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      showFeedback(data.message || "Could not save birthday reminder.", "error");
      return;
    }

    birthdayForm.reset();
    showFeedback(data.message, "success");
    await loadEntries();
  } catch {
    showFeedback("Something went wrong while saving the birthday reminder.", "error");
  } finally {
    submitButton.disabled = false;
  }
}

birthdayForm.addEventListener("submit", saveBirthday);

Promise.all([loadHealth(), loadEntries()]).catch(() => {
  schedulerNote.textContent = "The app could not load its current status.";
  jobFeedback.textContent = "The dashboard could not load customer birthdays.";
});
