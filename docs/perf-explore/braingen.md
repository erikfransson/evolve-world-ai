# Idea 152: brain.wat generated from templates (braingen)

Branch `pl-braingen`. Exact: the assembled brain module is byte-identical, so no re-measurement.

## What is generated
`scripts/watTemplate.ts` expands `{{def NAME params}}`, `{{for i N}}` (`@i`, `@o` = 16 i), `{{if @flag}}` and `{{NAME args}}` before the `{{LAYOUT}}` substitution (`wasmAssemble.ts`, `watText`). `node scripts/buildWasm.ts --print brain` writes the expanded text (485 lines, as before).
In brain.wat:
- `tanh i o`: the 5-line tanh of accumulator i, stored at byte offset o (was 21 copies).
- `consts`: the 9 constant loads k0 to k8 (was 6 copies).
- `group N pf`: one column group of N vectors, bias load, input loop (prefetch touches when pf is 1), tanh or plain store (was 6 branches). The six-way if chain is six calls.

## Bytes
`npm run wasm` before and after: `git diff` of `kernels.generated.ts` is empty (all six base64 modules equal). Identical bytes mean identical performance. The drift test (`tests/typescript/wasmKernels.test.ts`) still compares `generatedSource()`, which now expands the templates, against the committed file. A new test covers the expander (def, for, if, layout names untouched, error cases).

## Lines
brain.wat 487 to 228 (templates included), watTemplate.ts +61, wasmAssemble/buildWasm +16.

## sense.wat: left as is
No repeat that a template could fold without changing bytes. `$emit` is already one function (called twice). The stride-6 merge loop is not a copy of the general loop: it has a seen-creature branch instead of selects, and the emit stride-6 loop in `$emit` does two rays per step. Folding them would change the code.

## Tests
`npx vitest run wasm brain sense resident --maxWorkers=2 --testTimeout=180000`: exit 0, 8 files, 132 tests.
