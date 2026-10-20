/** A literal shell word, without expansion, operators, or redirection. */
interface Word {
  value: string;
  assignment: boolean;
}

/**
 * Recognize a deliberately small subset of shell syntax, not a general shell
 * parser. Quotes and escapes may carry literal arguments; shell evaluation may
 * not turn those arguments into another command or hide its exit status.
 */
function literalWords(command: string): Word[] | null {
  // Only ASCII space/tab delimit words. String.trim() would erase Unicode
  // whitespace that Bash treats as part of a filename, changing its identity.
  const input = command;
  if (input.includes("\0")) return null;
  const words: Word[] = [];
  let i = 0;
  while (i < input.length) {
    while (input[i] === " " || input[i] === "\t") i++;
    if (i === input.length) break;
    const start = i;
    let value = "";
    while (i < input.length && input[i] !== " " && input[i] !== "\t") {
      const char = input[i++];
      if (char === "'") {
        const end = input.indexOf("'", i);
        if (end === -1) return null;
        value += input.slice(i, end);
        i = end + 1;
      } else if (char === '"') {
        let closed = false;
        while (i < input.length) {
          const quoted = input[i++];
          if (quoted === '"') { closed = true; break; }
          if (quoted === "$" || quoted === "`") return null;
          if (quoted === "\\") {
            const next = input[i++];
            if (next === undefined || next === "\n" || next === "\r") return null;
            // In double quotes Bash only removes these particular backslashes.
            value += '\\"$`'.includes(next) ? next : `\\${next}`;
          } else {
            value += quoted;
          }
        }
        if (!closed) return null;
      } else if (char === "\\") {
        const next = input[i++];
        if (next === undefined || next === "\n" || next === "\r") return null;
        value += next;
      } else {
        if ("\r\n;&|<>()$`*?[]{}~#".includes(char)) return null;
        value += char;
      }
    }
    words.push({ value, assignment: /^[A-Za-z_][A-Za-z_0-9]*=/.test(input.slice(start, i)) });
  }
  return words;
}

// Explicit startup overrides can suppress script execution despite a zero
// shell exit status. Ambient environment/PATH remain outside this recognizer.
const SHELL_STARTUP_VARIABLES = new Set(["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"]);

function safeAssignment(value: string): boolean {
  const match = /^([A-Za-z_][A-Za-z_0-9]*)=/.exec(value);
  return !!match && !SHELL_STARTUP_VARIABLES.has(match[1]);
}

/**
 * Return the literal benchmark path only for a supported, complete invocation.
 * This is invocation validation, not a sandbox or proof of what a script does.
 */
export function benchmarkPathFromCommand(command: string): string | null {
  const words = literalWords(command);
  if (!words?.length) return null;
  let i = 0;
  let externalWrapper = false;
  while (words[i]?.assignment) {
    if (!safeAssignment(words[i++].value)) return null;
  }
  // All admitted wrapper options execute a child and return its status. Help,
  // version, env -S/-C, and other option-driven alternate modes are unsupported.
  while (i < words.length) {
    const wrapper = words[i].value;
    if (wrapper === "env") {
      externalWrapper = true;
      i++;
      if (words[i]?.value === "--") i++;
      while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[i]?.value ?? "")) {
        if (!safeAssignment(words[i++].value)) return null;
      }
    } else if (wrapper === "time") {
      i++;
      if (words[i]?.value === "-p") i++;
    } else if (wrapper === "nice") {
      externalWrapper = true;
      i++;
      if (words[i]?.value === "-n") {
        i++;
        if (!/^[+-]?\d+$/.test(words[i++]?.value ?? "")) return null;
      }
      if (words[i]?.value === "--") i++;
    } else if (wrapper === "nohup") {
      externalWrapper = true;
      i++;
      if (words[i]?.value === "--") i++;
    } else {
      break;
    }
  }
  const shell = words[i]?.value;
  const interpreted = shell === "bash" || shell === "sh";
  const sourced = shell === "source";
  if (sourced && externalWrapper) return null;
  if (interpreted || sourced) {
    i++;
    // Unlike -n/-c/-s/-D or --help, these flags still execute the script.
    if (interpreted) while (/^-[euxv]+$/.test(words[i]?.value ?? "")) i++;
    if (words[i]?.value === "--") i++;
  }
  const benchmark = words[i]?.value;
  if (!benchmark || benchmark.startsWith("-")) return null;
  const parts = benchmark.split("/");
  if (parts.at(-1) !== "autoresearch.sh" &&
      !(parts.at(-1) === "measure.sh" && parts.at(-2) === ".auto")) return null;
  // Bare command names and `source autoresearch.sh` search PATH, whereas our
  // provenance captures the cwd file. Require an explicit path in those forms.
  if (!interpreted && !benchmark.includes("/")) return null;
  return benchmark;
}
