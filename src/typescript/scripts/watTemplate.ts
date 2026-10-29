// Template expansion for the .wat kernels, run before the {{LAYOUT}} substitution. Tags are {{...}} on their own tokens:
//   {{def NAME p q}} ... {{end}}   defines a macro (removed from the output); its body may use @p, @q
//   {{NAME a b}}                   expands the macro with those arguments (a macro name wins over a layout name)
//   {{for i N}} ... {{end}}        repeats the body for i = 0..N-1 with @i = i and @o = 16 * i (the v128 byte offset)
//   {{if @flag}} ... {{end}}       keeps the body when the flag is 1
// `node scripts/buildWasm.ts --print brain` writes the expanded text.
type Node = string | { tag: string; args: string[]; body: Node[] };

function parse(text: string, file: string): Node[] {
  const out: Node[] = [];
  const stack: { tag: string; args: string[]; body: Node[] }[] = [];
  const top = () => (stack.length ? stack[stack.length - 1].body : out);
  const parts = text.split(/\{\{([^{}]*)\}\}/);
  parts.forEach((part, k) => {
    if (k % 2 === 0) return void (part && top().push(part));
    const [tag, ...args] = part.trim().split(/\s+/);
    if (tag === "end") {
      const done = stack.pop();
      if (!done) throw new Error(`${file}: {{end}} without a block`);
      top().push(done);
    } else if (tag === "def" || tag === "for" || tag === "if") stack.push({ tag, args, body: [] });
    else top().push({ tag, args, body: [] });
  });
  if (stack.length) throw new Error(`${file}: unclosed {{${stack[stack.length - 1].tag}}} block`);
  return out;
}

export function expandTemplates(text: string, file: string, layoutNames: (name: string) => boolean): string {
  const defs = new Map<string, { params: string[]; body: Node[] }>();
  const tree = parse(text, file);
  const sub = (s: string, env: Record<string, string>): string => s.replace(/@(\w+)/g, (m, n: string) => (n in env ? env[n] : m));
  const run = (nodes: Node[], env: Record<string, string>, depth: number): string => {
    if (depth > 8) throw new Error(`${file}: template nesting too deep`);
    let out = "";
    for (const n of nodes) {
      if (typeof n === "string") out += sub(n, env);
      else if (n.tag === "def") {
        const [name, ...params] = n.args;
        defs.set(name, { params, body: n.body });
      } else if (n.tag === "for") {
        const count = Number(sub(n.args[1], env));
        if (!Number.isInteger(count) || count < 0 || count > 64) throw new Error(`${file}: bad {{for}} count ${n.args[1]}`);
        for (let i = 0; i < count; i++) out += run(n.body, { ...env, [n.args[0]]: String(i), o: String(16 * i) }, depth + 1);
      } else if (n.tag === "if") {
        if (sub(n.args[0], env) === "1") out += run(n.body, env, depth + 1);
      } else {
        const d = defs.get(n.tag);
        if (!d) {
          if (!layoutNames(n.tag)) throw new Error(`${file}: unknown template or layout name ${n.tag}`);
          out += `{{${n.tag}}}`;
        } else {
          const args = n.args.map((a) => sub(a, env));
          if (args.length !== d.params.length) throw new Error(`${file}: {{${n.tag}}} takes ${d.params.length} arguments`);
          out += run(d.body, Object.fromEntries(d.params.map((p, k) => [p, args[k]])), depth + 1);
        }
      }
    }
    return out;
  };
  return run(tree, {}, 0).replace(/\n[ \t]*(?=\n)/g, "");
}
