// Daily plan changes: configurable campaign slots, economy image mode, longer video QC limit, expanded content bank.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { campaignSlots, campaignDueSlot, CAMPAIGN_SLOTS_UTC, pickNextCampaignItem, wfEconomyImages, wfWideModel, wfVideoMaxSeconds, wfVideoQcProblems } from "../cloudflare/worker.mjs";

const BANK = JSON.parse(readFileSync(new URL("../content/routine-content-bank.json", import.meta.url), "utf8"));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const isCreativeWorkflowIntent = new Function(html.match(/function isCreativeWorkflowIntent\(text\) \{[\s\S]*?\n {8}\}/)[0] + "\nreturn isCreativeWorkflowIntent;")();
const at = (iso) => new Date(iso);

test("CAMPAIGN_SLOTS unset keeps the current 10:30/17:30 schedule", () => {
  assert.deepEqual(campaignSlots({}), CAMPAIGN_SLOTS_UTC);
  assert.deepEqual(campaignSlots({ CAMPAIGN_SLOTS: "garbage" }), CAMPAIGN_SLOTS_UTC);
});

test("CAMPAIGN_SLOTS=09:30,17:30 maps Bangkok times to 02:30 and 10:30 UTC", () => {
  const s = campaignSlots({ CAMPAIGN_SLOTS: "09:30,17:30" });
  assert.deepEqual(s, [{ label: "09:30", h: 2, m: 30 }, { label: "17:30", h: 10, m: 30 }]);
  assert.equal(campaignDueSlot(at("2031-01-10T02:31:00Z"), s).key, "2031-01-10@09:30");
  assert.equal(campaignDueSlot(at("2031-01-10T03:31:00Z"), s), null, "10:30 is no longer a slot");
  assert.equal(campaignDueSlot(at("2031-01-10T04:00:00Z"), s), null, "11:00 (video time) never triggers a text post");
  assert.equal(campaignDueSlot(at("2031-01-10T10:40:00Z"), s).key, "2031-01-10@17:30");
  assert.deepEqual(campaignSlots({ CAMPAIGN_SLOTS: "06:00" })[0], { label: "06:00", h: 23, m: 0 }, "wraps to the previous UTC day");
});

test("economy image mode swaps Lucid Origin for FLUX schnell only when on", () => {
  assert.equal(wfEconomyImages({}), false);
  assert.equal(wfWideModel({}), "@cf/leonardo/lucid-origin");
  assert.equal(wfWideModel({ WF_ECONOMY_IMAGES: "on" }), "@cf/black-forest-labs/flux-1-schnell");
});

test("video QC limit defaults to ~6 s and can allow the ~12 s two-part format", () => {
  const qc = { width: 1080, height: 1920, duration: 12.84, video_codec: "h264", audio_codec: "aac", has_audio: true, subtitles_burned_in: true, character_reference: true };
  const head = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 0, 0, 0, 0]);
  assert.equal(wfVideoMaxSeconds({}), 6.6);
  assert.match(wfVideoQcProblems(qc, 5e6, head).join(" "), /duration/);
  assert.equal(wfVideoMaxSeconds({ VIDEO_MAX_SECONDS: "15" }), 15);
  assert.deepEqual(wfVideoQcProblems(qc, 5e6, head, 15), []);
  assert.equal(wfVideoMaxSeconds({ VIDEO_MAX_SECONDS: "99" }), 20, "capped");
});

test("expanded bank: 49 unique items, all routed to the workflow with CTA, used after week 1", () => {
  const all = [...BANK.week1, ...BANK.week2_3, ...BANK.reserves];
  assert.equal(BANK.week2_3.length, 28);
  assert.equal(new Set(all.map(i => i.cid)).size, all.length);
  assert.equal(new Set(all.map(i => i.topic)).size, all.length);
  for (const i of BANK.week2_3) { assert.equal(isCreativeWorkflowIntent(i.command), true, i.cid); assert.ok(i.command.includes('CTA "สนใจ"')); }
  assert.equal(pickNextCampaignItem(BANK, new Set(BANK.week1.map(i => i.cid))).cid, "W2-01");
});
