import { numberedOptionIndex } from "../ui.js";

function assert(actual: boolean, message: string): void {
  if (!actual) throw new Error(message);
}

assert(numberedOptionIndex("1", 3) === 0, "1 selects the first option");
assert(numberedOptionIndex("3", 3) === 2, "3 selects the third option");
assert(numberedOptionIndex("4", 3) === undefined, "out-of-range numbers are ignored");
assert(numberedOptionIndex("0", 3) === undefined, "zero is not a selector");
assert(numberedOptionIndex("12", 12) === undefined, "multi-digit input is left to normal handling");
console.log("numbered selector helper tests passed");
