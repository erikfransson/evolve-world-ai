// The "Gentle on CPU" toggle: on by default, remembered per browser. Workers get the value in their messages (see worker/pacer.ts).
const KEY = "gentleCpu";

export const GENTLE_TIP = "Leaves room for your other programs: one core stays free and the simulation backs off when your computer is busy. Turn off for maximum speed.";

export function readGentle(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeGentle(gentle: boolean): void {
  try {
    localStorage.setItem(KEY, gentle ? "on" : "off");
  } catch {
    // storage blocked: the choice lasts for this page only
  }
}

// Sets the switch from storage and saves and reports its changes.
export function bindGentle(input: HTMLInputElement, onChange: (gentle: boolean) => void): void {
  input.checked = readGentle();
  input.addEventListener("change", () => {
    writeGentle(input.checked);
    onChange(input.checked);
  });
}
