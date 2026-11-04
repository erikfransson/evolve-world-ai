# Coding guidelines for Agents


## Tests
Use vitest: `npm test` in `src/typescript`, tests in `tests/typescript`.
* Try to add tests that makes sense , and covering the basic, and protects against bugs but dont overdo it.
* When fixing bugs, try to follow procedure of: add test that fails, fix bug, verify test is green. 
* `mapImage.test.ts` fails when code that draws the Live map's ground picture changes (comments excepted): run `cd src/typescript && node scripts/buildMapImage.ts` (needs Chrome) and commit the new pictures; `mapAsset.test.ts` the same for `node scripts/buildMapAsset.ts` after a map change.

## Reviewing
Always use an indepdent reviewer to check your work before commiting and pushing
Use /thermo-nuclear-code-quality-review often.

