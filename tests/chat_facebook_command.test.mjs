// Unit tests for the Dashboard chat command parser (functions extracted from index.html).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
function extract(name) {
  const start = html.indexOf("function " + name + "(");
  assert.ok(start > 0, name + " exists");
  let depth = 0, i = html.indexOf("{", start);
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) break;
  }
  return html.slice(start, i + 1);
}
const ctx = vm.createContext({});
vm.runInContext(["isFacebookPublishIntent", "extractFacebookCaption", "selectFacebookTargetPage"].map(extract).join("\n"), ctx);
const { isFacebookPublishIntent, extractFacebookCaption, selectFacebookTargetPage } = ctx;

const COMMANDS = [
  'โพสต์ข้อความ "Hello Everyone" ไปยังเพจ Facebook',
  "โพสต์ข้อความ “Hello Everyone” ลงเพจ",
  "โพสต์ Hello Everyone ลงเพจ Facebook",
  "ช่วยโพสต์ Hello Everyone ไปที่เพจ",
  "post Hello Everyone to Facebook page",
  "โพสต์เพจ Facebook ข้อความ: Hello Everyone",
  "Post 'Hello Everyone' on Facebook"
];

test("Hello Everyone commands are recognised and the caption is extracted", () => {
  for (const command of COMMANDS) {
    assert.equal(isFacebookPublishIntent(command), true, command);
    assert.equal(extractFacebookCaption(command), "Hello Everyone", command);
  }
});

test("negated or unrelated commands are not routed to Facebook", () => {
  assert.equal(isFacebookPublishIntent("อย่าโพสต์ลงเพจ Facebook"), false);
  assert.equal(isFacebookPublishIntent("สรุปงานค้างทั้งหมด"), false);
});

test("target Page selection", () => {
  const a = { id: "a", account_name: "ชุมชน HR สายงานสรรหาว่าจ้าง" };
  const b = { id: "b", account_name: "Other Page" };
  assert.equal(selectFacebookTargetPage("โพสต์ Hello ลงเพจ", [a]).account.id, "a");
  assert.equal(selectFacebookTargetPage("โพสต์ Hello ลงเพจ other page", [a, b]).account.id, "b");
  assert.match(selectFacebookTargetPage("โพสต์ Hello ลงเพจ", [a, b]).error, /ระบุชื่อเพจ/);
  assert.match(selectFacebookTargetPage("โพสต์ Hello ลงเพจ", []).error, /ยังไม่พบ/);
});

test("chat no longer requires an image for Facebook commands", () => {
  const handler = extract("handleFacebookPublishChatCommand");
  assert.ok(!handler.includes("ยังไม่มีรูปแนบ"));
  assert.ok(handler.includes("selectFacebookTargetPage(command, ready)"));
  const approve = extract("approveAndPublishFacebookFromChat");
  assert.ok(approve.includes("post_kind:'text'"));
  assert.ok(approve.includes("confirm("));
});

test("creative workflow intent is separate from the single-post command", () => {
  const ctx2 = vm.createContext({});
  vm.runInContext(extract("isCreativeWorkflowIntent"), ctx2);
  const { isCreativeWorkflowIntent } = ctx2;
  assert.equal(isCreativeWorkflowIntent("ให้ Creative Bot คิดคอนเซปต์ แล้วให้ Graphic Design ทำภาพปกกับแบนเนอร์ จากนั้นโพสต์ลงเพจ"), true);
  assert.equal(isCreativeWorkflowIntent("ทำคอนเทนต์เคล็ดลับสัมภาษณ์งานแล้วโพสต์ Facebook"), true);
  for (const c of COMMANDS) assert.equal(isCreativeWorkflowIntent(c), false, c);
  assert.equal(isCreativeWorkflowIntent("อย่าโพสต์คอนเทนต์ลงเพจ"), false);
  const submit = html.slice(html.indexOf("function handleUserSubmit"), html.indexOf("LIVE API EXECUTION ENGINE"));
  assert.ok(submit.indexOf("isCreativeWorkflowIntent(text)") < submit.indexOf("isFacebookPublishIntent(text)"));
});
