import { describe, expect, it } from 'vitest';
import { firstChangedLine, hasFileInDiff, isAnchorInDiff, parseDiffHunks } from '../src/github/diffHunks.js';

const TWO_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
@@ -10,2 +11,3 @@ export { x };
 function foo() {}
+function bar() {}
 function baz() {}
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 000..333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const HELLO = 'world';
+export const BYE = 'friend';
`;

describe('parseDiffHunks', () => {
  it('captures every right-side line from added and context rows, skipping removals', () => {
    const index = parseDiffHunks(TWO_FILE_DIFF);

    const a = index.get('src/a.ts');
    expect(a).toBeDefined();
    // First hunk starts at +1: context line 1, + on 2 and 3, context on 4.
    // Second hunk starts at +11: context 11, + on 12, context on 13.
    expect(Array.from(a!).sort((p, q) => p - q)).toEqual([1, 2, 3, 4, 11, 12, 13]);

    const b = index.get('src/b.ts');
    expect(b).toBeDefined();
    expect(Array.from(b!).sort((p, q) => p - q)).toEqual([1, 2]);
  });

  it('ignores files deleted entirely (+++ /dev/null)', () => {
    const deletedFileDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const X = 1;
-export const Y = 2;
-export const Z = 3;
`;
    const index = parseDiffHunks(deletedFileDiff);
    expect(index.has('old.ts')).toBe(false);
    expect(index.has('/dev/null')).toBe(false);
  });

  it('skips binary-file sections without throwing', () => {
    const binaryDiff = `diff --git a/logo.png b/logo.png
index abc..def 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/src/c.ts b/src/c.ts
index 444..555 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,3 @@
 line1
+line2
 line3
`;
    const index = parseDiffHunks(binaryDiff);
    expect(index.has('logo.png')).toBe(false);
    expect(Array.from(index.get('src/c.ts')!).sort((p, q) => p - q)).toEqual([1, 2, 3]);
  });

  it('returns a partial index when the diff is truncated mid-hunk', () => {
    // Cut mid-hunk: header promises 3 lines but only 1 is present.
    const truncated = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,3 @@
 one
`;
    const index = parseDiffHunks(truncated);
    expect(Array.from(index.get('x.ts')!).sort((p, q) => p - q)).toEqual([1]);
    // Later lines that were in the "promised" hunk but not present in the
    // truncated text must be rejected — fail-closed.
    expect(isAnchorInDiff(index, 'x.ts', 2)).toBe(false);
    expect(isAnchorInDiff(index, 'x.ts', 3)).toBe(false);
  });

  it('handles an empty or whitespace-only diff without crashing', () => {
    expect(parseDiffHunks('').size).toBe(0);
    expect(parseDiffHunks('\n\n').size).toBe(0);
  });

  it('treats renames that still modify content correctly via the +++ line', () => {
    const renameDiff = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
 keep
-old
+new
`;
    const index = parseDiffHunks(renameDiff);
    expect(index.has('old/name.ts')).toBe(false);
    expect(Array.from(index.get('new/name.ts')!).sort((p, q) => p - q)).toEqual([1, 2]);
  });
});

describe('isAnchorInDiff', () => {
  const index = parseDiffHunks(TWO_FILE_DIFF);

  it('returns true only for lines present in a hunk for that file', () => {
    expect(isAnchorInDiff(index, 'src/a.ts', 2)).toBe(true);
    expect(isAnchorInDiff(index, 'src/a.ts', 12)).toBe(true);
    expect(isAnchorInDiff(index, 'src/a.ts', 5)).toBe(false); // between hunks
    expect(isAnchorInDiff(index, 'src/a.ts', 100)).toBe(false);
    expect(isAnchorInDiff(index, 'src/z.ts', 1)).toBe(false); // file not in diff
  });

  it('rejects zero, negative, and non-finite lines', () => {
    expect(isAnchorInDiff(index, 'src/a.ts', 0)).toBe(false);
    expect(isAnchorInDiff(index, 'src/a.ts', -1)).toBe(false);
    expect(isAnchorInDiff(index, 'src/a.ts', Number.NaN)).toBe(false);
  });
});

describe('firstChangedLine', () => {
  const index = parseDiffHunks(TWO_FILE_DIFF);

  it('returns the smallest right-side line for a file', () => {
    expect(firstChangedLine(index, 'src/a.ts')).toBe(1);
    expect(firstChangedLine(index, 'src/b.ts')).toBe(1);
    expect(firstChangedLine(index, 'missing.ts')).toBeUndefined();
  });
});

describe('hasFileInDiff', () => {
  const index = parseDiffHunks(TWO_FILE_DIFF);

  it('is true for modified files and false otherwise', () => {
    expect(hasFileInDiff(index, 'src/a.ts')).toBe(true);
    expect(hasFileInDiff(index, 'src/zzz.ts')).toBe(false);
  });
});
