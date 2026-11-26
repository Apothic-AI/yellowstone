#!/usr/bin/env node
/** Independent probe of committed HEAD parser: code-context false positives.
 *  Runs the *committed* reasoning-tags.ts from an isolated `git archive` copy. */
import { splitReasoning } from './src/reasoning-tags.ts';

// expectation: 'literal' = code/quotation context, tag must stay in visible text.
//               'protocol' = genuine top-level tag block, must be promoted.
const cases = [
  ['1 four-space indented code',
   '    <thinking>literal indented code example</thinking>', 'literal'],
  ['2 multiline inline-code span',
   'see `multiline code\n<thinking>example</thinking>\n` end', 'literal'],
  ['3 blockquote fenced code',
   '> ```xml\n> <thinking>quoted fenced example</thinking>\n> ```', 'literal'],
  ['4 tab-indented code',
   '\t<thinking>tab indented example</thinking>', 'literal'],
  ['5 plain (non-fenced) blockquote',
   '> <thinking>quoted prose example</thinking>', 'literal'],
  ['6 nested list item, 6-space indent (indented code in list)',
   '- item\n      <thinking>indented under list</thinking>', 'literal'],
  ['7 fenced with 4-space indent (CommonMark: still a fence at 4? no - indented code)',
   '    ```\n    <thinking>indented fence</thinking>\n    ```', 'literal'],
  ['8 proper top-level fence (must stay literal)',
   '```xml\n<thinking>proper fenced example</thinking>\n```', 'literal'],
  ['9 inline code same line (must stay literal)',
   'use `<thinking>inline</thinking>` here', 'literal'],
  ['10 plain paragraph tag (should be promoted)',
   '<thinking>real leak</thinking>\n\nThe answer.', 'protocol'],
  ['11 blockquote fenced, info string',
   '> ```\n> <thinking>x</thinking>\n> ```', 'literal'],
  ['12 double-nested blockquote fence',
   '> > ```\n> > <thinking>deep</thinking>\n> > ```', 'literal'],
];

const visible = (segs) => segs.filter((s) => s.kind === 'text').map((s) => s.text).join('');
const reasoned = (segs) => segs.filter((s) => s.kind === 'reasoning').map((s) => s.text).join('');
const hasTag = (s) => /<\/?thinking>/.test(s);

let bad = 0;
for (const [name, input, expectation] of cases) {
  const segs = splitReasoning(input);
  const promoted = reasoned(segs).length > 0;
  const tagSurvivesInText = hasTag(visible(segs));
  // A 'literal' case must stay in text; a 'protocol' case must be promoted.
  const wrong = expectation === 'literal' ? promoted : !promoted;
  if (wrong) bad++;
  const label = wrong ? (expectation === 'literal' ? 'DESTRUCTIVE ' : 'MISSED-LEAK ') : 'ok          ';
  console.log(`${label} [${expectation}] ${name}`);
  console.log(`   verdict=${promoted ? "PROMOTED" : "preserved"} reasoning=${JSON.stringify(reasoned(segs)).slice(0, 70)}`);
  console.log(`   visible=${JSON.stringify(visible(segs)).slice(0, 90)} tagInVisibleText=${tagSurvivesInText}`);
}
console.log(`\ncases=${cases.length} wrong=${bad} (destructive = literal context promoted; missed-leak = protocol not promoted)`);
