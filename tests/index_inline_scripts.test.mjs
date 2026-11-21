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

test("OpenBot chat routes explicit Facebook publish commands through authenticated approval flow", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const submit = html.slice(html.indexOf("function handleUserSubmit"), html.indexOf("LIVE API EXECUTION ENGINE"));
  assert.match(html, /function isFacebookPublishIntent\\(text\\)/);
  assert.match(html, /function extractFacebookCaption\\(command\\)/);
  assert.match(submit, /if \\(isFacebookPublishIntent\\(text\\)\\)/);
  assert.ok(submit.indexOf("isFacebookPublishIntent(text)") < submit.indexOf("systemConfig.execMode === 'LIVE'"));
  assert.match(html, /scRequest\\('\\/content', \\{method:'POST'/);
  assert.match(html, /scRequest\\('\\/content\\/' \\+ encodeURIComponent\\(draft\\.id\\) \\+ '\\/submit'/);
  assert.match(html, /approveAndPublishFacebookFromChat/);
  assert.match(html, /decision:'approve'/);
  assert.match(html, /confirm\\('ยืนยันอนุมัติและเผยแพร่/);
  assert.match(html, /publish\\/' \\+ encodeURIComponent\\(account\\.id\\)/);
  assert.match(html, /อย่ากดซ้ำจนกว่าจะตรวจประวัติการเผยแพร่/);
});
