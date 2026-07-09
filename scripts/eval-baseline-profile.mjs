#!/usr/bin/env node
// Aggregate N-rep baseline result.jsons into a per-scenario, per-claim PASS PROFILE (B0).
// Input: a dir of <scenario>.rep<N>.json files (each a `run --output-format json` envelope).
//
// A rep only measures the SKILL's guidance if the skill was actually invoked; a rep that answered
// from priors (skillsInvoked without the companion) is a negative control, not a valid baseline rep.
// So the gating profile is computed over INVOKED reps only, and not-invoked reps are surfaced
// separately as an F2 discrimination hint (a high not-invoked score = the claim is answerable without
// the skill).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = "cowork-harness";
const dir = process.argv[2];
if (!dir) { console.error("usage: aggregate-profile.mjs <dir>"); process.exit(2); }

const byScenario = {};
for (const f of readdirSync(dir).filter((f) => /\.rep\d+\.json$/.test(f))) {
  const name = f.replace(/\.rep\d+\.json$/, "");
  let raw;
  try { raw = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
  const r = Array.isArray(raw.results) ? raw.results[0] : raw;
  if (!r || !Array.isArray(r.assertions)) continue;
  const sem = r.assertions.find((a) => a.assertion && a.assertion.semantic_matches);
  if (!sem) continue;
  const bucket = (byScenario[name] ??= { reps: [], rubric: null, minPass: sem.assertion.semantic_matches.min_pass ?? "all" });
  bucket.reps.push({
    invoked: (r.skillsInvoked || []).includes(SKILL),
    success: r.result === "success",
    claims: sem.semanticClaims || [],
  });
  bucket.rubric ??= (sem.semanticClaims || []).map((c) => c.claim);
}

const profile = {};
for (const [name, { reps, rubric, minPass }] of Object.entries(byScenario).sort()) {
  const inv = reps.filter((rp) => rp.invoked);
  const notInv = reps.filter((rp) => !rp.invoked);
  const rate = (set, idx) => set.filter((rp) => rp.claims.find((c) => c.index === idx)?.pass).length;
  profile[name] = {
    reps: reps.length,
    skillInvoked: `${inv.length}/${reps.length}`,
    success: `${reps.filter((rp) => rp.success).length}/${reps.length}`,
    minPass,
    claims: (rubric || []).map((claim, index) => ({
      index,
      claim,
      // B0 profile (gating basis): pass rate over skill-INVOKED reps
      pass: `${rate(inv, index)}/${inv.length}`,
      // F2 hint: pass rate over reps where the skill was NOT invoked (priors only)
      priors: notInv.length ? `${rate(notInv, index)}/${notInv.length}` : null,
    })),
  };
}
console.log(JSON.stringify(profile, null, 2));
