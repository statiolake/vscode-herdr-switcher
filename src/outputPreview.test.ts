import assert from "node:assert/strict";
import test from "node:test";
import { formatOutputPreview } from "./outputPreview";

test("output preview keeps the latest non-empty visible lines", () => {
  assert.equal(
    formatOutputPreview(" \n  first  \nsecond\nthird\n\t", 2),
    "second\nthird",
  );
});

test("output preview is absent for an empty pane", () => {
  assert.equal(formatOutputPreview(" \n\t\n"), undefined);
});
