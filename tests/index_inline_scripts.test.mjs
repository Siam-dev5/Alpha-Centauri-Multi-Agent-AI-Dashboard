import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("all inline JavaScript in index.html parses", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match, index) => ({ index, source: match[1].trim() }))
    .filter(item => item.source.length > 0);
  assert.ok(scripts.length > 0, "expected inline scripts in dashboard");
  for (const script of scripts) {
    assert.doesNotThrow(
      () => new vm.Script(script.source, { filename: "index.html:inline-script-" + script.index }),
      "inline script " + script.index + " should parse"
    );
  }
});
