// Spoken confirmations. Fixed sentences: instant, offline, and the same every
// time, which is what you want from a short "Opening Chrome." anyway.

const TOGGLE_NAMES = {
  toggle_wifi: "Wi-Fi",
  toggle_bluetooth: "Bluetooth",
  toggle_airplane_mode: "Airplane mode",
  toggle_hotspot: "Mobile hotspot",
  toggle_night_light: "Night light",
  toggle_energy_saver: "Energy saver",
  toggle_battery_saver: "Energy saver",
};

const titleCase = (s) => String(s || "").replace(/\b\w/g, (c) => c.toUpperCase());

function levelReply(what, level) {
  const l = String(level || "").toLowerCase();
  if (l === "mute" || l === "unmute") return "Toggling mute.";
  if (l === "increase" || l === "up") return `Turning the ${what} up.`;
  if (l === "decrease" || l === "down") return `Turning the ${what} down.`;
  return l ? `Setting the ${what} to ${l} percent.` : `Adjusting the ${what}.`;
}

/**
 * The sentence Sonix says after an action.
 * @param {string} action
 * @param {object} [data]
 * @returns {string} "" for actions that need no confirmation.
 */
export function generateVoiceReply(action, data = {}) {
  if (TOGGLE_NAMES[action]) {
    const name = TOGGLE_NAMES[action];
    if (data.state === "on") return `Turning ${name} on.`;
    if (data.state === "off") return `Turning ${name} off.`;
    return `Toggling ${name}.`;
  }

  switch (action) {
    case "open_app":
    case "switch_app":
      return `Opening ${titleCase(data.app) || "the app"}.`;
    case "close_app":
      return data.app && data.app !== "window" ? `Closing ${titleCase(data.app)}.` : "Closing the window.";
    case "set_volume":
      return levelReply("volume", data.level);
    case "set_brightness":
      return levelReply("brightness", data.level);
    case "take_screenshot":
    case "toggle_screenshot":
      return "Taking a screenshot.";
    case "start_screen_recording":
      return "Starting screen recording.";
    case "stop_screen_recording":
      return "Stopping screen recording.";
    case "youtube_search":
      return data.query ? `Searching YouTube for ${data.query}.` : "Opening YouTube.";
    case "schedule_meeting":
      return "Opening your calendar.";
    case "create_task":
      return data.task ? `Reminder set: ${data.task}.` : "Reminder set.";
    case "send_email":
      return "Opening your email.";
    case "open_url":
      return "Opening the website.";
    case "shutdown":
      return "Shutting down in 30 seconds. Say cancel shutdown to stop it.";
    case "restart":
      return "Restarting in 30 seconds. Say cancel shutdown to stop it.";
    case "cancel_shutdown":
      return "Shutdown cancelled.";
    case "shutdown_timer":
      return `Shutting down in ${data.time} minutes.`;
    case "scroll_up":
    case "scroll_down":
      return "";
    case "error":
      return "Something went wrong.";
    default:
      return "Done.";
  }
}
