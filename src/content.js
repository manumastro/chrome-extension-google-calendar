const MEET_HOSTNAME = 'meet.google.com';
const MEET_CODE_PATH_PATTERN = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\/)?$/i;
const DETECTION_BADGE_ID = 'meet-recording-reminder-detected';
const REMINDER_PANEL_ID = 'meet-recording-reminder-panel';
const DETECTION_CHECK_INTERVAL_MS = 1500;
const REMINDER_SNOOZE_MS = 2 * 60 * 1000;
const STORAGE_CALL_LOGS_KEY = 'meetRecordingReminder.callLogs';
const MAX_CALL_LOG_ENTRIES = 50;

const CALL_OPEN_LABEL_PATTERNS = {
  callControls: [
    /\bcall controls\b/i,
    /\bcontrolli (della )?chiamata\b/i,
  ],
  leaveCall: [
    /\bleave call\b/i,
    /\babbandona( la)? chiamata\b/i,
    /\besci dalla chiamata\b/i,
    /\btermina( la)? chiamata\b/i,
  ],
};

let lastDetectionState = null;
let scheduledDetection = null;
let currentCallSession = null;
let isHandlingCallState = false;

function isGoogleMeetPage(location) {
  return location.hostname === MEET_HOSTNAME && MEET_CODE_PATH_PATTERN.test(location.pathname);
}

function getMeetCodeFromLocation(location) {
  return location.pathname.replace(/^\/+|\/+$/g, '');
}

function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim();
}

function isVisibleElement(element) {
  if (!(element instanceof Element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-hidden') !== 'true';
}

function hasAriaLabelMatching(patterns) {
  return Array.from(document.querySelectorAll('[aria-label]')).some((element) => {
    if (!isVisibleElement(element)) {
      return false;
    }

    const label = normalizeLabel(element.getAttribute('aria-label') || '');
    return patterns.some((pattern) => pattern.test(label));
  });
}

function isMeetCallOpen() {
  if (!isGoogleMeetPage(window.location)) {
    return false;
  }

  const hasCallControls = hasAriaLabelMatching(CALL_OPEN_LABEL_PATTERNS.callControls);
  const hasLeaveCall = hasAriaLabelMatching(CALL_OPEN_LABEL_PATTERNS.leaveCall);

  // Il DOM di una call aperta espone sia il gruppo "Call controls" sia il pulsante "Leave call".
  // Nella schermata pre-join possono esserci microfono/camera, ma non il pulsante di uscita dalla call.
  return hasCallControls && hasLeaveCall;
}

function getMeetDetectionState() {
  const pageDetected = isGoogleMeetPage(window.location);

  return {
    pageDetected,
    callOpen: pageDetected && isMeetCallOpen(),
  };
}

function getDetectionBadge() {
  const existingBadge = document.getElementById(DETECTION_BADGE_ID);
  if (existingBadge) {
    return existingBadge;
  }

  const badge = document.createElement('div');
  badge.id = DETECTION_BADGE_ID;
  badge.style.position = 'fixed';
  badge.style.right = '16px';
  badge.style.bottom = '16px';
  badge.style.zIndex = '2147483647';
  badge.style.padding = '10px 12px';
  badge.style.borderRadius = '8px';
  badge.style.background = '#1a73e8';
  badge.style.color = '#fff';
  badge.style.font = '13px/1.4 Arial, sans-serif';
  badge.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';

  document.documentElement.appendChild(badge);
  return badge;
}

function updateDetectionBadge({ pageDetected, callOpen }) {
  const existingBadge = document.getElementById(DETECTION_BADGE_ID);

  if (!pageDetected) {
    existingBadge?.remove();
    return;
  }

  const badge = getDetectionBadge();
  const text = callOpen ? 'Meet in call rilevato' : 'Pagina Meet rilevata';
  const background = callOpen ? '#188038' : '#1a73e8';

  if (badge.textContent !== text) {
    badge.textContent = text;
  }

  if (badge.dataset.background !== background) {
    badge.dataset.background = background;
    badge.style.background = background;
  }
}

function getStorageArea() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return null;
  }

  return chrome.storage.local;
}

function readStorageValue(key, fallbackValue) {
  const storage = getStorageArea();
  if (!storage) {
    return Promise.resolve(fallbackValue);
  }

  return new Promise((resolve) => {
    storage.get([key], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Meet Recording Reminder] Lettura storage fallita', chrome.runtime.lastError.message);
        resolve(fallbackValue);
        return;
      }

      resolve(Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallbackValue);
    });
  });
}

function writeStorageValue(key, value) {
  const storage = getStorageArea();
  if (!storage) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    storage.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Meet Recording Reminder] Scrittura storage fallita', chrome.runtime.lastError.message);
      }

      resolve();
    });
  });
}

function fallbackHash(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return `fallback-${(hash >>> 0).toString(16)}`;
}

async function hashMeetCode(meetCode) {
  if (!window.crypto?.subtle || typeof TextEncoder === 'undefined') {
    return fallbackHash(meetCode);
  }

  const encodedMeetCode = new TextEncoder().encode(meetCode);
  const digest = await window.crypto.subtle.digest('SHA-256', encodedMeetCode);
  const hashBytes = Array.from(new Uint8Array(digest));
  return hashBytes.map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function nowIsoString() {
  return new Date().toISOString();
}

async function upsertCurrentCallLog(changes) {
  if (!currentCallSession) {
    return;
  }

  const logs = await readStorageValue(STORAGE_CALL_LOGS_KEY, []);
  const safeLogs = Array.isArray(logs) ? logs : [];
  const existingIndex = safeLogs.findIndex((entry) => entry.sessionId === currentCallSession.sessionId);
  const updatedEntry = {
    ...(existingIndex >= 0 ? safeLogs[existingIndex] : currentCallSession),
    ...changes,
  };

  if (existingIndex >= 0) {
    safeLogs[existingIndex] = updatedEntry;
  } else {
    safeLogs.push(updatedEntry);
  }

  await writeStorageValue(STORAGE_CALL_LOGS_KEY, safeLogs.slice(-MAX_CALL_LOG_ENTRIES));
}

async function startCallSessionIfNeeded() {
  const meetCode = getMeetCodeFromLocation(window.location);
  const meetingCodeHash = await hashMeetCode(meetCode);

  if (currentCallSession?.meetingCodeHash === meetingCodeHash && !currentCallSession.leftAt) {
    return;
  }

  const joinedAt = nowIsoString();
  currentCallSession = {
    sessionId: `${meetingCodeHash}:${Date.now()}`,
    meetingCodeHash,
    joinedAt,
    lastSeenAt: joinedAt,
    reminderStatus: 'not_shown',
    reminderShownCount: 0,
    snoozeUntil: null,
  };

  await upsertCurrentCallLog(currentCallSession);
  console.info('[Meet Recording Reminder] Sessione call avviata', {
    meetingCodeHash,
    joinedAt,
  });
}

async function markReminderShown() {
  if (!currentCallSession) {
    return;
  }

  currentCallSession.reminderStatus = 'shown';
  currentCallSession.reminderShownAt = currentCallSession.reminderShownAt || nowIsoString();
  currentCallSession.lastReminderShownAt = nowIsoString();
  currentCallSession.reminderShownCount += 1;

  await upsertCurrentCallLog({
    reminderStatus: currentCallSession.reminderStatus,
    reminderShownAt: currentCallSession.reminderShownAt,
    lastReminderShownAt: currentCallSession.lastReminderShownAt,
    reminderShownCount: currentCallSession.reminderShownCount,
    lastSeenAt: nowIsoString(),
  });
}

async function updateReminderAction(action, extraChanges = {}) {
  if (!currentCallSession) {
    return;
  }

  currentCallSession.reminderStatus = action;
  Object.assign(currentCallSession, extraChanges);

  await upsertCurrentCallLog({
    reminderStatus: action,
    ...extraChanges,
    lastSeenAt: nowIsoString(),
  });
}

function removeReminderPanel() {
  document.getElementById(REMINDER_PANEL_ID)?.remove();
}

function createReminderButton(label, onClick, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.border = '0';
  button.style.borderRadius = '6px';
  button.style.padding = '8px 10px';
  button.style.cursor = 'pointer';
  button.style.font = '13px/1.3 Arial, sans-serif';
  button.style.background = options.primary ? '#1a73e8' : '#f1f3f4';
  button.style.color = options.primary ? '#fff' : '#202124';
  button.addEventListener('click', onClick);
  return button;
}

async function showRecordingReminder() {
  if (!currentCallSession || document.getElementById(REMINDER_PANEL_ID)) {
    return;
  }

  const panel = document.createElement('div');
  panel.id = REMINDER_PANEL_ID;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Reminder registrazione Meet');
  panel.style.position = 'fixed';
  panel.style.right = '16px';
  panel.style.bottom = '64px';
  panel.style.width = '320px';
  panel.style.boxSizing = 'border-box';
  panel.style.zIndex = '2147483647';
  panel.style.padding = '14px';
  panel.style.borderRadius = '12px';
  panel.style.background = '#fff';
  panel.style.color = '#202124';
  panel.style.font = '13px/1.4 Arial, sans-serif';
  panel.style.boxShadow = '0 6px 24px rgba(0, 0, 0, 0.28)';
  panel.style.border = '1px solid rgba(60, 64, 67, 0.16)';

  const title = document.createElement('div');
  title.textContent = 'Reminder registrazione';
  title.style.fontWeight = '700';
  title.style.fontSize = '14px';
  title.style.marginBottom = '6px';

  const message = document.createElement('div');
  message.textContent = 'Se questa riunione va registrata, verifica che qualcuno con permessi avvii la registrazione.';
  message.style.marginBottom = '12px';

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.flexWrap = 'wrap';

  actions.append(
    createReminderButton('Ok', () => {
      removeReminderPanel();
      void updateReminderAction('dismissed', { dismissedAt: nowIsoString() });
    }, { primary: true }),
    createReminderButton('Ricordamelo', () => {
      const snoozeUntilTimestamp = Date.now() + REMINDER_SNOOZE_MS;
      removeReminderPanel();
      void updateReminderAction('snoozed', {
        snoozedAt: nowIsoString(),
        snoozeUntil: new Date(snoozeUntilTimestamp).toISOString(),
      });
    }),
    createReminderButton('Non per questa call', () => {
      removeReminderPanel();
      void updateReminderAction('disabled_for_call', { disabledAt: nowIsoString() });
    }),
  );

  panel.append(title, message, actions);
  document.documentElement.appendChild(panel);

  await markReminderShown();
}

function shouldShowReminder() {
  if (!currentCallSession) {
    return false;
  }

  if (currentCallSession.reminderStatus === 'dismissed' || currentCallSession.reminderStatus === 'disabled_for_call') {
    return false;
  }

  if (currentCallSession.snoozeUntil && Date.parse(currentCallSession.snoozeUntil) > Date.now()) {
    return false;
  }

  return true;
}

async function handleOpenCallState() {
  await startCallSessionIfNeeded();

  if (!currentCallSession) {
    return;
  }

  await upsertCurrentCallLog({ lastSeenAt: nowIsoString() });

  if (shouldShowReminder()) {
    await showRecordingReminder();
  }
}

async function handleClosedCallState() {
  removeReminderPanel();

  if (!currentCallSession || currentCallSession.leftAt) {
    return;
  }

  const leftAt = nowIsoString();
  currentCallSession.leftAt = leftAt;
  await upsertCurrentCallLog({ leftAt, lastSeenAt: leftAt });
  currentCallSession = null;
}

function handleCallStateEffects(state) {
  if (isHandlingCallState) {
    return;
  }

  isHandlingCallState = true;
  const handler = state.callOpen ? handleOpenCallState : handleClosedCallState;

  handler()
    .catch((error) => {
      console.warn('[Meet Recording Reminder] Gestione stato call fallita', error);
    })
    .finally(() => {
      isHandlingCallState = false;
    });
}

function applyDetectionState(state) {
  document.documentElement.dataset.meetRecordingReminderPageDetected = String(state.pageDetected);
  document.documentElement.dataset.meetRecordingReminderCallOpen = String(state.callOpen);
  updateDetectionBadge(state);
  handleCallStateEffects(state);

  const stateKey = JSON.stringify(state);
  if (stateKey !== lastDetectionState) {
    lastDetectionState = stateKey;
    console.info('[Meet Recording Reminder] Stato Meet', {
      pageDetected: state.pageDetected,
      callOpen: state.callOpen,
      href: window.location.href,
    });
  }
}

function detectMeetPage() {
  applyDetectionState(getMeetDetectionState());
}

function scheduleDetection() {
  if (scheduledDetection) {
    return;
  }

  scheduledDetection = window.setTimeout(() => {
    scheduledDetection = null;
    detectMeetPage();
  }, 250);
}

detectMeetPage();
window.setInterval(detectMeetPage, DETECTION_CHECK_INTERVAL_MS);

const observer = new MutationObserver(scheduleDetection);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['aria-label', 'aria-hidden'],
});
