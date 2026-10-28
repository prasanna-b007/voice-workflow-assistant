// Contacts saved by voice ("save Amma's number as 98765 43210"), used to send
// WhatsApp messages and emails by name.

const KEY = "contacts";

// Ten-digit numbers are assumed to be Indian mobiles; WhatsApp links need the
// country code.
const DEFAULT_COUNTRY_CODE = "91";

export function getContacts() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

/**
 * Adds a contact, or fills in the phone/email of an existing one with the same name.
 * @param {{ name: string, phone?: string, email?: string }} contact
 */
export function saveContact({ name, phone = "", email = "" }) {
  const contacts = getContacts();
  const existing = contacts.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (phone) existing.phone = phone;
    if (email) existing.email = email;
  } else {
    contacts.push({ name, phone, email });
  }
  localStorage.setItem(KEY, JSON.stringify(contacts));
}

/** The contact whose name matches what was said ("amma", "my manager"), or null. */
export function findContact(spoken) {
  const name = (spoken || "").toLowerCase().trim().replace(/^(?:my|the)\s+/, "");
  if (!name) return null;
  const contacts = getContacts();
  return (
    contacts.find((c) => c.name.toLowerCase() === name) ||
    contacts.find((c) => c.name.toLowerCase().includes(name) || name.includes(c.name.toLowerCase())) ||
    null
  );
}

/** "98765 43210" → "919876543210", the form wa.me links take. */
export function toWhatsAppNumber(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.length === 10 ? DEFAULT_COUNTRY_CODE + digits : digits;
}
