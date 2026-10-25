const HEALTH_KEY = "streamshield.streamHealth";
export function readHealthPreference() {
  try {
    return window.localStorage.getItem(HEALTH_KEY) === "on";
  } catch {
    return false;
  }
}
export function writeHealthPreference(on: boolean) {
  try {
    window.localStorage.setItem(HEALTH_KEY, on ? "on" : "off");
  } catch {
    /* Preference only. */
  }
}
