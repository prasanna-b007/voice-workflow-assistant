// Routines: one phrase ("good morning", "work mode") that runs several commands.
// Each step is a sentence, run exactly as if the user had said it.

const KEY = "routines";

const DEFAULT_ROUTINES = [
  { name: "good morning", steps: ["what's the date today", "what's the weather today", "what's the news"] },
  { name: "work mode", steps: ["open vs code", "open gmail", "open slack"] },
];

export function getRoutines() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || DEFAULT_ROUTINES;
  } catch {
    return DEFAULT_ROUTINES;
  }
}

function store(routines) {
  localStorage.setItem(KEY, JSON.stringify(routines));
}

/** Adds a routine, replacing one with the same name. */
export function saveRoutine(name, steps) {
  const routines = getRoutines().filter((r) => r.name !== name.toLowerCase());
  routines.push({ name: name.toLowerCase(), steps });
  store(routines);
}

/** @returns {boolean} Whether a routine with that name existed. */
export function deleteRoutine(name) {
  const routines = getRoutines();
  const remaining = routines.filter((r) => r.name !== name.toLowerCase());
  store(remaining);
  return remaining.length !== routines.length;
}

/** The routine called `name`, ignoring a trailing "routine" or "mode" mismatch. */
export function findRoutine(name) {
  const spoken = (name || "").toLowerCase().trim().replace(/\s+routine$/, "");
  return getRoutines().find((r) => r.name === spoken || r.name.replace(/\s+mode$/, "") === spoken) || null;
}
