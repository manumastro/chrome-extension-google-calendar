const MEET_HOSTNAME = 'meet.google.com';
const DETECTION_BADGE_ID = 'meet-recording-reminder-detected';

function isGoogleMeetPage(location) {
  return location.hostname === MEET_HOSTNAME && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(location.pathname);
}

function showDetectionBadge() {
  if (document.getElementById(DETECTION_BADGE_ID)) {
    return;
  }

  const badge = document.createElement('div');
  badge.id = DETECTION_BADGE_ID;
  badge.textContent = 'Google Meet rilevato';
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
}

function detectMeetPage() {
  if (!isGoogleMeetPage(window.location)) {
    return;
  }

  document.documentElement.dataset.meetRecordingReminderDetected = 'true';
  showDetectionBadge();
  console.info('[Meet Recording Reminder] Google Meet rilevato', window.location.href);
}

detectMeetPage();
